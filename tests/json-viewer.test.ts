import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS } from "../src/lib/actions";
import {
  CHUNK,
  childPath,
  countLabel,
  downloadName,
  entriesOf,
  filterJson,
  formatSize,
  invalidMessage,
  isHttpUrl,
  isJsonContentType,
  JSON_VIEWER_HOST_ID,
  jsonViewerMessage,
  jsPath,
  kindOf,
  MAX_FORMAT_CHARS,
  rawJsonPre,
} from "../src/lib/json-viewer";
import { mountJsonViewer } from "../src/lib/json-viewer-view";
import { forceJsonViewer, jsonViewerState } from "../src/lib/page/json-viewer";

describe("json viewer: content type and page shape", () => {
  it("accepts JSON content types only", () => {
    for (const t of [
      "application/json",
      "application/json; charset=utf-8",
      "text/json",
      "application/ld+json",
      "application/problem+json",
      "APPLICATION/JSON",
    ])
      expect(isJsonContentType(t), t).toBe(true);
    for (const t of ["text/html", "text/plain", "application/javascript", "application/jsonp", "", null, undefined])
      expect(isJsonContentType(t), String(t)).toBe(false);
  });

  it("finds the raw <pre> of a JSON document, Chrome's empty formatter container included", () => {
    document.body.innerHTML = '<pre>{"a":1}</pre><div class="json-formatter-container"></div>';
    expect(rawJsonPre(document.body)?.textContent).toBe('{"a":1}');
    document.body.innerHTML = "\n<pre>[1]</pre>\n";
    expect(rawJsonPre(document.body)).not.toBeNull();
  });

  it("rejects ordinary pages", () => {
    document.body.innerHTML = "<pre>{}</pre><p>Some text</p>";
    expect(rawJsonPre(document.body)).toBeNull();
    document.body.innerHTML = "<pre>{}</pre><pre>{}</pre>";
    expect(rawJsonPre(document.body)).toBeNull();
    document.body.innerHTML = "<div>no pre</div>";
    expect(rawJsonPre(document.body)).toBeNull();
    document.body.innerHTML = "<pre>{}</pre><script>1</script>";
    expect(rawJsonPre(document.body)).toBeNull();
    expect(rawJsonPre(null)).toBeNull();
  });
});

describe("json viewer: values and paths", () => {
  it("classifies values and counts items", () => {
    expect([{}, [], "s", 1, true, null].map(kindOf)).toEqual(["object", "array", "string", "number", "boolean", "null"]);
    expect(countLabel({ a: 1, b: 2, c: 3 })).toBe("{3}");
    expect(countLabel(Array(100).fill(0))).toBe("[100]");
    expect(countLabel("x")).toBe("");
    expect(entriesOf(["a", "b"])).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    expect(entriesOf({ k: 1 })).toEqual([["k", 1]]);
  });

  it("builds JSONPath and JavaScript paths", () => {
    const p = childPath(childPath(childPath("$", "data"), 0), "id");
    expect(p).toBe("$.data[0].id");
    expect(jsPath(p)).toBe("data[0].id");
    expect(childPath("$", "content-type")).toBe('$["content-type"]');
    expect(childPath("$", "")).toBe('$[""]');
    expect(childPath("$", "$ref")).toBe("$.$ref");
    expect(jsPath('$["a b"]')).toBe('["a b"]');
    expect(jsPath("$[2]")).toBe("[2]");
    expect(jsPath("$")).toBe("$");
  });

  it("links http(s) URLs only", () => {
    expect(isHttpUrl("https://jsonplaceholder.typicode.com/posts/1")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/a?b=c#d")).toBe(true);
    for (const s of [
      "javascript:alert(1)",
      "ftp://x.test",
      "https://",
      "see https://a.test",
      "https://a.test/a b",
      "/relative",
      "mailto:a@b.c",
    ])
      expect(isHttpUrl(s), s).toBe(false);
  });

  it("filters on keys and primitive values, keeping ancestors", () => {
    const doc = { user: { name: "Ada", tags: ["admin", "ops"] }, count: 42, flag: true, nothing: null };
    expect(filterJson(doc, "  ")).toBeNull();
    const byValue = filterJson(doc, "ADMIN")!;
    expect([...byValue.matched]).toEqual(["$.user.tags[0]"]);
    expect([...byValue.visible].sort()).toEqual(["$", "$.user", "$.user.tags", "$.user.tags[0]"].sort());
    const byKey = filterJson(doc, "user")!;
    expect([...byKey.matched]).toEqual(["$.user"]);
    expect(filterJson(doc, "42")!.matched.has("$.count")).toBe(true);
    expect(filterJson(doc, "true")!.matched.has("$.flag")).toBe(true);
    expect(filterJson(doc, "null")!.matched.has("$.nothing")).toBe(true);
    // Array indexes are not keys.
    expect(filterJson([5, 6], "0")!.count).toBe(0);
    expect(filterJson(doc, "zzz")!.count).toBe(0);
  });

  it("names the download after the URL path", () => {
    expect(downloadName("https://jsonplaceholder.typicode.com/posts/1")).toBe("posts-1.json");
    expect(downloadName("https://api.test/v1/users?page=2")).toBe("users.json");
    expect(downloadName("https://cdn.test/data/config.json")).toBe("config.json");
    expect(downloadName("https://api.test/")).toBe("api.test.json");
    expect(downloadName("https://api.test/a%20b%3Fc")).toBe("a-b-c.json");
    expect(downloadName("not a url")).toBe("data.json");
    expect(downloadName("https://api.test/42")).toBe("42.json");
  });

  it("formats sizes, errors and palette messages", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(MAX_FORMAT_CHARS + 1)).toBe("10.0 MB");
    expect(invalidMessage({ line: 3, column: 7 })).toBe("Invalid JSON at line 3, column 7");
    expect(invalidMessage({ error: "Unexpected token" })).toBe("Invalid JSON: Unexpected token");
    expect(jsonViewerMessage("tree", "application/json")).toBe("JSON formatted.");
    expect(jsonViewerMessage("invalid", "application/json")).toMatch(/Invalid JSON/);
    expect(jsonViewerMessage("large", "application/json")).toMatch(/Format anyway/);
    expect(jsonViewerMessage(null, "text/html")).toBe("This tab is not a JSON document (text/html).");
  });

  it("is a palette action that does not need site access", () => {
    const action = ACTIONS.find((a) => a.id === "format-json")!;
    expect(action.title).toBe("Format this JSON page");
    expect(action.keywords).toMatch(/json.*formatter.*pretty.*viewer/);
    expect(action.scripts).toBeUndefined();
    expect(action.needs).toBeUndefined();
  });
});

describe("json viewer: rendering", () => {
  const JSON_TYPE = "application/json";
  const mount = (text: string, opts: { contentType?: string; force?: boolean } = {}) => {
    document.body.innerHTML = `<pre></pre><div class="json-formatter-container"></div>`;
    document.querySelector("pre")!.textContent = text;
    return mountJsonViewer(document, { contentType: JSON_TYPE, url: "https://api.test/posts/1", ...opts });
  };
  const shadow = () => document.getElementById(JSON_VIEWER_HOST_ID)!.shadowRoot!;
  const $ = (sel: string) => shadow().querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => Array.from(shadow().querySelectorAll(sel)) as HTMLElement[];
  const node = (path: string) => $(`.node[data-path='${path}']`);
  const toggle = (path: string) => node(path)!.querySelector(":scope > .line > .tog") as HTMLButtonElement;
  const btn = (label: string) => $$(".bar button").find((b) => b.textContent === label)!;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const SAMPLE = {
    userId: 1,
    id: 1,
    title: "sunt aut facere",
    link: "https://jsonplaceholder.typicode.com/posts/1",
    published: true,
    deleted: null,
    tags: ["a", "b", "c"],
    author: { name: "Ada", address: { city: "London", geo: { lat: "51.5" } } },
  };

  it("renders a tree with counts, colors, links and keeps the raw <pre>", () => {
    expect(mount(JSON.stringify(SAMPLE))).toBe("tree");
    expect(document.getElementById(JSON_VIEWER_HOST_ID)!.dataset.state).toBe("tree");
    // The original document stays in the page, hidden by the viewer's style.
    expect(document.querySelector("pre")!.textContent).toBe(JSON.stringify(SAMPLE));
    expect(document.getElementById("devkit-json-viewer-style")!.textContent).toContain("display:none");
    expect(node("$")!.querySelector(".count")!.textContent).toBe("{8}");
    expect(node("$.tags")!.querySelector(".count")!.textContent).toBe("[3]");
    expect(node("$.title")!.querySelector(".s")!.textContent).toBe('"sunt aut facere"');
    expect(node("$.id")!.querySelector(".n")!.textContent).toBe("1");
    expect(node("$.published")!.querySelector(".b")!.textContent).toBe("true");
    expect(node("$.deleted")!.querySelector(".null")!.textContent).toBe("null");
    const link = node("$.link")!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(SAMPLE.link);
    expect(link.rel).toBe("noopener noreferrer");
    expect(node("$.tags[0]")!.querySelector(".key")!.textContent).toBe("0");
    expect(node("$.title")!.querySelector(".key")!.getAttribute("title")).toContain("$.title");
    expect($(".meta")).not.toBeNull();
  });

  it("opens three levels and builds deeper children on first expand", () => {
    mount(JSON.stringify(SAMPLE));
    expect(toggle("$").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("$.author.address").getAttribute("aria-expanded")).toBe("true");
    const geo = toggle("$.author.address.geo");
    expect(geo.getAttribute("aria-expanded")).toBe("false");
    expect(node("$.author.address.geo.lat")).toBeNull();
    geo.click();
    expect(geo.getAttribute("aria-expanded")).toBe("true");
    expect(geo.textContent).toBe("▾");
    expect(node("$.author.address.geo.lat")).not.toBeNull();
    geo.click();
    expect(geo.getAttribute("aria-expanded")).toBe("false");
    expect((node("$.author.address.geo")!.querySelector(".children") as HTMLElement).hidden).toBe(true);
  });

  it("expands and collapses everything", () => {
    mount(JSON.stringify(SAMPLE));
    btn("Expand all").click();
    expect(node("$.author.address.geo.lat")).not.toBeNull();
    expect(toggle("$.author.address.geo").getAttribute("aria-expanded")).toBe("true");
    btn("Collapse all").click();
    expect(toggle("$").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("$.author").getAttribute("aria-expanded")).toBe("false");
    expect(toggle("$.tags").getAttribute("aria-expanded")).toBe("false");
    // Alt-click opens a whole branch, and closes it again.
    toggle("$.author").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(toggle("$.author.address.geo").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("$.tags").getAttribute("aria-expanded")).toBe("false");
    toggle("$.author").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(toggle("$.author.address").getAttribute("aria-expanded")).toBe("false");
  });

  it("renders big arrays in chunks", () => {
    const big = Array.from({ length: CHUNK * 2 + 10 }, (_, i) => ({ i }));
    mount(JSON.stringify(big));
    expect(node("$")!.querySelector(".count")!.textContent).toBe(`[${big.length}]`);
    expect($$(".node[data-path^='$['][data-path$=']']").length).toBe(CHUNK);
    const more = $(".more")!;
    expect(more.textContent).toBe(`Show 500 more (${(CHUNK + 10).toLocaleString("en-US")} left)`);
    more.click();
    expect($$(".node[data-path^='$['][data-path$=']']").length).toBe(CHUNK * 2);
    $(".more")!.click();
    expect($$(".node[data-path^='$['][data-path$=']']").length).toBe(big.length);
    expect($(".more")).toBeNull();
  });

  it("filters keys and values", () => {
    vi.useFakeTimers();
    mount(JSON.stringify(SAMPLE));
    const input = $("input[type=search]") as HTMLInputElement;
    input.value = "london";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(200);
    expect(node("$.author.address.city")!.classList.contains("hit")).toBe(true);
    expect(node("$.title")).toBeNull();
    expect(node("$.tags")).toBeNull();
    expect($$(".bar .meta").some((m) => m.textContent === "1 match")).toBe(true);
    input.value = "nomatchanywhere";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect($(".empty")!.textContent).toMatch(/No key or value matches/);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("");
    expect(node("$.title")).not.toBeNull();
  });

  it("shows a matched container's children", () => {
    vi.useFakeTimers();
    mount(JSON.stringify(SAMPLE));
    const input = $("input[type=search]") as HTMLInputElement;
    input.value = "tags";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(node("$.tags[2]")).not.toBeNull();
    expect(node("$.author")).toBeNull();
  });

  it("switches to raw text and back, and wraps lines", () => {
    const text = JSON.stringify(SAMPLE);
    mount(text);
    btn("Raw").click();
    expect($(".raw")!.textContent).toBe(text);
    expect(btn("Raw").getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById(JSON_VIEWER_HOST_ID)!.dataset.state).toBe("raw");
    btn("Parsed").click();
    expect(node("$.id")).not.toBeNull();
    btn("Wrap").click();
    expect($(".app")!.classList.contains("wrap")).toBe(true);
    expect(btn("Wrap").getAttribute("aria-pressed")).toBe("true");
  });

  it("copies a key's path and the indented JSON", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(JSON.stringify(SAMPLE));
    (node("$.author.name")!.querySelector(".key") as HTMLElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("$.author.name"));
    await vi.waitFor(() => expect($(".toast")!.textContent).toBe("Copied $.author.name"));
    btn("Copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(SAMPLE, null, 2)));
  });

  it("shows invalid JSON as raw text with the error position", () => {
    expect(mount('{\n  "a": 1,\n  "b": }')).toBe("invalid");
    expect($(".banner.error")!.textContent).toMatch(/^Invalid JSON at line 3, column 8/);
    expect($(".raw")!.textContent).toContain('"b": }');
    expect((btn("Parsed") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows very large documents raw until asked", () => {
    const text = JSON.stringify({ blob: "x".repeat(MAX_FORMAT_CHARS) });
    expect(mount(text)).toBe("large");
    expect($(".banner.info")!.textContent).toMatch(/This document is 10\.0 MB: shown as raw text/);
    const format = $$(".banner button").find((b) => b.textContent === "Format anyway")!;
    format.click();
    expect(document.getElementById(JSON_VIEWER_HOST_ID)!.dataset.state).toBe("tree");
    expect(node("$.blob")).not.toBeNull();
    expect($(".banner")!.hidden).toBe(true);
  });

  it("is idempotent and leaves other pages alone", () => {
    expect(mount("[1,2]")).toBe("tree");
    expect(mountJsonViewer(document, { contentType: JSON_TYPE })).toBe("already");
    expect(document.querySelectorAll(`#${JSON_VIEWER_HOST_ID}`).length).toBe(1);

    document.body.innerHTML = "<pre>[1]</pre>";
    expect(mountJsonViewer(document, { contentType: "text/html" })).toBe("not-json");
    document.body.innerHTML = "<pre>[1]</pre><p>text</p>";
    expect(mountJsonViewer(document, { contentType: JSON_TYPE })).toBe("not-json");
    document.body.innerHTML = "<pre>   </pre>";
    expect(mountJsonViewer(document, { contentType: JSON_TYPE })).toBe("not-json");
    expect(document.getElementById(JSON_VIEWER_HOST_ID)).toBeNull();
  });

  it("formats text/plain JSON only when asked, and only when it parses", () => {
    expect(mount('{"a":1}', { contentType: "text/plain" })).toBe("not-json");
    expect(mount("hello", { contentType: "text/plain", force: true })).toBe("not-json");
    expect(mount('{"a":1}', { contentType: "text/plain; charset=utf-8", force: true })).toBe("tree");
  });

  it("page functions report the viewer's state", () => {
    forceJsonViewer();
    expect((window as { __devkitJsonViewerForce?: boolean }).__devkitJsonViewerForce).toBe(true);
    mount("[]");
    expect(jsonViewerState(JSON_VIEWER_HOST_ID).state).toBe("tree");
    expect(jsonViewerState("missing").state).toBeNull();
  });
});
