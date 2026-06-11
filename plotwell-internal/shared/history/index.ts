/**
 * Content History - stores all generated content in localStorage.
 * Auto-downloads paid assets (images, video, voiceover) to disk.
 * Provides a browsable history for review.
 */

export type ContentSource = "blog" | "social" | "email" | "seo" | "sem";

export interface HistoryEntry {
  id: string;
  source: ContentSource;
  title: string;
  content: string;
  /** Per-platform or per-section content */
  sections?: Record<string, string>;
  /** Asset URLs (video, voiceover, image) */
  assets?: { type: string; url: string; label: string }[];
  metadata?: Record<string, string>;
  createdAt: string;
}

const STORAGE_KEY = "plotwell-internal-history";
const MAX_ENTRIES = 100;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
}

function slugify(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

/* ---- Read ---- */

export function getHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function getHistoryBySource(source: ContentSource): HistoryEntry[] {
  return getHistory().filter((e) => e.source === source);
}

export function getHistoryEntry(id: string): HistoryEntry | undefined {
  return getHistory().find((e) => e.id === id);
}

/* ---- Write ---- */

export function saveToHistory(entry: Omit<HistoryEntry, "id" | "createdAt">): HistoryEntry {
  const full: HistoryEntry = {
    ...entry,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  const history = getHistory();
  history.unshift(full);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_ENTRIES)));

  // Auto-download paid assets
  if (full.assets && full.assets.length > 0) {
    const prefix = `${full.source}_${slugify(full.title)}_${timestamp()}`;
    for (const asset of full.assets) {
      downloadAsset(asset.url, `${prefix}_${asset.label.toLowerCase().replace(/\s+/g, "-")}.${getExtension(asset.type)}`);
    }
  }

  return full;
}

export function deleteFromHistory(id: string): void {
  const history = getHistory().filter((e) => e.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function clearHistory(source?: ContentSource): void {
  if (!source) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const history = getHistory().filter((e) => e.source !== source);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

/* ---- Asset download helpers ---- */

function getExtension(type: string): string {
  if (type === "video") return "mp4";
  if (type === "audio") return "mp3";
  if (type === "image") return "png";
  return "bin";
}

async function downloadAsset(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error(`Failed to download asset ${filename}:`, err);
  }
}
