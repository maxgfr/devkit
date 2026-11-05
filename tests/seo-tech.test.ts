import { describe, expect, it } from "vitest";
import type { MetaSnapshot, TechSignals } from "../src/lib/page/collect";
import { seoReport, socialPreview } from "../src/lib/seo";
import { detectTech } from "../src/lib/tech";

const snap = (over: Partial<MetaSnapshot> = {}): MetaSnapshot => ({
  url: "https://ex.com/a",
  title: "A good title for the page",
  lang: "en",
  charset: "UTF-8",
  doctype: "<!DOCTYPE html>",
  meta: [
    { key: "description", value: "A description that is long enough to be useful for search engines and users." },
    { key: "viewport", value: "width=device-width" },
    { key: "og:title", value: "OG" },
  ],
  links: [{ rel: "canonical", href: "https://ex.com/a" }],
  headings: [{ level: 1, text: "Hello" }],
  jsonLd: [],
  microdataTypes: [],
  stats: { elements: 10, scripts: 1, stylesheets: 1, images: 0, iframes: 0, forms: 0, domDepth: 4, htmlBytes: 100 },
  ...over,
});

describe("SEO report", () => {
  it("passes a decent page and flags noindex", () => {
    const ok = seoReport(snap());
    expect(ok.find((c) => c.id === "title")!.level).toBe("good");
    expect(ok.find((c) => c.id === "canonical")!.detail).toMatch(/Self-referencing/);
    const noindex = seoReport(snap({ meta: [...snap().meta, { key: "robots", value: "noindex, nofollow" }] }));
    expect(noindex.find((c) => c.id === "robots")!.level).toBe("bad");
  });

  it("falls back from Open Graph to meta description", () => {
    expect(socialPreview(snap())).toMatchObject({ title: "OG", site: "ex.com" });
  });
});

describe("tech detection", () => {
  const signals: TechSignals = {
    globals: ["__NEXT_DATA__", "__react_dom__", "dataLayer"],
    generator: [],
    scripts: ["https://www.googletagmanager.com/gtm.js?id=X"],
    attributes: ["#__next"],
    classSample: [],
  };
  it("finds frameworks, analytics and hosting", () => {
    const names = detectTech(signals, { "x-vercel-id": "cdg1::abc", server: "Vercel" }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Next.js", "React", "Google Tag Manager", "Vercel"]));
  });
  it("reads the Angular version", () => {
    const t = detectTech({ globals: [], generator: [], scripts: [], attributes: ["[ng-version]", "ng-version=18.2.0"], classSample: [] });
    expect(t[0]!.name).toBe("Angular 18.2.0");
  });
});
