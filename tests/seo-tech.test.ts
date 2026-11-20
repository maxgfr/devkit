import { describe, expect, it } from "vitest";
import { hreflangCodeProblems, hreflangReport, isLanguage, isRegion, sameUrl } from "../src/lib/hreflang";
import { collectMeta, type MetaSnapshot, type PageContent, type TechSignals } from "../src/lib/page/collect";
import {
  indexability,
  pageCounts,
  robotsText,
  seoCounters,
  seoIssues,
  seoReport,
  seoTextReport,
  socialPreview,
  xRobotsForGoogle,
} from "../src/lib/seo";
import {
  imageChecks,
  LENGTH_LIMITS,
  lengthCount,
  NETWORKS,
  networkCard,
  socialChecklist,
  socialMistakes,
  truncate,
} from "../src/lib/social";
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

const og = (over: Record<string, string> = {}) =>
  Object.entries({
    "og:title": "Acme Mug",
    "og:description": "The best mug.",
    "og:image": "https://ex.com/og.png",
    "og:url": "https://ex.com/a",
    "og:type": "website",
    ...over,
  })
    .filter(([, value]) => value !== "")
    .map(([key, value]) => ({ key, value, attr: "property" as const }));

const content = (over: Partial<PageContent> = {}): PageContent => ({
  words: 120,
  images: [
    { alt: "Mug", title: false },
    { alt: null, title: false },
    { alt: "", title: true },
  ],
  links: [
    { href: "https://ex.com/a", rel: "" },
    { href: "https://www.ex.com/b", rel: "" },
    { href: "https://ex.com/a", rel: "" },
    { href: "https://blog.ex.com/", rel: "" },
    { href: "https://other.org/", rel: "nofollow noopener" },
  ],
  anchors: 5,
  ...over,
});

describe("SEO issues", () => {
  const ids = (s: MetaSnapshot) => seoReport(s).map((c) => c.id);
  it("counts images without alt as a share of all images", () => {
    const c = seoReport(snap({ content: content() })).find((x) => x.id === "images-alt")!;
    expect(c).toMatchObject({ level: "warn", detail: "1 of 3 images has no alt text." });
    const ok = seoReport(snap({ content: content({ images: [{ alt: "a", title: false }] }) })).find((x) => x.id === "images-alt")!;
    expect(ok.level).toBe("good");
    expect(ids(snap())).not.toContain("images-alt");
  });

  it("says a long description may be truncated and a short one is short, with the count", () => {
    const long = seoReport(snap({ meta: [{ key: "description", value: "x".repeat(171) }] })).find((c) => c.id === "description")!;
    expect(long).toMatchObject({ level: "info" });
    expect(long.detail).toMatch(/^Long \(171 chars\); it may be truncated/);
    const short = seoReport(snap({ meta: [{ key: "description", value: "Short" }] })).find((c) => c.id === "description")!;
    expect(short.level).toBe("warn");
    expect(short.detail).toMatch(/5 chars/);
    const title = seoReport(snap({ title: "t".repeat(61) })).find((c) => c.id === "title")!;
    expect(title).toMatchObject({ level: "info" });
  });

  it("lists the recommended Open Graph tags still missing", () => {
    const c = seoReport(snap({ meta: [...snap().meta, ...og()] })).find((x) => x.id === "og-recommended")!;
    expect(c.detail).toBe("Open Graph could still add: og:site_name, og:locale, og:image:alt, og:image:width, og:image:height.");
    const full = og({
      "og:site_name": "Acme",
      "og:locale": "en_US",
      "og:image:alt": "A mug",
      "og:image:width": "1200",
      "og:image:height": "630",
    });
    expect(ids(snap({ meta: full }))).not.toContain("og-recommended");
  });

  it("puts problems before warnings before hints", () => {
    const issues = seoIssues(seoReport(snap({ title: "", meta: [{ key: "description", value: "x".repeat(200) }] })));
    expect(issues.map((c) => c.level)).toEqual([...issues.map((c) => c.level)].sort((a, b) => "bwi".indexOf(a[0]!) - "bwi".indexOf(b[0]!)));
    expect(issues.every((c) => c.level !== "good")).toBe(true);
    expect(issues.map((c) => c.id)).not.toEqual(expect.arrayContaining(["manifest"]));
    expect(issues.some((c) => c.id === "jsonld" || c.id === "twitter")).toBe(false);
  });

  it("flags noindex from the googlebot meta and the none directive", () => {
    expect(seoReport(snap({ meta: [{ key: "robots", value: "none" }] })).find((c) => c.id === "robots")!.level).toBe("bad");
  });
});

describe("length counters", () => {
  it("counts characters against the limits", () => {
    expect(lengthCount("é".repeat(61), LENGTH_LIMITS.title)).toEqual({ length: 61, max: 60, over: true });
    expect(lengthCount(undefined, LENGTH_LIMITS.description)).toEqual({ length: 0, max: 160, over: false });
    expect(LENGTH_LIMITS).toMatchObject({ title: 60, description: 160, "og:title": 88, "og:description": 200 });
    // Emoji count once.
    expect(lengthCount("😀😀", 1).length).toBe(2);
  });
  it("truncates like a network, on characters", () => {
    expect(truncate("Hello world", 6)).toEqual({ text: "Hello…", cut: true });
    expect(truncate("Hi", 6)).toEqual({ text: "Hi", cut: false });
  });
  it("gives the page counters", () => {
    const s = snap({ content: content() });
    const c = seoCounters(s, seoReport(s));
    expect(c).toMatchObject({
      words: 120,
      headings: 1,
      images: { total: 3, missingAlt: 1 },
      links: { total: 5, internal: 3, external: 2 },
    });
    expect(c.issues).toBe(seoIssues(seoReport(s)).length);
    expect(seoCounters(snap(), [])).toMatchObject({ words: null, images: null, links: null });
  });
});

describe("images and links stats", () => {
  it("splits internal and external by hostname, www. aside", () => {
    expect(pageCounts(content(), "https://www.ex.com/a")).toEqual({
      images: { total: 3, missingAlt: 1, decorative: 1, withoutTitle: 2 },
      links: { total: 5, internal: 3, external: 2, unique: 4, nofollow: 1 },
    });
  });
  it("extrapolates past the links kept", () => {
    const c = pageCounts(content({ anchors: 10 }), "https://ex.com/");
    expect(c.links).toMatchObject({ total: 10, internal: 6, external: 4, nofollow: 2 });
  });
});

describe("Open Graph / Twitter checklist", () => {
  it("checks the essential and recommended tags", () => {
    const c = socialChecklist(snap({ meta: og({ "og:type": "" }) }));
    expect(c.score).toBe(4);
    expect(c.essential.find((t) => t.key === "og:type")!.state).toBe("missing");
    expect(c.recommended.map((t) => t.state)).toEqual(["missing", "missing", "missing", "missing", "missing"]);
  });
  it("shows Twitter tags covered by Open Graph as fallbacks", () => {
    const c = socialChecklist(snap({ meta: [...og(), { key: "twitter:title", value: "Mug on X" }] }));
    expect(c.twitter).toEqual([
      { key: "twitter:card", value: "summary", state: "fallback", from: "Open Graph" },
      { key: "twitter:title", value: "Mug on X", state: "set" },
      { key: "twitter:description", value: "The best mug.", state: "fallback", from: "og:description" },
      { key: "twitter:image", value: "https://ex.com/og.png", state: "fallback", from: "og:image" },
    ]);
    expect(socialChecklist(snap({ meta: [] })).twitter.every((t) => t.state === "missing")).toBe(true);
  });
});

describe("social mistakes", () => {
  const ids = (meta: MetaSnapshot["meta"], links = snap().links) => socialMistakes(snap({ meta, links })).map((m) => m.id);
  it("accepts a clean set, trailing slash and host case aside", () => {
    expect(ids(og({ "og:url": "https://EX.com/a/" }))).toEqual([]);
  });
  it("catches og:url that is not the canonical", () => {
    expect(ids(og({ "og:url": "https://ex.com/b" }))).toEqual(["og-url-canonical"]);
  });
  it("catches relative and http:// images", () => {
    expect(ids(og({ "og:image": "/og.png" }))).toEqual(["og:image-relative"]);
    expect(ids(og({ "og:image": "//cdn.ex.com/og.png" }))).toEqual(["og:image-relative"]);
    expect(ids(og({ "og:image": "http://ex.com/og.png" }))).toEqual(["og:image-http"]);
  });
  it("catches og: tags written with name=", () => {
    const meta = [...og({ "og:title": "" }), { key: "og:title", value: "Mug", attr: "name" as const }];
    const m = socialMistakes(snap({ meta }));
    expect(m.map((x) => x.id)).toEqual(["og-name"]);
    expect(m[0]!.text).toMatch(/property=/);
  });
  it("catches unknown twitter:card values", () => {
    expect(ids([...og(), { key: "twitter:card", value: "large" }])).toEqual(["twitter-card"]);
    for (const card of ["summary", "summary_large_image", "app", "player"])
      expect(ids([...og(), { key: "twitter:card", value: card }])).toEqual([]);
  });
  it("adds them to the SEO checks", () => {
    expect(seoReport(snap({ meta: og({ "og:image": "/og.png" }) })).some((c) => c.id === "og:image-relative")).toBe(true);
  });
});

describe("network previews", () => {
  const spec = (id: string) => NETWORKS.find((n) => n.id === id)!;
  it("has the five networks with their ratios", () => {
    expect(NETWORKS.map((n) => n.name)).toEqual(["Facebook", "LinkedIn", "X (Twitter)", "WhatsApp", "Slack"]);
    expect(spec("facebook").ratioText).toBe("1.91:1");
    expect(spec("x").ratioText).toBe("2:1");
  });
  it("uses a small 1:1 card on X unless summary_large_image", () => {
    const s = snap({ meta: og() });
    expect(networkCard(s, spec("x"))).toMatchObject({ layout: "small", ratioText: "1:1", domain: "ex.com" });
    const large = snap({ meta: [...og(), { key: "twitter:card", value: "summary_large_image" }] });
    expect(networkCard(large, spec("x"))).toMatchObject({ layout: "large", ratioText: "2:1" });
  });
  it("cuts the title to the network's limit and resolves the image", () => {
    const s = snap({ meta: og({ "og:title": "T".repeat(100), "og:image": "/og.png" }) });
    const c = networkCard(s, spec("facebook"));
    expect(c.titleCut).toBe(true);
    expect([...c.title].length).toBe(88);
    expect(c.domain).toBe("EX.COM");
    expect(c.image).toBe("https://ex.com/og.png");
    expect(networkCard(s, spec("linkedin")).description).toBe("");
  });
  it("falls back to a thumbnail when the measured image is too small", () => {
    expect(networkCard(snap({ meta: og() }), spec("facebook"), { width: 300, height: 300 }).layout).toBe("small");
  });
});

describe("measured image checks", () => {
  const ids = (w: number, h: number, d?: { width?: string; height?: string }) => imageChecks({ width: w, height: h }, d).map((c) => c.id);
  it("passes 1200×630", () => {
    expect(ids(1200, 630)).toEqual(["img-ok"]);
  });
  it("flags small, tiny and odd ratios", () => {
    expect(ids(800, 420)).toEqual(["img-small"]);
    expect(ids(150, 150)).toEqual(["img-tiny", "img-ratio"]);
    expect(ids(1200, 1200)).toEqual(["img-ratio"]);
  });
  it("flags declared sizes that do not match the file", () => {
    expect(ids(1200, 630, { width: "1200", height: "630" })).toEqual(["img-ok"]);
    expect(ids(1200, 630, { width: "600", height: "315" })).toEqual(["img-declared"]);
  });
});

describe("hreflang", () => {
  const alt = (hreflang: string, href: string, rawHref = href) => ({ rel: "alternate", hreflang, href, rawHref });
  it("accepts valid codes", () => {
    for (const code of ["fr", "en-GB", "de-AT", "zh-Hant-TW", "x-default", "pt-br"]) expect(hreflangCodeProblems(code)).toEqual([]);
  });
  it("catches underscores, en-UK and country codes used as languages", () => {
    expect(hreflangCodeProblems("de_AT")[0]!.text).toBe("Use a hyphen, not an underscore: de-AT.");
    expect(hreflangCodeProblems("en-UK")[0]!.text).toBe('"UK" is not a country code: use en-GB.');
    expect(hreflangCodeProblems("gb")[0]!.text).toMatch(/"gb" is a country code, not a language: .*en-GB/);
    expect(hreflangCodeProblems("en-XX")[0]!.level).toBe("bad");
    expect(hreflangCodeProblems("es-419")[0]!.level).toBe("warn");
    expect(hreflangCodeProblems("iw")[0]!.text).toMatch(/use he/);
    expect(hreflangCodeProblems("uk")).toEqual([expect.objectContaining({ level: "info" })]);
    expect(isLanguage("fr") && isRegion("gb") && !isRegion("uk")).toBe(true);
  });
  it("marks the page itself and the x-default", () => {
    const r = hreflangReport(
      [alt("fr", "https://www.lemonde.fr/"), alt("en", "https://www.lemonde.fr/en/"), alt("x-default", "https://www.lemonde.fr/")],
      "https://www.lemonde.fr/",
    );
    expect(r.entries.map((e) => [e.lang, e.self])).toEqual([
      ["fr", true],
      ["en", false],
      ["x-default", true],
    ]);
    expect(r).toMatchObject({ xDefault: true, selfReference: true, languages: 2, problems: [] });
    expect(r.entries[0]!.name).toBe("French");
  });
  it("reports a missing self-reference and x-default", () => {
    const r = hreflangReport([alt("en", "https://ex.com/en/")], "https://ex.com/fr/");
    expect(r.problems.map((p) => p.level)).toEqual(["warn", "info"]);
    expect(r.problems[1]!.text).toBe("No x-default entry — it is the fallback for languages you do not target.");
    expect(hreflangReport([alt("en", "https://ex.com/en/")], "https://ex.com/fr/", "https://ex.com/en").selfReference).toBe(true);
  });
  it("catches relative URLs, duplicates and conflicts", () => {
    const r = hreflangReport(
      [
        alt("fr", "https://ex.com/fr", "/fr"),
        alt("de", "https://ex.com/de"),
        alt("de", "https://ex.com/de/"),
        alt("en", "https://ex.com/en"),
        alt("EN", "https://ex.com/uk"),
      ],
      "https://ex.com/fr",
    );
    expect(r.entries[0]!.problems[0]!.text).toMatch(/^Relative URL/);
    expect(r.problems.map((p) => p.text)).toEqual(
      expect.arrayContaining(["Duplicate: de is listed 2 times.", "Conflict: en points to 2 different URLs."]),
    );
    expect(r.entries[4]!.problems.some((p) => p.level === "bad")).toBe(true);
  });
  it("feeds the SEO checks", () => {
    const checks = seoReport(snap({ links: [...snap().links, alt("de_AT", "https://ex.com/at")] }));
    expect(checks.find((c) => c.id === "hreflang")!.level).toBe("good");
    expect(checks.filter((c) => c.id.startsWith("hreflang-") && c.level === "bad").length).toBe(1);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["hreflang-self", "hreflang-x-default"]));
    expect(checks.some((c) => c.detail === "de_AT: Use a hyphen, not an underscore: de-AT.")).toBe(true);
    expect(sameUrl("https://EX.com:443/a/", "https://ex.com/a")).toBe(true);
  });
});

describe("indexability", () => {
  it("combines meta robots and X-Robots-Tag for Googlebot", () => {
    expect(indexability(snap())).toEqual({ index: true, follow: true, sources: [] });
    const ix = indexability(snap({ meta: [{ key: "robots", value: "index, nofollow" }] }), { "X-Robots-Tag": "noarchive" });
    expect(ix).toMatchObject({ index: true, follow: false });
    expect(ix.sources).toEqual([
      { source: "meta robots", value: "index, nofollow" },
      { source: "X-Robots-Tag", value: "noarchive" },
    ]);
    expect(indexability(snap(), { "x-robots-tag": "none" })).toMatchObject({ index: false, follow: false });
  });
  it("reads user-agent prefixes in X-Robots-Tag", () => {
    expect(xRobotsForGoogle("bingbot: noindex, googlebot: nofollow, max-snippet: 20")).toEqual(["nofollow", "max-snippet: 20"]);
    expect(indexability(snap(), { "x-robots-tag": "otherbot: noindex" }).index).toBe(true);
  });
  it("words the robots.txt verdict", () => {
    expect(robotsText({ status: 200, allowed: true })).toBe("Allowed");
    expect(robotsText({ status: 200, allowed: false, rule: "Disallow: /" })).toBe("Blocked (Disallow: /)");
    expect(robotsText({ status: 404, allowed: true })).toMatch(/^No robots.txt/);
    expect(robotsText({ status: 503, allowed: false })).toMatch(/blocked until/);
  });
});

describe("SEO report for people", () => {
  it("covers every section", () => {
    const s = snap({
      meta: [...snap().meta, ...og({ "og:title": "" })],
      links: [...snap().links, { rel: "alternate", hreflang: "en", href: "https://ex.com/a", rawHref: "https://ex.com/a" }],
      headings: [
        { level: 1, text: "Hello" },
        { level: 2, text: "Part" },
      ],
      content: content(),
    });
    const md = seoTextReport(s, {
      headers: { status: 200, headers: { "x-robots-tag": "noarchive" } },
      robots: { status: 200, allowed: true },
    });
    expect(md.startsWith("# SEO report: A good title for the page\nPage: https://ex.com/a")).toBe(true);
    for (const part of [
      "## Issues",
      "1 of 3 images has no alt text.",
      "- Title (25/60)",
      "## Social (Open Graph / Twitter) · 5/5",
      "- ✓ og:url: https://ex.com/a",
      "↳ twitter:image (fallback from og:image",
      "## hreflang (1)",
      "| ✓ | en | https://ex.com/a | this page |",
      "Return links from the other language versions",
      "- Links: 5 total, 3 internal, 2 external, 4 unique, 1 nofollow",
      "- index, follow (X-Robots-Tag: noarchive)",
      "- robots.txt (Googlebot): Allowed",
      "- HTTP status: 200",
      "## Headings (2)",
      "  - h2 Part",
    ])
      expect(md).toContain(part);
  });
});

describe("collectMeta in the page", () => {
  it("keeps the meta attribute, the raw link href, and counts images, links and words", () => {
    document.head.innerHTML = `<meta property="og:title" content="Mug"><meta name="og:image" content="/og.png"><meta charset="utf-8">
<link rel="alternate" hreflang="fr" href="/fr">`;
    document.body.innerHTML = `<p>Hello wide world, it's 2026.</p><img src="a.png" alt="A"><img src="b.png"><img src="c.png" alt="" title="C">
<a href="/x">x</a> <a href="https://other.org/" rel="nofollow">o</a> <a href="mailto:a@b.c">mail</a> <a href="/x#top">x again</a>`;
    const m = collectMeta();
    expect(m.meta.find((x) => x.key === "og:title")!.attr).toBe("property");
    expect(m.meta.find((x) => x.key === "og:image")!.attr).toBe("name");
    expect(m.meta.find((x) => x.key === "charset")!.attr).toBe("charset");
    expect(m.links[0]).toMatchObject({ rawHref: "/fr", hreflang: "fr" });
    expect(m.links[0]!.href).toMatch(/^https?:\/\/.+\/fr$/);
    expect(m.content!.images).toEqual([
      { alt: "A", title: false },
      { alt: null, title: false },
      { alt: "", title: true },
    ]);
    expect(m.content!.anchors).toBe(3);
    expect(m.content!.links.map((l) => l.rel)).toEqual(["", "nofollow", ""]);
    expect(m.content!.links[2]!.href.endsWith("/x")).toBe(true);
    expect(m.content!.words).toBeGreaterThanOrEqual(5);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
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
