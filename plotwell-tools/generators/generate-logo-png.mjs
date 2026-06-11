import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const { createCanvas } = require(resolve(repoRoot, 'plotwell-app', 'node_modules', 'canvas'));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// --- Square icon only: 512×512 ---
{
  const S = 512;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');

  // Light warm background
  ctx.fillStyle = '#f7f6f3';
  ctx.fillRect(0, 0, S, S);

  // Amber circle
  const cx = S / 2, cy = S / 2, r = 180;
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  grad.addColorStop(0, '#f59e0b');
  grad.addColorStop(1, '#d97706');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Screenplay lines
  const lines = [
    { dx: -100, dy: -80,  w: 200, h: 32, op: 1.0 },
    { dx: -100, dy: -28,  w: 150, h: 26, op: 0.9 },
    { dx: -70,  dy:  18,  w: 150, h: 26, op: 0.85 },
    { dx: -100, dy:  64,  w: 200, h: 26, op: 0.7 },
  ];
  for (const l of lines) {
    ctx.globalAlpha = l.op;
    ctx.fillStyle = 'white';
    roundRect(ctx, cx + l.dx, cy + l.dy, l.w, l.h, 13);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  writeFileSync(resolve(repoRoot, 'plotwell-app', 'public', 'logo-square.png'), canvas.toBuffer('image/png'));
  console.log('✅ logo-square.png (512×512)');
}

// --- Horizontal lockup: 800×400 square-ish with padding ---
{
  const W = 600, H = 200;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Light warm background
  ctx.fillStyle = '#f7f6f3';
  ctx.fillRect(0, 0, W, H);

  // Amber circle (left side)
  const r = 72, cx = 72 + 20, cy = H / 2;
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  grad.addColorStop(0, '#f59e0b');
  grad.addColorStop(1, '#d97706');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Screenplay lines on icon
  const lines = [
    { dx: -40, dy: -32, w: 80, h: 13, op: 1.0 },
    { dx: -40, dy: -11, w: 60, h: 10, op: 0.9 },
    { dx: -28, dy:  8,  w: 60, h: 10, op: 0.85 },
    { dx: -40, dy: 27,  w: 80, h: 10, op: 0.7 },
  ];
  for (const l of lines) {
    ctx.globalAlpha = l.op;
    ctx.fillStyle = 'white';
    roundRect(ctx, cx + l.dx, cy + l.dy, l.w, l.h, 5);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // "plotwell" wordmark
  ctx.fillStyle = '#0f0f0f';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('plotwell', cx + r + 24, cy);

  writeFileSync(resolve(repoRoot, 'plotwell-app', 'public', 'logo-lockup.png'), canvas.toBuffer('image/png'));
  console.log('✅ logo-lockup.png (600×200)');
}
