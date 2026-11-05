import { describe, expect, it } from "vitest";
import { analyzeBlock, analyzeJsonLd, jsonErrorAt } from "../src/lib/jsonld";

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
});
