#!/usr/bin/env node
/**
 * Generate AI character portrait images for the plotwell landing page mockup.
 * Uses black-forest-labs/flux-1.1-pro via Replicate.
 * Saves to plotwell-landing-v3/public/characters/
 */

import { createWriteStream, mkdirSync } from 'fs';
import https from 'https';
import http from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const OUT_DIR = resolve(repoRoot, 'plotwell-landing', 'public', 'characters');

mkdirSync(OUT_DIR, { recursive: true });

const CHARACTERS = [
  {
    filename: 'edward-bloom.jpg',
    prompt: `Cinematic close-up portrait of a charismatic American man in his late 40s, handsome and larger-than-life, warm confident smile, slight stubble, wearing a classic shirt, warm southern American golden-hour lighting from the side, shallow depth of field, bokeh background, analog film photography aesthetic, Kodak Portra 400, cinematic color grading, warm amber tones, no text, no watermarks`,
  },
  {
    filename: 'will-bloom.jpg',
    prompt: `Cinematic close-up portrait of a serious introspective American man in his late 20s, lean face, thoughtful expression, modern casual clothing, cool blue tones, overcast natural lighting, shallow depth of field, bokeh background, analog film photography aesthetic, Kodak Portra 400, cinematic color grading, no text, no watermarks`,
  },
  {
    filename: 'sandra.jpg',
    prompt: `Cinematic close-up portrait of a beautiful elegant American woman in her late 30s, warm loving smile, classic Southern belle style, soft golden natural lighting, floral dress suggestion, shallow depth of field, bokeh background, analog film photography aesthetic, Kodak Portra 400, cinematic warm color grading, no text, no watermarks`,
  },
  {
    filename: 'josephine.jpg',
    prompt: `Cinematic close-up portrait of a beautiful young European woman in her mid 20s, elegant and refined, gentle expression, sophisticated style, soft warm studio lighting, shallow depth of field, bokeh background, analog film photography aesthetic, Kodak Portra 400, cinematic color grading, no text, no watermarks`,
  },
];

async function generateImage(char) {
  console.log(`\n🎬 Generating: ${char.filename}`);
  console.log(`   Prompt: ${char.prompt.substring(0, 80)}...`);

  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({
      input: {
        prompt: char.prompt,
        aspect_ratio: '2:3',
        output_format: 'jpg',
        output_quality: 90,
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

  const outputPath = `${OUT_DIR}/${char.filename}`;
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

  console.log('🚀 Generating character portraits for plotwell landing page...\n');
  for (let i = 0; i < CHARACTERS.length; i++) {
    const char = CHARACTERS[i];
    try {
      await generateImage(char);
    } catch (err) {
      console.error(`   ❌ Failed ${char.filename}:`, err.message);
    }
    if (i < CHARACTERS.length - 1) {
      console.log('\n   ⏸  Waiting 15s to avoid rate limit...');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  console.log('\n🎉 All done! Images saved to:', OUT_DIR);
  console.log('   Update CHAR_PORTRAITS in App.tsx to use /characters/<filename>');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
