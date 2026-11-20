import { describe, expect, it } from "vitest";
import { dataViewerMessage, detectFormat, formatFromContentType, formatFromUrl } from "../src/lib/data-viewer";
import { invalidLinesMessage, looksLikeJsonLines, parseJsonLines } from "../src/lib/formats/jsonl";
import {
  type DomLike,
  elementPaths,
  feedSummary,
  filterXml,
  hasXmlStylesheet,
  inlineText,
  invalidXmlMessage,
  looksLikeFeed,
  looksLikeXml,
  parseXml,
  serializeXml,
  topPaths,
  type XmlDoc,
  xmlDeclaration,
  xmlDocFromDom,
  xmlErrorPosition,
} from "../src/lib/formats/xml";
import { downloadName } from "../src/lib/json-viewer";

describe("data viewer: format detection", () => {
  it("maps content types to formats", () => {
    const cases: [string, string | null][] = [
      ["application/json; charset=utf-8", "json"],
      ["application/problem+json", "json"],
      ["application/xml", "xml"],
      ["text/xml", "xml"],
      ["application/rss+xml", "xml"],
      ["application/atom+xml", "xml"],
      ["application/soap+xml", "xml"],
      ["application/xhtml+xml", null],
      ["image/svg+xml", null],
      ["text/csv", "csv"],
      ["application/csv", "csv"],
      ["text/tab-separated-values", "tsv"],
      ["application/yaml", "yaml"],
      ["text/yaml", "yaml"],
      ["application/x-yaml", "yaml"],
      ["text/x-yaml", "yaml"],
      ["application/x-ndjson", "jsonl"],
      ["application/jsonl", "jsonl"],
      ["application/json-seq", "jsonl"],
      ["text/plain", null],
      ["text/html", null],
      ["", null],
    ];
    for (const [type, format] of cases) expect(formatFromContentType(type), type).toBe(format);
  });

  it("maps URL extensions to formats", () => {
    expect(formatFromUrl("https://raw.githubusercontent.com/o/r/main/.github/workflows/ci.yml")).toBe("yaml");
    expect(formatFromUrl("https://x.test/data/export.CSV?download=1")).toBe("csv");
    expect(formatFromUrl("https://x.test/a.tsv")).toBe("tsv");
    expect(formatFromUrl("https://x.test/feed.rss")).toBe("xml");
    expect(formatFromUrl("https://x.test/logs.ndjson")).toBe("jsonl");
    expect(formatFromUrl("https://x.test/logs.jsonl#x")).toBe("jsonl");
    expect(formatFromUrl("https://x.test/package.json")).toBe("json");
    expect(formatFromUrl("https://x.test/readme.md")).toBeNull();
    expect(formatFromUrl("https://x.test/")).toBeNull();
    expect(formatFromUrl("not a url")).toBeNull();
  });

  it("detects declared, URL-hinted, feed and forced formats", () => {
    expect(detectFormat({ contentType: "application/xml" })).toEqual({ format: "xml", declared: true });
    expect(detectFormat({ contentType: "text/plain", url: "https://x.test/a.yaml" })).toEqual({ format: "yaml", declared: false });
    expect(
      detectFormat({
        contentType: "text/plain",
        url: "https://x.test/feed",
        text: '<?xml version="1.0"?><rss version="2.0"><channel/></rss>',
      }),
    ).toEqual({
      format: "xml",
      declared: false,
    });
    expect(detectFormat({ contentType: "text/plain", url: "https://x.test/feed", text: "<note>hi</note>" })).toBeNull();
    expect(detectFormat({ contentType: "text/plain", text: "<note>hi</note>", force: true })).toEqual({ format: "xml", declared: false });
    expect(detectFormat({ contentType: "text/plain", text: '{"a":1}', force: true })).toEqual({ format: "json", declared: false });
    expect(detectFormat({ contentType: "text/plain", text: '{"a":1}\n{"a":2}', force: true })).toEqual({
      format: "jsonl",
      declared: false,
    });
    expect(detectFormat({ contentType: "text/plain", text: '{"a":1}' })).toBeNull();
    expect(detectFormat({ contentType: "text/plain", text: "a,b\n1,2", force: true })).toBeNull();
    expect(detectFormat({ contentType: "text/html", url: "https://x.test/a.json" })).toBeNull();
    expect(detectFormat({ contentType: "image/png", url: "https://x.test/a.csv" })).toBeNull();
  });

  it("names downloads per format", () => {
    expect(downloadName("https://x.test/feed.xml", "xml")).toBe("feed.xml");
    expect(downloadName("https://x.test/config.yaml", "json")).toBe("config.json");
    expect(downloadName("https://x.test/data/export.csv", "csv")).toBe("export.csv");
    expect(downloadName("https://x.test/logs.ndjson", "json")).toBe("logs.json");
  });

  it("words the palette messages per format", () => {
    expect(dataViewerMessage("tree", "xml", "application/xml")).toBe("XML formatted.");
    expect(dataViewerMessage("tree", "csv", "text/plain")).toBe("CSV shown as a table.");
    expect(dataViewerMessage("raw", "jsonl", "text/plain")).toBe("JSON Lines formatted.");
    expect(dataViewerMessage("invalid", "yaml", "text/yaml")).toBe("Invalid YAML: shown as raw text with where it breaks.");
    expect(dataViewerMessage("unsupported", "yaml", "text/yaml")).toMatch(/^YAML shown as raw text: it uses syntax/);
    expect(dataViewerMessage("large", "xml", "text/xml")).toMatch(/^Large XML document/);
    expect(dataViewerMessage(null, null, "")).toMatch(/\(unknown type\)/);
  });
});

describe("data viewer: JSON Lines", () => {
  it("parses one value per line and flags invalid lines with their number", () => {
    const r = parseJsonLines('{"a":1}\r\n\n[2]\n{bad}\n"str"\n');
    expect(r.valid).toBe(3);
    expect(r.invalid).toBe(1);
    expect(r.items.map((l) => l.line)).toEqual([1, 3, 4, 5]);
    expect(r.items[0]!.value).toEqual({ a: 1 });
    expect(r.items[2]).toMatchObject({ line: 4, ok: false, text: "{bad}" });
    expect(invalidLinesMessage(r)).toBe("Line 4 is not valid JSON");
    expect(invalidLinesMessage(parseJsonLines("x\ny\n1"))).toBe("2 of 3 lines are not valid JSON: 1, 2");
    expect(invalidLinesMessage(parseJsonLines("1"))).toBe("");
  });

  it("reads JSON text sequences (RS separators)", () => {
    const r = parseJsonLines('\u001e{"a":1}\n\u001e{"a":2}\n');
    expect(r.items.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("sniffs JSON Lines only for several object or array lines", () => {
    expect(looksLikeJsonLines('{"a":1}\n{"a":2}')).toBe(true);
    expect(looksLikeJsonLines('{"a":1}')).toBe(false);
    expect(looksLikeJsonLines("1\n2")).toBe(false);
    expect(looksLikeJsonLines('{"a":1}\nnope')).toBe(false);
  });
});

/** A DOM-like tree for the model, without a parser (happy-dom's XML parser has no CDATA). */
const E = (name: string, attrs: Record<string, string>, ...children: DomLike[]): DomLike => ({
  nodeType: 1,
  nodeName: name,
  attributes: Object.entries(attrs).map(([n, value]) => ({ name: n, value })),
  childNodes: children,
});
const T = (value: string): DomLike => ({ nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] });
const CD = (value: string): DomLike => ({ nodeType: 4, nodeName: "#cdata-section", nodeValue: value, childNodes: [] });
const C = (value: string): DomLike => ({ nodeType: 8, nodeName: "#comment", nodeValue: value, childNodes: [] });
const PI = (target: string, value: string): DomLike => ({ nodeType: 7, nodeName: target, nodeValue: value, childNodes: [] });

const RSS: DomLike[] = [
  PI("xml-stylesheet", 'href="feed.xsl"'),
  C(" generated "),
  E(
    "rss",
    { version: "2.0" },
    T("\n  "),
    E(
      "channel",
      {},
      E("title", {}, T("Acme blog")),
      E("link", {}, T("https://acme.test/")),
      E("description", {}, CD("News & <b>notes</b>")),
      E(
        "item",
        {},
        E("title", {}, T("First post")),
        E("link", {}, T("https://acme.test/1")),
        E("pubDate", {}, T("Mon, 02 Nov 2026 10:00:00 GMT")),
      ),
      E("item", {}, E("title", {}, T("Second")), E("guid", {}, T("https://acme.test/2")), E("dc:date", {}, T("2026-11-03"))),
    ),
  ),
];

describe("data viewer: XML model", () => {
  const doc = xmlDocFromDom(RSS, '<?xml version="1.0"?>')!;

  it("builds a tree with attributes, text, CDATA, comments and processing instructions", () => {
    expect(doc.root.name).toBe("rss");
    expect(doc.root.attrs).toEqual([["version", "2.0"]]);
    expect(doc.nodes.map((n) => n.type)).toEqual(["pi", "comment", "element"]);
    // Whitespace-only text between elements is dropped.
    expect(doc.root.children.map((c) => c.type)).toEqual(["element"]);
    const channel = doc.root.children[0]!;
    expect(channel.type === "element" && channel.children[2]).toMatchObject({
      name: "description",
      children: [{ type: "cdata", text: "News & <b>notes</b>" }],
    });
    expect(hasXmlStylesheet(RSS)).toBe(true);
    expect(hasXmlStylesheet([E("a", {})])).toBe(false);
    expect(xmlDocFromDom([C("x")])).toBeNull();
  });

  it("gives XPath-like paths, with positions only for repeated names", () => {
    expect(topPaths(doc)).toEqual(["/processing-instruction()[1]", "/comment()[1]", "/rss"]);
    const channel = doc.root.children[0]!;
    if (channel.type !== "element") throw new Error("channel");
    expect(elementPaths("/rss/channel", channel.children)).toEqual([
      "/rss/channel/title",
      "/rss/channel/link",
      "/rss/channel/description",
      "/rss/channel/item[1]",
      "/rss/channel/item[2]",
    ]);
    expect(
      elementPaths("/a", [
        { type: "text", text: "x" },
        { type: "comment", text: "c" },
        { type: "text", text: "y" },
      ]),
    ).toEqual(["/a/text()[1]", "/a/comment()[1]", "/a/text()[2]"]);
  });

  it("filters on names, attributes and text, keeping ancestors", () => {
    expect(filterXml(doc, " ")).toBeNull();
    const f = filterXml(doc, "second")!;
    expect([...f.matched]).toEqual(["/rss/channel/item[2]/title/text()[1]"]);
    expect(f.visible.has("/rss/channel/item[2]")).toBe(true);
    expect(f.visible.has("/rss/channel/item[1]")).toBe(false);
    expect(filterXml(doc, "version")!.matched.has("/rss")).toBe(true);
    expect(filterXml(doc, "pubdate")!.matched.has("/rss/channel/item[1]/pubDate")).toBe(true);
    expect(filterXml(doc, "generated")!.matched.has("/comment()[1]")).toBe(true);
    expect(filterXml(doc, "zzz")!.count).toBe(0);
  });

  it("serializes the document indented, escaping text and attributes", () => {
    const small: XmlDoc = xmlDocFromDom(
      [C("c"), E("a", { x: '1"<' }, E("b", {}, T(" t & u ")), E("c", {}), E("d", {}, CD("<raw>"), E("e", {})))],
      '<?xml version="1.0"?>',
    )!;
    expect(serializeXml(small)).toBe(
      [
        '<?xml version="1.0"?>',
        "<!--c-->",
        '<a x="1&quot;&lt;">',
        "  <b>t &amp; u</b>",
        "  <c/>",
        "  <d>",
        "    <![CDATA[<raw>]]>",
        "    <e/>",
        "  </d>",
        "</a>",
      ].join("\n"),
    );
    expect(inlineText({ type: "element", name: "x", attrs: [], children: [{ type: "text", text: "a\nb" }] })).toBeNull();
  });

  it("summarizes RSS 2.0, Atom and RSS 1.0 feeds", () => {
    expect(feedSummary(doc)).toEqual({
      kind: "RSS",
      title: "Acme blog",
      link: "https://acme.test/",
      description: "News & <b>notes</b>",
      items: [
        { title: "First post", link: "https://acme.test/1", date: "Mon, 02 Nov 2026 10:00:00 GMT" },
        { title: "Second", link: "https://acme.test/2", date: "2026-11-03" },
      ],
    });
    const atom = xmlDocFromDom([
      E(
        "feed",
        { xmlns: "http://www.w3.org/2005/Atom" },
        E("title", {}, T("Atom site")),
        E("link", { rel: "self", href: "https://a.test/feed" }),
        E("link", { href: "https://a.test/" }),
        E(
          "entry",
          {},
          E("title", { type: "html" }, T("Entry")),
          E("link", { rel: "alternate", href: "https://a.test/e" }),
          E("updated", {}, T("2026-11-01T00:00:00Z")),
        ),
      ),
    ])!;
    expect(feedSummary(atom)).toEqual({
      kind: "Atom",
      title: "Atom site",
      link: "https://a.test/",
      description: "",
      items: [{ title: "Entry", link: "https://a.test/e", date: "2026-11-01T00:00:00Z" }],
    });
    const rdf = xmlDocFromDom([
      E(
        "rdf:RDF",
        {},
        E("channel", {}, E("title", {}, T("RDF"))),
        E("item", { "rdf:about": "https://r.test/1" }, E("title", {}, T("One"))),
      ),
    ])!;
    expect(feedSummary(rdf)).toMatchObject({
      kind: "RSS 1.0",
      title: "RDF",
      items: [{ title: "One", link: "https://r.test/1", date: "" }],
    });
    expect(feedSummary(xmlDocFromDom([E("note", {})])!)).toBeNull();
  });

  it("parses with DOMParser and reports errors with their position", () => {
    const r = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<a x="1"><b>t</b></a>', new DOMParser());
    expect(r.ok).toBe(true);
    expect(r.doc!.declaration).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(r.doc!.root).toMatchObject({
      name: "a",
      attrs: [["x", "1"]],
      children: [{ name: "b", children: [{ type: "text", text: "t" }] }],
    });
    const bad = parseXml("<a>\n<b></a>", new DOMParser());
    expect(bad).toMatchObject({ ok: false, line: 2, column: 8 });
    expect(invalidXmlMessage(bad)).toMatch(/^Invalid XML at line 2, column 8: Opening and ending tag mismatch/);
    expect(invalidXmlMessage({ error: "boom" })).toBe("Invalid XML: boom");
    expect(
      parseXml("x", {
        parseFromString: () => {
          throw new Error("no parser");
        },
      }),
    ).toEqual({ ok: false, error: "no parser" });
  });

  it("reads error positions from Chrome and Firefox messages", () => {
    expect(xmlErrorPosition("error on line 3 at column 14: Extra content")).toEqual({ line: 3, column: 14 });
    expect(xmlErrorPosition("XML Parsing Error: mismatched tag\nLocation: x\nLine Number 7, Column 2:")).toEqual({ line: 7, column: 2 });
    expect(xmlErrorPosition("nothing")).toBeNull();
  });

  it("sniffs XML and feeds in plain text", () => {
    expect(xmlDeclaration("  <?xml version='1.0'?><a/>")).toBe("<?xml version='1.0'?>");
    expect(xmlDeclaration("<a/>")).toBeUndefined();
    for (const s of ["<?xml version='1.0'?><a/>", "<a/>", "<!-- c --><a/>", "\uFEFF<root x='1'>"]) expect(looksLikeXml(s), s).toBe(true);
    for (const s of ["a<b", "{}", "< a>", ""]) expect(looksLikeXml(s), s).toBe(false);
    expect(looksLikeFeed('<?xml version="1.0"?>\n<rss version="2.0">')).toBe(true);
    expect(looksLikeFeed('<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(looksLikeFeed('<rdf:RDF xmlns:rdf="x">')).toBe(true);
    expect(looksLikeFeed("<feed><x/></feed>")).toBe(false);
    expect(looksLikeFeed("<note>rss</note>")).toBe(false);
  });
});
