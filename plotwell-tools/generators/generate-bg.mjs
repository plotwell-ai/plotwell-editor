#!/usr/bin/env node
/**
 * Generate a blurred cinematic background image for the website
 * Using black-forest-labs/flux-1.1-pro via Replicate
 */

import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import https from 'https';
import http from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

const prompt = `A professional film production set outdoors in bright golden sunshine, film crew working with cameras on cranes and dollies, director and actors on set, warm sunlight flooding the scene, film equipment and clapperboards, vibrant cinematic energy, extremely soft gaussian blur applied across the entire image making it dreamy and defocused for a website background, heavy bokeh effect, all subjects and background beautifully blurred and out of focus, warm golden tones, lens flare, atmospheric haze, 16:9 wide composition, no sharp edges, no text, no watermarks`;

async function generate() {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('Set REPLICATE_API_TOKEN before running this generator.');
  }

  console.log('🚀 Starting image generation with flux-2-max...');
  console.log('📝 Prompt:', prompt.substring(0, 100) + '...');

  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: '16:9',
        resolution: '4 MP',
        output_format: 'png',
        output_quality: 100,
        safety_tolerance: 3,
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Replicate API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  console.log('📦 Response status:', data.status);

  if (data.error) {
    throw new Error(`Generation error: ${data.error}`);
  }

  // Extract URL
  let imageUrl = null;
  if (data.output) {
    if (Array.isArray(data.output)) imageUrl = data.output[0];
    else if (typeof data.output === 'string') imageUrl = data.output;
  }

  if (!imageUrl) {
    // If still processing (Prefer: wait didn't wait), poll
    if (data.id && data.status !== 'succeeded') {
      console.log('⏳ Polling for result (id:', data.id, ')...');
      imageUrl = await pollForResult(data.id);
    } else {
      console.error('Raw response:', JSON.stringify(data, null, 2));
      throw new Error('Could not extract image URL from response');
    }
  }

  console.log('✅ Image URL:', imageUrl);

  // Download and save
  const outputPath = resolve(repoRoot, 'plotwell-tools', 'media', 'website-bg.png');
  await mkdir(dirname(outputPath), { recursive: true });
  await downloadImage(imageUrl, outputPath);
  console.log('💾 Saved to:', outputPath);
  console.log('🎉 Done!');
}

async function pollForResult(predictionId, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await res.json();
    console.log(`  Poll ${i + 1}: ${data.status}`);
    if (data.status === 'succeeded') {
      if (Array.isArray(data.output)) return data.output[0];
      return data.output;
    }
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`Prediction ${data.status}: ${data.error || 'unknown error'}`);
    }
  }
  throw new Error('Timed out waiting for prediction');
}

async function downloadImage(url, outputPath) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadImage(response.headers.location, outputPath).then(resolve).catch(reject);
      }
      const dest = createWriteStream(outputPath);
      response.pipe(dest);
      dest.on('finish', () => { dest.close(); resolve(); });
      dest.on('error', reject);
    }).on('error', reject);
  });
}

generate().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
