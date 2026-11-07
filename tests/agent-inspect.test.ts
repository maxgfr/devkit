import { describe, expect, it } from "vitest";
import {
  errorsMarkdown,
  fontsMarkdown,
  hasFindings,
  headersMarkdown,
  jsonLdMarkdown,
  linksMarkdown,
  NO_PROBLEM,
  perfMarkdown,
  seoMarkdown,
  siteFilesMarkdown,
} from "../src/lib/agent/inspect";
import { analyzeJsonLd } from "../src/lib/jsonld";
import type { MetaSnapshot, PerfSnapshot } from "../src/lib/page/collect";
import { parseRobots, parseSitemap } from "../src/lib/site-files";

const url = "https://ex.com/shop/mug";

const snap = (over: Partial<MetaSnapshot> = {}): MetaSnapshot => ({
  url,
  title: "A good title for the page",
  lang: "en",
  charset: "UTF-8",
  doctype: "<!DOCTYPE html>",
  meta: [
    { key: "description", value: "A description that is long enough to be useful for search engines and users." },
    { key: "viewport", value: "width=device-width" },
    ...["og:title", "og:description", "og:image", "og:url", "og:type"].map((key) => ({ key, value: "x" })),
  ],
  links: [
    { rel: "canonical", href: url },
    { rel: "icon", href: "/favicon.ico" },
  ],
  headings: [{ level: 1, text: "Mug" }],
  jsonLd: [],
  microdataTypes: [],
  stats: { elements: 10, scripts: 1, stylesheets: 1, images: 0, iframes: 0, forms: 0, domDepth: 4, htmlBytes: 100 },
  ...over,
});

const perf = (over: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  navigation: null,
  lcp: 1200,
  cls: 0.01,
  inp: null,
  fcp: 900,
  longTasks: { count: 0, total: 0 },
  resources: [],
  ...over,
});

describe("SEO report for agents", () => {
  it("says so when the page passes", () => {
    const md = seoMarkdown(snap(), { url });
    expect(md).toMatch(/^## SEO checks\nPage: https:\/\/ex.com\/shop\/mug\nResult: No problem found\./);
    expect(hasFindings(md)).toBe(false);
  });

  it("gives the tag to add, problems before warnings", () => {
    const md = seoMarkdown(snap({ meta: [{ key: "robots", value: "noindex" }], headings: [], links: [], title: "Mug" }), {
      url,
      heading: "###",
    });
    expect(md.startsWith("### SEO checks")).toBe(true);
    expect(md).toContain("#### To fix");
    expect(md).toContain('`<meta name="viewport" content="width=device-width, initial-scale=1">`');
    expect(md).toContain("remove `noindex`");
    expect(md).toContain(`\`<link rel="canonical" href="${url}">\``);
    expect(md.indexOf("#### To fix")).toBeLessThan(md.indexOf("#### Worth checking"));
    expect(md).toMatch(/Result: \d+ problems, \d+ warnings/);
    expect(hasFindings(md)).toBe(true);
  });
});

describe("JSON-LD report for agents", () => {
  it("reports the block, path and message, and the parse error with a snippet", () => {
    const report = analyzeJsonLd([
      {
        raw: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Mug",
          offers: { "@type": "Offer", price: "€12" },
        }),
        index: 0,
      },
      { raw: '{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Acme",\n}', index: 1 },
    ]);
    const md = jsonLdMarkdown(report, { url });
    expect(md).toContain("## Structured data (JSON-LD)");
    expect(md).toMatch(/Result: \d+ errors?, \d+ warnings? in 2 blocks\./);
    expect(md).toContain('Block #1 (Offer), `#1.offers.price`: price "€12" must be a plain number');
    expect(md).toContain("Block #1 (Offer), `#1.offers`: Offer: missing required priceCurrency");
    expect(md).toMatch(/Block #2, `#2`: Invalid JSON, .*line 5,? column 1/);
    expect(md).toContain('      4 |   "name": "Acme",');
    expect(md).toContain("search.google.com/test/rich-results");
  });

  it("says when there is no JSON-LD", () => {
    const md = jsonLdMarkdown(analyzeJsonLd([]), { url });
    expect(md).toContain(`Result: ${NO_PROBLEM} The page has no JSON-LD.`);
    expect(hasFindings(md)).toBe(false);
  });
});

describe("headers report for agents", () => {
  it("gives the header lines to add", () => {
    const md = headersMarkdown({ status: 200, url, redirected: false, ms: 120, headers: { server: "Apache/2.4.1" } }, { url });
    expect(md).toContain("## Response headers");
    expect(md).toMatch(/Result: Security grade [A-F] \(\d+\/100\): \d+ problems/);
    expect(md).toContain("`Strict-Transport-Security: max-age=31536000; includeSubDomains`");
    expect(md).toContain("`X-Content-Type-Options: nosniff`");
    expect(md).toContain("Caching, Compression");
    expect(md).toContain("server_tokens off;");
  });

  it("explains each weakness of an existing policy", () => {
    const md = headersMarkdown(
      {
        status: 200,
        url,
        redirected: false,
        ms: 80,
        headers: { "content-security-policy": "script-src 'self' 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'" },
      },
      { url },
    );
    expect(md).toContain("Current: `script-src 'self' 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'`");
    expect(md).toContain("Fix: remove `'unsafe-eval'`");
  });
});

describe("performance report for agents", () => {
  it("names the failing vitals against their thresholds and the heavy resources", () => {
    const md = perfMarkdown(
      perf({
        lcp: 4800,
        cls: 0.15,
        longTasks: { count: 4, total: 900 },
        resources: [
          {
            name: "https://ex.com/hero.jpg",
            type: "img",
            transfer: 900_000,
            decoded: 900_000,
            duration: 700,
            startTime: 300,
            responseStart: 0,
          },
          {
            name: "https://ex.com/app.js?token=abcdef123456",
            type: "script",
            transfer: 20_000,
            decoded: 60_000,
            duration: 90,
            startTime: 100,
            responseStart: 0,
          },
        ],
      }),
      { url },
    );
    expect(md).toContain("LCP (Largest Contentful Paint) is 4.8 s: poor (good up to 2.5 s, poor above 4 s).");
    expect(md).toContain("CLS (Cumulative Layout Shift) is 0.150: needs improvement");
    expect(md).toContain("Largest images on the page: `https://ex.com/hero.jpg` (879 KB)");
    expect(md).toContain("Heavy image: `https://ex.com/hero.jpg`");
    expect(md).toContain("4 long tasks blocked the main thread for 900 ms");
    expect(md).toMatch(/Result: 1 problem, \d+ warnings\. Core Web Vitals: Poor: LCP 4\.8 s\./);
    expect(md).toContain("token=[redacted]");
    expect(md).not.toContain("abcdef123456");
  });

  it("is clean when every vital is good", () => {
    const md = perfMarkdown(perf(), { url });
    expect(md).toContain(`Result: ${NO_PROBLEM} Core Web Vitals: Good`);
    expect(hasFindings(md)).toBe(false);
  });
});

describe("console errors report for agents", () => {
  it("lists message, source and stack with counts, in capture order", () => {
    const md = errorsMarkdown(
      {
        installed: true,
        errors: [
          {
            kind: "rejection",
            message: "Unhandled rejection: Error: 500",
            stack: "Error: 500\n    at load (https://ex.com/assets/api.js:3:9)",
            time: 2,
            count: 1,
          },
          {
            kind: "error",
            message: "TypeError: cart is undefined",
            source: "https://ex.com/assets/app.js",
            line: 12,
            column: 5,
            stack: "TypeError: cart is undefined\n    at render (https://ex.com/assets/app.js:12:5)",
            time: 1,
            count: 3,
          },
        ],
      },
      { url },
    );
    expect(md).toContain("Result: 4 errors captured (2 distinct messages).");
    expect(md).toContain("1. Uncaught error (×3): `TypeError: cart is undefined`");
    expect(md).toContain("Source: `https://ex.com/assets/app.js:12:5` (path `assets/app.js`)");
    expect(md).toContain("   ```\n   TypeError: cart is undefined\n       at render");
    expect(md).toContain("2. Unhandled rejection: `Unhandled rejection: Error: 500`");
  });

  it("says when capture is not running", () => {
    const md = errorsMarkdown({ installed: false, errors: [] }, { url });
    expect(md).toContain("Result: Not measured: devkit's error capture is not running on this page.");
    expect(hasFindings(md)).toBe(false);
  });
});

describe("links report for agents", () => {
  it("lists broken links with their text and a selector, redirects to check", () => {
    const md = linksMarkdown(
      [
        { href: "https://ex.com/old-page", text: "Pricing", status: 404 },
        { href: "https://ex.com/", text: "Home", status: 200 },
        { href: "http://other.test/a", text: "", status: 200, detail: "→ https://other.test/a" },
        { href: "https://linked.test/x", text: "Profile", status: 999 },
        { href: "https://dead.test/", text: "Old partner", status: "error", detail: "timeout" },
      ],
      { url },
    );
    expect(md).toContain("Result: 2 broken, 1 redirected, 1 to check by hand, out of 5 links checked.");
    expect(md).toContain("1. HTTP 404: `https://ex.com/old-page`");
    expect(md).toContain('Link text: "Pricing"');
    expect(md).toContain('Find it: `a[href*="/old-page"]`');
    expect(md).toContain("No answer (timeout): `https://dead.test/`");
    expect(md).toContain("`http://other.test/a` redirects to `https://other.test/a`");
  });

  it("says when nothing was checked", () => {
    const md = linksMarkdown([], { url });
    expect(md).toContain("Result: Not checked yet");
    expect(hasFindings(md)).toBe(false);
  });
});

describe("fonts report for agents", () => {
  it("reports failed font faces and a failing contrast pair", () => {
    const md = fontsMarkdown(
      {
        fonts: [
          { family: "Inter", weight: "400", style: "normal", status: "loaded" },
          { family: "Brand", weight: "700", style: "normal", status: "error" },
        ],
        families: [{ family: "Inter", count: 40 }],
        colors: [{ color: "rgb(17, 17, 17)", count: 30 }],
      },
      { url, contrast: { fg: "#999999", bg: "#ffffff" } },
    );
    expect(md).toContain("Result: 2 problems");
    expect(md).toContain("Font face `Brand` 700 normal failed to load.");
    expect(md).toMatch(/Text `#999999` on `#ffffff` has a contrast of 2\.\d+:1: fails WCAG AA/);
    expect(md).toContain("Most used colors: #111111 (30)");
  });
});

describe("site files report for agents", () => {
  it("flags a page blocked by robots.txt and a sitemap that does not list it", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /shop\nSitemap: https://ex.com/sitemap.xml");
    const sitemap = parseSitemap(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ex.com/</loc></url></urlset>',
    );
    const md = siteFilesMarkdown(
      {
        robots: { status: 200, parsed: robots },
        sitemap: { url: "https://ex.com/sitemap.xml", status: 200, parsed: sitemap },
        manifest: { href: "https://ex.com/app.webmanifest", status: 200, json: { name: "Shop" } },
      },
      { url },
    );
    expect(md).toContain("## robots.txt, sitemap and manifest");
    expect(md).toContain("This page (`/shop/mug`) is blocked for Googlebot by `Disallow: /shop` in robots.txt.");
    expect(md).toContain("This page is not listed in `https://ex.com/sitemap.xml`.");
    expect(md).toContain('start_url: missing; add `"start_url": "/"`');
  });

  it("suggests a robots.txt when there is none", () => {
    const md = siteFilesMarkdown({ robots: { status: 404, parsed: null }, manifest: { href: null } }, { url });
    expect(md).toContain("No robots.txt: `https://ex.com/robots.txt` answers HTTP 404");
    expect(md).toContain("   User-agent: *\n   Allow: /");
    expect(md).toContain("Not checked: sitemap.");
  });
});
