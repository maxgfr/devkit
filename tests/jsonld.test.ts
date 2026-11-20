import { describe, expect, it } from "vitest";
import {
  analyzeBlock,
  analyzeJsonLd,
  blockBadges,
  blockFileName,
  blockFindings,
  currencyFor,
  groupFindings,
  indexingSignals,
  inMode,
  isoDateFor,
  isoDurationFor,
  jsonErrorAt,
  plainPrice,
  reportCounts,
  richResultsTestUrl,
  schemaDocUrl,
  schemaValidatorUrl,
  scriptTag,
} from "../src/lib/jsonld";

const product = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Mug",
  image: "https://example.com/mug.jpg",
  description: "A mug",
  sku: "M1",
  brand: { "@type": "Brand", name: "Acme" },
  gtin13: "0000000000000",
  offers: {
    "@type": "Offer",
    price: "12.50",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
    url: "https://example.com/mug",
    priceValidUntil: "2027-01-01",
  },
};

describe("JSON-LD analyzer", () => {
  it("accepts a complete Product", () => {
    const b = analyzeBlock(JSON.stringify(product), 0);
    expect(b.ok).toBe(true);
    expect(b.nodes.map((n) => n.types[0])).toEqual(["Product", "Brand", "Offer"]);
    expect([...b.findings, ...b.nodes.flatMap((n) => n.findings)].filter((f) => f.severity === "error")).toEqual([]);
  });

  it("reports invalid JSON with a position", () => {
    const b = analyzeBlock('{"@type": "Product",\n "name": }', 0);
    expect(b.ok).toBe(false);
    expect(b.findings[0]!.message).toMatch(/Invalid JSON/);
    expect(b.error).toMatch(/line \d+/);
  });

  it("flags missing required properties, bad prices, dates and currencies", () => {
    const b = analyzeBlock(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        offers: { "@type": "Offer", price: "€12,50", priceCurrency: "euro" },
        releaseDate: "x",
        datePublished: "31/01/2026",
      }),
      0,
    );
    const messages = b.nodes.flatMap((n) => n.findings).map((f) => f.message);
    expect(messages.some((m) => /missing required name/.test(m))).toBe(true);
    expect(messages.some((m) => /price "€12,50" must be a plain number/.test(m))).toBe(true);
    expect(messages.some((m) => /priceCurrency "euro"/.test(m))).toBe(true);
    expect(messages.some((m) => /not an ISO 8601 date/.test(m))).toBe(true);
  });

  it("walks @graph, counts types and checks breadcrumb positions", () => {
    const r = analyzeJsonLd([
      {
        index: 0,
        raw: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebSite",
              "@id": "#site",
              name: "Ex",
              url: "https://ex.com",
              potentialAction: { "@type": "SearchAction", target: "https://ex.com/?q={q}", "query-input": "required name=q" },
            },
            {
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 1, name: "Home", item: "https://ex.com" },
                { "@type": "ListItem", position: 3, name: "Mugs" },
              ],
            },
            { "@type": "WebPage", isPartOf: { "@id": "#missing" }, name: "P", url: "https://ex.com/p" },
          ],
        }),
      },
    ]);
    expect(r.types.map((t) => t.type)).toContain("BreadcrumbList");
    const all = r.blocks[0]!.nodes.flatMap((n) => n.findings).map((f) => f.message);
    expect(all.some((m) => /positions are 1, 3/.test(m))).toBe(true);
    expect(all.some((m) => /#missing, which no node/.test(m))).toBe(true);
  });

  it("requires @context and warns on relative URLs and miscased keywords", () => {
    const b = analyzeBlock(JSON.stringify({ "@type": "Organization", name: "Acme", url: "/about", logo: "logo.png", "@Id": "x" }), 0);
    expect(b.findings.some((f) => /No @context/.test(f.message))).toBe(true);
    const node = b.nodes[0]!.findings.map((f) => f.message);
    expect(node.some((m) => /url "\/about" is not an absolute URL/.test(m))).toBe(true);
    expect(node.some((m) => /Unknown keyword @Id/.test(m))).toBe(true);
  });

  it("explains a parse position as line and column", () => {
    expect(jsonErrorAt("{\n  x", new SyntaxError("Unexpected token x in JSON at position 4"))).toBe("line 2, column 3: Unexpected token x");
  });

  it("suggests ISO 8601 dates and durations", () => {
    expect(isoDateFor("31.12.2026")).toBe("2026-12-31");
    expect(isoDateFor("2026/12/31")).toBe("2026-12-31");
    expect(isoDateFor("12/31/2026")).toBe("2026-12-31");
    expect(isoDateFor("31/12/2026")).toBe("2026-12-31");
    expect(isoDateFor("01/02/2026")).toBeUndefined();
    expect(isoDurationFor("45 min")).toBe("PT45M");
    expect(isoDurationFor("1h30")).toBe("PT1H30M");
    expect(isoDurationFor("1 hour and 15 minutes")).toBe("PT1H15M");
    expect(isoDurationFor("2 days")).toBe("P2D");
    expect(isoDurationFor("1:15")).toBe("PT1H15M");
    expect(isoDurationFor("pt20m")).toBe("PT20M");
    expect(isoDurationFor("a while")).toBeUndefined();
  });

  it("suggests plain prices and ISO 4217 currencies", () => {
    expect(plainPrice("89,90 €")).toEqual({ price: "89.90", currency: "EUR" });
    expect(plainPrice("$1,299.00")).toEqual({ price: "1299.00", currency: undefined });
    expect(plainPrice("1.299,00 EUR")).toEqual({ price: "1299.00", currency: "EUR" });
    expect(plainPrice("free").price).toBeUndefined();
    expect(currencyFor("eur")).toBe("EUR");
    expect(currencyFor("€")).toBe("EUR");
    expect(currencyFor("euro")).toBe("EUR");
    expect(currencyFor("XYZ")).toBeUndefined();
  });

  it("flags the value formats Google documents", () => {
    const b = analyzeBlock(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Recipe",
        name: "Pie",
        image: "https://example.com/my pie.jpg",
        datePublished: "31.12.2026",
        prepTime: "45 min",
        offers: [
          { "@type": "Offer", price: "89,90 €", priceCurrency: "€" },
          { "@type": "Offer", price: "10", priceCurrency: "BTC" },
          { "@type": "Offer", price: "10", priceCurrency: "ABC1" },
        ],
      }),
      0,
    );
    const m = blockFindings(b).map((f) => f.message);
    expect(m).toContain('datePublished "31.12.2026" is not an ISO 8601 date: write "2026-12-31"');
    expect(m).toContain('prepTime "45 min" is not an ISO 8601 duration: write "PT45M"');
    expect(m).toContain('image "https://example.com/my pie.jpg" contains spaces: encode them as %20');
    expect(m).toContain(
      'price "89,90 €" must be a plain number (use "." as decimal separator, no currency sign): write "89.90" with priceCurrency "EUR"',
    );
    expect(m).toContain('priceCurrency "€" must be an ISO 4217 code: write "EUR"');
    expect(m.some((x) => /priceCurrency "BTC" is not an ISO 4217 code/.test(x))).toBe(true);
    expect(m).toContain('priceCurrency "ABC1" must be an ISO 4217 code such as EUR');
    const chf = analyzeBlock(JSON.stringify({ ...product, offers: { ...product.offers, priceCurrency: "CHF" } }), 0);
    expect(blockFindings(chf).filter((f) => f.rule === "format.currency")).toEqual([]);
  });

  it("groups identical findings and keeps their paths", () => {
    const offer = { "@type": "Offer", price: "€5", priceCurrency: "EUR" };
    const b = analyzeBlock(
      JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: [offer, offer, offer, offer] }),
      0,
    );
    const prices = groupFindings(blockFindings(b)).filter((g) => g.rule === "format.price");
    expect(prices).toHaveLength(1);
    expect(prices[0]!.paths).toEqual([0, 1, 2, 3].map((i) => `#1.itemListElement[${i}].price`));
  });

  it("splits findings by validation mode and gives each block a status", () => {
    const google = { severity: "warn", rule: "google.recommended", path: "#1", message: "x" } as const;
    const vocab = { severity: "error", rule: "vocab.unknown-type", path: "#1", message: "y" } as const;
    const enumValue = { severity: "error", rule: "vocab.enum", path: "#1", message: "z" } as const;
    expect([inMode(google, "rich"), inMode(google, "schema")]).toEqual([true, false]);
    expect([inMode(vocab, "rich"), inMode(vocab, "schema")]).toEqual([false, true]);
    expect([inMode(enumValue, "rich"), inMode(enumValue, "schema")]).toEqual([true, true]);
    const r = analyzeJsonLd([{ raw: JSON.stringify(product), index: 0 }]);
    expect(blockBadges(r.blocks[0]!, "rich")).toEqual({ status: "valid", experimental: false, unsupported: [] });
    expect(reportCounts(r, "rich")).toEqual({ error: 0, warn: 0, info: 0 });
    const howTo = analyzeBlock(JSON.stringify({ "@context": "https://schema.org", "@type": "HowTo", name: "Tie", step: ["Loop"] }), 0);
    expect(blockBadges(howTo, "rich").unsupported.map((u) => u.type)).toEqual(["HowTo"]);
    const broken = analyzeBlock("{", 1);
    expect(blockBadges(broken, "schema").status).toBe("error");
    expect(blockFileName(broken)).toBe("jsonld-2.txt");
  });

  it("copies a block as a script tag, names its download and links schema.org docs", () => {
    const b = analyzeBlock(JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "</script><b>" }), 2);
    const tag = scriptTag(b);
    expect(tag.startsWith('<script type="application/ld+json">\n{\n  "@context"')).toBe(true);
    expect(tag.endsWith("\n</script>")).toBe(true);
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(tag.replace(/^<script[^>]*>|<\/script>$/g, "")).name).toBe("</script><b>");
    expect(blockFileName(b)).toBe("product-3.jsonld");
    expect(schemaDocUrl("Product")).toBe("https://schema.org/Product");
    expect(schemaDocUrl("schema:Offer")).toBe("https://schema.org/Offer");
    expect(schemaDocUrl("foaf:Person")).toBeNull();
  });

  it("keeps umlauts, accents, emojis and query strings intact in validator links", () => {
    const url = "https://example.com/müller/café-🎉?q=a b&lang=de#top";
    for (const link of [richResultsTestUrl(url), schemaValidatorUrl(url)]) {
      const encoded = link.slice(link.indexOf("url=") + 4);
      expect(decodeURIComponent(encoded)).toBe(url);
      expect(encoded).not.toMatch(/[&?#\s]/);
    }
    expect(richResultsTestUrl("https://ex.com/?a=1&b=2")).toBe(
      "https://search.google.com/test/rich-results?url=https%3A%2F%2Fex.com%2F%3Fa%3D1%26b%3D2",
    );
  });

  it("reads canonical, robots meta and X-Robots-Tag", () => {
    const snap = {
      meta: [
        { key: "robots", value: "noindex" },
        { key: "googlebot", value: "nosnippet" },
      ],
      links: [{ rel: "canonical", href: "https://ex.com/a" }],
    };
    expect(indexingSignals(snap, { "X-Robots-Tag": "noarchive" })).toEqual({
      canonical: "https://ex.com/a",
      robots: "noindex · googlebot: nosnippet",
      xRobotsTag: "noarchive",
    });
    expect(indexingSignals({ meta: [], links: [] }, {})).toEqual({ canonical: null, robots: null, xRobotsTag: null });
  });
});
