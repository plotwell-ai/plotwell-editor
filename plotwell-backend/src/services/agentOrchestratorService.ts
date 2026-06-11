/**
 * Agent Orchestrator Service
 *
 * Autonomous multi-step screenplay writer. Plans scenes, writes them
 * sequentially with continuity, optionally reviews and revises each scene,
 * and deducts credits per step.
 *
 * State machine: idle → planning → awaiting_approval → writing → reviewing → revising → paused → done → cancelled
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { AIModelRouter, aiRouter, AIRoutingContext } from './aiModelRouter';
import { executeToolCall, ToolExecutionContext } from './chatToolDefinitions';
import { PricingService } from './pricingService';
import { createScriptVersionSnapshot } from './scriptVersionService';
import { extractTipTapJsonFromAIResponse, extractTextFromTipTapJSON } from '../utils/aiHelpers';
import { getEffectiveCost } from '../config/pricingPlans';
import {
  AGENT_PLANNER_SYSTEM,
  AGENT_SCENE_WRITER_SYSTEM,
  AGENT_REVIEWER_SYSTEM,
  AGENT_REVISER_SYSTEM,
  AGENT_PLAN_CONFIG,
  AGENT_SCENE_CONFIG,
  AGENT_REVIEW_CONFIG,
  buildAgentPlanPrompt,
  buildAgentScenePrompt,
  buildAgentReviewPrompt,
  buildAgentRevisionPrompt,
} from '../prompts/agent';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// =============================================================================
// TYPES
// =============================================================================

export type AgentState =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'writing'
  | 'reviewing'
  | 'revising'
  | 'paused'
  | 'done'
  | 'cancelled';

export interface AgentPlannedScene {
  index: number;
  heading: string;
  description: string;
  characters: string[];
  location: string;
  estimated_length: string;
  action: 'write_new' | 'extend' | 'rewrite';
  source_scene_number?: number; // For extend/rewrite: which existing scene to modify
  insert_before_scene?: number; // For write_new: insert before this scene number (1-based). If omitted, append to end.
  skip?: boolean; // If true, this scene is skipped during execution
  status: 'pending' | 'writing' | 'reviewing' | 'revising' | 'done' | 'failed';
  content?: any; // TipTap JSON
  reviewResult?: SceneReviewResult;
}

export interface AgentPlan {
  id: string;
  projectId: string;
  userId: string;
  instruction: string;
  scenes: AgentPlannedScene[];
  estimatedCredits: number;
}

export interface SceneReviewResult {
  passed: boolean;
  health_score: number;
  issues: string[];
  strengths: string[];
}

export interface AgentExecuteOptions {
  includeReview?: boolean;
  reviewThreshold?: number; // health_score below this triggers revision (default: 75)
  stylePreferences?: string;
  autoInsertToScript?: boolean;
  scriptId?: string;
}

type SendEventFn = (event: string, data: any) => void;

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export class AgentOrchestrator {
  private state: AgentState = 'idle';
  private sendEvent: SendEventFn;
  private supabase: SupabaseClient;
  private userId: string;
  private projectId: string;
  private episodeId?: string;
  private pricingService: PricingService;
  private abortController: AbortController;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private totalCreditsUsed = 0;
  private scenesCompleted = 0;

  constructor(params: {
    sendEvent: SendEventFn;
    supabase: SupabaseClient;
    userId: string;
    projectId: string;
    episodeId?: string;
    pricingService: PricingService;
  }) {
    this.sendEvent = params.sendEvent;
    this.supabase = params.supabase;
    this.userId = params.userId;
    this.projectId = params.projectId;
    this.episodeId = params.episodeId;
    this.pricingService = params.pricingService;
    this.abortController = new AbortController();
  }

  // ---------------------------------------------------------------------------
  // PLAN GENERATION
  // ---------------------------------------------------------------------------

  async generatePlan(instruction: string, language: string = 'English'): Promise<AgentPlan | null> {
    this.state = 'planning';

    try {
      // Gather project context using existing chat tools
      const toolCtx: ToolExecutionContext = {
        projectId: this.projectId,
        episodeId: this.episodeId,
        supabase: this.supabase,
      };

      const [characters, locations, beatSheet, outline, treatment, existingScript] = await Promise.all([
        executeToolCall('get_characters', {}, toolCtx),
        executeToolCall('get_locations', {}, toolCtx),
        executeToolCall('get_beat_sheet', {}, toolCtx),
        executeToolCall('get_document', { document_type: 'outline' }, toolCtx),
        executeToolCall('get_document', { document_type: 'treatment' }, toolCtx),
        executeToolCall('get_script', {}, toolCtx),
      ]);

      // Fetch project concept
      const { data: project } = await this.supabase
        .from('projects')
        .select('name, description, project_type, content_language')
        .eq('id', this.projectId)
        .single();

      const effectiveLanguage = project?.content_language || language;
      const projectContext = project ? `Project: ${project.name}\nType: ${project.project_type || 'film'}\nDescription: ${project.description || ''}` : undefined;

      // Build planning prompt
      const prompt = buildAgentPlanPrompt({
        instruction,
        language: effectiveLanguage,
        projectContext,
        characters: characters.includes('No characters') ? undefined : characters,
        locations: locations.includes('No locations') ? undefined : locations,
        beatSheet: beatSheet.includes('No beat sheet') ? undefined : beatSheet,
        existingScript: existingScript.includes('No production script') ? undefined : existingScript,
        outline: outline.includes('No outline') ? undefined : outline,
        treatment: treatment.includes('No treatment') ? undefined : treatment,
      });

      if (DEBUG_AI) console.log(`🤖 Agent plan prompt length: ${prompt.length} chars`);

      // Create routing context
      const routingContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt + AGENT_PLANNER_SYSTEM,
        expectedOutputTokens: AGENT_PLAN_CONFIG.maxTokens,
        metadata: { forceModel: 'grok' },
      });

      // Stream the plan generation
      let planText = '';
      const result = await aiRouter.executeStreamingCompletion(
        routingContext,
        {
          messages: [
            { role: 'system', content: AGENT_PLANNER_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: AGENT_PLAN_CONFIG.maxTokens,
          temperature: AGENT_PLAN_CONFIG.temperature,
        },
        {
          onToken: (token) => {
            if (!this.abortController.signal.aborted) {
              planText += token;
              this.sendEvent('token', { content: token });
            }
          },
          signal: this.abortController.signal,
        }
      );

      if (this.abortController.signal.aborted) {
        this.state = 'cancelled';
        return null;
      }

      // Parse the plan JSON
      const scenes = this.parsePlanResponse(planText);
      if (!scenes || scenes.length === 0) {
        this.sendEvent('error', { message: 'no_scenes_generated' });
        this.state = 'idle';
        return null;
      }

      const creditCost = getEffectiveCost('agent_step');
      const plan: AgentPlan = {
        id: crypto.randomUUID(),
        projectId: this.projectId,
        userId: this.userId,
        instruction,
        scenes: scenes.map((s, i) => ({
          index: i,
          heading: s.heading,
          description: s.description,
          characters: s.characters || [],
          location: s.location || '',
          estimated_length: s.estimated_length || 'medium',
          action: s.action || 'write_new',
          source_scene_number: s.source_scene_number,
          insert_before_scene: s.insert_before_scene,
          status: 'pending' as const,
        })),
        estimatedCredits: scenes.length * creditCost,
      };

      this.state = 'awaiting_approval';
      this.sendEvent('plan', { plan });

      if (DEBUG_AI) console.log(`🤖 Agent plan generated: ${plan.scenes.length} scenes, ~${plan.estimatedCredits} credits`);

      return plan;
    } catch (error) {
      console.error('❌ Agent plan generation error:', error);
      this.sendEvent('error', { message: 'Failed to generate plan.' });
      this.state = 'idle';
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // PLAN EXECUTION
  // ---------------------------------------------------------------------------

  async executePlan(plan: AgentPlan, options: AgentExecuteOptions = {}): Promise<void> {
    const {
      includeReview = true,
      reviewThreshold = 75,
      stylePreferences,
    } = options;

    this.state = 'writing';
    this.startHeartbeat();

    const creditCost = getEffectiveCost('agent_step');

    // Gather context once for all scenes
    const toolCtx: ToolExecutionContext = {
      projectId: this.projectId,
      episodeId: this.episodeId,
      supabase: this.supabase,
    };

    const [characters, locations, outline, treatment] = await Promise.all([
      executeToolCall('get_characters', {}, toolCtx),
      executeToolCall('get_locations', {}, toolCtx),
      executeToolCall('get_document', { document_type: 'outline' }, toolCtx),
      executeToolCall('get_document', { document_type: 'treatment' }, toolCtx),
    ]);

    // Build documents context for scene writer
    const documents: { outline?: string; treatment?: string } = {};
    if (outline && !outline.includes('No outline')) {
      documents.outline = outline.length > 3000 ? outline.substring(0, 3000) + '...' : outline;
    }
    if (treatment && !treatment.includes('No treatment')) {
      documents.treatment = treatment.length > 3000 ? treatment.substring(0, 3000) + '...' : treatment;
    }

    // Fetch project language and script ID
    const { data: project } = await this.supabase
      .from('projects')
      .select('content_language, prod_script_id')
      .eq('id', this.projectId)
      .single();
    const language = project?.content_language || 'English';

    // Resolve script ID for auto-insertion
    let scriptId = options.scriptId || project?.prod_script_id || null;
    if (!scriptId && this.episodeId) {
      const { data: episode } = await this.supabase
        .from('episodes')
        .select('script_id')
        .eq('id', this.episodeId)
        .single();
      scriptId = episode?.script_id || null;
    }
    if (scriptId) {
      options.scriptId = scriptId;
      if (DEBUG_AI) console.log('📝 Agent will auto-insert scenes into script:', scriptId);
    } else {
      console.warn('⚠️ Agent: no script ID found, scenes will NOT be auto-inserted');
    }

    // Fetch raw script content for labeled context + next-scene extraction
    let existingScriptContext: string | undefined;
    let rawScriptContent: any = null;
    if (scriptId) {
      const { data: scriptData } = await this.supabase
        .from('scripts')
        .select('content')
        .eq('id', scriptId)
        .single();
      if (scriptData?.content) {
        rawScriptContent = scriptData.content;
        const labeledText = extractTextFromTipTapJSON(scriptData.content, 'labeled');
        // Pass full script. For very large scripts (200+ pages), build a smart context:
        // complete scene heading index + full content of scenes near the work area.
        const LARGE_SCRIPT_THRESHOLD = 100_000;
        if (labeledText.length <= LARGE_SCRIPT_THRESHOLD) {
          existingScriptContext = labeledText;
        } else {
          existingScriptContext = this.buildSmartScriptContext(rawScriptContent.content, plan);
          if (DEBUG_AI) console.log(`📜 Agent: large script (${labeledText.length} chars) — using smart context (${existingScriptContext.length} chars)`);
        }
      }
    }

    try {
      for (let i = 0; i < plan.scenes.length; i++) {
        const scene = plan.scenes[i];

        // --- Abort check ---
        if (this.abortController.signal.aborted) {
          this.state = 'cancelled';
          this.sendEvent('done', {
            scenesCompleted: this.scenesCompleted,
            totalCreditsUsed: this.totalCreditsUsed,
            cancelled: true,
          });
          return;
        }

        // --- Skip check ---
        if (scene.skip) {
          scene.status = 'done';
          this.scenesCompleted++;
          this.sendEvent('step_complete', {
            sceneIndex: i,
            content: null,
            reviewResult: null,
            scenesCompleted: this.scenesCompleted,
            totalScenes: plan.scenes.length,
            skipped: true,
          });
          if (DEBUG_AI) console.log(`⏭️ Agent: skipping scene ${i + 1} "${scene.heading}"`);
          continue;
        }

        // --- Credit check ---
        if (creditCost > 0) {
          const balance = await this.pricingService.getAICreditsBalance(this.userId);
          if (DEBUG_AI) console.log(`💰 Agent credit check: user=${this.userId} balance=${balance} needed=${creditCost} scene=${i}`);
          if (balance < creditCost) {
            this.state = 'paused';
            this.sendEvent('paused', {
              reason: 'insufficient_credits',
              creditsNeeded: creditCost,
              creditsAvailable: balance,
              sceneIndex: i,
            });
            return;
          }
        }

        // --- Write scene ---
        scene.status = 'writing';
        this.sendEvent('step_start', {
          sceneIndex: i,
          heading: scene.heading,
          description: scene.description,
          totalScenes: plan.scenes.length,
        });

        // Extract next-scene context for insertion-before scenarios
        let nextSceneContext: string | undefined;
        if (scene.insert_before_scene && rawScriptContent?.content) {
          nextSceneContext = this.extractNextSceneContext(rawScriptContent.content, scene.insert_before_scene);
        }

        const sceneContent = await this.writeScene(plan, i, characters, locations, language, stylePreferences, existingScriptContext, nextSceneContext, documents);

        if (!sceneContent) {
          scene.status = 'failed';
          this.sendEvent('error', { message: `Failed to write scene ${i + 1}: ${scene.heading}`, sceneIndex: i });
          continue;
        }

        scene.content = sceneContent;

        // --- Review scene (optional) ---
        if (includeReview) {
          scene.status = 'reviewing';
          this.state = 'reviewing';

          const reviewResult = await this.reviewScene(sceneContent, scene.heading, plan, i, characters);

          if (reviewResult) {
            scene.reviewResult = reviewResult;
            this.sendEvent('review', {
              sceneIndex: i,
              passed: reviewResult.passed,
              health_score: reviewResult.health_score,
              issues: reviewResult.issues,
              strengths: reviewResult.strengths,
            });

            // --- Revise if needed ---
            if (!reviewResult.passed && reviewResult.health_score < reviewThreshold) {
              scene.status = 'revising';
              this.state = 'revising';

              const revisedContent = await this.reviseScene(sceneContent, reviewResult, scene.heading, language);

              if (revisedContent) {
                scene.content = revisedContent;
                this.sendEvent('revision', { sceneIndex: i });
              }
            }
          }
        }

        // --- Deduct credits ---
        if (creditCost > 0) {
          await this.pricingService.consumeAICredits(
            this.userId,
            creditCost,
            `Agent Writer: scene ${i + 1} - ${scene.heading}`,
            { projectId: this.projectId, sceneIndex: i }
          );
          // Also increment ai_generations_used so ensureFreeUserCredits
          // knows this user has prior usage and doesn't re-initialize their balance.
          await this.pricingService.trackAIGeneration(this.userId);
          this.totalCreditsUsed += creditCost;

          const remaining = await this.pricingService.getAICreditsBalance(this.userId);
          this.sendEvent('credits_consumed', {
            creditsUsed: creditCost,
            creditsRemaining: remaining,
            sceneIndex: i,
          });
        }

        // --- Insert scene into script ---
        if (options.autoInsertToScript !== false && scene.content && options.scriptId) {
          const posLabel = scene.insert_before_scene ? `before scene ${scene.insert_before_scene}` : 'at end';
          if (DEBUG_AI) console.log(`📝 Agent: inserting scene ${i + 1} ${posLabel} into script ${options.scriptId}`);
          await this.insertSceneIntoScript(options.scriptId, scene.content, scene.insert_before_scene);
        } else if (options.autoInsertToScript === false) {
          if (DEBUG_AI) console.log(`📋 Agent: review mode - scene ${i + 1} generated but not inserted`);
        } else {
          if (DEBUG_AI) console.log(`⚠️ Agent: skipping insertion - content: ${!!scene.content}, scriptId: ${options.scriptId || 'none'}`);
        }

        // --- Mark complete ---
        scene.status = 'done';
        this.scenesCompleted++;
        this.state = 'writing';

        this.sendEvent('step_complete', {
          sceneIndex: i,
          content: scene.content,
          reviewResult: scene.reviewResult || null,
          scenesCompleted: this.scenesCompleted,
          totalScenes: plan.scenes.length,
        });
      }

      // --- All done ---
      this.state = 'done';
      this.sendEvent('done', {
        scenesCompleted: this.scenesCompleted,
        totalCreditsUsed: this.totalCreditsUsed,
        cancelled: false,
      });
    } catch (error) {
      console.error('❌ Agent execution error:', error);
      this.sendEvent('error', { message: 'Agent execution failed unexpectedly.' });
      this.state = 'done';
      this.sendEvent('done', {
        scenesCompleted: this.scenesCompleted,
        totalCreditsUsed: this.totalCreditsUsed,
        cancelled: false,
      });
    } finally {
      this.stopHeartbeat();
    }
  }

  // ---------------------------------------------------------------------------
  // SCENE WRITING
  // ---------------------------------------------------------------------------

  private async writeScene(
    plan: AgentPlan,
    sceneIndex: number,
    characters: string,
    locations: string,
    language: string,
    stylePreferences?: string,
    existingScriptContext?: string,
    nextSceneContext?: string,
    documents?: { outline?: string; treatment?: string },
  ): Promise<any | null> {
    try {
      // Build preceding scenes context (summarize older scenes to save tokens)
      let precedingScenes: string | undefined;
      if (sceneIndex > 0) {
        const writtenScenes = plan.scenes
          .slice(0, sceneIndex)
          .filter(s => s.content);

        if (writtenScenes.length > 0) {
          // Include full text for last 2 scenes, summaries for older ones
          const parts: string[] = [];
          for (const ws of writtenScenes) {
            const text = extractTextFromTipTapJSON(ws.content);
            if (ws.index >= sceneIndex - 2) {
              parts.push(`--- Scene ${ws.index + 1}: ${ws.heading} ---\n${text}`);
            } else {
              // Truncate older scenes to first 500 chars
              const summary = text.substring(0, 500) + (text.length > 500 ? '...' : '');
              parts.push(`--- Scene ${ws.index + 1}: ${ws.heading} (summary) ---\n${summary}`);
            }
          }
          precedingScenes = parts.join('\n\n');
        }
      }

      const currentScene = plan.scenes[sceneIndex];

      const prompt = buildAgentScenePrompt({
        plan: plan.scenes.map(s => ({
          heading: s.heading,
          description: s.description,
          characters: s.characters,
          location: s.location,
          estimated_length: s.estimated_length,
        })),
        sceneIndex,
        precedingScenes,
        characters: characters.includes('No characters') ? undefined : characters,
        locations: locations.includes('No locations') ? undefined : locations,
        language,
        stylePreferences,
        existingScriptContext,
        insertionContext: currentScene.insert_before_scene
          ? `This scene will be INSERTED BEFORE scene ${currentScene.insert_before_scene} in the existing script. It must lead naturally into the scene that currently follows it. Characters should NOT know about events that only happen in later scenes.`
          : undefined,
        nextSceneContext,
        documents,
      });

      const routingContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt + AGENT_SCENE_WRITER_SYSTEM,
        expectedOutputTokens: AGENT_SCENE_CONFIG.maxTokens,
        metadata: { forceModel: 'grok' },
      });

      let sceneText = '';
      await aiRouter.executeStreamingCompletion(
        routingContext,
        {
          messages: [
            { role: 'system', content: AGENT_SCENE_WRITER_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: AGENT_SCENE_CONFIG.maxTokens,
          temperature: AGENT_SCENE_CONFIG.temperature,
        },
        {
          onToken: (token) => {
            if (!this.abortController.signal.aborted) {
              sceneText += token;
              this.sendEvent('token', { content: token });
            }
          },
          signal: this.abortController.signal,
        }
      );

      if (this.abortController.signal.aborted) return null;

      // Parse TipTap JSON
      const extraction = extractTipTapJsonFromAIResponse(sceneText);
      if (!extraction.success || !extraction.json) {
        console.error(`❌ Agent scene ${sceneIndex + 1} JSON extraction failed:`, extraction.error);

        // Retry once with stricter prompt
        if (DEBUG_AI) console.log(`🔄 Agent retrying scene ${sceneIndex + 1}...`);
        return await this.retrySceneWrite(prompt);
      }

      return extraction.json;
    } catch (error) {
      console.error(`❌ Agent writeScene error (scene ${sceneIndex + 1}):`, error);
      return null;
    }
  }

  private async retrySceneWrite(originalPrompt: string): Promise<any | null> {
    try {
      const stricterSystem = AGENT_SCENE_WRITER_SYSTEM + '\n\nPREVIOUS ATTEMPT FAILED JSON PARSING. This time, be extra careful with JSON formatting. Start IMMEDIATELY with {"type":"doc","content":[ and end with ]}.';

      const routingContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: originalPrompt + stricterSystem,
        expectedOutputTokens: AGENT_SCENE_CONFIG.maxTokens,
        metadata: { forceModel: 'grok' },
      });

      const result = await aiRouter.executeCompletion(routingContext, {
        messages: [
          { role: 'system', content: stricterSystem },
          { role: 'user', content: originalPrompt },
        ],
        maxTokens: AGENT_SCENE_CONFIG.maxTokens,
        temperature: 0.5, // Lower temperature for retry
      });

      const extraction = extractTipTapJsonFromAIResponse(result.content);
      return extraction.success ? extraction.json : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // SCENE REVIEW
  // ---------------------------------------------------------------------------

  private async reviewScene(
    sceneContent: any,
    sceneHeading: string,
    plan: AgentPlan,
    sceneIndex: number,
    characters: string,
  ): Promise<SceneReviewResult | null> {
    try {
      const sceneText = extractTextFromTipTapJSON(sceneContent);
      const planContext = plan.scenes.map((s, i) =>
        `${i + 1}. ${s.heading} - ${s.description}`
      ).join('\n');

      const prompt = buildAgentReviewPrompt({
        sceneContent: sceneText,
        sceneHeading,
        planContext,
        characters: characters.includes('No characters') ? undefined : characters,
      });

      const routingContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt + AGENT_REVIEWER_SYSTEM,
        expectedOutputTokens: AGENT_REVIEW_CONFIG.maxTokens,
        metadata: { forceModel: 'grok' },
      });

      const result = await aiRouter.executeCompletion(routingContext, {
        messages: [
          { role: 'system', content: AGENT_REVIEWER_SYSTEM },
          { role: 'user', content: prompt },
        ],
        maxTokens: AGENT_REVIEW_CONFIG.maxTokens,
        temperature: AGENT_REVIEW_CONFIG.temperature,
      });

      // Parse review JSON
      const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const review = JSON.parse(cleaned) as SceneReviewResult;

      if (typeof review.health_score !== 'number' || !Array.isArray(review.issues)) {
        console.warn('⚠️ Agent review response missing expected fields');
        return null;
      }

      review.passed = review.health_score >= 75;

      if (DEBUG_AI) console.log(`🔍 Agent review scene ${sceneIndex + 1}: score=${review.health_score}, passed=${review.passed}`);

      return review;
    } catch (error) {
      console.error(`❌ Agent reviewScene error (scene ${sceneIndex + 1}):`, error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // SCENE REVISION
  // ---------------------------------------------------------------------------

  private async reviseScene(
    sceneContent: any,
    reviewResult: SceneReviewResult,
    sceneHeading: string,
    language: string,
  ): Promise<any | null> {
    try {
      const sceneText = extractTextFromTipTapJSON(sceneContent);

      const prompt = buildAgentRevisionPrompt({
        sceneContent: sceneText,
        reviewFeedback: {
          issues: reviewResult.issues,
          strengths: reviewResult.strengths,
        },
        sceneHeading,
        language,
      });

      const routingContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt + AGENT_REVISER_SYSTEM,
        expectedOutputTokens: AGENT_SCENE_CONFIG.maxTokens,
        metadata: { forceModel: 'grok' },
      });

      let revisionText = '';
      await aiRouter.executeStreamingCompletion(
        routingContext,
        {
          messages: [
            { role: 'system', content: AGENT_REVISER_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: AGENT_SCENE_CONFIG.maxTokens,
          temperature: 0.7,
        },
        {
          onToken: (token) => {
            if (!this.abortController.signal.aborted) {
              revisionText += token;
              this.sendEvent('token', { content: token });
            }
          },
          signal: this.abortController.signal,
        }
      );

      if (this.abortController.signal.aborted) return null;

      const extraction = extractTipTapJsonFromAIResponse(revisionText);
      return extraction.success ? extraction.json : null;
    } catch (error) {
      console.error('❌ Agent reviseScene error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // SCRIPT INSERTION
  // ---------------------------------------------------------------------------

  /**
   * Insert a scene into the script at the correct position.
   * @param insertBeforeScene - 1-based scene number to insert before. If undefined/0, append to end.
   */
  private async insertSceneIntoScript(scriptId: string, sceneContent: any, insertBeforeScene?: number): Promise<void> {
    try {
      // Fetch current script content
      const { data: script, error: fetchErr } = await this.supabase
        .from('scripts')
        .select('content')
        .eq('id', scriptId)
        .single();

      if (fetchErr || !script) {
        console.error('❌ Agent: could not fetch script for insertion:', fetchErr);
        return;
      }

      const existingContent = script.content || { type: 'doc', content: [] };
      const existingNodes: any[] = existingContent.content || [];
      const newNodes = sceneContent?.content || (Array.isArray(sceneContent) ? sceneContent : []);

      if (newNodes.length === 0) {
        console.warn('⚠️ Agent: no nodes to insert, sceneContent:', JSON.stringify(sceneContent).substring(0, 200));
        return;
      }

      let insertIndex = existingNodes.length; // default: append to end

      if (insertBeforeScene && insertBeforeScene >= 1) {
        // Find the node index of the Nth scene heading
        let sceneCount = 0;
        for (let i = 0; i < existingNodes.length; i++) {
          if (existingNodes[i].type === 'sceneHeading') {
            sceneCount++;
            if (sceneCount === insertBeforeScene) {
              insertIndex = i;
              break;
            }
          }
        }
        if (DEBUG_AI) console.log(`📍 Agent insert: before scene ${insertBeforeScene} → node index ${insertIndex} (found ${sceneCount} scene headings)`);
      }

      if (DEBUG_AI) console.log(`📝 Agent insert: existing nodes: ${existingNodes.length}, new nodes: ${newNodes.length}, insertIndex: ${insertIndex}`);

      // Calculate ProseMirror character offset of the insertion point (for comment shifting)
      // In ProseMirror, each block node = 1 (open) + text content + 1 (close)
      let insertCharOffset = 0;
      if (insertBeforeScene && insertIndex < existingNodes.length) {
        for (let i = 0; i < insertIndex; i++) {
          insertCharOffset += this.calculateNodeSize(existingNodes[i]);
        }
      }

      // Calculate the character size of the inserted content
      let insertedCharSize = 0;
      for (const node of newNodes) {
        insertedCharSize += this.calculateNodeSize(node);
      }

      // Splice new nodes at the correct position
      const updatedNodes = [...existingNodes];
      updatedNodes.splice(insertIndex, 0, ...newNodes);

      const updatedContent = {
        type: 'doc',
        content: updatedNodes,
      };

      await createScriptVersionSnapshot(this.supabase, {
        scriptId,
        userId: this.userId,
        changeSummary: 'Before AI agent scene insertion',
      });

      // Save back
      const { error: updateErr } = await this.supabase
        .from('scripts')
        .update({ content: updatedContent })
        .eq('id', scriptId);

      if (updateErr) {
        console.error('❌ Agent: could not update script:', updateErr);
      } else {
        const posLabel = insertBeforeScene ? `before scene ${insertBeforeScene}` : 'at end';
        if (DEBUG_AI) console.log(`✅ Agent: scene inserted ${posLabel} in script ${scriptId} (total nodes: ${updatedContent.content.length})`);
      }

      // Shift comment positions if inserting before existing content
      if (insertBeforeScene && insertedCharSize > 0) {
        await this.shiftCommentPositions(scriptId, insertCharOffset, insertedCharSize);
      }
    } catch (error) {
      console.error('❌ Agent insertSceneIntoScript error:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // CONTEXT HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Build a smart context for very large scripts (>100K chars labeled).
   * Returns: full scene heading index + full content of scenes near the work area.
   * This gives the model a structural map of the whole script plus depth where it matters.
   */
  private buildSmartScriptContext(nodes: any[], plan: AgentPlan): string {
    // Build scene heading index (full list, all scenes)
    const headings: string[] = [];
    let totalScenes = 0;
    for (const node of nodes) {
      if (node.type === 'sceneHeading') {
        totalScenes++;
        const text = node.content?.map((n: any) => n.text || '').join('') || '';
        headings.push(`${totalScenes}. ${text}`);
      }
    }
    const headingIndex = `=== SCRIPT SCENE INDEX (${totalScenes} scenes total) ===\n${headings.join('\n')}`;

    // Find the primary work area: where are we inserting/appending?
    // Use the first non-skip scene in the plan to anchor the neighborhood.
    const firstActiveScene = plan.scenes.find(s => !s.skip);
    let targetSceneNum: number;
    if (firstActiveScene?.insert_before_scene) {
      targetSceneNum = firstActiveScene.insert_before_scene;
    } else if (firstActiveScene?.source_scene_number) {
      targetSceneNum = firstActiveScene.source_scene_number;
    } else {
      targetSceneNum = totalScenes; // appending to end
    }

    // Extract full content of scenes in the neighborhood (±5 scenes)
    const neighborStart = Math.max(1, targetSceneNum - 5);
    const neighborEnd = Math.min(totalScenes, targetSceneNum + 5);
    const neighborText = this.extractSceneRange(nodes, neighborStart, neighborEnd);

    const neighborSection = neighborText
      ? `\n\n=== SCRIPT CONTENT (scenes ${neighborStart}–${neighborEnd}, near insertion point) ===\n${neighborText}`
      : '';

    return headingIndex + neighborSection;
  }

  /**
   * Extract the labeled text for scenes [fromScene, toScene] (1-based, inclusive).
   */
  private extractSceneRange(nodes: any[], fromScene: number, toScene: number): string {
    const parts: string[] = [];
    let sceneCount = 0;
    let inRange = false;
    let currentSceneNodes: any[] = [];

    for (const node of nodes) {
      if (node.type === 'sceneHeading') {
        // Save previous scene if we were collecting it
        if (inRange && currentSceneNodes.length > 0) {
          parts.push(extractTextFromTipTapJSON({ type: 'doc', content: currentSceneNodes }, 'labeled'));
        }
        sceneCount++;
        inRange = sceneCount >= fromScene && sceneCount <= toScene;
        currentSceneNodes = inRange ? [node] : [];
        // Stop iterating once we've passed the range
        if (sceneCount > toScene) break;
      } else if (inRange) {
        currentSceneNodes.push(node);
      }
    }

    // Flush final scene
    if (inRange && currentSceneNodes.length > 0) {
      parts.push(extractTextFromTipTapJSON({ type: 'doc', content: currentSceneNodes }, 'labeled'));
    }

    return parts.join('\n\n');
  }

  /**
   * Extract the content of a specific scene from the script for context.
   */
  private extractNextSceneContext(nodes: any[], sceneNumber: number): string | undefined {
    let sceneCount = 0;
    let startIdx = -1;

    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].type === 'sceneHeading') {
        sceneCount++;
        if (sceneCount === sceneNumber) {
          startIdx = i;
          break;
        }
      }
    }

    if (startIdx < 0) return undefined;

    // Extract nodes until the next scene heading or 20 nodes max
    let endIdx = Math.min(startIdx + 20, nodes.length);
    for (let i = startIdx + 1; i < endIdx; i++) {
      if (nodes[i].type === 'sceneHeading') {
        endIdx = i;
        break;
      }
    }

    const sceneNodes = nodes.slice(startIdx, endIdx);
    const sceneDoc = { type: 'doc', content: sceneNodes };
    const text = extractTextFromTipTapJSON(sceneDoc, 'labeled');

    // Return the full scene content (the writer needs to know what comes after)
    return text;
  }

  // ---------------------------------------------------------------------------
  // COMMENT POSITION HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Calculate the ProseMirror "size" of a node (open tag + content + close tag).
   * Block nodes = 1 (open) + content text length + 1 (close) = textLength + 2
   */
  private calculateNodeSize(node: any): number {
    if (!node) return 0;
    // Text nodes: just the text length
    if (node.type === 'text') return (node.text || '').length;
    // Block nodes: 1 (open) + children sizes + 1 (close)
    let size = 2; // open + close tag
    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        size += this.calculateNodeSize(child);
      }
    }
    return size;
  }

  /**
   * Shift all comment selection_data positions for a script when content is inserted before them.
   */
  private async shiftCommentPositions(scriptId: string, insertCharOffset: number, shiftAmount: number): Promise<void> {
    try {
      // Fetch all comments for this script that have selection_data
      const { data: comments, error } = await this.supabase
        .from('comments')
        .select('id, selection_data')
        .eq('content_type', 'script')
        .eq('content_id', scriptId)
        .eq('is_deleted', false)
        .not('selection_data', 'is', null);

      if (error || !comments || comments.length === 0) return;

      // Update comments whose positions are at or after the insertion point
      let shifted = 0;
      for (const comment of comments) {
        const sel = comment.selection_data;
        if (!sel || typeof sel.from !== 'number') continue;

        // Only shift comments that are at or after the insertion point
        if (sel.from >= insertCharOffset) {
          const updatedSelection = {
            ...sel,
            from: sel.from + shiftAmount,
            to: (sel.to || sel.from) + shiftAmount,
          };

          await this.supabase
            .from('comments')
            .update({ selection_data: updatedSelection })
            .eq('id', comment.id);

          shifted++;
        }
      }

      if (shifted > 0) {
        if (DEBUG_AI) console.log(`📝 Agent: shifted ${shifted} comment positions by +${shiftAmount} chars`);
      }
    } catch (error) {
      console.error('❌ Agent: error shifting comment positions:', error);
      // Non-fatal: comments may be slightly off but the script insertion succeeded
    }
  }

  // ---------------------------------------------------------------------------
  // CONTROL
  // ---------------------------------------------------------------------------

  cancel(): void {
    this.abortController.abort();
    this.state = 'cancelled';
    this.stopHeartbeat();
  }

  getState(): AgentState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private parsePlanResponse(text: string): Array<{
    heading: string;
    description: string;
    characters: string[];
    location: string;
    estimated_length: string;
    action: 'write_new' | 'extend' | 'rewrite';
    source_scene_number?: number;
    insert_before_scene?: number;
  }> | null {
    try {
      // Strip markdown wrappers and reasoning text
      let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      if (DEBUG_AI) console.log('🔍 Agent plan raw response (first 500 chars):', cleaned.substring(0, 500));

      // Try to find a JSON array
      const arrayStart = cleaned.indexOf('[');
      const arrayEnd = cleaned.lastIndexOf(']');

      // Try to find a JSON object (single scene case)
      const objStart = cleaned.indexOf('{');
      const objEnd = cleaned.lastIndexOf('}');

      let parsed: any;

      if (arrayStart !== -1 && arrayEnd > arrayStart) {
        // Found an array
        let jsonStr = cleaned.substring(arrayStart, arrayEnd + 1);

        // Fix: model returns ["key":"val",...] instead of [{"key":"val",...}]
        // Detect: array starts with [ immediately followed by "key": (no { before it)
        if (/^\[\s*"/.test(jsonStr) && !jsonStr.startsWith('[{') && !jsonStr.startsWith('[ {')) {
          // Wrap content in braces: ["a":"b"] → [{"a":"b"}]
          jsonStr = '[{' + jsonStr.substring(1, jsonStr.length - 1) + '}]';
          if (DEBUG_AI) console.log('🔧 Agent plan: fixed missing braces in array');
        }

        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          // Try to fix common issues: trailing commas, missing brackets
          const fixed = jsonStr
            .replace(/,\s*]/g, ']')  // trailing comma before ]
            .replace(/,\s*}/g, '}') // trailing comma before }
            .replace(/}\s*{/g, '},{'); // missing comma between objects
          try {
            parsed = JSON.parse(fixed);
          } catch {
            // Last resort: try to extract individual objects
            const objMatches = [...fixed.matchAll(/\{[^{}]*\}/g)];
            if (objMatches.length > 0) {
              parsed = objMatches.map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
            } else {
              throw new Error('Could not parse plan JSON');
            }
          }
        }
      } else if (objStart !== -1 && objEnd > objStart) {
        // Found a single object, wrap in array
        const jsonStr = cleaned.substring(objStart, objEnd + 1);
        try {
          parsed = [JSON.parse(jsonStr)];
        } catch {
          const fixed = jsonStr.replace(/,\s*}/g, '}');
          parsed = [JSON.parse(fixed)];
        }
      } else {
        console.error('❌ Agent plan: no JSON found in response');
        return null;
      }

      const scenes = Array.isArray(parsed) ? parsed : [parsed];
      if (scenes.length === 0) return [];

      // Validate each scene has required fields
      const validActions = ['write_new', 'extend', 'rewrite'];
      return scenes.filter(s => s && (s.heading || s.description)).map(s => ({
        heading: String(s.heading || s.scene_heading || 'UNTITLED SCENE'),
        description: String(s.description || s.scene_description || ''),
        characters: Array.isArray(s.characters) ? s.characters.map(String) : [],
        location: String(s.location || ''),
        estimated_length: String(s.estimated_length || 'medium'),
        action: (validActions.includes(s.action) ? s.action : 'write_new') as 'write_new' | 'extend' | 'rewrite',
        source_scene_number: typeof s.source_scene_number === 'number' ? s.source_scene_number : undefined,
        insert_before_scene: typeof s.insert_before_scene === 'number' ? s.insert_before_scene : undefined,
      }));
    } catch (error) {
      console.error('❌ Agent plan parsing error:', error);
      console.error('❌ Agent plan raw text:', text.substring(0, 300));
      return null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendEvent('heartbeat', {});
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
