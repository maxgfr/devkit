import { base64Encode } from "./utils/encode";
import { parseJson } from "./utils/json";

/*
 * Mock API responses: the rules, how they match a request, and the CDP `Fetch` payloads they
 * turn into. Framework-free; the debugger session lives in `mock-session.ts` (background).
 */

export const MOCK_METHODS = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type MockMethod = (typeof MOCK_METHODS)[number];

/** `Network.ErrorReason` values worth offering, with what the page sees. */
export const ERROR_REASONS = [
  ["Failed", "net::ERR_FAILED"],
  ["ConnectionRefused", "net::ERR_CONNECTION_REFUSED"],
  ["ConnectionReset", "net::ERR_CONNECTION_RESET"],
  ["TimedOut", "net::ERR_TIMED_OUT"],
  ["NameNotResolved", "net::ERR_NAME_NOT_RESOLVED"],
  ["InternetDisconnected", "net::ERR_INTERNET_DISCONNECTED"],
  ["BlockedByClient", "net::ERR_BLOCKED_BY_CLIENT"],
  ["Aborted", "net::ERR_ABORTED"],
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number][0];

export const CONTENT_TYPES = [
  "application/json",
  "text/plain",
  "text/html",
  "application/xml",
  "text/csv",
  "application/javascript",
  "application/problem+json",
] as const;

export interface Mock {
  id: string;
  enabled: boolean;
  name: string;
  method: MockMethod;
  /** Substring of the URL, `*` wildcards and `|` / `||` anchors like Request rules, or `/regex/flags`. */
  match: string;
  /** `respond` serves the response below; `fail` makes the request fail like a network error. */
  mode: "respond" | "fail";
  status: number;
  contentType: string;
  /** One `Name: value` per line. */
  headers: string;
  body: string;
  /** Milliseconds to wait before answering (or failing). */
  delay: number;
  error: ErrorReason;
  /** URL the mock was created from, to fetch its real response again. */
  source?: string;
}

export const MOCKS_KEY = "apiMocks";
export const MAX_DELAY = 60_000;

export function newMock(patch: Partial<Mock> = {}): Mock {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    name: "",
    method: "ANY",
    match: "",
    mode: "respond",
    status: 200,
    contentType: "application/json",
    headers: "",
    body: "{\n  \n}",
    delay: 0,
    error: "Failed",
    ...patch,
  };
}

export type PatternKind = "regex" | "wildcard" | "substring";

const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/s;

export function patternKind(match: string): PatternKind {
  const m = match.trim();
  if (REGEX_LITERAL.test(m)) return "regex";
  return /[*|]/.test(m) ? "wildcard" : "substring";
}

const escapeRegex = (s: string) => s.replace(/[.+?^${}()[\]\\]/g, "\\$&");

/**
 * The pattern as a RegExp tested against the URL without its #fragment. `null` when it is empty
 * or a regex that does not compile. `||host` anchors at the domain (and its subdomains), a leading
 * `|` at the start of the URL, a trailing `|` at its end, `*` is any run of characters.
 */
export function compilePattern(match: string): RegExp | null {
  const m = match.trim();
  if (!m) return null;
  const literal = REGEX_LITERAL.exec(m);
  if (literal) {
    try {
      return new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, ""));
    } catch {
      return null;
    }
  }
  let core = m;
  let head = "";
  let tail = "";
  if (core.startsWith("||")) {
    core = core.slice(2);
    head = "^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?";
  } else if (core.startsWith("|")) {
    core = core.slice(1);
    head = "^";
  }
  if (core.endsWith("|")) {
    core = core.slice(0, -1);
    tail = "$";
  }
  if (!core) return null;
  return new RegExp(head + core.split("*").map(escapeRegex).join(".*") + tail);
}

const withoutHash = (url: string) => {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
};

export function mockMatches(mock: Mock, method: string, url: string): boolean {
  if (!mock.enabled) return false;
  if (mock.method !== "ANY" && mock.method !== method.toUpperCase()) return false;
  const re = compilePattern(mock.match);
  return Boolean(re?.test(withoutHash(url)));
}

/** The first enabled, usable mock (in list order) that answers `method url`. */
export function findMock(mocks: Mock[], method: string, url: string): Mock | undefined {
  return mocks.find((m) => !mockProblem(m) && mockMatches(m, method, url));
}

export interface HeaderLine {
  name: string;
  value: string;
}

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** `Name: value` lines → headers, with the lines that are not headers. */
export function parseHeaders(text: string): { headers: HeaderLine[]; bad: string[] } {
  const headers: HeaderLine[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!TOKEN.test(name)) bad.push(line);
    else headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return { headers, bad };
}

/** What stops a mock from being served. Mocks with a problem are skipped. */
export function mockProblem(mock: Mock): string | null {
  if (!mock.match.trim()) return "Set a URL pattern";
  if (!compilePattern(mock.match)) return patternKind(mock.match) === "regex" ? "The regex does not compile" : "Set a URL pattern";
  if (mock.mode === "fail") return null;
  if (!Number.isInteger(mock.status) || mock.status < 100 || mock.status > 599) return "Status must be a number from 100 to 599";
  const { bad } = parseHeaders(mock.headers);
  if (bad.length) return `Not a header: ${bad[0]}`;
  if (!Number.isFinite(mock.delay) || mock.delay < 0 || mock.delay > MAX_DELAY) return `Delay must be 0 to ${MAX_DELAY} ms`;
  return null;
}

export const isJsonType = (contentType: string) => /[/+]json\b/i.test(contentType);

/** Body problems that do not stop the mock (an invalid JSON body is served as is, on purpose maybe). */
export function bodyWarning(mock: Mock): string | null {
  if (mock.mode === "fail" || !isJsonType(mock.contentType) || !mock.body.trim()) return null;
  const parsed = parseJson(mock.body);
  if (parsed.ok) return null;
  return `Invalid JSON${parsed.line ? ` at line ${parsed.line}, column ${parsed.column}` : ""}: served as is`;
}

export function prettyJson(text: string): string | null {
  const parsed = parseJson(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : null;
}

/** CDP `Fetch.RequestPattern` glob (`*`, `?`, `\` escapes) that pre-filters requests for a mock. */
function cdpGlob(match: string): string {
  if (patternKind(match) === "regex") return "*";
  const core = match
    .trim()
    .replace(/^\|\|?/, "")
    .replace(/\|$/, "")
    .replace(/[\\?]/g, "\\$&");
  return `*${core}*`.replace(/\*{2,}/g, "*");
}

export interface FetchPattern {
  urlPattern: string;
  resourceType: "XHR" | "Fetch";
  requestStage: "Request";
}

/**
 * Patterns for `Fetch.enable`: only fetch/XHR requests whose URL can match an enabled mock are
 * paused. Empty when nothing can match: call `Fetch.disable` then (an empty list pauses everything).
 */
export function fetchPatterns(mocks: Mock[]): FetchPattern[] {
  const globs = [...new Set(mocks.filter((m) => m.enabled && !mockProblem(m)).map((m) => cdpGlob(m.match)))];
  const all = globs.includes("*") ? ["*"] : globs;
  return all.flatMap((urlPattern) => [
    { urlPattern, resourceType: "XHR" as const, requestStage: "Request" as const },
    { urlPattern, resourceType: "Fetch" as const, requestStage: "Request" as const },
  ]);
}

const header = (headers: Record<string, string>, name: string): string | undefined => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

/** A CORS preflight (OPTIONS with Access-Control-Request-Method): Chrome pauses those too. */
export function preflightMethod(request: { method: string; headers: Record<string, string> }): string | null {
  if (request.method.toUpperCase() !== "OPTIONS") return null;
  return header(request.headers, "access-control-request-method")?.toUpperCase() ?? null;
}

export interface FulfillParams {
  responseCode: number;
  responseHeaders: HeaderLine[];
  body?: string;
}

const NO_BODY = new Set([204, 205, 304]);

/** Answer to a preflight for a mocked request, so a cross-origin mock works without the server. */
export function preflightResponse(request: { headers: Record<string, string> }): FulfillParams {
  const origin = header(request.headers, "origin") ?? "*";
  const asked = header(request.headers, "access-control-request-headers");
  return {
    responseCode: 204,
    responseHeaders: [
      { name: "Access-Control-Allow-Origin", value: origin },
      { name: "Access-Control-Allow-Methods", value: "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS" },
      { name: "Access-Control-Allow-Headers", value: asked || "*" },
      ...(origin !== "*" ? [{ name: "Access-Control-Allow-Credentials", value: "true" }] : []),
      { name: "Access-Control-Max-Age", value: "5" },
      { name: "Vary", value: "Origin" },
    ],
  };
}

/**
 * `Fetch.fulfillRequest` params for `mock` answering `request`. Adds CORS headers when the
 * request carries an Origin and the mock does not set them, so cross-origin mocks reach the page.
 */
export function fulfillParams(mock: Mock, request: { method: string; headers: Record<string, string> }): FulfillParams {
  const own = parseHeaders(mock.headers).headers;
  const has = (name: string) => own.some((h) => h.name.toLowerCase() === name);
  const headers: HeaderLine[] = [];
  if (mock.contentType.trim() && !has("content-type")) headers.push({ name: "Content-Type", value: mock.contentType.trim() });
  headers.push(...own);
  const origin = header(request.headers, "origin");
  if (origin && !has("access-control-allow-origin")) {
    headers.push({ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Credentials", value: "true" });
    const expose = own.map((h) => h.name).filter((n) => !/^(content-type|access-control-.*)$/i.test(n));
    if (expose.length && !has("access-control-expose-headers"))
      headers.push({ name: "Access-Control-Expose-Headers", value: expose.join(", ") });
  }
  if (!has("cache-control")) headers.push({ name: "Cache-Control", value: "no-store" });
  headers.push({
    name: "X-Devkit-Mock",
    value: mockLabel(mock)
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 200),
  });
  const bodyless = NO_BODY.has(mock.status) || request.method.toUpperCase() === "HEAD";
  return { responseCode: mock.status, responseHeaders: headers, ...(bodyless ? {} : { body: base64Encode(mock.body) }) };
}

/** Readable label of a mock for lists and the log. */
export function mockLabel(mock: Pick<Mock, "name" | "match">): string {
  return mock.name.trim() || mock.match.trim() || "Untitled mock";
}

/** A new mock that serves what `url` answered, ready to edit. */
export function mockFromResponse(r: { method: string; url: string; status?: number; contentType?: string; body?: string }): Mock {
  let match = r.url;
  let name = "";
  try {
    const u = new URL(r.url);
    match = `${u.host}${u.pathname}`;
    name = u.pathname;
  } catch {
    // not a URL: keep it as a substring
  }
  const contentType = (r.contentType ?? "application/json").split(";")[0]!.trim() || "application/json";
  const body = r.body ?? "";
  const pretty = isJsonType(contentType) ? prettyJson(body) : null;
  const method = (MOCK_METHODS as readonly string[]).includes(r.method.toUpperCase()) ? (r.method.toUpperCase() as MockMethod) : "ANY";
  return newMock({
    name,
    method,
    match,
    source: r.url,
    status: r.status && r.status >= 100 && r.status <= 599 ? r.status : 200,
    contentType,
    body: pretty ?? body,
  });
}

/** Mocks from an exported file: a list, or `{ mocks: [...] }`. Fresh ids; unknown fields dropped. */
export function importMocks(data: unknown): Mock[] {
  const list = Array.isArray(data) ? data : (data as { mocks?: unknown } | null)?.mocks;
  if (!Array.isArray(list)) throw new Error("Expected a JSON list of mocks");
  return list.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`Item ${i + 1} is not a mock`);
    const r = raw as Record<string, unknown>;
    if (typeof r.match !== "string") throw new Error(`Item ${i + 1} has no "match" URL pattern`);
    const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const method = str(r.method, "ANY").toUpperCase();
    const error = str(r.error, "Failed");
    const headers = Array.isArray(r.headers)
      ? (r.headers as HeaderLine[]).map((h) => `${h.name}: ${h.value}`).join("\n")
      : r.headers && typeof r.headers === "object"
        ? Object.entries(r.headers as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")
        : str(r.headers, "");
    const body = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body, null, 2);
    return newMock({
      enabled: r.enabled !== false,
      name: str(r.name, ""),
      method: (MOCK_METHODS as readonly string[]).includes(method) ? (method as MockMethod) : "ANY",
      match: r.match,
      mode: r.mode === "fail" ? "fail" : "respond",
      status: Math.round(num(r.status, 200)),
      contentType: str(r.contentType, "application/json"),
      headers,
      body,
      delay: Math.max(0, Math.min(MAX_DELAY, Math.round(num(r.delay, 0)))),
      error: ERROR_REASONS.some(([e]) => e === error) ? (error as ErrorReason) : "Failed",
      ...(typeof r.source === "string" && r.source ? { source: r.source } : {}),
    });
  });
}

/** What the export file holds: the mocks without their ids. */
export function exportMocks(mocks: Mock[]): string {
  return JSON.stringify(
    mocks.map(({ id: _id, ...m }) => m),
    null,
    2,
  );
}

/* Per-tab session state, kept by the background in storage.session and read by the panel. */

export interface MockTabState {
  on: boolean;
  /** Mocked answers since mocking was turned on. */
  hits: number;
  since?: number;
  /** Why Chrome ended the session when it did (`canceled_by_user`, `target_closed`). */
  detached?: string;
  error?: string;
}

export interface MockLogEntry {
  /** Network request id (also the key that dedupes Network and Fetch events). */
  id: string;
  time: number;
  method: string;
  url: string;
  status?: number;
  mime?: string;
  mockId?: string;
  mockName?: string;
  outcome: "pending" | "mocked" | "failed" | "passed" | "error";
  delay?: number;
  error?: string;
}

export const LOG_CAP = 100;
export const tabStateKey = (tabId: number) => `mocks:tab:${tabId}`;
export const tabLogKey = (tabId: number) => `mocks:log:${tabId}`;

/** Adds or updates the entry `patch.id`, newest first, capped. Mocked entries keep their outcome. */
export function upsertLog(log: MockLogEntry[], patch: Partial<MockLogEntry> & { id: string }): MockLogEntry[] {
  const i = log.findIndex((e) => e.id === patch.id);
  if (i < 0) {
    if (!patch.url) return log;
    const entry: MockLogEntry = { time: Date.now(), method: "GET", url: "", outcome: "pending", ...patch } as MockLogEntry;
    return [entry, ...log].slice(0, LOG_CAP);
  }
  const prev = log[i]!;
  const keep = prev.outcome === "mocked" || prev.outcome === "failed";
  const next: MockLogEntry = { ...prev, ...patch, ...(keep && patch.outcome ? { outcome: prev.outcome } : {}) };
  if (keep && patch.error && prev.outcome === "failed") next.error = prev.error ?? patch.error;
  const out = log.slice();
  out[i] = next;
  return out;
}

export const MOCK_MESSAGE = "devkit:mocks";

export type MockOp = "start" | "stop" | "status" | "clear" | "body";

export interface MockRequest {
  type: typeof MOCK_MESSAGE;
  op: MockOp;
  tabId: number;
  requestId?: string;
}

export interface MockReply {
  ok: boolean;
  error?: string;
  state?: MockTabState;
  body?: string;
  base64?: boolean;
}

/** Words for why Chrome ended a debugger session. */
export function detachReason(reason: string | undefined): string {
  if (reason === "canceled_by_user") return "Cancel was clicked on Chrome's debugging bar";
  if (reason === "target_closed") return "the tab closed or moved to a page Chrome does not let extensions debug";
  if (reason === "lost") return "Chrome ended the debugger session (its bar was closed or another tool detached it)";
  return reason ? `Chrome ended the session (${reason})` : "Chrome ended the session";
}
