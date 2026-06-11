import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { getUserId, checkProjectAccessForUser, supabase } from './helpers';
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

// =====================================================
// CREW MANAGEMENT ROUTES
// =====================================================

/**
 * POST /api/production/crew
 * Create a new crew member
 */
router.post('/crew', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, name, role, department, contact, rate_per_day, rate_per_hour, availability_dates, notes, season_id } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot create crew members', role: access.role });
    }

    const insertData: Record<string, any> = {
      project_id: projectId,
      user_id: userId,
      name,
      role,
      department,
      contact: contact || {},
      rate_per_day,
      rate_per_hour,
      availability_dates,
      notes
    };

    if (season_id) {
      insertData.season_id = season_id;
    }

    const { data: crew, error } = await supabase
      .from('production_crew')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error creating crew member:', error);
      return res.status(500).json({ error: 'Failed to create crew member' });
    }

    res.json({
      success: true,
      crew
    });
  } catch (error) {
    console.error('Error creating crew member:', error);
    res.status(500).json({
      error: 'Failed to create crew member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/production/crew/:projectId
 * Get all crew members for a project
 */
router.get('/crew/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const seasonId = req.query.season_id as string | undefined;

    let crewQuery = supabase
      .from('production_crew')
      .select('*')
      .eq('project_id', projectId);

    if (seasonId) {
      crewQuery = crewQuery.eq('season_id', seasonId);
    } else {
      crewQuery = crewQuery.is('season_id', null);
    }

    const { data: crew, error } = await crewQuery
      .order('department', { ascending: true })
      .order('role', { ascending: true });

    if (error) {
      console.error('Error fetching crew:', error);
      return res.status(500).json({ error: 'Failed to fetch crew' });
    }

    // Fetch assigned days for all crew members
    const crewIds = (crew || []).map(c => c.id);
    let crewWithDays = crew || [];

    if (crewIds.length > 0) {
      const { data: allDays, error: daysError } = await supabase
        .from('production_crew_days')
        .select('crew_id, shoot_date')
        .in('crew_id', crewIds);

      if (!daysError && allDays) {
        // Group days by crew_id
        const daysByCrewId: Record<string, string[]> = {};
        for (const day of allDays) {
          if (!daysByCrewId[day.crew_id]) {
            daysByCrewId[day.crew_id] = [];
          }
          daysByCrewId[day.crew_id].push(day.shoot_date);
        }

        // Attach assignedDays to each crew member
        crewWithDays = crew.map(c => ({
          ...c,
          assignedDays: daysByCrewId[c.id] || []
        }));
      }
    }

    res.json({
      success: true,
      crew: crewWithDays
    });
  } catch (error) {
    console.error('Error fetching crew:', error);
    res.status(500).json({
      error: 'Failed to fetch crew',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/production/crew/:projectId/:crewId
 * Get a specific crew member with their day assignments
 */
router.get('/crew/:projectId/:crewId', requireAuth, async (req, res) => {
  try {
    const { projectId, crewId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get crew member
    const { data: crew, error: crewError } = await supabase
      .from('production_crew')
      .select('*')
      .eq('id', crewId)
      .eq('project_id', projectId)
      .single();

    if (crewError) {
      console.error('Error fetching crew member:', crewError);
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Get day assignments
    const { data: days, error: daysError } = await supabase
      .from('production_crew_days')
      .select('*')
      .eq('crew_id', crewId)
      .order('shoot_date', { ascending: true });

    if (daysError) {
      console.error('Error fetching crew days:', daysError);
    }

    res.json({
      success: true,
      crew: {
        ...crew,
        days: days || []
      }
    });
  } catch (error) {
    console.error('Error fetching crew member:', error);
    res.status(500).json({
      error: 'Failed to fetch crew member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PUT /api/production/crew/:crewId
 * Update a crew member
 */
router.put('/crew/:crewId', requireAuth, async (req, res) => {
  try {
    const { crewId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get crew member to find project_id
    const { data: existingCrew, error: fetchError } = await supabase
      .from('production_crew')
      .select('project_id')
      .eq('id', crewId)
      .single();

    if (fetchError || !existingCrew) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingCrew.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot update crew members' });
    }

    const { name, role, department, contact, rate_per_day, rate_per_hour, availability_dates, notes, season_id } = req.body;

    const updateData: Record<string, any> = {
      name,
      role,
      department,
      contact,
      rate_per_day,
      rate_per_hour,
      availability_dates,
      notes,
      updated_at: new Date().toISOString()
    };

    // Allow setting or clearing season_id
    if (season_id !== undefined) {
      updateData.season_id = season_id || null;
    }

    const { data: crew, error } = await supabase
      .from('production_crew')
      .update(updateData)
      .eq('id', crewId)
      .select()
      .single();

    if (error) {
      console.error('Error updating crew member:', error);
      return res.status(500).json({ error: 'Failed to update crew member' });
    }

    res.json({
      success: true,
      crew
    });
  } catch (error) {
    console.error('Error updating crew member:', error);
    res.status(500).json({
      error: 'Failed to update crew member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/production/crew/:crewId
 * Delete a crew member
 */
router.delete('/crew/:crewId', requireAuth, async (req, res) => {
  try {
    const { crewId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get crew member to find project_id
    const { data: existingCrew, error: fetchError } = await supabase
      .from('production_crew')
      .select('project_id')
      .eq('id', crewId)
      .single();

    if (fetchError || !existingCrew) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingCrew.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete crew members' });
    }

    const { error } = await supabase
      .from('production_crew')
      .delete()
      .eq('id', crewId);

    if (error) {
      console.error('Error deleting crew member:', error);
      return res.status(500).json({ error: 'Failed to delete crew member' });
    }

    res.json({
      success: true,
      message: 'Crew member deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting crew member:', error);
    res.status(500).json({
      error: 'Failed to delete crew member',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/production/crew/:crewId/days
 * Assign crew member to shooting days
 */
router.post('/crew/:crewId/days', requireAuth, async (req, res) => {
  try {
    const { crewId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { project_id, projectId, dates, dayAssignments } = req.body;
    const effectiveProjectId = project_id || projectId;

    if (!effectiveProjectId) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Verify crew belongs to project
    const { data: crew, error: crewError } = await supabase
      .from('production_crew')
      .select('project_id')
      .eq('id', crewId)
      .eq('project_id', effectiveProjectId)
      .single();

    if (crewError || !crew) {
      return res.status(404).json({ error: 'Crew member not found in this project' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(effectiveProjectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot modify crew day assignments', role: access.role });
    }

    // First, delete existing day assignments for this crew member
    const { error: deleteError } = await supabase
      .from('production_crew_days')
      .delete()
      .eq('crew_id', crewId)
      .eq('project_id', effectiveProjectId);

    if (deleteError) {
      console.error('Error clearing crew days:', deleteError);
    }

    // Handle simple dates array format
    if (dates && Array.isArray(dates)) {
      if (dates.length === 0) {
        // Just cleared all assignments
        return res.json({
          success: true,
          assignments: []
        });
      }

      const assignments = dates.map((date: string) => ({
        project_id: effectiveProjectId,
        user_id: userId,
        crew_id: crewId,
        shoot_date: date
      }));

      const { data, error } = await supabase
        .from('production_crew_days')
        .insert(assignments)
        .select();

      if (error) {
        console.error('Error assigning crew to days:', error);
        return res.status(500).json({ error: 'Failed to assign crew to days' });
      }

      return res.json({
        success: true,
        assignments: data
      });
    }

    // Handle detailed dayAssignments format (legacy)
    if (dayAssignments && Array.isArray(dayAssignments)) {
      const assignments = dayAssignments.map((day: any) => ({
        project_id: effectiveProjectId,
        user_id: userId,
        crew_id: crewId,
        shoot_date: day.shoot_date,
        call_time: day.call_time,
        wrap_time: day.wrap_time,
        hours_worked: day.hours_worked,
        overtime_hours: day.overtime_hours,
        notes: day.notes
      }));

      const { data, error } = await supabase
        .from('production_crew_days')
        .insert(assignments)
        .select();

      if (error) {
        console.error('Error assigning crew to days:', error);
        return res.status(500).json({ error: 'Failed to assign crew to days' });
      }

      return res.json({
        success: true,
        assignments: data
      });
    }

    return res.status(400).json({ error: 'dates or dayAssignments array is required' });
  } catch (error) {
    console.error('Error assigning crew to days:', error);
    res.status(500).json({
      error: 'Failed to assign crew to days',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/production/crew/:crewId/days/:shootDate
 * Remove crew member from a specific day
 */
router.delete('/crew/:crewId/days/:shootDate', requireAuth, async (req, res) => {
  try {
    const { crewId, shootDate } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get crew member to find project_id
    const { data: crew, error: crewError } = await supabase
      .from('production_crew')
      .select('project_id')
      .eq('id', crewId)
      .single();

    if (crewError || !crew) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(crew.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot modify crew assignments' });
    }

    const { error } = await supabase
      .from('production_crew_days')
      .delete()
      .eq('crew_id', crewId)
      .eq('shoot_date', shootDate);

    if (error) {
      console.error('Error removing crew from day:', error);
      return res.status(500).json({ error: 'Failed to remove crew from day' });
    }

    res.json({
      success: true,
      message: 'Crew removed from day successfully'
    });
  } catch (error) {
    console.error('Error removing crew from day:', error);
    res.status(500).json({
      error: 'Failed to remove crew from day',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/production/crew-by-day/:projectId/:shootDate
 * Get all crew assigned to a specific shooting day
 */
router.get('/crew-by-day/:projectId/:shootDate', requireAuth, async (req, res) => {
  try {
    const { projectId, shootDate } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: crewDays, error } = await supabase
      .from('production_crew_days')
      .select(`
        *,
        production_crew (*)
      `)
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate);

    if (error) {
      console.error('Error fetching crew for day:', error);
      return res.status(500).json({ error: 'Failed to fetch crew for day' });
    }

    res.json({
      success: true,
      crew: crewDays || []
    });
  } catch (error) {
    console.error('Error fetching crew for day:', error);
    res.status(500).json({
      error: 'Failed to fetch crew for day',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =====================================================
// EPISODE CREW ASSIGNMENTS
// =====================================================

// Get crew members assigned to an episode
router.get('/episode/:episodeId', requireAuth, async (req, res) => {
  try {
    const { episodeId } = req.params;

    const { data, error } = await supabase
      .from('episode_crew')
      .select(`
        *,
        production_crew (
          id, name, role, department, contact, rate_per_day, rate_per_hour
        )
      `)
      .eq('episode_id', episodeId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('❌ GET EPISODE CREW ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch episode crew' });
  }
});

// Assign crew member to episode
router.post('/episode-assign', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { crew_member_id, episode_id, status = 'confirmed', notes } = req.body;

    if (!crew_member_id || !episode_id) {
      return res.status(400).json({ error: 'Missing crew_member_id or episode_id' });
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
      return res.status(403).json({ error: 'Read-only access - viewers cannot assign crew to episodes', role: access.role });
    }

    const { data, error } = await supabase
      .from('episode_crew')
      .upsert({
        crew_member_id,
        episode_id,
        status,
        notes: notes || null,
      }, { onConflict: 'crew_member_id,episode_id' })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (DEBUG_AI) console.log(`🎬 Crew member ${crew_member_id} assigned to episode ${episode_id}`);
    res.json(data);
  } catch (error) {
    console.error('❌ ASSIGN EPISODE CREW ERROR:', error);
    res.status(500).json({ error: 'Failed to assign crew to episode' });
  }
});

// Remove crew member from episode
router.delete('/episode-unassign', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { crew_member_id, episode_id } = req.body;

    if (!crew_member_id || !episode_id) {
      return res.status(400).json({ error: 'Missing crew_member_id or episode_id' });
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
      return res.status(403).json({ error: 'Read-only access - viewers cannot unassign crew from episodes', role: access.role });
    }

    const { error } = await supabase
      .from('episode_crew')
      .delete()
      .eq('crew_member_id', crew_member_id)
      .eq('episode_id', episode_id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ UNASSIGN EPISODE CREW ERROR:', error);
    res.status(500).json({ error: 'Failed to unassign crew from episode' });
  }
});

export default router;
