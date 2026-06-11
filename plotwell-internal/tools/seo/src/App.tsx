import { useState, useEffect, useCallback, useMemo } from "react";
import { generate, stream, estimateCosts, formatCost } from "@shared/ai-client";
import { SEO_SYSTEM } from "@shared/prompts";
import { getExistingPostsSummary, PLOTWELL_FEATURES } from "@shared/content";
import { saveToHistory } from "@shared/history";
import {
  ToolPage,
  PromptInput,
  StreamingOutput,
  CopyButton,
} from "@shared/components";
import {
  isConfigured,
  getStoredToken,
  startOAuthFlow,
  clearToken,
  searchConsoleQuery,
  searchConsoleSites,
  type SearchConsoleRow,
} from "@shared/google-auth";

type Tab = "data" | "meta" | "keywords" | "optimizer" | "schema" | "auditor" | "backlinks";

/* ------------------------------------------------------------------ */
/*  Shared: Search Console data hook                                   */
/* ------------------------------------------------------------------ */

function useSCData() {
  const [queries, setQueries] = useState<SearchConsoleRow[]>([]);
  const [pages, setPages] = useState<SearchConsoleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState(
    import.meta.env.VITE_SEARCH_CONSOLE_SITE_URL || ""
  );

  const load = useCallback(async () => {
    const token = getStoredToken();
    if (!token || !site) return;
    setLoading(true);
    setError(null);
    try {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);
      const fmt = (d: Date) => d.toISOString().split("T")[0];

      const [q, p] = await Promise.all([
        searchConsoleQuery(site, {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ["query"],
          rowLimit: 100,
        }),
        searchConsoleQuery(site, {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ["page"],
          rowLimit: 50,
        }),
      ]);
      const qRows = Array.isArray(q) ? q : [];
      const pRows = Array.isArray(p) ? p : [];
      setQueries(qRows);
      setPages(pRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load SC data");
    } finally {
      setLoading(false);
    }
  }, [site]);

  return { queries, pages, loading, error, site, setSite, load };
}

/* ------------------------------------------------------------------ */
/*  Google Auth Banner (reused)                                        */
/* ------------------------------------------------------------------ */

function GoogleAuthBanner({ onConnect }: { onConnect: () => void }) {
  if (!isConfigured()) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-semibold text-amber-800 mb-1">
          Connect Google Search Console
        </h3>
        <p className="text-xs text-amber-700">
          Set VITE_GOOGLE_CLIENT_ID in .env.local to get real keyword data.
          The SEO tools will work without it using AI-only mode.
        </p>
      </div>
    );
  }

  const token = getStoredToken();
  if (token) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold text-blue-800">
          Connect Google for real keyword data
        </h3>
        <p className="text-xs text-blue-600">
          Enhance keyword suggestions with actual Search Console data
        </p>
      </div>
      <button
        onClick={onConnect}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
      >
        Connect
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Real Data Tab (Search Console insights)                            */
/* ------------------------------------------------------------------ */

function RealDataTab({ sc }: { sc: ReturnType<typeof useSCData> }) {
  const token = getStoredToken();

  const handleConnect = async () => {
    try {
      await startOAuthFlow();
      sc.load();
    } catch {
      // user closed popup
    }
  };

  if (!token) {
    return (
      <div className="space-y-4">
        <GoogleAuthBanner onConnect={handleConnect} />
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm text-gray-500">
            Connect Google Search Console to see real keyword performance,
            opportunity gaps, and page-level insights.
          </p>
        </div>
      </div>
    );
  }

  if (sc.loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }

  if (sc.error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {sc.error}
        <button onClick={sc.load} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  const totalClicks = sc.queries.reduce((s, r) => s + r.clicks, 0) || sc.pages.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = sc.queries.reduce((s, r) => s + r.impressions, 0) || sc.pages.reduce((s, r) => s + r.impressions, 0);

  // Opportunity keywords: high impressions, low CTR
  const opportunities = [...sc.queries]
    .filter((r) => r.impressions >= 5 && r.ctr < 0.05)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  // Quick wins: already ranking page 1-2, could improve
  const quickWins = [...sc.queries]
    .filter((r) => r.position <= 20 && r.position > 3 && r.impressions >= 3)
    .sort((a, b) => a.position - b.position)
    .slice(0, 10);

  // Top performers
  const topPerformers = [...sc.queries]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  // Low-performing pages
  const lowPages = [...sc.pages]
    .filter((r) => r.impressions >= 5 && r.ctr < 0.02)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase">Clicks (90d)</p>
          <p className="text-2xl font-bold text-blue-700 mt-1">{totalClicks.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase">Impressions</p>
          <p className="text-2xl font-bold text-green-700 mt-1">{totalImpressions.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase">Keywords</p>
          <p className="text-2xl font-bold text-amber-700 mt-1">{sc.queries.length}</p>
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase">Pages</p>
          <p className="text-2xl font-bold text-purple-700 mt-1">{sc.pages.length}</p>
        </div>
      </div>

      {/* Opportunity keywords */}
      {opportunities.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-amber-800 mb-1">
            Opportunity Keywords
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            High impressions but low CTR. Improve titles/descriptions for these.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Query</th>
                <th className="pb-2 font-medium text-right">Impressions</th>
                <th className="pb-2 font-medium text-right">Clicks</th>
                <th className="pb-2 font-medium text-right">CTR</th>
                <th className="pb-2 font-medium text-right">Position</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-amber-50">
                  <td className="py-2 text-gray-700 font-medium">{r.keys[0]}</td>
                  <td className="py-2 text-right text-gray-600">{r.impressions}</td>
                  <td className="py-2 text-right text-gray-600">{r.clicks}</td>
                  <td className="py-2 text-right text-red-600">{(r.ctr * 100).toFixed(1)}%</td>
                  <td className="py-2 text-right text-gray-600">{r.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick wins */}
      {quickWins.length > 0 && (
        <div className="rounded-xl border border-green-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-green-800 mb-1">
            Quick Wins
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            Already ranking on page 1-2. Small improvements could boost these to top positions.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Query</th>
                <th className="pb-2 font-medium text-right">Position</th>
                <th className="pb-2 font-medium text-right">Impressions</th>
                <th className="pb-2 font-medium text-right">CTR</th>
              </tr>
            </thead>
            <tbody>
              {quickWins.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-green-50">
                  <td className="py-2 text-gray-700 font-medium">{r.keys[0]}</td>
                  <td className="py-2 text-right text-amber-600 font-semibold">{r.position.toFixed(1)}</td>
                  <td className="py-2 text-right text-gray-600">{r.impressions}</td>
                  <td className="py-2 text-right text-gray-600">{(r.ctr * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top performers */}
      {topPerformers.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-1">
            Top Performing Keywords
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            Your best keywords by clicks. Protect and expand these.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Query</th>
                <th className="pb-2 font-medium text-right">Clicks</th>
                <th className="pb-2 font-medium text-right">Impressions</th>
                <th className="pb-2 font-medium text-right">CTR</th>
                <th className="pb-2 font-medium text-right">Position</th>
              </tr>
            </thead>
            <tbody>
              {topPerformers.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-blue-50">
                  <td className="py-2 text-gray-700 font-medium">{r.keys[0]}</td>
                  <td className="py-2 text-right text-blue-700 font-semibold">{r.clicks}</td>
                  <td className="py-2 text-right text-gray-600">{r.impressions}</td>
                  <td className="py-2 text-right text-gray-600">{(r.ctr * 100).toFixed(1)}%</td>
                  <td className="py-2 text-right text-gray-600">{r.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pages needing improvement */}
      {lowPages.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-red-800 mb-1">
            Pages Needing Improvement
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            Getting impressions but almost no clicks. Rewrite meta tags for these.
          </p>
          <div className="space-y-2">
            {lowPages.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50">
                <span className="text-xs text-gray-700 truncate max-w-[400px]">{r.keys[0]}</span>
                <div className="flex gap-4 text-xs text-gray-500 shrink-0">
                  <span>{r.impressions} imp</span>
                  <span>{r.clicks} clicks</span>
                  <span className="text-red-600">{(r.ctr * 100).toFixed(1)}% CTR</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {sc.queries.length === 0 && sc.pages.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm text-gray-500">
            No Search Console data yet. This could be because the site is new
            or the data range doesn't have enough traffic.
          </p>
          <button onClick={sc.load} className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors">
            Refresh Data
          </button>
        </div>
      )}

      {/* Disconnect */}
      <div className="flex justify-end">
        <button
          onClick={() => { clearToken(); sc.load(); }}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Disconnect Google
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Meta Generator (enhanced with SC data)                             */
/* ------------------------------------------------------------------ */

function MetaGenerator({ sc }: { sc: ReturnType<typeof useSCData> }) {
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [previewUrl, setPreviewUrl] = useState("https://plotwell.co");

  // Build context from real SC data
  const scContext = sc.queries.length > 0
    ? `\n\nREAL SEARCH CONSOLE DATA (last 90 days):\nTop performing queries: ${sc.queries
        .slice(0, 10)
        .map((r) => `"${r.keys[0]}" (${r.clicks} clicks, pos ${r.position.toFixed(1)})`)
        .join(", ")}\nPages with low CTR that need better meta: ${sc.pages
        .filter((r) => r.ctr < 0.03 && r.impressions >= 3)
        .slice(0, 5)
        .map((r) => r.keys[0])
        .join(", ")}\n\nUse these real keywords to inform your meta tag suggestions.`
    : "";

  const handleGenerate = async (prompt: string) => {
    setOutput("");
    setIsStreaming(true);
    const fullPrompt = `Generate SEO meta tags for the following page or topic. Provide multiple options (at least 3 variations).

For each variation provide:
- Meta title (max 60 characters)
- Meta description (max 160 characters)

Topic/Page: ${prompt}
${scContext}
Format each variation clearly numbered. After the variations, provide a brief explanation of the SEO strategy behind each option.`;

    let result = "";
    try {
      for await (const chunk of stream(fullPrompt, { system: SEO_SYSTEM })) {
        result += chunk;
        setOutput(result);
      }
    } finally {
      setIsStreaming(false);
    }
  };

  const titleCount = title.length;
  const descCount = description.length;

  return (
    <div className="space-y-6">
      {sc.queries.length > 0 && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-xs text-green-700">
          Using real Search Console data ({sc.queries.length} keywords) to enhance suggestions
        </div>
      )}

      <PromptInput
        onSubmit={handleGenerate}
        placeholder="Enter a page name or topic (e.g., 'screenplay formatting guide', 'AI screenwriting tools comparison')..."
        disabled={isStreaming}
      />

      {/* SERP Preview */}
      {(title || description) && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Google SERP Preview
          </h3>
          <div className="rounded-lg border border-gray-100 bg-white p-4 max-w-xl">
            <p className="text-xs text-green-700 truncate">{previewUrl}</p>
            <p className="text-blue-800 text-lg font-medium leading-snug mt-0.5 hover:underline cursor-pointer">
              {title || "Enter a meta title above..."}
            </p>
            <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">
              {description || "Enter a meta description above..."}
            </p>
          </div>
        </div>
      )}

      {/* Live character counter */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">
          Character Counter & SERP Editor
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Page URL</label>
            <input type="url" value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Meta Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Paste or type your meta title..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500" />
            <div className="mt-1 flex items-center justify-between">
              <span className={`text-xs font-medium ${titleCount > 60 ? "text-red-600" : titleCount > 50 ? "text-amber-600" : "text-gray-400"}`}>
                {titleCount} / 60 characters
              </span>
              {titleCount > 60 && <span className="text-xs text-red-500">{titleCount - 60} over limit</span>}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Meta Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Paste or type your meta description..." rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none" />
            <div className="mt-1 flex items-center justify-between">
              <span className={`text-xs font-medium ${descCount > 160 ? "text-red-600" : descCount > 140 ? "text-amber-600" : "text-gray-400"}`}>
                {descCount} / 160 characters
              </span>
              {descCount > 160 && <span className="text-xs text-red-500">{descCount - 160} over limit</span>}
            </div>
          </div>
        </div>
      </div>

      {(output || isStreaming) && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Generated Meta Tags</h3>
            {output && !isStreaming && <CopyButton text={output} />}
          </div>
          <StreamingOutput content={output} isStreaming={isStreaming} className="max-h-96" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Keyword Ideas (enhanced with SC data)                              */
/* ------------------------------------------------------------------ */

function KeywordIdeas({ sc }: { sc: ReturnType<typeof useSCData> }) {
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const scContext = sc.queries.length > 0
    ? `\n\nREAL SEARCH CONSOLE DATA (last 90 days) - keywords plotwell already ranks for:\n${sc.queries
        .slice(0, 20)
        .map((r) => `- "${r.keys[0]}" (${r.impressions} impressions, ${r.clicks} clicks, position ${r.position.toFixed(1)})`)
        .join("\n")}\n\nUse this data to:\n1. Suggest related keywords that complement existing rankings\n2. Identify gaps where plotwell should rank but doesn't\n3. Suggest long-tail variations of working keywords\n4. Avoid suggesting keywords that are already well-covered`
    : "";

  const handleGenerate = async (prompt: string) => {
    setOutput("");
    setIsStreaming(true);
    const fullPrompt = `Given the following seed keyword, generate a comprehensive list of related keywords and content ideas for the plotwell blog and landing pages.

Seed keyword: ${prompt}
${scContext}
Provide:
1. **Primary keywords** (5-8) - High intent, directly related terms
2. **Long-tail keywords** (8-12) - Specific phrases with lower competition
3. **Question-based keywords** (5-8) - "How to...", "What is...", etc.
4. **Content angle suggestions** - For each primary keyword, suggest a specific content angle (blog post title, landing page concept, or guide topic) that would work well for plotwell
${sc.queries.length > 0 ? "5. **Gap analysis** - Keywords plotwell SHOULD rank for based on the existing data but currently doesn't" : ""}

Format with clear sections and bullet points.`;

    let result = "";
    try {
      for await (const chunk of stream(fullPrompt, { system: SEO_SYSTEM, maxTokens: 4096 })) {
        result += chunk;
        setOutput(result);
      }
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="space-y-6">
      {sc.queries.length > 0 && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-xs text-green-700">
          Using {sc.queries.length} real keywords from Search Console to find gaps and opportunities
        </div>
      )}

      <PromptInput
        onSubmit={handleGenerate}
        placeholder="Enter a seed keyword (e.g., 'screenplay software', 'AI screenwriting', 'film production planning')..."
        disabled={isStreaming}
      />

      {/* Quick seed suggestions from real data */}
      {sc.queries.length > 0 && !output && !isStreaming && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-xs font-semibold text-gray-600 mb-2">
            Seed from real data:
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {sc.queries
              .filter((r) => r.impressions >= 3)
              .slice(0, 12)
              .map((r, i) => (
                <button
                  key={i}
                  onClick={() => {
                    const input = document.querySelector<HTMLTextAreaElement>(
                      "textarea"
                    );
                    if (input) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        "value"
                      )?.set;
                      nativeInputValueSetter?.call(input, r.keys[0]);
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                    }
                  }}
                  className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-600 hover:border-amber-400 hover:bg-amber-50 transition-colors"
                >
                  {r.keys[0]}
                  <span className="ml-1 text-gray-400">{r.impressions}imp</span>
                </button>
              ))}
          </div>
        </div>
      )}

      {(output || isStreaming) && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Keyword Ideas & Content Angles</h3>
            {output && !isStreaming && <CopyButton text={output} />}
          </div>
          <StreamingOutput content={output} isStreaming={isStreaming} className="max-h-[32rem]" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Content Optimizer (enhanced with SC data)                          */
/* ------------------------------------------------------------------ */

function ContentOptimizer({ sc }: { sc: ReturnType<typeof useSCData> }) {
  const [content, setContent] = useState("");
  const [targetKeyword, setTargetKeyword] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const scContext = sc.queries.length > 0
    ? `\n\nREAL SEARCH CONSOLE DATA for context:\nTop keywords: ${sc.queries.slice(0, 10).map((r) => `"${r.keys[0]}"`).join(", ")}\n\nConsider these real keywords when suggesting internal linking and keyword optimization opportunities.`
    : "";

  const handleOptimize = async () => {
    if (!content.trim()) return;
    setOutput("");
    setIsStreaming(true);

    const fullPrompt = `Analyze the following content for SEO optimization${targetKeyword ? ` targeting the keyword "${targetKeyword}"` : ""}.

Content to analyze:
---
${content}
---
${scContext}
Provide a detailed SEO audit with:

1. **Overall SEO Score** - Rate 1-10 with brief justification
2. **Heading Structure** - Are H1/H2/H3 tags used properly? Suggest improvements
3. **Keyword Optimization** - ${targetKeyword ? `How well is "${targetKeyword}" integrated? Suggest natural placements` : "Identify the apparent target keyword and suggest optimization"}
4. **Keyword Density** - Current estimate and recommended adjustments
5. **Content Length** - Is it sufficient for ranking? Suggest ideal word count
6. **Internal Linking Opportunities** - Suggest where plotwell pages could be linked
7. **Readability** - Sentence length, paragraph structure, scanability
8. **Missing Elements** - Meta description suggestion, image alt text ideas, schema markup recommendations
9. **Quick Wins** - Top 3 changes that would have the biggest SEO impact

Be specific with suggestions and provide example rewrites where helpful.`;

    let result = "";
    try {
      for await (const chunk of stream(fullPrompt, { system: SEO_SYSTEM, maxTokens: 4096 })) {
        result += chunk;
        setOutput(result);
      }
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Target Keyword (optional)</label>
          <input type="text" value={targetKeyword} onChange={(e) => setTargetKeyword(e.target.value)}
            placeholder="e.g., screenplay formatting" disabled={isStreaming}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Content to Optimize</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your blog post, landing page copy, or any content you want to optimize for SEO..." rows={8} disabled={isStreaming}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 resize-none" />
          <div className="mt-1 text-xs text-gray-400">
            {content.trim().split(/\s+/).filter(Boolean).length} words
          </div>
        </div>
        <button onClick={handleOptimize} disabled={isStreaming || !content.trim()}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors">
          {isStreaming ? "Analyzing..." : "Optimize"}
        </button>
      </div>

      {(output || isStreaming) && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">SEO Analysis & Recommendations</h3>
            {output && !isStreaming && <CopyButton text={output} />}
          </div>
          <StreamingOutput content={output} isStreaming={isStreaming} className="max-h-[32rem]" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page Auditor                                                       */
/* ------------------------------------------------------------------ */

interface AuditResult {
  url: string;
  score: number;
  title: string;
  description: string;
  h1s: string[];
  h2Count: number;
  images: { total: number; missingAlt: number };
  links: { internal: number; external: number };
  htmlSize: number;
  scripts: number;
  stylesheets: number;
  jsonLd: number;
  hasViewport: boolean;
  hasCanonical: boolean;
  isHttps: boolean;
  hasLang: boolean;
  wordCount: number;
  issues: { type: "error" | "warning" | "ok"; message: string }[];
}

function auditPage(url: string, html: string): AuditResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const issues: AuditResult["issues"] = [];
  let score = 100;

  const title = doc.querySelector("title")?.textContent || doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content") || doc.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
  const h1s = Array.from(doc.querySelectorAll("h1")).map((el) => el.textContent?.trim() || "");
  const h2Count = doc.querySelectorAll("h2").length;
  const imgs = Array.from(doc.querySelectorAll("img"));
  const missingAlt = imgs.filter((i) => !i.getAttribute("alt")).length;

  const allLinks = Array.from(doc.querySelectorAll("a[href]"));
  const domain = new URL(url).hostname;
  let internal = 0, external = 0;
  for (const link of allLinks) {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("/") || href.includes(domain)) internal++;
    else if (href.startsWith("http")) external++;
  }

  // Checks
  if (!title) { issues.push({ type: "error", message: "Missing page title" }); score -= 15; }
  else if (title.length > 60) { issues.push({ type: "warning", message: `Title too long (${title.length}/60)` }); score -= 5; }
  else { issues.push({ type: "ok", message: `Title OK (${title.length}/60)` }); }

  if (!description) { issues.push({ type: "error", message: "Missing meta description" }); score -= 15; }
  else if (description.length > 160) { issues.push({ type: "warning", message: `Description too long (${description.length}/160)` }); score -= 5; }
  else { issues.push({ type: "ok", message: `Description OK (${description.length}/160)` }); }

  if (h1s.length === 0) { issues.push({ type: "error", message: "Missing H1" }); score -= 10; }
  else if (h1s.length > 1) { issues.push({ type: "warning", message: `Multiple H1s (${h1s.length})` }); score -= 5; }
  else { issues.push({ type: "ok", message: "Single H1 found" }); }

  if (missingAlt > 0) { issues.push({ type: "warning", message: `${missingAlt}/${imgs.length} images missing alt text` }); score -= Math.min(missingAlt * 2, 10); }
  else if (imgs.length > 0) { issues.push({ type: "ok", message: `All ${imgs.length} images have alt text` }); }

  const hasViewport = !!doc.querySelector('meta[name="viewport"]');
  if (!hasViewport) { issues.push({ type: "error", message: "Missing viewport meta" }); score -= 10; }
  else { issues.push({ type: "ok", message: "Viewport meta present" }); }

  const hasCanonical = !!doc.querySelector('link[rel="canonical"]');
  if (!hasCanonical) { issues.push({ type: "warning", message: "Missing canonical URL" }); score -= 5; }
  else { issues.push({ type: "ok", message: "Canonical URL present" }); }

  const hasLang = !!doc.documentElement.getAttribute("lang");
  if (!hasLang) { issues.push({ type: "warning", message: "Missing lang attribute" }); score -= 3; }
  else { issues.push({ type: "ok", message: `lang="${doc.documentElement.getAttribute("lang")}"` }); }

  if (!doc.querySelector('meta[property="og:image"]')) { issues.push({ type: "warning", message: "Missing og:image" }); score -= 5; }
  else { issues.push({ type: "ok", message: "og:image present" }); }

  const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]').length;
  if (jsonLd === 0) { issues.push({ type: "warning", message: "No JSON-LD structured data" }); score -= 3; }
  else { issues.push({ type: "ok", message: `${jsonLd} JSON-LD block(s)` }); }

  const isHttps = url.startsWith("https://");
  if (!isHttps) { issues.push({ type: "error", message: "Not HTTPS" }); score -= 10; }
  else { issues.push({ type: "ok", message: "HTTPS enabled" }); }

  if (internal < 3) { issues.push({ type: "warning", message: `Low internal links (${internal})` }); score -= 5; }

  const bodyText = doc.body?.textContent || "";
  const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;

  return {
    url, score: Math.max(0, score), title, description, h1s, h2Count,
    images: { total: imgs.length, missingAlt },
    links: { internal, external },
    htmlSize: html.length,
    scripts: doc.querySelectorAll("script").length,
    stylesheets: doc.querySelectorAll('link[rel="stylesheet"]').length,
    jsonLd, hasViewport, hasCanonical, isHttps, hasLang, wordCount,
    issues: issues.sort((a, b) => { const o = { error: 0, warning: 1, ok: 2 }; return o[a.type] - o[b.type]; }),
  };
}

function PageAuditor() {
  const [url, setUrl] = useState("https://plotwell.co");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiOutput, setAiOutput] = useState("");
  const [isAiStreaming, setIsAiStreaming] = useState(false);

  const handleAudit = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setAiOutput("");
    try {
      const res = await fetch(url);
      const html = await res.text();
      setResult(auditPage(url, html));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch. The page may block cross-origin requests.");
    }
    setLoading(false);
  };

  const handleAiRecommendations = async () => {
    if (!result) return;
    setIsAiStreaming(true);
    setAiOutput("");
    const issuesSummary = result.issues.map((i) => `[${i.type}] ${i.message}`).join("\n");
    const prompt = `Analyze this page audit for ${result.url} and give specific, actionable SEO improvement recommendations.

Score: ${result.score}/100
Title: "${result.title}" (${result.title.length} chars)
Description: "${result.description}" (${result.description.length} chars)
H1s: ${result.h1s.join(", ") || "none"}
Word count: ${result.wordCount}
Images: ${result.images.total} (${result.images.missingAlt} missing alt)
Links: ${result.links.internal} internal, ${result.links.external} external
JSON-LD: ${result.jsonLd} blocks

Issues:\n${issuesSummary}

Give 5-7 specific recommendations ranked by impact. For each, explain what to change and why.`;

    let text = "";
    try {
      for await (const chunk of stream(prompt, { system: SEO_SYSTEM, maxTokens: 2000 })) {
        text += chunk;
        setAiOutput(text);
      }
    } finally {
      setIsAiStreaming(false);
    }
  };

  const scoreColor = result ? (result.score >= 80 ? "text-green-600" : result.score >= 60 ? "text-amber-600" : "text-red-600") : "";
  const issueColors = { error: "bg-red-100 text-red-600 border-red-200", warning: "bg-amber-100 text-amber-600 border-amber-200", ok: "bg-green-100 text-green-600 border-green-200" };
  const issueIcons = { error: "X", warning: "!", ok: "O" };

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://plotwell.co"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          onKeyDown={(e) => e.key === "Enter" && handleAudit()} />
        <button onClick={handleAudit} disabled={loading || !url.trim()}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors">
          {loading ? "Auditing..." : "Audit"}
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {result && (
        <>
          {/* Score + SERP */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5 text-center">
              <p className="text-xs font-medium text-gray-500 uppercase">SEO Score</p>
              <p className={`text-5xl font-bold mt-2 ${scoreColor}`}>{result.score}</p>
              <p className="text-xs text-gray-400 mt-1">out of 100</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">SERP Preview</h3>
              <div className="rounded-lg border border-gray-100 p-3">
                <p className="text-xs text-green-700 truncate">{result.url}</p>
                <p className="text-blue-800 text-base font-medium mt-0.5 truncate">{result.title || "No title"}</p>
                <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">{result.description || "No description"}</p>
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xs text-gray-500">Words</p>
              <p className="text-lg font-bold text-gray-700">{result.wordCount.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xs text-gray-500">Images</p>
              <p className="text-lg font-bold text-gray-700">{result.images.total}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xs text-gray-500">Internal Links</p>
              <p className="text-lg font-bold text-gray-700">{result.links.internal}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xs text-gray-500">HTML Size</p>
              <p className="text-lg font-bold text-gray-700">{(result.htmlSize / 1024).toFixed(0)}KB</p>
            </div>
          </div>

          {/* Issues */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Checks ({result.issues.filter((i) => i.type === "ok").length}/{result.issues.length} passed)
            </h3>
            <div className="space-y-1.5">
              {result.issues.map((issue, i) => (
                <div key={i} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 ${issueColors[issue.type]}`}>
                  <span className="w-4 h-4 rounded-full border text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {issueIcons[issue.type]}
                  </span>
                  <span className="text-xs">{issue.message}</span>
                </div>
              ))}
            </div>
          </div>

          {/* AI Recommendations */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">AI Recommendations</h3>
              <button onClick={handleAiRecommendations} disabled={isAiStreaming}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors">
                {isAiStreaming ? "Analyzing..." : aiOutput ? "Re-analyze" : "Get Recommendations"}
              </button>
            </div>
            {(aiOutput || isAiStreaming) && (
              <StreamingOutput content={aiOutput} isStreaming={isAiStreaming} className="max-h-[400px]" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Schema Markup Generator                                            */
/* ------------------------------------------------------------------ */

type SchemaType = "website" | "article" | "product" | "faq" | "breadcrumb";

const SCHEMA_TEMPLATES: Record<SchemaType, { label: string; template: object }> = {
  website: {
    label: "Website",
    template: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "plotwell",
      url: "https://plotwell.co",
      description: "Professional screenplay editor and production planning platform",
      potentialAction: {
        "@type": "SearchAction",
        target: "https://plotwell.co/search?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    },
  },
  article: {
    label: "Blog Article",
    template: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Your Article Title",
      description: "Article description here",
      image: "https://plotwell.co/blog/cover.jpg",
      author: { "@type": "Organization", name: "plotwell" },
      publisher: {
        "@type": "Organization",
        name: "plotwell",
        logo: { "@type": "ImageObject", url: "https://plotwell.co/logo.png" },
      },
      datePublished: new Date().toISOString().split("T")[0],
      dateModified: new Date().toISOString().split("T")[0],
    },
  },
  product: {
    label: "SaaS Product",
    template: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "plotwell",
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Web",
      url: "https://plotwell.co",
      description: "AI-powered screenplay editor and production planning platform",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "EUR",
        description: "Free plan available",
      },
    },
  },
  faq: {
    label: "FAQ",
    template: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is plotwell?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "plotwell is a professional screenplay editor and production planning platform with AI-powered writing assistance.",
          },
        },
        {
          "@type": "Question",
          name: "Is plotwell free?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "plotwell offers a free plan with 1 project and 50 AI credits. Pro plan is 15 EUR/month.",
          },
        },
      ],
    },
  },
  breadcrumb: {
    label: "Breadcrumb",
    template: {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://plotwell.co" },
        { "@type": "ListItem", position: 2, name: "Blog", item: "https://plotwell.co/blog" },
        { "@type": "ListItem", position: 3, name: "Article Title", item: "https://plotwell.co/blog/article-slug" },
      ],
    },
  },
};

function SchemaGenerator() {
  const [schemaType, setSchemaType] = useState<SchemaType>("website");
  const [json, setJson] = useState(JSON.stringify(SCHEMA_TEMPLATES.website.template, null, 2));
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const handleTypeChange = (type: SchemaType) => {
    setSchemaType(type);
    setJson(JSON.stringify(SCHEMA_TEMPLATES[type].template, null, 2));
    setValidationErrors([]);
  };

  const validate = () => {
    const errors: string[] = [];
    try {
      const parsed = JSON.parse(json);
      if (!parsed["@context"]) errors.push('Missing "@context" field');
      if (!parsed["@type"]) errors.push('Missing "@type" field');
      if (parsed["@type"] === "Article") {
        if (!parsed.headline) errors.push("Article: missing headline");
        if (!parsed.author) errors.push("Article: missing author");
        if (!parsed.datePublished) errors.push("Article: missing datePublished");
      }
      if (parsed["@type"] === "FAQPage") {
        if (!parsed.mainEntity?.length) errors.push("FAQ: missing mainEntity questions");
      }
      if (errors.length === 0) errors.push("Valid JSON-LD structure");
    } catch {
      errors.push("Invalid JSON syntax");
    }
    setValidationErrors(errors);
  };

  const copyToClipboard = () => {
    const script = `<script type="application/ld+json">\n${json}\n</script>`;
    navigator.clipboard.writeText(script);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {(Object.entries(SCHEMA_TEMPLATES) as [SchemaType, { label: string }][]).map(([key, { label }]) => (
          <button key={key} onClick={() => handleTypeChange(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              schemaType === key
                ? "bg-amber-100 text-amber-700 border border-amber-300"
                : "bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200"
            }`}>
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">JSON-LD Markup</h3>
          <div className="flex gap-2">
            <button onClick={validate} className="rounded-md bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors">Validate</button>
            <button onClick={copyToClipboard} className="rounded-md bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">
              {copied ? "Copied!" : "Copy as <script>"}
            </button>
          </div>
        </div>
        <textarea value={json} onChange={(e) => { setJson(e.target.value); setValidationErrors([]); }}
          rows={16} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono bg-gray-50 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-y" spellCheck={false} />
      </div>

      {validationErrors.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Validation</h3>
          <div className="space-y-1">
            {validationErrors.map((err, i) => (
              <div key={i} className={`text-xs px-2 py-1 rounded ${
                err === "Valid JSON-LD structure" ? "bg-green-50 text-green-700"
                : err === "Invalid JSON syntax" ? "bg-red-50 text-red-700"
                : "bg-amber-50 text-amber-700"
              }`}>{err}</div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">HTML Output</h3>
        <pre className="text-xs font-mono bg-gray-50 rounded-lg p-3 overflow-x-auto text-gray-600">
          {`<script type="application/ld+json">\n${json}\n</script>`}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Organic Backlink Builder                                           */
/* ------------------------------------------------------------------ */

type BacklinkChannel = "comment" | "resource" | "community" | "mention";
type BacklinkStatus = "idea" | "ready" | "contacted" | "won" | "skip";

type BacklinkProspect = {
  id: string;
  title: string;
  url: string;
  channel: BacklinkChannel;
  angle: string;
  status: BacklinkStatus;
  relevance: number;
  effort: number;
  lastAction?: string;
};

const BACKLINK_STORAGE_KEY = "plotwell.organicBacklinkProspects.v1";

const starterProspects: BacklinkProspect[] = [
  {
    id: "starter-reddit-writing",
    title: "Reddit writing questions",
    url: "https://www.reddit.com/search/?q=novel%20outline%20tool",
    channel: "community",
    angle: "Answer outline and structure questions with a complete mini-workflow before mentioning Plotwell.",
    status: "idea",
    relevance: 5,
    effort: 2,
  },
  {
    id: "starter-resource-pages",
    title: "Writing resource pages",
    url: "https://www.google.com/search?q=writing+resources+novel+planning+tools",
    channel: "resource",
    angle: "Suggest Plotwell only to pages that already list writing or planning tools.",
    status: "idea",
    relevance: 5,
    effort: 3,
  },
  {
    id: "starter-blog-comments",
    title: "Story structure blog comments",
    url: "https://www.google.com/search?q=story+structure+blog+comments",
    channel: "comment",
    angle: "Leave useful comments on posts where a practical plotting workflow improves the discussion.",
    status: "idea",
    relevance: 4,
    effort: 1,
  },
  {
    id: "starter-unlinked",
    title: "Unlinked Plotwell mentions",
    url: "https://www.google.com/search?q=%22Plotwell%22+-site%3Aplotwell.co",
    channel: "mention",
    angle: "Ask for attribution links when someone already mentions Plotwell.",
    status: "idea",
    relevance: 5,
    effort: 2,
  },
];

const channelLabels: Record<BacklinkChannel, string> = {
  comment: "Comment",
  resource: "Resource page",
  community: "Community",
  mention: "Mention",
};

const statusLabels: Record<BacklinkStatus, string> = {
  idea: "Idea",
  ready: "Ready",
  contacted: "Contacted",
  won: "Won",
  skip: "Skip",
};

function getBacklinkScore(prospect: BacklinkProspect) {
  return prospect.relevance * 2 + (6 - prospect.effort);
}

function buildOutreachDraft(prospect: BacklinkProspect) {
  const target = prospect.title || "this page";
  const link = "https://plotwell.co";

  if (prospect.channel === "comment") {
    return `Really useful post. One thing that helped me with this problem is separating the plot work into three passes: first the character goal, then the scene conflict, then the reveal or change in each scene.\n\nIf it helps anyone here, I am building Plotwell around that workflow: ${link}\n\nNo pressure, just sharing because it fits the topic.`;
  }

  if (prospect.channel === "community") {
    return `I would start by outlining the story as decisions rather than chapters: what does the character want, what blocks them, and what changes after each scene?\n\nA simple structure I use:\n1. Goal\n2. Conflict\n3. Choice\n4. Consequence\n\nI am building Plotwell for this kind of planning, so it may help if you want a dedicated workspace: ${link}`;
  }

  if (prospect.channel === "mention") {
    return `Hey,\n\nThanks for mentioning Plotwell on ${target}. Would you be open to linking the mention to ${link}? It would help readers find the tool directly.\n\nEither way, appreciate the mention.`;
  }

  return `Hey,\n\nI found ${target} while looking through writing resources.\n\nI am building Plotwell, a story planning and screenplay workflow tool for writers. It may be a useful addition if you think it fits your readers: ${link}\n\nA good fit would be anywhere you list outlining, plotting, or screenplay tools.\n\nThanks for taking a look.`;
}

function OrganicBacklinks() {
  const [prospects, setProspects] = useState<BacklinkProspect[]>(() => {
    try {
      const stored = window.localStorage.getItem(BACKLINK_STORAGE_KEY);
      return stored ? JSON.parse(stored) : starterProspects;
    } catch {
      return starterProspects;
    }
  });
  const [selectedId, setSelectedId] = useState(prospects[0]?.id ?? "");
  const [newTitle, setNewTitle] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newChannel, setNewChannel] = useState<BacklinkChannel>("comment");
  const [newAngle, setNewAngle] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(BACKLINK_STORAGE_KEY, JSON.stringify(prospects));
  }, [prospects]);

  useEffect(() => {
    if (!prospects.some((prospect) => prospect.id === selectedId)) {
      setSelectedId(prospects[0]?.id ?? "");
    }
  }, [prospects, selectedId]);

  const sortedProspects = useMemo(
    () => [...prospects].sort((a, b) => getBacklinkScore(b) - getBacklinkScore(a)),
    [prospects]
  );
  const selected = sortedProspects.find((prospect) => prospect.id === selectedId) ?? sortedProspects[0];
  const draft = selected ? buildOutreachDraft(selected) : "";
  const todaysQueue = sortedProspects
    .filter((prospect) => prospect.status === "idea" || prospect.status === "ready")
    .slice(0, 5);
  const wins = prospects.filter((prospect) => prospect.status === "won").length;
  const contacted = prospects.filter((prospect) => prospect.status === "contacted").length;

  const addProspect = () => {
    if (!newTitle.trim()) return;
    const prospect: BacklinkProspect = {
      id: crypto.randomUUID(),
      title: newTitle.trim(),
      url: newUrl.trim(),
      channel: newChannel,
      angle: newAngle.trim() || "Be useful first; link only when it genuinely helps the reader.",
      status: "idea",
      relevance: 4,
      effort: newChannel === "comment" ? 1 : 2,
    };
    setProspects((current) => [prospect, ...current]);
    setSelectedId(prospect.id);
    setNewTitle("");
    setNewUrl("");
    setNewAngle("");
  };

  const updateProspect = (id: string, patch: Partial<BacklinkProspect>) => {
    setProspects((current) =>
      current.map((prospect) =>
        prospect.id === id
          ? {
              ...prospect,
              ...patch,
              lastAction: patch.status ? new Date().toISOString().slice(0, 10) : prospect.lastAction,
            }
          : prospect
      )
    );
  };

  const copyDraft = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-bold text-gray-900">Organic backlink loop</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              A lightweight system for helpful comments, community answers, resource-page suggestions, and unlinked mention requests.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-emerald-200 bg-white px-4 py-2">
              <p className="text-lg font-bold text-emerald-700">{todaysQueue.length}</p>
              <p className="text-[11px] text-gray-500">today</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-white px-4 py-2">
              <p className="text-lg font-bold text-blue-700">{contacted}</p>
              <p className="text-[11px] text-gray-500">sent</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-white px-4 py-2">
              <p className="text-lg font-bold text-amber-700">{wins}</p>
              <p className="text-[11px] text-gray-500">won</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-700">Add an opportunity</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="Page, thread, community, or site"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <input
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="URL"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <select
                value={newChannel}
                onChange={(event) => setNewChannel(event.target.value as BacklinkChannel)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {Object.entries(channelLabels).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>
            <textarea
              value={newAngle}
              onChange={(event) => setNewAngle(event.target.value)}
              placeholder="Why this is relevant, or what useful thing you can say there"
              rows={2}
              className="mt-3 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <button
              onClick={addProspect}
              className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
              disabled={!newTitle.trim()}
            >
              Add
            </button>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">Today&apos;s queue</h3>
              <p className="text-xs text-gray-500">Aim for 3 comments and 2 suggestions.</p>
            </div>
            <div className="mt-3 space-y-2">
              {todaysQueue.map((prospect) => (
                <button
                  key={prospect.id}
                  onClick={() => setSelectedId(prospect.id)}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                    selected?.id === prospect.id
                      ? "border-amber-300 bg-amber-50"
                      : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{prospect.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-gray-500">{prospect.angle}</p>
                    </div>
                    <span className="rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
                      {channelLabels[prospect.channel]}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {selected && (
            <>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-800">{selected.title}</h3>
                    {selected.url && (
                      <a href={selected.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-blue-600 hover:underline">
                        {selected.url}
                      </a>
                    )}
                  </div>
                  <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                    Score {getBacklinkScore(selected)}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="text-xs font-medium text-gray-500">
                    Relevance
                    <input
                      type="range"
                      min="1"
                      max="5"
                      value={selected.relevance}
                      onChange={(event) => updateProspect(selected.id, { relevance: Number(event.target.value) })}
                      className="mt-2 w-full"
                    />
                  </label>
                  <label className="text-xs font-medium text-gray-500">
                    Effort
                    <input
                      type="range"
                      min="1"
                      max="5"
                      value={selected.effort}
                      onChange={(event) => updateProspect(selected.id, { effort: Number(event.target.value) })}
                      className="mt-2 w-full"
                    />
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {(Object.keys(statusLabels) as BacklinkStatus[]).map((status) => (
                    <button
                      key={status}
                      onClick={() => updateProspect(selected.id, { status })}
                      className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                        selected.status === status
                          ? "border-amber-300 bg-amber-100 text-amber-700"
                          : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {statusLabels[status]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">Natural draft</h3>
                  <button onClick={copyDraft} className="rounded-md bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100">
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <textarea
                  value={draft}
                  readOnly
                  rows={10}
                  className="w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-700"
                />
                <p className="mt-2 text-xs text-gray-500">
                  Edit before posting. The link should feel optional and useful, never like the point of the comment.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main App                                                           */
/* ------------------------------------------------------------------ */

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "data", label: "Real Data", icon: "📊" },
  { id: "meta", label: "Meta Tags", icon: "🏷️" },
  { id: "keywords", label: "Keywords", icon: "🔑" },
  { id: "optimizer", label: "Optimizer", icon: "⚡" },
  { id: "schema", label: "Schema", icon: "{ }" },
  { id: "auditor", label: "Auditor", icon: "🔬" },
  { id: "backlinks", label: "Backlinks", icon: "->" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("data");
  const sc = useSCData();
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotStep, setAutopilotStep] = useState("");
  const [autopilotResult, setAutopilotResult] = useState<string | null>(null);

  // Auto-load SC data on mount if connected
  useEffect(() => {
    const token = getStoredToken();
    if (token && isConfigured()) {
      sc.load();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAutopilot = useCallback(async () => {
    if (autopilotRunning) return;
    setAutopilotRunning(true);
    setAutopilotResult(null);

    try {
      setAutopilotStep("Analyzing SEO landscape...");
      const posts = getExistingPostsSummary();
      const features = PLOTWELL_FEATURES.slice(0, 8).join(", ");

      // If SC data is loaded, include it
      let scContext = "";
      if (sc.queries.length > 0) {
        const topKw = sc.queries.slice(0, 15).map((k) => `${k.keys[0]} (pos: ${k.position?.toFixed(1)}, clicks: ${k.clicks})`).join(", ");
        scContext = `\nSearch Console top keywords: ${topKw}`;
      }

      const result = await generate(
        `Full SEO audit for plotwell (screenplay editor platform).
Features: ${features}
Existing blog posts:\n${posts}${scContext}

Provide a concise, actionable SEO report:
1. **Quick wins**: keywords we almost rank for (positions 4-20) that need content optimization
2. **Content gaps**: high-value topics we should write about (that we haven't covered)
3. **On-page issues**: meta descriptions, title tags, internal linking recommendations for existing posts
4. **New keyword targets**: 5 keyword phrases we should target with new content
5. **Competitor keywords**: terms competitors (Final Draft, Celtx, WriterSolo, Arc Studio) rank for that we don't

Be specific and actionable. Use bullet points.`,
        { system: SEO_SYSTEM, maxTokens: 3000, temperature: 0.5 }
      );

      setAutopilotResult(result);
      saveToHistory({ source: "seo", title: `SEO Audit ${new Date().toLocaleDateString()}`, content: result });

      // Auto-download
      const blob = new Blob([`# SEO Audit - ${new Date().toLocaleDateString()}\n\nGenerated: ${new Date().toISOString()}\n\n${result}`], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seo_audit_${new Date().toISOString().slice(0,10)}.md`;
      a.click();
      URL.revokeObjectURL(url);

      setAutopilotStep("Done! SEO audit saved.");
    } catch (err) {
      setAutopilotStep(`Error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setAutopilotRunning(false);
    }
  }, [autopilotRunning, sc.queries]);

  return (
    <ToolPage
      title="SEO Tools"
      description="Real keyword data, meta tag generation, content optimization, and schema markup."
    >
      {/* AUTOPILOT */}
      {!autopilotRunning && !autopilotResult && !autopilotStep && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-gray-900">Autopilot</h3>
              <p className="text-sm text-gray-600 mt-0.5">AI analyzes your SEO, finds gaps, and gives actionable recommendations.</p>
              <p className="text-[11px] text-gray-400 mt-1">Est. cost: {formatCost(estimateCosts({ textGenerations: 1 }).total)}</p>
            </div>
            <button onClick={handleAutopilot}
              className="rounded-xl bg-amber-600 px-8 py-3 text-sm font-bold text-white hover:bg-amber-700 shadow-md hover:shadow-lg transition-all">
              Run SEO Audit
            </button>
          </div>
        </div>
      )}

      {autopilotRunning && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-sm font-semibold text-amber-800">{autopilotStep}</p>
          </div>
        </div>
      )}

      {!autopilotRunning && autopilotStep && !autopilotResult && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-5 space-y-3">
          <p className="text-sm text-red-700">{autopilotStep}</p>
          <button onClick={() => { setAutopilotStep(""); setAutopilotResult(null); }}
            className="text-xs text-red-600 hover:text-red-800 font-medium">Try again</button>
        </div>
      )}

      {autopilotResult && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">SEO Audit Report</h3>
            <button onClick={() => { setAutopilotResult(null); setAutopilotStep(""); }}
              className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
          </div>
          <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-4 max-h-[500px] overflow-y-auto">
            {autopilotResult}
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === tab.id
                ? "bg-white text-amber-700 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            <span className="text-xs">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "data" && <RealDataTab sc={sc} />}
      {activeTab === "meta" && <MetaGenerator sc={sc} />}
      {activeTab === "keywords" && <KeywordIdeas sc={sc} />}
      {activeTab === "optimizer" && <ContentOptimizer sc={sc} />}
      {activeTab === "schema" && <SchemaGenerator />}
      {activeTab === "auditor" && <PageAuditor />}
      {activeTab === "backlinks" && <OrganicBacklinks />}
    </ToolPage>
  );
}
