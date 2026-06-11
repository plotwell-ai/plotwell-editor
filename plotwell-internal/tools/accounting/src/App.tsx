import { useState, useEffect, useCallback, useRef } from "react";
import { generate } from "@shared/ai-client";
import { ToolPage } from "@shared/components";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Tab = "dashboard" | "modelo303" | "modelo130" | "modelo390" | "facturas" | "gastos";

interface StripeBalanceTransaction {
  fee: number;
  fee_details: { amount: number; type: string; description: string }[];
  net: number;
}

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
  status: string;
  refunded: boolean;
  billing_details?: { email?: string; name?: string };
  description?: string;
  customer?: string;
  receipt_email?: string;
  balance_transaction?: StripeBalanceTransaction;
}

/** Net amount after refunds (in cents) */
function netAmount(c: StripeCharge): number {
  return c.amount - (c.amount_refunded || 0);
}

/** Stripe fee in cents */
function stripeFee(c: StripeCharge): number {
  return c.balance_transaction?.fee || 0;
}

/** Total Stripe fees for a list of charges (in euros) */
function totalStripeFees(charges: StripeCharge[]): number {
  return charges.reduce((s, c) => s + stripeFee(c), 0) / 100;
}

interface Expense {
  id: string;
  fecha: string;
  concepto: string;
  proveedor: string;
  base: number;
  ivaPct: number;
  iva: number;
  total: number;
  categoria: string;
}

type Quarter = 1 | 2 | 3 | 4;

const CATEGORIAS = [
  "Software/SaaS",
  "Hosting/Infra",
  "Marketing",
  "Servicios profesionales",
  "Otros",
];

const IVA_RATE = 0.21;
const IRPF_RATE = 0.20;

const QUARTER_MONTHS: Record<Quarter, [number, number, number]> = {
  1: [0, 1, 2],
  2: [3, 4, 5],
  3: [6, 7, 8],
  4: [9, 10, 11],
};

const QUARTER_DEADLINES: Record<Quarter, string> = {
  1: "1 - 20 de abril",
  2: "1 - 20 de julio",
  3: "1 - 20 de octubre",
  4: "1 - 30 de enero (siguiente ano)",
};

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const fmt = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

function getQuarterRange(quarter: Quarter, year: number): { gte: number; lte: number } {
  const months = QUARTER_MONTHS[quarter];
  const gte = Math.floor(new Date(year, months[0], 1).getTime() / 1000);
  const lte = Math.floor(new Date(year, months[2] + 1, 0, 23, 59, 59).getTime() / 1000);
  return { gte, lte };
}

function getYearRange(year: number): { gte: number; lte: number } {
  const gte = Math.floor(new Date(year, 0, 1).getTime() / 1000);
  const lte = Math.floor(new Date(year, 11, 31, 23, 59, 59).getTime() / 1000);
  return { gte, lte };
}

function loadExpenses(): Expense[] {
  try {
    const raw = localStorage.getItem("plotwell_gastos");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveExpenses(expenses: Expense[]) {
  localStorage.setItem("plotwell_gastos", JSON.stringify(expenses));
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ------------------------------------------------------------------ */
/*  Stripe API                                                         */
/* ------------------------------------------------------------------ */

const STRIPE_KEY = import.meta.env.VITE_STRIPE_SECRET_KEY || "";

async function fetchStripeCharges(gte: number, lte: number): Promise<StripeCharge[]> {
  if (!STRIPE_KEY) return [];
  const all: StripeCharge[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      "created[gte]": gte.toString(),
      "created[lte]": lte.toString(),
      "expand[]": "data.balance_transaction",
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await fetch(`/stripe-api/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${STRIPE_KEY}` },
    });

    if (!res.ok) {
      console.error("Stripe API error:", res.status, await res.text());
      break;
    }

    const json = await res.json();
    const charges: StripeCharge[] = (json.data || []).filter(
      (c: StripeCharge) => c.status === "succeeded" && !c.refunded
    );
    all.push(...charges);
    hasMore = json.has_more;
    if (hasMore && charges.length > 0) {
      startingAfter = charges[charges.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  return all;
}

/* ------------------------------------------------------------------ */
/*  Shared components                                                  */
/* ------------------------------------------------------------------ */

function MetricCard({
  label,
  value,
  color = "text-slate-900",
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-slate-700 mb-3">{children}</h3>;
}

function DeadlineBadge({ quarter }: { quarter: Quarter }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700">
      <span>Plazo: {QUARTER_DEADLINES[quarter]}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 1: Dashboard                                                   */
/* ------------------------------------------------------------------ */

function DashboardTab({
  charges,
  expenses,
  quarter,
  year,
  loading,
}: {
  charges: StripeCharge[];
  expenses: Expense[];
  quarter: Quarter;
  year: number;
  loading: boolean;
}) {
  const months = QUARTER_MONTHS[quarter];
  const ingresosBrutos = charges.reduce((s, c) => s + netAmount(c), 0) / 100;
  const comisionesStripe = totalStripeFees(charges);
  const baseImponible = ingresosBrutos / (1 + IVA_RATE);
  const ivaRepercutido = ingresosBrutos - baseImponible;

  const qExpenses = expenses.filter((e) => {
    const d = new Date(e.fecha);
    return d.getFullYear() === year && months.includes(d.getMonth());
  });
  const gastosDeducibles = qExpenses.reduce((s, e) => s + e.base, 0);
  const resultadoNeto = baseImponible - gastosDeducibles - comisionesStripe;

  // Monthly breakdown
  const monthlyData = months.map((m) => {
    const mCharges = charges.filter((c) => new Date(c.created * 1000).getMonth() === m);
    return {
      month: MONTH_NAMES[m],
      total: mCharges.reduce((s, c) => s + netAmount(c), 0) / 100,
    };
  });
  const maxMonthly = Math.max(...monthlyData.map((d) => d.total), 1);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Total facturado" value={fmt(ingresosBrutos)} color="text-slate-900" sub={`${charges.length} operaciones`} />
        <MetricCard label="Base imponible" value={fmt(baseImponible)} />
        <MetricCard label="IVA repercutido (21%)" value={fmt(ivaRepercutido)} color="text-amber-700" />
        <MetricCard label="Comisiones Stripe" value={fmt(comisionesStripe)} color="text-red-600" sub={charges.length > 0 ? `~${(comisionesStripe / ingresosBrutos * 100).toFixed(1)}% del total` : undefined} />
        <MetricCard label="Gastos deducibles" value={fmt(gastosDeducibles)} color="text-red-600" sub={`${qExpenses.length} gastos`} />
        <MetricCard label="IVA a ingresar" value={fmt(ivaRepercutido - qExpenses.reduce((s, e) => s + e.iva, 0))} color="text-red-600" />
        <MetricCard label="Ingreso neto (post-Stripe)" value={fmt(ingresosBrutos - comisionesStripe)} color="text-blue-600" sub="Facturado menos comisiones" />
        <MetricCard label="Resultado neto" value={fmt(resultadoNeto)} color={resultadoNeto >= 0 ? "text-green-600" : "text-red-600"} />
      </div>

      {/* Monthly chart */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <SectionTitle>Ingresos mensuales - Q{quarter} {year}</SectionTitle>
        <div className="flex items-end gap-4 h-40 mt-4">
          {monthlyData.map((d) => (
            <div key={d.month} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-xs font-medium text-slate-600">{fmt(d.total)}</span>
              <div
                className="w-full bg-amber-500 rounded-t transition-all duration-500"
                style={{ height: `${(d.total / maxMonthly) * 100}%`, minHeight: d.total > 0 ? "4px" : "0" }}
              />
              <span className="text-xs text-slate-500">{d.month.slice(0, 3)}</span>
            </div>
          ))}
        </div>
      </div>

      {!STRIPE_KEY && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          Configura <code className="bg-amber-100 px-1 rounded">VITE_STRIPE_SECRET_KEY</code> en <code className="bg-amber-100 px-1 rounded">.env.local</code> para cargar datos reales de Stripe.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 2: Modelo 303                                                  */
/* ------------------------------------------------------------------ */

function Modelo303Tab({
  charges,
  expenses,
  quarter,
  year,
}: {
  charges: StripeCharge[];
  expenses: Expense[];
  quarter: Quarter;
  year: number;
}) {
  const months = QUARTER_MONTHS[quarter];
  const ingresosBrutos = charges.reduce((s, c) => s + netAmount(c), 0) / 100;
  const baseImponible = +(ingresosBrutos / (1 + IVA_RATE)).toFixed(2);
  const cuotaRepercutido = +(baseImponible * IVA_RATE).toFixed(2);
  const numOperaciones = charges.length;

  const qExpenses = expenses.filter((e) => {
    const d = new Date(e.fecha);
    return d.getFullYear() === year && months.includes(d.getMonth());
  });
  const baseSoportado = qExpenses.reduce((s, e) => s + e.base, 0);
  const ivaSoportado = qExpenses.reduce((s, e) => s + e.iva, 0);
  const diferencia = +(cuotaRepercutido - ivaSoportado).toFixed(2);

  const copyData = () => {
    const text = [
      `MODELO 303 - Q${quarter} ${year}`,
      `PLOTWELL, S.L.U. - NIF: B26924068`,
      ``,
      `IVA DEVENGADO (Regimen general)`,
      `Casilla 01 - Num. operaciones: ${numOperaciones}`,
      `Casilla 02 - Base imponible: ${baseImponible.toFixed(2)}`,
      `Casilla 03 - Cuota: ${cuotaRepercutido.toFixed(2)}`,
      ``,
      `IVA DEDUCIBLE`,
      `Casilla 04 - Num. operaciones: ${qExpenses.length}`,
      `Casilla 05 - Base imponible: ${baseSoportado.toFixed(2)}`,
      `Casilla 06 - Cuota: ${ivaSoportado.toFixed(2)}`,
      ``,
      `RESULTADO`,
      `Casilla 07 - Diferencia: ${diferencia.toFixed(2)}`,
      `Resultado: ${diferencia >= 0 ? "A ingresar" : "A devolver"}: ${Math.abs(diferencia).toFixed(2)} EUR`,
    ].join("\n");
    navigator.clipboard.writeText(text);
  };

  const exportPDF = () => {
    const monthStart = MONTH_NAMES[months[0]];
    const monthEnd = MONTH_NAMES[months[2]];
    const deadline = QUARTER_DEADLINES[quarter];
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Modelo 303 - Q${quarter} ${year}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5; }
  h1 { font-size: 16pt; margin-bottom: 4px; }
  h2 { font-size: 12pt; margin: 20px 0 8px; color: #334155; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .header { text-align: center; margin-bottom: 24px; border-bottom: 3px solid #d97706; padding-bottom: 12px; }
  .header p { font-size: 9pt; color: #64748b; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; font-size: 10pt; }
  th { background: #f8fafc; font-weight: 600; color: #475569; }
  td.num { text-align: right; font-family: "JetBrains Mono", "Courier New", monospace; }
  .result-row td { font-weight: 700; font-size: 11pt; }
  .result-positive td { background: #fef2f2; color: #dc2626; }
  .result-negative td { background: #f0fdf4; color: #16a34a; }
  .period { font-size: 9pt; color: #64748b; margin: 12px 0; }
  .footer { margin-top: 32px; text-align: center; font-size: 8pt; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>Modelo 303 - Autoliquidacion IVA</h1>
    <p><strong>PLOTWELL, S.L.U.</strong> &mdash; NIF: B26924068 &mdash; Madrid</p>
    <p>Trimestre ${quarter}T ${year} (${monthStart} - ${monthEnd})</p>
  </div>

  <div class="period">
    <strong>Periodo de liquidacion:</strong> ${monthStart} - ${monthEnd} ${year} &nbsp;|&nbsp;
    <strong>Plazo de presentacion:</strong> ${deadline}
  </div>

  <h2>IVA Devengado - Regimen general</h2>
  <table>
    <thead>
      <tr><th>Casilla</th><th>Concepto</th><th style="text-align:right">Valor</th></tr>
    </thead>
    <tbody>
      <tr><td>01</td><td>Numero de operaciones</td><td class="num">${numOperaciones}</td></tr>
      <tr><td>02</td><td>Base imponible</td><td class="num">${baseImponible.toFixed(2)} EUR</td></tr>
      <tr><td>03</td><td>Cuota devengada (21%)</td><td class="num">${cuotaRepercutido.toFixed(2)} EUR</td></tr>
    </tbody>
  </table>

  <h2>IVA Deducible</h2>
  <table>
    <thead>
      <tr><th>Casilla</th><th>Concepto</th><th style="text-align:right">Valor</th></tr>
    </thead>
    <tbody>
      <tr><td>04</td><td>Numero de operaciones</td><td class="num">${qExpenses.length}</td></tr>
      <tr><td>05</td><td>Base imponible</td><td class="num">${baseSoportado.toFixed(2)} EUR</td></tr>
      <tr><td>06</td><td>Cuota soportada</td><td class="num">${ivaSoportado.toFixed(2)} EUR</td></tr>
    </tbody>
  </table>

  <h2>Resultado</h2>
  <table>
    <thead>
      <tr><th>Casilla</th><th>Concepto</th><th style="text-align:right">Valor</th></tr>
    </thead>
    <tbody>
      <tr><td>07</td><td>Diferencia (Casilla 03 - Casilla 06)</td><td class="num">${diferencia.toFixed(2)} EUR</td></tr>
      <tr class="result-row ${diferencia >= 0 ? "result-positive" : "result-negative"}">
        <td></td>
        <td>${diferencia >= 0 ? "A ingresar" : "A devolver"}</td>
        <td class="num">${Math.abs(diferencia).toFixed(2)} EUR</td>
      </tr>
    </tbody>
  </table>

  <div class="footer">
    Generated by plotwell internal tools &mdash; ${new Date().toLocaleDateString("es-ES")}
  </div>
</body>
</html>`;
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    iframe.contentDocument?.write(html);
    iframe.contentDocument?.close();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 1000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Modelo 303 - IVA Trimestral</h3>
          <p className="text-sm text-slate-500">PLOTWELL, S.L.U. / NIF: B26924068</p>
        </div>
        <DeadlineBadge quarter={quarter} />
      </div>

      {/* IVA Devengado */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        <SectionTitle>IVA Devengado - Regimen general</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          <CasillaField label="Casilla 01" desc="N. operaciones" value={numOperaciones.toString()} />
          <CasillaField label="Casilla 02" desc="Base imponible" value={fmt(baseImponible)} />
          <CasillaField label="Casilla 03" desc="Cuota (21%)" value={fmt(cuotaRepercutido)} />
        </div>
      </div>

      {/* IVA Deducible */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        <SectionTitle>IVA Deducible</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          <CasillaField label="Casilla 04" desc="N. operaciones" value={qExpenses.length.toString()} />
          <CasillaField label="Casilla 05" desc="Base imponible" value={fmt(baseSoportado)} />
          <CasillaField label="Casilla 06" desc="Cuota soportada" value={fmt(ivaSoportado)} />
        </div>
        <p className="text-xs text-slate-400">Los datos de IVA soportado se calculan desde la pestana Gastos.</p>
      </div>

      {/* Resultado */}
      <div className={`rounded-lg border p-5 ${diferencia >= 0 ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"}`}>
        <div className="grid grid-cols-2 gap-4">
          <CasillaField label="Casilla 07" desc="Diferencia" value={fmt(diferencia)} />
          <div>
            <p className="text-xs font-medium text-slate-500">Resultado</p>
            <p className={`text-xl font-bold ${diferencia >= 0 ? "text-red-600" : "text-green-600"}`}>
              {diferencia >= 0 ? "A ingresar" : "A devolver"}: {fmt(Math.abs(diferencia))}
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={copyData}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors"
        >
          Copiar datos
        </button>
        <button
          onClick={exportPDF}
          className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
        >
          Descargar PDF
        </button>
      </div>
    </div>
  );
}

function CasillaField({ label, desc, value }: { label: string; desc: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-bold text-amber-700">{label}</p>
      <p className="text-xs text-slate-500">{desc}</p>
      <p className="mt-1 text-base font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 3: Modelo 130                                                  */
/* ------------------------------------------------------------------ */

function Modelo130Tab({
  charges,
  expenses,
  quarter,
  year,
}: {
  charges: StripeCharge[];
  expenses: Expense[];
  quarter: Quarter;
  year: number;
}) {
  const [esAutonomo, setEsAutonomo] = useState(false);
  const [pagosAnteriores, setPagosAnteriores] = useState(0);

  const months = QUARTER_MONTHS[quarter];
  const ingresosBrutos = charges.reduce((s, c) => s + netAmount(c), 0) / 100;
  const ingresos = +(ingresosBrutos / (1 + IVA_RATE)).toFixed(2);

  const qExpenses = expenses.filter((e) => {
    const d = new Date(e.fecha);
    return d.getFullYear() === year && months.includes(d.getMonth());
  });
  const gastos = qExpenses.reduce((s, e) => s + e.base, 0);
  const rendimientoNeto = +(ingresos - gastos).toFixed(2);
  const pagoFraccionado = +(rendimientoNeto * IRPF_RATE).toFixed(2);
  const resultado = +(Math.max(0, pagoFraccionado - pagosAnteriores)).toFixed(2);

  if (!esAutonomo) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Modelo 130 - IRPF Trimestral</h3>
            <p className="text-sm text-slate-500">Pago fraccionado de IRPF para autonomos</p>
          </div>
          <DeadlineBadge quarter={quarter} />
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center space-y-4">
          <p className="text-sm text-slate-600">
            El Modelo 130 solo aplica si el socio/administrador esta dado de alta como autonomo.
          </p>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={esAutonomo}
              onChange={(e) => setEsAutonomo(e.target.checked)}
              className="w-4 h-4 accent-amber-600"
            />
            <span className="text-sm font-medium text-slate-700">Soy autonomo</span>
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Modelo 130 - IRPF Trimestral</h3>
          <p className="text-sm text-slate-500">PLOTWELL, S.L.U. / NIF: B26924068</p>
        </div>
        <DeadlineBadge quarter={quarter} />
      </div>

      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={esAutonomo}
          onChange={(e) => setEsAutonomo(e.target.checked)}
          className="w-4 h-4 accent-amber-600"
        />
        <span className="text-sm font-medium text-slate-700">Soy autonomo</span>
      </label>

      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        <SectionTitle>Calculo del pago fraccionado</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <CasillaField label="Casilla 01" desc="Ingresos (base imponible)" value={fmt(ingresos)} />
          <CasillaField label="Casilla 02" desc="Gastos deducibles" value={fmt(gastos)} />
          <CasillaField label="Casilla 03" desc="Rendimiento neto" value={fmt(rendimientoNeto)} />
          <CasillaField label="Casilla 04" desc="20% rendimiento neto" value={fmt(pagoFraccionado)} />
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        <SectionTitle>Deducciones</SectionTitle>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Pagos fraccionados anteriores del ejercicio
          </label>
          <input
            type="number"
            value={pagosAnteriores}
            onChange={(e) => setPagosAnteriores(Number(e.target.value) || 0)}
            step="0.01"
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>
      </div>

      <div className={`rounded-lg border p-5 ${resultado > 0 ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"}`}>
        <p className="text-xs font-medium text-slate-500">Resultado a ingresar</p>
        <p className={`text-xl font-bold ${resultado > 0 ? "text-red-600" : "text-green-600"}`}>
          {fmt(resultado)}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 4: Modelo 390                                                  */
/* ------------------------------------------------------------------ */

function Modelo390Tab({
  year,
  expenses,
}: {
  year: number;
  expenses: Expense[];
}) {
  const [yearCharges, setYearCharges] = useState<StripeCharge[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadYear = useCallback(async () => {
    setLoading(true);
    const range = getYearRange(year);
    const data = await fetchStripeCharges(range.gte, range.lte);
    setYearCharges(data);
    setLoaded(true);
    setLoading(false);
  }, [year]);

  useEffect(() => {
    setLoaded(false);
    setYearCharges([]);
  }, [year]);

  const yearExpenses = expenses.filter((e) => new Date(e.fecha).getFullYear() === year);
  const ingresosBrutos = yearCharges.reduce((s, c) => s + netAmount(c), 0) / 100;
  const comisionesAnuales = totalStripeFees(yearCharges);
  const baseImponible = +(ingresosBrutos / (1 + IVA_RATE)).toFixed(2);
  const ivaRepercutido = +(baseImponible * IVA_RATE).toFixed(2);
  const ivaSoportado = yearExpenses.reduce((s, e) => s + e.iva, 0);
  const resultado = +(ivaRepercutido - ivaSoportado).toFixed(2);

  // Per-quarter breakdown
  const quarterData = ([1, 2, 3, 4] as Quarter[]).map((q) => {
    const months = QUARTER_MONTHS[q];
    const qCharges = yearCharges.filter((c) => months.includes(new Date(c.created * 1000).getMonth()));
    const qExpenses = yearExpenses.filter((e) => months.includes(new Date(e.fecha).getMonth()));
    const qBruto = qCharges.reduce((s, c) => s + netAmount(c), 0) / 100;
    const qBase = +(qBruto / (1 + IVA_RATE)).toFixed(2);
    const qIvaRep = +(qBase * IVA_RATE).toFixed(2);
    const qIvaSop = qExpenses.reduce((s, e) => s + e.iva, 0);
    return { quarter: q, base: qBase, ivaRepercutido: qIvaRep, ivaSoportado: qIvaSop, diferencia: +(qIvaRep - qIvaSop).toFixed(2) };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Modelo 390 - Resumen Anual IVA</h3>
          <p className="text-sm text-slate-500">PLOTWELL, S.L.U. / NIF: B26924068 - Ejercicio {year}</p>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700">
          Plazo: 1 - 30 de enero {year + 1}
        </div>
      </div>

      {!loaded ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center space-y-4">
          <p className="text-sm text-slate-600">
            Carga los datos del ano completo desde Stripe para calcular el resumen anual.
          </p>
          <button
            onClick={loadYear}
            disabled={loading}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Cargando..." : `Cargar datos de ${year}`}
          </button>
        </div>
      ) : (
        <>
          {/* Annual totals */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <MetricCard label="Base imponible anual" value={fmt(baseImponible)} />
            <MetricCard label="IVA repercutido" value={fmt(ivaRepercutido)} color="text-amber-700" />
            <MetricCard label="IVA soportado" value={fmt(ivaSoportado)} color="text-blue-600" />
            <MetricCard label="Comisiones Stripe" value={fmt(comisionesAnuales)} color="text-red-600" sub={ingresosBrutos > 0 ? `~${(comisionesAnuales / ingresosBrutos * 100).toFixed(1)}%` : undefined} />
            <MetricCard
              label="Resultado anual"
              value={fmt(resultado)}
              color={resultado >= 0 ? "text-red-600" : "text-green-600"}
              sub={resultado >= 0 ? "A ingresar" : "A devolver"}
            />
          </div>

          {/* Quarter breakdown */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Trimestre</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Base imponible</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">IVA repercutido</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">IVA soportado</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {quarterData.map((q) => (
                  <tr key={q.quarter} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-medium text-slate-700">Q{q.quarter}</td>
                    <td className="px-4 py-2 text-right text-slate-600">{fmt(q.base)}</td>
                    <td className="px-4 py-2 text-right text-amber-700">{fmt(q.ivaRepercutido)}</td>
                    <td className="px-4 py-2 text-right text-blue-600">{fmt(q.ivaSoportado)}</td>
                    <td className={`px-4 py-2 text-right font-medium ${q.diferencia >= 0 ? "text-red-600" : "text-green-600"}`}>
                      {fmt(q.diferencia)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-4 py-2 text-slate-700">Total</td>
                  <td className="px-4 py-2 text-right text-slate-900">{fmt(baseImponible)}</td>
                  <td className="px-4 py-2 text-right text-amber-700">{fmt(ivaRepercutido)}</td>
                  <td className="px-4 py-2 text-right text-blue-600">{fmt(ivaSoportado)}</td>
                  <td className={`px-4 py-2 text-right ${resultado >= 0 ? "text-red-600" : "text-green-600"}`}>
                    {fmt(resultado)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 5: Facturas                                                    */
/* ------------------------------------------------------------------ */

function FacturasTab({
  charges,
  quarter,
  year,
  loading,
}: {
  charges: StripeCharge[];
  quarter: Quarter;
  year: number;
  loading: boolean;
}) {
  const sorted = [...charges].sort((a, b) => b.created - a.created);
  const totalBruto = charges.reduce((s, c) => s + netAmount(c), 0) / 100;
  const totalBase = +(totalBruto / (1 + IVA_RATE)).toFixed(2);
  const totalIva = +(totalBruto - totalBase).toFixed(2);
  const totalComisiones = totalStripeFees(charges);

  const exportCSV = () => {
    const header = "Fecha,Cliente,Concepto,Base Imponible,IVA,Total,Comision Stripe,Neto\n";
    const rows = sorted
      .map((c) => {
        const date = new Date(c.created * 1000).toLocaleDateString("es-ES");
        const email = c.receipt_email || c.billing_details?.email || "-";
        const desc = (c.description || "Suscripcion plotwell").replace(/,/g, ";");
        const bruto = netAmount(c) / 100;
        const base = +(bruto / (1 + IVA_RATE)).toFixed(2);
        const iva = +(bruto - base).toFixed(2);
        const fee = stripeFee(c) / 100;
        const neto = +(bruto - fee).toFixed(2);
        return `${date},${email},${desc},${base.toFixed(2)},${iva.toFixed(2)},${bruto.toFixed(2)},${fee.toFixed(2)},${neto.toFixed(2)}`;
      })
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `facturas_Q${quarter}_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-slate-900">
          Facturas - Q{quarter} {year}
        </h3>
        <button
          onClick={exportCSV}
          disabled={charges.length === 0}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50 transition-colors"
        >
          Exportar CSV
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Fecha</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Cliente</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Concepto</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Base</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">IVA</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Total</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Comision</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Neto</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No hay facturas en este periodo
                  </td>
                </tr>
              ) : (
                sorted.map((c) => {
                  const bruto = netAmount(c) / 100;
                  const base = +(bruto / (1 + IVA_RATE)).toFixed(2);
                  const iva = +(bruto - base).toFixed(2);
                  const fee = stripeFee(c) / 100;
                  const neto = +(bruto - fee).toFixed(2);
                  return (
                    <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2 text-slate-600">
                        {new Date(c.created * 1000).toLocaleDateString("es-ES")}
                      </td>
                      <td className="px-4 py-2 text-slate-600 truncate max-w-[200px]">
                        {c.receipt_email || c.billing_details?.email || "-"}
                      </td>
                      <td className="px-4 py-2 text-slate-600 truncate max-w-[200px]">
                        {c.description || "Suscripcion plotwell"}
                        {c.refunded && (
                          <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">REEMBOLSADO</span>
                        )}
                        {!c.refunded && c.amount_refunded > 0 && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">REEMBOLSO PARCIAL</span>
                        )}
                      </td>
                      <td className={`px-4 py-2 text-right ${c.amount_refunded > 0 ? "text-red-600" : "text-slate-600"}`}>{fmt(base)}</td>
                      <td className={`px-4 py-2 text-right ${c.amount_refunded > 0 ? "text-red-400" : "text-slate-400"}`}>{fmt(iva)}</td>
                      <td className={`px-4 py-2 text-right font-medium ${c.amount_refunded > 0 ? "text-red-700" : "text-slate-900"}`}>{fmt(bruto)}</td>
                      <td className="px-4 py-2 text-right text-red-500">{fmt(fee)}</td>
                      <td className="px-4 py-2 text-right font-medium text-green-700">{fmt(neto)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-slate-700">Totales ({sorted.length} facturas)</td>
                  <td className="px-4 py-2 text-right text-slate-900">{fmt(totalBase)}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{fmt(totalIva)}</td>
                  <td className="px-4 py-2 text-right text-slate-900">{fmt(totalBruto)}</td>
                  <td className="px-4 py-2 text-right text-red-500">{fmt(totalComisiones)}</td>
                  <td className="px-4 py-2 text-right text-green-700">{fmt(totalBruto - totalComisiones)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 6: Gastos                                                      */
/* ------------------------------------------------------------------ */

function GastosTab({
  expenses,
  setExpenses,
}: {
  expenses: Expense[];
  setExpenses: (e: Expense[]) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [concepto, setConcepto] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [base, setBase] = useState(0);
  const [ivaPct, setIvaPct] = useState(21);
  const [categoria, setCategoria] = useState(CATEGORIAS[0]);

  const resetForm = () => {
    setFecha(new Date().toISOString().slice(0, 10));
    setConcepto("");
    setProveedor("");
    setBase(0);
    setIvaPct(21);
    setCategoria(CATEGORIAS[0]);
    setEditId(null);
    setShowForm(false);
  };

  const handleSave = () => {
    if (!concepto.trim() || base <= 0) return;
    const iva = +(base * ivaPct / 100).toFixed(2);
    const total = +(base + iva).toFixed(2);
    const expense: Expense = {
      id: editId || generateId(),
      fecha,
      concepto: concepto.trim(),
      proveedor: proveedor.trim(),
      base: +base.toFixed(2),
      ivaPct,
      iva,
      total,
      categoria,
    };

    let updated: Expense[];
    if (editId) {
      updated = expenses.map((e) => (e.id === editId ? expense : e));
    } else {
      updated = [...expenses, expense];
    }
    updated.sort((a, b) => b.fecha.localeCompare(a.fecha));
    setExpenses(updated);
    saveExpenses(updated);
    resetForm();
  };

  const handleEdit = (e: Expense) => {
    setEditId(e.id);
    setFecha(e.fecha);
    setConcepto(e.concepto);
    setProveedor(e.proveedor);
    setBase(e.base);
    setIvaPct(e.ivaPct);
    setCategoria(e.categoria);
    setShowForm(true);
  };

  const handleDelete = (id: string) => {
    const updated = expenses.filter((e) => e.id !== id);
    setExpenses(updated);
    saveExpenses(updated);
  };

  const totalBase = expenses.reduce((s, e) => s + e.base, 0);
  const totalIva = expenses.reduce((s, e) => s + e.iva, 0);
  const totalTotal = expenses.reduce((s, e) => s + e.total, 0);

  const exportCSV = () => {
    const header = "Fecha,Concepto,Proveedor,Categoria,Base,IVA %,IVA,Total\n";
    const rows = expenses
      .map((e) =>
        `${e.fecha},${e.concepto.replace(/,/g, ";")},${e.proveedor.replace(/,/g, ";")},${e.categoria},${e.base.toFixed(2)},${e.ivaPct},${e.iva.toFixed(2)},${e.total.toFixed(2)}`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gastos_plotwell.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-slate-900">Gastos</h3>
        <div className="flex gap-2">
          <button
            onClick={exportCSV}
            disabled={expenses.length === 0}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50 transition-colors"
          >
            Exportar CSV
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors"
          >
            + Anadir gasto
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 space-y-4">
          <SectionTitle>{editId ? "Editar gasto" : "Nuevo gasto"}</SectionTitle>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Fecha</label>
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Concepto</label>
              <input
                type="text"
                value={concepto}
                onChange={(e) => setConcepto(e.target.value)}
                placeholder="Ej: Hosting Render"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Proveedor</label>
              <input
                type="text"
                value={proveedor}
                onChange={(e) => setProveedor(e.target.value)}
                placeholder="Ej: Render Inc."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Categoria</label>
              <select
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {CATEGORIAS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Base imponible</label>
              <input
                type="number"
                value={base || ""}
                onChange={(e) => setBase(Number(e.target.value) || 0)}
                step="0.01"
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">IVA (%)</label>
              <select
                value={ivaPct}
                onChange={(e) => setIvaPct(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                <option value={0}>0% (Exento / Intracomunitario)</option>
                <option value={4}>4% (Superreducido)</option>
                <option value={10}>10% (Reducido)</option>
                <option value={21}>21% (General)</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={!concepto.trim() || base <= 0}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {editId ? "Guardar cambios" : "Anadir"}
            </button>
            <button
              onClick={resetForm}
              className="rounded-lg bg-white border border-gray-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            {base > 0 && (
              <span className="text-xs text-slate-500">
                IVA: {fmt(+(base * ivaPct / 100).toFixed(2))} | Total: {fmt(+(base + base * ivaPct / 100).toFixed(2))}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Fecha</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Concepto</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Proveedor</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Categoria</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Base</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">IVA</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-slate-500">Total</th>
                <th className="px-4 py-2 text-xs font-medium text-slate-500"></th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No hay gastos registrados
                  </td>
                </tr>
              ) : (
                expenses.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-slate-600">{new Date(e.fecha).toLocaleDateString("es-ES")}</td>
                    <td className="px-4 py-2 text-slate-600">{e.concepto}</td>
                    <td className="px-4 py-2 text-slate-500">{e.proveedor || "-"}</td>
                    <td className="px-4 py-2">
                      <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {e.categoria}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">{fmt(e.base)}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{fmt(e.iva)}</td>
                    <td className="px-4 py-2 text-right font-medium text-slate-900">{fmt(e.total)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => handleEdit(e)}
                        className="text-xs text-amber-600 hover:text-amber-700 mr-2"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(e.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {expenses.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={4} className="px-4 py-2 text-slate-700">
                    Totales ({expenses.length} gastos)
                  </td>
                  <td className="px-4 py-2 text-right text-slate-900">{fmt(totalBase)}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{fmt(totalIva)}</td>
                  <td className="px-4 py-2 text-right text-slate-900">{fmt(totalTotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Los gastos se almacenan en localStorage. Los totales de IVA soportado alimentan automaticamente el Modelo 303.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AI Chat Panel                                                      */
/* ------------------------------------------------------------------ */

const TAX_SYSTEM = `Eres un asesor fiscal especializado en fiscalidad espanola para sociedades limitadas unipersonales (S.L.U.).

Contexto:
- Empresa: PLOTWELL, S.L.U.
- NIF: B26924068
- Domicilio fiscal: Madrid
- Actividad: Desarrollo y comercializacion de software SaaS
- Modelo de ingresos: Suscripciones mensuales/anuales via Stripe

Conocimientos:
- IVA (Modelo 303, 390): tipos impositivos, deducciones, regimen general
- Impuesto de Sociedades (Modelo 200): gastos deducibles, amortizaciones
- IRPF del administrador/socio (Modelo 130 si es autonomo)
- Retenciones e ingresos a cuenta
- Obligaciones formales: libros registro, facturas, SII
- Gastos deducibles para SLU de software: hosting, dominios, herramientas SaaS, publicidad digital, servicios profesionales
- Operaciones intracomunitarias (proveedores UE)
- IVA en servicios digitales B2C en la UE

Responde siempre en espanol. Se conciso y practico. Cuando no estes seguro, indica que se consulte con un asesor fiscal profesional.`;

function AIPanel({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

  const handleAsk = async () => {
    if (!question.trim() || loading) return;
    setAnswer("");
    setLoading(true);
    try {
      const result = await generate(question, {
        system: TAX_SYSTEM,
        maxTokens: 2048,
        temperature: 0.5,
      });
      setAnswer(result);
    } catch (err) {
      setAnswer(`Error: ${err instanceof Error ? err.message : "Error desconocido"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-white border-l border-gray-200 shadow-xl flex flex-col z-50">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-bold text-slate-900">Consultar IA - Fiscal</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg">
          &times;
        </button>
      </div>

      <div ref={messagesRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {!answer && !loading && (
          <div className="text-sm text-slate-400 space-y-2">
            <p>Pregunta sobre fiscalidad espanola para tu S.L.U. Ejemplos:</p>
            <ul className="space-y-1 text-xs">
              <li className="cursor-pointer hover:text-amber-600" onClick={() => setQuestion("Que gastos puedo deducir como SLU de software?")}>
                &bull; Que gastos puedo deducir como SLU de software?
              </li>
              <li className="cursor-pointer hover:text-amber-600" onClick={() => setQuestion("Puedo deducir el IVA de servicios de hosting de EEUU?")}>
                &bull; Puedo deducir el IVA de servicios de hosting de EEUU?
              </li>
              <li className="cursor-pointer hover:text-amber-600" onClick={() => setQuestion("Como funciona el IVA en ventas digitales B2C en la UE?")}>
                &bull; Como funciona el IVA en ventas digitales B2C en la UE?
              </li>
              <li className="cursor-pointer hover:text-amber-600" onClick={() => setQuestion("Que obligaciones fiscales trimestrales tiene una SLU?")}>
                &bull; Que obligaciones fiscales trimestrales tiene una SLU?
              </li>
            </ul>
          </div>
        )}

        {answer && (
          <div className="rounded-lg bg-gray-50 p-3 text-sm text-slate-700 whitespace-pre-wrap">
            {answer}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            Consultando...
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            placeholder="Escribe tu consulta fiscal..."
            disabled={loading}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          />
          <button
            onClick={handleAsk}
            disabled={loading || !question.trim()}
            className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main App                                                           */
/* ------------------------------------------------------------------ */

const tabs: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Resumen" },
  { id: "modelo303", label: "Modelo 303" },
  { id: "modelo130", label: "Modelo 130" },
  { id: "modelo390", label: "Modelo 390" },
  { id: "facturas", label: "Facturas" },
  { id: "gastos", label: "Gastos" },
];

export default function App({ embedded = false }: { embedded?: boolean }) {
  const now = new Date();
  const currentQuarter = (Math.ceil((now.getMonth() + 1) / 3)) as Quarter;
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [quarter, setQuarter] = useState<Quarter>(currentQuarter);
  const [year, setYear] = useState(now.getFullYear());
  const [charges, setCharges] = useState<StripeCharge[]>([]);
  const [loading, setLoading] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>(loadExpenses);
  const [showAI, setShowAI] = useState(false);

  // Cache key for fetched data
  const cacheKeyRef = useRef("");

  const fetchCharges = useCallback(async () => {
    const key = `${quarter}-${year}`;
    if (key === cacheKeyRef.current) return;
    setLoading(true);
    const range = getQuarterRange(quarter, year);
    const data = await fetchStripeCharges(range.gte, range.lte);
    setCharges(data);
    cacheKeyRef.current = key;
    setLoading(false);
  }, [quarter, year]);

  useEffect(() => {
    fetchCharges();
  }, [fetchCharges]);

  const yearOptions = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  const content = (
    <div className={embedded ? "px-6 py-4" : ""}>
      {/* Quarter & Year selectors */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Trimestre:</label>
          <div className="flex gap-1">
            {([1, 2, 3, 4] as Quarter[]).map((q) => (
              <button
                key={q}
                onClick={() => setQuarter(q)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  quarter === q
                    ? "bg-amber-600 text-white"
                    : "bg-gray-100 text-slate-600 hover:bg-gray-200"
                }`}
              >
                Q{q}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Ano:</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => setShowAI(true)}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
          >
            Consultar IA
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-white text-amber-700 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "dashboard" && (
        <DashboardTab charges={charges} expenses={expenses} quarter={quarter} year={year} loading={loading} />
      )}
      {activeTab === "modelo303" && (
        <Modelo303Tab charges={charges} expenses={expenses} quarter={quarter} year={year} />
      )}
      {activeTab === "modelo130" && (
        <Modelo130Tab charges={charges} expenses={expenses} quarter={quarter} year={year} />
      )}
      {activeTab === "modelo390" && (
        <Modelo390Tab year={year} expenses={expenses} />
      )}
      {activeTab === "facturas" && (
        <FacturasTab charges={charges} quarter={quarter} year={year} loading={loading} />
      )}
      {activeTab === "gastos" && (
        <GastosTab expenses={expenses} setExpenses={setExpenses} />
      )}

      {/* AI Panel */}
      {showAI && <AIPanel onClose={() => setShowAI(false)} />}
    </div>
  );

  if (embedded) return content;

  return (
    <ToolPage title="Contabilidad" description="PLOTWELL, S.L.U. / NIF: B26924068 - Herramientas fiscales y contables">
      {content}
    </ToolPage>
  );
}
