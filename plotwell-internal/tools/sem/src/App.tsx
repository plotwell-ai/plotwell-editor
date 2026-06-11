import { useState, useCallback } from "react";
import { generate, estimateCosts, formatCost } from "@shared/ai-client";
import { SEM_SYSTEM } from "@shared/prompts";
import { PLOTWELL_FEATURES } from "@shared/content";
import { ToolPage, CopyButton } from "@shared/components";
import { addToCalendar, hasItemToday, consumePrefill } from "@shared/calendar-bridge";
import { saveToHistory } from "@shared/history";

type Platform = "google" | "meta" | "linkedin";
type Objective = "awareness" | "traffic" | "conversions";
type Mode = "adcopy" | "campaign";
type CampaignStep = "keywords" | "ads" | "extensions";

interface CharCountProps {
  current: number;
  max: number;
}

function CharCount({ current, max }: CharCountProps) {
  const over = current > max;
  return (
    <span
      className={`text-xs font-medium ${over ? "text-red-600" : "text-gray-400"}`}
    >
      {current}/{max}
    </span>
  );
}

interface GoogleAd {
  headline1: string;
  headline2: string;
  headline3: string;
  description1: string;
  description2: string;
  displayPath: string;
}

interface MetaAd {
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
}

interface LinkedInAd {
  introText: string;
  headline: string;
  description: string;
}

type AdVariation = GoogleAd | MetaAd | LinkedInAd;

interface AdSet {
  platform: Platform;
  variations: AdVariation[];
}

interface KeywordGroup {
  name: string;
  keywords: string[];
  matchType: string;
  selected: boolean;
}

interface Sitelink {
  title: string;
  description1: string;
  description2: string;
  url: string;
}

interface AdExtensions {
  sitelinks: Sitelink[];
  callouts: string[];
  structuredSnippets: { header: string; values: string[] };
}

interface CampaignAdGroup {
  groupName: string;
  adSet: AdSet;
}

const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
  { value: "google", label: "Google Ads" },
  { value: "meta", label: "Meta Ads (Facebook / Instagram)" },
  { value: "linkedin", label: "LinkedIn Ads" },
];

const OBJECTIVE_OPTIONS: { value: Objective; label: string }[] = [
  { value: "awareness", label: "Brand Awareness" },
  { value: "traffic", label: "Traffic" },
  { value: "conversions", label: "Conversions" },
];

function parseGoogleAds(text: string): GoogleAd[] {
  const variations: GoogleAd[] = [];
  const blocks = text.split(/variation\s*\d+/i).filter((b) => b.trim());

  for (const block of blocks) {
    const get = (label: string) => {
      const re = new RegExp(`${label}\\s*[:.]\\s*(.+)`, "i");
      return re.exec(block)?.[1]?.trim() ?? "";
    };
    variations.push({
      headline1: get("headline 1"),
      headline2: get("headline 2"),
      headline3: get("headline 3"),
      description1: get("description 1"),
      description2: get("description 2"),
      displayPath: get("display(?:\\s*url)?\\s*path"),
    });
  }
  return variations.length ? variations : [];
}

function parseMetaAds(text: string): MetaAd[] {
  const variations: MetaAd[] = [];
  const blocks = text.split(/variation\s*\d+/i).filter((b) => b.trim());

  for (const block of blocks) {
    const get = (label: string) => {
      const re = new RegExp(`${label}\\s*[:.]\\s*(.+)`, "i");
      return re.exec(block)?.[1]?.trim() ?? "";
    };
    variations.push({
      primaryText: get("primary text"),
      headline: get("headline"),
      description: get("description"),
      cta: get("cta(?:\\s*button)?(?:\\s*text)?"),
    });
  }
  return variations.length ? variations : [];
}

function parseLinkedInAds(text: string): LinkedInAd[] {
  const variations: LinkedInAd[] = [];
  const blocks = text.split(/variation\s*\d+/i).filter((b) => b.trim());

  for (const block of blocks) {
    const get = (label: string) => {
      const re = new RegExp(`${label}\\s*[:.]\\s*(.+)`, "i");
      return re.exec(block)?.[1]?.trim() ?? "";
    };
    variations.push({
      introText: get("intro(?:\\s*text)?"),
      headline: get("headline"),
      description: get("description"),
    });
  }
  return variations.length ? variations : [];
}

function buildPrompt(
  platform: Platform,
  objective: Objective,
  audience: string
): string {
  const platformInstructions: Record<Platform, string> = {
    google: `Platform: Google Ads (Responsive Search Ads)
Generate 3 variations. For each variation provide:
- Headline 1: (max 30 characters)
- Headline 2: (max 30 characters)
- Headline 3: (max 30 characters)
- Description 1: (max 90 characters)
- Description 2: (max 90 characters)
- Display URL Path: (max 15 characters, e.g. "screenwriting")

Label each as "Variation 1", "Variation 2", "Variation 3".`,
    meta: `Platform: Meta Ads (Facebook / Instagram)
Generate 3 variations. For each variation provide:
- Primary Text: (the main ad body, 1-2 sentences)
- Headline: (max 40 characters)
- Description: (one short sentence)
- CTA Button Text: (e.g. "Learn More", "Sign Up", "Get Started")

Label each as "Variation 1", "Variation 2", "Variation 3".`,
    linkedin: `Platform: LinkedIn Ads (Sponsored Content)
Generate 3 variations. For each variation provide:
- Intro Text: (the main ad body, 1-2 sentences, professional tone)
- Headline: (max 70 characters)
- Description: (one short sentence)

Label each as "Variation 1", "Variation 2", "Variation 3".`,
  };

  return `${platformInstructions[platform]}

Campaign Objective: ${objective}
Target Audience: ${audience}

Respect all character limits strictly. Write compelling ad copy that drives action.`;
}

function buildCampaignAdPrompt(
  platform: Platform,
  objective: Objective,
  groupName: string,
  keywords: string[]
): string {
  const platformInstructions: Record<Platform, string> = {
    google: `Platform: Google Ads (Responsive Search Ads)
Generate 3 variations. For each variation provide:
- Headline 1: (max 30 characters)
- Headline 2: (max 30 characters)
- Headline 3: (max 30 characters)
- Description 1: (max 90 characters)
- Description 2: (max 90 characters)
- Display URL Path: (max 15 characters, e.g. "screenwriting")

Label each as "Variation 1", "Variation 2", "Variation 3".`,
    meta: `Platform: Meta Ads (Facebook / Instagram)
Generate 3 variations. For each variation provide:
- Primary Text: (the main ad body, 1-2 sentences)
- Headline: (max 40 characters)
- Description: (one short sentence)
- CTA Button Text: (e.g. "Learn More", "Sign Up", "Get Started")

Label each as "Variation 1", "Variation 2", "Variation 3".`,
    linkedin: `Platform: LinkedIn Ads (Sponsored Content)
Generate 3 variations. For each variation provide:
- Intro Text: (the main ad body, 1-2 sentences, professional tone)
- Headline: (max 70 characters)
- Description: (one short sentence)

Label each as "Variation 1", "Variation 2", "Variation 3".`,
  };

  return `${platformInstructions[platform]}

Campaign Objective: ${objective}
Ad Group Theme: ${groupName}
Target Keywords: ${keywords.join(", ")}

The ad copy should be highly relevant to these keywords. Incorporate the keyword theme naturally.
Respect all character limits strictly. Write compelling ad copy that drives action.`;
}

function googleAdToText(ad: GoogleAd): string {
  return [
    `Headline 1: ${ad.headline1}`,
    `Headline 2: ${ad.headline2}`,
    `Headline 3: ${ad.headline3}`,
    `Description 1: ${ad.description1}`,
    `Description 2: ${ad.description2}`,
    `Display Path: ${ad.displayPath}`,
  ].join("\n");
}

function metaAdToText(ad: MetaAd): string {
  return [
    `Primary Text: ${ad.primaryText}`,
    `Headline: ${ad.headline}`,
    `Description: ${ad.description}`,
    `CTA: ${ad.cta}`,
  ].join("\n");
}

function linkedInAdToText(ad: LinkedInAd): string {
  return [
    `Intro Text: ${ad.introText}`,
    `Headline: ${ad.headline}`,
    `Description: ${ad.description}`,
  ].join("\n");
}

function exportAdsToCsv(result: AdSet) {
  let headers: string[];
  let rows: string[][];

  if (result.platform === "google") {
    headers = ["Headline 1", "Headline 2", "Headline 3", "Description 1", "Description 2", "Path"];
    rows = (result.variations as GoogleAd[]).map((ad) => [
      ad.headline1, ad.headline2, ad.headline3, ad.description1, ad.description2, ad.displayPath,
    ]);
  } else if (result.platform === "meta") {
    headers = ["Primary Text", "Headline", "Description", "CTA"];
    rows = (result.variations as MetaAd[]).map((ad) => [
      ad.primaryText, ad.headline, ad.description, ad.cta,
    ]);
  } else {
    headers = ["Intro Text", "Headline", "Description"];
    rows = (result.variations as LinkedInAd[]).map((ad) => [
      ad.introText, ad.headline, ad.description,
    ]);
  }

  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = [headers.join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `plotwell-${result.platform}-ads.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCampaignCsv(
  keywordGroups: KeywordGroup[],
  campaignAds: CampaignAdGroup[],
  extensions: AdExtensions | null,
  platform: Platform
) {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines: string[] = [];

  // Keywords sheet
  lines.push("--- KEYWORDS ---");
  lines.push("Campaign,Ad Group,Keyword,Match Type");
  for (const group of keywordGroups.filter((g) => g.selected)) {
    for (const kw of group.keywords) {
      lines.push(
        ["plotwell", group.name, kw, group.matchType].map(escape).join(",")
      );
    }
  }

  // Ad copy sheet
  lines.push("");
  lines.push("--- AD COPY ---");
  if (platform === "google") {
    lines.push("Ad Group,Headline 1,Headline 2,Headline 3,Description 1,Description 2,Path");
    for (const group of campaignAds) {
      for (const ad of group.adSet.variations as GoogleAd[]) {
        lines.push(
          [group.groupName, ad.headline1, ad.headline2, ad.headline3, ad.description1, ad.description2, ad.displayPath]
            .map(escape)
            .join(",")
        );
      }
    }
  } else if (platform === "meta") {
    lines.push("Ad Group,Primary Text,Headline,Description,CTA");
    for (const group of campaignAds) {
      for (const ad of group.adSet.variations as MetaAd[]) {
        lines.push(
          [group.groupName, ad.primaryText, ad.headline, ad.description, ad.cta]
            .map(escape)
            .join(",")
        );
      }
    }
  } else {
    lines.push("Ad Group,Intro Text,Headline,Description");
    for (const group of campaignAds) {
      for (const ad of group.adSet.variations as LinkedInAd[]) {
        lines.push(
          [group.groupName, ad.introText, ad.headline, ad.description]
            .map(escape)
            .join(",")
        );
      }
    }
  }

  // Extensions (Google only)
  if (extensions && platform === "google") {
    lines.push("");
    lines.push("--- SITELINKS ---");
    lines.push("Title,Description Line 1,Description Line 2,Final URL");
    for (const sl of extensions.sitelinks) {
      lines.push(
        [sl.title, sl.description1, sl.description2, sl.url].map(escape).join(",")
      );
    }

    lines.push("");
    lines.push("--- CALLOUTS ---");
    lines.push("Callout Text");
    for (const c of extensions.callouts) {
      lines.push(escape(c));
    }

    lines.push("");
    lines.push("--- STRUCTURED SNIPPETS ---");
    lines.push(`Header: ${extensions.structuredSnippets.header}`);
    lines.push("Value");
    for (const v of extensions.structuredSnippets.values) {
      lines.push(escape(v));
    }
  }

  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `plotwell-campaign-${platform}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function GoogleAdCard({ ad, index }: { ad: GoogleAd; index: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">
          Variation {index + 1}
        </h4>
        <CopyButton text={googleAdToText(ad)} />
      </div>
      <div className="space-y-3">
        {(["headline1", "headline2", "headline3"] as const).map((key, i) => (
          <div key={key}>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500">
                Headline {i + 1}
              </label>
              <CharCount current={ad[key].length} max={30} />
            </div>
            <p className="mt-0.5 text-sm font-medium text-blue-700">
              {ad[key]}
            </p>
          </div>
        ))}
        {(["description1", "description2"] as const).map((key, i) => (
          <div key={key}>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500">
                Description {i + 1}
              </label>
              <CharCount current={ad[key].length} max={90} />
            </div>
            <p className="mt-0.5 text-sm text-gray-800">{ad[key]}</p>
          </div>
        ))}
        <div>
          <label className="text-xs font-medium text-gray-500">
            Display Path
          </label>
          <p className="mt-0.5 text-sm text-green-700">
            plotwell.com/{ad.displayPath}
          </p>
        </div>
      </div>
    </div>
  );
}

function MetaAdCard({ ad, index }: { ad: MetaAd; index: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">
          Variation {index + 1}
        </h4>
        <CopyButton text={metaAdToText(ad)} />
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-500">
            Primary Text
          </label>
          <p className="mt-0.5 text-sm text-gray-800">{ad.primaryText}</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500">
              Headline
            </label>
            <CharCount current={ad.headline.length} max={40} />
          </div>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">
            {ad.headline}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">
            Description
          </label>
          <p className="mt-0.5 text-sm text-gray-600">{ad.description}</p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">
            CTA Button
          </label>
          <span className="mt-1 inline-block rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white">
            {ad.cta}
          </span>
        </div>
      </div>
    </div>
  );
}

function LinkedInAdCard({ ad, index }: { ad: LinkedInAd; index: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">
          Variation {index + 1}
        </h4>
        <CopyButton text={linkedInAdToText(ad)} />
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-500">
            Intro Text
          </label>
          <p className="mt-0.5 text-sm text-gray-800">{ad.introText}</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500">
              Headline
            </label>
            <CharCount current={ad.headline.length} max={70} />
          </div>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">
            {ad.headline}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">
            Description
          </label>
          <p className="mt-0.5 text-sm text-gray-600">{ad.description}</p>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   Ad Copy Mode (existing functionality)
   ========================================================================== */

function AdCopyMode() {
  const [platform, setPlatform] = useState<Platform>("google");
  const [objective, setObjective] = useState<Objective>("conversions");
  const [audience, setAudience] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AdSet | null>(null);
  const [rawFallback, setRawFallback] = useState("");
  const [error, setError] = useState("");

  const handleGenerate = async () => {
    if (!audience.trim()) {
      setError("Please describe your target audience.");
      return;
    }

    setError("");
    setLoading(true);
    setResult(null);
    setRawFallback("");

    try {
      const prompt = buildPrompt(platform, objective, audience);
      const output = await generate(prompt, { system: SEM_SYSTEM });

      let variations: AdVariation[] = [];
      if (platform === "google") {
        variations = parseGoogleAds(output);
      } else if (platform === "meta") {
        variations = parseMetaAds(output);
      } else {
        variations = parseLinkedInAds(output);
      }

      if (variations.length === 0) {
        setRawFallback(output);
        return;
      }

      setResult({ platform, variations });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Platform selector */}
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Ad Platform
        </label>
        <div className="flex gap-2">
          {PLATFORM_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setPlatform(opt.value);
                setResult(null);
              }}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                platform === opt.value
                  ? "border-amber-500 bg-amber-50 text-amber-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Campaign objective */}
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Campaign Objective
        </label>
        <div className="flex gap-2">
          {OBJECTIVE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setObjective(opt.value)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                objective === opt.value
                  ? "border-amber-500 bg-amber-50 text-amber-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Target audience */}
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Target Audience
        </label>
        <textarea
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          placeholder="e.g. Independent screenwriters aged 25-45 looking for professional tools to write and produce their first feature film"
          rows={3}
          className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
      </div>

      {/* Format preview */}
      <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Ad format
        </h3>
        {platform === "google" && (
          <ul className="space-y-1 text-xs text-gray-600">
            <li>3 Headlines (30 chars each)</li>
            <li>2 Descriptions (90 chars each)</li>
            <li>Display URL path</li>
          </ul>
        )}
        {platform === "meta" && (
          <ul className="space-y-1 text-xs text-gray-600">
            <li>Primary text (body copy)</li>
            <li>Headline (40 chars)</li>
            <li>Description</li>
            <li>CTA button text</li>
          </ul>
        )}
        {platform === "linkedin" && (
          <ul className="space-y-1 text-xs text-gray-600">
            <li>Intro text (body copy)</li>
            <li>Headline (70 chars)</li>
            <li>Description</li>
          </ul>
        )}
      </div>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={loading}
        className="w-full rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Generating 3 variations...
          </span>
        ) : (
          "Generate Ad Variations"
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Raw fallback when parsing fails */}
      {rawFallback && !result && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-amber-700">
              Could not parse ad variations. Showing raw output:
            </p>
            <CopyButton text={rawFallback} />
          </div>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
            {rawFallback}
          </pre>
        </div>
      )}

      {/* Results */}
      {result && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">
              Generated Variations
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => exportAdsToCsv(result)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Export CSV
              </button>
              {!hasItemToday("sem", audience.slice(0, 50)) && (
                <button
                  onClick={() => addToCalendar({ type: "sem", title: audience.slice(0, 100) || `${result.platform} ads`, notes: `Platform: ${result.platform}, ${result.variations.length} variations` })}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  + Calendar
                </button>
              )}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {result.platform === "google" &&
              (result.variations as GoogleAd[]).map((ad, i) => (
                <GoogleAdCard key={i} ad={ad} index={i} />
              ))}
            {result.platform === "meta" &&
              (result.variations as MetaAd[]).map((ad, i) => (
                <MetaAdCard key={i} ad={ad} index={i} />
              ))}
            {result.platform === "linkedin" &&
              (result.variations as LinkedInAd[]).map((ad, i) => (
                <LinkedInAdCard key={i} ad={ad} index={i} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Campaign Mode (new functionality)
   ========================================================================== */

function CampaignMode() {
  const [step, setStep] = useState<CampaignStep>("keywords");
  const [platform, setPlatform] = useState<Platform>("google");
  const [objective, setObjective] = useState<Objective>("conversions");
  const [audience, setAudience] = useState("");
  const [description, setDescription] = useState(
    "plotwell - professional screenplay editor and production planning platform with AI-powered writing assistance"
  );

  // Keywords state
  const [keywordGroups, setKeywordGroups] = useState<KeywordGroup[]>([]);
  const [loadingKeywords, setLoadingKeywords] = useState(false);

  // Ads state
  const [campaignAds, setCampaignAds] = useState<CampaignAdGroup[]>([]);
  const [loadingAds, setLoadingAds] = useState(false);
  const [adsRawFallback, setAdsRawFallback] = useState("");

  // Extensions state
  const [extensions, setExtensions] = useState<AdExtensions | null>(null);
  const [loadingExtensions, setLoadingExtensions] = useState(false);

  const [error, setError] = useState("");

  const selectedGroups = keywordGroups.filter((g) => g.selected);

  /* ---------- Step 1: Keyword generation ---------- */

  const handleGenerateKeywords = async () => {
    if (!audience.trim()) {
      setError("Please describe your target audience.");
      return;
    }
    setError("");
    setLoadingKeywords(true);
    setKeywordGroups([]);

    try {
      const prompt = `Generate keyword groups for a Google Ads campaign.

Product: ${description}
Target audience: ${audience}
Campaign objective: ${objective}

Return a JSON object with this structure:
{
  "groups": [
    {
      "name": "Theme name",
      "keywords": ["keyword 1", "keyword 2"],
      "matchType": "phrase"
    }
  ]
}

Generate 3-5 thematic groups with 5-10 keywords each. Include:
- Brand keywords (plotwell related)
- Competitor keywords (Final Draft, Celtx alternatives)
- Feature keywords (screenplay editor, script writing software, etc.)
- Problem keywords (format screenplay, collaborate on script, etc.)
- Long-tail keywords (specific use cases)

Return ONLY the JSON object, no other text.`;

      const output = await generate(prompt, { system: SEM_SYSTEM });

      // Extract JSON from output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        setError("Failed to parse keyword groups. Please try again.");
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const groups: KeywordGroup[] = (parsed.groups || []).map(
        (g: { name: string; keywords: string[]; matchType?: string }) => ({
          name: g.name,
          keywords: g.keywords,
          matchType: g.matchType || "phrase",
          selected: true,
        })
      );

      if (groups.length === 0) {
        setError("No keyword groups generated. Please try again.");
        return;
      }

      setKeywordGroups(groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Keyword generation failed.");
    } finally {
      setLoadingKeywords(false);
    }
  };

  const toggleGroup = (index: number) => {
    setKeywordGroups((prev) =>
      prev.map((g, i) => (i === index ? { ...g, selected: !g.selected } : g))
    );
  };

  const removeKeyword = (groupIndex: number, kwIndex: number) => {
    setKeywordGroups((prev) =>
      prev.map((g, gi) =>
        gi === groupIndex
          ? { ...g, keywords: g.keywords.filter((_, ki) => ki !== kwIndex) }
          : g
      )
    );
  };

  const updateKeyword = (groupIndex: number, kwIndex: number, value: string) => {
    setKeywordGroups((prev) =>
      prev.map((g, gi) =>
        gi === groupIndex
          ? {
              ...g,
              keywords: g.keywords.map((kw, ki) =>
                ki === kwIndex ? value : kw
              ),
            }
          : g
      )
    );
  };

  const addKeyword = (groupIndex: number) => {
    setKeywordGroups((prev) =>
      prev.map((g, gi) =>
        gi === groupIndex ? { ...g, keywords: [...g.keywords, ""] } : g
      )
    );
  };

  const removeGroup = (index: number) => {
    setKeywordGroups((prev) => prev.filter((_, i) => i !== index));
  };

  /* ---------- Step 2: Ad copy generation ---------- */

  const handleGenerateAds = async () => {
    if (selectedGroups.length === 0) {
      setError("Please select at least one keyword group.");
      return;
    }
    setError("");
    setLoadingAds(true);
    setCampaignAds([]);
    setAdsRawFallback("");

    try {
      const results: CampaignAdGroup[] = [];

      for (const group of selectedGroups) {
        const prompt = buildCampaignAdPrompt(
          platform,
          objective,
          group.name,
          group.keywords
        );
        const output = await generate(prompt, { system: SEM_SYSTEM });

        let variations: AdVariation[] = [];
        if (platform === "google") {
          variations = parseGoogleAds(output);
        } else if (platform === "meta") {
          variations = parseMetaAds(output);
        } else {
          variations = parseLinkedInAds(output);
        }

        if (variations.length === 0) {
          setAdsRawFallback(
            (prev) => prev + `\n--- ${group.name} ---\n${output}\n`
          );
        } else {
          results.push({
            groupName: group.name,
            adSet: { platform, variations },
          });
        }
      }

      setCampaignAds(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ad generation failed.");
    } finally {
      setLoadingAds(false);
    }
  };

  /* ---------- Step 3: Extensions generation (Google only) ---------- */

  const handleGenerateExtensions = async () => {
    setError("");
    setLoadingExtensions(true);
    setExtensions(null);

    try {
      const prompt = `Generate Google Ads extensions for a campaign promoting plotwell - a professional screenplay editor and production planning platform.

Target audience: ${audience}
Campaign objective: ${objective}

Return a JSON object with this exact structure:
{
  "sitelinks": [
    {
      "title": "Title here (max 25 chars)",
      "description1": "First line (max 35 chars)",
      "description2": "Second line (max 35 chars)",
      "url": "https://plotwell.com/page"
    }
  ],
  "callouts": ["Callout 1 (max 25 chars)", "Callout 2", "Callout 3", "Callout 4", "Callout 5", "Callout 6"],
  "structuredSnippets": {
    "header": "Types",
    "values": ["Value 1", "Value 2", "Value 3"]
  }
}

Generate exactly:
- 4 sitelinks (title max 25 chars, each description max 35 chars)
- 6 callouts (max 25 chars each)
- 1 structured snippet set with a relevant header and 3-5 values

Return ONLY the JSON object, no other text.`;

      const output = await generate(prompt, { system: SEM_SYSTEM });

      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        setError("Failed to parse extensions. Please try again.");
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      setExtensions({
        sitelinks: parsed.sitelinks || [],
        callouts: parsed.callouts || [],
        structuredSnippets: parsed.structuredSnippets || {
          header: "",
          values: [],
        },
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Extension generation failed."
      );
    } finally {
      setLoadingExtensions(false);
    }
  };

  /* ---------- Step indicators ---------- */

  const steps: { key: CampaignStep; label: string; number: number }[] = [
    { key: "keywords", label: "Keywords", number: 1 },
    { key: "ads", label: "Ad Copy", number: 2 },
    { key: "extensions", label: "Extensions", number: 3 },
  ];

  const canProceedToAds = keywordGroups.length > 0 && selectedGroups.length > 0;
  const canProceedToExtensions = campaignAds.length > 0;

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <button
              onClick={() => setStep(s.key)}
              disabled={
                (s.key === "ads" && !canProceedToAds) ||
                (s.key === "extensions" && !canProceedToExtensions)
              }
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                step === s.key
                  ? "bg-amber-600 text-white"
                  : (s.key === "ads" && !canProceedToAds) ||
                      (s.key === "extensions" && !canProceedToExtensions)
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  step === s.key
                    ? "bg-white text-amber-600"
                    : "bg-gray-300 text-white"
                }`}
              >
                {s.number}
              </span>
              {s.label}
            </button>
            {i < steps.length - 1 && (
              <div className="h-px w-6 bg-gray-300" />
            )}
          </div>
        ))}
      </div>

      {/* Platform & Objective (shared across steps) */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Ad Platform
          </label>
          <div className="flex flex-wrap gap-2">
            {PLATFORM_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPlatform(opt.value)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  platform === opt.value
                    ? "border-amber-500 bg-amber-50 text-amber-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Campaign Objective
          </label>
          <div className="flex flex-wrap gap-2">
            {OBJECTIVE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setObjective(opt.value)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  objective === opt.value
                    ? "border-amber-500 bg-amber-50 text-amber-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ===== Step 1: Keywords ===== */}
      {step === "keywords" && (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">
              Product / Service Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">
              Target Audience
            </label>
            <textarea
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="e.g. Independent screenwriters aged 25-45 looking for professional tools to write and produce their first feature film"
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          <button
            onClick={handleGenerateKeywords}
            disabled={loadingKeywords}
            className="w-full rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingKeywords ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Generating keyword groups...
              </span>
            ) : (
              "Generate Keywords"
            )}
          </button>

          {/* Keyword groups */}
          {keywordGroups.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">
                  Keyword Groups
                </h3>
                <span className="text-sm text-gray-500">
                  {selectedGroups.length} of {keywordGroups.length} selected
                </span>
              </div>

              {keywordGroups.map((group, gi) => (
                <div
                  key={gi}
                  className={`rounded-lg border p-4 transition-colors ${
                    group.selected
                      ? "border-amber-300 bg-amber-50/50"
                      : "border-gray-200 bg-white"
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={group.selected}
                        onChange={() => toggleGroup(gi)}
                        className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                      />
                      <h4 className="text-sm font-semibold text-gray-700">
                        {group.name}
                      </h4>
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                        {group.matchType}
                      </span>
                    </div>
                    <button
                      onClick={() => removeGroup(gi)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {group.keywords.map((kw, ki) => (
                      <div
                        key={ki}
                        className="group flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1"
                      >
                        <input
                          type="text"
                          value={kw}
                          onChange={(e) =>
                            updateKeyword(gi, ki, e.target.value)
                          }
                          className="max-w-[180px] border-none bg-transparent p-0 text-xs text-gray-700 focus:outline-none focus:ring-0"
                          style={{ width: `${Math.max(kw.length * 7, 50)}px` }}
                        />
                        <button
                          onClick={() => removeKeyword(gi, ki)}
                          className="hidden text-gray-400 hover:text-red-500 group-hover:inline"
                        >
                          <svg
                            className="h-3 w-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => addKeyword(gi)}
                      className="rounded-full border border-dashed border-gray-300 px-3 py-1 text-xs text-gray-400 hover:border-amber-400 hover:text-amber-600 transition-colors"
                    >
                      + Add
                    </button>
                  </div>
                </div>
              ))}

              {/* Proceed to ads */}
              <button
                onClick={() => setStep("ads")}
                disabled={selectedGroups.length === 0}
                className="w-full rounded-lg border border-amber-600 bg-white px-6 py-3 text-sm font-semibold text-amber-600 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Continue to Ad Copy ({selectedGroups.length} group
                {selectedGroups.length !== 1 ? "s" : ""})
              </button>
            </div>
          )}
        </div>
      )}

      {/* ===== Step 2: Ad Copy ===== */}
      {step === "ads" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Generating ads for {selectedGroups.length} keyword group
              {selectedGroups.length !== 1 ? "s" : ""}
            </h3>
            <div className="flex flex-wrap gap-2">
              {selectedGroups.map((g, i) => (
                <span
                  key={i}
                  className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700"
                >
                  {g.name} ({g.keywords.length} keywords)
                </span>
              ))}
            </div>
          </div>

          <button
            onClick={handleGenerateAds}
            disabled={loadingAds}
            className="w-full rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingAds ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Generating ads for {selectedGroups.length} group
                {selectedGroups.length !== 1 ? "s" : ""}...
              </span>
            ) : (
              `Generate Ad Copy (3 variations per group)`
            )}
          </button>

          {/* Raw fallback */}
          {adsRawFallback && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-amber-700">
                  Some groups could not be parsed. Raw output:
                </p>
                <CopyButton text={adsRawFallback} />
              </div>
              <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">
                {adsRawFallback}
              </pre>
            </div>
          )}

          {/* Campaign ad results */}
          {campaignAds.length > 0 && (
            <div className="space-y-6">
              {campaignAds.map((group, gi) => (
                <div key={gi}>
                  <div className="mb-3 flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {group.groupName}
                    </h3>
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                      {group.adSet.variations.length} variations
                    </span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    {group.adSet.platform === "google" &&
                      (group.adSet.variations as GoogleAd[]).map((ad, i) => (
                        <GoogleAdCard key={i} ad={ad} index={i} />
                      ))}
                    {group.adSet.platform === "meta" &&
                      (group.adSet.variations as MetaAd[]).map((ad, i) => (
                        <MetaAdCard key={i} ad={ad} index={i} />
                      ))}
                    {group.adSet.platform === "linkedin" &&
                      (group.adSet.variations as LinkedInAd[]).map((ad, i) => (
                        <LinkedInAdCard key={i} ad={ad} index={i} />
                      ))}
                  </div>
                </div>
              ))}

              {/* Proceed to extensions or export */}
              <div className="flex gap-3">
                {platform === "google" && (
                  <button
                    onClick={() => setStep("extensions")}
                    className="flex-1 rounded-lg border border-amber-600 bg-white px-6 py-3 text-sm font-semibold text-amber-600 transition-colors hover:bg-amber-50"
                  >
                    Continue to Extensions
                  </button>
                )}
                <button
                  onClick={() =>
                    exportCampaignCsv(
                      keywordGroups,
                      campaignAds,
                      extensions,
                      platform
                    )
                  }
                  className="flex-1 rounded-lg border border-gray-300 bg-white px-6 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  Export Campaign CSV
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Step 3: Extensions (Google only) ===== */}
      {step === "extensions" && (
        <div className="space-y-4">
          {platform !== "google" ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
              Ad extensions are only available for Google Ads. Switch to Google
              Ads platform to use this feature.
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Ad Extensions
                </h3>
                <ul className="space-y-1 text-xs text-gray-600">
                  <li>4 Sitelinks (title 25 chars, description 35 chars x2)</li>
                  <li>6 Callouts (25 chars each)</li>
                  <li>Structured snippets (header + values)</li>
                </ul>
              </div>

              <button
                onClick={handleGenerateExtensions}
                disabled={loadingExtensions}
                className="w-full rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingExtensions ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Generating extensions...
                  </span>
                ) : (
                  "Generate Ad Extensions"
                )}
              </button>

              {/* Extensions results */}
              {extensions && (
                <div className="space-y-6">
                  {/* Sitelinks */}
                  <div>
                    <h3 className="mb-3 text-lg font-semibold text-gray-900">
                      Sitelinks
                    </h3>
                    <div className="grid gap-4 md:grid-cols-2">
                      {extensions.sitelinks.map((sl, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-gray-200 bg-white p-4"
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <label className="text-xs font-medium text-gray-500">
                              Sitelink {i + 1}
                            </label>
                            <CharCount
                              current={sl.title.length}
                              max={25}
                            />
                          </div>
                          <p className="text-sm font-medium text-blue-700">
                            {sl.title}
                          </p>
                          <div className="mt-2 space-y-1">
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-gray-600">
                                {sl.description1}
                              </p>
                              <CharCount
                                current={sl.description1.length}
                                max={35}
                              />
                            </div>
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-gray-600">
                                {sl.description2}
                              </p>
                              <CharCount
                                current={sl.description2.length}
                                max={35}
                              />
                            </div>
                          </div>
                          <p className="mt-2 text-xs text-green-600">
                            {sl.url}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Callouts */}
                  <div>
                    <h3 className="mb-3 text-lg font-semibold text-gray-900">
                      Callouts
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {extensions.callouts.map((c, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2"
                        >
                          <span className="text-sm text-gray-700">{c}</span>
                          <CharCount current={c.length} max={25} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Structured Snippets */}
                  <div>
                    <h3 className="mb-3 text-lg font-semibold text-gray-900">
                      Structured Snippets
                    </h3>
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                      <p className="mb-2 text-xs font-medium text-gray-500">
                        Header:{" "}
                        <span className="text-gray-700">
                          {extensions.structuredSnippets.header}
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {extensions.structuredSnippets.values.map((v, i) => (
                          <span
                            key={i}
                            className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700"
                          >
                            {v}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Export full campaign */}
                  <button
                    onClick={() =>
                      exportCampaignCsv(
                        keywordGroups,
                        campaignAds,
                        extensions,
                        platform
                      )
                    }
                    className="w-full rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700"
                  >
                    Export Full Campaign CSV
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Main App with mode tabs
   ========================================================================== */

export default function App() {
  const [mode, setMode] = useState<Mode>("adcopy");
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotStep, setAutopilotStep] = useState("");
  const [autopilotResult, setAutopilotResult] = useState<string | null>(null);

  const handleAutopilot = useCallback(async () => {
    if (autopilotRunning) return;
    setAutopilotRunning(true);
    setAutopilotResult(null);

    try {
      setAutopilotStep("Generating ad campaigns for all platforms...");
      const features = PLOTWELL_FEATURES.slice(0, 6).join(", ");
      const result = await generate(
        `Create a complete ad campaign for plotwell (screenplay editor + production planning platform).
Key features: ${features}

Generate ad copy for ALL 3 platforms:

## GOOGLE ADS
3 RSA variations, each with:
- 3 Headlines (max 30 chars each)
- 2 Descriptions (max 90 chars each)
- Display path suggestions

## META ADS (Facebook/Instagram)
3 variations, each with:
- Primary text (engaging, max 125 chars for preview)
- Headline (max 40 chars)
- Description (max 30 chars)
- CTA suggestion

## LINKEDIN ADS
3 variations, each with:
- Intro text (max 150 chars)
- Headline (max 70 chars)
- Description (max 100 chars)

Focus on conversions. Target: screenwriters, filmmakers, indie producers.
Highlight: AI-powered, modern web app, all-in-one platform, free tier available.`,
        { system: SEM_SYSTEM, maxTokens: 4096, temperature: 0.8 }
      );

      setAutopilotResult(result);
      saveToHistory({ source: "sem", title: "Ad campaign (Google + Meta + LinkedIn)", content: result });
      addToCalendar({ type: "sem", title: "Ad campaign generated (Google + Meta + LinkedIn)", notes: "3 variations per platform" });

      // Auto-download
      const blob = new Blob([`# SEM Campaign\n\nGenerated: ${new Date().toISOString()}\n\n${result}`], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sem_campaign_${new Date().toISOString().slice(0,10)}.md`;
      a.click();
      URL.revokeObjectURL(url);

      setAutopilotStep("Done! Campaign saved.");
    } catch (err) {
      setAutopilotStep(`Error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setAutopilotRunning(false);
    }
  }, [autopilotRunning]);

  return (
    <ToolPage
      title="SEM / Ad Copy Generator"
      description="Generate platform-specific ad copy with proper character limits and multiple variations."
    >
      {/* AUTOPILOT */}
      {!autopilotRunning && !autopilotResult && !autopilotStep && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-gray-900">Autopilot</h3>
              <p className="text-sm text-gray-600 mt-0.5">AI generates a full ad campaign for Google, Meta, and LinkedIn at once.</p>
              <p className="text-[11px] text-gray-400 mt-1">Est. cost: {formatCost(estimateCosts({ textGenerations: 1 }).total)}</p>
            </div>
            <button onClick={handleAutopilot}
              className="rounded-xl bg-amber-600 px-8 py-3 text-sm font-bold text-white hover:bg-amber-700 shadow-md hover:shadow-lg transition-all">
              Generate Campaign
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
            <h3 className="text-sm font-semibold text-gray-700">Generated Campaign</h3>
            <div className="flex gap-2">
              <CopyButton text={autopilotResult} />
              <button onClick={() => { setAutopilotResult(null); setAutopilotStep(""); }}
                className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          </div>
          <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-4 max-h-[500px] overflow-y-auto">
            {autopilotResult}
          </div>
        </div>
      )}

      {/* Mode tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => setMode("adcopy")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === "adcopy"
              ? "bg-white text-amber-700 shadow-sm"
              : "text-gray-600 hover:text-gray-800"
          }`}
        >
          Ad Copy
        </button>
        <button
          onClick={() => setMode("campaign")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === "campaign"
              ? "bg-white text-amber-700 shadow-sm"
              : "text-gray-600 hover:text-gray-800"
          }`}
        >
          Full Campaign
        </button>
      </div>

      {mode === "adcopy" ? <AdCopyMode /> : <CampaignMode />}
    </ToolPage>
  );
}
