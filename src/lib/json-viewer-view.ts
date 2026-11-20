// The data page viewer (JSON, XML / RSS / Atom, CSV / TSV, YAML, JSON Lines): vanilla DOM in a
// shadow root, so it stays light and the page's styles cannot reach it. Mounted by
// src/entrypoints/data-viewer.ts; tested in happy-dom.
import { CHROME_XML_SOURCE_ID, type DataFormat, detectFormat, FORMAT_LABELS, formatFromContentType, formatFromUrl } from "./data-viewer";
import { type CsvTable, csvTable } from "./formats/csv";
import { invalidLinesMessage, parseJsonLines } from "./formats/jsonl";
import {
  type DomLike,
  findParserError,
  hasXmlStylesheet,
  invalidXmlMessage,
  looksLikeXml,
  parserErrorMessage,
  parseXml,
  serializeXml,
  type XmlParseResult,
  xmlErrorPosition,
} from "./formats/xml";
import { parseYaml, yamlProblemMessage } from "./formats/yaml";
import { downloadName, formatSize, invalidMessage, JSON_VIEWER_HOST_ID, MAX_FORMAT_CHARS, rawJsonPre } from "./json-viewer";
import { parseJson } from "./utils/json";
import { type Body, elementFactory, type ViewCtx, XHTML } from "./viewer/ctx";
import { createCsvTable } from "./viewer/csv-table";
import { CSS } from "./viewer/css";
import { createJsonTree } from "./viewer/json-tree";
import { createXmlTree } from "./viewer/xml-tree";

export type MountStatus = "tree" | "raw" | "invalid" | "unsupported" | "large" | "already" | "not-data";

export interface MountOptions {
  /** Explicit request (palette action): also format `text/plain` documents that sniff as JSON, JSON Lines or XML. */
  force?: boolean;
  /** Defaults to `document.contentType`. */
  contentType?: string;
  /** Defaults to `location.href`; names the downloaded file and hints the format by its extension. */
  url?: string;
}

const PAGE_STYLE_ID = `${JSON_VIEWER_HOST_ID}-style`;

/** The document's text, as the page holds it. */
interface PageSource {
  text: string;
  /** An XML document (Chrome's XML viewer or a raw XML DOM). */
  xml?: boolean;
  /** The browser already failed to parse the XML document. */
  xmlError?: XmlParseResult;
}

const serialize = (nodes: ArrayLike<Node>) => {
  const s = new XMLSerializer();
  return Array.from(nodes, (n) => s.serializeToString(n)).join("\n");
};

/**
 * The text of a data document, or null when the page is not one: the single `<pre>` Chrome shows
 * text and JSON in, or the source of an XML document (moved aside by Chrome's XML viewer, or the
 * document itself). XML documents styled with `<?xml-stylesheet?>` are left alone.
 */
export function readPageSource(doc: Document, contentType: string): PageSource | null {
  const chromeSource = doc.getElementById(CHROME_XML_SOURCE_ID);
  if (chromeSource) {
    const nodes = chromeSource.childNodes as unknown as ArrayLike<DomLike>;
    if (hasXmlStylesheet(nodes)) return null;
    return { text: serialize(chromeSource.childNodes), xml: true };
  }
  const root = doc.documentElement;
  if (root && root.namespaceURI !== XHTML && formatFromContentType(contentType) === "xml") {
    if (hasXmlStylesheet(doc.childNodes as unknown as ArrayLike<DomLike>)) return null;
    const error = findParserError(doc);
    if (!error) return { text: serialize(doc.childNodes), xml: true };
    // Chrome keeps the document up to the first error, with a <parsererror> inside.
    const message = parserErrorMessage(error);
    const clone = root.cloneNode(true) as Element;
    for (const e of Array.from(clone.getElementsByTagName("parsererror"))) e.remove();
    return {
      text: error === root ? "" : serialize([clone]),
      xml: true,
      xmlError: { ok: false, error: message, ...(xmlErrorPosition(message) ?? {}) },
    };
  }
  const pre = rawJsonPre(doc.body);
  return pre ? { text: pre.textContent ?? "" } : null;
}

/** What the viewer shows for one format: built from the text, before any DOM. */
interface FormatModel {
  format: DataFormat;
  /** The parsed view is available. */
  ok: boolean;
  /** Why it is not. */
  failure?: "invalid" | "unsupported";
  banner?: { tone: "error" | "info"; title: string; detail?: string };
  parsedLabel: string;
  parsedTitle: string;
  filterLabel: string;
  tree: boolean;
  copy: { title: string; done: string; text: () => string };
  download: { name: string; type: string; text: () => string };
  meta?: string;
  body(ctx: ViewCtx): Body & { controls?: HTMLElement[] };
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";

function buildModel(format: DataFormat, source: PageSource, url: string): FormatModel {
  const text = source.text;
  const tree = { parsedLabel: "Parsed", parsedTitle: "Collapsible tree", filterLabel: "Filter keys and values", tree: true };
  const raw = { title: "Copy the raw text", done: "Copied the raw text.", text: () => text };
  if (format === "json") {
    const parsed = parseJson(text);
    return {
      format,
      ...tree,
      ok: parsed.ok,
      ...(parsed.ok
        ? {}
        : {
            failure: "invalid" as const,
            banner: {
              tone: "error" as const,
              title: invalidMessage(parsed),
              detail: parsed.line && parsed.error ? ` (${parsed.error})` : "",
            },
          }),
      copy: parsed.ok ? { title: "Copy the JSON, indented", done: "Copied the JSON, indented.", text: () => pretty(parsed.value) } : raw,
      download: { name: downloadName(url), type: "application/json", text: () => (parsed.ok ? pretty(parsed.value) : text) },
      body: (ctx) => createJsonTree(ctx, parsed.value),
    };
  }
  if (format === "yaml") {
    const parsed = parseYaml(text);
    const docs = parsed.documents ?? 0;
    const asJson = { title: "Copy as JSON, indented", done: "Copied as JSON, indented.", text: () => pretty(parsed.value) };
    return {
      format,
      ...tree,
      ok: parsed.ok,
      ...(parsed.ok
        ? {}
        : {
            failure: parsed.unsupported ? ("unsupported" as const) : ("invalid" as const),
            banner: { tone: parsed.unsupported ? ("info" as const) : ("error" as const), title: yamlProblemMessage(parsed) },
          }),
      meta: docs > 1 ? `${docs} documents` : undefined,
      copy: parsed.ok ? asJson : raw,
      download: parsed.ok
        ? { name: downloadName(url, "json"), type: "application/json", text: () => pretty(parsed.value) }
        : { name: downloadName(url, "yaml"), type: "text/yaml", text: () => text },
      body: (ctx) =>
        createJsonTree(ctx, parsed.value, docs > 1 ? { labels: Array.from({ length: docs }, (_, i) => `document ${i + 1}`) } : undefined),
    };
  }
  if (format === "jsonl") {
    const parsed = parseJsonLines(text);
    const values = parsed.items.map((l) => (l.ok ? l.value : undefined));
    const ok = parsed.valid > 0;
    const first = parsed.items.find((l) => !l.ok);
    return {
      format,
      ...tree,
      ok,
      ...(ok ? {} : { failure: "invalid" as const }),
      ...(parsed.invalid
        ? {
            banner: {
              tone: "error" as const,
              title: invalidLinesMessage(parsed),
              detail: first ? ` (line ${first.line}: ${first.error})` : "",
            },
          }
        : {}),
      meta: `${parsed.items.length.toLocaleString("en-US")} line${parsed.items.length === 1 ? "" : "s"}`,
      copy: ok
        ? {
            title: "Copy the valid lines as a JSON array",
            done: "Copied as a JSON array.",
            text: () => pretty(values.filter((v) => v !== undefined)),
          }
        : raw,
      download: {
        name: downloadName(url, "json"),
        type: "application/json",
        text: () => (ok ? pretty(values.filter((v) => v !== undefined)) : text),
      },
      body: (ctx) =>
        createJsonTree(ctx, values, {
          labels: parsed.items.map((l) => `line ${l.line}`),
          errors: parsed.items.map((l) => (l.ok ? undefined : l.error)),
          texts: parsed.items.map((l) => l.text),
        }),
    };
  }
  if (format === "xml") {
    const parsed = source.xmlError ?? parseXml(text, new DOMParser());
    const doc = parsed.doc;
    return {
      format,
      ok: parsed.ok,
      parsedLabel: "Tree",
      parsedTitle: "Collapsible element tree",
      filterLabel: "Filter tags, attributes and text",
      tree: true,
      ...(parsed.ok
        ? {}
        : {
            failure: "invalid" as const,
            banner: {
              tone: "error" as const,
              title: invalidXmlMessage(parsed),
              detail: source.xmlError && text ? " (the raw view shows the document up to that point)" : "",
            },
          }),
      copy: doc ? { title: "Copy the XML, indented", done: "Copied the XML, indented.", text: () => serializeXml(doc) } : raw,
      download: { name: downloadName(url, "xml"), type: "application/xml", text: () => (doc ? serializeXml(doc) : text) },
      body: (ctx) => createXmlTree(ctx, doc!),
    };
  }
  // CSV and TSV.
  const table = csvTable(text, { preferTab: format === "tsv" });
  let body: ReturnType<typeof createCsvTable> | null = null;
  return {
    format,
    ok: true,
    ...(csvProblem(table) ? { banner: csvProblem(table)! } : {}),
    parsedLabel: "Table",
    parsedTitle: "Table with sortable columns",
    filterLabel: "Filter rows",
    tree: false,
    copy: { title: `Copy the ${FORMAT_LABELS[format]} as served`, done: `Copied the ${FORMAT_LABELS[format]}.`, text: () => text },
    download: { name: downloadName(url, format), type: format === "tsv" ? "text/tab-separated-values" : "text/csv", text: () => text },
    body: (ctx) => {
      body ??= createCsvTable(ctx, text, { table });
      return body;
    },
  };
}

/** A banner for a CSV that does not split cleanly: an unterminated quote, or rows with a different number of fields. */
function csvProblem(table: CsvTable): FormatModel["banner"] | null {
  const issue = table.issues[0];
  if (issue)
    return { tone: "error", title: `${issue.message} at line ${issue.line}`, detail: " (the rest of the file is read as that one field)" };
  if (!table.ragged.length) return null;
  const n = table.ragged.length;
  const lines = table.ragged.slice(0, 10).join(", ") + (n > 10 ? "…" : "");
  return {
    tone: "info",
    title: `${n.toLocaleString("en-US")} row${n === 1 ? " has" : "s have"} a different number of fields`,
    detail: ` (line${n === 1 ? "" : "s"} ${lines})`,
  };
}

/** For a large document the viewer does not parse up front: whether it is worth showing at all. */
function plausible(format: DataFormat, text: string): boolean {
  if (format === "json") return /^\s*[[{]/.test(text);
  if (format === "xml") return looksLikeXml(text);
  return true;
}

/**
 * Replaces the browser's view of a data document with the viewer. Does nothing (and says why) when
 * the page is not a data document or already has the viewer, so injecting it twice is safe.
 */
export function mountDataViewer(doc: Document = document, opts: MountOptions = {}): MountStatus {
  if (doc.getElementById(JSON_VIEWER_HOST_ID)) return "already";
  const contentType = opts.contentType ?? doc.contentType ?? "";
  const url = opts.url ?? doc.location?.href ?? "";
  const source = readPageSource(doc, contentType);
  if (!source || (!source.text.trim() && !source.xmlError)) return "not-data";
  const detection = source.xml
    ? { format: "xml" as const, declared: true }
    : detectFormat({ contentType, url, text: source.text, force: opts.force });
  if (!detection) return "not-data";
  const { format } = detection;
  const large = source.text.length > MAX_FORMAT_CHARS;
  const model = large ? null : buildModel(format, source, url);
  if (!detection.declared) {
    // Plain text is formatted only when it reads as the format, unless the user asked for a file whose extension names it.
    const explicit = opts.force && formatFromUrl(url) === format;
    if (large ? !plausible(format, source.text) : !model!.ok && !explicit) return "not-data";
  }

  const host = takeOver(doc);
  const root = host.attachShadow({ mode: "open" });
  host.dataset.format = format;
  createViewer(doc, root, host, { text: source.text, format, url, model, build: () => buildModel(format, source, url) });
  return host.dataset.state as MountStatus;
}

/** Hides the page (kept in the DOM, untouched) and adds the viewer's host. XML documents get an XHTML body first. */
function takeOver(doc: Document): HTMLElement {
  const { el } = elementFactory(doc);
  let body = doc.body as HTMLElement | null;
  if (!body) {
    // An XML document shown as is (no XML viewer): move it into a hidden holder of a new XHTML root.
    const html = doc.createElementNS(XHTML, "html");
    html.append(el("head"));
    body = el("body");
    html.append(body);
    const holder = el("div");
    holder.id = `${JSON_VIEWER_HOST_ID}-source`;
    const old = doc.documentElement;
    if (old) doc.replaceChild(html, old);
    else doc.append(html);
    if (old) holder.append(old);
    body.append(holder);
  }
  const style = el("style");
  style.id = PAGE_STYLE_ID;
  // Hides the raw <pre> or XML source and Chrome's own controls (its "Pretty-print" box, its XML tree).
  style.textContent = `:root{color-scheme:light dark}html,body{margin:0!important;padding:0!important}body>:not(#${JSON_VIEWER_HOST_ID}){display:none!important}`;
  (doc.head ?? doc.documentElement).append(style);
  const host = el("div");
  host.id = JSON_VIEWER_HOST_ID;
  body.append(host);
  return host;
}

interface ViewerInput {
  text: string;
  format: DataFormat;
  url: string;
  /** Null when the document was too large to parse up front. */
  model: FormatModel | null;
  build: () => FormatModel;
}

function createViewer(doc: Document, shadow: ShadowRoot, host: HTMLElement, input: ViewerInput): void {
  const { text, format } = input;
  let model = input.model;
  const label = FORMAT_LABELS[format];
  const { el, button } = elementFactory(doc);
  let mode: "parsed" | "raw" = model?.ok ? "parsed" : "raw";
  let body: (Body & { controls?: HTMLElement[] }) | null = null;

  const style = el("style", undefined, CSS);
  const app = el("div", "app");
  const bar = el("div", "bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", `${label} viewer`);
  const brand = el("span", "brand", "devkit");
  brand.title = "Formatted by devkit. Turn it off in devkit's options.";
  const seg = el("div", "seg");
  const parsedBtn = button("Parsed");
  const rawBtn = button("Raw", undefined, "The document as the server sent it");
  seg.append(parsedBtn, rawBtn);
  const expandBtn = button("Expand all", undefined, "Alt-click a toggle to expand one branch");
  const collapseBtn = button("Collapse all");
  const search = el("input");
  search.type = "search";
  const matches = el("span", "meta");
  matches.setAttribute("aria-live", "polite");
  const controls = el("span", "controls");
  const meta = el("span", "meta");
  const wrapBtn = button("Wrap", undefined, format === "csv" || format === "tsv" ? "Wrap long cells" : "Wrap long lines");
  wrapBtn.setAttribute("aria-pressed", "false");
  const copyBtn = button("Copy");
  const downloadBtn = button("Download");
  const size = el("span", "meta", formatSize(text.length));
  bar.append(brand, seg, expandBtn, collapseBtn, search, matches, controls, el("span", "grow"), meta, size, wrapBtn, copyBtn, downloadBtn);

  const banner = el("div", "banner");
  banner.setAttribute("role", "status");
  banner.hidden = true;
  const view = el("main", "view");
  const toastEl = el("div", "toast");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  app.append(bar, banner, view, toastEl);
  shadow.append(style, app);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (message: string) => {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  };

  const copy = async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // No clipboard API (plain http pages are not secure contexts): fall back to a selection.
      const area = el("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.className = "offscreen";
      app.append(area);
      area.select();
      let ok = false;
      try {
        ok = doc.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  };

  const ctx: ViewCtx = { doc, app, view, el, button, toast, copy };

  /** Applies the model to the toolbar (again after "Format anyway"). */
  const setup = () => {
    parsedBtn.textContent = model?.parsedLabel ?? "Parsed";
    parsedBtn.title = model?.parsedTitle ?? "Collapsible tree";
    const filterLabel = model?.filterLabel ?? "Filter keys and values";
    search.placeholder = filterLabel;
    search.setAttribute("aria-label", filterLabel);
    expandBtn.hidden = collapseBtn.hidden = model ? !model.tree : false;
    meta.textContent = model?.meta ?? "";
    copyBtn.title = model?.copy.title ?? "Copy the raw text";
    downloadBtn.title = `Save as ${model?.download.name ?? downloadName(input.url, format)}`;
    body = model?.ok ? model.body(ctx) : null;
    controls.replaceChildren(...(body?.controls ?? []));
  };

  const renderRaw = () => {
    view.replaceChildren(el("pre", "raw", text));
  };

  const render = () => {
    host.dataset.state = mode === "parsed" ? "tree" : !model ? "large" : model.ok ? "raw" : (model.failure ?? "invalid");
    parsedBtn.setAttribute("aria-pressed", String(mode === "parsed"));
    rawBtn.setAttribute("aria-pressed", String(mode === "raw"));
    parsedBtn.disabled = !body;
    for (const b of [expandBtn, collapseBtn]) b.disabled = mode !== "parsed";
    search.disabled = mode !== "parsed";
    for (const c of Array.from(controls.querySelectorAll("button"))) c.disabled = mode !== "parsed";
    if (mode === "parsed" && body) {
      app.style.setProperty("--bar-h", `${bar.offsetHeight || 48}px`);
      body.render();
    } else renderRaw();
  };

  const showBanner = () => {
    banner.replaceChildren();
    banner.className = "banner";
    banner.hidden = true;
    banner.setAttribute("role", "status");
    if (!model) {
      banner.classList.add("info");
      banner.hidden = false;
      const formatBtn = button("Format anyway");
      formatBtn.addEventListener("click", () => {
        model = input.build();
        mode = model.ok ? "parsed" : "raw";
        setup();
        showBanner();
        render();
      });
      banner.append(
        el("span", "grow", `This document is ${formatSize(text.length)}: shown as raw text so the tab stays responsive.`),
        formatBtn,
      );
    } else if (model.banner) {
      banner.classList.add(model.banner.tone);
      banner.hidden = false;
      if (model.banner.tone === "error") banner.setAttribute("role", "alert");
      banner.append(el("strong", undefined, model.banner.title), el("span", "detail", model.banner.detail ?? ""));
    }
  };

  /* Events */

  parsedBtn.addEventListener("click", () => {
    if (mode === "parsed" || !body) return;
    mode = "parsed";
    render();
  });
  rawBtn.addEventListener("click", () => {
    if (mode === "raw") return;
    mode = "raw";
    render();
  });
  expandBtn.addEventListener("click", () => body?.expandAll?.());
  collapseBtn.addEventListener("click", () => body?.collapseAll?.());
  wrapBtn.addEventListener("click", () => {
    const on = !app.classList.contains("wrap");
    app.classList.toggle("wrap", on);
    wrapBtn.setAttribute("aria-pressed", String(on));
  });
  copyBtn.addEventListener("click", async () => {
    const c = model?.copy;
    toast((await copy(c ? c.text() : text)) ? (c?.done ?? "Copied the raw text.") : "Could not copy.");
  });
  downloadBtn.addEventListener("click", () => {
    const d = model?.download;
    const blob = new Blob([d ? d.text() : text], { type: d?.type ?? "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = el("a");
    a.href = href;
    a.download = d?.name ?? downloadName(input.url, format);
    app.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  });
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const applyFilter = () => {
    if (!body || mode !== "parsed") return;
    const count = body.filter(search.value);
    matches.textContent =
      count === null ? "" : body.countLabel ? body.countLabel(count) : `${count.toLocaleString("en-US")} match${count === 1 ? "" : "es"}`;
  };
  search.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 150);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(filterTimer);
      applyFilter();
    } else if (event.key === "Escape" && search.value) {
      search.value = "";
      applyFilter();
    }
  });

  setup();
  showBanner();
  render();
}
