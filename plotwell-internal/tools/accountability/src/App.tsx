import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ToolPage } from "@shared/components";
import { generate } from "@shared/ai-client";
import AccountingApp from "@tools/accounting/App";

/* ------------------------------------------------------------------ */
/*  Markdown renderer                                                  */
/* ------------------------------------------------------------------ */

function AIMarkdown({ text, className = "" }: { text: string; className?: string }) {
  const html = renderMarkdown(text);
  return (
    <div
      className={`ai-md text-sm leading-relaxed ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeader = false;

  const closeList = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; tableHeader = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList(); closeTable();
      out.push('<hr class="my-3 border-gray-200" />');
      continue;
    }

    // Table row
    if (/^\|/.test(line)) {
      closeList();
      if (!inTable) { out.push('<table class="w-full text-xs border-collapse my-2">'); inTable = true; tableHeader = false; }
      // Separator row (|---|)
      if (/^\|[\s\-:|]+\|/.test(line)) {
        if (!tableHeader) { out.push("</thead><tbody>"); tableHeader = true; }
        continue;
      }
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      const tag = !tableHeader ? "th" : "td";
      const cellClass = !tableHeader
        ? 'class="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-semibold text-gray-700"'
        : 'class="border border-gray-200 px-2 py-1 text-gray-600"';
      if (!tableHeader) out.push("<thead><tr>");
      else out.push("<tr>");
      cells.forEach((c) => out.push(`<${tag} ${cellClass}>${inlineFormat(c)}</${tag}>`));
      out.push("</tr>");
      continue;
    }
    if (inTable) closeTable();

    // Headings
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);
    if (h3) { closeList(); out.push(`<h3 class="text-xs font-semibold text-gray-700 mt-3 mb-1">${inlineFormat(h3[1])}</h3>`); continue; }
    if (h2) { closeList(); out.push(`<h2 class="text-sm font-semibold text-gray-800 mt-4 mb-1">${inlineFormat(h2[1])}</h2>`); continue; }
    if (h1) { closeList(); out.push(`<h1 class="text-base font-bold text-gray-900 mt-4 mb-2">${inlineFormat(h1[1])}</h1>`); continue; }

    // Ordered list
    const ol = line.match(/^(\d+)\.\s+(.*)/);
    if (ol) {
      closeTable();
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push('<ol class="list-decimal pl-5 my-1 space-y-0.5 text-gray-700">'); inOl = true; }
      out.push(`<li>${inlineFormat(ol[2])}</li>`);
      continue;
    }

    // Unordered list (-, *, •)
    const ul = line.match(/^[-*•]\s+(.*)/);
    if (ul) {
      closeTable();
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push('<ul class="list-disc pl-5 my-1 space-y-0.5 text-gray-700">'); inUl = true; }
      out.push(`<li>${inlineFormat(ul[1])}</li>`);
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      closeList(); closeTable();
      out.push('<div class="my-1" />');
      continue;
    }

    // Normal paragraph
    closeList(); closeTable();
    out.push(`<p class="my-0.5 text-gray-700">${inlineFormat(line)}</p>`);
  }

  closeList(); closeTable();
  return out.join("");
}

function inlineFormat(text: string): string {
  return text
    // Bold-italic
    .replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>")
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 py-0.5 rounded text-[11px] font-mono text-gray-800">$1</code>')
    // Escape remaining HTML just in case (very basic)
    ;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TopTab = "dashboard" | "accounting" | "proyecciones";

interface FiscalObligation {
  id: string;
  title: string;
  formNumber?: string;
  description: string;
  deadlineMonth: number; // 0-indexed
  deadlineDay: number;
  periodLabel: string;
  category: "iva" | "irpf" | "anual" | "legal" | "societario";
  firstYear: number;
  note?: string;
  /** Quarter index 1-4, or null for annual/non-quarterly */
  quarter?: 1 | 2 | 3 | 4;
}

type Status = "done" | "overdue" | "due-soon" | "upcoming" | "future" | "not-applicable" | "partial-period";
type FoundingImpact = "normal" | "partial" | "not-applicable";

/* ------------------------------------------------------------------ */
/*  Company info                                                       */
/* ------------------------------------------------------------------ */

/** PLOTWELL S.L.U. founded March 11, 2026. IS at 15% for first 2 years. */
const COMPANY_FOUNDED_DATE = new Date(2026, 2, 11); // 11 March 2026
const IS_REDUCED_UNTIL = 2027; // inclusive
const IS_RATE_REDUCED = 0.15;
const IS_RATE_NORMAL = 0.25;
const IVA_RATE = 0.21;

/* ------------------------------------------------------------------ */
/*  All fiscal obligations for S.L.U.                                  */
/* ------------------------------------------------------------------ */

const OBLIGATIONS: FiscalObligation[] = [
  // IVA quarterly
  { id: "303-q1", title: "Modelo 303 — Q1", formNumber: "303", description: "IVA trimestral. Enero-Marzo.", deadlineMonth: 3, deadlineDay: 20, periodLabel: "Ene-Mar", category: "iva", firstYear: 2026, quarter: 1 },
  { id: "303-q2", title: "Modelo 303 — Q2", formNumber: "303", description: "IVA trimestral. Abril-Junio.", deadlineMonth: 6, deadlineDay: 20, periodLabel: "Abr-Jun", category: "iva", firstYear: 2026, quarter: 2 },
  { id: "303-q3", title: "Modelo 303 — Q3", formNumber: "303", description: "IVA trimestral. Julio-Septiembre.", deadlineMonth: 9, deadlineDay: 20, periodLabel: "Jul-Sep", category: "iva", firstYear: 2026, quarter: 3 },
  { id: "303-q4", title: "Modelo 303 — Q4", formNumber: "303", description: "IVA trimestral. Octubre-Diciembre. Presentacion en enero siguiente.", deadlineMonth: 0, deadlineDay: 30, periodLabel: "Oct-Dic", category: "iva", firstYear: 2026, quarter: 4 },

  // IRPF quarterly (solo autonomo — S.L.U. normalmente NO presenta 130)
  { id: "130-q1", title: "Modelo 130 — Q1", formNumber: "130", description: "IRPF fraccionado (solo si administrador es autonomo). No aplica si unicamente sociedad.", deadlineMonth: 3, deadlineDay: 20, periodLabel: "Ene-Mar", category: "irpf", firstYear: 2026, quarter: 1 },
  { id: "130-q2", title: "Modelo 130 — Q2", formNumber: "130", description: "IRPF fraccionado Q2.", deadlineMonth: 6, deadlineDay: 20, periodLabel: "Abr-Jun", category: "irpf", firstYear: 2026, quarter: 2 },
  { id: "130-q3", title: "Modelo 130 — Q3", formNumber: "130", description: "IRPF fraccionado Q3.", deadlineMonth: 9, deadlineDay: 20, periodLabel: "Jul-Sep", category: "irpf", firstYear: 2026, quarter: 3 },
  { id: "130-q4", title: "Modelo 130 — Q4", formNumber: "130", description: "IRPF fraccionado Q4. Enero siguiente.", deadlineMonth: 0, deadlineDay: 30, periodLabel: "Oct-Dic", category: "irpf", firstYear: 2026, quarter: 4 },

  // Annual
  { id: "390", title: "Modelo 390 — Resumen anual IVA", formNumber: "390", description: "Resumen anual IVA. Debe cuadrar con los 4 Modelos 303.", deadlineMonth: 0, deadlineDay: 30, periodLabel: "Anual", category: "anual", firstYear: 2026 },
  { id: "200", title: "Modelo 200 — Impuesto Sociedades", formNumber: "200", description: `IS anual. Tipo ${IS_RATE_REDUCED * 100}% (empresa nueva, primeros 2 ejercicios). Presentacion en julio.`, deadlineMonth: 6, deadlineDay: 25, periodLabel: "Anual", category: "anual", firstYear: 2026 },
  { id: "renta", title: "Declaracion Renta (IRPF)", formNumber: "100", description: "IRPF anual del administrador. Campana abril-junio.", deadlineMonth: 5, deadlineDay: 30, periodLabel: "Anual", category: "anual", firstYear: 2026 },
  { id: "349", title: "Modelo 349 — Ops. intracomunitarias", formNumber: "349", description: "Solo si ventas/compras B2B con empresas de la UE.", deadlineMonth: 0, deadlineDay: 30, periodLabel: "Anual", category: "iva", firstYear: 2026 },

  // Corporate (first full year was 2026, but deposit/filing is done in 2027)
  { id: "cuentas", title: "Deposito Cuentas Anuales", description: "Registro Mercantil. Aprobacion en junta (jun), deposito (jul).", deadlineMonth: 6, deadlineDay: 30, periodLabel: "Ejercicio anterior", category: "societario", firstYear: 2027 },
  { id: "libros", title: "Legalizacion libros societarios", description: "Libro actas, socios, diario, inventarios. Plazo: abril.", deadlineMonth: 3, deadlineDay: 30, periodLabel: "Ejercicio anterior", category: "societario", firstYear: 2027 },

  // Legal
  { id: "rgpd", title: "Revision RGPD / LOPDGDD", description: "Revisar politica de privacidad, DPAs, cookies y derechos ARCO.", deadlineMonth: 0, deadlineDay: 31, periodLabel: "Anual", category: "legal", firstYear: 2026 },
];

/* ------------------------------------------------------------------ */
/*  Period / founding helpers                                          */
/* ------------------------------------------------------------------ */

/** Returns the calendar period an obligation covers (for founding-date analysis) */
function getObligationPeriod(o: FiscalObligation, fiscalYear: number): { start: Date; end: Date } {
  switch (o.quarter) {
    case 1: return { start: new Date(fiscalYear, 0, 1),  end: new Date(fiscalYear, 2, 31) };
    case 2: return { start: new Date(fiscalYear, 3, 1),  end: new Date(fiscalYear, 5, 30) };
    case 3: return { start: new Date(fiscalYear, 6, 1),  end: new Date(fiscalYear, 8, 30) };
    case 4: return { start: new Date(fiscalYear, 9, 1),  end: new Date(fiscalYear, 11, 31) };
    default: return { start: new Date(fiscalYear, 0, 1), end: new Date(fiscalYear, 11, 31) };
  }
}

/** Whether a founding date affects this obligation */
function getFoundingImpact(o: FiscalObligation, fiscalYear: number): FoundingImpact {
  const { start, end } = getObligationPeriod(o, fiscalYear);
  if (end < COMPANY_FOUNDED_DATE) return "not-applicable";
  if (start < COMPANY_FOUNDED_DATE) return "partial";
  return "normal";
}

/** Days in the obligation's period that the company actually existed */
function daysActiveInPeriod(o: FiscalObligation, fiscalYear: number): number | null {
  const { start, end } = getObligationPeriod(o, fiscalYear);
  const effectiveStart = COMPANY_FOUNDED_DATE > start ? COMPANY_FOUNDED_DATE : start;
  if (effectiveStart > end) return null;
  return Math.ceil((end.getTime() - effectiveStart.getTime()) / 86400000) + 1;
}

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

function getFilingYear(o: FiscalObligation, fiscalYear: number): number {
  // Any January deadline means the filing covers the previous fiscal year (e.g. 303-q4, 390, 349, rgpd)
  if (o.deadlineMonth === 0) return fiscalYear + 1;
  return fiscalYear;
}

function getStatus(o: FiscalObligation, done: Set<string>, fiscalYear: number): Status {
  const impact = getFoundingImpact(o, fiscalYear);
  if (impact === "not-applicable") return "not-applicable";

  if (done.has(`${o.id}:${fiscalYear}`)) return "done";

  if (impact === "partial") {
    // Still a real obligation but mark as partial for awareness
    const now = new Date();
    const fy = getFilingYear(o, fiscalYear);
    const deadline = new Date(fy, o.deadlineMonth, o.deadlineDay);
    const days = Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
    if (days < 0) return "overdue";
    if (days <= 15) return "due-soon";
    if (days <= 60) return "upcoming";
    return "partial-period"; // future but with partial-period context
  }

  const now = new Date();
  const fy = getFilingYear(o, fiscalYear);
  const deadline = new Date(fy, o.deadlineMonth, o.deadlineDay);
  const days = Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 15) return "due-soon";
  if (days <= 60) return "upcoming";
  return "future";
}

function daysUntil(o: FiscalObligation, fiscalYear: number): number {
  const fy = getFilingYear(o, fiscalYear);
  const deadline = new Date(fy, o.deadlineMonth, o.deadlineDay);
  return Math.ceil((deadline.getTime() - Date.now()) / 86400000);
}

function statusLabel(s: Status): { text: string; classes: string } {
  switch (s) {
    case "done":           return { text: "Presentado",       classes: "bg-green-100 text-green-700" };
    case "overdue":        return { text: "VENCIDO",          classes: "bg-red-100 text-red-700 font-semibold" };
    case "due-soon":       return { text: "Urgente",          classes: "bg-amber-100 text-amber-700 font-semibold" };
    case "upcoming":       return { text: "Proximo",          classes: "bg-blue-100 text-blue-700" };
    case "future":         return { text: "Pendiente",        classes: "bg-gray-100 text-gray-500" };
    case "partial-period": return { text: "Periodo parcial",  classes: "bg-amber-50 text-amber-600" };
    case "not-applicable": return { text: "No aplica",        classes: "bg-gray-100 text-gray-400" };
  }
}

/* ------------------------------------------------------------------ */
/*  Style maps                                                         */
/* ------------------------------------------------------------------ */

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  iva:        { bg: "bg-red-50",     text: "text-red-700"     },
  irpf:       { bg: "bg-orange-50",  text: "text-orange-700"  },
  anual:      { bg: "bg-blue-50",    text: "text-blue-700"    },
  societario: { bg: "bg-purple-50",  text: "text-purple-700"  },
  legal:      { bg: "bg-emerald-50", text: "text-emerald-700" },
};

const CATEGORY_LABELS: Record<string, string> = {
  iva: "IVA", irpf: "IRPF", anual: "Anuales", societario: "Societario", legal: "Legal",
};

const MONTH_NAMES_SHORT = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

/* ------------------------------------------------------------------ */
/*  AI system prompt                                                   */
/* ------------------------------------------------------------------ */

const TAX_SYSTEM = `Eres un asesor fiscal especializado en fiscalidad espanola para PLOTWELL, S.L.U. (NIF: B26924068, Madrid).
Empresa de nueva creacion, constituida el 11 de marzo de 2026. Software SaaS B2C. Ingresos via Stripe (suscripciones mensuales/anuales en EUR).
IS al 15% los dos primeros ejercicios. IVA 21%. Sin empleados por ahora.
El primer ejercicio fiscal empezo el 11/03/2026, por tanto el Q1 2026 es un periodo PARCIAL (solo desde el 11/03).
Responde en espanol. Se conciso y practico. Usa bullet points. Da pasos concretos y accionables.`;

/* ------------------------------------------------------------------ */
/*  Storage keys                                                       */
/* ------------------------------------------------------------------ */

const COMPLETIONS_KEY  = "plotwell-accountability-done";
const AI_CACHE_PREFIX  = "plotwell-accountability-ai-v2";
const PROJECTIONS_KEY  = "plotwell-accountability-projections";
const AI_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
  const now = new Date();
  const currentFiscalYear = now.getFullYear();

  const [topTab, setTopTab]       = useState<TopTab>("dashboard");
  const [fiscalYear, setFiscalYear] = useState(currentFiscalYear);
  const [doneSet, setDoneSet]     = useState<Set<string>>(new Set());
  const [aiAnalysis, setAiAnalysis]   = useState("");
  const [aiAnalysisTs, setAiAnalysisTs] = useState<number | null>(null);
  const [aiLoading, setAiLoading]     = useState(false);
  const [expandedObligation, setExpandedObligation] = useState<string | null>(null);
  const [obligationAI, setObligationAI]             = useState<Record<string, string>>({});
  const [obligationAILoading, setObligationAILoading] = useState<string | null>(null);
  const aiRanForYear = useRef<number | null>(null);

  // Projections state
  const [projRevenueGross, setProjRevenueGross] = useState("");
  const [projExpenses, setProjExpenses]         = useState("");
  const [projIVACollected, setProjIVACollected] = useState("");
  const [projIVADeductible, setProjIVADeductible] = useState("");
  const [projAIInsight, setProjAIInsight]       = useState("");
  const [projAILoading, setProjAILoading]       = useState(false);

  // Load persisted data
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COMPLETIONS_KEY);
      if (saved) setDoneSet(new Set(JSON.parse(saved)));
    } catch { /**/ }
    try {
      const p = JSON.parse(localStorage.getItem(PROJECTIONS_KEY) || "{}");
      if (p.revenue)      setProjRevenueGross(p.revenue);
      if (p.expenses)     setProjExpenses(p.expenses);
      if (p.ivaCollected) setProjIVACollected(p.ivaCollected);
      if (p.ivaDeductible) setProjIVADeductible(p.ivaDeductible);
    } catch { /**/ }
  }, []);

  // Save completions
  useEffect(() => {
    localStorage.setItem(COMPLETIONS_KEY, JSON.stringify([...doneSet]));
  }, [doneSet]);

  // Save projections
  useEffect(() => {
    localStorage.setItem(PROJECTIONS_KEY, JSON.stringify({
      revenue: projRevenueGross, expenses: projExpenses,
      ivaCollected: projIVACollected, ivaDeductible: projIVADeductible,
    }));
  }, [projRevenueGross, projExpenses, projIVACollected, projIVADeductible]);

  const toggleDone = useCallback((id: string) => {
    const key = `${id}:${fiscalYear}`;
    setDoneSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [fiscalYear]);

  // Filter to applicable fiscal year
  const allObligations = useMemo(
    () => OBLIGATIONS.filter((o) => fiscalYear >= o.firstYear),
    [fiscalYear]
  );

  // Separate not-applicable from the main list
  const { activeObligations, notApplicable } = useMemo(() => {
    const active: FiscalObligation[] = [];
    const na:     FiscalObligation[] = [];
    for (const o of allObligations) {
      if (getFoundingImpact(o, fiscalYear) === "not-applicable") na.push(o);
      else active.push(o);
    }
    return { activeObligations: active, notApplicable: na };
  }, [allObligations, fiscalYear]);

  // Split active obligations into action-needed / completed / future
  const { actionNeeded, completed, future } = useMemo(() => {
    const action: (FiscalObligation & { status: Status })[] = [];
    const done:   (FiscalObligation & { status: Status })[] = [];
    const rest:   (FiscalObligation & { status: Status })[] = [];

    for (const o of activeObligations) {
      const s = getStatus(o, doneSet, fiscalYear);
      const item = { ...o, status: s };
      if (s === "done") done.push(item);
      else if (s === "overdue" || s === "due-soon" || s === "upcoming") action.push(item);
      else rest.push(item); // future + partial-period
    }

    const order: Record<Status, number> = {
      overdue: 0, "due-soon": 1, upcoming: 2, "partial-period": 3, future: 4, done: 5, "not-applicable": 6,
    };
    action.sort((a, b) => order[a.status] - order[b.status]);
    return { actionNeeded: action, completed: done, future: rest };
  }, [activeObligations, doneSet, fiscalYear]);

  const stats = useMemo(() => ({
    total:   activeObligations.length,
    done:    completed.length,
    action:  actionNeeded.length,
    overdue: actionNeeded.filter((o) => o.status === "overdue").length,
  }), [activeObligations, actionNeeded, completed]);

  // Build AI analysis prompt with rich context
  const buildAnalysisPrompt = useCallback(() => {
    const today = now.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
    const partialOnes = activeObligations.filter(o => getFoundingImpact(o, fiscalYear) === "partial");
    const pending = actionNeeded.map((o) =>
      `- ${o.title} (plazo: ${o.deadlineDay}/${o.deadlineMonth + 1}, ${daysUntil(o, fiscalYear)} dias) [${o.status}]`
    ).join("\n");
    const partialNote = partialOnes.length > 0
      ? `\nObligaciones periodo parcial (empresa constituida 11/03/2026, Q1 afectado):\n${partialOnes.map(o => `- ${o.title}`).join("\n")}`
      : "";
    const projNote = projRevenueGross
      ? `\nDatos financieros estimados ${fiscalYear}:\n- Ingresos brutos: ${projRevenueGross} EUR\n- Gastos deducibles: ${projExpenses || "desconocido"} EUR\n- IVA repercutido: ${projIVACollected || "desconocido"} EUR\n- IVA soportado: ${projIVADeductible || "desconocido"} EUR`
      : "";

    return `Hoy es ${today}. Ejercicio fiscal ${fiscalYear}.
${fiscalYear === 2026 ? "PRIMER EJERCICIO: empresa constituida 11/03/2026. Primer trimestre es periodo parcial." : ""}
IS aplicable: ${fiscalYear <= IS_REDUCED_UNTIL ? "15% (empresa nueva)" : "25%"}.

Obligaciones pendientes (${actionNeeded.length}):
${pending || "(ninguna pendiente)"}
${partialNote}${projNote}

Completadas: ${completed.length}/${activeObligations.length}

Analisis que necesito:
1. Que hacer AHORA (esta semana/mes)
2. Preparacion para la proxima obligacion
3. Riesgos o plazos criticos a no perder
4. Consideraciones especiales por ser primer ejercicio / periodo parcial (si aplica)
5. Estimacion IS si tengo datos financieros

Responde en bullet points. Muy conciso. No repitas lo obvio.`;
  }, [actionNeeded, completed, activeObligations, fiscalYear, projRevenueGross, projExpenses, projIVACollected, projIVADeductible, now]);

  // Cache helpers (localStorage + 24h TTL)
  const readAiCache = useCallback((year: number): { text: string; ts: number } | null => {
    try {
      const raw = localStorage.getItem(`${AI_CACHE_PREFIX}-${year}`);
      if (!raw) return null;
      const { ts, text } = JSON.parse(raw);
      if (Date.now() - ts > AI_CACHE_TTL_MS) { localStorage.removeItem(`${AI_CACHE_PREFIX}-${year}`); return null; }
      return { text: text as string, ts: ts as number };
    } catch { return null; }
  }, []);

  const writeAiCache = useCallback((year: number, text: string) => {
    try { localStorage.setItem(`${AI_CACHE_PREFIX}-${year}`, JSON.stringify({ ts: Date.now(), text })); } catch { /**/ }
  }, []);

  const clearAiCache = useCallback((year: number) => {
    try { localStorage.removeItem(`${AI_CACHE_PREFIX}-${year}`); } catch { /**/ }
  }, []);

  // Auto AI analysis on mount / fiscal year change (localStorage-cached, 24h TTL)
  useEffect(() => {
    if (aiRanForYear.current === fiscalYear) return;
    const cached = readAiCache(fiscalYear);
    if (cached) { setAiAnalysis(cached.text); setAiAnalysisTs(cached.ts); aiRanForYear.current = fiscalYear; return; }

    // Small delay to avoid running before state settles
    const t = setTimeout(async () => {
      aiRanForYear.current = fiscalYear;
      setAiLoading(true);
      setAiAnalysis("");
      try {
        const result = await generate(buildAnalysisPrompt(), { system: TAX_SYSTEM, maxTokens: 1024, temperature: 0.3 });
        const now2 = Date.now();
        setAiAnalysis(result);
        setAiAnalysisTs(now2);
        writeAiCache(fiscalYear, result);
      } catch (err) {
        setAiAnalysis(`Error: ${err instanceof Error ? err.message : "Error desconocido"}`);
      } finally {
        setAiLoading(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [fiscalYear]); // intentionally NOT including buildAnalysisPrompt to avoid re-runs on every keystroke

  const refreshAiAnalysis = useCallback(async () => {
    clearAiCache(fiscalYear);
    aiRanForYear.current = null;
    setAiLoading(true);
    setAiAnalysis("");
    setAiAnalysisTs(null);
    try {
      const result = await generate(buildAnalysisPrompt(), { system: TAX_SYSTEM, maxTokens: 1024, temperature: 0.3 });
      const now2 = Date.now();
      setAiAnalysis(result);
      setAiAnalysisTs(now2);
      writeAiCache(fiscalYear, result);
    } catch (err) {
      setAiAnalysis(`Error: ${err instanceof Error ? err.message : "Error desconocido"}`);
    } finally {
      setAiLoading(false);
    }
  }, [buildAnalysisPrompt, fiscalYear, clearAiCache, writeAiCache]);

  // Per-obligation AI guidance
  const loadObligationAI = useCallback(async (o: FiscalObligation) => {
    if (obligationAI[o.id]) { setExpandedObligation(o.id); return; }
    setObligationAILoading(o.id);
    setExpandedObligation(o.id);
    const impact = getFoundingImpact(o, fiscalYear);
    const daysActive = impact === "partial" ? daysActiveInPeriod(o, fiscalYear) : null;
    const prompt = `Obligacion: ${o.title} (${o.description})
Empresa: PLOTWELL S.L.U., constituida 11/03/2026, SaaS, ingresos Stripe.
Ejercicio: ${fiscalYear}. Estado: ${getStatus(o, doneSet, fiscalYear)}.
${impact === "partial" && daysActive ? `Periodo parcial: empresa activa solo ${daysActive} dias de este trimestre.` : ""}
${projRevenueGross ? `Ingresos estimados anuales: ${projRevenueGross} EUR.` : ""}

Explica brevemente:
1. Documentos y datos que necesito para presentar esta obligacion
2. Importes o calculos clave a realizar
3. Errores tipicos o cosas a vigilar
${impact === "partial" ? "4. Como declarar un trimestre parcial por inicio de actividad" : ""}

Muy conciso. Bullet points.`;

    try {
      const result = await generate(prompt, { system: TAX_SYSTEM, maxTokens: 768, temperature: 0.2 });
      setObligationAI((prev) => ({ ...prev, [o.id]: result }));
    } catch (err) {
      setObligationAI((prev) => ({ ...prev, [o.id]: `Error: ${err instanceof Error ? err.message : "Error"}` }));
    } finally {
      setObligationAILoading(null);
    }
  }, [obligationAI, fiscalYear, doneSet, projRevenueGross]);

  // Projections computed
  const projComputed = useMemo(() => {
    const revenue  = parseFloat(projRevenueGross)  || 0;
    const expenses = parseFloat(projExpenses)       || 0;
    const ivaIn    = parseFloat(projIVACollected)   || 0;
    const ivaOut   = parseFloat(projIVADeductible)  || 0;

    const isRate = fiscalYear <= IS_REDUCED_UNTIL ? IS_RATE_REDUCED : IS_RATE_NORMAL;
    const profit    = Math.max(0, revenue - expenses);
    const isBase    = profit;
    const isOwed    = isBase * isRate;
    const ivaNet    = ivaIn - ivaOut;
    const ivaAuto   = revenue > 0 && ivaIn === 0 ? revenue * IVA_RATE : null;

    return { revenue, expenses, profit, isRate, isBase, isOwed, ivaNet, ivaAuto, ivaIn, ivaOut };
  }, [projRevenueGross, projExpenses, projIVACollected, projIVADeductible, fiscalYear]);

  const runProjectionsAI = useCallback(async () => {
    setProjAILoading(true);
    setProjAIInsight("");
    const { revenue, expenses, profit, isRate, isOwed, ivaNet } = projComputed;
    const prompt = `Datos financieros PLOTWELL S.L.U. ejercicio ${fiscalYear}:
- Ingresos brutos estimados: ${revenue.toFixed(2)} EUR
- Gastos deducibles estimados: ${expenses.toFixed(2)} EUR
- Beneficio estimado: ${profit.toFixed(2)} EUR
- IS estimado (${(isRate * 100).toFixed(0)}%): ${isOwed.toFixed(2)} EUR
- Posicion IVA neta (repercutido - soportado): ${ivaNet.toFixed(2)} EUR ${ivaNet > 0 ? "(a ingresar)" : "(a devolver/compensar)"}
${fiscalYear === 2026 ? "Primer ejercicio parcial (desde 11/03/2026)." : ""}

Dame:
1. Confirmacion de si los numeros parecen coherentes para un SaaS
2. Estrategias legales de optimizacion fiscal antes de cierre del ejercicio
3. Provisiones que debo apartar ahora mismo
4. Cualquier deduccion tipica de software SaaS que no deba perderme

Bullet points. Muy practico.`;

    try {
      const result = await generate(prompt, { system: TAX_SYSTEM, maxTokens: 1024, temperature: 0.3 });
      setProjAIInsight(result);
    } catch (err) {
      setProjAIInsight(`Error: ${err instanceof Error ? err.message : "Error"}`);
    } finally {
      setProjAILoading(false);
    }
  }, [projComputed, fiscalYear]);

  const yearOptions = Array.from({ length: 4 }, (_, i) => currentFiscalYear + 1 - i);
  const isFoundingYear = fiscalYear === COMPANY_FOUNDED_DATE.getFullYear();

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  return (
    <ToolPage title="Accountability" description="PLOTWELL S.L.U. / B26924068 / Madrid">
      {/* Top tabs */}
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1">
        {([
          ["dashboard",     "📋 Obligaciones"],
          ["accounting",    "💰 Contabilidad"],
          ["proyecciones",  "📈 Proyecciones"],
        ] as [TopTab, string][]).map(([tab, label]) => (
          <button key={tab} onClick={() => setTopTab(tab)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              topTab === tab ? "bg-white text-amber-700 shadow-sm" : "text-gray-600 hover:text-gray-900"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ---- DASHBOARD TAB ---- */}
      {topTab === "dashboard" && (
        <div className="space-y-5">

          {/* Year selector + stats row */}
          <div className="flex flex-wrap items-center gap-3">
            <select value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium focus:border-amber-500 focus:outline-none">
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>

            <div className="flex items-center gap-2 text-xs">
              {stats.overdue > 0 && <span className="px-2.5 py-1 rounded-full bg-red-100 text-red-700 font-semibold">{stats.overdue} vencidas</span>}
              {stats.action > 0  && <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 font-semibold">{stats.action} pendientes</span>}
              <span className="text-gray-400">{stats.done}/{stats.total} completadas</span>
            </div>

            <div className="flex-1" />

            <button onClick={refreshAiAnalysis} disabled={aiLoading}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 transition-colors">
              {aiLoading ? "Analizando..." : "Actualizar analisis"}
            </button>
          </div>

          {/* Founding year banner */}
          {isFoundingYear && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <span className="text-amber-500 text-base mt-0.5">⚡</span>
              <div className="text-sm">
                <span className="font-semibold text-amber-800">Primer ejercicio fiscal</span>
                <span className="text-amber-700"> — empresa constituida el 11/03/2026. El Q1 es un periodo parcial (solo desde el 11 de marzo). Las obligaciones marcadas con </span>
                <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-600 font-medium">Periodo parcial</span>
                <span className="text-amber-700"> incluyen solo la actividad desde la constitucion.</span>
              </div>
            </div>
          )}

          {/* AI Analysis (auto-displayed) */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-amber-600 text-sm font-semibold">Analisis fiscal IA</span>
              {!aiLoading && aiAnalysis && aiAnalysisTs && (
                <span className="text-[10px] text-amber-400">
                  {new Date(aiAnalysisTs).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {" · "}{Math.round((Date.now() - aiAnalysisTs) / 60000) < 60
                    ? `hace ${Math.round((Date.now() - aiAnalysisTs) / 60000)}m`
                    : Math.round((Date.now() - aiAnalysisTs) / 3600000) < 24
                      ? `hace ${Math.round((Date.now() - aiAnalysisTs) / 3600000)}h`
                      : "ayer"}
                </span>
              )}
            </div>
            {aiLoading ? (
              <div className="flex items-center gap-3 text-sm text-amber-700">
                <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                Analizando obligaciones fiscales...
              </div>
            ) : aiAnalysis ? (
              <AIMarkdown text={aiAnalysis} />
            ) : (
              <p className="text-sm text-amber-600 italic">Cargando analisis...</p>
            )}
          </div>

          {/* Progress bar */}
          <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3">
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all duration-500"
                style={{ width: `${stats.total > 0 ? (stats.done / stats.total) * 100 : 0}%` }} />
            </div>
            <span className="text-sm font-bold text-gray-700 tabular-nums">
              {stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0}%
            </span>
          </div>

          {/* ACTION NEEDED */}
          {actionNeeded.length > 0 && (
            <ObligationGroup title="Requiere accion" headerClass="bg-amber-50 border-amber-100 text-amber-800">
              {actionNeeded.map((o) => (
                <ObligationRow key={o.id} obligation={o} status={o.status} fiscalYear={fiscalYear}
                  onToggle={() => toggleDone(o.id)}
                  onAI={() => loadObligationAI(o)}
                  aiExpanded={expandedObligation === o.id}
                  aiContent={obligationAI[o.id]}
                  aiLoading={obligationAILoading === o.id}
                  onCloseAI={() => setExpandedObligation(null)}
                />
              ))}
            </ObligationGroup>
          )}

          {/* ALL CLEAR */}
          {actionNeeded.length === 0 && stats.done > 0 && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-center">
              <p className="text-green-700 font-semibold">Todo al dia</p>
              <p className="text-sm text-green-600 mt-1">No hay obligaciones pendientes por el momento.</p>
            </div>
          )}

          {/* FUTURE */}
          {future.length > 0 && (
            <ObligationGroup title="Proximas / Pendientes" headerClass="bg-gray-50 border-gray-100 text-gray-600">
              {future.map((o) => (
                <ObligationRow key={o.id} obligation={o} status={o.status} fiscalYear={fiscalYear}
                  onToggle={() => toggleDone(o.id)}
                  onAI={() => loadObligationAI(o)}
                  aiExpanded={expandedObligation === o.id}
                  aiContent={obligationAI[o.id]}
                  aiLoading={obligationAILoading === o.id}
                  onCloseAI={() => setExpandedObligation(null)}
                />
              ))}
            </ObligationGroup>
          )}

          {/* COMPLETED */}
          {completed.length > 0 && (
            <ObligationGroup title={`Completadas (${completed.length})`} headerClass="bg-gray-50 border-gray-100 text-gray-400">
              {completed.map((o) => (
                <ObligationRow key={o.id} obligation={o} status="done" fiscalYear={fiscalYear}
                  onToggle={() => toggleDone(o.id)}
                  onAI={() => loadObligationAI(o)}
                  aiExpanded={expandedObligation === o.id}
                  aiContent={obligationAI[o.id]}
                  aiLoading={obligationAILoading === o.id}
                  onCloseAI={() => setExpandedObligation(null)}
                />
              ))}
            </ObligationGroup>
          )}

          {/* NOT APPLICABLE */}
          {notApplicable.length > 0 && (
            <details className="rounded-xl border border-gray-100 overflow-hidden">
              <summary className="px-5 py-3 bg-gray-50 text-xs font-medium text-gray-400 cursor-pointer select-none">
                No aplica en {fiscalYear} ({notApplicable.length}) — empresa no constituida durante este periodo
              </summary>
              <div className="divide-y divide-gray-50">
                {notApplicable.map((o) => (
                  <div key={o.id} className="flex items-center gap-3 px-5 py-2.5 opacity-40">
                    <div className="w-5 h-5 rounded border-2 border-gray-200 shrink-0" />
                    <span className="text-sm text-gray-500 line-through">{o.title}</span>
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">No aplica</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ---- ACCOUNTING TAB ---- */}
      {topTab === "accounting" && <AccountingApp embedded />}

      {/* ---- PROYECCIONES TAB ---- */}
      {topTab === "proyecciones" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-gray-800">Estimaciones {fiscalYear}</h3>
              <select value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}
                className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none">
                {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              {isFoundingYear && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-600">Primer ejercicio (desde 11/03)</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ProjectionInput label="Ingresos brutos (EUR)" value={projRevenueGross} onChange={setProjRevenueGross} placeholder="ej. 12000" hint="Sin IVA" />
              <ProjectionInput label="Gastos deducibles (EUR)" value={projExpenses} onChange={setProjExpenses} placeholder="ej. 3500" hint="Hosting, software, etc." />
              <ProjectionInput label="IVA repercutido (EUR)" value={projIVACollected} onChange={setProjIVACollected} placeholder="ej. 2520" hint="IVA cobrado a clientes" />
              <ProjectionInput label="IVA soportado (EUR)" value={projIVADeductible} onChange={setProjIVADeductible} placeholder="ej. 630" hint="IVA pagado en gastos" />
            </div>
          </div>

          {/* Computed KPIs */}
          {projComputed.revenue > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KPICard label="Beneficio estimado" value={`${projComputed.profit.toFixed(0)} €`}
                sub={`${projComputed.revenue.toFixed(0)} - ${projComputed.expenses.toFixed(0)}`}
                color={projComputed.profit > 0 ? "green" : "red"} />
              <KPICard
                label={`IS estimado (${(projComputed.isRate * 100).toFixed(0)}%)`}
                value={`${projComputed.isOwed.toFixed(0)} €`}
                sub={fiscalYear <= IS_REDUCED_UNTIL ? "Tipo reducido empresa nueva" : "Tipo general"}
                color="blue" />
              <KPICard
                label="IVA a ingresar/devolver"
                value={`${Math.abs(projComputed.ivaNet).toFixed(0)} €`}
                sub={projComputed.ivaNet >= 0 ? "A ingresar en Hacienda" : "A compensar/devolver"}
                color={projComputed.ivaNet >= 0 ? "amber" : "purple"} />
              <KPICard
                label="Provision mensual IS"
                value={`${(projComputed.isOwed / 12).toFixed(0)} €/mes`}
                sub="Apartar cada mes para IS"
                color="gray" />
            </div>
          )}

          {projComputed.revenue === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">Introduce ingresos brutos para ver las estimaciones.</p>
          )}

          {projComputed.ivaAuto !== null && projIVACollected === "" && projComputed.revenue > 0 && (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
              IVA repercutido estimado automaticamente al 21%: {projComputed.ivaAuto.toFixed(2)} EUR. Introduce el valor real si lo tienes.
            </div>
          )}

          {/* AI Insight for projections */}
          {projComputed.revenue > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">Planificacion fiscal IA</span>
                <button onClick={runProjectionsAI} disabled={projAILoading}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors">
                  {projAILoading ? "Analizando..." : "Analizar"}
                </button>
              </div>
              {projAILoading && (
                <div className="flex items-center gap-2 text-sm text-amber-600">
                  <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                  Generando recomendaciones...
                </div>
              )}
              {projAIInsight && !projAILoading && (
                <AIMarkdown text={projAIInsight} />
              )}
              {!projAIInsight && !projAILoading && (
                <p className="text-xs text-gray-400">Pulsa Analizar para obtener estrategias de optimizacion fiscal basadas en tus estimaciones.</p>
              )}
            </div>
          )}
        </div>
      )}
    </ToolPage>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ObligationGroup({ title, headerClass, children }: {
  title: string; headerClass: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className={`px-5 py-3 border-b ${headerClass}`}>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}

function ObligationRow({ obligation: o, status, fiscalYear, onToggle, onAI, aiExpanded, aiContent, aiLoading, onCloseAI }: {
  obligation: FiscalObligation;
  status: Status;
  fiscalYear: number;
  onToggle: () => void;
  onAI: () => void;
  aiExpanded: boolean;
  aiContent?: string;
  aiLoading: boolean;
  onCloseAI: () => void;
}) {
  const days    = daysUntil(o, fiscalYear);
  const sl      = statusLabel(status);
  const cat     = CATEGORY_COLORS[o.category];
  const impact  = getFoundingImpact(o, fiscalYear);
  const daysAct = impact === "partial" ? daysActiveInPeriod(o, fiscalYear) : null;

  return (
    <div>
      <div className={`flex items-center gap-3 px-5 py-3 ${status === "overdue" ? "bg-red-50/50" : ""}`}>
        {/* Checkbox */}
        <button onClick={onToggle}
          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
            status === "done"    ? "bg-green-500 border-green-500 text-white" :
            status === "overdue" ? "border-red-400 hover:border-red-500" :
                                   "border-gray-300 hover:border-amber-500"
          }`}>
          {status === "done" && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-medium ${status === "done" ? "line-through text-gray-400" : "text-gray-800"}`}>
              {o.title}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${sl.classes}`}>{sl.text}</span>
            {impact === "partial" && status !== "done" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">
                Periodo parcial{daysAct ? ` (${daysAct} dias activo)` : ""}
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">{o.description}</p>
          {o.note && impact === "partial" && (
            <p className="text-[11px] text-amber-500 mt-0.5">{o.note}</p>
          )}
        </div>

        {/* Meta + AI button */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${cat.bg} ${cat.text}`}>
            {CATEGORY_LABELS[o.category]}
          </span>
          <span className="text-[10px] text-gray-400">
            {o.deadlineDay} {MONTH_NAMES_SHORT[o.deadlineMonth]}
          </span>
          {status !== "done" && status !== "future" && status !== "partial-period" && (
            <span className={`text-[10px] font-medium tabular-nums ${days < 0 ? "text-red-600" : days <= 15 ? "text-amber-600" : "text-blue-600"}`}>
              {days < 0 ? `${Math.abs(days)}d atrasado` : `${days}d`}
            </span>
          )}
          <button onClick={aiExpanded ? onCloseAI : onAI}
            title="Guia IA para esta obligacion"
            className={`rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
              aiExpanded ? "bg-amber-200 text-amber-800" : "bg-gray-100 text-gray-500 hover:bg-amber-100 hover:text-amber-700"
            }`}>
            IA
          </button>
        </div>
      </div>

      {/* Per-obligation AI panel */}
      {aiExpanded && (
        <div className="px-5 pb-4 pt-1 border-t border-gray-50 bg-amber-50/50">
          {aiLoading ? (
            <div className="flex items-center gap-2 text-xs text-amber-600 py-2">
              <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
              Consultando asesor fiscal...
            </div>
          ) : aiContent ? (
            <AIMarkdown text={aiContent} className="text-xs mt-1" />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProjectionInput({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
      {hint && <p className="text-[10px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function KPICard({ label, value, sub, color }: {
  label: string; value: string; sub?: string;
  color: "green" | "red" | "blue" | "amber" | "purple" | "gray";
}) {
  const colors: Record<string, { bg: string; text: string; sub: string }> = {
    green:  { bg: "bg-green-50 border-green-200",   text: "text-green-700",  sub: "text-green-500" },
    red:    { bg: "bg-red-50 border-red-200",        text: "text-red-700",    sub: "text-red-400"   },
    blue:   { bg: "bg-blue-50 border-blue-200",      text: "text-blue-700",   sub: "text-blue-500"  },
    amber:  { bg: "bg-amber-50 border-amber-200",    text: "text-amber-700",  sub: "text-amber-500" },
    purple: { bg: "bg-purple-50 border-purple-200",  text: "text-purple-700", sub: "text-purple-500"},
    gray:   { bg: "bg-gray-50 border-gray-200",      text: "text-gray-700",   sub: "text-gray-400"  },
  };
  const c = colors[color];
  return (
    <div className={`rounded-xl border p-4 ${c.bg}`}>
      <p className="text-[11px] text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${c.text}`}>{value}</p>
      {sub && <p className={`text-[10px] mt-1 ${c.sub}`}>{sub}</p>}
    </div>
  );
}
