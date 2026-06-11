import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { upload, sanitizeFileName } from "../services/imageService";
import * as characterElementsService from "../services/characterElementsService";
import { checkProjectArchivedByRecordId } from "../middleware/archiveMiddleware";
import { resolveImageUrls, BUCKETS } from "../services/storageService";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router({ mergeParams: true }); // mergeParams to access :characterId from parent router

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Helper to get character_id from URL params
function getCharacterId(req: Request): string {
  return req.params.characterId || req.params.id;
}

// Middleware: verify user has access to the character's project (owner or active collaborator)
// Blocks viewers on write operations (POST/PUT/DELETE)
router.use(async (req: Request, res: Response, next) => {
  try {
    const userId = req.user?.id;
    const characterId = getCharacterId(req);

    if (!userId || !characterId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Look up character to get project_id
    const { data: character, error: charError } = await supabase
      .from('characters')
      .select('project_id')
      .eq('id', characterId)
      .single();

    if (charError || !character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    // Check project ownership
    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', character.project_id)
      .single();

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    let role = 'owner';
    if (project.user_id !== userId) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('role, status')
        .eq('project_id', character.project_id)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (!collaborator) {
        return res.status(403).json({ error: 'Access denied - not authorized for this project' });
      }
      role = collaborator.role;
    }

    // Block viewers on write operations
    if (role === 'viewer' && req.method !== 'GET') {
      return res.status(403).json({ error: 'Read-only access - viewers cannot make changes', role: 'viewer' });
    }

    next();
  } catch (error) {
    console.error('Error in character elements access check:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/characters/:characterId/elements - Get all elements for a character
router.get("/", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const { data, error } = await characterElementsService.getCharacterElements(characterId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Resolve storage paths to signed URLs
    const resolved = await resolveImageUrls(data || [], [
      { field: 'reference_image_url', bucket: BUCKETS.CHARACTER_IMAGES }
    ]);

    res.json(resolved);
  } catch (error) {
    console.error('❌ Error fetching character elements:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/characters/:characterId/elements/active - Get only active elements
router.get("/active", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const { data, error } = await characterElementsService.getActiveElements(characterId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Resolve storage paths to signed URLs
    const resolved = await resolveImageUrls(data || [], [
      { field: 'reference_image_url', bucket: BUCKETS.CHARACTER_IMAGES }
    ]);

    res.json(resolved);
  } catch (error) {
    console.error('❌ Error fetching active elements:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/characters/:characterId/elements/count - Get element count
router.get("/count", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const count = await characterElementsService.getElementCount(characterId);
    res.json({ count, max: 3 });
  } catch (error) {
    console.error('❌ Error getting element count:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/characters/:characterId/elements - Create a new element
router.post("/",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const characterId = getCharacterId(req);
      const { name, element_type, description, is_active } = req.body;

      if (!name || !element_type) {
        return res.status(400).json({ error: "name and element_type are required" });
      }

      const validTypes = ['costume', 'prop', 'accessory', 'makeup', 'hairstyle', 'other'];
      if (!validTypes.includes(element_type)) {
        return res.status(400).json({
          error: `Invalid element_type. Must be one of: ${validTypes.join(', ')}`
        });
      }

      const { data, error } = await characterElementsService.createCharacterElement({
        character_id: characterId,
        name,
        element_type,
        description,
        is_active: is_active !== false
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Character element created:', data?.id);
      res.status(201).json(data);
    } catch (error) {
      console.error('❌ Error creating character element:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// GET /api/characters/:characterId/elements/:elementId - Get single element
router.get("/:elementId", async (req: Request, res: Response) => {
  try {
    const { elementId } = req.params;
    const { data, error } = await characterElementsService.getCharacterElementById(elementId);

    if (error) {
      return res.status(404).json({ error: "Element not found" });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching element:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// PUT /api/characters/:characterId/elements/:elementId - Update element
router.put("/:elementId",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { elementId } = req.params;
      const { name, element_type, description, is_active } = req.body;

      const updates: characterElementsService.UpdateCharacterElementData = {};
      if (name !== undefined) updates.name = name;
      if (element_type !== undefined) {
        const validTypes = ['costume', 'prop', 'accessory', 'makeup', 'hairstyle', 'other'];
        if (!validTypes.includes(element_type)) {
          return res.status(400).json({
            error: `Invalid element_type. Must be one of: ${validTypes.join(', ')}`
          });
        }
        updates.element_type = element_type;
      }
      if (description !== undefined) updates.description = description;
      if (is_active !== undefined) updates.is_active = is_active;

      const { data, error } = await characterElementsService.updateCharacterElement(elementId, updates);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Character element updated:', elementId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error updating character element:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/characters/:characterId/elements/:elementId/toggle-active - Toggle active state
router.put("/:elementId/toggle-active",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { elementId } = req.params;
      const { data, error } = await characterElementsService.toggleElementActive(elementId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Element active state toggled:', elementId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error toggling element active state:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// POST /api/characters/:characterId/elements/:elementId/upload-reference - Upload reference image
router.post("/:elementId/upload-reference",
  checkProjectArchivedByRecordId("characters", "characterId"),
  upload.single('image'),
  async (req: Request, res: Response) => {
    try {
      const characterId = getCharacterId(req);
      const { elementId } = req.params;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Get existing element to check for old reference image
      const { data: existingElement } = await characterElementsService.getCharacterElementById(elementId);

      // Upload to Supabase storage
      const fileName = `characters/${characterId}/elements/${elementId}/${sanitizeFileName(file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from('character-images')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error('❌ Storage upload error:', uploadError);
        return res.status(500).json({ error: uploadError.message });
      }

      // Store the path (not public URL) - signed URLs generated on read
      // Update element with reference image path
      const { data, error } = await characterElementsService.updateCharacterElement(elementId, {
        reference_image_url: fileName
      });

      if (error) {
        // Clean up uploaded file if database update fails
        await supabase.storage.from('character-images').remove([fileName]);
        return res.status(500).json({ error: error.message });
      }

      // Clean up old reference image if it exists
      if (existingElement?.reference_image_url) {
        try {
          const oldPath = extractStoragePathLocal(existingElement.reference_image_url);
          if (oldPath) {
            await supabase.storage.from('character-images').remove([oldPath]);
          }
        } catch (cleanupError) {
          console.warn('⚠️ Failed to delete old reference image:', cleanupError);
        }
      }

      if (DEBUG_AI) console.log('✅ Reference image uploaded for element:', elementId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error uploading reference image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// DELETE /api/characters/:characterId/elements/:elementId/reference - Remove reference image
router.delete("/:elementId/reference",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { elementId } = req.params;

      // Get element to find reference image URL
      const { data: element } = await characterElementsService.getCharacterElementById(elementId);

      if (!element?.reference_image_url) {
        return res.status(400).json({ error: "Element has no reference image" });
      }

      // Update element to remove reference image URL
      const { data, error } = await characterElementsService.updateCharacterElement(elementId, {
        reference_image_url: null
      });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Clean up from storage
      try {
        const storagePath = extractStoragePathLocal(element.reference_image_url);
        if (storagePath) {
          await supabase.storage.from('character-images').remove([storagePath]);
        }
      } catch (cleanupError) {
        console.warn('⚠️ Failed to delete reference image from storage:', cleanupError);
      }

      if (DEBUG_AI) console.log('✅ Reference image removed for element:', elementId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error removing reference image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// POST /api/characters/:characterId/elements/reorder - Reorder elements
router.post("/reorder",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const characterId = getCharacterId(req);
      const { elementIds } = req.body;

      if (!Array.isArray(elementIds)) {
        return res.status(400).json({ error: "elementIds must be an array" });
      }

      const result = await characterElementsService.reorderElements(characterId, elementIds);

      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }

      if (DEBUG_AI) console.log('✅ Elements reordered for character:', characterId);
      res.json('data' in result ? result.data : []);
    } catch (error) {
      console.error('❌ Error reordering elements:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// DELETE /api/characters/:characterId/elements/:elementId - Delete element
router.delete("/:elementId",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { elementId } = req.params;

      // Get element to find reference image URL for cleanup
      const { data: element } = await characterElementsService.getCharacterElementById(elementId);

      const { data, error } = await characterElementsService.deleteCharacterElement(elementId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Clean up reference image from storage if exists
      if (element?.reference_image_url) {
        try {
          const storagePath = extractStoragePathLocal(element.reference_image_url);
          if (storagePath) {
            await supabase.storage.from('character-images').remove([storagePath]);
          }
        } catch (cleanupError) {
          console.warn('⚠️ Failed to delete reference image from storage:', cleanupError);
        }
      }

      if (DEBUG_AI) console.log('✅ Character element deleted:', elementId);
      res.json({ success: true, deleted: data });
    } catch (error) {
      console.error('❌ Error deleting character element:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// Helper to extract storage path from URL or return path as-is
function extractStoragePathLocal(value: string): string | null {
  if (!value) return null;
  // If it's already a plain path (not a URL), return it directly
  if (!value.startsWith('http')) return value;
  try {
    const match = value.match(/\/storage\/v1\/object\/(?:public|sign)\/character-images\/([^?]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export default router;
