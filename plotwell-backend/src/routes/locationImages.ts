import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { upload, sanitizeFileName } from "../services/imageService";
import * as locationImagesService from "../services/locationImagesService";
import { checkProjectArchivedByRecordId } from "../middleware/archiveMiddleware";
import { resolveImageUrls, BUCKETS } from "../services/storageService";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router({ mergeParams: true });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function getLocationId(req: Request): string {
  return req.params.locationId || req.params.id;
}

// Middleware: verify user has access to the location's project
router.use(async (req: Request, res: Response, next) => {
  try {
    const userId = req.user?.id;
    const locationId = getLocationId(req);

    if (!userId || !locationId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { data: location, error: locError } = await supabase
      .from('locations')
      .select('project_id')
      .eq('id', locationId)
      .single();

    if (locError || !location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', location.project_id)
      .single();

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    let role = 'owner';
    if (project.user_id !== userId) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('role, status')
        .eq('project_id', location.project_id)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (!collaborator) {
        return res.status(403).json({ error: 'Access denied - not authorized for this project' });
      }
      role = collaborator.role;
    }

    if (role === 'viewer' && req.method !== 'GET') {
      return res.status(403).json({ error: 'Read-only access - viewers cannot make changes', role: 'viewer' });
    }

    next();
  } catch (error) {
    console.error('Error in location images access check:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/locations/:locationId/images
router.get("/", async (req: Request, res: Response) => {
  try {
    const locationId = getLocationId(req);
    const { data, error } = await locationImagesService.getLocationImages(locationId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const resolved = await resolveImageUrls(data || [], [
      { field: 'image_url', bucket: BUCKETS.LOCATION_IMAGES }
    ]);

    res.json(resolved);
  } catch (error) {
    console.error('❌ Error fetching location images:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/locations/:locationId/images/primary
router.get("/primary", async (req: Request, res: Response) => {
  try {
    const locationId = getLocationId(req);
    const { data, error } = await locationImagesService.getPrimaryImage(locationId);

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message });
    }

    if (data) {
      const [resolved] = await resolveImageUrls([data], [
        { field: 'image_url', bucket: BUCKETS.LOCATION_IMAGES }
      ]);
      return res.json(resolved);
    }

    res.json(null);
  } catch (error) {
    console.error('❌ Error fetching primary location image:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/locations/:locationId/images/count
router.get("/count", async (req: Request, res: Response) => {
  try {
    const locationId = getLocationId(req);
    const count = await locationImagesService.getImageCount(locationId);
    res.json({ count, max: 3 });
  } catch (error) {
    console.error('❌ Error getting location image count:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/locations/:locationId/images
router.post("/",
  checkProjectArchivedByRecordId("locations", "locationId"),
  upload.single('image'),
  async (req: Request, res: Response) => {
    try {
      const locationId = getLocationId(req);
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { description, image_type, is_primary } = req.body;

      const fileName = `locations/${locationId}/images/${sanitizeFileName(file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from('location-images')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error('❌ Storage upload error:', uploadError);
        return res.status(500).json({ error: uploadError.message });
      }

      const { data, error } = await locationImagesService.createLocationImage({
        location_id: locationId,
        image_url: fileName,
        description,
        image_type: image_type || 'exterior',
        is_primary: is_primary === 'true' || is_primary === true,
        is_ai_generated: false
      });

      if (error) {
        await supabase.storage.from('location-images').remove([fileName]);
        return res.status(400).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Location image uploaded:', data?.id);
      res.status(201).json(data);
    } catch (error) {
      console.error('❌ Error uploading location image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/locations/:locationId/images/:imageId
router.put("/:imageId",
  checkProjectArchivedByRecordId("locations", "locationId"),
  async (req: Request, res: Response) => {
    try {
      const { imageId } = req.params;
      const { description, image_type } = req.body;

      const { data, error } = await locationImagesService.updateLocationImage(imageId, {
        description,
        image_type
      });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Location image updated:', imageId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error updating location image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/locations/:locationId/images/:imageId/set-primary
router.put("/:imageId/set-primary",
  checkProjectArchivedByRecordId("locations", "locationId"),
  async (req: Request, res: Response) => {
    try {
      const { imageId } = req.params;

      const { data, error } = await locationImagesService.setPrimaryImage(imageId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (DEBUG_AI) console.log('✅ Primary location image set:', imageId);
      res.json(data);
    } catch (error) {
      console.error('❌ Error setting primary location image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// POST /api/locations/:locationId/images/reorder
router.post("/reorder",
  checkProjectArchivedByRecordId("locations", "locationId"),
  async (req: Request, res: Response) => {
    try {
      const locationId = getLocationId(req);
      const { imageIds } = req.body;

      if (!Array.isArray(imageIds)) {
        return res.status(400).json({ error: "imageIds must be an array" });
      }

      const result = await locationImagesService.reorderImages(locationId, imageIds);

      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }

      if (DEBUG_AI) console.log('✅ Location images reordered:', locationId);
      res.json('data' in result ? result.data : []);
    } catch (error) {
      console.error('❌ Error reordering location images:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// DELETE /api/locations/:locationId/images/:imageId
router.delete("/:imageId",
  checkProjectArchivedByRecordId("locations", "locationId"),
  async (req: Request, res: Response) => {
    try {
      const { imageId } = req.params;

      const { data: image } = await locationImagesService.getLocationImageById(imageId);

      const { data, error } = await locationImagesService.deleteLocationImage(imageId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Clean up from storage
      if (image?.image_url) {
        try {
          await supabase.storage
            .from('location-images')
            .remove([image.image_url]);
        } catch (storageError) {
          console.warn('⚠️ Failed to delete location image from storage:', storageError);
        }
      }

      if (DEBUG_AI) console.log('✅ Location image deleted:', imageId);
      res.json({ success: true, deleted: data });
    } catch (error) {
      console.error('❌ Error deleting location image:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

export default router;
