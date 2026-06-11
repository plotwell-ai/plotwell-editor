// Script Doctor V2 - API Routes
// Scene-level screenplay analysis with caching and freemium support

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { extractUserId, addPricingService, checkAIGenerationLimit, trackAIUsage, manualTrackCreativeUsage, PricingRequest } from '../middleware/pricingMiddleware';
import { addAIUsageTracker, extractProjectId, trackOpenAIUsageInRoute, AITrackingRequest } from '../middleware/aiUsageMiddleware';
import { createClient } from '@supabase/supabase-js';
import { aiTaskEvents } from '../services/aiTaskEventService';

import {
  analyzeBatch,
  getSettings,
  updateSettings,
  getAllAnalyses,
  clearAnalyses,
  saveSummary,
  getSummary,
  dismissIssue,
  undismissIssue,
  getDismissedIssues,
  BatchSceneAnalysisRequest,
  ProgressCallback,
} from '../services/scriptDoctorService';
import { ScriptDoctorSettings, IssueCategory } from '../services/scriptDoctorPrompts';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ============================================================================
// Types
// ============================================================================

interface ScriptDoctorRequest extends AITrackingRequest {
  isPremiumUser?: boolean;
  pricingService?: PricingRequest['pricingService'];
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Normalize projectId → project_id for pricing middleware compatibility
 * (pricing middleware reads req.body.project_id, Script Doctor sends projectId)
 */
function normalizeProjectId(req: Request, _res: Response, next: NextFunction) {
  if (req.body.projectId && !req.body.project_id) {
    req.body.project_id = req.body.projectId;
  }
  next();
}

/**
 * Check if user has premium access for full analysis
 */
async function checkPremiumAccess(req: ScriptDoctorRequest, res: Response, next: Function) {
  try {
    const userId = req.userId;

    // Check user's subscription
    const { getSubscriptionRecord, isPaidSubscription } = require('../utils/subscriptionHelpers');
    const subscription = await getSubscriptionRecord(supabase, userId);
    req.isPremiumUser = isPaidSubscription(subscription);

    next();
  } catch (error) {
    // Default to free tier on error
    req.isPremiumUser = false;
    next();
  }
}

/**
 * Verify user has access to the project
 */
async function verifyProjectAccess(req: Request, res: Response, next: Function) {
  try {
    const { projectId } = req.body;
    const userId = (req as ScriptDoctorRequest).userId;

    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId' });
    }

    // Check if user owns the project or is a collaborator
    const { data: project } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .single();

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership or collaboration access
    if (project.user_id !== userId) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .single();

      if (!collaborator) {
        return res.status(403).json({ error: 'Access denied to this project' });
      }
    }

    next();
  } catch (error) {
    console.error('❌ Project access check failed:', error);
    res.status(500).json({ error: 'Failed to verify project access' });
  }
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/script-doctor/v2/analyze-batch
 * Analyze multiple scenes efficiently
 */
router.post(
  '/analyze-batch',
  requireAuth,
  extractUserId,
  normalizeProjectId,
  addPricingService,
  checkPremiumAccess,
  verifyProjectAccess,
  checkAIGenerationLimit,
  trackAIUsage,
  addAIUsageTracker,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const {
        projectId,
        scriptId,
        episodeId,
        scenes,
        settings,
        contentLanguage = 'en',
        forceRefresh = false,
      } = req.body;

      const userId = req.userId!;
      req.projectId = projectId;

      // Validate
      if (!projectId || !scriptId || !scenes || !Array.isArray(scenes)) {
        return res.status(400).json({
          error: 'Missing required fields: projectId, scriptId, scenes (array)',
        });
      }

      if (scenes.length === 0) {
        return res.json({ analyses: [], cachedCount: 0 });
      }

      // If forceRefresh, clear existing analyses first
      if (forceRefresh) {
        if (DEBUG_AI) console.log('🔄 Script Doctor: Force refresh - clearing cache for script', scriptId);
        await supabase
          .from('script_doctor_scene_analyses')
          .delete()
          .eq('project_id', projectId)
          .eq('script_id', scriptId);
      }

      // No scene limit - Grok 4.1-Fast has 2M context window
      // Can analyze entire feature-length scripts in a single call
      if (DEBUG_AI) console.log(`🎬 Script Doctor: Analyzing full script with ${scenes.length} scenes`);

      // Get settings
      const analysisSettings: ScriptDoctorSettings = settings || await getSettings(projectId, userId);

      // Build request
      const batchRequest: BatchSceneAnalysisRequest = {
        projectId,
        scriptId,
        episodeId,
        userId,
        scenes,
        settings: analysisSettings,
        contentLanguage,
        isPremiumUser: req.isPremiumUser || false,
      };

      if (DEBUG_AI) {
        console.log(`📊 Script Doctor V2: Batch analyzing ${scenes.length} scenes for project ${projectId}`);
      }

      // Analyze batch
      const result = await analyzeBatch(batchRequest);

      // Calculate overall score
      const overallScore = result.analyses.length > 0
        ? Math.round(result.analyses.reduce((sum, a) => sum + a.healthScore, 0) / result.analyses.length)
        : null;

      const analyzedCount = result.analyses.length - result.cachedCount;
      if (DEBUG_AI) {
        console.log(`✅ Script Doctor: ${result.cachedCount} cached, ${analyzedCount} analyzed, overall score: ${overallScore}`);
        if (result.summary) {
          console.log(`📋 Script Doctor Summary: ${result.summary.overall.substring(0, 100)}...`);
        }
      }

      // Track AI usage for the Script Doctor analysis
      if (result.usage && analyzedCount > 0) {
        trackOpenAIUsageInRoute(req, 'script_generation', result.usage.model, {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.total_tokens,
        }, {
          metadata: {
            context: 'script_doctor',
            scenesAnalyzed: analyzedCount,
            scenesCached: result.cachedCount,
            overallScore,
          },
        });
      }

      // Persist summary to settings for cache reload
      if (result.summary) {
        saveSummary(projectId, userId, scriptId, result.summary).catch(() => {});
      }

      aiTaskEvents.emit('task', {
        type: 'script-doctor:completed',
        projectId,
        userId,
        payload: { analyzedCount, overallScore },
      });

      res.json({
        analyses: result.analyses,
        cachedCount: result.cachedCount,
        analyzedCount,
        overallScore,
        summary: result.summary,
      });

    } catch (error) {
      console.error('❌ Script Doctor V2 analyze-batch error:', error);
      if (req.userId && req.body?.projectId) {
        aiTaskEvents.emit('task', {
          type: 'script-doctor:failed',
          projectId: req.body.projectId,
          userId: req.userId,
          payload: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
      }
      res.status(500).json({
        error: 'Failed to analyze scenes',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * POST /api/script-doctor/v2/analyze-batch-stream
 * Analyze multiple scenes with SSE progress streaming
 */
router.post(
  '/analyze-batch-stream',
  requireAuth,
  extractUserId,
  normalizeProjectId,
  addPricingService,
  checkPremiumAccess,
  verifyProjectAccess,
  checkAIGenerationLimit,
  trackAIUsage,
  addAIUsageTracker,
  async (req: ScriptDoctorRequest, res: Response) => {
    const {
      projectId,
      scriptId,
      episodeId,
      scenes,
      settings,
      contentLanguage = 'en',
      forceRefresh = false,
    } = req.body;

    const userId = req.userId!;
    req.projectId = projectId;

    if (!projectId || !scriptId || !scenes || !Array.isArray(scenes)) {
      return res.status(400).json({
        error: 'Missing required fields: projectId, scriptId, scenes (array)',
      });
    }

    // SSE setup
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: any) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      if (scenes.length === 0) {
        sendEvent('complete', { analyses: [], cachedCount: 0 });
        res.end();
        return;
      }

      if (forceRefresh) {
        await supabase
          .from('script_doctor_scene_analyses')
          .delete()
          .eq('project_id', projectId)
          .eq('script_id', scriptId);
      }

      const analysisSettings = settings || await getSettings(projectId, userId);

      const batchRequest: BatchSceneAnalysisRequest = {
        projectId,
        scriptId,
        episodeId,
        userId,
        scenes,
        settings: analysisSettings,
        contentLanguage,
        isPremiumUser: req.isPremiumUser || false,
      };

      // Progress callback sends SSE events
      const onProgress: ProgressCallback = (event) => {
        sendEvent('progress', event);
      };

      const result = await analyzeBatch(batchRequest, onProgress);

      const overallScore = result.analyses.length > 0
        ? Math.round(result.analyses.reduce((sum, a) => sum + a.healthScore, 0) / result.analyses.length)
        : null;

      const analyzedCount = result.analyses.length - result.cachedCount;

      // Track AI usage (only when actual AI was called, not just cached results)
      if (analyzedCount > 0) {
        // Track token usage in AI usage log
        if (result.usage) {
          trackOpenAIUsageInRoute(req, 'script_generation', result.usage.model, {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          }, {
            metadata: {
              context: 'script_doctor',
              scenesAnalyzed: analyzedCount,
              scenesCached: result.cachedCount,
              overallScore,
            },
          });
        }
        // Track against user's plan quota (SSE bypasses trackAIUsage middleware, so we do it manually)
        manualTrackCreativeUsage(userId, projectId, req.pricingService).catch(err =>
          console.error('❌ Script Doctor: Failed to track AI usage:', err)
        );
      }

      if (result.summary) {
        saveSummary(projectId, userId, scriptId, result.summary).catch(() => {});
      }

      aiTaskEvents.emit('task', {
        type: 'script-doctor:completed',
        projectId,
        userId,
        payload: { analyzedCount, overallScore, stream: true },
      });

      // Send final result
      sendEvent('complete', {
        analyses: result.analyses,
        cachedCount: result.cachedCount,
        analyzedCount,
        overallScore,
        summary: result.summary,
      });
    } catch (error) {
      console.error('❌ Script Doctor V2 analyze-batch-stream error:', error);
      aiTaskEvents.emit('task', {
        type: 'script-doctor:failed',
        projectId,
        userId,
        payload: { error: error instanceof Error ? error.message : 'Unknown error', stream: true },
      });
      sendEvent('error', {
        error: 'Failed to analyze scenes',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      res.end();
    }
  }
);

/**
 * GET /api/script-doctor/v2/scenes/:projectId/:scriptId
 * Get all cached analyses for a script
 */
router.get(
  '/scenes/:projectId/:scriptId',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId, scriptId } = req.params;
      const { episode_id: episodeId } = req.query;
      const userId = req.userId!;

      const analyses = await getAllAnalyses(
        projectId,
        scriptId,
        episodeId as string | undefined
      );

      // Calculate overall score
      const overallScore = analyses.length > 0
        ? Math.round(analyses.reduce((sum, a) => sum + a.healthScore, 0) / analyses.length)
        : null;

      // Retrieve cached summary
      const summary = await getSummary(projectId, userId, scriptId);

      res.json({
        analyses,
        overallScore,
        summary,
        count: analyses.length,
      });

    } catch (error) {
      console.error('❌ Script Doctor V2 get scenes error:', error);
      res.status(500).json({
        error: 'Failed to fetch analyses',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * DELETE /api/script-doctor/v2/scenes/:projectId/:scriptId
 * Clear all cached analyses for a script
 */
router.delete(
  '/scenes/:projectId/:scriptId',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId, scriptId } = req.params;
      const userId = req.userId!;

      const deletedCount = await clearAnalyses(projectId, scriptId, userId);

      res.json({ success: true, deletedCount });

    } catch (error) {
      console.error('❌ Script Doctor V2 clear analyses error:', error);
      res.status(500).json({
        error: 'Failed to clear analyses',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * GET /api/script-doctor/v2/settings/:projectId
 * Get Script Doctor settings for a project
 */
router.get(
  '/settings/:projectId',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const userId = req.userId!;

      const settings = await getSettings(projectId, userId);

      res.json({ settings });

    } catch (error) {
      console.error('❌ Script Doctor V2 get settings error:', error);
      res.status(500).json({
        error: 'Failed to fetch settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * PUT /api/script-doctor/v2/settings/:projectId
 * Update Script Doctor settings for a project
 */
router.put(
  '/settings/:projectId',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const userId = req.userId!;
      const updates = req.body;

      // Validate updates
      const allowedFields = [
        'analysis_mode',
        'periodic_interval_minutes',
        'writing_mode',
        'genre',
        'custom_notes',
        'enabled_categories',
        'show_scene_health_dots',
        'is_enabled',
      ];

      const filteredUpdates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          filteredUpdates[key] = value;
        }
      }

      const settings = await updateSettings(projectId, userId, filteredUpdates);

      res.json({ settings });

    } catch (error) {
      console.error('❌ Script Doctor V2 update settings error:', error);
      res.status(500).json({
        error: 'Failed to update settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

// ============================================================================
// Issue Dismiss/Acknowledge Routes
// ============================================================================

/**
 * GET /api/script-doctor/v2/dismissed/:projectId/:scriptId
 * Get all dismissed issue IDs for a script
 */
router.get(
  '/dismissed/:projectId/:scriptId',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId, scriptId } = req.params;
      const userId = req.userId!;

      const dismissed = await getDismissedIssues(projectId, scriptId, userId);

      res.json({ dismissed });
    } catch (error) {
      console.error('❌ Script Doctor get dismissed error:', error);
      res.status(500).json({ error: 'Failed to fetch dismissed issues' });
    }
  }
);

/**
 * POST /api/script-doctor/v2/dismiss-issue
 * Dismiss or acknowledge an issue
 */
router.post(
  '/dismiss-issue',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId, scriptId, sceneId, issueId, status = 'dismissed' } = req.body;
      const userId = req.userId!;

      if (!projectId || !scriptId || !sceneId || !issueId) {
        return res.status(400).json({
          error: 'Missing required fields: projectId, scriptId, sceneId, issueId',
        });
      }

      if (!['dismissed', 'acknowledged'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be "dismissed" or "acknowledged"' });
      }

      await dismissIssue(projectId, scriptId, sceneId, issueId, userId, status);

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Script Doctor dismiss issue error:', error);
      res.status(500).json({ error: 'Failed to dismiss issue' });
    }
  }
);

/**
 * DELETE /api/script-doctor/v2/dismiss-issue
 * Undismiss an issue (restore it)
 */
router.delete(
  '/dismiss-issue',
  requireAuth,
  extractUserId,
  async (req: ScriptDoctorRequest, res: Response) => {
    try {
      const { projectId, scriptId, sceneId, issueId } = req.body;
      const userId = req.userId!;

      if (!projectId || !scriptId || !sceneId || !issueId) {
        return res.status(400).json({
          error: 'Missing required fields: projectId, scriptId, sceneId, issueId',
        });
      }

      await undismissIssue(projectId, scriptId, sceneId, issueId, userId);

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Script Doctor undismiss issue error:', error);
      res.status(500).json({ error: 'Failed to undismiss issue' });
    }
  }
);

export default router;
