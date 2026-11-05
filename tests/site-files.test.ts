import { describe, expect, it } from "vitest";
import { isAllowed, manifestChecks, parseRobots, parseSitemap } from "../src/lib/site-files";

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
