/**
 * AI Video Generation (MEGA beta)
 *
 * Turns a storyboard panel (a shot) into a short animated clip using the
 * OpenRouter video API (x-ai/grok-imagine-video, image-to-video). The panel's
 * still image becomes the first frame, so character/location consistency comes
 * for free from the already-generated storyboard image.
 *
 * Billing: 10 credits per second of video (same rate as one image per second),
 * charged ONLY when the clip completes successfully. Failed jobs cost nothing.
 *
 * Flow:
 *   POST /generate-panel-video   → submit job, store job id, return { processing }
 *   GET  /panel-video-status     → poll provider; on completion store the mp4,
 *                                  consume credits, return a signed video URL
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../../middleware/auth';
import { extractUserId, addPricingService, PricingRequest } from '../../middleware/pricingMiddleware';
import { getEffectiveCost } from '../../config/pricingPlans';
import { getSignedUrl, BUCKETS, detectBucket } from '../../services/storageService';
import { buildVideoMotionPrompt } from '../../prompts';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import {
  submitVideoJob,
  getVideoJob,
  downloadVideo,
  DEFAULT_VIDEO_MODEL,
  MIN_VIDEO_SECONDS,
  MAX_VIDEO_SECONDS,
  type VideoResolution,
  type VideoJob,
} from '../../services/videoModelRouter';
import { PricingService } from '../../services/pricingService';
import { stitchClips, frameSizeForFormat } from '../../services/videoStitchService';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// 10 credits per second of video — same rate as one image.
const VIDEO_CREDITS_PER_SECOND = getEffectiveCost('image');

// Hard deadline for a clip job. If the provider hasn't reached a terminal state
// by now (lost job, stuck queue, provider-side timeout), we fail the panel so
// the card stops spinning forever. No credits are charged for a timed-out job.
const VIDEO_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface ProjectAccess {
  hasAccess: boolean;
  canEdit: boolean;
  ownerId: string | null;
}

/**
 * Resolve access for a user against a project, and return who pays for credits
 * (the project owner, so collaborators draw from the owner's balance).
 */
async function resolveProjectAccess(projectId: string, userId: string): Promise<ProjectAccess> {
  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!project) return { hasAccess: false, canEdit: false, ownerId: null };

  const ownerId = project.user_id as string;
  if (ownerId === userId) return { hasAccess: true, canEdit: true, ownerId };

  const { data: collaborator } = await supabase
    .from('project_collaborators')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (!collaborator) return { hasAccess: false, canEdit: false, ownerId };
  return {
    hasAccess: true,
    canEdit: ['owner', 'admin', 'editor'].includes(collaborator.role),
    ownerId,
  };
}

/** Resolve a stored panel image path to a publicly fetchable signed URL. */
async function signPanelImage(imageUrl: string): Promise<string> {
  const bucket = detectBucket(imageUrl);
  if (bucket) return getSignedUrl(bucket, imageUrl);
  if (!imageUrl.startsWith('http')) {
    return getSignedUrl(
      imageUrl.startsWith('ai-generated/') ? BUCKETS.STORYBOARD_IMAGES : BUCKETS.PROJECT_ASSETS,
      imageUrl
    );
  }
  return imageUrl;
}

function resolveResolution(value: unknown): VideoResolution {
  return value === '480p' || value === '720p' || value === '1080p' ? value : '720p';
}

// =====================================================
// POST /generate-panel-video — start an image-to-video job
// =====================================================
router.post('/generate-panel-video', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { panel_id, project_id, duration, resolution, model } = req.body;
  const userId = req.userId!;

  if (!panel_id || !project_id) {
    return res.status(400).json({ error: 'Missing panel_id or project_id' });
  }

  try {
    const access = await resolveProjectAccess(project_id, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    if (!access.canEdit) return res.status(403).json({ error: 'Read-only access - viewers cannot generate video', role: 'viewer' });

    // Load the panel and confirm it belongs to the project
    const { data: panel, error: panelError } = await supabase
      .from('storyboard_panels')
      .select('*')
      .eq('id', panel_id)
      .eq('project_id', project_id)
      .single();

    if (panelError || !panel) return res.status(404).json({ error: 'Panel not found' });
    if (!panel.image_url) {
      return res.status(400).json({ error: 'Panel has no image yet. Generate the panel image before animating it.' });
    }
    // Animate is for cinematic (real, colorful) stills only — sketches animate poorly.
    if (panel.image_fidelity === 'sketch') {
      return res.status(400).json({ error: 'Sketch images cannot be animated. Regenerate the panel image in cinematic mode first.' });
    }
    if (panel.video_status === 'processing') {
      return res.status(409).json({ error: 'A video is already being generated for this panel.', status: 'processing' });
    }

    // Clip length: prefer explicit request, else the panel's planned duration.
    const requestedSeconds = duration != null ? Number(duration) : Number(panel.duration);
    const seconds = Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, Math.round(requestedSeconds || 5)));
    const creditsRequired = seconds * VIDEO_CREDITS_PER_SECOND;

    // The project owner pays. Check their balance up front so we never start a
    // job the account can't cover (credits are consumed on completion).
    const pricingService = req.pricingService || new PricingService(supabase);
    const ownerId = access.ownerId || userId;
    const balance = await pricingService.getAICreditsBalance(ownerId);
    if (balance < creditsRequired) {
      return res.status(403).json({
        error: 'Insufficient AI credits',
        message: `This ${seconds}s video requires ${creditsRequired} AI credits (${VIDEO_CREDITS_PER_SECOND}/second). Balance: ${balance}.`,
        type: 'INSUFFICIENT_CREDITS',
        credits_required: creditsRequired,
        credits_balance: balance,
        action_required: 'purchase_credits',
      });
    }

    // Determine aspect ratio from the project's video format (vertical series → 9:16)
    const { data: projectData } = await supabase
      .from('projects')
      .select('video_format, project_type')
      .eq('id', project_id)
      .single();
    const aspectRatio = String(projectData?.video_format || '').includes('16:9') ? '16:9' : '9:16';

    // Reserve the panel BEFORE calling the (paid) provider. If the DB/schema is
    // misconfigured (e.g. migration not applied), this fails here and we never
    // spend money on a job we couldn't track.
    const { error: reserveError } = await supabase
      .from('storyboard_panels')
      .update({
        video_status: 'processing',
        video_job_id: null,
        video_duration: seconds,
        video_model: model || DEFAULT_VIDEO_MODEL,
        video_url: null,
        video_error: null,
        video_created_at: new Date().toISOString(),
      })
      .eq('id', panel_id);

    if (reserveError) {
      console.error('❌ Failed to reserve panel for video job (no provider call made):', reserveError);
      return res.status(500).json({ error: 'Failed to start video generation', details: reserveError.message });
    }

    const firstFrameImageUrl = await signPanelImage(panel.image_url);
    let previousShotContext: string | undefined;
    if (Number(panel.panel_number) > 1 && panel.scene_id) {
      let previousPanelQuery = supabase
        .from('storyboard_panels')
        .select('panel_number, scene_description, notes, camera_direction, video_url, image_url')
        .eq('project_id', project_id)
        .eq('scene_id', panel.scene_id)
        .lt('panel_number', panel.panel_number)
        .order('panel_number', { ascending: false })
        .limit(1);

      previousPanelQuery = panel.episode_id
        ? previousPanelQuery.eq('episode_id', panel.episode_id)
        : previousPanelQuery.is('episode_id', null);

      const { data: previousPanels } = await previousPanelQuery;
      const previousPanel = previousPanels?.[0];
      if (previousPanel) {
        previousShotContext = [
          previousPanel.scene_description,
          previousPanel.notes,
          previousPanel.camera_direction,
          previousPanel.video_url ? 'A completed previous clip exists immediately before this one' : null,
          previousPanel.image_url ? 'The previous shot has a locked visual reference' : null,
        ].filter(Boolean).join(' ');
      }
    }

    const prompt = buildVideoMotionPrompt({
      sceneDescription: panel.scene_description || '',
      shotType: panel.shot_type,
      cameraMovement: panel.camera_movement,
      cameraDirection: panel.camera_direction,
      mood: panel.mood,
      notes: panel.notes,
      sceneHeading: panel.scene_heading,
      previousShotContext,
    });

    let job;
    try {
      job = await submitVideoJob({
        prompt,
        firstFrameImageUrl,
        aspectRatio,
        durationSeconds: seconds,
        resolution: resolveResolution(resolution),
        model: typeof model === 'string' ? model : undefined,
      });
    } catch (submitError) {
      // Roll the reservation back so the panel isn't stuck "processing".
      const msg = submitError instanceof Error ? submitError.message : 'Video submission failed';
      await supabase
        .from('storyboard_panels')
        .update({ video_status: 'failed', video_error: msg })
        .eq('id', panel_id);
      throw submitError;
    }

    // Attach the provider job id so the poller can track it.
    const { error: jobIdError } = await supabase
      .from('storyboard_panels')
      .update({ video_job_id: job.id })
      .eq('id', panel_id);

    if (jobIdError) {
      console.error('❌ Job created but failed to persist job id:', jobIdError);
      await supabase
        .from('storyboard_panels')
        .update({ video_status: 'failed', video_error: 'Could not save the video job reference' })
        .eq('id', panel_id);
      return res.status(500).json({ error: 'Failed to start video generation', details: jobIdError.message });
    }

    aiTaskEvents.emit('task', {
      type: 'panel-video:processing',
      projectId: project_id,
      userId,
      payload: { panelId: panel_id, jobId: job.id, duration: seconds },
    });

    if (DEBUG_AI) console.log(`🎥 Panel ${panel_id} video job ${job.id} started (${seconds}s, ${creditsRequired} credits)`);

    return res.json({
      panel_id,
      status: 'processing',
      job_id: job.id,
      duration: seconds,
      credits_required: creditsRequired,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ generate-panel-video error:', message);
    return res.status(500).json({ error: 'Failed to start video generation', details: message });
  }
});

// =====================================================
// GET /panel-video-status — poll a panel's video job
// =====================================================
router.get('/panel-video-status', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const panelId = req.query.panel_id as string;
  const projectId = req.query.project_id as string;
  const userId = req.userId!;

  if (!panelId || !projectId) {
    return res.status(400).json({ error: 'Missing panel_id or project_id' });
  }

  try {
    const access = await resolveProjectAccess(projectId, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied - not authorized for this project' });

    const { data: panel, error: panelError } = await supabase
      .from('storyboard_panels')
      .select('*')
      .eq('id', panelId)
      .eq('project_id', projectId)
      .single();

    if (panelError || !panel) return res.status(404).json({ error: 'Panel not found' });

    // Terminal or idle states — just report current state.
    if (panel.video_status !== 'processing' || !panel.video_job_id) {
      const signedVideo = panel.video_url ? await getSignedUrl(BUCKETS.GENERATED_VIDEO, panel.video_url) : null;
      return res.json({
        panel_id: panelId,
        status: panel.video_status || null,
        video_url: signedVideo,
        error: panel.video_error || null,
      });
    }

    // Hard timeout: if the job has been processing past the deadline, stop
    // polling and fail it. Checked BEFORE the provider call so a job stays
    // escapable even when the provider's poll endpoint keeps erroring.
    const startedAt = panel.video_created_at ? new Date(panel.video_created_at).getTime() : 0;
    if (startedAt && Date.now() - startedAt > VIDEO_JOB_TIMEOUT_MS) {
      const timeoutMsg = `Video generation timed out after ${Math.round(VIDEO_JOB_TIMEOUT_MS / 60000)} minutes. No credits were charged. Please try again.`;
      await supabase
        .from('storyboard_panels')
        .update({ video_status: 'failed', video_error: timeoutMsg })
        .eq('id', panelId)
        .eq('video_status', 'processing');
      aiTaskEvents.emit('task', {
        type: 'panel-video:failed',
        projectId,
        userId,
        payload: { panelId, error: 'timeout' },
      });
      return res.json({ panel_id: panelId, status: 'failed', error: timeoutMsg });
    }

    // Poll the provider.
    let job: VideoJob;
    try {
      job = await getVideoJob(panel.video_job_id);
    } catch (pollErr) {
      // A transient provider/poll error shouldn't flip the card to failed — keep
      // it processing so the next poll retries (the timeout guard above bounds it).
      const msg = pollErr instanceof Error ? pollErr.message : 'poll failed';
      if (DEBUG_AI) console.log(`🎥 Poll panel ${panelId} provider error (will retry): ${msg}`);
      return res.json({ panel_id: panelId, status: 'processing' });
    }
    if (DEBUG_AI) console.log(`🎥 Poll panel ${panelId} job ${panel.video_job_id}: status=${job.status}, urls=${job.videoUrls?.length ?? 0}`);

    if (job.status === 'completed') {
      const sourceUrl = job.videoUrls?.[0];
      if (!sourceUrl) {
        await supabase
          .from('storyboard_panels')
          .update({ video_status: 'failed', video_error: 'Provider reported completion but returned no video URL' })
          .eq('id', panelId);
        return res.json({ panel_id: panelId, status: 'failed', error: 'No video returned' });
      }

      const buffer = await downloadVideo(sourceUrl);
      const storagePath = `panel-videos/${projectId}/${panelId}/${uuidv4()}.mp4`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKETS.GENERATED_VIDEO)
        .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true });

      if (uploadError) {
        // Surface the failure instead of spinning forever. A "Bucket not found"
        // here means the `generated-video` storage bucket hasn't been created.
        const notFound = /not.?found/i.test(uploadError.message || '');
        const friendly = notFound
          ? "Storage bucket 'generated-video' not found. Create a private bucket named 'generated-video' in Supabase."
          : `Could not store the rendered video: ${uploadError.message}`;
        console.error('❌ Video upload failed:', uploadError);
        await supabase
          .from('storyboard_panels')
          .update({ video_status: 'failed', video_error: friendly })
          .eq('id', panelId);
        return res.json({ panel_id: panelId, status: 'failed', error: friendly });
      }

      // Atomically claim the completion: only the request that flips
      // processing → completed gets to charge credits (idempotency guard).
      const { data: claimed } = await supabase
        .from('storyboard_panels')
        .update({ video_status: 'completed', video_url: storagePath, video_error: null })
        .eq('id', panelId)
        .eq('video_status', 'processing')
        .select('id, video_duration');

      if (claimed && claimed.length > 0) {
        const seconds = claimed[0].video_duration || panel.video_duration || 5;
        const credits = seconds * VIDEO_CREDITS_PER_SECOND;
        const pricingService = req.pricingService || new PricingService(supabase);
        const ownerId = access.ownerId || userId;
        try {
          await pricingService.consumeAICredits(ownerId, credits, 'Panel video generation', {
            project_id: projectId,
            panel_id: panelId,
            seconds,
            initiated_by: userId,
          });
        } catch (creditErr) {
          console.error('❌ Failed to consume video credits:', creditErr);
        }

        aiTaskEvents.emit('task', {
          type: 'panel-video:completed',
          projectId,
          userId,
          payload: { panelId, seconds },
        });
      }

      const signedVideo = await getSignedUrl(BUCKETS.GENERATED_VIDEO, storagePath);
      return res.json({ panel_id: panelId, status: 'completed', video_url: signedVideo, error: null });
    }

    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
      await supabase
        .from('storyboard_panels')
        .update({ video_status: 'failed', video_error: job.error || `Video generation ${job.status}` })
        .eq('id', panelId);

      aiTaskEvents.emit('task', {
        type: 'panel-video:failed',
        projectId,
        userId,
        payload: { panelId, error: job.error || job.status },
      });

      return res.json({ panel_id: panelId, status: 'failed', error: job.error || `Video generation ${job.status}` });
    }

    // Still pending / in_progress.
    return res.json({ panel_id: panelId, status: 'processing' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ panel-video-status error:', message);
    return res.status(500).json({ error: 'Failed to check video status', details: message });
  }
});

// =====================================================
// SCENE / EPISODE RENDER (assembly) — stitch clips into a reel.
// No credits: clips are already paid; this only concatenates them.
// =====================================================

const nowIso = () => new Date().toISOString();

/** Run the ffmpeg stitch in the background and update the render row. */
async function runStitch(renderId: string, projectId: string, clipPaths: string[], videoFormat?: string | null) {
  try {
    const signed = await Promise.all(clipPaths.map((p) => getSignedUrl(BUCKETS.GENERATED_VIDEO, p)));
    const { width, height } = frameSizeForFormat(videoFormat);
    const buffer = await stitchClips(signed, { width, height });

    const storagePath = `reels/${projectId}/${renderId}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKETS.GENERATED_VIDEO)
      .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    await supabase
      .from('video_renders')
      .update({ status: 'completed', video_url: storagePath, error: null, updated_at: nowIso() })
      .eq('id', renderId);
    if (DEBUG_AI) console.log(`🎬 Render ${renderId} completed (${clipPaths.length} clips)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Render failed';
    console.error(`❌ Render ${renderId} failed:`, msg);
    await supabase
      .from('video_renders')
      .update({ status: 'failed', error: msg, updated_at: nowIso() })
      .eq('id', renderId);
  }
}

/** Remove prior renders for a target so only the latest reel remains. */
async function deletePriorRenders(projectId: string, episodeId: string | null, sceneId: string | null, scope: 'scene' | 'episode') {
  let q = supabase.from('video_renders').delete().eq('project_id', projectId).eq('scope', scope);
  q = episodeId ? q.eq('episode_id', episodeId) : q.is('episode_id', null);
  q = sceneId ? q.eq('scene_id', sceneId) : q.is('scene_id', null);
  await q;
}

// POST /render-scene — stitch one scene's completed clips into a reel.
router.post('/render-scene', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { project_id, episode_id, scene_id } = req.body;
  const userId = req.userId!;
  if (!project_id || !scene_id) return res.status(400).json({ error: 'Missing project_id or scene_id' });

  try {
    const access = await resolveProjectAccess(project_id, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    if (!access.canEdit) return res.status(403).json({ error: 'Read-only access - viewers cannot render', role: 'viewer' });

    let q = supabase
      .from('storyboard_panels')
      .select('panel_number, video_url, video_status')
      .eq('project_id', project_id)
      .eq('scene_id', scene_id);
    q = episode_id ? q.eq('episode_id', episode_id) : q.is('episode_id', null);
    const { data: panels } = await q.order('panel_number', { ascending: true });

    const clips = (panels || []).filter((p) => p.video_status === 'completed' && p.video_url).map((p) => p.video_url as string);
    if (clips.length === 0) {
      return res.status(400).json({ error: 'No animated clips in this scene yet. Generate clips first.' });
    }

    const { data: project } = await supabase.from('projects').select('video_format').eq('id', project_id).single();

    await deletePriorRenders(project_id, episode_id || null, scene_id, 'scene');
    const { data: render, error: insertError } = await supabase
      .from('video_renders')
      .insert({ project_id, episode_id: episode_id || null, scene_id, scope: 'scene', status: 'processing', clip_count: clips.length })
      .select()
      .single();
    if (insertError || !render) return res.status(500).json({ error: 'Failed to start render', details: insertError?.message });

    res.json({ render_id: render.id, status: 'processing', clip_count: clips.length });
    runStitch(render.id, project_id, clips, project?.video_format); // background
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ render-scene error:', message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to render scene', details: message });
  }
});

// POST /render-episode — stitch all completed clips for the episode in order.
router.post('/render-episode', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { project_id, episode_id } = req.body;
  const userId = req.userId!;
  if (!project_id) return res.status(400).json({ error: 'Missing project_id' });

  try {
    const access = await resolveProjectAccess(project_id, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    if (!access.canEdit) return res.status(403).json({ error: 'Read-only access - viewers cannot render', role: 'viewer' });

    let q = supabase
      .from('storyboard_panels')
      .select('scene_number, panel_number, video_url, video_status')
      .eq('project_id', project_id);
    q = episode_id ? q.eq('episode_id', episode_id) : q.is('episode_id', null);
    const { data: panels } = await q.order('scene_number', { ascending: true }).order('panel_number', { ascending: true });

    const clips = (panels || []).filter((p) => p.video_status === 'completed' && p.video_url).map((p) => p.video_url as string);
    if (clips.length === 0) {
      return res.status(400).json({ error: 'No animated clips yet. Generate clips first.' });
    }

    const { data: project } = await supabase.from('projects').select('video_format').eq('id', project_id).single();

    await deletePriorRenders(project_id, episode_id || null, null, 'episode');
    const { data: render, error: insertError } = await supabase
      .from('video_renders')
      .insert({ project_id, episode_id: episode_id || null, scene_id: null, scope: 'episode', status: 'processing', clip_count: clips.length })
      .select()
      .single();
    if (insertError || !render) return res.status(500).json({ error: 'Failed to start render', details: insertError?.message });

    res.json({ render_id: render.id, status: 'processing', clip_count: clips.length });
    runStitch(render.id, project_id, clips, project?.video_format); // background
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ render-episode error:', message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to render episode', details: message });
  }
});

// GET /renders — list current reels for the project/episode (signed URLs).
router.get('/renders', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const projectId = req.query.project_id as string;
  const episodeId = req.query.episode_id as string | undefined;
  const userId = req.userId!;
  if (!projectId) return res.status(400).json({ error: 'Missing project_id' });

  try {
    const access = await resolveProjectAccess(projectId, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied - not authorized for this project' });

    let q = supabase.from('video_renders').select('*').eq('project_id', projectId);
    q = episodeId ? q.eq('episode_id', episodeId) : q.is('episode_id', null);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const rows = await Promise.all(
      (data || []).map(async (r) => ({
        ...r,
        video_url: r.video_url ? await getSignedUrl(BUCKETS.GENERATED_VIDEO, r.video_url) : null,
      }))
    );
    res.json(rows);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ renders list error:', message);
    res.status(500).json({ error: 'Failed to load renders', details: message });
  }
});

export default router;
