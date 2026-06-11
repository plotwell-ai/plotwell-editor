import { useState, useCallback, useEffect } from "react";
import { generate, stream, estimateCosts, formatCost } from "@shared/ai-client";
import { ToolPage, StreamingOutput, CopyButton } from "@shared/components";
import { CONTENT_GAPS, getExistingPostsSummary, getExistingSlugs } from "@shared/content";
import { getProductContextShort } from "@shared/product-context";
import { addToCalendar, hasItemToday, consumePrefill } from "@shared/calendar-bridge";
import { saveToHistory } from "@shared/history";
import { SOCIAL_SYSTEM, EMAIL_SYSTEM, SEM_SYSTEM } from "@shared/prompts";

/* ------------------------------------------------------------------ */
/*  Draft History (localStorage)                                       */
/* ------------------------------------------------------------------ */

interface Draft {
  id: string;
  topic: string;
  lang: string;
  slug: string;
  title: string;
  markdown: string;
  content: string;
  meta: BlogMeta;
  savedAt: string;
}

const DRAFTS_KEY = "plotwell-internal-blog-drafts";
const MAX_DRAFTS = 30;

function loadDrafts(): Draft[] {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveDraft(draft: Draft): void {
  const drafts = loadDrafts();
  // Remove duplicate slugs (keep latest)
  const filtered = drafts.filter((d) => d.slug !== draft.slug || d.lang !== draft.lang);
  filtered.unshift(draft);
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(filtered.slice(0, MAX_DRAFTS)));
}

function deleteDraft(id: string): void {
  const drafts = loadDrafts().filter((d) => d.id !== id);
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

function DraftHistory({
  onRestore,
}: {
  onRestore: (draft: Draft) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(loadDrafts);
  const [expanded, setExpanded] = useState(false);

  // Refresh when component mounts or is toggled
  useEffect(() => {
    if (expanded) setDrafts(loadDrafts());
  }, [expanded]);

  if (drafts.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <span>Draft History ({drafts.length})</span>
        <span className="text-xs text-gray-400">{expanded ? "Hide" : "Show"}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 max-h-[300px] overflow-y-auto">
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="flex items-center justify-between px-5 py-2.5 border-b border-gray-50 hover:bg-gray-50 group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    {draft.lang.toUpperCase()}
                  </span>
                  <span className="text-sm font-medium text-gray-800 truncate">
                    {draft.title || draft.topic}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {draft.slug} &middot; {new Date(draft.savedAt).toLocaleDateString()} {new Date(draft.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-3">
                <button
                  onClick={() => onRestore(draft)}
                  className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 opacity-0 group-hover:opacity-100 transition-all"
                >
                  Restore
                </button>
                <button
                  onClick={() => {
                    deleteDraft(draft.id);
                    setDrafts(loadDrafts());
                  }}
                  className="rounded-md px-2 py-1 text-xs text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Minimal markdown to HTML (covers headings, bold, italic, links, lists, paragraphs) */
function mdToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/^(?!<[hulo])((?!<li).+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");
}

function MarkdownPreview({ content }: { content: string }) {
  const html = mdToHtml(content);
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px 32px;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:680px}
h1{font-size:1.8em;margin:1.2em 0 0.4em;font-weight:700}
h2{font-size:1.35em;margin:1.4em 0 0.4em;font-weight:600;color:#0f172a}
h3{font-size:1.1em;margin:1.2em 0 0.3em;font-weight:600;color:#334155}
p{margin:0 0 0.8em}
strong{font-weight:600}
a{color:#2563eb;text-decoration:underline}
ul,ol{margin:0 0 1em;padding-left:1.5em}
li{margin:0.2em 0}
</style></head><body>${html}</body></html>`;

  return (
    <iframe
      srcDoc={doc}
      sandbox=""
      title="Markdown preview"
      className="w-full border-0 rounded-lg"
      style={{ minHeight: 300 }}
      onLoad={(e) => {
        const f = e.currentTarget;
        if (f.contentDocument?.body) {
          f.style.height = f.contentDocument.body.scrollHeight + 32 + "px";
        }
      }}
    />
  );
}

type Lang = "en" | "es" | "both";

const BLOG_SYSTEM_PROMPT = `You are a content writer for plotwell. Write blog posts that are practical, actionable, and aimed at screenwriters, filmmakers, and content creators.

${getProductContextShort()}

RULES:
- Write in a direct, professional tone. No fluff, no filler.
- Use markdown with ## for main sections and ### for subsections
- Include practical examples, tables, or step-by-step guides where appropriate
- Naturally mention plotwell features where relevant (not forced, not salesy)
- Keep paragraphs short (2-4 sentences max)
- Target 1200-1800 words
- Do NOT include the title as an H1 (the blog template adds it)
- Do NOT include frontmatter (it will be added separately)
- Use bold for key concepts on first mention
- End with a short, motivating closing paragraph (no CTA, the template adds one)
- Never use em dashes
- Always lowercase "plotwell" (not "Plotwell")`;

function buildUserPrompt(topic: string, lang: string, keyword: string) {
  const langInstruction =
    lang === "es"
      ? "Write the entire article in Spanish. Use natural, professional Spanish (not translated-sounding)."
      : "Write the entire article in English.";

  const keywordLine = keyword.trim()
    ? `\nTarget SEO keyword: "${keyword.trim()}"\n`
    : "";

  return `Write a blog post about: "${topic}"
${keywordLine}
${langInstruction}

Also provide at the very end, separated by "---META---", a JSON object with:
- "title": the article title (in the target language)
- "description": a 1-2 sentence SEO description (in the target language)
- "slug": a URL-friendly slug in the target language (lowercase, hyphens, no accents)
- "tags": array of 2-4 tags from this list: screenwriting, production, storyboarding, characters, formatting, story structure, series, collaboration, content creation, AI tools, filmmaking, budgeting
- "readTime": estimated read time in minutes (integer)
- "imagePrompt": a detailed prompt for generating a cover illustration. Style: minimalist flat 2D vector art, editorial blog header, amber (#d97706) and slate blue (#2563eb) accents on soft white background. No text/words/letters. Describe the visual concept that represents the article topic.`;
}

interface BlogMeta {
  title?: string;
  description?: string;
  slug?: string;
  tags?: string[];
  readTime?: number;
  imagePrompt?: string;
}

function parseBlogOutput(text: string): {
  content: string;
  meta: BlogMeta;
} {
  const metaSplit = text.split("---META---");
  const content = metaSplit[0].trim();
  let meta: BlogMeta = {};

  if (metaSplit[1]) {
    try {
      const jsonMatch = metaSplit[1].match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        meta = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Will use defaults
    }
  }

  // Fallback: infer meta from content when AI didn't produce ---META---
  if (!metaSplit[1] || !meta.title) {
    // Try to extract title from first heading
    const h1Match = content.match(/^#\s+(.+)$/m);
    const h2Match = content.match(/^##\s+(.+)$/m);
    if (!meta.title) meta.title = h1Match?.[1] || h2Match?.[1] || "";
    // Estimate read time from word count
    if (!meta.readTime) {
      const words = content.split(/\s+/).length;
      meta.readTime = Math.max(3, Math.round(words / 250));
    }
    // Extract first paragraph as description
    if (!meta.description) {
      const firstParagraph = content
        .split("\n")
        .find((line) => line.trim() && !line.startsWith("#"));
      if (firstParagraph) {
        meta.description = firstParagraph.trim().slice(0, 160);
      }
    }
  }

  return { content, meta };
}

function BlogContentPreview({ content }: { content: string }) {
  const [view, setView] = useState<"code" | "preview">("code");

  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden">
      <div className="flex items-center gap-1 bg-gray-50 px-3 py-1.5 border-b border-gray-100">
        <button
          onClick={() => setView("code")}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            view === "code" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Markdown
        </button>
        <button
          onClick={() => setView("preview")}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            view === "preview" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Preview
        </button>
      </div>
      {view === "preview" ? (
        <MarkdownPreview content={content} />
      ) : (
        <div className="max-h-[400px] overflow-y-auto bg-gray-50 p-4 prose prose-sm max-w-none whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildFrontmatter(
  meta: BlogMeta,
  lang: string,
  slug: string,
  imageFilename: string
): string {
  const today = new Date().toISOString().split("T")[0];
  return [
    "---",
    `title: "${(meta.title || "Untitled").replace(/"/g, '\\"')}"`,
    `description: "${(meta.description || "").replace(/"/g, '\\"')}"`,
    `date: "${today}"`,
    `slug: "${slug}"`,
    `tags: ${JSON.stringify(meta.tags || ["screenwriting"])}`,
    `lang: "${lang}"`,
    `author: "plotwell"`,
    `readTime: ${meta.readTime || 7}`,
    `image: "/blog/${imageFilename}"`,
    "---",
  ].join("\n");
}

interface GeneratedPost {
  lang: string;
  content: string;
  meta: BlogMeta;
  slug: string;
  markdown: string;
  filename: string;
}

/* ------------------------------------------------------------------ */
/*  Repurpose Panel                                                    */
/* ------------------------------------------------------------------ */

interface RepurposedContent {
  tiktok: string;
  instagram: string;
  twitter: string;
  linkedin: string;
  email: string;
  googleAds: string;
}

const PLATFORMS = [
  { key: "tiktok" as const, label: "TikTok", icon: "🎵" },
  { key: "instagram" as const, label: "Instagram", icon: "📸" },
  { key: "twitter" as const, label: "X / Twitter", icon: "🐦" },
  { key: "linkedin" as const, label: "LinkedIn", icon: "💼" },
  { key: "email" as const, label: "Email Newsletter", icon: "📧" },
  { key: "googleAds" as const, label: "Google Ads", icon: "📢" },
] as const;

function RepurposePanel({ posts }: { posts: GeneratedPost[] }) {
  const [expanded, setExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [content, setContent] = useState<RepurposedContent | null>(null);
  const [calendarAdded, setCalendarAdded] = useState(false);

  if (posts.length === 0) return null;

  const post = posts[0];
  const blogTitle = post.meta.title || "Untitled";
  const blogContent = post.content;
  const blogSnippet = blogContent.slice(0, 500);

  const handleGenerateAll = async () => {
    setIsGenerating(true);

    const results: Partial<RepurposedContent> = {};

    const tasks = [
      {
        key: "tiktok" as const,
        prompt: `Repurpose this blog post into a TikTok post. Blog: ${blogContent}\n\nCreate engaging TikTok-specific content based on the key points. Include a strong hook (first line that grabs attention), a concise caption, and relevant hashtags (8-12). Format as:\nHOOK: ...\nCAPTION: ...\nHASHTAGS: ...`,
        system: SOCIAL_SYSTEM,
      },
      {
        key: "instagram" as const,
        prompt: `Repurpose this blog post into an Instagram post. Blog: ${blogContent}\n\nCreate engaging Instagram-specific content based on the key points. Include a caption (with line breaks for readability), 3-5 carousel slide ideas, and relevant hashtags (15-20). Format as:\nCAPTION: ...\nCAROUSEL IDEAS:\n1. ...\n2. ...\nHASHTAGS: ...`,
        system: SOCIAL_SYSTEM,
      },
      {
        key: "twitter" as const,
        prompt: `Repurpose this blog post into an X/Twitter thread. Blog: ${blogContent}\n\nCreate an engaging thread of 4-6 tweets based on the key points. Each tweet should be under 280 characters. Format as:\nTWEET 1: ...\nTWEET 2: ...\n(etc.)`,
        system: SOCIAL_SYSTEM,
      },
      {
        key: "linkedin" as const,
        prompt: `Repurpose this blog post into a LinkedIn post. Blog: ${blogContent}\n\nCreate a professional, engaging LinkedIn post based on the key points. Include a hook first line, the main content with line breaks, and a closing thought. Keep it under 1300 characters.`,
        system: SOCIAL_SYSTEM,
      },
      {
        key: "email" as const,
        prompt: `Create a newsletter email promoting this blog post. Blog title: "${blogTitle}". Key points: ${blogSnippet}\n\nInclude subject line, preview text, and body. Format as:\nSUBJECT: ...\nPREVIEW: ...\nBODY:\n...`,
        system: EMAIL_SYSTEM,
      },
      {
        key: "googleAds" as const,
        prompt: `Create Google Ads copy promoting this blog post. Title: "${blogTitle}".\n\nGenerate 3 headlines (30 chars each max) and 2 descriptions (90 chars each max). Format as:\nHEADLINE 1: ...\nHEADLINE 2: ...\nHEADLINE 3: ...\nDESCRIPTION 1: ...\nDESCRIPTION 2: ...`,
        system: SEM_SYSTEM,
      },
    ];

    const promises = tasks.map(async (task) => {
      try {
        const result = await generate(task.prompt, {
          system: task.system,
          maxTokens: 1500,
          temperature: 0.7,
        });
        results[task.key] = result.trim();
      } catch {
        results[task.key] = `[Error generating ${task.key} content]`;
      }
    });

    await Promise.all(promises);
    setContent(results as RepurposedContent);
    setIsGenerating(false);
  };

  const handleAddAllToCalendar = () => {
    if (!content) return;

    const platformNames = PLATFORMS.map((p) => p.label).join(", ");
    addToCalendar({
      type: "blog",
      title: `Repurposed: ${blogTitle}`,
      notes: `Platforms: ${platformNames}\nOriginal slug: ${post.slug}`,
    });
    setCalendarAdded(true);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span>Repurpose Content</span>
          {content && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
              Generated
            </span>
          )}
        </span>
        <span className="text-xs text-gray-400">{expanded ? "Collapse" : "Expand"}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-5 space-y-4">
          {!content && (
            <div className="text-center py-4">
              <p className="text-sm text-gray-500 mb-3">
                Generate social media posts, email newsletter, and SEM ad copy from your blog post.
              </p>
              <button
                onClick={handleGenerateAll}
                disabled={isGenerating}
                className="rounded-lg bg-amber-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {isGenerating ? "Generating All..." : "Generate All"}
              </button>
            </div>
          )}

          {content && (
            <>
              <div className="space-y-3">
                {PLATFORMS.map(({ key, label, icon }) => (
                  <details key={key} className="rounded-lg border border-gray-200 overflow-hidden">
                    <summary className="flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-800 cursor-pointer hover:bg-gray-50 transition-colors">
                      <span>
                        {icon} {label}
                      </span>
                    </summary>
                    <div className="border-t border-gray-100 bg-gray-50 p-4">
                      <div className="flex justify-end mb-2">
                        <CopyButton text={content[key]} />
                      </div>
                      <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
                        {content[key]}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleGenerateAll}
                  disabled={isGenerating}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  {isGenerating ? "Regenerating..." : "Regenerate All"}
                </button>
                {!calendarAdded && (
                  <button
                    onClick={handleAddAllToCalendar}
                    className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors"
                  >
                    Add All to Calendar
                  </button>
                )}
                {calendarAdded && (
                  <span className="text-sm text-green-600 font-medium">Added to calendar</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Ideas Board                                                         */
/* ------------------------------------------------------------------ */

type IdeaStatus = "idea" | "writing" | "done";

interface BlogIdea {
  id: string;
  title: string;
  keyword: string;
  notes: string;
  status: IdeaStatus;
  createdAt: string;
}

const IDEAS_KEY = "blog-ideas-board";

function loadIdeas(): BlogIdea[] {
  try { return JSON.parse(localStorage.getItem(IDEAS_KEY) || "[]"); }
  catch { return []; }
}
function persistIdeas(ideas: BlogIdea[]) {
  localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas));
}

const COLUMNS: { id: IdeaStatus; label: string; color: string; dot: string }[] = [
  { id: "idea",    label: "Ideas",    color: "bg-gray-50 border-gray-200",   dot: "bg-gray-400" },
  { id: "writing", label: "Writing",  color: "bg-amber-50 border-amber-200", dot: "bg-amber-400" },
  { id: "done",    label: "Done",     color: "bg-green-50 border-green-200", dot: "bg-green-500" },
];

function IdeasBoard({ onWrite }: { onWrite: (title: string, keyword: string) => void }) {
  const [ideas,     setIdeas]     = useState<BlogIdea[]>(loadIdeas);
  const [drafting,  setDrafting]  = useState(false);
  const [newTitle,  setNewTitle]  = useState("");
  const [newKw,     setNewKw]     = useState("");
  const [newNotes,  setNewNotes]  = useState("");
  const [editId,    setEditId]    = useState<string | null>(null);
  const [editField, setEditField] = useState<Partial<BlogIdea>>({});

  const mut = (next: BlogIdea[]) => { setIdeas(next); persistIdeas(next); };

  const addIdea = () => {
    if (!newTitle.trim()) return;
    const idea: BlogIdea = {
      id: crypto.randomUUID(), title: newTitle.trim(), keyword: newKw.trim(),
      notes: newNotes.trim(), status: "idea", createdAt: new Date().toISOString(),
    };
    mut([idea, ...ideas]);
    setNewTitle(""); setNewKw(""); setNewNotes(""); setDrafting(false);
  };

  const move = (id: string, status: IdeaStatus) =>
    mut(ideas.map(i => i.id === id ? { ...i, status } : i));

  const remove = (id: string) => mut(ideas.filter(i => i.id !== id));

  const startEdit = (idea: BlogIdea) => { setEditId(idea.id); setEditField({ ...idea }); };
  const saveEdit  = () => {
    mut(ideas.map(i => i.id === editId ? { ...i, ...editField } : i));
    setEditId(null);
  };

  const byStatus = (s: IdeaStatus) => ideas.filter(i => i.status === s);

  return (
    <div className="space-y-5">
      {/* Add card */}
      {drafting ? (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-900">New idea</p>
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addIdea()}
            placeholder="Post title or topic…"
            autoFocus
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          <input value={newKw} onChange={e => setNewKw(e.target.value)}
            placeholder="Target keyword (optional)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          <textarea rows={2} value={newNotes} onChange={e => setNewNotes(e.target.value)}
            placeholder="Notes, angle, research links…"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none" />
          <div className="flex gap-2">
            <button onClick={addIdea} disabled={!newTitle.trim()}
              className="rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-semibold text-sm px-4 py-2 cursor-pointer transition-colors">
              Add idea
            </button>
            <button onClick={() => setDrafting(false)}
              className="rounded-lg border border-gray-200 text-gray-600 text-sm px-4 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDrafting(true)}
          className="w-full rounded-xl border-2 border-dashed border-gray-200 hover:border-amber-300 text-gray-400 hover:text-amber-600 text-sm font-medium py-3 transition-colors cursor-pointer">
          + Add idea
        </button>
      )}

      {/* Kanban columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {COLUMNS.map(col => (
          <div key={col.id} className={`rounded-xl border p-3 space-y-2 ${col.color}`}>
            <div className="flex items-center gap-2 px-1">
              <span className={`w-2 h-2 rounded-full ${col.dot}`} />
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{col.label}</span>
              <span className="ml-auto text-xs text-gray-400">{byStatus(col.id).length}</span>
            </div>

            {byStatus(col.id).length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4 italic">Empty</p>
            )}

            {byStatus(col.id).map(idea => (
              <div key={idea.id} className="rounded-lg border border-gray-200 bg-white p-3 space-y-1.5 group">
                {editId === idea.id ? (
                  <div className="space-y-2">
                    <input value={editField.title ?? ""} onChange={e => setEditField(f => ({ ...f, title: e.target.value }))}
                      className="w-full rounded border border-gray-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400" />
                    <input value={editField.keyword ?? ""} onChange={e => setEditField(f => ({ ...f, keyword: e.target.value }))}
                      placeholder="Keyword"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400" />
                    <textarea rows={2} value={editField.notes ?? ""} onChange={e => setEditField(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Notes"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400 resize-none" />
                    <div className="flex gap-1.5">
                      <button onClick={saveEdit} className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-medium rounded px-2.5 py-1 cursor-pointer transition-colors">Save</button>
                      <button onClick={() => setEditId(null)} className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium text-gray-900 leading-tight">{idea.title}</p>
                    {idea.keyword && <p className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded inline-block">{idea.keyword}</p>}
                    {idea.notes   && <p className="text-xs text-gray-500 leading-relaxed">{idea.notes}</p>}
                    {/* Actions */}
                    <div className="flex items-center gap-1 pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {COLUMNS.filter(c => c.id !== col.id).map(c => (
                        <button key={c.id} onClick={() => move(idea.id, c.id)}
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50 cursor-pointer transition-colors">
                          → {c.label}
                        </button>
                      ))}
                      <button onClick={() => onWrite(idea.title, idea.keyword)}
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 cursor-pointer transition-colors ml-auto">
                        ✏ Write
                      </button>
                      <button onClick={() => startEdit(idea)}
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50 cursor-pointer transition-colors">
                        Edit
                      </button>
                      <button onClick={() => remove(idea.id)}
                        className="text-gray-300 hover:text-red-400 cursor-pointer transition-colors ml-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [mainTab, setMainTab] = useState<"generate" | "ideas">("generate");

  const [topic, setTopic] = useState(() => {
    const prefill = consumePrefill();
    return prefill?.type === "blog" ? prefill.topic : "";
  });
  const [keyword, setKeyword] = useState("");
  const [lang, setLang] = useState<Lang>("en");
  const [customSlug, setCustomSlug] = useState("");
  const [customTags, setCustomTags] = useState("");
  const [generateImage, setGenerateImage] = useState(true);

  const [streamContent, setStreamContent] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [posts, setPosts] = useState<GeneratedPost[]>([]);
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [imageStatus, setImageStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!topic.trim() || isGenerating) return;

    setIsGenerating(true);
    setStreamContent("");
    setPosts([]);
    setSaveStatus("");
    setImageStatus("");
    setLogs([]);

    const languages = lang === "both" ? ["en", "es"] : [lang];
    const generated: GeneratedPost[] = [];
    let coverImageFilename: string | null = null;

    for (const currentLang of languages) {
      log(`Generating ${currentLang.toUpperCase()} blog post...`);

      try {
        // Stream the content for visual feedback
        let fullText = "";
        for await (const chunk of stream(
          buildUserPrompt(topic, currentLang, keyword),
          {
            system: BLOG_SYSTEM_PROMPT,
            maxTokens: 6000,
            temperature: 0.7,
          }
        )) {
          fullText += chunk;
          setStreamContent(fullText);
        }

        const { content, meta } = parseBlogOutput(fullText);

        // Override tags if provided
        if (customTags.trim()) {
          meta.tags = customTags.split(",").map((t) => t.trim());
        }

        let slug =
          customSlug.trim() ||
          meta.slug ||
          slugify(meta.title || topic);

        // Slug collision check
        if (existingSlugs.has(slug)) {
          log(`Warning: slug "${slug}" already exists! Adding suffix.`);
          slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
        }

        const imageSlug = slug.replace(/^(como-|how-to-|guia-)/g, "");
        coverImageFilename = coverImageFilename || `${imageSlug}.png`;

        const frontmatter = buildFrontmatter(
          meta,
          currentLang,
          slug,
          coverImageFilename
        );
        const markdown = `${frontmatter}\n\n${content}\n`;
        const filename = `${slug}.md`;

        generated.push({
          lang: currentLang,
          content,
          meta,
          slug,
          markdown,
          filename,
        });

        log(
          `${currentLang.toUpperCase()} done: "${meta.title}" (${slug})`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        log(`Error (${currentLang}): ${msg}`);
      }
    }

    // Auto-save drafts
    for (const post of generated) {
      saveDraft({
        id: `${post.slug}-${post.lang}-${Date.now()}`,
        topic,
        lang: post.lang,
        slug: post.slug,
        title: post.meta.title || topic,
        markdown: post.markdown,
        content: post.content,
        meta: post.meta,
        savedAt: new Date().toISOString(),
      });
    }

    setPosts(generated);
    setIsGenerating(false);
  }, [topic, keyword, lang, customSlug, customTags, isGenerating, log]);

  const handleSaveToDisk = useCallback(async () => {
    if (posts.length === 0) return;

    setSaveStatus("saving");

    for (const post of posts) {
      try {
        // Save markdown to plotwell-landing/content/blog/
        const contentPath = `../../plotwell-landing/content/blog/${post.filename}`;
        const blob = new Blob([post.markdown], { type: "text/markdown" });

        // Use File System Access API (local Chrome only)
        if ("showSaveFilePicker" in window) {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: post.filename,
            types: [
              {
                description: "Markdown",
                accept: { "text/markdown": [".md"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          log(`Saved ${post.filename}`);
        } else {
          // Fallback: download
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = post.filename;
          a.click();
          URL.revokeObjectURL(url);
          log(`Downloaded ${post.filename} (move to plotwell-landing/content/blog/)`);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          log(`Save cancelled for ${post.filename}`);
        } else {
          log(`Error saving ${post.filename}: ${err}`);
        }
      }
    }

    setSaveStatus("done");
  }, [posts, log]);

  const handleGenerateImage = useCallback(async () => {
    const imagePrompt = posts[0]?.meta?.imagePrompt;
    if (!imagePrompt) {
      log("No image prompt found in metadata");
      return;
    }

    setImageStatus("generating");
    const slug = posts[0].slug.replace(/^(como-|how-to-|guia-)/g, "");

    const styleGuide = `
Professional editorial illustration for a blog header. Clean, modern, visually striking.
Warm color palette with amber/gold (#d97706, #f59e0b) and deep slate blue (#1e3a5f, #2563eb) as accent colors.
Soft warm off-white background. Elegant composition with generous whitespace.
CRITICAL: Absolutely no text, no words, no letters, no numbers, no labels, no captions, no titles, no watermarks, no writing of any kind anywhere in the image.
High quality, detailed, professional graphic design aesthetic. Photorealistic 3D render with soft studio lighting.`;

    const fullPrompt = `${imagePrompt}\n${styleGuide}`;

    log("Generating cover image with Flux 2 Dev...");

    try {
      const token = import.meta.env.VITE_REPLICATE_API_TOKEN;
      const response = await fetch(
        "/replicate-api/v1/models/black-forest-labs/flux-2-dev/predictions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "wait",
          },
          body: JSON.stringify({
            input: {
              prompt: fullPrompt,
              aspect_ratio: "16:9",
              output_format: "png",
              output_quality: 90,
              go_fast: true,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      let imageUrl = data.output;
      if (Array.isArray(imageUrl)) imageUrl = imageUrl[0];
      if (typeof imageUrl === "object" && imageUrl?.href) imageUrl = imageUrl.href;

      // Download and save
      const imgResponse = await fetch(imageUrl);
      const imgBlob = await imgResponse.blob();
      const filename = `${slug}.png`;

      if ("showSaveFilePicker" in window) {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [
            { description: "PNG Image", accept: { "image/png": [".png"] } },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(imgBlob);
        await writable.close();
        log(`Saved cover image: ${filename}`);
      } else {
        const url = URL.createObjectURL(imgBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        log(`Downloaded ${filename} (move to plotwell-landing/public/blog/)`);
      }

      setImageStatus("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      log(`Image error: ${msg}`);
      setImageStatus("error");
    }
  }, [posts, log]);

  const handleRestoreDraft = useCallback((draft: Draft) => {
    setTopic(draft.topic);
    setCustomSlug(draft.slug);
    if (draft.meta.tags) setCustomTags(draft.meta.tags.join(", "));
    setLang(draft.lang as Lang);
    setPosts([
      {
        lang: draft.lang,
        content: draft.content,
        meta: draft.meta,
        slug: draft.slug,
        markdown: draft.markdown,
        filename: `${draft.slug}.md`,
      },
    ]);
    setStreamContent("");
    setLogs([`Restored draft: "${draft.title}"`]);
  }, []);

  const canGenerate = topic.trim().length > 0 && !isGenerating;

  // Suggestion helpers
  const gaps = lang === "es" ? CONTENT_GAPS.blog_es : CONTENT_GAPS.blog_en;
  const existingSlugs = getExistingSlugs();
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [aiSuggestions, setAiSuggestions] = useState<Array<{ topic: string; keyword: string; tags: string[] }>>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);

  // Autopilot state
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotStep, setAutopilotStep] = useState("");

  /** ONE CLICK: AI picks best topic, generates EN+ES posts, cover image, repurposed content, adds to calendar */
  const handleAutopilot = useCallback(async () => {
    if (autopilotRunning || isGenerating) return;
    setAutopilotRunning(true);
    setStreamContent("");
    setPosts([]);
    setSaveStatus("");
    setImageStatus("");
    setLogs([]);

    try {
      // Step 1: AI picks the best topic
      setAutopilotStep("Picking the best topic...");
      log("Autopilot: Analyzing existing content and finding gaps...");
      const existing = getExistingPostsSummary();
      const topicResult = await generate(
        `Existing blog posts on the plotwell blog:\n${existing}\n\nPick the SINGLE BEST new blog post topic to write right now. Consider:\n- What content gaps exist (topics NOT yet covered)\n- What would drive the most organic search traffic\n- What's most relevant to screenwriters/filmmakers right now\n- Seasonal relevance (current date: ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })})\n\nReturn ONLY a JSON object with: "topic" (the full topic), "keyword" (target SEO keyword), "tags" (array of 2-3 tags from: screenwriting, production, storyboarding, characters, formatting, story structure, series, collaboration, content creation, AI tools, filmmaking, budgeting), "reasoning" (1 sentence why this is the best choice right now).\n\nNo explanation, just the JSON.`,
        { system: "You are an SEO content strategist for plotwell, a screenplay editor platform. Pick topics that will rank well and drive signups.", maxTokens: 500, temperature: 0.7 }
      );
      const topicMatch = topicResult.match(/\{[\s\S]*\}/);
      if (!topicMatch) throw new Error("Could not parse topic suggestion");
      const suggestion = JSON.parse(topicMatch[0]);

      setTopic(suggestion.topic);
      setKeyword(suggestion.keyword);
      setCustomTags(suggestion.tags.join(", "));
      setCustomSlug("");
      log(`Topic selected: "${suggestion.topic}" (${suggestion.reasoning})`);

      // Step 2: Generate posts
      const languages = lang === "both" ? ["en", "es"] : [lang];
      setAutopilotStep(`Writing ${languages.map(l => l.toUpperCase()).join(" + ")} blog post${languages.length > 1 ? "s" : ""}...`);
      const generated: GeneratedPost[] = [];
      let coverImageFilename: string | null = null;

      for (const currentLang of languages) {
        log(`Generating ${currentLang.toUpperCase()} post...`);
        let fullText = "";
        for await (const chunk of stream(
          buildUserPrompt(suggestion.topic, currentLang, suggestion.keyword),
          { system: BLOG_SYSTEM_PROMPT, maxTokens: 6000, temperature: 0.7 }
        )) {
          fullText += chunk;
          setStreamContent(fullText);
        }

        const { content, meta } = parseBlogOutput(fullText);
        if (suggestion.tags.length > 0) meta.tags = suggestion.tags;

        let slug = meta.slug || slugify(meta.title || suggestion.topic);
        if (existingSlugs.has(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

        const imageSlug = slug.replace(/^(como-|how-to-|guia-)/g, "");
        coverImageFilename = coverImageFilename || `${imageSlug}.png`;

        const frontmatter = buildFrontmatter(meta, currentLang, slug, coverImageFilename);
        const markdown = `${frontmatter}\n\n${content}\n`;

        generated.push({ lang: currentLang, content, meta, slug, markdown, filename: `${slug}.md` });
        log(`${currentLang.toUpperCase()} done: "${meta.title}"`);

        // Auto-save draft
        saveDraft({
          id: `${slug}-${currentLang}-${Date.now()}`,
          topic: suggestion.topic,
          lang: currentLang, slug,
          title: meta.title || suggestion.topic,
          markdown, content, meta,
          savedAt: new Date().toISOString(),
        });
      }

      setPosts(generated);
      setStreamContent("");

      // Save to history
      for (const post of generated) {
        saveToHistory({
          source: "blog",
          title: post.meta.title || suggestion.topic,
          content: post.markdown,
          metadata: { lang: post.lang, slug: post.slug, keyword: suggestion.keyword },
        });
      }

      // Step 3: Auto-download .md files
      setAutopilotStep("Saving .md files...");
      for (const post of generated) {
        const blob = new Blob([post.markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = post.filename; a.click();
        URL.revokeObjectURL(url);
        log(`Downloaded ${post.filename}`);
      }

      // Step 4: Generate cover image
      let imageAssetUrl: string | undefined;
      const imagePrompt = generated[0]?.meta?.imagePrompt;
      if (imagePrompt && generateImage) {
        setAutopilotStep("Generating cover image...");
        log("Generating cover image with Flux 2 Dev...");
        try {
          const token = import.meta.env.VITE_REPLICATE_API_TOKEN;
          const styleGuide = `Professional editorial illustration for a blog header. Clean, modern, visually striking. Warm color palette with amber/gold (#d97706, #f59e0b) and deep slate blue (#1e3a5f, #2563eb) as accent colors. Soft warm off-white background. CRITICAL: No text, no words, no letters anywhere. Photorealistic 3D render with soft studio lighting.`;
          const response = await fetch(
            "/replicate-api/v1/models/black-forest-labs/flux-2-dev/predictions",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
              body: JSON.stringify({ input: { prompt: `${imagePrompt}\n${styleGuide}`, aspect_ratio: "16:9", output_format: "png", output_quality: 90, go_fast: true } }),
            }
          );
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
          }
          const data = await response.json();
          let imageUrl = data.output;
          if (Array.isArray(imageUrl)) imageUrl = imageUrl[0];
          if (typeof imageUrl === "object" && imageUrl?.href) imageUrl = imageUrl.href;
          imageAssetUrl = imageUrl;

          // Auto-download
          const imgResponse = await fetch(imageUrl);
          const imgBlob = await imgResponse.blob();
          const imgSlug = generated[0].slug.replace(/^(como-|how-to-|guia-)/g, "");
          const filename = `${imgSlug}.png`;
          const dlUrl = URL.createObjectURL(imgBlob);
          const dl = document.createElement("a");
          dl.href = dlUrl; dl.download = filename; dl.click();
          URL.revokeObjectURL(dlUrl);
          log(`Cover image downloaded: ${filename}`);
          setImageStatus("done");
        } catch (err) {
          log(`Image generation failed: ${err instanceof Error ? err.message : "error"}`);
          setImageStatus("error");
        }
      }

      // Step 5: Save to history + calendar
      const historyAssets: { type: string; url: string; label: string }[] = [];
      if (imageAssetUrl) historyAssets.push({ type: "image", url: imageAssetUrl, label: "Cover image" });

      for (const post of generated) {
        saveToHistory({
          source: "blog",
          title: post.meta.title || suggestion.topic,
          content: post.markdown,
          assets: historyAssets.length > 0 ? historyAssets : undefined,
          metadata: { lang: post.lang, slug: post.slug, keyword: suggestion.keyword },
        });
      }

      addToCalendar({
        type: "blog",
        title: generated[0].meta.title || suggestion.topic,
        notes: `Slug: ${generated[0].slug}\nLangs: ${languages.join(", ").toUpperCase()}\nKeyword: ${suggestion.keyword}`,
      });
      log("Saved to history and calendar");

      setAutopilotStep("Done! Everything saved.");
      log("Autopilot complete.");
    } catch (err) {
      log(`Autopilot error: ${err instanceof Error ? err.message : "error"}`);
      setAutopilotStep("Error occurred. Check logs.");
    } finally {
      setAutopilotRunning(false);
    }
  }, [autopilotRunning, isGenerating, log, existingSlugs]);

  const pickSuggestion = (s: { topic: string; keyword: string; tags: string[] }) => {
    setTopic(s.topic);
    setKeyword(s.keyword);
    setCustomTags(s.tags.join(", "));
    setShowSuggestions(false);
  };

  const handleAISuggest = useCallback(async () => {
    setIsSuggesting(true);
    try {
      const existing = getExistingPostsSummary();
      const result = await generate(
        `Here are the existing blog posts on the plotwell blog:\n${existing}\n\nSuggest 5 NEW blog post topics that would fill content gaps and attract organic traffic. Focus on screenwriting, filmmaking, and production planning topics NOT already covered.\n\nReturn ONLY a JSON array of objects with: "topic" (the full article topic/title idea), "keyword" (target SEO keyword phrase), "tags" (array of 2-3 tags from: screenwriting, production, storyboarding, characters, formatting, story structure, series, collaboration, content creation, AI tools, filmmaking, budgeting).\n\nNo explanation, just the JSON array.`,
        { system: "You are an SEO content strategist for plotwell, a screenplay editor platform.", maxTokens: 1500, temperature: 0.9 }
      );
      const match = result.match(/\[[\s\S]*\]/);
      if (match) setAiSuggestions(JSON.parse(match[0]));
    } catch { /* ignore */ }
    setIsSuggesting(false);
  }, []);

  return (
    <ToolPage
      title="Blog Post Generator"
      description="Generate blog posts with frontmatter, SEO metadata, and cover images for plotwell-landing."
    >
      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 mb-6">
        {(["generate", "ideas"] as const).map(t => (
          <button key={t} onClick={() => setMainTab(t)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer capitalize ${mainTab === t ? "bg-white text-amber-700 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}>
            {t === "generate" ? "Generate" : "Ideas board"}
          </button>
        ))}
      </div>

      {mainTab === "ideas" && (
        <IdeasBoard onWrite={(title, kw) => {
          setTopic(title);
          if (kw) setKeyword(kw);
          setMainTab("generate");
        }} />
      )}

      {mainTab === "generate" && <div className="space-y-6">
        {/* AUTOPILOT */}
        {!posts.length && !isGenerating && !autopilotRunning && (
          <div className="rounded-xl border-2 border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-900">Autopilot</h3>
                <p className="text-sm text-gray-600 mt-0.5">
                  AI picks the best topic, writes posts, generates assets, and adds to calendar.
                </p>
              </div>
              <button
                onClick={handleAutopilot}
                className="rounded-xl bg-amber-600 px-8 py-3 text-sm font-bold text-white hover:bg-amber-700 shadow-md hover:shadow-lg transition-all"
              >
                Generate Everything
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-amber-200">
              <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                <input type="checkbox" checked={lang === "both"} onChange={(e) => setLang(e.target.checked ? "both" : "en")} className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                EN + ES (both languages)
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                <input type="checkbox" checked={generateImage} onChange={(e) => setGenerateImage(e.target.checked)} className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                Cover image
              </label>
              <span className="ml-auto text-[11px] text-gray-400">
                Est. cost: {formatCost(estimateCosts({
                  textGenerations: lang === "both" ? 3 : 2,
                  imageGenerations: generateImage ? 1 : 0,
                }).total)}
              </span>
            </div>
          </div>
        )}

        {/* Autopilot progress */}
        {autopilotRunning && (
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-800">{autopilotStep}</p>
              </div>
            </div>
          </div>
        )}

        {/* Quick suggestions */}
        {showSuggestions && !isGenerating && !autopilotRunning && !posts.length && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-amber-800">Suggested Topics</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleAISuggest}
                  disabled={isSuggesting}
                  className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                >
                  {isSuggesting ? "Thinking..." : "Ask AI for Ideas"}
                </button>
                <button
                  onClick={() => setShowSuggestions(false)}
                  className="text-xs text-amber-600 hover:text-amber-800"
                >
                  Hide
                </button>
              </div>
            </div>

            {/* AI suggestions */}
            {aiSuggestions.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-amber-700 mb-2">AI suggestions:</p>
                <div className="space-y-1.5">
                  {aiSuggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => pickSuggestion(s)}
                      className="w-full text-left rounded-md border border-amber-200 bg-white px-3 py-2 text-sm text-gray-800 hover:border-amber-400 hover:bg-amber-50 transition-colors"
                    >
                      <span className="font-medium">{s.topic}</span>
                      <span className="ml-2 text-xs text-gray-400">({s.keyword})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Pre-built gap suggestions */}
            <p className="text-xs font-medium text-amber-700 mb-2">
              Content gaps ({lang === "es" ? "ES" : "EN"}):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {gaps.slice(0, 8).map((s, i) => (
                <button
                  key={i}
                  onClick={() => pickSuggestion(s)}
                  className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs text-gray-700 hover:border-amber-500 hover:bg-amber-50 transition-colors"
                >
                  {s.topic.length > 60 ? s.topic.slice(0, 57) + "..." : s.topic}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-amber-600/70">
              {existingSlugs.size} posts already published. Click a topic to auto-fill and generate.
            </p>
          </div>
        )}

        {/* Draft History */}
        <DraftHistory onRestore={handleRestoreDraft} />

        {/* Inputs */}
        <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
          {/* Topic */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">
                Topic
              </label>
              {!showSuggestions && !isGenerating && !posts.length && (
                <button onClick={() => setShowSuggestions(true)} className="text-xs text-amber-600 hover:text-amber-700">
                  Show suggestions
                </button>
              )}
            </div>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder='e.g. "How to write a pilot episode" or "Beat sheets for beginners"'
              disabled={isGenerating}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
            />
          </div>

          {/* Keyword + Language row */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target Keyword
                <span className="ml-1 text-gray-400 font-normal">
                  (optional)
                </span>
              </label>
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="e.g. screenwriting dialogue tips"
                disabled={isGenerating}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Language
              </label>
              <div className="flex gap-2">
                {(["en", "es", "both"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLang(l)}
                    disabled={isGenerating}
                    className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                      lang === l
                        ? "border-amber-500 bg-amber-50 text-amber-700"
                        : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
                    }`}
                  >
                    {l === "both" ? "EN + ES" : l.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Slug + Tags row */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Custom Slug
                <span className="ml-1 text-gray-400 font-normal">
                  (auto-generated if empty)
                </span>
              </label>
              <input
                type="text"
                value={customSlug}
                onChange={(e) => setCustomSlug(e.target.value)}
                placeholder="e.g. how-to-write-pilot-episode"
                disabled={isGenerating}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tags
                <span className="ml-1 text-gray-400 font-normal">
                  (comma-separated, auto if empty)
                </span>
              </label>
              <input
                type="text"
                value={customTags}
                onChange={(e) => setCustomTags(e.target.value)}
                placeholder="e.g. screenwriting, story structure"
                disabled={isGenerating}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
              />
            </div>
          </div>

          {/* Options row */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={generateImage}
                onChange={(e) => setGenerateImage(e.target.checked)}
                disabled={isGenerating}
                className="rounded border-gray-300 text-amber-600 focus:ring-amber-500"
              />
              Generate cover image
            </label>
          </div>

          {/* Generate button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="rounded-lg bg-amber-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {isGenerating
                ? "Generating..."
                : lang === "both"
                ? "Generate EN + ES Posts"
                : "Generate Blog Post"}
            </button>
          </div>
        </div>

        {/* Live preview while streaming */}
        {(streamContent || isGenerating) && !posts.length && (
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Generating...
            </h3>
            <StreamingOutput
              content={streamContent}
              isStreaming={isGenerating}
              className="min-h-[200px] max-h-[500px] rounded-lg border border-gray-100 bg-gray-50 p-4"
            />
          </div>
        )}

        {/* Generated posts */}
        {posts.length > 0 && (
          <div className="space-y-4">
            {posts.map((post) => (
              <div
                key={post.lang}
                className="rounded-lg border border-gray-200 bg-white p-5"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        {post.lang.toUpperCase()}
                      </span>
                      <h3 className="text-base font-semibold text-gray-900">
                        {post.meta.title || "Untitled"}
                      </h3>
                    </div>
                    <p className="text-xs text-gray-500">
                      Slug: <code className="bg-gray-100 px-1 rounded">{post.slug}</code>
                      {" | "}
                      Tags: {(post.meta.tags || []).join(", ")}
                      {" | "}
                      ~{post.meta.readTime || 7} min read
                    </p>
                    {post.meta.description && (
                      <p className="text-xs text-gray-400 mt-1 italic">
                        {post.meta.description}
                      </p>
                    )}
                  </div>
                  <CopyButton text={post.markdown} />
                </div>

                {/* Frontmatter preview */}
                <details className="mb-3">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                    View frontmatter
                  </summary>
                  <pre className="mt-2 rounded bg-gray-50 p-3 text-xs text-gray-600 overflow-x-auto">
                    {post.markdown.split("---")[1]
                      ? `---${post.markdown.split("---")[1]}---`
                      : ""}
                  </pre>
                </details>

                {/* Content preview with toggle */}
                <BlogContentPreview content={post.content} />
              </div>
            ))}

            {/* Status badges */}
            <div className="flex items-center gap-2 text-xs">
              {saveStatus === "done" && <span className="px-2 py-1 rounded-full bg-green-100 text-green-700">Files downloaded</span>}
              {imageStatus === "done" && <span className="px-2 py-1 rounded-full bg-purple-100 text-purple-700">Cover image downloaded</span>}
              {imageStatus === "error" && <span className="px-2 py-1 rounded-full bg-red-100 text-red-700">Image failed</span>}
              <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-700">Saved to history</span>
            </div>

            {/* Repurpose content into social, email, SEM */}
            <RepurposePanel posts={posts} />
          </div>
        )}

        {/* Logs */}
        {logs.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-900 p-4">
            <h4 className="text-xs font-medium text-gray-400 mb-2">Log</h4>
            <div className="space-y-1 font-mono text-xs text-gray-300">
              {logs.map((msg, i) => (
                <div key={i}>{msg}</div>
              ))}
            </div>
          </div>
        )}
      </div>}
    </ToolPage>
  );
}
