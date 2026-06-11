import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import {
  Camera, Video, Image, Wand2, Plus, Download, CheckCircle, Clock, AlertCircle,
  Loader2, X, Copy, Check, Trash2, ExternalLink, ChevronDown, ChevronUp,
  Circle, Square, Pause, Play, Music, Subtitles, MonitorSmartphone, Scissors, LayoutGrid,
} from "lucide-react";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────

interface ScreenshotSlot {
  id: string;
  label: string;
  description: string;
  section?: string;
  custom?: boolean;
  device?: "desktop" | "mobile";
  size?: string; // display hint e.g. "1920×1080"
}

interface CaptureRecord {
  capturedAt: string;
  preview: string;   // base64 thumbnail for card display
  fullRes?: string;  // full-res JPEG base64 — persisted so downloads can happen later
}

interface VideoEntry {
  id: string;
  label: string;
  description: string;
  youtubeId: string;
  custom?: boolean;
  format?: "desktop" | "mobile";
}

interface SubtitleEntry {
  id: string;
  start: number; // seconds
  end: number;
  text: string;
}

interface ThumbnailFormat {
  id: string;
  label: string;
  platform: string;
  width: number;
  height: number;
  description: string;
}

interface ThumbnailSubject {
  id: string;
  name: string;
  createdAt: number;
}

// ─────────────────────────────────────────────
//  Built-in registries
// ─────────────────────────────────────────────

const BUILT_IN_SLOTS: ScreenshotSlot[] = [
  // ── Desktop (1920×1080) ───────────────────────────────────────────────────
  { id: "script-editor-desktop",  device: "desktop", size: "1920×1080", label: "Script Editor",        section: "script",           description: "Open a script with content. Formatting toolbar visible. Full window." },
  { id: "ai-assistant-desktop",   device: "desktop", size: "1920×1080", label: "AI Assistant",         section: "script",           description: "Open a script with the AI Chat panel expanded on the right. One exchange visible." },
  { id: "storyboard-desktop",     device: "desktop", size: "1920×1080", label: "Storyboard",           section: "storyboard",       description: "Storyboard view with 4+ panels generated and visible." },
  { id: "production-desktop",     device: "desktop", size: "1920×1080", label: "Production Planning",  section: "scenes-breakdown", description: "Scenes Breakdown with scenes and breakdowns visible." },
  { id: "collaboration-desktop",  device: "desktop", size: "1920×1080", label: "Team Collaboration",   section: "script",           description: "Project with collaborators. Team indicator in TopBar showing active users." },
  { id: "tv-series-desktop",      device: "desktop", size: "1920×1080", label: "TV Series",            section: "script",           description: "TV Series project. Episode selector visible with at least 2 episodes." },
  // ── Mobile (390×844) ─────────────────────────────────────────────────────
  { id: "script-editor-mobile",   device: "mobile",  size: "390×844",   label: "Script Editor",        section: "script",           description: "Open a script. Show the script view in mobile layout. Toolbar should be accessible." },
  { id: "ai-assistant-mobile",    device: "mobile",  size: "390×844",   label: "AI Assistant",         section: "script",           description: "Open AI panel in mobile full-screen mode. One exchange visible." },
  { id: "storyboard-mobile",      device: "mobile",  size: "390×844",   label: "Storyboard",           section: "storyboard",       description: "Storyboard view in mobile layout. Panels scrolling vertically." },
  { id: "production-mobile",      device: "mobile",  size: "390×844",   label: "Production Planning",  section: "scenes-breakdown", description: "Scenes Breakdown in mobile layout." },
  { id: "nav-mobile",             device: "mobile",  size: "390×844",   label: "Mobile Navigation",    section: "script",           description: "Show the bottom nav bar. Tap a section to highlight it. Dashboard visible." },
  { id: "projects-mobile",        device: "mobile",  size: "390×844",   label: "Projects List",        section: undefined,          description: "Projects page in mobile layout. Show 2+ project cards." },
];

const THUMBNAIL_FORMATS: ThumbnailFormat[] = [
  { id: "yt",      label: "YouTube",              platform: "YouTube",           width: 1280, height: 720,  description: "16:9 · thumbnail shown in search results and player" },
  { id: "tw",      label: "Twitter / X Card",     platform: "Twitter / X",       width: 1200, height: 675,  description: "16:9 · link preview card in the timeline" },
  { id: "li",      label: "LinkedIn",             platform: "LinkedIn",          width: 1200, height: 627,  description: "1.91:1 · link share preview image" },
  { id: "tw-v",    label: "Twitter / X Portrait", platform: "Twitter / X",       width: 1080, height: 1350, description: "4:5 · inline image post in the feed" },
  { id: "ig-sq",   label: "Instagram Square",     platform: "Instagram",         width: 1080, height: 1080, description: "1:1 · standard square post" },
  { id: "reel",    label: "Shorts / Reel / TikTok", platform: "IG · YT · TikTok", width: 1080, height: 1920, description: "9:16 · vertical short-form thumbnail" },
];

const BUILT_IN_VIDEOS: VideoEntry[] = [
  // ── Desktop demos ─────────────────────────────────────────────────────────
  { format: "desktop", id: "agent-writer",  label: "AI Agent Writer",                description: "Describe a scene and the AI plans, writes, and inserts it automatically.", youtubeId: "uuSQHVKMhys" },
  { format: "desktop", id: "extraction",    label: "Extract Characters & Locations",  description: "Instantly extract every character and location from your script.", youtubeId: "hlaF0yfLxXI" },
  { format: "desktop", id: "image-gen",     label: "AI Image Generation",             description: "Generate reference images for characters and locations inside plotwell.", youtubeId: "WEmh5BUODyQ" },
  { format: "desktop", id: "storyboard",    label: "Storyboard with AI",              description: "Turn your script into a visual storyboard in minutes.", youtubeId: "OfmYVuiXAGs" },
  { format: "desktop", id: "script-doctor", label: "Script Doctor",                   description: "Automatically detect pacing issues, continuity errors, and formatting problems.", youtubeId: "" },
  { format: "desktop", id: "treatment",     label: "Generate Treatment",              description: "Turn your finished script into a professional treatment with one click.", youtubeId: "" },
  { format: "desktop", id: "production",    label: "Production Planning",             description: "Breakdowns, call sheets, stripboards, and budgets — all connected to your script.", youtubeId: "" },
  // ── Mobile demos ──────────────────────────────────────────────────────────
  { format: "mobile",  id: "mobile-overview",   label: "App Overview (mobile)",       description: "Quick walkthrough of the mobile experience — script view, nav, and AI panel.", youtubeId: "" },
  { format: "mobile",  id: "mobile-script",     label: "Script Editor (mobile)",      description: "Writing a scene on mobile — keyboard, toolbar, and element switching.", youtubeId: "" },
  { format: "mobile",  id: "mobile-storyboard", label: "Storyboard (mobile)",         description: "Scrolling through storyboard panels and tapping into panel detail.", youtubeId: "" },
];

// ─────────────────────────────────────────────
//  Window size presets
// ─────────────────────────────────────────────

interface SizePreset { label: string; w: number; h: number }

const SIZE_PRESETS: SizePreset[] = [
  { label: "1920 × 1080  (Full HD)", w: 1920, h: 1080 },
  { label: "1440 × 900   (iMac)",    w: 1440, h: 900  },
  { label: "1366 × 768   (Laptop)",  w: 1366, h: 768  },
  { label: "1280 × 800   (MacBook)", w: 1280, h: 800  },
  { label: "2560 × 1440  (2K)",      w: 2560, h: 1440 },
];

const MOBILE_PRESETS: SizePreset[] = [
  { label: "390 × 844   (iPhone 14 Pro)", w: 390, h: 844 },
  { label: "375 × 812   (iPhone SE 3)",   w: 375, h: 812 },
  { label: "414 × 896   (iPhone 11)",     w: 414, h: 896 },
  { label: "360 × 800   (Android M)",     w: 360, h: 800 },
];

// ─────────────────────────────────────────────
//  Storage
// ─────────────────────────────────────────────

const CAPTURES_KEY              = "pw-media-captures";
const THUMBNAILS_KEY            = "pw-media-thumbnails";
const THUMBNAIL_SUBJECTS_KEY    = "pw-media-th-subjects";
const THUMBNAIL_SUBJECT_CAPS_KEY = "pw-media-th-caps";
const CUSTOM_SLOTS_KEY          = "pw-media-custom-slots";
const CUSTOM_VIDEOS_KEY    = "pw-media-custom-videos";
const VIDEO_IDS_KEY        = "pw-media-video-ids";
const RECORDINGS_KEY       = "pw-media-recordings"; // metadata only, blobs held in memory
const AI_TOKEN_KEY         = "pw-media-ai-token";   // user's JWT for local backend AI calls
const SAVED_BGS_KEY        = "pw-media-saved-bgs";  // saved AI backgrounds for reuse

function load<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
}
function save(key: string, val: unknown) { localStorage.setItem(key, JSON.stringify(val)); }

interface SavedBg {
  id: string;
  thumbnail: string; // 320px wide JPEG base64 for gallery display
  fullRes: string;   // full-resolution JPEG base64 for reuse
  label: string;
  formatId: string;
  createdAt: string;
}

const MAX_SAVED_BGS = 15;

// ─────────────────────────────────────────────
//  Canvas / export utilities
// ─────────────────────────────────────────────

const EXPORT_SIZES = [
  { width: 1920, suffix: "",    label: "Full · 1920px" },
  { width: 1024, suffix: "-md", label: "Medium · 1024px" },
  { width: 640,  suffix: "-sm", label: "Small · 640px" },
];

async function captureFrame(stream: MediaStream): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.onloadedmetadata = () =>
      video.play().then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.createElement("canvas");
            c.width = video.videoWidth;
            c.height = video.videoHeight;
            c.getContext("2d")!.drawImage(video, 0, 0);
            stream.getTracks().forEach(t => t.stop());
            video.srcObject = null;
            resolve(c);
          })
        )
      );
    video.onerror = reject;
  });
}

async function resizeToWebP(src: HTMLCanvasElement, w: number): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = w; c.height = Math.round(src.height * (w / src.width));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) =>
    c.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/webp", 0.92)
  );
}

async function resizeToJpeg(src: HTMLCanvasElement, w: number, h: number): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(src, 0, 0, w, h);
  return new Promise((res, rej) =>
    c.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", 0.92)
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Text overlay ──

interface TextOverlay {
  line1: string;
  line2: string;
  size: number;
  color: string;          // headline color
  line2color: string;     // subtitle color (defaults to headline color)
  position: "top" | "center" | "bottom";
  align: "left" | "center" | "right";
  bold: boolean;
  shadow: boolean;
  shadowOpacity: number;  // 0-1
  shadowSize: number;     // blur multiplier 0.5-3
  stroke: boolean;
  strokeColor: string;    // outline color
  strokeWidth: number;    // width multiplier 0.5-4
  uppercase: boolean;
  fontFamily: string;
  letterSpacing: number;
  lineHeight: number;
  textBg: boolean;
  textBgColor: string;    // rgba() string
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Plotwell",     value: "'Plus Jakarta Sans', Inter, system-ui, sans-serif" },
  { label: "Impact",       value: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { label: "Arial Black",  value: "'Arial Black', Gadget, sans-serif" },
  { label: "Inter",        value: "Inter, system-ui, -apple-system, sans-serif" },
  { label: "Georgia",      value: "Georgia, 'Times New Roman', serif" },
  { label: "Courier",      value: "'Courier New', Courier, monospace" },
];

const DEFAULT_OVERLAY: TextOverlay = {
  line1: "", line2: "", size: 1,
  color: "#ffffff", line2color: "",
  position: "bottom", align: "center",
  bold: true,
  shadow: true, shadowOpacity: 0.80, shadowSize: 1,
  stroke: false, strokeColor: "#000000", strokeWidth: 1,
  uppercase: false,
  fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
  letterSpacing: 0, lineHeight: 1.3,
  textBg: false, textBgColor: "rgba(0,0,0,0.60)",
};
function renderTextOnCanvas(src: HTMLCanvasElement, ov: TextOverlay): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  if (!ov.line1.trim() && !ov.line2.trim()) return c;

  const base = Math.round(src.width * 0.055 * ov.size);
  const align = ov.align ?? "center";
  const fontFamily = ov.fontFamily || "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif";
  ctx.textBaseline = "middle";

  const rawLines = [ov.line1.trim(), ov.line2.trim()].filter(Boolean);
  const lines = ov.uppercase ? rawLines.map(l => l.toUpperCase()) : rawLines;

  const lineHMult = ov.lineHeight ?? 1.3;
  const lineH = base * lineHMult;
  const totalH = lineH * lines.length;
  const pad = src.width * 0.06;
  const cx = align === "left" ? pad : align === "right" ? src.width - pad : src.width / 2;
  const maxW = src.width - pad * 2;
  const baseY = ov.position === "top" ? src.height * 0.10
              : ov.position === "bottom" ? src.height * 0.88 - totalH
              : src.height / 2 - totalH / 2;

  const letterSpacingPx = ov.letterSpacing ?? 0;

  lines.forEach((text, i) => {
    const fs = i === 0 ? base : Math.round(base * 0.72);
    const weight = (ov.bold && i === 0) ? "900" : ov.bold ? "700" : "600";
    ctx.font = `${weight} ${fs}px ${fontFamily}`;
    const ty = baseY + lineH * i + lineH / 2;

    // Per-line color: subtitle uses line2color if set
    const lineColor = (i === 1 && ov.line2color) ? ov.line2color : ov.color;

    // Text background pill
    if (ov.textBg) {
      const measuredW = letterSpacingPx > 0
        ? measureSpacedTextWidth(ctx, text, letterSpacingPx)
        : ctx.measureText(text).width;
      const textW = Math.min(measuredW, maxW);
      const bgPad = fs * 0.28;
      const bgW = textW + bgPad * 2;
      const bgH = fs * 1.4;
      const bgX = align === "left" ? cx - bgPad
                : align === "right" ? cx - textW - bgPad
                : cx - bgW / 2;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = ov.textBgColor ?? "rgba(0,0,0,0.60)";
      ctx.beginPath();
      ctx.roundRect(bgX, ty - bgH / 2, bgW, bgH, bgH / 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw stroke first (outline)
    if (ov.stroke) {
      ctx.save();
      ctx.textAlign = align;
      ctx.shadowColor = "transparent";
      // Parse strokeColor — support hex and rgba; default to near-black
      const sc = ov.strokeColor ?? "#000000";
      ctx.strokeStyle = sc;
      ctx.lineWidth = Math.max(1, fs * 0.09 * (ov.strokeWidth ?? 1));
      ctx.lineJoin = "round";
      if (letterSpacingPx > 0) {
        drawSpacedText(ctx, text, cx, ty, maxW, letterSpacingPx, align, true);
      } else {
        ctx.strokeText(text, cx, ty, maxW);
      }
      ctx.restore();
    }

    // Shadow on fill
    if (ov.shadow) {
      const op = ov.shadowOpacity ?? 0.80;
      const sz = ov.shadowSize ?? 1;
      ctx.shadowColor = `rgba(0,0,0,${op})`;
      ctx.shadowBlur = src.width * 0.011 * sz;
      ctx.shadowOffsetY = src.width * 0.003 * sz;
    } else {
      ctx.shadowColor = "transparent";
    }

    ctx.textAlign = align;
    ctx.fillStyle = lineColor;
    if (letterSpacingPx > 0) {
      drawSpacedText(ctx, text, cx, ty, maxW, letterSpacingPx, align, false);
    } else {
      ctx.fillText(text, cx, ty, maxW);
    }
    ctx.shadowColor = "transparent";
  });
  return c;
}

/** Measure total rendered width of text with manual letter spacing */
function measureSpacedTextWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  const chars = [...text];
  let w = 0;
  chars.forEach(ch => { w += ctx.measureText(ch).width; });
  return w + spacing * Math.max(0, chars.length - 1);
}

/** Draw text with manual letter spacing (canvas has no built-in letterSpacing in older browsers) */
function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number, cy: number,
  maxW: number,
  spacing: number,
  align: "left" | "center" | "right",
  stroke: boolean,
) {
  ctx.save();
  // MUST override textAlign to "left" — we position each char absolutely
  ctx.textAlign = "left";

  const chars = [...text];
  let totalW = 0;
  const widths: number[] = chars.map(ch => { const w = ctx.measureText(ch).width; totalW += w; return w; });
  totalW += spacing * Math.max(0, chars.length - 1);

  const scale = totalW > maxW ? maxW / totalW : 1;
  const effectiveSpacing = spacing * scale;
  const scaledW = totalW * scale;
  const startX = align === "left" ? cx
               : align === "right" ? cx - scaledW
               : cx - scaledW / 2;

  let x = startX;
  chars.forEach((ch, i) => {
    if (stroke) ctx.strokeText(ch, x, cy);
    else ctx.fillText(ch, x, cy);
    x += widths[i] * scale + effectiveSpacing;
  });
  ctx.restore();
}

// ── AI headlines call (hits local backend /api/ai/chat) ──

async function fetchAIHeadlines(topic: string, token: string): Promise<string[]> {
  const res = await fetch("http://localhost:3001/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{
        role: "user",
        content: `Generate 5 short, punchy thumbnail headlines for a video about: "${topic}".
Rules: max 6 words each, no quotes, no emojis, title case, action-oriented.
Return ONLY a JSON array of strings, no explanation.`
      }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  // Support both {reply} and {message}/{content} shapes
  const raw: string = data.reply ?? data.message ?? data.content ?? data.choices?.[0]?.message?.content ?? "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) return JSON.parse(match[0]) as string[];
  // Fallback: split by newline
  return raw.split("\n").map((l: string) => l.replace(/^[-•\d.]+\s*/, "").trim()).filter(Boolean).slice(0, 5);
}

// ── Replicate FLUX image generation ──

function getFluxAspectRatio(format: ThumbnailFormat): string {
  const r = format.width / format.height;
  if (r >= 1.7)  return "16:9";
  if (r >= 1.4)  return "3:2";
  if (r >= 1.1)  return "4:3";
  if (r >= 0.95) return "1:1";
  if (r >= 0.75) return "4:5";
  return "9:16";
}

// Brand kit — each asset stored separately
const BK_LOGO_KEY    = "pw-media-bk-logo";
const BK_PRODUCT_KEY = "pw-media-bk-product";
const BK_STYLE_KEY   = "pw-media-bk-style";
const BK_STRENGTH_KEY = "pw-media-bk-strength";
const BK_COLORS_KEY   = "pw-media-bk-colors";

interface BrandColor { hex: string; name: string; }

interface BrandKit {
  logo:    string; // base64 — composited on final image
  product: string; // base64 — hero screenshot, placed prominently
  style:   string; // base64 — colour/style reference for FLUX img2img
  strength: number; // img2img creativity 0.3–0.95
  colors:  BrandColor[]; // explicit hex colors injected into every prompt
}

// plotwell default palette — user can customise
const DEFAULT_BRAND_COLORS: BrandColor[] = [
  { hex: "#0f172a", name: "Dark Navy" },
  { hex: "#f59e0b", name: "Amber" },
  { hex: "#2563eb", name: "Blue" },
];

// Text-to-image prompts — bold colourful SaaS YouTube thumbnail style
const FLUX_TEXT_PROMPTS = [
  "bold vibrant gradient background, deep navy blue to bright amber orange, dramatic light rays, dynamic energy, SaaS product thumbnail style, no text",
  "explosive colourful burst, dark background with electric amber and blue neon glows, high contrast, professional tech product thumbnail",
  "rich dark gradient, amber gold streaks and blue light beams radiating outward, cinematic depth of field, premium software brand",
  "bold geometric shapes, dark navy and vivid amber yellow, modern abstract composition, vibrant SaaS marketing background",
  "dramatic spotlight on dark stage, amber rim lighting, deep blue shadows, professional product showcase background, no text",
  "striking split background, dark charcoal left half and vivid amber orange right half, sharp contrast, modern brand thumbnail",
];

// Image-to-image prompts — keep brand style but make it bold and colourful
const FLUX_IMG2IMG_PROMPTS = [
  "reimagine as a bold vibrant SaaS thumbnail background using these brand colours, high contrast, dramatic gradients, no text",
  "transform into an energetic YouTube thumbnail background, keep the brand palette, add dramatic light rays and depth",
  "amplify the brand colours into a vivid striking background, deep shadows and bright accent pops, professional product thumbnail",
  "bold product launch thumbnail background inspired by this brand identity, dynamic composition, vivid colour contrast",
  "cinematic SaaS thumbnail background derived from these brand colours, dark base with electric accent glows, premium feel",
  "explosive colourful background in this brand style, amplified saturation, dramatic lighting, YouTube thumbnail quality",
];

/** Quality suffix appended to every AI prompt — drives FLUX toward commercial photography quality */
const QUALITY_SUFFIX = ", professional graphic design, sharp crisp edges, vibrant saturated colors, 4K ultra-sharp, commercial photography, award-winning visual";

/** Downscale a base64 image. Uses PNG for logos (preserves transparency), JPEG for everything else. */
async function resizeBrandRef(base64: string, maxW = 512, fmt: "jpeg" | "png" = "jpeg"): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve(fmt === "png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = base64;
  });
}

/**
 * Remove a solid background colour from a logo PNG using BFS flood-fill.
 *
 * Detection strategy: sample ALL edge pixels (perimeter of the image).
 * Quantise colours to 32×32×32 buckets. The bucket with the highest count
 * is the candidate background. If it covers >= 35% of opaque edge pixels
 * we treat it as a solid background and flood-fill inward from every edge
 * pixel that matches it — far more robust than corner-only sampling.
 *
 * Returns a transparent PNG data URL.  Falls back to original on any error.
 */
async function removeLogoBackground(base64: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onerror = () => resolve(base64);
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const { width: W, height: H } = c;
        const data = ctx.getImageData(0, 0, W, H);
        const px = data.data;

        // ── If image already has meaningful transparency, skip removal ──
        // Sample ~1000 evenly-spaced pixels; if >5% are already transparent, pass through.
        const step = Math.max(1, Math.floor(px.length / (4 * 1000)));
        let transparentCount = 0, sampleCount = 0;
        for (let i = 3; i < px.length; i += 4 * step) { if (px[i] < 20) transparentCount++; sampleCount++; }
        if (sampleCount > 0 && transparentCount / sampleCount > 0.05) {
          resolve(c.toDataURL("image/png")); return;
        }

        // ── Sample corner regions (5×5 at each corner) to detect background colour ──
        // Corner-only sampling is far more reliable than full perimeter because logos
        // often have content (circles, shapes) touching the edges — but corners are almost
        // always background.
        const cs = Math.max(3, Math.min(8, Math.floor(Math.min(W, H) / 20)));
        const cornerIdxs: number[] = [];
        for (let dy = 0; dy < cs; dy++) {
          for (let dx = 0; dx < cs; dx++) {
            cornerIdxs.push(dy * W + dx);              // top-left
            cornerIdxs.push(dy * W + (W - 1 - dx));   // top-right
            cornerIdxs.push((H - 1 - dy) * W + dx);   // bottom-left
            cornerIdxs.push((H - 1 - dy) * W + (W - 1 - dx)); // bottom-right
          }
        }

        // Keep only opaque corner pixels
        const opaqueCorners = cornerIdxs.filter(idx => px[idx * 4 + 3] > 128);
        if (opaqueCorners.length === 0) { resolve(base64); return; } // already transparent

        // Find dominant corner colour via quantised buckets
        const BIN = 24;
        const buckets: Record<string, { r: number; g: number; b: number; count: number }> = {};
        for (const idx of opaqueCorners) {
          const i = idx * 4;
          const key = `${Math.round(px[i]/BIN)},${Math.round(px[i+1]/BIN)},${Math.round(px[i+2]/BIN)}`;
          if (!buckets[key]) buckets[key] = { r: px[i], g: px[i+1], b: px[i+2], count: 0 };
          buckets[key].count++;
        }
        const top = Object.values(buckets).sort((a, b) => b.count - a.count)[0];

        // Require dominant corner colour to cover >= 25% of opaque corner pixels
        // (lower than before because corners may have fewer pixels)
        if (top.count / opaqueCorners.length < 0.25) { resolve(base64); return; }

        const { r: rRef, g: gRef, b: bRef } = top;
        const THRESHOLD = 64; // L1 distance to count as background

        // ── BFS flood-fill seeded from ALL perimeter pixels matching bg colour ──
        // We detect bg using corners but seed from the full perimeter so the fill
        // reaches the entire background, not just what's accessible from corners.
        const perimeterIdx: number[] = [];
        for (let x = 0; x < W; x++) {
          perimeterIdx.push(x);                // top row
          perimeterIdx.push((H - 1) * W + x); // bottom row
        }
        for (let y = 1; y < H - 1; y++) {
          perimeterIdx.push(y * W);            // left col
          perimeterIdx.push(y * W + (W - 1)); // right col
        }

        const visited = new Uint8Array(W * H);
        const queue: number[] = [];

        const isBg = (i: number) => {
          if (px[i + 3] < 20) return true;
          return Math.abs(px[i]-rRef) + Math.abs(px[i+1]-gRef) + Math.abs(px[i+2]-bRef) < THRESHOLD;
        };

        const enqueue = (x: number, y: number) => {
          if (x < 0 || y < 0 || x >= W || y >= H) return;
          const idx = y * W + x;
          if (visited[idx]) return;
          if (!isBg(idx * 4)) return;
          visited[idx] = 1;
          queue.push(idx);
        };

        for (const idx of perimeterIdx) {
          if (!visited[idx] && isBg(idx * 4)) {
            visited[idx] = 1;
            queue.push(idx);
          }
        }

        while (queue.length > 0) {
          const idx = queue.pop()!;
          px[idx * 4 + 3] = 0;
          const x = idx % W, y = Math.floor(idx / W);
          enqueue(x - 1, y); enqueue(x + 1, y);
          enqueue(x, y - 1); enqueue(x, y + 1);
        }

        ctx.putImageData(data, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch {
        resolve(base64);
      }
    };
    img.src = base64;
  });
}

/**
 * Scan canvas edges to detect app chrome (e.g. plotwell TopBar) and scrollbar.
 *
 * Top detection: colour-continuity from row 0.
 *   Compute the average colour of the very first row (the chrome reference).
 *   Keep scanning downward as long as each row's average colour stays "close" to
 *   that reference. The first row whose average deviates significantly = content start.
 *   This is robust: the dark plotwell TopBar stays near its own average until the
 *   bright editor area begins, at which point the scan stops precisely at the boundary.
 *
 * Right detection: last N columns that are highly uniform (scrollbar).
 */
function detectChromeMargins(canvas: HTMLCanvasElement): { top: number; right: number } {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;

  // ── Top chrome ──
  function rowAvg(y: number): [number, number, number] {
    const px = ctx.getImageData(0, y, width, 1).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; }
    return [r / width, g / width, b / width];
  }

  const [rRef, gRef, bRef] = rowAvg(0);
  // Only trim if the first row is visibly dark (a bright first row = no chrome to remove)
  const refLuma = 0.299*rRef + 0.587*gRef + 0.114*bRef;

  let top = 0;
  if (refLuma < 170) {
    // Scan rows while their average colour stays close to the chrome reference.
    // Use a generous threshold (90) so rows with a few icons don't stop the scan early —
    // only the dramatic dark→bright transition at the content boundary triggers the stop.
    const COLOUR_SHIFT = 90;
    const maxTopScan = Math.min(Math.round(height * 0.20), 200);
    for (let y = 1; y < maxTopScan; y++) {
      const [rA, gA, bA] = rowAvg(y);
      if (Math.abs(rA-rRef) + Math.abs(gA-gRef) + Math.abs(bA-bRef) > COLOUR_SHIFT) break;
      top = y + 1;
    }
  }

  // ── Right scrollbar ──
  // Sample a column's worth of pixels; if > 82% agree with a dominant sample → scrollbar
  function isUniformCol(x: number, sampleH: number): boolean {
    const px = ctx.getImageData(x, 0, 1, sampleH).data;
    const mid = Math.floor(sampleH / 2) * 4;
    const [rR, gR, bR] = [px[mid], px[mid+1], px[mid+2]];
    let match = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i]-rR) + Math.abs(px[i+1]-gR) + Math.abs(px[i+2]-bR) < 50) match++;
    }
    return match / sampleH >= 0.82;
  }

  let right = 0;
  const sampleH = Math.min(height, 300);
  for (let x = width - 1; x >= width - 22; x--) {
    if (!isUniformCol(x, sampleH)) break;
    right = width - x;
  }

  return { top, right };
}

/** Generate thumbnail background via Vite proxy → Replicate flux-2-pro (token injected by proxy, no CORS) */
async function generateWithFlux(
  prompt: string,
  format: ThumbnailFormat,
  opts?: { referenceImage?: string; strength?: number },
): Promise<string> {
  const input: Record<string, unknown> = {
    prompt,
    aspect_ratio: getFluxAspectRatio(format),
    output_format: "jpg",
    output_quality: 90,
    safety_tolerance: 5,
    ...(opts?.referenceImage
      ? { image_prompt: opts.referenceImage, image_prompt_strength: opts.strength ?? 0.65 }
      : {}),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replicateToken: string = (import.meta as any).env?.VITE_REPLICATE_API_TOKEN ?? "";

  const res = await fetch("/replicate-api/v1/models/black-forest-labs/flux-2-pro/predictions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${replicateToken}`,
      "Prefer": "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Replicate ${res.status}: ${body}`);
  }

  const data = await res.json() as { status: string; output?: string[] | string; error?: string };
  if (data.status === "failed") throw new Error(`Replicate failed: ${data.error ?? "unknown"}`);

  const url = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!url) throw new Error("No output URL from Replicate");
  return url as string;
}

/** Load a URL into a canvas (handles CORS via img element) */
async function urlToCanvas(url: string, targetW: number, targetH: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = targetW; c.height = targetH;
      c.getContext("2d")!.drawImage(img, 0, 0, targetW, targetH);
      resolve(c);
    };
    img.onerror = () => reject(new Error("Failed to load generated image"));
    img.src = url;
  });
}

/**
 * Scale-and-center-crop a canvas to exactly match a ThumbnailFormat's dimensions.
 * Equivalent to CSS `object-fit: cover` — always fills the target without distortion.
 */
function fitBgToFormat(src: HTMLCanvasElement, fmt: ThumbnailFormat): HTMLCanvasElement {
  const { width: tw, height: th } = fmt;
  const scale = Math.max(tw / src.width, th / src.height);
  const srcW = tw / scale, srcH = th / scale;
  const srcX = (src.width  - srcW) / 2;
  const srcY = (src.height - srcH) / 2;
  const c = document.createElement("canvas");
  c.width = tw; c.height = th;
  c.getContext("2d")!.drawImage(src, srcX, srcY, srcW, srcH, 0, 0, tw, th);
  return c;
}

/**
 * Wrap a screenshot canvas in a browser chrome (dark bar + traffic lights + address bar).
 * Returns a new canvas that is taller by the chrome bar height.
 */
function wrapInBrowserMockup(src: HTMLCanvasElement): HTMLCanvasElement {
  const barH = Math.round(src.width * 0.044);
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height + barH;
  const ctx = out.getContext("2d")!;

  // Chrome bar
  ctx.fillStyle = "#1a1f2e";
  ctx.fillRect(0, 0, out.width, barH);

  // Separator line
  ctx.fillStyle = "#2d3748";
  ctx.fillRect(0, barH - 1, out.width, 1);

  // Traffic light dots
  const dotR = Math.round(barH * 0.21);
  const dotY = barH / 2;
  const dotColors = ["#ff5f57", "#ffbd2e", "#28ca41"];
  dotColors.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(barH * (0.7 + i * 1.1), dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
  });

  // Address bar pill
  const aX = barH * 4.2;
  const aW = Math.round(out.width * 0.44);
  const aH = Math.round(barH * 0.50);
  ctx.fillStyle = "#2d3748";
  ctx.beginPath();
  ctx.roundRect(aX, dotY - aH / 2, aW, aH, aH / 2);
  ctx.fill();

  // Lock dot inside address bar
  ctx.fillStyle = "#4a5568";
  ctx.beginPath();
  ctx.arc(aX + aH * 0.6, dotY, dotR * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // URL text placeholder (tiny dots)
  ctx.fillStyle = "#4a5568";
  ctx.fillRect(aX + aH * 1.2, dotY - 1, aW * 0.35, 2);

  // Screenshot below bar
  ctx.drawImage(src, 0, barH);
  return out;
}

/**
 * Composite a product screenshot as the hero element on the AI background.
 * layout: "left" | "center" | "right"
 * widthFrac: 0.35–0.90 — how wide the product takes relative to canvas width
 */
function compositeOverlay(
  bg: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  layout: "left" | "center" | "right" = "right",
  widthFrac: number = 0.65,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = bg.width; c.height = bg.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bg, 0, 0);

  const mockW = Math.round(bg.width * Math.max(0.35, Math.min(0.90, widthFrac)));
  const mockH = Math.round(overlay.height * (mockW / overlay.width));

  const pad = Math.round(bg.width * 0.03);
  const x = layout === "center"
    ? Math.round((bg.width - mockW) / 2)
    : layout === "right"
    ? bg.width - mockW - pad
    : pad; // left
  const y = Math.max(pad, Math.round((bg.height - mockH) / 2));

  // Radial dark halo behind the product — grounds it in the scene instead of floating
  const haloW = mockW * 1.7;
  const haloH = mockH * 1.5;
  const haloCX = x + mockW / 2;
  const haloCY = y + mockH / 2;
  const haloR = Math.max(haloW, haloH) / 2;
  const grd = ctx.createRadialGradient(haloCX, haloCY, 0, haloCX, haloCY, haloR);
  grd.addColorStop(0, "rgba(0,0,0,0.55)");
  grd.addColorStop(0.6, "rgba(0,0,0,0.20)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(haloCX - haloR, haloCY - haloR, haloR * 2, haloR * 2);

  // Drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = Math.round(bg.width * 0.035);
  ctx.shadowOffsetX = Math.round(bg.width * 0.005);
  ctx.shadowOffsetY = Math.round(bg.width * 0.010);

  // Rounded clip for the screenshot
  const r = Math.round(bg.width * 0.012);
  ctx.beginPath();
  ctx.roundRect(x, y, mockW, mockH, r);
  ctx.clip();
  ctx.shadowColor = "transparent";
  ctx.drawImage(overlay, x, y, mockW, mockH);
  ctx.restore();

  // Subtle border glow
  ctx.save();
  const gr = ctx.createLinearGradient(x, y, x + mockW, y + mockH);
  gr.addColorStop(0, "rgba(245,158,11,0.55)");
  gr.addColorStop(1, "rgba(37,99,235,0.30)");
  ctx.strokeStyle = gr;
  ctx.lineWidth = Math.round(bg.width * 0.0025);
  ctx.beginPath();
  ctx.roundRect(x, y, mockW, mockH, r);
  ctx.stroke();
  ctx.restore();

  return c;
}

function toThumbnail(canvas: HTMLCanvasElement): string {
  const c = document.createElement("canvas");
  c.width = 320; c.height = Math.round(canvas.height / canvas.width * 320);
  c.getContext("2d")!.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function parseSRT(text: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const timeToSec = (t: string) => {
    const [h, m, rest] = t.trim().split(":");
    const [s, ms] = rest.replace(",", ".").split(".");
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? "0").padEnd(3, "0")) / 1000;
  };
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find(l => l.includes("-->"));
    if (!timeLine) continue;
    const [start, end] = timeLine.split("-->").map(timeToSec);
    const textLines = lines.slice(lines.indexOf(timeLine) + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (textLines) entries.push({ id: crypto.randomUUID(), start, end, text: textLines });
  }
  return entries;
}

function toSRT(entries: SubtitleEntry[]): string {
  return entries
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((e, i) => {
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
      };
      return `${i + 1}\n${fmt(e.start)} --> ${fmt(e.end)}\n${e.text}`;
    })
    .join("\n\n");
}

// ─────────────────────────────────────────────
//  Tiny shared UI
// ─────────────────────────────────────────────

function Badge({ color, children }: { color: "green" | "amber" | "gray" | "red" | "blue"; children: React.ReactNode }) {
  const cls = { green: "bg-green-100 text-green-700", amber: "bg-amber-100 text-amber-700", gray: "bg-gray-100 text-gray-500", red: "bg-red-100 text-red-600", blue: "bg-blue-100 text-blue-700" }[color];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>;
}

function Btn({ onClick, disabled, variant = "primary", className = "", children }: {
  onClick?: () => void; disabled?: boolean; variant?: "primary" | "outline" | "ghost" | "danger" | "red";
  className?: string; children: React.ReactNode;
}) {
  const vars = {
    primary: "bg-amber-500 hover:bg-amber-600 text-white",
    outline: "border border-gray-200 bg-white hover:bg-gray-50 text-gray-700",
    ghost: "hover:bg-gray-100 text-gray-600",
    danger: "border border-red-200 bg-white hover:bg-red-50 text-red-600",
    red: "bg-red-500 hover:bg-red-600 text-white",
  };
  return (
    <button className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${vars[variant]} ${className}`}
      onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────
//  Window size launcher
// ─────────────────────────────────────────────

function SizeLauncher({ section, device }: { section?: string; device?: "desktop" | "mobile" }) {
  const presets = device === "mobile" ? MOBILE_PRESETS : SIZE_PRESETS;
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"normal" | "appmode">("appmode");
  const [copied, setCopied] = useState(false);
  const preset = presets[selected];

  const url = section ? `http://localhost:5173?section=${section}` : "http://localhost:5173";

  // Chrome --app mode: no URL bar, no tabs, no bookmarks — pure page content
  // --user-data-dir forces a new isolated Chrome process so --window-size is respected.
  const appModeCmd = `cmd /c start chrome --app="${url}" --user-data-dir="%TEMP%\\pw-media" --window-size=${preset.w},${preset.h} --window-position=0,0`;

  const launchNormal = () => {
    window.open(url, "_blank", `width=${preset.w},height=${preset.h},left=0,top=0`);
  };

  const copyCmd = async () => {
    await navigator.clipboard.writeText(appModeCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="w-4 h-4 text-blue-600" />
          <p className="text-xs font-semibold text-blue-700">Open app</p>
        </div>
        {/* Mode toggle */}
        <div className="flex items-center gap-1 bg-white border border-blue-200 rounded-lg p-0.5">
          {(["appmode", "normal"] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer ${mode === m ? "bg-blue-100 text-blue-700" : "text-gray-400 hover:text-gray-600"}`}>
              {m === "appmode" ? "App mode" : "Normal"}
            </button>
          ))}
        </div>
      </div>

      {/* Size picker */}
      <select
        className="w-full rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
        value={selected}
        onChange={e => setSelected(Number(e.target.value))}
      >
        {presets.map((p, i) => (
          <option key={i} value={i}>{p.label}</option>
        ))}
      </select>

      {mode === "appmode" ? (
        <>
          <div className="rounded-lg bg-gray-900 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
              <span className="text-[10px] text-gray-400 font-mono">Run in PowerShell / cmd</span>
              <button onClick={copyCmd} className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-white cursor-pointer transition-colors">
                {copied ? <><Check className="w-3 h-3 text-green-400" />Copied</> : <><Copy className="w-3 h-3" />Copy</>}
              </button>
            </div>
            <p className="px-3 py-2.5 text-[10px] font-mono text-green-300 break-all leading-relaxed">{appModeCmd}</p>
          </div>
          <p className="text-[10px] text-blue-600 leading-relaxed">
            Opens an isolated Chrome instance at exactly <strong>{preset.w} × {preset.h}px</strong> with no URL bar, tabs, or bookmarks.
          </p>
        </>
      ) : (
        <>
          <Btn onClick={launchNormal} variant="outline" className="w-full justify-center">
            <ExternalLink className="w-3.5 h-3.5" />
            Open in browser ({preset.w}×{preset.h})
          </Btn>
          <p className="text-[10px] text-blue-600">Normal browser window — you'll need to crop the URL bar manually.</p>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Capture modal (screenshots)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  Crop tool
// ─────────────────────────────────────────────

interface CropRect { x: number; y: number; w: number; h: number }
type Handle = "top" | "bottom" | "left" | "right";

function cropCanvas(src: HTMLCanvasElement, crop: CropRect): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(crop.w);
  c.height = Math.round(crop.h);
  c.getContext("2d")!.drawImage(src, -Math.round(crop.x), -Math.round(crop.y));
  return c;
}


function CropTool({ raw, onApply, onBack }: {
  raw: HTMLCanvasElement;
  onApply: (cropped: HTMLCanvasElement) => void;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Track container width via ResizeObserver so scale is always accurate.
  // We start at 0 and show overlays only once measured (avoids wrong first render).
  const [containerW, setContainerW] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [crop, setCrop] = useState<CropRect>({
    x: 0, y: 31, w: raw.width - 16, h: raw.height - 31,
  });
  const dragRef = useRef<{ handle: Handle; startMouse: number; startCrop: CropRect } | null>(null);

  const scale = containerW > 0 ? containerW / raw.width : 1;

  // Scale: displayed pixels per image pixel (read live for drag delta calculations)
  const getScale = useCallback(() => {
    if (!containerRef.current) return scale;
    return containerRef.current.clientWidth / raw.width;
  }, [raw.width, scale]);

  const onMouseDown = useCallback((handle: Handle) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      handle,
      startMouse: handle === "left" || handle === "right" ? e.clientX : e.clientY,
      startCrop: { ...crop },
    };
  }, [crop]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { handle, startMouse, startCrop } = dragRef.current;
      const scale = getScale();
      const isHoriz = handle === "left" || handle === "right";
      const delta = ((isHoriz ? e.clientX : e.clientY) - startMouse) / scale;
      setCrop(prev => {
        const c = { ...prev };
        if (handle === "top") {
          const newY = Math.max(0, Math.min(startCrop.y + delta, startCrop.y + startCrop.h - 10));
          c.h = startCrop.h - (newY - startCrop.y);
          c.y = newY;
        } else if (handle === "bottom") {
          c.h = Math.max(10, Math.min(startCrop.h + delta, raw.height - startCrop.y));
        } else if (handle === "left") {
          const newX = Math.max(0, Math.min(startCrop.x + delta, startCrop.x + startCrop.w - 10));
          c.w = startCrop.w - (newX - startCrop.x);
          c.x = newX;
        } else if (handle === "right") {
          c.w = Math.max(10, Math.min(startCrop.w + delta, raw.width - startCrop.x));
        }
        return c;
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [getScale, raw.height, raw.width]);

  // Displayed positions of crop edges (only meaningful once containerW is measured)
  const displayH = Math.round(raw.height * scale);
  const top    = Math.round(crop.y * scale);
  const bottom = Math.round((crop.y + crop.h) * scale);
  const left   = Math.round(crop.x * scale);
  const right  = Math.round((crop.x + crop.w) * scale);

  const HANDLE_THICK = 4;
  const HANDLE_HIT   = 20;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">Drag the handles to exclude browser chrome. Dimmed areas will be cropped out.</p>
        <span className="text-[11px] font-mono text-gray-400 shrink-0">
          {Math.round(crop.w)} × {Math.round(crop.h)} px
        </span>
      </div>

      {/* Image + crop overlay.
          aspectRatio lets CSS own the height — no JS feedback loop.
          Overlays are hidden until containerW is measured to avoid misplaced handles on first paint. */}
      <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg border border-gray-200 select-none"
        style={{ aspectRatio: `${raw.width} / ${raw.height}` }}>
        <img src={raw.toDataURL("image/jpeg", 0.75)} alt="Capture" className="w-full h-full object-cover block" draggable={false} />

        {containerW > 0 && (<>
        {/* Dimmed areas */}
        <div className="absolute inset-0 pointer-events-none">
          {/* top dim */}
          <div className="absolute left-0 right-0 top-0 bg-black/50" style={{ height: top }} />
          {/* bottom dim */}
          <div className="absolute left-0 right-0 bottom-0 bg-black/50" style={{ height: displayH - bottom }} />
          {/* left dim */}
          <div className="absolute left-0 bg-black/50" style={{ width: left, top, height: bottom - top }} />
          {/* right dim */}
          <div className="absolute right-0 bg-black/50" style={{ width: containerW - right, top, height: bottom - top }} />
        </div>

        {/* Crop border */}
        <div className="absolute pointer-events-none border-2 border-amber-400" style={{ top, left, width: right - left, height: bottom - top }} />

        {/* Top handle */}
        <div className="absolute left-0 right-0 flex items-center justify-center cursor-ns-resize z-10"
          style={{ top: top - HANDLE_HIT / 2, height: HANDLE_HIT }}
          onMouseDown={onMouseDown("top")}>
          <div className="w-12 rounded-full bg-amber-400 shadow-md" style={{ height: HANDLE_THICK }} />
        </div>
        {/* Bottom handle */}
        <div className="absolute left-0 right-0 flex items-center justify-center cursor-ns-resize z-10"
          style={{ top: bottom - HANDLE_HIT / 2, height: HANDLE_HIT }}
          onMouseDown={onMouseDown("bottom")}>
          <div className="w-12 rounded-full bg-amber-400 shadow-md" style={{ height: HANDLE_THICK }} />
        </div>
        {/* Left handle */}
        <div className="absolute flex items-center justify-center cursor-ew-resize z-10"
          style={{ left: left - HANDLE_HIT / 2, width: HANDLE_HIT, top, height: bottom - top }}
          onMouseDown={onMouseDown("left")}>
          <div className="h-12 rounded-full bg-amber-400 shadow-md" style={{ width: HANDLE_THICK }} />
        </div>
        {/* Right handle */}
        <div className="absolute flex items-center justify-center cursor-ew-resize z-10"
          style={{ left: right - HANDLE_HIT / 2, width: HANDLE_HIT, top, height: bottom - top }}
          onMouseDown={onMouseDown("right")}>
          <div className="h-12 rounded-full bg-amber-400 shadow-md" style={{ width: HANDLE_THICK }} />
        </div>
        </>)}
      </div>

      {/* Numeric inputs as secondary controls */}
      <div className="grid grid-cols-4 gap-2 text-center">
        {(["top","bottom","left","right"] as Handle[]).map(h => {
          const val = h === "top" ? Math.round(crop.y)
            : h === "bottom" ? Math.round(raw.height - crop.y - crop.h)
            : h === "left" ? Math.round(crop.x)
            : Math.round(raw.width - crop.x - crop.w);
          const label = { top: "Crop top", bottom: "Crop bottom", left: "Crop left", right: "Crop right" }[h];
          return (
            <div key={h}>
              <p className="text-[10px] text-gray-400 mb-1">{label}</p>
              <input type="number" min={0} value={val}
                onChange={e => {
                  const n = Math.max(0, Number(e.target.value));
                  setCrop(c => {
                    if (h === "top")    return { ...c, y: n, h: raw.height - n - (raw.height - c.y - c.h) };
                    if (h === "bottom") return { ...c, h: raw.height - c.y - n };
                    if (h === "left")   return { ...c, x: n, w: raw.width - n - (raw.width - c.x - c.w) };
                    return { ...c, w: raw.width - c.x - n };
                  });
                }}
                className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-1">
        <Btn variant="outline" onClick={onBack}><Camera className="w-3.5 h-3.5" />Recapture</Btn>
        <Btn onClick={() => onApply(cropCanvas(raw, crop))}><Check className="w-3.5 h-3.5" />Apply crop</Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Thumbnail crop tool (aspect-ratio locked)
// ─────────────────────────────────────────────

function ThumbnailCropTool({ raw, format, onApply, onBack }: {
  raw: HTMLCanvasElement;
  format: ThumbnailFormat;
  onApply: (cropped: HTMLCanvasElement) => void;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current; if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const ar = format.width / format.height;

  const initCrop = useCallback((): CropRect => {
    // Largest crop that fits the raw image at the target aspect ratio, centered
    const imgAr = raw.width / raw.height;
    let w: number, h: number;
    if (imgAr > ar) { h = raw.height; w = h * ar; }
    else             { w = raw.width;  h = w / ar; }
    return { x: Math.round((raw.width - w) / 2), y: Math.round((raw.height - h) / 2), w: Math.round(w), h: Math.round(h) };
  }, [raw, ar]);

  const [crop, setCrop] = useState<CropRect>(initCrop);
  const [sizeT, setSizeT] = useState(1); // 0 = smallest, 1 = largest
  const dragRef    = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const cornerDragRef = useRef<{ corner: "tl"|"tr"|"bl"|"br"; sx: number; sy: number; startCrop: CropRect } | null>(null);

  const maxCropW = ar >= raw.width / raw.height ? Math.min(raw.width, raw.height * ar) : raw.width;
  const minCropW = maxCropW * 0.3;

  const getScale = useCallback(() =>
    containerRef.current ? containerRef.current.clientWidth / raw.width : (containerW > 0 ? containerW / raw.width : 1),
  [raw.width, containerW]);

  const onBoxDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, cx: crop.x, cy: crop.y };
  }, [crop]);

  const onCornerDown = (corner: "tl"|"tr"|"bl"|"br") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cornerDragRef.current = { corner, sx: e.clientX, sy: e.clientY, startCrop: { ...crop } };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = getScale();

      // ── Corner resize (AR-locked) ──
      if (cornerDragRef.current) {
        const { corner, sx, sy, startCrop } = cornerDragRef.current;
        const dx = (e.clientX - sx) / s;
        const dy = (e.clientY - sy) / s;
        // Sign: positive delta means "grow" for br, "shrink" for tl, etc.
        const signX = (corner === "br" || corner === "tr") ? 1 : -1;
        const signY = (corner === "br" || corner === "bl") ? 1 : -1;
        // Use the dominant axis to drive resize
        const delta = (Math.abs(dx) > Math.abs(dy))
          ? signX * dx
          : signY * dy * ar; // dy scaled to width equivalent
        let newW = Math.max(minCropW, Math.min(maxCropW, startCrop.w + delta));
        let newH = Math.round(newW / ar);
        // Keep the OPPOSITE corner fixed
        let newX = corner === "tl" || corner === "bl"
          ? startCrop.x + startCrop.w - newW
          : startCrop.x;
        let newY = corner === "tl" || corner === "tr"
          ? startCrop.y + startCrop.h - newH
          : startCrop.y;
        // Clamp to raw bounds
        newX = Math.max(0, Math.min(raw.width - newW, newX));
        newY = Math.max(0, Math.min(raw.height - newH, newY));
        newW = Math.round(newW); newH = Math.round(newW / ar);
        setCrop({ x: newX, y: newY, w: newW, h: newH });
        setSizeT(Math.max(0, Math.min(1, (newW - minCropW) / (maxCropW - minCropW))));
        return;
      }

      // ── Box drag (move) ──
      if (!dragRef.current) return;
      const s2 = getScale();
      setCrop(c => ({
        ...c,
        x: Math.max(0, Math.min(raw.width  - c.w, dragRef.current!.cx + (e.clientX - dragRef.current!.sx) / s2)),
        y: Math.max(0, Math.min(raw.height - c.h, dragRef.current!.cy + (e.clientY - dragRef.current!.sy) / s2)),
      }));
    };
    const onUp = () => { dragRef.current = null; cornerDragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [getScale, raw, ar, minCropW, maxCropW]);

  // Apply a manual trim (pixels to skip from top / right of raw image)
  const applyManualTrim = useCallback((trimTop: number, trimRight: number) => {
    const t = Math.max(0, Math.min(trimTop,  Math.round(raw.height * 0.5)));
    const r = Math.max(0, Math.min(trimRight, Math.round(raw.width  * 0.4)));
    const availW = raw.width  - r;
    const availH = raw.height - t;
    let w: number, h: number;
    if (availW / availH > ar) { h = availH; w = h * ar; }
    else { w = availW; h = w / ar; }
    w = Math.round(Math.min(w, maxCropW));
    h = Math.round(w / ar);
    const x = Math.round((availW - w) / 2);
    setCrop({ x, y: t, w, h });
    setSizeT(Math.max(0, Math.min(1, (w - minCropW) / (maxCropW - minCropW))));
    setTrimmed(true);
  }, [raw, ar, maxCropW, minCropW]);

  // Size slider: 0 = 30% of max, 1 = max fill
  const handleSize = (t: number) => {
    setSizeT(t);
    const w = Math.round(minCropW + (maxCropW - minCropW) * t);
    const h = Math.round(w / ar);
    setCrop(c => ({
      w, h,
      x: Math.max(0, Math.min(raw.width  - w, Math.round(c.x + (c.w - w) / 2))),
      y: Math.max(0, Math.min(raw.height - h, Math.round(c.y + (c.h - h) / 2))),
    }));
  };

  const scale = containerW > 0 ? containerW / raw.width : 1;
  const cx = Math.round(crop.x * scale), cy = Math.round(crop.y * scale);
  const cw = Math.round(crop.w * scale), ch = Math.round(crop.h * scale);
  const dh = Math.round(raw.height * scale);

  const applyCrop = () => {
    const c = document.createElement("canvas");
    c.width = Math.round(crop.w); c.height = Math.round(crop.h);
    c.getContext("2d")!.drawImage(raw, -Math.round(crop.x), -Math.round(crop.y));
    onApply(c);
  };

  // Auto-trim: scan raw canvas edges for browser chrome and scrollbar
  const [trimmed, setTrimmed] = useState(false);
  const autoTrim = useCallback(() => {
    const margins = detectChromeMargins(raw);
    if (margins.top === 0 && margins.right === 0) { setTrimmed(true); return; }
    // Push crop down by detected top margin, pull in from right
    const availW = raw.width - margins.right;
    const availH = raw.height - margins.top;
    // Keep same AR — compute max crop box inside available area
    let w: number, h: number;
    if (availW / availH > ar) { h = availH; w = h * ar; }
    else { w = availW; h = w / ar; }
    w = Math.round(Math.min(w, maxCropW));
    h = Math.round(w / ar);
    const x = Math.round((availW - w) / 2); // center horizontally within safe area
    const y = margins.top;                  // start just below chrome
    setCrop({ x, y, w, h });
    setSizeT(1);
    setTrimmed(true);
  }, [raw, ar, maxCropW]);

  // Derived trim values (live from crop state — shown in manual inputs)
  const trimTop   = Math.round(crop.y);
  const trimRight = Math.max(0, raw.width - Math.round(crop.x + crop.w));

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-gray-500 shrink-0">Drag to move · drag corners to resize · zoom slider below.</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={autoTrim}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${trimmed ? "border-green-300 bg-green-50 text-green-700" : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
            {trimmed ? <><Check className="w-3 h-3" />Trimmed</> : <><Scissors className="w-3 h-3" />Auto-trim</>}
          </button>
          <span className="text-[11px] font-mono text-gray-400">{format.width}×{format.height}</span>
        </div>
      </div>

      {/* Manual trim inputs */}
      <div className="grid grid-cols-4 gap-2">
        {([
          ["Top trim", trimTop,   (v: number) => applyManualTrim(v, trimRight)],
          ["Right trim", trimRight, (v: number) => applyManualTrim(trimTop, v)],
          ["Crop X",  Math.round(crop.x), (v: number) => setCrop(c => ({ ...c, x: Math.max(0, Math.min(raw.width - c.w, v)) }))],
          ["Crop Y",  Math.round(crop.y), (v: number) => setCrop(c => ({ ...c, y: Math.max(0, Math.min(raw.height - c.h, v)) }))],
        ] as [string, number, (v: number) => void][]).map(([label, val, handler]) => (
          <div key={label}>
            <p className="text-[10px] text-gray-400 mb-1">{label}</p>
            <input type="number" min={0} value={val}
              onChange={e => handler(Math.max(0, Number(e.target.value)))}
              className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </div>
        ))}
      </div>

      {/* Crop preview */}
      <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg border border-gray-200 select-none"
        style={{ aspectRatio: `${raw.width} / ${raw.height}` }}>
        <img src={raw.toDataURL("image/jpeg", 0.75)} alt="Capture" className="w-full h-full object-cover block" draggable={false} />
        {containerW > 0 && (<>
          {/* Dim outside crop box */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-0 right-0 top-0 bg-black/60" style={{ height: cy }} />
            <div className="absolute left-0 right-0 bottom-0 bg-black/60" style={{ height: dh - cy - ch }} />
            <div className="absolute bg-black/60" style={{ left: 0, width: cx, top: cy, height: ch }} />
            <div className="absolute bg-black/60" style={{ right: 0, width: containerW - cx - cw, top: cy, height: ch }} />
          </div>
          {/* Draggable + resizable crop box */}
          <div className="absolute border-2 border-amber-400 cursor-move"
            style={{ left: cx, top: cy, width: cw, height: ch }}
            onMouseDown={onBoxDown}>
            {/* Rule-of-thirds guides */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-1/3 left-0 right-0 border-t border-white/20" />
              <div className="absolute top-2/3 left-0 right-0 border-t border-white/20" />
              <div className="absolute left-1/3 top-0 bottom-0 border-l border-white/20" />
              <div className="absolute left-2/3 top-0 bottom-0 border-l border-white/20" />
            </div>
            {/* Corner resize handles */}
            {(["tl","tr","bl","br"] as const).map(corner => (
              <div
                key={corner}
                className={`absolute w-4 h-4 border-amber-400 border-2 bg-white rounded-sm z-10
                  ${corner === "tl" ? "top-0 left-0 -translate-x-px -translate-y-px cursor-nw-resize"
                  : corner === "tr" ? "top-0 right-0 translate-x-px -translate-y-px cursor-ne-resize"
                  : corner === "bl" ? "bottom-0 left-0 -translate-x-px translate-y-px cursor-sw-resize"
                  :                   "bottom-0 right-0 translate-x-px translate-y-px cursor-se-resize"}`}
                onMouseDown={onCornerDown(corner)}
              />
            ))}
          </div>
        </>)}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[10px] text-gray-400 shrink-0">Size</span>
        <input type="range" min={0} max={1} step={0.01} value={sizeT}
          onChange={e => handleSize(Number(e.target.value))} className="flex-1 accent-amber-500" />
        <span className="text-[10px] font-mono text-gray-500 w-20 text-right shrink-0">
          {Math.round(crop.w)} × {Math.round(crop.h)}
        </span>
      </div>

      <div className="flex items-center justify-between pt-1">
        <Btn variant="outline" onClick={onBack}><Camera className="w-3.5 h-3.5" />Recapture</Btn>
        <Btn onClick={applyCrop}><Check className="w-3.5 h-3.5" />Apply crop</Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Thumbnail composer
//  Mental model:
//    Screenshot you captured  =  HERO (placed on background)
//    Brand Kit                =  feeds AI background (style ref + colors)
//    Result                   =  YouTube / Instagram / TikTok thumbnail
// ─────────────────────────────────────────────

type ComposerTab = "bg" | "hero" | "text";

function ThumbnailComposer({ canvas, format, brandKit, onApply, onBack }: {
  canvas: HTMLCanvasElement;
  format: ThumbnailFormat;
  brandKit?: BrandKit;
  onApply: (final: HTMLCanvasElement) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ComposerTab>("bg");
  const [ov, setOv] = useState<TextOverlay>(DEFAULT_OVERLAY);

  // ── AI background ──
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageGenLoading, setImageGenLoading] = useState(false);
  const [imageGenError, setImageGenError] = useState("");
  const [aiBgCanvas, setAiBgCanvas] = useState<HTMLCanvasElement | null>(null);

  // ── Hero controls ──
  const [heroPosition, setHeroPosition] = useState<"left" | "center" | "right">("right");
  const [heroSize, setHeroSize] = useState(0.62);
  const [useMockup, setUseMockup] = useState(true);
  const [showHero, setShowHero] = useState(true);
  const [logoPos, setLogoPos] = useState<"tl" | "tr" | "bl" | "br">("tl");

  // ── Brand kit (derived from props — must come before any useEffect that reads them) ──
  const brandRef = brandKit?.style ?? "";
  const brandStrength = brandKit?.strength ?? 0.65;
  const brandLogo = brandKit?.logo ?? "";
  const brandColors = brandKit?.colors ?? [];
  const colorSuffix = brandColors.length > 0
    ? `, using exact brand colors: ${brandColors.map(c => `${c.name} ${c.hex}`).join(", ")}`
    : "";

  // ── Logo image (pre-loaded for live preview + export) ──
  // Using HTMLImageElement directly (not via canvas intermediary) preserves PNG transparency reliably
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!brandLogo) { setLogoImg(null); return; }
    const img = new window.Image();
    img.onload = () => setLogoImg(img);
    img.src = brandLogo;
  }, [brandLogo]);

  // ── Color picker debounce — only apply after user stops dragging ──
  const [colorDraft, setColorDraft] = useState(ov.color);
  const [line2colorDraft, setLine2colorDraft] = useState(ov.line2color);
  const colorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const line2colorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateColorDebounced = (hex: string) => {
    setColorDraft(hex);
    if (colorTimerRef.current) clearTimeout(colorTimerRef.current);
    colorTimerRef.current = setTimeout(() => setOv(o => ({ ...o, color: hex })), 180);
  };
  const updateLine2ColorDebounced = (hex: string) => {
    setLine2colorDraft(hex);
    if (line2colorTimerRef.current) clearTimeout(line2colorTimerRef.current);
    line2colorTimerRef.current = setTimeout(() => setOv(o => ({ ...o, line2color: hex })), 180);
  };

  // Custom hero image (replaces the captured screenshot as hero)
  const [localHeroCanvas, setLocalHeroCanvas] = useState<HTMLCanvasElement | null>(null);
  const [localHeroPreview, setLocalHeroPreview] = useState("");
  const localHeroRef = useRef<HTMLInputElement>(null);

  const handleHeroUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const b64 = ev.target?.result as string;
      if (!b64) return;
      const img = new window.Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        setLocalHeroCanvas(c);
        setLocalHeroPreview(b64);
      };
      img.src = b64;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // ── AI headlines ──
  const [topic, setTopic] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [headlineLoading, setHeadlineLoading] = useState(false);
  const [headlineError, setHeadlineError] = useState("");
  const [backendToken, setBackendToken] = useState(() => localStorage.getItem(AI_TOKEN_KEY) ?? "");
  const [showBTInput, setShowBTInput] = useState(false);

  const saveBT = (t: string) => { setBackendToken(t); localStorage.setItem(AI_TOKEN_KEY, t); };

  // ── Saved backgrounds gallery ──
  const [savedBgs, setSavedBgs] = useState<SavedBg[]>(() => load<SavedBg[]>(SAVED_BGS_KEY, []));
  const [bgLabel, setBgLabel] = useState("");

  const saveToGallery = useCallback(() => {
    if (!aiBgCanvas) return;
    const thumb = toThumbnail(aiBgCanvas);
    const fullRes = aiBgCanvas.toDataURL("image/jpeg", 0.92);
    const entry: SavedBg = {
      id: crypto.randomUUID(),
      thumbnail: thumb,
      fullRes,
      label: bgLabel.trim() || format.label,
      formatId: format.id,
      createdAt: new Date().toISOString(),
    };
    setSavedBgs(prev => {
      const next = [entry, ...prev].slice(0, MAX_SAVED_BGS);
      try { save(SAVED_BGS_KEY, next); } catch { /* quota */ }
      return next;
    });
    setBgLabel("");
  }, [aiBgCanvas, bgLabel, format]);

  const deleteSavedBg = useCallback((id: string) => {
    setSavedBgs(prev => {
      const next = prev.filter(b => b.id !== id);
      try { save(SAVED_BGS_KEY, next); } catch { /* quota */ }
      return next;
    });
  }, []);

  const loadSavedBg = useCallback((bg: SavedBg) => {
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      setAiBgCanvas(c);
      setTab("hero");
    };
    img.src = bg.fullRes;
  }, []);

  // ── Canvas resolution ──
  // Hero: local upload > captured screenshot
  const heroCanvas = localHeroCanvas ?? canvas;

  // Composited result:
  //   - If AI bg ready: bg + hero (with optional mockup frame) + logo + text
  //   - If no AI bg yet: just the captured screenshot (preview placeholder)
  const getComposited = useCallback((): HTMLCanvasElement => {
    let base: HTMLCanvasElement;
    if (aiBgCanvas) {
      if (showHero) {
        const prod = useMockup ? wrapInBrowserMockup(heroCanvas) : heroCanvas;
        base = compositeOverlay(aiBgCanvas, prod, heroPosition, heroSize);
      } else {
        base = aiBgCanvas;
      }
    } else {
      base = canvas;
    }
    // Overlay logo if preloaded (draw the HTMLImageElement directly — preserves PNG transparency)
    if (logoImg && aiBgCanvas) {
      const out = document.createElement("canvas");
      out.width = base.width; out.height = base.height;
      const ctx = out.getContext("2d")!;
      ctx.drawImage(base, 0, 0);
      const logoW = Math.round(base.width * 0.10);
      const logoH = Math.round(logoImg.naturalHeight * (logoW / logoImg.naturalWidth));
      const pad = Math.round(base.width * 0.025);
      const lx = (logoPos === "tr" || logoPos === "br") ? base.width - logoW - pad : pad;
      const ly = (logoPos === "bl" || logoPos === "br") ? base.height - logoH - pad : pad;
      ctx.drawImage(logoImg, lx, ly, logoW, logoH);
      return out;
    }
    return base;
  }, [aiBgCanvas, showHero, useMockup, heroCanvas, heroPosition, heroSize, canvas, logoImg, logoPos]);

  const preview = renderTextOnCanvas(getComposited(), ov);
  const previewUrl = preview.toDataURL("image/jpeg", 0.8);
  const update = (patch: Partial<TextOverlay>) => setOv(o => ({ ...o, ...patch }));

  // ── Generate AI background ──
  const generateImage = async () => {
    if (!imagePrompt.trim()) { setImageGenError("Enter a prompt first."); return; }
    setImageGenError(""); setImageGenLoading(true); setAiBgCanvas(null);
    try {
      const opts = brandRef ? { referenceImage: brandRef, strength: brandStrength } : undefined;
      const url = await generateWithFlux(imagePrompt + colorSuffix + QUALITY_SUFFIX, format, opts);
      const c = await urlToCanvas(url, format.width, format.height);
      setAiBgCanvas(c);
      setTab("hero"); // auto-switch to Hero tab after bg is ready
    } catch (e: unknown) {
      setImageGenError(e instanceof Error ? e.message : String(e));
    } finally { setImageGenLoading(false); }
  };

  // ── AI headlines ──
  const suggestHeadlines = async () => {
    if (!topic.trim()) { setHeadlineError("Enter a topic first."); return; }
    if (!backendToken.trim()) { setShowBTInput(true); return; }
    setHeadlineError(""); setHeadlineLoading(true); setSuggestions([]);
    try {
      const items = await fetchAIHeadlines(topic, backendToken);
      setSuggestions(items);
    } catch (e: unknown) {
      setHeadlineError(e instanceof Error ? e.message : String(e));
    } finally { setHeadlineLoading(false); }
  };

  // ── Apply & export ──
  const handleApply = () => {
    // getComposited() already includes logo — just add text overlay
    onApply(renderTextOnCanvas(getComposited(), ov));
  };

  const bgPresets = brandRef ? FLUX_IMG2IMG_PROMPTS : FLUX_TEXT_PROMPTS;

  return (
    <div className="space-y-4">

      {/* ── Live preview ── */}
      <div className="rounded-xl overflow-hidden border border-gray-200 bg-gray-950 flex items-center justify-center relative"
        style={{ aspectRatio: `${format.width} / ${format.height}`, maxHeight: "260px" }}>
        {imageGenLoading ? (
          <div className="flex flex-col items-center gap-3 text-gray-400">
            <Loader2 className="w-7 h-7 animate-spin text-amber-500" />
            <span className="text-xs font-medium">Generating with FLUX 2 Pro…</span>
          </div>
        ) : (
          <>
            <img src={previewUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
            {!aiBgCanvas && (
              <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none">
                <span className="text-[10px] text-white/50 bg-black/40 rounded-full px-2.5 py-1">Generate a background below to compose the thumbnail</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Tab bar ── */}
      <div className="flex border border-gray-200 rounded-xl bg-gray-50 p-1 gap-1">
        {([["bg","Background"],["hero","Hero"],["text","Text"]] as [ComposerTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-sm font-medium rounded-lg transition-all cursor-pointer ${tab === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-400 hover:text-gray-700"}`}>
            {label}
            {t === "hero" && aiBgCanvas && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════ Background tab ══════════════════════════════ */}
      {tab === "bg" && (
        <div className="space-y-3">
          {/* Brand kit — what's being used for AI */}
          <div className={`rounded-xl border px-3 py-2.5 flex items-start gap-3 ${brandRef || brandColors.length ? "border-violet-200 bg-violet-50" : "border-dashed border-gray-300 bg-gray-50"}`}>
            {brandRef ? (
              <>
                <img src={brandRef} alt="Style ref" className="w-10 h-10 object-cover rounded-lg border border-violet-200 bg-gray-900 shrink-0" />
                <div>
                  <p className="text-[11px] font-semibold text-violet-800">Brand style active</p>
                  <p className="text-[10px] text-violet-500">img2img — FLUX will stay close to your brand style ({Math.round(brandStrength * 100)}% strength)</p>
                  {brandColors.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {brandColors.map((c, i) => <span key={i} className="w-3 h-3 rounded-full border border-white/50 inline-block" style={{ background: c.hex }} />)}
                      <span className="text-[10px] text-violet-500 ml-1">colors injected</span>
                    </div>
                  )}
                </div>
              </>
            ) : brandColors.length > 0 ? (
              <>
                <div className="flex gap-1 pt-0.5 shrink-0">
                  {brandColors.slice(0, 4).map((c, i) => <span key={i} className="w-4 h-4 rounded-full border border-gray-200" style={{ background: c.hex }} />)}
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-violet-800">Brand colors active</p>
                  <p className="text-[10px] text-violet-500">{brandColors.map(c => c.name).join(", ")} — injected into every prompt</p>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-gray-400">No brand kit — add style reference &amp; colors in the Brand Kit section above for better results.</p>
            )}
          </div>

          {/* Preset chips */}
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">
              {brandRef ? "Mood presets (img2img)" : "Background presets"}
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {bgPresets.map((p, i) => (
                <button key={i} onClick={() => setImagePrompt(p)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-[11px] whitespace-nowrap cursor-pointer transition-colors ${imagePrompt === p ? "border-violet-500 bg-violet-100 text-violet-800" : "border-gray-200 bg-white hover:bg-gray-50 text-gray-600"}`}>
                  {p.slice(0, 34)}{p.length > 34 ? "…" : ""}
                </button>
              ))}
            </div>
          </div>

          {/* Custom prompt */}
          <textarea
            className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
            rows={3}
            placeholder={brandRef ? "Describe the mood, lighting, colours for the background…" : "e.g. cinematic dark studio, glowing amber and blue neon, dramatic lighting"}
            value={imagePrompt}
            onChange={e => setImagePrompt(e.target.value)}
          />

          {imageGenError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{imageGenError}</p>}

          <div className="flex items-center gap-2">
            <button onClick={generateImage} disabled={imageGenLoading || !imagePrompt.trim()}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all">
              {imageGenLoading
                ? <><Loader2 className="w-4 h-4 animate-spin" />Generating background…</>
                : <><Wand2 className="w-4 h-4" />{aiBgCanvas ? "Regenerate" : "Generate background"}</>}
            </button>
            {aiBgCanvas && (
              <button
                onClick={() => {
                  aiBgCanvas.toBlob(b => {
                    if (b) triggerDownload(b, `bg-${format.id}-${Date.now()}.jpg`);
                  }, "image/jpeg", 0.93);
                }}
                title="Download background image"
                className="inline-flex items-center gap-1.5 rounded-xl border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-700 px-3 py-2.5 text-sm font-medium cursor-pointer transition-colors shrink-0">
                <Download className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Save to gallery */}
          {aiBgCanvas && (
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                placeholder={`Name (default: ${format.label})`}
                value={bgLabel}
                onChange={e => setBgLabel(e.target.value)}
                onKeyDown={e => e.key === "Enter" && saveToGallery()}
              />
              <button onClick={saveToGallery}
                className="inline-flex items-center gap-1.5 rounded-xl border border-green-300 bg-green-50 hover:bg-green-100 text-green-700 px-3 py-2 text-sm font-medium cursor-pointer transition-colors shrink-0">
                <Plus className="w-4 h-4" />Save to gallery
              </button>
            </div>
          )}

          {/* Saved backgrounds gallery */}
          {savedBgs.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">Saved backgrounds ({savedBgs.length})</p>
              <div className="grid grid-cols-3 gap-2">
                {savedBgs.map(bg => (
                  <div key={bg.id} className="relative group rounded-lg overflow-hidden border border-gray-200 bg-gray-900 cursor-pointer"
                    style={{ aspectRatio: `${format.width} / ${format.height}` }}
                    onClick={() => loadSavedBg(bg)}>
                    <img src={bg.thumbnail} alt={bg.label} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                      <span className="text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity drop-shadow">Use</span>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); deleteSavedBg(bg.id); }}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500/80 hover:bg-red-600 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                      <X className="w-3 h-3" />
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5">
                      <p className="text-[9px] text-white/80 truncate">{bg.label}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-400 text-center">Your screenshot will be placed as the hero on this background automatically.</p>
        </div>
      )}

      {/* ══════════════════════════════ Hero tab ══════════════════════════════ */}
      {tab === "hero" && (
        <div className="space-y-4">
          {/* Hero image — captured screenshot or custom upload */}
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Hero image (placed on background)</p>
            {localHeroPreview ? (
              <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
                <img src={localHeroPreview} alt="Hero" className="w-20 h-12 object-cover rounded-lg border border-amber-200 bg-gray-900 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-amber-800">Custom image</p>
                  <button onClick={() => localHeroRef.current?.click()} className="text-[10px] text-amber-600 underline cursor-pointer">Replace</button>
                </div>
                <button onClick={() => { setLocalHeroCanvas(null); setLocalHeroPreview(""); }}
                  className="text-amber-300 hover:text-red-400 cursor-pointer shrink-0"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="flex-1 rounded-xl border border-gray-200 bg-gray-50 p-2.5 flex items-center gap-2.5">
                  <img src={canvas.toDataURL("image/jpeg", 0.6)} alt="Captured" className="w-20 h-12 object-cover rounded-lg border border-gray-200 bg-gray-900 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-gray-700">Captured screenshot</p>
                    <p className="text-[10px] text-gray-400">{canvas.width} × {canvas.height}px</p>
                  </div>
                </div>
                <button onClick={() => localHeroRef.current?.click()}
                  className="rounded-xl border-2 border-dashed border-gray-300 hover:border-amber-400 bg-white hover:bg-amber-50 transition-colors cursor-pointer flex flex-col items-center justify-center gap-1 px-3">
                  <Plus className="w-4 h-4 text-gray-400" />
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">Swap image</span>
                </button>
              </div>
            )}
            <input ref={localHeroRef} type="file" accept="image/*" className="hidden" onChange={handleHeroUpload} />
          </div>

          {/* Show hero toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={showHero} onChange={e => setShowHero(e.target.checked)}
              className="w-4 h-4 accent-amber-500 rounded" />
            <span className="text-sm font-semibold text-gray-800">Show hero on background</span>
          </label>

          {showHero && (
            <>
              {/* Browser frame */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={useMockup} onChange={e => setUseMockup(e.target.checked)}
                  className="w-4 h-4 accent-violet-500 rounded" />
                <span className="text-sm text-gray-700">Browser frame mockup</span>
                <span className="text-[10px] bg-violet-100 text-violet-600 rounded-full px-2 py-0.5">recommended</span>
              </label>

              {/* Position */}
              <div>
                <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Hero position</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["left","center","right"] as const).map(l => (
                    <button key={l} onClick={() => setHeroPosition(l)}
                      className={`rounded-xl border py-2 text-sm font-medium cursor-pointer transition-colors ${heroPosition === l ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                      {l === "left" ? "← Left" : l === "center" ? "Center" : "Right →"}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">
                  {heroPosition === "right" ? "Leaves left side free for text overlay" :
                   heroPosition === "left" ? "Leaves right side free for text overlay" :
                   "Full-width hero, text floats on top"}
                </p>
              </div>

              {/* Size */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] text-gray-400 uppercase tracking-wide">Hero size</label>
                  <span className="text-[10px] font-mono text-gray-600 bg-gray-100 rounded px-1.5">{Math.round(heroSize * 100)}%</span>
                </div>
                <input type="range" min={0.35} max={0.90} step={0.01} value={heroSize}
                  onChange={e => setHeroSize(Number(e.target.value))} className="w-full accent-amber-500" />
                <div className="flex justify-between text-[10px] text-gray-300 mt-0.5">
                  <span>Small</span><span>Large</span>
                </div>
              </div>
            </>
          )}

          {/* Logo position */}
          {brandLogo && (
            <div>
              <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Logo corner</label>
              <div className="grid grid-cols-2 gap-1.5">
                {([["tl","↖ Top left"],["tr","Top right ↗"],["bl","↙ Bottom left"],["br","Bottom right ↘"]] as const).map(([pos, label]) => (
                  <button key={pos} onClick={() => setLogoPos(pos)}
                    className={`rounded-xl border py-2 text-sm font-medium cursor-pointer transition-colors ${logoPos === pos ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════ Text tab ══════════════════════════════ */}
      {tab === "text" && (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Headline</label>
            <input className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              placeholder="Main title (large)" value={ov.line1} onChange={e => update({ line1: e.target.value })} />
          </div>
          <div>
            <label className="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Subtitle</label>
            <input className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              placeholder="Supporting text" value={ov.line2} onChange={e => update({ line2: e.target.value })} />
          </div>

          {/* AI headline suggestions */}
          <div className="rounded-xl border border-purple-200 bg-purple-50 p-3 space-y-2">
            <p className="text-[11px] font-semibold text-purple-700">✨ AI suggestions <span className="font-normal opacity-60">(needs local backend)</span></p>
            <div className="flex gap-1.5">
              <input
                className="flex-1 min-w-0 rounded-lg border border-purple-200 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400"
                placeholder="e.g. AI screenplay writing tool"
                value={topic} onChange={e => setTopic(e.target.value)}
                onKeyDown={e => e.key === "Enter" && suggestHeadlines()}
              />
              <button onClick={suggestHeadlines} disabled={headlineLoading}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40 cursor-pointer">
                {headlineLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Go"}
              </button>
            </div>
            {headlineError && (
              <p className="text-xs text-red-600">{headlineError}
                {headlineError.includes("401") && <> — <button onClick={() => setShowBTInput(v => !v)} className="underline cursor-pointer">set token</button></>}
              </p>
            )}
            {showBTInput && (
              <div className="flex gap-1.5">
                <input type="password" className="flex-1 min-w-0 rounded border border-purple-200 bg-white px-2 py-1 text-xs font-mono focus:outline-none"
                  value={backendToken} onChange={e => setBackendToken(e.target.value)} placeholder="eyJ…" />
                <button onClick={() => { saveBT(backendToken); setShowBTInput(false); }}
                  className="px-2 py-1 rounded text-xs bg-purple-600 text-white cursor-pointer">Save</button>
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-1">
                {suggestions.map((s, i) => (
                  <button key={i} onClick={() => update({ line1: s })}
                    className={`w-full text-left rounded-lg px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${ov.line1 === s ? "bg-purple-200 text-purple-900 font-semibold" : "hover:bg-purple-100 text-gray-700"}`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Font family */}
          <div>
            <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Font</label>
            <div className="grid grid-cols-3 gap-1">
              {FONT_OPTIONS.map(f => (
                <button key={f.value} onClick={() => update({ fontFamily: f.value })}
                  className={`rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors truncate px-1 ${ov.fontFamily === f.value ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}
                  style={{ fontFamily: f.value }}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Size + letter spacing */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-gray-400 uppercase tracking-wide">Size</label>
                <span className="text-[10px] font-mono text-gray-500">{Math.round(ov.size * 100)}%</span>
              </div>
              <input type="range" min={0.5} max={2.5} step={0.05} value={ov.size}
                onChange={e => update({ size: Number(e.target.value) })} className="w-full accent-amber-500" />
              <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>S</span><span>XL</span></div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-gray-400 uppercase tracking-wide">Spacing</label>
                <span className="text-[10px] font-mono text-gray-500">{ov.letterSpacing ?? 0}px</span>
              </div>
              <input type="range" min={0} max={16} step={0.5} value={ov.letterSpacing ?? 0}
                onChange={e => update({ letterSpacing: Number(e.target.value) })} className="w-full accent-amber-500" />
              <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>Normal</span><span>Wide</span></div>
            </div>
          </div>

          {/* Line height */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] text-gray-400 uppercase tracking-wide">Line height</label>
              <span className="text-[10px] font-mono text-gray-500">{(ov.lineHeight ?? 1.3).toFixed(1)}×</span>
            </div>
            <input type="range" min={0.9} max={2.2} step={0.05} value={ov.lineHeight ?? 1.3}
              onChange={e => update({ lineHeight: Number(e.target.value) })} className="w-full accent-amber-500" />
            <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>Tight</span><span>Loose</span></div>
          </div>

          {/* Headline color + subtitle color */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Headline color</label>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5">
                <input type="color" value={colorDraft}
                  onChange={e => updateColorDebounced(e.target.value)}
                  onBlur={e => update({ color: e.target.value })}
                  className="w-7 h-7 rounded cursor-pointer border-0 p-0 bg-transparent shrink-0" />
                <span className="text-[11px] font-mono text-gray-500">{colorDraft}</span>
              </div>
              <div className="flex gap-1.5 mt-1.5">
                {["#ffffff","#ffff00","#f59e0b","#ff3b3b","#000000"].map(col => (
                  <button key={col} onClick={() => { setColorDraft(col); update({ color: col }); }}
                    className={`w-5 h-5 rounded-full border-2 cursor-pointer transition-transform hover:scale-110 ${colorDraft === col ? "border-gray-700 scale-110" : "border-gray-200"}`}
                    style={{ background: col }} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Subtitle color</label>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5">
                <input type="color" value={line2colorDraft || colorDraft}
                  onChange={e => updateLine2ColorDebounced(e.target.value)}
                  onBlur={e => update({ line2color: e.target.value })}
                  className="w-7 h-7 rounded cursor-pointer border-0 p-0 bg-transparent shrink-0" />
                <span className="text-[11px] font-mono text-gray-500">{line2colorDraft || "(same)"}</span>
              </div>
              <div className="flex gap-1.5 mt-1.5">
                {["#f59e0b","#60a5fa","#a3e635","#fb7185"].map(col => (
                  <button key={col} onClick={() => { setLine2colorDraft(col); update({ line2color: col }); }}
                    className={`w-5 h-5 rounded-full border-2 cursor-pointer transition-transform hover:scale-110 ${line2colorDraft === col ? "border-gray-700 scale-110" : "border-gray-200"}`}
                    style={{ background: col }} />
                ))}
              </div>
            </div>
          </div>

          {/* Position + alignment */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Position</label>
              <div className="flex gap-1">
                {(["top","center","bottom"] as const).map(p => (
                  <button key={p} onClick={() => update({ position: p })}
                    className={`flex-1 rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors ${ov.position === p ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Align</label>
              <div className="flex gap-1">
                {(["left","center","right"] as const).map(a => (
                  <button key={a} onClick={() => update({ align: a })}
                    className={`flex-1 rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors ${ov.align === a ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                    {a === "left" ? "←" : a === "center" ? "≡" : "→"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Style toggles */}
          <div className="grid grid-cols-4 gap-1.5">
            {([
              ["Bold", "bold"],
              ["Shadow", "shadow"],
              ["Outline", "stroke"],
              ["UPPER", "uppercase"],
            ] as [string, "bold" | "shadow" | "stroke" | "uppercase"][]).map(([label, key]) => (
              <button key={key} onClick={() => update({ [key]: !ov[key] })}
                className={`rounded-xl border py-2 text-sm font-semibold cursor-pointer transition-colors ${ov[key] ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Outline controls */}
          {ov.stroke && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2.5">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Outline settings</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-1.5">Color</label>
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5">
                    <input type="color" value={ov.strokeColor ?? "#000000"}
                      onChange={e => update({ strokeColor: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent shrink-0" />
                    <span className="text-[10px] font-mono text-gray-500">{ov.strokeColor ?? "#000000"}</span>
                  </div>
                  <div className="flex gap-1.5 mt-1.5">
                    {["#000000","#ffffff","#f59e0b","#2563eb"].map(col => (
                      <button key={col} onClick={() => update({ strokeColor: col })}
                        className={`w-5 h-5 rounded-full border-2 cursor-pointer ${(ov.strokeColor??'#000000')===col?"border-gray-700":"border-gray-200"}`}
                        style={{ background: col }} />
                    ))}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] text-gray-400">Width</label>
                    <span className="text-[10px] font-mono text-gray-500">{(ov.strokeWidth??1).toFixed(1)}×</span>
                  </div>
                  <input type="range" min={0.3} max={4} step={0.1} value={ov.strokeWidth??1}
                    onChange={e => update({ strokeWidth: Number(e.target.value) })} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>Thin</span><span>Thick</span></div>
                </div>
              </div>
            </div>
          )}

          {/* Shadow controls */}
          {ov.shadow && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2.5">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Shadow settings</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] text-gray-400">Opacity</label>
                    <span className="text-[10px] font-mono text-gray-500">{Math.round((ov.shadowOpacity??0.8)*100)}%</span>
                  </div>
                  <input type="range" min={0.1} max={1} step={0.05} value={ov.shadowOpacity??0.8}
                    onChange={e => update({ shadowOpacity: Number(e.target.value) })} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>Soft</span><span>Strong</span></div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] text-gray-400">Blur</label>
                    <span className="text-[10px] font-mono text-gray-500">{(ov.shadowSize??1).toFixed(1)}×</span>
                  </div>
                  <input type="range" min={0.2} max={3} step={0.1} value={ov.shadowSize??1}
                    onChange={e => update({ shadowSize: Number(e.target.value) })} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-[10px] text-gray-300 mt-0.5"><span>Tight</span><span>Wide</span></div>
                </div>
              </div>
            </div>
          )}

          {/* Text background */}
          <div className={`rounded-xl border p-3 space-y-2 transition-colors ${ov.textBg ? "border-violet-300 bg-violet-50" : "border-gray-200 bg-gray-50"}`}>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={ov.textBg} onChange={e => update({ textBg: e.target.checked })}
                  className="w-3.5 h-3.5 accent-violet-500" />
                <span className="text-[11px] font-semibold text-gray-700">Text background pill</span>
              </label>
              <span className="text-[10px] text-gray-400">Great for readability</span>
            </div>
            {ov.textBg && (
              <div className="flex gap-2 flex-wrap">
                {[
                  ["Black", "rgba(0,0,0,0.65)"],
                  ["Dark", "rgba(15,23,42,0.80)"],
                  ["Amber", "rgba(217,119,6,0.85)"],
                  ["Blue", "rgba(37,99,235,0.80)"],
                  ["White", "rgba(255,255,255,0.85)"],
                ].map(([label, val]) => (
                  <button key={val} onClick={() => update({ textBgColor: val })}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-medium cursor-pointer border transition-colors ${ov.textBgColor === val ? "border-violet-500 bg-violet-100 text-violet-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <Btn variant="outline" onClick={onBack}><Camera className="w-3.5 h-3.5" />Re-crop</Btn>
        <Btn onClick={handleApply} disabled={!aiBgCanvas}>
          <Check className="w-3.5 h-3.5" />{aiBgCanvas ? "Apply & export" : "Generate background first"}
        </Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Thumbnail capture modal
// ─────────────────────────────────────────────

type ThumbnailPhase = "ready" | "capturing" | "crop" | "compose" | "preview";

function ThumbnailCaptureModal({ format, capture, brandKit, onSave, onClose }: {
  format: ThumbnailFormat;
  capture?: CaptureRecord;
  brandKit?: BrandKit;
  onSave: (preview: string, fullRes: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<ThumbnailPhase>("ready");
  const [rawCanvas, setRawCanvas] = useState<HTMLCanvasElement | null>(null);
  const [croppedCanvas, setCroppedCanvas] = useState<HTMLCanvasElement | null>(null); // pre-text
  const [finalCanvas, setFinalCanvas] = useState<HTMLCanvasElement | null>(null);    // with text baked in
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(false);

  // If already captured, jump straight to preview
  useEffect(() => {
    if (!capture?.fullRes) return;
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      setFinalCanvas(c); setPhase("preview");
    };
    img.src = capture.fullRes;
  }, []); // eslint-disable-line

  const startCapture = async () => {
    setError(""); setPhase("capturing");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" } as MediaTrackConstraints, audio: false });
      const c = await captureFrame(stream);
      setRawCanvas(c); setPhase("crop");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Permission denied") && !msg.includes("cancelled")) setError(msg);
      setPhase("ready");
    }
  };

  const handleCropApply = async (cropped: HTMLCanvasElement) => {
    const blob = await resizeToJpeg(cropped, format.width, format.height);
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = format.width; c.height = format.height;
      c.getContext("2d")!.drawImage(img, 0, 0);
      setCroppedCanvas(c); setPhase("compose");
    };
    img.src = URL.createObjectURL(blob);
  };

  const handleCompose = (final: HTMLCanvasElement) => {
    setFinalCanvas(final); setDownloaded(false); setPhase("preview");
    onSave(toThumbnail(final), final.toDataURL("image/jpeg", 0.92));
  };

  const download = () => {
    if (!finalCanvas) return;
    finalCanvas.toBlob(b => { if (b) triggerDownload(b, `${format.id}.jpg`); }, "image/jpeg", 0.92);
    setDownloaded(true);
  };

  const orientLabel = format.width === format.height ? "Square" : format.width > format.height ? "Landscape" : "Portrait";
  const phaseLabel = { ready: "Setup", capturing: "Capturing", crop: "Crop", compose: "Compose", preview: "Preview" }[phase];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{format.label}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{format.platform} · {format.width}×{format.height}px · {orientLabel} · {phaseLabel}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-6 space-y-4">

          {phase === "ready" && (
            <>
              <SizeLauncher />
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1.5">{format.platform}</p>
                <p className="text-sm text-amber-900">{format.description}</p>
              </div>
              {format.height > format.width && (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                  <p className="text-xs text-blue-700 leading-relaxed">
                    <strong>Portrait tip:</strong> Open the app at 390×844px (iPhone size) for more natural mobile content to crop from.
                  </p>
                </div>
              )}
              <p className="text-xs text-gray-500">Click <strong>Start capture</strong>, pick the plotwell tab, then crop to {format.width}×{format.height}. You can add text overlay in the next step.</p>
              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex justify-end">
                <Btn onClick={startCapture}><Camera className="w-4 h-4" />Start capture</Btn>
              </div>
            </>
          )}

          {phase === "capturing" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              <p className="text-sm text-gray-600">Select the plotwell tab in the browser dialog…</p>
            </div>
          )}

          {phase === "crop" && rawCanvas && (
            <ThumbnailCropTool raw={rawCanvas} format={format}
              onApply={handleCropApply}
              onBack={() => { setRawCanvas(null); setPhase("ready"); }} />
          )}

          {phase === "compose" && croppedCanvas && (
            <ThumbnailComposer canvas={croppedCanvas} format={format}
              brandKit={brandKit}
              onApply={handleCompose}
              onBack={() => setPhase("crop")} />
          )}

          {phase === "preview" && finalCanvas && (
            <>
              <div className="rounded-lg overflow-hidden border border-gray-200 bg-gray-900 flex items-center justify-center"
                style={{ aspectRatio: `${format.width} / ${format.height}`, maxHeight: "320px" }}>
                <img src={finalCanvas.toDataURL("image/jpeg", 0.8)} alt="Thumbnail" className="max-w-full max-h-full object-contain" />
              </div>
              <p className="text-[11px] font-mono text-gray-400">{finalCanvas.width} × {finalCanvas.height} px · JPEG</p>
              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-2">
                  <Btn variant="outline" onClick={() => setPhase("compose")}><Camera className="w-3.5 h-3.5" />Edit text</Btn>
                  <Btn variant="outline" onClick={() => { setRawCanvas(null); setPhase("ready"); }}><Camera className="w-3.5 h-3.5" />Recapture</Btn>
                </div>
                <div className="flex gap-2">
                  <Btn onClick={download} variant={downloaded ? "outline" : "primary"}>
                    {downloaded ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Download className="w-3.5 h-3.5" />}
                    {downloaded ? "Downloaded" : "Download .jpg"}
                  </Btn>
                  <Btn variant="outline" onClick={onClose}><CheckCircle className="w-3.5 h-3.5" />Close</Btn>
                </div>
              </div>
              <p className="text-[11px] text-gray-400">Drop into <code className="bg-gray-100 rounded px-1 font-mono text-gray-600">plotwell-landing/public/thumbnails/</code></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Capture modal
// ─────────────────────────────────────────────

type CapturePhase = "ready" | "capturing" | "crop" | "preview" | "downloading";

function CaptureModal({ slot, capture, onSave, onClose }: {
  slot: ScreenshotSlot; capture?: CaptureRecord;
  onSave: (preview: string, fullRes: string) => void; onClose: () => void;
}) {
  const [phase, setPhase] = useState<CapturePhase>("ready");
  const [rawCanvas, setRawCanvas] = useState<HTMLCanvasElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());

  // If this slot was already captured, reconstruct the canvas from stored fullRes
  // and jump straight to the download phase so the user can download without recapturing.
  useEffect(() => {
    if (!capture?.fullRes) return;
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      setCanvas(c); setPhase("preview");
    };
    img.src = capture.fullRes;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startCapture = useCallback(async () => {
    setError(""); setPhase("capturing");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" } as MediaTrackConstraints, audio: false });
      const c = await captureFrame(stream);
      setRawCanvas(c); setPhase("crop");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Permission denied") && !msg.includes("cancelled")) setError(msg);
      setPhase("ready");
    }
  }, []);

  const handleCropApply = useCallback((cropped: HTMLCanvasElement) => {
    setCanvas(cropped); setDownloaded(new Set()); setPhase("preview");
    // Auto-save immediately — closing the modal without downloading still persists the image
    onSave(toThumbnail(cropped), cropped.toDataURL("image/jpeg", 0.8));
  }, [onSave]);

  const downloadSize = useCallback(async (idx: number) => {
    if (!canvas) return;
    const { width, suffix } = EXPORT_SIZES[idx];
    const blob = await resizeToWebP(canvas, Math.min(width, canvas.width));
    triggerDownload(blob, `${slot.id}${suffix}.webp`);
    setDownloaded(p => new Set([...p, idx]));
  }, [canvas, slot.id]);

  const downloadAll = useCallback(async () => {
    if (!canvas) return;
    setPhase("downloading");
    for (let i = 0; i < EXPORT_SIZES.length; i++) { await downloadSize(i); await new Promise(r => setTimeout(r, 300)); }
    setPhase("preview");
  }, [canvas, downloadSize]);

  const phaseLabel = { ready: "Setup", capturing: "Capturing", crop: "Crop", preview: "Download", downloading: "Download" }[phase];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{slot.label}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{phaseLabel}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-6 space-y-4">
          {phase === "ready" && (
            <>
              <SizeLauncher section={slot.section} device={slot.device} />
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Then set up the app</p>
                <p className="text-sm text-amber-900 leading-relaxed">{slot.description}</p>
              </div>
              <p className="text-xs text-gray-500">When the app looks right, click <strong>Start capture</strong>. Pick the plotwell tab when Chrome asks.</p>
              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex justify-end">
                <Btn onClick={startCapture}><Camera className="w-4 h-4" />Start capture</Btn>
              </div>
            </>
          )}

          {phase === "capturing" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              <p className="text-sm text-gray-600">Select the plotwell tab in the browser dialog…</p>
            </div>
          )}

          {phase === "crop" && rawCanvas && (
            <CropTool
              raw={rawCanvas}
              onApply={handleCropApply}
              onBack={() => { setRawCanvas(null); setPhase("ready"); }}
            />
          )}

          {(phase === "preview" || phase === "downloading") && canvas && (
            <>
              <div className="rounded-lg overflow-hidden border border-gray-200">
                <img src={canvas.toDataURL("image/jpeg", 0.8)} alt="Cropped preview" className="w-full h-auto max-h-56 object-cover object-top" />
              </div>
              <p className="text-[11px] font-mono text-gray-400">{canvas.width} × {canvas.height} px</p>

              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Download sizes</p>
                <div className="grid grid-cols-3 gap-2">
                  {EXPORT_SIZES.map(({ label, suffix }, i) => (
                    <button key={i} onClick={() => downloadSize(i)} disabled={phase === "downloading"}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${downloaded.has(i) ? "border-green-300 bg-green-50 text-green-700" : "border-gray-200 bg-white hover:bg-gray-50 text-gray-700"}`}>
                      {downloaded.has(i) ? <Check className="w-4 h-4 text-green-600" /> : <Download className="w-4 h-4 text-gray-400" />}
                      <span>{label}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{slot.id}{suffix}.webp</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-2">
                  <Btn variant="outline" onClick={() => { setRawCanvas(null); setPhase("ready"); }}><Camera className="w-3.5 h-3.5" />Recapture</Btn>
                  <Btn variant="outline" onClick={downloadAll} disabled={phase === "downloading"}>
                    {phase === "downloading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Download all
                  </Btn>
                </div>
                <Btn onClick={onClose}><CheckCircle className="w-3.5 h-3.5" />Close</Btn>
              </div>

              <p className="text-[11px] text-gray-400">
                Drop files into <code className="bg-gray-100 rounded px-1 font-mono text-gray-600">plotwell-landing/public/screenshots/</code>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Add Slot modal
// ─────────────────────────────────────────────

function AddSlotModal({ onAdd, onClose, existingIds }: {
  onAdd: (s: ScreenshotSlot) => void; onClose: () => void; existingIds: Set<string>;
}) {
  const [label, setLabel] = useState(""); const [description, setDescription] = useState(""); const [section, setSection] = useState("");
  const id = label.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const conflict = existingIds.has(id);
  const valid = id.length > 0 && description.length > 0 && !conflict;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">New screenshot slot</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Label</label>
            <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="e.g. Beat Sheet" value={label} onChange={e => setLabel(e.target.value)} />
            {id && <p className="mt-1 text-[10px] font-mono text-gray-400">id: {id}{conflict && <span className="text-red-500 ml-2">already exists</span>}</p>}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Setup instructions</label>
            <textarea className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none" rows={3} placeholder="What should be visible before capturing?" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">App section <span className="font-normal text-gray-400">(optional)</span></label>
            <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="e.g. beats" value={section} onChange={e => setSection(e.target.value)} />
          </div>
          {id && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Output files</p>
              {EXPORT_SIZES.map(({ suffix }) => (
                <p key={suffix} className="text-[11px] font-mono text-gray-600">/screenshots/{id}{suffix}.webp</p>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="outline" onClick={onClose}>Cancel</Btn>
            <Btn onClick={() => onAdd({ id, label, description, section: section || undefined, custom: true })} disabled={!valid}><Plus className="w-3.5 h-3.5" />Add slot</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Slot card
// ─────────────────────────────────────────────

function SlotCard({ slot, capture, onCapture, onDelete }: {
  slot: ScreenshotSlot; capture?: CaptureRecord; onCapture: () => void; onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-gray-300 transition-colors">
      <div className="relative w-full bg-gray-50 border-b border-gray-100" style={{ aspectRatio: "16/9" }}>
        {capture?.preview
          ? <img src={capture.preview} alt={slot.label} className="w-full h-full object-cover object-top" />
          : <div className="w-full h-full flex flex-col items-center justify-center gap-2"><Camera className="w-6 h-6 text-gray-300" /><span className="text-[10px] text-gray-400 font-medium">No capture yet</span></div>
        }
        <div className="absolute top-2 left-2">
          {capture ? <Badge color="green"><CheckCircle className="w-2.5 h-2.5" />Captured</Badge> : <Badge color="gray"><AlertCircle className="w-2.5 h-2.5" />Missing</Badge>}
        </div>
        <div className="absolute top-2 right-2 flex gap-1">
          {slot.device === "mobile" && <Badge color="blue">📱 Mobile</Badge>}
          {slot.size && <Badge color="gray">{slot.size}</Badge>}
          {slot.custom && <Badge color="amber">Custom</Badge>}
        </div>
      </div>
      <div className="p-3">
        <p className="text-sm font-semibold text-gray-900 truncate">{slot.label}</p>
        <p className="text-[10px] font-mono text-gray-400 mt-0.5">/screenshots/{slot.id}.webp</p>
        {capture && <p className="mt-1 text-[10px] text-gray-400 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{new Date(capture.capturedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>}
        <button onClick={() => setExpanded(v => !v)} className="mt-2 flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}Setup instructions
        </button>
        {expanded && <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed bg-gray-50 rounded-lg px-2.5 py-2">{slot.description}</p>}
        <div className="mt-3 flex items-center gap-2">
          <Btn onClick={onCapture} variant="primary" className="flex-1 justify-center">
            {capture ? <><Download className="w-3.5 h-3.5" />Download</> : <><Camera className="w-3.5 h-3.5" />Capture</>}
          </Btn>
          {onDelete && <Btn variant="ghost" onClick={onDelete} className="px-2"><Trash2 className="w-3.5 h-3.5 text-gray-400" /></Btn>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Screenshots tab
// ─────────────────────────────────────────────

function ScreenshotsTab() {
  const [customSlots, setCustomSlots] = useState<ScreenshotSlot[]>(() => load(CUSTOM_SLOTS_KEY, []));
  const [captures, setCaptures] = useState<Record<string, CaptureRecord>>(() => load(CAPTURES_KEY, {}));
  const [captureTarget, setCaptureTarget] = useState<ScreenshotSlot | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deviceFilter, setDeviceFilter] = useState<"all" | "desktop" | "mobile">("all");

  const allSlots = [...BUILT_IN_SLOTS, ...customSlots];
  const existingIds = new Set(allSlots.map(s => s.id));
  const captured = allSlots.filter(s => captures[s.id]).length;
  const visibleSlots = deviceFilter === "all" ? allSlots : allSlots.filter(s => (s.device ?? "desktop") === deviceFilter);

  const handleSaveCapture = useCallback((preview: string, fullRes: string) => {
    if (!captureTarget) return;
    const next = { ...captures, [captureTarget.id]: { capturedAt: new Date().toISOString(), preview, fullRes } };
    setCaptures(next);
    try { save(CAPTURES_KEY, next); } catch {
      const slim = { ...next, [captureTarget.id]: { ...next[captureTarget.id], fullRes: undefined } };
      save(CAPTURES_KEY, slim);
    }
  }, [captureTarget, captures]);

  const handleAddSlot = useCallback((slot: ScreenshotSlot) => {
    const next = [...customSlots, slot]; setCustomSlots(next); save(CUSTOM_SLOTS_KEY, next); setShowAddModal(false);
  }, [customSlots]);

  const handleDeleteSlot = useCallback((id: string) => {
    const next = customSlots.filter(s => s.id !== id); setCustomSlots(next); save(CUSTOM_SLOTS_KEY, next);
    const nc = { ...captures }; delete nc[id]; setCaptures(nc); save(CAPTURES_KEY, nc);
  }, [customSlots, captures]);

  const desktopCount = allSlots.filter(s => (s.device ?? "desktop") === "desktop").length;
  const mobileCount  = allSlots.filter(s => s.device === "mobile").length;
  const desktopDone  = allSlots.filter(s => (s.device ?? "desktop") === "desktop" && captures[s.id]).length;
  const mobileDone   = allSlots.filter(s => s.device === "mobile" && captures[s.id]).length;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-600"><span className="font-semibold text-gray-900">{captured}</span> / {allSlots.length} captured</div>
          <div className="h-1.5 w-32 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${(captured / allSlots.length) * 100}%` }} /></div>
        </div>
        <Btn onClick={() => setShowAddModal(true)} variant="outline"><Plus className="w-3.5 h-3.5" />Add slot</Btn>
      </div>

      {/* Device filter tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-200">
        {([
          { id: "all",     label: `All (${allSlots.length})`,                 done: captured },
          { id: "desktop", label: `Desktop (${desktopCount})`,                done: desktopDone },
          { id: "mobile",  label: `Mobile (${mobileCount})`,                  done: mobileDone },
        ] as { id: typeof deviceFilter; label: string; done: number }[]).map(t => (
          <button key={t.id} onClick={() => setDeviceFilter(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${deviceFilter === t.id ? "border-amber-500 text-amber-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
            {t.id === "desktop" ? "🖥" : t.id === "mobile" ? "📱" : ""}
            {t.label}
            {t.done > 0 && <span className="text-[10px] bg-green-100 text-green-700 rounded-full px-1.5">{t.done} ✓</span>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleSlots.map(slot => (
          <SlotCard key={slot.id} slot={slot} capture={captures[slot.id]} onCapture={() => setCaptureTarget(slot)} onDelete={slot.custom ? () => handleDeleteSlot(slot.id) : undefined} />
        ))}
      </div>
      <div className="mt-6 rounded-xl bg-gray-50 border border-gray-200 px-5 py-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Where to put the files</p>
        <p className="text-xs text-gray-600 leading-relaxed">Drop all <code className="bg-white border border-gray-200 rounded px-1 font-mono">.webp</code> files into <code className="bg-white border border-gray-200 rounded px-1 font-mono">plotwell-landing/public/screenshots/</code>. The landing picks them up automatically.</p>
      </div>
      {captureTarget && <CaptureModal slot={captureTarget} capture={captures[captureTarget.id]} onSave={handleSaveCapture} onClose={() => setCaptureTarget(null)} />}
      {showAddModal && <AddSlotModal onAdd={handleAddSlot} onClose={() => setShowAddModal(false)} existingIds={existingIds} />}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Unified thumbnail editor (all formats at once)
// ─────────────────────────────────────────────

function UnifiedThumbnailModal({ brandKit, onSave, onClose }: {
  brandKit?: BrandKit;
  onSave: (formatId: string, preview: string, fullRes: string) => void;
  onClose: () => void;
}) {
  type Phase = "ready" | "capturing" | "crop" | "compose";
  const [phase, setPhase]         = useState<Phase>("ready");
  const [captureError, setCaptureError] = useState("");
  const [rawCanvas, setRawCanvas]       = useState<HTMLCanvasElement | null>(null);
  const [heroCanvas, setHeroCanvas]     = useState<HTMLCanvasElement | null>(null);

  // ── Composition state ──
  const [tab, setTab]               = useState<"bg" | "hero" | "text">("bg");
  const [ov, setOv]                 = useState<TextOverlay>(DEFAULT_OVERLAY);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageGenLoading, setImageGenLoading] = useState(false);
  const [imageGenError,   setImageGenError]   = useState("");
  const [aiBgCanvas, setAiBgCanvas]   = useState<HTMLCanvasElement | null>(null);
  const [heroPosition, setHeroPosition] = useState<"left" | "center" | "right">("right");
  const [heroSize, setHeroSize]         = useState(0.62);
  const [useMockup, setUseMockup]       = useState(true);
  const [showHero, setShowHero]         = useState(true);
  const [logoPos, setLogoPos]           = useState<"tl" | "tr" | "bl" | "br">("tl");
  // Aspect ratio used when generating the background (default 16:9)
  const [seedFormat, setSeedFormat]     = useState<ThumbnailFormat>(THUMBNAIL_FORMATS[0]);
  const [exporting, setExporting]       = useState(false);

  // ── Brand kit ──
  const brandLogo    = brandKit?.logo     ?? "";
  const brandRef     = brandKit?.style    ?? "";
  const brandStrength = brandKit?.strength ?? 0.65;
  const brandColors  = brandKit?.colors   ?? [];
  const colorSuffix  = brandColors.length > 0
    ? `, using exact brand colors: ${brandColors.map(c => `${c.name} ${c.hex}`).join(", ")}`
    : "";

  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!brandLogo) { setLogoImg(null); return; }
    const img = new window.Image();
    img.onload = () => setLogoImg(img);
    img.src = brandLogo;
  }, [brandLogo]);

  // ── Color picker debounce ──
  const [colorDraft,     setColorDraft]     = useState(ov.color);
  const [line2colorDraft, setLine2colorDraft] = useState(ov.line2color);
  const colorTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const line2colorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateColorDebounced = (hex: string) => {
    setColorDraft(hex);
    if (colorTimerRef.current) clearTimeout(colorTimerRef.current);
    colorTimerRef.current = setTimeout(() => setOv(o => ({ ...o, color: hex })), 180);
  };
  const updateLine2ColorDebounced = (hex: string) => {
    setLine2colorDraft(hex);
    if (line2colorTimerRef.current) clearTimeout(line2colorTimerRef.current);
    line2colorTimerRef.current = setTimeout(() => setOv(o => ({ ...o, line2color: hex })), 180);
  };

  // ── Saved backgrounds ──
  const [savedBgs, setSavedBgs] = useState<SavedBg[]>(() => load<SavedBg[]>(SAVED_BGS_KEY, []));
  const [bgLabel, setBgLabel]   = useState("");

  const saveToGallery = useCallback(() => {
    if (!aiBgCanvas) return;
    const entry: SavedBg = {
      id: crypto.randomUUID(),
      thumbnail: toThumbnail(aiBgCanvas),
      fullRes: aiBgCanvas.toDataURL("image/jpeg", 0.92),
      label: bgLabel.trim() || seedFormat.label,
      formatId: seedFormat.id,
      createdAt: new Date().toISOString(),
    };
    setSavedBgs(prev => {
      const next = [entry, ...prev].slice(0, MAX_SAVED_BGS);
      try { save(SAVED_BGS_KEY, next); } catch { /* quota */ }
      return next;
    });
    setBgLabel("");
  }, [aiBgCanvas, bgLabel, seedFormat]);

  const deleteSavedBg = (id: string) => {
    setSavedBgs(prev => {
      const next = prev.filter(b => b.id !== id);
      try { save(SAVED_BGS_KEY, next); } catch { /* quota */ }
      return next;
    });
  };

  const loadSavedBg = (bg: SavedBg) => {
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      setAiBgCanvas(c); setTab("hero");
    };
    img.src = bg.fullRes;
  };

  // ── Local hero upload ──
  const [localHeroCanvas,  setLocalHeroCanvas]  = useState<HTMLCanvasElement | null>(null);
  const [localHeroPreview, setLocalHeroPreview] = useState("");
  const localHeroRef = useRef<HTMLInputElement>(null);
  const handleHeroUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const b64 = ev.target?.result as string; if (!b64) return;
      const img = new window.Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        setLocalHeroCanvas(c); setLocalHeroPreview(b64);
      };
      img.src = b64;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const activeHero = localHeroCanvas ?? heroCanvas;
  const update = (patch: Partial<TextOverlay>) => setOv(o => ({ ...o, ...patch }));
  const bgPresets = brandRef ? FLUX_IMG2IMG_PROMPTS : FLUX_TEXT_PROMPTS;

  // ── Capture ──
  const startCapture = async () => {
    setCaptureError(""); setPhase("capturing");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" } as MediaTrackConstraints, audio: false });
      const c = await captureFrame(stream);
      setRawCanvas(c); setPhase("crop");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Permission denied") && !msg.includes("cancelled")) setCaptureError(msg);
      setPhase("ready");
    }
  };

  // ── Generate AI background ──
  const generateBg = async () => {
    if (!imagePrompt.trim()) { setImageGenError("Enter a prompt first."); return; }
    setImageGenError(""); setImageGenLoading(true); setAiBgCanvas(null);
    try {
      const opts = brandRef ? { referenceImage: brandRef, strength: brandStrength } : undefined;
      const url = await generateWithFlux(imagePrompt + colorSuffix + QUALITY_SUFFIX, seedFormat, opts);
      const c   = await urlToCanvas(url, seedFormat.width, seedFormat.height);
      setAiBgCanvas(c); setTab("hero");
    } catch (e: unknown) {
      setImageGenError(e instanceof Error ? e.message : String(e));
    } finally { setImageGenLoading(false); }
  };

  // ── Per-format composition (memoised — recomputes only when relevant state changes) ──
  // Produces { formatId → thumbnail data URL } for the live preview grid.
  // Full-res canvases are created on demand at export time to avoid holding 6 large canvases in memory.
  const allPreviews = useMemo<Record<string, string>>(() => {
    if (!aiBgCanvas) return {};
    const compose = (fmt: ThumbnailFormat): HTMLCanvasElement => {
      const bg = fitBgToFormat(aiBgCanvas, fmt);
      let base: HTMLCanvasElement;
      if (showHero && activeHero) {
        const prod = useMockup ? wrapInBrowserMockup(activeHero) : activeHero;
        base = compositeOverlay(bg, prod, heroPosition, heroSize);
      } else {
        base = bg;
      }
      if (logoImg) {
        const out = document.createElement("canvas");
        out.width = base.width; out.height = base.height;
        const ctx = out.getContext("2d")!;
        ctx.drawImage(base, 0, 0);
        const logoW = Math.round(base.width * 0.10);
        const logoH = Math.round(logoImg.naturalHeight * (logoW / logoImg.naturalWidth));
        const pad   = Math.round(base.width * 0.025);
        const lx = (logoPos === "tr" || logoPos === "br") ? base.width  - logoW - pad : pad;
        const ly = (logoPos === "bl" || logoPos === "br") ? base.height - logoH - pad : pad;
        ctx.drawImage(logoImg, lx, ly, logoW, logoH);
        base = out;
      }
      return renderTextOnCanvas(base, ov);
    };
    return Object.fromEntries(THUMBNAIL_FORMATS.map(fmt => [fmt.id, compose(fmt).toDataURL("image/jpeg", 0.72)]));
  }, [aiBgCanvas, activeHero, showHero, useMockup, heroPosition, heroSize, logoImg, logoPos, ov]);

  // Full-res compose for a single format at export time
  const composeFullRes = useCallback((fmt: ThumbnailFormat): HTMLCanvasElement => {
    if (!aiBgCanvas) return document.createElement("canvas");
    const bg = fitBgToFormat(aiBgCanvas, fmt);
    let base: HTMLCanvasElement;
    if (showHero && activeHero) {
      const prod = useMockup ? wrapInBrowserMockup(activeHero) : activeHero;
      base = compositeOverlay(bg, prod, heroPosition, heroSize);
    } else {
      base = bg;
    }
    if (logoImg) {
      const out = document.createElement("canvas");
      out.width = base.width; out.height = base.height;
      const ctx = out.getContext("2d")!;
      ctx.drawImage(base, 0, 0);
      const logoW = Math.round(base.width * 0.10);
      const logoH = Math.round(logoImg.naturalHeight * (logoW / logoImg.naturalWidth));
      const pad   = Math.round(base.width * 0.025);
      const lx = (logoPos === "tr" || logoPos === "br") ? base.width  - logoW - pad : pad;
      const ly = (logoPos === "bl" || logoPos === "br") ? base.height - logoH - pad : pad;
      ctx.drawImage(logoImg, lx, ly, logoW, logoH);
      base = out;
    }
    return renderTextOnCanvas(base, ov);
  }, [aiBgCanvas, activeHero, showHero, useMockup, heroPosition, heroSize, logoImg, logoPos, ov]);

  // ── Export all ──
  const exportAll = async () => {
    setExporting(true);
    for (const fmt of THUMBNAIL_FORMATS) {
      const c = composeFullRes(fmt);
      onSave(fmt.id, toThumbnail(c), c.toDataURL("image/jpeg", 0.92));
      await new Promise<void>(res =>
        c.toBlob(b => { if (b) triggerDownload(b, `${fmt.id}.jpg`); setTimeout(res, 280); }, "image/jpeg", 0.92)
      );
    }
    setExporting(false);
  };

  const landscape = THUMBNAIL_FORMATS.filter(f => f.width  > f.height);
  const portrait  = THUMBNAIL_FORMATS.filter(f => f.height > f.width);
  const square    = THUMBNAIL_FORMATS.filter(f => f.width === f.height);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="w-full max-w-6xl rounded-2xl bg-white shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: "96vh" }}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">All Thumbnails</h2>
            <p className="text-xs text-gray-500 mt-0.5">Compose once · auto-crop for every social format</p>
          </div>
          <div className="flex items-center gap-3">
            {aiBgCanvas && (
              <button onClick={exportAll} disabled={exporting}
                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 cursor-pointer transition-colors">
                {exporting ? <><Loader2 className="w-4 h-4 animate-spin" />Exporting…</> : <><Download className="w-4 h-4" />Export all {THUMBNAIL_FORMATS.length}</>}
              </button>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Body: left controls + right preview grid */}
        <div className="flex flex-1 overflow-hidden min-h-0">

          {/* ─── Left panel: controls ─── */}
          <div className="w-[380px] shrink-0 border-r border-gray-100 overflow-y-auto flex flex-col">
            <div className="p-5 space-y-4 flex-1">

              {/* Step pills */}
              <div className="flex items-center gap-1.5 text-[11px] font-medium">
                {(["Capture", "Compose"] as const).map((label, i) => {
                  const active = i === 0
                    ? (phase === "ready" || phase === "capturing" || phase === "crop")
                    : phase === "compose";
                  const done = i === 0 && phase === "compose";
                  return (
                    <span key={label} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${done ? "bg-green-100 text-green-700" : active ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-400"}`}>
                      {done && <Check className="w-3 h-3" />}{label}
                    </span>
                  );
                })}
              </div>

              {/* ── Ready ── */}
              {phase === "ready" && (
                <>
                  <SizeLauncher />
                  <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                    <p className="text-xs text-blue-700 leading-relaxed">
                      <strong>Tip:</strong> For portrait / Reel formats, launch the app at 390×844 (iPhone size) before capturing.
                    </p>
                  </div>
                  <p className="text-xs text-gray-500">Capture once — all 6 social formats will be composed from a single screenshot.</p>
                  {captureError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{captureError}</p>}
                  <Btn onClick={startCapture} className="w-full justify-center"><Camera className="w-4 h-4" />Start capture</Btn>
                  <button onClick={() => setPhase("compose")}
                    className="w-full text-center text-xs text-gray-400 hover:text-gray-600 underline cursor-pointer py-1 transition-colors">
                    Skip capture — use AI background only
                  </button>
                </>
              )}

              {/* ── Capturing ── */}
              {phase === "capturing" && (
                <div className="flex flex-col items-center gap-3 py-10">
                  <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
                  <p className="text-sm text-gray-600">Select the plotwell tab…</p>
                </div>
              )}

              {/* ── Crop ── */}
              {phase === "crop" && rawCanvas && (
                <CropTool raw={rawCanvas}
                  onApply={c => { setHeroCanvas(c); setPhase("compose"); }}
                  onBack={() => { setRawCanvas(null); setPhase("ready"); }} />
              )}

              {/* ── Compose ── */}
              {phase === "compose" && (
                <>
                  {/* Captured hero strip */}
                  {heroCanvas && (
                    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50 p-2.5">
                      <img src={heroCanvas.toDataURL("image/jpeg", 0.5)} alt="Hero"
                        className="w-16 h-9 object-cover rounded border border-gray-200 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-700">Screenshot ready</p>
                        <p className="text-[10px] text-gray-400">{heroCanvas.width} × {heroCanvas.height}px</p>
                      </div>
                      <button onClick={() => { setRawCanvas(null); setPhase("ready"); }}
                        className="text-[10px] text-gray-400 hover:text-gray-700 cursor-pointer shrink-0 underline">Recapture</button>
                    </div>
                  )}

                  {/* Tab bar */}
                  <div className="flex border border-gray-200 rounded-xl bg-gray-50 p-1 gap-1">
                    {([["bg","Background"],["hero","Hero"],["text","Text"]] as ["bg"|"hero"|"text", string][]).map(([t, lbl]) => (
                      <button key={t} onClick={() => setTab(t)}
                        className={`flex-1 py-1.5 text-sm font-medium rounded-lg transition-all cursor-pointer ${tab === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-400 hover:text-gray-700"}`}>
                        {lbl}{t === "hero" && aiBgCanvas && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />}
                      </button>
                    ))}
                  </div>

                  {/* ─ Background tab ─ */}
                  {tab === "bg" && (
                    <div className="space-y-3">
                      {/* Seed AR picker */}
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Generate at aspect ratio</label>
                        <div className="grid grid-cols-3 gap-1">
                          {THUMBNAIL_FORMATS.map(f => (
                            <button key={f.id} onClick={() => setSeedFormat(f)}
                              className={`rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors truncate px-1 ${seedFormat.id === f.id ? "border-violet-400 bg-violet-50 text-violet-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                              {f.id === "yt" ? "16:9" : f.id === "tw" ? "16:9 tw" : f.id === "li" ? "1.9:1" : f.id === "tw-v" ? "4:5" : f.id === "ig-sq" ? "1:1" : "9:16"}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1.5">Background generates at this AR — center-cropped for all others automatically.</p>
                      </div>

                      {(brandRef || brandColors.length > 0) && (
                        <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 flex items-center gap-2.5">
                          {brandRef && <img src={brandRef} alt="" className="w-8 h-8 object-cover rounded-lg shrink-0" />}
                          <p className="text-[10px] text-violet-700 font-medium">Brand style active · colors injected</p>
                        </div>
                      )}

                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {bgPresets.map((p, i) => (
                          <button key={i} onClick={() => setImagePrompt(p)}
                            className={`shrink-0 rounded-full border px-3 py-1 text-[11px] whitespace-nowrap cursor-pointer transition-colors ${imagePrompt === p ? "border-violet-500 bg-violet-100 text-violet-800" : "border-gray-200 bg-white hover:bg-gray-50 text-gray-600"}`}>
                            {p.slice(0, 30)}…
                          </button>
                        ))}
                      </div>

                      <textarea className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
                        rows={3} placeholder="Describe background mood, lighting…"
                        value={imagePrompt} onChange={e => setImagePrompt(e.target.value)} />

                      {imageGenError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{imageGenError}</p>}

                      <div className="flex gap-2">
                        <button onClick={generateBg} disabled={imageGenLoading || !imagePrompt.trim()}
                          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                          {imageGenLoading ? <><Loader2 className="w-4 h-4 animate-spin" />Generating…</> : <><Wand2 className="w-4 h-4" />{aiBgCanvas ? "Regenerate" : "Generate"}</>}
                        </button>
                        {aiBgCanvas && (
                          <button onClick={() => aiBgCanvas.toBlob(b => b && triggerDownload(b, `bg-${Date.now()}.jpg`), "image/jpeg", 0.93)}
                            className="inline-flex items-center gap-1 rounded-xl border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-700 px-3 py-2.5 text-sm cursor-pointer shrink-0">
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {aiBgCanvas && (
                        <div className="flex gap-2">
                          <input className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                            placeholder={`Save name…`} value={bgLabel} onChange={e => setBgLabel(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && saveToGallery()} />
                          <button onClick={saveToGallery}
                            className="inline-flex items-center gap-1 rounded-xl border border-green-300 bg-green-50 hover:bg-green-100 text-green-700 px-3 py-2 text-sm font-medium cursor-pointer shrink-0">
                            <Plus className="w-4 h-4" />Save
                          </button>
                        </div>
                      )}

                      {savedBgs.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Saved ({savedBgs.length})</p>
                          <div className="grid grid-cols-3 gap-1.5">
                            {savedBgs.map(bg => (
                              <div key={bg.id} className="relative group rounded-lg overflow-hidden border border-gray-200 bg-gray-900 cursor-pointer aspect-video"
                                onClick={() => loadSavedBg(bg)}>
                                <img src={bg.thumbnail} alt={bg.label} className="w-full h-full object-cover" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
                                  <span className="text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">Use</span>
                                </div>
                                <button onClick={e => { e.stopPropagation(); deleteSavedBg(bg.id); }}
                                  className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                                  <X className="w-2.5 h-2.5" />
                                </button>
                                <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5">
                                  <p className="text-[8px] text-white/80 truncate">{bg.label}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ─ Hero tab ─ */}
                  {tab === "hero" && (
                    <div className="space-y-3">
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Hero image</p>
                        <div className="flex gap-2">
                          <div className="flex-1 rounded-xl border border-gray-200 bg-gray-50 p-2 flex items-center gap-2.5">
                            {(localHeroPreview || heroCanvas) && (
                              <img src={localHeroPreview || heroCanvas!.toDataURL("image/jpeg", 0.5)} alt="Hero"
                                className="w-14 h-8 object-cover rounded border border-gray-200 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-gray-700">{localHeroPreview ? "Custom" : "Captured"}</p>
                              {localHeroPreview && (
                                <button onClick={() => { setLocalHeroCanvas(null); setLocalHeroPreview(""); }}
                                  className="text-[10px] text-gray-400 hover:text-red-500 cursor-pointer">Remove</button>
                              )}
                            </div>
                          </div>
                          <button onClick={() => localHeroRef.current?.click()}
                            className="rounded-xl border-2 border-dashed border-gray-300 hover:border-amber-400 px-3 flex flex-col items-center justify-center gap-0.5 cursor-pointer hover:bg-amber-50 transition-colors">
                            <Plus className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-[9px] text-gray-400">Swap</span>
                          </button>
                        </div>
                        <input ref={localHeroRef} type="file" accept="image/*" className="hidden" onChange={handleHeroUpload} />
                      </div>

                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={showHero} onChange={e => setShowHero(e.target.checked)} className="w-4 h-4 accent-amber-500 rounded" />
                        <span className="text-sm font-semibold text-gray-800">Show hero on background</span>
                      </label>

                      {showHero && <>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input type="checkbox" checked={useMockup} onChange={e => setUseMockup(e.target.checked)} className="w-4 h-4 accent-violet-500 rounded" />
                          <span className="text-sm text-gray-700">Browser frame mockup</span>
                        </label>

                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Position</label>
                          <div className="grid grid-cols-3 gap-1.5">
                            {(["left","center","right"] as const).map(l => (
                              <button key={l} onClick={() => setHeroPosition(l)}
                                className={`rounded-xl border py-2 text-sm font-medium cursor-pointer transition-colors ${heroPosition === l ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                                {l === "left" ? "← Left" : l === "center" ? "Center" : "Right →"}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-[10px] text-gray-400 uppercase tracking-wide">Size</label>
                            <span className="text-[10px] font-mono text-gray-600">{Math.round(heroSize * 100)}%</span>
                          </div>
                          <input type="range" min={0.35} max={0.90} step={0.01} value={heroSize}
                            onChange={e => setHeroSize(Number(e.target.value))} className="w-full accent-amber-500" />
                        </div>
                      </>}

                      {brandLogo && (
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Logo corner</label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {([["tl","↖ Top left"],["tr","Top right ↗"],["bl","↙ Bottom left"],["br","Bottom right ↘"]] as const).map(([pos, lbl]) => (
                              <button key={pos} onClick={() => setLogoPos(pos)}
                                className={`rounded-xl border py-2 text-xs font-medium cursor-pointer transition-colors ${logoPos === pos ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                                {lbl}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ─ Text tab ─ */}
                  {tab === "text" && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Headline</label>
                        <input className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                          placeholder="Main title" value={ov.line1} onChange={e => update({ line1: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Subtitle</label>
                        <input className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                          placeholder="Supporting text" value={ov.line2} onChange={e => update({ line2: e.target.value })} />
                      </div>

                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Font</label>
                        <div className="grid grid-cols-3 gap-1">
                          {FONT_OPTIONS.map(f => (
                            <button key={f.value} onClick={() => update({ fontFamily: f.value })}
                              className={`rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer truncate px-1 transition-colors ${ov.fontFamily === f.value ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}
                              style={{ fontFamily: f.value }}>{f.label}</button>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-[10px] text-gray-400 uppercase tracking-wide">Size</label>
                            <span className="text-[10px] font-mono text-gray-500">{Math.round(ov.size * 100)}%</span>
                          </div>
                          <input type="range" min={0.5} max={2.5} step={0.05} value={ov.size}
                            onChange={e => update({ size: Number(e.target.value) })} className="w-full accent-amber-500" />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-[10px] text-gray-400 uppercase tracking-wide">Spacing</label>
                            <span className="text-[10px] font-mono text-gray-500">{ov.letterSpacing ?? 0}px</span>
                          </div>
                          <input type="range" min={0} max={16} step={0.5} value={ov.letterSpacing ?? 0}
                            onChange={e => update({ letterSpacing: Number(e.target.value) })} className="w-full accent-amber-500" />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Headline color</label>
                          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5">
                            <input type="color" value={colorDraft}
                              onChange={e => updateColorDebounced(e.target.value)}
                              onBlur={e => update({ color: e.target.value })}
                              className="w-7 h-7 rounded cursor-pointer border-0 p-0 bg-transparent shrink-0" />
                            <span className="text-[11px] font-mono text-gray-500">{colorDraft}</span>
                          </div>
                          <div className="flex gap-1.5 mt-1.5">
                            {["#ffffff","#ffff00","#f59e0b","#ff3b3b","#000000"].map(col => (
                              <button key={col} onClick={() => { setColorDraft(col); update({ color: col }); }}
                                className={`w-5 h-5 rounded-full border-2 cursor-pointer ${colorDraft === col ? "border-gray-700" : "border-gray-200"}`}
                                style={{ background: col }} />
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Subtitle color</label>
                          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5">
                            <input type="color" value={line2colorDraft || colorDraft}
                              onChange={e => updateLine2ColorDebounced(e.target.value)}
                              onBlur={e => update({ line2color: e.target.value })}
                              className="w-7 h-7 rounded cursor-pointer border-0 p-0 bg-transparent shrink-0" />
                            <span className="text-[11px] font-mono text-gray-500">{line2colorDraft || "(same)"}</span>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Position</label>
                          <div className="flex gap-1">
                            {(["top","center","bottom"] as const).map(p => (
                              <button key={p} onClick={() => update({ position: p })}
                                className={`flex-1 rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors ${ov.position === p ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                                {p[0].toUpperCase() + p.slice(1)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-400 mb-1.5 uppercase tracking-wide">Align</label>
                          <div className="flex gap-1">
                            {(["left","center","right"] as const).map(a => (
                              <button key={a} onClick={() => update({ align: a })}
                                className={`flex-1 rounded-lg border py-1.5 text-[11px] font-medium cursor-pointer transition-colors ${ov.align === a ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
                                {a === "left" ? "←" : a === "center" ? "≡" : "→"}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-1.5">
                        {([["Bold","bold"],["Shadow","shadow"],["Outline","stroke"],["UPPER","uppercase"]] as [string,"bold"|"shadow"|"stroke"|"uppercase"][]).map(([lbl, key]) => (
                          <button key={key} onClick={() => update({ [key]: !ov[key] })}
                            className={`rounded-xl border py-2 text-sm font-semibold cursor-pointer transition-colors ${ov[key] ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ─── Right panel: live format grid ─── */}
          <div className="flex-1 overflow-y-auto bg-gray-50 p-5 space-y-6">
            {!aiBgCanvas ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-400 min-h-64">
                <Image className="w-14 h-14 text-gray-200" />
                <p className="text-sm text-center max-w-xs">
                  {phase === "ready" || phase === "capturing"
                    ? "Capture a screenshot first, then generate a background."
                    : phase === "crop"
                    ? "Crop your screenshot, then go to Background tab."
                    : "Generate a background to see all format previews."}
                </p>
              </div>
            ) : (
              <>
                {[
                  { label: "Landscape", formats: landscape, icon: "🖥️", cols: "grid-cols-2" },
                  { label: "Portrait",  formats: portrait,  icon: "📱", cols: "grid-cols-3" },
                  { label: "Square",    formats: square,    icon: "⬛", cols: "grid-cols-3" },
                ].map(({ label, formats, icon, cols }) => formats.length === 0 ? null : (
                  <div key={label}>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{icon} {label}</p>
                    <div className={`grid ${cols} gap-3`}>
                      {formats.map(fmt => {
                        const previewUrl = allPreviews[fmt.id];
                        return (
                          <div key={fmt.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                            <div className="bg-gray-900 flex items-center justify-center overflow-hidden"
                              style={{ aspectRatio: `${fmt.width}/${fmt.height}`, maxHeight: "160px" }}>
                              {previewUrl
                                ? <img src={previewUrl} alt={fmt.label} className="w-full h-full object-cover" />
                                : <span className="text-[10px] text-gray-600 font-mono">{fmt.width}×{fmt.height}</span>
                              }
                            </div>
                            <div className="px-2.5 py-2 flex items-center justify-between gap-1.5">
                              <div className="min-w-0">
                                <p className="text-[11px] font-semibold text-gray-800 truncate">{fmt.label}</p>
                                <p className="text-[10px] text-amber-600 font-medium">{fmt.platform}</p>
                              </div>
                              <button
                                onClick={() => {
                                  const c = composeFullRes(fmt);
                                  c.toBlob(b => b && triggerDownload(b, `${fmt.id}.jpg`), "image/jpeg", 0.92);
                                }}
                                title="Download this format"
                                className="shrink-0 p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                                <Download className="w-3.5 h-3.5 text-gray-500" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* Sticky Export All */}
                <div className="sticky bottom-0 pt-2 pb-1">
                  <button onClick={exportAll} disabled={exporting}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 cursor-pointer transition-colors shadow-lg">
                    {exporting
                      ? <><Loader2 className="w-4 h-4 animate-spin" />Exporting all formats…</>
                      : <><Download className="w-4 h-4" />Export all {THUMBNAIL_FORMATS.length} formats</>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Thumbnails tab
// ─────────────────────────────────────────────

const DEFAULT_THUMBNAIL_SUBJECTS: ThumbnailSubject[] = [
  { id: "script-editor", name: "Script Editor", createdAt: 0 },
  { id: "ai-assistant",  name: "AI Assistant",  createdAt: 0 },
  { id: "random",        name: "Random",         createdAt: 0 },
];

function SubjectFormatMini({ fmt, capture, onClick }: {
  fmt: ThumbnailFormat;
  capture?: CaptureRecord;
  onClick: () => void;
}) {
  const ar = fmt.width / fmt.height;
  const isReady = !!capture;
  return (
    <button
      onClick={onClick}
      title={`${fmt.label} · ${fmt.width}×${fmt.height}`}
      className={`w-full flex flex-col gap-1.5 rounded-lg border p-2 transition-colors text-left hover:border-amber-300 hover:shadow-sm ${
        isReady ? "border-green-200 bg-green-50" : "border-gray-200 bg-white"
      }`}
    >
      {/* Aspect-ratio preview box */}
      <div
        className="w-full overflow-hidden rounded bg-gray-900"
        style={{ aspectRatio: `${fmt.width} / ${fmt.height}`, maxHeight: ar > 1 ? "64px" : "120px" }}
      >
        {capture?.preview ? (
          <img src={capture.preview} alt={fmt.label} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Image className="w-3 h-3 text-gray-600" />
          </div>
        )}
      </div>
      {/* Label + status */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <p className="text-[10px] font-medium text-gray-700 truncate leading-tight">{fmt.label}</p>
        {isReady
          ? <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
          : <AlertCircle className="w-3 h-3 text-gray-300 shrink-0" />
        }
      </div>
      <p className="text-[9px] text-gray-400 font-mono">{fmt.width}×{fmt.height}</p>
    </button>
  );
}

function ThumbnailFormatCard({ fmt, capture, onEdit, onDownload }: {
  fmt: ThumbnailFormat;
  capture?: CaptureRecord;
  onEdit: () => void;
  onDownload: () => void;
}) {
  const ar = fmt.width / fmt.height;
  // Compute a CSS aspect-ratio string
  const cssAR = `${fmt.width} / ${fmt.height}`;
  const isReady = !!capture;

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-gray-300 transition-colors">
      {/* Preview area — respects the format's actual aspect ratio */}
      <div className="relative w-full bg-gray-900 overflow-hidden" style={{ aspectRatio: cssAR, maxHeight: ar > 1 ? "180px" : "320px" }}>
        {capture?.preview
          ? <img src={capture.preview} alt={fmt.label} className="w-full h-full object-cover" />
          : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <Image className="w-5 h-5 text-gray-600" />
              <span className="text-[10px] text-gray-500">No capture yet</span>
            </div>
          )
        }
        <div className="absolute top-2 left-2">
          {isReady
            ? <Badge color="green"><CheckCircle className="w-2.5 h-2.5" />Ready</Badge>
            : <Badge color="gray"><AlertCircle className="w-2.5 h-2.5" />Missing</Badge>
          }
        </div>
        <div className="absolute top-2 right-2">
          <Badge color="gray">{fmt.width}×{fmt.height}</Badge>
        </div>
      </div>

      <div className="p-3 space-y-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{fmt.label}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">{fmt.platform} · {fmt.description}</p>
          {capture && (
            <p className="text-[10px] text-gray-400 flex items-center gap-1 mt-0.5">
              <Clock className="w-2.5 h-2.5" />
              {new Date(capture.capturedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>
        <div className="flex gap-1.5">
          <Btn onClick={onEdit} variant="primary" className="flex-1 justify-center text-xs py-1.5">
            {isReady ? <><Download className="w-3 h-3" />Edit</> : <><Camera className="w-3 h-3" />Create</>}
          </Btn>
          {isReady && (
            <Btn onClick={onDownload} variant="outline" className="px-2 py-1.5">
              <Download className="w-3 h-3" />
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ThumbnailsTab() {
  // ── Subjects ──────────────────────────────────────────────────────────────
  const [subjects, setSubjects] = useState<ThumbnailSubject[]>(() => {
    const stored = load<ThumbnailSubject[]>(THUMBNAIL_SUBJECTS_KEY, []);
    return stored.length > 0 ? stored : DEFAULT_THUMBNAIL_SUBJECTS;
  });
  const [allCaptures, setAllCaptures] = useState<Record<string, Record<string, CaptureRecord>>>(
    () => load(THUMBNAIL_SUBJECT_CAPS_KEY, {})
  );
  const [newSubjectName, setNewSubjectName] = useState("");
  const [activeSubjectId, setActiveSubjectId] = useState<string | null>(null);
  const [activeFmt, setActiveFmt] = useState<ThumbnailFormat | null>(null);

  const saveSubjects = (s: ThumbnailSubject[]) => {
    setSubjects(s);
    save(THUMBNAIL_SUBJECTS_KEY, s);
  };
  const saveAllCaptures = (c: Record<string, Record<string, CaptureRecord>>) => {
    setAllCaptures(c);
    try { save(THUMBNAIL_SUBJECT_CAPS_KEY, c); } catch {
      const slim = Object.fromEntries(
        Object.entries(c).map(([sid, fmts]) => [
          sid,
          Object.fromEntries(Object.entries(fmts).map(([fid, cap]) => [fid, { ...cap, fullRes: undefined }])),
        ])
      );
      save(THUMBNAIL_SUBJECT_CAPS_KEY, slim);
    }
  };

  const addSubject = () => {
    if (!newSubjectName.trim()) return;
    const s: ThumbnailSubject = { id: `sub-${Date.now()}`, name: newSubjectName.trim(), createdAt: Date.now() };
    saveSubjects([...subjects, s]);
    setNewSubjectName("");
  };
  const removeSubject = (id: string) => {
    saveSubjects(subjects.filter(s => s.id !== id));
    const next = { ...allCaptures };
    delete next[id];
    saveAllCaptures(next);
  };
  const handleCaptureSave = (preview: string, fullRes: string) => {
    if (!activeSubjectId || !activeFmt) return;
    const next = {
      ...allCaptures,
      [activeSubjectId]: {
        ...(allCaptures[activeSubjectId] ?? {}),
        [activeFmt.id]: { capturedAt: new Date().toISOString(), preview, fullRes },
      },
    };
    saveAllCaptures(next);
    setActiveFmt(null);
    setActiveSubjectId(null);
  };
  const downloadFmt = (subjectId: string, fmt: ThumbnailFormat) => {
    const cap = allCaptures[subjectId]?.[fmt.id];
    if (!cap?.fullRes) return;
    const a = Object.assign(document.createElement("a"), {
      href: cap.fullRes,
      download: `${subjects.find(s => s.id === subjectId)?.name.toLowerCase().replace(/\s+/g, "-") ?? subjectId}-${fmt.id}.jpg`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // Brand kit — structured, each asset persisted separately
  const [bk, setBk] = useState<BrandKit>({
    logo:    localStorage.getItem(BK_LOGO_KEY)    ?? "",
    product: localStorage.getItem(BK_PRODUCT_KEY) ?? "",
    style:   localStorage.getItem(BK_STYLE_KEY)   ?? "",
    strength: Number(localStorage.getItem(BK_STRENGTH_KEY) ?? "0.65"),
    colors: load<BrandColor[]>(BK_COLORS_KEY, DEFAULT_BRAND_COLORS),
  });
  const [bkExpanded, setBkExpanded] = useState(() =>
    !localStorage.getItem(BK_LOGO_KEY) && !localStorage.getItem(BK_PRODUCT_KEY) && !localStorage.getItem(BK_STYLE_KEY)
  );

  const updateBk = (patch: Partial<BrandKit>) => setBk(prev => ({ ...prev, ...patch }));

  const saveBkAsset = async (field: "logo" | "product" | "style", base64: string) => {
    const key = field === "logo" ? BK_LOGO_KEY : field === "product" ? BK_PRODUCT_KEY : BK_STYLE_KEY;
    // Use PNG for logo to preserve transparency; JPEG for style/product refs
    const fmt: "jpeg" | "png" = field === "logo" ? "png" : "jpeg";
    const maxW = field === "product" ? 800 : field === "logo" ? 400 : 512;
    // For logos: auto-remove solid backgrounds (flood-fill from perimeter) before resizing
    const processed = field === "logo"
      ? await removeLogoBackground(base64).catch(() => base64)
      : base64;
    const small = await resizeBrandRef(processed, maxW, fmt);
    updateBk({ [field]: small });
    localStorage.setItem(key, small);
  };

  const clearBkAsset = (field: "logo" | "product" | "style") => {
    const key = field === "logo" ? BK_LOGO_KEY : field === "product" ? BK_PRODUCT_KEY : BK_STYLE_KEY;
    updateBk({ [field]: "" });
    localStorage.removeItem(key);
  };

  const saveBkStrength = (v: number) => {
    updateBk({ strength: v });
    localStorage.setItem(BK_STRENGTH_KEY, String(v));
  };

  const saveBkColors = (colors: BrandColor[]) => {
    updateBk({ colors });
    save(BK_COLORS_KEY, colors);
  };

  const updateColor = (i: number, patch: Partial<BrandColor>) => {
    const next = bk.colors.map((c, idx) => idx === i ? { ...c, ...patch } : c);
    saveBkColors(next);
  };
  const addColor = () => saveBkColors([...bk.colors, { hex: "#000000", name: "New color" }]);
  const removeColor = (i: number) => saveBkColors(bk.colors.filter((_, idx) => idx !== i));

  const makeBkFileHandler = (field: "logo" | "product" | "style") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { if (ev.target?.result) saveBkAsset(field, ev.target.result as string); };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const logoRef    = useRef<HTMLInputElement>(null);
  const productRef = useRef<HTMLInputElement>(null);
  const styleRef   = useRef<HTMLInputElement>(null);

  const bkActive = !!(bk.logo || bk.product || bk.style);

  const BK_SLOTS = [
    {
      field: "logo" as const,
      label: "Logo",
      hint: "Solid background removed automatically on upload — PNG/JPG accepted",
      ref: logoRef,
      value: bk.logo,
      accept: "image/png,image/svg+xml,image/jpeg",
    },
    {
      field: "product" as const,
      label: "Product screenshot",
      hint: "Hero image — placed large on the AI background",
      ref: productRef,
      value: bk.product,
      accept: "image/*",
    },
    {
      field: "style" as const,
      label: "Style reference",
      hint: "Colour palette or brand image — guides AI background generation",
      ref: styleRef,
      value: bk.style,
      accept: "image/*",
    },
  ] as const;

  return (
    <div>
      {/* Brand Kit card */}
      <div className="rounded-xl border border-violet-200 bg-violet-50 mb-6 overflow-hidden">
        <button className="w-full flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-violet-100 transition-colors"
          onClick={() => setBkExpanded(e => !e)}>
          <div className="flex items-center gap-2.5">
            <Wand2 className="w-4 h-4 text-violet-600" />
            <span className="text-sm font-semibold text-violet-900">Brand Kit</span>
            {bkActive
              ? <span className="text-[10px] bg-violet-200 text-violet-700 rounded-full px-2 py-0.5 font-medium">
                  {[bk.logo && "Logo", bk.product && "Product", bk.style && "Style"].filter(Boolean).join(" · ")}
                </span>
              : <span className="text-[10px] bg-white text-gray-400 rounded-full px-2 py-0.5 border border-gray-200">Empty — add your brand assets</span>}
          </div>
          {bkExpanded ? <ChevronUp className="w-4 h-4 text-violet-400" /> : <ChevronDown className="w-4 h-4 text-violet-400" />}
        </button>

        {bkExpanded && (
          <div className="px-4 pb-4 border-t border-violet-100 pt-4 space-y-4">
            <p className="text-xs text-violet-700 leading-relaxed">
              Save your brand assets here. They are used automatically when generating AI thumbnails — style reference for the background, product screenshot as the hero, and logo composited on top.
            </p>

            {/* Asset slots */}
            <div className="grid grid-cols-3 gap-3">
              {BK_SLOTS.map(slot => (
                <div key={slot.field} className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">{slot.label}</p>
                  {slot.value ? (
                    <div className="relative group">
                      <img src={slot.value} alt={slot.label}
                        className="w-full aspect-video object-cover rounded-lg border border-violet-200 bg-gray-900" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-2">
                        <button onClick={() => slot.ref.current?.click()}
                          className="text-[10px] text-white bg-white/20 hover:bg-white/30 rounded px-2 py-1 cursor-pointer">Replace</button>
                        <button onClick={() => clearBkAsset(slot.field)}
                          className="text-[10px] text-white bg-red-500/60 hover:bg-red-500/80 rounded px-2 py-1 cursor-pointer">Remove</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => slot.ref.current?.click()}
                      className="w-full aspect-video rounded-lg border-2 border-dashed border-violet-300 hover:border-violet-500 bg-white hover:bg-violet-50 transition-colors cursor-pointer flex flex-col items-center justify-center gap-1">
                      <Plus className="w-4 h-4 text-violet-400" />
                      <span className="text-[10px] text-violet-400">Upload</span>
                    </button>
                  )}
                  <p className="text-[10px] text-gray-400 leading-tight">{slot.hint}</p>
                  <input ref={slot.ref} type="file" accept={slot.accept} className="hidden"
                    onChange={makeBkFileHandler(slot.field)} />
                </div>
              ))}
            </div>

            {/* Brand colors — injected into every AI prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">Brand colors</label>
                <button onClick={addColor} className="text-[10px] text-violet-600 hover:text-violet-800 cursor-pointer flex items-center gap-1">
                  <Plus className="w-3 h-3" />Add
                </button>
              </div>
              <p className="text-[10px] text-gray-400">These hex values are appended to every AI prompt so the background always uses your exact brand palette.</p>
              <div className="flex flex-wrap gap-2">
                {bk.colors.map((col, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5">
                    <input type="color" value={col.hex} onChange={e => updateColor(i, { hex: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent" />
                    <input type="text" value={col.name} onChange={e => updateColor(i, { name: e.target.value })}
                      className="w-20 text-[11px] text-gray-700 border-0 outline-none bg-transparent" />
                    <span className="text-[10px] font-mono text-gray-400">{col.hex}</span>
                    <button onClick={() => removeColor(i)} className="text-gray-300 hover:text-red-400 cursor-pointer ml-1"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* Creativity slider — only relevant when style reference is set */}
            {bk.style && (
              <div className="flex items-center gap-3 pt-1">
                <span className="text-[10px] text-gray-500 whitespace-nowrap">AI creativity</span>
                <input type="range" min={0.3} max={0.95} step={0.05} value={bk.strength}
                  onChange={e => saveBkStrength(Number(e.target.value))} className="flex-1 accent-violet-500" />
                <span className="text-[10px] font-mono text-gray-500 w-8 text-right">{Math.round(bk.strength * 100)}%</span>
                <span className="text-[10px] text-gray-400">Low = stays close to style ref · High = more creative</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add subject row */}
      <div className="flex gap-2 mb-6">
        <input
          value={newSubjectName}
          onChange={e => setNewSubjectName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addSubject()}
          placeholder="New subject — e.g. Script Editor, Pricing, Holiday promo..."
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
        <Btn onClick={addSubject} disabled={!newSubjectName.trim()}>
          <Plus className="w-3.5 h-3.5" />Add
        </Btn>
      </div>

      {/* Subject list */}
      {subjects.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">No thumbnail subjects yet — add one above.</div>
      ) : (
        <div className="space-y-4">
          {subjects.map(subject => {
            const subCaps = allCaptures[subject.id] ?? {};
            const readyCount = THUMBNAIL_FORMATS.filter(f => subCaps[f.id]).length;
            const pct = (readyCount / THUMBNAIL_FORMATS.length) * 100;
            return (
              <div key={subject.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                {/* Header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-gray-50">
                  <p className="text-sm font-semibold text-gray-900 flex-1">{subject.name}</p>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-gray-400">{readyCount}/{THUMBNAIL_FORMATS.length}</span>
                    <div className="h-1.5 w-20 rounded-full bg-gray-200 overflow-hidden">
                      <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <button onClick={() => removeSubject(subject.id)}
                    className="text-gray-300 hover:text-red-400 p-1 rounded transition-colors cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Format mini cards */}
                <div className="p-4 grid grid-cols-3 sm:grid-cols-6 gap-2.5">
                  {THUMBNAIL_FORMATS.map(fmt => {
                    const cap = subCaps[fmt.id];
                    return (
                      <div key={fmt.id} className="relative group">
                        <SubjectFormatMini
                          fmt={fmt}
                          capture={cap}
                          onClick={() => { setActiveSubjectId(subject.id); setActiveFmt(fmt); }}
                        />
                        {cap?.fullRes && (
                          <button
                            onClick={() => downloadFmt(subject.id, fmt)}
                            title="Download"
                            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 bg-white/90 hover:bg-white rounded p-0.5 shadow-sm transition-opacity cursor-pointer"
                          >
                            <Download className="w-2.5 h-2.5 text-gray-600" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl bg-gray-50 border border-gray-200 px-5 py-4 mt-6">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">File naming</p>
        <p className="text-xs text-gray-600 leading-relaxed">
          Downloads are named <code className="bg-white border border-gray-200 rounded px-1 font-mono">subject-formatid.jpg</code> — e.g.{" "}
          <code className="bg-white border border-gray-200 rounded px-1 font-mono">script-editor-yt.jpg</code>.
          Drop into <code className="bg-white border border-gray-200 rounded px-1 font-mono">plotwell-landing/public/thumbnails/</code>.
        </p>
      </div>

      {activeFmt && activeSubjectId && (
        <ThumbnailCaptureModal
          format={activeFmt}
          capture={allCaptures[activeSubjectId]?.[activeFmt.id]}
          brandKit={bk}
          onSave={handleCaptureSave}
          onClose={() => { setActiveFmt(null); setActiveSubjectId(null); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Subtitle editor
// ─────────────────────────────────────────────

function SubtitleEditor({ entries, onChange, currentTime }: {
  entries: SubtitleEntry[]; onChange: (entries: SubtitleEntry[]) => void; currentTime: number;
}) {
  const addEntry = () => {
    const start = Math.floor(currentTime);
    const entry: SubtitleEntry = { id: crypto.randomUUID(), start, end: start + 3, text: "" };
    onChange([...entries, entry].sort((a, b) => a.start - b.start));
  };

  const update = (id: string, field: keyof SubtitleEntry, value: string | number) => {
    onChange(entries.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  const remove = (id: string) => onChange(entries.filter(e => e.id !== id));

  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const active = entries.find(e => currentTime >= e.start && currentTime <= e.end);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Subtitles</p>
        <Btn variant="outline" onClick={addEntry} className="text-xs py-1"><Plus className="w-3 h-3" />Add at {formatTime(currentTime)}</Btn>
      </div>

      {sorted.length === 0
        ? <p className="text-xs text-gray-400 text-center py-4">No subtitles yet. Play the video, pause at the right moment, then click "Add".</p>
        : (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {sorted.map(e => (
              <div key={e.id} className={`flex items-start gap-2 rounded-lg border p-2 transition-colors ${active?.id === e.id ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
                <div className="flex items-center gap-1 shrink-0">
                  <input type="number" min={0} step={0.5} value={e.start} onChange={ev => update(e.id, "start", Number(ev.target.value))} className="w-14 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400" />
                  <span className="text-[10px] text-gray-400">→</span>
                  <input type="number" min={0} step={0.5} value={e.end} onChange={ev => update(e.id, "end", Number(ev.target.value))} className="w-14 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400" />
                </div>
                <input value={e.text} onChange={ev => update(e.id, "text", ev.target.value)} placeholder="Caption text…" className="flex-1 rounded border border-gray-200 px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400" />
                <button onClick={() => remove(e.id)} className="shrink-0 text-gray-300 hover:text-red-400 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}

// ─────────────────────────────────────────────
//  Speed zone types & constants (shared between RecordModal and VideoTrimmer)
// ─────────────────────────────────────────────

interface SpeedZone {
  id: string;
  start: number;
  end: number;
  speed: number; // 2 | 4 | 8 | 16
}

const SPEED_OPTIONS = [2, 4, 8, 16];
const SPEED_COLORS: Record<number, string> = {
  2:  "bg-blue-400/40 border-blue-500",
  4:  "bg-purple-400/40 border-purple-500",
  8:  "bg-pink-400/40 border-pink-500",
  16: "bg-red-400/40 border-red-500",
};
const SPEED_TEXT: Record<number, string> = {
  2: "text-blue-700", 4: "text-purple-700", 8: "text-pink-700", 16: "text-red-700",
};

// SpeedZoneRow: local string state so users can type freely without the
// controlled input resetting mid-keystroke (e.g. clearing "10" to type "20").
function SpeedZoneRow({ z, inPoint, outPoint, onUpdate, onRemove }: {
  z: SpeedZone;
  inPoint: number;
  outPoint: number;
  onUpdate: (patch: Partial<SpeedZone>) => void;
  onRemove: () => void;
}) {
  const [startStr, setStartStr] = useState(z.start.toFixed(1));
  const [endStr,   setEndStr  ] = useState(z.end.toFixed(1));
  const [speedStr, setSpeedStr] = useState(String(z.speed));

  // Stay in sync if parent updates from outside (e.g. drag-on-timeline)
  useEffect(() => setStartStr(z.start.toFixed(1)), [z.start]);
  useEffect(() => setEndStr(z.end.toFixed(1)),     [z.end]);
  useEffect(() => setSpeedStr(String(z.speed)),    [z.speed]);

  const commitStart = () => {
    const v = parseFloat(startStr);
    if (!isNaN(v)) onUpdate({ start: Math.max(inPoint, Math.min(v, z.end - 0.1)) });
    else setStartStr(z.start.toFixed(1));
  };
  const commitEnd = () => {
    const v = parseFloat(endStr);
    if (!isNaN(v)) onUpdate({ end: Math.min(outPoint, Math.max(v, z.start + 0.1)) });
    else setEndStr(z.end.toFixed(1));
  };
  const commitSpeed = () => {
    const v = parseFloat(speedStr);
    if (!isNaN(v) && v >= 1.1) onUpdate({ speed: Math.round(v * 10) / 10 });
    else setSpeedStr(String(z.speed));
  };

  const isPreset = SPEED_OPTIONS.includes(z.speed);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 flex-wrap">
      {/* Preset buttons */}
      <div className="flex items-center gap-1">
        {SPEED_OPTIONS.map(s => (
          <button key={s} onClick={() => onUpdate({ speed: s })}
            className={`w-9 py-0.5 rounded text-[11px] font-bold border cursor-pointer transition-colors ${
              z.speed === s ? `${SPEED_COLORS[s]} ${SPEED_TEXT[s]}` : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100"
            }`}>
            {s}×
          </button>
        ))}
        {/* Custom speed input */}
        <input
          type="text"
          inputMode="decimal"
          value={speedStr}
          onChange={e => setSpeedStr(e.target.value)}
          onBlur={commitSpeed}
          onKeyDown={e => e.key === "Enter" && commitSpeed()}
          title="Custom speed (e.g. 20)"
          className={`w-14 rounded border px-1.5 py-0.5 text-[11px] font-bold font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400 cursor-text ${
            !isPreset ? "border-amber-400 bg-amber-50 text-amber-700" : "border-gray-200 bg-white text-gray-400"
          }`}
          placeholder="20×"
        />
      </div>
      {/* Time range inputs — free typing, commits on blur/Enter */}
      <div className="flex items-center gap-1 text-xs text-gray-500">
        <input
          type="text"
          inputMode="decimal"
          value={startStr}
          onChange={e => setStartStr(e.target.value)}
          onBlur={commitStart}
          onKeyDown={e => e.key === "Enter" && commitStart()}
          className="w-16 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span>→</span>
        <input
          type="text"
          inputMode="decimal"
          value={endStr}
          onChange={e => setEndStr(e.target.value)}
          onBlur={commitEnd}
          onKeyDown={e => e.key === "Enter" && commitEnd()}
          className="w-16 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
      </div>
      <span className="text-[10px] text-gray-400 font-mono ml-auto shrink-0">{formatTime(z.end - z.start)}</span>
      <button onClick={onRemove} className="text-gray-300 hover:text-red-400 cursor-pointer shrink-0"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Record modal
// ─────────────────────────────────────────────

type RecordPhase = "setup" | "recording" | "paused" | "review";

function RecordModal({ entry, onClose }: { entry: VideoEntry; onClose: () => void }) {
  const [phase, setPhase] = useState<RecordPhase>("setup");
  const [elapsed, setElapsed] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [musicVol, setMusicVol] = useState(0.3);
  const [error, setError] = useState("");

  // Trim state
  const [videoDuration, setVideoDuration] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [speedZones, setSpeedZones] = useState<SpeedZone[]>([]);
  const [trimPhase, setTrimPhase] = useState<"idle" | "trimming" | "done">("idle");
  const [trimProgress, setTrimProgress] = useState(0);
  const [trimmedUrl, setTrimmedUrl] = useState<string | null>(null);
  const trimIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0); // always in sync with elapsed state for use in closures
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const musicUrlRef = useRef<string | null>(null);

  // Cleanup blob URLs on unmount
  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (trimmedUrl) URL.revokeObjectURL(trimmedUrl);
    if (musicUrlRef.current) URL.revokeObjectURL(musicUrlRef.current);
  }, [blobUrl, trimmedUrl]);

  // Sync video currentTime for subtitle editor
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handler = () => setCurrentTime(video.currentTime);
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [phase]);

  // Music volume
  useEffect(() => { if (musicRef.current) musicRef.current.volume = musicVol; }, [musicVol]);

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // ── Trim helpers ──
  const rateAt = (t: number) => speedZones.find(z => t >= z.start && t < z.end)?.speed ?? 1;
  const effectiveDuration = (() => {
    if (speedZones.length === 0) return outPoint - inPoint;
    let total = 0;
    for (let t = inPoint; t < outPoint; t += 0.1) total += 0.1 / rateAt(t);
    return total;
  })();

  const onVideoMetadata = () => {
    const raw = videoRef.current?.duration ?? 0;
    // Only trust browser-reported duration if it's a finite, plausible value.
    // MediaRecorder WebM blobs frequently report Infinity or a stale short value.
    if (isFinite(raw) && raw > 0.5) {
      setVideoDuration(raw); setInPoint(0); setOutPoint(raw);
      setTrimPhase("idle"); setSpeedZones([]);
    }
    // Otherwise keep the elapsed-based values set in recorder.onstop.
  };

  const seekFromTimeline = (e: React.MouseEvent) => {
    const rect = timelineRef.current?.getBoundingClientRect(); if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (videoRef.current) videoRef.current.currentTime = ratio * videoDuration;
  };

  const addSpeedZone = () => {
    const start = Math.max(inPoint, currentTime - 0.5);
    const end = Math.min(outPoint, start + Math.min(5, (outPoint - inPoint) / 3));
    setSpeedZones(z => [...z, { id: crypto.randomUUID(), start, end, speed: 2 }]);
  };
  const updateZone = (id: string, patch: Partial<SpeedZone>) =>
    setSpeedZones(z => z.map(s => s.id === id ? { ...s, ...patch } : s));
  const removeZone = (id: string) => setSpeedZones(z => z.filter(s => s.id !== id));

  const renderClip = async () => {
    const video = videoRef.current; if (!video) return;
    setTrimPhase("trimming"); setTrimProgress(0);
    video.pause();
    video.currentTime = inPoint;
    await new Promise<void>(res => {
      const fn = () => { video.removeEventListener("seeked", fn); res(); };
      video.addEventListener("seeked", fn);
    });
    const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(m => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (trimIntervalRef.current) clearInterval(trimIntervalRef.current);
      video.pause(); video.playbackRate = 1;
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      setTrimmedUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      setTrimPhase("done");
    };
    recorder.start(200);
    video.playbackRate = rateAt(inPoint);
    video.play();
    let wallElapsed = 0, lastRealTime = performance.now();
    trimIntervalRef.current = setInterval(() => {
      if (!videoRef.current) return;
      const now = performance.now();
      wallElapsed += (now - lastRealTime) / 1000; lastRealTime = now;
      const rate = rateAt(videoRef.current.currentTime);
      if (videoRef.current.playbackRate !== rate) videoRef.current.playbackRate = rate;
      setTrimProgress(Math.min(1, wallElapsed / effectiveDuration));
      if (videoRef.current.currentTime >= outPoint - 0.05) {
        recorder.stop();
        clearInterval(trimIntervalRef.current!);
      }
    }, 80);
  };

  const pct = (t: number) => videoDuration > 0 ? (t / videoDuration) * 100 : 0;

  const startRecording = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: true,
      });

      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(m => MediaRecorder.isTypeSupported(m)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
        setBlobUrl(URL.createObjectURL(blob));
        // MediaRecorder WebM blobs often have wrong/Infinity duration metadata.
        // Use elapsed (wall-clock recording time) to set the trim range immediately.
        const elapsedSnap = elapsedRef.current;
        setVideoDuration(elapsedSnap);
        setInPoint(0);
        setOutPoint(elapsedSnap);
        setTrimPhase("idle");
        setSpeedZones([]);
        setPhase("review");
      };
      recorder.start(1000);
      recorderRef.current = recorder;

      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(p => { elapsedRef.current = p + 1; return p + 1; }), 1000);
      setPhase("recording");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Permission denied") && !msg.includes("cancelled")) setError(msg);
    }
  };

  const pauseRecording = () => {
    recorderRef.current?.pause();
    stopTimer();
    setPhase("paused");
  };

  const resumeRecording = () => {
    recorderRef.current?.resume();
    timerRef.current = setInterval(() => setElapsed(p => { elapsedRef.current = p + 1; return p + 1; }), 1000);
    setPhase("recording");
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    stopTimer();
  };

  const handleMusicFile = (file: File) => {
    if (musicUrlRef.current) URL.revokeObjectURL(musicUrlRef.current);
    const url = URL.createObjectURL(file);
    musicUrlRef.current = url;
    setMusicFile(file);
    if (!musicRef.current) musicRef.current = new Audio();
    musicRef.current.src = url;
    musicRef.current.loop = true;
    musicRef.current.volume = musicVol;
  };

  const toggleMusic = () => {
    if (!musicRef.current) return;
    musicRef.current.paused ? musicRef.current.play() : musicRef.current.pause();
  };

  const downloadVideo = () => {
    const url = trimmedUrl || blobUrl; if (!url) return;
    fetch(url).then(r => r.blob()).then(blob => triggerDownload(blob, `${entry.id}.webm`));
  };

  const downloadSRT = () => {
    if (subtitles.length === 0) return;
    const blob = new Blob([toSRT(subtitles)], { type: "text/plain" });
    triggerDownload(blob, `${entry.id}.srt`);
  };

  const [burning, setBurning] = useState(false);
  const [burnProgress, setBurnProgress] = useState(0);

  const burnSubtitlesIntoVideo = async () => {
    const url = trimmedUrl || blobUrl;
    if (!url || subtitles.length === 0 || burning) return;

    setBurning(true);
    setBurnProgress(0);

    // Separate video element so we don't disturb the player
    const src = document.createElement("video");
    src.src = url;
    src.preload = "auto";
    src.muted = true; // unmuted via captureStream audio track below
    await new Promise<void>(res => { src.onloadedmetadata = () => res(); });

    const W = src.videoWidth  || 1280;
    const H = src.videoHeight || 720;
    const duration = src.duration || 60;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    // Canvas video stream + audio from source element
    const canvasStream = canvas.captureStream(30);
    try {
      const srcStream = (src as any).captureStream?.() as MediaStream | undefined;
      srcStream?.getAudioTracks().forEach(t => canvasStream.addTrack(t));
    } catch { /* audio unavailable — video-only */ }

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus" : "video/webm";
    const recorder = new MediaRecorder(canvasStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      triggerDownload(blob, `${entry.id}-social.webm`);
      setBurning(false);
      setBurnProgress(0);
    };

    const fontSize = Math.round(H * 0.048);

    const drawFrame = () => {
      ctx.drawImage(src, 0, 0, W, H);

      const t = src.currentTime;
      setBurnProgress(t / duration);

      const sub = subtitles.find(s => t >= s.start && t <= s.end);
      if (sub) {
        const lines = sub.text.split("\n");
        const lineH = fontSize * 1.35;
        const totalH = lines.length * lineH;
        const baseY = H - fontSize * 1.2 - totalH;

        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        // Background box
        const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
        const pad = fontSize * 0.45;
        ctx.fillStyle = "rgba(0,0,0,0.68)";
        ctx.beginPath();
        const bx = W / 2 - maxW / 2 - pad;
        const by = baseY - pad * 0.5;
        const bw = maxW + pad * 2;
        const bh = totalH + pad;
        const r = 8;
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();

        // Text
        ctx.fillStyle = "white";
        lines.forEach((line, i) => {
          ctx.fillText(line, W / 2, baseY + i * lineH);
        });
      }

      if (!src.ended && !src.paused) {
        requestAnimationFrame(drawFrame);
      } else {
        recorder.stop();
      }
    };

    recorder.start(100);
    src.play();
    requestAnimationFrame(drawFrame);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{entry.label}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Screen recording</p>
          </div>
          <button onClick={() => { stopTimer(); onClose(); }} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer"><X className="w-4 h-4 text-gray-500" /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-5">
          {/* ── SETUP ── */}
          {phase === "setup" && (
            <>
              <SizeLauncher section={entry.id} device={entry.format} />
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">What to show</p>
                <p className="text-sm text-amber-900 leading-relaxed">{entry.description}</p>
              </div>
              <p className="text-xs text-gray-500">
                Click <strong>Start recording</strong>. Chrome will ask you to pick a tab — choose the plotwell tab. System audio is captured automatically.
              </p>
              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex justify-end">
                <Btn onClick={startRecording} variant="red"><Circle className="w-4 h-4" fill="currentColor" />Start recording</Btn>
              </div>
            </>
          )}

          {/* ── RECORDING / PAUSED ── */}
          {(phase === "recording" || phase === "paused") && (
            <div className="flex flex-col items-center gap-6 py-6">
              <div className="flex items-center gap-3">
                {phase === "recording" && <Circle className="w-4 h-4 text-red-500 animate-pulse" fill="currentColor" />}
                {phase === "paused" && <Pause className="w-4 h-4 text-amber-500" />}
                <span className="text-4xl font-mono font-bold text-gray-900 tabular-nums">{formatTime(elapsed)}</span>
              </div>
              <p className="text-sm text-gray-500">{phase === "recording" ? "Recording in progress…" : "Paused"}</p>
              <div className="flex items-center gap-3">
                {phase === "recording"
                  ? <Btn onClick={pauseRecording} variant="outline"><Pause className="w-4 h-4" />Pause</Btn>
                  : <Btn onClick={resumeRecording} variant="outline"><Play className="w-4 h-4" />Resume</Btn>
                }
                <Btn onClick={stopRecording} variant="red"><Square className="w-4 h-4" />Stop</Btn>
              </div>
            </div>
          )}

          {/* ── REVIEW ── */}
          {phase === "review" && blobUrl && (() => {
            const activeSub = subtitles.find(e => currentTime >= e.start && currentTime <= e.end);
            const inPct = pct(inPoint), outPct = pct(outPoint), curPct = pct(currentTime);
            return (
            <>
              {/* 1. Video player with subtitle overlay */}
              <div className="relative rounded-xl overflow-hidden border border-gray-200 bg-black">
                <video ref={videoRef} src={trimmedUrl || blobUrl} controls
                  onLoadedMetadata={onVideoMetadata}
                  className="w-full max-h-64 object-contain" />
                {activeSub && (
                  <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none">
                    <div className="bg-black/75 text-white text-sm font-medium px-4 py-1.5 rounded-lg text-center max-w-lg">{activeSub.text}</div>
                  </div>
                )}
              </div>

              {/* 2. Trim & Speed Zones */}
              <div className="rounded-xl border border-gray-200 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Scissors className="w-4 h-4 text-gray-500" />
                    <p className="text-sm font-semibold text-gray-700">Trim & Speed</p>
                    {trimPhase === "done" && <Badge color="green"><CheckCircle className="w-2.5 h-2.5" />Rendered</Badge>}
                  </div>
                  {trimPhase === "done" && (
                    <Btn variant="outline" className="text-xs py-1" onClick={() => setTrimPhase("idle")}>
                      <Scissors className="w-3 h-3" />Edit again
                    </Btn>
                  )}
                </div>

                {videoDuration > 0 && trimPhase !== "done" && (
                  <>
                    {/* Timeline */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold">
                          {formatTime(inPoint)} → {formatTime(outPoint)}
                        </span>
                        <span className="text-xs font-mono text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                          {formatTime(outPoint - inPoint)}
                        </span>
                      </div>
                      <div ref={timelineRef}
                        className="relative h-10 rounded-lg bg-gray-200 cursor-crosshair select-none overflow-hidden"
                        onMouseDown={seekFromTimeline}>
                        <div className="absolute inset-y-0 left-0 bg-black/30" style={{ width: `${inPct}%` }} />
                        <div className="absolute inset-y-0 right-0 bg-black/30" style={{ width: `${100 - outPct}%` }} />
                        <div className="absolute inset-y-0 bg-amber-400/50"
                          style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }} />
                        <div className="absolute top-0 bottom-0 w-1 bg-amber-500 rounded-sm" style={{ left: `${inPct}%` }} />
                        <div className="absolute top-0 bottom-0 w-1 bg-amber-500 rounded-sm" style={{ left: `calc(${outPct}% - 4px)` }} />
                        {speedZones.map(z => (
                          <div key={z.id}
                            className={`absolute inset-y-0 border-y-2 ${SPEED_COLORS[z.speed] ?? "bg-blue-400/40 border-blue-500"} flex items-center justify-center pointer-events-none`}
                            style={{ left: `${pct(z.start)}%`, width: `${pct(z.end) - pct(z.start)}%` }}>
                            <span className={`text-[10px] font-bold ${SPEED_TEXT[z.speed] ?? "text-blue-700"}`}>{z.speed}×</span>
                          </div>
                        ))}
                        <div className="absolute inset-y-0 w-0.5 bg-white shadow pointer-events-none" style={{ left: `${curPct}%` }} />
                      </div>
                    </div>

                    {/* In/Out sliders */}
                    <div className="grid grid-cols-2 gap-3">
                      {([
                        { label: "In point",  val: inPoint,  set: (v: number) => { setInPoint(v); if (videoRef.current) videoRef.current.currentTime = v; }, min: 0, max: outPoint - 0.1 },
                        { label: "Out point", val: outPoint, set: (v: number) => { setOutPoint(v); if (videoRef.current) videoRef.current.currentTime = v; }, min: inPoint + 0.1, max: videoDuration },
                      ] as { label: string; val: number; set: (v: number) => void; min: number; max: number }[]).map(({ label, val, set, min, max }) => (
                        <div key={label}>
                          <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">{label}</label>
                          <input type="range" min={min} max={max} step={0.1} value={val}
                            onChange={e => set(Number(e.target.value))} className="w-full accent-amber-500" />
                          <span className="text-[11px] font-mono text-gray-500">{formatTime(val)}</span>
                        </div>
                      ))}
                    </div>

                    {/* Speed zones */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold">Speed zones</p>
                        <Btn variant="outline" onClick={addSpeedZone} className="text-xs py-1 px-2">
                          <Plus className="w-3 h-3" />Add at {formatTime(currentTime)}
                        </Btn>
                      </div>
                      {speedZones.length === 0
                        ? <p className="text-xs text-gray-400">No speed zones. Play, pause at the section to speed up, then click "Add".</p>
                        : (
                          <div className="space-y-2">
                            {[...speedZones].sort((a, b) => a.start - b.start).map(z => (
                              <SpeedZoneRow
                                key={z.id}
                                z={z}
                                inPoint={inPoint}
                                outPoint={outPoint}
                                onUpdate={patch => updateZone(z.id, patch)}
                                onRemove={() => removeZone(z.id)}
                              />
                            ))}
                          </div>
                        )
                      }
                    </div>

                    {/* Render button / progress */}
                    {trimPhase === "idle" && (
                      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
                        <p className="text-xs text-gray-400">
                          Est. output: <span className="font-mono text-gray-600">{formatTime(effectiveDuration)}</span>
                          {speedZones.length > 0 && <span> · {speedZones.length} speed zone{speedZones.length > 1 ? "s" : ""}</span>}
                        </p>
                        <Btn onClick={renderClip}><Scissors className="w-3.5 h-3.5" />Render clip</Btn>
                      </div>
                    )}
                    {trimPhase === "trimming" && (
                      <div className="space-y-2 border-t border-gray-100 pt-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />Rendering{speedZones.length > 0 ? " with speed zones" : ""}…
                          </span>
                          <span className="font-mono text-gray-600">{Math.round(trimProgress * 100)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${trimProgress * 100}%` }} />
                        </div>
                      </div>
                    )}
                  </>
                )}
                {videoDuration === 0 && <p className="text-xs text-gray-400">Loading video…</p>}
              </div>

              {/* 3. Background music */}
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Music className="w-4 h-4 text-gray-500" />
                  <p className="text-sm font-semibold text-gray-700">Background music</p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="cursor-pointer">
                    <input type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleMusicFile(f); }} />
                    <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 cursor-pointer transition-colors">
                      <Plus className="w-3.5 h-3.5" />{musicFile ? musicFile.name : "Upload audio"}
                    </span>
                  </label>
                  {musicFile && (
                    <>
                      <Btn variant="ghost" onClick={toggleMusic}><Play className="w-3.5 h-3.5" />Preview</Btn>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Vol</span>
                        <input type="range" min={0} max={1} step={0.05} value={musicVol} onChange={e => setMusicVol(Number(e.target.value))} className="w-24 accent-amber-500" />
                        <span className="text-xs text-gray-500 w-8">{Math.round(musicVol * 100)}%</span>
                      </div>
                    </>
                  )}
                </div>
                <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
                  Upload an MP3/WAV. Download both files, then merge in any video editor.
                </p>
              </div>

              {/* 4. Subtitles */}
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Subtitles className="w-4 h-4 text-gray-500" />
                  <p className="text-sm font-semibold text-gray-700">Subtitles</p>
                </div>
                <SubtitleEditor entries={subtitles} onChange={setSubtitles} currentTime={currentTime} />
              </div>

              {/* 5. Export */}
              <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Export</p>
                <div className="flex flex-wrap gap-2">
                  <Btn onClick={downloadVideo}>
                    <Download className="w-3.5 h-3.5" />Download {trimmedUrl ? "clip" : "video"} (.webm)
                  </Btn>
                  {subtitles.length > 0 && (
                    <>
                      <Btn
                        onClick={burnSubtitlesIntoVideo}
                        disabled={burning}
                        className="bg-violet-600 hover:bg-violet-700 border-violet-600 hover:border-violet-700 text-white"
                      >
                        {burning
                          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Burning… {Math.round(burnProgress * 100)}%</>
                          : <><Subtitles className="w-3.5 h-3.5" />Download with subtitles (social)</>
                        }
                      </Btn>
                      <Btn variant="outline" onClick={downloadSRT}>
                        <Download className="w-3.5 h-3.5" />.srt only
                      </Btn>
                    </>
                  )}
                </div>
                {burning && (
                  <div className="mt-2 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${burnProgress * 100}%` }} />
                  </div>
                )}
                <p className="mt-2 text-[10px] text-gray-400">
                  "Download with subtitles" burns text into the video pixels — one file, ready for social.
                  Upload the plain .webm to YouTube directly, or convert to MP4 with VLC/Handbrake.
                </p>
              </div>
            </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Video row
// ─────────────────────────────────────────────

function VideoRow({ entry, youtubeId, onChange, onRecord, onDelete }: {
  entry: VideoEntry; youtubeId: string; onChange: (id: string) => void;
  onRecord: () => void; onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(youtubeId);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const commit = () => { onChange(draft.trim()); setEditing(false); };
  const hasVideo = youtubeId.length > 0;

  return (
    <div className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="shrink-0 w-24 h-14 rounded-lg overflow-hidden bg-gray-100 border border-gray-200">
        {hasVideo
          ? <img src={`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`} alt={entry.label} className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center"><Video className="w-5 h-5 text-gray-300" /></div>
        }
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-gray-900">{entry.label}</p>
          {hasVideo ? <Badge color="green"><CheckCircle className="w-2.5 h-2.5" />Published</Badge> : <Badge color="amber"><AlertCircle className="w-2.5 h-2.5" />Not published</Badge>}
          {entry.custom && <Badge color="gray">Custom</Badge>}
        </div>
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{entry.description}</p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {editing
            ? <div className="flex items-center gap-2 flex-1">
                <input ref={inputRef} className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="YouTube video ID" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
                <Btn onClick={commit} variant="primary" className="py-1 px-2.5 text-xs">Save</Btn>
                <Btn onClick={() => setEditing(false)} variant="ghost" className="py-1 px-2 text-xs">Cancel</Btn>
              </div>
            : <div className="flex items-center gap-2">
                <button onClick={() => { setDraft(youtubeId); setEditing(true); }} className="text-xs font-mono text-gray-500 hover:text-gray-800 underline underline-offset-2 cursor-pointer">{youtubeId || "Set YouTube ID"}</button>
                {hasVideo && <>
                  <button onClick={async () => { await navigator.clipboard.writeText(youtubeId); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="cursor-pointer text-gray-400 hover:text-gray-600">{copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}</button>
                  <a href={`https://www.youtube.com/watch?v=${youtubeId}`} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-gray-600"><ExternalLink className="w-3 h-3" /></a>
                </>}
              </div>
          }
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Btn onClick={onRecord} variant="red" className="text-xs py-1.5"><Circle className="w-3 h-3" fill="currentColor" />Record</Btn>
        {onDelete && <button onClick={onDelete} className="rounded-lg p-1.5 hover:bg-red-50 text-gray-300 hover:text-red-400 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Add Video modal
// ─────────────────────────────────────────────

function AddVideoModal({ onAdd, onClose, existingIds }: {
  onAdd: (e: VideoEntry) => void; onClose: () => void; existingIds: Set<string>;
}) {
  const [label, setLabel] = useState(""); const [description, setDescription] = useState(""); const [youtubeId, setYoutubeId] = useState("");
  const [format, setFormat] = useState<"desktop" | "mobile">("desktop");
  const id = label.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const conflict = existingIds.has(id);
  const valid = id.length > 0 && description.length > 0 && !conflict;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">New video entry</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100 cursor-pointer"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Label</label>
            <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="e.g. Beat Sheet" value={label} onChange={e => setLabel(e.target.value)} />
            {id && conflict && <p className="mt-1 text-[10px] text-red-500 font-mono">"{id}" already exists</p>}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Description</label>
            <textarea className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none" rows={2} placeholder="Short description shown under the video" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-600 mb-1">YouTube ID <span className="font-normal text-gray-400">(optional)</span></label>
              <input className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="e.g. dQw4w9WgXcQ" value={youtubeId} onChange={e => setYoutubeId(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Format</label>
              <select value={format} onChange={e => setFormat(e.target.value as "desktop" | "mobile")}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none bg-white">
                <option value="desktop">🖥 Desktop</option>
                <option value="mobile">📱 Mobile</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="outline" onClick={onClose}>Cancel</Btn>
            <Btn onClick={() => onAdd({ id, label, description, youtubeId: youtubeId.trim(), custom: true, format })} disabled={!valid}><Plus className="w-3.5 h-3.5" />Add video</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Videos tab
// ─────────────────────────────────────────────

function VideosTab() {
  const [customVideos, setCustomVideos] = useState<VideoEntry[]>(() => load(CUSTOM_VIDEOS_KEY, []));
  const [ids, setIds] = useState<Record<string, string>>(() => {
    const stored = load<Record<string, string>>(VIDEO_IDS_KEY, {});
    const merged: Record<string, string> = {};
    for (const v of BUILT_IN_VIDEOS) merged[v.id] = stored[v.id] ?? v.youtubeId;
    for (const v of load<VideoEntry[]>(CUSTOM_VIDEOS_KEY, [])) merged[v.id] = stored[v.id] ?? v.youtubeId;
    return merged;
  });
  const [recording, setRecording] = useState<VideoEntry | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const allVideos = [...BUILT_IN_VIDEOS, ...customVideos];
  const existingIds = new Set(allVideos.map(v => v.id));
  const published = allVideos.filter(v => ids[v.id]?.length).length;

  const handleIdChange = (entryId: string, youtubeId: string) => {
    const next = { ...ids, [entryId]: youtubeId };
    setIds(next); save(VIDEO_IDS_KEY, next);
  };

  const handleAddVideo = (entry: VideoEntry) => {
    const next = [...customVideos, entry]; setCustomVideos(next); save(CUSTOM_VIDEOS_KEY, next);
    setIds(p => { const n = { ...p, [entry.id]: entry.youtubeId }; save(VIDEO_IDS_KEY, n); return n; });
    setShowAddModal(false);
  };

  const handleDeleteVideo = (id: string) => {
    setCustomVideos(customVideos.filter(v => v.id !== id)); save(CUSTOM_VIDEOS_KEY, customVideos.filter(v => v.id !== id));
  };

  const desktopVideos = allVideos.filter(v => (v.format ?? "desktop") === "desktop");
  const mobileVideos  = allVideos.filter(v => v.format === "mobile");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-600"><span className="font-semibold text-gray-900">{published}</span> / {allVideos.length} published to YouTube</div>
          <div className="h-1.5 w-32 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${allVideos.length > 0 ? (published / allVideos.length) * 100 : 0}%` }} /></div>
        </div>
        <Btn onClick={() => setShowAddModal(true)} variant="outline"><Plus className="w-3.5 h-3.5" />Add video</Btn>
      </div>

      {desktopVideos.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">🖥 Desktop demos</p>
          <div className="space-y-3">
            {desktopVideos.map(entry => (
              <VideoRow key={entry.id} entry={entry} youtubeId={ids[entry.id] ?? ""} onChange={id => handleIdChange(entry.id, id)} onRecord={() => setRecording(entry)} onDelete={entry.custom ? () => handleDeleteVideo(entry.id) : undefined} />
            ))}
          </div>
        </div>
      )}

      {mobileVideos.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">📱 Mobile demos</p>
          <div className="space-y-3">
            {mobileVideos.map(entry => (
              <VideoRow key={entry.id} entry={entry} youtubeId={ids[entry.id] ?? ""} onChange={id => handleIdChange(entry.id, id)} onRecord={() => setRecording(entry)} onDelete={entry.custom ? () => handleDeleteVideo(entry.id) : undefined} />
            ))}
          </div>
        </div>
      )}


      <div className="mt-6 rounded-xl bg-gray-50 border border-gray-200 px-5 py-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Workflow</p>
        <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside leading-relaxed">
          <li>Click <strong>Record</strong> — set window size, then start screen recording</li>
          <li>After stopping, add subtitles by playing the video and clicking "Add" at each moment</li>
          <li>Optionally upload background music and preview the mix</li>
          <li>Download the <code className="bg-white border border-gray-200 rounded px-1 font-mono">.webm</code> + <code className="bg-white border border-gray-200 rounded px-1 font-mono">.srt</code></li>
          <li>Upload to YouTube, then paste the video ID back here</li>
        </ol>
      </div>

      {recording && <RecordModal entry={recording} onClose={() => setRecording(null)} />}
      {showAddModal && <AddVideoModal onAdd={handleAddVideo} onClose={() => setShowAddModal(false)} existingIds={existingIds} />}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Video trimmer
// ─────────────────────────────────────────────

type TrimPhase = "idle" | "loaded" | "trimming" | "done";

function VideoTrimmer() {
  const [file, setFile] = useState<File | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [phase, setPhase] = useState<TrimPhase>("idle");
  const [trimProgress, setTrimProgress] = useState(0);
  const [trimmedUrl, setTrimmedUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [speedZones, setSpeedZones] = useState<SpeedZone[]>([]);
  const [importedSubs, setImportedSubs] = useState<SubtitleEntry[]>([]);
  const [burning, setBurning] = useState(false);
  const [burnProgress, setBurnProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const trimIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    if (trimmedUrl) URL.revokeObjectURL(trimmedUrl);
  }, [srcUrl, trimmedUrl]);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [phase]);

  const loadFile = (f: File) => {
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    if (trimmedUrl) { URL.revokeObjectURL(trimmedUrl); setTrimmedUrl(null); }
    setFile(f); setSrcUrl(URL.createObjectURL(f));
    setPhase("idle"); setSpeedZones([]);
  };

  const onMetadata = () => {
    const dur = videoRef.current?.duration ?? 0;
    setDuration(dur); setInPoint(0); setOutPoint(dur); setPhase("loaded");
  };

  const seekFromEvent = (e: React.MouseEvent) => {
    const rect = timelineRef.current?.getBoundingClientRect(); if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (videoRef.current) videoRef.current.currentTime = ratio * duration;
  };

  // Returns the playback rate that should be active at time t
  const rateAt = (t: number) => speedZones.find(z => t >= z.start && t < z.end)?.speed ?? 1;

  // Effective wall-clock duration: normal parts run 1:1, speed zones compress
  const effectiveDuration = (() => {
    if (speedZones.length === 0) return outPoint - inPoint;
    let total = 0;
    // Walk through [inPoint, outPoint] in small steps
    const step = 0.1;
    for (let t = inPoint; t < outPoint; t += step) {
      total += step / rateAt(t);
    }
    return total;
  })();

  const addSpeedZone = () => {
    // Default: current-time ± 5s, clamped to clip range
    const start = Math.max(inPoint, currentTime - 0.5);
    const end   = Math.min(outPoint, start + Math.min(5, (outPoint - inPoint) / 3));
    setSpeedZones(z => [...z, { id: crypto.randomUUID(), start, end, speed: 2 }]);
  };

  const updateZone = (id: string, patch: Partial<SpeedZone>) =>
    setSpeedZones(z => z.map(s => s.id === id ? { ...s, ...patch } : s));

  const removeZone = (id: string) => setSpeedZones(z => z.filter(s => s.id !== id));

  const trim = async () => {
    const video = videoRef.current; if (!video) return;
    setPhase("trimming"); setTrimProgress(0);

    video.pause();
    video.currentTime = inPoint;
    await new Promise<void>(res => {
      const fn = () => { video.removeEventListener("seeked", fn); res(); };
      video.addEventListener("seeked", fn);
    });

    const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) ?? "video/webm";

    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (trimIntervalRef.current) clearInterval(trimIntervalRef.current);
      video.pause(); video.playbackRate = 1;
      setTrimmedUrl(URL.createObjectURL(new Blob(chunks, { type: mimeType })));
      setPhase("done");
    };

    recorder.start(200);
    video.playbackRate = rateAt(inPoint);
    video.play();

    let wallElapsed = 0;
    let lastRealTime = performance.now();

    trimIntervalRef.current = setInterval(() => {
      if (!videoRef.current) return;
      const now = performance.now();
      wallElapsed += (now - lastRealTime) / 1000;
      lastRealTime = now;

      // Update playback rate for current position
      const rate = rateAt(videoRef.current.currentTime);
      if (videoRef.current.playbackRate !== rate) videoRef.current.playbackRate = rate;

      setTrimProgress(Math.min(1, wallElapsed / effectiveDuration));

      if (videoRef.current.currentTime >= outPoint - 0.05) {
        recorder.stop();
        clearInterval(trimIntervalRef.current!);
      }
    }, 80);
  };

  const downloadTrimmed = () => {
    if (!trimmedUrl || !file) return;
    fetch(trimmedUrl).then(r => r.blob())
      .then(b => triggerDownload(b, `${file.name.replace(/\.[^.]+$/, "")}-edit.webm`));
  };

  const loadSRT = (f: File) => {
    f.text().then(text => setImportedSubs(parseSRT(text)));
  };

  const burnSubs = async () => {
    const sourceUrl = trimmedUrl || srcUrl;
    if (!sourceUrl || importedSubs.length === 0 || burning) return;
    setBurning(true); setBurnProgress(0);

    // Must be in DOM for captureStream + autoplay
    const src = document.createElement("video");
    Object.assign(src.style, { position: "fixed", top: "-9999px", left: "-9999px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    src.src = sourceUrl;
    src.preload = "auto";
    src.muted = true; // allows autoplay; AudioContext still captures audio pre-mute
    document.body.appendChild(src);

    await new Promise<void>(res => {
      if (src.readyState >= 1) { res(); return; }
      src.onloadedmetadata = () => res();
    });

    const startAt = trimmedUrl ? 0 : inPoint;
    const endAt   = trimmedUrl ? src.duration : outPoint;
    const dur = Math.max(endAt - startAt, 0.1);
    const W = src.videoWidth || 1280;
    const H = src.videoHeight || 720;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    const canvasStream = canvas.captureStream(30);

    // Web Audio captures audio even from muted elements (pre-mute in the pipeline)
    let audioCtx: AudioContext | null = null;
    try {
      audioCtx = new AudioContext();
      const elSrc = audioCtx.createMediaElementSource(src);
      const dest  = audioCtx.createMediaStreamDestination();
      elSrc.connect(dest);
      dest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
    } catch { /* audio capture unavailable */ }

    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) ?? "video/webm";

    const recorder = new MediaRecorder(canvasStream, { mimeType });
    const chunks: Blob[] = [];
    let done = false;

    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      audioCtx?.close();
      document.body.removeChild(src);
      const blob = new Blob(chunks, { type: "video/webm" });
      const name = file ? `${file.name.replace(/\.[^.]+$/, "")}-subtitled.webm` : "video-subtitled.webm";
      triggerDownload(blob, name);
      setBurning(false); setBurnProgress(0);
    };

    const finish = () => {
      if (done) return;
      done = true;
      recorder.requestData();
      recorder.stop();
    };

    const fontSize = Math.round(H * 0.048);
    // If trimmedUrl: clip starts at 0 but srt timestamps start at inPoint
    const timeOffset = trimmedUrl ? inPoint : 0;

    const drawSub = (absT: number) => {
      const sub = importedSubs.find(s => absT >= s.start && absT <= s.end);
      if (!sub) return;
      const lines = sub.text.split("\n");
      const lineH = fontSize * 1.35;
      const totalH = lines.length * lineH;
      const baseY = H - fontSize * 1.2 - totalH;
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
      const pad = fontSize * 0.45;
      const bx = W/2 - maxW/2 - pad, by = baseY - pad*0.5;
      const bw = maxW + pad*2, bh = totalH + pad, r = 8;
      ctx.fillStyle = "rgba(0,0,0,0.68)";
      ctx.beginPath();
      ctx.moveTo(bx+r,by); ctx.lineTo(bx+bw-r,by); ctx.quadraticCurveTo(bx+bw,by,bx+bw,by+r);
      ctx.lineTo(bx+bw,by+bh-r); ctx.quadraticCurveTo(bx+bw,by+bh,bx+bw-r,by+bh);
      ctx.lineTo(bx+r,by+bh); ctx.quadraticCurveTo(bx,by+bh,bx,by+bh-r);
      ctx.lineTo(bx,by+r); ctx.quadraticCurveTo(bx,by,bx+r,by);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "white";
      lines.forEach((l, i) => ctx.fillText(l, W/2, baseY + i*lineH));
    };

    // requestVideoFrameCallback gives frame-perfect sync (Chrome 83+), fallback to RAF
    const hasRVFC = typeof (src as any).requestVideoFrameCallback === "function";

    if (hasRVFC) {
      const onFrame = (_: number, meta: { mediaTime: number }) => {
        if (done) return;
        ctx.drawImage(src, 0, 0, W, H);
        drawSub(meta.mediaTime + timeOffset);
        setBurnProgress(Math.min((meta.mediaTime - startAt) / dur, 1));
        if (meta.mediaTime >= endAt - 0.05) { finish(); return; }
        (src as any).requestVideoFrameCallback(onFrame);
      };
      (src as any).requestVideoFrameCallback(onFrame);
    } else {
      const tick = () => {
        if (done) return;
        ctx.drawImage(src, 0, 0, W, H);
        drawSub(src.currentTime + timeOffset);
        setBurnProgress(Math.min((src.currentTime - startAt) / dur, 1));
        if (src.currentTime >= endAt - 0.05 || src.ended) { finish(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    src.addEventListener("ended", finish, { once: true });

    // Seek, draw first frame, then start recorder BEFORE play
    src.currentTime = startAt;
    await new Promise<void>(res => { src.onseeked = () => res(); });
    ctx.drawImage(src, 0, 0, W, H); // prime the canvas
    recorder.start(200);
    src.play().catch(() => { /* autoplay blocked — user needs to interact */ });
  };

  const p = (t: number) => duration > 0 ? (t / duration) * 100 : 0;
  const inPct  = p(inPoint);
  const outPct = p(outPoint);
  const curPct = p(currentTime);

  return (
    <div className="space-y-6">

      {/* Drop zone */}
      <label
        className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 cursor-pointer transition-colors ${dragging ? "border-amber-400 bg-amber-50" : "border-gray-200 hover:border-amber-300 hover:bg-gray-50"}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("video/")) loadFile(f); }}
      >
        <input type="file" accept="video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
        <Video className="w-8 h-8 text-gray-300" />
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700">{file ? file.name : "Drop a video file here"}</p>
          <p className="text-xs text-gray-400 mt-0.5">{file ? `${(file.size / 1e6).toFixed(1)} MB` : "or click to browse · MP4, WebM, MOV"}</p>
        </div>
        {file && <span className="text-xs text-amber-600 font-medium">Change file</span>}
      </label>

      {/* SRT import */}
      <label className={`flex items-center gap-3 rounded-xl border border-dashed px-4 py-3 cursor-pointer transition-colors ${importedSubs.length > 0 ? "border-violet-300 bg-violet-50" : "border-gray-200 hover:border-violet-300 hover:bg-gray-50"}`}>
        <input type="file" accept=".srt,.vtt" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadSRT(f); }} />
        <Subtitles className={`w-4 h-4 shrink-0 ${importedSubs.length > 0 ? "text-violet-500" : "text-gray-300"}`} />
        {importedSubs.length > 0
          ? <span className="text-sm text-violet-700 font-medium">{importedSubs.length} subtitle{importedSubs.length > 1 ? "s" : ""} loaded — <span className="font-normal text-violet-500">click to replace</span></span>
          : <span className="text-sm text-gray-400">Upload .srt file to burn subtitles into the video <span className="text-gray-300">(optional)</span></span>
        }
        {importedSubs.length > 0 && (
          <button className="ml-auto text-gray-300 hover:text-red-400 cursor-pointer" onClick={e => { e.preventDefault(); setImportedSubs([]); }}>
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </label>

      {/* Video player */}
      {srcUrl && (
        <div className="rounded-xl overflow-hidden border border-gray-200 bg-black">
          <video ref={videoRef} src={srcUrl} className="w-full max-h-72 object-contain"
            controls onLoadedMetadata={onMetadata} />
        </div>
      )}

      {/* Timeline + controls */}
      {phase !== "idle" && duration > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-5">

          {/* ── Timeline ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Timeline</p>
              <span className="text-xs font-mono text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                {formatTime(inPoint)} → {formatTime(outPoint)} · {formatTime(outPoint - inPoint)}
              </span>
            </div>

            {/* Main bar */}
            <div ref={timelineRef}
              className="relative h-12 rounded-lg bg-gray-100 cursor-crosshair select-none overflow-hidden"
              onMouseDown={seekFromEvent}>
              {/* Dimmed outside trim range */}
              <div className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${inPct}%` }} />
              <div className="absolute inset-y-0 right-0 bg-black/25" style={{ width: `${100 - outPct}%` }} />
              {/* Active range fill */}
              <div className="absolute inset-y-0 bg-amber-400/20 border-y-2 border-amber-400"
                style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }} />
              {/* Speed zones */}
              {speedZones.map(z => (
                <div key={z.id}
                  className={`absolute inset-y-0 border-y-2 ${SPEED_COLORS[z.speed] ?? "bg-blue-400/40 border-blue-500"} flex items-center justify-center pointer-events-none`}
                  style={{ left: `${p(z.start)}%`, width: `${p(z.end) - p(z.start)}%` }}>
                  <span className={`text-[10px] font-bold ${SPEED_TEXT[z.speed] ?? "text-blue-700"} drop-shadow`}>{z.speed}×</span>
                </div>
              ))}
              {/* Playhead */}
              <div className="absolute inset-y-0 w-0.5 bg-white shadow-lg pointer-events-none"
                style={{ left: `${curPct}%` }} />
              {/* In/Out markers */}
              <div className="absolute top-0 bottom-0 w-1 bg-amber-500" style={{ left: `${inPct}%` }} />
              <div className="absolute top-0 bottom-0 w-1 bg-amber-500" style={{ left: `calc(${outPct}% - 4px)` }} />
            </div>

            {/* Legend */}
            {speedZones.length > 0 && (
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                <span className="flex items-center gap-1 text-[10px] text-gray-400"><span className="inline-block w-3 h-2 rounded-sm bg-amber-400/50 border border-amber-500" />Normal</span>
                {[...new Set(speedZones.map(z => z.speed))].map(s => (
                  <span key={s} className={`flex items-center gap-1 text-[10px] ${SPEED_TEXT[s]}`}>
                    <span className={`inline-block w-3 h-2 rounded-sm ${SPEED_COLORS[s]?.split(" ")[0]} border ${SPEED_COLORS[s]?.split(" ")[1]}`} />{s}× speed
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Trim sliders ── */}
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "In point",  val: inPoint,  set: (v: number) => { setInPoint(v); if (videoRef.current) videoRef.current.currentTime = v; }, min: 0,       max: outPoint - 0.1 },
              { label: "Out point", val: outPoint, set: (v: number) => { setOutPoint(v); if (videoRef.current) videoRef.current.currentTime = v; }, min: inPoint + 0.1, max: duration },
            ].map(({ label, val, set, min, max }) => (
              <div key={label}>
                <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">{label}</label>
                <input type="range" min={min} max={max} step={0.1} value={val}
                  onChange={e => set(Number(e.target.value))} className="w-full accent-amber-500" />
                <span className="text-[11px] font-mono text-gray-500">{formatTime(val)}</span>
              </div>
            ))}
          </div>

          {/* ── Speed zones ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Speed zones</p>
              {phase === "loaded" && (
                <Btn variant="outline" onClick={addSpeedZone} className="text-xs py-1 px-2">
                  <Plus className="w-3 h-3" />Add at {formatTime(currentTime)}
                </Btn>
              )}
            </div>

            {speedZones.length === 0
              ? <p className="text-xs text-gray-400 py-2">No speed zones. Play the video, pause where you want to speed up, then click "Add".</p>
              : (
                <div className="space-y-2">
                  {[...speedZones].sort((a, b) => a.start - b.start).map(z => (
                    <SpeedZoneRow
                      key={z.id}
                      z={z}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onUpdate={patch => updateZone(z.id, patch)}
                      onRemove={() => removeZone(z.id)}
                    />
                  ))}
                </div>
              )
            }
          </div>

          {/* ── Export actions ── */}
          {phase === "loaded" && (
            <div className="flex items-center justify-between pt-1 border-t border-gray-100 flex-wrap gap-2">
              <p className="text-xs text-gray-400">
                Est. output: <span className="font-mono text-gray-600">{formatTime(effectiveDuration)}</span>
                {speedZones.length > 0 && <span className="text-gray-400"> (with {speedZones.length} speed zone{speedZones.length > 1 ? "s" : ""})</span>}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {importedSubs.length > 0 && speedZones.length === 0 && (
                  <Btn onClick={burnSubs} disabled={burning}
                    className="bg-violet-600 hover:bg-violet-700 border-violet-600 hover:border-violet-700 text-white">
                    {burning
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Burning… {Math.round(burnProgress * 100)}%</>
                      : <><Subtitles className="w-3.5 h-3.5" />Burn subs into video</>
                    }
                  </Btn>
                )}
                <Btn onClick={trim}><Scissors className="w-3.5 h-3.5" />Render clip</Btn>
              </div>
            </div>
          )}

          {phase === "trimming" && (
            <div className="space-y-2 border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                  Rendering{speedZones.length > 0 ? " with speed zones" : ""}…
                </span>
                <span className="font-mono text-gray-600">{Math.round(trimProgress * 100)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${trimProgress * 100}%` }} />
              </div>
            </div>
          )}

          {phase === "done" && trimmedUrl && (
            <div className="space-y-3 pt-1 border-t border-gray-100">
              <p className="text-xs text-green-700 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Render complete</p>
              <div className="rounded-xl overflow-hidden border border-gray-200 bg-black">
                <video src={trimmedUrl} controls className="w-full max-h-48 object-contain" />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Btn onClick={downloadTrimmed}><Download className="w-3.5 h-3.5" />Download clip</Btn>
                {importedSubs.length > 0 && (
                  <Btn onClick={burnSubs} disabled={burning}
                    className="bg-violet-600 hover:bg-violet-700 border-violet-600 hover:border-violet-700 text-white">
                    {burning
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Burning… {Math.round(burnProgress * 100)}%</>
                      : <><Subtitles className="w-3.5 h-3.5" />Download with subs burned in</>
                    }
                  </Btn>
                )}
                <Btn variant="outline" onClick={() => { setPhase("loaded"); setTrimmedUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; }); }}>
                  <Scissors className="w-3.5 h-3.5" />Edit again
                </Btn>
              </div>
              {burning && (
                <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${burnProgress * 100}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {phase === "idle" && !srcUrl && (
        <div className="rounded-xl bg-gray-50 border border-gray-200 px-5 py-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">How it works</p>
          <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside leading-relaxed">
            <li>Drop a video file (MP4, WebM, MOV)</li>
            <li>Set in/out points to trim, then add speed zones for any sections you want accelerated</li>
            <li>Click <strong>Render clip</strong> — plays in real-time while re-encoding (faster sections take less wall-clock time)</li>
            <li>Download as WebM</li>
          </ol>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Root
// ─────────────────────────────────────────────

/* ------------------------------------------------------------------ */
/*  Assets Checklist                                                    */
/* ------------------------------------------------------------------ */

type AssetStatus = "ready" | "missing" | "wip";

interface AssetItem {
  id: string;
  label: string;
  description: string;
  size?: string;
  category: string;
}

const ASSET_LIST: AssetItem[] = [
  // OG / Social
  { id: "og-image",        category: "OG / Social",    label: "OG Image",            size: "1200×630",     description: "Default open graph image for link previews" },
  { id: "og-twitter",      category: "OG / Social",    label: "Twitter Card",         size: "1200×600",     description: "Twitter / X large card image" },
  { id: "og-linkedin",     category: "OG / Social",    label: "LinkedIn Cover",       size: "1128×191",     description: "LinkedIn page banner" },
  // Favicon / App icon
  { id: "favicon-ico",     category: "Favicon",        label: "favicon.ico",          size: "16/32/48px",   description: "Browser tab icon (multi-size ICO)" },
  { id: "favicon-svg",     category: "Favicon",        label: "favicon.svg",                               description: "Vector favicon for modern browsers" },
  { id: "apple-touch",     category: "Favicon",        label: "apple-touch-icon",     size: "180×180",      description: "iOS home screen icon" },
  { id: "pwa-192",         category: "Favicon",        label: "PWA icon 192",         size: "192×192",      description: "Android / PWA manifest icon" },
  { id: "pwa-512",         category: "Favicon",        label: "PWA icon 512",         size: "512×512",      description: "Android / PWA manifest large icon" },
  // Landing page
  { id: "hero-screenshot", category: "Landing Page",   label: "Hero screenshot",      size: "2560×1600",    description: "Main product screenshot in hero section" },
  { id: "feature-1",       category: "Landing Page",   label: "Feature screenshot 1",                      description: "Feature section — script editor" },
  { id: "feature-2",       category: "Landing Page",   label: "Feature screenshot 2",                      description: "Feature section — storyboard" },
  { id: "feature-3",       category: "Landing Page",   label: "Feature screenshot 3",                      description: "Feature section — production planning" },
  { id: "mobile-shot",     category: "Landing Page",   label: "Mobile screenshot",    size: "390×844",      description: "Mobile responsive view" },
  // YouTube / Video
  { id: "yt-thumbnail",    category: "YouTube",        label: "YT Thumbnail",         size: "1280×720",     description: "YouTube video thumbnail" },
  { id: "yt-channel-art",  category: "YouTube",        label: "Channel art",          size: "2560×1440",    description: "YouTube channel banner" },
  // Social posts
  { id: "ig-square",       category: "Social posts",   label: "Instagram square",     size: "1080×1080",    description: "Instagram feed post" },
  { id: "ig-story",        category: "Social posts",   label: "Instagram story",      size: "1080×1920",    description: "Instagram / TikTok story format" },
  { id: "twitter-post",    category: "Social posts",   label: "Twitter post image",   size: "1600×900",     description: "Twitter / X inline image" },
  // Docs / Admin
  { id: "logo-dark",       category: "Brand",          label: "Logo (dark bg)",                             description: "Logo variant for dark backgrounds / emails" },
  { id: "logo-light",      category: "Brand",          label: "Logo (light bg)",                            description: "Logo variant for white / light backgrounds" },
  { id: "logo-icon",       category: "Brand",          label: "Logo mark only",       size: "512×512",      description: "Icon-only mark (no wordmark)" },
];

const ASSETS_STATUS_KEY = "media-assets-status";

function loadAssetStatuses(): Record<string, AssetStatus> {
  try { return JSON.parse(localStorage.getItem(ASSETS_STATUS_KEY) || "{}"); }
  catch { return {}; }
}

const STATUS_CONFIG: Record<AssetStatus, { label: string; color: string; dot: string }> = {
  missing: { label: "Missing",  color: "bg-red-100 text-red-700",    dot: "bg-red-400" },
  wip:     { label: "WIP",      color: "bg-amber-100 text-amber-700", dot: "bg-amber-400" },
  ready:   { label: "Ready",    color: "bg-green-100 text-green-700", dot: "bg-green-500" },
};

function AssetsTab() {
  const [statuses, setStatuses] = useState<Record<string, AssetStatus>>(loadAssetStatuses);

  const set = (id: string, status: AssetStatus) => {
    const next = { ...statuses, [id]: status };
    setStatuses(next);
    localStorage.setItem(ASSETS_STATUS_KEY, JSON.stringify(next));
  };

  const categories = [...new Set(ASSET_LIST.map(a => a.category))];
  const ready   = ASSET_LIST.filter(a => (statuses[a.id] ?? "missing") === "ready").length;
  const total   = ASSET_LIST.length;
  const pct     = Math.round((ready / total) * 100);

  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-900">{ready}/{total} assets ready</span>
          <span className="text-sm font-semibold text-gray-500">{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Asset categories */}
      {categories.map(cat => (
        <div key={cat}>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{cat}</h3>
          <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
            {ASSET_LIST.filter(a => a.category === cat).map(asset => {
              const status = statuses[asset.id] ?? "missing";
              const cfg = STATUS_CONFIG[status];
              return (
                <div key={asset.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={`shrink-0 w-2 h-2 rounded-full ${cfg.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{asset.label}</span>
                      {asset.size && <span className="text-[10px] text-gray-400 font-mono">{asset.size}</span>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{asset.description}</p>
                  </div>
                  {/* Status cycle button */}
                  <div className="flex gap-1 shrink-0">
                    {(["missing", "wip", "ready"] as AssetStatus[]).map(s => (
                      <button key={s} onClick={() => set(asset.id, s)}
                        className={`text-[10px] font-medium px-2 py-1 rounded cursor-pointer transition-colors ${status === s ? cfg.color : "text-gray-400 hover:text-gray-600"}`}>
                        {STATUS_CONFIG[s].label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

type Tab = "screenshots" | "thumbnails" | "videos" | "trim" | "assets";

export default function App() {
  const [tab, setTab] = useState<Tab>("screenshots");
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Media</h1>
        <p className="mt-1 text-sm text-gray-500">Capture screenshots, thumbnails, and record demo videos for the landing site.</p>
      </div>
      <div className="flex items-center gap-1 border-b border-gray-200 mb-6">
        {([
          { id: "screenshots", label: "Screenshots", icon: Camera      },
          { id: "thumbnails",  label: "Thumbnails",  icon: Image       },
          { id: "videos",      label: "Videos",      icon: Video       },
          { id: "trim",        label: "Edit video",  icon: Scissors    },
          { id: "assets",      label: "Assets",      icon: LayoutGrid  },
        ] as { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[]).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id as Tab)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${tab === id ? "border-amber-500 text-amber-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>
      {tab === "screenshots" && <ScreenshotsTab />}
      {tab === "thumbnails"  && <ThumbnailsTab />}
      {tab === "videos"      && <VideosTab />}
      {tab === "trim"        && <VideoTrimmer />}
      {tab === "assets"      && <AssetsTab />}
    </div>
  );
}
