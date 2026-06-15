import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { checkProjectArchived, checkProjectArchivedByRecordId } from "../middleware/archiveMiddleware";
import { requireAuth, checkProjectAccess, checkProjectAccessByRecordId } from "../middleware/auth";
import { upload } from "../services/imageService";
import { uploadLocationImage, deleteLocationImage } from "../services/locationImageService";
import { resolveImageUrls, getSignedUrl, BUCKETS } from "../services/storageService";
import { canonicalizeLocationName, getLocationIdentityKey } from "../utils/locationIdentity";
import { sanitizeLocationVisualProfile } from "../utils/visualProfiles";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get all locations for a project
router.get("/", requireAuth, checkProjectAccess, async (req, res) => {
  const { project_id, sort_by, sort_order, scope, episode_id, season_id } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });
  let query = supabase
    .from("locations")
    .select(`
      *,
      production_location:production_locations(
        id,
        name,
        address,
        location_type,
        cost_per_day,
        permits_required,
        availability_dates,
        contact_info,
        notes
      )
    `)
    .eq("project_id", project_id);

  // Scope filtering for series projects
  if (scope) query = query.eq("scope", scope);
  if (episode_id) query = query.eq("episode_id", episode_id);
  if (season_id) query = query.eq("season_id", season_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Sort by story_importance (critical > major > supporting > minor) then by name
  const importanceOrder: Record<string, number> = {
    'critical': 0,
    'major': 1,
    'supporting': 2,
    'minor': 3
  };

  let sortedData = data || [];

  // Apply custom sorting if provided
  if (sort_by) {
    const isAsc = sort_order === 'asc';
    sortedData = sortedData.sort((a: any, b: any) => {
      const valA = a[sort_by as string] ?? '';
      const valB = b[sort_by as string] ?? '';
      const comparison = typeof valA === 'string'
        ? valA.localeCompare(valB)
        : valA - valB;
      return isAsc ? comparison : -comparison;
    });
  } else {
    // Default: sort by story_importance, then alphabetically by name
    sortedData = sortedData.sort((a: any, b: any) => {
      const impA = importanceOrder[a.story_importance] ?? 4;
      const impB = importanceOrder[b.story_importance] ?? 4;
      if (impA !== impB) return impA - impB;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  // Resolve storage paths to signed URLs
  const resolved = await resolveImageUrls(sortedData, [
    { field: 'image_url', bucket: BUCKETS.LOCATION_IMAGES }
  ]);
  res.json(resolved);
});

// Create a location
// NOTE: Frontend sends additional fields: location_type, story_importance, atmosphere, visual_notes, production_location_id
// These need to be added to support full frontend functionality
router.post("/", requireAuth, checkProjectAccess, checkProjectArchived, async (req, res) => {
  const {
    name,
    address,
    description,
    project_id,
    location_type,
    story_importance,
    atmosphere,
    visual_notes,
    visual_profile,
    production_location_id
  } = req.body;
  if (!name || !project_id) return res.status(400).json({ error: "Missing name or project_id" });

  const canonicalName = canonicalizeLocationName(name);
  if (!canonicalName) return res.status(400).json({ error: "Invalid location name" });

  const { data: existingLocations, error: existingError } = await supabase
    .from("locations")
    .select("*")
    .eq("project_id", project_id);
  if (existingError) return res.status(500).json({ error: existingError.message });

  const requestedKey = getLocationIdentityKey(canonicalName);
  const existingLocation = (existingLocations || []).find(
    (location: any) => getLocationIdentityKey(location.name) === requestedKey
  );
  if (existingLocation) {
    return res.json({ ...existingLocation, reused_existing: true });
  }

  // Ensure valid values for constraint fields
  const validatedData: any = {
    name: canonicalName,
    address,
    description,
    project_id,
    location_type: location_type || 'interior',
    story_importance: story_importance || 'supporting',
    atmosphere,
    visual_notes,
    visual_profile: sanitizeLocationVisualProfile(visual_profile)
  };

  // Add production_location_id if provided
  if (production_location_id) {
    validatedData.production_location_id = production_location_id;
  }

  const { data, error } = await supabase
    .from("locations")
    .insert([validatedData])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Upload location image
router.post("/:id/upload-image", requireAuth, checkProjectAccessByRecordId("locations", true), checkProjectArchivedByRecordId("locations"), upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Upload to storage (returns path, not URL)
    const storagePath = await uploadLocationImage(req.file, id);

    // Update location with storage path
    const { data, error } = await supabase
      .from('locations')
      .update({ image_url: storagePath })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Return signed URL for immediate display
    const signedUrl = await getSignedUrl(BUCKETS.LOCATION_IMAGES, storagePath);
    res.json({ image_url: signedUrl, location: data });
  } catch (error: any) {
    console.error('Image upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Note: upload-reference endpoint removed - reference images are now sent as base64 directly in the generation request

// Edit a location
// NOTE: Frontend sends additional fields: location_type, story_importance, atmosphere, visual_notes, production_location_id, image_url
router.put("/:id", requireAuth, checkProjectAccessByRecordId("locations", true), checkProjectArchivedByRecordId("locations"), async (req, res) => {
  const { id } = req.params;
  const {
    name,
    address,
    description,
    location_type,
    story_importance,
    atmosphere,
    visual_notes,
    visual_profile,
    production_location_id,
    image_url
  } = req.body;

  if (!name) return res.status(400).json({ error: "Missing name" });
  const canonicalName = canonicalizeLocationName(name);
  if (!canonicalName) return res.status(400).json({ error: "Invalid location name" });

  const { data: currentLocation, error: currentError } = await supabase
    .from("locations")
    .select("project_id")
    .eq("id", id)
    .single();
  if (currentError || !currentLocation) {
    return res.status(404).json({ error: currentError?.message || "Location not found" });
  }

  const { data: projectLocations, error: locationsError } = await supabase
    .from("locations")
    .select("id, name")
    .eq("project_id", currentLocation.project_id);
  if (locationsError) return res.status(500).json({ error: locationsError.message });

  const requestedKey = getLocationIdentityKey(canonicalName);
  const duplicate = (projectLocations || []).find(
    (location: any) =>
      location.id !== id && getLocationIdentityKey(location.name) === requestedKey
  );
  if (duplicate) {
    return res.status(409).json({
      error: "A matching location already exists",
      existing_location_id: duplicate.id,
    });
  }

  // Build update object with proper defaults for constraint fields
  const updates: any = {
    name: canonicalName,
    address,
    description
  };

  // Only include constraint fields if they have valid values
  if (location_type) updates.location_type = location_type;
  if (story_importance) updates.story_importance = story_importance;
  if (atmosphere !== undefined) updates.atmosphere = atmosphere;
  if (visual_notes !== undefined) updates.visual_notes = visual_notes;
  if (visual_profile !== undefined) {
    updates.visual_profile = sanitizeLocationVisualProfile(visual_profile);
  }

  // Handle production_location_id - can be set to null to remove mapping
  if (production_location_id !== undefined) {
    updates.production_location_id = production_location_id || null;
  }

  // Handle image_url updates
  if (image_url !== undefined) {
    // If image_url is explicitly set to null, delete the old image
    if (image_url === null) {
      const { data: currentLocation } = await supabase
        .from("locations")
        .select("image_url")
        .eq("id", id)
        .single();

      if (currentLocation?.image_url) {
        await deleteLocationImage(currentLocation.image_url);
      }
    }
    updates.image_url = image_url;
  }

  const { data, error } = await supabase
    .from("locations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error('Database update error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Delete a location
router.delete("/:id", requireAuth, checkProjectAccessByRecordId("locations", true), checkProjectArchivedByRecordId("locations"), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase
    .from("locations")
    .delete()
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export default router;
