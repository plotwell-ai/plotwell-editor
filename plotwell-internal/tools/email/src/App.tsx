import { useState, useCallback } from "react";
import { generate, stream, formatCost, estimateCosts } from "@shared/ai-client";
import { EMAIL_SYSTEM } from "@shared/prompts";
import { getExistingPostsSummary, PLOTWELL_FEATURES } from "@shared/content";
import { addToCalendar, hasItemToday, consumePrefill } from "@shared/calendar-bridge";
import { saveToHistory } from "@shared/history";
import {
  ToolPage,
  StreamingOutput,
  CopyButton,
} from "@shared/components";

type Tab = "single" | "drip" | "subjects" | "campaigns";
type CampaignStatus = "idea" | "draft" | "scheduled" | "sent";
type EmailType =
  | "newsletter"
  | "product_update"
  | "onboarding"
  | "re_engagement"
  | "announcement";
type Tone = "professional" | "friendly" | "urgent";
type DripGoal = "onboarding" | "trial_conversion" | "feature_adoption";

interface Campaign {
  id: string;
  name: string;
  type: EmailType;
  audience: string;
  notes: string;
  status: CampaignStatus;
  createdAt: number;
}

const CAMPAIGN_COLUMNS: { status: CampaignStatus; label: string; dot: string; badge: string }[] = [
  { status: "idea", label: "Idea", dot: "bg-gray-400", badge: "bg-gray-100 text-gray-600" },
  { status: "draft", label: "Draft", dot: "bg-blue-400", badge: "bg-blue-100 text-blue-700" },
  { status: "scheduled", label: "Scheduled", dot: "bg-amber-400", badge: "bg-amber-100 text-amber-700" },
  { status: "sent", label: "Sent", dot: "bg-green-400", badge: "bg-green-100 text-green-700" },
];

// Module-level prefill consumed once when SingleEmailTab mounts
let _campaignPrefill = "";

const EMAIL_TYPES: { value: EmailType; label: string }[] = [
  { value: "newsletter", label: "Newsletter" },
  { value: "product_update", label: "Product Update" },
  { value: "onboarding", label: "Onboarding" },
  { value: "re_engagement", label: "Re-engagement" },
  { value: "announcement", label: "Announcement" },
];

const TONES: { value: Tone; label: string }[] = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "urgent", label: "Urgent" },
];

const DRIP_GOALS: { value: DripGoal; label: string }[] = [
  { value: "onboarding", label: "Onboarding" },
  { value: "trial_conversion", label: "Trial Conversion" },
  { value: "feature_adoption", label: "Feature Adoption" },
];

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
        active
          ? "bg-amber-600 text-white"
          : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

interface EmailParts {
  subjectLine: string;
  previewText: string;
  htmlBody: string;
  plainText: string;
}

function parseEmailOutput(raw: string): EmailParts | null {
  const get = (label: string, nextLabel: string): string => {
    const re = new RegExp(`${label}[:\\s]*\\n([\\s\\S]*?)(?=${nextLabel}|$)`, "i");
    const m = raw.match(re);
    return m?.[1]?.trim() ?? "";
  };

  const htmlBody = get("HTML BODY", "PLAIN TEXT VERSION");
  if (!htmlBody) return null;

  return {
    subjectLine: get("SUBJECT LINE", "PREVIEW TEXT"),
    previewText: get("PREVIEW TEXT", "HTML BODY"),
    htmlBody,
    plainText: get("PLAIN TEXT VERSION", "\\z"),
  };
}

function EmailPreview({ html, subject, preview }: { html: string; subject: string; preview: string }) {
  const iframeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
body{margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#f9fafb}
a{color:#2563eb}img{max-width:100%}
</style></head><body>${html}</body></html>`;

  return (
    <div className="space-y-3">
      {/* Email header mock */}
      {(subject || preview) && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 space-y-1">
          {subject && (
            <div className="flex gap-2 text-sm">
              <span className="font-medium text-gray-500 shrink-0">Subject:</span>
              <span className="font-semibold text-gray-900">{subject}</span>
            </div>
          )}
          {preview && (
            <div className="flex gap-2 text-xs">
              <span className="font-medium text-gray-400 shrink-0">Preview:</span>
              <span className="text-gray-500">{preview}</span>
            </div>
          )}
        </div>
      )}
      {/* Rendered HTML in sandboxed iframe */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <iframe
          srcDoc={iframeHtml}
          sandbox=""
          title="Email preview"
          className="w-full border-0"
          style={{ minHeight: 400, maxWidth: 600, margin: "0 auto", display: "block" }}
          onLoad={(e) => {
            const frame = e.currentTarget;
            if (frame.contentDocument?.body) {
              frame.style.height = frame.contentDocument.body.scrollHeight + 40 + "px";
            }
          }}
        />
      </div>
    </div>
  );
}

function EmailOutputPanel({ output, isStreaming }: { output: string; isStreaming: boolean }) {
  const [view, setView] = useState<"code" | "preview">("code");
  const parsed = !isStreaming ? parseEmailOutput(output) : null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {/* View toggle + copy buttons */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
        <div className="flex gap-1 rounded-md bg-gray-100 p-0.5">
          <button
            onClick={() => setView("code")}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              view === "code" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Code
          </button>
          <button
            onClick={() => setView("preview")}
            disabled={!parsed}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
              view === "preview" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Preview
          </button>
        </div>
        <div className="flex items-center gap-2">
          {parsed?.htmlBody && (
            <CopyButton text={parsed.htmlBody} label="HTML" />
          )}
          {parsed?.subjectLine && !hasItemToday("email", parsed.subjectLine) && (
            <button
              onClick={() => addToCalendar({ type: "email", title: parsed.subjectLine, notes: `Type: ${parsed.previewText || "email"}` })}
              className="rounded px-2.5 py-1 text-xs font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              + Calendar
            </button>
          )}
          <CopyButton text={output} />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {view === "preview" && parsed ? (
          <EmailPreview html={parsed.htmlBody} subject={parsed.subjectLine} preview={parsed.previewText} />
        ) : (
          <StreamingOutput
            content={output}
            isStreaming={isStreaming}
            className="min-h-[200px] max-h-[600px]"
          />
        )}
      </div>

      {/* Email compatibility validation */}
      {parsed?.htmlBody && !isStreaming && (
        <EmailValidation html={parsed.htmlBody} subject={parsed.subjectLine} preview={parsed.previewText} />
      )}
    </div>
  );
}

function EmailValidation({ html, subject, preview }: { html: string; subject: string; preview: string }) {
  const issues: { type: "error" | "warning" | "ok"; message: string }[] = [];

  // Subject line checks
  if (!subject) {
    issues.push({ type: "error", message: "Missing subject line" });
  } else if (subject.length > 60) {
    issues.push({ type: "warning", message: `Subject line too long (${subject.length}/60 chars). May be truncated on mobile.` });
  } else {
    issues.push({ type: "ok", message: `Subject line length OK (${subject.length}/60)` });
  }

  // Preview text
  if (!preview) {
    issues.push({ type: "warning", message: "Missing preview text. Email clients will show body text instead." });
  } else if (preview.length > 90) {
    issues.push({ type: "warning", message: `Preview text long (${preview.length}/90 chars). May be truncated.` });
  } else {
    issues.push({ type: "ok", message: `Preview text OK (${preview.length}/90)` });
  }

  // HTML checks
  if (html.includes("<style>") || html.includes("<style ")) {
    issues.push({ type: "warning", message: "Contains <style> block. Gmail strips <style> tags. Use inline styles for best compatibility." });
  }
  if (html.includes("display: grid") || html.includes("display:grid")) {
    issues.push({ type: "error", message: "CSS Grid detected. Not supported in most email clients. Use tables instead." });
  }
  if (html.includes("display: flex") || html.includes("display:flex")) {
    issues.push({ type: "warning", message: "Flexbox detected. Limited email client support. Consider using tables." });
  }
  if (html.includes("position: absolute") || html.includes("position:absolute")) {
    issues.push({ type: "error", message: "CSS position:absolute detected. Not supported in email clients." });
  }
  if (html.includes("<div") && !html.includes("<table")) {
    issues.push({ type: "warning", message: "Uses <div> layout without <table>. Table-based layout is more reliable in email clients." });
  }
  if (!html.includes("max-width") && !html.includes("width:")) {
    issues.push({ type: "warning", message: "No width constraint. Email may render too wide. Add max-width: 600px." });
  }
  if (html.includes("<img") && !html.includes('alt=')) {
    issues.push({ type: "warning", message: "Images without alt text. Add alt attributes for accessibility." });
  }
  if (!html.includes("font-family")) {
    issues.push({ type: "warning", message: "No font-family specified. Use web-safe fonts (Arial, Helvetica, Georgia)." });
  }
  if (html.includes("rgba(") || html.includes("hsla(")) {
    issues.push({ type: "warning", message: "CSS rgba/hsla colors detected. Some email clients don't support these. Use hex colors." });
  }

  const errors = issues.filter((i) => i.type === "error").length;
  const warnings = issues.filter((i) => i.type === "warning").length;
  const oks = issues.filter((i) => i.type === "ok").length;

  const iconMap = { error: "X", warning: "!", ok: "O" };
  const colorMap = {
    error: "bg-red-100 text-red-600 border-red-200",
    warning: "bg-amber-100 text-amber-600 border-amber-200",
    ok: "bg-green-100 text-green-600 border-green-200",
  };

  return (
    <div className="border-t border-gray-100 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-600">Email Compatibility Check</h4>
        <div className="flex gap-2 text-[10px]">
          {errors > 0 && <span className="text-red-600">{errors} errors</span>}
          {warnings > 0 && <span className="text-amber-600">{warnings} warnings</span>}
          {oks > 0 && <span className="text-green-600">{oks} passed</span>}
        </div>
      </div>
      <div className="space-y-1">
        {issues.map((issue, i) => (
          <div key={i} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 ${colorMap[issue.type]}`}>
            <span className="w-4 h-4 rounded-full border text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
              {iconMap[issue.type]}
            </span>
            <span className="text-xs">{issue.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SingleEmailTab() {
  const [emailType, setEmailType] = useState<EmailType>("newsletter");
  const [tone, setTone] = useState<Tone>("professional");
  const [keyPoints, setKeyPoints] = useState(() => {
    if (_campaignPrefill) {
      const v = _campaignPrefill;
      _campaignPrefill = "";
      return v;
    }
    const prefill = consumePrefill();
    return prefill?.type === "email" ? prefill.topic : "";
  });
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const handleGenerate = async () => {
    if (!keyPoints.trim() || isStreaming) return;
    setOutput("");
    setIsStreaming(true);

    const prompt = `Generate a single marketing email for plotwell.

Type: ${emailType.replace("_", " ")}
Tone: ${tone}
Key points to cover:
${keyPoints}

Provide the output in this exact format:

SUBJECT LINE:
[subject line here]

PREVIEW TEXT:
[preview text, max 90 characters]

HTML BODY:
[full email body with HTML formatting - use <h2>, <p>, <a>, <strong> tags. Include a clear CTA button styled as: <a href="{{cta_url}}" style="background-color:#d97706;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">CTA Text</a>]

PLAIN TEXT VERSION:
[plain text version of the same email, suitable for email clients that don't render HTML]

Use {{first_name}} for personalization. Keep the email scannable with short paragraphs.`;

    try {
      for await (const chunk of stream(prompt, {
        system: EMAIL_SYSTEM,
        maxTokens: 4096,
      })) {
        setOutput((prev) => prev + chunk);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Email Type
          </label>
          <select
            value={emailType}
            onChange={(e) => setEmailType(e.target.value as EmailType)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Tone
          </label>
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value as Tone)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            {TONES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Key Points
        </label>
        <textarea
          value={keyPoints}
          onChange={(e) => setKeyPoints(e.target.value)}
          rows={4}
          placeholder="What should this email communicate? List the main points, features, or announcements to cover..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
        />
      </div>

      <button
        onClick={handleGenerate}
        disabled={isStreaming || !keyPoints.trim()}
        className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
      >
        {isStreaming ? "Generating..." : "Generate Email"}
      </button>

      {output && (
        <EmailOutputPanel output={output} isStreaming={isStreaming} />
      )}
    </div>
  );
}

function DripSequenceTab() {
  const [goal, setGoal] = useState<DripGoal>("onboarding");
  const [emailCount, setEmailCount] = useState(5);
  const [daysBetween, setDaysBetween] = useState(3);
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const handleGenerate = async () => {
    if (!context.trim() || isStreaming) return;
    setOutput("");
    setIsStreaming(true);

    const prompt = `Generate a ${emailCount}-email drip sequence for plotwell.

Goal: ${goal.replace("_", " ")}
Number of emails: ${emailCount}
Days between emails: ${daysBetween}
Additional context: ${context}

For each email in the sequence, provide:

---
EMAIL [number] (Day [day number])
SUBJECT LINE: [subject]
PREVIEW TEXT: [preview, max 90 chars]
BODY:
[Full email body text. Use short paragraphs. Include a CTA. Use {{first_name}} for personalization.]
---

Make each email build on the previous one, gradually moving the reader toward the goal. Start with a warm welcome/introduction and end with a strong conversion push. Vary the subject line styles (question, benefit, curiosity, social proof, urgency).`;

    try {
      for await (const chunk of stream(prompt, {
        system: EMAIL_SYSTEM,
        maxTokens: 8192,
      })) {
        setOutput((prev) => prev + chunk);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Sequence Goal
          </label>
          <select
            value={goal}
            onChange={(e) => setGoal(e.target.value as DripGoal)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            {DRIP_GOALS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Number of Emails
          </label>
          <input
            type="number"
            min={3}
            max={7}
            value={emailCount}
            onChange={(e) =>
              setEmailCount(
                Math.min(7, Math.max(3, parseInt(e.target.value) || 3))
              )
            }
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Days Between
          </label>
          <input
            type="number"
            min={1}
            max={14}
            value={daysBetween}
            onChange={(e) =>
              setDaysBetween(
                Math.min(14, Math.max(1, parseInt(e.target.value) || 1))
              )
            }
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Context and Details
        </label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={4}
          placeholder="Describe the target audience, specific features to highlight, current pain points, or any specific messaging you want included..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={isStreaming || !context.trim()}
          className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
        >
          {isStreaming ? "Generating..." : "Generate Sequence"}
        </button>
        <span className="text-xs text-gray-400">
          {emailCount} emails over {(emailCount - 1) * daysBetween} days
        </span>
      </div>

      {output && (
        <EmailOutputPanel output={output} isStreaming={isStreaming} />
      )}
    </div>
  );
}

function SubjectLinesTab() {
  const [topic, setTopic] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const handleGenerate = async () => {
    if (!topic.trim() || isStreaming) return;
    setOutput("");
    setIsStreaming(true);

    const prompt = `Generate 10 email subject line variations for a plotwell marketing email about:
${topic}

For each subject line, provide:

[number]. [subject line] ([character count] chars)

After listing all 10, add:

---
A/B TEST RECOMMENDATIONS:

Pair 1: [number] vs [number]
Rationale: [why these two make a good A/B test - e.g., question vs statement, curiosity vs benefit]

Pair 2: [number] vs [number]
Rationale: [why these two make a good A/B test]

Pair 3: [number] vs [number]
Rationale: [why these two make a good A/B test]

Mix the styles: use questions, benefits, curiosity gaps, numbers/stats, urgency, social proof, and personalization ({{first_name}}). Keep most under 50 characters for mobile optimization, but include a couple longer ones for desktop.`;

    try {
      for await (const chunk of stream(prompt, {
        system: EMAIL_SYSTEM,
        maxTokens: 2048,
      })) {
        setOutput((prev) => prev + chunk);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Email Topic
        </label>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          placeholder="Describe the email content or campaign theme. E.g., 'New AI-powered scene generation feature launch' or 'End of year discount for annual plans'..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
        />
      </div>

      <button
        onClick={handleGenerate}
        disabled={isStreaming || !topic.trim()}
        className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
      >
        {isStreaming ? "Generating..." : "Generate Subject Lines"}
      </button>

      {output && (
        <div className="relative rounded-lg border border-gray-200 bg-white p-4">
          <div className="absolute top-3 right-3">
            <CopyButton text={output} />
          </div>
          <StreamingOutput
            content={output}
            isStreaming={isStreaming}
            className="min-h-[200px] max-h-[600px]"
          />
        </div>
      )}
    </div>
  );
}

function CampaignsBoard({ onWrite }: { onWrite: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("email-campaigns") || "[]");
    } catch {
      return [];
    }
  });
  const [addingIn, setAddingIn] = useState<CampaignStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Campaign, "id" | "createdAt" | "status">>({
    name: "",
    type: "newsletter",
    audience: "",
    notes: "",
  });

  const save = (updated: Campaign[]) => {
    setCampaigns(updated);
    localStorage.setItem("email-campaigns", JSON.stringify(updated));
  };

  const openAdd = (status: CampaignStatus) => {
    setForm({ name: "", type: "newsletter", audience: "", notes: "" });
    setEditingId(null);
    setAddingIn(status);
  };

  const openEdit = (c: Campaign) => {
    setForm({ name: c.name, type: c.type, audience: c.audience, notes: c.notes });
    setEditingId(c.id);
    setAddingIn(null);
  };

  const submitAdd = (status: CampaignStatus) => {
    if (!form.name.trim()) return;
    save([...campaigns, { ...form, id: Date.now().toString(), status, createdAt: Date.now() }]);
    setAddingIn(null);
  };

  const submitEdit = () => {
    if (!form.name.trim() || !editingId) return;
    save(campaigns.map((c) => (c.id === editingId ? { ...c, ...form } : c)));
    setEditingId(null);
  };

  const move = (id: string, dir: 1 | -1) => {
    const statuses: CampaignStatus[] = ["idea", "draft", "scheduled", "sent"];
    save(
      campaigns.map((c) => {
        if (c.id !== id) return c;
        const idx = statuses.indexOf(c.status);
        const next = statuses[idx + dir];
        return next ? { ...c, status: next } : c;
      })
    );
  };

  const remove = (id: string) => save(campaigns.filter((c) => c.id !== id));

  const handleWrite = (c: Campaign) => {
    _campaignPrefill = [
      c.name,
      c.audience && `Audience: ${c.audience}`,
      c.notes && c.notes,
    ]
      .filter(Boolean)
      .join("\n\n");
    onWrite();
  };

  const statuses: CampaignStatus[] = ["idea", "draft", "scheduled", "sent"];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {CAMPAIGN_COLUMNS.map((col, colIdx) => {
        const cards = campaigns.filter((c) => c.status === col.status);
        return (
          <div key={col.status} className="rounded-xl border border-gray-200 bg-gray-50 p-3 flex flex-col gap-2">
            {/* Column header */}
            <div className="flex items-center gap-2 px-1">
              <span className={`w-2 h-2 rounded-full shrink-0 ${col.dot}`} />
              <span className="text-xs font-semibold text-gray-700">{col.label}</span>
              <span className="ml-auto text-[10px] font-medium text-gray-400">{cards.length}</span>
            </div>

            {/* Cards */}
            {cards.map((c) => {
              const isEditing = editingId === c.id;
              const typeLabel = EMAIL_TYPES.find((t) => t.value === c.type)?.label ?? c.type;
              return (
                <div key={c.id} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                  {isEditing ? (
                    <>
                      <input
                        autoFocus
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="Campaign name"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                      />
                      <select
                        value={form.type}
                        onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as EmailType }))}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                      >
                        {EMAIL_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <input
                        value={form.audience}
                        onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}
                        placeholder="Target audience"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                      />
                      <textarea
                        value={form.notes}
                        onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                        rows={2}
                        placeholder="Notes / key points..."
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs resize-none focus:border-amber-500 focus:outline-none"
                      />
                      <div className="flex gap-1.5">
                        <button onClick={submitEdit} className="flex-1 rounded bg-amber-600 py-1 text-[11px] font-medium text-white hover:bg-amber-700">Save</button>
                        <button onClick={() => setEditingId(null)} className="flex-1 rounded border border-gray-300 py-1 text-[11px] text-gray-600 hover:bg-gray-50">Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-1">
                        <p className="text-xs font-semibold text-gray-900 leading-snug">{c.name}</p>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${col.badge}`}>{typeLabel}</span>
                      </div>
                      {c.audience && (
                        <p className="text-[11px] text-gray-500 line-clamp-1">👥 {c.audience}</p>
                      )}
                      {c.notes && (
                        <p className="text-[11px] text-gray-400 line-clamp-2">{c.notes}</p>
                      )}
                      {/* Actions */}
                      <div className="flex items-center gap-1 pt-0.5">
                        {(col.status === "idea" || col.status === "draft") && (
                          <button
                            onClick={() => handleWrite(c)}
                            className="rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700 transition-colors"
                          >
                            ✏ Write
                          </button>
                        )}
                        <button onClick={() => openEdit(c)} className="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Edit">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        {colIdx > 0 && (
                          <button onClick={() => move(c.id, -1)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Move left">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                          </button>
                        )}
                        {colIdx < statuses.length - 1 && (
                          <button onClick={() => move(c.id, 1)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Move right">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                          </button>
                        )}
                        <button onClick={() => remove(c.id)} className="rounded p-1 text-red-300 hover:bg-red-50 hover:text-red-500" title="Delete">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* Add card */}
            {addingIn === col.status ? (
              <div className="rounded-lg border border-dashed border-amber-300 bg-white p-3 space-y-2">
                <input
                  autoFocus
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitAdd(col.status); if (e.key === "Escape") setAddingIn(null); }}
                  placeholder="Campaign name"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                />
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as EmailType }))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                >
                  {EMAIL_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <input
                  value={form.audience}
                  onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}
                  placeholder="Target audience (optional)"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
                />
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  placeholder="Key points / notes (optional)"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs resize-none focus:border-amber-500 focus:outline-none"
                />
                <div className="flex gap-1.5">
                  <button onClick={() => submitAdd(col.status)} className="flex-1 rounded bg-amber-600 py-1 text-[11px] font-medium text-white hover:bg-amber-700">Add</button>
                  <button onClick={() => setAddingIn(null)} className="flex-1 rounded border border-gray-300 py-1 text-[11px] text-gray-600 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => openAdd(col.status)}
                className="rounded-lg border border-dashed border-gray-300 py-2 text-xs text-gray-400 hover:border-gray-400 hover:text-gray-600 transition-colors"
              >
                + Add campaign
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("single");
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotStep, setAutopilotStep] = useState("");
  const [autopilotResult, setAutopilotResult] = useState<string | null>(null);

  const handleAutopilot = useCallback(async () => {
    if (autopilotRunning) return;
    setAutopilotRunning(true);
    setAutopilotResult(null);

    try {
      setAutopilotStep("Deciding what email to write...");
      const posts = getExistingPostsSummary();
      const features = PLOTWELL_FEATURES.slice(0, 6).join(", ");
      const decisionResult = await generate(
        `You're the email marketing manager for plotwell (screenplay editor + production platform).
Features: ${features}
Recent blog posts:\n${posts}\n
Decide what email to send to our mailing list TODAY. Options:
- Newsletter with recent blog content + tips
- Product update highlighting a feature
- Re-engagement for inactive users

Return ONLY JSON: { "type": "newsletter|product_update|re_engagement", "topic": "the angle", "subject_line": "the subject" }`,
        { system: EMAIL_SYSTEM, maxTokens: 300, temperature: 0.7 }
      );
      const match = decisionResult.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Could not parse decision");
      const { type, topic, subject_line } = JSON.parse(match[0]);

      setAutopilotStep(`Writing ${type} email: "${subject_line}"...`);
      const emailResult = await generate(
        `Write a complete ${type} email for plotwell.
Topic: ${topic}
Subject line: ${subject_line}

Include:
- Subject line
- Preview text (50-90 chars)
- Full HTML email body (inline styles, table layout for compatibility)
- Plain text version

Format:
SUBJECT: ...
PREVIEW: ...
---HTML---
(full HTML)
---PLAIN---
(plain text version)`,
        { system: EMAIL_SYSTEM, maxTokens: 4096, temperature: 0.7 }
      );

      setAutopilotResult(emailResult);
      saveToHistory({ source: "email", title: subject_line, content: emailResult, metadata: { type, topic } });
      addToCalendar({ type: "email", title: subject_line, notes: `Type: ${type}\nTopic: ${topic}` });

      // Auto-download
      const blob = new Blob([`# Email: ${subject_line}\n\nType: ${type}\nTopic: ${topic}\nGenerated: ${new Date().toISOString()}\n\n${emailResult}`], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `email_${new Date().toISOString().slice(0,10)}_${subject_line.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;
      a.click();
      URL.revokeObjectURL(url);

      setAutopilotStep("Done! Email saved.");
    } catch (err) {
      setAutopilotStep(`Error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setAutopilotRunning(false);
    }
  }, [autopilotRunning]);

  return (
    <ToolPage
      title="Email Campaigns"
      description="Generate marketing emails, drip sequences, and subject line variations for plotwell."
    >
      <div className="space-y-6">
        {/* AUTOPILOT */}
        {activeTab !== "campaigns" && !autopilotRunning && !autopilotResult && !autopilotStep && (
          <div className="rounded-xl border-2 border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-900">Autopilot</h3>
                <p className="text-sm text-gray-600 mt-0.5">AI decides the best email to send, writes it, and adds it to your calendar.</p>
                <p className="text-[11px] text-gray-400 mt-1">Est. cost: {formatCost(estimateCosts({ textGenerations: 2 }).total)}</p>
              </div>
              <button onClick={handleAutopilot}
                className="rounded-xl bg-amber-600 px-8 py-3 text-sm font-bold text-white hover:bg-amber-700 shadow-md hover:shadow-lg transition-all">
                Generate Email
              </button>
            </div>
          </div>
        )}

        {activeTab !== "campaigns" && autopilotRunning && (
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-semibold text-amber-800">{autopilotStep}</p>
            </div>
          </div>
        )}

        {activeTab !== "campaigns" && !autopilotRunning && autopilotStep && !autopilotResult && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 space-y-3">
            <p className="text-sm text-red-700">{autopilotStep}</p>
            <button onClick={() => { setAutopilotStep(""); setAutopilotResult(null); }}
              className="text-xs text-red-600 hover:text-red-800 font-medium">Try again</button>
          </div>
        )}

        {activeTab !== "campaigns" && autopilotResult && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">Generated Email</h3>
              <div className="flex gap-2">
                <CopyButton text={autopilotResult} />
                <button onClick={() => { setAutopilotResult(null); setAutopilotStep(""); }}
                  className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed bg-gray-50 rounded-lg p-4 max-h-[500px] overflow-y-auto">
              {autopilotResult}
            </pre>
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <TabButton active={activeTab === "campaigns"} onClick={() => setActiveTab("campaigns")}>Campaigns</TabButton>
          <TabButton active={activeTab === "single"} onClick={() => setActiveTab("single")}>Single Email</TabButton>
          <TabButton active={activeTab === "drip"} onClick={() => setActiveTab("drip")}>Drip Sequence</TabButton>
          <TabButton active={activeTab === "subjects"} onClick={() => setActiveTab("subjects")}>Subject Lines</TabButton>
        </div>

        {activeTab === "campaigns" && (
          <CampaignsBoard onWrite={() => setActiveTab("single")} />
        )}
        {activeTab === "single" && <SingleEmailTab />}
        {activeTab === "drip" && <DripSequenceTab />}
        {activeTab === "subjects" && <SubjectLinesTab />}
      </div>
    </ToolPage>
  );
}
