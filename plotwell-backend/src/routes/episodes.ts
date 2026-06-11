import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth";
import { extractUserId, PricingRequest } from "../middleware/pricingMiddleware";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get all episodes for a season
router.get("/seasons/:seasonId/episodes", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;

  try {
    // Verify user has access to season
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select(`
        id,
        project_id,
        projects!inner (
          id,
          user_id
        )
      `)
      .eq("id", seasonId)
      .single();

    if (seasonError || !season) {
      console.error('❌ SEASON ACCESS ERROR:', seasonError);
      return res.status(404).json({ error: "Season not found" });
    }

    // Check if user is owner or collaborator
    // @ts-ignore - Supabase types nested relations as arrays but returns objects with !inner
    const isOwner = season.projects?.user_id === userId;
    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", season.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collaboration) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Get all episodes for the season
    const { data: episodes, error: episodesError } = await supabase
      .from("episodes")
      .select("*")
      .eq("season_id", seasonId)
      .order("episode_number", { ascending: true });

    if (episodesError) {
      console.error('❌ EPISODES ERROR:', episodesError);
      return res.status(500).json({ error: episodesError.message });
    }

    res.json(episodes || []);
  } catch (error) {
    console.error('❌ GET EPISODES EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all episodes for a project (across all seasons)
router.get("/projects/:projectId/episodes", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { projectId } = req.params;

  try {
    // Verify user has access to project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, user_id, project_type")
      .eq("id", projectId)
      .eq("deleted", false)
      .single();

    if (projectError || !project) {
      console.error('❌ PROJECT ACCESS ERROR:', projectError);
      return res.status(404).json({ error: "Project not found" });
    }

    // Check access
    const isOwner = project.user_id === userId;
    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collaboration) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Get all episodes for the project with season info
    // Note: Films also have episodes (1 season, 1 episode) in unified system
    const { data: episodes, error: episodesError } = await supabase
      .from("episodes")
      .select(`
        *,
        seasons!inner (
          season_number,
          title
        )
      `)
      .eq("project_id", projectId)
      .order("episode_number", { ascending: true });

    if (episodesError) {
      console.error('❌ EPISODES ERROR:', episodesError);
      return res.status(500).json({ error: episodesError.message });
    }

    // Sort by season number first, then episode number (PostgREST doesn't support ordering by joined table columns)
    const sortedEpisodes = episodes?.sort((a: any, b: any) => {
      if (a.seasons.season_number !== b.seasons.season_number) {
        return a.seasons.season_number - b.seasons.season_number;
      }
      return a.episode_number - b.episode_number;
    }) || [];

    res.json(sortedEpisodes);
  } catch (error) {
    console.error('❌ GET PROJECT EPISODES EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single episode
router.get("/episodes/:episodeId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { episodeId } = req.params;

  try {
    const { data: episode, error: episodeError } = await supabase
      .from("episodes")
      .select(`
        *,
        seasons!inner (
          id,
          season_number,
          title,
          projects!inner (
            id,
            user_id
          )
        )
      `)
      .eq("id", episodeId)
      .single();

    if (episodeError || !episode) {
      console.error('❌ EPISODE ERROR:', episodeError);
      return res.status(404).json({ error: "Episode not found" });
    }

    // Check access
    const isOwner = episode.seasons.projects.user_id === userId;
    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", episode.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collaboration) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    res.json(episode);
  } catch (error) {
    console.error('❌ GET EPISODE EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new episode
router.post("/seasons/:seasonId/episodes", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;
  const episodeData = req.body;

  try {
    // Verify user has access to season
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select(`
        id,
        project_id,
        projects!inner (
          id,
          user_id
        )
      `)
      .eq("id", seasonId)
      .single();

    if (seasonError || !season) {
      console.error('❌ SEASON ACCESS ERROR:', seasonError);
      return res.status(404).json({ error: "Season not found" });
    }

    // Check if user has edit access
    // @ts-ignore - Supabase types nested relations as arrays but returns objects with !inner
    const isOwner = season.projects?.user_id === userId;
    let hasEditAccess = isOwner;

    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", season.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      hasEditAccess = collaboration && ['owner', 'admin', 'editor'].includes(collaboration.role);
    }

    if (!hasEditAccess) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Create episode
    const { data: newEpisode, error: createError } = await supabase
      .from("episodes")
      .insert({
        season_id: seasonId,
        // project_id will be set automatically by trigger
        episode_number: episodeData.episode_number,
        title: episodeData.title,
        synopsis: episodeData.synopsis,
        writer: episodeData.writer,
        director: episodeData.director,
        production_start_date: episodeData.production_start_date,
        production_end_date: episodeData.production_end_date,
        air_date: episodeData.air_date,
        runtime: episodeData.runtime,
        status: episodeData.status || 'outline',
        settings: episodeData.settings || {}
      })
      .select()
      .single();

    if (createError) {
      console.error('❌ CREATE EPISODE ERROR:', createError);
      return res.status(500).json({ error: createError.message });
    }

    res.status(201).json(newEpisode);
  } catch (error) {
    console.error('❌ CREATE EPISODE EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update an episode
router.put("/episodes/:episodeId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { episodeId } = req.params;
  const updateData = req.body;

  try {
    // Get episode with project info
    const { data: episode, error: episodeError } = await supabase
      .from("episodes")
      .select(`
        *,
        seasons!inner (
          id,
          projects!inner (
            id,
            user_id
          )
        )
      `)
      .eq("id", episodeId)
      .single();

    if (episodeError || !episode) {
      console.error('❌ EPISODE ERROR:', episodeError);
      return res.status(404).json({ error: "Episode not found" });
    }

    // Check if user has edit access
    const isOwner = episode.seasons.projects.user_id === userId;
    let hasEditAccess = isOwner;

    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", episode.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      hasEditAccess = collaboration && ['owner', 'admin', 'editor'].includes(collaboration.role);
    }

    if (!hasEditAccess) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Update episode
    const { data: updatedEpisode, error: updateError } = await supabase
      .from("episodes")
      .update({
        episode_number: updateData.episode_number,
        title: updateData.title,
        synopsis: updateData.synopsis,
        writer: updateData.writer,
        director: updateData.director,
        production_start_date: updateData.production_start_date,
        production_end_date: updateData.production_end_date,
        air_date: updateData.air_date,
        runtime: updateData.runtime,
        status: updateData.status,
        script_id: updateData.script_id,
        settings: updateData.settings
      })
      .eq("id", episodeId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ UPDATE EPISODE ERROR:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    res.json(updatedEpisode);
  } catch (error) {
    console.error('❌ UPDATE EPISODE EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an episode
router.delete("/episodes/:episodeId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { episodeId } = req.params;

  try {
    // Get episode with project info
    const { data: episode, error: episodeError } = await supabase
      .from("episodes")
      .select(`
        *,
        seasons!inner (
          id,
          projects!inner (
            id,
            user_id
          )
        )
      `)
      .eq("id", episodeId)
      .single();

    if (episodeError || !episode) {
      console.error('❌ EPISODE ERROR:', episodeError);
      return res.status(404).json({ error: "Episode not found" });
    }

    // Check if user has delete access (owner or admin only)
    // @ts-ignore - Supabase types nested relations as arrays but returns objects with !inner
    const isOwner = episode.seasons?.projects?.user_id === userId;
    let hasDeleteAccess = isOwner;

    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", episode.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      hasDeleteAccess = collaboration && ['owner', 'admin'].includes(collaboration.role);
    }

    if (!hasDeleteAccess) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Delete episode
    const { error: deleteError } = await supabase
      .from("episodes")
      .delete()
      .eq("id", episodeId);

    if (deleteError) {
      console.error('❌ DELETE EPISODE ERROR:', deleteError);
      return res.status(500).json({ error: deleteError.message });
    }

    res.json({ message: "Episode deleted successfully" });
  } catch (error) {
    console.error('❌ DELETE EPISODE EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Cross-Episode Character/Location Mapping
// ============================================================================

// Get all episodes a specific character appears in
router.get("/characters/:characterId/episodes", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { characterId } = req.params;

  try {
    // Get character with project access check
    const { data: character, error: charError } = await supabase
      .from("characters")
      .select("id, project_id, name")
      .eq("id", characterId)
      .single();

    if (charError || !character) {
      return res.status(404).json({ error: "Character not found" });
    }

    // Verify access
    const { data: project } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", character.project_id)
      .eq("deleted", false)
      .single();

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", character.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collab) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Get episode appearances with episode details
    const { data: appearances, error } = await supabase
      .from("episode_characters")
      .select(`
        role_type,
        screen_time_estimate,
        episodes!inner (
          id,
          episode_number,
          title,
          season_id,
          seasons!inner (
            season_number,
            title
          )
        )
      `)
      .eq("character_id", characterId);

    if (error) {
      console.error('❌ EPISODE CHARACTERS ERROR:', error);
      return res.status(500).json({ error: error.message });
    }

    // Flatten the response
    const episodes = (appearances || []).map((a: any) => ({
      episodeId: a.episodes.id,
      episodeNumber: a.episodes.episode_number,
      episodeTitle: a.episodes.title,
      seasonId: a.episodes.season_id,
      seasonNumber: a.episodes.seasons.season_number,
      seasonTitle: a.episodes.seasons.title,
      roleType: a.role_type,
      screenTimeEstimate: a.screen_time_estimate,
    }));

    res.json({ characterId, characterName: character.name, episodes });
  } catch (error) {
    console.error('❌ GET CHARACTER EPISODES EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full character-episode matrix for a project
router.get("/projects/:projectId/episode-characters", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { projectId } = req.params;

  try {
    // Verify access
    const { data: project } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .eq("deleted", false)
      .single();

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collab) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Get all characters for this project
    const { data: characters, error: charError } = await supabase
      .from("characters")
      .select("id, name, scope")
      .eq("project_id", projectId);

    if (charError) {
      return res.status(500).json({ error: charError.message });
    }

    // Get all episode-character mappings for this project's episodes
    const { data: mappings, error: mapError } = await supabase
      .from("episode_characters")
      .select(`
        character_id,
        role_type,
        screen_time_estimate,
        episodes!inner (
          id,
          episode_number,
          season_id
        )
      `)
      .in("character_id", (characters || []).map(c => c.id));

    if (mapError) {
      return res.status(500).json({ error: mapError.message });
    }

    // Build matrix: character -> episodes
    const matrix = (characters || []).map(char => {
      const charMappings = (mappings || []).filter((m: any) => m.character_id === char.id);
      return {
        characterId: char.id,
        characterName: char.name,
        scope: char.scope,
        episodes: charMappings.map((m: any) => ({
          episodeId: m.episodes.id,
          episodeNumber: m.episodes.episode_number,
          seasonId: m.episodes.season_id,
          roleType: m.role_type,
          screenTimeEstimate: m.screen_time_estimate,
        })),
        episodeCount: charMappings.length,
      };
    });

    res.json({ matrix });
  } catch (error) {
    console.error('❌ GET EPISODE CHARACTERS MATRIX EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all episodes a specific location appears in
router.get("/locations/:locationId/episodes", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { locationId } = req.params;

  try {
    const { data: location, error: locError } = await supabase
      .from("locations")
      .select("id, project_id, name")
      .eq("id", locationId)
      .single();

    if (locError || !location) {
      return res.status(404).json({ error: "Location not found" });
    }

    // Verify access
    const { data: project } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", location.project_id)
      .eq("deleted", false)
      .single();

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", location.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collab) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    const { data: appearances, error } = await supabase
      .from("episode_locations")
      .select(`
        scene_count,
        episodes!inner (
          id,
          episode_number,
          title,
          season_id,
          seasons!inner (
            season_number,
            title
          )
        )
      `)
      .eq("location_id", locationId);

    if (error) {
      console.error('❌ EPISODE LOCATIONS ERROR:', error);
      return res.status(500).json({ error: error.message });
    }

    const episodes = (appearances || []).map((a: any) => ({
      episodeId: a.episodes.id,
      episodeNumber: a.episodes.episode_number,
      episodeTitle: a.episodes.title,
      seasonId: a.episodes.season_id,
      seasonNumber: a.episodes.seasons.season_number,
      seasonTitle: a.episodes.seasons.title,
      sceneCount: a.scene_count,
    }));

    res.json({ locationId, locationName: location.name, episodes });
  } catch (error) {
    console.error('❌ GET LOCATION EPISODES EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full location-episode matrix for a project
router.get("/projects/:projectId/episode-locations", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { projectId } = req.params;

  try {
    const { data: project } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .eq("deleted", false)
      .single();

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      if (!collab) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    const { data: locations, error: locError } = await supabase
      .from("locations")
      .select("id, name, scope")
      .eq("project_id", projectId);

    if (locError) {
      return res.status(500).json({ error: locError.message });
    }

    const { data: mappings, error: mapError } = await supabase
      .from("episode_locations")
      .select(`
        location_id,
        scene_count,
        episodes!inner (
          id,
          episode_number,
          season_id
        )
      `)
      .in("location_id", (locations || []).map(l => l.id));

    if (mapError) {
      return res.status(500).json({ error: mapError.message });
    }

    const matrix = (locations || []).map(loc => {
      const locMappings = (mappings || []).filter((m: any) => m.location_id === loc.id);
      return {
        locationId: loc.id,
        locationName: loc.name,
        scope: loc.scope,
        episodes: locMappings.map((m: any) => ({
          episodeId: m.episodes.id,
          episodeNumber: m.episodes.episode_number,
          seasonId: m.episodes.season_id,
          sceneCount: m.scene_count,
        })),
        episodeCount: locMappings.length,
      };
    });

    res.json({ matrix });
  } catch (error) {
    console.error('❌ GET EPISODE LOCATIONS MATRIX EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
