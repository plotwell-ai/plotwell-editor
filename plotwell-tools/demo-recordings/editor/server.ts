/**
 * Video Editor Server
 * Serves the editor UI and handles ffmpeg processing requests.
 * Run: npm run editor
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

const app = express();
const PORT = 4242;

const VIDEOS_DIR = path.resolve(__dirname, '../output/videos');
const FINAL_DIR  = path.resolve(__dirname, '../output/final');
const EDITOR_DIR = path.resolve(__dirname, '.');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve the editor HTML
app.get('/', (_req, res) => {
  res.sendFile(path.join(EDITOR_DIR, 'index.html'));
});

// List raw videos
app.get('/api/videos', (_req, res) => {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const files = fs.readdirSync(VIDEOS_DIR)
    .filter(f => f.endsWith('.webm') || f.endsWith('.mp4'))
    .map(f => {
      const stat = fs.statSync(path.join(VIDEOS_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    });
  res.json(files);
});

// Stream a video file
app.get('/api/videos/:name', (req, res) => {
  const filePath = path.join(VIDEOS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/webm',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/webm',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Get video duration via ffprobe
app.get('/api/videos/:name/info', (req, res) => {
  const filePath = path.join(VIDEOS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  ffmpeg.ffprobe(filePath, (err, metadata) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      duration: metadata.format.duration,
      width: metadata.streams[0]?.width,
      height: metadata.streams[0]?.height,
    });
  });
});

// Process video with variable-speed segments
// Body: { input: 'filename.webm', segments: [{start, end, speed}], music?: string, musicVolume?: number, output?: string }
app.post('/api/process', async (req, res) => {
  const { input, segments, music, musicVolume = 0.15, output } = req.body as {
    input: string;
    segments: { start: number; end: number; speed: number }[];
    music?: string;
    musicVolume?: number;
    output?: string;
  };

  if (!input || !segments?.length) {
    return res.status(400).json({ error: 'input and segments required' });
  }

  const inputPath = path.join(VIDEOS_DIR, input);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Input file not found' });
  }

  fs.mkdirSync(FINAL_DIR, { recursive: true });
  const baseName = path.basename(input, path.extname(input));
  const outputName = output ?? `${baseName}-edited.mp4`;
  const outputPath = path.join(FINAL_DIR, outputName);

  // Build ffmpeg filter_complex for variable-speed segments
  try {
    const args = buildFFmpegArgs(inputPath, outputPath, segments, music, musicVolume);

    // Send SSE-style progress via chunked response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Transfer-Encoding', 'chunked');

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;
      // Parse time= from ffmpeg progress
      const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m) {
        const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
        res.write(JSON.stringify({ type: 'progress', seconds: secs }) + '\n');
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        res.write(JSON.stringify({ type: 'done', output: outputName }) + '\n');
      } else {
        res.write(JSON.stringify({ type: 'error', message: stderr.slice(-500) }) + '\n');
      }
      res.end();
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Build the ffmpeg argument list for variable-speed segments.
 *
 * Strategy: for each segment, trim + setpts (video) + atempo (audio),
 * then concat all segments.
 */
function buildFFmpegArgs(
  input: string,
  output: string,
  segments: { start: number; end: number; speed: number }[],
  music?: string,
  musicVolume = 0.15,
): string[] {
  const args: string[] = ['-y', '-i', input];
  if (music && fs.existsSync(music)) args.push('-i', music);

  const filterParts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];

  segments.forEach((seg, i) => {
    const dur = seg.end - seg.start;
    const pts = (1 / seg.speed).toFixed(6);
    const atempo = buildAtempoChain(seg.speed);

    // Video segment
    filterParts.push(
      `[0:v]trim=start=${seg.start}:duration=${dur},setpts=${pts}*(PTS-STARTPTS),fade=t=in:st=0:d=0.3[v${i}]`
    );
    vLabels.push(`[v${i}]`);

    // Audio segment
    filterParts.push(
      `[0:a]atrim=start=${seg.start}:duration=${dur},asetpts=PTS-STARTPTS,${atempo}[a${i}]`
    );
    aLabels.push(`[a${i}]`);
  });

  const n = segments.length;

  // Concat video + audio
  filterParts.push(
    `${vLabels.join('')}concat=n=${n}:v=1:a=0[vout]`,
    `${aLabels.join('')}concat=n=${n}:v=0:a=1[araw]`
  );

  // Mix with background music if provided
  if (music && fs.existsSync(music)) {
    filterParts.push(
      `[1:a]aloop=loop=-1:size=2e+09,volume=${musicVolume}[bg]`,
      `[araw][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    );
  } else {
    filterParts.push(`[araw]anull[aout]`);
  }

  args.push('-filter_complex', filterParts.join('; '));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  args.push(output);

  return args;
}

function buildAtempoChain(speed: number): string {
  if (speed >= 0.5 && speed <= 2.0) return `atempo=${speed.toFixed(4)}`;
  const filters: string[] = [];
  let r = speed;
  while (r > 2.0) { filters.push('atempo=2.0'); r /= 2.0; }
  if (r > 0.5) filters.push(`atempo=${r.toFixed(4)}`);
  return filters.join(',');
}

app.listen(PORT, () => {
  console.log(`\n🎬 Video Editor running at http://localhost:${PORT}\n`);
});
