import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { ProductionExportService } from '../../services/productionExportService';
import { SceneBreakdownExportService } from '../../services/sceneBreakdownExportService';
import { getUserId, supabase } from './helpers';

const router = Router();

// =============================================================================
// EXPORT ROUTES
// =============================================================================

/**
 * Export call sheet to CSV
 * GET /api/production/call-sheet/:projectId/:shootDate/export/csv
 */
router.get('/call-sheet/:projectId/:shootDate/export/csv', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    // Get project info for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, title')
      .eq('id', projectId)
      .single();

    const csv = await ProductionExportService.exportCallSheetToCSV(projectId, shootDate);
    const filename = ProductionExportService.getExportFilename(
      project?.name || project?.title || 'call_sheet',
      'call_sheet',
      'csv',
      shootDate
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error('Error exporting call sheet to CSV:', error);
    res.status(500).json({
      error: 'Failed to export call sheet',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export call sheet to HTML (for PDF)
 * GET /api/production/call-sheet/:projectId/:shootDate/export/html
 */
router.get('/call-sheet/:projectId/:shootDate/export/html', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId, shootDate } = req.params;

    // Get project info for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, title')
      .eq('id', projectId)
      .single();

    const html = await ProductionExportService.exportCallSheetToHTML(projectId, shootDate);
    const filename = ProductionExportService.getExportFilename(
      project?.name || project?.title || 'call_sheet',
      'call_sheet',
      'html',
      shootDate
    );

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);

  } catch (error) {
    console.error('Error exporting call sheet to HTML:', error);
    res.status(500).json({
      error: 'Failed to export call sheet',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export cast list to CSV
 * GET /api/production/:projectId/cast/export/csv
 */
router.get('/:projectId/cast/export/csv', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    // Get project info for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, title')
      .eq('id', projectId)
      .single();

    const csv = await ProductionExportService.exportCastToCSV(projectId);
    const filename = ProductionExportService.getExportFilename(
      project?.name || project?.title || 'cast',
      'cast',
      'csv'
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error('Error exporting cast to CSV:', error);
    res.status(500).json({
      error: 'Failed to export cast',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export locations to CSV
 * GET /api/production/:projectId/locations/export/csv
 */
router.get('/:projectId/locations/export/csv', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    // Get project info for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, title')
      .eq('id', projectId)
      .single();

    const csv = await ProductionExportService.exportLocationsToCSV(projectId);
    const filename = ProductionExportService.getExportFilename(
      project?.name || project?.title || 'locations',
      'locations',
      'csv'
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error('Error exporting locations to CSV:', error);
    res.status(500).json({
      error: 'Failed to export locations',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export schedule to CSV
 * GET /api/production/:projectId/schedule/export/csv
 */
router.get('/:projectId/schedule/export/csv', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;

    // Get project info for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, title')
      .eq('id', projectId)
      .single();

    const csv = await ProductionExportService.exportScheduleToCSV(projectId);
    const filename = ProductionExportService.getExportFilename(
      project?.name || project?.title || 'schedule',
      'schedule',
      'csv'
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error('Error exporting schedule to CSV:', error);
    res.status(500).json({
      error: 'Failed to export schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export scene breakdown to HTML (for PDF)
 * GET /api/production/:projectId/breakdown/export/html
 */
router.get('/:projectId/breakdown/export/html', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    const { episode_id } = req.query;

    // Verify project access
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, user_id')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check if user owns project or is a collaborator
    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from('project_collaborators')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .single();

      if (!collab) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const html = await SceneBreakdownExportService.exportBreakdownToHTML(
      projectId,
      episode_id as string | undefined
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('Error exporting breakdown to HTML:', error);
    res.status(500).json({
      error: 'Failed to export breakdown',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Export Day Out of Days to HTML (for PDF)
 * GET /api/production/:projectId/dood/export/html
 */
router.get('/:projectId/dood/export/html', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { projectId } = req.params;
    const { episode_id } = req.query;

    // Verify project access
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, user_id')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check if user owns project or is a collaborator
    if (project.user_id !== userId) {
      const { data: collab } = await supabase
        .from('project_collaborators')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .single();

      if (!collab) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const html = await SceneBreakdownExportService.exportDayOutOfDaysToHTML(
      projectId,
      episode_id as string | undefined
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('Error exporting DOOD to HTML:', error);
    res.status(500).json({
      error: 'Failed to export Day Out of Days',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
