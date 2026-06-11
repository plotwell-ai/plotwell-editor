/**
 * Agent Writer Routes
 *
 * Autonomous multi-step screenplay generation.
 * POST /plan    - Generate a scene-by-scene plan (SSE stream)
 * POST /execute - Execute an approved plan (SSE stream)
 * POST /cancel  - Cancel an in-progress execution
 */

import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { requireAuth } from '../../middleware/auth';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import {
  extractUserId,
  addPricingService,
  requireFeature,
  checkAICreativeTaskLimit,
  trackAIUsage,
  PricingRequest,
} from '../../middleware/pricingMiddleware';
import { PricingService } from '../../services/pricingService';
import { AgentOrchestrator, AgentPlan, AgentExecuteOptions } from '../../services/agentOrchestratorService';
import { createScriptVersionSnapshot } from '../../services/scriptVersionService';
import {
  applyScriptContentToActiveRoom,
  flushActiveScriptRoomToDatabase,
  getActiveScriptRoomContent,
  hasActiveCollaborationRoom,
} from '../../services/collaborationServer';

dotenv.config();

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const router = Router();

// In-memory registry of active orchestrators for cancel support
const activeOrchestrators = new Map<string, AgentOrchestrator>();

function orchestratorKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

// ---------------------------------------------------------------------------
// Helper: Set up SSE response
// ---------------------------------------------------------------------------

function setupSSE(res: Response): (event: string, data: any) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return (event: string, data: any) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: Check project access
// ---------------------------------------------------------------------------

async function checkProjectAccess(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  canEdit: boolean;
}> {
  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!project) return { hasAccess: false, canEdit: false };

  if (project.user_id === userId) {
    return { hasAccess: true, canEdit: true };
  }

  // Check collaboration
  const { data: collab } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (collab) {
    return {
      hasAccess: true,
      canEdit: collab.role !== 'viewer',
    };
  }

  return { hasAccess: false, canEdit: false };
}

// ---------------------------------------------------------------------------
// POST /plan - Generate a scene-by-scene plan
// ---------------------------------------------------------------------------

router.post(
  '/plan',
  requireAuth,
  extractUserId,
  addPricingService,
  requireFeature('agent_writer'),
  checkAICreativeTaskLimit,
  trackAIUsage,
  async (req: PricingRequest, res: Response) => {
    const userId = req.userId;
    const { project_id, instruction, episode_id, language } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!project_id || !instruction) {
      return res.status(400).json({ error: 'project_id and instruction are required' });
    }

    // Check access
    const access = await checkProjectAccess(project_id, userId);
    if (!access.hasAccess || !access.canEdit) {
      return res.status(403).json({ error: 'No write access to this project' });
    }

    // Check for existing orchestrator
    const key = orchestratorKey(userId, project_id);
    if (activeOrchestrators.has(key)) {
      return res.status(409).json({ error: 'An agent is already running for this project' });
    }

    const sendEvent = setupSSE(res);

    const pricingService = req.pricingService || new PricingService(supabase);

    const orchestrator = new AgentOrchestrator({
      sendEvent,
      supabase,
      userId,
      projectId: project_id,
      episodeId: episode_id,
      pricingService,
    });

    activeOrchestrators.set(key, orchestrator);

    // Handle client disconnect
    req.on('close', () => {
      orchestrator.cancel();
      activeOrchestrators.delete(key);
    });

    try {
      await orchestrator.generatePlan(instruction, language || 'English');
      aiTaskEvents.emit('task', {
        type: 'agent:done',
        projectId: project_id,
        userId,
        payload: { operation: 'plan' },
      });
    } catch (error) {
      console.error('❌ Agent /plan error:', error);
      aiTaskEvents.emit('task', {
        type: 'agent:error',
        projectId: project_id,
        userId,
        payload: { error: 'Plan generation failed' },
      });
      sendEvent('error', { message: 'Plan generation failed' });
    } finally {
      activeOrchestrators.delete(key);
      // Small delay to ensure last SSE events are flushed before closing
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

// ---------------------------------------------------------------------------
// POST /execute - Execute an approved plan
// ---------------------------------------------------------------------------

router.post(
  '/execute',
  requireAuth,
  extractUserId,
  addPricingService,
  requireFeature('agent_writer'),
  checkAICreativeTaskLimit,
  async (req: PricingRequest, res: Response) => {
    const userId = req.userId;
    const {
      project_id,
      plan,
      episode_id,
      include_review,
      review_threshold,
      style_preferences,
      auto_insert,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!project_id || !plan || !plan.scenes || !Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      return res.status(400).json({ error: 'project_id and a valid plan with scenes are required' });
    }

    // Check access
    const access = await checkProjectAccess(project_id, userId);
    if (!access.hasAccess || !access.canEdit) {
      return res.status(403).json({ error: 'No write access to this project' });
    }

    // Check for existing orchestrator
    const key = orchestratorKey(userId, project_id);
    if (activeOrchestrators.has(key)) {
      return res.status(409).json({ error: 'An agent is already running for this project' });
    }

    const sendEvent = setupSSE(res);
    const pricingService = req.pricingService || new PricingService(supabase);

    const orchestrator = new AgentOrchestrator({
      sendEvent,
      supabase,
      userId,
      projectId: project_id,
      episodeId: episode_id,
      pricingService,
    });

    activeOrchestrators.set(key, orchestrator);

    // Handle client disconnect
    req.on('close', () => {
      orchestrator.cancel();
      activeOrchestrators.delete(key);
    });

    const options: AgentExecuteOptions = {
      includeReview: include_review !== false, // default true
      reviewThreshold: review_threshold || 60,
      stylePreferences: style_preferences,
      autoInsertToScript: auto_insert !== false, // default true
    };

    // Normalize plan structure
    const validActions = ['write_new', 'extend', 'rewrite'];
    const normalizedPlan: AgentPlan = {
      id: plan.id || crypto.randomUUID(),
      projectId: project_id,
      userId,
      instruction: plan.instruction || '',
      scenes: plan.scenes.map((s: any, i: number) => ({
        index: i,
        heading: s.heading || '',
        description: s.description || '',
        characters: s.characters || [],
        location: s.location || '',
        estimated_length: s.estimated_length || 'medium',
        action: (validActions.includes(s.action) ? s.action : 'write_new') as 'write_new' | 'extend' | 'rewrite',
        source_scene_number: typeof s.source_scene_number === 'number' ? s.source_scene_number : undefined,
        insert_before_scene: typeof s.insert_before_scene === 'number' ? s.insert_before_scene : undefined,
        skip: Boolean(s.skip),
        status: 'pending' as const,
      })),
      estimatedCredits: plan.estimatedCredits || 0,
    };

    try {
      await orchestrator.executePlan(normalizedPlan, options);
      aiTaskEvents.emit('task', {
        type: 'agent:done',
        projectId: project_id,
        userId,
        payload: { operation: 'execute', scenesCount: normalizedPlan.scenes.length },
      });
    } catch (error) {
      console.error('❌ Agent /execute error:', error);
      aiTaskEvents.emit('task', {
        type: 'agent:error',
        projectId: project_id,
        userId,
        payload: { error: 'Execution failed' },
      });
      sendEvent('error', { message: 'Execution failed' });
    } finally {
      activeOrchestrators.delete(key);
      // Small delay to ensure last SSE events are flushed before closing
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

// ---------------------------------------------------------------------------
// POST /cancel - Cancel an in-progress execution
// ---------------------------------------------------------------------------

router.post(
  '/cancel',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res: Response) => {
    const userId = req.userId;
    const { project_id } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!project_id) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    const key = orchestratorKey(userId, project_id);
    const orchestrator = activeOrchestrators.get(key);

    if (!orchestrator) {
      return res.status(404).json({ error: 'No active agent found for this project' });
    }

    orchestrator.cancel();
    activeOrchestrators.delete(key);

    if (DEBUG_AI) console.log(`🛑 Agent cancelled for ${key}`);

    res.json({ success: true, message: 'Agent cancelled' });
  }
);

// ---------------------------------------------------------------------------
// POST /insert - Insert previously generated scenes into the script (review mode)
// ---------------------------------------------------------------------------

router.post(
  '/insert',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res: Response) => {
    const userId = req.userId;
    const { project_id, episode_id, scenes } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!project_id || !scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: 'project_id and scenes array are required' });
    }

    const access = await checkProjectAccess(project_id, userId);
    if (!access.hasAccess || !access.canEdit) {
      return res.status(403).json({ error: 'No write access to this project' });
    }

    try {
      // Find the script for this project/episode
      let scriptQuery = supabase
        .from('scripts')
        .select('id, content')
        .eq('project_id', project_id);

      if (episode_id) {
        scriptQuery = scriptQuery.eq('episode_id', episode_id);
      }

      const { data: script, error: fetchErr } = await scriptQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (fetchErr || !script) {
        return res.status(404).json({ error: 'Script not found' });
      }

      const activeRoom = hasActiveCollaborationRoom(project_id, 'script', script.id);
      const activeContent = activeRoom ? getActiveScriptRoomContent(project_id, script.id) : null;
      const workingContent = activeContent || script.content || { type: 'doc', content: [] };
      const workingNodes: any[] = [...(workingContent.content || [])];

      // Process scenes sequentially to correctly handle positional insertions.
      // Each scene is inserted one at a time so that earlier insertions shift
      // the scene numbers correctly for subsequent ones.
      let totalNodesInserted = 0;
      let snapshotCreated = false;

      for (const scene of scenes) {
        const newNodes = scene.content?.content || (Array.isArray(scene.content) ? scene.content : []);
        if (newNodes.length === 0) continue;

        // Re-fetch current content before each insertion (previous insertions shift positions)
        const { data: current, error: currentErr } = await supabase
          .from('scripts')
          .select('content')
          .eq('id', script.id)
          .single();

        if (!activeRoom && (currentErr || !current)) {
          console.error('❌ Agent /insert: could not re-fetch script:', currentErr);
          continue;
        }

        const existingNodes: any[] = activeRoom ? workingNodes : ((current?.content?.content) || []);
        let insertIndex = existingNodes.length; // default: append to end

        if (scene.insertBeforeScene && scene.insertBeforeScene >= 1) {
          let sceneCount = 0;
          for (let i = 0; i < existingNodes.length; i++) {
            if (existingNodes[i].type === 'sceneHeading') {
              sceneCount++;
              if (sceneCount === scene.insertBeforeScene) {
                insertIndex = i;
                break;
              }
            }
          }
          if (DEBUG_AI) console.log(`📍 Agent /insert: "${scene.heading}" before scene ${scene.insertBeforeScene} → node index ${insertIndex}`);
        } else {
          if (DEBUG_AI) console.log(`📍 Agent /insert: "${scene.heading}" appended to end`);
        }

        const updatedNodes = activeRoom ? workingNodes : [...existingNodes];
        updatedNodes.splice(insertIndex, 0, ...newNodes);

        if (!snapshotCreated) {
          if (activeRoom) {
            await flushActiveScriptRoomToDatabase(project_id, script.id, {
              userId,
              changeSummary: `Before AI insert scene: ${scene.heading}`,
              createVersion: true,
            });
          } else {
            await createScriptVersionSnapshot(supabase, {
              scriptId: script.id,
              userId,
              changeSummary: `Before AI insert scene: ${scene.heading}`,
            });
          }
          snapshotCreated = true;
        }

        if (activeRoom) {
          totalNodesInserted += newNodes.length;
          continue;
        }

        const { error: updateErr } = await supabase
          .from('scripts')
          .update({ content: { type: 'doc', content: updatedNodes } })
          .eq('id', script.id);

        if (updateErr) {
          console.error('❌ Agent /insert: failed to update script:', updateErr);
        } else {
          totalNodesInserted += newNodes.length;
        }
      }

      if (activeRoom && totalNodesInserted > 0) {
        const result = await applyScriptContentToActiveRoom(project_id, script.id, {
          type: 'doc',
          content: workingNodes,
        }, {
          userId,
          changeSummary: 'AI insert scenes',
          flush: true,
        });

        if (!result.appliedToRoom) {
          return res.status(409).json({ error: 'Could not apply scenes to active collaboration room' });
        }
      }

      if (totalNodesInserted === 0) {
        return res.status(400).json({ error: 'No scene content to insert' });
      }

      if (DEBUG_AI) console.log(`✅ Agent /insert: ${scenes.length} scenes (${totalNodesInserted} nodes) inserted into script ${script.id}`);
      res.json({ success: true, nodesInserted: totalNodesInserted });
    } catch (error) {
      console.error('❌ Agent /insert error:', error);
      res.status(500).json({ error: 'Failed to insert scenes' });
    }
  }
);

export default router;
