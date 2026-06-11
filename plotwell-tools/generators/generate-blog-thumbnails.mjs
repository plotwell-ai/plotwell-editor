#!/usr/bin/env node
/**
 * Generate blog post thumbnail images using Replicate flux-2-max
 * Saves to plotwell-landing-v3/public/blog/ and plotwell-landing/public/blog/
 *
 * Usage: node generate-blog-thumbnails.mjs
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

const OUTPUT_DIRS = [
  resolve(repoRoot, 'plotwell-landing', 'public', 'blog'),
];

const POSTS = [
  {
    slug: 'three-act-structure-screenplay',
    filename: 'three-act-structure.png',
    prompt: `A cinematic overhead shot of a classic three-act screenplay structure diagram drawn on aged paper, dramatic stages marked with a rising and falling arc, a vintage fountain pen resting beside the page, warm amber desk lamp illumination, shallow depth of field, professional screenwriting aesthetic, muted warm tones with cream and amber highlights, no readable text, 16:9 format, editorial photography style`,
  },
  {
    slug: 'script-doctor-structural-fixes',
    filename: 'script-doctor-structural-fixes.png',
    prompt: `A dramatic cinematic close-up of a printed screenplay script on a wooden desk, red editorial pen marks and annotations visible on the pages, soft warm studio lighting, shallow depth of field, professional film industry aesthetic, clean and minimal composition, muted warm tones with amber highlights, no text visible, 16:9 format, editorial photography style`,
  },
  {
    slug: 'scene-breakdown-production-plan',
    filename: 'scene-breakdown-production-plan.png',
    prompt: `A cinematic overhead shot of a film production planning workspace, professional breakdown sheets and scheduling stripboard spread across a desk, colored strips and scene cards arranged in a grid, a coffee cup and fountain pen nearby, warm ambient light from a desk lamp, organized and professional aesthetic, muted neutral tones, shallow focus, no readable text, 16:9 format, editorial photography style`,
  },
  {
    slug: 'writing-dialogue-that-works',
    filename: 'writing-dialogue-that-works.png',
    prompt: `Two actors in conversation in a minimalist film set, facing each other in a medium shot, dramatic side lighting creating depth and shadow, black and white or muted cinematic tones, professional film production aesthetic, the scene suggests an intense exchange, no visible text or props, 16:9 format, cinematic editorial photography style`,
  },
  {
    slug: 'how-to-write-a-logline',
    filename: 'how-to-write-a-logline.png',
    prompt: `A cinematic close-up of a single typed sentence on aged cream paper — a logline — resting on a dark wooden writer's desk, a vintage typewriter partially visible in the background, warm amber lamplight, dramatic side lighting with deep shadows, shallow depth of field, professional screenwriting aesthetic, no readable text on the paper, 16:9 format, editorial photography style`,
  },
];

async function generate(post) {
  console.log(`\n🎨 Generating thumbnail for: ${post.slug}`);
  console.log(`   Prompt: ${post.prompt.substring(0, 80)}...`);

  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({
      input: {
        prompt: post.prompt,
        aspect_ratio: '16:9',
        resolution: '2 MP',
        output_format: 'png',
        output_quality: 90,
        safety_tolerance: 3,
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Replicate API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Generation error: ${data.error}`);
  }

  let imageUrl = null;
  if (data.output) {
    if (Array.isArray(data.output)) imageUrl = data.output[0];
    else if (typeof data.output === 'string') imageUrl = data.output;
  }

  if (!imageUrl && data.id) {
    console.log(`   ⏳ Polling for result (id: ${data.id})...`);
    imageUrl = await pollForResult(data.id);
  }

  if (!imageUrl) {
    throw new Error(`Could not extract image URL from response for ${post.slug}`);
  }

  console.log(`   ✅ Generated: ${imageUrl}`);

  // Save to all output dirs
  for (const dir of OUTPUT_DIRS) {
    await mkdir(dir, { recursive: true });
    const outputPath = `${dir}/${post.filename}`;
    await downloadImage(imageUrl, outputPath);
    console.log(`   💾 Saved to: ${outputPath}`);
  }
}

async function pollForResult(predictionId, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await res.json();
    console.log(`   Poll ${i + 1}: ${data.status}`);
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

async function main() {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('Set REPLICATE_API_TOKEN before running this generator.');
  }

  console.log('🚀 Blog thumbnail generator');
  console.log(`   Generating ${POSTS.length} thumbnails...\n`);

  for (const post of POSTS) {
    try {
      await generate(post);
    } catch (err) {
      console.error(`❌ Failed for ${post.slug}:`, err.message);
    }
  }

  console.log('\n🎉 Done! Update your blog post frontmatter to use the new image paths:');
  for (const post of POSTS) {
    console.log(`   ${post.slug}: image: "/blog/${post.filename}"`);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
