import { useState, useEffect, useCallback, useMemo } from "react";
import { generate } from "@shared/ai-client";
import { CALENDAR_SYSTEM } from "@shared/prompts";
import { ToolPage } from "@shared/components";
import { setPrefill, getToolPath } from "@shared/calendar-bridge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ContentType = "blog" | "social" | "email" | "sem";
type Platform = "tiktok" | "instagram" | "x" | "linkedin";
type Status = "planned" | "draft" | "published";

interface ContentItem {
  id: string;
  date: string; // YYYY-MM-DD
  type: ContentType;
  title: string;
  platform?: Platform;
  status: Status;
  notes: string;
}

interface AISuggestion {
  date: string;
  type: ContentType;
  title: string;
  platform?: Platform;
  notes: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "plotwell-internal-calendar";

const TYPE_CONFIG: Record<ContentType, { label: string; color: string; bg: string; dot: string }> = {
  blog: { label: "Blog", color: "text-amber-700", bg: "bg-amber-100", dot: "bg-amber-500" },
  social: { label: "Social", color: "text-blue-700", bg: "bg-blue-100", dot: "bg-blue-500" },
  email: { label: "Email", color: "text-green-700", bg: "bg-green-100", dot: "bg-green-500" },
  sem: { label: "SEM", color: "text-purple-700", bg: "bg-purple-100", dot: "bg-purple-500" },
};

const PLATFORM_OPTIONS: Platform[] = ["tiktok", "instagram", "x", "linkedin"];

const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X / Twitter",
  linkedin: "LinkedIn",
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isSameDay(a: string, b: string): boolean {
  return a === b;
}

function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function getStartPadding(year: number, month: number): number {
  const firstDay = new Date(year, month, 1).getDay();
  // Convert Sunday=0 to Monday-based: Mon=0, Tue=1, ..., Sun=6
  return firstDay === 0 ? 6 : firstDay - 1;
}

function getWeekRange(today: Date): { start: string; end: string } {
  const day = today.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: formatDate(monday), end: formatDate(sunday) };
}

function loadItems(): ContentItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveItems(items: ContentItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

/* ------------------------------------------------------------------ */
/*  Modal Component                                                    */
/* ------------------------------------------------------------------ */

function ContentModal({
  date,
  item,
  onSave,
  onDelete,
  onClose,
}: {
  date: string;
  item: ContentItem | null;
  onSave: (item: ContentItem) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<ContentType>(item?.type || "blog");
  const [title, setTitle] = useState(item?.title || "");
  const [platform, setPlatform] = useState<Platform | undefined>(item?.platform);
  const [status, setStatus] = useState<Status>(item?.status || "planned");
  const [notes, setNotes] = useState(item?.notes || "");
  const [itemDate, setItemDate] = useState(item?.date || date);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({
      id: item?.id || generateId(),
      date: itemDate,
      type,
      title: title.trim(),
      platform: type === "social" ? platform || "instagram" : undefined,
      status,
      notes: notes.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">
            {item ? "Edit Content" : "Add Content"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={itemDate}
              onChange={(e) => setItemDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <div className="flex gap-2">
              {(Object.entries(TYPE_CONFIG) as [ContentType, typeof TYPE_CONFIG[ContentType]][]).map(
                ([key, cfg]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setType(key)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      type === key
                        ? `${cfg.bg} ${cfg.color} border-current`
                        : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                    }`}
                  >
                    {cfg.label}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Content title or topic..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              autoFocus
            />
          </div>

          {/* Platform (social only) */}
          {type === "social" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
              <div className="flex gap-2">
                {PLATFORM_OPTIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlatform(p)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      platform === p
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                    }`}
                  >
                    {PLATFORM_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Status */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <div className="flex gap-2">
              {(["planned", "draft", "published"] as Status[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors ${
                    status === s
                      ? s === "published"
                        ? "border-green-500 bg-green-50 text-green-700"
                        : s === "draft"
                          ? "border-amber-500 bg-amber-50 text-amber-700"
                          : "border-slate-500 bg-slate-50 text-slate-700"
                      : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes, links, keywords..."
              rows={3}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            {item ? (
              <button
                type="button"
                onClick={() => onDelete(item.id)}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                Delete
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {item ? "Update" : "Add"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AI Suggestions Panel                                               */
/* ------------------------------------------------------------------ */

function AISuggestionsPanel({
  suggestions,
  loading,
  onAccept,
  onDismiss,
  onGenerate,
}: {
  suggestions: AISuggestion[];
  loading: boolean;
  onAccept: (s: AISuggestion) => void;
  onDismiss: () => void;
  onGenerate: () => void;
}) {
  if (suggestions.length === 0 && !loading) {
    return (
      <button
        onClick={onGenerate}
        className="w-full rounded-lg border border-dashed border-amber-300 bg-amber-50/50 px-4 py-3 text-sm text-amber-700 hover:bg-amber-50 transition-colors"
      >
        Suggest content for this week...
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-amber-800">AI Suggestions</h3>
        <div className="flex gap-2">
          <button
            onClick={onGenerate}
            disabled={loading}
            className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Thinking..." : "Refresh"}
          </button>
          <button
            onClick={onDismiss}
            className="text-xs text-amber-600 hover:text-amber-800"
          >
            Dismiss
          </button>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4 justify-center">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          <span className="text-sm text-amber-600">Generating suggestions...</span>
        </div>
      ) : (
        <div className="space-y-2">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="flex items-start gap-2 group rounded-md border border-amber-200 bg-white px-3 py-2"
            >
              <span className={`mt-0.5 shrink-0 inline-block h-2 w-2 rounded-full ${TYPE_CONFIG[s.type].dot}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{s.title}</p>
                <p className="text-xs text-gray-500">
                  {TYPE_CONFIG[s.type].label}
                  {s.platform ? ` / ${PLATFORM_LABELS[s.platform]}` : ""}
                  {" - "}
                  {s.date}
                </p>
                {s.notes && (
                  <p className="text-xs text-gray-400 mt-0.5 truncate">{s.notes}</p>
                )}
              </div>
              <button
                onClick={() => onAccept(s)}
                className="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white opacity-0 group-hover:opacity-100 hover:bg-amber-700 transition-all"
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Week Sidebar                                                       */
/* ------------------------------------------------------------------ */

function WeekSidebar({
  items,
  year,
  month,
  onItemClick,
}: {
  items: ContentItem[];
  year: number;
  month: number;
  onItemClick: (item: ContentItem) => void;
}) {
  const today = new Date();
  const { start, end } = getWeekRange(today);

  const weekItems = items
    .filter((item) => item.date >= start && item.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Group by day
  const grouped: Record<string, ContentItem[]> = {};
  for (const item of weekItems) {
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  }

  // Monthly stats
  const monthStr = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthItems = items.filter((item) => item.date.startsWith(monthStr));
  const blogCount = monthItems.filter((i) => i.type === "blog").length;
  const socialCount = monthItems.filter((i) => i.type === "social").length;
  const emailCount = monthItems.filter((i) => i.type === "email").length;
  const semCount = monthItems.filter((i) => i.type === "sem").length;

  // Upcoming (next 7 days from today, status not published)
  const todayStr = formatDate(today);
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);
  const nextWeekStr = formatDate(nextWeek);
  const upcoming = items
    .filter((i) => i.date >= todayStr && i.date <= nextWeekStr && i.status !== "published")
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="space-y-5">
      {/* Monthly Stats */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          {MONTH_NAMES[month]} Stats
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "Blog", count: blogCount, cfg: TYPE_CONFIG.blog },
            { label: "Social", count: socialCount, cfg: TYPE_CONFIG.social },
            { label: "Email", count: emailCount, cfg: TYPE_CONFIG.email },
            { label: "SEM", count: semCount, cfg: TYPE_CONFIG.sem },
          ].map((s) => (
            <div key={s.label} className={`rounded-md ${s.cfg.bg} px-3 py-2`}>
              <p className={`text-lg font-bold ${s.cfg.color}`}>{s.count}</p>
              <p className={`text-xs ${s.cfg.color} opacity-80`}>{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* This Week */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          This Week
        </h3>
        {Object.keys(grouped).length === 0 ? (
          <p className="text-sm text-gray-400 italic">No content this week</p>
        ) : (
          <div className="space-y-3">
            {Object.entries(grouped).map(([date, dayItems]) => {
              const d = parseDate(date);
              const dayName = DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1];
              return (
                <div key={date}>
                  <p className="text-xs font-medium text-gray-500 mb-1">
                    {dayName}, {d.getDate()}
                  </p>
                  <div className="space-y-1">
                    {dayItems.map((item) => (
                      <div key={item.id} className="flex items-center gap-1 group">
                        <button
                          onClick={() => onItemClick(item)}
                          className="flex-1 text-left flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50 transition-colors min-w-0"
                        >
                          <span className={`shrink-0 h-2 w-2 rounded-full ${TYPE_CONFIG[item.type].dot}`} />
                          <span className="text-sm text-gray-700 truncate flex-1">{item.title}</span>
                          <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${
                            item.status === "published"
                              ? "bg-green-100 text-green-600"
                              : item.status === "draft"
                                ? "bg-amber-100 text-amber-600"
                                : "bg-gray-100 text-gray-500"
                          }`}>
                            {item.status}
                          </span>
                        </button>
                        {item.status !== "published" && (
                          <a
                            href={getToolPath(item.type as "blog" | "social" | "email" | "sem")}
                            onClick={() => setPrefill({ type: item.type as "blog" | "social" | "email" | "sem", topic: item.title, platform: (item.platform || "") as "" })}
                            className="shrink-0 rounded px-1.5 py-1 text-[10px] font-medium text-amber-600 hover:bg-amber-50 opacity-0 group-hover:opacity-100 transition-all"
                            title="Generate content"
                          >
                            Go
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upcoming Deadlines */}
      {upcoming.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
          <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-3">
            Upcoming (7 days)
          </h3>
          <div className="space-y-1.5">
            {upcoming.slice(0, 6).map((item) => {
              const d = parseDate(item.date);
              const isToday = isSameDay(item.date, todayStr);
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className={`shrink-0 h-2 w-2 rounded-full ${TYPE_CONFIG[item.type].dot}`} />
                  <span className={`truncate flex-1 ${isToday ? "font-medium text-amber-800" : "text-gray-700"}`}>
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">
                    {isToday ? "Today" : `${d.getDate()}/${d.getMonth() + 1}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Calendar App                                                  */
/* ------------------------------------------------------------------ */

export default function App() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [items, setItems] = useState<ContentItem[]>(loadItems);

  // Modal state
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<ContentItem | null>(null);

  // AI suggestions
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  // Persist to localStorage
  useEffect(() => {
    saveItems(items);
  }, [items]);

  const todayStr = formatDate(today);

  // Calendar grid data
  const days = useMemo(() => getMonthDays(year, month), [year, month]);
  const padding = useMemo(() => getStartPadding(year, month), [year, month]);

  // Items indexed by date for quick lookup
  const itemsByDate = useMemo(() => {
    const map: Record<string, ContentItem[]> = {};
    for (const item of items) {
      if (!map[item.date]) map[item.date] = [];
      map[item.date].push(item);
    }
    return map;
  }, [items]);

  // Navigation
  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
  };
  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  };

  // Modal handlers
  const openAddModal = (date: string) => {
    setModalDate(date);
    setModalItem(null);
  };
  const openEditModal = (item: ContentItem) => {
    setModalDate(item.date);
    setModalItem(item);
  };
  const closeModal = () => {
    setModalDate(null);
    setModalItem(null);
  };

  const handleSave = (item: ContentItem) => {
    setItems((prev) => {
      const existing = prev.findIndex((i) => i.id === item.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = item;
        return updated;
      }
      return [...prev, item];
    });
    closeModal();
  };

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    closeModal();
  };

  // AI suggest
  const handleAISuggest = useCallback(async () => {
    setAiLoading(true);
    try {
      const { start, end } = getWeekRange(today);
      const existingThisWeek = items
        .filter((i) => i.date >= start && i.date <= end)
        .map((i) => `${i.date}: [${i.type}] ${i.title}`)
        .join("\n");

      const prompt = `Today is ${todayStr}. The current week is ${start} to ${end}.

Existing content planned this week:
${existingThisWeek || "(none)"}

Suggest 5 content items for this week that would complement what already exists. Fill gaps across channels (blog, social, email, sem). Avoid duplicating existing topics.

For social posts, specify a platform (tiktok, instagram, x, or linkedin).

Return ONLY a JSON array of objects with these fields:
- "date": YYYY-MM-DD (within this week)
- "type": "blog" | "social" | "email" | "sem"
- "title": short descriptive title
- "platform": only for social type, one of "tiktok" | "instagram" | "x" | "linkedin"
- "notes": brief description of the content idea

No explanation, just the JSON array.`;

      const result = await generate(prompt, {
        system: CALENDAR_SYSTEM,
        maxTokens: 1500,
        temperature: 0.9,
      });

      const match = result.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed: AISuggestion[] = JSON.parse(match[0]);
        setSuggestions(parsed);
      }
    } catch (err) {
      console.error("AI suggestion error:", err);
    }
    setAiLoading(false);
  }, [items, todayStr]);

  const handleAcceptSuggestion = (s: AISuggestion) => {
    const newItem: ContentItem = {
      id: generateId(),
      date: s.date,
      type: s.type,
      title: s.title,
      platform: s.platform,
      status: "planned",
      notes: s.notes || "",
    };
    setItems((prev) => [...prev, newItem]);
    setSuggestions((prev) => prev.filter((x) => x !== s));
  };

  // Export CSV
  const handleExportCSV = () => {
    const monthStr = `${year}-${String(month + 1).padStart(2, "0")}`;
    const monthItems = items
      .filter((i) => i.date.startsWith(monthStr))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (monthItems.length === 0) return;

    const headers = ["Date", "Type", "Title", "Platform", "Status", "Notes"];
    const rows = monthItems.map((i) => [
      i.date,
      i.type,
      `"${i.title.replace(/"/g, '""')}"`,
      i.platform || "",
      i.status,
      `"${i.notes.replace(/"/g, '""')}"`,
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plotwell-calendar-${monthStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ToolPage
      title="Content Calendar"
      description="Plan and schedule content across blog, social, email, and SEM channels."
    >
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Main Calendar Area */}
        <div className="flex-1 min-w-0">
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-gray-900">
                {MONTH_NAMES[month]} {year}
              </h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={prevMonth}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={goToday}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Today
                </button>
                <button
                  onClick={nextMonth}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleExportCSV}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Export CSV
              </button>
            </div>
          </div>

          {/* Type Legend */}
          <div className="flex items-center gap-4 mb-3">
            {(Object.entries(TYPE_CONFIG) as [ContentType, typeof TYPE_CONFIG[ContentType]][]).map(
              ([key, cfg]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
                  <span className="text-xs text-gray-500">{cfg.label}</span>
                </div>
              )
            )}
          </div>

          {/* Calendar Grid */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
              {DAY_NAMES.map((day) => (
                <div key={day} className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {day}
                </div>
              ))}
            </div>

            {/* Day cells */}
            <div className="grid grid-cols-7">
              {/* Empty padding cells */}
              {Array.from({ length: padding }).map((_, i) => (
                <div key={`pad-${i}`} className="min-h-[88px] border-b border-r border-gray-100 bg-gray-50/50" />
              ))}

              {/* Day cells */}
              {days.map((d) => {
                const dateStr = formatDate(d);
                const isToday = isSameDay(dateStr, todayStr);
                const dayItems = itemsByDate[dateStr] || [];

                return (
                  <div
                    key={dateStr}
                    onClick={() => openAddModal(dateStr)}
                    className={`min-h-[88px] border-b border-r border-gray-100 p-1.5 cursor-pointer transition-colors hover:bg-amber-50/40 ${
                      isToday ? "bg-amber-50/60" : ""
                    }`}
                  >
                    {/* Day number */}
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday
                            ? "bg-amber-600 text-white"
                            : "text-gray-700"
                        }`}
                      >
                        {d.getDate()}
                      </span>
                      {dayItems.length > 0 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openAddModal(dateStr); }}
                          className="rounded p-0.5 text-gray-300 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      )}
                    </div>

                    {/* Content pills */}
                    <div className="space-y-0.5">
                      {dayItems.slice(0, 3).map((item) => (
                        <button
                          key={item.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditModal(item);
                          }}
                          className={`w-full text-left rounded px-1.5 py-0.5 text-[10px] font-medium truncate transition-colors ${TYPE_CONFIG[item.type].bg} ${TYPE_CONFIG[item.type].color} hover:opacity-80`}
                          title={item.title}
                        >
                          {item.title}
                        </button>
                      ))}
                      {dayItems.length > 3 && (
                        <p className="text-[10px] text-gray-400 px-1">
                          +{dayItems.length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Trailing padding */}
              {Array.from({ length: (7 - ((padding + days.length) % 7)) % 7 }).map((_, i) => (
                <div key={`trail-${i}`} className="min-h-[88px] border-b border-r border-gray-100 bg-gray-50/50" />
              ))}
            </div>
          </div>

          {/* AI Suggestions */}
          <div className="mt-4">
            <AISuggestionsPanel
              suggestions={suggestions}
              loading={aiLoading}
              onAccept={handleAcceptSuggestion}
              onDismiss={() => setSuggestions([])}
              onGenerate={handleAISuggest}
            />
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="w-full lg:w-72 shrink-0">
          <WeekSidebar
            items={items}
            year={year}
            month={month}
            onItemClick={openEditModal}
          />
        </div>
      </div>

      {/* Modal */}
      {modalDate && (
        <ContentModal
          date={modalDate}
          item={modalItem}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={closeModal}
        />
      )}
    </ToolPage>
  );
}
