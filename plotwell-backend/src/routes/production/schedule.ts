import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth';
import scheduleService from '../../services/scheduleService';
import callSheetService from '../../services/callSheetService';
import { getUserId, supabase, checkProjectAccessForUser } from './helpers';

const router = Router();

/**
 * Middleware: verify the authenticated user can access req.params.projectId
 * (owner or active collaborator). Write methods additionally require edit rights.
 */
async function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    if (req.method !== 'GET' && !access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot make changes', role: access.role });
    }

    next();
  } catch (error) {
    console.error('Error verifying project access:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =====================================================
// SCHEDULE MANAGEMENT ENDPOINTS
// =====================================================

/**
 * Get shooting schedule for a project
 * GET /api/production/schedule/:projectId
 */
router.get('/schedule/:projectId', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    const schedule = await scheduleService.getSchedule(projectId);

    res.json({
      success: true,
      schedule
    });

  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({
      error: 'Failed to fetch schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Assign a scene to a shoot date
 * PUT /api/production/schedule/scene/:sceneId
 */
router.put('/schedule/scene/:sceneId', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sceneId } = req.params;
    const { shootDate, shootDay } = req.body;

    if (!shootDate) {
      return res.status(400).json({ error: 'shootDate is required' });
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

    // Verify project access
    const access = await checkProjectAccessForUser(scene.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot modify schedule', role: access.role });
    }

    const updated = await scheduleService.assignSceneToDate(sceneId, shootDate, shootDay);

    res.json({
      success: true,
      scene: updated
    });

  } catch (error) {
    console.error('Error assigning scene to date:', error);
    res.status(500).json({
      error: 'Failed to assign scene to date',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Bulk reorder scenes
 * PUT /api/production/schedule/:projectId/reorder
 */
router.put('/schedule/:projectId/reorder', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    const { sceneOrder } = req.body;

    if (!Array.isArray(sceneOrder)) {
      return res.status(400).json({ error: 'sceneOrder array is required' });
    }

    const result = await scheduleService.reorderScenes(projectId, userId, sceneOrder);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Error reordering scenes:', error);
    res.status(500).json({
      error: 'Failed to reorder scenes',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * AI-powered schedule optimization
 * POST /api/production/schedule/:projectId/optimize
 */
router.post('/schedule/:projectId/optimize', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    const options = req.body; // OptimizationOptions

    const result = await scheduleService.optimizeSchedule(projectId, userId, options);

    res.json(result);

  } catch (error) {
    console.error('Error optimizing schedule:', error);
    res.status(500).json({
      error: 'Failed to optimize schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get daily breakdown for a specific date
 * GET /api/production/schedule/:projectId/daily/:shootDate
 */
router.get('/schedule/:projectId/daily/:shootDate', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    const scenes = await scheduleService.getDailyBreakdown(projectId, shootDate);

    res.json({
      success: true,
      scenes,
      date: shootDate
    });

  } catch (error) {
    console.error('Error fetching daily breakdown:', error);
    res.status(500).json({
      error: 'Failed to fetch daily breakdown',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Clear all schedule data
 * DELETE /api/production/schedule/:projectId
 */
router.delete('/schedule/:projectId', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    const result = await scheduleService.clearSchedule(projectId, userId);

    res.json({
      success: true,
      message: 'Schedule cleared successfully'
    });

  } catch (error) {
    console.error('Error clearing schedule:', error);
    res.status(500).json({
      error: 'Failed to clear schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =====================================================
// SHOOTING DAY SETTINGS ENDPOINTS
// =====================================================

/**
 * Get shooting day settings for a specific date
 * GET /api/production/day-settings/:projectId/:shootDate
 */
router.get('/day-settings/:projectId/:shootDate', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    const { data, error } = await supabase
      .from('shooting_day_settings')
      .select('*')
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error fetching day settings:', error);
      return res.status(500).json({ error: 'Failed to fetch day settings' });
    }

    // Return defaults if no settings exist
    const settings = data || {
      general_call_time: '07:00',
      department_call_times: {},
      estimated_wrap_time: null,
      notes: '',
      primary_location: ''
    };

    res.json({
      success: true,
      settings
    });

  } catch (error) {
    console.error('Error fetching day settings:', error);
    res.status(500).json({
      error: 'Failed to fetch day settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Update or create shooting day settings for a specific date
 * PUT /api/production/day-settings/:projectId/:shootDate
 */
router.put('/day-settings/:projectId/:shootDate', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;
    const {
      general_call_time,
      department_call_times,
      estimated_wrap_time,
      notes,
      primary_location
    } = req.body;

    // Upsert the settings (insert or update)
    const { data, error } = await supabase
      .from('shooting_day_settings')
      .upsert({
        project_id: projectId,
        user_id: userId,
        shoot_date: shootDate,
        general_call_time: general_call_time || '07:00',
        department_call_times: department_call_times || {},
        estimated_wrap_time: estimated_wrap_time || null,
        notes: notes || '',
        primary_location: primary_location || '',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'project_id,shoot_date'
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving day settings:', error);
      return res.status(500).json({ error: 'Failed to save day settings' });
    }

    res.json({
      success: true,
      settings: data
    });

  } catch (error) {
    console.error('Error saving day settings:', error);
    res.status(500).json({
      error: 'Failed to save day settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get all shooting day settings for a project
 * GET /api/production/day-settings/:projectId
 */
router.get('/day-settings/:projectId', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    const { data, error } = await supabase
      .from('shooting_day_settings')
      .select('*')
      .eq('project_id', projectId)
      .order('shoot_date');

    if (error) {
      console.error('Error fetching all day settings:', error);
      return res.status(500).json({ error: 'Failed to fetch day settings' });
    }

    res.json({
      success: true,
      settings: data || []
    });

  } catch (error) {
    console.error('Error fetching all day settings:', error);
    res.status(500).json({
      error: 'Failed to fetch day settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =====================================================
// CALL SHEET ENDPOINTS
// =====================================================

/**
 * Get all scheduled shooting days for a project
 * GET /api/production/call-sheet/:projectId/days
 * NOTE: This route MUST be defined before /:shootDate to avoid "days" being parsed as a date
 */
router.get('/call-sheet/:projectId/days', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    const { episode_id } = req.query;

    const days = await callSheetService.getShootingDays(projectId, episode_id as string | undefined);

    res.json({
      success: true,
      days
    });

  } catch (error) {
    console.error('Error fetching shooting days:', error);
    res.status(500).json({
      error: 'Failed to fetch shooting days',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Generate call sheet for a specific date
 * GET /api/production/call-sheet/:projectId/:shootDate
 */
router.get('/call-sheet/:projectId/:shootDate', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    const callSheet = await callSheetService.generateCallSheet(projectId, shootDate);

    res.json({
      success: true,
      callSheet
    });

  } catch (error) {
    console.error('Error generating call sheet:', error);
    res.status(500).json({
      error: 'Failed to generate call sheet',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get call sheet as formatted text (for PDF/print)
 * GET /api/production/call-sheet/:projectId/:shootDate/text
 */
router.get('/call-sheet/:projectId/:shootDate/text', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    const callSheet = await callSheetService.generateCallSheet(projectId, shootDate);
    const formattedText = callSheetService.formatAsText(callSheet);

    res.json({
      success: true,
      text: formattedText,
      callSheet
    });

  } catch (error) {
    console.error('Error formatting call sheet:', error);
    res.status(500).json({
      error: 'Failed to format call sheet',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
