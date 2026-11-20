// The JSON page viewer: vanilla DOM in a shadow root, so it stays light and the page's styles
// cannot reach it. Mounted by src/entrypoints/json-viewer.content.ts; tested in happy-dom.
import {
  CHUNK,
  childPath,
  countLabel,
  downloadName,
  entriesOf,
  type FilterResult,
  filterJson,
  formatSize,
  invalidMessage,
  isContainer,
  isHttpUrl,
  isJsonContentType,
  JSON_VIEWER_HOST_ID,
  kindOf,
  MAX_FORMAT_CHARS,
  OPEN_DEPTH,
  rawJsonPre,
} from "./json-viewer";
import { type JsonResult, parseJson } from "./utils/json";

export type MountStatus = "tree" | "raw" | "invalid" | "large" | "already" | "not-json";

export interface MountOptions {
  /** Explicit request (palette action): also format `text/plain` documents that parse as JSON. */
  force?: boolean;
  /** Defaults to `document.contentType`. */
  contentType?: string;
  /** Defaults to `location.href`; names the downloaded file. */
  url?: string;
}

const PAGE_STYLE_ID = `${JSON_VIEWER_HOST_ID}-style`;
/** Nodes built by one "Expand all" before it stops, to keep the tab responsive. */
const EXPAND_ALL_BUDGET = 20_000;

/**
 * Replaces the browser's view of a JSON document with the viewer. Does nothing (and says why)
 * when the page is not a raw JSON document or already has the viewer, so injecting it twice is safe.
 */
export function mountJsonViewer(doc: Document = document, opts: MountOptions = {}): MountStatus {
  if (doc.getElementById(JSON_VIEWER_HOST_ID)) return "already";
  const contentType = opts.contentType ?? doc.contentType ?? "";
  const json = isJsonContentType(contentType);
  if (!json && !(opts.force && /^text\/plain\b/i.test(contentType))) return "not-json";
  const pre = rawJsonPre(doc.body);
  const text = pre?.textContent ?? "";
  if (!pre || !text.trim()) return "not-json";
  const large = text.length > MAX_FORMAT_CHARS;
  const parsed = large ? null : parseJson(text);
  // Plain text is formatted only when it is JSON.
  if (!json && (large ? !/^\s*[[{]/.test(text) : !parsed?.ok)) return "not-json";

  const style = doc.createElement("style");
  style.id = PAGE_STYLE_ID;
  // Hides the raw <pre> (kept in the DOM, untouched) and Chrome's own "Pretty-print" control.
  style.textContent = `:root{color-scheme:light dark}html,body{margin:0!important;padding:0!important}body>:not(#${JSON_VIEWER_HOST_ID}){display:none!important}`;
  (doc.head ?? doc.documentElement).append(style);
  const host = doc.createElement("div");
  host.id = JSON_VIEWER_HOST_ID;
  doc.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  createViewer(doc, root, host, { text, parsed, url: opts.url ?? doc.location?.href ?? "" });
  return host.dataset.state as MountStatus;
}

interface Source {
  text: string;
  /** Null when the document was too large to parse up front. */
  parsed: JsonResult | null;
  url: string;
}

interface NodeCtl {
  el: HTMLElement;
  value: unknown;
  path: string;
  depth: number;
  /** Inside a container that matched the filter: its whole subtree shows. */
  inMatch: boolean;
  toggle?: HTMLButtonElement;
  childrenEl?: HTMLElement;
  /** Child entries to show (all of them, or the filtered ones). */
  entries?: [string | number, unknown][];
  rendered: number;
  open: boolean;
  children: NodeCtl[];
}

function createViewer(doc: Document, root: ShadowRoot, host: HTMLElement, source: Source): void {
  const { text, url } = source;
  let parsed = source.parsed;
  let mode: "tree" | "raw" = parsed?.ok ? "tree" : "raw";
  let filter: FilterResult | null = null;
  let budget = Number.POSITIVE_INFINITY;
  let rootCtl: NodeCtl | null = null;
  const ctls = new WeakMap<Element, NodeCtl>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, content?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (content !== undefined) e.textContent = content;
    return e;
  };
  const button = (label: string, cls?: string, title?: string): HTMLButtonElement => {
    const b = el("button", cls, label);
    b.type = "button";
    if (title) b.title = title;
    return b;
  };

  const style = el("style", undefined, CSS);
  const app = el("div", "app");
  const bar = el("div", "bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "JSON viewer");
  const brand = el("span", "brand", "devkit");
  brand.title = "Formatted by devkit. Turn it off in devkit's options.";
  const seg = el("div", "seg");
  const parsedBtn = button("Parsed", undefined, "Collapsible tree");
  const rawBtn = button("Raw", undefined, "The document as the server sent it");
  seg.append(parsedBtn, rawBtn);
  const expandBtn = button("Expand all", undefined, "Alt-click a toggle to expand one branch");
  const collapseBtn = button("Collapse all");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Filter keys and values";
  search.setAttribute("aria-label", "Filter keys and values");
  const matches = el("span", "meta");
  matches.setAttribute("aria-live", "polite");
  const wrapBtn = button("Wrap", undefined, "Wrap long lines");
  wrapBtn.setAttribute("aria-pressed", "false");
  const copyBtn = button("Copy", undefined, "Copy the JSON, indented");
  const downloadBtn = button("Download", undefined, `Save as ${downloadName(url)}`);
  const size = el("span", "meta", formatSize(text.length));
  bar.append(brand, seg, expandBtn, collapseBtn, search, matches, el("span", "grow"), size, wrapBtn, copyBtn, downloadBtn);

  const banner = el("div", "banner");
  banner.setAttribute("role", "status");
  banner.hidden = true;
  const view = el("main", "view");
  const toastEl = el("div", "toast");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  app.append(bar, banner, view, toastEl);
  root.append(style, app);

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

  const pretty = () => (parsed?.ok ? JSON.stringify(parsed.value, null, 2) : text);

  /* Tree */

  const valueEl = (value: unknown): HTMLElement => {
    const kind = kindOf(value);
    if (kind === "string") {
      const s = el("span", "s");
      const str = value as string;
      if (isHttpUrl(str)) {
        const a = el("a", undefined, JSON.stringify(str).slice(1, -1));
        a.href = str;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        s.append('"', a, '"');
      } else s.textContent = JSON.stringify(str);
      return s;
    }
    if (kind === "number") return el("span", "n", String(value));
    if (kind === "boolean") return el("span", "b", String(value));
    return el("span", "null", "null");
  };

  const buildNode = (key: string | number | null, value: unknown, path: string, depth: number, inMatch: boolean): NodeCtl => {
    budget--;
    const node = el("div", "node");
    node.dataset.path = path;
    const line = el("div", "line");
    line.title = path;
    node.append(line);
    const ctl: NodeCtl = { el: node, value, path, depth, inMatch, rendered: 0, open: false, children: [] };
    ctls.set(node, ctl);
    const matched = filter?.matched.has(path) ?? false;
    if (matched) node.classList.add("hit");
    const container = isContainer(value);
    if (container) {
      const toggle = button("▸", "tog");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `${key === null ? "Root" : String(key)} ${countLabel(value)}`);
      line.append(toggle);
      ctl.toggle = toggle;
    } else line.append(el("span", "sp"));
    if (key !== null) {
      const k = button(typeof key === "number" ? String(key) : JSON.stringify(key), typeof key === "number" ? "key idx" : "key");
      k.title = `${path} (click to copy the path)`;
      line.append(k, el("span", "colon", ": "));
    }
    if (container) {
      line.append(el("span", "count", countLabel(value)));
      const childMatch = inMatch || matched;
      ctl.entries = entriesOf(value).filter(([k]) => childMatch || !filter || filter.visible.has(childPath(path, k)));
      if (!ctl.entries.length) ctl.toggle!.disabled = true;
      else {
        // Filtering opens the path to every match (and a matched container one level), nothing more.
        const open = filter ? !inMatch && filter.visible.has(path) : depth < OPEN_DEPTH;
        if (open && budget > 0) expand(ctl);
      }
    } else line.append(valueEl(value));
    return ctl;
  };

  const renderMore = (ctl: NodeCtl) => {
    const entries = ctl.entries ?? [];
    const list = ctl.childrenEl!;
    list.querySelector(":scope > .more")?.remove();
    const end = Math.min(entries.length, ctl.rendered + CHUNK);
    const inMatch = ctl.inMatch || (filter?.matched.has(ctl.path) ?? false);
    for (let i = ctl.rendered; i < end; i++) {
      const [k, v] = entries[i]!;
      const child = buildNode(k, v, childPath(ctl.path, k), ctl.depth + 1, inMatch);
      ctl.children.push(child);
      list.append(child.el);
    }
    ctl.rendered = end;
    if (end < entries.length) {
      const left = entries.length - end;
      list.append(button(`Show ${Math.min(CHUNK, left).toLocaleString("en-US")} more (${left.toLocaleString("en-US")} left)`, "more"));
    }
  };

  function expand(ctl: NodeCtl) {
    if (!ctl.toggle || ctl.toggle.disabled) return;
    if (!ctl.childrenEl) {
      ctl.childrenEl = el("div", "children");
      ctl.el.append(ctl.childrenEl);
      renderMore(ctl);
    }
    ctl.childrenEl.hidden = false;
    ctl.open = true;
    ctl.toggle.textContent = "▾";
    ctl.toggle.setAttribute("aria-expanded", "true");
  }

  const collapse = (ctl: NodeCtl) => {
    if (!ctl.toggle || !ctl.childrenEl) return;
    ctl.childrenEl.hidden = true;
    ctl.open = false;
    ctl.toggle.textContent = "▸";
    ctl.toggle.setAttribute("aria-expanded", "false");
  };

  /** Expands `ctl` and every built or buildable descendant, within the node budget. */
  const expandDeep = (ctl: NodeCtl): boolean => {
    if (budget <= 0) return false;
    expand(ctl);
    for (const child of ctl.children) if (child.toggle && !expandDeep(child)) return false;
    return true;
  };
  /** Expand all, for the toolbar and Alt-click: stops after EXPAND_ALL_BUDGET new nodes. */
  const expandAll = (ctl: NodeCtl) => {
    budget = EXPAND_ALL_BUDGET;
    const done = expandDeep(ctl);
    budget = Number.POSITIVE_INFINITY;
    if (!done) toast(`Expanded the first ${EXPAND_ALL_BUDGET.toLocaleString("en-US")} nodes.`);
  };
  const collapseDeep = (ctl: NodeCtl) => {
    for (const child of ctl.children) collapseDeep(child);
    collapse(ctl);
  };

  const renderTree = () => {
    view.replaceChildren();
    if (!parsed?.ok) return;
    budget = Number.POSITIVE_INFINITY;
    const tree = el("div", "tree");
    rootCtl = buildNode(null, parsed.value, "$", 0, false);
    tree.append(rootCtl.el);
    view.append(tree);
    if (filter && !filter.count) view.append(el("p", "empty", "No key or value matches the filter."));
  };

  const renderRaw = () => {
    const pre = el("pre", "raw", text);
    view.replaceChildren(pre);
  };

  const render = () => {
    host.dataset.state = mode === "tree" ? "tree" : !parsed ? "large" : parsed.ok ? "raw" : "invalid";
    parsedBtn.setAttribute("aria-pressed", String(mode === "tree"));
    rawBtn.setAttribute("aria-pressed", String(mode === "raw"));
    parsedBtn.disabled = !parsed?.ok;
    for (const b of [expandBtn, collapseBtn]) b.disabled = mode !== "tree";
    search.disabled = mode !== "tree";
    if (mode === "tree") renderTree();
    else renderRaw();
  };

  const showBanner = () => {
    banner.replaceChildren();
    banner.className = "banner";
    banner.hidden = true;
    if (!parsed) {
      banner.classList.add("info");
      banner.hidden = false;
      const formatBtn = button("Format anyway");
      formatBtn.addEventListener("click", () => {
        parsed = parseJson(text);
        mode = parsed.ok ? "tree" : "raw";
        showBanner();
        render();
      });
      banner.append(
        el("span", "grow", `This document is ${formatSize(text.length)}: shown as raw text so the tab stays responsive.`),
        formatBtn,
      );
    } else if (!parsed.ok) {
      banner.classList.add("error");
      banner.hidden = false;
      banner.setAttribute("role", "alert");
      const detail = parsed.line && parsed.error ? ` (${parsed.error})` : "";
      banner.append(el("strong", undefined, invalidMessage(parsed)), el("span", "detail", detail));
    }
  };

  /* Events */

  view.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest("button");
    if (!target) return;
    const node = target.closest(".node");
    const ctl = node ? ctls.get(node) : undefined;
    if (target.classList.contains("more")) {
      const owner = target.parentElement?.closest(".node");
      const parent = owner ? ctls.get(owner) : undefined;
      if (parent) renderMore(parent);
      return;
    }
    if (!ctl) return;
    if (target.classList.contains("tog")) {
      if (ctl.open) (event as MouseEvent).altKey ? collapseDeep(ctl) : collapse(ctl);
      else if ((event as MouseEvent).altKey) expandAll(ctl);
      else expand(ctl);
    } else if (target.classList.contains("key")) {
      toast((await copy(ctl.path)) ? `Copied ${ctl.path}` : "Could not copy the path.");
    }
  });

  parsedBtn.addEventListener("click", () => {
    if (mode === "tree" || !parsed?.ok) return;
    mode = "tree";
    render();
  });
  rawBtn.addEventListener("click", () => {
    if (mode === "raw") return;
    mode = "raw";
    render();
  });
  expandBtn.addEventListener("click", () => {
    if (rootCtl) expandAll(rootCtl);
  });
  collapseBtn.addEventListener("click", () => {
    if (!rootCtl) return;
    for (const child of rootCtl.children) collapseDeep(child);
  });
  wrapBtn.addEventListener("click", () => {
    const on = !app.classList.contains("wrap");
    app.classList.toggle("wrap", on);
    wrapBtn.setAttribute("aria-pressed", String(on));
  });
  copyBtn.addEventListener("click", async () => {
    toast((await copy(pretty())) ? (parsed?.ok ? "Copied the JSON, indented." : "Copied the raw text.") : "Could not copy.");
  });
  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([pretty()], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = el("a");
    a.href = href;
    a.download = downloadName(url);
    app.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  });
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const applyFilter = () => {
    if (!parsed?.ok) return;
    filter = filterJson(parsed.value, search.value);
    matches.textContent = filter ? `${filter.count.toLocaleString("en-US")} match${filter.count === 1 ? "" : "es"}` : "";
    renderTree();
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

  showBanner();
  render();
}

const CSS = `
:host { all: initial; display: block; }
.app {
  --bg: #ffffff; --bg-2: #f6f7f9; --fg: #14171f; --fg-3: #646b7a; --line: #e2e5eb;
  --accent: #0e7490; --accent-fg: #ffffff; --hit: #e0f4f8; --bad: #b91c1c;
  --key: #0e7490; --str: #15803d; --num: #b45309; --bool: #7c3aed; --null: #646b7a;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font: 13px / 1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .app {
    --bg: #111318; --bg-2: #181b22; --fg: #e7e9ee; --fg-3: #8a91a0; --line: #2a2f3a;
    --accent: #22d3ee; --accent-fg: #062a33; --hit: #0f2f37; --bad: #f87171;
    --key: #22d3ee; --str: #4ade80; --num: #fbbf24; --bool: #c4b5fd; --null: #8a91a0;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.bar {
  position: sticky; top: 0; z-index: 1;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 8px 12px; background: var(--bg-2); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; color: var(--accent); margin-right: 4px; }
.grow { flex: 1; }
.meta { color: var(--fg-3); font-size: 12px; }
button {
  font: inherit; color: inherit; background: var(--bg); cursor: pointer;
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.seg { display: inline-flex; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: 6px 0 0 6px; }
.seg button:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
input[type="search"] {
  font: inherit; color: inherit; background: var(--bg); min-width: 14em;
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px;
}
.banner { display: flex; align-items: center; gap: 8px; margin: 12px 12px 0; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); }
.banner.error { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); }
.banner.info { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.banner .detail { color: var(--fg-3); font-family: var(--mono); font-size: 12px; }
.view { padding: 8px 12px 48px; font: 13px / 1.6 var(--mono); overflow-x: auto; }
.raw { margin: 0; font: inherit; white-space: pre; }
.line { white-space: nowrap; border-radius: 3px; }
.line:hover { background: var(--bg-2); }
.children { margin-left: 0.55em; padding-left: 1em; border-left: 1px solid var(--line); }
.tog, .key {
  border: 0; background: none; padding: 0; border-radius: 3px;
  font: inherit; line-height: inherit;
}
.tog { display: inline-block; width: 1.3em; text-align: center; color: var(--fg-3); }
.tog:disabled { opacity: 0.35; }
.sp { display: inline-block; width: 1.3em; }
.key { color: var(--key); cursor: copy; }
.key:hover { text-decoration: underline; }
.key.idx { color: var(--fg-3); }
.colon, .count { color: var(--fg-3); }
.s { color: var(--str); }
.s a { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
.n { color: var(--num); }
.b { color: var(--bool); }
.null { color: var(--null); font-style: italic; }
.hit > .line { background: var(--hit); }
.more { margin: 2px 0 2px 1.3em; font-family: inherit; font-size: 12px; padding: 1px 8px; color: var(--accent); }
.empty { color: var(--fg-3); font-family: system-ui, sans-serif; }
.wrap .raw { white-space: pre-wrap; overflow-wrap: anywhere; }
.wrap .line { white-space: pre-wrap; overflow-wrap: anywhere; }
.offscreen { position: fixed; top: 0; left: -9999px; opacity: 0; }
.toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; border-radius: 6px; background: var(--fg); color: var(--bg);
  font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 0.15s;
}
.toast.show { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
`;
