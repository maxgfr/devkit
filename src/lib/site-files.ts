// robots.txt, sitemaps and the web app manifest of a site.

export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay?: string;
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
  other: string[];
}

export function parseRobots(text: string): Robots {
  const robots: Robots = { groups: [], sitemaps: [], other: [] };
  let group: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    if (!clean) continue;
    const idx = clean.indexOf(":");
    if (idx < 0) continue;
    const key = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!group || !lastWasAgent) {
        group = { agents: [], allow: [], disallow: [] };
        robots.groups.push(group);
      }
      group.agents.push(value);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") robots.sitemaps.push(value);
    else if (group && key === "allow") group.allow.push(value);
    else if (group && key === "disallow") group.disallow.push(value);
    else if (group && key === "crawl-delay") group.crawlDelay = value;
    else robots.other.push(clean);
  }
  return robots;
}

const patternToRegex = (p: string) =>
  new RegExp(
    `^${p
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\\\$$/, "$")}`,
  );

/** Whether `agent` may fetch `path`, by Google's rules: the longest matching rule wins, allow wins a tie. */
export function isAllowed(robots: Robots, agent: string, path: string): { allowed: boolean; rule?: string } {
  const a = agent.toLowerCase();
  const group =
    robots.groups.find((g) => g.agents.some((x) => x.toLowerCase() !== "*" && a.includes(x.toLowerCase()))) ??
    robots.groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true };
  let best: { len: number; allow: boolean; rule: string } | null = null;
  for (const [list, allow] of [
    [group.allow, true],
    [group.disallow, false],
  ] as const) {
    for (const rule of list) {
      if (!rule) continue;
      if (patternToRegex(rule).test(path) && (!best || rule.length > best.len || (rule.length === best.len && allow)))
        best = { len: rule.length, allow, rule };
    }
  }
  return best ? { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.rule}` } : { allowed: true };
}

export interface Sitemap {
  kind: "urlset" | "sitemapindex" | "unknown";
  urls: { loc: string; lastmod?: string }[];
}

export function parseSitemap(xml: string): Sitemap {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement?.localName;
  const kind = root === "urlset" || root === "sitemapindex" ? root : "unknown";
  const tag = kind === "sitemapindex" ? "sitemap" : "url";
  const byName = (root: Element | Document, name: string) =>
    Array.from(root.getElementsByTagName("*")).filter((el) => el.localName === name);
  const urls = byName(doc, tag).map((el) => ({
    loc: byName(el, "loc")[0]?.textContent?.trim() ?? "",
    lastmod: byName(el, "lastmod")[0]?.textContent?.trim() || undefined,
  }));
  return { kind, urls: urls.filter((u) => u.loc) };
}

export interface ManifestCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** What Chrome needs to offer installing the app, checked against a parsed manifest. */
export function manifestChecks(m: Record<string, unknown>): ManifestCheck[] {
  const icons = (Array.isArray(m.icons) ? m.icons : []) as { sizes?: string; purpose?: string; src?: string }[];
  const sizes = icons.flatMap((i) => (i.sizes ?? "").split(/\s+/));
  const display = String(m.display ?? "browser");
  return [
    { label: "name or short_name", ok: Boolean(m.name || m.short_name), detail: String(m.name ?? m.short_name ?? "missing") },
    { label: "start_url", ok: Boolean(m.start_url), detail: String(m.start_url ?? "missing") },
    { label: "display", ok: ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].includes(display), detail: display },
    { label: "192px icon", ok: sizes.includes("192x192") || sizes.includes("any"), detail: sizes.join(", ") || "no icons" },
    { label: "512px icon", ok: sizes.includes("512x512") || sizes.includes("any"), detail: sizes.join(", ") || "no icons" },
    {
      label: "maskable icon",
      ok: icons.some((i) => /maskable/.test(i.purpose ?? "")),
      detail: icons.some((i) => /maskable/.test(i.purpose ?? "")) ? "yes" : "none (Android crops the icon)",
    },
    { label: "theme_color", ok: Boolean(m.theme_color), detail: String(m.theme_color ?? "missing") },
    { label: "background_color", ok: Boolean(m.background_color), detail: String(m.background_color ?? "missing") },
    { label: "id", ok: Boolean(m.id), detail: String(m.id ?? "missing (start_url is used)") },
  ];
}

export interface ExternalTool {
  name: string;
  url: (pageUrl: string) => string;
}

export const EXTERNAL_TOOLS: ExternalTool[] = [
  { name: "PageSpeed Insights", url: (u) => `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(u)}` },
  { name: "Rich Results Test", url: (u) => `https://search.google.com/test/rich-results?url=${encodeURIComponent(u)}` },
  { name: "Schema.org validator", url: (u) => `https://validator.schema.org/#url=${encodeURIComponent(u)}` },
  { name: "W3C HTML validator", url: (u) => `https://validator.w3.org/nu/?doc=${encodeURIComponent(u)}` },
  { name: "Security headers", url: (u) => `https://securityheaders.com/?q=${encodeURIComponent(u)}&followRedirects=on` },
  {
    name: "Mozilla Observatory",
    url: (u) => `https://developer.mozilla.org/en-US/observatory/analyze?host=${encodeURIComponent(new URL(u).hostname)}`,
  },
  { name: "SSL Labs", url: (u) => `https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(new URL(u).hostname)}` },
  { name: "WebPageTest", url: (u) => `https://www.webpagetest.org/?url=${encodeURIComponent(u)}` },
  { name: "Wayback Machine", url: (u) => `https://web.archive.org/web/*/${u}` },
  { name: "Open Graph debugger (opengraph.xyz)", url: (u) => `https://www.opengraph.xyz/url/${encodeURIComponent(u)}` },
  { name: "DNS (dnschecker)", url: (u) => `https://dnschecker.org/#A/${new URL(u).hostname}` },
  { name: "BuiltWith", url: (u) => `https://builtwith.com/${new URL(u).hostname}` },
];
