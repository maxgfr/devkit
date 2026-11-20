import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeDataPage } from "../src/lib/data-viewer";
import { JSON_VIEWER_HOST_ID } from "../src/lib/json-viewer";
import { mountDataViewer, readPageSource } from "../src/lib/json-viewer-view";
import { jsonViewerState } from "../src/lib/page/json-viewer";

const host = (doc: Document = document) => doc.getElementById(JSON_VIEWER_HOST_ID)!;
const shadow = (doc: Document = document) => host(doc).shadowRoot!;
const $ = (sel: string, doc?: Document) => shadow(doc).querySelector(sel) as HTMLElement | null;
const $$ = (sel: string, doc?: Document) => Array.from(shadow(doc).querySelectorAll(sel)) as HTMLElement[];
const btn = (label: string, doc?: Document) => $$(".bar button", doc).find((b) => b.textContent === label) as HTMLButtonElement;
const node = (path: string, doc?: Document) => $(`.node[data-path='${path}']`, doc);
const filter = (query: string) => {
  const input = $("input[type=search]") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
};

/** A text document as Chrome shows it: one <pre>. */
const mountText = (text: string, contentType: string, url = "https://data.test/file", force = false) => {
  document.body.innerHTML = "<pre></pre>";
  document.querySelector("pre")!.textContent = text;
  return mountDataViewer(document, { contentType, url, force });
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("data viewer: YAML", () => {
  const YAML = "name: devkit\nlinks:\n  home: https://devkit.test/\ntags: [a, b]\nsteps:\n  - run: test\n  - run: build\n";

  it("renders YAML as the JSON tree and copies it as JSON", async () => {
    expect(mountText(YAML, "text/yaml")).toBe("tree");
    expect(host().dataset.format).toBe("yaml");
    expect($(".bar")!.getAttribute("aria-label")).toBe("YAML viewer");
    expect(node("$.name")!.querySelector(".s")!.textContent).toBe('"devkit"');
    expect(node("$.links.home a")).toBeNull();
    expect(node("$.links.home")!.querySelector("a")!.getAttribute("href")).toBe("https://devkit.test/");
    expect(node("$.steps")!.querySelector(".count")!.textContent).toBe("[2]");
    expect(btn("Copy").title).toBe("Copy as JSON, indented");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    btn("Copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"run": "build"')));
    btn("Raw").click();
    expect($(".raw")!.textContent).toBe(YAML);
  });

  it("labels several documents", () => {
    mountText("a: 1\n---\nb: 2\n", "application/x-yaml");
    expect(node("$[1]")!.querySelector(".key")!.textContent).toBe("document 2");
    expect($$(".bar .meta").some((m) => m.textContent === "2 documents")).toBe(true);
  });

  it("shows unsupported syntax as raw text with an honest message", () => {
    expect(mountText("bucket: !Ref MyBucket\n", "text/yaml")).toBe("unsupported");
    expect($(".banner.info")!.textContent).toMatch(/uses the custom tag !Ref \(line 1\), which devkit's YAML reader does not support/);
    expect($(".raw")!.textContent).toContain("!Ref");
    expect(btn("Parsed").disabled).toBe(true);
  });

  it("shows invalid YAML with its line", () => {
    expect(mountText("a: 1\n  b: 2\n", "text/yaml")).toBe("invalid");
    expect($(".banner.error")!.textContent).toMatch(/^Invalid YAML at line 2/);
  });

  it("formats .yml files served as text/plain only when they parse", () => {
    expect(mountText("on: push\njobs: {}\n", "text/plain", "https://raw.test/ci.yml")).toBe("tree");
    expect(mountText("a: 1\n  b: 2", "text/plain", "https://raw.test/bad.yml")).toBe("not-data");
    // Asked for explicitly, the error shows.
    expect(mountText("a: 1\n  b: 2", "text/plain", "https://raw.test/bad.yml", true)).toBe("invalid");
  });
});

describe("data viewer: JSON Lines", () => {
  it("renders one tree per line and flags invalid lines", () => {
    expect(mountText('{"level":"info","msg":"up"}\n{"level":"error"\n\n{"level":"warn","n":[1,2]}\n', "application/x-ndjson")).toBe("tree");
    expect(host().dataset.format).toBe("jsonl");
    expect(node("$")!.querySelector(".count")!.textContent).toBe("[3]");
    expect(node("$[0]")!.querySelector(".key")!.textContent).toBe("line 1");
    expect(node("$[2]")!.querySelector(".key")!.textContent).toBe("line 4");
    expect(node("$[2].n")).not.toBeNull();
    const bad = node("$[1]")!;
    expect(bad.classList.contains("bad")).toBe(true);
    expect(bad.querySelector(".err")!.textContent).toMatch(/^Invalid JSON: /);
    expect(bad.querySelector(".src")!.textContent).toContain('{"level":"error"');
    expect($(".banner.error")!.textContent).toMatch(/^Line 2 is not valid JSON/);
    filter("warn");
    expect(node("$[2].level")!.classList.contains("hit")).toBe(true);
    expect(node("$[0]")).toBeNull();
  });

  it("copies a path relative to its line", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mountText('{"a":{"b":1}}\n{"a":{"b":2}}', "text/plain", "https://x.test/events.jsonl");
    (node("$[1].a.b")!.querySelector(".key") as HTMLElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("$.a.b"));
    await vi.waitFor(() => expect($(".toast")!.textContent).toBe("Copied $.a.b (line 2)"));
  });

  it("is invalid when no line parses, and sniffed from text/plain when asked", () => {
    expect(mountText("nope\nnope", "application/jsonl")).toBe("invalid");
    expect(mountText('{"a":1}\n{"a":2}', "text/plain", "https://x.test/log", true)).toBe("tree");
    expect(host().dataset.format).toBe("jsonl");
  });
});

describe("data viewer: CSV", () => {
  const CSV = "name,score,site\nAda,10,https://ada.test/\nalan,9,\nGrace,100,x\n";
  const rows = () => $$("tbody tr").map((tr) => Array.from(tr.querySelectorAll("td"), (td) => td.textContent));

  it("renders a table with a sticky header, row numbers and links", () => {
    expect(mountText(CSV, "text/csv")).toBe("tree");
    expect(host().dataset.format).toBe("csv");
    expect(btn("Table").getAttribute("aria-pressed")).toBe("true");
    expect(btn("Expand all").hidden).toBe(true);
    expect($$("thead th").map((th) => th.textContent)).toEqual(["#", "name", "score", "site"]);
    expect(rows()).toEqual([
      ["Ada", "10", "https://ada.test/"],
      ["alan", "9", ""],
      ["Grace", "100", "x"],
    ]);
    expect($("tbody td a")!.getAttribute("href")).toBe("https://ada.test/");
    expect($("tbody .rn")!.title).toBe("Line 2 of the file");
    expect($$(".bar .meta").some((m) => m.textContent === "3 rows × 3 columns, comma-separated")).toBe(true);
  });

  it("sorts by a column, then reverses, then restores the order", () => {
    mountText(CSV, "text/csv");
    const sortBy = (name: string) => $$("thead .sort").find((b) => b.textContent?.startsWith(name))!;
    sortBy("score").click();
    expect(rows().map((r) => r[0])).toEqual(["alan", "Ada", "Grace"]);
    expect(sortBy("score").parentElement!.getAttribute("aria-sort")).toBe("ascending");
    sortBy("score").click();
    expect(rows().map((r) => r[0])).toEqual(["Grace", "Ada", "alan"]);
    sortBy("score").click();
    expect(rows().map((r) => r[0])).toEqual(["Ada", "alan", "Grace"]);
    expect(sortBy("score").parentElement!.getAttribute("aria-sort")).toBe("none");
  });

  it("filters rows and counts them", () => {
    mountText(CSV, "text/csv");
    filter("GRACE");
    expect(rows()).toEqual([["Grace", "100", "x"]]);
    expect($$(".bar .meta").some((m) => m.textContent === "1 of 3 rows")).toBe(true);
    filter("nothing");
    expect($(".empty")!.textContent).toBe("No row matches the filter.");
  });

  it("toggles the header row and wraps cells", () => {
    mountText(CSV, "text/csv");
    const header = btn("Header row");
    expect(header.getAttribute("aria-pressed")).toBe("true");
    expect(header.title).toMatch(/heuristic/);
    header.click();
    expect(header.getAttribute("aria-pressed")).toBe("false");
    expect($$("thead th").map((th) => th.textContent)).toEqual(["#", "Column 1", "Column 2", "Column 3"]);
    expect(rows()[0]).toEqual(["name", "score", "site"]);
    btn("Wrap").click();
    expect($(".app")!.classList.contains("wrap")).toBe(true);
  });

  it("sniffs the delimiter, flags ragged rows and shows TSV", () => {
    mountText("a;b\n1;2;3\n4;5\n", "text/plain", "https://x.test/export.csv");
    expect($$("thead th").map((th) => th.textContent)).toEqual(["#", "a", "b", "Column 3"]);
    expect($$("tbody tr")[0]!.classList.contains("ragged")).toBe(true);
    expect($$("tbody tr")[0]!.title).toBe("Line 2 has 3 fields, the header has 2");
    expect($(".banner.info")!.textContent).toBe("1 row has a different number of fields (line 2)");
    mountTextAgain("x\ty\n1\t2\n", "text/tab-separated-values");
    expect(host().dataset.format).toBe("tsv");
    expect(rows()).toEqual([["1", "2"]]);
  });

  it("reports an unterminated quote", () => {
    mountText('a,b\n1,"open\n2,3\n', "text/csv");
    expect($(".banner.error")!.textContent).toBe("Unterminated quoted field at line 2 (the rest of the file is read as that one field)");
    expect(host().dataset.state).toBe("tree");
  });

  it("builds big tables in chunks", () => {
    const big = `n\n${Array.from({ length: 1205 }, (_, i) => i).join("\n")}`;
    mountText(big, "text/csv");
    expect($$("tbody tr").length).toBe(500);
    const more = $(".more")!;
    expect(more.textContent).toBe("Show 500 more rows (705 left)");
    more.click();
    expect($$("tbody tr").length).toBe(1000);
  });
});

/** Mounts again on a fresh page (the viewer refuses to mount twice). */
function mountTextAgain(text: string, contentType: string) {
  document.head.innerHTML = "";
  return mountText(text, contentType);
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme blog</title><link>https://acme.test/</link>
<item><title>First post</title><link>https://acme.test/1</link><pubDate>Mon, 02 Nov 2026</pubDate></item>
<item><title>Second</title><link>https://acme.test/2</link></item>
</channel></rss>`;

describe("data viewer: XML", () => {
  /** What Chrome's XML viewer leaves in the page: the original nodes moved into a hidden div. */
  const chromeXmlViewer = (xml: string) => {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    document.body.innerHTML =
      '<div id="webkit-xml-viewer-source-xml"></div><div class="header">This XML file does not appear to have any style information associated with it.</div>';
    const holder = document.getElementById("webkit-xml-viewer-source-xml")!;
    for (const n of Array.from(parsed.childNodes)) holder.append(document.importNode(n, true));
  };

  it("reads the source Chrome's XML viewer moved aside, and renders the element tree", () => {
    chromeXmlViewer(RSS);
    expect(readPageSource(document, "application/xml")!.text).toContain('<rss version="2.0">');
    expect(mountDataViewer(document, { contentType: "application/xml", url: "https://acme.test/feed.xml" })).toBe("tree");
    expect(host().dataset.format).toBe("xml");
    expect(btn("Tree").getAttribute("aria-pressed")).toBe("true");
    const rss = node("/rss")!;
    expect(rss.querySelector(".tagname")!.textContent).toBe("rss");
    expect(rss.querySelector(".an")!.textContent).toBe("version");
    expect(rss.querySelector(".av")!.textContent).toBe('"2.0"');
    // A lone text child stays on its element's line.
    expect(node("/rss/channel/item[1]/title")!.textContent).toBe("<title>First post</title>");
    expect(node("/rss/channel/link")!.querySelector("a")!.getAttribute("href")).toBe("https://acme.test/");
    expect(document.getElementById("devkit-json-viewer-style")!.textContent).toContain("display:none");
  });

  it("shows a feed summary above the tree", () => {
    chromeXmlViewer(RSS);
    mountDataViewer(document, { contentType: "application/rss+xml" });
    const feed = $(".feed")!;
    expect(feed.querySelector("summary")!.textContent).toBe("RSS feed · 2 items");
    expect(feed.querySelector(".feed-title a")!.textContent).toBe("Acme blog");
    expect(Array.from(feed.querySelectorAll(".feed-items li"), (li) => li.textContent)).toEqual(["First postMon, 02 Nov 2026", "Second"]);
    expect(feed.querySelector(".feed-items a")!.getAttribute("href")).toBe("https://acme.test/1");
  });

  it("collapses, expands and filters elements", () => {
    chromeXmlViewer(RSS);
    mountDataViewer(document, { contentType: "text/xml" });
    const toggle = node("/rss/channel/item[1]")!.querySelector(":scope > .line > .tog") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(node("/rss/channel/item[1]")!.querySelector(":scope > .line .tail")!.textContent).toBe("…</item>");
    btn("Expand all").click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    btn("Collapse all").click();
    expect((node("/rss/channel")!.querySelector(":scope > .line > .tog") as HTMLElement).getAttribute("aria-expanded")).toBe("false");
    filter("second");
    expect(node("/rss/channel/item[2]/title")!.classList.contains("hit")).toBe(true);
    expect(node("/rss/channel/item[1]")).toBeNull();
    expect($(".feed")).toBeNull();
    expect($$(".bar .meta").some((m) => m.textContent === "1 match")).toBe(true);
  });

  it("copies an element's XPath and the indented XML", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    chromeXmlViewer(RSS);
    mountDataViewer(document, { contentType: "application/xml" });
    (node("/rss/channel/item[2]/link")!.querySelector(".tagname") as HTMLElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("/rss/channel/item[2]/link"));
    btn("Copy").click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("    <item>\n      <title>First post</title>")),
    );
  });

  it("leaves documents with an xml-stylesheet alone", () => {
    // happy-dom's parser drops top-level processing instructions: build what Chrome keeps.
    chromeXmlViewer("<a/>");
    const holder = document.getElementById("webkit-xml-viewer-source-xml")!;
    holder.prepend(document.createProcessingInstruction("xml-stylesheet", 'type="text/css" href="s.css"'));
    expect(mountDataViewer(document, { contentType: "application/xml" })).toBe("not-data");
    expect(document.getElementById(JSON_VIEWER_HOST_ID)).toBeNull();
  });

  it("formats an XML document shown without Chrome's viewer, in an XHTML body of its own", () => {
    const xml = new DOMParser().parseFromString("<note><to>Ada</to></note>", "application/xml");
    expect(mountDataViewer(xml, { contentType: "application/xml", url: "https://x.test/note.xml" })).toBe("tree");
    expect(xml.documentElement.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(xml.getElementById(`${JSON_VIEWER_HOST_ID}-source`)!.querySelector("note")).not.toBeNull();
    expect(node("/note/to", xml)!.textContent).toBe("<to>Ada</to>");
  });

  it("shows the browser's parse error with its position", () => {
    const xml = new DOMParser().parseFromString("<a>\n<b></a>", "application/xml");
    expect(mountDataViewer(xml, { contentType: "application/xml" })).toBe("invalid");
    expect($(".banner.error", xml)!.textContent).toMatch(/^Invalid XML at line 2, column 8: Opening and ending tag mismatch/);
    expect($(".raw", xml)!.textContent).not.toContain("parsererror");
  });

  it("formats RSS that Chrome shows as text/plain, and XML text when asked", () => {
    expect(mountText(RSS, "text/plain", "https://acme.test/feed")).toBe("tree");
    expect($(".feed summary")!.textContent).toBe("RSS feed · 2 items");
    document.head.innerHTML = "";
    expect(mountText("<note><to>Ada</to></note>", "text/plain", "https://x.test/n")).toBe("not-data");
    expect(mountText("<note><to>Ada</to></note>", "text/plain", "https://x.test/n", true)).toBe("tree");
    expect(jsonViewerState(JSON_VIEWER_HOST_ID)).toMatchObject({ state: "tree", format: "xml" });
  });

  it("shows invalid XML text with its position", () => {
    expect(mountText("<a>\n<b></a>", "text/xml")).toBe("invalid");
    expect($(".banner.error")!.textContent).toMatch(/^Invalid XML at line 2, column 8/);
    expect($(".raw")!.textContent).toBe("<a>\n<b></a>");
  });
});

describe("data viewer: the always-on gate", () => {
  const pre = (text: string) => {
    document.body.innerHTML = "<pre></pre>";
    document.querySelector("pre")!.textContent = text;
  };

  it("asks for the viewer on data documents only", () => {
    pre("a: 1");
    expect(looksLikeDataPage(document, "https://x.test/a", "text/yaml")).toBe(true);
    expect(looksLikeDataPage(document, "https://x.test/a", "text/plain")).toBe(false);
    expect(looksLikeDataPage(document, "https://x.test/a.yml", "text/plain")).toBe(true);
    pre(RSS);
    expect(looksLikeDataPage(document, "https://x.test/feed", "text/plain")).toBe(true);
    pre('{"a":1}');
    expect(looksLikeDataPage(document, "https://x.test/api", "application/json")).toBe(true);
    // JSON as text/plain waits for an explicit request, as before.
    expect(looksLikeDataPage(document, "https://x.test/api", "text/plain")).toBe(false);
    document.body.innerHTML = "<h1>Page</h1><pre>a,b</pre>";
    expect(looksLikeDataPage(document, "https://x.test/a.csv", "text/plain")).toBe(false);
    pre("a,b");
    expect(looksLikeDataPage(document, "https://x.test/a.csv", "text/html")).toBe(false);
  });

  it("recognizes XML documents, Chrome's XML viewer included, but not SVG", () => {
    document.body.innerHTML = '<div id="webkit-xml-viewer-source-xml"></div>';
    expect(looksLikeDataPage(document, "https://x.test/a.xml", "application/xml")).toBe(true);
    const xml = new DOMParser().parseFromString("<note/>", "application/xml");
    expect(looksLikeDataPage(xml, "https://x.test/n", "application/xml")).toBe(true);
    const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml");
    expect(looksLikeDataPage(svg, "https://x.test/i.svg", "image/svg+xml")).toBe(false);
  });
});
