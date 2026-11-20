// Pure logic of the data page viewer (src/entrypoints/data-viewer.ts): which format a tab
// holds, from its content type, URL and text. JSON-specific helpers stay in ./json-viewer.
import { looksLikeJsonLines } from "./formats/jsonl";
import { looksLikeFeed, looksLikeXml } from "./formats/xml";
import { isJsonContentType, rawJsonPre } from "./json-viewer";

export type DataFormat = "json" | "xml" | "csv" | "tsv" | "yaml" | "jsonl";

export const FORMAT_LABELS: Record<DataFormat, string> = {
  json: "JSON",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  yaml: "YAML",
  jsonl: "JSON Lines",
};

const mimeOf = (contentType: string | null | undefined) => (contentType ?? "").split(";")[0]!.trim().toLowerCase();

/** XML types that Chrome renders as pages of their own (XHTML, SVG, MathML) are not data. */
const XML_PAGES = new Set(["application/xhtml+xml", "image/svg+xml", "application/mathml+xml"]);

/** The data format a content type names, or null (`text/plain` included: that one needs the URL or the text). */
export function formatFromContentType(contentType: string | null | undefined): DataFormat | null {
  const type = mimeOf(contentType);
  if (isJsonContentType(type)) return "json";
  if (/^(application\/(x-)?ndjson|application\/(x-)?jsonl(ines)?|application\/json-seq)$/.test(type)) return "jsonl";
  if (type === "application/xml" || type === "text/xml" || (/^[a-z]+\/[\w.+-]+\+xml$/.test(type) && !XML_PAGES.has(type))) return "xml";
  if (/^(text|application)\/(x-)?csv$|^text\/comma-separated-values$/.test(type)) return "csv";
  if (type === "text/tab-separated-values" || type === "text/tsv") return "tsv";
  if (/^(application|text)\/(x-)?yaml$/.test(type)) return "yaml";
  return null;
}

/** The data format of a URL's file extension (`.json`, `.xml`, `.rss`, `.atom`, `.csv`, `.tsv`, `.yml`, `.yaml`, `.jsonl`, `.ndjson`). */
export function formatFromUrl(url: string | null | undefined): DataFormat | null {
  let path = "";
  try {
    path = new URL(url ?? "").pathname.toLowerCase();
  } catch {
    return null;
  }
  const ext = /\.([a-z]+)$/.exec(path)?.[1];
  switch (ext) {
    case "json":
    case "geojson":
      return "json";
    case "xml":
    case "rss":
    case "atom":
      return "xml";
    case "csv":
      return "csv";
    case "tsv":
    case "tab":
      return "tsv";
    case "yml":
    case "yaml":
      return "yaml";
    case "jsonl":
    case "ndjson":
      return "jsonl";
    default:
      return null;
  }
}

export interface Detection {
  format: DataFormat;
  /**
   * Named by the content type: the viewer opens even when the text does not parse, to show where it
   * breaks. Otherwise (text/plain) it opens only when the text parses as the format.
   */
  declared: boolean;
}

/**
 * The format to show a tab in, or null to leave it alone:
 * - a data content type (JSON, XML, CSV, TSV, YAML, JSON Lines) always;
 * - `text/plain` (and the other text types Chrome shows as plain text) when the URL's extension
 *   names a format, or when it is an RSS / Atom feed (Chrome shows those as `text/plain`);
 * - on an explicit request (`force`), also text/plain that sniffs as JSON, JSON Lines or XML.
 */
export function detectFormat(input: {
  contentType?: string | null;
  url?: string | null;
  text?: string;
  force?: boolean;
}): Detection | null {
  const declared = formatFromContentType(input.contentType);
  if (declared) return { format: declared, declared: true };
  if (!/^text\//.test(mimeOf(input.contentType)) || /^text\/html$/.test(mimeOf(input.contentType))) return null;
  const byUrl = formatFromUrl(input.url);
  if (byUrl) return { format: byUrl, declared: false };
  const text = input.text ?? "";
  if (looksLikeFeed(text)) return { format: "xml", declared: false };
  if (!input.force) return null;
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return { format: looksLikeJsonLines(text) ? "jsonl" : "json", declared: false };
  if (looksLikeXml(text)) return { format: "xml", declared: false };
  return null;
}

/** Palette message once the viewer script ran on a tab (`format` is the host's `data-format`). */
export function dataViewerMessage(state: string | null, format: string | null | undefined, contentType: string): string {
  const label = FORMAT_LABELS[format as DataFormat] ?? "JSON";
  if (state === "tree" || state === "raw")
    return format === "csv" || format === "tsv" ? `${label} shown as a table.` : `${label} formatted.`;
  if (state === "invalid") return `Invalid ${label}: shown as raw text with where it breaks.`;
  if (state === "unsupported") return `${label} shown as raw text: it uses syntax devkit's reader does not support.`;
  if (state === "large") return `Large ${label} document: shown as raw text, with a Format anyway button.`;
  return `This tab is not a data document (${contentType || "unknown type"}): JSON, XML, CSV, YAML or JSON Lines.`;
}

/* The always-on gate */

/** Built file of the viewer itself, injected by the background (gate) and by the palette action. */
export const DATA_VIEWER_FILE = "data-viewer.js";
/** What the gate sends the background when the tab holds a data document. */
export const DATA_VIEWER_MESSAGE = "devkit:data-viewer";
/** Chrome's XML tree viewer moves the original XML document into this element. */
export const CHROME_XML_SOURCE_ID = "webkit-xml-viewer-source-xml";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * The cheap check of the content script that runs on every page once the viewer is turned on:
 * an XML document, or a single `<pre>` (how Chrome shows JSON and text) whose content type, URL or
 * first characters name a data format. Only then is the viewer itself injected.
 */
export function looksLikeDataPage(doc: Document, url: string, contentType = doc.contentType ?? ""): boolean {
  if (doc.getElementById(CHROME_XML_SOURCE_ID)) return true;
  const root = doc.documentElement;
  if (root && root.namespaceURI !== XHTML_NS) return formatFromContentType(contentType) === "xml";
  const pre = rawJsonPre(doc.body);
  return pre !== null && detectFormat({ contentType, url, text: (pre.textContent ?? "").slice(0, 4096) }) !== null;
}
