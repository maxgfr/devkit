// "Copy for agent" reports of the Inspect panels: SEO, structured data, headers, performance, console errors,
// links, fonts and site files. Pure: each builder takes what its panel already computed and returns Markdown in
// the shared shape of agent-md.ts, so the page report can nest them under "###".
import { agentDoc, clip, code, fence, plural } from "../agent-md";
import { createRedactor, type ReportError } from "../bug-report";
import { sourcePath } from "../element";
import { cachingReport, type Check, type HeaderFetch, securityReport } from "../headers";
import { type HeadingIssue, headingIssues, headingText, isExposed, levelCounts, outlineLines } from "../headings";
import { type Finding, type JsonLdBlock, type JsonLdReport, richResultsTestUrl } from "../jsonld";
import type { FontsColors, MetaSnapshot, PerfSnapshot } from "../page/collect";
import type { HeadingsSnapshot, RawHeading } from "../page/headings";
import { jsonLdVerdict } from "../report";
import { linkHref, metaValue, seoReport } from "../seo";
import { EXTERNAL_TOOLS, isAllowed, manifestChecks, type Robots, type Sitemap } from "../site-files";
import { formatBytes } from "../storage-usage";
import { contrast, parseColor, toHex } from "../utils/color";
import { lineColumn } from "../utils/json";
import {
  formatVital,
  msLabel,
  navigationPhases,
  RATING_TEXT,
  type ResourceKind,
  rateVital,
  resourceBreakdown,
  resourceKind,
  VITALS,
  type VitalName,
  vitalsOf,
  vitalsSummary,
} from "../viz";

export interface AgentCtx {
  /** The page the data comes from. */
  url: string;
  /** "##" alone (the default), "###" inside the page report. */
  heading?: "##" | "###";
}

/** Start of the Result line when there is nothing to fix or check. */
export const NO_PROBLEM = "No problem found.";

/** Whether a report built here lists anything to fix or to check (its "To fix" or "Worth checking" section). */
export const hasFindings = (md: string) => /^#{3,4} (To fix|Worth checking)$/m.test(md);

interface Item {
  text: string;
  details?: string[];
  /** Multi-line content (a fenced snippet) under the item, indented into it. */
  block?: string;
}

/** Numbered list, capped: "… and N more" past `max`. */
function list(items: Item[], max = 20, more = "more"): string {
  const out = items.slice(0, max).map((it, i) => {
    const details = (it.details ?? []).filter(Boolean).map((d) => `   - ${d}`);
    const block = it.block
      ? it.block
          .split("\n")
          .map((l) => (l ? `   ${l}` : ""))
          .join("\n")
      : "";
    return [`${i + 1}. ${it.text}`, ...details, block].filter(Boolean).join("\n");
  });
  if (items.length > max) out.push(`… and ${items.length - max} ${more}.`);
  return out.join("\n");
}

/** "2 problems, 1 warning", or NO_PROBLEM. */
function counted(problems: number, warnings: number): string {
  if (!problems && !warnings) return NO_PROBLEM;
  return [problems ? plural(problems, "problem") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(", ");
}

const sentence = (s: string) => (/[.:!?]$/.test(s) ? s : `${s}.`);

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/* SEO */

function seoFix(c: Check, snap: MetaSnapshot): { where: string; fix: string } | null {
  const title = snap.title.trim();
  const desc = metaValue(snap, "description");
  const page = snap.url.split("#")[0]!;
  switch (c.id) {
    case "title":
      return {
        where: "`<title>` in `<head>`",
        fix: title
          ? `Rewrite it to 10–60 characters (now ${title.length}), the page's topic first and the site name last.`
          : "Add a `<title>` of 10–60 characters naming the page's topic (its h1 is a good start).",
      };
    case "description":
      return {
        where: '`<meta name="description">` in `<head>`',
        fix: desc
          ? `Rewrite it to 50–160 characters (now ${desc.length}): a summary of the page that makes people click.`
          : `Add ${code('<meta name="description" content="…">')} with a 50–160 character summary of the page.`,
      };
    case "canonical":
      return { where: "`<head>`", fix: `Add ${code(`<link rel="canonical" href="${page}">`)} (the URL this content should rank under).` };
    case "robots":
      return {
        where: `${code(`<meta name="robots" content="${metaValue(snap, "robots") ?? metaValue(snap, "googlebot") ?? ""}">`)} in \`<head>\``,
        fix: "If the page should appear in search results, remove `noindex` (check the `X-Robots-Tag` response header too). Leave it only on pages that must stay out of search.",
      };
    case "viewport":
      return { where: "`<head>`", fix: `Add ${code('<meta name="viewport" content="width=device-width, initial-scale=1">')}.` };
    case "lang":
      return { where: "`<html>`", fix: `Set the page's language: ${code('<html lang="en">')} (use the language of the content).` };
    case "charset":
      return { where: "`<head>`", fix: `Declare UTF-8 as the first element of \`<head>\`: ${code('<meta charset="utf-8">')}.` };
    case "doctype":
      return {
        where: "first line of the HTML",
        fix: `Start the document with ${code("<!DOCTYPE html>")} so it renders in standards mode.`,
      };
    case "h1": {
      const h1 = snap.headings.filter((h) => h.level === 1).length;
      return h1
        ? { where: "the page's headings", fix: `Keep one \`<h1>\` for the page's main topic and turn the other ${h1 - 1} into \`<h2>\`.` }
        : { where: "the page's main content", fix: "Add one `<h1>` naming the page's main topic (often the visible page title)." };
    }
    case "og": {
      const missing = c.detail.replace(/^Missing /, "").split(", ");
      const value: Record<string, string> = {
        "og:title": metaValue(snap, "og:title") || title || "…",
        "og:description": metaValue(snap, "og:description") || desc || "…",
        "og:image": "https://… (absolute URL, 1200×630)",
        "og:url": linkHref(snap, "canonical") ?? page,
        "og:type": "website",
      };
      return {
        where: "`<head>`",
        fix: `Add ${missing.map((k) => code(`<meta property="${k}" content="${clip(value[k] ?? "…", 80)}">`)).join(", ")}.`,
      };
    }
    case "favicon":
      return { where: "`<head>`", fix: `Add ${code('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')} (or a 32×32 PNG).` };
    case "hreflang":
      return {
        where: '`<link rel="alternate" hreflang>` in `<head>`',
        fix: `Add ${code(`<link rel="alternate" hreflang="x-default" href="${page}">`)} for visitors whose language matches no alternate.`,
      };
    default:
      return null;
  }
}

/** SEO panel: the checks of `seoReport` on the page's meta snapshot. */
export function seoMarkdown(snap: MetaSnapshot, ctx: AgentCtx): string {
  const checks = seoReport(snap);
  const item = (c: Check): Item => {
    const f = seoFix(c, snap);
    return {
      text: `${c.label}: ${clip(c.detail, 200)}`,
      details: f ? [`Where: ${f.where}`, `Fix: ${f.fix.charAt(0).toLowerCase()}${f.fix.slice(1)}`] : [],
    };
  };
  const bad = checks.filter((c) => c.level === "bad");
  const warn = checks.filter((c) => c.level === "warn");
  return agentDoc({
    title: "SEO checks",
    url: ctx.url,
    heading: ctx.heading,
    result: counted(bad.length, warn.length),
    context: [`Title: ${snap.title.trim() ? code(clip(snap.title.trim(), 120)) : "none"}`],
    sections: [
      { title: "To fix", body: list(bad.map(item)) },
      { title: "Worth checking", body: list(warn.map(item)) },
    ],
    verify: bad.length || warn.length ? "Reload the page and refresh devkit's SEO & meta panel." : undefined,
  });
}

/* Headings */

function headingFix(issue: HeadingIssue, snap: HeadingsSnapshot): string {
  const h = snap.headings[issue.at[0] ?? -1];
  switch (issue.id) {
    case "none":
      return "Mark up the page's titles as headings: one `<h1>` for the main topic, `<h2>` for each section, `<h3>` inside them.";
    case "no-h1":
      return h
        ? `Make the h1 visible to everyone (remove the CSS or \`aria-hidden\` that hides ${code(h.selector)}), or add a visible \`<h1>\` naming the page's main topic.`
        : "Add one `<h1>` naming the page's main topic (often the visible page title), before the section headings.";
    case "multiple-h1":
      return "Keep one `<h1>` for the page's main topic and turn the others into `<h2>`; style them with a class if they must look the same.";
    case "first-not-h1":
      return "Put the `<h1>` first in the main content, or turn the headings above it (logos, banners, navigation titles) into plain text or lower-level headings.";
    case "skipped-level":
      return `Change it to an \`<h${issue.expected}>\` and keep its look with a CSS class, or add the missing \`<h${issue.expected}>\` section heading above it.`;
    case "empty":
      return "Give it text, or remove it if it is only a spacer; an icon-only heading needs an `aria-label` or the image's `alt`.";
    case "aria-level-missing":
      return h
        ? `Add the level: ${code(`aria-level="${h.level}"`)} (screen readers assume 2), or use a real \`<h${h.level}>\`.`
        : "Add `aria-level`, or use a real `<hN>`.";
    case "aria-hidden":
      return 'Remove `aria-hidden="true"` from it or its ancestor, so screen reader users get the structure sighted users see.';
    case "too-long":
      return "Shorten it to a phrase (under about 70 characters) and move the rest into a paragraph below.";
    case "duplicate":
      return 'Make each one unique (add the subject: "Pricing for teams" rather than "Pricing"), so the outline and a screen reader\'s headings list tell them apart.';
    case "empty-section":
      return "Add the section's content, or merge the heading with the next one.";
    case "title-mismatch":
      return "Check that the `<h1>` and the `<title>` name the same topic.";
  }
}

const headingWhere = (h: RawHeading) => `${code(h.selector)}: ${code(clip(h.html, 160))}`;

/** Headings panel: the problems of `headingIssues` and the outline they sit in. */
export function headingsMarkdown(snap: HeadingsSnapshot, ctx: AgentCtx): string {
  const issues = headingIssues(snap);
  const item = (i: HeadingIssue): Item => {
    const at = i.at.map((n) => snap.headings[n]).filter((h): h is RawHeading => Boolean(h));
    return {
      text: `${i.label}: ${clip(i.detail, 240)}`,
      details: [
        ...at.slice(0, 6).map((h) => `Where: ${headingWhere(h)}`),
        at.length > 6 ? `… and ${at.length - 6} more` : "",
        `Fix: ${headingFix(i, snap)}`,
      ],
    };
  };
  const bad = issues.filter((i) => i.level === "bad");
  const warn = issues.filter((i) => i.level === "warn");
  const notes = issues.filter((i) => i.level === "info");
  const exposed = snap.headings.filter(isExposed);
  const counts = levelCounts(exposed)
    .map((n, l) => (n ? `h${l + 1} ×${n}` : ""))
    .filter(Boolean)
    .join(", ");
  const noId = snap.headings.filter((h) => h.visibility === "visible" && !h.id && headingText(h)).length;
  return agentDoc({
    title: "Headings outline",
    url: ctx.url,
    heading: ctx.heading,
    result: counted(bad.length, warn.length),
    context: [
      `${plural(snap.headings.length, "heading")}${snap.capped ? " (capped)" : ""}, ${exposed.length} announced by screen readers${counts ? ` (${counts})` : ""}.`,
      noId ? `${plural(noId, "visible heading")} without an \`id\`: no link can point to ${noId === 1 ? "it" : "them"}.` : "",
    ],
    sections: [
      { title: "To fix", body: list(bad.map(item)) },
      { title: "Worth checking", body: list(warn.map(item)) },
      {
        title: "Notes",
        body: list(
          notes.map((i) => ({ text: `${i.label}: ${clip(i.detail, 200)}` })),
          10,
        ),
      },
      { title: "Outline", body: outlineLines(snap, issues, { max: 80 }) },
    ],
    verify: bad.length || warn.length ? "Reload the page and refresh devkit's Headings panel (Inspect › Headings)." : undefined,
  });
}

/* Structured data */

/** The lines around a JSON parse error, with a caret under the column; long (minified) lines are cut around it. */
function jsonSnippet(raw: string, error: string | undefined): string {
  const at = error ? /line (\d+),? column (\d+)/.exec(error) : null;
  const pos = !at && error ? /position (\d+)/.exec(error) : null;
  if (!at && !pos) return fence(clip(raw, 400), "json");
  const { line: n, column: col } = at ? { line: Number(at[1]), column: Number(at[2]) } : lineColumn(raw, Number(pos![1]));
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) {
    let text = lines[i - 1]!;
    let caret = col;
    if (text.length > 160) {
      const from = i === n ? Math.max(0, col - 80) : 0;
      text = `${from ? "…" : ""}${text.slice(from, from + 160)}${from + 160 < text.length ? "…" : ""}`;
      caret = col - from + (from ? 1 : 0);
    }
    const gutter = `${String(i).padStart(4)} | `;
    out.push(`${gutter}${text}`);
    if (i === n) out.push(`${" ".repeat(gutter.length + Math.max(0, caret - 1))}^`);
  }
  return fence(out.join("\n"));
}

function jsonLdItem(block: JsonLdBlock, f: Finding, types: string[]): Item {
  const where = `Block #${block.index + 1}${types.length ? ` (${types.join(", ")})` : ""}, ${code(f.path)}`;
  const details: string[] = [];
  let snippet: string | undefined;
  if (!block.ok && block.error && block.error !== "Empty script") {
    details.push(
      "Fix: correct the syntax at that position (trailing comma, unescaped quote or line break in a string, comment, single quotes). If a template or CMS writes this script, fix it there and build the JSON with a serializer (JSON.stringify).",
    );
    snippet = jsonSnippet(block.raw.trim(), block.error);
  } else if (block.error === "Empty script") details.push("Fix: remove the empty tag, or fill it with the page's schema.org data.");
  else if (/missing required/.test(f.message))
    details.push("Fix: add the property to this node with the value the page shows; without it the node is not eligible for rich results.");
  else if (/missing recommended/.test(f.message)) details.push("Fix: add it if the page shows that information.");
  return { text: `${where}: ${f.message}`, details, block: snippet };
}

/** Structured data panel: the report of `analyzeJsonLd` on the page's JSON-LD scripts. */
export function jsonLdMarkdown(report: JsonLdReport, ctx: AgentCtx): string {
  const errors: Item[] = [];
  const warnings: Item[] = [];
  const notes = new Map<string, string[]>();
  for (const b of report.blocks) {
    const entries: { f: Finding; types: string[] }[] = [
      ...b.findings.map((f) => ({ f, types: b.nodes[0]?.types ?? [] })),
      ...b.nodes.flatMap((n) => n.findings.map((f) => ({ f, types: n.types }))),
    ];
    for (const { f, types } of entries) {
      if (f.severity === "error") errors.push(jsonLdItem(b, f, types));
      else if (f.severity === "warn") warnings.push(jsonLdItem(b, f, types));
      else notes.set(f.message, [...(notes.get(f.message) ?? []), f.path]);
    }
  }
  const { error, warn } = report.counts;
  const result = !report.blocks.length
    ? `${NO_PROBLEM} The page has no JSON-LD.`
    : error || warn
      ? `${jsonLdVerdict(report).text}.`
      : `${NO_PROBLEM} ${plural(report.blocks.length, "block")} checked.`;
  return agentDoc({
    title: "Structured data (JSON-LD)",
    url: ctx.url,
    heading: ctx.heading,
    result,
    context: report.blocks.length
      ? [
          report.types.length ? `Types: ${report.types.map((t) => `${t.type} ×${t.count}`).join(", ")}` : "",
          'Blocks are numbered in document order of the page\'s `<script type="application/ld+json">` tags; a path starts at its block (`#2.offers.price` is `offers.price` in block #2).',
        ]
      : [],
    sections: [
      { title: "To fix", body: list(errors, 30, "more errors") },
      { title: "Worth checking", body: list(warnings, 20, "more warnings") },
      {
        title: "Notes",
        body: Array.from(notes.entries()).map(
          ([message, paths]) =>
            `- ${message} (${code(paths[0]!)}${paths.length > 1 ? ` and ${plural(paths.length - 1, "other node")}` : ""})`,
        ),
      },
    ],
    verify:
      error || warn
        ? `Reload the page and refresh devkit's Structured data panel, then run Google's Rich Results Test: ${richResultsTestUrl(ctx.url)}`
        : undefined,
  });
}

/* Headers */

const CSP_ISSUE_FIX: [RegExp, string][] = [
  [
    /unsafe-inline/,
    "replace `'unsafe-inline'` in script-src with a per-response nonce (`'nonce-…'` on each inline `<script>`) or hashes, plus `'strict-dynamic'`.",
  ],
  [/unsafe-eval/, "remove `'unsafe-eval'`: find the eval(), new Function() or string setTimeout() that needs it (often an old library)."],
  [/no default-src or script-src/, "add `default-src 'self'` so scripts are restricted at all."],
  [/wildcard/, "replace `*` in default-src / script-src with the exact origins the page loads scripts from."],
  [/object-src/, "add `object-src 'none'`."],
  [/frame-ancestors/, "add `frame-ancestors 'self'` (or the origins allowed to embed the page)."],
];

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

function securityFix(c: Check, headers: Record<string, string>): string[] {
  switch (c.id) {
    case "https":
      return ["Fix: serve the site over HTTPS and redirect every `http://` request to `https://` with a 301."];
    case "hsts":
      return c.level === "bad"
        ? ["Fix: add to every HTTPS response `Strict-Transport-Security: max-age=31536000; includeSubDomains`."]
        : [
            "Fix: raise max-age to at least 6 months: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (add `preload` only once every subdomain serves HTTPS).",
          ];
    case "csp": {
      const csp = headerValue(headers, "content-security-policy");
      if (!csp && c.level === "warn")
        return ["Fix: once the reports show nothing legitimate is blocked, send the same policy as `Content-Security-Policy`."];
      if (!csp)
        return [
          "Fix: start from `Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`, add the third-party origins the page loads (script-src, style-src, img-src, connect-src), and roll it out as `Content-Security-Policy-Report-Only` first to see what it would block.",
        ];
      return [`Current: ${code(clip(csp, 400))}`, ...CSP_ISSUE_FIX.filter(([re]) => re.test(c.detail)).map(([, fix]) => `Fix: ${fix}`)];
    }
    case "framing":
      return ["Fix: add `Content-Security-Policy: frame-ancestors 'self'` (and `X-Frame-Options: SAMEORIGIN` for old browsers)."];
    case "nosniff":
      return ["Fix: add `X-Content-Type-Options: nosniff`."];
    case "referrer":
      if (!headerValue(headers, "referrer-policy"))
        return ["Fix: send `Referrer-Policy: strict-origin-when-cross-origin` so the policy does not depend on the browser."];
      return [
        "Fix: send `Referrer-Policy: strict-origin-when-cross-origin`: `unsafe-url` and `no-referrer-when-downgrade` send full URLs, paths and query strings included, to other sites.",
      ];
    case "leak":
      return [
        'Fix: drop the version from these headers (nginx `server_tokens off;`, Apache `ServerTokens Prod` and `Header unset X-Powered-By`, Express `app.disable("x-powered-by")`, PHP `expose_php = Off`).',
      ];
    case "cors":
      return c.level === "bad"
        ? [
            "Fix: never send `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`: echo only allow-listed origins and add `Vary: Origin`.",
          ]
        : ["Fix: `*` lets any site read this response; unless the HTML is a public API, remove the header or list the allowed origins."];
    default:
      return [];
  }
}

const CACHE_FIX: Record<string, string> = {
  "cache-control":
    "Fix: send an explicit `Cache-Control` for the HTML, e.g. `Cache-Control: no-cache` (revalidate each visit, with an ETag); long max-age belongs to fingerprinted assets, not the document.",
  validators: "Fix: send an `ETag` (or `Last-Modified`) so browsers revalidate with a 304 instead of downloading the page again.",
  compression: "Fix: enable Brotli or gzip for text/html at the server or CDN (`Content-Encoding: br`).",
};

const HARDENING: Record<string, string> = {
  permissions: "`Permissions-Policy: camera=(), microphone=(), geolocation=()` turns off the features the page does not use.",
  coop: "`Cross-Origin-Opener-Policy: same-origin` isolates the window from pages it opens (check popup and OAuth flows first).",
  corp: "`Cross-Origin-Resource-Policy: same-origin` stops other sites from embedding the response.",
};

/** Security headers panel: the grade of `securityReport` and the `cachingReport` checks of the document response. */
export function headersMarkdown(fetched: HeaderFetch, ctx: AgentCtx & { omitCsp?: boolean }): string {
  const report = securityReport(fetched.headers, fetched.url);
  // In the page report the CSP has its own, more detailed section.
  const sec = ctx.omitCsp ? { ...report, checks: report.checks.filter((c) => c.id !== "csp") } : report;
  const cache = cachingReport(fetched.headers);
  const secItem = (c: Check): Item => ({ text: `${c.label}: ${clip(c.detail, 200)}`, details: securityFix(c, fetched.headers) });
  const cacheItem = (c: Check): Item => ({
    text: `Caching, ${c.label}: ${clip(c.detail, 200)}`,
    details: CACHE_FIX[c.id] ? [CACHE_FIX[c.id]!] : [],
  });
  const bad = sec.checks.filter((c) => c.level === "bad").map(secItem);
  const warn = [
    ...sec.checks.filter((c) => c.level === "warn").map(secItem),
    ...cache.filter((c) => c.level === "warn" || c.level === "bad").map(cacheItem),
  ];
  const hardening = sec.checks.filter((c) => c.level === "info" && c.detail.startsWith("Not set") && HARDENING[c.id]);
  const grade = `Security grade ${sec.grade} (${sec.score}/100)`;
  return agentDoc({
    title: "Response headers",
    url: ctx.url,
    heading: ctx.heading,
    result: bad.length || warn.length ? `${grade}: ${counted(bad.length, warn.length)}.` : `${NO_PROBLEM} ${grade}.`,
    context: [
      `Response: HTTP ${fetched.status}${fetched.redirected ? `, after redirects to ${fetched.url}` : ""}, ${fetched.ms} ms (fetched again by devkit; Set-Cookie is not visible).`,
      bad.length || warn.length
        ? "Set headers where the HTML response is produced: the server or CDN config, or the framework's headers setting (next.config.js headers(), vercel.json, netlify.toml, nginx add_header)."
        : "",
    ],
    sections: [
      { title: "To fix", body: list(bad) },
      { title: "Worth checking", body: list(warn) },
      { title: "Optional hardening", body: hardening.map((c) => `- ${HARDENING[c.id]}`) },
    ],
    verify:
      bad.length || warn.length
        ? `Deploy, then refresh devkit's Headers & security panel, or run ${code(`curl -sI ${fetched.url}`)}.`
        : undefined,
  });
}

/* Performance */

const VITAL_FIX: Record<VitalName, string> = {
  lcp: 'Find the LCP element (Chrome DevTools Performance panel, or the largest image or text block above the fold). If it is an image: do not lazy-load it, give it `fetchpriority="high"` or a `<link rel="preload" as="image">`, serve it resized in AVIF or WebP. Cut render-blocking CSS and JS, and the server time (TTFB) before it.',
  inp: "Open devkit's Responsiveness panel to find the slow interactions and the scripts behind them; then split their handlers, yield to the main thread (`scheduler.yield()` or `setTimeout`), and move heavy work off it.",
  cls: "Give images, videos, iframes and ad slots explicit `width` and `height` (or `aspect-ratio`), do not insert content above what is on screen after load, and match web font fallbacks (`size-adjust`) or use `font-display: optional`.",
  fcp: "Remove render-blocking resources in `<head>`: `defer` the scripts, inline the critical CSS and load the rest without blocking, `preconnect` to the origins needed for the first paint.",
  ttfb: "The server answers slowly: cache the HTML at a CDN, cut the work done per request (database queries, server rendering), and avoid redirects before the document.",
};

const NOT_MEASURED: Record<VitalName, string> = {
  lcp: "page still loading or loaded in a background tab",
  inp: "no interaction yet",
  cls: "not reported in this tab",
  fcp: "page not painted, or loaded in a background tab",
  ttfb: "no navigation entry (back/forward cache)",
};

/** Over these transfer sizes one resource is worth a look. */
const HEAVY: Record<ResourceKind, { bytes: number; fix: string }> = {
  image: {
    bytes: 400 * 1024,
    fix: "Serve it resized for its display size, in AVIF or WebP, with `srcset` and `sizes`; lazy-load it if it is below the fold.",
  },
  script: {
    bytes: 300 * 1024,
    fix: "Split the bundle, load routes and widgets on demand, and drop unused dependencies (check a bundle analyzer).",
  },
  style: { bytes: 150 * 1024, fix: "Remove unused CSS and split what only some pages need." },
  font: {
    bytes: 150 * 1024,
    fix: "Serve WOFF2, subset it to the characters used (`unicode-range`), or use a variable font instead of many weights.",
  },
  fetch: { bytes: 1024 * 1024, fix: "Check it is needed on load; paginate or compress the response." },
  other: { bytes: 1024 * 1024, fix: "Check it is needed on load, and that it is compressed and cached." },
};

/** Performance panel: Web Vitals, long tasks, navigation phases and resources of `collectPerf`. */
export function perfMarkdown(p: PerfSnapshot, ctx: AgentCtx): string {
  const redactor = createRedactor(p.resources.map((r) => r.name).join("\n"));
  const name = (url: string) => code(clip(redactor.redact(url), 160));
  const bad: Item[] = [];
  const warn: Item[] = [];
  const vitals = vitalsOf(p);
  const images = p.resources
    .filter((r) => resourceKind(r.name, r.type) === "image" && r.transfer > 0)
    .sort((a, b) => b.transfer - a.transfer)
    .slice(0, 3);
  for (const v of vitals) {
    const rating = rateVital(v.name, v.value);
    if (!rating || rating === "good") continue;
    const t = VITALS[v.name];
    const th = (n: number) => (t.unitless ? String(n) : msLabel(n));
    const details = [`Fix: ${VITAL_FIX[v.name]}`];
    if (v.name === "lcp" && images.length)
      details.push(`Largest images on the page: ${images.map((r) => `${name(r.name)} (${formatBytes(r.transfer)})`).join(", ")}`);
    if (v.name === "lcp" || v.name === "fcp") {
      const ttfb = p.navigation?.ttfb ?? null;
      if (ttfb !== null && rateVital("ttfb", ttfb) !== "good") details.push(`TTFB alone is ${formatVital("ttfb", ttfb)} of it.`);
    }
    (rating === "poor" ? bad : warn).push({
      text: `${t.label} (${t.name}) is ${formatVital(v.name, v.value)}: ${RATING_TEXT[rating].toLowerCase()} (good up to ${th(t.good)}, poor above ${th(t.poor)}).`,
      details,
    });
  }
  if (p.longTasks.total > 300)
    warn.push({
      text: `${plural(p.longTasks.count, "long task")} blocked the main thread for ${msLabel(p.longTasks.total)} in total.`,
      details: [
        "Fix: find them in the Chrome DevTools Performance panel; split long work into chunks that yield, defer non-critical scripts, and move heavy computation to a Web Worker.",
      ],
    });
  const redirect = p.navigation?.redirect ?? 0;
  if (redirect > 50)
    warn.push({
      text: `The document went through redirects costing ${msLabel(redirect)} before its request.`,
      details: ["Fix: link to the final URL directly (scheme, host and trailing slash included)."],
    });
  const heavy = p.resources
    .map((r) => ({ r, kind: resourceKind(r.name, r.type) }))
    .filter(({ r, kind }) => r.transfer > HEAVY[kind].bytes)
    .sort((a, b) => b.r.transfer - a.r.transfer);
  for (const { r, kind } of heavy.slice(0, 8))
    warn.push({ text: `Heavy ${kind}: ${name(r.name)}, ${formatBytes(r.transfer)} transferred.`, details: [`Fix: ${HEAVY[kind].fix}`] });
  if (heavy.length > 8) warn.push({ text: `… and ${plural(heavy.length - 8, "more heavy resource")}.` });

  const breakdown = resourceBreakdown(p.resources);
  const missing = vitals.filter((v) => rateVital(v.name, v.value) === null).map((v) => `${VITALS[v.name].label} (${NOT_MEASURED[v.name]})`);
  const heaviest = [...p.resources]
    .filter((r) => r.transfer > 0)
    .sort((a, b) => b.transfer - a.transfer)
    .slice(0, 5);
  const slowest = [...p.resources].sort((a, b) => b.duration - a.duration).slice(0, 5);
  const nav = p.navigation ? navigationPhases(p.navigation) : null;
  const summary = vitalsSummary(p);
  return agentDoc({
    title: "Performance",
    url: ctx.url,
    heading: ctx.heading,
    result: `${sentence(counted(bad.length, warn.length))} Core Web Vitals: ${summary.text}.`,
    context: [
      "Lab data from this tab (one load, buffered entries); field data (CrUX) can differ.",
      missing.length ? `Not measured: ${missing.join(", ")}.` : "",
      `${plural(breakdown.count, "request")}, ${formatBytes(breakdown.bytes)} transferred (0 B for cached responses and cross-origin ones without Timing-Allow-Origin).`,
    ],
    sections: [
      { title: "To fix", body: list(bad) },
      { title: "Worth checking", body: list(warn, 15) },
      {
        title: "Navigation timing",
        body: nav
          ? [
              nav.phases
                .filter((ph) => ph.end - ph.start >= 1)
                .map((ph) => `${ph.label} ${msLabel(ph.end - ph.start)}`)
                .join(" · "),
              nav.markers.map((m) => `${m.label} at ${msLabel(m.at)}`).join(" · "),
            ]
          : [],
      },
      {
        title: "Heaviest requests",
        body: heaviest.map((r) => `- ${name(r.name)}: ${formatBytes(r.transfer)}, ${msLabel(r.duration)}`),
      },
      {
        title: "Slowest requests",
        body: slowest
          .filter((r) => r.duration >= 100)
          .map((r) => `- ${name(r.name)}: ${msLabel(r.duration)}, starts at ${msLabel(r.startTime)}`),
      },
    ],
    verify:
      bad.length || warn.length
        ? `Reload the page in a foreground tab and refresh devkit's Performance panel; for field data, run PageSpeed Insights: ${EXTERNAL_TOOLS.find((t) => t.name === "PageSpeed Insights")!.url(ctx.url)}`
        : undefined,
  });
}

/* Console errors */

const ERROR_KIND: Record<string, { label: string; fix: string }> = {
  error: {
    label: "Uncaught error",
    fix: "correct the code at the first stack frame that belongs to the project (not a library or the framework).",
  },
  rejection: {
    label: "Unhandled rejection",
    fix: "a promise failed with nothing handling it: add a `catch` (or try / await) where it is created, and handle the failure case.",
  },
  console: { label: "console.error", fix: "the stack shows where it was logged: find why that code path reports an error." },
  resource: {
    label: "Failed resource",
    fix: "check the URL exists and answers 200 (path, deploy, CDN), and that CSP or CORS does not block it.",
  },
};

/** Console errors panel: what devkit's capture holds for the page (`readErrors`). */
export function errorsMarkdown(data: { installed: boolean; errors: readonly ReportError[] }, ctx: AgentCtx): string {
  const errors = [...data.errors].sort((a, b) => a.time - b.time);
  const total = errors.reduce((s, e) => s + (e.count || 1), 0);
  const redactor = createRedactor(errors.map((e) => [e.message, e.source ?? "", e.stack ?? ""].join("\n")).join("\n"));
  const r = redactor.redact;
  const pageOrigin = originOf(ctx.url);
  const items = errors.map((e): Item => {
    const kind = ERROR_KIND[e.kind] ?? { label: e.kind, fix: "" };
    const lines = e.message.split("\n");
    const details: string[] = [];
    if (e.source) {
      const loc = `${r(clip(e.source, 200))}${e.line ? `:${e.line}:${e.column ?? 0}` : ""}`;
      const local = sourcePath(e.source);
      details.push(`Source: ${code(loc)}${local !== e.source ? ` (path ${code(clip(r(local), 160))})` : ""}`);
      const origin = originOf(e.source);
      if (origin && pageOrigin && origin !== pageOrigin)
        details.push(`From another origin (${origin}): a third-party script, or a CDN copy of the project's.`);
    }
    if (lines.length > 1) details.push(`Message continues: ${code(clip(r(lines.slice(1).join(" ").trim()), 300))}`);
    if (kind.fix) details.push(`Fix: ${kind.fix}`);
    const frames = e.stack
      ?.split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/chrome-extension:/.test(l))
      .slice(0, 8)
      .join("\n");
    return {
      text: `${kind.label}${e.count > 1 ? ` (×${e.count})` : ""}: ${code(clip(r(lines[0]!), 300))}`,
      details,
      block: frames ? fence(clip(r(frames), 1200)) : undefined,
    };
  });
  const result = errors.length
    ? `${plural(total, "error")} captured (${plural(errors.length, "distinct message")}).`
    : data.installed
      ? `${NO_PROBLEM} No error captured since devkit started listening.`
      : "Not measured: devkit's error capture is not running on this page.";
  return agentDoc({
    title: "Console errors",
    url: ctx.url,
    heading: ctx.heading,
    result,
    context: [
      errors.length ? "Listed in the order they first happened: an early error often causes the later ones." : "",
      !data.installed && !errors.length
        ? "Turn capture on in devkit's Console errors panel (Capture on all pages), reload the page, then copy the report again."
        : "",
      redactor.count
        ? `${plural(redactor.count, "value")} that looked like a secret or token ${redactor.count === 1 ? "is" : "are"} masked.`
        : "",
    ],
    sections: [{ title: "To fix", body: list(items, 15, "more distinct errors") }],
    verify: errors.length
      ? "Reload the page with devkit's capture on, repeat the same steps, and check devkit's Console errors panel stays empty."
      : undefined,
  });
}

/* Links */

/** One checked link, as the Link checker holds it. */
export interface LinkCheck {
  href: string;
  text: string;
  status: number | "error" | "pending";
  /** "→ final URL" after a redirect, or the network error. */
  detail?: string;
}

/** Statuses that often mean "not for a request without cookies" rather than "gone". */
const GATED = new Set([401, 403, 405, 429, 999]);

function linkFinder(href: string): string {
  try {
    const u = new URL(href);
    const tail = u.pathname !== "/" ? `${u.pathname}${u.search}` : u.host;
    return code(`a[href*="${clip(tail, 120).replace(/"/g, '\\"')}"]`);
  } catch {
    return code(`a[href="${href}"]`);
  }
}

/** Link checker panel: the results of its "Check all" run. */
export function linksMarkdown(results: readonly LinkCheck[], ctx: AgentCtx): string {
  const redactor = createRedactor(results.map((l) => `${l.href} ${l.detail ?? ""}`).join("\n"));
  const r = (s: string) => clip(redactor.redact(s), 200);
  const where = (l: LinkCheck) => [
    l.text ? `Link text: "${clip(l.text, 80)}"` : "Link has no text (an image or icon link)",
    `Find it: ${linkFinder(r(l.href))}`,
  ];
  const broken: Item[] = [];
  const gated: Item[] = [];
  const redirected: Item[] = [];
  let pending = 0;
  for (const l of results) {
    if (l.status === "pending") pending++;
    else if (l.status === "error")
      broken.push({
        text: `No answer (${l.detail ?? "network error"}): ${code(r(l.href))}`,
        details: [...where(l), "Fix: check the domain and URL still exist; remove or replace the link if they do not."],
      });
    else if (l.status >= 400 && GATED.has(l.status))
      gated.push({
        text: `HTTP ${l.status}: ${code(r(l.href))}`,
        details: [
          ...where(l),
          "Answered to a request without cookies: often a login wall or bot protection. Open it in a browser to check it works for visitors.",
        ],
      });
    else if (l.status >= 400)
      broken.push({
        text: `HTTP ${l.status}: ${code(r(l.href))}`,
        details: [
          ...where(l),
          l.status >= 500
            ? "Fix: the target server fails; if it keeps failing, replace or remove the link."
            : "Fix: point the link at the page's current URL or remove it; if the target is on this site, add a redirect from the old URL.",
        ],
      });
    else if (l.status >= 300 || l.detail?.startsWith("→"))
      redirected.push({
        text: `${code(r(l.href))} redirects to ${code(r(l.detail?.replace(/^→\s*/, "") ?? `HTTP ${l.status}`))}`,
        details: [...where(l), "Fix: link straight to the final URL."],
      });
  }
  const done = results.length - pending;
  const found = broken.length + gated.length + redirected.length;
  const result = !done
    ? "Not checked yet: run Check all in devkit's Link checker panel, then copy the report again."
    : found
      ? `${[
          `${broken.length} broken`,
          redirected.length ? `${redirected.length} redirected` : "",
          gated.length ? `${gated.length} to check by hand` : "",
        ]
          .filter(Boolean)
          .join(", ")}, out of ${plural(done, "link")} checked.`
      : `${NO_PROBLEM} ${plural(done, "link")} checked.`;
  return agentDoc({
    title: "Links",
    url: ctx.url,
    heading: ctx.heading,
    result,
    context: [
      done ? "Checked from devkit without cookies (HEAD, then GET when refused); same-page anchors are skipped." : "",
      pending && done ? `${plural(pending, "link")} not checked (the check was stopped or is still running).` : "",
      found ? "`Find it` selectors match the URL's path, so they also find relative hrefs in the source." : "",
    ],
    sections: [
      { title: "To fix", body: list(broken, 30, "more broken links") },
      { title: "Worth checking", body: list([...gated, ...redirected], 20, "more links") },
    ],
    verify: found ? "Fix the links, reload the page and run devkit's Link checker again." : undefined,
  });
}

/* Fonts and colors */

/** Fonts & colors panel: the fonts, families and palette of `collectFontsColors`, plus the contrast checker's pair when given. */
export function fontsMarkdown(data: FontsColors, ctx: AgentCtx & { contrast?: { fg: string; bg: string } }): string {
  const bad: Item[] = [];
  const warn: Item[] = [];
  const seen = new Set<string>();
  for (const f of data.fonts) {
    const key = `${f.family}|${f.weight}|${f.style}`;
    if (f.status !== "error" || seen.has(key)) continue;
    seen.add(key);
    bad.push({
      text: `Font face ${code(f.family)} ${f.weight} ${f.style} failed to load.`,
      details: [
        `Where: the \`@font-face\` rule for "${f.family}" (its \`src\` URL).`,
        "Fix: check the URL answers 200 with a font file, that a font on another origin is served with `Access-Control-Allow-Origin`, and that CSP `font-src` allows it.",
      ],
    });
  }
  if (ctx.contrast) {
    const fg = parseColor(ctx.contrast.fg);
    const bg = parseColor(ctx.contrast.bg);
    const ratio = fg && bg ? contrast(fg, bg) : null;
    if (fg && bg && ratio !== null && ratio < 4.5)
      bad.push({
        text: `Text ${code(toHex(fg))} on ${code(toHex(bg))} has a contrast of ${ratio}:1: fails WCAG AA for body text (4.5:1)${ratio >= 3 ? ", passes for large text (3:1)" : " and for large text (3:1)"}.`,
        details: ["Fix: darken the text or lighten the background (or the reverse on a dark theme) until the pair reaches 4.5:1."],
      });
  }
  const loaded = data.fonts.filter((f) => f.status === "loaded");
  if (loaded.length > 12)
    warn.push({
      text: `${plural(loaded.length, "font face")} loaded: each weight and style is a separate download.`,
      details: ["Fix: drop the weights the design does not use, or switch to one variable font."],
    });
  if (data.families.length > 4)
    warn.push({
      text: `${plural(data.families.length, "font family", "font families")} set on text: ${data.families
        .slice(0, 8)
        .map((f) => f.family)
        .join(", ")}${data.families.length > 8 ? ", …" : ""}.`,
      details: ["Check the families that are used in a few places only: they may be leftovers, or styles that should use the main family."],
    });
  const hex = (c: string) => {
    const rgba = parseColor(c);
    return rgba ? toHex(rgba) : c;
  };
  return agentDoc({
    title: "Fonts and colors",
    url: ctx.url,
    heading: ctx.heading,
    result: counted(bad.length, warn.length),
    context: ["Text contrast is checked element by element by devkit's Accessibility audit (axe rule `color-contrast`)."],
    sections: [
      { title: "To fix", body: list(bad) },
      { title: "Worth checking", body: list(warn) },
      {
        title: "In use",
        body: [
          data.families.length
            ? `- Families on text: ${data.families
                .slice(0, 10)
                .map((f) => `${f.family} (${f.count})`)
                .join(", ")}`
            : "",
          data.fonts.length
            ? `- Font faces: ${data.fonts.length} declared, ${loaded.length} loaded`
            : "- Font faces: none (system fonts only)",
          data.colors.length
            ? `- Most used colors: ${data.colors
                .slice(0, 12)
                .map((c) => `${hex(c.color)} (${c.count})`)
                .join(", ")}`
            : "",
        ],
      },
    ],
    verify: bad.length || warn.length ? "Reload the page and refresh devkit's Fonts & colors panel." : undefined,
  });
}

/* Site files */

export interface SiteFilesData {
  /** `/robots.txt` of the origin: its HTTP status, and its rules when it answered under 400. */
  robots?: { status: number; parsed: Robots | null } | null;
  sitemap?: { url: string; status: number; parsed: Sitemap | null } | null;
  /** `href` null: the page links no manifest. `json` null: it is not valid JSON. */
  manifest?: { href: string | null; status?: number; json?: Record<string, unknown> | null } | null;
}

const MANIFEST_FIX: Record<string, string> = {
  "name or short_name": '`"name": "…", "short_name": "…"`',
  start_url: '`"start_url": "/"`',
  display: '`"display": "standalone"`',
  "192px icon": '`{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }` in `icons`',
  "512px icon": '`{ "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }` in `icons`',
  "maskable icon": '`"purpose": "maskable"` on an icon whose content sits in the central 80%',
  theme_color: '`"theme_color": "#…"`',
  background_color: '`"background_color": "#…"`',
  id: '`"id": "/"`',
};

const normalize = (u: string) => u.split("#")[0]!.replace(/\/$/, "");

/** robots.txt, sitemap, manifest panel: the three files as the panel fetched them. */
export function siteFilesMarkdown(data: SiteFilesData, ctx: AgentCtx): string {
  const origin = originOf(ctx.url);
  const path = (() => {
    try {
      const u = new URL(ctx.url);
      return `${u.pathname}${u.search}`;
    } catch {
      return "/";
    }
  })();
  const bad: Item[] = [];
  const warn: Item[] = [];
  const notes: string[] = [];
  const robots = data.robots;
  if (robots && robots.status >= 500)
    bad.push({
      text: `${code(`${origin}/robots.txt`)} answers HTTP ${robots.status}.`,
      details: ["Fix: make it answer 200 (or 404 when there is none): Google stops crawling the site while robots.txt fails with a 5xx."],
    });
  else if (robots && !robots.parsed)
    warn.push({
      text: `No robots.txt: ${code(`${origin}/robots.txt`)} answers HTTP ${robots.status}, so crawlers may fetch everything.`,
      details: ["Fix: add one at the site root, for example:"],
      block: fence(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml`),
    });
  else if (robots?.parsed) {
    const verdict = isAllowed(robots.parsed, "Googlebot", path);
    if (!verdict.allowed)
      bad.push({
        text: `This page (${code(path)}) is blocked for Googlebot by ${code(verdict.rule ?? "Disallow")} in robots.txt.`,
        details: [
          'Fix: if the page should be in search results, remove or narrow that rule. Blocking crawling does not remove a page from the index: use `<meta name="robots" content="noindex">` for that, on a crawlable page.',
        ],
      });
    if (!robots.parsed.sitemaps.length)
      warn.push({
        text: "robots.txt lists no sitemap.",
        details: [`Fix: add ${code(`Sitemap: ${origin}/sitemap.xml`)} (an absolute URL) to robots.txt.`],
      });
  }
  const sitemap = data.sitemap;
  if (sitemap) {
    const listed = Boolean(robots?.parsed?.sitemaps.includes(sitemap.url));
    if (!sitemap.parsed)
      (listed ? bad : warn).push({
        text: `No sitemap at ${code(sitemap.url)} (HTTP ${sitemap.status})${listed ? ", the URL robots.txt points to" : ""}.`,
        details: [
          listed
            ? "Fix: publish the sitemap at that URL, or correct the `Sitemap:` line of robots.txt."
            : "Fix: generate one (most frameworks and CMSs have a plugin for it) and list it in robots.txt.",
        ],
      });
    else if (sitemap.parsed.kind === "unknown")
      bad.push({
        text: `${code(sitemap.url)} is not a sitemap: its root element is neither \`<urlset>\` nor \`<sitemapindex>\`, or the XML is invalid.`,
        details: ["Fix: serve sitemap XML (https://www.sitemaps.org/protocol.html) at that URL."],
      });
    else {
      const { kind, urls } = sitemap.parsed;
      if (!urls.length)
        warn.push({ text: `The sitemap ${code(sitemap.url)} is empty.`, details: ["Fix: list the site's indexable pages in it."] });
      if (urls.length > 50_000)
        bad.push({
          text: `The sitemap ${code(sitemap.url)} lists ${urls.length.toLocaleString("en")} URLs: the limit is 50,000.`,
          details: ["Fix: split it into several sitemaps listed by a sitemap index."],
        });
      const host = originOf(sitemap.url);
      const foreign = urls.filter((u) => originOf(u.loc) !== host);
      if (foreign.length)
        warn.push({
          text: `${plural(foreign.length, "entry", "entries")} of ${code(sitemap.url)} ${foreign.length === 1 ? "is" : "are"} on another host, e.g. ${code(clip(foreign[0]!.loc, 160))}.`,
          details: [
            "Fix: a sitemap lists URLs of its own host only (unless both hosts are verified in Search Console): move them to that host's sitemap.",
          ],
        });
      if (kind === "urlset" && urls.length && !urls.some((u) => normalize(u.loc) === normalize(ctx.url)))
        warn.push({
          text: `This page is not listed in ${code(sitemap.url)}.`,
          details: ["Add it if it should be indexed (it may also sit in another sitemap of the site)."],
        });
      notes.push(
        `- Sitemap ${code(sitemap.url)}: ${kind === "sitemapindex" ? "sitemap index" : "URL set"}, ${plural(urls.length, "entry", "entries")}.`,
      );
    }
  }
  const manifest = data.manifest;
  if (manifest && !manifest.href) notes.push("- No web app manifest (only needed for an installable app).");
  else if (manifest?.href && !manifest.json)
    bad.push({
      text: `The manifest ${code(manifest.href)} is not valid JSON (HTTP ${manifest.status ?? "?"}).`,
      details: ['Fix: serve valid JSON at that URL, or fix the `<link rel="manifest">` href.'],
    });
  else if (manifest?.href && manifest.json) {
    const failing = manifestChecks(manifest.json).filter((c) => !c.ok);
    if (failing.length)
      warn.push({
        text: `The manifest ${code(manifest.href)} misses what Chrome needs to offer installing the app (only matters if the site should be installable).`,
        details: failing.map((c) => `${c.label}: ${c.detail}${MANIFEST_FIX[c.label] ? `; add ${MANIFEST_FIX[c.label]}` : ""}`),
      });
  }
  const notChecked = [
    robots === undefined ? "robots.txt" : "",
    sitemap === undefined ? "sitemap" : "",
    manifest === undefined ? "manifest" : "",
  ].filter(Boolean);
  return agentDoc({
    title: "robots.txt, sitemap and manifest",
    url: ctx.url,
    heading: ctx.heading,
    result: counted(bad.length, warn.length),
    context: [notChecked.length ? `Not checked: ${notChecked.join(", ")}.` : ""],
    sections: [
      { title: "To fix", body: list(bad) },
      { title: "Worth checking", body: list(warn) },
      { title: "Notes", body: notes },
    ],
    verify:
      bad.length || warn.length
        ? "Deploy, then refresh devkit's robots.txt, sitemap, manifest panel; Search Console's robots.txt and sitemap reports show what Google fetched."
        : undefined,
  });
}
