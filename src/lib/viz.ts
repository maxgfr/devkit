// Pure helpers behind the inspectors' charts: scales, thresholds, ratings and layouts. No DOM, no React.
import type { Check, Level } from "./headers";
import type { PerfSnapshot } from "./page/collect";

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Short duration for axis ticks and labels: "0", "450 ms", "1.2 s", "12 s". */
export function msLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms === 0) return "0";
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${Number((ms / 1000).toFixed(ms < 10_000 ? 2 : 1))} s`;
}

/** Axis from 0 to at least `max`, in steps of 1, 2 or 5 × 10ⁿ, about `target` steps long. */
export function niceTicks(max: number, target = 4): { end: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { end: 1, ticks: [0, 1] };
  const raw = max / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const err = raw / pow;
  const step = pow * (err >= 7.07 ? 10 : err >= 3.16 ? 5 : err >= 1.41 ? 2 : 1);
  const n = Math.max(1, Math.ceil(max / step - 1e-9));
  const ticks = Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { end: ticks[ticks.length - 1]!, ticks };
}

/* Web Vitals */

export type VitalName = "lcp" | "inp" | "cls" | "fcp" | "ttfb";
export type Rating = "good" | "needs-improvement" | "poor";

/** web.dev thresholds: good up to `good`, poor above `poor` (75th percentile of page loads in the field). */
export const VITALS: Record<VitalName, { label: string; name: string; good: number; poor: number; unitless?: boolean }> = {
  lcp: { label: "LCP", name: "Largest Contentful Paint", good: 2500, poor: 4000 },
  inp: { label: "INP", name: "Interaction to Next Paint", good: 200, poor: 500 },
  cls: { label: "CLS", name: "Cumulative Layout Shift", good: 0.1, poor: 0.25, unitless: true },
  fcp: { label: "FCP", name: "First Contentful Paint", good: 1800, poor: 3000 },
  ttfb: { label: "TTFB", name: "Time to First Byte", good: 800, poor: 1800 },
};

export const RATING_TEXT: Record<Rating, string> = { good: "Good", "needs-improvement": "Needs improvement", poor: "Poor" };
export const RATING_LEVEL: Record<Rating, Level> = { good: "good", "needs-improvement": "warn", poor: "bad" };

export function rateVital(name: VitalName, value: number | null | undefined): Rating | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const t = VITALS[name];
  return value <= t.good ? "good" : value <= t.poor ? "needs-improvement" : "poor";
}

export function formatVital(name: VitalName, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return VITALS[name].unitless ? value.toFixed(3) : msLabel(value);
}

/** Where a value sits on its threshold bar. The bar runs from 0 to 1.5 × the poor threshold; `over` marks a clamped value. */
export function vitalScale(name: VitalName, value: number | null | undefined) {
  const t = VITALS[name];
  const max = t.poor * 1.5;
  const known = value !== null && value !== undefined && Number.isFinite(value);
  return {
    max,
    good: t.good / max,
    poor: t.poor / max,
    pos: known ? clamp01(value / max) : null,
    over: known ? value > max : false,
  };
}

/** The vitals of a snapshot, in display order. */
export function vitalsOf(p: PerfSnapshot): { name: VitalName; value: number | null }[] {
  return [
    { name: "lcp", value: p.lcp },
    { name: "inp", value: p.inp },
    { name: "cls", value: p.cls },
    { name: "fcp", value: p.fcp },
    { name: "ttfb", value: p.navigation?.ttfb ?? null },
  ];
}

/** One line for the report card: the worst Core Web Vital (LCP, INP, CLS) measured so far. */
export function vitalsSummary(p: PerfSnapshot): { level: Level; text: string } {
  const core = vitalsOf(p)
    .filter((v) => v.name === "lcp" || v.name === "inp" || v.name === "cls")
    .map((v) => ({ ...v, rating: rateVital(v.name, v.value) }))
    .filter((v) => v.rating);
  if (!core.length) return { level: "info", text: "Not measured yet" };
  const order: Rating[] = ["poor", "needs-improvement", "good"];
  const worst = order.find((r) => core.some((v) => v.rating === r))!;
  const shown = worst === "good" ? core : core.filter((v) => v.rating === worst);
  return {
    level: RATING_LEVEL[worst],
    text: `${RATING_TEXT[worst]}: ${shown.map((v) => `${VITALS[v.name].label} ${formatVital(v.name, v.value)}`).join(", ")}`,
  };
}

/* Security */

/** Grade bands of `securityReport` (score ≥ 90 is A … < 30 is F), with the level its score color uses. */
export const GRADE_BANDS: { grade: string; from: number; to: number; level: Level }[] = [
  { grade: "F", from: 0, to: 30, level: "bad" },
  { grade: "E", from: 30, to: 45, level: "bad" },
  { grade: "D", from: 45, to: 60, level: "warn" },
  { grade: "C", from: 60, to: 75, level: "warn" },
  { grade: "B", from: 75, to: 90, level: "good" },
  { grade: "A", from: 90, to: 100, level: "good" },
];

export const scoreLevel = (score: number): Level => (score >= 75 ? "good" : score >= 45 ? "warn" : "bad");

export function levelCounts(checks: Pick<Check, "level">[]): Record<Level, number> {
  const out: Record<Level, number> = { good: 0, warn: 0, bad: 0, info: 0 };
  for (const c of checks) out[c.level]++;
  return out;
}

/* Resources */

export type ResourceKind = "script" | "style" | "font" | "image" | "fetch" | "other";

/** Fixed order: a kind keeps its color and its place in the stack whatever the page loads. */
export const RESOURCE_KINDS: { kind: ResourceKind; label: string }[] = [
  { kind: "script", label: "Scripts" },
  { kind: "style", label: "Styles" },
  { kind: "font", label: "Fonts" },
  { kind: "image", label: "Images" },
  { kind: "fetch", label: "Fetch / XHR" },
  { kind: "other", label: "Other" },
];

/** What a resource is, from its URL extension first, then its initiator type. */
export function resourceKind(name: string, initiatorType: string): ResourceKind {
  let path = name;
  try {
    path = new URL(name).pathname;
  } catch {
    path = name.split(/[?#]/)[0]!;
  }
  path = path.toLowerCase();
  if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return "font";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(path)) return "image";
  if (/\.css$/.test(path)) return "style";
  if (/\.(m?js|cjs)$/.test(path)) return "script";
  switch (initiatorType) {
    case "script":
      return "script";
    case "img":
    case "image":
    case "video":
    case "audio":
      return "image";
    case "fetch":
    case "xmlhttprequest":
    case "beacon":
      return "fetch";
    default:
      return "other";
  }
}

type Resource = PerfSnapshot["resources"][number];

export function resourceBreakdown(resources: Pick<Resource, "name" | "type" | "transfer">[]) {
  const m = new Map<ResourceKind, { count: number; bytes: number }>();
  for (const r of resources) {
    const k = resourceKind(r.name, r.type);
    const e = m.get(k) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += r.transfer || 0;
    m.set(k, e);
  }
  const kinds = RESOURCE_KINDS.filter((k) => m.has(k.kind)).map((k) => ({ ...k, ...m.get(k.kind)! }));
  return { kinds, count: resources.length, bytes: kinds.reduce((s, k) => s + k.bytes, 0) };
}

export type WaterfallSort = "start" | "transfer" | "duration";

/** Rows of the waterfall, each placed on a shared 0 → `end` ms axis (`left` and `width` are fractions of it). */
export function waterfallLayout<R extends Pick<Resource, "name" | "type" | "transfer" | "duration" | "startTime">>(
  resources: R[],
  { sort = "start", limit, markers = [] }: { sort?: WaterfallSort; limit?: number; markers?: number[] } = {},
) {
  const ends = resources.map((r) => (r.startTime || 0) + Math.max(0, r.duration || 0));
  const { end, ticks } = niceTicks(Math.max(0, ...ends, ...markers.filter((m) => m > 0)));
  const sorted = resources
    .map((r) => ({ r, start: Math.max(0, r.startTime || 0), dur: Math.max(0, r.duration || 0) }))
    .sort((a, b) =>
      sort === "start" ? a.start - b.start || b.dur - a.dur : sort === "transfer" ? b.r.transfer - a.r.transfer : b.dur - a.dur,
    );
  const rows = (limit === undefined ? sorted : sorted.slice(0, limit)).map(({ r, start, dur }) => ({
    item: r,
    kind: resourceKind(r.name, r.type),
    start,
    end: start + dur,
    left: clamp01(start / end),
    width: clamp01(dur / end),
  }));
  return { rows, end, ticks, total: resources.length };
}

/* Navigation timing */

export interface Phase {
  id: string;
  label: string;
  start: number;
  end: number;
}

/** Phases of the document request on one axis from navigation start, plus DOMContentLoaded and load markers. */
export function navigationPhases(nav: Record<string, number>): {
  phases: Phase[];
  markers: { id: string; label: string; at: number }[];
  end: number;
} {
  const v = (k: string) => Math.max(0, Number(nav[k]) || 0);
  const phases: Phase[] = [];
  const add = (id: string, label: string, start: number, end: number) => phases.push({ id, label, start, end: Math.max(start, end) });
  if ("responseStart" in nav) {
    const tls = v("tlsStart");
    add("redirect", "Redirect", 0, v("redirect") > 0 ? v("redirectEnd") : 0);
    add("dns", "DNS", v("dnsStart"), v("dnsEnd"));
    add("connect", "Connect", v("connectStart"), tls > 0 ? tls : v("connectEnd"));
    add("tls", "TLS", tls > 0 ? tls : v("connectEnd"), v("connectEnd"));
    add("waiting", "Waiting (server)", v("requestStart"), v("responseStart"));
    add("download", "Download", v("responseStart"), v("responseEnd"));
    add("dom", "DOM processing", v("responseEnd"), v("domInteractive"));
  } else {
    // Older snapshots only carry durations: lay them end to end.
    let t = 0;
    const seq = (id: string, label: string, d: number) => {
      add(id, label, t, t + d);
      t += d;
    };
    seq("redirect", "Redirect", v("redirect"));
    seq("dns", "DNS", v("dns"));
    seq("connect", "Connect", Math.max(0, v("connect") - v("tls")));
    seq("tls", "TLS", v("tls"));
    seq("waiting", "Waiting (server)", Math.max(0, v("ttfb") - t));
    seq("download", "Download", v("download"));
    seq("dom", "DOM processing", Math.max(0, v("domInteractive") - t));
  }
  const markers = [
    { id: "dcl", label: "DOMContentLoaded", at: v("domContentLoaded") },
    { id: "load", label: "Load", at: v("load") },
  ].filter((m) => m.at > 0);
  const end = Math.max(...phases.map((p) => p.end), ...markers.map((m) => m.at));
  return { phases, markers, end };
}

/* Links */

export function linkBuckets(results: { status: number | "error" | "pending"; detail?: string }[]) {
  const out = { ok: 0, redirect: 0, broken: 0, pending: 0 };
  for (const r of results) {
    if (r.status === "pending") out.pending++;
    else if (r.status === "error" || r.status >= 400) out.broken++;
    else if (r.status >= 300 || r.detail?.startsWith("→")) out.redirect++;
    else out.ok++;
  }
  return out;
}

/** Each value's share of the total (0 when the total is 0). */
export function shares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  return values.map((v) => (total > 0 ? Math.max(0, v) / total : 0));
}

export const percent = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

/** A request's short name for a narrow row: last path segment (with a trimmed query), or the host for a bare origin. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return u.host + (u.search ? u.search.slice(0, 24) : "");
    const name = decodeURIComponent(last);
    return u.search ? `${name}${u.search.length > 16 ? `${u.search.slice(0, 15)}…` : u.search}` : name;
  } catch {
    return url;
  }
}

/** Axis tick labels with the unit on the last one only ("0 · 50 · 100 · 150 ms", or seconds from 1 s up), so narrow axes stay legible. */
export function axisLabels(ticks: number[]): string[] {
  const seconds = (ticks[ticks.length - 1] ?? 0) >= 1000;
  return ticks.map((t, i) => {
    const v = seconds ? Number((t / 1000).toPrecision(6)) : Math.round(t);
    return i === ticks.length - 1 ? `${v} ${seconds ? "s" : "ms"}` : String(v);
  });
}
