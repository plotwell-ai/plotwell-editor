import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import castService from '../../services/castService';
import { getUserId, checkProjectAccessForUser, supabase } from './helpers';
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

// =====================================================
// CAST MANAGEMENT ENDPOINTS
// =====================================================

/**
 * Create a new cast member
 * POST /api/production/cast
 */
router.post('/cast', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, ...castData } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // Verify project access (write required for creating cast)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot create cast members' });
    }

    const cast = await castService.createCast(projectId, userId, castData);

    res.json({
      success: true,
      cast
    });

  } catch (error) {
    console.error('Error creating cast member:', error);
    res.status(500).json({
      error: 'Failed to create cast member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get all cast members for a project
 * GET /api/production/cast/:projectId
 */
router.get('/cast/:projectId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const seasonId = req.query.season_id as string | undefined;
    const cast = await castService.getCast(projectId, seasonId);

    res.json({
      success: true,
      cast
    });

  } catch (error) {
    console.error('Error fetching cast:', error);
    res.status(500).json({
      error: 'Failed to fetch cast',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get a single cast member by ID (with day assignments)
 * GET /api/production/cast/:projectId/:castId
 */
router.get('/cast/:projectId/:castId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, castId } = req.params;

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const cast = await castService.getCastById(castId);

    // Also fetch day assignments for this cast member
    const { data: days } = await supabase
      .from('production_cast_days')
      .select('*')
      .eq('cast_id', castId)
      .eq('project_id', projectId)
      .order('shoot_date', { ascending: true });

    res.json({
      success: true,
      cast: {
        ...cast,
        days: days || []
      }
    });

  } catch (error) {
    console.error('Error fetching cast member:', error);
    res.status(500).json({
      error: 'Failed to fetch cast member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Update a cast member
 * PUT /api/production/cast/:castId
 */
router.put('/cast/:castId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId } = req.params;
    const updates = req.body;

    // Get cast member to find project_id
    const existingCast = await castService.getCastById(castId);
    if (!existingCast) {
      return res.status(404).json({ error: 'Cast member not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingCast.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot update cast members' });
    }

    const cast = await castService.updateCast(castId, userId, updates);

    res.json({
      success: true,
      cast
    });

  } catch (error) {
    console.error('Error updating cast member:', error);
    res.status(500).json({
      error: 'Failed to update cast member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Delete a cast member
 * DELETE /api/production/cast/:castId
 */
router.delete('/cast/:castId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId } = req.params;

    // Get cast member to find project_id
    const existingCast = await castService.getCastById(castId);
    if (!existingCast) {
      return res.status(404).json({ error: 'Cast member not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingCast.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete cast members' });
    }

    await castService.deleteCast(castId, userId);

    res.json({
      success: true,
      message: 'Cast member deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting cast member:', error);
    res.status(500).json({
      error: 'Failed to delete cast member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Assign cast member to scenes
 * POST /api/production/cast/:castId/scenes
 */
router.post('/cast/:castId/scenes', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId } = req.params;
    const { projectId, sceneAssignments } = req.body;

    if (!projectId || !Array.isArray(sceneAssignments)) {
      return res.status(400).json({ error: 'projectId and sceneAssignments array are required' });
    }

    // Verify cast belongs to project (and get it)
    const { data: cast, error: castError } = await supabase
      .from('production_cast')
      .select('project_id')
      .eq('id', castId)
      .eq('project_id', projectId)
      .single();

    if (castError || !cast) {
      return res.status(404).json({ error: 'Cast member not found in this project' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot assign cast', role: access.role });
    }

    const assignments = await castService.assignCastToScenes(projectId, userId, castId, sceneAssignments);

    res.json({
      success: true,
      assignments
    });

  } catch (error) {
    console.error('Error assigning cast to scenes:', error);
    res.status(500).json({
      error: 'Failed to assign cast to scenes',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Remove cast member from a scene
 * DELETE /api/production/cast/:castId/scenes/:sceneId
 */
router.delete('/cast/:castId/scenes/:sceneId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId, sceneId } = req.params;

    // Lookup scene's project_id to verify access
    const { data: scene, error: sceneError } = await supabase
      .from('production_scene_data')
      .select('project_id')
      .eq('id', sceneId)
      .single();

    if (sceneError || !scene) {
      return res.status(404).json({ error: 'Scene not found' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(scene.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot remove cast assignments', role: access.role });
    }

    await castService.removeCastFromScene(castId, sceneId, userId);

    res.json({
      success: true,
      message: 'Cast removed from scene successfully'
    });

  } catch (error) {
    console.error('Error removing cast from scene:', error);
    res.status(500).json({
      error: 'Failed to remove cast from scene',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get cast for a specific scene
 * GET /api/production/scene/:sceneId/cast
 */
router.get('/scene/:sceneId/cast', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sceneId } = req.params;

    const cast = await castService.getCastForScene(sceneId);

    res.json({
      success: true,
      cast
    });

  } catch (error) {
    console.error('Error fetching cast for scene:', error);
    res.status(500).json({
      error: 'Failed to fetch cast for scene',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Assign cast member to shooting days
 * POST /api/production/cast/:castId/days
 */
router.post('/cast/:castId/days', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId } = req.params;
    const { project_id, projectId, dates, dayAssignments } = req.body;
    const effectiveProjectId = project_id || projectId;

    if (!effectiveProjectId) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Verify cast belongs to project
    const { data: cast, error: castError } = await supabase
      .from('production_cast')
      .select('project_id')
      .eq('id', castId)
      .eq('project_id', effectiveProjectId)
      .single();

    if (castError || !cast) {
      return res.status(404).json({ error: 'Cast member not found in this project' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(effectiveProjectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot modify cast day assignments', role: access.role });
    }

    // First, delete existing day assignments for this cast member
    const { error: deleteError } = await supabase
      .from('production_cast_days')
      .delete()
      .eq('cast_id', castId)
      .eq('project_id', effectiveProjectId);

    if (deleteError) {
      console.error('Error deleting existing cast day assignments:', deleteError);
    }

    // Handle simple dates array format
    if (dates && Array.isArray(dates)) {
      if (dates.length === 0) {
        return res.json({
          success: true,
          message: 'All cast day assignments removed',
          assignments: []
        });
      }

      const assignments = dates.map((date: string) => ({
        project_id: effectiveProjectId,
        user_id: userId,
        cast_id: castId,
        shoot_date: date
      }));

      const { data, error } = await supabase
        .from('production_cast_days')
        .insert(assignments)
        .select();

      if (error) {
        console.error('Error saving cast day assignments:', error);
        return res.status(500).json({
          error: 'Failed to save cast day assignments',
          details: error.message
        });
      }

      return res.json({
        success: true,
        assignments: data
      });
    }

    // Handle legacy dayAssignments format
    if (dayAssignments && Array.isArray(dayAssignments)) {
      const assignments = dayAssignments.map((assignment: { date: string; callTime?: string; wrapTime?: string; notes?: string }) => ({
        project_id: effectiveProjectId,
        user_id: userId,
        cast_id: castId,
        shoot_date: assignment.date,
        call_time: assignment.callTime || null,
        wrap_time: assignment.wrapTime || null,
        notes: assignment.notes || null
      }));

      const { data, error } = await supabase
        .from('production_cast_days')
        .insert(assignments)
        .select();

      if (error) {
        console.error('Error saving cast day assignments:', error);
        return res.status(500).json({
          error: 'Failed to save cast day assignments',
          details: error.message
        });
      }

      return res.json({
        success: true,
        assignments: data
      });
    }

    return res.status(400).json({ error: 'Either dates array or dayAssignments array is required' });

  } catch (error) {
    console.error('Error saving cast day assignments:', error);
    res.status(500).json({
      error: 'Failed to save cast day assignments',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get cast member by day
 * GET /api/production/cast-by-day/:projectId/:shootDate
 */
router.get('/cast-by-day/:projectId/:shootDate', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    const { data, error } = await supabase
      .from('production_cast_days')
      .select(`
        *,
        cast:production_cast(*)
      `)
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate);

    if (error) {
      console.error('Error fetching cast by day:', error);
      return res.status(500).json({
        error: 'Failed to fetch cast by day',
        details: error.message
      });
    }

    res.json({
      success: true,
      cast: data || []
    });

  } catch (error) {
    console.error('Error fetching cast by day:', error);
    res.status(500).json({
      error: 'Failed to fetch cast by day',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Bulk create cast from characters database
 * POST /api/production/cast/:projectId/bulk-from-characters
 */
router.post('/cast/:projectId/bulk-from-characters', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    // Verify project access
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot create cast members', role: access.role });
    }

    const cast = await castService.bulkCreateCastFromCharacters(projectId, userId);

    res.json({
      success: true,
      cast,
      count: cast.length,
      message: `Created ${cast.length} cast members from characters`
    });

  } catch (error) {
    console.error('Error bulk creating cast:', error);
    res.status(500).json({
      error: 'Failed to bulk create cast',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Update call time for cast in a scene
 * PUT /api/production/cast/:castId/scenes/:sceneId/call-time
 */
router.put('/cast/:castId/scenes/:sceneId/call-time', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { castId, sceneId } = req.params;
    const { callTime } = req.body;

    if (!callTime) {
      return res.status(400).json({ error: 'callTime is required' });
    }

    // Lookup scene's project_id to verify access
    const { data: scene, error: sceneError } = await supabase
      .from('production_scene_data')
      .select('project_id')
      .eq('id', sceneId)
      .single();

    if (sceneError || !scene) {
      return res.status(404).json({ error: 'Scene not found' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(scene.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot update call times', role: access.role });
    }

    const assignment = await castService.updateCallTime(castId, sceneId, userId, callTime);

    res.json({
      success: true,
      assignment
    });

  } catch (error) {
    console.error('Error updating call time:', error);
    res.status(500).json({
      error: 'Failed to update call time',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =====================================================
// EPISODE CAST ASSIGNMENTS
// =====================================================

// Get cast members assigned to an episode
router.get('/episode/:episodeId', requireAuth, async (req, res) => {
  try {
    const { episodeId } = req.params;

    const { data, error } = await supabase
      .from('episode_cast')
      .select(`
        *,
        production_cast (
          id, character_name, actor_name, category, actor_contact, rate_per_day
        )
      `)
      .eq('episode_id', episodeId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('❌ GET EPISODE CAST ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch episode cast' });
  }
});

// Assign cast member to episode
router.post('/episode-assign', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { cast_member_id, episode_id, status = 'confirmed', notes } = req.body;

    if (!cast_member_id || !episode_id) {
      return res.status(400).json({ error: 'Missing cast_member_id or episode_id' });
    }

    // Lookup episode to get project_id
    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('project_id')
      .eq('id', episode_id)
      .single();

    if (episodeError || !episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(episode.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot assign cast to episodes', role: access.role });
    }

    const { data, error } = await supabase
      .from('episode_cast')
      .upsert({
        cast_member_id,
        episode_id,
        status,
        notes: notes || null,
      }, { onConflict: 'cast_member_id,episode_id' })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (DEBUG_AI) console.log(`🎬 Cast member ${cast_member_id} assigned to episode ${episode_id}`);
    res.json(data);
  } catch (error) {
    console.error('❌ ASSIGN EPISODE CAST ERROR:', error);
    res.status(500).json({ error: 'Failed to assign cast to episode' });
  }
});

// Remove cast member from episode
router.delete('/episode-unassign', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { cast_member_id, episode_id } = req.body;

    if (!cast_member_id || !episode_id) {
      return res.status(400).json({ error: 'Missing cast_member_id or episode_id' });
    }

    // Lookup episode to get project_id
    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('project_id')
      .eq('id', episode_id)
      .single();

    if (episodeError || !episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(episode.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot unassign cast from episodes', role: access.role });
    }

    const { error } = await supabase
      .from('episode_cast')
      .delete()
      .eq('cast_member_id', cast_member_id)
      .eq('episode_id', episode_id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ UNASSIGN EPISODE CAST ERROR:', error);
    res.status(500).json({ error: 'Failed to unassign cast from episode' });
  }
});

export default router;
