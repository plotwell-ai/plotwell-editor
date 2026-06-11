/**
 * Video Stitch Service (MEGA beta assembly)
 *
 * Concatenates a set of shot clips (mp4 URLs) into a single vertical reel using
 * a bundled ffmpeg binary (ffmpeg-static). Clips can come from different models
 * with different sizes/fps, so each input is normalized (scaled + padded to the
 * target frame, constant fps) before concatenation.
 *
 * Video-only: current clips are generated without audio. If a clip carries an
 * audio track it is ignored for now (a later phase adds TTS/music on the reel).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

export interface StitchOptions {
  width?: number;
  height?: number;
  fps?: number;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download clip (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, buffer);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, {
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderr.trim().split(/\r?\n/).slice(-12).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}${detail ? `:\n${detail}` : ''}`));
    });
  });
}

/**
 * Download the given clip URLs, concatenate them in order, and return the
 * resulting mp4 as a Buffer. Throws if there are no clips.
 */
export async function stitchClips(clipUrls: string[], options: StitchOptions = {}): Promise<Buffer> {
  if (!clipUrls.length) throw new Error('No clips to stitch');
  if (!ffmpegPath) throw new Error('ffmpeg binary not available');

  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const fps = options.fps ?? 24;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plotwell-stitch-'));
  const inputFiles: string[] = [];
  const outputFile = path.join(workDir, `${randomUUID()}.mp4`);

  try {
    // Download all clips first.
    for (let i = 0; i < clipUrls.length; i++) {
      const file = path.join(workDir, `clip-${i}.mp4`);
      await downloadToFile(clipUrls[i], file);
      inputFiles.push(file);
    }

    if (DEBUG_AI) console.log(`🎬 Stitching ${inputFiles.length} clip(s) → ${width}x${height}@${fps}`);

    // Single input shortcut: still normalize so output is consistent.
    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    inputFiles.forEach((_, i) => {
      filterParts.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}[v${i}]`
      );
      concatInputs.push(`[v${i}]`);
    });
    const filterComplex =
      filterParts.join(';') +
      `;${concatInputs.join('')}concat=n=${inputFiles.length}:v=1:a=0[outv]`;

    const args = [
      '-y',
      ...inputFiles.flatMap((file) => ['-i', file]),
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-movflags', '+faststart',
      outputFile,
    ];

    if (DEBUG_AI) console.log(`🎬 ffmpeg ${args.map((arg) => `"${arg}"`).join(' ')}`);
    await runFfmpeg(args);

    return await fs.readFile(outputFile);
  } finally {
    // Best-effort cleanup of the temp working directory.
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pick a target frame size from a project video format string. Defaults to 9:16. */
export function frameSizeForFormat(videoFormat?: string | null): { width: number; height: number } {
  const v = String(videoFormat || '').toLowerCase();
  if (v.includes('16:9')) return { width: 1280, height: 720 };
  if (v.includes('1:1') || v === 'square') return { width: 1080, height: 1080 };
  return { width: 720, height: 1280 }; // 9:16 vertical default
}
