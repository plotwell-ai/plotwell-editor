const REPLICATE_API_URL = "/replicate-api/v1/predictions";
const GPT5_MINI_API_URL = "/replicate-api/v1/models/openai/gpt-5-mini/predictions";

function getApiToken(): string {
  const token = import.meta.env.VITE_REPLICATE_API_TOKEN;
  if (!token) throw new Error("VITE_REPLICATE_API_TOKEN not set in .env.local");
  return token;
}

export interface GenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  model?: "gpt-oss-120b" | "gpt-5-mini";
}

interface ReplicateResponse {
  output: string | string[];
  status: string;
}

function extractOutput(data: ReplicateResponse): string {
  if (!data.output) return "";
  if (Array.isArray(data.output)) return data.output.join("").trim();
  if (typeof data.output === "string") return data.output.trim();
  return "";
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, init);
    if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === retries) {
      return response;
    }
    const delay = 1000 * Math.pow(2, attempt);
    console.warn(`Retry ${attempt + 1}/${retries} in ${delay}ms (status ${response.status})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("Retry logic error");
}

export async function generate(
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  const {
    system,
    maxTokens = 4096,
    temperature = 0.7,
    model = "gpt-oss-120b",
  } = options;

  const token = getApiToken();

  if (model === "gpt-5-mini") {
    return generateGPT5Mini(prompt, { system, maxTokens });
  }

  // GPT-OSS-120B via Replicate
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

  const response = await fetchWithRetry(REPLICATE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: "openai/gpt-oss-120b",
      input: {
        prompt: fullPrompt,
        max_tokens: maxTokens,
        temperature,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return extractOutput(data);
}

async function generateGPT5Mini(
  prompt: string,
  options: { system?: string; maxTokens?: number }
): Promise<string> {
  const { system, maxTokens } = options;
  const token = getApiToken();

  const input: Record<string, unknown> = {
    system_prompt: system || "",
    prompt,
    reasoning_effort: "medium",
    verbosity: "high",
    image_input: [],
  };

  if (maxTokens) {
    input.max_completion_tokens = maxTokens;
  }

  const response = await fetchWithRetry(GPT5_MINI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate GPT-5-mini error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return extractOutput(data);
}

/**
 * Streaming via polling (Replicate doesn't support true SSE for these models).
 * Calls generate() internally and yields the full result in one chunk.
 * Kept as async generator so consumers don't need to change their code.
 */
export async function* stream(
  prompt: string,
  options: GenerateOptions = {}
): AsyncGenerator<string> {
  const result = await generate(prompt, options);
  // Simulate streaming by yielding in chunks for better UX
  const chunkSize = 20;
  for (let i = 0; i < result.length; i += chunkSize) {
    yield result.slice(i, i + chunkSize);
    // Small delay for visual streaming effect
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------------------------------------------ */
/*  Video generation (async polling - videos take 30-180s)             */
/* ------------------------------------------------------------------ */

export type VideoModel = "kling" | "hailuo" | "luma" | "wan";

export interface VideoOptions {
  duration?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  model?: VideoModel;
}

export interface VideoJob {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string;
  error?: string;
}

const VIDEO_MODELS: Record<VideoModel, { url: string; buildInput: (prompt: string, opts: VideoOptions) => Record<string, unknown> }> = {
  kling: {
    url: "/replicate-api/v1/models/kwaivgi/kling-v3-video/predictions",
    buildInput: (prompt, { duration = 5, aspectRatio = "9:16" }) => ({
      prompt,
      duration,
      aspect_ratio: aspectRatio,
      mode: "standard",
      negative_prompt: "blurry, low quality, text, watermark, letters",
    }),
  },
  hailuo: {
    url: "/replicate-api/v1/models/minimax/hailuo-2.3/predictions",
    buildInput: (prompt, { aspectRatio = "9:16" }) => ({
      prompt,
      aspect_ratio: aspectRatio,
    }),
  },
  luma: {
    url: "/replicate-api/v1/models/luma/ray-flash-2-720p/predictions",
    buildInput: (prompt, { duration = 5, aspectRatio = "9:16" }) => ({
      prompt,
      duration: Math.min(duration, 9),
      aspect_ratio: aspectRatio,
    }),
  },
  wan: {
    url: "/replicate-api/v1/models/wan-video/wan-2.5-t2v-fast/predictions",
    buildInput: (prompt, { aspectRatio = "9:16" }) => ({
      prompt,
      max_frames: 81,
      aspect_ratio: aspectRatio,
    }),
  },
};

export const VIDEO_MODEL_INFO: Record<VideoModel, { label: string; cost: number; costLabel: string; quality: string }> = {
  wan: { label: "Wan 2.5 Fast", cost: 0.34, costLabel: "~$0.34/clip", quality: "Fair" },
  luma: { label: "Luma Flash 2", cost: 0.30, costLabel: "~$0.30/clip", quality: "Good" },
  hailuo: { label: "Hailuo 2.3", cost: 0.25, costLabel: "~$0.25/clip", quality: "High" },
  kling: { label: "Kling V3", cost: 0.50, costLabel: "~$0.50/clip", quality: "Excellent" },
};

/* ------------------------------------------------------------------ */
/*  Cost estimation                                                    */
/* ------------------------------------------------------------------ */

/** Cost per 1K tokens for text models (approximate) */
const TEXT_MODEL_COSTS = {
  "gpt-oss-120b": { input: 0.0, output: 0.0 }, // free on Replicate currently
  "gpt-5-mini": { input: 0.0, output: 0.0 },
};

/** Cost for image generation */
const IMAGE_COSTS = {
  "flux-2-dev": 0.03, // ~$0.03 per image
};

/** Cost for voiceover TTS */
const TTS_COST_PER_CHAR = 0.000015; // ~$0.015 per 1K chars

export interface CostEstimate {
  textGenerations: number;
  imageGenerations: number;
  videoClips: number;
  voiceovers: number;
  videoModel?: VideoModel;
  voiceoverChars?: number;
  breakdown: { item: string; cost: number }[];
  total: number;
}

/**
 * Estimate costs for a batch of AI operations.
 * Text generation on Replicate free models = $0.
 * Main costs: video clips, images, voiceover.
 */
export function estimateCosts(params: {
  textGenerations?: number;
  imageGenerations?: number;
  videoClips?: number;
  videoModel?: VideoModel;
  voiceovers?: number;
  voiceoverChars?: number;
}): CostEstimate {
  const {
    textGenerations = 0,
    imageGenerations = 0,
    videoClips = 0,
    videoModel = "hailuo",
    voiceovers = 0,
    voiceoverChars = 500,
  } = params;

  const breakdown: { item: string; cost: number }[] = [];

  if (textGenerations > 0) {
    breakdown.push({ item: `${textGenerations}x text generation`, cost: 0 });
  }

  const imageCost = imageGenerations * IMAGE_COSTS["flux-2-dev"];
  if (imageGenerations > 0) {
    breakdown.push({ item: `${imageGenerations}x cover image`, cost: imageCost });
  }

  const videoCost = videoClips * VIDEO_MODEL_INFO[videoModel].cost;
  if (videoClips > 0) {
    breakdown.push({ item: `${videoClips}x video clip (${VIDEO_MODEL_INFO[videoModel].label})`, cost: videoCost });
  }

  const ttsCost = voiceovers * voiceoverChars * TTS_COST_PER_CHAR;
  if (voiceovers > 0) {
    breakdown.push({ item: `${voiceovers}x voiceover`, cost: ttsCost });
  }

  const total = imageCost + videoCost + ttsCost;

  return {
    textGenerations,
    imageGenerations,
    videoClips,
    voiceovers,
    videoModel,
    voiceoverChars,
    breakdown,
    total,
  };
}

export function formatCost(amount: number): string {
  if (amount === 0) return "Free";
  if (amount < 0.01) return "<$0.01";
  return `~$${amount.toFixed(2)}`;
}

export async function startVideoGeneration(
  prompt: string,
  options: VideoOptions = {}
): Promise<VideoJob> {
  const { model = "hailuo" } = options;
  const token = getApiToken();
  const config = VIDEO_MODELS[model];

  // Retry loop for rate limits (429)
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({ input: config.buildInput(prompt, options) }),
    });

    if (response.status === 429) {
      let retryAfter = 15;
      try {
        const body = await response.json();
        retryAfter = Math.ceil(body.retry_after || body.detail?.match(/~(\d+)s/)?.[1] || 15);
      } catch { /* use default */ }
      console.warn(`Rate limited, waiting ${retryAfter}s before retry ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Video API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    let output = data.output;
    if (output) {
      if (Array.isArray(output)) output = output[0];
      if (typeof output === "object" && output?.href) output = output.href;
    }

    return {
      id: data.id,
      status: data.status,
      output: typeof output === "string" ? output : undefined,
    };
  }

  throw new Error("Rate limited after 3 retries");
}

export async function pollVideoJob(job: VideoJob): Promise<VideoJob> {
  const token = getApiToken();
  const response = await fetch(`/replicate-api/v1/predictions/${job.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Poll error: ${response.status}`);
  }

  const data = await response.json();
  let output = data.output;
  if (Array.isArray(output)) output = output[0];
  if (typeof output === "object" && output?.href) output = output.href;

  return {
    id: data.id,
    status: data.status,
    output: typeof output === "string" ? output : undefined,
    error: data.error,
  };
}

/* ------------------------------------------------------------------ */
/*  TTS voiceover (sync - completes in seconds)                        */
/* ------------------------------------------------------------------ */

export interface TTSOptions {
  voiceId?: string;
  speed?: number;
  emotion?: "happy" | "calm" | "sad" | "angry" | "fearful" | "surprised";
}

const TTS_URL = "/replicate-api/v1/models/minimax/speech-2.8-hd/predictions";

export async function generateVoiceover(
  text: string,
  options: TTSOptions = {}
): Promise<string> {
  const { voiceId = "Casual_Guy", speed = 1.0, emotion } = options;
  const token = getApiToken();

  const input: Record<string, unknown> = {
    text,
    voice_id: voiceId,
    speed,
    format: "mp3",
    sample_rate: 24000,
  };
  if (emotion) input.emotion = emotion;

  const response = await fetchWithRetry(TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TTS API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  let output = data.output;
  if (Array.isArray(output)) output = output[0];
  if (typeof output === "object" && output?.href) output = output.href;
  return output || "";
}
