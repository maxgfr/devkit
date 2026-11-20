// Chrome UX Report (CrUX) API: field data from real Chrome users, next to the lab vitals measured in the tab.
// Pure: builds the requests, parses the answers, rates them on the web.dev thresholds of viz.ts. The network and
// the cache are passed in, so everything here runs in tests without a key.
import { type Rating, rateVital, type VitalName } from "./viz";

export const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records";
/** Where to create a key: the API's page in the Google Cloud console, then Credentials › Create API key. */
export const CRUX_KEY_HELP = "https://developer.chrome.com/docs/crux/api#APIKey";
export const CRUX_CONSOLE = "https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com";
/** CrUX publishes a new 28-day window every day: one day of cache matches its refresh rate. */
export const CRUX_CACHE_MS = 24 * 60 * 60 * 1000;
/** Weekly points in the history: 25 is the API's default (about six months). */
export const CRUX_HISTORY_PERIODS = 25;

export type CruxScope = "url" | "origin";
export type CruxFormFactor = "PHONE" | "DESKTOP" | "ALL";
export type CruxKind = "record" | "history";

export const CRUX_VITALS: VitalName[] = ["lcp", "inp", "cls", "fcp", "ttfb"];
/** API metric names of the vitals. TTFB is still "experimental_" in the API. */
export const CRUX_METRIC: Record<VitalName, string> = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
  fcp: "first_contentful_paint",
  ttfb: "experimental_time_to_first_byte",
};
export const CRUX_RTT = "round_trip_time";

export const SCOPE_TEXT: Record<CruxScope, string> = { url: "This URL", origin: "Whole origin" };
export const FORM_FACTOR_TEXT: Record<CruxFormFactor, string> = { PHONE: "Phone", DESKTOP: "Desktop", ALL: "All devices" };

const LOCAL_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|.*\.example|.*\.invalid|\[.*\]|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0)$/i;

/**
 * Why CrUX cannot have data for `pageUrl`, or null when it may. CrUX only covers public http(s) pages, so a local or
 * private address is never sent to Google.
 */
export function cruxIneligible(pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return "No page open.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Field data exists for web pages only.";
  const host = u.hostname;
  if (LOCAL_HOST.test(host) || !host.includes("."))
    return "CrUX only covers public sites: a local or private address has no field data (and is not sent to Google).";
  return null;
}

/** What CrUX is asked about: the page without its fragment (CrUX drops the query too, but keeps it in the key), or its origin. */
export function cruxTarget(pageUrl: string, scope: CruxScope): string {
  const u = new URL(pageUrl);
  if (scope === "origin") return u.origin;
  u.hash = "";
  return u.href;
}

export interface CruxRequest {
  kind: CruxKind;
  scope: CruxScope;
  formFactor: CruxFormFactor;
  target: string;
  /** Endpoint without the key: the key goes in the X-Goog-Api-Key header, never in a URL. */
  endpoint: string;
  body: Record<string, unknown>;
}

export function cruxRequest(pageUrl: string, scope: CruxScope, formFactor: CruxFormFactor, kind: CruxKind): CruxRequest {
  const target = cruxTarget(pageUrl, scope);
  const body: Record<string, unknown> = { [scope]: target };
  // No formFactor: every device type together.
  if (formFactor !== "ALL") body.formFactor = formFactor;
  body.metrics = [...CRUX_VITALS.map((v) => CRUX_METRIC[v]), CRUX_RTT];
  if (kind === "history") body.collectionPeriodCount = CRUX_HISTORY_PERIODS;
  return {
    kind,
    scope,
    formFactor,
    target,
    endpoint: `${CRUX_ENDPOINT}:${kind === "record" ? "queryRecord" : "queryHistoryRecord"}`,
    body,
  };
}

/** Cache key of a request: per kind, scope, form factor and target (never the API key). */
export const cruxCacheKey = (r: Pick<CruxRequest, "kind" | "scope" | "formFactor" | "target">) =>
  `devkit-crux:${r.kind}:${r.scope}:${r.formFactor}:${r.target}`;

/* Parsing */

/** A CrUX number: CLS comes as a string ("0.05"), missing values as null or "NaN". */
export function cruxNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

interface CruxDate {
  year?: number;
  month?: number;
  day?: number;
}

/** "2026-11-15" from the API's { year, month, day }. */
export function cruxDate(d: CruxDate | undefined): string | null {
  if (!d?.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 19 – Nov 15, 2026" (or with both years when the window crosses one). */
export function formatPeriod(p: { first: string; last: string } | null): string {
  if (!p) return "";
  const part = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return { y: y!, text: `${MONTHS[m! - 1]} ${d}` };
  };
  const a = part(p.first);
  const b = part(p.last);
  return a.y === b.y ? `${a.text} – ${b.text}, ${b.y}` : `${a.text}, ${a.y} – ${b.text}, ${b.y}`;
}

export interface CruxDistribution {
  good: number;
  ni: number;
  poor: number;
}

export interface CruxMetric {
  name: VitalName;
  p75: number | null;
  rating: Rating | null;
  /** Share of page loads in each web.dev bucket (the API's 3 histogram bins), 0–1. */
  distribution: CruxDistribution | null;
}

export interface CruxRecord {
  scope: CruxScope;
  formFactor: CruxFormFactor;
  /** The URL or origin the record is for, as CrUX normalized it. */
  target: string;
  metrics: CruxMetric[];
  /** 75th percentile round trip time of the visitors' connections, in ms. */
  rtt: number | null;
  period: { first: string; last: string } | null;
}

interface RawBin {
  start?: unknown;
  end?: unknown;
  density?: unknown;
}
interface RawMetric {
  histogram?: RawBin[];
  percentiles?: { p75?: unknown };
}
interface RawPeriod {
  firstDate?: CruxDate;
  lastDate?: CruxDate;
}
interface RawKey {
  url?: string;
  origin?: string;
  formFactor?: string;
}

function distribution(bins: RawBin[] | undefined): CruxDistribution | null {
  if (!Array.isArray(bins) || bins.length < 3) return null;
  const [good, ni, poor] = bins.slice(0, 3).map((b) => cruxNumber(b.density) ?? 0) as [number, number, number];
  return good + ni + poor > 0 ? { good, ni, poor } : null;
}

const formFactorOf = (key: RawKey | undefined): CruxFormFactor =>
  key?.formFactor === "PHONE" || key?.formFactor === "DESKTOP" ? key.formFactor : "ALL";

export function parseCruxRecord(json: unknown): CruxRecord {
  const record = (json as { record?: { key?: RawKey; metrics?: Record<string, RawMetric>; collectionPeriod?: RawPeriod } })?.record;
  if (!record?.metrics) throw new CruxError("other", 200, "The CrUX API answered without a record.");
  const metrics = record.metrics;
  const first = cruxDate(record.collectionPeriod?.firstDate);
  const last = cruxDate(record.collectionPeriod?.lastDate);
  return {
    scope: record.key?.url ? "url" : "origin",
    formFactor: formFactorOf(record.key),
    target: record.key?.url ?? record.key?.origin ?? "",
    metrics: CRUX_VITALS.map((name) => {
      const m = metrics[CRUX_METRIC[name]];
      const p75 = cruxNumber(m?.percentiles?.p75);
      return { name, p75, rating: rateVital(name, p75), distribution: distribution(m?.histogram) };
    }).filter((m) => m.p75 !== null || m.distribution),
    rtt: cruxNumber(metrics[CRUX_RTT]?.percentiles?.p75),
    period: first && last ? { first, last } : null,
  };
}

export interface CruxHistory {
  /** Last day of each 28-day window, oldest first. */
  periods: string[];
  /** p75 per window for each vital present, aligned with `periods`; null where CrUX had too little data. */
  series: Partial<Record<VitalName, (number | null)[]>>;
}

export function parseCruxHistory(json: unknown): CruxHistory {
  const record = (
    json as {
      record?: { metrics?: Record<string, { percentilesTimeseries?: { p75s?: unknown[] } }>; collectionPeriods?: RawPeriod[] };
    }
  )?.record;
  if (!record?.metrics) throw new CruxError("other", 200, "The CrUX API answered without a history record.");
  const periods = (record.collectionPeriods ?? []).map((p) => cruxDate(p.lastDate) ?? "");
  const series: CruxHistory["series"] = {};
  for (const name of CRUX_VITALS) {
    const p75s = record.metrics[CRUX_METRIC[name]]?.percentilesTimeseries?.p75s;
    if (!Array.isArray(p75s)) continue;
    const values = periods.map((_, i) => cruxNumber(p75s[i]));
    if (values.some((v) => v !== null)) series[name] = values;
  }
  return { periods, series };
}

/** Where the latest point of a series stands against the first known one: "up" means slower (worse) for every vital. */
export function cruxTrend(values: (number | null)[]): { from: number; to: number; change: number } | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const from = known[0]!;
  const to = known[known.length - 1]!;
  return { from, to, change: from === 0 ? 0 : (to - from) / from };
}

/** Points of a sparkline in a `width` × `height` box: x by index, y from the series' own min to max (inverted: up is higher). */
export function sparkline(values: (number | null)[], width: number, height: number, pad = 2): { x: number; y: number }[][] {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return [];
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    const y = max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2);
    run.push({ x: Number((pad + i * step).toFixed(2)), y: Number(y.toFixed(2)) });
  });
  if (run.length) runs.push(run);
  return runs;
}

/** How the tab's lab value compares with the field p75, in words. */
export function labVsField(name: VitalName, lab: number | null | undefined, field: number | null): string | null {
  if (lab === null || lab === undefined || !Number.isFinite(lab) || field === null) return null;
  const labRating = rateVital(name, lab);
  const fieldRating = rateVital(name, field);
  if (!labRating || !fieldRating) return null;
  if (labRating === fieldRating) return "same rating as the field";
  const order: Rating[] = ["good", "needs-improvement", "poor"];
  return order.indexOf(labRating) < order.indexOf(fieldRating)
    ? "better than the field: real visitors fare worse than this tab"
    : "worse than the field: this load was slower than most real visits";
}

/* Errors */

export type CruxErrorKind = "not-found" | "invalid-key" | "denied" | "quota" | "network" | "other";

export class CruxError extends Error {
  constructor(
    readonly kind: CruxErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CrUXError";
  }
}

/** The user-facing error of a failed answer. Never echoes the key: Google's messages do not contain it, and `key` is masked anyway. */
export function cruxError(status: number, body: unknown, scope: CruxScope = "url", key = ""): CruxError {
  const err = (body as { error?: { message?: string; status?: string; details?: { reason?: string }[] } })?.error;
  const raw = String(err?.message ?? "");
  const message = key ? raw.split(key).join("•••") : raw;
  const reason = err?.details?.map((d) => d.reason).find(Boolean) ?? "";
  if (status === 404)
    return new CruxError(
      "not-found",
      status,
      scope === "url"
        ? "No field data for this URL: CrUX only reports pages with enough real Chrome visits."
        : "No field data for this origin: CrUX only reports sites with enough real Chrome visits.",
    );
  if (status === 429 || err?.status === "RESOURCE_EXHAUSTED")
    return new CruxError("quota", status, "CrUX API quota reached (150 queries a minute per Google Cloud project). Try again in a minute.");
  if ((status === 400 && /API key not valid|API_KEY_INVALID/i.test(`${message} ${reason}`)) || reason === "API_KEY_INVALID")
    return new CruxError("invalid-key", status, "Google says the CrUX API key is not valid. Check it in Options.");
  if (status === 401 || status === 403)
    return new CruxError(
      "denied",
      status,
      "Google refused the key: enable the Chrome UX Report API in the key's Google Cloud project, and allow it in the key's API restrictions.",
    );
  return new CruxError("other", status, `The CrUX API answered ${status}${message ? `: ${message}` : ""}.`);
}

/* Fetching */

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export interface CruxCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface Cached {
  at: number;
  status: number;
  body: unknown;
}

/** Runs `req` with `key`, through `cache` (successes and "no data" answers, for CRUX_CACHE_MS). Throws CruxError. */
export async function cruxFetch(
  req: CruxRequest,
  key: string,
  fetchImpl: FetchLike,
  cache?: CruxCache,
  now = Date.now(),
): Promise<unknown> {
  const ck = cruxCacheKey(req);
  const hit = (await cache?.get(ck).catch(() => undefined)) as Cached | undefined;
  let status: number;
  let body: unknown;
  if (hit && typeof hit.at === "number" && now - hit.at < CRUX_CACHE_MS) {
    ({ status, body } = hit);
  } else {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(req.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify(req.body),
      });
    } catch {
      throw new CruxError("network", 0, "Could not reach the CrUX API: check the connection.");
    }
    status = res.status;
    body = await res.json().catch(() => null);
    if (res.ok || status === 404) await cache?.set(ck, { at: now, status, body } satisfies Cached).catch(() => undefined);
  }
  if (status >= 200 && status < 300) return body;
  throw cruxError(status, body, req.scope, key);
}

export interface CruxResult {
  record: CruxRecord;
  history: CruxHistory | null;
  /** The URL had no data, so the origin is shown instead. */
  fellBack: boolean;
}

/**
 * Field data for `pageUrl`: the record and its history. Asked for the URL with no data, falls back to the origin
 * (the history follows the scope that answered; a missing history alone is not an error).
 */
export async function loadCrux(
  pageUrl: string,
  scope: CruxScope,
  formFactor: CruxFormFactor,
  key: string,
  fetchImpl: FetchLike,
  cache?: CruxCache,
): Promise<CruxResult> {
  const record = async (s: CruxScope) =>
    parseCruxRecord(await cruxFetch(cruxRequest(pageUrl, s, formFactor, "record"), key, fetchImpl, cache));
  let used = scope;
  let rec: CruxRecord;
  try {
    rec = await record(scope);
  } catch (e) {
    if (!(e instanceof CruxError && e.kind === "not-found" && scope === "url")) throw e;
    used = "origin";
    rec = await record("origin");
  }
  let history: CruxHistory | null = null;
  try {
    history = parseCruxHistory(await cruxFetch(cruxRequest(pageUrl, used, formFactor, "history"), key, fetchImpl, cache));
  } catch (e) {
    if (!(e instanceof CruxError) || e.kind === "invalid-key" || e.kind === "denied") throw e;
  }
  return { record: rec, history, fellBack: used !== scope };
}

/** A request that only checks the key: one metric of a site CrUX always has. A 404 would still prove the key works. */
export const CRUX_TEST_REQUEST: CruxRequest = {
  kind: "record",
  scope: "origin",
  formFactor: "ALL",
  target: "https://developer.chrome.com",
  endpoint: `${CRUX_ENDPOINT}:queryRecord`,
  body: { origin: "https://developer.chrome.com", metrics: [CRUX_METRIC.lcp] },
};

export async function testCruxKey(key: string, fetchImpl: FetchLike): Promise<void> {
  try {
    await cruxFetch(CRUX_TEST_REQUEST, key, fetchImpl);
  } catch (e) {
    if (e instanceof CruxError && e.kind === "not-found") return;
    throw e;
  }
}
