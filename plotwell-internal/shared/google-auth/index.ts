/**
 * Google OAuth2 helper for browser-based API access.
 * Uses implicit flow (response_type=token) via popup.
 *
 * Setup:
 * 1. Create a Google Cloud project
 * 2. Enable "Search Console API", "Google Analytics Data API", and "Google Ads API"
 * 3. Create OAuth2 credentials (Web application)
 *    - Authorized redirect URIs: http://localhost:5180/oauth/callback
 * 4. Set VITE_GOOGLE_CLIENT_ID in .env.local
 * 5. Set VITE_GOOGLE_ADS_DEVELOPER_TOKEN in .env.local (from Google Ads > API Center)
 * 6. Set VITE_GOOGLE_ADS_CUSTOMER_ID in .env.local (without dashes, e.g. 1234567890)
 */

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/adwords",
].join(" ");

const TOKEN_KEY = "plotwell_google_token";
const EXPIRY_KEY = "plotwell_google_token_expiry";

export function getClientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
}

export function isConfigured(): boolean {
  return !!getClientId();
}

export function getStoredToken(): string | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const expiry = sessionStorage.getItem(EXPIRY_KEY);
  if (!token || !expiry) return null;
  if (Date.now() > Number(expiry)) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
    return null;
  }
  return token;
}

export function storeToken(token: string, expiresIn: number): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresIn * 1000));
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
}

export function startOAuthFlow(): Promise<string> {
  return new Promise((resolve, reject) => {
    const clientId = getClientId();
    if (!clientId) {
      reject(new Error("VITE_GOOGLE_CLIENT_ID not set"));
      return;
    }

    const redirectUri = `${window.location.origin}/oauth/callback`;
    const state = Math.random().toString(36).slice(2);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "token",
      scope: SCOPES,
      state,
      include_granted_scopes: "true",
      prompt: "consent",
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    const width = 500;
    const height = 600;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;

    const popup = window.open(
      authUrl,
      "google-auth",
      `width=${width},height=${height},left=${left},top=${top}`
    );

    if (!popup) {
      reject(new Error("Popup blocked. Please allow popups for this site."));
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "google-oauth-callback") return;

      window.removeEventListener("message", handleMessage);
      clearInterval(pollTimer);

      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }

      const { access_token, expires_in } = event.data;
      if (access_token) {
        storeToken(access_token, Number(expires_in) || 3600);
        resolve(access_token);
      } else {
        reject(new Error("No access token received"));
      }
    };

    window.addEventListener("message", handleMessage);

    // Poll in case postMessage fails (popup closed without completing)
    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        window.removeEventListener("message", handleMessage);
        reject(new Error("Auth popup closed"));
      }
    }, 500);
  });
}

/* ------------------------------------------------------------------ */
/*  Google API helpers                                                  */
/* ------------------------------------------------------------------ */

async function googleFetch(url: string, body?: unknown): Promise<unknown> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated with Google");

  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    init.method = "POST";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (res.status === 401) {
    clearToken();
    throw new Error("Google token expired. Please reconnect.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API ${res.status}: ${text}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Search Console API                                                 */
/* ------------------------------------------------------------------ */

export interface SearchConsoleRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchConsoleResponse {
  rows: SearchConsoleRow[];
  responseAggregationType: string;
}

export async function searchConsoleQuery(
  siteUrl: string,
  options: {
    startDate: string; // YYYY-MM-DD
    endDate: string;
    dimensions: ("query" | "page" | "country" | "device" | "date")[];
    rowLimit?: number;
  }
): Promise<SearchConsoleRow[]> {
  const encodedSite = encodeURIComponent(siteUrl);
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`;

  const body = {
    startDate: options.startDate,
    endDate: options.endDate,
    dimensions: options.dimensions,
    rowLimit: options.rowLimit || 100,
  };

  const data = (await googleFetch(url, body)) as SearchConsoleResponse;
  return data.rows || [];
}

export async function searchConsoleSites(): Promise<string[]> {
  const data = (await googleFetch(
    "https://searchconsole.googleapis.com/webmasters/v3/sites"
  )) as { siteEntry?: { siteUrl: string }[] };
  return data.siteEntry?.map((s) => s.siteUrl) || [];
}

/* ------------------------------------------------------------------ */
/*  Google Analytics Data API (GA4)                                    */
/* ------------------------------------------------------------------ */

export interface GA4Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

export interface GA4Response {
  rows?: GA4Row[];
  totals?: GA4Row[];
  rowCount?: number;
  metadata?: unknown;
}

/**
 * Run a GA4 report. Accepts either:
 * - Simple format: { startDate, endDate, dimensions: ["page"], metrics: ["sessions"] }
 * - Raw GA4 API format: { dateRanges, dimensions: [{name:"page"}], metrics: [{name:"sessions"}], orderBys, limit }
 */
export async function ga4RunReport(
  propertyId: string,
  options: Record<string, unknown>
): Promise<GA4Response> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  let body: Record<string, unknown>;

  // Detect if caller passed raw GA4 API format (has dateRanges) or simple format (has startDate)
  if (options.dateRanges) {
    // Raw GA4 API format - pass through
    body = options;
  } else {
    // Simple format - wrap into GA4 API format
    const dims = options.dimensions as string[] | { name: string }[];
    const mets = options.metrics as string[] | { name: string }[];

    body = {
      dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
      dimensions: Array.isArray(dims)
        ? dims.map((d) => (typeof d === "string" ? { name: d } : d))
        : [],
      metrics: Array.isArray(mets)
        ? mets.map((m) => (typeof m === "string" ? { name: m } : m))
        : [],
      limit: options.limit || 100,
    };

    if (options.orderBys || options.orderBy) {
      body.orderBys = options.orderBys || (options.orderBy as { metric: string; desc: boolean }[])?.map((o) => ({
        metric: { metricName: o.metric },
        desc: o.desc,
      }));
    }
  }

  return (await googleFetch(url, body)) as GA4Response;
}

export async function ga4ListProperties(): Promise<
  { name: string; displayName: string; propertyId: string }[]
> {
  try {
    const data = (await googleFetch(
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
    )) as {
      accountSummaries?: {
        propertySummaries?: {
          property: string;
          displayName: string;
        }[];
      }[];
    };

    const properties: { name: string; displayName: string; propertyId: string }[] = [];
    for (const account of data.accountSummaries || []) {
      for (const prop of account.propertySummaries || []) {
        const id = prop.property.replace("properties/", "");
        properties.push({
          name: prop.property,
          displayName: prop.displayName,
          propertyId: id,
        });
      }
    }
    return properties;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Google Ads API (REST + GAQL)                                       */
/* ------------------------------------------------------------------ */

export function getAdsConfig(): { developerToken: string; customerId: string } | null {
  const developerToken = import.meta.env.VITE_GOOGLE_ADS_DEVELOPER_TOKEN || "";
  const customerId = (import.meta.env.VITE_GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  if (!developerToken || !customerId) return null;
  return { developerToken, customerId };
}

export function isAdsConfigured(): boolean {
  return !!getAdsConfig();
}

async function adsFetch(customerId: string, gaqlQuery: string): Promise<unknown> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated with Google");
  const config = getAdsConfig();
  if (!config) throw new Error("Google Ads not configured (missing developer token or customer ID)");

  // Use Vite proxy to avoid CORS (Google Ads API doesn't support browser requests)
  // Use `search` (not `searchStream`) for standard paginated results
  const url = `/google-ads-api/v23/customers/${customerId}/googleAds:search`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": config.developerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: gaqlQuery }),
  });

  if (res.status === 401) {
    clearToken();
    throw new Error("Google token expired. Please reconnect.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads API ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.results || [];
}

export interface AdsCampaignRow {
  campaign: string;
  campaignId: string;
  status: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  ctr: number;
  avgCpc: number;
}

export async function adsGetCampaignPerformance(
  customerId: string,
  startDate: string,
  endDate: string
): Promise<AdsCampaignRow[]> {
  const query = `
    SELECT
      campaign.name,
      campaign.id,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `;

  const results = (await adsFetch(customerId, query)) as {
    campaign: { name: string; id: string; status: string };
    metrics: {
      impressions: string;
      clicks: string;
      costMicros: string;
      conversions: string;
      ctr: string;
      averageCpc: string;
    };
  }[];

  return results.map((r) => ({
    campaign: r.campaign.name,
    campaignId: r.campaign.id,
    status: r.campaign.status,
    impressions: Number(r.metrics.impressions) || 0,
    clicks: Number(r.metrics.clicks) || 0,
    costMicros: Number(r.metrics.costMicros) || 0,
    conversions: Number(r.metrics.conversions) || 0,
    ctr: Number(r.metrics.ctr) || 0,
    avgCpc: Number(r.metrics.averageCpc) || 0,
  }));
}

export interface AdsKeywordRow {
  keyword: string;
  matchType: string;
  campaign: string;
  adGroup: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  qualityScore: number | null;
}

export async function adsGetKeywordPerformance(
  customerId: string,
  startDate: string,
  endDate: string
): Promise<AdsKeywordRow[]> {
  const query = `
    SELECT
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      campaign.name,
      ad_group.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      ad_group_criterion.quality_info.quality_score
    FROM keyword_view
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
    ORDER BY metrics.impressions DESC
    LIMIT 200
  `;

  const results = (await adsFetch(customerId, query)) as {
    adGroupCriterion: {
      keyword: { text: string; matchType: string };
      qualityInfo?: { qualityScore: number };
    };
    campaign: { name: string };
    adGroup: { name: string };
    metrics: {
      impressions: string;
      clicks: string;
      costMicros: string;
      conversions: string;
    };
  }[];

  return results.map((r) => ({
    keyword: r.adGroupCriterion.keyword.text,
    matchType: r.adGroupCriterion.keyword.matchType,
    campaign: r.campaign.name,
    adGroup: r.adGroup.name,
    impressions: Number(r.metrics.impressions) || 0,
    clicks: Number(r.metrics.clicks) || 0,
    costMicros: Number(r.metrics.costMicros) || 0,
    conversions: Number(r.metrics.conversions) || 0,
    qualityScore: r.adGroupCriterion.qualityInfo?.qualityScore ?? null,
  }));
}

export interface AdsDailyRow {
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
}

export async function adsGetDailyPerformance(
  customerId: string,
  startDate: string,
  endDate: string
): Promise<AdsDailyRow[]> {
  const query = `
    SELECT
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date ASC
  `;

  const results = (await adsFetch(customerId, query)) as {
    segments: { date: string };
    metrics: {
      impressions: string;
      clicks: string;
      costMicros: string;
      conversions: string;
    };
  }[];

  // Aggregate by date (multiple campaigns per day)
  const byDate: Record<string, AdsDailyRow> = {};
  for (const r of results) {
    const d = r.segments.date;
    if (!byDate[d]) byDate[d] = { date: d, impressions: 0, clicks: 0, costMicros: 0, conversions: 0 };
    byDate[d].impressions += Number(r.metrics.impressions) || 0;
    byDate[d].clicks += Number(r.metrics.clicks) || 0;
    byDate[d].costMicros += Number(r.metrics.costMicros) || 0;
    byDate[d].conversions += Number(r.metrics.conversions) || 0;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

export async function adsListAccessibleCustomers(): Promise<string[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated with Google");
  const config = getAdsConfig();
  if (!config) return [];

  const res = await fetch(
    "/google-ads-api/v23/customers:listAccessibleCustomers",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": config.developerToken,
      },
    }
  );

  if (!res.ok) return [];
  const data = (await res.json()) as { resourceNames?: string[] };
  return (data.resourceNames || []).map((r: string) => r.replace("customers/", ""));
}
