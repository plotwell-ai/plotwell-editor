import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth";
import { extractUserId, PricingRequest } from "../middleware/pricingMiddleware";
import { isEpisodic } from "../utils/projectType";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get all seasons for a project
router.get("/projects/:projectId/seasons", requireAuth, extractUserId, async (req: PricingRequest, res) => {
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

    // Check if user is owner or collaborator
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

    // Check if project is episodic (TV series or vertical series)
    if (!isEpisodic(project.project_type)) {
      return res.status(400).json({ error: "Project is not a series" });
    }

    // Get all seasons for the project
    const { data: seasons, error: seasonsError } = await supabase
      .from("seasons")
      .select("*")
      .eq("project_id", projectId)
      .order("season_number", { ascending: true });

    if (seasonsError) {
      console.error('❌ SEASONS ERROR:', seasonsError);
      return res.status(500).json({ error: seasonsError.message });
    }

    res.json(seasons || []);
  } catch (error) {
    console.error('❌ GET SEASONS EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single season
router.get("/seasons/:seasonId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;

  try {
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select(`
        *,
        projects!inner (
          id,
          user_id,
          project_type
        )
      `)
      .eq("id", seasonId)
      .single();

    if (seasonError || !season) {
      console.error('❌ SEASON ERROR:', seasonError);
      return res.status(404).json({ error: "Season not found" });
    }

    // Check access
    const isOwner = season.projects.user_id === userId;
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

    res.json(season);
  } catch (error) {
    console.error('❌ GET SEASON EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new season
router.post("/projects/:projectId/seasons", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { projectId } = req.params;
  const seasonData = req.body;

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

    // Check if project is episodic (TV series or vertical series)
    if (!isEpisodic(project.project_type)) {
      return res.status(400).json({ error: "Project is not a series" });
    }

    // Check if user has edit access
    const isOwner = project.user_id === userId;
    let hasEditAccess = isOwner;

    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      hasEditAccess = collaboration && ['owner', 'admin', 'editor'].includes(collaboration.role);
    }

    if (!hasEditAccess) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Create season
    const { data: newSeason, error: createError } = await supabase
      .from("seasons")
      .insert({
        project_id: projectId,
        season_number: seasonData.season_number,
        title: seasonData.title || `Season ${seasonData.season_number}`,
        description: seasonData.description,
        production_start_date: seasonData.production_start_date,
        production_end_date: seasonData.production_end_date,
        air_date: seasonData.air_date,
        status: seasonData.status || 'planning',
        settings: seasonData.settings || {}
      })
      .select()
      .single();

    if (createError) {
      console.error('❌ CREATE SEASON ERROR:', createError);

      // Handle duplicate season number error
      if (createError.code === '23505' && createError.message.includes('seasons_project_id_season_number_key')) {
        return res.status(409).json({
          error: "Season already exists",
          message: `A season with number ${seasonData.season_number} already exists for this project.`
        });
      }

      return res.status(500).json({ error: createError.message });
    }

    res.status(201).json(newSeason);
  } catch (error) {
    console.error('❌ CREATE SEASON EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a season
router.put("/seasons/:seasonId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;
  const updateData = req.body;

  try {
    // Get season with project info
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select(`
        *,
        projects!inner (
          id,
          user_id
        )
      `)
      .eq("id", seasonId)
      .single();

    if (seasonError || !season) {
      console.error('❌ SEASON ERROR:', seasonError);
      return res.status(404).json({ error: "Season not found" });
    }

    // Check if user has edit access
    const isOwner = season.projects.user_id === userId;
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

    // Update season
    const { data: updatedSeason, error: updateError } = await supabase
      .from("seasons")
      .update({
        season_number: updateData.season_number,
        title: updateData.title,
        description: updateData.description,
        production_start_date: updateData.production_start_date,
        production_end_date: updateData.production_end_date,
        air_date: updateData.air_date,
        status: updateData.status,
        settings: updateData.settings
      })
      .eq("id", seasonId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ UPDATE SEASON ERROR:', updateError);

      // Handle duplicate season number error
      if (updateError.code === '23505' && updateError.message.includes('seasons_project_id_season_number_key')) {
        return res.status(409).json({
          error: "Season number already exists",
          message: `Another season with number ${updateData.season_number} already exists for this project. Please choose a different season number.`
        });
      }

      return res.status(500).json({ error: updateError.message });
    }

    res.json(updatedSeason);
  } catch (error) {
    console.error('❌ UPDATE SEASON EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a season
router.delete("/seasons/:seasonId", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;

  try {
    // Get season with project info
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select(`
        *,
        projects!inner (
          id,
          user_id
        )
      `)
      .eq("id", seasonId)
      .single();

    if (seasonError || !season) {
      console.error('❌ SEASON ERROR:', seasonError);
      return res.status(404).json({ error: "Season not found" });
    }

    // Check if user has delete access (owner or admin only)
    const isOwner = season.projects.user_id === userId;
    let hasDeleteAccess = isOwner;

    if (!isOwner) {
      const { data: collaboration } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", season.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      hasDeleteAccess = collaboration && ['owner', 'admin'].includes(collaboration.role);
    }

    if (!hasDeleteAccess) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Check if season has episodes
    const { data: episodes, error: episodesError } = await supabase
      .from("episodes")
      .select("id")
      .eq("season_id", seasonId);

    if (episodesError) {
      console.error('❌ CHECK EPISODES ERROR:', episodesError);
      return res.status(500).json({ error: episodesError.message });
    }

    if (episodes && episodes.length > 0) {
      return res.status(400).json({
        error: "Cannot delete season with episodes",
        message: `This season has ${episodes.length} episode(s). Please delete all episodes first.`
      });
    }

    // Delete season (only if empty)
    const { error: deleteError } = await supabase
      .from("seasons")
      .delete()
      .eq("id", seasonId);

    if (deleteError) {
      console.error('❌ DELETE SEASON ERROR:', deleteError);
      return res.status(500).json({ error: deleteError.message });
    }

    res.json({ message: "Season deleted successfully" });
  } catch (error) {
    console.error('❌ DELETE SEASON EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Season Dashboard
// ============================================================================

// Get season dashboard with episode statuses, character matrix, budget rollup
router.get("/seasons/:seasonId/dashboard", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;

  try {
    // Get season with project access check
    const { data: season } = await supabase
      .from("seasons")
      .select(`id, project_id, season_number, title, projects!inner (id, user_id)`)
      .eq("id", seasonId)
      .single();

    if (!season) return res.status(404).json({ error: "Season not found" });

    // @ts-ignore
    const isOwner = season.projects?.user_id === userId;
    if (!isOwner) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", season.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();
      if (!collab) return res.status(403).json({ error: "Access denied" });
    }

    // Fetch episodes, character appearances, budgets in parallel
    const [episodesRes, charMappingsRes, budgetRes] = await Promise.all([
      supabase
        .from("episodes")
        .select("id, episode_number, title, status, runtime")
        .eq("season_id", seasonId)
        .order("episode_number"),
      supabase
        .from("episode_characters")
        .select(`
          character_id,
          role_type,
          episodes!inner (id, episode_number, season_id)
        `)
        .eq("episodes.season_id", seasonId),
      supabase
        .from("production_budgets")
        .select("episode_id, total")
        .eq("project_id", season.project_id),
    ]);

    const episodes = episodesRes.data || [];
    const charMappings = charMappingsRes.data || [];
    const budgetItems = budgetRes.data || [];

    // Episode statuses
    const episodeList = episodes.map(ep => {
      const epBudgets = budgetItems.filter((b: any) => b.episode_id === ep.id);
      const epBudgetTotal = epBudgets.reduce((sum: number, b: any) => sum + (b.total || 0), 0);
      return {
        id: ep.id,
        episodeNumber: ep.episode_number,
        title: ep.title,
        status: ep.status,
        runtime: ep.runtime,
        budgetTotal: epBudgetTotal,
      };
    });

    // Total runtime
    const totalRuntime = episodes.reduce((sum, ep) => sum + (ep.runtime || 0), 0);

    // Budget rollup
    const episodeIds = new Set(episodes.map(ep => ep.id));
    const seasonBudgetTotal = budgetItems
      .filter((b: any) => episodeIds.has(b.episode_id))
      .reduce((sum: number, b: any) => sum + (b.total || 0), 0);

    // Character appearance matrix (unique characters across episodes)
    const characterMap = new Map<string, { characterId: string; episodes: number[] }>();
    for (const m of charMappings) {
      const charId = (m as any).character_id;
      const epNum = (m as any).episodes?.episode_number;
      if (!charId || !epNum) continue;
      if (!characterMap.has(charId)) {
        characterMap.set(charId, { characterId: charId, episodes: [] });
      }
      characterMap.get(charId)!.episodes.push(epNum);
    }

    res.json({
      seasonId,
      seasonNumber: season.season_number,
      seasonTitle: season.title,
      episodes: episodeList,
      episodeCount: episodes.length,
      totalRuntime,
      seasonBudgetTotal,
      characterAppearances: Array.from(characterMap.values()),
    });
  } catch (error) {
    console.error('❌ SEASON DASHBOARD EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Season Budget Summary
// ============================================================================

router.get("/seasons/:seasonId/budget-summary", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId;
  const { seasonId } = req.params;

  try {
    const { data: season } = await supabase
      .from("seasons")
      .select("id, project_id, season_number, projects!inner (id, user_id)")
      .eq("id", seasonId)
      .single();

    if (!season) return res.status(404).json({ error: "Season not found" });

    // @ts-ignore
    if (season.projects?.user_id !== userId) {
      const { data: collab } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", season.project_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .single();
      if (!collab) return res.status(403).json({ error: "Access denied" });
    }

    // Get all episodes for this season
    const { data: episodes } = await supabase
      .from("episodes")
      .select("id, episode_number, title")
      .eq("season_id", seasonId)
      .order("episode_number");

    const episodeIds = (episodes || []).map(e => e.id);

    // Get all budget items for these episodes
    const { data: budgetItems } = await supabase
      .from("production_budgets")
      .select("episode_id, category, total")
      .in("episode_id", episodeIds.length > 0 ? episodeIds : ['__none__']);

    // Build per-episode and per-category totals
    const episodeTotals = (episodes || []).map(ep => {
      const epItems = (budgetItems || []).filter((b: any) => b.episode_id === ep.id);
      const total = epItems.reduce((sum: number, b: any) => sum + (b.total || 0), 0);
      return {
        episodeId: ep.id,
        episodeNumber: ep.episode_number,
        episodeTitle: ep.title,
        total,
      };
    });

    const categoryTotals: Record<string, number> = {};
    for (const item of (budgetItems || [])) {
      const cat = (item as any).category || 'other';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + ((item as any).total || 0);
    }

    const seasonTotal = episodeTotals.reduce((sum, ep) => sum + ep.total, 0);

    res.json({
      seasonId,
      seasonNumber: season.season_number,
      seasonTotal,
      episodeTotals,
      categoryTotals,
    });
  } catch (error) {
    console.error('❌ SEASON BUDGET SUMMARY ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
