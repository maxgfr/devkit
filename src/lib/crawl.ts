// Light site crawl: the URLs of a site's sitemaps (or a pasted list) fetched from the extension page as served
// HTML (no JavaScript runs), each page read with devkit's SEO and JSON-LD checks, then findings across pages:
// duplicate titles, descriptions and h1, missing tags, error statuses, noindex pages in the sitemap, canonicals
// pointing elsewhere, JSON-LD errors per type. Pure apart from DOMParser and the fetch it is handed.
import type { Level } from "./headers";
import { hreflangReport, normalizeUrl, sameUrl } from "./hreflang";
import { analyzeJsonLd, type Finding, indexingSignals, inMode, type ValidateMode } from "./jsonld";
import { collectMeta } from "./page/collect";
import type { SchemaVocab } from "./schema-vocab";
import { indexability, metaValue } from "./seo";
import { isAllowed, parseRobots, parseSitemap, type Robots, type Sitemap } from "./site-files";
import { LENGTH_LIMITS } from "./social";

/** `fetch`, or a fake of it in tests. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const CRAWL_LIMITS = { maxPages: 500, maxConcurrency: 6, maxDelayMs: 10_000 } as const;

export type CrawlAgent = "devkit" | "Googlebot";

export interface CrawlSettings {
  maxPages: number;
  concurrency: number;
  /** Pause between two requests, across all workers. */
  delayMs: number;
  respectRobots: boolean;
  /** Whose robots.txt rules apply. The request itself goes out with Chrome's own User-Agent. */
  userAgent: CrawlAgent;
  /** Also crawl URLs of other hosts the sitemap lists (asks for access to each). */
  includeOtherHosts: boolean;
}

export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = {
  maxPages: 50,
  concurrency: 3,
  delayMs: 250,
  respectRobots: true,
  userAgent: "devkit",
  includeOtherHosts: false,
};

/** Settings brought back inside their bounds (they come from storage and number inputs). */
export function clampSettings(s: Partial<CrawlSettings>): CrawlSettings {
  const num = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const d = DEFAULT_CRAWL_SETTINGS;
  return {
    maxPages: num(s.maxPages, 1, CRAWL_LIMITS.maxPages, d.maxPages),
    concurrency: num(s.concurrency, 1, CRAWL_LIMITS.maxConcurrency, d.concurrency),
    delayMs: num(s.delayMs, 0, CRAWL_LIMITS.maxDelayMs, d.delayMs),
    respectRobots: s.respectRobots ?? d.respectRobots,
    userAgent: s.userAgent === "Googlebot" ? "Googlebot" : "devkit",
    includeOtherHosts: s.includeOtherHosts ?? d.includeOtherHosts,
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
};

/* Sitemaps */

/**
 * The body as text, gunzipped when it is gzip data (a `sitemap.xml.gz` served as a file, not with
 * `Content-Encoding: gzip`, which the browser already undoes).
 */
export async function responseText(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

export interface RobotsRead {
  url: string;
  status: number;
  /** null when robots.txt is missing (4xx) or failed: everything may be crawled. */
  parsed: Robots | null;
  error?: string;
}

export async function readRobots(origin: string, fetcher: Fetcher, signal?: AbortSignal): Promise<RobotsRead> {
  const url = `${origin}/robots.txt`;
  try {
    const res = await fetcher(url, { signal, credentials: "omit", cache: "no-store" });
    const text = await res.text();
    return { url, status: res.status, parsed: res.status < 400 ? parseRobots(text) : null };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { url, status: 0, parsed: null, error: errorText(e) };
  }
}

/** Sitemaps to start from: those robots.txt lists, else `/sitemap.xml`. */
export function sitemapRoots(origin: string, robots: Robots | null): string[] {
  const listed = Array.from(new Set((robots?.sitemaps ?? []).filter((u) => originOf(u))));
  return listed.length ? listed : [`${origin}/sitemap.xml`];
}

export interface SitemapRead {
  url: string;
  status: number;
  kind: Sitemap["kind"] | "error" | "skipped";
  entries: number;
  /** The sitemap index that listed it. */
  parent?: string;
  error?: string;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  /** The sitemap that lists it. */
  sitemap: string;
}

export interface SitemapsResult {
  sitemaps: SitemapRead[];
  urls: SitemapUrl[];
  /** A limit stopped the reading: more sitemaps or URLs exist than were read. */
  truncated: boolean;
}

export interface ReadSitemapsOptions {
  /** Sitemaps read at most, indexes included. */
  maxSitemaps?: number;
  /** How deep sitemap indexes are followed (an index of indexes is depth 2). */
  maxDepth?: number;
  maxUrls?: number;
  /** Whether a sitemap URL may be fetched (devkit holds access to its host). */
  allow?: (url: string) => boolean;
  signal?: AbortSignal;
}

/** Reads sitemaps breadth-first, following sitemap indexes (bounded), each sitemap once. */
export async function readSitemaps(roots: string[], fetcher: Fetcher, options: ReadSitemapsOptions = {}): Promise<SitemapsResult> {
  const { maxSitemaps = 50, maxDepth = 3, maxUrls = 50_000, allow = () => true, signal } = options;
  const queue: { url: string; depth: number; parent?: string }[] = roots.map((url) => ({ url, depth: 0 }));
  const seen = new Set<string>();
  const seenUrls = new Set<string>();
  const out: SitemapsResult = { sitemaps: [], urls: [], truncated: false };
  while (queue.length) {
    const { url, depth, parent } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (out.sitemaps.length >= maxSitemaps) {
      out.truncated = true;
      break;
    }
    if (!allow(url)) {
      out.sitemaps.push({ url, status: 0, kind: "skipped", entries: 0, parent, error: "On another host: not read" });
      continue;
    }
    let status = 0;
    let text = "";
    try {
      const res = await fetcher(url, { signal, credentials: "omit", cache: "no-store" });
      status = res.status;
      text = await responseText(res);
    } catch (e) {
      if (signal?.aborted) throw e;
      out.sitemaps.push({ url, status, kind: "error", entries: 0, parent, error: errorText(e) });
      continue;
    }
    if (status >= 400) {
      out.sitemaps.push({ url, status, kind: "error", entries: 0, parent, error: `HTTP ${status}` });
      continue;
    }
    const parsed = parseSitemap(text);
    out.sitemaps.push({ url, status, kind: parsed.kind, entries: parsed.urls.length, parent });
    if (parsed.kind === "sitemapindex") {
      if (depth + 1 > maxDepth) {
        out.truncated = true;
        continue;
      }
      for (const u of parsed.urls) queue.push({ url: u.loc, depth: depth + 1, parent: url });
    } else if (parsed.kind === "urlset") {
      for (const u of parsed.urls) {
        if (seenUrls.has(u.loc)) continue;
        if (out.urls.length >= maxUrls) {
          out.truncated = true;
          break;
        }
        seenUrls.add(u.loc);
        out.urls.push({ loc: u.loc, lastmod: u.lastmod, sitemap: url });
      }
    }
  }
  return out;
}

/** URLs from pasted text: one per line (or separated by spaces / commas), relative ones against `origin`. */
export function parseUrlList(text: string, origin: string): string[] {
  const out: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    const t = token.trim();
    if (!t) continue;
    try {
      const u = new URL(t, `${origin}/`);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.href);
    } catch {
      /* not a URL */
    }
  }
  return Array.from(new Set(out));
}

/* Plan */

export type SkipReason = "other-host" | "robots" | "limit" | "invalid";

export interface SkippedUrl {
  url: string;
  reason: SkipReason;
  /** The robots.txt rule that blocks it. */
  rule?: string;
}

export interface CrawlPlan {
  queue: string[];
  skipped: SkippedUrl[];
  /** Origins other than the site's in the queue (devkit needs access to each). */
  otherOrigins: string[];
}

export interface PlanOptions {
  origin: string;
  settings: CrawlSettings;
  /** Parsed robots.txt per origin; a missing or null entry allows everything. */
  robots: Record<string, Robots | null | undefined>;
}

/** Which URLs get fetched, in order, and why the others do not. */
export function planCrawl(urls: string[], { origin, settings, robots }: PlanOptions): CrawlPlan {
  const queue: string[] = [];
  const skipped: SkippedUrl[] = [];
  const seen = new Set<string>();
  const others = new Set<string>();
  for (const raw of urls) {
    const o = originOf(raw);
    if (!o) {
      skipped.push({ url: raw, reason: "invalid" });
      continue;
    }
    const url = raw.split("#")[0]!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (o !== origin && !settings.includeOtherHosts) {
      skipped.push({ url, reason: "other-host" });
      continue;
    }
    const rules = robots[o];
    if (settings.respectRobots && rules) {
      const u = new URL(url);
      const verdict = isAllowed(rules, settings.userAgent, `${u.pathname}${u.search}`);
      if (!verdict.allowed) {
        skipped.push({ url, reason: "robots", rule: verdict.rule });
        continue;
      }
    }
    if (queue.length >= settings.maxPages) {
      skipped.push({ url, reason: "limit" });
      continue;
    }
    queue.push(url);
    if (o !== origin) others.add(o);
  }
  return { queue, skipped, otherOrigins: Array.from(others) };
}

/** robots.txt `Crawl-delay` for the agent, in ms (0 when none). */
export function crawlDelayMs(robots: Robots | null | undefined, agent: string): number {
  if (!robots) return 0;
  const a = agent.toLowerCase();
  const group =
    robots.groups.find((g) => g.agents.some((x) => x !== "*" && a.includes(x.toLowerCase()))) ??
    robots.groups.find((g) => g.agents.includes("*"));
  const seconds = Number(group?.crawlDelay);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, CRAWL_LIMITS.maxDelayMs) : 0;
}

/* Queue */

export interface QueueOptions {
  concurrency: number;
  /** Minimum time between the starts of two items, across workers. */
  delayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `worker` over `items`, `concurrency` at a time, starts spaced by `delayMs`. Stops taking items once
 * `signal` aborts and resolves to the items left undone (never started, or interrupted by the abort), in
 * order, so a later call resumes them. `worker` handles its own errors; one that still throws is counted
 * as done unless the abort caused it.
 */
export async function runQueue<T>(items: T[], worker: (item: T) => Promise<void>, options: QueueOptions): Promise<T[]> {
  const { delayMs = 0, signal, sleep = realSleep, now = () => Date.now() } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const undone = new Set<number>();
  let next = 0;
  let nextStart = 0;
  const run = async () => {
    while (!signal?.aborted && next < items.length) {
      const index = next++;
      const t = now();
      const wait = nextStart - t;
      nextStart = Math.max(t, nextStart) + delayMs;
      if (wait > 0) await sleep(wait);
      if (signal?.aborted) {
        undone.add(index);
        break;
      }
      try {
        await worker(items[index]!);
      } catch {
        if (signal?.aborted) undone.add(index);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  for (let i = next; i < items.length; i++) undone.add(i);
  return Array.from(undone)
    .sort((a, b) => a - b)
    .map((i) => items[i]!);
}

/* Pages */

export interface CrawlJsonLdFinding {
  severity: "error" | "warn";
  rule: string;
  message: string;
  path: string;
  /** The node's first @type, or "(block)" for a finding on the script itself (invalid JSON, no @context). */
  type: string;
}

export type CanonicalState = "self" | "other" | "missing";

export interface CrawlPage {
  url: string;
  finalUrl: string;
  redirected: boolean;
  /** 0 when the request failed (network error, blocked, timeout). */
  status: number;
  error?: string;
  contentType: string;
  /** A 2xx HTML answer, the only kind read for tags. */
  html: boolean;
  /** Request to end of body, in ms. */
  ms: number;
  /** Size of the decoded body (after any compression is undone). */
  bytes: number;
  title: string;
  description: string | null;
  canonical: string | null;
  canonicalState: CanonicalState;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  noindex: boolean;
  h1: string[];
  hreflang: number;
  words: number;
  jsonld: { blocks: number; types: string[]; findings: CrawlJsonLdFinding[] };
  inSitemap: boolean;
}

export type HtmlFacts = Pick<
  CrawlPage,
  "title" | "description" | "canonical" | "canonicalState" | "robotsMeta" | "noindex" | "h1" | "hreflang" | "words" | "jsonld"
>;

const EMPTY_FACTS: HtmlFacts = {
  title: "",
  description: null,
  canonical: null,
  canonicalState: "missing",
  robotsMeta: null,
  noindex: false,
  h1: [],
  hreflang: 0,
  words: 0,
  jsonld: { blocks: 0, types: [], findings: [] },
};

/** Reads served HTML with the SEO panel's and the JSON-LD Tester's checks. `url` is where it was served from. */
export function readHtml(html: string, url: string, xRobotsTag: string | null, vocab?: SchemaVocab): HtmlFacts {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const snap = collectMeta(doc, url);
  const headers = xRobotsTag ? { "x-robots-tag": xRobotsTag } : undefined;
  const signals = indexingSignals(snap, headers);
  const report = analyzeJsonLd(snap.jsonLd, { vocab });
  const findings: CrawlJsonLdFinding[] = [];
  const keep = (f: Finding, type: string) => {
    if (f.severity === "error" || f.severity === "warn")
      findings.push({ severity: f.severity, rule: f.rule, message: f.message, path: f.path, type });
  };
  for (const block of report.blocks) {
    for (const f of block.findings) keep(f, "(block)");
    for (const node of block.nodes) for (const f of node.findings) keep(f, node.types[0] ?? "(block)");
  }
  const description = metaValue(snap, "description")?.trim();
  return {
    title: snap.title.replace(/\s+/g, " ").trim(),
    description: description || null,
    canonical: signals.canonical,
    canonicalState: !signals.canonical ? "missing" : sameUrl(signals.canonical, url) ? "self" : "other",
    robotsMeta: signals.robots,
    noindex: !indexability(snap, headers).index,
    h1: snap.headings.filter((h) => h.level === 1).map((h) => h.text),
    hreflang: hreflangReport(snap.links, url, signals.canonical).entries.length,
    words: snap.content?.words ?? 0,
    jsonld: { blocks: report.blocks.length, types: report.types.map((t) => t.type), findings },
  };
}

export interface FetchPageOptions {
  fetcher: Fetcher;
  vocab?: SchemaVocab;
  signal?: AbortSignal;
  inSitemap?: boolean;
  now?: () => number;
  /** Bodies past this size are measured but not parsed. */
  maxParseBytes?: number;
  /** A request without an answer after this long is recorded as failed (0 for no limit). */
  timeoutMs?: number;
}

/** Fetches one URL and reads it. Throws only when `signal` aborted it; any other failure is a page with status 0. */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<CrawlPage> {
  const {
    fetcher,
    vocab,
    signal,
    inSitemap = false,
    now = () => performance.now(),
    maxParseBytes = 5_000_000,
    timeoutMs = 30_000,
  } = options;
  const blank: CrawlPage = {
    url,
    finalUrl: url,
    redirected: false,
    status: 0,
    contentType: "",
    html: false,
    ms: 0,
    bytes: 0,
    xRobotsTag: null,
    inSitemap,
    ...EMPTY_FACTS,
  };
  const timeout =
    timeoutMs > 0 && typeof AbortSignal.timeout === "function" && typeof AbortSignal.any === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const fetchSignal = timeout ? (signal ? AbortSignal.any([signal, timeout]) : timeout) : signal;
  const start = now();
  let res: Response;
  let text: string;
  try {
    res = await fetcher(url, { signal: fetchSignal, credentials: "omit", cache: "no-store", redirect: "follow" });
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw e;
    const error = timeout?.aborted ? `No answer after ${Math.round(timeoutMs / 1000)} s` : errorText(e);
    return { ...blank, ms: Math.round(now() - start), error };
  }
  const ms = Math.round(now() - start);
  const finalUrl = res.url || url;
  const contentType = res.headers.get("content-type") ?? "";
  const xRobotsTag = res.headers.get("x-robots-tag");
  const bytes = new TextEncoder().encode(text).length;
  const isHtml = res.status >= 200 && res.status < 300 && /\bx?html\b/i.test(contentType);
  const page: CrawlPage = {
    ...blank,
    finalUrl,
    redirected: res.redirected || normalizeUrl(finalUrl) !== normalizeUrl(url),
    status: res.status,
    contentType,
    html: isHtml,
    ms,
    bytes,
    xRobotsTag,
  };
  if (!isHtml) return page;
  if (bytes > maxParseBytes) return { ...page, error: `Not parsed: larger than ${Math.round(maxParseBytes / 1_000_000)} MB` };
  try {
    return { ...page, ...readHtml(text, finalUrl, xRobotsTag, vocab) };
  } catch (e) {
    return { ...page, error: `Not parsed: ${errorText(e)}` };
  }
}

/* Findings */

export const jsonLdCounts = (page: CrawlPage, mode: ValidateMode) => {
  const shown = page.jsonld.findings.filter((f) => inMode(f, mode));
  return { errors: shown.filter((f) => f.severity === "error").length, warnings: shown.filter((f) => f.severity === "warn").length };
};

export interface CrawlFinding {
  id: string;
  level: Level;
  title: string;
  /** What it means and what to do. */
  fix: string;
  /** Every page concerned. */
  urls: string[];
  /** For duplicates and per-type counts: the shared value (or type) and its pages. */
  groups?: { value: string; urls: string[] }[];
}

/** Pages that answered 2xx HTML and were read. */
const readPages = (pages: CrawlPage[]) => pages.filter((p) => p.html && !p.error?.startsWith("Not parsed"));
/**
 * What search engines would index: read, not noindex, canonical to itself or unset, each final URL once (a URL
 * that redirects to a crawled page is that page, not a duplicate of it).
 */
const indexablePages = (pages: CrawlPage[]) => {
  const seen = new Set<string>();
  return readPages(pages)
    .filter((p) => !p.noindex && p.canonicalState !== "other")
    .sort((a, b) => Number(a.redirected) - Number(b.redirected))
    .filter((p) => {
      const key = normalizeUrl(p.finalUrl);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const groupBy = <T extends { url: string }>(items: T[], key: (p: T) => string | null | undefined) => {
  const map = new Map<string, { value: string; urls: string[] }>();
  for (const p of items) {
    const value = key(p);
    if (!value) continue;
    const k = value.replace(/\s+/g, " ").trim().toLowerCase();
    const g = map.get(k);
    if (g) g.urls.push(p.url);
    else map.set(k, { value: value.replace(/\s+/g, " ").trim(), urls: [p.url] });
  }
  return Array.from(map.values());
};

const duplicates = (pages: CrawlPage[], key: (p: CrawlPage) => string | null | undefined) =>
  groupBy(pages, key)
    .filter((g) => g.urls.length > 1)
    .sort((a, b) => b.urls.length - a.urls.length);

/** Findings across the crawled pages, most severe first; `skipped` adds the sitemap URLs robots.txt blocks. */
export function crawlFindings(pages: CrawlPage[], options: { mode?: ValidateMode; skipped?: SkippedUrl[] } = {}): CrawlFinding[] {
  const { mode = "rich", skipped = [] } = options;
  const out: CrawlFinding[] = [];
  const add = (f: CrawlFinding) => {
    if (f.urls.length) out.push(f);
  };
  const read = readPages(pages);
  const indexable = indexablePages(pages);

  const failing = pages.filter((p) => p.status === 0 || p.status >= 400);
  add({
    id: "status",
    level: "bad",
    title: "Pages answering an error",
    fix: "Fix or remove these URLs, and take them out of the sitemap: it should list live pages only.",
    urls: failing.map((p) => p.url),
    groups: groupBy(failing, (p) => (p.status ? `HTTP ${p.status}` : `Failed: ${p.error ?? "no answer"}`)),
  });
  add({
    id: "noindex-in-sitemap",
    level: "bad",
    title: "noindex pages listed in the sitemap",
    fix: "A sitemap lists pages to index: remove these from it, or drop the noindex (meta robots or X-Robots-Tag) if they should be indexed.",
    urls: read.filter((p) => p.noindex && p.inSitemap).map((p) => p.url),
  });
  const typeErrors = new Map<string, { errors: number; urls: Set<string> }>();
  const typeWarnings = new Map<string, { warnings: number; urls: Set<string> }>();
  for (const p of read)
    for (const f of p.jsonld.findings) {
      if (!inMode(f, mode)) continue;
      if (f.severity === "error") {
        const t = typeErrors.get(f.type) ?? { errors: 0, urls: new Set<string>() };
        t.errors++;
        t.urls.add(p.url);
        typeErrors.set(f.type, t);
      } else {
        const t = typeWarnings.get(f.type) ?? { warnings: 0, urls: new Set<string>() };
        t.warnings++;
        t.urls.add(p.url);
        typeWarnings.set(f.type, t);
      }
    }
  const perType = <T extends { urls: Set<string> }>(m: Map<string, T>, count: (t: T) => number, word: string) =>
    Array.from(m.entries())
      .sort((a, b) => count(b[1]) - count(a[1]))
      .map(([type, t]) => ({
        value: `${type === "(block)" ? "Script (invalid JSON, no @context or @type)" : type}: ${count(t)} ${word}${count(t) === 1 ? "" : "s"}`,
        urls: Array.from(t.urls),
      }));
  const errorUrls = new Set(Array.from(typeErrors.values()).flatMap((t) => Array.from(t.urls)));
  add({
    id: "jsonld-errors",
    level: "bad",
    title: `JSON-LD errors (${mode === "rich" ? "Rich Results" : "Schema.org"} checks)`,
    fix: "Open each page in devkit's Structured data panel for the exact property and fix; errors keep a rich result from showing.",
    urls: Array.from(errorUrls),
    groups: perType(typeErrors, (t) => t.errors, "error"),
  });
  add({
    id: "missing-title",
    level: "bad",
    title: "Missing <title>",
    fix: "Give every page a unique <title> of about 10–60 characters.",
    urls: read.filter((p) => !p.title).map((p) => p.url),
  });
  const dupTitles = duplicates(indexable, (p) => p.title);
  add({
    id: "duplicate-title",
    level: "warn",
    title: "Duplicate titles",
    fix: "Each indexable page needs its own title, or a canonical to the page it duplicates.",
    urls: dupTitles.flatMap((g) => g.urls),
    groups: dupTitles,
  });
  add({
    id: "missing-description",
    level: "warn",
    title: "Missing meta description",
    fix: 'Add <meta name="description"> of about 50–160 characters: without one, search engines pick a snippet from the page.',
    urls: read.filter((p) => !p.description).map((p) => p.url),
  });
  const dupDescriptions = duplicates(indexable, (p) => p.description);
  add({
    id: "duplicate-description",
    level: "warn",
    title: "Duplicate meta descriptions",
    fix: "Write a description per page that says what that page is about.",
    urls: dupDescriptions.flatMap((g) => g.urls),
    groups: dupDescriptions,
  });
  add({
    id: "missing-h1",
    level: "warn",
    title: "No h1",
    fix: "Give each page one h1 that names its main topic.",
    urls: read.filter((p) => p.h1.length === 0).map((p) => p.url),
  });
  const otherCanonical = read.filter((p) => p.canonicalState === "other");
  add({
    id: "canonical-elsewhere",
    level: "warn",
    title: "Canonical pointing to another URL",
    fix: "Fine for real duplicates; otherwise make the canonical self-referencing. A sitemap should list canonical URLs only.",
    urls: otherCanonical.map((p) => p.url),
    groups: groupBy(otherCanonical, (p) => p.canonical),
  });
  const redirected = pages.filter((p) => p.redirected);
  add({
    id: "redirected",
    level: "warn",
    title: "URLs that redirect",
    fix: "List the final URL in the sitemap and in internal links, so crawlers skip the redirect.",
    urls: redirected.map((p) => p.url),
    groups: groupBy(redirected, (p) => p.finalUrl),
  });
  add({
    id: "robots-blocked",
    level: "warn",
    title: "Sitemap URLs blocked by robots.txt (not fetched)",
    fix: "A sitemap should not list URLs robots.txt blocks: unblock them or remove them from the sitemap.",
    urls: skipped.filter((s) => s.reason === "robots").map((s) => s.url),
    groups: groupBy(
      skipped.filter((s) => s.reason === "robots"),
      (s) => s.rule,
    ),
  });
  add({
    id: "multiple-h1",
    level: "info",
    title: "More than one h1",
    fix: "Allowed in HTML, but one h1 per page states the topic most clearly.",
    urls: read.filter((p) => p.h1.length > 1).map((p) => p.url),
  });
  const dupH1 = duplicates(indexable, (p) => p.h1[0]);
  add({
    id: "duplicate-h1",
    level: "info",
    title: "Duplicate h1",
    fix: "Pages sharing an h1 often share a topic: make each heading specific.",
    urls: dupH1.flatMap((g) => g.urls),
    groups: dupH1,
  });
  add({
    id: "title-length",
    level: "info",
    title: `Title shorter than 10 or longer than ${LENGTH_LIMITS.title} characters`,
    fix: "Long titles are cut in search results, short ones say little.",
    urls: read.filter((p) => p.title && (p.title.length < 10 || p.title.length > LENGTH_LIMITS.title)).map((p) => p.url),
  });
  add({
    id: "description-length",
    level: "info",
    title: `Description shorter than 50 or longer than ${LENGTH_LIMITS.description} characters`,
    fix: "Search engines cut long descriptions and may replace short ones.",
    urls: read
      .filter((p) => p.description && (p.description.length < 50 || p.description.length > LENGTH_LIMITS.description))
      .map((p) => p.url),
  });
  add({
    id: "missing-canonical",
    level: "info",
    title: "No canonical",
    fix: 'Add <link rel="canonical"> to itself, so URL variants (parameters, trailing slash) fold into one.',
    urls: read.filter((p) => p.canonicalState === "missing").map((p) => p.url),
  });
  const warnUrls = new Set(Array.from(typeWarnings.values()).flatMap((t) => Array.from(t.urls)));
  add({
    id: "jsonld-warnings",
    level: "info",
    title: "JSON-LD warnings",
    fix: "Recommended properties and value formats: worth adding, not blocking.",
    urls: Array.from(warnUrls),
    groups: perType(typeWarnings, (t) => t.warnings, "warning"),
  });
  add({
    id: "not-html",
    level: "info",
    title: "Not HTML",
    fix: "Sitemaps of pages list HTML pages; files belong in their own sitemap (images, videos) or nowhere.",
    urls: pages.filter((p) => p.status >= 200 && p.status < 300 && !p.html).map((p) => p.url),
  });
  return out;
}

/** Finding titles per page URL, for the table's issue count and the page detail. */
export function issuesByUrl(findings: CrawlFinding[]): Map<string, CrawlFinding[]> {
  const map = new Map<string, CrawlFinding[]>();
  for (const f of findings) for (const u of f.urls) map.set(u, [...(map.get(u) ?? []), f]);
  return map;
}

export interface CrawlSummary {
  pages: number;
  ok: number;
  errors: number;
  redirects: number;
  noindex: number;
  withJsonLd: number;
  avgMs: number | null;
  bytes: number;
}

export function crawlSummary(pages: CrawlPage[]): CrawlSummary {
  const timed = pages.filter((p) => p.status > 0);
  return {
    pages: pages.length,
    ok: pages.filter((p) => p.status >= 200 && p.status < 300).length,
    errors: pages.filter((p) => p.status === 0 || p.status >= 400).length,
    redirects: pages.filter((p) => p.redirected).length,
    noindex: pages.filter((p) => p.noindex).length,
    withJsonLd: pages.filter((p) => p.jsonld.blocks > 0).length,
    avgMs: timed.length ? Math.round(timed.reduce((s, p) => s + p.ms, 0) / timed.length) : null,
    bytes: pages.reduce((s, p) => s + p.bytes, 0),
  };
}

/* Table */

export type SortKey = "url" | "status" | "title" | "description" | "h1" | "words" | "jsonld" | "ms" | "bytes" | "issues";
export type PageFilter = "all" | "issues" | "errors" | "noindex" | "redirected" | "jsonld-errors" | "canonical-other";

export const PAGE_FILTERS: [PageFilter, string][] = [
  ["all", "All pages"],
  ["issues", "With findings"],
  ["errors", "Error status"],
  ["noindex", "noindex"],
  ["redirected", "Redirected"],
  ["canonical-other", "Canonical elsewhere"],
  ["jsonld-errors", "JSON-LD errors"],
];

export function filterPages(
  pages: CrawlPage[],
  { filter, query, mode, issues }: { filter: PageFilter; query?: string; mode: ValidateMode; issues: Map<string, CrawlFinding[]> },
): CrawlPage[] {
  const q = query?.trim().toLowerCase() ?? "";
  return pages.filter((p) => {
    const keep =
      filter === "all" ||
      (filter === "issues" && (issues.get(p.url)?.some((f) => f.level !== "info") ?? false)) ||
      (filter === "errors" && (p.status === 0 || p.status >= 400)) ||
      (filter === "noindex" && p.noindex) ||
      (filter === "redirected" && p.redirected) ||
      (filter === "canonical-other" && p.canonicalState === "other") ||
      (filter === "jsonld-errors" && jsonLdCounts(p, mode).errors > 0);
    if (!keep) return false;
    if (!q) return true;
    return [p.url, p.finalUrl, p.title, p.description ?? "", p.h1.join(" "), p.jsonld.types.join(" "), String(p.status)]
      .join("\n")
      .toLowerCase()
      .includes(q);
  });
}

export function sortPages(
  pages: CrawlPage[],
  key: SortKey,
  dir: "asc" | "desc",
  { mode, issues }: { mode: ValidateMode; issues: Map<string, CrawlFinding[]> },
): CrawlPage[] {
  const value = (p: CrawlPage): number | string => {
    switch (key) {
      case "url":
        return p.url;
      case "status":
        return p.status;
      case "title":
        return p.title.length;
      case "description":
        return p.description?.length ?? -1;
      case "h1":
        return p.h1.length;
      case "words":
        return p.words;
      case "jsonld": {
        const c = jsonLdCounts(p, mode);
        return c.errors * 1000 + c.warnings;
      }
      case "ms":
        return p.ms;
      case "bytes":
        return p.bytes;
      case "issues":
        return issues.get(p.url)?.filter((f) => f.level !== "info").length ?? 0;
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...pages].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c * sign || a.url.localeCompare(b.url);
  });
}

/* Exports */

/** A CSV cell: quoted when needed; text a spreadsheet would run as a formula (= + - @) is prefixed with '. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  "url",
  "final_url",
  "status",
  "redirected",
  "content_type",
  "title",
  "title_length",
  "description",
  "description_length",
  "canonical",
  "canonical_state",
  "meta_robots",
  "x_robots_tag",
  "noindex",
  "h1_count",
  "h1",
  "hreflang",
  "words",
  "jsonld_types",
  "jsonld_errors",
  "jsonld_warnings",
  "response_ms",
  "bytes",
  "in_sitemap",
  "error",
];

export function crawlCsv(pages: CrawlPage[], mode: ValidateMode): string {
  const rows = pages.map((p) => {
    const c = jsonLdCounts(p, mode);
    return [
      p.url,
      p.finalUrl,
      p.status,
      p.redirected,
      p.contentType,
      p.title,
      p.title.length,
      p.description,
      p.description?.length ?? 0,
      p.canonical,
      p.canonicalState,
      p.robotsMeta,
      p.xRobotsTag,
      p.noindex,
      p.h1.length,
      p.h1.join(" | "),
      p.hreflang,
      p.words,
      p.jsonld.types.join(" "),
      c.errors,
      c.warnings,
      p.ms,
      p.bytes,
      p.inSitemap,
      p.error ?? "",
    ]
      .map(csvCell)
      .join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

export interface CrawlExport {
  origin: string;
  crawledAt: string;
  settings: CrawlSettings;
  mode: ValidateMode;
  sitemaps: SitemapRead[];
  pages: CrawlPage[];
  skipped: SkippedUrl[];
  /** URLs planned but not fetched yet (the crawl was stopped). */
  pending: string[];
}

export function crawlJson(data: CrawlExport): string {
  const findings = crawlFindings(data.pages, { mode: data.mode, skipped: data.skipped });
  return JSON.stringify({ ...data, summary: crawlSummary(data.pages), findings }, null, 2);
}
