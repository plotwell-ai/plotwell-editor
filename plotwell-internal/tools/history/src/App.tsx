import { useState, useEffect, useMemo } from "react";
import { ToolPage, CopyButton } from "@shared/components";
import { getHistory, deleteFromHistory, clearHistory, type HistoryEntry, type ContentSource } from "@shared/history";

const SOURCE_CONFIG: Record<ContentSource, { label: string; color: string; bg: string }> = {
  blog:   { label: "Blog",   color: "text-amber-700",   bg: "bg-amber-50" },
  social: { label: "Social", color: "text-blue-700",    bg: "bg-blue-50" },
  email:  { label: "Email",  color: "text-green-700",   bg: "bg-green-50" },
  seo:    { label: "SEO",    color: "text-purple-700",  bg: "bg-purple-50" },
  sem:    { label: "SEM",    color: "text-pink-700",    bg: "bg-pink-50" },
};

export default function App() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [filter, setFilter] = useState<ContentSource | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = () => setEntries(getHistory());
  useEffect(reload, []);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.source === filter);
  }, [entries, filter]);

  const handleDelete = (id: string) => {
    deleteFromHistory(id);
    reload();
    if (expandedId === id) setExpandedId(null);
  };

  const handleClear = () => {
    if (filter === "all") clearHistory();
    else clearHistory(filter);
    reload();
    setExpandedId(null);
  };

  // Count by source
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.source] = (c[e.source] || 0) + 1;
    return c;
  }, [entries]);

  return (
    <ToolPage title="Content History" description="Browse all generated content from autopilot runs.">
      <div className="space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")} count={counts.all}>All</FilterButton>
            {(Object.entries(SOURCE_CONFIG) as [ContentSource, typeof SOURCE_CONFIG[ContentSource]][]).map(([key, cfg]) => (
              <FilterButton key={key} active={filter === key} onClick={() => setFilter(key)} count={counts[key] || 0}>
                {cfg.label}
              </FilterButton>
            ))}
          </div>
          <div className="flex-1" />
          {entries.length > 0 && (
            <button onClick={handleClear} className="text-xs text-red-500 hover:text-red-700">
              Clear {filter === "all" ? "all" : SOURCE_CONFIG[filter].label}
            </button>
          )}
        </div>

        {/* Entries */}
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
            <p className="text-sm text-gray-400">No generated content yet. Run an autopilot to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((entry) => {
              const cfg = SOURCE_CONFIG[entry.source];
              const isExpanded = expandedId === entry.id;
              const date = new Date(entry.createdAt);

              return (
                <div key={entry.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  {/* Header row */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-50 transition-colors"
                  >
                    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${cfg.bg} ${cfg.color}`}>
                      {cfg.label}
                    </span>
                    <span className="text-sm font-medium text-gray-800 flex-1 truncate">{entry.title}</span>
                    {entry.assets && entry.assets.length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">
                        {entry.assets.length} asset{entry.assets.length > 1 ? "s" : ""}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400 shrink-0">
                      {date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 p-5 space-y-4">
                      {/* Metadata */}
                      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(entry.metadata).map(([k, v]) => (
                            <span key={k} className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
                              {k}: {v}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Sections (e.g. per-platform social content) */}
                      {entry.sections && Object.keys(entry.sections).length > 0 ? (
                        <div className="space-y-3">
                          {Object.entries(entry.sections).map(([key, value]) => (
                            <details key={key} className="rounded-lg border border-gray-200 overflow-hidden">
                              <summary className="flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-50">
                                <span>{key}</span>
                                <CopyButton text={value} />
                              </summary>
                              <div className="border-t border-gray-100 bg-gray-50 p-4">
                                <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">{value}</pre>
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : (
                        /* Full content */
                        <div>
                          <div className="flex justify-end mb-2">
                            <CopyButton text={entry.content} />
                          </div>
                          <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed bg-gray-50 rounded-lg p-4 max-h-[400px] overflow-y-auto">
                            {entry.content}
                          </pre>
                        </div>
                      )}

                      {/* Assets */}
                      {entry.assets && entry.assets.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {entry.assets.map((asset, i) => (
                            <a key={i} href={asset.url} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-100 transition-colors">
                              {asset.type === "video" && <VideoIcon />}
                              {asset.type === "audio" && <AudioIcon />}
                              {asset.type === "image" && <ImageIcon />}
                              {asset.label}
                            </a>
                          ))}
                        </div>
                      )}

                      {/* Delete */}
                      <div className="flex justify-end pt-2 border-t border-gray-100">
                        <button onClick={() => handleDelete(entry.id)} className="text-xs text-red-500 hover:text-red-700">
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ToolPage>
  );
}

function FilterButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${active ? "bg-amber-100 text-amber-700" : "text-gray-500 hover:text-gray-700"}`}>
      {children} {count > 0 && <span className="text-gray-400 ml-0.5">({count})</span>}
    </button>
  );
}

function VideoIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>;
}
function AudioIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
}
function ImageIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>;
}
