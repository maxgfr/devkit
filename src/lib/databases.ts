// IndexedDB and Cache Storage viewer: the tagged JSON form of structured-clone values, and the pure helpers the
// panels use around it (previews, validation, key ranges, paging, exports). The page side lives in page/databases.ts.

/**
 * A structured-clone value as JSON. Plain JSON passes through; everything JSON cannot hold is an object whose
 * `$type` names it: `{ "$type": "Date", "value": "2024-01-01T00:00:00.000Z" }`. A plain object that has its own
 * `$type` key is wrapped as `{ "$type": "Object", "value": {…} }` so it is never mistaken for a tag.
 */
export type Tagged = null | boolean | number | string | Tagged[] | { [key: string]: Tagged };

export const TAG = "$type";

/** Version of the in-page codec (`__devkitIdbCodec`) the panel expects: a stale copy in the page is replaced. */
export const IDB_CODEC_VERSION = 1;

/** How much of a value the page encodes. Past a limit the value becomes a `Truncated` tag, which cannot be written back. */
export interface CodecLimits {
  /** Nesting levels. */
  depth: number;
  /** Characters per string. */
  string: number;
  /** Bytes per ArrayBuffer, typed array or Blob (base64-encoded). */
  binary: number;
  /** Values in total. */
  nodes: number;
}

/** For the records table: enough for a preview, small enough to list a page of records. */
export const PREVIEW_LIMITS: CodecLimits = { depth: 8, string: 400, binary: 256, nodes: 400 };
/** For one record opened in the editor, and for exports. */
export const FULL_LIMITS: CodecLimits = { depth: 40, string: 2_000_000, binary: 4_194_304, nodes: 100_000 };

export const TYPED_ARRAYS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
] as const;

const BINARY = new Set<string>(["ArrayBuffer", ...TYPED_ARRAYS]);

type Obj = { [key: string]: Tagged };
const isObj = (v: Tagged | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const tagOf = (v: Tagged | undefined): string | null => (isObj(v) && typeof v[TAG] === "string" ? (v[TAG] as string) : null);

function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** A one-line preview of a tagged value, for table cells. */
export function previewTagged(value: Tagged, max = 140): string {
  let out = "";
  let cut = false;
  const push = (s: string) => {
    out += s;
    cut = out.length >= max;
    return !cut;
  };
  const walk = (v: Tagged, depth: number, plain = false): boolean => {
    if (v === null || typeof v !== "object") return push(typeof v === "string" ? JSON.stringify(v) : String(v));
    if (Array.isArray(v)) {
      if (depth > 2) return push(`[…${v.length}]`);
      if (!push("[")) return false;
      for (let i = 0; i < v.length; i++) {
        if (i && !push(", ")) return false;
        if (!walk(v[i]!, depth + 1)) return false;
      }
      return push("]");
    }
    const tag = plain ? null : tagOf(v);
    // An object that had its own $type key: shown as the object it is.
    if (tag === "Object" && isObj(v.value)) return walk(v.value, depth, true);
    if (tag) return push(tagPreview(v, tag));
    const keys = Object.keys(v);
    if (depth > 2) return push(`{…${keys.length}}`);
    if (!push("{")) return false;
    for (let i = 0; i < keys.length; i++) {
      if (i && !push(", ")) return false;
      if (!push(`${/^[A-Za-z_$][\w$]*$/.test(keys[i]!) ? keys[i] : JSON.stringify(keys[i])}: `)) return false;
      if (!walk(v[keys[i]!]!, depth + 1)) return false;
    }
    return push("}");
  };
  walk(value, 0);
  return cut && out.length >= max ? `${out.slice(0, max - 1)}…` : out;
}

function tagPreview(v: Obj, tag: string): string {
  const size = typeof v.byteLength === "number" ? bytesText(v.byteLength) : typeof v.size === "number" ? bytesText(v.size) : "";
  switch (tag) {
    case "undefined":
      return "undefined";
    case "Number":
      return String(v.value);
    case "BigInt":
      return `${v.value}n`;
    case "Date":
      return `Date(${v.value ?? "Invalid Date"})`;
    case "RegExp":
      return `/${v.source}/${v.flags ?? ""}`;
    case "Map":
      return `Map(${Array.isArray(v.entries) ? v.entries.length : "?"})`;
    case "Set":
      return `Set(${Array.isArray(v.values) ? v.values.length : "?"})`;
    case "Blob":
      return `Blob(${[v.mime || "no type", size].filter(Boolean).join(", ")})`;
    case "File":
      return `File(${[v.name, v.mime, size].filter(Boolean).join(", ")})`;
    case "Error":
      return `${v.name ?? "Error"}: ${v.message ?? ""}`;
    case "Truncated":
      return v.reason === "string" && typeof v.preview === "string" ? `${JSON.stringify(v.preview).slice(0, -1)}…"` : `…(${v.reason})`;
    case "Unsupported":
      return `<${v.kind ?? "unsupported"}>`;
    default:
      return BINARY.has(tag) ? `${tag}(${size})` : `<${tag}>`;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The first problem that keeps `value` from being written back, with its path, or null when it can be: an unknown
 * or malformed tag, a value the page could only show in part (Truncated, Unsupported, binary or Blob content cut).
 */
export function checkTagged(value: Tagged, path = "$"): string | null {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return `${path}: use {"$type":"Number","value":"${value}"}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = checkTagged(value[i]!, `${path}[${i}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (!(TAG in value)) {
    for (const [k, v] of Object.entries(value)) {
      const issue = checkTagged(v, `${path}.${k}`);
      if (issue) return issue;
    }
    return null;
  }
  const tag = value[TAG];
  const str = (k: string) => typeof value[k] === "string";
  const bad = (what: string) => `${path}: ${what}`;
  if (typeof tag !== "string") return bad(`"${TAG}" must be a string (wrap the object as {"$type":"Object","value":{…}})`);
  switch (tag) {
    case "undefined":
      return null;
    case "Number":
      return ["NaN", "Infinity", "-Infinity", "-0"].includes(value.value as string)
        ? null
        : bad('Number value must be "NaN", "Infinity", "-Infinity" or "-0"');
    case "BigInt":
      return str("value") && /^-?\d+$/.test(value.value as string) ? null : bad("BigInt value must be a string of digits");
    case "Date":
      return value.value === null || (str("value") && !Number.isNaN(Date.parse(value.value as string)))
        ? null
        : bad("Date value must be an ISO date string");
    case "RegExp":
      if (!str("source")) return bad("RegExp needs a source string");
      try {
        new RegExp(value.source as string, typeof value.flags === "string" ? value.flags : "");
        return null;
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid RegExp");
      }
    case "Map": {
      if (!Array.isArray(value.entries)) return bad("Map needs an entries array of [key, value] pairs");
      for (let i = 0; i < value.entries.length; i++) {
        const pair = value.entries[i];
        if (!Array.isArray(pair) || pair.length !== 2) return bad(`Map entry ${i} must be a [key, value] pair`);
        const issue = checkTagged(pair[0]!, `${path}.entries[${i}][0]`) ?? checkTagged(pair[1]!, `${path}.entries[${i}][1]`);
        if (issue) return issue;
      }
      return null;
    }
    case "Set":
      return Array.isArray(value.values) ? checkTagged(value.values, `${path}.values`) : bad("Set needs a values array");
    case "Object":
      return isObj(value.value) ? checkTagged(value.value, `${path}.value`) : bad("Object needs a value object");
    case "Error":
      return str("message") ? null : bad("Error needs a message string");
    case "Blob":
    case "File":
      if (tag === "File" && !str("name")) return bad("File needs a name");
      if (value.truncated === true || !str("base64")) return bad(`${tag} content was too large to load: it cannot be written back`);
      return BASE64.test(value.base64 as string) ? null : bad("base64 is not valid");
    case "Truncated":
      return bad(`cut by devkit (${value.reason ?? "size"}): open the record on its own or edit it in the page`);
    case "Unsupported":
      return bad(`${value.kind ?? "this value"} cannot be shown or written back here`);
    default:
      if (!BINARY.has(tag)) return bad(`unknown ${TAG} "${tag}"`);
      if (value.truncated === true) return bad(`${tag} was too large to load: it cannot be written back`);
      return str("base64") && BASE64.test(value.base64 as string) ? null : bad(`${tag} needs base64 content`);
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The editor's text as a tagged value ready to write, or why it is not. */
export function parseRecordText(text: string): Parsed<Tagged> {
  let value: Tagged;
  try {
    value = JSON.parse(text) as Tagged;
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const issue = checkTagged(value);
  return issue ? { ok: false, error: issue } : { ok: true, value };
}

/** Whether a tagged value is a valid IndexedDB key: number, string, Date, binary, or an array of those. */
export function isValidKey(key: Tagged): boolean {
  if (typeof key === "number") return Number.isFinite(key);
  if (typeof key === "string") return true;
  if (Array.isArray(key)) return key.every(isValidKey);
  const tag = tagOf(key);
  if (tag === "Date") return typeof (key as Obj).value === "string" && checkTagged(key) === null;
  if (tag === "Number") return false;
  return tag !== null && BINARY.has(tag) && checkTagged(key) === null;
}

/** A key typed by the user: JSON when it parses (`42`, `"42"`, `["a", 1]`, a Date tag), else the text as a string. */
export function parseKeyText(text: string): Parsed<Tagged> {
  if (!text.trim()) return { ok: false, error: "Enter a key." };
  let key: Tagged = text;
  try {
    key = JSON.parse(text) as Tagged;
  } catch {
    // Not JSON: the text itself is the key.
  }
  return isValidKey(key)
    ? { ok: true, value: key }
    : { ok: false, error: "Not a valid IndexedDB key: use a number, a string, an array, a Date or binary tag." };
}

export type KeyPath = string | string[] | null;

export function keyPathText(keyPath: KeyPath): string {
  if (keyPath === null) return "out-of-line keys";
  if (Array.isArray(keyPath)) return `[${keyPath.join(", ")}]`;
  return keyPath || "(empty key path)";
}

/**
 * Why `value` cannot go into a store whose key comes from `keyPath`, or null. A missing key is fine with
 * autoIncrement (IndexedDB generates it); otherwise each key path must lead to a valid key.
 */
export function inlineKeyProblem(value: Tagged, keyPath: KeyPath, autoIncrement: boolean): string | null {
  if (keyPath === null) return null;
  const paths = Array.isArray(keyPath) ? keyPath : [keyPath];
  for (const path of paths) {
    let at: Tagged | undefined = value;
    for (const part of path ? path.split(".") : []) {
      at = isObj(at) && !tagOf(at) ? at[part] : undefined;
    }
    if (at === undefined || tagOf(at) === "undefined") {
      if (autoIncrement && !Array.isArray(keyPath)) {
        return isObj(value) && !tagOf(value) ? null : "With autoIncrement and a key path, the value must be an object.";
      }
      return `The value has no "${path}", the store's key path.`;
    }
    if (!isValidKey(at)) return `"${path}" is not a valid key (number, string, Date, binary or array).`;
  }
  return null;
}

/** How to filter records, on the primary key or an index. */
export type RangeSpec = { kind: "all" } | { kind: "equals"; key: Tagged } | { kind: "prefix"; lower: string; upper: string | null };

/** The smallest string greater than every string starting with `prefix`, or null when there is none. */
export function prefixUpperBound(prefix: string): string | null {
  let p = prefix;
  while (p && p.charCodeAt(p.length - 1) === 0xffff) p = p.slice(0, -1);
  if (!p) return null;
  return p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
}

export function buildRange(mode: "all" | "equals" | "prefix", text: string): Parsed<RangeSpec> {
  if (mode === "all" || (mode === "prefix" && !text)) return { ok: true, value: { kind: "all" } };
  if (mode === "prefix") return { ok: true, value: { kind: "prefix", lower: text, upper: prefixUpperBound(text) } };
  const key = parseKeyText(text);
  return key.ok ? { ok: true, value: { kind: "equals", key: key.value } } : key;
}

/** "26–50 of 120", for the pager. */
export function pageLabel(offset: number, shown: number, total: number): string {
  if (!total) return "No records";
  if (!shown) return `None past ${offset.toLocaleString("en")} of ${total.toLocaleString("en")}`;
  return `${(offset + 1).toLocaleString("en")}–${(offset + shown).toLocaleString("en")} of ${total.toLocaleString("en")}`;
}

export function pageOffsets(offset: number, limit: number, total: number): { prev: number | null; next: number | null } {
  return {
    prev: offset > 0 ? Math.max(0, offset - limit) : null,
    next: offset + limit < total ? offset + limit : null,
  };
}

/* Results of the page functions */

export interface IdbIndexInfo {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface IdbStoreInfo {
  name: string;
  keyPath: KeyPath;
  autoIncrement: boolean;
  count: number | null;
  indexes: IdbIndexInfo[];
}

export interface IdbDatabaseInfo {
  name: string;
  version: number | null;
  stores: IdbStoreInfo[];
  error?: string;
}

export interface IdbListResult {
  /** False when the browser cannot list databases (no indexedDB.databases()). */
  supported: boolean;
  origin: string;
  databases: IdbDatabaseInfo[];
}

export interface IdbRecord {
  /** The index key when reading through an index, else the primary key. */
  key: Tagged;
  primaryKey: Tagged;
  value: Tagged;
}

export interface IdbReadResult {
  total: number;
  offset: number;
  records: IdbRecord[];
}

export type IdbRequest =
  | { op: "list" }
  | {
      op: "read";
      db: string;
      store: string;
      index: string | null;
      range: RangeSpec;
      offset: number;
      limit: number;
      limits: CodecLimits;
    }
  | { op: "get"; db: string; store: string; key: Tagged; limits: CodecLimits }
  | { op: "put" | "add"; db: string; store: string; key: Tagged | null; value: Tagged }
  | { op: "delete"; db: string; store: string; key: Tagged }
  | { op: "clear"; db: string; store: string };

export interface CacheSummary {
  name: string;
  count: number;
}

export interface CacheEntrySummary {
  method: string;
  url: string;
  /** 0 for opaque (cross-origin no-cors) responses, whose status and body are hidden. */
  status: number;
  type: string;
  contentType: string;
  /** Content-Length, else the measured body; null when unknown. */
  size: number | null;
}

export type CacheBody =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string }
  | { kind: "none"; reason: string };

export interface CacheEntryDetail extends CacheEntrySummary {
  statusText: string;
  headers: [string, string][];
  body: CacheBody;
}

export type CacheRequest =
  | { op: "list" }
  | { op: "entries"; cache: string; limit: number }
  | { op: "entry"; cache: string; url: string; textCap: number; imageCap: number }
  | { op: "delete-entry"; cache: string; url: string }
  | { op: "export"; cache: string; textCap: number; limit: number };

export type BodyKind = "json" | "text" | "image" | "binary";

/** How to show a cached body, from its Content-Type. */
export function bodyKind(contentType: string): BodyKind {
  const t = contentType.toLowerCase().split(";")[0]!.trim();
  if (/[/+]json$/.test(t) || t === "application/manifest+json") return "json";
  if (t.startsWith("image/") && t !== "image/svg+xml") return "image";
  if (
    t.startsWith("text/") ||
    t === "image/svg+xml" ||
    /[/+]xml$/.test(t) ||
    /javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|toml|csv/.test(t)
  )
    return "text";
  return "binary";
}

/** A JSON body parsed, or null when it does not parse. */
export function parseJsonBody(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A cached URL as the list shows it: path and query on the page's origin, the full URL elsewhere. */
export function shortUrl(url: string, origin: string | null): string {
  try {
    const u = new URL(url);
    return origin && u.origin === origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

/* Exports */

export function exportFileName(kind: "indexeddb" | "cache", ...parts: string[]): string {
  const slug = parts
    .map((p) =>
      p
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60),
    )
    .filter(Boolean)
    .join("-");
  return `${kind}-${slug || "export"}.json`;
}

export function storeExport(
  meta: { origin: string; database: string; version: number | null; store: IdbStoreInfo; exportedAt: string },
  records: IdbRecord[],
  total: number,
): string {
  return JSON.stringify(
    {
      format: "devkit-indexeddb",
      version: 1,
      origin: meta.origin,
      exportedAt: meta.exportedAt,
      database: { name: meta.database, version: meta.version },
      store: {
        name: meta.store.name,
        keyPath: meta.store.keyPath,
        autoIncrement: meta.store.autoIncrement,
        indexes: meta.store.indexes,
      },
      count: total,
      ...(records.length < total ? { truncated: `first ${records.length} of ${total} records` } : {}),
      records: records.map((r) => ({ key: r.primaryKey, value: r.value })),
    },
    null,
    2,
  );
}

export function cacheExport(
  meta: { origin: string; cache: string; exportedAt: string },
  entries: CacheEntryDetail[],
  total: number,
): string {
  return JSON.stringify(
    {
      format: "devkit-cache-storage",
      version: 1,
      origin: meta.origin,
      exportedAt: meta.exportedAt,
      cache: meta.cache,
      count: total,
      ...(entries.length < total ? { truncated: `first ${entries.length} of ${total} entries` } : {}),
      entries: entries.map((e) => ({
        method: e.method,
        url: e.url,
        status: e.status,
        statusText: e.statusText,
        type: e.type,
        headers: Object.fromEntries(e.headers),
        size: e.size,
        body: e.body.kind === "text" ? e.body.text : e.body.kind === "image" ? e.body.dataUrl : null,
        ...(e.body.kind === "text" && e.body.truncated ? { bodyTruncated: true } : {}),
        ...(e.body.kind === "none" ? { bodyNote: e.body.reason } : {}),
      })),
    },
    null,
    2,
  );
}
