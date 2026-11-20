// Pure logic of the JSON page viewer (src/entrypoints/json-viewer.content.ts): no browser APIs,
// so the content script and the tests share it.

/** Id of the runtime-registered content script that formats JSON pages (Options › JSON viewer). */
export const JSON_VIEWER_SCRIPT_ID = "devkit-json-viewer";
export const JSON_VIEWER_SCRIPT_IDS = [JSON_VIEWER_SCRIPT_ID];
/** Built file of the content script, for `registerContentScripts` and `executeScript`. */
export const JSON_VIEWER_FILE = "content-scripts/json-viewer.js";
/** Id of the element that hosts the viewer's shadow root: present once a page is formatted. */
export const JSON_VIEWER_HOST_ID = "devkit-json-viewer";
/** Above this many characters the document is shown raw, with a "Format anyway" button. */
export const MAX_FORMAT_CHARS = 10 * 1024 * 1024;
/** Levels open on first render (the root is level 0). */
export const OPEN_DEPTH = 3;
/** Children of a node built at a time; the rest come with a "Show more" button. */
export const CHUNK = 500;

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/** `application/json`, `text/json` and any `+json` type (`application/ld+json`, `application/problem+json`…). */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type === "text/json" || /^[a-z]+\/[\w.+-]+\+json$/.test(type);
}

/**
 * The `<pre>` holding the raw document when `body` is what Chrome renders for a JSON or text
 * response: a single `<pre>`, plus at most elements without text of their own (Chrome's
 * "Pretty-print" control lives in a shadow root, so it has none). Null for any other page.
 */
export function rawJsonPre(body: HTMLElement | null | undefined): HTMLPreElement | null {
  if (!body) return null;
  let pre: HTMLPreElement | null = null;
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 3 && node.textContent?.trim()) return null;
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    if (el.tagName === "PRE" && !pre) pre = el as HTMLPreElement;
    else if (el.tagName === "PRE" || el.textContent?.trim() || /^(SCRIPT|IFRAME|IMG|VIDEO|CANVAS|FORM)$/.test(el.tagName)) return null;
  }
  return pre;
}

export function kindOf(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

/** `{3}` for an object of three keys, `[100]` for an array of 100 items. */
export function countLabel(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isContainer(value)) return `{${Object.keys(value).length}}`;
  return "";
}

/** Keys or indexes of a container, in display order. */
export function entriesOf(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (isContainer(value)) return Object.entries(value);
  return [];
}

/** JSONPath of a child: `$.data`, `$.data[0]`, `$["content-type"]`. The root is `$`. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** The same path as a JavaScript accessor, without the root: `data[0].id` (`$` stays `$`). */
export function jsPath(path: string): string {
  if (path === "$") return "$";
  return path.startsWith("$.") ? path.slice(2) : path.slice(1);
}

/** Strings that are worth a link: absolute http(s) URLs without spaces. */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(value) || value.length > 2048) return false;
  try {
    return Boolean(new URL(value).host);
  } catch {
    return false;
  }
}

export interface FilterResult {
  /** Paths to show: the matches and their ancestors. */
  visible: Set<string>;
  /** Paths whose key or value matched; a matched container shows its whole subtree. */
  matched: Set<string>;
  count: number;
}

/**
 * Nodes to show for a filter query (case-insensitive, on keys, array indexes are not keys, and
 * primitive values as displayed: strings without quotes, numbers, `true`, `null`). Null when the
 * query is empty.
 */
export function filterJson(value: unknown, query: string): FilterResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const visible = new Set<string>();
  const matched = new Set<string>();
  const walk = (v: unknown, path: string, key: string | number | null, ancestors: string[]): void => {
    const keyHit = typeof key === "string" && key.toLowerCase().includes(q);
    const valueHit = !isContainer(v) && String(v).toLowerCase().includes(q);
    if (keyHit || valueHit) {
      matched.add(path);
      for (const a of ancestors) visible.add(a);
      visible.add(path);
    }
    if (!isContainer(v)) return;
    const next = [...ancestors, path];
    for (const [k, child] of entriesOf(v)) walk(child, childPath(path, k), k, next);
  };
  walk(value, "$", null, []);
  return { visible, matched, count: matched.size };
}

/** `posts-1.json` for /posts/1, `users.json` for /api/users, `data.json` for /data.json, the host for /. */
export function downloadName(url: string): string {
  let segments: string[] = [];
  let host = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    segments = u.pathname
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .filter(Boolean);
  } catch {
    // Not a URL: fall back to a fixed name.
  }
  let last = segments.at(-1) ?? "";
  if (last && /^\d+$/.test(last) && segments.length > 1) last = `${segments.at(-2)}-${last}`;
  const base = (last || host || "data")
    .replace(/\.json$/i, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return `${base || "data"}.json`;
}

export function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}

/** Palette message once the viewer script ran on a tab. */
export function jsonViewerMessage(state: string | null, contentType: string): string {
  if (state === "tree" || state === "raw") return "JSON formatted.";
  if (state === "invalid") return "Invalid JSON: shown as raw text with where it breaks.";
  if (state === "large") return "Large JSON document: shown as raw text, with a Format anyway button.";
  return `This tab is not a JSON document (${contentType || "unknown type"}).`;
}

/** Error banner text for a document that does not parse. */
export function invalidMessage(result: { error?: string; line?: number; column?: number }): string {
  return result.line ? `Invalid JSON at line ${result.line}, column ${result.column}` : `Invalid JSON: ${result.error ?? "parse error"}`;
}
