// Who the page loads from, and the integrity, CORS, mixed content and framing checks on those loads.
import type { Level } from "../headers";
import type { SurfaceSnapshot } from "../page/security";

/**
 * Multi-part public suffixes common enough to matter. An approximation of the Public Suffix List,
 * which is too large to ship: unknown suffixes fall back to the last two labels.
 */
const MULTI_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "org.za",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "com.ar",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "com.tr",
  "com.ua",
  "co.il",
  "co.id",
  "com.my",
  "com.ph",
  "com.vn",
  "com.pl",
  "gouv.fr",
  "asso.fr",
  // Hosting platforms where every subdomain is a different owner.
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "s3.amazonaws.com",
  "blogspot.com",
  "onrender.com",
  "fly.dev",
]);

/** Approximate registrable domain ("site") of a host name: `cdn.shop.example.co.uk` → `example.co.uk`. */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.split(".");
  for (let take = 3; take >= 2; take--) {
    if (labels.length > take && MULTI_SUFFIXES.has(labels.slice(-take).join("."))) return labels.slice(-(take + 1)).join(".");
  }
  if (labels.length >= 2 && MULTI_SUFFIXES.has(labels.slice(-2).join("."))) return host;
  return labels.slice(-2).join(".");
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) || /^wss?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export interface SiteGroup {
  site: string;
  firstParty: boolean;
  hosts: string[];
  requests: number;
  bytes: number;
  /** Requests whose size the browser hides (cross-origin without Timing-Allow-Origin, or served from cache). */
  hiddenSize: number;
  types: Record<string, number>;
}

/** Resource timing grouped by site, heaviest first; the page's own site first. */
export function groupBySite(snap: SurfaceSnapshot): SiteGroup[] {
  const pageHost = hostOf(snap.url) ?? "";
  const pageSite = siteOf(pageHost);
  const groups = new Map<string, SiteGroup & { hostSet: Set<string> }>();
  for (const r of snap.resources) {
    const host = hostOf(r.name);
    if (!host) continue;
    const site = siteOf(host);
    const g = groups.get(site) ?? {
      site,
      firstParty: site === pageSite,
      hosts: [],
      hostSet: new Set<string>(),
      requests: 0,
      bytes: 0,
      hiddenSize: 0,
      types: {},
    };
    g.hostSet.add(host);
    g.requests++;
    const size = r.transfer || r.encoded;
    if (size) g.bytes += size;
    else g.hiddenSize++;
    g.types[r.type] = (g.types[r.type] ?? 0) + 1;
    groups.set(site, g);
  }
  return [...groups.values()]
    .map(({ hostSet, ...g }) => ({ ...g, hosts: [...hostSet].sort() }))
    .sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || b.bytes - a.bytes || b.requests - a.requests);
}

export interface SurfaceFinding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  url?: string;
}

const normCors = (v: string | null) => (v === null ? null : v === "use-credentials" ? "use-credentials" : "anonymous");

/** Subresource integrity, crossorigin, mixed content and iframe sandbox checks. */
export function surfaceFindings(snap: SurfaceSnapshot): SurfaceFinding[] {
  const out: SurfaceFinding[] = [];
  const pageOrigin = originOf(snap.url);
  const https = snap.url.startsWith("https:");
  const cross = (u: string) => {
    const o = originOf(u);
    return Boolean(o) && o !== "null" && o !== pageOrigin;
  };
  const tags = [
    ...snap.scripts.map((s) => ({ tag: "script", url: s.src, integrity: s.integrity, crossorigin: s.crossorigin })),
    ...snap.styles.map((s) => ({ tag: "stylesheet", url: s.href, integrity: s.integrity, crossorigin: s.crossorigin })),
  ];
  for (const t of tags) {
    if (!cross(t.url)) continue;
    if (!t.integrity)
      out.push({
        id: `sri:${t.url}`,
        level: "warn",
        title: `Cross-origin ${t.tag} without integrity`,
        detail: "If that host is compromised, its code runs on your page. Pin the file with an integrity hash (Utils › Hash & SRI).",
        url: t.url,
      });
    else if (t.crossorigin === null)
      out.push({
        id: `cors:${t.url}`,
        level: "bad",
        title: `integrity without crossorigin on a ${t.tag}`,
        detail: 'A cross-origin file with integrity must be fetched with CORS (crossorigin="anonymous"), otherwise the browser blocks it.',
        url: t.url,
      });
  }
  const used = new Map(tags.map((t) => [t.url, normCors(t.crossorigin)]));
  for (const p of snap.preloads) {
    if (p.as === "font" && p.crossorigin === null)
      out.push({
        id: `preload-font:${p.href}`,
        level: "warn",
        title: "Font preload without crossorigin",
        detail: "Fonts are always fetched in CORS mode: without crossorigin the preload is wasted and the font downloads twice.",
        url: p.href,
      });
    else if (used.has(p.href) && used.get(p.href) !== normCors(p.crossorigin))
      out.push({
        id: `preload-cors:${p.href}`,
        level: "warn",
        title: "crossorigin differs between the preload and the tag",
        detail: "The preloaded response cannot be reused: the file is downloaded twice.",
        url: p.href,
      });
  }
  if (https) {
    const seen = new Set<string>();
    for (const i of [
      ...snap.insecure,
      ...snap.resources.filter((r) => r.name.startsWith("http:")).map((r) => ({ tag: r.type, url: r.name })),
    ]) {
      if (seen.has(i.url)) continue;
      seen.add(i.url);
      const active = /^(script|iframe|link|object|embed|form|css|xmlhttprequest|fetch)$/.test(i.tag);
      out.push({
        id: `mixed:${i.url}`,
        level: active ? "bad" : "warn",
        title: `Mixed content (${i.tag})`,
        detail: active
          ? "An http:// load on an https page: blocked by the browser, or open to tampering on the network."
          : "An http:// load on an https page: upgraded or blocked by the browser, and visible on the network.",
        url: i.url,
      });
    }
  }
  for (const f of snap.iframes) {
    if (f.sandbox !== null || !cross(f.src)) continue;
    out.push({
      id: `sandbox:${f.src}`,
      level: "info",
      title: "Cross-origin iframe without sandbox",
      detail: "Fine for trusted embeds; sandbox limits what a third-party frame may do (scripts, popups, top navigation).",
      url: f.src,
    });
  }
  return out;
}
