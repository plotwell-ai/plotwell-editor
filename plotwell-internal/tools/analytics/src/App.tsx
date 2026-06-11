import { useState, useEffect, useCallback } from "react";
import { generate } from "@shared/ai-client";
import { ToolPage, CopyButton } from "@shared/components";
import {
  isConfigured,
  isAdsConfigured,
  getStoredToken,
  startOAuthFlow,
  clearToken,
  searchConsoleQuery,
  searchConsoleSites,
  ga4RunReport,
  ga4ListProperties,
  getAdsConfig,
  adsGetCampaignPerformance,
  adsGetKeywordPerformance,
  adsGetDailyPerformance,
  type AdsCampaignRow,
  type AdsKeywordRow,
  type AdsDailyRow,
} from "@shared/google-auth";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Tab = "revenue" | "customers" | "users" | "search-console" | "ga4" | "ads-audit" | "competitors";

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
  status: string;
  refunded: boolean;
  customer?: string;
  receipt_email?: string;
  description?: string;
  balance_transaction?: {
    fee: number;
    net: number;
  };
}

interface StripeSubscription {
  id: string;
  status: string;
  created: number;
  current_period_start: number;
  current_period_end: number;
  canceled_at: number | null;
  plan?: {
    amount: number;
    interval: string;
    currency: string;
    nickname?: string;
  };
  customer?: string;
}

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  subscriptions?: { data: StripeSubscription[] };
  metadata?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Stripe helpers                                                     */
/* ------------------------------------------------------------------ */

function getStripeKey(): string {
  const key = import.meta.env.VITE_STRIPE_SECRET_KEY;
  if (!key) throw new Error("VITE_STRIPE_SECRET_KEY not set");
  return key;
}

async function fetchStripe(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = `/stripe-api/v1/${endpoint}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getStripeKey()}` },
  });
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllCharges(months: number): Promise<StripeCharge[]> {
  const since = Math.floor(Date.now() / 1000) - months * 30 * 86400;
  const all: StripeCharge[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      limit: "100",
      "created[gte]": String(since),
      "expand[]": "data.balance_transaction",
    };
    if (startingAfter) params.starting_after = startingAfter;

    const res = (await fetchStripe("charges", params)) as {
      data: StripeCharge[];
      has_more: boolean;
    };
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return all;
}

async function fetchAllSubscriptions(): Promise<StripeSubscription[]> {
  const all: StripeSubscription[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = {
      limit: "100",
      status: "all",
      "expand[]": "data.plan",
    };
    if (startingAfter) params.starting_after = startingAfter;

    const res = (await fetchStripe("subscriptions", params)) as {
      data: StripeSubscription[];
      has_more: boolean;
    };
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return all;
}

async function fetchAllCustomers(): Promise<StripeCustomer[]> {
  const all: StripeCustomer[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      limit: "100",
      "expand[]": "data.subscriptions",
    };
    if (startingAfter) params.starting_after = startingAfter;

    const res = (await fetchStripe("customers", params)) as {
      data: StripeCustomer[];
      has_more: boolean;
    };
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return all;
}

/* ------------------------------------------------------------------ */
/*  Supabase helpers                                                   */
/* ------------------------------------------------------------------ */

interface SupabaseUser {
  id: string;
  email?: string;
  created_at: string;
  last_sign_in_at: string | null;
  app_metadata?: { provider?: string; providers?: string[] };
  user_metadata?: { full_name?: string; name?: string };
}

function getSupabaseConfig() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, configured: !!(url && key) };
}

async function fetchAllSupabaseUsers(): Promise<SupabaseUser[]> {
  const { configured } = getSupabaseConfig();
  if (!configured) throw new Error("Supabase env vars not set");

  const all: SupabaseUser[] = [];
  let page = 1;
  const perPage = 1000;

  // Paginate -- typically 1 request for < 1000 users
  // Auth headers are injected by the Vite proxy (server-side)
  for (let i = 0; i < 10; i++) {
    const res = await fetch(
      `/supabase-api/auth/v1/admin/users?page=${page}&per_page=${perPage}`
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const users: SupabaseUser[] = data.users || data;
    all.push(...users);
    if (users.length < perPage) break;
    page++;
  }
  return all;
}

/* ------------------------------------------------------------------ */
/*  Shared UI                                                          */
/* ------------------------------------------------------------------ */

function MetricCard({
  label,
  value,
  sub,
  color = "amber",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: "amber" | "green" | "red" | "blue" | "purple";
}) {
  const colors = {
    amber: "border-amber-200 bg-amber-50",
    green: "border-green-200 bg-green-50",
    red: "border-red-200 bg-red-50",
    blue: "border-blue-200 bg-blue-50",
    purple: "border-purple-200 bg-purple-50",
  };
  const textColors = {
    amber: "text-amber-700",
    green: "text-green-700",
    red: "text-red-700",
    blue: "text-blue-700",
    purple: "text-purple-700",
  };

  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${textColors[color]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function formatEur(cents: number): string {
  return new Intl.NumberFormat("en-EU", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatEurDecimal(cents: number): string {
  return new Intl.NumberFormat("en-EU", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  // Parse markdown tables, headers, bold, lists into HTML
  const html = content
    // Tables: detect lines with | and convert
    .replace(/^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)*)/gm, (_match, header: string, _sep: string, body: string) => {
      const ths = header.split("|").filter(Boolean).map((c: string) => `<th class="px-3 py-2 text-left text-xs font-semibold text-gray-600 bg-gray-50 border border-gray-200">${c.trim()}</th>`).join("");
      const rows = body.trim().split("\n").map((row: string) => {
        const tds = row.split("|").filter(Boolean).map((c: string) => `<td class="px-3 py-2 text-xs text-gray-700 border border-gray-200">${c.trim().replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</td>`).join("");
        return `<tr class="hover:bg-gray-50">${tds}</tr>`;
      }).join("");
      return `<div class="overflow-x-auto my-3"><table class="w-full border-collapse rounded-lg overflow-hidden text-sm"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="text-sm font-semibold text-gray-800 mt-4 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="text-base font-semibold text-gray-900 mt-5 mb-2 pb-1 border-b border-gray-200">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="text-lg font-bold text-gray-900 mt-6 mb-2">$1</h2>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Bullet lists
    .replace(/^[•\-] (.+)$/gm, '<li class="text-sm text-gray-700 ml-4 list-disc">$1</li>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li class="text-sm text-gray-700 ml-4 list-decimal">$1</li>')
    // Wrap consecutive <li> in <ul>/<ol>
    .replace(/((?:<li class="text-sm text-gray-700 ml-4 list-disc">.*<\/li>\n?)+)/g, '<ul class="my-2 space-y-1">$1</ul>')
    .replace(/((?:<li class="text-sm text-gray-700 ml-4 list-decimal">.*<\/li>\n?)+)/g, '<ol class="my-2 space-y-1">$1</ol>')
    // Paragraphs (lines not already wrapped)
    .replace(/^(?!<[hultdo])((?!<li|<strong).+)$/gm, '<p class="text-sm text-gray-700 my-1">$1</p>')
    .replace(/<p class="text-sm text-gray-700 my-1"><\/p>/g, "");

  return (
    <div
      className="bg-gray-50 rounded-lg p-5 max-h-[600px] overflow-y-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <p>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 text-xs font-medium text-red-600 underline hover:text-red-800"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Date helper                                                        */
/* ------------------------------------------------------------------ */

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

/* ------------------------------------------------------------------ */
/*  Google Auth Banner (shared)                                        */
/* ------------------------------------------------------------------ */

function GoogleAuthBanner({ onConnect }: { onConnect: () => void }) {
  if (!isConfigured()) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5">
        <h3 className="text-sm font-semibold text-amber-800 mb-2">Google API Not Configured</h3>
        <p className="text-xs text-amber-700 mb-3">
          Set VITE_GOOGLE_CLIENT_ID in .env.local to enable Search Console and Analytics.
        </p>
        <ol className="text-xs text-amber-600 space-y-1 list-decimal list-inside">
          <li>Create a Google Cloud project</li>
          <li>Enable Search Console API and Analytics Data API</li>
          <li>Create OAuth2 credentials (redirect URI: http://localhost:5180/oauth/callback)</li>
          <li>Add VITE_GOOGLE_CLIENT_ID to .env.local</li>
        </ol>
      </div>
    );
  }

  const token = getStoredToken();
  if (token) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold text-blue-800">Connect Google Account</h3>
        <p className="text-xs text-blue-600">Required for Search Console and Analytics data</p>
      </div>
      <button
        onClick={onConnect}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
      >
        Connect Google
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Revenue Tab (Stripe)                                               */
/* ------------------------------------------------------------------ */

function RevenueTab() {
  const [charges, setCharges] = useState<StripeCharge[]>([]);
  const [subs, setSubs] = useState<StripeSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<6 | 12>(12);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s] = await Promise.all([
        fetchAllCharges(period),
        fetchAllSubscriptions(),
      ]);
      setCharges(c);
      setSubs(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={load} />;

  const paid = charges.filter((c) => c.status === "paid" && !c.refunded);
  const refunded = charges.filter((c) => c.refunded);
  const totalRevenue = paid.reduce((s, c) => s + c.amount - (c.amount_refunded || 0), 0);
  const totalFees = paid.reduce((s, c) => s + (c.balance_transaction?.fee || 0), 0);
  const netRevenue = totalRevenue - totalFees;
  const avgTransaction = paid.length ? totalRevenue / paid.length : 0;

  const activeSubs = subs.filter((s) => s.status === "active");
  const mrr = activeSubs.reduce((s, sub) => {
    const amount = sub.plan?.amount || 0;
    const interval = sub.plan?.interval || "month";
    return s + (interval === "year" ? Math.round(amount / 12) : amount);
  }, 0);

  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const recentCanceled = subs.filter(
    (s) => s.canceled_at && s.canceled_at >= thirtyDaysAgo
  ).length;
  const churnRate = activeSubs.length + recentCanceled > 0
    ? ((recentCanceled / (activeSubs.length + recentCanceled)) * 100).toFixed(1)
    : "0.0";

  const monthlyRevenue: Record<string, number> = {};
  for (const c of paid) {
    const d = new Date(c.created * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyRevenue[key] = (monthlyRevenue[key] || 0) + c.amount - (c.amount_refunded || 0);
  }
  const sortedMonths = Object.entries(monthlyRevenue)
    .sort(([a], [b]) => a.localeCompare(b));
  const maxMonthly = Math.max(...sortedMonths.map(([, v]) => v), 1);

  const planCounts: Record<string, { count: number; mrr: number }> = {};
  for (const sub of activeSubs) {
    const name = sub.plan?.nickname || sub.plan?.interval || "Unknown";
    if (!planCounts[name]) planCounts[name] = { count: 0, mrr: 0 };
    planCounts[name].count++;
    const amount = sub.plan?.amount || 0;
    const interval = sub.plan?.interval || "month";
    planCounts[name].mrr += interval === "year" ? Math.round(amount / 12) : amount;
  }

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Period:</span>
        {([6, 12] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              period === p
                ? "bg-amber-100 text-amber-700"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {p}m
          </button>
        ))}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="MRR" value={formatEurDecimal(mrr)} color="amber" />
        <MetricCard
          label="Total Revenue"
          value={formatEur(totalRevenue)}
          sub={`${paid.length} transactions`}
          color="green"
        />
        <MetricCard
          label="Active Subs"
          value={String(activeSubs.length)}
          sub={`${churnRate}% churn (30d)`}
          color="blue"
        />
        <MetricCard
          label="Avg Transaction"
          value={formatEurDecimal(avgTransaction)}
          color="purple"
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Net Revenue" value={formatEur(netRevenue)} sub="After Stripe fees" />
        <MetricCard label="Stripe Fees" value={formatEur(totalFees)} color="red" />
        <MetricCard label="Refunds" value={String(refunded.length)} sub={formatEur(refunded.reduce((s, c) => s + c.amount_refunded, 0))} color="red" />
      </div>

      {/* Monthly revenue chart */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          Monthly Revenue
        </h3>
        {sortedMonths.length === 0 ? (
          <p className="text-xs text-gray-400">No data</p>
        ) : (
          <div className="flex items-end gap-1 h-40">
            {sortedMonths.map(([month, amount]) => (
              <div
                key={month}
                className="flex-1 flex flex-col items-center gap-1"
              >
                <span className="text-[10px] font-medium text-gray-600">
                  {formatEur(amount)}
                </span>
                <div
                  className="w-full bg-amber-400 rounded-t-md transition-all duration-500 min-h-[2px]"
                  style={{ height: `${(amount / maxMonthly) * 100}%` }}
                />
                <span className="text-[10px] text-gray-400">
                  {month.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Plan breakdown */}
      {Object.keys(planCounts).length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">
            Plan Breakdown
          </h3>
          <div className="space-y-3">
            {Object.entries(planCounts)
              .sort(([, a], [, b]) => b.mrr - a.mrr)
              .map(([name, { count, mrr: planMrr }]) => (
                <div key={name} className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-gray-700">{name}</span>
                    <span className="ml-2 text-xs text-gray-400">{count} subscribers</span>
                  </div>
                  <span className="text-sm font-semibold text-amber-700">
                    {formatEurDecimal(planMrr)}/mo
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Recent transactions */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          Recent Transactions
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium text-right">Amount</th>
                <th className="pb-2 font-medium text-right">Fee</th>
                <th className="pb-2 font-medium text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {paid.slice(0, 20).map((c) => {
                const net = c.amount - (c.amount_refunded || 0) - (c.balance_transaction?.fee || 0);
                return (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 text-gray-600">
                      {new Date(c.created * 1000).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-gray-600">{c.receipt_email || c.customer || "-"}</td>
                    <td className="py-2 text-gray-500 max-w-[200px] truncate">{c.description || "-"}</td>
                    <td className="py-2 text-right text-gray-700 font-medium">
                      {formatEurDecimal(c.amount)}
                    </td>
                    <td className="py-2 text-right text-red-500">
                      {formatEurDecimal(c.balance_transaction?.fee || 0)}
                    </td>
                    <td className="py-2 text-right text-green-700 font-medium">
                      {formatEurDecimal(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Customers Tab (Stripe)                                             */
/* ------------------------------------------------------------------ */

function CustomersTab() {
  const [customers, setCustomers] = useState<StripeCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "paying" | "free" | "churned">("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await fetchAllCustomers();
      setCustomers(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={load} />;

  // Classify customers
  const classified = customers.map((c) => {
    const activeSub = c.subscriptions?.data?.find((s) => s.status === "active");
    const canceledSub = c.subscriptions?.data?.find(
      (s) => s.status === "canceled" || s.canceled_at
    );
    const status: "paying" | "free" | "churned" = activeSub
      ? "paying"
      : canceledSub
        ? "churned"
        : "free";
    const mrr = activeSub
      ? activeSub.plan?.interval === "year"
        ? Math.round((activeSub.plan?.amount || 0) / 12)
        : activeSub.plan?.amount || 0
      : 0;
    return { ...c, status, mrr, activeSub, canceledSub };
  });

  const filtered =
    filter === "all"
      ? classified
      : classified.filter((c) => c.status === filter);

  const totalCustomers = customers.length;
  const paying = classified.filter((c) => c.status === "paying").length;
  const churned = classified.filter((c) => c.status === "churned").length;
  const free = classified.filter((c) => c.status === "free").length;
  const conversionRate = totalCustomers > 0 ? ((paying / totalCustomers) * 100).toFixed(1) : "0.0";

  // Signups by month
  const signupsByMonth: Record<string, number> = {};
  for (const c of customers) {
    const d = new Date(c.created * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    signupsByMonth[key] = (signupsByMonth[key] || 0) + 1;
  }
  const sortedSignupMonths = Object.entries(signupsByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12);
  const maxSignups = Math.max(...sortedSignupMonths.map(([, v]) => v), 1);

  const statusColors = {
    paying: "bg-green-100 text-green-700",
    free: "bg-gray-100 text-gray-600",
    churned: "bg-red-100 text-red-600",
  };

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total Customers" value={String(totalCustomers)} color="blue" />
        <MetricCard label="Paying" value={String(paying)} sub={`${conversionRate}% conversion`} color="green" />
        <MetricCard label="Free" value={String(free)} color="amber" />
        <MetricCard label="Churned" value={String(churned)} color="red" />
      </div>

      {/* Signups chart */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          Customer Signups (last 12 months)
        </h3>
        {sortedSignupMonths.length === 0 ? (
          <p className="text-xs text-gray-400">No data</p>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {sortedSignupMonths.map(([month, count]) => (
              <div
                key={month}
                className="flex-1 flex flex-col items-center gap-1"
              >
                <span className="text-[10px] font-medium text-gray-600">
                  {count}
                </span>
                <div
                  className="w-full bg-blue-400 rounded-t-md transition-all duration-500 min-h-[2px]"
                  style={{ height: `${(count / maxSignups) * 100}%` }}
                />
                <span className="text-[10px] text-gray-400">
                  {month.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filter + Customer list */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700">
            Customers ({filtered.length})
          </h3>
          <div className="flex gap-1">
            {(["all", "paying", "free", "churned"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize ${
                  filter === f
                    ? "bg-amber-100 text-amber-700"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Plan</th>
                <th className="pb-2 font-medium text-right">MRR</th>
                <th className="pb-2 font-medium text-right">Joined</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 50).map((c) => (
                <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2">
                    <div className="text-gray-700 font-medium">{c.name || c.email || c.id}</div>
                    {c.name && c.email && (
                      <div className="text-gray-400">{c.email}</div>
                    )}
                  </td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[c.status]}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2 text-gray-500">
                    {c.activeSub?.plan?.nickname || c.activeSub?.plan?.interval || "-"}
                  </td>
                  <td className="py-2 text-right text-gray-700 font-medium">
                    {c.mrr > 0 ? formatEurDecimal(c.mrr) : "-"}
                  </td>
                  <td className="py-2 text-right text-gray-500">
                    {new Date(c.created * 1000).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cohort Retention */}
      {(() => {
        // Build cohorts by signup month
        const cohorts: Record<string, {
          total: number;
          paying: number;
          churned: number;
          active: number;
          avgDaysToChurn: number;
        }> = {};

        for (const c of classified) {
          const d = new Date(c.created * 1000);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          if (!cohorts[key]) cohorts[key] = { total: 0, paying: 0, churned: 0, active: 0, avgDaysToChurn: 0 };
          cohorts[key].total++;
          if (c.status === "paying") { cohorts[key].paying++; cohorts[key].active++; }
          if (c.status === "churned") {
            cohorts[key].churned++;
            if (c.canceledSub?.canceled_at) {
              const daysActive = (c.canceledSub.canceled_at - c.created) / 86400;
              cohorts[key].avgDaysToChurn += daysActive;
            }
          }
          if (c.status === "free") cohorts[key].active++;
        }

        // Finalize avg days
        for (const co of Object.values(cohorts)) {
          if (co.churned > 0) co.avgDaysToChurn = Math.round(co.avgDaysToChurn / co.churned);
        }

        const sortedCohorts = Object.entries(cohorts)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-12);

        if (sortedCohorts.length === 0) return null;

        // Churn analysis
        const allChurned = classified.filter((c) => c.status === "churned");
        const avgLifetime = allChurned.length > 0
          ? Math.round(allChurned.reduce((s, c) => {
              const canceledAt = c.canceledSub?.canceled_at || Math.floor(Date.now() / 1000);
              return s + (canceledAt - c.created) / 86400;
            }, 0) / allChurned.length)
          : 0;

        return (
          <>
            {/* Cohort table */}
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">
                Cohort Retention
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-gray-500">
                      <th className="pb-2 font-medium">Cohort</th>
                      <th className="pb-2 font-medium text-right">Signups</th>
                      <th className="pb-2 font-medium text-right">Paying</th>
                      <th className="pb-2 font-medium text-right">Churned</th>
                      <th className="pb-2 font-medium text-right">Retention</th>
                      <th className="pb-2 font-medium text-right">Avg Days to Churn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCohorts.map(([month, co]) => {
                      const retention = co.total > 0 ? ((co.active / co.total) * 100).toFixed(0) : "0";
                      const retentionNum = co.total > 0 ? (co.active / co.total) * 100 : 0;
                      return (
                        <tr key={month} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-2 text-gray-700 font-medium">{month}</td>
                          <td className="py-2 text-right text-gray-600">{co.total}</td>
                          <td className="py-2 text-right text-green-600 font-medium">{co.paying}</td>
                          <td className="py-2 text-right text-red-600">{co.churned}</td>
                          <td className="py-2 text-right">
                            <span className={`font-semibold ${retentionNum >= 80 ? "text-green-600" : retentionNum >= 50 ? "text-amber-600" : "text-red-600"}`}>
                              {retention}%
                            </span>
                          </td>
                          <td className="py-2 text-right text-gray-500">
                            {co.avgDaysToChurn > 0 ? `${co.avgDaysToChurn}d` : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Churn summary */}
            {allChurned.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-red-800 mb-3">
                  Churn Analysis
                </h3>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <MetricCard label="Total Churned" value={String(allChurned.length)} color="red" />
                  <MetricCard
                    label="Avg Lifetime"
                    value={`${avgLifetime}d`}
                    sub={`~${Math.round(avgLifetime / 30)} months`}
                    color="amber"
                  />
                  <MetricCard
                    label="Churn Rate (30d)"
                    value={`${((churned / Math.max(paying + churned, 1)) * 100).toFixed(1)}%`}
                    color="red"
                  />
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-600">Recent Cancellations</h4>
                  {allChurned
                    .filter((c) => c.canceledSub?.canceled_at)
                    .sort((a, b) => (b.canceledSub?.canceled_at || 0) - (a.canceledSub?.canceled_at || 0))
                    .slice(0, 5)
                    .map((c) => (
                      <div key={c.id} className="flex items-center justify-between py-1.5 border-b border-gray-50 text-xs">
                        <span className="text-gray-700">{c.email || c.name || c.id}</span>
                        <div className="flex gap-4 text-gray-500">
                          <span>Plan: {c.canceledSub?.plan?.nickname || c.canceledSub?.plan?.interval || "?"}</span>
                          <span>Canceled: {c.canceledSub?.canceled_at ? new Date(c.canceledSub.canceled_at * 1000).toLocaleDateString() : "?"}</span>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Search Console Tab                                                 */
/* ------------------------------------------------------------------ */

interface SCRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function SearchConsoleTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 28 | 90>(28);
  const [sites, setSites] = useState<string[]>([]);
  const [selectedSite, setSelectedSite] = useState<string>(
    import.meta.env.VITE_SEARCH_CONSOLE_SITE_URL || ""
  );
  const [queryRows, setQueryRows] = useState<SCRow[]>([]);
  const [pageRows, setPageRows] = useState<SCRow[]>([]);
  const [totals, setTotals] = useState<{
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  } | null>(null);

  const handleConnect = useCallback(async () => {
    try {
      await startOAuthFlow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth flow failed");
    }
  }, []);

  const loadSites = useCallback(async () => {
    try {
      const urls = await searchConsoleSites();
      setSites(urls);
      if (!selectedSite && urls.length > 0) {
        setSelectedSite(urls[0]);
      }
    } catch (err) {
      console.error("Failed to load Search Console sites:", err);
      setError(err instanceof Error ? err.message : "Failed to load sites");
    }
  }, [selectedSite]);

  const loadData = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    setError(null);
    try {
      const startDate = dateStr(range);
      const endDate = dateStr(1);

      const [queryResult, pageResult] = await Promise.all([
        searchConsoleQuery(selectedSite, {
          startDate,
          endDate,
          dimensions: ["query"],
          rowLimit: 50,
        }),
        searchConsoleQuery(selectedSite, {
          startDate,
          endDate,
          dimensions: ["page"],
          rowLimit: 30,
        }),
      ]);

      const qRows = Array.isArray(queryResult) ? queryResult : (queryResult as { rows?: SCRow[] }).rows || [];
      const pRows = Array.isArray(pageResult) ? pageResult : (pageResult as { rows?: SCRow[] }).rows || [];

      setQueryRows(qRows);
      setPageRows(pRows);

      // Calculate totals from whichever dataset has data (prefer queries, fallback to pages)
      const allRows = qRows.length > 0 ? qRows : pRows;
      const totalClicks = allRows.reduce((s: number, r: SCRow) => s + r.clicks, 0);
      const totalImpressions = allRows.reduce((s: number, r: SCRow) => s + r.impressions, 0);
      const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
      const avgPosition =
        allRows.length > 0
          ? allRows.reduce((s: number, r: SCRow) => s + r.position, 0) / allRows.length
          : 0;

      setTotals({
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: avgCtr,
        position: avgPosition,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Search Console data");
    } finally {
      setLoading(false);
    }
  }, [selectedSite, range]);

  useEffect(() => {
    const token = getStoredToken();
    if (token && isConfigured()) {
      loadSites();
    }
  }, [loadSites]);

  useEffect(() => {
    const token = getStoredToken();
    if (token && selectedSite) {
      loadData();
    }
  }, [loadData, selectedSite]);

  const token = getStoredToken();

  return (
    <div className="space-y-6">
      <GoogleAuthBanner onConnect={handleConnect} />

      {token && isConfigured() && (
        <>
          {/* Site selector + date range + disconnect */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xs text-gray-500 shrink-0">Site:</span>
              {sites.length > 0 ? (
                <select
                  value={selectedSite}
                  onChange={(e) => setSelectedSite(e.target.value)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0 flex-1"
                >
                  {sites.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={selectedSite}
                  onChange={(e) => setSelectedSite(e.target.value)}
                  placeholder="https://plotwell.app"
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0 flex-1"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Range:</span>
              {([7, 28, 90] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    range === r
                      ? "bg-blue-100 text-blue-700"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {r}d
                </button>
              ))}
              <button
                onClick={() => {
                  clearToken();
                  setTotals(null);
                  setQueryRows([]);
                  setPageRows([]);
                  setSites([]);
                }}
                className="ml-2 rounded-md px-2 py-1 text-xs text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>

          {loading && <Spinner />}
          {error && <ErrorBox message={error} onRetry={loadData} />}

          {!loading && !error && totals && (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard
                  label="Total Clicks"
                  value={totals.clicks.toLocaleString()}
                  sub={`Last ${range} days`}
                  color="blue"
                />
                <MetricCard
                  label="Total Impressions"
                  value={totals.impressions.toLocaleString()}
                  sub={`Last ${range} days`}
                  color="purple"
                />
                <MetricCard
                  label="Avg CTR"
                  value={`${(totals.ctr * 100).toFixed(1)}%`}
                  color="green"
                />
                <MetricCard
                  label="Avg Position"
                  value={totals.position.toFixed(1)}
                  color="amber"
                />
              </div>

              {/* Top Queries table */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Top Queries ({queryRows.length})
                </h3>
                {queryRows.length === 0 ? (
                  <p className="text-xs text-gray-400">No query data available</p>
                ) : (
                  <div className="overflow-x-auto">
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
                        {queryRows.map((row, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 text-gray-700 font-medium max-w-[300px] truncate">
                              {row.keys[0]}
                            </td>
                            <td className="py-2 text-right text-blue-700 font-medium">
                              {row.clicks.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {row.impressions.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {(row.ctr * 100).toFixed(1)}%
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {row.position.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Top Pages table */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Top Pages ({pageRows.length})
                </h3>
                {pageRows.length === 0 ? (
                  <p className="text-xs text-gray-400">No page data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-gray-500">
                          <th className="pb-2 font-medium">Page</th>
                          <th className="pb-2 font-medium text-right">Clicks</th>
                          <th className="pb-2 font-medium text-right">Impressions</th>
                          <th className="pb-2 font-medium text-right">CTR</th>
                          <th className="pb-2 font-medium text-right">Position</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((row, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 text-gray-700 font-medium max-w-[350px] truncate">
                              {row.keys[0]}
                            </td>
                            <td className="py-2 text-right text-blue-700 font-medium">
                              {row.clicks.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {row.impressions.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {(row.ctr * 100).toFixed(1)}%
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {row.position.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Google Analytics (GA4) Tab                                         */
/* ------------------------------------------------------------------ */

interface GA4Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

interface GA4Report {
  rows?: GA4Row[];
  totals?: { metricValues: { value: string }[] }[];
}

interface GA4Property {
  name: string;
  displayName: string;
}

function GA4Tab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 28 | 90>(28);
  const [properties, setProperties] = useState<GA4Property[]>([]);
  const [propertyId, setPropertyId] = useState<string>(
    import.meta.env.VITE_GA4_PROPERTY_ID || ""
  );
  const [kpis, setKpis] = useState<{
    activeUsers: number;
    sessions: number;
    pageViews: number;
    avgSessionDuration: number;
  } | null>(null);
  const [dailySessions, setDailySessions] = useState<{ date: string; sessions: number }[]>([]);
  const [topPages, setTopPages] = useState<
    { path: string; views: number; users: number; avgEngagement: number }[]
  >([]);
  const [trafficSources, setTrafficSources] = useState<
    { source: string; sessions: number; users: number }[]
  >([]);

  const handleConnect = useCallback(async () => {
    try {
      await startOAuthFlow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth flow failed");
    }
  }, []);

  const loadProperties = useCallback(async () => {
    try {
      const result = await ga4ListProperties();
      const props = (result as { properties?: GA4Property[] }).properties || [];
      setProperties(props);
      if (!propertyId && props.length > 0) {
        // Extract numeric ID from "properties/123456" format
        const firstId = props[0].name.replace("properties/", "");
        setPropertyId(firstId);
      }
    } catch {
      // Properties listing may fail if no admin access; user can enter ID manually
    }
  }, [propertyId]);

  const loadData = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);
    try {
      const startDate = dateStr(range);
      const endDate = dateStr(1);

      const [kpiReport, dailyReport, pagesReport, sourcesReport] = await Promise.all([
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
            { name: "averageSessionDuration" },
          ],
        }) as Promise<GA4Report>,
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "date" }],
          metrics: [{ name: "sessions" }],
          orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
        }) as Promise<GA4Report>,
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "pagePath" }],
          metrics: [
            { name: "screenPageViews" },
            { name: "activeUsers" },
            { name: "userEngagementDuration" },
          ],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: 20,
        }) as Promise<GA4Report>,
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "sessionSourceMedium" }],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
          ],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 15,
        }) as Promise<GA4Report>,
      ]);

      // Parse KPI totals
      const kpiTotals = kpiReport.totals?.[0]?.metricValues || kpiReport.rows?.[0]?.metricValues;
      if (kpiTotals) {
        setKpis({
          activeUsers: parseInt(kpiTotals[0]?.value || "0", 10),
          sessions: parseInt(kpiTotals[1]?.value || "0", 10),
          pageViews: parseInt(kpiTotals[2]?.value || "0", 10),
          avgSessionDuration: parseFloat(kpiTotals[3]?.value || "0"),
        });
      }

      // Parse daily sessions
      const daily = (dailyReport.rows || []).map((row) => {
        const raw = row.dimensionValues[0].value; // YYYYMMDD
        const formatted = `${raw.slice(4, 6)}/${raw.slice(6, 8)}`;
        return {
          date: formatted,
          sessions: parseInt(row.metricValues[0].value, 10),
        };
      });
      setDailySessions(daily);

      // Parse top pages
      const pages = (pagesReport.rows || []).map((row) => {
        const views = parseInt(row.metricValues[0].value, 10);
        const users = parseInt(row.metricValues[1].value, 10);
        const totalEngagement = parseFloat(row.metricValues[2].value);
        return {
          path: row.dimensionValues[0].value,
          views,
          users,
          avgEngagement: users > 0 ? totalEngagement / users : 0,
        };
      });
      setTopPages(pages);

      // Parse traffic sources
      const sources = (sourcesReport.rows || []).map((row) => ({
        source: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value, 10),
        users: parseInt(row.metricValues[1].value, 10),
      }));
      setTrafficSources(sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Analytics data");
    } finally {
      setLoading(false);
    }
  }, [propertyId, range]);

  useEffect(() => {
    const token = getStoredToken();
    if (token && isConfigured()) {
      loadProperties();
    }
  }, [loadProperties]);

  useEffect(() => {
    const token = getStoredToken();
    if (token && propertyId) {
      loadData();
    }
  }, [loadData, propertyId]);

  const token = getStoredToken();

  const maxDailySessions = Math.max(...dailySessions.map((d) => d.sessions), 1);

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }

  return (
    <div className="space-y-6">
      <GoogleAuthBanner onConnect={handleConnect} />

      {token && isConfigured() && (
        <>
          {/* Property selector + date range + disconnect */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xs text-gray-500 shrink-0">Property:</span>
              {properties.length > 0 ? (
                <select
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0 flex-1"
                >
                  {properties.map((p) => {
                    const id = p.name.replace("properties/", "");
                    return (
                      <option key={id} value={id}>
                        {p.displayName} ({id})
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  type="text"
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  placeholder="GA4 Property ID (e.g. 123456789)"
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0 flex-1"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Range:</span>
              {([7, 28, 90] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    range === r
                      ? "bg-blue-100 text-blue-700"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {r}d
                </button>
              ))}
              <button
                onClick={() => {
                  clearToken();
                  setKpis(null);
                  setDailySessions([]);
                  setTopPages([]);
                  setTrafficSources([]);
                  setProperties([]);
                }}
                className="ml-2 rounded-md px-2 py-1 text-xs text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>

          {loading && <Spinner />}
          {error && <ErrorBox message={error} onRetry={loadData} />}

          {!loading && !error && kpis && (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard
                  label="Active Users"
                  value={kpis.activeUsers.toLocaleString()}
                  sub={`Last ${range} days`}
                  color="blue"
                />
                <MetricCard
                  label="Sessions"
                  value={kpis.sessions.toLocaleString()}
                  sub={`Last ${range} days`}
                  color="green"
                />
                <MetricCard
                  label="Page Views"
                  value={kpis.pageViews.toLocaleString()}
                  sub={`Last ${range} days`}
                  color="purple"
                />
                <MetricCard
                  label="Avg Session Duration"
                  value={formatDuration(kpis.avgSessionDuration)}
                  color="amber"
                />
              </div>

              {/* Sessions by Day chart */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Sessions by Day
                </h3>
                {dailySessions.length === 0 ? (
                  <p className="text-xs text-gray-400">No data</p>
                ) : (
                  <div className="flex items-end gap-1 h-40">
                    {dailySessions.map((day) => (
                      <div
                        key={day.date}
                        className="flex-1 flex flex-col items-center gap-1"
                      >
                        <span className="text-[10px] font-medium text-gray-600">
                          {day.sessions}
                        </span>
                        <div
                          className="w-full bg-blue-400 rounded-t-md transition-all duration-500 min-h-[2px]"
                          style={{
                            height: `${(day.sessions / maxDailySessions) * 100}%`,
                          }}
                        />
                        <span className="text-[10px] text-gray-400">
                          {day.date}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Top Pages table */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Top Pages ({topPages.length})
                </h3>
                {topPages.length === 0 ? (
                  <p className="text-xs text-gray-400">No page data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-gray-500">
                          <th className="pb-2 font-medium">Page Path</th>
                          <th className="pb-2 font-medium text-right">Views</th>
                          <th className="pb-2 font-medium text-right">Users</th>
                          <th className="pb-2 font-medium text-right">Avg Engagement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topPages.map((page, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 text-gray-700 font-medium max-w-[350px] truncate">
                              {page.path}
                            </td>
                            <td className="py-2 text-right text-blue-700 font-medium">
                              {page.views.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {page.users.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {formatDuration(page.avgEngagement)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Traffic Sources table */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Traffic Sources ({trafficSources.length})
                </h3>
                {trafficSources.length === 0 ? (
                  <p className="text-xs text-gray-400">No traffic source data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-gray-500">
                          <th className="pb-2 font-medium">Source / Medium</th>
                          <th className="pb-2 font-medium text-right">Sessions</th>
                          <th className="pb-2 font-medium text-right">Users</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trafficSources.map((src, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 text-gray-700 font-medium">
                              {src.source}
                            </td>
                            <td className="py-2 text-right text-blue-700 font-medium">
                              {src.sessions.toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-gray-600">
                              {src.users.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main App                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Ads Audit Tab                                                      */
/* ------------------------------------------------------------------ */

interface AuditDiscrepancy {
  date: string;
  adsClicks: number;
  ga4Sessions: number;
  gap: number;
  gapPct: number;
}

function AdsAuditTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 28 | 90>(28);

  // Data
  const [campaigns, setCampaigns] = useState<AdsCampaignRow[]>([]);
  const [keywords, setKeywords] = useState<AdsKeywordRow[]>([]);
  const [dailyAds, setDailyAds] = useState<AdsDailyRow[]>([]);
  const [dailyGA4, setDailyGA4] = useState<{ date: string; sessions: number; users: number }[]>([]);
  const [scQueries, setScQueries] = useState<{ query: string; clicks: number; impressions: number; ctr: number; position: number }[]>([]);
  const [discrepancies, setDiscrepancies] = useState<AuditDiscrepancy[]>([]);
  const [ga4Sources, setGa4Sources] = useState<{ source: string; sessions: number; users: number }[]>([]);
  const [ga4Total, setGa4Total] = useState<{ sessions: number; users: number }>({ sessions: 0, users: 0 });

  // AI
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const propertyId = import.meta.env.VITE_GA4_PROPERTY_ID || "";

  const loadData = useCallback(async () => {
    const config = getAdsConfig();
    if (!config) {
      setError("Google Ads not configured. Set VITE_GOOGLE_ADS_DEVELOPER_TOKEN and VITE_GOOGLE_ADS_CUSTOMER_ID in .env.local");
      return;
    }
    if (!propertyId) {
      setError("GA4 not configured. Set VITE_GA4_PROPERTY_ID in .env.local");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const startDate = dateStr(range);
      const endDate = dateStr(1);

      const [adsDaily, adsCampaigns, adsKw, ga4Daily, ga4BySource, ga4Totals, scData] = await Promise.all([
        adsGetDailyPerformance(config.customerId, startDate, endDate),
        adsGetCampaignPerformance(config.customerId, startDate, endDate),
        adsGetKeywordPerformance(config.customerId, startDate, endDate),
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
          ],
          dimensionFilter: {
            filter: {
              fieldName: "sessionDefaultChannelGroup",
              stringFilter: { matchType: "EXACT", value: "Paid Search" },
            },
          },
          orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
          limit: 100,
        }),
        // All traffic by source/medium to see where GA4 classifies Ads traffic
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "sessionSourceMedium" }],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
          ],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 30,
        }),
        // Total sessions (all sources) to compare
        ga4RunReport(propertyId, {
          dateRanges: [{ startDate, endDate }],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
          ],
        }),
        searchConsoleQuery("sc-domain:plotwell.co", {
          startDate,
          endDate,
          dimensions: ["query"],
          rowLimit: 50,
        }).catch(() => []),
      ]);

      setDailyAds(adsDaily);
      setCampaigns(adsCampaigns);
      setKeywords(adsKw);

      // Parse GA4 daily paid search
      const ga4Rows = ((ga4Daily as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows || []).map((row) => {
        const raw = row.dimensionValues[0].value;
        const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
        return {
          date: formatted,
          sessions: parseInt(row.metricValues[0].value, 10),
          users: parseInt(row.metricValues[1].value, 10),
        };
      });
      setDailyGA4(ga4Rows);

      // Parse GA4 sources breakdown
      const sourceRows = ((ga4BySource as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows || []).map((row) => ({
        source: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value, 10),
        users: parseInt(row.metricValues[1].value, 10),
      }));
      setGa4Sources(sourceRows);

      // Parse GA4 totals
      const totalsData = ga4Totals as { rows?: { metricValues: { value: string }[] }[] };
      const totRow = totalsData.rows?.[0];
      setGa4Total({
        sessions: totRow ? parseInt(totRow.metricValues[0].value, 10) : 0,
        users: totRow ? parseInt(totRow.metricValues[1].value, 10) : 0,
      });

      // Parse SC
      setScQueries(scData.map((r) => ({
        query: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })));

      // Calculate discrepancies
      const ga4ByDate: Record<string, number> = {};
      for (const row of ga4Rows) ga4ByDate[row.date] = row.sessions;

      const disc: AuditDiscrepancy[] = [];
      for (const day of adsDaily) {
        const ga4Sessions = ga4ByDate[day.date] || 0;
        const gap = day.clicks - ga4Sessions;
        const gapPct = day.clicks > 0 ? (gap / day.clicks) * 100 : 0;
        disc.push({ date: day.date, adsClicks: day.clicks, ga4Sessions, gap, gapPct });
      }
      setDiscrepancies(disc);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [range, propertyId]);

  useEffect(() => {
    if (getStoredToken() && isAdsConfigured()) loadData();
  }, [loadData]);

  const handleConnect = useCallback(async () => {
    try {
      await startOAuthFlow();
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth flow failed");
    }
  }, [loadData]);

  const runAIAnalysis = useCallback(async () => {
    setIsAnalyzing(true);
    setAiAnalysis("");

    const totalAdsClicks = dailyAds.reduce((s, d) => s + d.clicks, 0);
    const totalGA4Sessions = dailyGA4.reduce((s, d) => s + d.sessions, 0);
    const totalSpend = campaigns.reduce((s, c) => s + c.costMicros, 0) / 1_000_000;
    const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);

    const prompt = `You are an expert Google Ads and GA4 analyst. Analyze this data for plotwell.co (a screenplay editor SaaS) and give actionable recommendations.

## Summary
- Period: last ${range} days
- Total Ads clicks: ${totalAdsClicks}
- Total GA4 paid search sessions: ${totalGA4Sessions}
- Tracking gap: ${totalAdsClicks - totalGA4Sessions} clicks (${totalAdsClicks > 0 ? (((totalAdsClicks - totalGA4Sessions) / totalAdsClicks) * 100).toFixed(1) : 0}%)
- Total spend: €${totalSpend.toFixed(2)}
- Total conversions: ${totalConversions}
- CPA: ${totalConversions > 0 ? `€${(totalSpend / totalConversions).toFixed(2)}` : "N/A"}

## Campaigns
${campaigns.map((c) => `- ${c.campaign}: ${c.clicks} clicks, €${(c.costMicros / 1_000_000).toFixed(2)} spend, ${c.conversions} conv, CTR ${(c.ctr * 100).toFixed(2)}%`).join("\n")}

## Daily Discrepancies (Ads clicks vs GA4 sessions)
${discrepancies.map((d) => `- ${d.date}: Ads ${d.adsClicks} / GA4 ${d.ga4Sessions} (gap: ${d.gap}, ${d.gapPct.toFixed(0)}%)`).join("\n")}

## Top Ads Keywords
${keywords.slice(0, 20).map((k) => `- "${k.keyword}" (${k.matchType}): ${k.impressions} imp, ${k.clicks} clicks, €${(k.costMicros / 1_000_000).toFixed(2)}, QS: ${k.qualityScore ?? "N/A"}`).join("\n")}

## Top Organic Queries (Search Console)
${scQueries.slice(0, 20).map((q) => `- "${q.query}": ${q.impressions} imp, ${q.clicks} clicks, CTR ${(q.ctr * 100).toFixed(1)}%, pos ${q.position.toFixed(1)}`).join("\n")}

Provide analysis in these sections:
1. **Tracking Gap Diagnosis** - Why are Ads clicks not showing in GA4? Quantify the issue.
2. **Campaign Performance** - Which campaigns are performing well/poorly? CPA analysis.
3. **Keyword Opportunities** - Compare paid keywords vs organic queries. Find overlap and gaps.
4. **Budget Recommendations** - Where to increase/decrease spend.
5. **Quick Wins** - Top 3 actions to take this week.

Be specific with numbers. Use tables where helpful. Write in English.`;

    try {
      const result = await generate(prompt);
      setAiAnalysis(result);
    } catch {
      setAiAnalysis("Failed to generate analysis. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  }, [range, dailyAds, dailyGA4, campaigns, keywords, scQueries, discrepancies]);

  if (!getStoredToken()) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <p className="mb-4 text-gray-600">Connect your Google account to audit Ads vs Analytics</p>
        <button onClick={handleConnect} className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-medium text-white hover:bg-amber-700">
          Connect Google Account
        </button>
      </div>
    );
  }

  if (!isAdsConfigured()) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6">
        <p className="font-medium text-red-800">Google Ads not configured</p>
        <p className="mt-1 text-sm text-red-600">
          Set <code className="rounded bg-red-100 px-1">VITE_GOOGLE_ADS_DEVELOPER_TOKEN</code> and{" "}
          <code className="rounded bg-red-100 px-1">VITE_GOOGLE_ADS_CUSTOMER_ID</code> in your .env.local file.
        </p>
      </div>
    );
  }

  const totalAdsClicks = dailyAds.reduce((s, d) => s + d.clicks, 0);
  const totalAdsImpressions = dailyAds.reduce((s, d) => s + d.impressions, 0);
  const totalGA4Sessions = dailyGA4.reduce((s, d) => s + d.sessions, 0);
  const totalSpend = campaigns.reduce((s, c) => s + c.costMicros, 0) / 1_000_000;
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);
  const trackingGap = totalAdsClicks > 0 ? ((totalAdsClicks - totalGA4Sessions) / totalAdsClicks) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {([7, 28, 90] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r ? "bg-amber-100 text-amber-800" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button
            onClick={runAIAnalysis}
            disabled={isAnalyzing || campaigns.length === 0}
            className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {isAnalyzing ? "Analyzing..." : "AI Analysis"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard label="Ads Clicks" value={totalAdsClicks.toLocaleString()} color="blue" />
        <MetricCard label="GA4 Sessions" value={totalGA4Sessions.toLocaleString()} color="green" />
        <MetricCard
          label="Tracking Gap"
          value={`${trackingGap.toFixed(0)}%`}
          sub={`${totalAdsClicks - totalGA4Sessions} lost`}
          color={trackingGap > 50 ? "red" : trackingGap > 20 ? "amber" : "green"}
        />
        <MetricCard label="Impressions" value={totalAdsImpressions.toLocaleString()} color="purple" />
        <MetricCard label="Spend" value={`€${totalSpend.toFixed(2)}`} color="amber" />
        <MetricCard
          label="CPA"
          value={totalConversions > 0 ? `€${(totalSpend / totalConversions).toFixed(2)}` : "N/A"}
          sub={`${totalConversions} conv`}
          color={totalConversions > 0 ? "green" : "red"}
        />
      </div>

      {/* Daily Comparison Table */}
      {discrepancies.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-800">Daily: Ads Clicks vs GA4 Paid Sessions</h3>
          </div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Date</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Ads Clicks</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">GA4 Sessions</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Gap</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Gap %</th>
                </tr>
              </thead>
              <tbody>
                {discrepancies.map((d) => (
                  <tr key={d.date} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-700">{d.date}</td>
                    <td className="px-4 py-2 text-right font-medium text-blue-700">{d.adsClicks}</td>
                    <td className="px-4 py-2 text-right font-medium text-green-700">{d.ga4Sessions}</td>
                    <td className={`px-4 py-2 text-right font-medium ${d.gap > 0 ? "text-red-600" : "text-green-600"}`}>
                      {d.gap > 0 ? `+${d.gap}` : d.gap}
                    </td>
                    <td className={`px-4 py-2 text-right ${d.gapPct > 50 ? "text-red-600 font-semibold" : d.gapPct > 20 ? "text-amber-600" : "text-gray-500"}`}>
                      {d.gapPct.toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* GA4 Source Diagnosis */}
      {ga4Sources.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 overflow-hidden">
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-amber-800">
              GA4 Traffic Sources (total: {ga4Total.sessions} sessions, {ga4Total.users} users)
            </h3>
            <p className="text-xs text-amber-600 mt-0.5">Where is GA4 classifying your traffic? Look for google/cpc here.</p>
          </div>
          <div className="overflow-x-auto max-h-60">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-amber-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Source / Medium</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Sessions</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Users</th>
                </tr>
              </thead>
              <tbody>
                {ga4Sources.map((s, i) => (
                  <tr key={i} className={`border-t border-amber-100 ${s.source.includes("cpc") || s.source.includes("paid") ? "bg-amber-100 font-semibold" : ""}`}>
                    <td className="px-4 py-1.5 text-gray-700">{s.source}</td>
                    <td className="px-4 py-1.5 text-right">{s.sessions}</td>
                    <td className="px-4 py-1.5 text-right">{s.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Campaigns */}
      {campaigns.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-800">Campaign Performance</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Campaign</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Impressions</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Clicks</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">CTR</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Spend</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Avg CPC</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Conv</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.campaignId} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-800 font-medium">{c.campaign}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{c.impressions.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-medium text-blue-700">{c.clicks}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{(c.ctr * 100).toFixed(2)}%</td>
                    <td className="px-4 py-2 text-right text-gray-700">€{(c.costMicros / 1_000_000).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right text-gray-600">€{(c.avgCpc / 1_000_000).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-medium text-green-700">{c.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Keywords: Paid vs Organic */}
      {(keywords.length > 0 || scQueries.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Paid Keywords */}
          {keywords.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="border-b border-gray-100 bg-blue-50 px-4 py-3">
                <h3 className="text-sm font-semibold text-blue-800">Paid Keywords (Google Ads)</h3>
              </div>
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Keyword</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Clicks</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Cost</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">QS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.slice(0, 25).map((k, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-700 truncate max-w-[200px]" title={k.keyword}>{k.keyword}</td>
                        <td className="px-3 py-1.5 text-right text-blue-700 font-medium">{k.clicks}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">€{(k.costMicros / 1_000_000).toFixed(2)}</td>
                        <td className={`px-3 py-1.5 text-right font-medium ${
                          k.qualityScore === null ? "text-gray-400" :
                          k.qualityScore >= 7 ? "text-green-600" :
                          k.qualityScore >= 5 ? "text-amber-600" : "text-red-600"
                        }`}>
                          {k.qualityScore ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Organic Queries */}
          {scQueries.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="border-b border-gray-100 bg-green-50 px-4 py-3">
                <h3 className="text-sm font-semibold text-green-800">Organic Queries (Search Console)</h3>
              </div>
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Query</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Clicks</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Imp</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Pos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scQueries.slice(0, 25).map((q, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-700 truncate max-w-[200px]" title={q.query}>{q.query}</td>
                        <td className="px-3 py-1.5 text-right text-green-700 font-medium">{q.clicks}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{q.impressions}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{q.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI Analysis */}
      {aiAnalysis && <MarkdownRenderer content={aiAnalysis} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Competitor Tab                                                     */
/* ------------------------------------------------------------------ */

const COMPETITOR_KEYWORDS = [
  "screenplay software", "screenwriting software", "script writing app",
  "final draft alternative", "celtx alternative", "screenplay editor",
  "ai screenwriting", "screenplay formatter", "film production software",
  "screenplay writing tool", "script editor online", "screenwriting app",
  "storyboard software", "production planning software",
  "ai script generator", "screenplay collaboration",
];

const COMPETITORS = [
  { name: "Final Draft", domain: "finaldraft.com", weakness: "Expensive ($250), no AI, desktop only" },
  { name: "Celtx", domain: "celtx.com", weakness: "Limited free plan, dated UI, slow" },
  { name: "Arc Studio Pro", domain: "arcstudiopro.com", weakness: "No production tools, limited AI" },
  { name: "WriterSolo", domain: "writersolo.com", weakness: "Limited features, small team" },
  { name: "Highland", domain: "highland2.app", weakness: "Mac only, no collaboration" },
];

function CompetitorTab() {
  const [loading, setLoading] = useState(false);
  const [scData, setScData] = useState<SCRow[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = getStoredToken();
  const site = import.meta.env.VITE_SEARCH_CONSOLE_SITE_URL || "";

  const loadData = useCallback(async () => {
    if (!token || !site) return;
    setLoading(true);
    setError(null);
    try {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);
      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const result = await searchConsoleQuery(site, {
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        dimensions: ["query"],
        rowLimit: 500,
      });
      const rows = (Array.isArray(result) ? result : []) as SCRow[];
      setScData(rows.filter((r: SCRow) =>
        COMPETITOR_KEYWORDS.some((kw) => r.keys[0].toLowerCase().includes(kw.split(" ")[0]))
        || r.keys[0].toLowerCase().includes("plotwell")
        || r.keys[0].toLowerCase().includes("screenplay")
        || r.keys[0].toLowerCase().includes("screenwriting")
        || r.keys[0].toLowerCase().includes("script")
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    }
    setLoading(false);
  }, [token, site]);

  useEffect(() => { if (token) loadData(); }, [token, loadData]);

  const analyzeCompetitors = async () => {
    setIsAnalyzing(true);
    const scContext = scData.length > 0
      ? `plotwell's real search data (90d):\n${scData.slice(0, 30).map((r) => `- "${r.keys[0]}" pos:${r.position.toFixed(1)} clicks:${r.clicks} imp:${r.impressions}`).join("\n")}`
      : "No search data available yet (site is new).";

    try {
      const result = await generate(
        `Analyze plotwell's competitive positioning:\n\n${scContext}\n\nCompetitors:\n${COMPETITORS.map((c) => `- ${c.name} (${c.domain}): ${c.weakness}`).join("\n")}\n\nTarget keywords:\n${COMPETITOR_KEYWORDS.join(", ")}\n\nProvide:\n1. Keywords where plotwell should rank higher (with specific content suggestions)\n2. Content gaps vs competitors\n3. Quick wins for improving rankings\n4. Competitor weaknesses to exploit in content/ads\n5. Recommended blog post topics to capture competitor traffic\n\nBe specific and actionable. Never use em dashes.`,
        { system: "You are an SEO competitive analyst for plotwell, a screenplay editor SaaS. Be direct and specific.", maxTokens: 2500, temperature: 0.7 }
      );
      setAiAnalysis(result);
    } catch (err) {
      setAiAnalysis(`Error: ${err instanceof Error ? err.message : "Failed to analyze"}`);
    }
    setIsAnalyzing(false);
  };

  // Matched keywords (where plotwell appears in SC data)
  const matched = COMPETITOR_KEYWORDS.map((kw) => {
    const row = scData.find((r) => r.keys[0].toLowerCase().includes(kw));
    return { keyword: kw, data: row || null };
  });

  const ranking = matched.filter((m) => m.data);
  const gaps = matched.filter((m) => !m.data);

  return (
    <div className="space-y-6">
      {/* Competitor cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {COMPETITORS.map((c) => (
          <div key={c.name} className="rounded-xl border border-gray-200 bg-white p-4">
            <h4 className="text-sm font-semibold text-gray-800">{c.name}</h4>
            <p className="text-xs text-gray-400 mt-0.5">{c.domain}</p>
            <p className="text-xs text-red-600 mt-2">{c.weakness}</p>
          </div>
        ))}
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <h4 className="text-sm font-semibold text-amber-800">plotwell</h4>
          <p className="text-xs text-amber-600 mt-0.5">plotwell.co</p>
          <p className="text-xs text-green-600 mt-2">AI native + production tools + affordable</p>
        </div>
      </div>

      {!token && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          Connect Google in the Search Console tab to see real keyword positions.
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {error && <ErrorBox message={error} onRetry={loadData} />}

      {/* Keyword positions table */}
      {!loading && token && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Keyword Tracking ({ranking.length}/{COMPETITOR_KEYWORDS.length} ranking)
          </h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Keyword</th>
                <th className="pb-2 font-medium text-right">Position</th>
                <th className="pb-2 font-medium text-right">Impressions</th>
                <th className="pb-2 font-medium text-right">Clicks</th>
                <th className="pb-2 font-medium text-right">CTR</th>
                <th className="pb-2 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {matched.map(({ keyword, data }) => (
                <tr key={keyword} className="border-b border-gray-50">
                  <td className="py-2 text-gray-700 font-medium">{keyword}</td>
                  {data ? (
                    <>
                      <td className="py-2 text-right font-semibold">
                        <span className={data.position <= 3 ? "text-green-600" : data.position <= 10 ? "text-amber-600" : "text-red-600"}>
                          {data.position.toFixed(1)}
                        </span>
                      </td>
                      <td className="py-2 text-right text-gray-600">{data.impressions}</td>
                      <td className="py-2 text-right text-gray-600">{data.clicks}</td>
                      <td className="py-2 text-right text-gray-600">{(data.ctr * 100).toFixed(1)}%</td>
                      <td className="py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                          data.position <= 3 ? "bg-green-100 text-green-700"
                          : data.position <= 10 ? "bg-amber-100 text-amber-700"
                          : "bg-red-100 text-red-700"
                        }`}>
                          {data.position <= 3 ? "Top 3" : data.position <= 10 ? "Page 1" : `Page ${Math.ceil(data.position / 10)}`}
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 text-right text-gray-300">-</td>
                      <td className="py-2 text-right text-gray-300">-</td>
                      <td className="py-2 text-right text-gray-300">-</td>
                      <td className="py-2 text-right text-gray-300">-</td>
                      <td className="py-2 text-center">
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Not ranking</span>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Gap keywords */}
      {gaps.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-red-800 mb-2">
            Keyword Gaps ({gaps.length})
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            plotwell doesn't rank for these target keywords yet. Create content to capture them.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {gaps.map(({ keyword }) => (
              <span key={keyword} className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700">
                {keyword}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* AI Analysis */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">AI Competitive Analysis</h3>
          <div className="flex gap-2">
            {aiAnalysis && <CopyButton text={aiAnalysis} />}
            <button
              onClick={analyzeCompetitors}
              disabled={isAnalyzing}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {isAnalyzing ? "Analyzing..." : aiAnalysis ? "Re-analyze" : "Analyze Competitors"}
            </button>
          </div>
        </div>
        {aiAnalysis && (
          <MarkdownRenderer content={aiAnalysis} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Users Tab (Supabase Auth)                                          */
/* ------------------------------------------------------------------ */

function UsersTab() {
  const [users, setUsers] = useState<SupabaseUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const u = await fetchAllSupabaseUsers();
      setUsers(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { configured } = getSupabaseConfig();
  if (!configured) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
        Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env.local</code>
      </div>
    );
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={load} />;

  const now = Date.now();
  const DAY = 86400000;

  // Activity classification
  const activeToday = users.filter(
    (u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() < DAY
  ).length;
  const active7d = users.filter(
    (u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() < 7 * DAY
  ).length;
  const active30d = users.filter(
    (u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() < 30 * DAY
  ).length;
  const neverSignedIn = users.filter((u) => !u.last_sign_in_at).length;

  // Signups by day (last 30 days)
  const signupsByDay: Record<string, number> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    signupsByDay[d.toISOString().split("T")[0]] = 0;
  }
  for (const u of users) {
    const day = u.created_at.split("T")[0];
    if (day in signupsByDay) signupsByDay[day]++;
  }
  const sortedDays = Object.entries(signupsByDay);
  const maxDaily = Math.max(...sortedDays.map(([, v]) => v), 1);

  // Signups by month (all time)
  const signupsByMonth: Record<string, number> = {};
  for (const u of users) {
    const d = new Date(u.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    signupsByMonth[key] = (signupsByMonth[key] || 0) + 1;
  }
  const sortedMonths = Object.entries(signupsByMonth).sort(([a], [b]) => a.localeCompare(b));
  const maxMonthly = Math.max(...sortedMonths.map(([, v]) => v), 1);

  // Signups this week / this month
  const weekAgo = now - 7 * DAY;
  const monthAgo = now - 30 * DAY;
  const signupsThisWeek = users.filter((u) => new Date(u.created_at).getTime() > weekAgo).length;
  const signupsThisMonth = users.filter((u) => new Date(u.created_at).getTime() > monthAgo).length;

  // Auth providers breakdown
  const providerCounts: Record<string, number> = {};
  for (const u of users) {
    const provider = u.app_metadata?.provider || "email";
    providerCounts[provider] = (providerCounts[provider] || 0) + 1;
  }
  const sortedProviders = Object.entries(providerCounts).sort(([, a], [, b]) => b - a);

  // Activity buckets for last sign-in
  const activityBuckets = [
    { label: "Today", count: activeToday, color: "bg-green-400" },
    { label: "1-7 days", count: active7d - activeToday, color: "bg-emerald-300" },
    { label: "7-30 days", count: active30d - active7d, color: "bg-amber-300" },
    { label: "30-90 days", count: users.filter((u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() >= 30 * DAY && now - new Date(u.last_sign_in_at).getTime() < 90 * DAY).length, color: "bg-orange-300" },
    { label: "90+ days", count: users.filter((u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() >= 90 * DAY).length, color: "bg-red-300" },
    { label: "Never", count: neverSignedIn, color: "bg-gray-300" },
  ];
  const maxBucket = Math.max(...activityBuckets.map((b) => b.count), 1);

  // Sort users by most recent first
  const sorted = [...users].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  function timeAgo(dateStr: string | null): string {
    if (!dateStr) return "Never";
    const diff = now - new Date(dateStr).getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < DAY) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
    if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))}w ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <MetricCard label="Total Users" value={String(users.length)} color="blue" />
        <MetricCard label="Signups (7d)" value={String(signupsThisWeek)} color="green" />
        <MetricCard label="Signups (30d)" value={String(signupsThisMonth)} color="amber" />
        <MetricCard label="DAU" value={String(activeToday)} sub={`${users.length > 0 ? ((activeToday / users.length) * 100).toFixed(0) : 0}%`} color="purple" />
        <MetricCard label="WAU / MAU" value={`${active7d} / ${active30d}`} color="blue" />
      </div>

      {/* Daily signups chart (last 30 days) */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          Daily Signups (last 30 days)
        </h3>
        <div className="flex items-end gap-[2px] h-28">
          {sortedDays.map(([day, count]) => (
            <div key={day} className="flex-1 flex flex-col items-center gap-0.5" title={`${day}: ${count}`}>
              {count > 0 && (
                <span className="text-[9px] font-medium text-gray-500">{count}</span>
              )}
              <div
                className="w-full bg-blue-400 rounded-t-sm transition-all duration-300 min-h-[1px]"
                style={{ height: count > 0 ? `${(count / maxDaily) * 100}%` : "1px", opacity: count > 0 ? 1 : 0.2 }}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-gray-400">{sortedDays[0]?.[0]?.slice(5)}</span>
          <span className="text-[10px] text-gray-400">{sortedDays[sortedDays.length - 1]?.[0]?.slice(5)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Monthly signups chart */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">
            Monthly Signups (all time)
          </h3>
          {sortedMonths.length === 0 ? (
            <p className="text-xs text-gray-400">No data</p>
          ) : (
            <div className="flex items-end gap-1 h-28">
              {sortedMonths.map(([month, count]) => (
                <div key={month} className="flex-1 flex flex-col items-center gap-0.5">
                  <span className="text-[9px] font-medium text-gray-500">{count}</span>
                  <div
                    className="w-full bg-amber-400 rounded-t-sm transition-all duration-300 min-h-[2px]"
                    style={{ height: `${(count / maxMonthly) * 100}%` }}
                  />
                  <span className="text-[9px] text-gray-400">{month.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Activity distribution */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">
            Last Sign-in Distribution
          </h3>
          <div className="space-y-2">
            {activityBuckets.map((bucket) => (
              <div key={bucket.label} className="flex items-center gap-3">
                <span className="text-xs text-gray-500 w-16 text-right">{bucket.label}</span>
                <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${bucket.color} rounded-full transition-all duration-500`}
                    style={{ width: `${(bucket.count / maxBucket) * 100}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-600 w-8">{bucket.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Auth providers */}
      {sortedProviders.length > 1 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Auth Providers</h3>
          <div className="flex gap-3">
            {sortedProviders.map(([provider, count]) => (
              <div key={provider} className="rounded-lg border border-gray-200 px-3 py-2">
                <p className="text-xs text-gray-500 capitalize">{provider}</p>
                <p className="text-lg font-bold text-gray-800">{count}</p>
                <p className="text-[10px] text-gray-400">{((count / users.length) * 100).toFixed(0)}%</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User table */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          All Users ({users.length})
        </h3>
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">User</th>
                <th className="pb-2 font-medium">Provider</th>
                <th className="pb-2 font-medium">Signed Up</th>
                <th className="pb-2 font-medium">Last Sign-in</th>
                <th className="pb-2 font-medium text-right">Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.map((u) => {
                const lastActive = u.last_sign_in_at
                  ? now - new Date(u.last_sign_in_at).getTime()
                  : null;
                const activityColor = !lastActive
                  ? "bg-gray-100 text-gray-500"
                  : lastActive < DAY
                    ? "bg-green-100 text-green-700"
                    : lastActive < 7 * DAY
                      ? "bg-emerald-100 text-emerald-700"
                      : lastActive < 30 * DAY
                        ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-600";

                return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="py-2">
                      <div>
                        <p className="font-medium text-gray-800">
                          {u.user_metadata?.full_name || u.user_metadata?.name || "---"}
                        </p>
                        <p className="text-gray-400">{u.email || "---"}</p>
                      </div>
                    </td>
                    <td className="py-2">
                      <span className="capitalize text-gray-600">
                        {u.app_metadata?.provider || "email"}
                      </span>
                    </td>
                    <td className="py-2 text-gray-600">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-gray-600">
                      {timeAgo(u.last_sign_in_at)}
                    </td>
                    <td className="py-2 text-right">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${activityColor}`}>
                        {!u.last_sign_in_at
                          ? "Never"
                          : lastActive! < DAY
                            ? "Active"
                            : lastActive! < 7 * DAY
                              ? "This week"
                              : lastActive! < 30 * DAY
                                ? "This month"
                                : "Inactive"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "revenue", label: "Revenue", icon: "\u{1F4B0}" },
  { id: "customers", label: "Customers", icon: "\u{1F465}" },
  { id: "users", label: "Users", icon: "\u{1F464}" },
  { id: "search-console", label: "Search Console", icon: "\u{1F50E}" },
  { id: "ga4", label: "Analytics", icon: "\u{1F4C8}" },
  { id: "ads-audit" as Tab, label: "Ads Audit", icon: "\u{1F4CA}" },
  { id: "competitors", label: "Competitors", icon: "\u2694\uFE0F" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("revenue");

  return (
    <ToolPage
      title="Analytics"
      description="Revenue metrics, customer insights, search performance, and web analytics."
    >
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
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "revenue" && <RevenueTab />}
      {activeTab === "customers" && <CustomersTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "search-console" && <SearchConsoleTab />}
      {activeTab === "ga4" && <GA4Tab />}
      {activeTab === "ads-audit" && <AdsAuditTab />}
      {activeTab === "competitors" && <CompetitorTab />}
    </ToolPage>
  );
}
