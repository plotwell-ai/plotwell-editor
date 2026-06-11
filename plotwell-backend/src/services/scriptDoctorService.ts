// Script Doctor V2 - Service Layer
// Business logic for scene-level screenplay analysis with caching

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { aiRouter, AIModelRouter } from './aiModelRouter';
import {
  buildSystemPrompt,
  extractJsonFromResponse,
  ScriptDoctorSettings,
  IssueCategory,
  IssueSeverity,
} from './scriptDoctorPrompts';
import { CHAT_CONTEXT_TOOLS, executeToolCall, ToolExecutionContext } from './chatToolDefinitions';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Script Doctor tools: exclude get_script (scenes are already in the request)
const SCRIPT_DOCTOR_TOOLS = CHAT_CONTEXT_TOOLS.filter(
  tool => tool.function.name !== 'get_script'
);

// ============================================================================
// Types
// ============================================================================

export interface SceneIssue {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  message: string;
  suggestion?: string;
  excerpt: string;
}

export interface SceneAnalysis {
  sceneId: string;
  sceneNumber: number;
  sceneHeading: string;
  contentHash: string;
  healthScore: number;
  issues: SceneIssue[];
  strengths: string[];
  pacingScore?: number;
  dialogueScore?: number;
  motivationScore?: number;
  analysisTier: 'basic' | 'full';
  analyzedAt: string;
}

export interface BatchSceneAnalysisRequest {
  projectId: string;
  scriptId: string;
  episodeId?: string;
  userId: string;
  scenes: Array<{
    sceneId: string;
    sceneNumber: number;
    sceneHeading: string;
    sceneContent: string;
  }>;
  settings: ScriptDoctorSettings;
  contentLanguage: string;
  isPremiumUser: boolean;
}

export interface ScriptDoctorSettingsRow {
  id: string;
  project_id: string;
  user_id: string;
  analysis_mode: 'on-save' | 'on-demand' | 'periodic';
  periodic_interval_minutes: number;
  writing_mode: 'standard' | 'strict' | 'minimal';
  genre: string;
  custom_notes: string;
  enabled_categories: IssueCategory[];
  show_scene_health_dots: boolean;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute SHA-256 hash of content for caching
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute hash of settings for cache invalidation
 */
export function computeSettingsHash(settings: ScriptDoctorSettings): string {
  const settingsString = JSON.stringify({
    writingMode: settings.writingMode,
    genre: settings.genre,
    enabledCategories: settings.enabledCategories.sort(),
  });
  return createHash('sha256').update(settingsString).digest('hex').substring(0, 16);
}

/**
 * Generate unique issue ID
 */
function generateIssueId(): string {
  return `issue-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// Cache Operations
// ============================================================================

/**
 * Check if a cached analysis exists for the given scene
 */
export async function getCachedAnalysis(
  projectId: string,
  scriptId: string,
  sceneId: string,
  contentHash: string,
  settingsHash: string
): Promise<SceneAnalysis | null> {
  const { data, error } = await supabase
    .from('script_doctor_scene_analyses')
    .select('*')
    .eq('project_id', projectId)
    .eq('script_id', scriptId)
    .eq('scene_id', sceneId)
    .eq('content_hash', contentHash)
    .eq('settings_hash', settingsHash)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    sceneId: data.scene_id,
    sceneNumber: data.scene_number,
    sceneHeading: data.scene_heading,
    contentHash: data.content_hash,
    healthScore: data.health_score,
    issues: data.issues as SceneIssue[],
    strengths: data.strengths as string[],
    pacingScore: data.pacing_score,
    dialogueScore: data.dialogue_score,
    motivationScore: data.motivation_score,
    analysisTier: data.analysis_tier,
    analyzedAt: data.created_at,
  };
}

interface StoreAnalysisRequest {
  projectId: string;
  scriptId: string;
  episodeId?: string;
  userId: string;
  sceneId: string;
  sceneNumber: number;
  sceneHeading: string;
  isPremiumUser: boolean;
}

/**
 * Store analysis result in cache
 */
async function storeAnalysis(
  request: StoreAnalysisRequest,
  analysis: SceneAnalysis,
  settingsHash: string
): Promise<void> {
  const { error } = await supabase
    .from('script_doctor_scene_analyses')
    .upsert({
      project_id: request.projectId,
      script_id: request.scriptId,
      episode_id: request.episodeId || null,
      user_id: request.userId,
      scene_id: request.sceneId,
      scene_number: request.sceneNumber,
      scene_heading: request.sceneHeading,
      content_hash: analysis.contentHash,
      health_score: analysis.healthScore,
      issues: analysis.issues,
      strengths: analysis.strengths,
      pacing_score: analysis.pacingScore || null,
      dialogue_score: analysis.dialogueScore || null,
      motivation_score: analysis.motivationScore || null,
      settings_hash: settingsHash,
      analysis_tier: analysis.analysisTier,
    }, {
      onConflict: 'project_id,script_id,scene_id,content_hash,settings_hash',
    });

  if (error) {
    console.warn('⚠️ Failed to cache scene analysis:', error.message);
  }
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Analyze multiple scenes in batch
 * Uses a SINGLE AI call to analyze ALL scenes at once (leveraging Grok 4-1's 2M context)
 */
export interface AnalyzeBatchResult {
  analyses: SceneAnalysis[];
  cachedCount: number;
  summary: ScriptSummary | null;
  usage?: { model: string; prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type ProgressCallback = (event: {
  phase: 'cache_check' | 'context_gathering' | 'analyzing' | 'parsing' | 'complete';
  cached?: number;
  toAnalyze?: number;
  total?: number;
  toolRound?: number;
}) => void;

export async function analyzeBatch(
  request: BatchSceneAnalysisRequest,
  onProgress?: ProgressCallback
): Promise<AnalyzeBatchResult> {
  const settingsHash = computeSettingsHash(request.settings);
  const results: SceneAnalysis[] = [];
  let cachedCount = 0;
  let summary: ScriptSummary | null = null;

  // Check cache for each scene first
  const scenesToAnalyze: Array<typeof request.scenes[0] & { contentHash: string }> = [];

  for (const scene of request.scenes) {
    const contentHash = computeContentHash(scene.sceneContent);
    const cached = await getCachedAnalysis(
      request.projectId,
      request.scriptId,
      scene.sceneId,
      contentHash,
      settingsHash
    );

    if (cached) {
      results.push(cached);
      cachedCount++;
    } else {
      scenesToAnalyze.push({ ...scene, contentHash });
    }
  }

  if (DEBUG_AI) console.log(`📊 Script Doctor Batch: ${cachedCount} cached, ${scenesToAnalyze.length} to analyze`);

  onProgress?.({ phase: 'cache_check', cached: cachedCount, toAnalyze: scenesToAnalyze.length, total: request.scenes.length });

  if (scenesToAnalyze.length === 0) {
    onProgress?.({ phase: 'complete', cached: cachedCount, toAnalyze: 0, total: request.scenes.length });
    return { analyses: results, cachedCount, summary: null };
  }

  // Analyze all scenes in a single call - script is sent as one block (token-efficient)
  let usage: AnalyzeBatchResult['usage'];
  try {
    const batchResults = await analyzeScenesBatch(scenesToAnalyze, request, settingsHash, onProgress);
    results.push(...batchResults.analyses);
    summary = batchResults.summary;
    usage = batchResults.usage;
  } catch (error) {
    console.error(`❌ Script Doctor analysis failed for ${scenesToAnalyze.length} scenes:`, error);
    // Add fallback analyses for failed scenes
    for (const scene of scenesToAnalyze) {
      results.push({
        sceneId: scene.sceneId,
        sceneNumber: scene.sceneNumber,
        sceneHeading: scene.sceneHeading,
        contentHash: scene.contentHash,
        healthScore: 50,
        issues: [],
        strengths: [],
        analysisTier: 'basic' as const,
        analyzedAt: new Date().toISOString(),
      });
    }
  }

  // Sort by scene number
  results.sort((a, b) => a.sceneNumber - b.sceneNumber);

  onProgress?.({ phase: 'complete', cached: cachedCount, toAnalyze: scenesToAnalyze.length, total: request.scenes.length });

  return { analyses: results, cachedCount, summary, usage };
}

// Summary returned by Script Doctor
export interface ScriptSummary {
  overall: string;
  strengths: string;
  focusAreas: string;
}

/**
 * Analyze multiple scenes in a SINGLE AI call
 */
async function analyzeScenesBatch(
  scenes: Array<{ sceneId: string; sceneNumber: number; sceneHeading: string; sceneContent: string; contentHash: string }>,
  request: BatchSceneAnalysisRequest,
  settingsHash: string,
  onProgress?: ProgressCallback
): Promise<{ analyses: SceneAnalysis[]; summary: ScriptSummary | null; usage?: AnalyzeBatchResult['usage'] }> {
  const analysisTier = request.isPremiumUser ? 'full' : 'basic';

  // Build script as ONE continuous block (like brainstorming chat does)
  // This is MUCH more token-efficient than formatting each scene separately
  const fullScriptText = scenes.map(scene => scene.sceneContent).join('\n\n');

  // Build compact scene list for reference (just numbers and headings)
  const sceneList = scenes.map(scene => `${scene.sceneNumber}. ${scene.sceneHeading}`).join('\n');

  const systemPrompt = buildSystemPrompt(request.settings, request.contentLanguage);

  // Language instruction
  const langName = request.contentLanguage === 'es' ? 'Spanish' : request.contentLanguage === 'en' ? 'English' : request.contentLanguage;
  const languageNote = request.contentLanguage !== 'en'
    ? `\n⚠️ LANGUAGE: Write ALL feedback in ${langName}.\n`
    : '';

  const userPrompt = `Analyze this ${request.settings.genre} screenplay as a script doctor.
${languageNote}
=== SCENE LIST (${scenes.length} scenes) ===
${sceneList}

=== SCRIPT FORMAT ===
Each line is prefixed with its screenplay element type in brackets:
[SCENE HEADING] = Scene heading (INT./EXT. location)
[ACTION] = Action/description line
[CHARACTER] = Character name (cue before dialogue)
[DIALOGUE] = Dialogue line
[PARENTHETICAL] = Parenthetical direction
[TRANSITION] = Transition (CUT TO, FADE OUT, etc.)
IMPORTANT: Uppercase text in [ACTION] lines (e.g., "YOUNG EDWARD") is a character reference, NOT a scene heading. Only [SCENE HEADING] lines are scene headings.

=== FULL SCRIPT ===
${fullScriptText}

=== THINK FIRST ===
Before writing ANY JSON, carefully consider:
- What is this screenplay's central theme and emotional arc?
- What is the writer's distinctive voice and style?
- Which patterns (repeated images, dialogue callbacks, structural choices) are intentional?
- Where does the script genuinely lose the reader vs. where is it making deliberate choices?

Only after you have a clear picture of the whole screenplay should you score individual scenes.

=== ANALYSIS CRITERIA ===
Categories: ${request.settings.enabledCategories.join(', ')}
Mode: ${request.settings.writingMode}
${request.settings.customNotes ? `Writer notes: ${request.settings.customNotes}` : ''}

When you DO flag an issue:
- Explain WHY it hurts the story (not just what the problem is)
- Suggest HOW to fix it in a way that respects the writer's voice
- Include an exact excerpt so the writer can find it

=== RESPONSE FORMAT (JSON only) ===
{
  "summary": "3-4 sentences: overall assessment, main strengths, and key areas for improvement",
  "scenes": [
    {"n":1,"s":85,"c":"dialogue","i":"Detailed issue explanation","f":"Specific fix suggestion","e":"exact quote from script"},
    {"n":2,"s":92,"c":"","i":"","f":"","e":""},
    ...
  ]
}

FIELD KEY:
- n = scene number
- s = health score (0-100)
- c = category: one of ${request.settings.enabledCategories.join(', ')}
- i = issue: explain the problem clearly (WHY it hurts the story)
- f = fix: actionable suggestion (HOW to improve it)
- e = excerpt: exact 10-30 character quote that appears ONLY in THIS scene (for highlighting). Copy-paste directly from the scene text. Do NOT use text from other scenes. Do NOT include [ELEMENT TYPE] labels - quote only the actual script text

EXAMPLES OF GOOD vs BAD FEEDBACK:
- BAD i: "dialogue unclear" (generic, no reasoning)
- GOOD i: "The exposition about the family history feels forced - characters wouldn't naturally explain things they both already know"
- GOOD f: "Show the family tension through actions or let it emerge naturally in conflict"
- GOOD e: "Papá siempre decía que"

RULES:
- Output ONLY valid JSON. No markdown, no explanation.
- Include ALL ${scenes.length} scenes (n:${scenes[0].sceneNumber} to n:${scenes[scenes.length - 1].sceneNumber})
- Aim for 20-40% of scenes having useful feedback - not every scene needs an issue
- When you flag something, include all four: category (c), issue (i), fix (f), AND exact excerpt (e)
- If a scene works well, give it a high score and leave c/i/f/e empty`;

  // Build routing context - Grok 4.1 Fast Reasoning with maximum capabilities
  // 2M context window, reasoning mode for deep analysis
  const routingContext = AIModelRouter.createContext({
    requestType: 'extraction',
    inputText: userPrompt,
    expectedOutputTokens: Math.min(100000, scenes.length * 2000), // ~2000 tokens per scene for detailed analysis
    metadata: {
      forceModel: 'grok', // Grok 4.1 Fast Reasoning - uses extended thinking
      userPlanId: request.isPremiumUser ? 'paid' : 'free',
    },
  });

  // Execute AI request - maximize tokens for thorough script doctor analysis
  // Grok can output up to 131K tokens with reasoning
  const maxOutputTokens = Math.min(131072, Math.max(32000, scenes.length * 2500));

  if (DEBUG_AI) console.log(`🧠 Script Doctor: Grok 4.1 Fast Reasoning, ${maxOutputTokens} max tokens`);

  // Tool-use loop: AI gathers project context before analyzing
  const MAX_TOOL_ROUNDS = 3;
  let currentMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let result: any;

  const toolContext: ToolExecutionContext = {
    projectId: request.projectId,
    episodeId: request.episodeId,
    supabase,
  };

  if (DEBUG_AI) console.log('🔧 Script Doctor: Starting tool-use loop (max rounds:', MAX_TOOL_ROUNDS, ')');
  onProgress?.({ phase: 'context_gathering', toolRound: 0 });

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS;

    result = await aiRouter.executeCompletion(routingContext, {
      messages: currentMessages,
      maxTokens: isLastRound ? maxOutputTokens : 1024,
      temperature: 0.5,
      tools: isLastRound ? undefined : SCRIPT_DOCTOR_TOOLS,
    });

    // Accumulate usage across all rounds
    totalUsage.prompt_tokens += result.usage.prompt_tokens;
    totalUsage.completion_tokens += result.usage.completion_tokens;
    totalUsage.total_tokens += result.usage.total_tokens;

    // If no tool calls, the AI is giving us the final analysis
    if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') {
      onProgress?.({ phase: 'analyzing' });
      // If truncated by token limit on a tool round, redo with full budget and no tools
      if (result.finishReason === 'length' && !isLastRound) {
        if (DEBUG_AI) console.log(`⚠️ Script Doctor: Response truncated at 1024 tokens, retrying with full budget`);
        result = await aiRouter.executeCompletion(routingContext, {
          messages: currentMessages,
          maxTokens: maxOutputTokens,
          temperature: 0.5,
        });
        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;
      }
      if (DEBUG_AI) console.log(`🔧 Script Doctor: Completed in ${round + 1} round(s)`);
      break;
    }

    onProgress?.({ phase: 'context_gathering', toolRound: round + 1 });

    // Add assistant message with tool_calls to conversation
    currentMessages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.toolCalls,
    });

    // Execute each tool call and add results
    for (const toolCall of result.toolCalls) {
      try {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        const toolResult = await executeToolCall(
          toolCall.function.name,
          args,
          toolContext
        );

        if (DEBUG_AI) console.log(`🔧 Script Doctor tool ${toolCall.function.name}: returned ${toolResult.length} chars`);

        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      } catch (toolError) {
        console.error(`❌ Script Doctor tool ${toolCall.function.name} error:`, toolError);
        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Error executing ${toolCall.function.name}.`,
        });
      }
    }
  }

  result.usage = totalUsage;

  // Log token usage for diagnostics
  if (DEBUG_AI) {
    console.log('📊 Script Doctor AI Response:', {
      model: result.model,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      responseLength: result.content?.length || 0
    });
  }

  onProgress?.({ phase: 'parsing' });

  // Parse response
  const rawContent = result.content || '';

  const jsonResponse = extractJsonFromResponse(rawContent);
  if (!jsonResponse) {
    console.error('❌ Script Doctor: No JSON found in response:', rawContent.substring(0, 500));
    throw new Error('No valid JSON response from AI');
  }

  if (DEBUG_AI) console.log('📝 Script Doctor: Extracted JSON length:', jsonResponse.length);

  let parsed: Array<Record<string, unknown>>;
  let scriptSummary: ScriptSummary | null = null;

  try {
    // Try to fix truncated JSON by finding the last complete object
    let jsonToParse = jsonResponse;
    try {
      JSON.parse(jsonToParse);
    } catch (e) {
      // JSON is likely truncated - try to fix it
      if (DEBUG_AI) console.log('⚠️ Script Doctor: Fixing truncated JSON:', (e as Error).message);

      // Check if this is a wrapper object with scenes array
      if (jsonToParse.includes('"scenes"')) {
        const lastCompleteScene = jsonToParse.lastIndexOf('},{');
        const lastSceneEnd = jsonToParse.lastIndexOf('}]');

        if (lastCompleteScene > lastSceneEnd && lastCompleteScene > 0) {
          jsonToParse = jsonToParse.substring(0, lastCompleteScene + 1) + ']}';
        } else if (lastSceneEnd > 0) {
          jsonToParse = jsonToParse.substring(0, lastSceneEnd + 2) + '}';
        }
      } else {
        const lastCompleteIndex = jsonToParse.lastIndexOf('},');
        const lastArrayEnd = jsonToParse.lastIndexOf('}]');

        if (lastCompleteIndex > lastArrayEnd && lastCompleteIndex > 0) {
          jsonToParse = jsonToParse.substring(0, lastCompleteIndex + 1) + ']';
        }
      }

      // Verify the fix worked
      try {
        JSON.parse(jsonToParse);
      } catch (e2) {
        console.error('❌ Script Doctor: JSON parse failed:', (e as Error).message);
        throw e;
      }
    }

    const rawParsed = JSON.parse(jsonToParse);

    // Handle both array and object responses
    if (Array.isArray(rawParsed)) {
      parsed = rawParsed;
    } else if (rawParsed && typeof rawParsed === 'object') {
      // Check if it's a wrapper object with "scenes" and "summary" properties
      if (Array.isArray(rawParsed.scenes)) {
        parsed = rawParsed.scenes;
        // Handle summary - can be either a string or an object
        if (rawParsed.summary) {
          if (typeof rawParsed.summary === 'string') {
            scriptSummary = {
              overall: rawParsed.summary,
              strengths: '',
              focusAreas: '',
            };
          } else if (typeof rawParsed.summary === 'object') {
            scriptSummary = {
              overall: String(rawParsed.summary.overall || ''),
              strengths: String(rawParsed.summary.strengths || ''),
              focusAreas: String(rawParsed.summary.focusAreas || ''),
            };
          }
        }
      } else if (rawParsed.sceneNumber !== undefined || rawParsed.n !== undefined) {
        parsed = [rawParsed];
      } else {
        console.error('❌ Script Doctor: Unexpected response structure:', Object.keys(rawParsed));
        throw new Error('Response is not an array or valid scene object');
      }
    } else {
      throw new Error('Response is not an array or object');
    }

    if (DEBUG_AI) console.log(`✅ Script Doctor: Parsed ${parsed.length}/${scenes.length} scenes`);

    if (parsed.length < scenes.length) {
      console.warn(`⚠️ Script Doctor: Truncated - got ${parsed.length}/${scenes.length} scenes`);
    }
  } catch (parseError) {
    console.error('❌ Script Doctor: Parse failed:', (parseError as Error).message);
    throw new Error('Invalid AI response format');
  }

  // Map responses to scenes
  const analyses: SceneAnalysis[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const response = parsed[i] || {};

    // Handle both compact format (n, s, i, x) and full format (sceneNumber, healthScore, issues)
    const sceneNumber = Number(response.n || response.sceneNumber) || (i + 1);
    const healthScore = Number(response.s || response.healthScore) || 75;

    let issues: SceneIssue[] = [];

    // Strip element type labels that the AI may accidentally include in excerpts
    const cleanExcerpt = (raw: string): string =>
      raw.replace(/^\[(ACTION|CHARACTER|DIALOGUE|PARENTHETICAL|TRANSITION|SCENE HEADING|HOOK|VOICEOVER|SHOT DESCRIPTION|CTA|MUSIC CUE|TEXT OVERLAY|TIMING NOTE)\]\s*/i, '');

    // Helper to validate category from AI response
    const validCategories = new Set(request.settings.enabledCategories);
    const parseCategory = (raw: unknown): IssueCategory => {
      const cat = String(raw || '').trim() as IssueCategory;
      return validCategories.has(cat) ? cat : request.settings.enabledCategories[0] || 'clarity';
    };

    // Compact format: "i" is issue, "f" is fix/suggestion, "e" is excerpt, "c" is category
    if (typeof response.i === 'string' && response.i.trim()) {
      issues.push({
        id: generateIssueId(),
        category: parseCategory(response.c),
        severity: 'warning' as IssueSeverity,
        message: response.i.trim(),
        suggestion: response.f ? String(response.f).trim() : undefined,
        excerpt: response.e ? cleanExcerpt(String(response.e).trim()) : '',
      });
    }
    // Full format: "issues" is an array
    else if (Array.isArray(response.issues)) {
      issues = (response.issues as Array<Record<string, unknown>>).map(issue => ({
        id: generateIssueId(),
        category: parseCategory(issue.category || issue.c),
        severity: (issue.severity as IssueSeverity) || 'warning',
        message: String(issue.message || issue.i || ''),
        suggestion: issue.suggestion ? String(issue.suggestion) : (issue.f ? String(issue.f) : undefined),
        excerpt: cleanExcerpt(String(issue.excerpt || issue.e || '')),
      }));
    }

    const analysis: SceneAnalysis = {
      sceneId: scene.sceneId,
      sceneNumber: scene.sceneNumber,
      sceneHeading: scene.sceneHeading,
      contentHash: scene.contentHash,
      healthScore,
      issues,
      strengths: [],
      analysisTier,
      analyzedAt: new Date().toISOString(),
    };

    analyses.push(analysis);

    // Store in cache
    await storeAnalysis({
      projectId: request.projectId,
      scriptId: request.scriptId,
      episodeId: request.episodeId,
      userId: request.userId,
      sceneId: scene.sceneId,
      sceneNumber: scene.sceneNumber,
      sceneHeading: scene.sceneHeading,
      isPremiumUser: request.isPremiumUser,
    }, analysis, settingsHash);
  }

  if (DEBUG_AI) {
    console.log(`✅ Script Doctor Batch: Analyzed ${scenes.length} scenes in single AI call`);
  }

  return {
    analyses,
    summary: scriptSummary,
    usage: {
      model: result.model,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.total_tokens,
    },
  };
}

// ============================================================================
// Settings Operations
// ============================================================================

/**
 * Get Script Doctor settings for a project
 */
export async function getSettings(
  projectId: string,
  userId: string
): Promise<ScriptDoctorSettings & { analysisMode: string; periodicIntervalMinutes: number; isEnabled: boolean }> {
  const { data, error } = await supabase
    .from('script_doctor_settings')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    // Return defaults if no settings exist
    return {
      writingMode: 'standard',
      genre: 'drama',
      customNotes: '',
      enabledCategories: ['pacing', 'dialogue', 'clarity', 'engagement', 'character'],
      analysisMode: 'on-demand',
      periodicIntervalMinutes: 5,
      isEnabled: true,
    };
  }

  return {
    writingMode: data.writing_mode,
    genre: data.genre,
    customNotes: data.custom_notes,
    enabledCategories: data.enabled_categories,
    analysisMode: data.analysis_mode,
    periodicIntervalMinutes: data.periodic_interval_minutes,
    isEnabled: data.is_enabled,
  };
}

/**
 * Update Script Doctor settings for a project
 */
export async function updateSettings(
  projectId: string,
  userId: string,
  updates: Partial<ScriptDoctorSettingsRow>
): Promise<ScriptDoctorSettingsRow> {
  // Upsert settings
  const { data, error } = await supabase
    .from('script_doctor_settings')
    .upsert({
      project_id: projectId,
      user_id: userId,
      ...updates,
    }, {
      onConflict: 'project_id,user_id',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update settings: ${error.message}`);
  }

  return data;
}

/**
 * Get all cached analyses for a script
 */
export async function getAllAnalyses(
  projectId: string,
  scriptId: string,
  episodeId?: string
): Promise<SceneAnalysis[]> {
  let query = supabase
    .from('script_doctor_scene_analyses')
    .select('*')
    .eq('project_id', projectId)
    .eq('script_id', scriptId)
    .order('scene_number', { ascending: true });

  if (episodeId) {
    query = query.eq('episode_id', episodeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('❌ Failed to fetch analyses:', error);
    return [];
  }

  return (data || []).map(row => ({
    sceneId: row.scene_id,
    sceneNumber: row.scene_number,
    sceneHeading: row.scene_heading,
    contentHash: row.content_hash,
    healthScore: row.health_score,
    issues: row.issues as SceneIssue[],
    strengths: row.strengths as string[],
    pacingScore: row.pacing_score,
    dialogueScore: row.dialogue_score,
    motivationScore: row.motivation_score,
    analysisTier: row.analysis_tier,
    analyzedAt: row.created_at,
  }));
}

/**
 * Clear all analyses for a script (e.g., when settings change)
 */
export async function clearAnalyses(
  projectId: string,
  scriptId: string,
  userId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('script_doctor_scene_analyses')
    .delete()
    .eq('project_id', projectId)
    .eq('script_id', scriptId)
    .eq('user_id', userId)
    .select('id');

  if (error) {
    console.error('❌ Failed to clear analyses:', error);
    return 0;
  }

  return data?.length || 0;
}

/**
 * Save the script summary to settings for cache persistence
 */
export async function saveSummary(
  projectId: string,
  userId: string,
  scriptId: string,
  summary: ScriptSummary
): Promise<void> {
  const { error } = await supabase
    .from('script_doctor_settings')
    .upsert({
      project_id: projectId,
      user_id: userId,
      last_summary: summary,
      last_summary_script_id: scriptId,
    }, {
      onConflict: 'project_id,user_id',
    });

  if (error) {
    console.warn('⚠️ Failed to save Script Doctor summary:', error.message);
  }
}

// ============================================================================
// Issue Dismiss/Acknowledge
// ============================================================================

/**
 * Dismiss or acknowledge an issue so it's hidden from the UI
 */
export async function dismissIssue(
  projectId: string,
  scriptId: string,
  sceneId: string,
  issueId: string,
  userId: string,
  status: 'dismissed' | 'acknowledged' = 'dismissed'
): Promise<void> {
  const { error } = await supabase
    .from('script_doctor_dismissed_issues')
    .upsert({
      project_id: projectId,
      script_id: scriptId,
      scene_id: sceneId,
      issue_id: issueId,
      user_id: userId,
      status,
      dismissed_at: new Date().toISOString(),
    }, {
      onConflict: 'project_id,script_id,scene_id,issue_id,user_id',
    });

  if (error) {
    console.error('❌ Failed to dismiss issue:', error.message);
    throw new Error(`Failed to dismiss issue: ${error.message}`);
  }
}

/**
 * Undismiss an issue (restore it to active)
 */
export async function undismissIssue(
  projectId: string,
  scriptId: string,
  sceneId: string,
  issueId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('script_doctor_dismissed_issues')
    .delete()
    .eq('project_id', projectId)
    .eq('script_id', scriptId)
    .eq('scene_id', sceneId)
    .eq('issue_id', issueId)
    .eq('user_id', userId);

  if (error) {
    console.error('❌ Failed to undismiss issue:', error.message);
    throw new Error(`Failed to undismiss issue: ${error.message}`);
  }
}

/**
 * Get all dismissed issue IDs for a script
 */
export async function getDismissedIssues(
  projectId: string,
  scriptId: string,
  userId: string
): Promise<Array<{ sceneId: string; issueId: string; status: string }>> {
  const { data, error } = await supabase
    .from('script_doctor_dismissed_issues')
    .select('scene_id, issue_id, status')
    .eq('project_id', projectId)
    .eq('script_id', scriptId)
    .eq('user_id', userId);

  if (error) {
    console.error('❌ Failed to fetch dismissed issues:', error.message);
    return [];
  }

  return (data || []).map(row => ({
    sceneId: row.scene_id,
    issueId: row.issue_id,
    status: row.status,
  }));
}

/**
 * Get the cached summary for a script
 */
export async function getSummary(
  projectId: string,
  userId: string,
  scriptId: string
): Promise<ScriptSummary | null> {
  const { data, error } = await supabase
    .from('script_doctor_settings')
    .select('last_summary, last_summary_script_id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;

  // Only return summary if it matches the requested script
  if (data.last_summary_script_id === scriptId && data.last_summary) {
    return data.last_summary as ScriptSummary;
  }

  return null;
}
