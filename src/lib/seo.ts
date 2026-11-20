import type { Check, Level } from "./headers";
import { hreflangReport, RETURN_LINKS_NOTE } from "./hreflang";
import type { MetaSnapshot, PageContent } from "./page/collect";
import { LENGTH_LIMITS, lengthCount, OG_ESSENTIAL, OG_RECOMMENDED, socialChecklist, socialMistakes } from "./social";

export const metaValue = (snap: MetaSnapshot, key: string) => snap.meta.find((m) => m.key.toLowerCase() === key.toLowerCase())?.value;
export const linkHref = (snap: MetaSnapshot, rel: string) => snap.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes(rel))?.href;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function seoReport(snap: MetaSnapshot): Check[] {
  const out: Check[] = [];
  const add = (id: string, label: string, level: Check["level"], detail: string) => out.push({ id, label, level, detail });

  const title = snap.title.trim();
  const t = lengthCount(title, LENGTH_LIMITS.title);
  add(
    "title",
    "Title",
    !title ? "bad" : t.length < 10 ? "warn" : t.over ? "info" : "good",
    !title
      ? "Missing"
      : t.length < 10
        ? `Short (${t.length} chars, aim for 10–60): ${title}`
        : t.over
          ? `Long (${t.length} chars); it may be truncated: ${title}`
          : `${t.length} chars (aim for 10–60): ${title}`,
  );
  const desc = metaValue(snap, "description")?.trim();
  const d = lengthCount(desc, LENGTH_LIMITS.description);
  add(
    "description",
    "Meta description",
    !desc ? "bad" : d.length < 50 ? "warn" : d.over ? "info" : "good",
    !desc
      ? "Missing"
      : d.length < 50
        ? `Short (${d.length} chars, aim for 50–160): ${desc}`
        : d.over
          ? `Long (${d.length} chars); it may be truncated: ${desc}`
          : `${d.length} chars (aim for 50–160): ${desc}`,
  );

  const canonical = linkHref(snap, "canonical");
  if (!canonical) add("canonical", "Canonical", "warn", "No <link rel=canonical>");
  else {
    const same = canonical.split("#")[0] === snap.url.split("#")[0];
    add("canonical", "Canonical", "good", same ? `Self-referencing: ${canonical}` : `Points elsewhere: ${canonical}`);
  }
  const robots = [metaValue(snap, "robots"), metaValue(snap, "googlebot")].filter(Boolean).join(", ");
  add("robots", "Robots meta", /noindex|\bnone\b/i.test(robots) ? "bad" : "good", robots ? robots : "Not set (index, follow)");
  add(
    "viewport",
    "Viewport",
    metaValue(snap, "viewport") ? "good" : "bad",
    metaValue(snap, "viewport") ?? "Missing: mobile browsers render at desktop width",
  );
  add("lang", "Language", snap.lang ? "good" : "warn", snap.lang || "No lang on <html>");
  add("charset", "Charset", /utf-8/i.test(snap.charset) ? "good" : "warn", snap.charset);
  add("doctype", "Doctype", /<!DOCTYPE html>/i.test(snap.doctype) ? "good" : "warn", snap.doctype || "Missing: quirks mode");

  const h1 = snap.headings.filter((h) => h.level === 1);
  add(
    "h1",
    "H1",
    h1.length === 1 ? "good" : h1.length ? "warn" : "bad",
    h1.length
      ? `${h1.length} × h1: ${h1
          .map((h) => h.text)
          .join(" | ")
          .slice(0, 160)}`
      : "No h1",
  );

  if (snap.content) {
    const c = pageCounts(snap.content, snap.url);
    if (c.images.total)
      add(
        "images-alt",
        "Image alt text",
        c.images.missingAlt ? "warn" : "good",
        c.images.missingAlt
          ? `${c.images.missingAlt} of ${plural(c.images.total, "image")} ${c.images.missingAlt === 1 ? "has" : "have"} no alt text.`
          : `All ${plural(c.images.total, "image")} have an alt attribute${c.images.decorative ? ` (${c.images.decorative} decorative, alt="")` : ""}.`,
      );
  }

  const og = OG_ESSENTIAL.filter((k) => !metaValue(snap, k)?.trim());
  add("og", "Open Graph", og.length === 0 ? "good" : og.length > 2 ? "bad" : "warn", og.length ? `Missing ${og.join(", ")}` : "Complete");
  const recommended = OG_RECOMMENDED.filter((k) => !metaValue(snap, k)?.trim());
  if (og.length < OG_ESSENTIAL.length && recommended.length)
    add("og-recommended", "Open Graph extras", "info", `Open Graph could still add: ${recommended.join(", ")}.`);
  for (const m of socialMistakes(snap)) add(m.id, "Social tags", m.level, m.text);
  const tw = metaValue(snap, "twitter:card");
  add("twitter", "Twitter / X card", tw ? "good" : "info", tw ? `twitter:card ${tw}` : "Not set (Open Graph is used as fallback)");

  const icon = snap.links.some((l) => /icon/i.test(l.rel));
  add(
    "favicon",
    "Favicon",
    icon ? "good" : "warn",
    icon
      ? snap.links
          .filter((l) => /icon/i.test(l.rel))
          .map((l) => `${l.rel}${l.sizes ? ` ${l.sizes}` : ""}`)
          .join(", ")
      : "No <link rel=icon>: /favicon.ico is requested",
  );
  const hl = hreflangReport(snap.links, snap.url, canonical);
  if (hl.entries.length) {
    const entryProblems = hl.entries.flatMap((e) => e.problems.map((p) => ({ ...p, text: `${e.lang || "(empty)"}: ${p.text}` })));
    // The summary states what is there; each problem below is its own check (counted once).
    add(
      "hreflang",
      "hreflang",
      "good",
      `${plural(hl.entries.length, "alternate")} (${hl.entries.map((a) => a.lang).join(", ")})${hl.xDefault ? "" : ", no x-default"}`,
    );
    if (!hl.selfReference)
      add("hreflang-self", "hreflang", "warn", "No self-reference: the page should list itself among its hreflang alternates.");
    if (!hl.xDefault)
      add("hreflang-x-default", "hreflang", "info", "No x-default entry — it is the fallback for languages you do not target.");
    const seen = new Set<string>();
    for (const p of [...hl.problems.filter((p) => !/^No (self-reference|x-default)/.test(p.text)), ...entryProblems]) {
      if (seen.has(p.text)) continue;
      seen.add(p.text);
      add(`hreflang-${seen.size}`, "hreflang", p.level, p.text);
    }
  }
  add(
    "jsonld",
    "Structured data",
    snap.jsonLd.length || snap.microdataTypes.length ? "good" : "info",
    snap.jsonLd.length
      ? `${snap.jsonLd.length} JSON-LD block(s)`
      : snap.microdataTypes.length
        ? `Microdata: ${snap.microdataTypes.join(", ")}`
        : "None",
  );
  const manifest = linkHref(snap, "manifest");
  add("manifest", "Web app manifest", manifest ? "good" : "info", manifest ?? "None");
  return out;
}

/** Checks whose "info" only says something is absent that most pages do without. */
const NOT_ISSUES = new Set(["jsonld", "manifest", "twitter"]);

/** The checks worth a look: problems and warnings first, then the hints. */
export const seoIssues = (checks: Check[]) => {
  const rank: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  return checks
    .filter((c) => c.level !== "good" && !(c.level === "info" && NOT_ISSUES.has(c.id)))
    .sort((a, b) => rank[a.level] - rank[b.level]);
};

/** Open Graph / Twitter values, with the fallbacks crawlers use. */
export function socialPreview(snap: MetaSnapshot) {
  return {
    title: metaValue(snap, "og:title") ?? metaValue(snap, "twitter:title") ?? snap.title,
    description: metaValue(snap, "og:description") ?? metaValue(snap, "twitter:description") ?? metaValue(snap, "description") ?? "",
    image: metaValue(snap, "og:image") ?? metaValue(snap, "twitter:image"),
    site: metaValue(snap, "og:site_name") ?? new URL(snap.url).hostname,
    card: metaValue(snap, "twitter:card") ?? "summary",
  };
}

export interface PageCounts {
  images: { total: number; missingAlt: number; decorative: number; withoutTitle: number };
  links: { total: number; internal: number; external: number; unique: number; nofollow: number };
}

/** The site a host belongs to for internal / external links: the hostname, a leading "www." dropped. */
const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * Image and link counts. A link is internal when its hostname is the page's, a leading "www." aside
 * (www.example.com and example.com are one site; blog.example.com counts as external, as the registrable
 * domain would need the public suffix list).
 */
export function pageCounts(content: PageContent, pageUrl: string): PageCounts {
  let host = "";
  try {
    host = siteOf(new URL(pageUrl).hostname);
  } catch {
    /* no URL: everything is external */
  }
  const imgs = content.images;
  let internal = 0;
  let nofollow = 0;
  for (const l of content.links) {
    try {
      if (siteOf(new URL(l.href).hostname) === host) internal++;
    } catch {
      /* unparsable: external */
    }
    if (/(^|\s)nofollow(\s|$)/i.test(l.rel)) nofollow++;
  }
  // Past the 5,000 links kept, the split is extrapolated from those.
  const scale = content.links.length ? content.anchors / content.links.length : 1;
  const total = content.anchors;
  const int = Math.round(internal * scale);
  return {
    images: {
      total: imgs.length,
      missingAlt: imgs.filter((i) => i.alt === null).length,
      decorative: imgs.filter((i) => i.alt !== null && !i.alt.trim()).length,
      withoutTitle: imgs.filter((i) => !i.title).length,
    },
    links: {
      total,
      internal: int,
      external: total - int,
      unique: new Set(content.links.map((l) => l.href)).size,
      nofollow: Math.round(nofollow * scale),
    },
  };
}

export interface Indexability {
  index: boolean;
  follow: boolean;
  /** Where each directive came from, e.g. "meta robots: noindex". */
  sources: { source: string; value: string }[];
}

const VALUE_DIRECTIVES = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;

/** Directives of an X-Robots-Tag header that apply to Googlebot (no user agent, or `googlebot:`). */
export function xRobotsForGoogle(header: string): string[] {
  const out: string[] = [];
  let agent: string | null = null;
  for (const raw of header.split(",")) {
    let token = raw.trim();
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(token);
    if (m && !VALUE_DIRECTIVES.test(m[1]!)) {
      agent = m[1]!.toLowerCase();
      token = m[2]!.trim();
    }
    if (token && (agent === null || agent === "googlebot")) out.push(token.toLowerCase());
  }
  return out;
}

/** Whether Google may index the page and follow its links, from meta robots, meta googlebot and X-Robots-Tag. */
export function indexability(snap: Pick<MetaSnapshot, "meta">, headers?: Record<string, string>): Indexability {
  const sources: Indexability["sources"] = [];
  const directives: string[] = [];
  for (const m of snap.meta.filter((m) => /^(robots|googlebot)$/i.test(m.key))) {
    sources.push({ source: `meta ${m.key.toLowerCase()}`, value: m.value });
    directives.push(...m.value.split(",").map((s) => s.trim().toLowerCase()));
  }
  const header = headers ? Object.entries(headers).find(([k]) => k.toLowerCase() === "x-robots-tag")?.[1] : undefined;
  if (header) {
    sources.push({ source: "X-Robots-Tag", value: header });
    directives.push(...xRobotsForGoogle(header));
  }
  return {
    index: !directives.some((d) => d === "noindex" || d === "none"),
    follow: !directives.some((d) => d === "nofollow" || d === "none"),
    sources,
  };
}

export interface SeoCounters {
  issues: number;
  words: number | null;
  headings: number;
  images: { total: number; missingAlt: number } | null;
  links: { total: number; internal: number; external: number } | null;
}

export function seoCounters(snap: MetaSnapshot, checks: Check[]): SeoCounters {
  const c = snap.content ? pageCounts(snap.content, snap.url) : null;
  return {
    issues: seoIssues(checks).length,
    words: snap.content?.words ?? null,
    headings: snap.headings.length,
    images: c ? { total: c.images.total, missingAlt: c.images.missingAlt } : null,
    links: c ? { total: c.links.total, internal: c.links.internal, external: c.links.external } : null,
  };
}

/** The robots.txt answer for Googlebot on the page, as the SEO panel shows it. */
export interface RobotsVerdict {
  status: number;
  allowed: boolean;
  rule?: string;
}

/** Text of a robots.txt verdict: 4xx means no robots.txt (all allowed), 5xx makes Google stop crawling. */
export function robotsText(r: RobotsVerdict): string {
  if (r.status >= 500) return `robots.txt answered HTTP ${r.status}: Google treats the site as blocked until it answers.`;
  if (r.status >= 400) return `No robots.txt (HTTP ${r.status}): everything may be crawled.`;
  return `${r.allowed ? "Allowed" : "Blocked"}${r.rule ? ` (${r.rule})` : ""}`;
}

const MARK: Record<Level, string> = { bad: "✕", warn: "▲", info: "ⓘ", good: "✓" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/**
 * The whole SEO panel as a Markdown report for people (the "Copy report" button): counters, issues, meta,
 * social tags, hreflang, images and links, indexability and the headings.
 */
export function seoTextReport(
  snap: MetaSnapshot,
  extra: { headers?: { status: number; headers: Record<string, string> }; robots?: RobotsVerdict | null } = {},
): string {
  const checks = seoReport(snap);
  const issues = seoIssues(checks);
  const counters = seoCounters(snap, checks);
  const counts = snap.content ? pageCounts(snap.content, snap.url) : null;
  const out: string[] = [`# SEO report: ${snap.title.trim() || snap.url}\nPage: ${snap.url}`];
  out.push(
    [
      plural(counters.issues, "issue"),
      counters.words !== null ? plural(counters.words, "word") : "",
      plural(counters.headings, "heading"),
      counters.images ? `${plural(counters.images.total, "image")} (${counters.images.missingAlt} without alt)` : "",
      counters.links
        ? `${plural(counters.links.total, "link")} (${counters.links.internal} internal · ${counters.links.external} external)`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
  out.push(`## Issues\n\n${issues.length ? issues.map((c) => `- ${MARK[c.level]} ${c.label}: ${c.detail}`).join("\n") : "None."}`);
  const title = lengthCount(snap.title, LENGTH_LIMITS.title);
  const desc = metaValue(snap, "description");
  const dl = lengthCount(desc, LENGTH_LIMITS.description);
  out.push(
    [
      "## Meta",
      "",
      `- Title (${title.length}/${title.max}): ${snap.title.trim() || "missing"}`,
      `- Meta description (${dl.length}/${dl.max}): ${desc?.trim() || "missing"}`,
      `- Canonical: ${linkHref(snap, "canonical") ?? "none"}`,
      `- Robots (meta): ${metaValue(snap, "robots") ?? "not set (index, follow)"}`,
      `- Viewport: ${metaValue(snap, "viewport") ?? "missing"}`,
      `- Language: ${snap.lang || "not set"}`,
    ].join("\n"),
  );
  const social = socialChecklist(snap);
  const tag = (t: { key: string; state: string; value?: string; from?: string }) =>
    `- ${t.state === "set" ? "✓" : t.state === "fallback" ? "↳" : "✕"} ${t.key}${t.state === "set" ? `: ${t.value}` : t.state === "fallback" ? ` (fallback from ${t.from}: ${t.value})` : " (missing)"}`;
  out.push(
    [
      `## Social (Open Graph / Twitter) · ${social.score}/5`,
      "",
      "Essential:",
      ...social.essential.map(tag),
      "",
      "Recommended:",
      ...social.recommended.map(tag),
      "",
      "Twitter / X (with Open Graph fallback):",
      ...social.twitter.map(tag),
    ].join("\n"),
  );
  const hl = hreflangReport(snap.links, snap.url, linkHref(snap, "canonical"));
  if (hl.entries.length)
    out.push(
      [
        `## hreflang (${hl.entries.length}) · x-default ${hl.xDefault ? "yes" : "no"} · self-reference ${hl.selfReference ? "yes" : "no"} · ${plural(hl.languages, "language")}`,
        "",
        "| | hreflang | URL | Notes |",
        "| --- | --- | --- | --- |",
        ...hl.entries.map(
          (e) =>
            `| ${e.problems.some((p) => p.level === "bad" || p.level === "warn") ? "✕" : "✓"} | ${cell(e.lang)} | ${cell(e.raw)} | ${cell([e.self ? "this page" : "", ...e.problems.map((p) => p.text)].filter(Boolean).join("; "))} |`,
        ),
        "",
        ...hl.problems.map((p) => `- ${MARK[p.level]} ${p.text}`),
        RETURN_LINKS_NOTE,
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join("\n"),
    );
  if (counts)
    out.push(
      [
        "## Images · Links",
        "",
        `- Images: ${counts.images.total} total, ${counts.images.missingAlt} missing alt, ${counts.images.withoutTitle} without title`,
        `- Links: ${counts.links.total} total, ${counts.links.internal} internal, ${counts.links.external} external, ${counts.links.unique} unique, ${counts.links.nofollow} nofollow`,
      ].join("\n"),
    );
  const ix = indexability(snap, extra.headers?.headers);
  out.push(
    [
      "## Indexability",
      "",
      `- ${ix.index ? "index" : "noindex"}, ${ix.follow ? "follow" : "nofollow"}${ix.sources.length ? ` (${ix.sources.map((s) => `${s.source}: ${s.value}`).join("; ")})` : " (no robots meta, no X-Robots-Tag)"}`,
      `- robots.txt (Googlebot): ${extra.robots ? robotsText(extra.robots) : "not read"}`,
      `- HTTP status: ${extra.headers ? extra.headers.status : "not read"}`,
    ].join("\n"),
  );
  if (snap.headings.length)
    out.push(
      [
        `## Headings (${snap.headings.length})`,
        "",
        ...snap.headings.slice(0, 200).map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- h${h.level} ${h.text || "(empty)"}`),
        ...(snap.headings.length > 200 ? [`… and ${snap.headings.length - 200} more.`] : []),
      ].join("\n"),
    );
  return out.join("\n\n");
}
