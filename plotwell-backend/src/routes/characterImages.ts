import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { upload, deleteCharacterImage as deleteImageFromStorage, sanitizeFileName } from "../services/imageService";
import * as characterImagesService from "../services/characterImagesService";
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
    console.error('Error in character images access check:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/characters/:characterId/images - Get all images for a character
router.get("/", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const { data, error } = await characterImagesService.getCharacterImages(characterId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Resolve storage paths to signed URLs
    const resolved = await resolveImageUrls(data || [], [
      { field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES }
    ]);

    res.json(resolved);
  } catch (error) {
    console.error('❌ Error fetching character images:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/characters/:characterId/images/primary - Get primary image
router.get("/primary", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const { data, error } = await characterImagesService.getPrimaryImage(characterId);

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      return res.status(500).json({ error: error.message });
    }

    if (data) {
      const [resolved] = await resolveImageUrls([data], [
        { field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES }
      ]);
      return res.json(resolved);
    }

    res.json(null);
  } catch (error) {
    console.error('❌ Error fetching primary image:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/characters/:characterId/images/count - Get image count
router.get("/count", async (req: Request, res: Response) => {
  try {
    const characterId = getCharacterId(req);
    const count = await characterImagesService.getImageCount(characterId);
    res.json({ count, max: 3 });
  } catch (error) {
    console.error('❌ Error getting image count:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/characters/:characterId/images - Upload a new image
router.post("/",
  checkProjectArchivedByRecordId("characters", "characterId"),
  upload.single('image'),
  async (req: Request, res: Response) => {
    try {
      const characterId = getCharacterId(req);
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { description, image_type, is_primary } = req.body;

      // Upload to Supabase storage (sanitize filename to prevent path traversal)
      const fileName = `characters/${characterId}/images/${sanitizeFileName(file.originalname)}`;
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
      // Create database record
      const { data, error } = await characterImagesService.createCharacterImage({
        character_id: characterId,
        image_url: fileName,
        description,
        image_type: image_type || 'portrait',
        is_primary: is_primary === 'true' || is_primary === true,
        is_ai_generated: false
      });

      if (error) {
        // Clean up uploaded file if database insert fails
        await supabase.storage.from('character-images').remove([fileName]);
        return res.status(400).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Character image uploaded:', data?.id);
      res.status(201).json(data);
    } catch (error) {
      console.error('❌ Error uploading character image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/characters/:characterId/images/:imageId - Update image metadata
router.put("/:imageId",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { imageId } = req.params;
      const { description, image_type } = req.body;

      const { data, error } = await characterImagesService.updateCharacterImage(imageId, {
        description,
        image_type
      });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Character image updated:', imageId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error updating character image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/characters/:characterId/images/:imageId/set-primary - Set image as primary
router.put("/:imageId/set-primary",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const { imageId } = req.params;

      const { data, error } = await characterImagesService.setPrimaryImage(imageId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Primary image set:', imageId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error setting primary image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// POST /api/characters/:characterId/images/reorder - Reorder images
router.post("/reorder",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    try {
      const characterId = getCharacterId(req);
      const { imageIds } = req.body;

      if (!Array.isArray(imageIds)) {
        return res.status(400).json({ error: "imageIds must be an array" });
      }

      const result = await characterImagesService.reorderImages(characterId, imageIds);

      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }

      if (DEBUG_AI) console.log('✅ Images reordered for character:', characterId);
      res.json('data' in result ? result.data : []);
    } catch (error) {
      console.error('❌ Error reordering images:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// DELETE /api/characters/:characterId/images/:imageId - Delete an image
router.delete("/:imageId",
  checkProjectArchivedByRecordId("characters", "characterId"),
  async (req: Request, res: Response) => {
    if (DEBUG_AI) console.log('🗑️ DELETE image request:', { params: req.params, characterId: req.params.characterId, imageId: req.params.imageId });
    try {
      const { imageId } = req.params;

      // Get image URL before deletion for storage cleanup
      const { data: image } = await characterImagesService.getCharacterImageById(imageId);

      const { data, error } = await characterImagesService.deleteCharacterImage(imageId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Clean up from storage
      if (image?.image_url) {
        try {
          await deleteImageFromStorage(image.image_url);
        } catch (storageError) {
          console.warn('⚠️ Failed to delete image from storage:', storageError);
          // Don't fail the request if storage cleanup fails
        }
      }

      if (DEBUG_AI) console.log('✅ Character image deleted:', imageId);
      res.json({ success: true, deleted: data });
    } catch (error) {
      console.error('❌ Error deleting character image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

export default router;
