#!/usr/bin/env node
/**
 * Generate AI storyboard sketch panels for the plotwell landing page mockup.
 * Uses black-forest-labs/flux-1.1-pro via Replicate.
 * Cinematic pencil sketch / storyboard illustration style.
 * Saves to plotwell-landing-v3/public/storyboards/
 */

import { createWriteStream, mkdirSync } from 'fs';
import https from 'https';
import http from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const OUT_DIR = resolve(repoRoot, 'plotwell-landing', 'public', 'storyboards');

mkdirSync(OUT_DIR, { recursive: true });

const STYLE = 'professional film storyboard illustration, pencil sketch, black and white, monochrome, charcoal drawing, rough hand-drawn lines, cinematic composition, movie production art, no color, no watermarks, no text';

const PANELS = [
  {
    filename: 'sb-01.jpg',
    prompt: `${STYLE}. Wide shot underwater scene — large catfish swimming through murky river, fish hook dangling from above, light rays filtering through water, dramatic perspective from below`,
  },
  {
    filename: 'sb-02.jpg',
    prompt: `${STYLE}. Extreme close-up of a catfish eye, enormous and ancient-looking, hook reflected in its pupil, dramatic macro composition, fish scales texture`,
  },
  {
    filename: 'sb-03.jpg',
    prompt: `${STYLE}. Over-the-shoulder shot — older man in his 40s gesturing expressively, young boy aged 3 listening wide-eyed on a bed, warm bedroom setting, intimate family scene`,
  },
  {
    filename: 'sb-04.jpg',
    prompt: `${STYLE}. Medium wide shot — circle of young boys around a campfire at night, one charismatic man standing at center telling a story with big gestures, dramatic firelight shadows`,
  },
  {
    filename: 'sb-05.jpg',
    prompt: `${STYLE}. Medium close-up — man's hand holding up a wedding ring toward the sky, ring catching light, campfire in soft focus background, dramatic upward angle`,
  },
  {
    filename: 'sb-06.jpg',
    prompt: `${STYLE}. Wide shot interior — elegant front hallway of a Southern home, teenage girl in formal dress looking enchanted at a man telling a story, teenage boy in background looking furious and embarrassed`,
  },
];

async function generateImage(panel) {
  console.log(`\n🎬 Generating: ${panel.filename}`);
  console.log(`   Prompt: ${panel.prompt.substring(0, 80)}...`);

  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({
      input: {
        prompt: panel.prompt,
        aspect_ratio: '3:2',
        output_format: 'jpg',
        output_quality: 85,
        safety_tolerance: 2,
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Replicate API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`Generation error: ${data.error}`);

  let imageUrl = null;
  if (data.output) {
    imageUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  }

  if (!imageUrl && data.id) {
    console.log(`   ⏳ Polling (id: ${data.id})...`);
    imageUrl = await poll(data.id);
  }

  if (!imageUrl) throw new Error('No image URL in response');
  console.log(`   ✅ URL: ${imageUrl.substring(0, 60)}...`);

  const outputPath = `${OUT_DIR}/${panel.filename}`;
  await download(imageUrl, outputPath);
  console.log(`   💾 Saved: ${outputPath}`);
  return outputPath;
}

async function poll(id, max = 90) {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await res.json();
    console.log(`   Poll ${i + 1}: ${data.status}`);
    if (data.status === 'succeeded') return Array.isArray(data.output) ? data.output[0] : data.output;
    if (data.status === 'failed' || data.status === 'canceled') throw new Error(`Prediction ${data.status}: ${data.error}`);
  }
  throw new Error('Timed out');
}

async function download(url, dest) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('Set REPLICATE_API_TOKEN before running this generator.');
  }

  console.log('🚀 Generating storyboard sketch panels for plotwell landing page...\n');
  for (let i = 0; i < PANELS.length; i++) {
    const panel = PANELS[i];
    try {
      await generateImage(panel);
    } catch (err) {
      console.error(`   ❌ Failed ${panel.filename}:`, err.message);
    }
    if (i < PANELS.length - 1) {
      console.log('\n   ⏸  Waiting 15s to avoid rate limit...');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  console.log('\n🎉 All done! Images saved to:', OUT_DIR);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
