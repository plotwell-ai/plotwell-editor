/**
 * Beat Sheet Routes - Story Structure Planning
 *
 * Handles CRUD operations for beats (story structure planning cards)
 * Supports both film projects and TV series (episode-level beats)
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../config/database';
import { requireAuth, getUserId } from '../middleware/auth';
import { extractUserId } from '../middleware/pricingMiddleware';
import { BeatExportService } from '../services/beatExportService';

const router = Router();

function normalizeBeatAct(act?: string | null): string {
  const normalized = String(act || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'act1':
    case 'act_1':
      return 'act1';
    case 'act2':
    case 'act_2':
    case 'act_2a':
    case 'act2a':
      return 'act2a';
    case 'act_2b':
    case 'act2b':
      return 'act2b';
    case 'act3':
    case 'act_3':
      return 'act3';
    case 'act4':
    case 'act_4':
      return 'act4';
    case 'act5':
    case 'act_5':
      return 'act5';
    case 'custom':
      return 'custom';
    default:
      return 'act1';
  }
}

/**
 * Helper: Check if user has access to a project (owner OR active collaborator)
 * Returns: { hasAccess: boolean, isOwner: boolean, role: string | null }
 */
async function checkProjectAccessForUser(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  isOwner: boolean;
  role: string | null;
  canEdit: boolean;
}> {
  // Check if user is the project owner
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .eq('deleted', false)
    .single();

  if (projectError || !project) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  if (project.user_id === userId) {
    return { hasAccess: true, isOwner: true, role: 'owner', canEdit: true };
  }

  // Check if user is a collaborator
  const { data: collaborator, error: collabError } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (collabError || !collaborator) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  const canEdit = ['owner', 'admin', 'editor'].includes(collaborator.role);
  return { hasAccess: true, isOwner: false, role: collaborator.role, canEdit };
}

// Apply middleware to all routes
router.use(requireAuth);
router.use(extractUserId);

// =============================================================================
// GET ALL BEATS FOR PROJECT
// =============================================================================

/**
 * GET /api/projects/:projectId/beats
 * Get all beats for a project (film) or all beats across all episodes (TV series)
 */
router.get('/projects/:projectId/beats', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const userId = req.userId;

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId as string);
    if (!access.hasAccess) {
      console.error('❌ PROJECT ACCESS DENIED:', { projectId, userId });
      return res.status(404).json({ error: 'Project not found or access denied' });
    }

    // Get all beats for project, ordered by order
    const { data: beats, error: beatsError } = await supabase
      .from('beats')
      .select(`
        *,
        episodes:episode_id (
          id,
          title,
          episode_number
        )
      `)
      .eq('project_id', projectId)
      .order('order', { ascending: true });

    if (beatsError) {
      console.error('❌ BEATS FETCH ERROR:', beatsError);
      return res.status(500).json({ error: 'Failed to fetch beats' });
    }

    res.json(beats || []);

  } catch (error) {
    console.error('❌ GET BEATS ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// GET BEATS FOR SPECIFIC EPISODE
// =============================================================================

/**
 * GET /api/projects/:projectId/episodes/:episodeId/beats
 * Get beats for a specific episode (TV series)
 */
router.get('/projects/:projectId/episodes/:episodeId/beats', async (req: Request, res: Response) => {
  try {
    const { projectId, episodeId } = req.params;
    const userId = req.userId;

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId as string);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Project not found or access denied' });
    }

    // Verify episode belongs to project
    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('id, title, episode_number')
      .eq('id', episodeId)
      .eq('project_id', projectId)
      .single();

    if (episodeError || !episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    // Get beats for episode
    const { data: beats, error: beatsError } = await supabase
      .from('beats')
      .select('*')
      .eq('episode_id', episodeId)
      .order('order', { ascending: true });

    if (beatsError) {
      console.error('❌ EPISODE BEATS FETCH ERROR:', beatsError);
      return res.status(500).json({ error: 'Failed to fetch episode beats' });
    }

    res.json(beats || []);

  } catch (error) {
    console.error('❌ GET EPISODE BEATS ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// CREATE BEAT
// =============================================================================

/**
 * POST /api/projects/:projectId/beats
 * Create a new beat
 */
router.post('/projects/:projectId/beats', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const userId = req.userId;
    const {
      episode_id,
      title,
      description,
      notes,
      act,
      beat_type,
      color,
      page_estimate,
      duration_estimate,
      order,
      template_id,
      ai_generated,
      ai_confidence
    } = req.body;

    // Verify project access and edit permission (owner OR editor/admin collaborator)
    const access = await checkProjectAccessForUser(projectId, userId as string);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Project not found or access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot create beats' });
    }

    // If episode_id provided, verify it belongs to project
    if (episode_id) {
      const { data: episode, error: episodeError } = await supabase
        .from('episodes')
        .select('id')
        .eq('id', episode_id)
        .eq('project_id', projectId)
        .single();

      if (episodeError || !episode) {
        return res.status(404).json({ error: 'Episode not found' });
      }
    }

    // If order not provided, get next order number
    let finalOrder = order;
    if (finalOrder === undefined || finalOrder === null) {
      const query = supabase
        .from('beats')
        .select('order')
        .eq('project_id', projectId);

      if (episode_id) {
        query.eq('episode_id', episode_id);
      }

      const { data: existingBeats } = await query.order('order', { ascending: false }).limit(1);

      finalOrder = existingBeats && existingBeats.length > 0
        ? existingBeats[0].order + 1
        : 0;
    }

    // Create beat
    const { data: beat, error: createError } = await supabase
      .from('beats')
      .insert([{
        project_id: projectId,
        episode_id: episode_id || null,
        title,
        description: description || null,
        notes: notes || null,
        order: finalOrder,
        act: normalizeBeatAct(act),
        beat_type: beat_type || 'custom',
        color: color || '#3b82f6',
        page_estimate: page_estimate || 1,
        duration_estimate: duration_estimate || null,
        template_id: template_id || null,
        ai_generated: ai_generated || false,
        ai_confidence: ai_confidence || null,
        conversion_status: 'not_converted'
      }])
      .select()
      .single();

    if (createError) {
      console.error('❌ BEAT CREATE ERROR:', createError);
      return res.status(500).json({ error: 'Failed to create beat' });
    }

    res.status(201).json(beat);

  } catch (error) {
    console.error('❌ CREATE BEAT ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// UPDATE BEAT
// =============================================================================

/**
 * PATCH /api/beats/:beatId
 * Update an existing beat
 */
router.patch('/beats/:beatId', async (req: Request, res: Response) => {
  try {
    const { beatId } = req.params;
    const userId = req.userId;
    const updates = req.body;

    // Get beat and its project_id
    const { data: beat, error: beatError } = await supabase
      .from('beats')
      .select('id, project_id')
      .eq('id', beatId)
      .single();

    if (beatError || !beat) {
      return res.status(404).json({ error: 'Beat not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(beat.project_id, userId as string);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot update beats' });
    }

    // Only allow specific fields to be updated
    const allowedFields = [
      'title', 'description', 'notes', 'order', 'act', 'beat_type',
      'color', 'page_estimate', 'duration_estimate', 'script_id', 'scene_number',
      'conversion_status', 'template_id'
    ];

    const updateData: any = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateData[field] = field === 'act' ? normalizeBeatAct(updates[field]) : updates[field];
      }
    }

    // Update beat
    const { data: updatedBeat, error: updateError } = await supabase
      .from('beats')
      .update(updateData)
      .eq('id', beatId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ BEAT UPDATE ERROR:', updateError);
      return res.status(500).json({ error: 'Failed to update beat' });
    }

    res.json(updatedBeat);

  } catch (error) {
    console.error('❌ UPDATE BEAT ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// DELETE BEAT
// =============================================================================

/**
 * DELETE /api/beats/:beatId
 * Delete a beat
 */
router.delete('/beats/:beatId', async (req: Request, res: Response) => {
  try {
    const { beatId } = req.params;
    const userId = req.userId;

    // Get beat and its project_id
    const { data: beat, error: beatError } = await supabase
      .from('beats')
      .select('id, project_id')
      .eq('id', beatId)
      .single();

    if (beatError || !beat) {
      return res.status(404).json({ error: 'Beat not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(beat.project_id, userId as string);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete beats' });
    }

    // Delete beat
    const { error: deleteError } = await supabase
      .from('beats')
      .delete()
      .eq('id', beatId);

    if (deleteError) {
      console.error('❌ BEAT DELETE ERROR:', deleteError);
      return res.status(500).json({ error: 'Failed to delete beat' });
    }

    res.json({ message: 'Beat deleted successfully' });

  } catch (error) {
    console.error('❌ DELETE BEAT ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// REORDER BEATS
// =============================================================================

/**
 * POST /api/beats/reorder
 * Batch update beat order (for drag-and-drop)
 */
router.post('/beats/reorder', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { beats } = req.body; // Array of { id, order }

    if (!Array.isArray(beats) || beats.length === 0) {
      return res.status(400).json({ error: 'Invalid beats array' });
    }

    // Verify all beats belong to accessible projects
    const beatIds = beats.map(b => b.id);
    const { data: userBeats, error: verifyError } = await supabase
      .from('beats')
      .select('id, project_id')
      .in('id', beatIds);

    if (verifyError || !userBeats) {
      return res.status(500).json({ error: 'Failed to verify beats' });
    }

    // Check access and edit permission for all unique projects
    const projectIds = [...new Set(userBeats.map(b => b.project_id))];
    for (const projectId of projectIds) {
      const access = await checkProjectAccessForUser(projectId, userId as string);
      if (!access.hasAccess) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (!access.canEdit) {
        return res.status(403).json({ error: 'Viewers cannot reorder beats' });
      }
    }

    // Only update beats that were verified as accessible
    const verifiedBeatIds = new Set(userBeats.map(b => b.id));
    const verifiedBeats = beats.filter(beat => verifiedBeatIds.has(beat.id));

    if (verifiedBeats.length !== beats.length) {
      return res.status(403).json({ error: 'Some beats are not accessible' });
    }

    // Update all beat orders
    const updates = verifiedBeats.map(beat =>
      supabase
        .from('beats')
        .update({ order: beat.order })
        .eq('id', beat.id)
    );

    await Promise.all(updates);

    res.json({ message: 'Beats reordered successfully' });

  } catch (error) {
    console.error('❌ REORDER BEATS ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// EXPORT BEATS
// =============================================================================

/**
 * GET /api/projects/:projectId/beats/export/:format
 * Export beats to various formats (csv, docx, html)
 */
router.get('/projects/:projectId/beats/export/:format', async (req: Request, res: Response) => {
  try {
    const { projectId, format } = req.params;
    const { episode_id, includeNotes, includePageEstimates, groupByAct } = req.query;
    const userId = req.userId;

    // Verify project access (viewers can export - read-only operation)
    const access = await checkProjectAccessForUser(projectId, userId as string);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Project not found or access denied' });
    }

    // Get project name for filename
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, title')
      .eq('id', projectId)
      .eq('deleted', false)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const options = {
      includeNotes: includeNotes !== 'false',
      includePageEstimates: includePageEstimates !== 'false',
      groupByAct: groupByAct !== 'false'
    };

    const episodeId = episode_id as string | undefined;

    let content: string | Buffer;
    let mimeType: string;
    let filename: string;

    switch (format.toLowerCase()) {
      case 'csv':
        content = await BeatExportService.exportToCSV(projectId, episodeId, options);
        mimeType = BeatExportService.getExportMimeType('csv');
        filename = BeatExportService.getExportFilename(project.name || project.title, 'csv');
        break;

      case 'docx':
        content = await BeatExportService.exportToDocx(projectId, episodeId, options);
        mimeType = BeatExportService.getExportMimeType('docx');
        filename = BeatExportService.getExportFilename(project.name || project.title, 'txt');
        break;

      case 'html':
        content = await BeatExportService.exportToHTML(projectId, episodeId, options);
        mimeType = BeatExportService.getExportMimeType('html');
        filename = BeatExportService.getExportFilename(project.name || project.title, 'html');
        break;

      default:
        return res.status(400).json({ error: 'Unsupported export format. Use: csv, docx, html' });
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);

  } catch (error) {
    console.error('❌ EXPORT BEATS ERROR:', error);
    res.status(500).json({ error: 'Failed to export beats' });
  }
});

export default router;
