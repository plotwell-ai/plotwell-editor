/**
 * finalize.ts — Post-process all demo recordings.
 *
 * Run: npm run demo:finalize
 *
 * Each entry in EDIT_CONFIGS maps a raw video filename to its edit settings.
 * Add/adjust entries as needed.
 */

import path from 'path';
import { editVideo, getVideoDuration } from '../utils/edit';

const VIDEOS_DIR  = path.resolve(__dirname, '../output/videos');
const ASSETS_DIR  = path.resolve(__dirname, '../assets');

// ─── Per-video edit config ────────────────────────────────────────────────────
// Keys are the raw .webm filenames (without extension).
// Any video not listed here will be processed with DEFAULT_CONFIG.
const EDIT_CONFIGS: Record<string, Parameters<typeof editVideo>[1]> = {
  'new_project_and_agent_1': {
    speed: 1.5,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    subtitles: path.join(ASSETS_DIR, 'subtitles', 'new_project_and_agent_1.srt'),
    fadeDuration: 1,
  },
  'character_locations_extraction_2': {
    speed: 1.8,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    subtitles: path.join(ASSETS_DIR, 'subtitles', 'character_locations_extraction_2.srt'),
    fadeDuration: 1,
  },
  'scriptdoctor_3': {
    speed: 1.5,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    subtitles: path.join(ASSETS_DIR, 'subtitles', 'scriptdoctor_3.srt'),
    fadeDuration: 1,
  },
  'image_gen_4': {
    speed: 1.3,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.2,
    subtitles: path.join(ASSETS_DIR, 'subtitles', 'image_gen_4.srt'),
    fadeDuration: 1,
  },
  'storyboards': {
    speed: 1.4,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    fadeDuration: 1,
  },
  'treatment_ai_2_bis': {
    speed: 1.5,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    fadeDuration: 1,
  },
  'demo7': {
    speed: 1.5,
    music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
    musicVolume: 0.15,
    fadeDuration: 1,
  },
};

const DEFAULT_CONFIG: Parameters<typeof editVideo>[1] = {
  speed: 1.5,
  music: path.join(ASSETS_DIR, 'music', 'background.mp3'),
  musicVolume: 0.15,
  fadeDuration: 1,
};

// ─── Run ──────────────────────────────────────────────────────────────────────
async function main() {
  const fs = await import('fs');
  const rawFiles = fs.readdirSync(VIDEOS_DIR).filter(f => f.endsWith('.webm'));

  if (rawFiles.length === 0) {
    console.log('No .webm files found in output/videos/. Run a demo first.');
    process.exit(0);
  }

  // Filter to a single file if passed as argument: npm run demo:finalize -- storyboards
  const target = process.argv[2];
  const toProcess = target
    ? rawFiles.filter(f => f.includes(target))
    : rawFiles;

  if (toProcess.length === 0) {
    console.log(`No file matching "${target}" in output/videos/.`);
    process.exit(1);
  }

  console.log(`\n🎬 Finalizing ${toProcess.length} video(s)…\n`);

  let ok = 0, fail = 0;

  for (const file of toProcess) {
    const name = path.basename(file, '.webm');
    const inputPath = path.join(VIDEOS_DIR, file);
    const config = EDIT_CONFIGS[name] ?? DEFAULT_CONFIG;

    // Auto-set fade-out if trim.end not set — probe duration
    if (!config.trim?.end && config.fadeDuration) {
      try {
        const duration = await getVideoDuration(inputPath);
        const adjustedDur = duration / (config.speed ?? 1);
        config.trim = {
          ...config.trim,
          end: duration, // raw duration (ffmpeg trims before speed)
        };
        // patch fade-out into output options via trim
        config.trim.end = duration;
      } catch { /* skip fade-out if probe fails */ }
    }

    try {
      const out = await editVideo(inputPath, config);
      console.log(`  → ${path.relative(process.cwd(), out)}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\n✅ Done — ${ok} succeeded, ${fail} failed.`);
  console.log(`   Output: output/final/\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
