import express from "express";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, checkProjectAccess } from "../middleware/auth";
import { extractUserId, addPricingService, requireFeature, checkWritePermissions } from "../middleware/pricingMiddleware";
import { generateSceneId } from "../services/sceneIdentityService";
import { parseScriptContent } from "../services/scriptParsingService";
import { resolveImageUrls, BUCKETS, detectBucket } from "../services/storageService";
import { sanitizeFileName } from "../services/imageService";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = express.Router();

/**
 * Resolve image_url in storyboard panels to signed URLs.
 * Panels can have images from storyboard-images (AI generated) or project-assets (user uploaded).
 */
async function resolveStoryboardPanelUrls(panels: any[]): Promise<any[]> {
  if (!panels.length) return panels;

  const { getSignedUrl } = await import("../services/storageService");
  const result = panels.map(p => ({ ...p }));

  for (let i = 0; i < result.length; i++) {
    const imageUrl = result[i].image_url;
    if (imageUrl) {
      // Detect which bucket this image belongs to
      const bucket = detectBucket(imageUrl);
      if (bucket) {
        result[i].image_url = await getSignedUrl(bucket, imageUrl);
      } else if (!imageUrl.startsWith('http')) {
        // Plain path without identifiable bucket - try storyboard-images first, then project-assets
        result[i].image_url = await getSignedUrl(
          imageUrl.startsWith('ai-generated/') ? BUCKETS.STORYBOARD_IMAGES : BUCKETS.PROJECT_ASSETS,
          imageUrl
        );
      }
    }

    // Sign the generated video path so the player gets a playable URL.
    const videoUrl = result[i].video_url;
    if (videoUrl && !videoUrl.startsWith('http')) {
      result[i].video_url = await getSignedUrl(BUCKETS.GENERATED_VIDEO, videoUrl);
    }
  }

  return result;
}
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const upload = multer({ storage: multer.memoryStorage() });

// =====================================================
// SCENE ENDPOINTS
// =====================================================

// Get scenes from script (for scene selector)
router.get("/scenes", requireAuth, checkProjectAccess, extractUserId, addPricingService, requireFeature('storyboards'), async (req, res) => {
  const { project_id, episode_id } = req.query;

  if (!project_id) {
    return res.status(400).json({ error: "Missing project_id" });
  }

  try {
    let scriptId: string | null = null;

    if (episode_id) {
      // TV Series: Get the episode's script_id
      const { data: episode } = await supabase
        .from('episodes')
        .select('script_id')
        .eq('id', episode_id)
        .single();

      if (episode?.script_id) {
        scriptId = episode.script_id;
      }
    } else {
      // Film: Use same script priority as production (active_script_id > prod_script_id > latest)
      // This ensures scene_id hashes are consistent between storyboard and shot list import
      const { data: project } = await supabase
        .from('projects')
        .select('prod_script_id, active_script_id')
        .eq('id', project_id)
        .single();

      scriptId = project?.active_script_id || project?.prod_script_id || null;
    }

    // Fetch the script content
    let script = null;
    if (scriptId) {
      const { data } = await supabase
        .from('scripts')
        .select('id, content')
        .eq('id', scriptId)
        .single();
      script = data;
    }

    // Fallback: latest script for project
    if (!script) {
      const { data: latestScript } = await supabase
        .from('scripts')
        .select('id, content')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      script = latestScript;
    }

    if (!script) {
      if (DEBUG_AI) console.log('❌ No script found for project');
      return res.status(404).json({
        error: 'No script found. Please create a script first.',
        redirect_to: `/dashboard/${project_id}?section=script`
      });
    }

    // Extract scenes using the existing script parsing service
    const scenes = parseScriptContent(script.content);

    if (scenes.length === 0) {
      if (DEBUG_AI) console.log('⚠️ No scenes found in script');
      return res.json([]);
    }

    // Generate scene IDs for all scenes first
    const scenesWithIds = scenes.map((scene: any) => ({
      ...scene,
      scene_id: generateSceneId({
        scene_number: scene.scene_number,
        heading: scene.heading,
        location: scene.location,
        time_of_day: scene.time_of_day,
        int_ext: scene.int_ext,
        action_content: scene.action_content || '',
        characters: scene.characters || []
      })
    }));

    // Batch query: Get all panel counts for this project in ONE query
    // This replaces N+1 pattern (270 queries → 1 query)
    const { data: allPanels } = await supabase
      .from('storyboard_panels')
      .select('scene_id')
      .eq('project_id', project_id);

    // Build a lookup map of scene_id → panel count
    const panelCountMap: Record<string, number> = {};
    if (allPanels) {
      for (const panel of allPanels) {
        if (panel.scene_id) {
          panelCountMap[panel.scene_id] = (panelCountMap[panel.scene_id] || 0) + 1;
        }
      }
    }

    // Enrich scenes with panel_count from the lookup map (no additional queries)
    const enrichedScenes = scenesWithIds.map((scene: any) => ({
      scene_id: scene.scene_id,
      scene_number: scene.scene_number,
      heading: scene.heading,
      location: scene.location || '',
      time_of_day: scene.time_of_day || '',
      content: (scene.action_content || '').trim(),
      panel_count: panelCountMap[scene.scene_id] || 0
    }));

    res.json(enrichedScenes);

  } catch (error) {
    console.error('❌ ERROR FETCHING SCENES:', error);
    res.status(500).json({ error: 'Failed to fetch scenes' });
  }
});

// =====================================================
// PANEL ENDPOINTS
// =====================================================

// Get storyboard panels
router.get("/", requireAuth, checkProjectAccess, extractUserId, addPricingService, requireFeature('storyboards'), async (req, res) => {
  const { project_id, episode_id, scene_id } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // Build query with optional episode and scene filters
  let query = supabase
    .from("storyboard_panels")
    .select("*")
    .eq("project_id", project_id);

  // Filter by episode if provided, otherwise get project-level panels (episode_id IS NULL)
  if (episode_id) {
    query = query.eq("episode_id", episode_id);
  } else {
    query = query.is("episode_id", null);
  }

  // Filter by scene if provided (NEW)
  if (scene_id) {
    query = query.eq("scene_id", scene_id);
  }

  const { data, error } = await query.order("panel_number", { ascending: true });

  if (error) {
    console.error('❌ ERROR FETCHING PANELS:', error);
    return res.status(500).json({ error: error.message });
  }

  // Resolve storage paths to signed URLs (panels may use storyboard-images or project-assets bucket)
  const resolved = await resolveStoryboardPanelUrls(data || []);
  res.json(resolved);
});

// Get storyboard panels by project ID (for direct project access)
router.get("/:project_id", requireAuth, checkProjectAccess, extractUserId, addPricingService, requireFeature('storyboards'), async (req, res) => {
  const { project_id } = req.params;
  const { episode_id, scene_id } = req.query;

  // Build query with optional episode and scene filters
  let query = supabase
    .from("storyboard_panels")
    .select("*")
    .eq("project_id", project_id);

  // Filter by episode if provided, otherwise get project-level panels (episode_id IS NULL)
  if (episode_id) {
    query = query.eq("episode_id", episode_id);
  } else {
    query = query.is("episode_id", null);
  }

  // Filter by scene if provided (NEW)
  if (scene_id) {
    query = query.eq("scene_id", scene_id);
  }

  const { data, error } = await query.order("panel_number", { ascending: true });

  if (error) {
    console.error('❌ ERROR FETCHING PANELS:', error);
    return res.status(500).json({ error: error.message });
  }

  // Resolve storage paths to signed URLs
  const resolved = await resolveStoryboardPanelUrls(data || []);
  res.json(resolved);
});

// Create storyboard panel
router.post("/", requireAuth, extractUserId, addPricingService, requireFeature('storyboards'), checkWritePermissions, async (req, res) => {
  const {
    project_id,
    episode_id, // Optional episode ID for TV series
    scene_id,   // Required for scene-based storyboards
    scene_number,  // Required for display
    scene_heading, // Required for UI
    panel_number,  // Optional - will be auto-calculated if not provided
    scene_description,
    shot_type,
    camera_movement,
    camera_direction, // Optional - explicit per-shot camera move (drives video animation)
    duration,
    notes,
    lighting,
    mood,
    linked_character_ids, // Optional - array of character UUIDs (max 3)
    linked_location_id, // Optional - location UUID for AI image reference
  } = req.body;

  // Validation: require scene fields for new storyboards
  if (!project_id || !scene_description) {
    return res.status(400).json({ error: "Missing project_id or scene_description" });
  }

  if (!scene_id || scene_number == null || !scene_heading) {
    return res.status(400).json({
      error: "Missing scene_id, scene_number, or scene_heading. Scene-based fields are required."
    });
  }

  if (DEBUG_AI) console.log('🚀 CREATE STORYBOARD PANEL:', { project_id, episode_id, scene_id, scene_number });

  try {
    // Auto-calculate panel_number if not provided
    let finalPanelNumber = panel_number;

    if (!finalPanelNumber) {
      // Count existing panels for this scene
      let countQuery = supabase
        .from('storyboard_panels')
        .select('panel_number', { count: 'exact' })
        .eq('project_id', project_id)
        .eq('scene_id', scene_id);

      if (episode_id) {
        countQuery = countQuery.eq('episode_id', episode_id);
      }

      const { count } = await countQuery;
      finalPanelNumber = (count || 0) + 1;

      if (DEBUG_AI) console.log(`  📊 Auto-calculated panel_number: ${finalPanelNumber} (${count} existing panels)`);
    }

    const panelData: any = {
      project_id,
      scene_id,
      scene_number,
      scene_heading,
      panel_number: finalPanelNumber,
      scene_description,
      shot_type,
      camera_movement,
      camera_direction: camera_direction || '',
      duration,
      notes,
      lighting: lighting || '',
      mood: mood || '',
    };

    // Add episode_id only if provided (for TV series)
    if (episode_id) {
      panelData.episode_id = episode_id;
    }

    // Add linked_character_ids if provided (max 3)
    if (linked_character_ids && Array.isArray(linked_character_ids)) {
      panelData.linked_character_ids = linked_character_ids.slice(0, 3);
    }

    // Add linked_location_id if provided
    if (linked_location_id) {
      panelData.linked_location_id = linked_location_id;
    }

    const { data, error } = await supabase
      .from("storyboard_panels")
      .insert([panelData])
      .select()
      .single();

    if (error) {
      console.error('❌ ERROR CREATING PANEL:', error);
      return res.status(500).json({ error: error.message });
    }

    if (DEBUG_AI) console.log(`✅ PANEL CREATED: ${data.id} (panel #${finalPanelNumber} in scene ${scene_number})`);
    res.json(data);

  } catch (error) {
    console.error('❌ UNEXPECTED ERROR:', error);
    res.status(500).json({ error: 'Failed to create storyboard panel' });
  }
});

// Reorder storyboard panels (MUST be before /:id route)
router.put("/reorder", requireAuth, extractUserId, addPricingService, requireFeature('storyboards'), checkWritePermissions, async (req, res) => {

  const { project_id, episode_id, updates } = req.body;

  if (!project_id || !updates || !Array.isArray(updates)) {
    return res.status(400).json({
      error: "Missing project_id or updates array"
    });
  }

  try {
    // Strategy: First set all panel numbers to temporary high values to avoid conflicts
    // Then update them to their final values

    // Build base query filter
    const buildFilter = (query: any) => {
      query = query.eq("project_id", project_id);
      // Filter by episode context
      if (episode_id) {
        query = query.eq("episode_id", episode_id);
      } else {
        query = query.is("episode_id", null);
      }
      return query;
    };

    // Step 1: Set all panels to temporary high numbers (1000+)
    const tempUpdatePromises = updates.map(async (update: { id: string; panel_number: number }, index) => {
      const tempNumber = 1000 + index; // Use 1000+ as temp numbers
      let query = supabase
        .from("storyboard_panels")
        .update({ panel_number: tempNumber })
        .eq("id", update.id);
      query = buildFilter(query);
      return await query;
    });

    const tempResults = await Promise.all(tempUpdatePromises);
    const tempFailures = tempResults.filter(result => result.error);

    if (tempFailures.length > 0) {
      console.error("❌ Failed temp updates:", tempFailures.map(r => r.error?.message));
      return res.status(500).json({ error: "Failed to prepare panel reordering" });
    }

    // Step 2: Update to final panel numbers
    const finalUpdatePromises = updates.map(async (update: { id: string; panel_number: number }) => {
      let query = supabase
        .from("storyboard_panels")
        .update({ panel_number: update.panel_number })
        .eq("id", update.id);
      query = buildFilter(query);
      return await query;
    });

    const finalResults = await Promise.all(finalUpdatePromises);
    const finalFailures = finalResults.filter(result => result.error);

    if (finalFailures.length > 0) {
      console.error("❌ Failed final updates:", finalFailures.map(r => r.error?.message));
      return res.status(500).json({ error: "Failed to finalize panel reordering" });
    }

    res.json({ success: true, updated: updates.length });
  } catch (error) {
    console.error("Reorder error:", error);
    res.status(500).json({ error: "Failed to reorder panels" });
  }
});

// Update storyboard panel
router.put("/:id", requireAuth, extractUserId, addPricingService, requireFeature('storyboards'), checkWritePermissions, async (req, res) => {
  const { id } = req.params;

  const {
    scene_description,
    shot_type,
    camera_movement,
    camera_direction, // Optional - explicit per-shot camera move (drives video animation)
    duration,
    notes,
    lighting,
    mood,
    image_url,
    image_fidelity, // Optional - 'sketch' | 'cinematic'; gates Animate (cinematic only)
    linked_character_ids, // Optional - array of character UUIDs (max 3)
    linked_location_id, // Optional - location UUID for AI image reference
  } = req.body;

  if (!scene_description) {
    return res.status(400).json({ error: "Scene description is required" });
  }

  const updateData: any = {
    scene_description,
    shot_type,
    camera_movement,
    duration,
    notes,
    lighting: lighting ?? '',
    mood: mood ?? '',
    image_url,
  };

  // Persist camera direction only when explicitly provided, so image-only updates
  // (e.g. regenerating the still) don't wipe an existing camera move.
  if (camera_direction !== undefined) {
    updateData.camera_direction = camera_direction || '';
  }

  // Persist image fidelity when provided. Clearing the image clears fidelity too.
  if (image_fidelity !== undefined) {
    updateData.image_fidelity = image_fidelity || null;
  } else if (image_url === null) {
    updateData.image_fidelity = null;
  }

  // Add linked_character_ids if provided (max 3), or set to empty array if explicitly passed
  if (linked_character_ids !== undefined) {
    updateData.linked_character_ids = Array.isArray(linked_character_ids)
      ? linked_character_ids.slice(0, 3)
      : [];
  }

  // Add linked_location_id if provided, or set to null if explicitly cleared
  if (linked_location_id !== undefined) {
    updateData.linked_location_id = linked_location_id || null;
  }

  // If the source image is changing (regenerated, replaced, or removed), any
  // existing video was generated from the OLD still and no longer matches the
  // panel — invalidate it so the UI shows the new image + Animate again.
  if (image_url !== undefined) {
    const { data: current } = await supabase
      .from("storyboard_panels")
      .select("image_url, video_url, video_status")
      .eq("id", id)
      .single();

    if (current && image_url !== current.image_url && (current.video_url || current.video_status)) {
      Object.assign(updateData, {
        video_status: null,
        video_url: null,
        video_job_id: null,
        video_duration: null,
        video_model: null,
        video_error: null,
        video_created_at: null,
      });
    }
  }

  const { data, error } = await supabase
    .from("storyboard_panels")
    .update(updateData)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Delete storyboard panel
router.delete("/:id", requireAuth, extractUserId, addPricingService, requireFeature('storyboards'), checkWritePermissions, async (req: any, res: any) => {
  const { id } = req.params;
  
  if (DEBUG_AI) console.log('🗑️ Delete storyboard panel request:', id);
  if (DEBUG_AI) console.log('🗑️ User from request:', req.userId);

  try {
    // First check if panel exists
    const { data: existingPanel, error: checkError } = await supabase
      .from("storyboard_panels")
      .select('*')
      .eq("id", id)
      .single();

    if (checkError) {
      console.error('❌ Error checking panel existence:', checkError);
      return res.status(404).json({ error: "Panel not found" });
    }

    // Delete the panel
    const { error } = await supabase
      .from("storyboard_panels")
      .delete()
      .eq("id", id);

    if (error) {
      console.error('❌ Delete error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('❌ Unexpected error in delete route:', error);
    res.status(500).json({ error: error.message || 'Unknown error occurred' });
  }
});

// Upload panel image
router.post("/:id/upload-image", requireAuth, extractUserId, addPricingService, requireFeature('storyboards'), checkWritePermissions, upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "No image file provided" });
  }

  try {
    const safeName = sanitizeFileName(file.originalname);
    const fileName = `storyboard/${uuidv4()}.${safeName.split('.').pop()}`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("project-assets")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    // Store the path (not public URL) - signed URLs generated on read.
    // Uploaded images are treated as cinematic so they can be animated.
    // A new image replaces the old one, so invalidate any existing video.
    const { data, error } = await supabase
      .from("storyboard_panels")
      .update({
        image_url: fileName,
        image_fidelity: 'cinematic',
        video_status: null,
        video_url: null,
        video_job_id: null,
        video_duration: null,
        video_model: null,
        video_error: null,
        video_created_at: null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Return signed URL for immediate display
    const { getSignedUrl, BUCKETS } = await import("../services/storageService");
    const signedUrl = await getSignedUrl(BUCKETS.PROJECT_ASSETS, fileName);
    res.json({ image_url: signedUrl });
  } catch (error) {
    res.status(500).json({ error: "Failed to upload image" });
  }
});

export default router;