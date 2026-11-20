import { afterEach, describe, expect, it } from "vitest";
import { hasFindings } from "../src/lib/agent/inspect";
import { renderedSourceMarkdown } from "../src/lib/agent/rendered-source";
import { readRenderedDom } from "../src/lib/page/rendered-source";
import { PANELS } from "../src/lib/panels";
import { bodyText, jsonLdItem, listDiff, parseHtml, prettyHtml, renderDiff, seoSnapshot, sourceDiff } from "../src/lib/rendered-source";

const URL_ = "https://shop.example/products/mug";

const SERVED = `<!doctype html>
<html lang="en"><head>
<title>Loading…</title>
<meta name="description" content="A mug">
<meta property="og:title" content="Mug">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body>
<div id="app"><h1>Mug</h1><a href="/">Home</a> <a href="https://other.example/x#frag" rel="nofollow">Partner</a></div>
<script>document.title = "x"</script>
</body></html>`;

const RENDERED = `<!doctype html>
<html lang="en"><head>
<title>Acme Mug – Shop</title>
<meta name="description" content="A mug">
<meta property="og:title" content="Acme Mug">
<meta property="og:image" content="https://shop.example/mug.png">
<link rel="canonical" href="/products/mug">
<link rel="alternate" hreflang="fr" href="https://shop.example/fr/products/mug">
<script type="application/ld+json">{ "itemListElement": [], "@type": "BreadcrumbList", "@context": "https://schema.org" }</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug","offers":{"@type":"Offer","price":"12"}}</script>
</head><body>
<div id="app"><h1>Mug</h1><h2>Reviews</h2><p>${"word ".repeat(40)}</p>
<a href="/">Home</a> <a href="https://other.example/x" rel="sponsored">Partner</a>
<a href="/products/cup">Cup</a> <a href="/products/plate#top">Plate</a> <a href="mailto:a@b.c">Mail</a>
<img src="/mug.png" alt="Mug"></div>
</body></html>`;

const snap = (html: string) => seoSnapshot(parseHtml(html), URL_);

describe("seoSnapshot", () => {
  it("reads the SEO signals of a document without running its scripts", () => {
    const s = snap(RENDERED);
    expect(s.title).toBe("Acme Mug – Shop");
    expect(s.lang).toBe("en");
    expect(s.description).toBe("A mug");
    expect(s.canonicals).toEqual(["https://shop.example/products/mug"]);
    expect(s.hreflang).toEqual([{ lang: "fr", href: "https://shop.example/fr/products/mug" }]);
    expect(s.social).toEqual([
      { key: "og:title", value: "Acme Mug" },
      { key: "og:image", value: "https://shop.example/mug.png" },
    ]);
    expect(s.jsonLd.map((b) => b.types)).toEqual([["BreadcrumbList"], ["Product", "Offer"]]);
    expect(s.headings).toEqual([
      { level: 1, text: "Mug" },
      { level: 2, text: "Reviews" },
    ]);
    // mailto is not a crawlable link; fragments are dropped; internal is by host.
    expect(s.links.map((l) => [l.href, l.internal])).toEqual([
      ["https://shop.example/", true],
      ["https://other.example/x", false],
      ["https://shop.example/products/cup", true],
      ["https://shop.example/products/plate", true],
    ]);
    expect(s.images).toEqual([{ src: "https://shop.example/mug.png", alt: "Mug" }]);
    expect(s.index).toBe(true);
    expect(s.words).toBeGreaterThan(40);
  });

  it("resolves against <base href>, reads noindex and tells a missing title from an empty one", () => {
    const s = snap(
      `<html><head><base href="https://cdn.example/root/"><meta name="robots" content="noindex, follow"><link rel="canonical" href="page"></head><body></body></html>`,
    );
    expect(s.canonicals).toEqual(["https://cdn.example/root/page"]);
    expect(s.index).toBe(false);
    expect(s.follow).toBe(true);
    expect(s.title).toBeNull();
    expect(snap("<title></title>").title).toBe("");
    expect(s.words).toBe(0);
  });

  it("counts words with a space between blocks and leaves scripts and noscript out", () => {
    const doc = parseHtml(
      "<body><p>one</p><p>two three</p><script>var a = 1</script><noscript>enable js</noscript><style>p{}</style></body>",
    );
    expect(bodyText(doc)).toBe("one two three");
  });

  it("parses JSON-LD whatever the key order, and keeps invalid blocks", () => {
    expect(jsonLdItem('{"b":1,"a":{"@type":"X"}}').key).toBe(jsonLdItem('{ "a": { "@type": "X" }, "b": 1 }').key);
    expect(jsonLdItem('{"@graph":[{"@type":"A"},{"@type":["B","C"]}]}').types).toEqual(["A", "B", "C"]);
    const bad = jsonLdItem("{oops");
    expect(bad.ok).toBe(false);
    expect(bad.types).toEqual([]);
  });
});

describe("renderDiff", () => {
  const d = renderDiff(snap(SERVED), snap(RENDERED));

  it("compares the fields", () => {
    const by = Object.fromEntries(d.fields.map((f) => [f.id, f.change]));
    expect(by).toEqual({ title: "changed", description: "same", robots: "same", canonical: "added", lang: "same" });
  });

  it("lists what JavaScript added, removed and changed", () => {
    expect(d.social.added.map((s) => s.key)).toEqual(["og:image"]);
    expect(d.social.changed).toEqual([{ key: "og:title", served: "Mug", rendered: "Acme Mug" }]);
    // Same BreadcrumbList with another key order is not a change; the Product is new.
    expect(d.jsonLd.same).toBe(1);
    expect(d.jsonLd.added.map((b) => b.types[0])).toEqual(["Product"]);
    expect(d.hreflang.added).toHaveLength(1);
    expect(d.headings.added).toEqual([{ level: 2, text: "Reviews" }]);
    expect(d.links.added.map((l) => l.href)).toEqual(["https://shop.example/products/cup", "https://shop.example/products/plate"]);
    expect(d.links.removed).toEqual([]);
    expect(d.links.relChanged).toEqual([{ href: "https://other.example/x", served: "nofollow", rendered: "sponsored" }]);
    expect(d.images.added).toHaveLength(1);
  });

  it("ranks heuristic findings: problems first", () => {
    const ids = d.findings.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(["canonical-js", "title-changed", "social-js", "social-changed", "links-js", "jsonld-js", "hreflang-js"]),
    );
    expect(d.findings[0]!.level).toBe("bad");
    expect(d.findings.find((f) => f.id === "links-js")?.text).toBe("2 links only after JavaScript");
    expect(d.findings.find((f) => f.id === "jsonld-js")?.text).toBe("1 JSON-LD block injected by JavaScript");
    const levels = d.findings.map((f) => ["bad", "warn", "info", "good"].indexOf(f.level));
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });

  it("flags noindex only in the served HTML, a changed canonical, and client-side rendering", () => {
    const served = snap(
      `<head><meta name="robots" content="noindex"><link rel="canonical" href="/a"></head><body><div id="app"></div></body>`,
    );
    const rendered = snap(`<head><link rel="canonical" href="/b"></head><body><main>${"text ".repeat(300)}</main></body>`);
    const ids = renderDiff(served, rendered).findings.map((f) => `${f.level}:${f.id}`);
    expect(ids.slice(0, 3).sort()).toEqual(["bad:canonical-changed", "bad:content-js", "bad:noindex-served"]);
    const back = renderDiff(rendered, served).findings.map((f) => f.id);
    expect(back).toContain("noindex-rendered");
  });

  it("finds nothing when both sides carry the same signals", () => {
    const same = renderDiff(snap(RENDERED), snap(RENDERED));
    expect(same.findings).toEqual([expect.objectContaining({ id: "same", level: "good" })]);
    // A trailing slash or a host case difference in the canonical is the same URL for a crawler.
    const a = snap('<link rel="canonical" href="https://Shop.example/products/mug/">');
    const b = snap('<link rel="canonical" href="https://shop.example/products/mug">');
    expect(renderDiff(a, b).fields.find((f) => f.id === "canonical")?.change).toBe("same");
  });
});

describe("listDiff", () => {
  it("is a multiset difference", () => {
    expect(listDiff(["a", "a", "b"], ["a", "c", "c"], (x) => x)).toEqual({ added: ["c", "c"], removed: ["a", "b"], same: 1 });
  });
});

describe("source view", () => {
  it("pretty-prints one tag per line, short text inline", () => {
    const out = prettyHtml(
      parseHtml(
        '<!doctype html><html><head><title>T</title></head><body><div class="x"><p>Hi <b>there</b></p><br><img src="a.png" alt=""></div></body></html>',
      ),
    );
    expect(out).toBe(
      [
        "<!DOCTYPE html>",
        "<html>",
        "  <head>",
        "    <title>T</title>",
        "  </head>",
        "  <body>",
        '    <div class="x">',
        "      <p>",
        "        Hi",
        "        <b>there</b>",
        "      </p>",
        "      <br>",
        '      <img src="a.png" alt>',
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  it("keeps script bodies, re-indented", () => {
    const out = prettyHtml(parseHtml("<body><script>\n    var a = 1;\n    var b = 2;\n</script></body>"));
    expect(out).toContain("    <script>\n      var a = 1;\n      var b = 2;\n    </script>");
  });

  it("diffs line by line and folds unchanged runs", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[15] = "changed";
    b.push("new last");
    const d = sourceDiff(a.join("\n"), b.join("\n"), { context: 2 });
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.tooLarge).toBe(false);
    expect(d.lines[0]).toEqual({ kind: "skip", count: 13 });
    expect(d.lines.filter((l) => l.kind === "add").map((l) => ("text" in l ? l.text : ""))).toEqual(["changed", "new last"]);
    const del = d.lines.find((l) => l.kind === "del");
    expect(del).toEqual({ kind: "del", text: "line 15", a: 16 });
  });

  it("gives up past the budget instead of freezing", () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join("\n");
    expect(sourceDiff(a, b, { maxCells: 1000 }).tooLarge).toBe(true);
    expect(sourceDiff("same\ntext", "same\ntext")).toEqual({ lines: [{ kind: "skip", count: 2 }], added: 0, removed: 0, tooLarge: false });
  });
});

describe("readRenderedDom (page function)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the live DOM without devkit's overlays", () => {
    document.body.innerHTML =
      '<h1>Live</h1><devkit-headings><b>badge</b></devkit-headings><div id="devkit-env-ribbon">PROD</div><p id="keep">ok</p>';
    const dom = readRenderedDom();
    expect(dom.html).toContain("<h1>Live</h1>");
    expect(dom.html).toContain('id="keep"');
    expect(dom.html).not.toContain("devkit-headings");
    expect(dom.html).not.toContain("PROD");
    expect(dom.truncated).toBe(false);
    expect(readRenderedDom(20).html).toHaveLength(20);
    expect(readRenderedDom(20).truncated).toBe(true);
    // The live page is untouched.
    expect(document.querySelector("devkit-headings")).not.toBeNull();
  });
});

describe("renderedSourceMarkdown", () => {
  it("lists the findings with fixes and the differences", () => {
    const md = renderedSourceMarkdown(renderDiff(snap(SERVED), snap(RENDERED)), { url: URL_, notes: ["The re-fetch answered HTTP 200."] });
    expect(md.startsWith("## Served HTML vs rendered DOM (devkit panel: Inspect › Served vs rendered)")).toBe(true);
    expect(md).toContain(`Page: ${URL_}`);
    expect(md).toMatch(/^Result: 1 problem, \d+ warnings, \d+ notes$/m);
    expect(md).toContain("The findings are heuristics.");
    expect(md).toContain("The re-fetch answered HTTP 200.");
    expect(md).toContain("Canonical only exists after JavaScript");
    expect(md).toContain('Fix: Render `<link rel="canonical">` in the served HTML');
    expect(md).toContain("- Title (changed): served `Loading…`, rendered `Acme Mug – Shop`");
    expect(md).toContain("- JSON-LD added: Product, Offer");
    expect(hasFindings(md)).toBe(true);
  });

  it("says when nothing differs", () => {
    const md = renderedSourceMarkdown(renderDiff(snap(RENDERED), snap(RENDERED)), { url: URL_ });
    expect(md).toContain("Result: Same SEO signals in the served HTML and after JavaScript.");
    expect(hasFindings(md)).toBe(false);
  });
});

describe("panel registry", () => {
  it("registers the Served vs rendered panel in Inspect", () => {
    const p = PANELS.find((x) => x.id === "rendered-source");
    expect(p?.category).toBe("inspect");
    expect(p?.keywords).toMatch(/view source/);
    expect(p?.keywords).toMatch(/hydration/);
  });
});
