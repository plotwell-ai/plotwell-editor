/**
 * /api/tools — Standalone mini-tool endpoints
 *
 * Scripts tool:
 *   POST /api/tools/scripts/scenes   — Extract scene list from treatment (free, IP rate limited)
 *   POST /api/tools/scripts/preview  — Generate Scene 1 in Fountain (free, 1-shot per IP per 24h)
 *   POST /api/tools/scripts/generate — Generate full script (auth required, 1 credit/scene)
 *
 * Storyboard tool:
 *   POST /api/tools/storyboard/parse    — Parse script into scene list (free)
 *   POST /api/tools/storyboard/preview  — Generate 3 panel images (free, 1-shot per IP per 24h)
 *   POST /api/tools/storyboard/generate — Generate full storyboard (auth required, 10 credits/panel)
 *
 * Budget tool:
 *   POST /api/tools/budget/estimate  — Top-sheet estimate (free, IP rate limited)
 *   POST /api/tools/budget/breakdown — Full department breakdown (auth required, 5 credits)
 */

import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { extractUserId } from '../middleware/pricingMiddleware';
import { PricingService } from '../services/pricingService';
import { aiRouter, AIModelRouter } from '../services/aiModelRouter';
import { ImageModelRouter } from '../services/imageModelRouter';
import { buildStoryboardImagePrompt } from '../prompts';
import { BUCKETS } from '../services/storageService';

const router = express.Router();

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// Lazy Supabase client
let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

// Shared image router (lazy singleton)
let _imageRouter: ImageModelRouter | null = null;
function getImageRouter() {
  if (!_imageRouter) _imageRouter = new ImageModelRouter();
  return _imageRouter;
}

// ─── Rate limiters ──────────────────────────────────────────────────────────

const freeListLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.ip || ipKeyGenerator(req.ip || 'unknown'),
  message: 'Too many requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// 1-shot free preview: 3 per IP per 24h (tolerance for retries)
const freePreviewLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.ip || ipKeyGenerator(req.ip || 'unknown'),
  message: 'Free preview limit reached. Sign up to continue.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authGenerateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req as any).userId || req.ip || ipKeyGenerator(req.ip || 'unknown'),
  message: 'Too many generation requests, please slow down.',
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Uploads a base64 data URI image to Supabase temp storage and returns a 24h signed URL.
 * Falls back to the original URL on any failure.
 */
async function uploadToTempStorage(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith('data:image/')) return imageUrl;
  const commaIdx = imageUrl.indexOf(',');
  if (commaIdx === -1) return imageUrl;
  const base64Data = imageUrl.slice(commaIdx + 1);
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `ai-generated/tool-preview/${uuidv4()}.png`;
    const { error: uploadError } = await getSupabase().storage
      .from(BUCKETS.STORYBOARD_IMAGES)
      .upload(fileName, buffer, { contentType: 'image/png', upsert: false });
    if (uploadError) {
      if (DEBUG_AI) console.log('⚠️ uploadToTempStorage: upload failed:', uploadError.message);
      return imageUrl;
    }
    const { data: signed } = await getSupabase().storage
      .from(BUCKETS.STORYBOARD_IMAGES)
      .createSignedUrl(fileName, 86400); // 24h TTL
    return signed?.signedUrl ?? imageUrl;
  } catch (err) {
    if (DEBUG_AI) console.log('⚠️ uploadToTempStorage: error:', err);
    return imageUrl;
  }
}

async function checkAndDeductCredits(
  userId: string,
  amount: number,
  description: string,
  metadata: Record<string, unknown>
): Promise<{ ok: boolean; balance: number; error?: string }> {
  const pricingService = new PricingService(getSupabase());
  const balance = await pricingService.getAICreditsBalance(userId);

  if (balance < amount) {
    return { ok: false, balance, error: `Insufficient credits. Need ${amount}, have ${balance}.` };
  }

  const deducted = await pricingService.consumeAICredits(userId, amount, description, metadata);
  if (!deducted) {
    return { ok: false, balance, error: 'Failed to deduct credits. Please try again.' };
  }

  const newBalance = await pricingService.getAICreditsBalance(userId);
  return { ok: true, balance: newBalance };
}

async function aiComplete(system: string, user: string, maxTokens = 2000, temperature = 0.7): Promise<string> {
  const context = AIModelRouter.createContext({
    requestType: 'generation',
    inputText: user,
    expectedOutputTokens: maxTokens,
  });

  const result = await aiRouter.executeCompletion(context, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens,
    temperature,
  });

  return result.content;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCRIPTS TOOL
// ═══════════════════════════════════════════════════════════════════════════

const SCENES_SYSTEM = `You are a professional script analyst. Given a treatment, synopsis, or outline, extract a scene breakdown.

Return a JSON array and nothing else. Use this exact structure:
[{"number":1,"heading":"INT. COFFEE SHOP - DAY","summary":"Brief one-sentence description of the key action or turning point."}]

Rules:
- Scene headings: INT. LOCATION - TIME OF DAY or EXT. LOCATION - TIME OF DAY (all caps)
- Use INT./EXT. only when a scene genuinely crosses between interior and exterior
- Summaries under 25 words each
- Scene count appropriate to format: Feature Film 30-50, TV Pilot 15-25, Short Film 5-15, Web Series Episode 8-15
- Always return at least 3 scenes, even for very short or minimal treatments — infer logical continuations if needed
- Return ONLY the JSON array, no markdown code blocks, no explanation`;

const SCENE_WRITE_SYSTEM = `You are a professional screenplay writer. Write the requested scene in proper Fountain screenplay format.

Fountain format rules:
- Scene heading on its own line: INT. LOCATION - TIME OF DAY or EXT. LOCATION - TIME OF DAY
- Use INT./EXT. only when the scene genuinely crosses between interior and exterior
- Action lines: plain text paragraphs describing what the camera sees
- Character cue: CHARACTER NAME on its own line (ALL CAPS)
- Dialogue: on the next line after the character cue
- Parenthetical: use single parentheses only, e.g. (beat) or (quietly), on its own line between cue and dialogue — NEVER double parentheses like ((text))
- Scene length: 1-3 pages (60-200 words total)
- Write ONLY the Fountain-formatted scene text, no explanations`;

function sceneWritePrompt(opts: {
  treatment: string; genre: string; tone: string; format: string;
  heading: string; summary: string; sceneNumber: number; totalScenes: number;
}) {
  return `Scene ${opts.sceneNumber} of ${opts.totalScenes} | ${opts.genre} | ${opts.tone} | ${opts.format}

Scene heading: ${opts.heading}
Scene purpose: ${opts.summary}

Story context:
${opts.treatment.slice(0, 600)}${opts.treatment.length > 600 ? '...' : ''}`;
}

/** POST /api/tools/scripts/scenes */
router.post('/scripts/scenes', freeListLimiter, async (req: Request, res: Response) => {
  const { treatment, genre = 'Drama', tone = 'Serious', format = 'Feature Film', language } = req.body as Record<string, string>;

  if (!treatment || treatment.trim().length < 50) {
    return res.status(400).json({ error: 'Treatment must be at least 50 characters.' });
  }

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write all summaries in ${language}. Do not use English.`
    : '';

  try {
    if (DEBUG_AI) console.log('🔍 Tools/scripts: generating scene list');

    const raw = await aiComplete(
      SCENES_SYSTEM + langInstruction,
      `Format: ${format}\nGenre: ${genre}\nTone: ${tone}\n\nTreatment:\n${treatment.slice(0, 4000)}`,
      2000, 0.3
    );

    // Extract JSON array robustly — always find the outermost [ ... ] span,
    // ignoring any prose, markdown fences, or trailing text the model may add.
    const _arrStart = raw.indexOf('[');
    const _arrEnd = raw.lastIndexOf(']');
    const jsonStr = (_arrStart !== -1 && _arrEnd > _arrStart)
      ? raw.slice(_arrStart, _arrEnd + 1)
      : raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    let scenes: Array<{ number: number; heading: string; summary: string }>;
    try {
      scenes = JSON.parse(jsonStr);
    } catch {
      console.error('❌ Tools/scripts: failed to parse scene list JSON, raw length:', raw.length);
      if (DEBUG_AI) console.error('❌ Tools/scripts: raw response:', raw.slice(0, 500));
      return res.status(500).json({ error: 'Failed to parse scene breakdown. Please try again.' });
    }

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(500).json({ error: 'Could not generate scene breakdown. Please add more detail.' });
    }

    if (DEBUG_AI) console.log(`✅ Tools/scripts: ${scenes.length} scenes`);
    res.json({ scenes });
  } catch (error) {
    console.error('❌ Tools/scripts/scenes error:', error);
    res.status(500).json({ error: 'Failed to generate scene breakdown. Please try again.' });
  }
});

/** POST /api/tools/scripts/preview — First 3 scenes free */
router.post('/scripts/preview', freePreviewLimiter, async (req: Request, res: Response) => {
  const { treatment, genre = 'Drama', tone = 'Serious', format = 'Feature Film', scenes, language } = req.body as {
    treatment?: string; genre?: string; tone?: string; format?: string; language?: string;
    scenes?: Array<{ number: number; heading: string; summary: string }>;
  };

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write the screenplay in ${language}. All dialogue, action lines, and character cues should be in ${language}.`
    : '';

  if (!treatment || !scenes || scenes.length === 0) {
    return res.status(400).json({ error: 'Missing treatment or scene list.' });
  }

  const previewScenes = scenes.slice(0, 3);

  try {
    if (DEBUG_AI) console.log(`🔍 Tools/scripts: generating ${previewScenes.length} preview scenes`);

    const parts = await Promise.all(
      previewScenes.map((scene) =>
        aiComplete(
          SCENE_WRITE_SYSTEM + langInstruction,
          sceneWritePrompt({ treatment, genre, tone, format, heading: scene.heading, summary: scene.summary, sceneNumber: scene.number, totalScenes: scenes.length }),
          1200, 0.7
        )
      )
    );

    const content = parts.filter(Boolean).join('\n\n');
    if (!content) return res.status(500).json({ error: 'Failed to generate preview. Please try again.' });

    if (DEBUG_AI) console.log(`✅ Tools/scripts: preview done (${previewScenes.length} scenes)`);
    res.json({ content, previewCount: previewScenes.length });
  } catch (error) {
    console.error('❌ Tools/scripts/preview error:', error);
    res.status(500).json({ error: 'Failed to generate preview. Please try again.' });
  }
});

/** POST /api/tools/scripts/generate — full script, auth + credits */
router.post('/scripts/generate', requireAuth, extractUserId, authGenerateLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { treatment, genre = 'Drama', tone = 'Serious', format = 'Feature Film', scenes } = req.body as {
    treatment?: string; genre?: string; tone?: string; format?: string;
    scenes?: Array<{ number: number; heading: string; summary: string }>;
  };

  if (!treatment || !scenes || scenes.length === 0) {
    return res.status(400).json({ error: 'Missing treatment or scene list.' });
  }

  const creditsNeeded = scenes.length;
  const { ok, balance, error } = await checkAndDeductCredits(
    userId, creditsNeeded,
    `Scripts tool: ${format} (${scenes.length} scenes)`,
    { tool: 'scripts', scenes: scenes.length }
  );

  if (!ok) {
    return res.status(402).json({ error, error_type: 'insufficient_credits', credits_required: creditsNeeded, credits_balance: balance });
  }

  if (DEBUG_AI) console.log(`🚀 Tools/scripts: generating ${scenes.length} scenes for ${userId}`);

  try {
    const parts: string[] = [];
    for (const scene of scenes) {
      const sceneText = await aiComplete(
        SCENE_WRITE_SYSTEM,
        sceneWritePrompt({ treatment, genre, tone, format, heading: scene.heading, summary: scene.summary, sceneNumber: scene.number, totalScenes: scenes.length }),
        1200, 0.7
      );
      if (sceneText) parts.push(sceneText);
    }

    const newBalance = await new PricingService(getSupabase()).getAICreditsBalance(userId);

    if (DEBUG_AI) console.log(`✅ Tools/scripts: full script done (${parts.length} scenes)`);
    res.json({ content: parts.join('\n\n'), credits_used: creditsNeeded, credits_remaining: newBalance });
  } catch (error) {
    console.error('❌ Tools/scripts/generate error:', error);
    res.status(500).json({ error: 'Script generation failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STORYBOARD TOOL
// ═══════════════════════════════════════════════════════════════════════════

const STORYBOARD_PARSE_SYSTEM = `You are a professional script analyst. Extract a scene list from a screenplay or script.

Return a JSON array and nothing else:
[{"number":1,"heading":"INT. COFFEE SHOP - DAY","summary":"Brief description of the key visual action."}]

Rules:
- Use the actual scene headings from the script when available
- Summaries focus on what the camera SEES (visual action, not dialogue)
- Max 20 words per summary
- Return ONLY the JSON array`;

// Asks the AI to return structured panel data — same fields the main app uses
const STORYBOARD_PANEL_SYSTEM = `You are a professional storyboard artist and cinematographer.
Given a scene heading and action description, return a JSON object describing a single storyboard panel.

LANGUAGE RULE: Write the "description" field in the SAME language as the input script/scene content.
The enum fields (shot_type, camera_movement, lighting, mood) must ALWAYS use the exact English option keys listed below — never translate them.

CRITICAL for description: The image model generating the visual cannot identify characters by name. You MUST describe every character that appears using their physical appearance — always state gender explicitly (woman/man/girl/boy), approximate age, hair, build, and clothing. Never write just a character name like "Clara runs" or "Clara corre". Instead describe their appearance: "a young woman with dark curly hair runs". If character descriptions are provided, use them.

Return ONLY a JSON object, no markdown:
{
  "description": "2-3 sentence visual description of what the camera sees — explicit character appearance (gender, age, hair, build), action, composition. In the same language as the script.",
  "shot_type": "medium-shot",
  "camera_movement": "static",
  "lighting": "natural",
  "mood": "tense"
}

shot_type options: extreme-wide, wide-shot, medium-shot, close-up, extreme-close-up, over-shoulder, point-of-view, two-shot, insert, cutaway, low-angle, high-angle
camera_movement options: static, pan-left, pan-right, tilt-up, tilt-down, dolly-in, dolly-out, tracking, handheld, crane
lighting options: natural, golden-hour, blue-hour, night, overcast, high-key, low-key, backlit, side-lit, practical, neon
mood options: tense, romantic, melancholic, chaotic, serene, ominous, joyful, mysterious, epic, intimate, gritty, dreamlike`;

/**
 * Extract character names and their visual descriptions from raw script text.
 * Returns a map of UPPERCASE_NAME → description string.
 * One AI call, cached per preview request.
 */
async function extractCharacterDescriptions(scriptText: string): Promise<Record<string, string>> {
  if (!scriptText || scriptText.trimStart().startsWith('<')) return {};
  try {
    const raw = await aiComplete(
      `You extract character descriptions from screenplays. Return ONLY a JSON object mapping character names to their visual appearance.

Rules:
- Keys must be the character's name in UPPERCASE exactly as it appears in the script
- Values must describe ONLY visual appearance: age, gender, ethnicity, hair, build, typical clothing
- Include ONLY characters that have at least one visual detail described in the script
- Keep each description to 1-2 sentences, English only
- Return {} if no visual descriptions are found

Example output:
{"CLARA": "Woman in her late 20s, dark curly hair, athletic build, wearing a bikini.", "MARCO": "Man around 30, short black hair, stubble, usually seen in a worn leather jacket."}`,
      `Extract character visual descriptions from this script:\n\n${scriptText.slice(0, 5000)}`,
      600, 0.2
    );
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Given scene content and a character map, return descriptions for characters
 * that appear in this scene (matched by uppercase name mentions).
 */
function getSceneCharacterDescriptions(sceneContent: string, heading: string, characters: Record<string, string>): string {
  if (!Object.keys(characters).length) return '';
  const text = (heading + ' ' + sceneContent).toUpperCase();
  const found = Object.entries(characters).filter(([name]) => text.includes(name));
  if (!found.length) return '';
  return found.map(([name, desc]) => `${name}: ${desc}`).join('\n');
}

/**
 * Extract the actual scene content (action lines, dialogue) from raw script text.
 * Finds the scene by its heading and returns the text until the next scene heading.
 * Works for Fountain and plain text formats. Returns empty string for FDX (XML).
 */
function extractSceneContent(scriptText: string, heading: string, maxChars = 600): string {
  if (!scriptText) return '';
  // Skip XML/FDX — not parseable as plain text
  if (scriptText.trimStart().startsWith('<')) return '';

  const upper = scriptText.toUpperCase();
  const headingUpper = heading.toUpperCase().replace(/\s+/g, ' ').trim();
  const idx = upper.indexOf(headingUpper);
  if (idx === -1) return '';

  const afterHeading = scriptText.slice(idx + heading.length);
  // Stop at the next scene heading (line starting with INT. / EXT. / INT./EXT.)
  const nextScene = afterHeading.match(/\n[ \t]*(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)/i);
  const raw = afterHeading.slice(0, nextScene?.index ?? afterHeading.length).trim();
  // Strip Fountain notes/sections and collapse whitespace
  return raw.replace(/^={2,}.*$/gm, '').replace(/\n{3,}/g, '\n\n').slice(0, maxChars).trim();
}

function buildPanelPrompt(
  scene: { heading: string; summary: string },
  genre: string,
  sceneContent?: string,
  characterDescriptions?: string,
) {
  const action = sceneContent?.trim() || scene.summary;
  const charSection = characterDescriptions?.trim()
    ? `\nCharacters in this scene:\n${characterDescriptions}`
    : '';
  return `Scene heading: ${scene.heading}
Scene content:
${action}${charSection}
Genre: ${genre}

Return a JSON object for this panel. Use the character descriptions to accurately depict their appearance in the visual description.`;
}

async function generatePanelData(
  scene: { heading: string; summary: string },
  genre: string,
  langInstruction: string,
  sceneContent?: string,
  characterDescriptions?: string,
) {
  const raw = await aiComplete(
    STORYBOARD_PANEL_SYSTEM + langInstruction,
    buildPanelPrompt(scene, genre, sceneContent, characterDescriptions),
    300, 0.7
  );
  try {
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(jsonStr) as { description: string; shot_type: string; camera_movement: string; lighting: string; mood: string };
  } catch {
    return { description: raw.slice(0, 400), shot_type: 'medium-shot', camera_movement: 'static', lighting: 'natural', mood: 'tense' };
  }
}

/** POST /api/tools/storyboard/parse */
router.post('/storyboard/parse', freeListLimiter, async (req: Request, res: Response) => {
  const { script, language } = req.body as { script?: string; language?: string };

  if (!script || script.trim().length < 50) {
    return res.status(400).json({ error: 'Script must be at least 50 characters.' });
  }

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write all summaries in ${language}. Do not use English.`
    : '';

  try {
    if (DEBUG_AI) console.log('🔍 Tools/storyboard: parsing script');

    const raw = await aiComplete(
      STORYBOARD_PARSE_SYSTEM + langInstruction,
      `Parse this script into a scene list:\n\n${script.slice(0, 6000)}`,
      2000, 0.2
    );

    const _sStart = raw.indexOf('['), _sEnd = raw.lastIndexOf(']');
    const jsonStr = (_sStart !== -1 && _sEnd > _sStart)
      ? raw.slice(_sStart, _sEnd + 1)
      : raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    let scenes: Array<{ number: number; heading: string; summary: string }>;
    try {
      scenes = JSON.parse(jsonStr);
    } catch {
      return res.status(500).json({ error: 'Failed to parse scene list. Please try again.' });
    }

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(500).json({ error: 'No scenes found. Check your script format.' });
    }

    if (DEBUG_AI) console.log(`✅ Tools/storyboard: ${scenes.length} scenes parsed`);
    res.json({ scenes });
  } catch (error) {
    console.error('❌ Tools/storyboard/parse error:', error);
    res.status(500).json({ error: 'Failed to parse script. Please try again.' });
  }
});

/** POST /api/tools/storyboard/preview — first 2 panels free */
router.post('/storyboard/preview', freePreviewLimiter, async (req: Request, res: Response) => {
  const { scenes, genre = 'Drama', style = 'Realistic', language, scriptText, scriptFormat } = req.body as {
    scenes?: Array<{ number: number; heading: string; summary: string }>;
    genre?: string; style?: string; language?: string;
    scriptText?: string; scriptFormat?: string;
  };

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write the "description" field in ${language} to match the script's language. The enum fields (shot_type, camera_movement, lighting, mood) must always use the exact English option keys listed — never translate them.`
    : '';

  if (!scenes || scenes.length === 0) {
    return res.status(400).json({ error: 'No scenes provided.' });
  }

  const previewScenes = scenes.slice(0, 2);

  try {
    if (DEBUG_AI) console.log('🔍 Tools/storyboard: generating 2 preview panels');

    const fidelity = style === 'Sketch' ? 'sketch' : 'cinematic';

    // Extract character descriptions once — shared across all panels
    const characters = scriptText ? await extractCharacterDescriptions(scriptText) : {};
    if (DEBUG_AI && Object.keys(characters).length) console.log(`🎭 Tools/storyboard: ${Object.keys(characters).length} characters extracted:`, Object.keys(characters).join(', '));

    const rawPanels = await Promise.all(previewScenes.map(async (scene) => {
      // Step 1: Get structured panel data using full scene content + character descriptions
      const sceneContent = scriptText ? extractSceneContent(scriptText, scene.heading) : undefined;
      const charDescs = getSceneCharacterDescriptions(sceneContent || scene.summary, scene.heading, characters);
      const panelData = await generatePanelData(scene, genre, langInstruction, sceneContent, charDescs);

      // Step 2: Build production-quality image prompt (same builder as main app)
      // Pass character descriptions as notes so FLUX receives explicit appearance info
      // even if the text AI description omitted gender/appearance details.
      const imagePrompt = buildStoryboardImagePrompt({
        sceneDescription: panelData.description,
        shotType: panelData.shot_type,
        cameraMovement: panelData.camera_movement,
        fidelity,
        lighting: panelData.lighting,
        mood: panelData.mood,
        sceneHeading: scene.heading,
        notes: charDescs ? charDescs.replace(/\n/g, '; ') : undefined,
      });

      // Step 3: Generate image
      const result = await getImageRouter().generate({
        prompt: imagePrompt,
        aspectRatio: '16:9',
        outputFormat: 'png',
      });

      return {
        number: scene.number,
        heading: scene.heading,
        summary: scene.summary,
        imageUrl: result.imageUrl,
        description: panelData.description,
      };
    }));

    // Step 4: Upload any base64 images to Supabase storage so the session payload
    // stays small (base64 PNGs can be 1-2 MB each, causing PayloadTooLarge errors).
    const panels = await Promise.all(rawPanels.map(async (panel) => ({
      ...panel,
      imageUrl: await uploadToTempStorage(panel.imageUrl),
    })));

    // Step 5: Create a server-side session so the frontend never needs to re-POST panel data.
    const sessionToken = createToolSession(
      typeof scriptText === 'string' ? scriptText : '',
      scriptFormat === 'fdx' ? 'fdx' : 'fountain',
      panels,
    );

    if (DEBUG_AI) console.log(`✅ Tools/storyboard: ${panels.length} preview panels done, session ${sessionToken}`);
    res.json({ panels, sessionToken });
  } catch (error) {
    console.error('❌ Tools/storyboard/preview error:', error);
    res.status(500).json({ error: 'Failed to generate storyboard preview. Please try again.' });
  }
});

/** POST /api/tools/storyboard/generate — full storyboard, auth + credits */
router.post('/storyboard/generate', requireAuth, extractUserId, authGenerateLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { scenes, genre = 'Drama', style = 'Realistic', language } = req.body as {
    scenes?: Array<{ number: number; heading: string; summary: string }>;
    genre?: string; style?: string; language?: string;
  };

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write the "description" field in ${language} to match the script's language. The enum fields (shot_type, camera_movement, lighting, mood) must always use the exact English option keys listed — never translate them.`
    : '';

  if (!scenes || scenes.length === 0) {
    return res.status(400).json({ error: 'No scenes provided.' });
  }

  const IMAGE_CREDIT_COST = 10;
  const creditsNeeded = scenes.length * IMAGE_CREDIT_COST;

  const { ok, balance, error } = await checkAndDeductCredits(
    userId, creditsNeeded,
    `Storyboard tool: ${scenes.length} panels`,
    { tool: 'storyboard', panels: scenes.length }
  );

  if (!ok) {
    return res.status(402).json({ error, error_type: 'insufficient_credits', credits_required: creditsNeeded, credits_balance: balance });
  }

  if (DEBUG_AI) console.log(`🚀 Tools/storyboard: generating ${scenes.length} panels for ${userId}`);

  try {
    // Generate all panels in parallel batches of 3
    const panels: Array<{ number: number; heading: string; summary: string; imageUrl: string; description: string }> = [];
    const batchSize = 3;

    for (let i = 0; i < scenes.length; i += batchSize) {
      const batch = scenes.slice(i, i + batchSize);
      const fidelity = style === 'Sketch' ? 'sketch' : 'cinematic';
      const batchResults = await Promise.all(batch.map(async (scene) => {
        const panelData = await generatePanelData(scene, genre, langInstruction);
        const imagePrompt = buildStoryboardImagePrompt({
          sceneDescription: panelData.description,
          shotType: panelData.shot_type,
          cameraMovement: panelData.camera_movement,
          fidelity,
          lighting: panelData.lighting,
          mood: panelData.mood,
          sceneHeading: scene.heading,
        });
        const result = await getImageRouter().generate({ prompt: imagePrompt, aspectRatio: '16:9', outputFormat: 'png' });
        return { number: scene.number, heading: scene.heading, summary: scene.summary, imageUrl: result.imageUrl, description: panelData.description };
      }));
      panels.push(...batchResults);
    }

    const newBalance = await new PricingService(getSupabase()).getAICreditsBalance(userId);

    if (DEBUG_AI) console.log(`✅ Tools/storyboard: ${panels.length} panels done`);
    res.json({ panels, credits_used: creditsNeeded, credits_remaining: newBalance });
  } catch (error) {
    console.error('❌ Tools/storyboard/generate error:', error);
    res.status(500).json({ error: 'Storyboard generation failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BUDGET TOOL
// ═══════════════════════════════════════════════════════════════════════════

// Reference data for budget calibration (standard rom-com/drama, 90 min, mid-budget)
const BUDGET_REFERENCE = `
Reference ranges for a standard rom-com or drama (90 min, mid-budget, ~2 leads + 4-8 supporting):
Country       | Shoot days | Budget range (local currency)         | Notes
USA indie     | 18-25      | USD 500K-3M                           | Non-union or low-budget SAG
USA mid       | 25-35      | USD 5-15M                             | SAG/IATSE, streaming originals
USA studio    | 40-60      | USD 20-60M                            | Theatrical, full union
UK            | 30-40      | GBP 1-4M indie / 5-15M mid            | BECTU/Equity; 25.5% AVEC tax relief
France        | 35-45      | EUR 2-4M indie / 5-10M mid            | CNC subsidy; strict 35h/week rules
Germany       | 30-40      | EUR 3-7M mid / 8-15M large            | Regional Filmförderung co-financing
Spain         | 30-40      | EUR 0.6-1.5M indie / 1.5-4M mid      | ICAA grants; 10-12h days, 5-day week
Mexico        | 25-30      | USD 800K-2.5M mid                     | EFICINE/IMCINE; competitive tech costs
Colombia      | 22-28      | USD 800K-1.8M                         | FDC + Ley 1556 (40% rebate)
Argentina     | 20-25      | USD 500K-1.2M                         | INCAA; peso volatility — quote in USD
Uruguay       | 20-25      | USD 600K-1.5M (usually co-production) | ICAU modest grants; often co-prod
India Bollywood| 50-80     | INR 20-50 crore (USD 2.5-6M)         | Musical numbers add 3-5 days each
India indie   | 25-35      | INR 2-5 crore (USD 240-600K)          | Arthouse/OTT

Shoot day rule: ~3 script pages/day average. Comedies trend faster (dialogue-heavy, fewer complex set-ups). Dramas with many locations or careful framing trend slower.
`;

const BUDGET_TOPSHEET_SYSTEM = `You are a professional film production accountant with 20 years of experience. Given a project description, produce a realistic top-sheet budget estimate.

Use the reference data below to calibrate your estimate to the correct country and budget tier:
${BUDGET_REFERENCE}

Return a JSON object and nothing else:
{
  "total_low": 50000,
  "total_high": 120000,
  "currency": "<ISO 4217 code matching the production country>",
  "shooting_days_estimate": 15,
  "assumptions": ["Non-union crew", "Practical locations only", "No VFX"],
  "categories": [
    {"name": "Above the Line", "low": 8000, "high": 20000, "note": "Director, writer, lead cast"},
    {"name": "Camera & Lighting", "low": 6000, "high": 15000, "note": "Equipment rental"},
    {"name": "Sound", "low": 2000, "high": 5000, "note": "Production sound + post"},
    {"name": "Locations & Art", "low": 4000, "high": 10000, "note": "Location fees, set dressing"},
    {"name": "Cast & Extras", "low": 5000, "high": 12000, "note": "Principal + day players"},
    {"name": "Post Production", "low": 8000, "high": 20000, "note": "Edit, color, VFX, music"},
    {"name": "G&A / Contingency", "low": 5000, "high": 15000, "note": "Insurance, legal, 10% contingency"}
  ]
}

Rules:
- Use the correct local currency: USA→USD, UK→GBP, Canada→CAD, Spain/France/Germany/Italy→EUR, Australia→AUD, Mexico→MXN, Argentina→ARS (or USD if requested), Brazil→BRL, India→INR. Default to USD for unknown countries.
- Scale total to the production country and union/non-union status using the reference ranges above
- shooting_days_estimate must follow the ~3 pages/day rule adjusted for genre and country norms
- Return ONLY the JSON object`;

const BUDGET_BREAKDOWN_SYSTEM = `You are a professional line producer. Given a project, produce a detailed department-by-department budget breakdown.

Use the reference data below to calibrate day rates and totals to the correct country and budget tier:
${BUDGET_REFERENCE}

Return a JSON object and nothing else:
{
  "total_low": 50000,
  "total_high": 120000,
  "currency": "<ISO 4217 code matching the production country>",
  "departments": [
    {
      "name": "Direction",
      "line_items": [
        {"item": "Director fee", "qty": 1, "unit": "flat", "rate_low": 5000, "rate_high": 15000, "note": ""},
        {"item": "AD (1st)", "qty": 15, "unit": "days", "rate_low": 400, "rate_high": 600, "note": "Day rate"}
      ]
    }
  ]
}

Rules:
- Use the correct local currency: USA→USD, UK→GBP, Canada→CAD, Spain/France/Germany/Italy→EUR, Australia→AUD, Mexico→MXN, Argentina→ARS, Brazil→BRL, India→INR. Default to USD for unknown countries.
- At least 8 departments with realistic day rates for the specified country and union status
- Total must fall within the reference range for the country and budget tier
- Return ONLY the JSON object`;

function budgetUserPrompt(body: {
  description: string; country: string; union: string;
  shooting_days: number; cast_size: number; genre: string; format: string;
}) {
  return `Project: ${body.description.slice(0, 1000)}

Country: ${body.country}
Union/Non-union: ${body.union}
Estimated shooting days: ${body.shooting_days}
Cast size: ${body.cast_size} principal roles
Genre: ${body.genre}
Format: ${body.format}`;
}

/** POST /api/tools/budget/estimate — top-sheet, free */
router.post('/budget/estimate', freeListLimiter, async (req: Request, res: Response) => {
  const { description, country = 'USA', union = 'Non-union', shooting_days = 15, cast_size = 5, genre = 'Drama', format = 'Feature Film', language } = req.body as {
    description?: string; country?: string; union?: string;
    shooting_days?: number; cast_size?: number; genre?: string; format?: string; language?: string;
  };

  if (!description || description.trim().length < 30) {
    return res.status(400).json({ error: 'Please describe your project (at least 30 characters).' });
  }

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write all text fields (assumptions, category names, notes) in ${language}. Do not use English.`
    : '';

  try {
    if (DEBUG_AI) console.log('🔍 Tools/budget: generating top-sheet');

    const raw = await aiComplete(
      BUDGET_TOPSHEET_SYSTEM + langInstruction,
      budgetUserPrompt({ description, country, union, shooting_days, cast_size, genre, format }),
      1500, 0.3
    );

    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let estimate: Record<string, unknown>;
    try {
      estimate = JSON.parse(jsonStr);
    } catch {
      return res.status(500).json({ error: 'Failed to generate estimate. Please try again.' });
    }

    if (DEBUG_AI) console.log('✅ Tools/budget: top-sheet done');
    res.json({ estimate });
  } catch (error) {
    console.error('❌ Tools/budget/estimate error:', error);
    res.status(500).json({ error: 'Failed to generate budget estimate. Please try again.' });
  }
});

/** POST /api/tools/budget/breakdown — full breakdown, auth + credits */
router.post('/budget/breakdown', requireAuth, extractUserId, authGenerateLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { description, country = 'USA', union = 'Non-union', shooting_days = 15, cast_size = 5, genre = 'Drama', format = 'Feature Film', language } = req.body as {
    description?: string; country?: string; union?: string;
    shooting_days?: number; cast_size?: number; genre?: string; format?: string; language?: string;
  };

  if (!description || description.trim().length < 30) {
    return res.status(400).json({ error: 'Please describe your project.' });
  }

  const langInstruction = language && language !== 'English'
    ? `\nIMPORTANT: Write all text fields (department names, item names, notes) in ${language}. Do not use English.`
    : '';

  const CREDITS_COST = 5;
  const { ok, balance, error } = await checkAndDeductCredits(
    userId, CREDITS_COST,
    `Budget tool: ${format} breakdown`,
    { tool: 'budget', format }
  );

  if (!ok) {
    return res.status(402).json({ error, error_type: 'insufficient_credits', credits_required: CREDITS_COST, credits_balance: balance });
  }

  try {
    if (DEBUG_AI) console.log(`🚀 Tools/budget: generating full breakdown for ${userId}`);

    const raw = await aiComplete(
      BUDGET_BREAKDOWN_SYSTEM + langInstruction,
      budgetUserPrompt({ description, country, union, shooting_days, cast_size, genre, format }),
      3000, 0.3
    );

    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(jsonStr);
    } catch {
      return res.status(500).json({ error: 'Failed to parse breakdown. Please try again.' });
    }

    const newBalance = await new PricingService(getSupabase()).getAICreditsBalance(userId);

    if (DEBUG_AI) console.log('✅ Tools/budget: breakdown done');
    res.json({ breakdown, credits_used: CREDITS_COST, credits_remaining: newBalance });
  } catch (error) {
    console.error('❌ Tools/budget/breakdown error:', error);
    res.status(500).json({ error: 'Failed to generate breakdown. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SESSION STORE — cross-origin bridge for tool → app handoff
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The landing site (plotwell.co) and the app (app.plotwell.co) run on different
 * origins, so localStorage is not shared. We use a short-lived in-memory store
 * keyed by a random token included in the signup redirect URL.
 *
 * TTL: 30 minutes. Max 5 000 entries (oldest pruned first).
 */

interface ToolSession {
  scriptText: string;         // Raw fountain / FDX content (at minimum Scene 1)
  scriptFormat: 'fountain' | 'fdx';
  panels: Array<{
    number: number;
    heading: string;
    summary: string;
    imageUrl: string;
    description: string;
  }>;
  // Optional full-generation context (scripts tool only)
  treatment?: string;
  genre?: string;
  tone?: string;
  format?: string;
  scenes?: Array<{ number: number; heading: string; summary: string }>;
  // Budget tool data
  budgetEstimate?: {
    currency: string;
    categories: Array<{ name: string; low: number; high: number; note?: string }>;
  };
  budgetBreakdown?: {
    currency: string;
    departments: Array<{
      name: string;
      line_items: Array<{ item: string; qty: number; unit: string; rate_low: number; rate_high: number; note?: string }>;
    }>;
  };
  createdAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 5000;
const toolSessions = new Map<string, ToolSession>();

/** Creates a session entry and returns the token. */
function createToolSession(
  scriptText: string,
  scriptFormat: 'fountain' | 'fdx',
  panels: ToolSession['panels'],
): string {
  if (toolSessions.size >= SESSION_MAX) {
    const oldest = toolSessions.keys().next().value;
    if (oldest) toolSessions.delete(oldest);
  }
  const token = uuidv4();
  toolSessions.set(token, {
    scriptText: scriptText.slice(0, 100_000),
    scriptFormat,
    panels: panels.slice(0, 20),
    createdAt: Date.now(),
  });
  return token;
}

// Prune expired entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of toolSessions.entries()) {
    if (v.createdAt < cutoff) toolSessions.delete(k);
  }
}, 10 * 60 * 1000);

/**
 * POST /api/tools/save-session
 * Called by the landing tool BEFORE redirecting to the app.
 * No auth required — just rate limited per IP.
 * Returns a short-lived token to include in the redirect URL.
 */
router.post('/save-session', freeListLimiter, express.json({ limit: '5mb' }), (req: Request, res: Response) => {
  const { scriptText, scriptFormat, panels, treatment, genre, tone, format, scenes, budgetEstimate, budgetBreakdown } = req.body as Partial<ToolSession>;

  const hasPanels = Array.isArray(panels) && panels.length > 0;
  const hasScript = typeof scriptText === 'string' && scriptText.trim().length > 0;
  const hasBudget = !!(budgetEstimate?.categories?.length || budgetBreakdown?.departments?.length);
  if (!hasPanels && !hasScript && !hasBudget) {
    return res.status(400).json({ error: 'Missing session data' });
  }

  // Evict oldest entry if at capacity
  if (toolSessions.size >= SESSION_MAX) {
    const oldest = toolSessions.keys().next().value;
    if (oldest) toolSessions.delete(oldest);
  }

  const token = uuidv4();
  toolSessions.set(token, {
    scriptText: (scriptText ?? '').slice(0, 100_000),
    scriptFormat: scriptFormat === 'fdx' ? 'fdx' : 'fountain',
    panels: (panels ?? []).slice(0, 20),
    // Full-generation context (optional, scripts tool only)
    treatment: treatment ? String(treatment).slice(0, 8000) : undefined,
    genre: genre ? String(genre).slice(0, 100) : undefined,
    tone: tone ? String(tone).slice(0, 100) : undefined,
    format: format ? String(format).slice(0, 100) : undefined,
    scenes: Array.isArray(scenes) ? scenes.slice(0, 60) : undefined,
    // Budget tool data
    budgetEstimate: budgetEstimate ?? undefined,
    budgetBreakdown: budgetBreakdown ?? undefined,
    createdAt: Date.now(),
  });

  res.json({ token });
});

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARD ENDPOINT — create project after auth
// ═══════════════════════════════════════════════════════════════════════════

interface ImportPanel {
  number: number;
  heading: string;
  summary: string;
  imageUrl: string;
  description: string;
}

async function importPanels(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  panels: ImportPanel[],
): Promise<number> {
  let imported = 0;
  for (const panel of panels.slice(0, 20)) {
    try {
      let storedImagePath: string | null = null;

      if (panel.imageUrl?.startsWith('data:image/')) {
        // Base64 fallback: upload directly from memory (happens if temp upload failed earlier)
        try {
          const commaIdx = panel.imageUrl.indexOf(',');
          if (commaIdx !== -1) {
            const buffer = Buffer.from(panel.imageUrl.slice(commaIdx + 1), 'base64');
            const fileName = `ai-generated/${projectId}/tool-import/${uuidv4()}.png`;
            const { error: uploadError } = await supabase.storage
              .from(BUCKETS.STORYBOARD_IMAGES)
              .upload(fileName, buffer, { contentType: 'image/png', upsert: false });
            if (!uploadError) storedImagePath = fileName;
          }
        } catch (imgErr) {
          if (DEBUG_AI) console.log(`⚠️ importPanels: base64 upload failed for panel ${panel.number}:`, imgErr);
        }
      } else if (panel.imageUrl?.startsWith('http')) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          const imgRes = await fetch(panel.imageUrl, { signal: controller.signal });
          clearTimeout(timeout);

          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            const fileName = `ai-generated/${projectId}/tool-import/${uuidv4()}.png`;
            const { error: uploadError } = await supabase.storage
              .from(BUCKETS.STORYBOARD_IMAGES)
              .upload(fileName, buffer, { contentType: 'image/png', upsert: false });
            if (!uploadError) storedImagePath = fileName;
          }
        } catch (imgErr) {
          if (DEBUG_AI) console.log(`⚠️ importPanels: image fetch failed for panel ${panel.number}:`, imgErr);
        }
      }

      const sceneId = crypto.createHash('sha256')
        .update(panel.heading.trim().toLowerCase())
        .digest('hex');

      const { error: panelError } = await supabase
        .from('storyboard_panels')
        .insert([{
          project_id: projectId,
          scene_id: sceneId,
          scene_number: panel.number,
          scene_heading: panel.heading,
          panel_number: 1,
          scene_description: panel.description || panel.summary,
          shot_type: 'medium-shot',
          camera_movement: 'static',
          lighting: 'natural',
          mood: 'dramatic',
          image_url: storedImagePath,
        }]);

      if (!panelError) imported++;
    } catch (err) {
      console.error(`⚠️ importPanels: failed panel ${panel.number}:`, err);
    }
  }
  return imported;
}

/**
 * Imports budget data from the tool session into production_budgets.
 * Prefers the detailed breakdown (line items) over the top-sheet (categories).
 * Amounts in the tool are plain numbers (e.g. 50000); DB stores cents → multiply by 100.
 */
async function importBudget(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
  session: ToolSession,
): Promise<number> {
  const rows: Array<{
    project_id: string; user_id: string;
    category_name: string; item_name: string;
    quantity: number; rate: number; unit: string; total: number;
    notes: string | null; is_estimated: boolean;
  }> = [];

  if (session.budgetBreakdown?.departments?.length) {
    for (const dept of session.budgetBreakdown.departments) {
      for (const li of dept.line_items) {
        const avgRate = Math.round(((li.rate_low + li.rate_high) / 2) * 100);
        rows.push({
          project_id: projectId, user_id: userId,
          category_name: dept.name, item_name: li.item,
          quantity: li.qty, rate: avgRate, unit: li.unit,
          total: Math.round(li.qty * avgRate),
          notes: li.note || null, is_estimated: true,
        });
      }
    }
  } else if (session.budgetEstimate?.categories?.length) {
    for (const cat of session.budgetEstimate.categories) {
      const avg = Math.round(((cat.low + cat.high) / 2) * 100);
      rows.push({
        project_id: projectId, user_id: userId,
        category_name: cat.name, item_name: cat.name,
        quantity: 1, rate: avg, unit: 'flat',
        total: avg,
        notes: cat.note || null, is_estimated: true,
      });
    }
  }

  if (!rows.length) return 0;

  const { error } = await supabase.from('production_budgets').insert(rows);
  if (error) {
    console.error('⚠️ importBudget: insert failed:', error.message);
    return 0;
  }
  return rows.length;
}

/**
 * POST /api/tools/onboard
 * Called after the user authenticates in a mini-tool.
 *
 * 1. Idempotently initialises user_subscriptions + user_quotas (free plan, 10 starter credits for new users)
 * 2. Creates a project and returns its ID so the frontend can redirect to the app
 * 3. If sessionToken provided, retrieves tool session data:
 *    - Imports storyboard panels (downloads images, uploads to storage)
 *    - Imports budget items into production_budgets
 *    - Returns scriptText + scriptFormat so the app can parse and import the script
 */
router.post('/onboard', requireAuth, extractUserId, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const {
    source = 'tool',
    projectName,
    sessionToken,
  } = req.body as { source?: string; projectName?: string; sessionToken?: string };

  // Retrieve and consume session (cross-origin handoff)
  const session = sessionToken ? toolSessions.get(sessionToken) ?? null : null;
  if (sessionToken && session) toolSessions.delete(sessionToken);

  const supabase = getSupabase();

  try {
    // ── 1. Init subscription (idempotent) ────────────────────────────────
    await supabase
      .from('user_subscriptions')
      .upsert({ user_id: userId, plan_id: 'free', status: 'active' }, { onConflict: 'user_id' });

    // Give new users 10 starter AI credits (only if no row exists yet)
    const { data: existingQuota } = await supabase
      .from('user_quotas')
      .select('user_id, ai_credits_balance')
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingQuota) {
      await supabase
        .from('user_quotas')
        .insert({ user_id: userId, ai_generations_used: 0, ai_credits_balance: 10, storage_used_gb: 0 });
    }

    // ── 2. Derive a project name ─────────────────────────────────────────
    const sourceLabels: Record<string, string> = {
      'scripts-tool': 'My Script',
      'storyboard-tool': 'My Storyboard',
      'budget-tool': 'My Film Budget',
    };
    const name = projectName?.trim() || sourceLabels[source] || 'My Project';

    // ── 3. Check project limit before creating ───────────────────────────
    const pricingService = new PricingService(supabase);
    const canCreate = await pricingService.canPerformAction(userId, 'create_project');
    if (!canCreate.allowed) {
      return res.status(403).json({
        error: 'Project limit exceeded',
        message: canCreate.reason,
        type: 'LIMIT_EXCEEDED',
        action_required: 'upgrade',
      });
    }

    // ── 4. Create project ────────────────────────────────────────────────
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert([{
        name,
        user_id: userId,
        project_type: 'film',
        status: 'active',
        content_language: 'en',
        video_format: '16:9',
        settings: {},
      }])
      .select('id')
      .single();

    if (projectError) {
      console.error('❌ Tools/onboard: failed to create project:', projectError);
      return res.status(500).json({ error: 'Failed to create project' });
    }

    // ── 4. Create an initial empty script for the project ────────────────
    const defaultContent = { type: 'doc', content: [{ type: 'action' }] };
    const { data: scriptData, error: scriptError } = await supabase
      .from('scripts')
      .insert([{
        title: name,
        project_id: project.id,
        content: defaultContent,
        is_ai_generated: true,
      }])
      .select('id')
      .single();

    if (scriptError) {
      console.error('⚠️ Tools/onboard: failed to create initial script:', scriptError);
    }

    // ── 5. Import storyboard panels from session (if any) ────────────────
    let panelsImported = 0;
    if (session?.panels?.length) {
      panelsImported = await importPanels(supabase, project.id as string, session.panels);
      if (DEBUG_AI) console.log(`✅ Tools/onboard: ${panelsImported} panels imported`);
    }

    // ── 5b. Import budget items from session (if any) ─────────────────────
    if (session && (session.budgetBreakdown || session.budgetEstimate)) {
      const budgetRowsImported = await importBudget(supabase, project.id as string, userId, session);
      if (DEBUG_AI) console.log(`✅ Tools/onboard: ${budgetRowsImported} budget rows imported`);
    }

    // ── 6. Use the preview script already generated (first 3 scenes) ──────
    // The free preview generates 3 scenes; import exactly that, no more.
    const finalScriptText = session?.scriptText ?? null;

    if (DEBUG_AI) console.log(`✅ Tools/onboard: project ${project.id} created for user ${userId} (source: ${source}, panels: ${panelsImported})`);

    // Return scriptText/scriptFormat so the app can parse and save it via PUT /api/scripts/:id
    res.json({
      projectId: project.id,
      scriptId: scriptData?.id ?? null,
      scriptText: finalScriptText,
      scriptFormat: session?.scriptFormat ?? null,
    });
  } catch (error) {
    console.error('❌ Tools/onboard error:', error);
    res.status(500).json({ error: 'Failed to onboard user' });
  }
});

export default router;
