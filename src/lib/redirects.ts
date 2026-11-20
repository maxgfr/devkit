// Redirect path: every hop of a navigation (server 301/302/303/307/308, the browser's own internal redirects,
// Refresh headers, meta refresh and JavaScript redirects), built from webRequest / webNavigation events in the
// background, and what is worth fixing in it. Pure: no browser API here, so the chain building is unit-tested.
import type { Check } from "./headers";

/** How a hop moved on to the next one. */
export type RedirectKind = "http" | "internal" | "refresh" | "meta" | "js" | "client";

export interface Hop {
  url: string;
  /** HTTP status of the response; 0 when there was none (network error). */
  status: number;
  statusLine?: string;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  /** How this hop moved on; absent on the last hop. */
  redirect?: RedirectKind;
  /** Where it moved to. */
  location?: string;
  /** Time from the request (or the previous redirect) to this response, in ms. */
  ms?: number;
  ip?: string;
  fromCache?: boolean;
  /** Network error (net::ERR_…), when the request failed. */
  error?: string;
}

export interface Chain {
  id: string;
  /** "tab": a navigation seen in a tab; "trace": a URL devkit requested itself. */
  source: "tab" | "trace";
  /** Epoch ms of the first request. */
  startedAt: number;
  hops: Hop[];
  /** Why the chain ended early, when it did. */
  stopped?: "max-hops" | "loop";
  /** The navigation became the tab's document (false for downloads, 204s and aborted loads). */
  committed?: boolean;
  /** Earlier hops dropped to keep the chain bounded (endless client redirects). */
  dropped?: number;
  /** Anything devkit could not see, in words. */
  note?: string;
}

/** storage.session key of the last chains of each tab (newest first), written by the background. */
export const REDIRECTS_KEY = "redirectChains";
export type RedirectStore = Record<string, Chain[]>;
/** Message asking the background to trace a URL. */
export const REDIRECT_TRACE = "devkit:redirect-trace";
export type TraceMessage = { type: typeof REDIRECT_TRACE; url: string };
export type TraceAnswer = { chain?: Chain; error?: string };
/** Message from the probe content script: the page's meta refresh `content`, or null. */
export const META_REFRESH_SEEN = "devkit:meta-refresh";

/** Browsers give up after 20 redirects; so does devkit. */
export const MAX_REDIRECTS = 20;
const MAX_HOPS = MAX_REDIRECTS + 1;
const MAX_HEADER_VALUE = 4000;

export const KIND_TEXT: Record<RedirectKind, string> = {
  http: "server redirect",
  internal: "internal redirect (browser)",
  refresh: "Refresh header",
  meta: "meta refresh",
  js: "JavaScript redirect",
  client: "client redirect",
};

/** Client-side hops: the page loaded, then sent the browser on. */
export const isClientKind = (k: RedirectKind | undefined) => k === "meta" || k === "js" || k === "client" || k === "refresh";

/** webRequest's header list as a record: lower-cased names, repeated headers joined like the Fetch API does. */
export function headersRecord(list: { name: string; value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    const name = h.name.toLowerCase();
    const value = (h.value ?? "").slice(0, MAX_HEADER_VALUE);
    out[name] = name in out ? `${out[name]}${name === "set-cookie" ? "\n" : ", "}${value}` : value;
  }
  return out;
}

/** The URL without its fragment: webRequest drops it, webNavigation keeps it. */
export function sameDocument(a: string, b: string): boolean {
  return a.split("#")[0] === b.split("#")[0];
}

/**
 * The delay and target of a refresh (`<meta http-equiv=refresh content>` or the Refresh header), resolved
 * against `base`, following the HTML parsing rules loosely: `5`, `0;url=/next`, `3, URL='next'`.
 */
export function parseRefresh(content: string, base: string): { delay: number; url: string } | null {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:[;,]\s*(?:url\s*=\s*)?(.*))?$/is.exec(content);
  if (!m) return null;
  let target = (m[2] ?? "").trim();
  if ((target.startsWith("'") || target.startsWith('"')) && target.length > 1) {
    const q = target[0]!;
    const end = target.indexOf(q, 1);
    target = target.slice(1, end === -1 ? undefined : end);
  }
  try {
    return { delay: Math.floor(Number(m[1])), url: new URL(target || base, base).href };
  } catch {
    return null;
  }
}

/** The `content` of the first `<meta http-equiv=refresh>` in an HTML document, outside comments and `<noscript>`. */
export function findMetaRefresh(html: string): string | null {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "");
  for (const [tag] of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string) =>
      new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i")
        .exec(tag)
        ?.slice(1)
        .find((v) => v !== undefined);
    if (attr("http-equiv")?.trim().toLowerCase() === "refresh") {
      const content = attr("content");
      if (content !== undefined) return content;
    }
  }
  return null;
}

/* Building a chain from webRequest events */

export interface Recording {
  chain: Chain;
  /** When the current hop's request started. */
  hopStart: number;
  /** The last onHeadersReceived, used when the request ends without onCompleted. */
  last?: { url: string; status: number; statusLine?: string; headers: Record<string, string> };
}

export interface ResponseEvent {
  url: string;
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: { name: string; value?: string }[];
  timeStamp: number;
  ip?: string;
  fromCache?: boolean;
}

export function startRecording(id: string, at: number, source: Chain["source"]): Recording {
  return { chain: { id, source, startedAt: at, hops: [] }, hopStart: at, last: undefined };
}

function hopOf(rec: Recording, e: ResponseEvent): Hop {
  const hop: Hop = {
    url: e.url,
    status: e.statusCode ?? 0,
    headers: headersRecord(e.responseHeaders),
    ms: Math.max(0, Math.round(e.timeStamp - rec.hopStart)),
  };
  if (e.statusLine) hop.statusLine = e.statusLine;
  if (e.ip) hop.ip = e.ip;
  if (e.fromCache) hop.fromCache = true;
  return hop;
}

/** onHeadersReceived: remembers the response in case the request ends without onCompleted. */
export function recordHeaders(rec: Recording, e: ResponseEvent): void {
  rec.last = { url: e.url, status: e.statusCode ?? 0, statusLine: e.statusLine, headers: headersRecord(e.responseHeaders) };
}

/** Redirects the browser makes itself (HSTS upgrade, another extension) carry a made-up status line. */
export function isInternalRedirect(statusLine: string | undefined, headers: Record<string, string>): boolean {
  return /internal redirect/i.test(statusLine ?? "") || "non-authoritative-reason" in headers;
}

/** onBeforeRedirect: one more hop. Past 20 redirects the chain stops, as the browser does. */
export function recordRedirect(rec: Recording, e: ResponseEvent & { redirectUrl: string }): void {
  rec.last = undefined;
  if (rec.chain.hops.length >= MAX_REDIRECTS) {
    rec.chain.stopped = "max-hops";
    return;
  }
  const hop = hopOf(rec, e);
  hop.redirect = isInternalRedirect(e.statusLine, hop.headers) ? "internal" : "http";
  hop.location = e.redirectUrl;
  rec.chain.hops.push(hop);
  rec.hopStart = e.timeStamp;
}

/** onCompleted: the last hop. */
export function recordComplete(rec: Recording, e: ResponseEvent): Chain {
  rec.chain.hops.push(hopOf(rec, e));
  rec.last = undefined;
  return rec.chain;
}

/** onErrorOccurred: the last hop is the response seen before the error, or the failed URL. */
export function recordError(rec: Recording, e: { url: string; error: string; timeStamp: number }): Chain {
  const last = rec.last && sameDocument(rec.last.url, e.url) ? rec.last : undefined;
  const hop = hopOf(rec, {
    url: e.url,
    statusCode: last?.status ?? 0,
    statusLine: last?.statusLine,
    timeStamp: e.timeStamp,
  });
  if (last) hop.headers = last.headers;
  // An aborted body after the headers came in is not a failure of the response (the reader stopped).
  if (!(last && /ERR_ABORTED/.test(e.error))) hop.error = e.error;
  if (/TOO_MANY_REDIRECTS/.test(e.error)) rec.chain.stopped = "max-hops";
  rec.chain.hops.push(hop);
  rec.last = undefined;
  return rec.chain;
}

/** `next` was started by a client redirect from the last document of `prev`: one chain, bounded to 21 hops. */
export function joinClient(prev: Chain, next: Chain, kind: RedirectKind): Chain {
  const head = prev.hops.map((h) => ({ ...h }));
  const last = head.at(-1);
  if (last) {
    last.redirect = kind;
    last.location = next.hops[0]?.url;
  }
  const hops = [...head, ...next.hops];
  const dropped = Math.max(0, hops.length - MAX_HOPS);
  const out: Chain = { ...next, startedAt: prev.startedAt, hops: hops.slice(dropped) };
  const total = (prev.dropped ?? 0) + dropped;
  if (total) out.dropped = total;
  return out;
}

/** The latest chain in `chains` (newest first) that ended on `url`. */
export function pickChain(chains: Chain[] | undefined, url: string): Chain | undefined {
  return chains?.find((c) => {
    const last = c.hops.at(-1);
    return last ? sameDocument(last.url, url) : false;
  });
}

/* Reading a chain */

export const redirectCount = (chain: Chain) => chain.hops.filter((h) => h.redirect).length;
export const finalHop = (chain: Chain): Hop | undefined => chain.hops.at(-1);
export const chainMs = (chain: Chain) => chain.hops.reduce((s, h) => s + (h.ms ?? 0), 0);

/** Index of the first hop whose URL already appeared earlier in the chain, or -1. */
export function loopAt(chain: Chain): number {
  const seen = new Set<string>();
  for (const [i, h] of chain.hops.entries()) {
    const key = h.url.split("#")[0]!;
    if (seen.has(key)) return i;
    seen.add(key);
  }
  return -1;
}

const strip = (u: URL) => ({ host: u.hostname.replace(/^www\./, ""), path: u.pathname.replace(/\/+$/, "") || "/" });

/**
 * What a redirect only changes, when it looks like a URL being made canonical (heuristic): the scheme, the
 * www prefix, a trailing slash, the letter case of the path. Such moves are usually permanent.
 */
export function canonicalChange(from: string, to: string): string | null {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to, from);
  } catch {
    return null;
  }
  if (a.href === b.href || a.search !== b.search) return null;
  const sa = strip(a);
  const sb = strip(b);
  if (sa.host !== sb.host || a.port !== b.port) return null;
  const changes: string[] = [];
  if (a.protocol !== b.protocol) changes.push(b.protocol === "https:" ? "moves to HTTPS" : "moves to HTTP");
  if (a.hostname !== b.hostname) changes.push(b.hostname.startsWith("www.") ? "adds www" : "removes www");
  if (sa.path === sb.path) {
    if (a.pathname !== b.pathname) changes.push(b.pathname.endsWith("/") ? "adds a trailing slash" : "removes the trailing slash");
  } else if (sa.path.toLowerCase() === sb.path.toLowerCase()) changes.push("changes the letter case");
  else return null;
  return changes.length ? changes.join(", ") : null;
}

const scheme = (u: string) => {
  try {
    return new URL(u).protocol;
  } catch {
    return "";
  }
};

/** What is worth knowing about a chain, worst first in the UI via the levels. */
export function redirectFindings(chain: Chain): Check[] {
  const out: Check[] = [];
  const add = (id: string, label: string, level: Check["level"], detail: string) => out.push({ id, label, level, detail });
  const redirects = redirectCount(chain);
  const final = finalHop(chain);
  const loop = loopAt(chain);

  if (chain.stopped === "loop" || loop !== -1)
    add(
      "loop",
      "Redirect loop",
      "bad",
      loop !== -1
        ? `${chain.hops[loop]!.url} comes back after ${loop} ${loop === 1 ? "hop" : "hops"}: the page never loads.`
        : "A meta refresh points back to a page already in the chain.",
    );
  if (chain.stopped === "max-hops")
    add("max-hops", "Too many redirects", "bad", `Stopped after ${MAX_REDIRECTS} redirects, like the browser does.`);

  if (!redirects) add("none", "Redirects", "good", "Served directly, without a redirect.");
  else if (redirects > 2)
    add(
      "hops",
      "Long chain",
      "warn",
      `${redirects} redirects: each one is a round trip before the page starts. Link to the final URL, and redirect old URLs to it in one hop.`,
    );
  else add("hops", "Redirects", "info", `${redirects} ${redirects === 1 ? "redirect" : "redirects"} before the page.`);

  for (const [i, h] of chain.hops.entries()) {
    if (!h.redirect || !h.location) continue;
    const from = scheme(h.url);
    const to = scheme(h.location);
    if (from === "https:" && to === "http:")
      add(`downgrade-${i}`, "HTTPS to HTTP", "bad", `Hop ${i + 1} leaves HTTPS for ${h.location}: the rest travels in clear text.`);
    else if (from === "http:" && to === "https:")
      add(
        `upgrade-${i}`,
        "HTTP upgraded to HTTPS",
        h.redirect === "internal" ? "good" : "info",
        h.redirect === "internal"
          ? `The browser upgraded ${h.url} itself (HSTS or an HTTPS-first setting), without asking the server.`
          : `Hop ${i + 1} upgrades ${h.url}. Links that point at https:// directly skip this round trip; HSTS lets the browser skip it too.`,
      );
    if (h.redirect === "http" && (h.status === 302 || h.status === 307)) {
      const change = canonicalChange(h.url, h.location);
      if (change)
        add(
          `temporary-${i}`,
          "Temporary redirect for a permanent move (heuristic)",
          "warn",
          `Hop ${i + 1} answers ${h.status} but only ${change}. A canonical URL change is usually permanent: use 301 or 308 so search engines and caches move to the new URL.`,
        );
    }
  }

  const client = chain.hops.filter((h) => isClientKind(h.redirect));
  if (client.length) {
    const kinds = [...new Set(client.map((h) => KIND_TEXT[h.redirect!]))];
    const mixed = chain.hops.some((h) => h.redirect === "http");
    add(
      "client",
      mixed ? "Server and client redirects mixed" : "Client-side redirect",
      "warn",
      `${client.length} ${client.length === 1 ? "hop" : "hops"} by ${kinds.join(", ")}: the page loads before moving on, and crawlers or link previews may not follow. A server 301/308 is faster and understood everywhere.`,
    );
  }

  if (final?.error) add("error", "Final request failed", "bad", final.error);
  else if (final && final.status >= 400) add("status", "Final response", "bad", `HTTP ${final.status} at ${final.url}.`);
  else if (final && final.status >= 300 && !chain.stopped)
    add("status", "Final response", "warn", `HTTP ${final.status} without a redirect followed.`);
  return out;
}

/** One line per hop, for people (Copy chain). */
export function chainText(chain: Chain): string {
  const lines = chain.hops.map((h, i) => {
    const status = h.error ? h.error : h.statusLine?.replace(/^HTTP\/[\d.]+\s*/, "") || String(h.status);
    const how = h.redirect && h.redirect !== "http" ? ` (${KIND_TEXT[h.redirect]})` : "";
    const time = h.ms !== undefined ? ` · ${h.ms} ms` : "";
    return `${i + 1}. ${status}${how} ${h.url}${time}${h.location ? `\n   → ${h.location}` : ""}`;
  });
  if (chain.dropped) lines.unshift(`(${chain.dropped} earlier hops not kept)`);
  return lines.join("\n");
}
