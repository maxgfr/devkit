import { describe, expect, it } from "vitest";
import { EXTERNAL_TOOLS, isAllowed, manifestChecks, parseRobots, parseSitemap, TOOL_GROUPS } from "../src/lib/site-files";

describe("external tools", () => {
  const page = "https://www.exämple.de/größe/😀?q=a b&lang=de#top";
  const href = new URL(page).href;
  const tool = (name: string) => EXTERNAL_TOOLS.find((t) => t.name === name)!.url(page);
  it("groups every tool", () => {
    expect(new Set(EXTERNAL_TOOLS.map((t) => t.group))).toEqual(new Set(TOOL_GROUPS));
    for (const name of [
      "GTmetrix",
      "W3C CSS validator",
      "WAVE accessibility",
      "Facebook Sharing Debugger",
      "LinkedIn Post Inspector",
      "Ahrefs Site Explorer",
      "Sistrix Visibility Index",
      "WHOIS",
    ])
      expect(EXTERNAL_TOOLS.some((t) => t.name === name)).toBe(true);
  });
  it("passes the full URL, encoded, to URL-based tools", () => {
    expect(href).toBe("https://www.xn--exmple-cua.de/gr%C3%B6%C3%9Fe/%F0%9F%98%80?q=a%20b&lang=de#top");
    for (const [name, param] of [
      ["PageSpeed Insights", "url"],
      ["GTmetrix", "url"],
      ["W3C CSS validator", "uri"],
      ["W3C HTML validator", "doc"],
      ["Facebook Sharing Debugger", "q"],
    ] as const)
      expect(new URL(tool(name)).searchParams.get(param), name).toBe(href);
    expect(tool("Facebook Sharing Debugger")).toBe(`https://developers.facebook.com/tools/debug/?q=${encodeURIComponent(href)}`);
    expect(tool("LinkedIn Post Inspector")).toBe(`https://www.linkedin.com/post-inspector/inspect/${encodeURIComponent(href)}`);
    expect(decodeURIComponent(new URL(tool("LinkedIn Post Inspector")).pathname.split("/inspect/")[1]!)).toBe(href);
    expect(tool("WAVE accessibility")).toBe(`https://wave.webaim.org/report#/${href}`);
    // The page's own query string stays inside the tool's parameter.
    expect(new URL(tool("W3C CSS validator")).searchParams.get("lang")).toBeNull();
  });
  it("passes the host or the domain to domain tools", () => {
    expect(tool("WHOIS")).toBe("https://who.is/whois/xn--exmple-cua.de");
    expect(tool("Sistrix Visibility Index")).toBe("https://app.sistrix.com/en/visibility-index/xn--exmple-cua.de");
    expect(new URL(tool("Ahrefs Site Explorer")).searchParams.get("target")).toBe("www.xn--exmple-cua.de");
  });
  it("says which tools need the URL pasted", () => {
    expect(EXTERNAL_TOOLS.filter((t) => t.pasteUrl).map((t) => t.name)).toEqual(["GTmetrix"]);
  });
});

describe("robots.txt", () => {
  const robots = parseRobots(`# comment
User-agent: Googlebot
User-agent: Bingbot
Disallow: /private
Allow: /private/public

User-agent: *
Disallow: /
Sitemap: https://ex.com/sitemap.xml`);
  it("groups agents and finds sitemaps", () => {
    expect(robots.groups[0]!.agents).toEqual(["Googlebot", "Bingbot"]);
    expect(robots.sitemaps).toEqual(["https://ex.com/sitemap.xml"]);
  });
  it("applies the longest match", () => {
    expect(isAllowed(robots, "Googlebot", "/private/x").allowed).toBe(false);
    expect(isAllowed(robots, "Googlebot", "/private/public/a").allowed).toBe(true);
    expect(isAllowed(robots, "OtherBot", "/anything").allowed).toBe(false);
  });
});

describe("sitemap & manifest", () => {
  it("parses url sets and indexes", () => {
    const s = parseSitemap(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ex.com/</loc><lastmod>2026-01-01</lastmod></url></urlset>',
    );
    expect(s).toEqual({ kind: "urlset", urls: [{ loc: "https://ex.com/", lastmod: "2026-01-01" }] });
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://ex.com/a.xml</loc></sitemap></sitemapindex>").kind).toBe("sitemapindex");
  });
  it("checks installability", () => {
    const checks = manifestChecks({
      name: "App",
      start_url: "/",
      display: "standalone",
      icons: [{ sizes: "192x192" }, { sizes: "512x512", purpose: "maskable" }],
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(["theme_color", "background_color", "id"]);
  });
});
