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

/** The group that applies to `agent`: the one naming the longest token the agent contains, else `*`. */
function groupFor(robots: Robots, agent: string): RobotsGroup | undefined {
  const a = agent.toLowerCase();
  let best: { group: RobotsGroup; len: number } | undefined;
  for (const g of robots.groups)
    for (const x of g.agents) {
      const token = x.toLowerCase();
      if (token && token !== "*" && a.includes(token) && (!best || token.length > best.len)) best = { group: g, len: token.length };
    }
  return best?.group ?? robots.groups.find((g) => g.agents.includes("*"));
}

/** Whether robots.txt has a group naming `agent` itself, rather than leaving it to `User-agent: *`. */
export function hasOwnGroup(robots: Robots, agent: string): boolean {
  const group = groupFor(robots, agent);
  return Boolean(group && !group.agents.includes("*"));
}

/**
 * Whether `agent` may fetch `path`, by Google's rules: the group with the most specific user-agent token applies,
 * the longest matching rule wins, allow wins a tie.
 */
export function isAllowed(robots: Robots, agent: string, path: string): { allowed: boolean; rule?: string } {
  const group = groupFor(robots, agent);
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

export type ToolGroup = "Structured data" | "Performance" | "Validation" | "Social" | "SEO & domain" | "Security";

export const TOOL_GROUPS: ToolGroup[] = ["Structured data", "Performance", "Validation", "Social", "SEO & domain", "Security"];

export interface ExternalTool {
  name: string;
  group: ToolGroup;
  url: (pageUrl: string) => string;
  /** The site does not take the URL from the link: devkit copies it to paste in the site's form. */
  pasteUrl?: boolean;
  /** Shown under the name, e.g. that the tool needs a sign-in. */
  note?: string;
}

/** `u` as the browser would send it: spaces, umlauts and emoji percent-encoded, the host in punycode. */
const href = (u: string) => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};
const host = (u: string) => new URL(u).hostname;
/** The domain for domain-level tools (Sistrix, WHOIS): the hostname without a leading "www.". */
const domain = (u: string) => host(u).replace(/^www\./, "");
const q = (u: string) => encodeURIComponent(href(u));

// The W3C CSS, WAVE, Facebook, LinkedIn, Sistrix and WHOIS patterns were opened in Chrome (November 2026) and
// show the page's result. GTmetrix ignores a URL parameter, hence pasteUrl; Ahrefs keeps the target only when
// signed in (signed out, it lands on its Site Explorer page).
export const EXTERNAL_TOOLS: ExternalTool[] = [
  { name: "Rich Results Test", group: "Structured data", url: (u) => `https://search.google.com/test/rich-results?url=${q(u)}` },
  { name: "Schema.org validator", group: "Structured data", url: (u) => `https://validator.schema.org/#url=${q(u)}` },
  { name: "PageSpeed Insights", group: "Performance", url: (u) => `https://pagespeed.web.dev/analysis?url=${q(u)}` },
  { name: "GTmetrix", group: "Performance", url: (u) => `https://gtmetrix.com/?url=${q(u)}`, pasteUrl: true },
  { name: "WebPageTest", group: "Performance", url: (u) => `https://www.webpagetest.org/?url=${q(u)}` },
  { name: "W3C HTML validator", group: "Validation", url: (u) => `https://validator.w3.org/nu/?doc=${q(u)}` },
  { name: "W3C CSS validator", group: "Validation", url: (u) => `https://jigsaw.w3.org/css-validator/validator?uri=${q(u)}` },
  { name: "WAVE accessibility", group: "Validation", url: (u) => `https://wave.webaim.org/report#/${href(u)}` },
  { name: "Facebook Sharing Debugger", group: "Social", url: (u) => `https://developers.facebook.com/tools/debug/?q=${q(u)}` },
  { name: "LinkedIn Post Inspector", group: "Social", url: (u) => `https://www.linkedin.com/post-inspector/inspect/${q(u)}` },
  { name: "Open Graph debugger (opengraph.xyz)", group: "Social", url: (u) => `https://www.opengraph.xyz/url/${q(u)}` },
  {
    name: "Ahrefs Site Explorer",
    group: "SEO & domain",
    url: (u) => `https://app.ahrefs.com/site-explorer/overview/v2/subdomains/live?target=${encodeURIComponent(host(u))}`,
    note: "needs an Ahrefs sign-in",
  },
  {
    name: "Sistrix Visibility Index",
    group: "SEO & domain",
    url: (u) => `https://app.sistrix.com/en/visibility-index/${encodeURIComponent(domain(u))}`,
  },
  { name: "WHOIS", group: "SEO & domain", url: (u) => `https://who.is/whois/${encodeURIComponent(domain(u))}` },
  { name: "DNS (dnschecker)", group: "SEO & domain", url: (u) => `https://dnschecker.org/#A/${host(u)}` },
  { name: "BuiltWith", group: "SEO & domain", url: (u) => `https://builtwith.com/${host(u)}` },
  { name: "Wayback Machine", group: "SEO & domain", url: (u) => `https://web.archive.org/web/*/${href(u)}` },
  { name: "Security headers", group: "Security", url: (u) => `https://securityheaders.com/?q=${q(u)}&followRedirects=on` },
  {
    name: "Mozilla Observatory",
    group: "Security",
    url: (u) => `https://developer.mozilla.org/en-US/observatory/analyze?host=${encodeURIComponent(host(u))}`,
  },
  { name: "SSL Labs", group: "Security", url: (u) => `https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(host(u))}` },
];
