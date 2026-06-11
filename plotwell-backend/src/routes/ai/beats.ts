/**
 * AI Beat Sheet Routes
 *
 * AI-powered beat sheet features:
 * - Suggest next beats based on story structure
 * - Analyze beat sheet structure
 * - Expand beat into detailed outline
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../../config/database';
import { requireAuth, getUserId } from '../../middleware/auth';
import { addPricingService, extractUserId, checkAIGenerationLimit, trackAIUsage } from '../../middleware/pricingMiddleware';

import { preventDuplicateBeatSuggest, preventDuplicateBeatAnalyze, preventDuplicateBeatExpand, preventDuplicateBeatDescriptionGeneration } from '../../middleware/requestDeduplication';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { extractTextFromTipTapJSON, loadProjectLanguageSettings, buildLanguageInstructions } from '../../utils/aiHelpers';
import {
  BEAT_SUGGEST_CONFIG, BEAT_ANALYZE_CONFIG, BEAT_EXPAND_CONFIG, BEAT_DESCRIPTION_CONFIG,
  BEAT_SUGGEST_SYSTEM, BEAT_ANALYZE_SYSTEM, BEAT_EXPAND_SYSTEM, BEAT_DESCRIPTION_SYSTEM,
  buildBeatSuggestPrompt, buildBeatAnalyzePrompt, buildBeatExpandPrompt, buildBeatDescriptionPrompt,
} from '../../prompts';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

// Debug: Log all requests to this router
router.use((req, res, next) => {
  if (DEBUG_AI) console.log(`🎯 BEATS AI ROUTER HIT: ${req.method} ${req.path}`);
  next();
});

// Apply middleware to all AI routes
router.use(requireAuth);
router.use(extractUserId);

// =============================================================================
// AI SUGGEST NEXT BEAT
// =============================================================================

/**
 * POST /api/projects/:projectId/beats/ai-suggest-next
 * AI suggests possible next beats based on existing beats and structure template
 */
router.post(
  '/projects/:projectId/beats/ai-suggest-next',
  preventDuplicateBeatSuggest,
  addPricingService,

  checkAIGenerationLimit,
  trackAIUsage,
  async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const userId = req.userId;
      const {
        episode_id,
        template_id,
        genre,
        existing_beats
      } = req.body;

      // Verify project ownership
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id, name, project_type')
        .eq('id', projectId)
        .eq('user_id', userId)
        .eq('deleted', false)
        .single();

      if (projectError || !project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Get template info if template_id provided
      let template: any = null;
      if (template_id) {
        const { data: templateData } = await supabase
          .from('structure_templates')
          .select('*')
          .eq('id', template_id)
          .single();

        template = templateData;
      }

      // Load language settings
      const languageSettings = await loadProjectLanguageSettings(projectId, userId!);
      const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

      // Build prompt for AI
      const beatsContext = existing_beats
        ? existing_beats.map((b: any, i: number) => `${i + 1}. ${b.title}${b.description ? ` - ${b.description}` : ''}`).join('\n')
        : 'No beats yet';

      const templateInfo = template
        ? `Structure Template: ${template.name}\nDescription: ${template.description}`
        : 'No specific template selected';

      const prompt = buildBeatSuggestPrompt({
        projectName: project.name,
        templateInfo,
        genre: genre || 'Not specified',
        beatsContext,
        templateName: template?.name || 'standard screenplay',
        languageInstructions,
      });

      // Call AI via router
      const suggestContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt,
        expectedOutputTokens: 2000,
        metadata: { forceModel: 'grok' }
      });

      const suggestResult = await aiRouter.executeCompletion(suggestContext, {
        messages: [
          { role: "system", content: BEAT_SUGGEST_SYSTEM },
          { role: "user", content: prompt }
        ],
        maxTokens: 2000,
        temperature: 0.8, // Higher temp for creative suggestions
      });

      let output = suggestResult.content || "";

      // Parse JSON from output
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error('❌ FAILED TO PARSE AI RESPONSE');
        return res.status(500).json({ error: 'Failed to parse AI suggestions' });
      }

      const suggestions = JSON.parse(jsonMatch[0]);

      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:completed', projectId: req.params.projectId, userId: req.userId, payload: { operation: 'suggest' } });
      }
      res.json({ suggestions });

    } catch (error) {
      console.error('❌ AI SUGGEST BEAT ERROR:', error);
      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:failed', projectId: req.params.projectId, userId: req.userId, payload: { error: 'suggest failed' } });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// =============================================================================
// AI ANALYZE STRUCTURE
// =============================================================================

/**
 * POST /api/projects/:projectId/beats/ai-analyze-structure
 * AI analyzes beat sheet structure and provides feedback
 */
router.post(
  '/projects/:projectId/beats/ai-analyze-structure',
  preventDuplicateBeatAnalyze,
  addPricingService,

  checkAIGenerationLimit,
  trackAIUsage,
  async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const userId = req.userId;
      const {
        episode_id,
        template_id,
        beats // Full beats array with act, beat_type, etc.
      } = req.body;

      if (!beats || beats.length === 0) {
        return res.status(400).json({ error: 'No beats to analyze' });
      }

      // Verify project ownership
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id, name, project_type')
        .eq('id', projectId)
        .eq('user_id', userId)
        .eq('deleted', false)
        .single();

      if (projectError || !project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Get template info
      let template: any = null;
      if (template_id) {
        const { data: templateData } = await supabase
          .from('structure_templates')
          .select('*')
          .eq('id', template_id)
          .single();

        template = templateData;
      }

      // Load language settings
      const languageSettings = await loadProjectLanguageSettings(projectId, userId!);
      const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

      // Count beats by act
      const actCounts: any = {};
      beats.forEach((beat: any) => {
        actCounts[beat.act] = (actCounts[beat.act] || 0) + 1;
      });

      // Build prompt
      const beatsDetails = beats.map((b: any, i: number) =>
        `${i + 1}. [${b.act}] ${b.title} (${b.beat_type})`
      ).join('\n');

      const prompt = buildBeatAnalyzePrompt({
        projectName: project.name,
        templateName: template?.name || 'Custom',
        totalBeats: beats.length,
        actCounts: Object.entries(actCounts).map(([act, count]) => `- ${act}: ${count} beats`).join('\n'),
        beatsDetails,
        languageInstructions,
      });

      // Call AI via router
      const analyzeContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt,
        expectedOutputTokens: 2000,
        metadata: { forceModel: 'grok' }
      });

      const analyzeResult = await aiRouter.executeCompletion(analyzeContext, {
        messages: [
          { role: "system", content: BEAT_ANALYZE_SYSTEM },
          { role: "user", content: prompt }
        ],
        maxTokens: 2000,
        temperature: 0.7,
      });

      let output = analyzeResult.content || "";

      // Parse JSON
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ FAILED TO PARSE AI RESPONSE');
        return res.status(500).json({ error: 'Failed to parse AI analysis' });
      }

      const analysis = JSON.parse(jsonMatch[0]);

      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:completed', projectId: req.params.projectId, userId: req.userId, payload: { operation: 'analyze' } });
      }
      res.json({ analysis });

    } catch (error) {
      console.error('❌ AI ANALYZE STRUCTURE ERROR:', error);
      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:failed', projectId: req.params.projectId, userId: req.userId, payload: { error: 'analyze failed' } });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// =============================================================================
// AI EXPAND BEAT
// =============================================================================

/**
 * POST /api/beats/:beatId/ai-expand
 * AI expands a beat into a detailed scene outline
 */
router.post(
  '/beats/:beatId/ai-expand',
  preventDuplicateBeatExpand,
  addPricingService,
  checkAIGenerationLimit,
  trackAIUsage,
  async (req: Request, res: Response) => {
    try {
      const { beatId } = req.params;
      const userId = req.userId;
      const { genre, tone } = req.body;

      // Get beat with project info
      const { data: beat, error: beatError } = await supabase
        .from('beats')
        .select(`
          *,
          projects!inner(id, name, user_id)
        `)
        .eq('id', beatId)
        .single();

      if (beatError || !beat) {
        return res.status(404).json({ error: 'Beat not found' });
      }

      // @ts-ignore
      if (beat.projects.user_id !== userId) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      // Load language settings
      // @ts-ignore
      const languageSettings = await loadProjectLanguageSettings(beat.projects.id, userId!);
      const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

      // Build prompt
      const prompt = buildBeatExpandPrompt({
        beatTitle: beat.title,
        beatDescription: beat.description || 'No additional description',
        beatType: beat.beat_type,
        act: beat.act,
        genre: genre || 'Not specified',
        tone: tone || 'Not specified',
        languageInstructions,
      });

      // Call AI via router
      const expandContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt,
        expectedOutputTokens: 1500,
        metadata: { forceModel: 'grok' }
      });

      const expandResult = await aiRouter.executeCompletion(expandContext, {
        messages: [
          { role: "system", content: BEAT_EXPAND_SYSTEM },
          { role: "user", content: prompt }
        ],
        maxTokens: 1500,
        temperature: 0.75,
      });

      let output = expandResult.content || "";

      // Parse JSON
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ FAILED TO PARSE AI RESPONSE');
        return res.status(500).json({ error: 'Failed to parse AI expansion' });
      }

      const expansion = JSON.parse(jsonMatch[0]);

      if (req.userId) {
        // @ts-ignore
        aiTaskEvents.emit('task', { type: 'beat:completed', projectId: beat.projects.id, userId: req.userId, payload: { operation: 'expand', beatId } });
      }
      res.json({ expansion });

    } catch (error) {
      console.error('❌ AI EXPAND BEAT ERROR:', error);
      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:failed', projectId: req.params.beatId || '', userId: req.userId, payload: { error: 'expand failed' } });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// =============================================================================
// AI GENERATE BEAT DESCRIPTION
// =============================================================================

/**
 * POST /api/ai/beats/generate-description
 * AI generates a beat description based on project documents
 */
router.post(
  '/beats/generate-description',
  preventDuplicateBeatDescriptionGeneration,
  addPricingService,
  checkAIGenerationLimit,
  trackAIUsage,
  async (req: Request, res: Response) => {
    if (DEBUG_AI) console.log('🎬 BEAT DESCRIPTION HANDLER REACHED');
    try {
      const userId = req.userId;
      const {
        project_id,
        episode_id,
        title,
        act,
        beat_type,
        existing_beats = []
      } = req.body;

      if (DEBUG_AI) console.log('🎬 Beat generation params:', { project_id, title, act, beat_type, existingBeatsCount: existing_beats.length });

      if (!project_id || !title) {
        return res.status(400).json({ error: 'Missing required fields: project_id and title' });
      }

      // Verify project ownership or collaboration access
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id, name, project_type, user_id')
        .eq('id', project_id)
        .eq('deleted', false)
        .single();

      if (projectError || !project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Check ownership or collaborator access
      let hasAccess = project.user_id === userId;
      if (!hasAccess) {
        const { data: collab } = await supabase
          .from('project_collaborators')
          .select('id')
          .eq('project_id', project_id)
          .eq('user_id', userId)
          .eq('status', 'active')
          .single();
        hasAccess = !!collab;
      }

      if (!hasAccess) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      // Fetch ALL project documents
      const { data: documents } = await supabase
        .from('project_documents')
        .select('title, document_type, content')
        .eq('project_id', project_id)
        .order('created_at', { ascending: true });

      // Build documents context (limit to 2000 chars per doc for quick generation)
      let documentsContext = '';
      if (documents && documents.length > 0) {
        documentsContext = documents.map((doc: any) => {
          const text = extractTextFromTipTapJSON(doc.content);
          const truncated = text.length > 2000 ? text.substring(0, 2000) + '...' : text;
          return `### ${doc.title || 'Untitled'} (${doc.document_type})\n${truncated}`;
        }).join('\n\n');
        if (DEBUG_AI) console.log(`🎬 Loaded ${documents.length} documents for context`);
      }

      // Load language settings
      const languageSettings = await loadProjectLanguageSettings(project_id, project.user_id);
      const languageInstructions = buildLanguageInstructions(
        languageSettings.language,
        languageSettings.content_language,
        'generation'
      );

      // Map act and beat_type to readable labels
      const actLabels: Record<string, string> = {
        act1: 'Act 1 (Setup)',
        act2a: 'Act 2A (Rising Action)',
        act2b: 'Act 2B (Complications)',
        act3: 'Act 3 (Resolution)',
        act4: 'Act 4',
        act5: 'Act 5',
        custom: 'Custom'
      };

      const beatTypeLabels: Record<string, string> = {
        setup: 'Setup - Establishing the world and characters',
        inciting_incident: 'Inciting Incident - The event that starts the story',
        midpoint: 'Midpoint - Major shift or revelation',
        climax: 'Climax - The peak of the conflict',
        resolution: 'Resolution - How things are resolved',
        rising_action: 'Rising Action - Building tension',
        turning_point: 'Turning Point - Change in direction',
        crisis: 'Crisis - A critical moment of decision',
        custom: 'Custom beat'
      };

      const actLabel = actLabels[act] || act || 'Not specified';
      const beatTypeLabel = beatTypeLabels[beat_type] || beat_type || 'Custom beat';

      // Build existing beats context (sorted by order)
      let existingBeatsContext = '';
      if (existing_beats && existing_beats.length > 0) {
        const sortedBeats = [...existing_beats].sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
        existingBeatsContext = sortedBeats.map((b: any, idx: number) => {
          const beatActLabel = actLabels[b.act] || b.act || 'Unknown';
          const beatTypeLabel = beatTypeLabels[b.beat_type] || b.beat_type || 'custom';
          const desc = b.description ? ` - ${b.description.substring(0, 150)}${b.description.length > 150 ? '...' : ''}` : '';
          return `${idx + 1}. [${beatActLabel}] ${b.title} (${beatTypeLabel})${desc}`;
        }).join('\n');
      }

      // Build prompt
      const prompt = buildBeatDescriptionPrompt({
        projectName: project.name,
        projectType: project.project_type || 'film',
        documentsContext,
        existingBeatsContext,
        title,
        actLabel,
        beatTypeLabel,
        languageInstructions,
      });

      // Call AI via router - use Grok for reliable generation
      if (DEBUG_AI) console.log('🎬 Calling AI for beat description...');
      const generateContext = AIModelRouter.createContext({
        requestType: 'generation',
        inputText: prompt,
        expectedOutputTokens: 1000,
        metadata: { forceModel: 'grok' }
      });

      const generateResult = await aiRouter.executeCompletion(generateContext, {
        messages: [
          { role: "system", content: BEAT_DESCRIPTION_SYSTEM },
          { role: "user", content: prompt }
        ],
        maxTokens: 1000,
        temperature: 0.7,
      });
      if (DEBUG_AI) console.log('🎬 AI response received');

      let description = generateResult.content || "";

      // Clean up the response - remove any quotes or extra whitespace
      description = description.trim();
      if ((description.startsWith('"') && description.endsWith('"')) ||
          (description.startsWith("'") && description.endsWith("'"))) {
        description = description.slice(1, -1);
      }

      if (DEBUG_AI) console.log('✅ AI GENERATE BEAT DESCRIPTION SUCCESS:', { title, act, beat_type });

      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:completed', projectId: project_id, userId: req.userId, payload: { operation: 'generate-description' } });
      }
      res.json({ description });

    } catch (error) {
      console.error('❌ AI GENERATE BEAT DESCRIPTION ERROR:', error);
      if (req.userId) {
        aiTaskEvents.emit('task', { type: 'beat:failed', projectId: req.body?.project_id || '', userId: req.userId, payload: { error: 'description generation failed' } });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
