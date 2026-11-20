// XML / RSS / Atom for the data page viewer: a plain tree model built from a DOM (DOMParser in the
// page), parse errors with their position, XPath-like paths, a filter, an indented serializer and a
// feed summary. Pure apart from `parseXml`, which takes the parser to use.

export type XmlNode = XmlElement | XmlText | XmlCdata | XmlComment | XmlPi;

export interface XmlElement {
  type: "element";
  name: string;
  attrs: [string, string][];
  children: XmlNode[];
}
export interface XmlText {
  type: "text";
  text: string;
}
export interface XmlCdata {
  type: "cdata";
  text: string;
}
export interface XmlComment {
  type: "comment";
  text: string;
}
export interface XmlPi {
  type: "pi";
  target: string;
  text: string;
}

export interface XmlDoc {
  /** Top-level nodes: processing instructions and comments around the root element. */
  nodes: XmlNode[];
  root: XmlElement;
  /** The `<?xml …?>` declaration of the source, when it had one (DOM parsers drop it). */
  declaration?: string;
}

/** The parts of a DOM node the model reads: real DOM nodes fit, and so do plain objects in tests. */
export interface DomLike {
  nodeType: number;
  nodeName: string;
  nodeValue?: string | null;
  /** Processing instructions: their target (the same as `nodeName` in browsers). */
  target?: string;
  attributes?: ArrayLike<{ name: string; value: string }> | null;
  childNodes: ArrayLike<DomLike>;
}

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const PI = 7;
const COMMENT = 8;

/** Model of DOM nodes; whitespace-only text between elements is dropped. Null for doctypes and the like. */
export function xmlNodeFromDom(node: DomLike): XmlNode | null {
  switch (node.nodeType) {
    case ELEMENT: {
      const attrs = Array.from(node.attributes ?? [], (a) => [a.name, a.value] as [string, string]);
      const children: XmlNode[] = [];
      for (const child of Array.from(node.childNodes)) {
        const c = xmlNodeFromDom(child);
        if (c && !(c.type === "text" && !c.text.trim())) children.push(c);
      }
      return { type: "element", name: node.nodeName, attrs, children };
    }
    case TEXT:
      return { type: "text", text: node.nodeValue ?? "" };
    case CDATA:
      return { type: "cdata", text: node.nodeValue ?? "" };
    case COMMENT:
      return { type: "comment", text: node.nodeValue ?? "" };
    case PI:
      return { type: "pi", target: node.target || node.nodeName, text: node.nodeValue ?? "" };
    default:
      return null;
  }
}

/** Model of a parsed document's top-level nodes. Null when there is no root element. */
export function xmlDocFromDom(nodes: ArrayLike<DomLike>, declaration?: string): XmlDoc | null {
  const out: XmlNode[] = [];
  let root: XmlElement | null = null;
  for (const n of Array.from(nodes)) {
    const m = xmlNodeFromDom(n);
    if (!m || (m.type === "text" && !m.text.trim())) continue;
    if (m.type === "element" && !root) root = m;
    out.push(m);
  }
  return root ? { nodes: out, root, ...(declaration ? { declaration } : {}) } : null;
}

/** `<?xml version="1.0" encoding="UTF-8"?>` at the start of `text`, if any. */
export function xmlDeclaration(text: string): string | undefined {
  return /^\uFEFF?\s*(<\?xml\s[^?]*\?>)/.exec(text)?.[1];
}

/** Whether the document asks for a stylesheet (`<?xml-stylesheet …?>`): such pages are left as the site styled them. */
export function hasXmlStylesheet(nodes: ArrayLike<DomLike>): boolean {
  return Array.from(nodes).some((n) => n.nodeType === PI && (n.target || n.nodeName) === "xml-stylesheet");
}

/** Line and column of a parser error message: Chrome (`error on line 2 at column 8`) and Firefox (`Line Number 2, Column 8`). */
export function xmlErrorPosition(message: string): { line: number; column: number } | null {
  const m = /line (\d+) at column (\d+)/i.exec(message) ?? /Line Number (\d+), Column (\d+)/i.exec(message);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
}

const PARSERERROR_NS = ["http://www.w3.org/1999/xhtml", "http://www.mozilla.org/newlayout/xml/parsererror.xml"];

/** The `<parsererror>` a browser's XML parser puts in a document that does not parse, if any. */
export function findParserError(doc: Document): Element | null {
  for (const el of Array.from(doc.getElementsByTagName("parsererror"))) {
    if (PARSERERROR_NS.includes(el.namespaceURI ?? "") || el === doc.documentElement) return el;
  }
  return null;
}

/** The error line of a `<parsererror>`, without Chrome's "This page contains the following errors" framing. */
export function parserErrorMessage(el: Element): string {
  const text = (el.textContent ?? "").replace(/This page contains the following errors:/i, "");
  const line = /(error on line[^\n]*|XML Parsing Error:[^\n]*(?:\n[^\n]*Line Number[^\n]*)?)/i.exec(text)?.[1];
  return (line ?? text.replace(/Below is a rendering of the page up to the first error\.?/i, "")).replace(/\s+/g, " ").trim();
}

export interface XmlParseResult {
  ok: boolean;
  doc?: XmlDoc;
  error?: string;
  line?: number;
  column?: number;
}

/** Parses `text` with the browser's XML parser. */
export function parseXml(text: string, parser: { parseFromString(s: string, type: "application/xml"): Document }): XmlParseResult {
  let dom: Document;
  try {
    dom = parser.parseFromString(text, "application/xml");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const err = findParserError(dom);
  if (err) {
    const error = parserErrorMessage(err) || "XML parse error";
    return { ok: false, error, ...(xmlErrorPosition(error) ?? {}) };
  }
  const doc = xmlDocFromDom(dom.childNodes as unknown as ArrayLike<DomLike>, xmlDeclaration(text));
  return doc ? { ok: true, doc } : { ok: false, error: "No root element" };
}

/** `Invalid XML at line 2, column 8: Opening and ending tag mismatch…` */
export function invalidXmlMessage(result: { error?: string; line?: number; column?: number }): string {
  const detail = (result.error ?? "parse error").replace(/^error on line \d+ at column \d+:\s*/i, "");
  return result.line ? `Invalid XML at line ${result.line}, column ${result.column}: ${detail}` : `Invalid XML: ${detail}`;
}

/* Paths */

/** XPath of an element's child element: `/rss/channel/item[2]` (the position only when the name repeats). */
export function elementPaths(parent: string, children: XmlNode[]): string[] {
  const total = new Map<string, number>();
  for (const c of children) if (c.type === "element") total.set(c.name, (total.get(c.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const kinds = new Map<string, number>();
  return children.map((c) => {
    if (c.type === "element") {
      const k = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, k);
      return `${parent}/${c.name}${(total.get(c.name) ?? 0) > 1 ? `[${k}]` : ""}`;
    }
    const test = c.type === "comment" ? "comment()" : c.type === "pi" ? "processing-instruction()" : "text()";
    const k = (kinds.get(test) ?? 0) + 1;
    kinds.set(test, k);
    return `${parent}/${test}[${k}]`;
  });
}

/** Paths of the document's top-level nodes: the root element is `/name`. */
export function topPaths(doc: XmlDoc): string[] {
  return elementPaths("", doc.nodes);
}

/** Children shown inline on the element's line: a lone short text or CDATA child. */
export function inlineText(el: XmlElement): XmlText | XmlCdata | null {
  if (el.children.length !== 1) return null;
  const only = el.children[0]!;
  return (only.type === "text" || only.type === "cdata") && !only.text.trim().includes("\n") && only.text.length <= 200 ? only : null;
}

/* Filter */

export interface XmlFilter {
  visible: Set<string>;
  matched: Set<string>;
  count: number;
}

/** Nodes to show for a query (case-insensitive) on tag and attribute names, attribute values, text, CDATA and comments. */
export function filterXml(doc: XmlDoc, query: string): XmlFilter | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const visible = new Set<string>();
  const matched = new Set<string>();
  const hit = (s: string) => s.toLowerCase().includes(q);
  const walk = (node: XmlNode, path: string, ancestors: string[]) => {
    const own =
      node.type === "element"
        ? hit(node.name) || node.attrs.some(([k, v]) => hit(k) || hit(v))
        : node.type === "pi"
          ? hit(node.target) || hit(node.text)
          : hit(node.text);
    if (own) {
      matched.add(path);
      visible.add(path);
      for (const a of ancestors) visible.add(a);
    }
    if (node.type !== "element") return;
    const paths = elementPaths(path, node.children);
    const next = [...ancestors, path];
    for (let i = 0; i < node.children.length; i++) walk(node.children[i]!, paths[i]!, next);
  };
  const paths = topPaths(doc);
  for (let i = 0; i < doc.nodes.length; i++) walk(doc.nodes[i]!, paths[i]!, []);
  return { visible, matched, count: matched.size };
}

/* Serialization */

export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

export function openTag(el: XmlElement, selfClosing = false): string {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join("");
  return `<${el.name}${attrs}${selfClosing ? "/>" : ">"}`;
}

function nodeText(node: XmlText | XmlCdata | XmlComment | XmlPi): string {
  if (node.type === "text") return escapeXmlText(node.text.trim());
  if (node.type === "cdata") return `<![CDATA[${node.text}]]>`;
  if (node.type === "comment") return `<!--${node.text}-->`;
  return `<?${node.target}${node.text ? ` ${node.text}` : ""}?>`;
}

/** The document indented by `indent`: text trimmed, a lone short text kept on its element's line. */
export function serializeXml(doc: XmlDoc, indent = "  "): string {
  const out: string[] = [];
  if (doc.declaration) out.push(doc.declaration);
  const write = (node: XmlNode, depth: number) => {
    const pad = indent.repeat(depth);
    if (node.type !== "element") {
      out.push(pad + nodeText(node));
      return;
    }
    if (!node.children.length) {
      out.push(pad + openTag(node, true));
      return;
    }
    const inline = inlineText(node);
    if (inline) {
      out.push(`${pad}${openTag(node)}${nodeText(inline)}</${node.name}>`);
      return;
    }
    out.push(pad + openTag(node));
    for (const c of node.children) write(c, depth + 1);
    out.push(`${pad}</${node.name}>`);
  };
  for (const n of doc.nodes) write(n, 0);
  return out.join("\n");
}

/* Feeds */

export interface FeedItem {
  title: string;
  link: string;
  date: string;
}
export interface FeedSummary {
  kind: "RSS" | "Atom" | "RSS 1.0";
  title: string;
  link: string;
  description: string;
  items: FeedItem[];
}

export function localName(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

const childrenNamed = (el: XmlElement | undefined, name: string): XmlElement[] =>
  (el?.children ?? []).filter((c): c is XmlElement => c.type === "element" && localName(c.name) === name);
const child = (el: XmlElement | undefined, ...names: string[]): XmlElement | undefined => {
  for (const n of names) {
    const found = childrenNamed(el, n)[0];
    if (found) return found;
  }
  return undefined;
};

/** All text and CDATA inside an element, whitespace collapsed. */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return "";
  const parts: string[] = [];
  const walk = (n: XmlNode) => {
    if (n.type === "text" || n.type === "cdata") parts.push(n.text);
    else if (n.type === "element") n.children.forEach(walk);
  };
  walk(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const attr = (el: XmlElement | undefined, name: string): string => el?.attrs.find(([k]) => k === name)?.[1] ?? "";

/** An Atom `<link>`: the `alternate` one (or one without `rel`), else the first. */
function atomLink(el: XmlElement | undefined): string {
  const links = childrenNamed(el, "link");
  const alt = links.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate") ?? links[0];
  return attr(alt, "href") || textOf(alt);
}

/** Title, link and items of an RSS 2.0, RSS 1.0 (RDF) or Atom feed; null for other documents. */
export function feedSummary(doc: XmlDoc): FeedSummary | null {
  const root = doc.root;
  const name = localName(root.name);
  if (name === "rss") {
    const channel = child(root, "channel");
    if (!channel) return null;
    return {
      kind: "RSS",
      title: textOf(child(channel, "title")),
      link: textOf(child(channel, "link")),
      description: textOf(child(channel, "description")),
      items: childrenNamed(channel, "item").map((item) => ({
        title: textOf(child(item, "title")),
        link: textOf(child(item, "link")) || textOf(child(item, "guid")),
        date: textOf(child(item, "pubDate", "date")),
      })),
    };
  }
  if (name === "feed") {
    return {
      kind: "Atom",
      title: textOf(child(root, "title")),
      link: atomLink(root),
      description: textOf(child(root, "subtitle")),
      items: childrenNamed(root, "entry").map((entry) => ({
        title: textOf(child(entry, "title")),
        link: atomLink(entry),
        date: textOf(child(entry, "updated", "published")),
      })),
    };
  }
  if (name === "RDF") {
    const channel = child(root, "channel");
    return {
      kind: "RSS 1.0",
      title: textOf(child(channel, "title")),
      link: textOf(child(channel, "link")),
      description: textOf(child(channel, "description")),
      items: childrenNamed(root, "item").map((item) => ({
        title: textOf(child(item, "title")),
        link: textOf(child(item, "link")) || attr(item, "rdf:about"),
        date: textOf(child(item, "date", "pubDate")),
      })),
    };
  }
  return null;
}

/** Counts elements, for the toolbar. */
export function countElements(node: XmlNode): number {
  return node.type === "element" ? 1 + node.children.reduce((n, c) => n + countElements(c), 0) : 0;
}

/** Whether text looks like the start of an XML document (sniffing `text/plain`). */
export function looksLikeXml(text: string): boolean {
  return /^\uFEFF?\s*<(\?xml\s|!--|!DOCTYPE\s|[A-Za-z_][\w.:-]*[\s/>])/.test(text);
}

/** Root names of feeds: Chrome shows `application/rss+xml` and `application/atom+xml` as `text/plain`. */
export function looksLikeFeed(text: string): boolean {
  const head = text.slice(0, 4096);
  return looksLikeXml(head) && /<(rss[\s>]|feed[\s>][\s\S]*?http:\/\/www\.w3\.org\/2005\/Atom|rdf:RDF[\s>])/.test(head);
}
