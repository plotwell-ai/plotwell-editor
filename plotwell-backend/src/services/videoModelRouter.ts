/**
 * Video Model Router Service
 *
 * Thin wrapper around the OpenRouter video generation API for turning a
 * storyboard panel's still image into a short clip (image-to-video).
 *
 * Default model: x-ai/grok-imagine-video
 *   - text-, image-, and reference-conditioned video
 *   - 1-15s, 24fps, 480p/720p, vertical 9:16 supported
 *
 * The API is asynchronous:
 *   1. POST /api/v1/videos            → returns a job { id, status }
 *   2. GET  /api/v1/videos/{id}       → poll until status === 'completed'
 *   3. GET  unsigned_urls[0]          → download the rendered mp4 (auth required)
 *
 * To switch the default model, change DEFAULT_VIDEO_MODEL below. The supported
 * durations/resolutions differ per model — see /api/v1/videos/models.
 */

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const DEFAULT_VIDEO_MODEL = 'x-ai/grok-imagine-video';

// Grok Imagine supports 1-15 second clips.
export const MIN_VIDEO_SECONDS = 1;
export const MAX_VIDEO_SECONDS = 15;

export type VideoAspectRatio = '9:16' | '16:9' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3';
export type VideoResolution = '480p' | '720p' | '1080p';
export type VideoJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface VideoGenerationInput {
  prompt: string;
  /** Publicly fetchable URL (e.g. a Supabase signed URL) used as the first frame. */
  firstFrameImageUrl?: string;
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: number;
  resolution?: VideoResolution;
  model?: string;
  seed?: number;
}

export interface VideoJob {
  id: string;
  status: VideoJobStatus;
  pollingUrl?: string;
  /** Provider-side cost in USD, present once completed. */
  cost?: number;
  /** Download URLs for the rendered clip, present once completed. */
  videoUrls?: string[];
  error?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173',
    'X-Title': 'plotwell',
  };
}

function clampDuration(seconds?: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, n));
}

function parseJob(data: any): VideoJob {
  return {
    id: data.id || data.generation_id,
    status: (data.status as VideoJobStatus) || 'pending',
    pollingUrl: data.polling_url,
    cost: data.usage?.cost,
    videoUrls: Array.isArray(data.unsigned_urls) ? data.unsigned_urls : undefined,
    error: data.error,
  };
}

/**
 * Submit an image-to-video job. Returns immediately with a job id to poll.
 */
export async function submitVideoJob(input: VideoGenerationInput): Promise<VideoJob> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const model = input.model || DEFAULT_VIDEO_MODEL;
  const body: Record<string, any> = {
    model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio || '9:16',
    duration: clampDuration(input.durationSeconds),
    resolution: input.resolution || '720p',
  };

  if (input.firstFrameImageUrl) {
    body.frame_images = [
      {
        type: 'image_url',
        image_url: { url: input.firstFrameImageUrl },
        frame_type: 'first_frame',
      },
    ];
  }

  if (input.seed !== undefined) body.seed = input.seed;

  if (DEBUG_AI) {
    console.log('🎥 Submitting video job:', { model, aspect_ratio: body.aspect_ratio, duration: body.duration, resolution: body.resolution, hasFrame: !!input.firstFrameImageUrl });
  }

  const response = await fetch(`${OPENROUTER_BASE}/videos`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`❌ OpenRouter video non-JSON response (${response.status}):`, raw.substring(0, 300));
    throw new Error(`${response.status} ${raw.substring(0, 200)}`);
  }

  if (!response.ok || data.error) {
    const detail = data.error?.message || JSON.stringify(data.error || data).substring(0, 300);
    const code = data.error?.code || response.status;
    console.error(`❌ OpenRouter video ${code}:`, detail);
    throw new Error(`${code} ${detail}`);
  }

  const job = parseJob(data);
  if (!job.id) {
    console.error('❌ OpenRouter video: no job id in response:', JSON.stringify(data).substring(0, 500));
    throw new Error('No job id returned from video API');
  }

  if (DEBUG_AI) console.log(`🎥 Video job submitted: ${job.id} (${job.status})`);
  return job;
}

/**
 * Poll a video job by id.
 */
export async function getVideoJob(jobId: string): Promise<VideoJob> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const response = await fetch(`${OPENROUTER_BASE}/videos/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  });

  const raw = await response.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`❌ OpenRouter video poll non-JSON (${response.status}):`, raw.substring(0, 300));
    throw new Error(`${response.status} ${raw.substring(0, 200)}`);
  }

  if (!response.ok || data.error) {
    const detail = data.error?.message || JSON.stringify(data.error || data).substring(0, 300);
    const code = data.error?.code || response.status;
    console.error(`❌ OpenRouter video poll ${code}:`, detail);
    throw new Error(`${code} ${detail}`);
  }

  if (DEBUG_AI) console.log('🎥 Raw video poll response:', JSON.stringify(data).substring(0, 600));
  return parseJob(data);
}

/**
 * Download the rendered clip as a buffer. The unsigned content URL is on the
 * OpenRouter API and requires the API key.
 */
export async function downloadVideo(videoUrl: string): Promise<Buffer> {
  const isOpenRouterContent = videoUrl.startsWith(OPENROUTER_BASE);
  const response = await fetch(videoUrl, {
    headers: isOpenRouterContent ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {},
  });

  if (!response.ok) {
    throw new Error(`Failed to download video (${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}
