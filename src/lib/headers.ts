export type Level = "good" | "warn" | "bad" | "info";

export interface Check {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

export interface HeaderFetch {
  status: number;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  ms: number;
}

/** Fetches `url` again from devkit and returns what the server answers (Set-Cookie stays hidden by the browser). */
export async function fetchHeaders(url: string, init: RequestInit = {}): Promise<HeaderFetch> {
  const start = performance.now();
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", ...init });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.body?.cancel().catch(() => undefined);
  return { status: res.status, url: res.url, redirected: res.redirected, headers, ms: Math.round(performance.now() - start) };
}

const lower = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** Security checks over response headers, in the spirit of securityheaders.com. */
export function securityReport(raw: Record<string, string>, url: string): { checks: Check[]; grade: string; score: number } {
  const h = lower(raw);
  const checks: Check[] = [];
  const https = url.startsWith("https:");
  const add = (id: string, label: string, level: Level, detail: string) => checks.push({ id, label, level, detail });

  checks.push(
    https
      ? { id: "https", label: "HTTPS", level: "good", detail: "Served over TLS" }
      : { id: "https", label: "HTTPS", level: "bad", detail: "Served in clear text" },
  );

  const hsts = h["strict-transport-security"];
  if (!https) add("hsts", "Strict-Transport-Security", "info", "Only meaningful over HTTPS");
  else if (!hsts) add("hsts", "Strict-Transport-Security", "bad", "Missing: browsers may reach the site over HTTP first");
  else {
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    add(
      "hsts",
      "Strict-Transport-Security",
      maxAge >= 15552000 ? "good" : "warn",
      maxAge >= 15552000 ? hsts : `max-age ${maxAge}s is under 6 months: ${hsts}`,
    );
  }

  const csp = h["content-security-policy"];
  const cspRo = h["content-security-policy-report-only"];
  if (!csp)
    add(
      "csp",
      "Content-Security-Policy",
      cspRo ? "warn" : "bad",
      cspRo ? "Report-only: nothing is enforced" : "Missing: no protection against injected scripts",
    );
  else {
    const issues: string[] = [];
    if (/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*('nonce-|'sha(256|384|512)-|'strict-dynamic')/.test(csp))
      issues.push("'unsafe-inline' scripts");
    if (/script-src[^;]*'unsafe-eval'/.test(csp)) issues.push("'unsafe-eval'");
    if (!/default-src|script-src/.test(csp)) issues.push("no default-src or script-src");
    if (/(default|script)-src[^;]*(\s|^)\*(\s|;|$)/.test(csp)) issues.push("wildcard source");
    if (!/object-src\s+'none'/.test(csp) && !/default-src\s+'none'/.test(csp)) issues.push("object-src not 'none'");
    if (!/frame-ancestors/.test(csp)) issues.push("no frame-ancestors");
    add("csp", "Content-Security-Policy", issues.length ? "warn" : "good", issues.length ? `Weak: ${issues.join(", ")}` : "Enforced");
  }

  const xfo = h["x-frame-options"];
  const frameAncestors = csp && /frame-ancestors/.test(csp);
  add(
    "framing",
    "Clickjacking (X-Frame-Options / frame-ancestors)",
    xfo || frameAncestors ? "good" : "bad",
    xfo ? `X-Frame-Options: ${xfo}` : frameAncestors ? "CSP frame-ancestors" : "Missing: the page can be framed by any site",
  );

  const xcto = h["x-content-type-options"];
  add("nosniff", "X-Content-Type-Options", xcto?.toLowerCase() === "nosniff" ? "good" : "warn", xcto ? xcto : "Missing: set it to nosniff");

  const rp = h["referrer-policy"];
  add(
    "referrer",
    "Referrer-Policy",
    rp ? (/unsafe-url|no-referrer-when-downgrade/.test(rp) ? "warn" : "good") : "warn",
    rp ?? "Missing: the browser default (strict-origin-when-cross-origin) applies",
  );

  const pp = h["permissions-policy"];
  add("permissions", "Permissions-Policy", pp ? "good" : "info", pp ? pp.slice(0, 160) : "Not set: features follow the browser defaults");

  const coop = h["cross-origin-opener-policy"];
  add("coop", "Cross-Origin-Opener-Policy", coop ? "good" : "info", coop ?? "Not set");
  const corp = h["cross-origin-resource-policy"];
  add("corp", "Cross-Origin-Resource-Policy", corp ? "good" : "info", corp ?? "Not set");

  const leaks = ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version"].filter((k) => h[k] && /\d/.test(h[k]!));
  add(
    "leak",
    "Version disclosure",
    leaks.length ? "warn" : "good",
    leaks.length ? leaks.map((k) => `${k}: ${h[k]}`).join(" · ") : "No server version in headers",
  );

  const acao = h["access-control-allow-origin"];
  if (acao === "*" && h["access-control-allow-credentials"] === "true") add("cors", "CORS", "bad", "Allow-Origin * with credentials");
  else if (acao) add("cors", "CORS", acao === "*" ? "warn" : "info", `Access-Control-Allow-Origin: ${acao}`);

  const weights: Record<Level, number> = { good: 1, warn: 0.5, bad: 0, info: 1 };
  const scored = checks.filter((c) => c.level !== "info");
  const score = Math.round((scored.reduce((s, c) => s + weights[c.level], 0) / Math.max(1, scored.length)) * 100);
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 45 ? "D" : score >= 30 ? "E" : "F";
  return { checks, grade, score };
}

/** Caching checks for the document response. */
export function cachingReport(raw: Record<string, string>): Check[] {
  const h = lower(raw);
  const out: Check[] = [];
  const cc = h["cache-control"];
  out.push({
    id: "cache-control",
    label: "Cache-Control",
    level: cc ? "info" : "warn",
    detail: cc ?? "Missing: caches pick their own heuristics",
  });
  if (h.etag || h["last-modified"])
    out.push({
      id: "validators",
      label: "Validators",
      level: "good",
      detail: [h.etag && `ETag ${h.etag}`, h["last-modified"] && `Last-Modified ${h["last-modified"]}`].filter(Boolean).join(" · "),
    });
  else out.push({ id: "validators", label: "Validators", level: "warn", detail: "No ETag or Last-Modified: no cheap revalidation" });
  if (h.age) out.push({ id: "age", label: "Age", level: "info", detail: `${h.age}s in a shared cache` });
  const hit = ["x-cache", "cf-cache-status", "x-vercel-cache", "x-nextjs-cache", "x-cache-status"].find((k) => h[k]);
  if (hit) out.push({ id: "cdn", label: "CDN cache", level: /hit/i.test(h[hit]!) ? "good" : "info", detail: `${hit}: ${h[hit]}` });
  const enc = h["content-encoding"];
  out.push({ id: "compression", label: "Compression", level: enc ? "good" : "warn", detail: enc ?? "None: enable gzip, br or zstd" });
  if (h.vary) out.push({ id: "vary", label: "Vary", level: "info", detail: h.vary });
  return out;
}
