// Content-Security-Policy: parsing, directive-by-directive findings, and a starter policy from what the page loads.
import type { Level } from "../headers";
import type { SurfaceSnapshot } from "../page/security";

export interface CspDirective {
  name: string;
  values: string[];
}

export interface CspPolicy {
  source: "header" | "meta";
  reportOnly: boolean;
  raw: string;
  directives: CspDirective[];
  /** Directives written twice: browsers ignore every copy after the first. */
  duplicates: string[];
}

/** Parses a CSP header value. Several policies (comma-separated, or several headers) come back as several entries. */
export function parseCsp(raw: string, source: CspPolicy["source"] = "header", reportOnly = false): CspPolicy[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((policy) => {
      const directives: CspDirective[] = [];
      const duplicates: string[] = [];
      for (const part of policy.split(";")) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (!name) continue;
        const lower = name.toLowerCase();
        if (directives.some((d) => d.name === lower)) {
          duplicates.push(lower);
          continue;
        }
        directives.push({ name: lower, values });
      }
      return { source, reportOnly, raw: policy, directives, duplicates };
    });
}

export interface CspFinding {
  directive: string;
  level: Level;
  message: string;
}

const KNOWN = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "fenced-frame-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "sandbox",
  "report-uri",
  "report-to",
  "upgrade-insecure-requests",
  "require-trusted-types-for",
  "trusted-types",
  "webrtc",
]);
const DEPRECATED = new Set(["block-all-mixed-content", "plugin-types", "referrer", "reflected-xss", "disown-opener", "navigate-to"]);
const META_IGNORED = ["frame-ancestors", "report-uri", "sandbox"];

/**
 * Hosts serving files anyone can publish (npm CDNs, Google's JSONP endpoints, open buckets): allowing
 * them lets an attacker load a script of their choosing. A short, well-known list, not exhaustive.
 */
const BYPASS_HOSTS = [
  /(^|\.)googleapis\.com$/,
  /(^|\.)google\.com$/,
  /(^|\.)gstatic\.com$/,
  /^cdn\.jsdelivr\.net$/,
  /^unpkg\.com$/,
  /^cdnjs\.cloudflare\.com$/,
  /(^|\.)cloudfront\.net$/,
  /(^|\.)amazonaws\.com$/,
  /^raw\.githubusercontent\.com$/,
  /(^|\.)github\.io$/,
  /(^|\.)firebaseapp\.com$/,
  /(^|\.)herokuapp\.com$/,
];

const isNonceOrHash = (v: string) => /^'(nonce-|sha(256|384|512)-)/i.test(v);

/** Directive-by-directive findings for one policy. `xfo` is the X-Frame-Options header, if any. */
export function analyzeCsp(policy: CspPolicy, opts: { https: boolean; xfo?: string } = { https: true }): CspFinding[] {
  const out: CspFinding[] = [];
  const add = (directive: string, level: Level, message: string) => out.push({ directive, level, message });
  const get = (name: string) => policy.directives.find((d) => d.name === name);
  const def = get("default-src");
  const script = get("script-src") ?? def;
  const scriptName = get("script-src") ? "script-src" : "default-src";

  if (policy.reportOnly) add("(policy)", "warn", "Report-only: violations are reported, nothing is blocked.");
  for (const d of policy.duplicates) add(d, "warn", "Written twice: browsers ignore the second copy.");
  if (policy.source === "meta")
    for (const name of META_IGNORED) if (get(name)) add(name, "warn", `Ignored in a <meta> policy: ${name} only works as an HTTP header.`);

  if (!def) add("default-src", "warn", "Missing: anything without its own directive (fonts, frames, connections…) is unrestricted.");
  if (!script) add("script-src", "bad", "No script-src or default-src: scripts are not restricted at all.");
  else {
    const v = script.values.map((x) => x.toLowerCase());
    const hasNonceHash = v.some(isNonceOrHash);
    const strictDynamic = v.includes("'strict-dynamic'");
    if (v.includes("'unsafe-inline'"))
      add(
        scriptName,
        hasNonceHash ? "info" : "bad",
        hasNonceHash
          ? "'unsafe-inline' is ignored because a nonce or hash is present (kept for old browsers)."
          : "'unsafe-inline' without a nonce or hash: injected inline scripts run, so the policy stops little XSS.",
      );
    if (v.includes("'unsafe-eval'")) add(scriptName, "warn", "'unsafe-eval': eval() and new Function() are allowed.");
    if (v.includes("'wasm-unsafe-eval'"))
      add(scriptName, "info", "'wasm-unsafe-eval': WebAssembly compilation is allowed (scripts still cannot eval).");
    if (strictDynamic)
      add(
        scriptName,
        hasNonceHash ? "good" : "warn",
        hasNonceHash
          ? "'strict-dynamic': scripts loaded by a nonced or hashed script are trusted; host allowlists and 'self' are ignored by modern browsers."
          : "'strict-dynamic' without a nonce or hash: host allowlists are ignored, so no script can load.",
      );
    if (!strictDynamic) {
      if (v.includes("*")) add(scriptName, "bad", "Wildcard *: scripts load from any host.");
      for (const scheme of ["http:", "https:"])
        if (v.includes(scheme)) add(scriptName, "bad", `${scheme} allows scripts from any host over that scheme.`);
      if (v.includes("data:")) add(scriptName, "bad", 'data: lets an injected <script src="data:…"> run.');
      if (v.includes("blob:")) add(scriptName, "warn", "blob: lets code that can create blobs run them as scripts.");
      for (const src of v) {
        if (src.startsWith("http://")) add(scriptName, "warn", `${src} is loaded over plain HTTP: anyone on the network can swap it.`);
        const host = /^(?:https?:\/\/)?(\*\.)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(\/|$)/.exec(src)?.[2];
        if (host && !src.startsWith("'") && BYPASS_HOSTS.some((re) => re.test(host)))
          add(scriptName, "warn", `${src} serves files anyone can publish: an attacker can load their own script from it (known bypass).`);
      }
    }
    if (!v.some(isNonceOrHash) && !strictDynamic && !v.includes("'unsafe-inline'") && v.every((x) => x === "'none'"))
      add(scriptName, "good", "'none': no script runs.");
  }

  const object = get("object-src") ?? def;
  if (!object?.values.map((x) => x.toLowerCase()).includes("'none'"))
    add("object-src", "warn", "Not 'none': plugins (<object>, <embed>) can load content. Set object-src 'none'.");
  if (!get("base-uri"))
    add(
      "base-uri",
      "warn",
      "Missing (it does not fall back to default-src): an injected <base> tag can redirect relative script URLs. Use 'self' or 'none'.",
    );
  if (!get("frame-ancestors"))
    add(
      "frame-ancestors",
      opts.xfo ? "info" : "warn",
      opts.xfo ? `Missing, but X-Frame-Options: ${opts.xfo} covers framing.` : "Missing: any site can frame the page (clickjacking).",
    );
  if (!get("form-action")) add("form-action", "info", "Missing (no fallback to default-src): forms may post anywhere.");
  if (!get("report-uri") && !get("report-to"))
    add("report-uri", "info", "No report-uri or report-to: violations are not reported anywhere.");
  if (opts.https && get("upgrade-insecure-requests"))
    add("upgrade-insecure-requests", "good", "http:// subresources are upgraded to https://.");
  if (get("require-trusted-types-for")) add("require-trusted-types-for", "good", "Trusted Types enforced for DOM XSS sinks.");
  for (const d of policy.directives) {
    if (DEPRECATED.has(d.name)) add(d.name, "info", "Deprecated: browsers ignore it.");
    else if (!KNOWN.has(d.name)) add(d.name, "info", "Unknown directive: browsers ignore it (typo?).");
    if (d.values.includes("*") && d.name !== scriptName && /-src$/.test(d.name)) add(d.name, "info", "Wildcard *: any host.");
  }
  return out;
}

export interface StarterCsp {
  policy: string;
  notes: string[];
}

const sourceFor = (url: string, pageOrigin: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol === "data:") return "data:";
    if (u.protocol === "blob:") return "blob:";
    if (!/^(https?|wss?):$/.test(u.protocol)) return null;
    return u.origin === pageOrigin ? "'self'" : u.origin;
  } catch {
    return null;
  }
};

const FONT_RE = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|#|$)/i;

/**
 * A suggested policy built from the origins the page actually used. A starting point: deploy it as
 * Content-Security-Policy-Report-Only, watch the reports, then enforce.
 */
export function starterCsp(snap: SurfaceSnapshot): StarterCsp {
  const pageOrigin = new URL(snap.url).origin;
  const https = snap.url.startsWith("https:");
  const buckets: Record<string, Set<string>> = {
    "script-src": new Set(["'self'"]),
    "style-src": new Set(["'self'"]),
    "img-src": new Set(["'self'"]),
    "font-src": new Set(["'self'"]),
    "connect-src": new Set(["'self'"]),
    "media-src": new Set(),
    "frame-src": new Set(),
    "form-action": new Set(["'self'"]),
  };
  const put = (directive: string, url: string) => {
    const s = sourceFor(url, pageOrigin);
    if (s) buckets[directive]!.add(s);
  };
  for (const s of snap.scripts) put("script-src", s.src);
  for (const s of snap.styles) put("style-src", s.href);
  for (const i of snap.images) put("img-src", i);
  for (const m of snap.media) put("media-src", m);
  for (const f of snap.iframes) if (/^https?:/.test(f.src)) put("frame-src", f.src);
  for (const f of snap.forms) put("form-action", f);
  for (const r of snap.resources) {
    const path = (() => {
      try {
        return new URL(r.name).pathname;
      } catch {
        return "";
      }
    })();
    if (r.type === "script") put("script-src", r.name);
    else if (r.type === "link" && /\.css(\?|$)/i.test(path)) put("style-src", r.name);
    else if (FONT_RE.test(path)) put("font-src", r.name);
    else if (r.type === "img" || r.type === "image" || (r.type === "css" && IMG_RE.test(path))) put("img-src", r.name);
    else if (r.type === "css" && /\.css(\?|$)/i.test(path)) put("style-src", r.name);
    else if (["fetch", "xmlhttprequest", "beacon", "eventsource", "other"].includes(r.type)) put("connect-src", r.name);
    else if (r.type === "video" || r.type === "audio" || r.type === "track") put("media-src", r.name);
    else if (r.type === "iframe" || r.type === "frame") put("frame-src", r.name);
  }
  if (snap.dataImages) buckets["img-src"]!.add("data:");
  const notes: string[] = [];
  if (snap.inlineScripts || snap.inlineHandlers) {
    buckets["script-src"]!.add("'nonce-{RANDOM}'");
    notes.push(
      `The page has ${snap.inlineScripts} inline script${snap.inlineScripts === 1 ? "" : "s"}${snap.inlineHandlers ? ` and ${snap.inlineHandlers} inline event handler${snap.inlineHandlers === 1 ? "" : "s"}` : ""}: give each <script> a fresh nonce per response (replace {RANDOM}), or hash them. Inline handlers (onclick=…) need rewriting as listeners.`,
    );
  }
  if (snap.inlineStyles || snap.styleAttributes) {
    buckets["style-src"]!.add("'unsafe-inline'");
    notes.push(
      `'unsafe-inline' in style-src because the page has ${snap.inlineStyles} <style> block${snap.inlineStyles === 1 ? "" : "s"} and ${snap.styleAttributes} style attribute${snap.styleAttributes === 1 ? "" : "s"}. Lower risk than for scripts; replace with nonces or hashes when you can.`,
    );
  }
  notes.push(
    "connect-src only lists what loaded so far: WebSockets and later API calls do not show in resource timing. Use the app, then regenerate.",
  );
  const order = ["script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "frame-src", "form-action"];
  const lines = ["default-src 'self'"];
  for (const d of order) {
    const values = [...buckets[d]!];
    if (!values.length) {
      if (d === "frame-src" || d === "media-src") continue;
    }
    lines.push(`${d} ${values.join(" ")}`);
  }
  lines.push("object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'");
  if (https) lines.push("upgrade-insecure-requests");
  return { policy: `${lines.join("; ")};`, notes };
}
