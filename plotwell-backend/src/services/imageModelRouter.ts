/**
 * Image Model Router Service
 *
 * Unified interface for image generation via two providers:
 *
 * OpenRouter (primary/default):
 *   - flux.2-pro         (default)
 *   - flux.2-klein-4b    (fallback)
 *   - gemini-2.5-flash-image
 *   - riverflow-v2-standard-preview
 *
 * Replicate (optional only when a Replicate preferred_model is selected):
 *   - flux-2-dev
 *   - seedream-4
 *   - flux-1.1-pro
 *   - imagen-4-fast
 *
 * To switch default provider, change DEFAULT_MODEL / DEFAULT_PROVIDER below.
 */

import Replicate from "replicate";
import { OpenAI } from "openai";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// ─── Provider & Model Config ────────────────────────────────────────────────

export type ImageProvider = 'replicate' | 'openrouter';

// Change these two lines to switch the global default
const DEFAULT_MODEL: ImageModelId = 'flux.2-pro';
const DEFAULT_PROVIDER: ImageProvider = 'openrouter';
const DEFAULT_FALLBACK: ImageModelId = 'flux.2-klein-4b';

export type ReplicateImageModelId = 'seedream-4' | 'flux-1.1-pro' | 'flux-2-dev' | 'imagen-4-fast';
export type OpenRouterImageModelId = 'flux.2-klein-4b' | 'flux.2-pro' | 'gemini-2.5-flash-image' | 'riverflow-v2-standard-preview';
export type ImageModelId = ReplicateImageModelId | OpenRouterImageModelId;

interface ModelConfig {
  provider: ImageProvider;
  modelId: string;
  name: string;
}

const MODEL_CONFIGS: Record<ImageModelId, ModelConfig> = {
  // OpenRouter models
  'flux.2-klein-4b':              { provider: 'openrouter', modelId: 'black-forest-labs/flux.2-klein-4b',            name: 'FLUX 2 Klein 4B' },
  'flux.2-pro':                   { provider: 'openrouter', modelId: 'black-forest-labs/flux.2-pro',                 name: 'FLUX 2 Pro' },
  'gemini-2.5-flash-image':       { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-image',               name: 'Gemini 2.5 Flash Image' },
  'riverflow-v2-standard-preview':{ provider: 'openrouter', modelId: 'sourceful/riverflow-v2-standard-preview',      name: 'Riverflow V2' },
  // Replicate models
  'flux-2-dev':                   { provider: 'replicate',  modelId: 'black-forest-labs/flux-2-dev',                 name: 'FLUX 2 Dev' },
  'seedream-4':                   { provider: 'replicate',  modelId: 'bytedance/seedream-4',                         name: 'Seedream 4' },
  'flux-1.1-pro':                 { provider: 'replicate',  modelId: 'black-forest-labs/flux-1.1-pro',               name: 'FLUX 1.1 Pro' },
  'imagen-4-fast':                { provider: 'replicate',  modelId: 'google/imagen-4-fast',                         name: 'Imagen 4 Fast' },
};

// ─── Input / Output Interfaces ──────────────────────────────────────────────

/** Per-reference role so the model treats a face photo and a set photo differently. */
export type ReferenceRole = 'character' | 'location' | 'continuity';

export interface ImageGenerationInput {
  prompt: string;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '4:5' | '5:4' | '3:2' | '2:3';
  outputFormat?: 'png' | 'jpg' | 'webp';
  width?: number;
  height?: number;
  referenceImages?: string[];
  /** Parallel to referenceImages: what each image represents. Defaults to all 'character'. */
  referenceRoles?: ReferenceRole[];
  referenceStrength?: number; // 0-1
  fidelity?: StoryboardFidelity;
}

export interface ImageGenerationResult {
  imageUrl: string;
  model: ImageModelId;
  provider: ImageProvider;
  generationTimeMs?: number;
  isBase64?: boolean;
}

// ─── Router Class ───────────────────────────────────────────────────────────

export class ImageModelRouter {
  private replicate: Replicate;
  private openrouter: OpenAI;
  private preferredModel: ImageModelId;
  private fallbackEnabled: boolean;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(options?: {
    preferredModel?: ImageModelId;
    preferredProvider?: ImageProvider;
    fallbackEnabled?: boolean;
    maxRetries?: number;
    retryDelayMs?: number;
  }) {
    this.replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    this.openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.FRONTEND_URL?.split(',')[0] || "http://localhost:5173",
        "X-Title": "plotwell"
      }
    });
    this.preferredModel = options?.preferredModel || DEFAULT_MODEL;
    this.fallbackEnabled = options?.fallbackEnabled ?? true;
    this.maxRetries = options?.maxRetries ?? 2;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const modelOrder = this.getModelOrder();
    let lastError: Error | null = null;
    let allModerated = true;

    for (const modelId of modelOrder) {
      const config = MODEL_CONFIGS[modelId];

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
            if (DEBUG_AI) console.log(`🔄 Retry ${attempt}/${this.maxRetries} for ${config.name} after ${delay}ms...`);
            await this.sleep(delay);
          }

          const startTime = Date.now();
          const result = await this.generateWithModel(modelId, input);
          const generationTimeMs = Date.now() - startTime;

          if (DEBUG_AI) console.log(`✅ Image generated with ${config.name} (${config.provider}) in ${generationTimeMs}ms${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);

          return {
            imageUrl: result.imageUrl,
            model: modelId,
            provider: config.provider,
            generationTimeMs,
            isBase64: result.isBase64,
          };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          lastError = err;
          if (!this.isModerationError(err)) allModerated = false;

          const exhausted = attempt >= this.maxRetries;
          const retryable = this.isRetryableError(err);

          if (exhausted || !retryable) {
            console.error(`❌ ${config.name} (${config.provider}) failed${exhausted ? ' (retries exhausted)' : ' (non-retryable)'}:`, err.message);
            if (!this.fallbackEnabled) throw lastError;
            break;
          }

          console.warn(`⚠️ ${config.name} attempt ${attempt + 1} failed (will retry):`, err.message);
        }
      }
    }

    if (allModerated && lastError) {
      const modErr = new Error('Your image was blocked by content moderation. Try rephrasing your description to avoid potentially sensitive content.');
      (modErr as any).code = 'CONTENT_MODERATED';
      throw modErr;
    }

    throw lastError || new Error('All image generation models failed');
  }

  setPreferredModel(modelId: ImageModelId): void {
    this.preferredModel = modelId;
  }

  static getAvailableModels(): { id: ImageModelId; name: string; provider: ImageProvider }[] {
    return Object.entries(MODEL_CONFIGS).map(([id, config]) => ({
      id: id as ImageModelId,
      name: config.name,
      provider: config.provider,
    }));
  }

  static getModelsByProvider(provider: ImageProvider): { id: ImageModelId; name: string }[] {
    return Object.entries(MODEL_CONFIGS)
      .filter(([_, config]) => config.provider === provider)
      .map(([id, config]) => ({ id: id as ImageModelId, name: config.name }));
  }

  // ─── Routing ────────────────────────────────────────────────────────────

  private getModelOrder(): ImageModelId[] {
    if (!this.fallbackEnabled) return [this.preferredModel];
    const order: ImageModelId[] = [this.preferredModel];
    if (this.preferredModel !== DEFAULT_FALLBACK) order.push(DEFAULT_FALLBACK);
    return order;
  }

  private async generateWithModel(modelId: ImageModelId, input: ImageGenerationInput): Promise<{ imageUrl: string; isBase64?: boolean }> {
    const config = MODEL_CONFIGS[modelId];
    if (config.provider === 'openrouter') {
      return this.generateWithOpenRouter(modelId as OpenRouterImageModelId, input);
    }
    return this.generateWithReplicate(modelId as ReplicateImageModelId, input);
  }

  // ─── OpenRouter Provider ────────────────────────────────────────────────

  private async generateWithOpenRouter(
    modelId: OpenRouterImageModelId,
    input: ImageGenerationInput
  ): Promise<{ imageUrl: string; isBase64: boolean }> {
    const config = MODEL_CONFIGS[modelId];
    if (DEBUG_AI) console.log(`🌐 OpenRouter Image API:`, { model: config.modelId });

    let prompt = input.prompt;

    // Prepend reference image guidance to prompt — FLUX 2 uses input_image fields
    // natively and relies on prompt text to control how closely to match references.
    // References carry a role: 'character' photos drive identity/face, 'location'
    // photos drive the set/environment. Applying one face-identity instruction to a
    // location photo (the old behaviour) made the model hallucinate faces into the
    // set and ignore the actual location — so we describe each group separately.
    if (input.referenceImages && input.referenceImages.length > 0) {
      const strength = input.referenceStrength !== undefined ? Math.round(input.referenceStrength * 100) : 70;
      const isSketch = input.fidelity === 'sketch';
      const styleOverride = isSketch
        ? ' STYLE OVERRIDE: The output MUST be a black and white pencil sketch drawing regardless of the reference image style. Do NOT produce a photorealistic or color image. Render the character as a pencil sketch illustration with hatching and linework.'
        : '';

      // Image order in contentParts mirrors referenceImages, so roles map 1:1.
      const roles: ReferenceRole[] = input.referenceRoles && input.referenceRoles.length === input.referenceImages.length
        ? input.referenceRoles
        : input.referenceImages.map(() => 'character');
      const charCount = roles.filter(r => r === 'character').length;
      const locCount = roles.filter(r => r === 'location').length;
      const continuityCount = roles.filter(r => r === 'continuity').length;

      // Tell the model which reference indices are people vs. set.
      const segments: string[] = [];
      const roleSummary = roles.map((role, index) => {
        const label = role === 'character'
          ? 'CHARACTER'
          : role === 'location'
            ? 'LOCATION/SET'
            : 'PREVIOUS SHOT/CONTINUITY';
        return `#${index + 1} ${label}`;
      });
      if (roleSummary.length > 0) {
        segments.push(`Reference image roles in order: ${roleSummary.join(', ')}.`);
      }

      // Character identity instruction (scales with strength).
      if (charCount > 0) {
        const subj = charCount > 1 ? 'the character reference images show the people' : 'the character reference image shows the person';
        if (strength >= 90) {
          segments.push(`CRITICAL CHARACTER IDENTITY: ${subj} who must appear. Reproduce their EXACT face, facial bone structure, eye shape, nose, mouth, jawline, skin tone, and hair color/texture so it is unmistakably the SAME person. IGNORE the clothing, outfit, and setting from the character reference; wardrobe and environment come ONLY from the scene description below.${styleOverride}`);
        } else if (strength >= 75) {
          segments.push(`CHARACTER IDENTITY: match the face of ${subj} closely — same facial structure, eye shape, skin tone, and hair type, clearly recognizable as the same individual. Do NOT copy clothing or setting from the character reference; dress them per the scene description.${styleOverride}`);
        } else if (strength >= 50) {
          segments.push(`Use the character reference(s) as a strong guide: keep facial type, ethnicity, age, hair color, and build, though exact features may vary.${styleOverride}`);
        } else if (strength >= 25) {
          segments.push(`Use the character reference(s) as loose inspiration: keep the general vibe, coloring, and approximate age/build.${styleOverride}`);
        } else {
          segments.push(`Use the character reference(s) only as a mood/style reference; appearance can differ.${styleOverride}`);
        }
      }

      // Location/set instruction — never treated as a person.
      if (locCount > 0) {
        const subj = locCount > 1 ? 'the location reference images show' : 'the location reference image shows';
        segments.push(`LOCATION/SET: ${subj} the environment for this shot. Reproduce the SAME place — its architecture, layout, furniture, materials, color palette, and overall geometry — as the background/set. Do NOT treat the location reference as a person and do NOT copy any people from it; place the described character(s) naturally within this environment.`);
      }

      if (continuityCount > 0) {
        const subj = continuityCount > 1 ? 'the continuity reference images show previous available shots' : 'the continuity reference image shows the previous available storyboard shot';
        segments.push(`CONTINUITY: ${subj} in this sequence. First follow the CURRENT shot description. If the current shot continues the same moment/place, preserve the same characters, wardrobe, props, location geometry, lighting logic, time of day, color treatment, and visual style from the previous shot. If the current shot clearly jumps to a new time, location, angle, subject, or story beat, do NOT force the old location geometry or staging; carry forward only the relevant continuity cues such as recurring character identity, wardrobe/props that should persist, and the overall visual style. Always create a NEW composition for the current shot. Do not copy the exact camera framing unless the current shot calls for it.`);
      }

      prompt = `${segments.join(' ')} ${prompt}`;
      if (DEBUG_AI) console.log(`🎭 OpenRouter: ${charCount} character + ${locCount} location + ${continuityCount} continuity reference(s) at ${strength}% identity, fidelity: ${input.fidelity || 'cinematic'}`);
    }

    // Build multimodal content
    const contentParts: any[] = [{ type: 'text', text: prompt }];
    if (input.referenceImages) {
      for (const imageUrl of input.referenceImages) {
        contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
      }
    }

    const isDualOutput = config.modelId.includes('gemini');
    const requestBody: any = {
      model: config.modelId,
      messages: [{ role: 'user', content: contentParts.length === 1 ? contentParts[0].text : contentParts }],
      modalities: isDualOutput ? ['image', 'text'] : ['image'],
    };

    if (input.aspectRatio) {
      requestBody.image_config = { aspect_ratio: input.aspectRatio };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173',
        'X-Title': 'plotwell',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const rawText = await response.text();
    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      // OpenRouter returned plain text (rate limit, gateway error, etc.)
      console.error(`❌ OpenRouter non-JSON response (${response.status}):`, rawText.substring(0, 300));
      throw new Error(`${response.status} ${rawText.substring(0, 200)}`);
    }

    if (!response.ok || data.error) {
      const rawMeta = data.error?.metadata?.raw;
      let moderationTag = '';
      if (rawMeta) {
        try {
          const raw = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
          if (raw.status === 'Request Moderated') {
            moderationTag = ` [MODERATED by ${data.error?.metadata?.provider_name || 'provider'}]`;
          }
        } catch {}
      }
      const detail = data.error?.message || JSON.stringify(data.error || data).substring(0, 300);
      const code = data.error?.code || response.status;
      console.error(`❌ OpenRouter ${code}${moderationTag}:`, detail);
      throw new Error(`${code} ${detail}${moderationTag}`);
    }

    if (DEBUG_AI) console.log('🌐 OpenRouter response keys:', Object.keys(data));

    return this.extractOpenRouterImage(data);
  }

  private extractOpenRouterImage(data: any): { imageUrl: string; isBase64: boolean } {
    const message = data.choices?.[0]?.message;
    if (message) {
      if (message.images?.length > 0) {
        const img = message.images[0];
        const url = typeof img === 'string' ? img : (img.image_url?.url || img.url);
        if (url) return { imageUrl: url, isBase64: url.startsWith('data:image/') };
      }
      if (typeof message.content === 'string' && message.content.startsWith('data:image/')) {
        return { imageUrl: message.content, isBase64: true };
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            return { imageUrl: part.image_url.url, isBase64: part.image_url.url.startsWith('data:image/') };
          }
        }
      }
    }
    if (data.data?.[0]) {
      const item = data.data[0];
      if (item.url) return { imageUrl: item.url, isBase64: false };
      if (item.b64_json) return { imageUrl: `data:image/png;base64,${item.b64_json}`, isBase64: true };
    }
    if (data.images?.[0]) {
      const img = data.images[0];
      const url = typeof img === 'string' ? img : (img.image_url?.url || img.url);
      if (url) return { imageUrl: url, isBase64: url.startsWith('data:image/') };
    }
    console.error('❌ OpenRouter: Could not extract image. Response:', JSON.stringify(data, null, 2).substring(0, 1000));
    throw new Error('Could not extract image from OpenRouter response');
  }

  // ─── Replicate Provider ─────────────────────────────────────────────────

  private async generateWithReplicate(
    modelId: ReplicateImageModelId,
    input: ImageGenerationInput
  ): Promise<{ imageUrl: string }> {
    const config = MODEL_CONFIGS[modelId];
    if (DEBUG_AI) console.log(`🔁 Replicate API:`, { model: config.modelId });

    const replicateInput: Record<string, any> = {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio || '16:9',
    };

    // Per-model options
    switch (modelId) {
      case 'flux-2-dev':
        replicateInput.go_fast = true;
        replicateInput.output_format = input.outputFormat || 'png';
        replicateInput.output_quality = 90;
        replicateInput.disable_safety_checker = false;
        // Supports up to 4 reference images
        if (input.referenceImages?.length) {
          replicateInput.input_images = input.referenceImages.slice(0, 4);
          if (input.referenceStrength !== undefined) replicateInput.image_prompt_strength = input.referenceStrength;
          if (DEBUG_AI) console.log(`🎭 FLUX 2 Dev: ${replicateInput.input_images.length} reference image(s)`);
        }
        break;

      case 'seedream-4':
        replicateInput.size = '2K';
        replicateInput.enhance_prompt = true;
        break;

      case 'flux-1.1-pro':
        replicateInput.output_format = input.outputFormat || 'png';
        replicateInput.output_quality = 90;
        replicateInput.safety_tolerance = 3;
        replicateInput.prompt_upsampling = false;
        // Supports single reference image (image-to-image)
        if (input.referenceImages?.length) {
          replicateInput.image = input.referenceImages[0];
          if (input.referenceStrength !== undefined) {
            replicateInput.prompt_strength = 1 - input.referenceStrength;
          }
          if (DEBUG_AI) console.log(`🎭 FLUX 1.1 Pro: using reference image`);
        }
        break;

      case 'imagen-4-fast':
        replicateInput.output_format = input.outputFormat || 'png';
        replicateInput.safety_filter_level = 'block_only_high';
        break;
    }

    const output = await this.replicate.run(
      config.modelId as `${string}/${string}`,
      { input: replicateInput }
    );

    return { imageUrl: this.extractReplicateUrl(output) };
  }

  private extractReplicateUrl(output: any): string {
    if (typeof output === 'string') return output;
    if (Array.isArray(output) && output.length > 0) return this.extractReplicateUrl(output[0]);
    if (output && typeof output === 'object') {
      if (typeof output.href === 'string') return output.href;
      const str = output.toString?.();
      if (str?.startsWith('http://') || str?.startsWith('https://')) return str;
      if (typeof output.url === 'function') {
        const r = output.url();
        if (typeof r?.href === 'string') return r.href;
        if (typeof r === 'string') return r;
      }
      if (typeof output.url === 'string') return output.url;
      if (typeof output.uri === 'string') return output.uri;
      if (output.output) return this.extractReplicateUrl(output.output);
    }
    throw new Error('Could not extract image URL from Replicate output');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isRetryableError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    const permanent = ['invalid prompt', 'content policy', 'safety filter', 'nsfw', 'blocked', 'moderated', 'unauthorized', 'invalid api key', 'authentication', 'quota exceeded', 'billing', 'payment required'];
    return !permanent.some(p => msg.includes(p));
  }

  private isModerationError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes('moderated') || msg.includes('content policy') || msg.includes('safety filter') || msg.includes('nsfw') || msg.includes('blocked');
  }
}

// ─── Singleton Factory ────────────────────────────────────────────────────

let routerInstance: ImageModelRouter | null = null;

export function getImageRouter(options?: {
  preferredModel?: ImageModelId;
  preferredProvider?: ImageProvider;
  fallbackEnabled?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
}): ImageModelRouter {
  if (!routerInstance || options) {
    routerInstance = new ImageModelRouter(options);
  }
  return routerInstance;
}

// ─── Sanitization (uses DeepSeek V4 Flash via OpenRouter) ────────────────────

/**
 * Sanitize user-provided text before it enters an image prompt.
 * Strips content that might trigger model moderation filters
 * while preserving visual/physical details.
 */
export async function sanitizeForImageGeneration(text: string): Promise<string> {
  if (!text?.trim()) return text;

  try {
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterApiKey) {
      if (DEBUG_AI) console.log('⚠️ No OPENROUTER_API_KEY, skipping sanitization');
      return text;
    }

    const deepseek = new OpenAI({
      apiKey: openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.FRONTEND_URL?.split(',')[0] || "http://localhost:5173",
        "X-Title": "plotwell",
      },
    });
    if (DEBUG_AI) console.log('🧹 Sanitizing input for image moderation compliance...');

    const completion = await deepseek.chat.completions.create({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: `You sanitize image generation prompts for FLUX and similar models with strict content moderation. The input may be a character description, location description, or a full image prompt.

RULES:
- ONLY remove or rephrase content that could trigger moderation: sexual content, explicit violence, nudity, graphic trauma, drug use, self-harm, medical procedures, weapons, blood, crime scenes, autopsy, examination rooms with bodies, morgue details
- FOR LOCATIONS: Rephrase medical/forensic/crime location names to neutral architectural equivalents (e.g. "examination room" → "clinical office", "morgue" → "cold storage room", "crime scene" → "empty room"). Keep the architectural and visual details (lighting, furniture, layout, materials, atmosphere)
- FOR CHARACTERS: Keep ALL visual/physical details: appearance, clothing, personality traits, emotions, profession, age, hair, accessories, body type, ethnicity
- Replace problematic narrative details with neutral alternatives
- If the text mentions multiple ages or life stages, pick the MOST RELEVANT single age
- CRITICAL: If an age or age range is mentioned, ALWAYS preserve it exactly as stated and place it prominently at the start of the output. Never round up or alter the age.
- AGE-AWARE REPHRASING: When a character is young (under 35) but has descriptors that imply physical aging (e.g. "tired eyes", "gaunt face", "shadows under eyes"), reframe these as emotional/expressive qualities rather than physical aging signs
- Remove story/narrative arc information (backstory, plot points, character development arcs, relationships to other characters) — keep ONLY visual details
- PRESERVE all image generation instructions (style, camera, composition, "no text", "no collage", etc.)
- Do NOT add new content, embellish, or restructure
- Output ONLY the cleaned text, nothing else
- If the text is already clean, return it unchanged`
        },
        { role: "user", content: text }
      ],
      max_tokens: 1024,
      temperature: 0.3,
    });

    const sanitized = completion.choices[0]?.message?.content?.trim();
    if (sanitized && sanitized.length > 5) {
      if (DEBUG_AI && sanitized !== text) console.log('🧹 Input sanitized for moderation compliance');
      return sanitized;
    }
    return text;
  } catch (error) {
    console.warn('⚠️ Sanitization failed, using original:', error instanceof Error ? error.message : error);
    return text;
  }
}

// ─── Storyboard Convenience Function ──────────────────────────────────────

import { buildStoryboardImagePrompt, type StoryboardFidelity, type StoryboardVisualStyle } from '../prompts';
export type { StoryboardFidelity, StoryboardVisualStyle };

export interface CharacterReference {
  imageUrl: string;
  name?: string;
  description?: string;
}

export async function generateStoryboardImage(
  sceneDescription: string,
  shotType?: string,
  cameraMovement?: string,
  options?: {
    preferredModel?: ImageModelId;
    preferredProvider?: ImageProvider;
    aspectRatio?: '16:9' | '9:16' | '4:3' | '1:1' | '4:5';
    fidelity?: StoryboardFidelity;
    characterReferences?: CharacterReference[];
    /** Location/set reference photos. Tagged 'location' so they steer the set, not a face. */
    locationReferences?: CharacterReference[];
    /** Immediate previous shot reference. Tagged 'continuity' so it steers sequence consistency. */
    continuityReferences?: CharacterReference[];
    lighting?: string;
    mood?: string;
    notes?: string;
    cameraDirection?: string;
    sceneHeading?: string;
    visualStyle?: StoryboardVisualStyle | string;
  }
): Promise<ImageGenerationResult> {
  const fidelity = options?.fidelity || 'cinematic';

  const prompt = buildStoryboardImagePrompt({
    sceneDescription,
    shotType,
    cameraMovement,
    cameraDirection: options?.cameraDirection,
    fidelity,
    lighting: options?.lighting,
    mood: options?.mood,
    notes: options?.notes,
    sceneHeading: options?.sceneHeading,
    aspectRatio: options?.aspectRatio,
    visualStyle: options?.visualStyle,
  });

  const preferredModel = options?.preferredModel || DEFAULT_MODEL;

  const router = getImageRouter({
    preferredModel,
    preferredProvider: options?.preferredProvider,
    fallbackEnabled: true,
    maxRetries: 2,
  });

  const generationInput: ImageGenerationInput = {
    prompt,
    aspectRatio: options?.aspectRatio || '16:9',
    outputFormat: 'png',
    fidelity,
  };

  // FLUX 2 accepts up to 4 reference images. Reserve slots for continuity and
  // location first, then use the remaining slots for character identity.
  const continuityRefs = (options?.continuityReferences || []).slice(0, 1);
  const locationRefs = (options?.locationReferences || []).slice(0, Math.max(0, 4 - continuityRefs.length));
  const charCap = Math.max(0, 4 - continuityRefs.length - locationRefs.length);
  const charRefs = (options?.characterReferences || []).slice(0, charCap);
  const combined = [...charRefs, ...locationRefs, ...continuityRefs].slice(0, 4);

  if (combined.length > 0) {
    generationInput.referenceImages = combined.map(ref => ref.imageUrl);
    generationInput.referenceRoles = [
      ...charRefs.map(() => 'character' as const),
      ...locationRefs.map(() => 'location' as const),
      ...continuityRefs.map(() => 'continuity' as const),
    ].slice(0, 4);
    // High identity strength keeps character faces accurate (cinematic-first fidelity).
    generationInput.referenceStrength = 0.95;
    if (DEBUG_AI) console.log(`🎭 Storyboard generation with ${charRefs.length} character + ${locationRefs.length} location + ${continuityRefs.length} continuity reference(s):`,
      combined.map(r => r.name || 'unnamed').join(', '));
  }

  return router.generate(generationInput);
}
