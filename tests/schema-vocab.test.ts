import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeJsonLd } from "../src/lib/jsonld";
import { checkVocab, editDistance, nearest, type SchemaVocab, schemaTerm } from "../src/lib/schema-vocab";

/** A hand-built slice of Schema.org, enough for every check. */
const vocab: SchemaVocab = {
  source: { name: "Schema.org", url: "", file: "", version: "test", date: "2026-01-01", license: "", licenseUrl: "", terms: "" },
  dataTypes: ["Text", "Number", "Date", "DateTime"],
  types: {
    Thing: [],
    Text: [],
    URL: ["Text"],
    Number: [],
    Date: [],
    DateTime: [],
    Intangible: ["Thing"],
    Enumeration: ["Intangible"],
    ItemAvailability: ["Enumeration"],
    EventStatusType: ["Enumeration"],
    CreativeWork: ["Thing"],
    Product: ["Thing"],
    Offer: ["Intangible"],
    Person: ["Thing"],
    Organization: ["Thing"],
    Place: ["Thing"],
    PostalAddress: ["Intangible"],
    Event: ["Thing"],
    Role: ["Intangible"],
    Service: ["Intangible"],
    Pendingthing: ["Thing"],
  },
  properties: {
    name: [["Thing"], ["Text"]],
    url: [["Thing"], ["URL"]],
    offers: [["Product", "Event"], ["Offer"]],
    price: [["Offer"], ["Number", "Text"]],
    availability: [["Offer"], ["ItemAvailability"]],
    author: [["CreativeWork"], ["Person", "Organization"]],
    location: [
      ["Event", "Organization"],
      ["Place", "PostalAddress", "Text"],
    ],
    eventStatus: [["Event"], ["EventStatusType"]],
    serviceArea: [["Organization", "Service"], ["Place"]],
    areaServed: [
      ["Organization", "Service"],
      ["Place", "Text"],
    ],
    performer: [["Event"], ["Person", "Organization"]],
    sparkle: [["Thing"], ["Text"]],
  },
  members: {
    InStock: ["ItemAvailability"],
    OutOfStock: ["ItemAvailability"],
    EventScheduled: ["EventStatusType"],
    EventCancelled: ["EventStatusType"],
  },
  superseded: { serviceArea: "areaServed" },
  pending: ["Pendingthing", "sparkle"],
};

const run = (value: unknown) => checkVocab(value, vocab, "#1");
const messages = (value: unknown) => run(value).map((f) => f.message);

describe("Schema.org vocabulary checks (fixture)", () => {
  it("measures edit distance with transpositions, case-insensitively", () => {
    expect(editDistance("Prodcut", "Product")).toBe(1);
    expect(editDistance("prize", "price")).toBe(1);
    expect(editDistance("NAME", "name")).toBe(0);
    expect(nearest("Prodcut", ["Product", "Person"])).toBe("Product");
    expect(nearest("Xyz", ["Product", "Person"])).toBeUndefined();
  });

  it("reads schema.org prefixes and ignores other vocabularies", () => {
    expect(schemaTerm("https://schema.org/Product")).toBe("Product");
    expect(schemaTerm("http://schema.org/Product")).toBe("Product");
    expect(schemaTerm("schema:Product")).toBe("Product");
    expect(schemaTerm("foaf:Person")).toBeNull();
    expect(schemaTerm("http://xmlns.com/foaf/0.1/Person")).toBeNull();
  });

  it("flags an unknown type with a suggestion", () => {
    const f = run({ "@context": "https://schema.org", "@type": "Prodcut", name: "Mug" });
    expect(f).toEqual([
      { severity: "error", rule: "vocab.unknown-type", path: "#1", message: "Prodcut is not a Schema.org type. Did you mean Product?" },
    ]);
  });

  it("suggests properties of the node's type first", () => {
    const f = run({ "@type": "Offer", prize: "12" });
    expect(f[0]).toMatchObject({
      rule: "vocab.unknown-property",
      path: "#1.prize",
      message: "prize is not a Schema.org property. Did you mean price?",
    });
  });

  it("warns when a property is outside the type's domain", () => {
    const f = run({ "@type": "Product", name: "Mug", author: { "@type": "Person", name: "Ann" } });
    expect(f).toEqual([
      {
        severity: "warn",
        rule: "vocab.domain",
        path: "#1.author",
        message: "author is not a property of Product: Schema.org expects it on CreativeWork",
      },
    ]);
  });

  it("warns on a nested node of a type the range does not include, but accepts text", () => {
    expect(messages({ "@type": "Event", location: { "@type": "Person", name: "Ann" } })).toEqual([
      "location expects Place, PostalAddress or Text, not Person",
    ]);
    expect(run({ "@type": "Event", location: "Paris" })).toEqual([]);
    expect(run({ "@type": "Event", location: { "@type": "Place", name: "Hall" } })).toEqual([]);
  });

  it("checks enumeration values, short or full, with a suggestion", () => {
    expect(run({ "@type": "Offer", availability: "https://schema.org/InStock" })).toEqual([]);
    expect(run({ "@type": "Offer", availability: "InStock" })).toEqual([]);
    expect(run({ "@type": "Offer", availability: { "@id": "schema:OutOfStock" } })).toEqual([]);
    expect(messages({ "@type": "Offer", availability: "InStok" })).toEqual([
      'availability "InStok" is not a valid ItemAvailability value. Did you mean https://schema.org/InStock?',
    ]);
    expect(messages({ "@type": "Event", eventStatus: "Scheduled" })[0]).toMatch(/Did you mean https:\/\/schema\.org\/EventScheduled\?/);
  });

  it("points superseded and pending terms out", () => {
    const f = run({ "@type": "Organization", serviceArea: { "@type": "Place" } });
    expect(f.map((x) => x.message)).toEqual(["serviceArea is superseded by areaServed (https://schema.org/areaServed)"]);
    expect(run({ "@type": "Pendingthing", sparkle: "x" }).map((x) => x.rule)).toEqual(["vocab.pending", "vocab.pending"]);
  });

  it("walks @graph and arrays with paths, and handles @type arrays", () => {
    const f = run({
      "@context": "https://schema.org",
      "@graph": [{ "@type": ["Product", "Thing"], offers: [{ "@type": "Offer", availability: "Nope" }] }],
    });
    expect(f.map((x) => x.path)).toEqual(["#1.@graph[0].offers[0].availability"]);
  });

  it("skips @-keywords, Action annotations, Role wrappers and other contexts", () => {
    expect(run({ "@context": "https://schema.org", "@type": "Thing", "@id": "#x", "query-input": "required name=q" })).toEqual([]);
    expect(run({ "@type": "Event", performer: { "@type": "Role", performer: { "@type": "Person", name: "A" } } })).toEqual([]);
    expect(run({ "@context": "https://www.w3.org/ns/activitystreams", "@type": "Note", content: "x" })).toEqual([]);
    expect(run({ "@context": { "@vocab": "https://schema.org/" }, "@type": "Prodcut" })).toHaveLength(1);
  });
});

describe("Schema.org vocabulary (public/schema-vocab.json)", () => {
  const real = JSON.parse(readFileSync(join(__dirname, "../public/schema-vocab.json"), "utf8")) as SchemaVocab;
  const check = (value: unknown) => checkVocab({ "@context": "https://schema.org", ...(value as object) }, real, "#1");

  it("records its source and stays compact", () => {
    expect(real.source).toMatchObject({ name: "Schema.org", license: "CC BY-SA 3.0" });
    expect(real.source.version).toMatch(/^\d+\.\d+$/);
    expect(readFileSync(join(__dirname, "../public/schema-vocab.json")).length).toBeLessThan(300 * 1024);
    expect(readFileSync(join(__dirname, "../public/schema-vocab.LICENSE.txt"), "utf8")).toMatch(/Creative Commons Attribution-ShareAlike/);
  });

  it("catches the usual mistakes", () => {
    const text = (value: unknown) => check(value).map((f) => f.message);
    expect(text({ "@type": "Prodcut", name: "Mug" })).toContain("Prodcut is not a Schema.org type. Did you mean Product?");
    expect(text({ "@type": "Offer", prize: "12", priceCurrency: "EUR" })).toContain(
      "prize is not a Schema.org property. Did you mean price?",
    );
    expect(text({ "@type": "Product", name: "Mug", author: "Ann" })[0]).toMatch(
      /^author is not a property of Product: Schema.org expects it on/,
    );
    expect(text({ "@type": "Event", name: "Gig", location: { "@type": "Person", name: "Ann" } })[0]).toMatch(
      /^location expects .*, not Person$/,
    );
    expect(text({ "@type": "Offer", availability: "InStok" })).toContain(
      'availability "InStok" is not a valid ItemAvailability value. Did you mean https://schema.org/InStock?',
    );
    expect(text({ "@type": "Event", name: "Gig", eventStatus: "Scheduled" })[0]).toMatch(
      /Did you mean https:\/\/schema\.org\/EventScheduled\?/,
    );
    expect(text({ "@type": "Organization", name: "Acme", serviceArea: "Paris" })).toContain(
      "serviceArea is superseded by areaServed (https://schema.org/areaServed)",
    );
  });

  it("finds nothing in a clean Product", () => {
    expect(
      check({
        "@type": "Product",
        name: "Mug",
        image: "https://example.com/mug.jpg",
        brand: { "@type": "Brand", name: "Acme" },
        aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 12 },
        offers: {
          "@type": "Offer",
          price: "12.50",
          priceCurrency: "EUR",
          availability: "https://schema.org/InStock",
          itemCondition: "https://schema.org/NewCondition",
          seller: { "@type": "Organization", name: "Acme" },
        },
      }),
    ).toEqual([]);
  });

  it("feeds analyzeJsonLd: findings land on their node, and replace the built-in availability check", () => {
    const raw = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Mug",
      offers: { "@type": "Offer", availability: "InStok" },
    });
    const r = analyzeJsonLd([{ raw, index: 0 }], { vocab: real });
    expect(r.vocab?.version).toBe(real.source.version);
    const offer = r.blocks[0]!.nodes.find((n) => n.types.includes("Offer"))!;
    expect(offer.findings.filter((f) => /availability/.test(f.message)).map((f) => f.rule)).toEqual(["vocab.enum"]);
    const without = analyzeJsonLd([{ raw, index: 0 }]);
    expect(without.blocks[0]!.nodes[1]!.findings.some((f) => f.rule === "format.availability")).toBe(true);
  });
});
