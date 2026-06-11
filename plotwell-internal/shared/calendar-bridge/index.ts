/**
 * Bridge between content tools and the calendar.
 * Uses localStorage to add items to the calendar from any tool.
 */

const STORAGE_KEY = "plotwell-internal-calendar";

export type ContentType = "blog" | "social" | "email" | "sem";
export type ContentStatus = "planned" | "draft" | "published";
export type Platform = "tiktok" | "instagram" | "x" | "linkedin" | "";

export interface CalendarItem {
  id: string;
  date: string; // YYYY-MM-DD
  type: ContentType;
  title: string;
  platform: Platform;
  status: ContentStatus;
  notes: string;
}

function loadItems(): CalendarItem[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveItems(items: CalendarItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

/**
 * Add a content item to the calendar from any tool.
 * Returns the created item's ID.
 */
export function addToCalendar(item: {
  type: ContentType;
  title: string;
  platform?: Platform;
  status?: ContentStatus;
  notes?: string;
  date?: string; // defaults to today
}): string {
  const id = `${item.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const today = new Date().toISOString().split("T")[0];

  const newItem: CalendarItem = {
    id,
    date: item.date || today,
    type: item.type,
    title: item.title,
    platform: item.platform || "",
    status: item.status || "draft",
    notes: item.notes || "",
  };

  const items = loadItems();
  items.push(newItem);
  saveItems(items);

  return id;
}

/**
 * Check if a similar item already exists today (avoids duplicates).
 */
export function hasItemToday(type: ContentType, title: string): boolean {
  const today = new Date().toISOString().split("T")[0];
  const items = loadItems();
  return items.some(
    (i) => i.date === today && i.type === type && i.title === title
  );
}

/* ------------------------------------------------------------------ */
/*  Cross-tool navigation (Calendar -> Tool with pre-filled topic)     */
/* ------------------------------------------------------------------ */

const PREFILL_KEY = "plotwell-internal-prefill";

export interface PrefillData {
  type: ContentType;
  topic: string;
  platform?: Platform;
}

/** Set prefill data for a tool to pick up */
export function setPrefill(data: PrefillData): void {
  localStorage.setItem(PREFILL_KEY, JSON.stringify(data));
}

/** Read and clear prefill data (consumed once) */
export function consumePrefill(): PrefillData | null {
  const raw = localStorage.getItem(PREFILL_KEY);
  if (!raw) return null;
  localStorage.removeItem(PREFILL_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Get the route path for a content type */
export function getToolPath(type: ContentType): string {
  const paths: Record<ContentType, string> = {
    blog: "/blog",
    social: "/social",
    email: "/email",
    sem: "/sem",
  };
  return paths[type];
}
