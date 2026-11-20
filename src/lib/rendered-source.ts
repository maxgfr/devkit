// Served HTML vs rendered DOM: what a crawler that does not run JavaScript sees, next to what the browser shows
// after scripts ran. Pure: both documents come in as HTML text, are parsed with DOMParser (scripts never run),
// reduced to the same SEO snapshot and compared. The findings are heuristics.
import type { Level } from "./headers";
import { normalizeUrl } from "./hreflang";
import { indexability } from "./seo";
import { type DiffLine, diffLines } from "./utils/diff";

export interface SnapLink {
  /** Resolved against the page (and its <base>), fragment removed. */
  href: string;
  text: string;
  rel: string;
  internal: boolean;
}

export interface SnapJsonLd {
  raw: string;
  ok: boolean;
  /** Every @type found in the block, nested ones and @graph included. */
  types: string[];
  /** Parsed JSON with sorted keys, for comparing blocks whatever their formatting; the raw text when it does not parse. */
  key: string;
}

export interface SeoSnapshot {
  /** null when the document has no <title>. */
  title: string | null;
  lang: string;
  description: string | null;
  /** meta robots and meta googlebot, as written. */
  robots: { key: string; value: string }[];
  index: boolean;
  follow: boolean;
  /** Every <link rel=canonical>, resolved. */
  canonicals: string[];
  hreflang: { lang: string; href: string }[];
  /** og:*, twitter:*, fb:* and article:* meta tags (several og:image are joined with a space). */
  social: { key: string; value: string }[];
  jsonLd: SnapJsonLd[];
  headings: { level: number; text: string }[];
  links: SnapLink[];
  images: { src: string; alt: string | null }[];
  /** Words of the body text (scripts, styles, templates and noscript left out). */
  words: number;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** The URL relative links of `doc` resolve against: its <base href> when it has one, else the page URL. */
function baseOf(doc: Document, pageUrl: string): string {
  const base = doc.querySelector("base[href]")?.getAttribute("href");
  if (!base) return pageUrl;
  try {
    return new URL(base, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

const resolve = (href: string, base: string): string | null => {
  try {
    const url = new URL(href.trim(), base);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

/** Same JSON whatever the key order and whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function typesOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) typesOf(v, out);
  else if (value && typeof value === "object") {
    const t = (value as Record<string, unknown>)["@type"];
    for (const one of Array.isArray(t) ? t : [t]) if (typeof one === "string") out.add(one);
    for (const v of Object.values(value as Record<string, unknown>)) if (v && typeof v === "object") typesOf(v, out);
  }
  return out;
}

export function jsonLdItem(raw: string): SnapJsonLd {
  try {
    const value = JSON.parse(raw);
    return { raw, ok: true, types: [...typesOf(value)], key: canonicalJson(value) };
  } catch {
    return { raw, ok: false, types: [], key: raw.trim() };
  }
}

const SKIP_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "CANVAS"]);

/** Body text with a space between text nodes, so `<p>a</p><p>b</p>` reads "a b". */
export function bodyText(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  const parts: string[] = [];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) parts.push(child.nodeValue ?? "");
      else if (child.nodeType === 1 && !SKIP_TEXT.has((child as Element).tagName.toUpperCase())) walk(child);
    }
  };
  walk(body);
  return clean(parts.join(" "));
}

/** What a crawler reads in `doc`: title, meta, canonical, hreflang, social tags, JSON-LD, headings, links, images, words. */
export function seoSnapshot(doc: Document, pageUrl: string): SeoSnapshot {
  const base = baseOf(doc, pageUrl);
  let host = "";
  try {
    host = new URL(pageUrl).host;
  } catch {
    /* no page URL: every link counts as external */
  }
  const metas = Array.from(doc.querySelectorAll("meta")).map((m) => ({
    key: (m.getAttribute("name") ?? m.getAttribute("property") ?? "").trim(),
    value: m.getAttribute("content") ?? "",
  }));
  const robots = metas.filter((m) => /^(robots|googlebot)$/i.test(m.key));
  const ix = indexability({ meta: robots });
  const social = new Map<string, string[]>();
  for (const m of metas) {
    const key = m.key.toLowerCase();
    if (/^(og|twitter|fb|article):/.test(key)) social.set(key, [...(social.get(key) ?? []), clean(m.value)]);
  }
  const relOf = (el: Element) => clean(el.getAttribute("rel")).toLowerCase();
  const linkEls = Array.from(doc.querySelectorAll("link[rel][href]"));
  const canonicals = linkEls
    .filter((l) => relOf(l).split(" ").includes("canonical"))
    .map((l) => resolve(l.getAttribute("href") ?? "", base) ?? l.getAttribute("href") ?? "");
  const hreflang = linkEls
    .filter((l) => relOf(l).split(" ").includes("alternate") && l.hasAttribute("hreflang"))
    .map((l) => ({
      lang: clean(l.getAttribute("hreflang")).toLowerCase(),
      href: resolve(l.getAttribute("href") ?? "", base) ?? l.getAttribute("href") ?? "",
    }));
  const titleEl = doc.querySelector("title");
  const description = metas.find((m) => m.key.toLowerCase() === "description");
  const links: SnapLink[] = [];
  for (const a of Array.from(doc.querySelectorAll("a[href], area[href]"))) {
    const href = resolve(a.getAttribute("href") ?? "", base);
    if (!href || !/^https?:/i.test(href)) continue;
    const text = clean(a.textContent || a.getAttribute("aria-label") || a.querySelector("img[alt]")?.getAttribute("alt")).slice(0, 120);
    let internal = false;
    try {
      internal = new URL(href).host === host;
    } catch {
      /* unparsable: external */
    }
    links.push({ href, text, rel: relOf(a), internal });
  }
  const images = Array.from(doc.querySelectorAll("img")).map((img) => {
    const raw = img.getAttribute("src") ?? "";
    return { src: raw ? (resolve(raw, base) ?? raw) : "", alt: img.getAttribute("alt") };
  });
  const text = bodyText(doc);
  return {
    title: titleEl ? clean(titleEl.textContent) : null,
    lang: clean(doc.documentElement?.getAttribute("lang")),
    description: description ? clean(description.value) : null,
    robots,
    index: ix.index,
    follow: ix.follow,
    canonicals,
    hreflang,
    social: [...social].map(([key, values]) => ({ key, value: values.join(" ") })),
    jsonLd: Array.from(doc.querySelectorAll('script[type="application/ld+json" i]')).map((s) => jsonLdItem(s.textContent ?? "")),
    headings: Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
      level: Number(h.tagName[1]),
      text: clean(h.textContent).slice(0, 200),
    })),
    links,
    images,
    words: text ? text.split(" ").length : 0,
  };
}

/* Diff */

export type Change = "added" | "removed" | "changed" | "same";

export interface FieldDiff {
  id: "title" | "description" | "robots" | "canonical" | "lang";
  label: string;
  served: string | null;
  rendered: string | null;
  change: Change;
}

export interface ListDiff<T> {
  added: T[];
  removed: T[];
  same: number;
}

export interface RenderFinding {
  id: string;
  level: Level;
  text: string;
  detail: string;
}

export interface RenderDiff {
  served: SeoSnapshot;
  rendered: SeoSnapshot;
  fields: FieldDiff[];
  hreflang: ListDiff<{ lang: string; href: string }>;
  social: ListDiff<{ key: string; value: string }> & { changed: { key: string; served: string; rendered: string }[] };
  jsonLd: ListDiff<SnapJsonLd> & { changed: { served: SnapJsonLd; rendered: SnapJsonLd }[] };
  headings: ListDiff<{ level: number; text: string }>;
  links: ListDiff<SnapLink> & { relChanged: { href: string; served: string; rendered: string }[] };
  images: ListDiff<{ src: string; alt: string | null }>;
  words: { served: number; rendered: number };
  /** Ranked: problems, then warnings, then notes. */
  findings: RenderFinding[];
}

/** Multiset difference by `key`: what only `b` has (added), what only `a` has (removed), how many both have. */
export function listDiff<T>(a: T[], b: T[], key: (item: T) => string): ListDiff<T> {
  const left = new Map<string, T[]>();
  for (const item of a) left.set(key(item), [...(left.get(key(item)) ?? []), item]);
  const added: T[] = [];
  let same = 0;
  for (const item of b) {
    const k = key(item);
    const bucket = left.get(k);
    if (bucket?.length) {
      bucket.shift();
      same++;
    } else added.push(item);
  }
  return { added, removed: [...left.values()].flat(), same };
}

const field = (
  id: FieldDiff["id"],
  label: string,
  served: string | null,
  rendered: string | null,
  equal = served === rendered,
): FieldDiff => ({
  id,
  label,
  served,
  rendered,
  change: equal ? "same" : served === null || served === "" ? "added" : rendered === null || rendered === "" ? "removed" : "changed",
});

const robotsText = (s: SeoSnapshot) => (s.robots.length ? s.robots.map((r) => `${r.key.toLowerCase()}: ${r.value}`).join("; ") : null);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

const quote = (s: string | null, max = 80) =>
  s === null ? "none" : s === "" ? "empty" : `"${s.length > max ? `${s.slice(0, max)}…` : s}"`;

/** Compares the snapshot of the served HTML with the one of the rendered DOM. */
export function renderDiff(served: SeoSnapshot, rendered: SeoSnapshot): RenderDiff {
  const canon = (s: SeoSnapshot) => (s.canonicals.length ? s.canonicals.join(" ") : null);
  const fields: FieldDiff[] = [
    field("title", "Title", served.title, rendered.title),
    field("description", "Meta description", served.description, rendered.description),
    field("robots", "Meta robots", robotsText(served), robotsText(rendered)),
    field(
      "canonical",
      "Canonical",
      canon(served),
      canon(rendered),
      served.canonicals.map((u) => normalizeUrl(u)).join(" ") === rendered.canonicals.map((u) => normalizeUrl(u)).join(" "),
    ),
    field("lang", "<html lang>", served.lang || null, rendered.lang || null),
  ];
  const hreflang = listDiff(served.hreflang, rendered.hreflang, (h) => `${h.lang} ${normalizeUrl(h.href)}`);

  const servedSocial = new Map(served.social.map((s) => [s.key, s.value]));
  const renderedSocial = new Map(rendered.social.map((s) => [s.key, s.value]));
  const social = {
    added: rendered.social.filter((s) => !servedSocial.has(s.key)),
    removed: served.social.filter((s) => !renderedSocial.has(s.key)),
    same: served.social.filter((s) => renderedSocial.get(s.key) === s.value).length,
    changed: served.social
      .filter((s) => renderedSocial.has(s.key) && renderedSocial.get(s.key) !== s.value)
      .map((s) => ({ key: s.key, served: s.value, rendered: renderedSocial.get(s.key)! })),
  };

  // JSON-LD: identical blocks first, then blocks with the same types count as changed, the rest as added or removed.
  const ld = listDiff(served.jsonLd, rendered.jsonLd, (b) => b.key);
  const sig = (b: SnapJsonLd) => [...b.types].sort().join(",");
  const changed: { served: SnapJsonLd; rendered: SnapJsonLd }[] = [];
  const ldRemoved = [...ld.removed];
  const ldAdded: SnapJsonLd[] = [];
  for (const block of ld.added) {
    const at = ldRemoved.findIndex((r) => r.ok && block.ok && sig(r) === sig(block));
    if (at >= 0) changed.push({ served: ldRemoved.splice(at, 1)[0]!, rendered: block });
    else ldAdded.push(block);
  }
  const jsonLd = { added: ldAdded, removed: ldRemoved, same: ld.same, changed };

  const headings = listDiff(served.headings, rendered.headings, (h) => `${h.level} ${h.text.toLowerCase()}`);
  const linkKey = (l: SnapLink) => normalizeUrl(l.href);
  const uniq = (list: SnapLink[]) => [...new Map(list.map((l) => [linkKey(l), l])).values()];
  const servedLinks = uniq(served.links);
  const renderedLinks = uniq(rendered.links);
  const links = {
    ...listDiff(servedLinks, renderedLinks, linkKey),
    relChanged: servedLinks.flatMap((l) => {
      const r = renderedLinks.find((x) => linkKey(x) === linkKey(l));
      return r && r.rel !== l.rel ? [{ href: l.href, served: l.rel, rendered: r.rel }] : [];
    }),
  };
  const images = listDiff(
    served.images.filter((i) => i.src),
    rendered.images.filter((i) => i.src),
    (i) => i.src,
  );
  const words = { served: served.words, rendered: rendered.words };
  const diff: RenderDiff = { served, rendered, fields, hreflang, social, jsonLd, headings, links, images, words, findings: [] };
  diff.findings = renderFindings(diff);
  return diff;
}

const RANK: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };

/** What the differences mean for crawlers that do not run JavaScript. Heuristics, ranked. */
export function renderFindings(d: RenderDiff): RenderFinding[] {
  const out: RenderFinding[] = [];
  const add = (id: string, level: Level, text: string, detail: string) => out.push({ id, level, text, detail });
  const f = (id: FieldDiff["id"]) => d.fields.find((x) => x.id === id)!;

  if (!d.served.index && d.rendered.index)
    add(
      "noindex-served",
      "bad",
      "noindex only in the served HTML",
      "JavaScript removes the noindex, but Google may stop at the served HTML and skip rendering: the page can stay out of the index.",
    );
  else if (d.served.index && !d.rendered.index)
    add(
      "noindex-rendered",
      "warn",
      "noindex added by JavaScript",
      "Google applies it after rendering; crawlers that do not run JavaScript index the page anyway. Put the directive in the HTML if it is meant.",
    );

  const canonical = f("canonical");
  if (canonical.change === "added")
    add(
      "canonical-js",
      "warn",
      "Canonical only exists after JavaScript",
      `The served HTML has no canonical; JavaScript adds ${quote(canonical.rendered)}. Google may read it after rendering, other crawlers never do: put it in the HTML.`,
    );
  else if (canonical.change === "changed")
    add(
      "canonical-changed",
      "bad",
      "Canonical changed by JavaScript",
      `Served ${quote(canonical.served)}, rendered ${quote(canonical.rendered)}: two conflicting signals, Google may pick either.`,
    );
  else if (canonical.change === "removed")
    add(
      "canonical-removed",
      "warn",
      "Canonical removed by JavaScript",
      `The served HTML declares ${quote(canonical.served)}; the rendered DOM has none.`,
    );
  if (d.rendered.canonicals.length > 1)
    add(
      "canonical-many",
      "bad",
      "Several canonicals after JavaScript",
      `${d.rendered.canonicals.length} canonical links in the rendered DOM: Google ignores them all.`,
    );

  const words = d.words;
  if (words.rendered >= 100 && words.served < words.rendered * 0.3)
    add(
      "content-js",
      "bad",
      "Most of the text is rendered by JavaScript",
      `${plural(words.served, "word")} in the served HTML, ${plural(words.rendered, "word")} after JavaScript: crawlers that do not render see an almost empty page (client-side rendering).`,
    );
  else if (words.rendered >= 50 && words.served < words.rendered * 0.7)
    add(
      "content-partly-js",
      "warn",
      "Part of the text is rendered by JavaScript",
      `${plural(words.served, "word")} served, ${plural(words.rendered, "word")} rendered.`,
    );

  const title = f("title");
  if (title.change === "added")
    add(
      "title-js",
      "warn",
      "Title only exists after JavaScript",
      `JavaScript sets ${quote(title.rendered)}; the served HTML has ${quote(title.served)}.`,
    );
  else if (title.change === "changed")
    add(
      "title-changed",
      "warn",
      "Title changed by JavaScript",
      `Served ${quote(title.served)}, rendered ${quote(title.rendered)}. Share previews and crawlers that do not render use the served one.`,
    );
  else if (title.change === "removed")
    add("title-removed", "warn", "Title removed by JavaScript", `The served title was ${quote(title.served)}.`);

  const desc = f("description");
  if (desc.change !== "same")
    add(
      `description-${desc.change}`,
      "warn",
      desc.change === "added" ? "Meta description only exists after JavaScript" : `Meta description ${desc.change} by JavaScript`,
      `Served ${quote(desc.served)}, rendered ${quote(desc.rendered)}.`,
    );

  if (d.social.added.length)
    add(
      "social-js",
      "bad",
      `${plural(d.social.added.length, "share tag")} only after JavaScript`,
      `${d.social.added
        .slice(0, 5)
        .map((s) => s.key)
        .join(
          ", ",
        )}${d.social.added.length > 5 ? "…" : ""}: Facebook, LinkedIn, X, Slack and WhatsApp read the served HTML only, so their previews miss them.`,
    );
  if (d.social.changed.length)
    add(
      "social-changed",
      "warn",
      `${plural(d.social.changed.length, "share tag")} changed by JavaScript`,
      `${d.social.changed
        .slice(0, 5)
        .map((s) => s.key)
        .join(", ")}: share previews use the served value.`,
    );

  const h1 = (s: SeoSnapshot) => s.headings.filter((h) => h.level === 1).map((h) => h.text);
  const servedH1 = h1(d.served);
  const renderedH1 = h1(d.rendered);
  if (!servedH1.length && renderedH1.length)
    add("h1-js", "warn", "The h1 only exists after JavaScript", `JavaScript adds ${quote(renderedH1[0]!)}.`);
  else if (servedH1.join("\n") !== renderedH1.join("\n") && servedH1.length && renderedH1.length)
    add("h1-changed", "info", "The h1 changed by JavaScript", `Served ${quote(servedH1[0]!)}, rendered ${quote(renderedH1[0]!)}.`);

  const internalAdded = d.links.added.filter((l) => l.internal).length;
  if (d.links.added.length)
    add(
      "links-js",
      internalAdded ? "warn" : "info",
      `${plural(d.links.added.length, "link")} only after JavaScript`,
      `${internalAdded} internal, ${d.links.added.length - internalAdded} external. Crawlers that do not render cannot follow them to discover pages.`,
    );
  if (d.links.removed.length)
    add(
      "links-removed",
      "info",
      `${plural(d.links.removed.length, "link")} removed by JavaScript`,
      "In the served HTML, gone after JavaScript.",
    );
  if (d.links.relChanged.length)
    add(
      "links-rel",
      "info",
      `rel changed by JavaScript on ${plural(d.links.relChanged.length, "link")}`,
      "nofollow, sponsored or ugc set by JavaScript is missed by crawlers that do not render.",
    );

  if (d.jsonLd.added.length)
    add(
      "jsonld-js",
      "warn",
      `${plural(d.jsonLd.added.length, "JSON-LD block")} injected by JavaScript`,
      `${typesList(d.jsonLd.added)}. Google reads structured data added by JavaScript, but other crawlers and some tools only see the served HTML.`,
    );
  if (d.jsonLd.removed.length)
    add("jsonld-removed", "warn", `${plural(d.jsonLd.removed.length, "JSON-LD block")} removed by JavaScript`, typesList(d.jsonLd.removed));
  if (d.jsonLd.changed.length)
    add(
      "jsonld-changed",
      "info",
      `${plural(d.jsonLd.changed.length, "JSON-LD block")} changed by JavaScript`,
      typesList(d.jsonLd.changed.map((c) => c.rendered)),
    );

  if (d.hreflang.added.length)
    add(
      "hreflang-js",
      "warn",
      `${plural(d.hreflang.added.length, "hreflang alternate")} only after JavaScript`,
      "Put hreflang in the HTML (or the sitemap): it is read more reliably there.",
    );
  if (d.hreflang.removed.length)
    add(
      "hreflang-removed",
      "warn",
      `${plural(d.hreflang.removed.length, "hreflang alternate")} removed by JavaScript`,
      d.hreflang.removed.map((h) => h.lang).join(", "),
    );

  if (f("robots").change !== "same" && d.served.index === d.rendered.index)
    add(
      "robots-changed",
      "info",
      "Meta robots changed by JavaScript",
      `Served ${quote(f("robots").served)}, rendered ${quote(f("robots").rendered)}.`,
    );
  if (f("lang").change !== "same")
    add(
      "lang-changed",
      "info",
      "<html lang> changed by JavaScript",
      `Served ${quote(f("lang").served)}, rendered ${quote(f("lang").rendered)}.`,
    );
  if (d.headings.added.length + d.headings.removed.length && !out.some((x) => x.id === "h1-js"))
    add(
      "headings-js",
      "info",
      "Headings differ after JavaScript",
      `${d.headings.added.length} added, ${d.headings.removed.length} removed.`,
    );
  if (d.images.added.length)
    add(
      "images-js",
      "info",
      `${plural(d.images.added.length, "image")} only after JavaScript`,
      "Lazy loaders and carousels often do this; crawlers that do not render miss them.",
    );

  if (!out.length)
    add(
      "same",
      "good",
      "Same SEO signals before and after JavaScript",
      "Title, meta, canonical, structured data, headings and links match.",
    );
  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

function typesList(blocks: SnapJsonLd[]): string {
  const types = [...new Set(blocks.flatMap((b) => (b.ok ? b.types : ["invalid JSON"])))];
  return types.length ? types.join(", ") : "no @type";
}

/* Source view */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "xmp"]);

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One tag or text per line, indented by depth: both sides go through the same parser and printer, so the line
 * diff shows what differs in the DOM, not in the formatting. An element whose only child is short text stays on one line.
 */
export function prettyHtml(doc: Document): string {
  const lines: string[] = [];
  const pad = (depth: number) => "  ".repeat(depth);
  const open = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes)
      .map((a) => (a.value === "" ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`))
      .join("");
    return `<${tag}${attrs}>`;
  };
  const walk = (node: Node, depth: number) => {
    if (node.nodeType === 3) {
      const text = clean(node.nodeValue);
      if (text) lines.push(pad(depth) + escapeText(text));
      return;
    }
    if (node.nodeType === 8) {
      lines.push(`${pad(depth)}<!--${clean(node.nodeValue)}-->`);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (VOID.has(tag)) {
      lines.push(pad(depth) + open(el));
      return;
    }
    const kids = tag === "template" ? Array.from((el as HTMLTemplateElement).content?.childNodes ?? []) : Array.from(el.childNodes);
    if (RAW.has(tag)) {
      const body = (el.textContent ?? "").replace(/^\s*\n|\s+$/g, "");
      if (!body.includes("\n") && body.length <= 100) lines.push(`${pad(depth)}${open(el)}${body}</${tag}>`);
      else {
        lines.push(pad(depth) + open(el));
        const indent = Math.min(
          ...body
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => /^\s*/.exec(l)![0].length),
        );
        for (const l of body.split("\n"))
          if (l.trim()) lines.push(pad(depth + 1) + l.slice(Number.isFinite(indent) ? indent : 0).trimEnd());
        lines.push(`${pad(depth)}</${tag}>`);
      }
      return;
    }
    const only = kids.filter((k) => k.nodeType !== 3 || clean(k.nodeValue));
    if (!only.length) {
      lines.push(`${pad(depth)}${open(el)}</${tag}>`);
      return;
    }
    if (only.length === 1 && only[0]!.nodeType === 3 && clean(only[0]!.nodeValue).length <= 100) {
      lines.push(`${pad(depth)}${open(el)}${escapeText(clean(only[0]!.nodeValue))}</${tag}>`);
      return;
    }
    lines.push(pad(depth) + open(el));
    for (const k of kids) walk(k, depth + 1);
    lines.push(`${pad(depth)}</${tag}>`);
  };
  if (doc.doctype) lines.push(`<!DOCTYPE ${doc.doctype.name}>`);
  for (const k of Array.from(doc.childNodes)) if (k.nodeType !== 10) walk(k, 0);
  return lines.join("\n");
}

export type SourceLine = DiffLine | { kind: "skip"; count: number };

export interface SourceDiff {
  /** Changed lines with `context` lines around them; long unchanged runs folded into "skip". */
  lines: SourceLine[];
  added: number;
  removed: number;
  /** Too many lines left to diff once the common start and end are set aside. */
  tooLarge: boolean;
}

/**
 * Line diff of two pretty-printed documents. The common first and last lines are set aside before the LCS
 * (which is quadratic), and the diff gives up past `maxCells` (lines × lines) rather than freeze the panel.
 */
export function sourceDiff(a: string, b: string, { context = 3, maxCells = 4_000_000 } = {}): SourceDiff {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const midX = x.slice(start, x.length - end);
  const midY = y.slice(start, y.length - end);
  if (midX.length * midY.length > maxCells) return { lines: [], added: 0, removed: 0, tooLarge: true };
  const mid: DiffLine[] =
    !midX.length && !midY.length
      ? []
      : !midX.length
        ? midY.map((text, i) => ({ kind: "add", text, b: start + i + 1 }))
        : !midY.length
          ? midX.map((text, i) => ({ kind: "del", text, a: start + i + 1 }))
          : diffLines(midX.join("\n"), midY.join("\n")).map((l) => ({
              ...l,
              a: l.a === undefined ? undefined : l.a + start,
              b: l.b === undefined ? undefined : l.b + start,
            }));
  const all: DiffLine[] = [
    ...x.slice(0, start).map((text, i): DiffLine => ({ kind: "same", text, a: i + 1, b: i + 1 })),
    ...mid,
    ...x.slice(x.length - end).map((text, i): DiffLine => ({ kind: "same", text, a: x.length - end + i + 1, b: y.length - end + i + 1 })),
  ];
  const keep = new Uint8Array(all.length);
  all.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = 1;
  });
  const lines: SourceLine[] = [];
  let skipped = 0;
  all.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) lines.push({ kind: "skip", count: skipped });
      skipped = 0;
      lines.push(l);
    } else skipped++;
  });
  if (skipped) lines.push({ kind: "skip", count: skipped });
  return {
    lines,
    added: mid.filter((l) => l.kind === "add").length,
    removed: mid.filter((l) => l.kind === "del").length,
    tooLarge: false,
  };
}
