/**
 * Production Prerequisites Middleware
 *
 * Ensures that production features can only be accessed when:
 * 1. Project has an active script
 * 2. Script has been parsed and scenes are available
 * 3. Production data is in sync with script (or sync is in progress)
 */

import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/database';
import { parseScriptFromProject } from '../services/scriptParsingService';

// Extend Express Request to include production status
declare global {
  namespace Express {
    interface Request {
      productionStatus?: ProductionStatus;
    }
  }
}

export interface ProductionStatus {
  hasScript: boolean;
  scriptId: string | null;
  hasScenes: boolean;
  sceneCount: number;
  productionSceneCount: number;
  syncStatus: 'synced' | 'needs_review' | 'conflicts' | 'not_initialized';
  canUseProduction: boolean;
  message?: string;
}

/**
 * Check if project meets production planner prerequisites
 */
export async function checkProductionPrerequisites(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const projectId = req.params.projectId;
    const userId = req.user?.id;
    const episodeId = req.query.episode_id as string | undefined;

    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get production status (pass episodeId for TV series)
    const status = await getProductionStatus(projectId, userId, episodeId);

    // Attach to request for use in route handlers
    req.productionStatus = status;

    // If prerequisites not met, return 403
    if (!status.canUseProduction) {
      return res.status(403).json({
        error: 'Production prerequisites not met',
        status,
        message: status.message
      });
    }

    next();
  } catch (error) {
    console.error('Error checking production prerequisites:', error);
    return res.status(500).json({ error: 'Failed to check production prerequisites' });
  }
}

/**
 * Middleware that only checks prerequisites (doesn't block)
 * Useful for GET endpoints that need to show status
 */
export async function attachProductionStatus(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const projectId = req.params.projectId;
    const userId = req.user?.id;
    const episodeId = req.query.episode_id as string | undefined;

    if (!projectId || !userId) {
      return next();
    }

    const status = await getProductionStatus(projectId, userId, episodeId);
    req.productionStatus = status;

    next();
  } catch (error) {
    console.error('Error attaching production status:', error);
    // Don't block the request
    next();
  }
}

/**
 * Get comprehensive production status for a project
 * @param projectId - The project ID
 * @param userId - The user ID
 * @param episodeId - Optional episode ID for TV series
 */
export async function getProductionStatus(
  projectId: string,
  userId: string,
  episodeId?: string
): Promise<ProductionStatus> {
  try {
    // 1. Check if project has a script (pass episodeId for TV series)
    const scriptData = await parseScriptFromProject(projectId, userId, undefined, episodeId);

    if (!scriptData) {
      return {
        hasScript: false,
        scriptId: null,
        hasScenes: false,
        sceneCount: 0,
        productionSceneCount: 0,
        syncStatus: 'not_initialized',
        canUseProduction: false,
        message: 'No script found for this project. Please create a script first.'
      };
    }

    const scriptId = scriptData.scriptId;
    const scriptScenes = scriptData.scenes;
    const sceneCount = scriptScenes.length;

    if (sceneCount === 0) {
      return {
        hasScript: true,
        scriptId,
        hasScenes: false,
        sceneCount: 0,
        productionSceneCount: 0,
        syncStatus: 'not_initialized',
        canUseProduction: false,
        message: 'Script has no scenes. Please add scenes to your script first.'
      };
    }

    // 2. Check production scene data using Supabase (optionally filtered by episode)
    let prodQuery = supabase
      .from('production_scene_data')
      .select('sync_status')
      .eq('project_id', projectId)
      .neq('status', 'archived');

    if (episodeId) {
      prodQuery = prodQuery.eq('episode_id', episodeId);
    }

    const { data: prodScenes, error: prodError } = await prodQuery;

    if (prodError) {
      console.error('Error fetching production scenes:', prodError);
    }

    const productionSceneCount = prodScenes?.length || 0;
    const unsyncedCount = prodScenes?.filter(s => s.sync_status !== 'synced').length || 0;

    // 3. Get project sync status
    const { data: projectData } = await supabase
      .from('projects')
      .select('scene_sync_status')
      .eq('id', projectId)
      .single();

    const projectSyncStatus = projectData?.scene_sync_status || 'not_initialized';

    // 4. Determine if production can be used
    let canUseProduction = false;
    let message = '';
    let syncStatus: 'synced' | 'needs_review' | 'conflicts' | 'not_initialized';

    if (productionSceneCount === 0) {
      // No production scenes - need initial sync
      syncStatus = 'not_initialized';
      canUseProduction = false;
      message = 'Production not initialized. Scenes will be automatically linked when you open the production planner.';
    } else if (unsyncedCount > 0) {
      // Has production scenes but some are out of sync
      syncStatus = projectSyncStatus;
      canUseProduction = true; // Can still use, but needs review
      message = `${unsyncedCount} scene(s) need review. Script may have changed since last sync.`;
    } else {
      // All good
      syncStatus = 'synced';
      canUseProduction = true;
      message = '';
    }

    return {
      hasScript: true,
      scriptId,
      hasScenes: true,
      sceneCount,
      productionSceneCount,
      syncStatus,
      canUseProduction,
      message
    };

  } catch (error) {
    console.error('Error getting production status:', error);
    throw error;
  }
}

/**
 * Middleware for endpoints that specifically require synced scenes
 * (e.g., "Fill with AI" that needs to enhance existing scenes)
 */
export async function requireSyncedScenes(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const projectId = req.params.projectId;
    const userId = req.user?.id;
    const episodeId = req.query.episode_id as string | undefined;

    if (!projectId || !userId) {
      return res.status(400).json({ error: 'Project ID and user authentication required' });
    }

    const status = req.productionStatus || await getProductionStatus(projectId, userId, episodeId);

    if (!status.canUseProduction) {
      return res.status(403).json({
        error: 'Production prerequisites not met',
        status
      });
    }

    if (status.productionSceneCount === 0) {
      return res.status(403).json({
        error: 'No production scenes found',
        message: 'Please open the production planner first to initialize scenes.',
        status
      });
    }

    next();
  } catch (error) {
    console.error('Error checking synced scenes:', error);
    return res.status(500).json({ error: 'Failed to verify scene sync status' });
  }
}

export default {
  checkProductionPrerequisites,
  attachProductionStatus,
  requireSyncedScenes,
  getProductionStatus
};
