/**
 * Video edit pipeline — wraps ffmpeg via fluent-ffmpeg.
 *
 * Usage:
 *   await editVideo('output/videos/01-editor.webm', {
 *     speed: 1.5,
 *     music: 'assets/music/background.mp3',
 *     musicVolume: 0.18,
 *     subtitles: 'assets/subtitles/01-editor.srt',
 *     trim: { start: 2, end: 60 },   // seconds, optional
 *     fadeDuration: 1,
 *     output: 'output/final/01-editor.mp4',
 *   });
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

export interface EditOptions {
  /** Playback speed multiplier. 1.0 = normal, 1.5 = 50% faster, 2.0 = double speed. */
  speed?: number;
  /** Path to background music file (mp3/wav). Optional. */
  music?: string;
  /** Music volume 0–1. Default 0.18 (quiet background). */
  musicVolume?: number;
  /** Path to .srt subtitle file. Optional. */
  subtitles?: string;
  /** Trim the video. Start/end in seconds. Optional. */
  trim?: { start?: number; end?: number };
  /** Fade in/out duration in seconds. Default 0.8. */
  fadeDuration?: number;
  /** Output path. Defaults to same dir as input, .mp4 extension. */
  output?: string;
}

const FINAL_DIR = path.resolve(__dirname, '../output/final');

export async function editVideo(
  inputPath: string,
  opts: EditOptions = {}
): Promise<string> {
  fs.mkdirSync(FINAL_DIR, { recursive: true });

  const {
    speed = 1.0,
    music,
    musicVolume = 0.18,
    subtitles,
    trim,
    fadeDuration = 0.8,
    output,
  } = opts;

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = output ?? path.join(FINAL_DIR, `${baseName}.mp4`);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath);

    // ── Trim ──────────────────────────────────────────────────────────────
    if (trim?.start) cmd = cmd.setStartTime(trim.start);
    if (trim?.end)   cmd = cmd.setDuration(trim.end - (trim.start ?? 0));

    // ── Video filters ──────────────────────────────────────────────────────
    const vFilters: string[] = [];

    if (speed !== 1.0) {
      vFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
    }

    if (subtitles) {
      // Escape Windows backslashes for ffmpeg filter syntax
      const srtPath = path.resolve(subtitles).replace(/\\/g, '/').replace(/:/g, '\\:');
      vFilters.push(`subtitles='${srtPath}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Shadow=1,Alignment=2'`);
    }

    // Fade in/out video
    // We need to know the duration for fade-out. We'll use a two-pass workaround via
    // ffprobe, but for simplicity we schedule a 1s fade-out from a fixed near-end offset.
    vFilters.push(`fade=t=in:st=0:d=${fadeDuration}`);
    // fade-out: ffmpeg can't know total duration at filter-graph build time without probing,
    // so we rely on the caller setting trim.end, otherwise skip it.
    if (trim?.end) {
      const dur = trim.end - (trim.start ?? 0);
      const adjustedDur = dur / speed;
      vFilters.push(`fade=t=out:st=${(adjustedDur - fadeDuration).toFixed(2)}:d=${fadeDuration}`);
    }

    cmd = cmd.videoFilters(vFilters);

    // ── Audio filters ──────────────────────────────────────────────────────
    if (music && fs.existsSync(music)) {
      // Mix original audio (if any) + background music
      cmd = cmd.input(music);
      const aFilters = speed !== 1.0
        ? buildAudioSpeedFilter(speed)
        : 'anull';

      cmd = cmd.complexFilter([
        // Speed up / normalize original audio track
        `[0:a]${aFilters},volume=1.0[orig]`,
        // Loop music to match video length, then lower volume
        `[1:a]aloop=loop=-1:size=2e+09,volume=${musicVolume}[bg]`,
        // Mix both
        `[orig][bg]amix=inputs=2:duration=first:dropout_transition=2[out]`,
      ], 'out');
    } else if (speed !== 1.0) {
      // No music — just speed up audio
      cmd = cmd.audioFilters(buildAudioSpeedFilter(speed));
    }

    // ── Output ────────────────────────────────────────────────────────────
    cmd
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 20',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-pix_fmt yuv420p',      // broad compatibility (Twitter, LinkedIn, etc.)
      ])
      .output(outputPath)
      .on('start', (cmdLine) => {
        console.log(`\n▶ ffmpeg: ${path.basename(inputPath)} → ${path.basename(outputPath)}`);
        if (process.env.DEBUG_FFMPEG) console.log(cmdLine);
      })
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r  ${Math.round(p.percent)}%`);
      })
      .on('end', () => {
        process.stdout.write('\r  100% ✓\n');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`\n❌ ffmpeg error: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Builds an atempo filter chain for the given speed.
 * atempo only accepts values between 0.5 and 2.0, so we chain it for extreme values.
 */
function buildAudioSpeedFilter(speed: number): string {
  if (speed >= 0.5 && speed <= 2.0) return `atempo=${speed.toFixed(4)}`;

  // Chain: e.g. 3x = atempo=2.0,atempo=1.5
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  if (remaining > 0.5) filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

/**
 * Get video duration in seconds using ffprobe.
 */
export function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}
