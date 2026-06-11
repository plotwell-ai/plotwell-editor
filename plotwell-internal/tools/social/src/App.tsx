import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { generate, stream, startVideoGeneration, pollVideoJob, generateVoiceover, VIDEO_MODEL_INFO, estimateCosts, formatCost, type VideoJob, type VideoOptions, type VideoModel } from "@shared/ai-client";
import { SOCIAL_SYSTEM } from "@shared/prompts";
import { ToolPage, CopyButton } from "@shared/components";
import { CONTENT_GAPS, PLOTWELL_FEATURES, getExistingPostsSummary } from "@shared/content";
import { getProductContextShort } from "@shared/product-context";
import { addToCalendar, hasItemToday, consumePrefill } from "@shared/calendar-bridge";
import { saveToHistory } from "@shared/history";

type Platform = "tiktok" | "instagram" | "x" | "linkedin";

interface PlatformConfig {
  label: string;
  icon: string;
  sections: string[];
  charLimits: Record<string, number>;
  promptInstruction: string;
}

const PLATFORMS: Record<Platform, PlatformConfig> = {
  tiktok: {
    label: "TikTok",
    icon: "🎵",
    sections: ["Hook / Script", "Caption", "Hashtags"],
    charLimits: {
      "Caption": 2200,
      "Hashtags": 100,
    },
    promptInstruction: `Generate TikTok content with these sections clearly labeled:

## Hook / Script
A compelling hook idea and short video script outline (attention-grabbing first 3 seconds, main content beats, CTA).

## Caption
An engaging caption (max 2200 characters) with emojis and a CTA.

## Hashtags
Relevant hashtags (aim for a mix of trending and niche, max 100 characters total).`,
  },
  instagram: {
    label: "Instagram",
    icon: "📸",
    sections: ["Caption", "Carousel Ideas", "Reels Script", "Hashtags"],
    charLimits: {
      "Caption": 2200,
      "Hashtags": 100,
    },
    promptInstruction: `Generate Instagram content with these sections clearly labeled:

## Caption
An engaging Instagram caption (max 2200 characters) with line breaks, emojis, and a CTA.

## Carousel Ideas
5-10 slide ideas for a carousel post, each slide summarized in one sentence.

## Reels Script
A short Reels video script outline (hook, main points, CTA) under 90 seconds.

## Hashtags
30 relevant hashtags (mix of popular, niche, and branded), max 100 characters per group.`,
  },
  x: {
    label: "X / Twitter",
    icon: "𝕏",
    sections: ["Tweet Thread", "Single Tweet"],
    charLimits: {
      "Single Tweet": 280,
    },
    promptInstruction: `Generate X/Twitter content with these sections clearly labeled:

## Tweet Thread
A compelling thread of 4-8 tweets. Number each tweet (1/, 2/, etc.). Each tweet must be under 280 characters. Start with a strong hook tweet.

## Single Tweet
3 standalone tweet variations (each under 280 characters) that can work independently. Include a CTA where appropriate.`,
  },
  linkedin: {
    label: "LinkedIn",
    icon: "💼",
    sections: ["Post", "Article Summary"],
    charLimits: {
      "Post": 3000,
    },
    promptInstruction: `Generate LinkedIn content with these sections clearly labeled:

## Post
A professional LinkedIn post (max 3000 characters) with a strong hook first line, clear formatting with line breaks, relevant insights, and a CTA or question to drive engagement.

## Article Summary
A brief article summary (3-4 paragraphs) that could serve as a LinkedIn article or newsletter excerpt. Professional tone, actionable takeaways.`,
  },
};

function sectionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches: ## Name, **## Name**, **## Name **, ### Name, etc.
  // Tolerates optional bold markers, extra #, trailing **, and ---
  return new RegExp(`(?:^|\\n)(?:---\\s*\\n)?\\**\\s*#{2,3}\\s*${escaped}\\s*\\**\\s*\\n`, "i");
}

function parseSections(content: string, sectionNames: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < sectionNames.length; i++) {
    const name = sectionNames[i];
    const match = content.match(sectionPattern(name));
    if (match && match.index !== undefined) {
      const start = match.index + match[0].length;
      let end = content.length;
      for (let j = 0; j < sectionNames.length; j++) {
        if (j === i) continue;
        const nextMatch = content.substring(start).match(sectionPattern(sectionNames[j]));
        if (nextMatch && nextMatch.index !== undefined) {
          const candidateEnd = start + nextMatch.index;
          if (candidateEnd < end) end = candidateEnd;
        }
      }
      result[name] = content.substring(start, end).trim();
    }
  }
  return result;
}

function CharCount({ text, limit }: { text: string; limit: number }) {
  const count = text.length;
  const ratio = count / limit;
  const color =
    ratio > 1
      ? "text-red-600"
      : ratio > 0.9
        ? "text-amber-600"
        : "text-gray-400";

  return (
    <span className={`text-xs font-medium ${color}`}>
      {count} / {limit}
    </span>
  );
}

function SocialSuggestions({
  platform,
  onPick,
  onPickAndGenerate,
}: {
  platform: Platform;
  onPick: (brief: string) => void;
  onPickAndGenerate: (brief: string) => void;
}) {
  const [aiIdeas, setAiIdeas] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Filter pre-built suggestions for current platform
  const prebuilt = CONTENT_GAPS.social.filter((s) => s.platform === platform);

  const handleAISuggest = async () => {
    setLoading(true);
    try {
      const platformLabel = PLATFORMS[platform].label;
      const features = PLOTWELL_FEATURES.slice(0, 8).join("\n- ");
      const result = await generate(
        `Generate 5 creative ${platformLabel} content briefs for plotwell (screenplay editor platform).\n\nKey features:\n- ${features}\n\nEach brief should be a single sentence describing the content idea, optimized for ${platformLabel}. Make them engaging, specific, and ready to generate content from.\n\nReturn ONLY a JSON array of strings. No explanation.`,
        { system: "You are a social media strategist for a screenplay/filmmaking SaaS.", maxTokens: 800, temperature: 1.0 }
      );
      const match = result.match(/\[[\s\S]*\]/);
      if (match) setAiIdeas(JSON.parse(match[0]));
    } catch { /* ignore */ }
    setLoading(false);
  };

  const allSuggestions = [
    ...aiIdeas.map((brief) => ({ brief, isAI: true })),
    ...prebuilt.map((s) => ({ brief: s.brief, isAI: false })),
  ];

  if (allSuggestions.length === 0 && !loading) {
    return (
      <div className="mb-4">
        <button
          onClick={handleAISuggest}
          className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 px-4 py-3 text-sm text-amber-700 hover:bg-amber-50 transition-colors w-full"
        >
          Generate brief ideas for {PLATFORMS[platform].label}...
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-amber-800">Quick Briefs</h3>
        <button
          onClick={handleAISuggest}
          disabled={loading}
          className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Thinking..." : "More Ideas"}
        </button>
      </div>
      <div className="space-y-1.5">
        {allSuggestions.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 group">
            <button
              onClick={() => onPick(s.brief)}
              className="flex-1 text-left rounded-md border border-amber-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:border-amber-400 hover:bg-amber-50 transition-colors"
            >
              {s.isAI && <span className="text-amber-500 mr-1">AI</span>}
              {s.brief}
            </button>
            <button
              onClick={() => onPickAndGenerate(s.brief)}
              className="shrink-0 rounded-md bg-amber-600 px-2 py-1.5 text-xs font-medium text-white opacity-0 group-hover:opacity-100 hover:bg-amber-700 transition-all"
              title="Generate now"
            >
              Go
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type Lang = "en" | "es";

/* ------------------------------------------------------------------ */
/*  Platform Mockup Previews                                           */
/* ------------------------------------------------------------------ */

function PhoneFrame({ children, platform }: { children: ReactNode; platform: Platform }) {
  const bgColor = platform === "tiktok" ? "bg-black" : platform === "x" ? "bg-black" : "bg-white";
  return (
    <div className="mx-auto" style={{ width: 280 }}>
      <div className={`rounded-[2rem] border-[6px] border-gray-800 ${bgColor} overflow-hidden shadow-xl`}>
        {/* Status bar */}
        <div className={`flex items-center justify-between px-5 py-1.5 text-[10px] ${platform === "tiktok" || platform === "x" ? "text-white" : "text-black"}`}>
          <span>9:41</span>
          <div className="flex gap-1">
            <span>5G</span>
            <span>100%</span>
          </div>
        </div>
        <div style={{ minHeight: 400 }}>{children}</div>
      </div>
    </div>
  );
}

function PlatformMockup({ platform, sections }: { platform: Platform; sections: Record<string, string> }) {
  if (platform === "tiktok") {
    const script = sections["Hook / Script"] || "";
    const caption = sections["Caption"] || "";
    const hashtags = sections["Hashtags"] || "";
    return (
      <PhoneFrame platform="tiktok">
        <div className="relative bg-gradient-to-b from-gray-900 to-black p-4 text-white" style={{ minHeight: 400 }}>
          {/* Video area placeholder */}
          <div className="flex items-center justify-center h-48 rounded-lg bg-gray-800/50 mb-4">
            <span className="text-3xl">🎬</span>
          </div>
          {/* Right side icons */}
          <div className="absolute right-3 top-20 flex flex-col items-center gap-4 text-white">
            <div className="text-center"><div className="w-8 h-8 rounded-full bg-gray-600" /><span className="text-[9px]">12.5K</span></div>
            <div className="text-center"><span className="text-lg">💬</span><span className="text-[9px] block">234</span></div>
            <div className="text-center"><span className="text-lg">↗️</span><span className="text-[9px] block">Share</span></div>
          </div>
          {/* Caption area */}
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80">
            <p className="text-xs font-semibold mb-1">@plotwell</p>
            <p className="text-[11px] leading-tight line-clamp-3">{caption || script}</p>
            <p className="text-[10px] text-blue-300 mt-1 line-clamp-1">{hashtags}</p>
          </div>
        </div>
      </PhoneFrame>
    );
  }

  if (platform === "instagram") {
    const caption = sections["Caption"] || "";
    const hashtags = sections["Hashtags"] || "";
    return (
      <PhoneFrame platform="instagram">
        <div className="bg-white" style={{ minHeight: 400 }}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-400 to-pink-500" />
            <span className="text-xs font-semibold text-gray-900">plotwell</span>
          </div>
          {/* Image placeholder */}
          <div className="aspect-square bg-gradient-to-br from-amber-50 to-blue-50 flex items-center justify-center">
            <span className="text-4xl">📸</span>
          </div>
          {/* Actions */}
          <div className="flex gap-4 px-3 py-2 text-lg">
            <span>♡</span><span>💬</span><span>↗️</span>
            <span className="ml-auto">🔖</span>
          </div>
          {/* Caption */}
          <div className="px-3 pb-3">
            <p className="text-[11px] leading-tight"><span className="font-semibold">plotwell</span> {caption.slice(0, 150)}{caption.length > 150 ? "..." : ""}</p>
            <p className="text-[10px] text-blue-600 mt-1 line-clamp-1">{hashtags}</p>
          </div>
        </div>
      </PhoneFrame>
    );
  }

  if (platform === "x") {
    const thread = sections["Tweet Thread"] || sections["Single Tweet"] || "";
    const firstTweet = thread.split(/\d+\//).filter(Boolean)[0] || thread.slice(0, 280);
    return (
      <PhoneFrame platform="x">
        <div className="bg-black text-white p-4" style={{ minHeight: 400 }}>
          {/* Header */}
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-full bg-amber-600" />
            <div>
              <p className="text-xs font-bold">plotwell</p>
              <p className="text-[10px] text-gray-500">@plotwell_app</p>
            </div>
          </div>
          {/* Tweet */}
          <p className="text-[13px] leading-relaxed mb-3">{firstTweet.trim().slice(0, 280)}</p>
          {/* Engagement */}
          <div className="flex gap-6 text-[10px] text-gray-500 border-t border-gray-800 pt-2">
            <span>💬 42</span>
            <span>🔁 128</span>
            <span>♡ 1.2K</span>
            <span>📊 15K</span>
          </div>
        </div>
      </PhoneFrame>
    );
  }

  // LinkedIn
  const post = sections["Post"] || sections["Article Summary"] || "";
  return (
    <PhoneFrame platform="linkedin">
      <div className="bg-white" style={{ minHeight: 400 }}>
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-100">
          <div className="w-9 h-9 rounded-full bg-amber-600 flex items-center justify-center text-white text-xs font-bold">pw</div>
          <div>
            <p className="text-xs font-semibold text-gray-900">plotwell</p>
            <p className="text-[10px] text-gray-500">Professional screenplay editor</p>
          </div>
        </div>
        {/* Post */}
        <div className="px-3 py-3">
          <p className="text-[12px] leading-relaxed text-gray-800 line-clamp-[12]">{post.slice(0, 500)}</p>
        </div>
        {/* Engagement */}
        <div className="flex justify-between px-3 py-2 border-t border-gray-100 text-[10px] text-gray-500">
          <span>👍 Like</span>
          <span>💬 Comment</span>
          <span>🔁 Repost</span>
          <span>↗️ Send</span>
        </div>
      </div>
    </PhoneFrame>
  );
}

/* ------------------------------------------------------------------ */
/*  Main App                                                           */
/* ------------------------------------------------------------------ */

// ─────────────────────────────────────────────────────────────────────────────
//  STRATEGY — types, storage, component
// ─────────────────────────────────────────────────────────────────────────────

interface ContentPillar { id: string; name: string; description: string; emoji: string; }
interface StrategyData {
  audience: string;
  problem: string;
  tone: string;
  activePlatforms: Platform[];
  pillars: ContentPillar[];
  postingFrequency: string;
}

const STRATEGY_KEY = "social-strategy-v1";
const DEFAULT_STRATEGY: StrategyData = {
  audience: "",
  problem: "",
  tone: "",
  activePlatforms: ["tiktok", "x", "linkedin"],
  pillars: [
    { id: "p1", name: "Product updates",      description: "New features, improvements, behind-the-scenes building", emoji: "🚀" },
    { id: "p2", name: "Tips & education",      description: "Screenwriting tips, production planning advice",        emoji: "💡" },
    { id: "p3", name: "Social proof",          description: "User stories, testimonials, results",                  emoji: "⭐" },
    { id: "p4", name: "Founder journey",       description: "Building in public, lessons, decisions",              emoji: "🧭" },
    { id: "p5", name: "Industry commentary",   description: "Trends in AI, filmmaking, SaaS",                      emoji: "📣" },
  ],
  postingFrequency: "3x/week",
};

function loadStrategy(): StrategyData {
  try { const s = localStorage.getItem(STRATEGY_KEY); return s ? { ...DEFAULT_STRATEGY, ...JSON.parse(s) } : DEFAULT_STRATEGY; }
  catch { return DEFAULT_STRATEGY; }
}
function saveStrategy(s: StrategyData) {
  try { localStorage.setItem(STRATEGY_KEY, JSON.stringify(s)); } catch { /**/ }
}

function StrategyTab() {
  const [data, setData] = useState<StrategyData>(loadStrategy);
  const [saved, setSaved] = useState(true);

  const update = (patch: Partial<StrategyData>) => {
    setData(prev => { const next = { ...prev, ...patch }; saveStrategy(next); return next; });
    setSaved(true);
  };

  const togglePlatform = (p: Platform) => {
    const next = data.activePlatforms.includes(p)
      ? data.activePlatforms.filter(x => x !== p)
      : [...data.activePlatforms, p];
    update({ activePlatforms: next });
  };

  const updatePillar = (id: string, patch: Partial<ContentPillar>) => {
    update({ pillars: data.pillars.map(p => p.id === id ? { ...p, ...patch } : p) });
  };
  const addPillar = () => {
    update({ pillars: [...data.pillars, { id: crypto.randomUUID(), name: "New pillar", description: "", emoji: "📌" }] });
  };
  const removePillar = (id: string) => {
    update({ pillars: data.pillars.filter(p => p.id !== id) });
  };

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Audience */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">🎯 Audience</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Who are you talking to?</label>
            <input value={data.audience} onChange={e => update({ audience: e.target.value })}
              placeholder="Indie filmmakers, screenwriters, small production companies…"
              className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">What problem do they have?</label>
            <input value={data.problem} onChange={e => update({ problem: e.target.value })}
              placeholder="They waste time on formatting, admin, and logistics instead of writing…"
              className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tone of voice</label>
            <input value={data.tone} onChange={e => update({ tone: e.target.value })}
              placeholder="Direct, founder-y, no-fluff, knowledgeable but accessible…"
              className={inputCls} />
          </div>
        </div>
      </div>

      {/* Active platforms */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">📱 Active platforms</h3>
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(PLATFORMS) as Platform[]).map(p => (
            <button key={p} onClick={() => togglePlatform(p)}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${data.activePlatforms.includes(p) ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"}`}>
              <span>{PLATFORMS[p].icon}</span>{PLATFORMS[p].label}
            </button>
          ))}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Posting frequency</label>
          <select value={data.postingFrequency} onChange={e => update({ postingFrequency: e.target.value })}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none bg-white">
            {["Daily", "5x/week", "3x/week", "2x/week", "Weekly"].map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>

      {/* Content pillars */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">🏛 Content pillars</h3>
          <button onClick={addPillar} className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer">+ Add pillar</button>
        </div>
        <p className="text-xs text-gray-400">Every post should fit one of these. Limits what you post about — which is good.</p>
        <div className="space-y-2">
          {data.pillars.map(p => (
            <div key={p.id} className="flex items-start gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <input value={p.emoji} onChange={e => updatePillar(p.id, { emoji: e.target.value })}
                className="w-9 rounded border border-gray-200 px-1.5 py-1 text-center text-base focus:outline-none bg-white shrink-0" />
              <div className="flex-1 space-y-1.5">
                <input value={p.name} onChange={e => updatePillar(p.id, { name: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white" />
                <input value={p.description} onChange={e => updatePillar(p.id, { description: e.target.value })}
                  placeholder="What does this cover?"
                  className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white" />
              </div>
              <button onClick={() => removePillar(p.id)} className="shrink-0 text-gray-300 hover:text-red-400 cursor-pointer mt-0.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {saved && (
        <p className="text-xs text-green-600 font-medium px-1">✓ Strategy saved — auto-saved on every change</p>
      )}
    </div>
  );
}

type MainTab = "generate" | "strategy";

export default function App() {
  const [mainTab, setMainTab] = useState<MainTab>("generate");
  const [strategy] = useState<StrategyData>(loadStrategy);
  const [prefillData] = useState(() => consumePrefill());

  // Default platform to first active from strategy, or tiktok
  const defaultPlatform = (): Platform => {
    if (prefillData?.type === "social" && prefillData.platform) return prefillData.platform as Platform;
    if (strategy.activePlatforms.length > 0) return strategy.activePlatforms[0];
    return "tiktok";
  };
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [topic, setTopic] = useState(
    prefillData?.type === "social" ? prefillData.topic : ""
  );
  const [lang, setLang] = useState<Lang>("en");
  const [variations, setVariations] = useState<string[]>([]);
  const [activeVariation, setActiveVariation] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showMockup, setShowMockup] = useState(false);

  const config = PLATFORMS[platform];
  const output = variations[activeVariation] || "";
  const sections = parseSections(output, config.sections);

  const handleGenerate = useCallback(async () => {
    const trimmed = topic.trim();
    if (!trimmed || isGenerating) return;

    setIsGenerating(true);
    setVariations([]);
    setActiveVariation(0);
    setShowMockup(false);

    const langInstruction = lang === "es"
      ? "\n\nIMPORTANT: Write ALL content in Spanish. Use natural, professional Spanish (not translated-sounding). Keep section headers in English (## Caption, ## Hashtags, etc.) so they can be parsed correctly."
      : "";

    // Generate 3 variations
    const results: string[] = [];
    for (let v = 0; v < 3; v++) {
      const variationInstruction = v === 0
        ? ""
        : `\n\nThis is variation ${v + 1} of 3. Make it meaningfully different from the previous versions: different hook angle, different tone, different structure. Be creative.`;

      // Build strategy context block
      const strategyCtx = [
        strategy.audience  && `Target audience: ${strategy.audience}`,
        strategy.problem   && `Their problem: ${strategy.problem}`,
        strategy.tone      && `Tone of voice: ${strategy.tone}`,
        strategy.pillars.length > 0 && `Content pillars: ${strategy.pillars.map(p => `${p.emoji} ${p.name}`).join(", ")}`,
      ].filter(Boolean).join("\n");

      const prompt = `Topic/Brief: ${trimmed}

Platform: ${config.label}
${strategyCtx ? `\n${strategyCtx}\n` : ""}
${config.promptInstruction}${langInstruction}${variationInstruction}`;

      try {
        let accumulated = "";
        for await (const chunk of stream(prompt, {
          system: SOCIAL_SYSTEM,
          maxTokens: 2048,
          temperature: v === 0 ? 0.8 : 0.95, // Higher temperature for variations
        })) {
          accumulated += chunk;
          // Show live preview for the active variation
          setVariations((prev) => {
            const copy = [...prev];
            copy[v] = accumulated;
            return copy;
          });
          setActiveVariation(v);
        }
        results.push(accumulated);
      } catch (err) {
        console.error(`Variation ${v + 1} error:`, err);
        results.push(`Error generating variation ${v + 1}. Please try again.`);
      }
    }

    setVariations(results);
    setActiveVariation(0);
    setIsGenerating(false);
  }, [topic, isGenerating, config, lang]);

  // Autopilot state
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotStep, setAutopilotStep] = useState("");
  const [autopilotResults, setAutopilotResults] = useState<Record<string, string> | null>(null);
  const [apIncludeVideo, setApIncludeVideo] = useState(false);
  const [apIncludeVoiceover, setApIncludeVoiceover] = useState(false);
  const [apVideoModel, setApVideoModel] = useState<VideoModel>("hailuo");

  /** ONE CLICK: AI picks a topic, generates content for ALL platforms */
  const handleAutopilot = useCallback(async () => {
    if (autopilotRunning || isGenerating) return;
    setAutopilotRunning(true);
    setAutopilotResults(null);
    setVariations([]);

    try {
      // Step 1: AI picks the best social content angle
      setAutopilotStep("Picking the best content angle...");
      const existing = getExistingPostsSummary();
      const features = PLOTWELL_FEATURES.slice(0, 8).join(", ");
      const topicResult = await generate(
        `You're the social media manager for plotwell (screenplay editor + production planning platform).
Features: ${features}
Recent blog posts:\n${existing}\n
Pick ONE compelling social media topic to post about TODAY. Consider what would get engagement from screenwriters and filmmakers.
Return ONLY a JSON object: { "topic": "the topic/angle", "hook": "a catchy hook line" }`,
        { system: SOCIAL_SYSTEM, maxTokens: 300, temperature: 0.9 }
      );
      const topicMatch = topicResult.match(/\{[\s\S]*\}/);
      if (!topicMatch) throw new Error("Could not parse topic");
      const { topic: autoTopic, hook } = JSON.parse(topicMatch[0]);
      setTopic(autoTopic);

      // Step 2: Generate for all platforms in parallel
      setAutopilotStep("Generating content for all platforms...");
      const platforms: [string, PlatformConfig][] = Object.entries(PLATFORMS) as [string, PlatformConfig][];
      const langInstr = lang === "es"
        ? "\n\nIMPORTANT: Write ALL content in Spanish. Keep section headers in English."
        : "";

      const results: Record<string, string> = {};
      await Promise.all(platforms.map(async ([key, cfg]) => {
        const prompt = `Topic/Brief: ${autoTopic}\nHook to use: ${hook}\n\nPlatform: ${cfg.label}\n\n${cfg.promptInstruction}${langInstr}`;
        try {
          const result = await generate(prompt, { system: SOCIAL_SYSTEM, maxTokens: 2048, temperature: 0.8 });
          results[key] = result;
        } catch {
          results[key] = `Error generating ${cfg.label} content.`;
        }
      }));

      setAutopilotResults(results);

      // Step 3: Generate video if enabled
      if (apIncludeVideo) {
        setAutopilotStep(`Generating video clip (${VIDEO_MODEL_INFO[apVideoModel].label})...`);
        try {
          const videoPrompt = `Cinematic b-roll for a social media post about: ${autoTopic}. Professional, modern, warm amber and slate blue color palette. No text overlay.`;
          const job = await startVideoGeneration(videoPrompt, { model: apVideoModel, aspectRatio: "9:16", duration: 5 });
          let current = job;
          while (current.status === "starting" || current.status === "processing") {
            await new Promise((r) => setTimeout(r, 5000));
            current = await pollVideoJob(current);
          }
          if (current.output) {
            results["_video"] = current.output;
            setAutopilotResults({ ...results });
          }
        } catch (err) {
          console.error("Video generation failed:", err);
        }
      }

      // Step 4: Generate voiceover if enabled
      if (apIncludeVoiceover && hook) {
        setAutopilotStep("Generating voiceover...");
        try {
          const voiceUrl = await generateVoiceover(hook, { voiceId: "Casual_Guy", speed: 1.0 });
          if (voiceUrl) {
            results["_voiceover"] = voiceUrl;
            setAutopilotResults({ ...results });
          }
        } catch (err) {
          console.error("Voiceover failed:", err);
        }
      }

      // Step 5: Save to history + calendar
      const assets: { type: string; url: string; label: string }[] = [];
      if (results["_video"]) assets.push({ type: "video", url: results["_video"], label: "Video clip" });
      if (results["_voiceover"]) assets.push({ type: "audio", url: results["_voiceover"], label: "Voiceover" });

      saveToHistory({
        source: "social",
        title: autoTopic,
        content: Object.entries(results).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `## ${k.toUpperCase()}\n${v}`).join("\n\n"),
        sections: Object.fromEntries(Object.entries(results).filter(([k]) => !k.startsWith("_"))),
        assets: assets.length > 0 ? assets : undefined,
        metadata: { hook, lang },
      });

      addToCalendar({
        type: "social",
        title: autoTopic,
        notes: `Platforms: ${platforms.map(([, c]) => c.label).join(", ")}\nHook: ${hook}`,
      });

      // Auto-download content as .md
      const allContent = Object.entries(results)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => `## ${k.toUpperCase()}\n\n${v}`)
        .join("\n\n---\n\n");
      const mdBlob = new Blob([`# Social Content: ${autoTopic}\n\nGenerated: ${new Date().toISOString()}\n\n${allContent}`], { type: "text/markdown" });
      const mdUrl = URL.createObjectURL(mdBlob);
      const mdLink = document.createElement("a");
      mdLink.href = mdUrl;
      mdLink.download = `social_${new Date().toISOString().slice(0,10)}_${autoTopic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;
      mdLink.click();
      URL.revokeObjectURL(mdUrl);

      setAutopilotStep("Done! Content ready for all platforms.");
    } catch (err) {
      setAutopilotStep(`Error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setAutopilotRunning(false);
    }
  }, [autopilotRunning, isGenerating, lang]);

  return (
    <ToolPage
      title="Social"
      description="Content strategy, generation, and scheduling for plotwell."
    >
      {/* Main tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 w-fit">
        {([["generate", "🚀 Generate"], ["strategy", "🏛 Strategy"]] as [MainTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setMainTab(t)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${mainTab === t ? "bg-white text-amber-700 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}>
            {label}
          </button>
        ))}
      </div>

      {mainTab === "strategy" && <StrategyTab />}

      {mainTab === "generate" && <>
      {/* AUTOPILOT */}
      {!variations.length && !isGenerating && !autopilotRunning && !autopilotResults && !autopilotStep && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-gray-900">Autopilot</h3>
              <p className="text-sm text-gray-600 mt-0.5">AI picks a topic and generates content for all platforms at once.</p>
            </div>
            <button onClick={handleAutopilot}
              className="rounded-xl bg-amber-600 px-8 py-3 text-sm font-bold text-white hover:bg-amber-700 shadow-md hover:shadow-lg transition-all">
              Generate Everything
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-3 border-t border-amber-200">
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="radio" name="social-lang" checked={lang === "en"} onChange={() => setLang("en")} className="text-amber-600 focus:ring-amber-500" />
              English
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="radio" name="social-lang" checked={lang === "es"} onChange={() => setLang("es")} className="text-amber-600 focus:ring-amber-500" />
              Spanish
            </label>
            <div className="w-px h-4 bg-amber-200" />
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" checked={apIncludeVideo} onChange={(e) => setApIncludeVideo(e.target.checked)} className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
              Video clip
            </label>
            {apIncludeVideo && (
              <select value={apVideoModel} onChange={(e) => setApVideoModel(e.target.value as VideoModel)}
                className="text-[11px] border border-amber-300 rounded px-2 py-1 bg-white text-gray-700">
                {(Object.entries(VIDEO_MODEL_INFO) as [VideoModel, typeof VIDEO_MODEL_INFO[VideoModel]][]).map(([k, v]) => (
                  <option key={k} value={k}>{v.label} ({v.costLabel})</option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" checked={apIncludeVoiceover} onChange={(e) => setApIncludeVoiceover(e.target.checked)} className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
              Voiceover
            </label>
            <span className="ml-auto text-[11px] text-gray-400">
              Est. cost: {formatCost(estimateCosts({
                textGenerations: 5,
                videoClips: apIncludeVideo ? 1 : 0,
                videoModel: apVideoModel,
                voiceovers: apIncludeVoiceover ? 1 : 0,
                voiceoverChars: 200,
              }).total)}
            </span>
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

      {!autopilotRunning && autopilotStep && !autopilotResults && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-5 space-y-3">
          <p className="text-sm text-red-700">{autopilotStep}</p>
          <button onClick={() => { setAutopilotStep(""); setAutopilotResults(null); }}
            className="text-xs text-red-600 hover:text-red-800 font-medium">Try again</button>
        </div>
      )}

      {/* Autopilot results */}
      {autopilotResults && (
        <div className="mb-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Generated for all platforms</h3>
            <button onClick={() => { setAutopilotResults(null); setAutopilotStep(""); setTopic(""); }}
              className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
          </div>
          {(Object.entries(PLATFORMS) as [Platform, PlatformConfig][]).map(([key, cfg]) => (
            <details key={key} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <summary className="flex items-center justify-between px-5 py-3 text-sm font-medium text-gray-800 cursor-pointer hover:bg-gray-50">
                <span>{cfg.label}</span>
                <CopyButton text={autopilotResults[key] || ""} />
              </summary>
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
                  {autopilotResults[key]}
                </pre>
              </div>
            </details>
          ))}
          {autopilotResults["_video"] && (
            <div className="rounded-lg border border-purple-200 bg-purple-50 px-5 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-purple-700">Video clip generated</span>
              <a href={autopilotResults["_video"]} target="_blank" rel="noopener noreferrer"
                className="text-xs font-medium text-purple-600 hover:text-purple-800 underline">
                Download video
              </a>
            </div>
          )}
          {autopilotResults["_voiceover"] && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-5 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-green-700">Voiceover generated</span>
              <a href={autopilotResults["_voiceover"]} target="_blank" rel="noopener noreferrer"
                className="text-xs font-medium text-green-600 hover:text-green-800 underline">
                Download audio
              </a>
            </div>
          )}
        </div>
      )}

      {/* Platform Tabs — only show active platforms from strategy */}
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        {(Object.entries(PLATFORMS) as [Platform, PlatformConfig][])
          .filter(([key]) => strategy.activePlatforms.length === 0 || strategy.activePlatforms.includes(key))
          .map(
          ([key, cfg]) => (
            <button
              key={key}
              onClick={() => {
                setPlatform(key);
                setVariations([]);
                setActiveVariation(0);
                setShowMockup(false);
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                platform === key
                  ? "bg-white text-amber-700 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <span>{cfg.icon}</span>
              {cfg.label}
            </button>
          )
        )}
      </div>

      {/* Quick briefs — strategy hint */}
      {strategy.audience && (
        <p className="text-xs text-gray-400 -mt-4 mb-4 px-1">
          Writing for: <span className="text-gray-600">{strategy.audience}</span>
          {strategy.tone && <> · <span className="text-gray-600">{strategy.tone}</span></>}
        </p>
      )}

      {/* Quick briefs */}
      {!isGenerating && variations.length === 0 && (
        <SocialSuggestions
          platform={platform}
          onPick={(brief) => { setTopic(brief); }}
          onPickAndGenerate={(brief) => { setTopic(brief); setTimeout(() => { document.getElementById("social-generate-btn")?.click(); }, 50); }}
        />
      )}

      {/* Topic Input + Language */}
      <div className="mb-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Topic / Brief
          </label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={`Describe the content you want to create for ${config.label}...`}
            rows={4}
            disabled={isGenerating}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleGenerate();
              }
            }}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 resize-none"
          />
          <p className="mt-1 text-xs text-gray-400">
            Press Ctrl+Enter to generate 3 variations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Language:</span>
          {(["en", "es"] as Lang[]).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              disabled={isGenerating}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                lang === l
                  ? "border-amber-500 bg-amber-50 text-amber-700"
                  : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Generate Button */}
      <button
        id="social-generate-btn"
        onClick={handleGenerate}
        disabled={isGenerating || !topic.trim()}
        className="mb-8 w-full rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
      >
        {isGenerating ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Generating {config.label} variations...
          </span>
        ) : (
          `Generate 3 ${config.label} Variations`
        )}
      </button>

      {/* Variation Tabs + Output */}
      {variations.length > 0 && (
        <div className="space-y-4">
          {/* Variation selector + mockup toggle */}
          <div className="flex items-center justify-between">
            <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
              {variations.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActiveVariation(i)}
                  className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                    activeVariation === i
                      ? "bg-white text-amber-700 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {isGenerating && i === variations.length - 1 && !variations[i]
                    ? "Generating..."
                    : `Variation ${String.fromCharCode(65 + i)}`}
                </button>
              ))}
            </div>
            {!isGenerating && output && (
              <button
                onClick={() => setShowMockup(!showMockup)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  showMockup
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
                }`}
              >
                {showMockup ? "Hide Preview" : "Phone Preview"}
              </button>
            )}
          </div>

          {/* Platform Mockup */}
          {showMockup && !isGenerating && Object.keys(sections).length > 0 && (
            <div className="rounded-lg border border-purple-200 bg-gradient-to-b from-purple-50 to-white p-6">
              <h3 className="text-xs font-semibold text-purple-700 mb-4 text-center">
                {config.label} Preview (Variation {String.fromCharCode(65 + activeVariation)})
              </h3>
              <PlatformMockup platform={platform} sections={sections} />
            </div>
          )}

          {/* Content Sections */}
          {!isGenerating && Object.keys(sections).length === 0 && output ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-amber-700">
                  Could not parse sections. Showing raw output:
                </p>
                <CopyButton text={output} />
              </div>
              <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
                {output}
              </pre>
            </div>
          ) : (
            config.sections.map((sectionName) => {
              const sectionContent = sections[sectionName] || "";
              const charLimit = config.charLimits[sectionName];

              return (
                <div
                  key={sectionName}
                  className="rounded-lg border border-gray-200 bg-white"
                >
                  <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                    <h3 className="text-sm font-semibold text-gray-800">
                      {sectionName}
                    </h3>
                    <div className="flex items-center gap-3">
                      {charLimit && sectionContent && (
                        <CharCount text={sectionContent} limit={charLimit} />
                      )}
                      {sectionContent && <CopyButton text={sectionContent} />}
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    {sectionContent ? (
                      <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
                        {sectionContent}
                      </pre>
                    ) : (
                      <p className="text-sm text-gray-400 italic">
                        {isGenerating ? "Generating..." : "No content yet"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {/* Copy All + Generate Assets + Calendar */}
          {!isGenerating && output && (
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <AssetGenerator script={output} platform={platform} />
                {!hasItemToday("social", topic) && (
                  <button
                    onClick={() => {
                      addToCalendar({
                        type: "social",
                        title: topic.slice(0, 100),
                        platform: platform as "tiktok" | "instagram" | "x" | "linkedin",
                        notes: `${variations.length} variations generated`,
                      });
                    }}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Add to Calendar
                  </button>
                )}
              </div>
              <CopyButton text={output} className="px-4 py-1.5" />
            </div>
          )}
        </div>
      )}
      </>}
    </ToolPage>
  );
}

/* ------------------------------------------------------------------ */
/*  Asset Generator (video clips + voiceover from script)              */
/* ------------------------------------------------------------------ */

const PRODUCT_SCREENSHOTS = [
  { label: "Script Editor", path: "/blog/script_main_view.png" },
  { label: "AI Expand", path: "/blog/script_ai_expand_process.png" },
  { label: "Script Doctor", path: "/blog/script_script_doctor.png" },
  { label: "Beat Sheet", path: "/blog/beats_board.png" },
  { label: "Storyboard", path: "/blog/storyboard_main.png" },
  { label: "Scene Breakdown", path: "/blog/breakdown_main.png" },
  { label: "Budget", path: "/blog/budget.png" },
  { label: "Call Sheet", path: "/blog/callsheet.png" },
];

const TTS_VOICES = [
  { id: "Casual_Guy", label: "Casual (Male)" },
  { id: "Lively_Girl", label: "Lively (Female)" },
  { id: "Deep_Voice_Man", label: "Deep (Male)" },
  { id: "Young_Knight", label: "Young (Male)" },
  { id: "Abbess", label: "Calm (Female)" },
];

interface AssetJob {
  type: "video" | "voiceover" | "image";
  label: string;
  prompt?: string;
  status: "pending" | "generating" | "done" | "error";
  url?: string;
  error?: string;
  videoJobId?: string;
}

function downloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";
  a.click();
}

function extractVoiceoverText(script: string): string {
  const voLines: string[] = [];
  for (const line of script.split("\n")) {
    const lower = line.toLowerCase();
    if (lower.includes("voice-over:") || lower.includes("voiceover:") || lower.includes("voice over:")) {
      voLines.push(line.replace(/.*?:\s*"?/i, "").replace(/"?\s*$/, ""));
    }
  }
  if (voLines.length > 0) return voLines.join(" ");
  const captionMatch = script.match(/##\s*Caption[\s\S]*?\n([\s\S]*?)(?=##|$)/i);
  if (captionMatch) return captionMatch[1].replace(/#\S+/g, "").replace(/[^a-zA-Z0-9\s.,!?'-]/g, "").trim().slice(0, 300);
  return script.replace(/[#*\[\]]/g, "").slice(0, 200);
}

/** Brand-aware video prompt builder. CRITICAL: no text/letters in video. */
const VIDEO_STYLE = `Photorealistic cinematic footage, shallow depth of field, warm amber and cool blue tones, professional studio lighting, clean modern aesthetic. CRITICAL: absolutely no text, no words, no letters, no numbers, no UI elements, no watermarks, no labels anywhere in the frame.`;

function buildVideoPrompts(script: string, platform: Platform): Array<{ label: string; prompt: string }> {
  const vertical = platform === "tiktok" || platform === "instagram";
  const framing = vertical ? "vertical 9:16 composition, centered subject" : "widescreen 16:9 cinematic composition";
  const base = `${VIDEO_STYLE} ${framing}.`;

  const results: Array<{ label: string; prompt: string }> = [];

  // Try to extract beats from the script
  const beatMatches = script.match(/\d+\.\s*\*\*([^*]+)\*\*\s*[-–—:]\s*([^\n]+)/g);

  if (beatMatches && beatMatches.length >= 2) {
    for (const beat of beatMatches.slice(0, 3)) {
      const descMatch = beat.match(/\*\*([^*]+)\*\*\s*[-–—:]\s*(.+)/);
      if (descMatch) {
        const beatLabel = descMatch[1].trim();
        const beatDesc = descMatch[2].replace(/["""]/g, "").trim();
        // Convert script direction into a visual-only scene description
        results.push({
          label: beatLabel,
          prompt: `${beatDesc}. Professional filmmaking context, creative workspace. ${base}`,
        });
      }
    }
  }

  // If no beats found, generate standard plotwell marketing shots
  if (results.length === 0) {
    results.push(
      {
        label: "Hook",
        prompt: `A creative professional sitting at a modern desk, looking frustrated at their laptop screen, warm ambient lighting, coffee cup nearby. ${base}`,
      },
      {
        label: "Product moment",
        prompt: `Close-up of hands typing on a laptop keyboard, screen glowing with warm amber light, focused creative work in a stylish workspace. ${base}`,
      },
      {
        label: "Satisfaction",
        prompt: `A screenwriter leaning back in their chair with a satisfied smile, laptop open in front of them, soft golden hour light through a window. ${base}`,
      },
    );
  }

  return results;
}

function AssetGenerator({ script, platform }: { script: string; platform: Platform }) {
  const [expanded, setExpanded] = useState(false);
  const [jobs, setJobs] = useState<AssetJob[]>([]);
  const [voice, setVoice] = useState("Casual_Guy");
  const [videoModel, setVideoModel] = useState<VideoModel>("hailuo");
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
    };
  }, []);

  const updateJob = (idx: number, patch: Partial<AssetJob>) => {
    setJobs((prev) => prev.map((j, k) => k === idx ? { ...j, ...patch } : j));
  };

  const startPolling = (jobId: string, idx: number) => {
    pollTimers.current[jobId] = setInterval(async () => {
      try {
        const updated = await pollVideoJob({ id: jobId, status: "processing" });
        if (updated.status === "succeeded" && updated.output) {
          clearInterval(pollTimers.current[jobId]);
          updateJob(idx, { status: "done", url: updated.output });
        } else if (updated.status === "failed") {
          clearInterval(pollTimers.current[jobId]);
          updateJob(idx, { status: "error", error: updated.error || "Generation failed" });
        }
      } catch {
        clearInterval(pollTimers.current[jobId]);
        updateJob(idx, { status: "error", error: "Connection lost while polling" });
      }
    }, 5000);
  };

  const handleGenerateAll = async () => {
    const aspect: VideoOptions["aspectRatio"] = (platform === "tiktok" || platform === "instagram") ? "9:16" : "16:9";
    const videoPrompts = buildVideoPrompts(script, platform);
    const voText = extractVoiceoverText(script);

    const newJobs: AssetJob[] = [
      ...videoPrompts.map((vp) => ({
        type: "video" as const,
        label: vp.label,
        prompt: vp.prompt,
        status: "pending" as const,
      })),
      { type: "voiceover", label: "Voiceover", status: "pending", prompt: voText },
    ];
    setJobs(newJobs);

    // Sequential generation with rate-limit awareness
    // Each startVideoGeneration has internal retry for 429
    (async () => {
      // Videos: launch one at a time, each polls independently after creation
      for (let i = 0; i < videoPrompts.length; i++) {
        const idx = i;
        try {
          updateJob(idx, { status: "generating" });
          const job = await startVideoGeneration(videoPrompts[idx].prompt, {
            duration: 5,
            aspectRatio: aspect,
            model: videoModel,
          });

          if (job.status === "succeeded" && job.output) {
            updateJob(idx, { status: "done", url: job.output });
          } else {
            updateJob(idx, { videoJobId: job.id });
            startPolling(job.id, idx);
          }
        } catch (err) {
          updateJob(idx, { status: "error", error: err instanceof Error ? err.message : String(err) });
        }
        // Small delay between requests to avoid burst limit
        if (i < videoPrompts.length - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Voiceover: after all videos are kicked off
      const voIdx = videoPrompts.length;
      await new Promise((r) => setTimeout(r, 2000));
      try {
        updateJob(voIdx, { status: "generating" });
        const audioUrl = await generateVoiceover(voText, { voiceId: voice });
        updateJob(voIdx, { status: "done", url: audioUrl });
      } catch (err) {
        updateJob(voIdx, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="rounded-lg border border-purple-300 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100 transition-colors"
      >
        Generate Video Assets
      </button>
    );
  }

  const generating = jobs.some((j) => j.status === "generating");
  const doneCount = jobs.filter((j) => j.status === "done").length;

  return (
    <div className="w-full rounded-lg border border-purple-200 bg-purple-50/50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-purple-800">Video Assets</h3>
        <button onClick={() => setExpanded(false)} className="text-xs text-purple-500 hover:text-purple-700">
          Close
        </button>
      </div>

      {/* Options */}
      {jobs.length === 0 && (
        <div className="space-y-4">
          {/* Video model picker with price/quality info */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Video Model</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.entries(VIDEO_MODEL_INFO) as [VideoModel, typeof VIDEO_MODEL_INFO[VideoModel]][]).map(([key, info]) => (
                <button
                  key={key}
                  onClick={() => setVideoModel(key)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    videoModel === key
                      ? "border-purple-500 bg-purple-50 ring-1 ring-purple-500"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <div className="text-xs font-semibold text-gray-800">{info.label}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-500">{info.cost}</span>
                    <span className="text-xs text-gray-400">{info.quality}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Voice picker */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Voiceover</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-xs w-full"
            >
              {TTS_VOICES.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>

          {/* Preview what will be generated */}
          <div className="rounded-md bg-white border border-gray-200 p-3 space-y-1.5">
            <p className="text-xs font-medium text-gray-600">Will generate:</p>
            {buildVideoPrompts(script, platform).map((vp, i) => (
              <p key={i} className="text-xs text-gray-500 truncate">
                🎬 {vp.label}: {vp.prompt.slice(0, 80)}...
              </p>
            ))}
            <p className="text-xs text-gray-500 truncate">
              🎤 Voiceover: {extractVoiceoverText(script).slice(0, 80)}...
            </p>
            <p className="mt-2 text-xs text-amber-600 font-medium">
              Est. cost: ~${(buildVideoPrompts(script, platform).length * (
                videoModel === "wan" ? 0.02 : videoModel === "luma" ? 0.30 : videoModel === "hailuo" ? 0.25 : 0.50
              )).toFixed(2)} ({buildVideoPrompts(script, platform).length} clips)
            </p>
          </div>

          <button
            onClick={handleGenerateAll}
            className="w-full rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-purple-700 transition-colors"
          >
            Generate All Assets
          </button>
        </div>
      )}

      {/* Job progress */}
      {jobs.length > 0 && (
        <div className="space-y-2">
          {jobs.map((job, i) => (
            <div key={i} className="rounded-md bg-white border border-gray-200 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{job.type === "video" ? "🎬" : "🎤"}</span>
                  <span className="text-sm font-medium text-gray-800">{job.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {job.status === "pending" && <span className="text-xs text-gray-400">Queued</span>}
                  {job.status === "generating" && (
                    <span className="flex items-center gap-1.5 text-xs text-purple-600">
                      <span className="h-3 w-3 animate-spin rounded-full border border-purple-500 border-t-transparent" />
                      {job.type === "video" ? "Rendering..." : "Synthesizing..."}
                    </span>
                  )}
                  {job.status === "done" && job.url && (
                    <button
                      onClick={() => downloadUrl(job.url!, `plotwell-${job.label.toLowerCase().replace(/\s/g, "-")}.${job.type === "video" ? "mp4" : "mp3"}`)}
                      className="rounded bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-200 transition-colors"
                    >
                      Download {job.type === "video" ? ".mp4" : ".mp3"}
                    </button>
                  )}
                  {job.status === "error" && (
                    <span className="text-xs text-red-600 max-w-[200px] truncate" title={job.error}>
                      {job.error}
                    </span>
                  )}
                </div>
              </div>
              {job.prompt && (
                <p className="mt-1 text-xs text-gray-400 truncate">{job.prompt.slice(0, 100)}...</p>
              )}
            </div>
          ))}
          {generating && (
            <p className="text-xs text-gray-400">Videos take 30-180s. You can keep working while they generate.</p>
          )}
          {doneCount === jobs.length && doneCount > 0 && (
            <p className="text-xs text-green-600 font-medium">All assets ready! Download and assemble in your editor.</p>
          )}
        </div>
      )}

      {/* Product screenshots for b-roll */}
      <details className="group">
        <summary className="text-xs font-medium text-purple-700 cursor-pointer hover:text-purple-900">
          plotwell screenshots for b-roll ({PRODUCT_SCREENSHOTS.length})
        </summary>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {PRODUCT_SCREENSHOTS.map((ss) => (
            <a
              key={ss.path}
              href={`https://plotwell.com${ss.path}`}
              download
              target="_blank"
              rel="noopener"
              className="rounded-md border border-gray-200 bg-white p-1.5 text-center hover:border-purple-300 transition-colors"
            >
              <div className="text-xs text-gray-600 truncate">{ss.label}</div>
            </a>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-gray-400">
          Screenshots are in plotwell-landing/public/blog/. Use as screen recordings or b-roll overlays.
        </p>
      </details>
    </div>
  );
}
