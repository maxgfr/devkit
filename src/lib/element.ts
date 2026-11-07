// Element picker: data shapes and the pure helpers shared by the in-page collector
// (src/lib/page/element.ts, bundled into element-picker.js) and the side panel.

/** Where a piece of UI is written in the source. */
export interface SourceLoc {
  file: string;
  line?: number;
  column?: number;
  /** How devkit found it: "_debugSource", "_debugStack", "data-inspector", "__file"… */
  via: string;
}

export interface ComponentInfo {
  name: string;
  /** For React: where this component's element is created (the JSX in its parent). For Vue: the component's file. */
  source?: SourceLoc;
  /** memo, forwardRef, class, lazy… */
  kind?: string;
  /** Source under node_modules or a framework's internals. */
  library?: boolean;
}

export interface FrameworkInfo {
  name: "React" | "Vue 3" | "Vue 2" | "Svelte" | "Angular";
  version?: string;
  /** Debug data (component names, sources) is present: a development build. */
  dev: boolean;
  /** Nearest component first. */
  components: ComponentInfo[];
  /** Props of the nearest component, serialized by `serializeValue`. */
  props?: unknown;
  propsOf?: string;
  /** Where the picked element itself is written. */
  source?: SourceLoc;
}

export interface Crumb {
  label: string;
  /** How many levels above the picked element (0 = the element). */
  up: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number; dpr: number };
  tag: string;
  id: string;
  classes: string[];
  attributes: [string, string][];
  text: string;
  html: string;
  htmlTruncated: boolean;
  selector: string;
  selectorUnique: boolean;
  /** Selector of the shadow host, when the element lives in a shadow root. */
  shadowHost?: string;
  path: Crumb[];
  childCount: number;
  rect: Rect;
  inView: boolean;
  /** Why the element is not visible, when it is not. */
  hidden?: string;
  styles: [string, string][];
  /** Layout of the parent (display flex/grid…), which often explains the element's size. */
  parentLayout?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: { attr: string; value: string };
  /** Attributes added by locator tools (react-dev-inspector, LocatorJS, vite plugins, Astro…). */
  locatorAttrs: [string, string][];
  framework?: FrameworkInfo;
  /** Best source location found, from the framework or a locator attribute. */
  source?: SourceLoc;
}

/* Props serializer */

export interface SerializeOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxItems?: number;
  maxString?: number;
  /** Total values emitted before the rest is cut. */
  maxNodes?: number;
}

const REACT_ELEMENT = new Set(["react.element", "react.transitional.element"]);

const symbolName = (s: unknown) => (typeof s === "symbol" ? (s.description ?? "") : "");

/** A component or tag name from a React element type (string, function, memo, forwardRef, lazy, context). */
export function reactTypeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") return (type as { displayName?: string }).displayName || type.name || "Anonymous";
  if (type && typeof type === "object") {
    const t = type as { displayName?: string; $$typeof?: symbol; type?: unknown; render?: unknown; _context?: unknown };
    if (t.displayName) return t.displayName;
    const kind = symbolName(t.$$typeof);
    if (kind === "react.memo") return reactTypeName(t.type);
    if (kind === "react.forward_ref") return reactTypeName(t.render);
    if (kind === "react.lazy") return "Lazy";
    if (kind === "react.context" || kind === "react.provider") return "Context.Provider";
    if (kind === "react.consumer") return "Context.Consumer";
  }
  return "Anonymous";
}

function nodeLabel(node: { nodeType: number; nodeName: string; id?: string; className?: unknown }): string {
  if (node.nodeType !== 1) return node.nodeName.toLowerCase();
  const cls =
    typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
  return `${node.nodeName.toLowerCase()}${node.id ? `#${node.id}` : ""}${cls}`;
}

/**
 * Turns any value (React props, a Vue instance's props…) into JSON-safe data a model can read:
 * functions become "ƒ name", React elements "<Name />", DOM nodes "[node div#id]", cycles
 * "[Circular]", and depth, keys, items, strings and the total size are capped.
 */
export function serializeValue(value: unknown, options: SerializeOptions = {}): unknown {
  const { maxDepth = 4, maxKeys = 30, maxItems = 20, maxString = 300, maxNodes = 400 } = options;
  let nodes = 0;
  const path = new Set<unknown>();
  const walk = (v: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > maxNodes) return "[…]";
    if (v === null) return null;
    switch (typeof v) {
      case "string":
        return v.length > maxString ? `${v.slice(0, maxString)}… (${v.length} chars)` : v;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "boolean":
        return v;
      case "undefined":
        return "[undefined]";
      case "bigint":
        return `${v}n`;
      case "symbol":
        return v.toString();
      case "function":
        return `ƒ ${(v as { displayName?: string }).displayName || v.name || "anonymous"}`;
    }
    const o = v as Record<string | symbol, unknown>;
    if (path.has(o)) return "[Circular]";
    try {
      const typeOf = symbolName(o.$$typeof);
      if (REACT_ELEMENT.has(typeOf)) {
        const props = (o.props ?? {}) as { children?: unknown };
        const name = reactTypeName(o.type);
        return typeof props.children === "string" && props.children.length <= 40 ? `<${name}>${props.children}</${name}>` : `<${name} />`;
      }
      if (typeof (o as { nodeType?: unknown }).nodeType === "number" && typeof (o as { nodeName?: unknown }).nodeName === "string")
        return `[node ${nodeLabel(o as never)}]`;
      if (typeof Window !== "undefined" && o instanceof Window) return "[Window]";
      if (o instanceof Date) return Number.isNaN(o.getTime()) ? "[Invalid Date]" : o.toISOString();
      if (o instanceof RegExp) return o.toString();
      if (o instanceof Error) return `[${o.name}: ${o.message.slice(0, maxString)}]`;
      if (typeof (o as { then?: unknown }).then === "function") return "[Promise]";
    } catch {
      return "[unreadable]";
    }
    if (depth >= maxDepth) return Array.isArray(o) ? `[Array(${o.length})]` : "[Object]";
    path.add(o);
    try {
      if (Array.isArray(o) || o instanceof Set) {
        const items = Array.isArray(o) ? o : [...o];
        const out = items.slice(0, maxItems).map((x) => walk(x, depth + 1));
        if (items.length > maxItems) out.push(`… ${items.length - maxItems} more`);
        return out;
      }
      if (o instanceof Map) {
        const out: Record<string, unknown> = {};
        let i = 0;
        for (const [k, x] of o) {
          if (i++ >= maxKeys) {
            out["…"] = `${o.size - maxKeys} more`;
            break;
          }
          out[typeof k === "string" ? k : String(walk(k, maxDepth))] = walk(x, depth + 1);
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      const proto = Object.getPrototypeOf(o);
      const ctor = proto && proto !== Object.prototype ? (proto.constructor as { name?: string } | undefined)?.name : undefined;
      if (ctor && ctor !== "Object") out.__class = ctor;
      const keys = Object.keys(o);
      for (const k of keys.slice(0, maxKeys)) {
        try {
          out[k] = walk(o[k], depth + 1);
        } catch {
          out[k] = "[throws]";
        }
      }
      if (keys.length > maxKeys) out["…"] = `${keys.length - maxKeys} more keys`;
      return out;
    } finally {
      path.delete(o);
    }
  };
  return walk(value, 0);
}

/* Stack frames */

export interface Frame {
  fn?: string;
  url: string;
  line: number;
  column: number;
}

/** Parses V8 ("at fn (url:1:2)") and Firefox/Safari ("fn@url:1:2") stack lines. */
export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const v8 = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const gecko = !v8 ? /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line) : null;
    const m = v8 ?? gecko;
    if (!m) continue;
    const url = m[2]!.replace(/^async /, "");
    frames.push({ fn: m[1] || undefined, url, line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

/** React, its JSX runtime, the scheduler, dependencies and devkit itself: not where the bug is. */
export function isLibraryUrl(url: string): boolean {
  return (
    /node_modules|\/\.vite\/deps\/|react-dom[.-]|react\.(development|production)|jsx-(dev-)?runtime|scheduler\.(development|production)/.test(
      url,
    ) ||
    /^(chrome-extension|moz-extension|node|native):/.test(url) ||
    url === "<anonymous>" ||
    /\/_next\/static\/chunks\/(framework|main|webpack|polyfills)/.test(url)
  );
}

/** The first frame of `stack` in the app's own code, as a source location. */
export function firstUserFrame(stack: string, via = "_debugStack"): SourceLoc | undefined {
  const frame = parseStack(stack).find((f) => !isLibraryUrl(f.url));
  return frame ? { file: frame.url, line: frame.line, column: frame.column, via } : undefined;
}

/** Turns a dev-server URL into the path a developer recognizes: src/App.tsx instead of http://localhost:5173/src/App.tsx?t=123. */
export function sourcePath(file: string): string {
  let f = file
    .trim()
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "")
    .replace(/^webpack:\/\/[^/]*\//, "");
  if (/^https?:\/\//.test(f)) {
    // A dev-server URL: its path is relative to the project, except Vite's /@fs/ for files outside it.
    f = f.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
    f = f.startsWith("/@fs/") ? f.slice(4) : f.replace(/^\//, "");
  }
  f = f.replace(/^\.\//, "");
  return f || file;
}

export function formatSource(loc: SourceLoc | undefined): string {
  if (!loc) return "";
  const path = sourcePath(loc.file);
  return loc.line ? `${path}:${loc.line}${loc.column ? `:${loc.column}` : ""}` : path;
}

/** Reads a "path:line:col" (or "path::line") value of a locator attribute. */
export function parseLocation(value: string, via: string): SourceLoc | undefined {
  const m = /^(.+?)(?::{1,2}(\d+))?(?::(\d+))?$/.exec(value.trim());
  if (!m?.[1]) return undefined;
  return { file: m[1], line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined, via };
}

/** A source location from the attributes locator tools add to the DOM in development. */
export function sourceFromAttributes(attrs: [string, string][]): SourceLoc | undefined {
  const get = (name: string) => attrs.find(([k]) => k === name)?.[1];
  const path = get("data-inspector-relative-path");
  if (path) {
    const line = get("data-inspector-line");
    const col = get("data-inspector-column");
    return { file: path, line: line ? Number(line) : undefined, column: col ? Number(col) : undefined, via: "data-inspector" };
  }
  const astro = get("data-astro-source-file");
  if (astro) {
    const [line, col] = (get("data-astro-source-loc") ?? "").split(":").map(Number);
    return { file: astro, line: line || undefined, column: col || undefined, via: "data-astro-source" };
  }
  const sourceFile = get("data-source-file");
  if (sourceFile) {
    const line = get("data-source-line");
    return { file: sourceFile, line: line ? Number(line) : undefined, via: "data-source-file" };
  }
  for (const name of [
    "data-v-inspector",
    "data-locatorjs-id",
    "data-locator",
    "data-source",
    "data-qwik-inspector",
    "data-component-path",
  ]) {
    const v = get(name);
    if (v && /[/\\.]/.test(v)) return parseLocation(v, name);
  }
  return undefined;
}

/* Playwright locator */

const jsString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

/** The most readable Playwright locator for the element: test id, role and name, label, text, then CSS. */
export function buildLocator(info: Pick<ElementInfo, "testId" | "role" | "name" | "label" | "placeholder" | "text" | "selector">): string {
  const short = (s: string | undefined) => (s && s.length <= 80 && !s.includes("\n") ? s : undefined);
  if (info.testId)
    return info.testId.attr === "data-testid"
      ? `page.getByTestId(${jsString(info.testId.value)})`
      : `page.locator(${jsString(`[${info.testId.attr}="${info.testId.value}"]`)})`;
  const name = short(info.name);
  if (info.role && name) return `page.getByRole(${jsString(info.role)}, { name: ${jsString(name)} })`;
  if (short(info.label)) return `page.getByLabel(${jsString(info.label!)})`;
  if (short(info.placeholder)) return `page.getByPlaceholder(${jsString(info.placeholder!)})`;
  const text = info.text.trim();
  if (text && text.length <= 50 && !text.includes("\n")) return `page.getByText(${jsString(text)}, { exact: true })`;
  return `page.locator(${jsString(info.selector)})`;
}

/* Screenshot crop */

/**
 * The region of a captureVisibleTab image showing `rect` (CSS pixels, viewport coordinates), with
 * `pad` CSS pixels around it, clipped to the image. Null when the element is not on screen.
 */
export function cropRegion(
  rect: Rect,
  viewport: { width: number },
  image: { width: number; height: number },
  pad = 8,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!viewport.width || !image.width) return null;
  const scale = image.width / viewport.width;
  const x0 = Math.max(0, Math.floor((rect.x - pad) * scale));
  const y0 = Math.max(0, Math.floor((rect.y - pad) * scale));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width + pad) * scale));
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height + pad) * scale));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/* Markdown for a coding agent */

export interface ElementError {
  kind: string;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  count: number;
  time: number;
}

export interface MarkdownOptions {
  note?: string;
  errors?: ElementError[];
  /** A screenshot of the element travels with the text. */
  image?: boolean;
  maxProps?: number;
}

/** The short name of the element: button#save.btn.primary */
export function elementLabel(info: Pick<ElementInfo, "tag" | "id" | "classes">): string {
  return `${info.tag}${info.id ? `#${info.id}` : ""}${info.classes
    .slice(0, 3)
    .map((c) => `.${c}`)
    .join("")}`;
}

const fence = (lang: string, body: string) => {
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

/** Compact Markdown describing the element: what a coding agent needs to find it in the source and fix it. */
export function buildElementMarkdown(info: ElementInfo, options: MarkdownOptions = {}): string {
  const fw = info.framework;
  const user = fw?.components.filter((c) => !c.library) ?? [];
  const nearest = user[0] ?? fw?.components[0];
  const out: string[] = [];
  out.push(`## UI element: \`<${info.tag}>\`${nearest ? ` in \`${nearest.name}\`` : ""}`);
  const note = options.note?.trim();
  if (note) out.push("", `**What's wrong / what should change:** ${note}`);
  out.push("");
  out.push(`- Page: ${info.url} (viewport ${info.viewport.width}×${info.viewport.height}, DPR ${info.viewport.dpr})`);
  if (info.source) out.push(`- Source: \`${formatSource(info.source)}\` (from ${info.source.via})`);
  else if (fw)
    out.push(
      `- Source: not found. ${fw.dev ? "No file:line in the debug data." : "This looks like a production build, which strips it: run the dev server to get file:line."}`,
    );
  else out.push("- Framework: none detected (plain DOM, or a production build without debug data)");
  out.push(
    `- Selector: \`${info.selector}\`${info.selectorUnique ? "" : " (not unique)"}${info.shadowHost ? ` inside the shadow root of \`${info.shadowHost}\`` : ""}`,
  );
  out.push(`- Playwright: \`${buildLocator(info)}\``);
  out.push(`- DOM path: \`${info.path.map((c) => c.label).join(" > ")}\``);
  const r = info.rect;
  out.push(
    `- Box: ${Math.round(r.width)}×${Math.round(r.height)} at x ${Math.round(r.x)}, y ${Math.round(r.y)}${info.hidden ? ` (hidden: ${info.hidden})` : info.inView ? "" : " (outside the viewport)"}`,
  );
  const text = info.text.replace(/\s+/g, " ").trim();
  if (text) out.push(`- Text: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`);
  const attrs = info.attributes.filter(([k]) => k !== "id" && k !== "class" && !info.locatorAttrs.some(([l]) => l === k));
  if (attrs.length) out.push(`- Attributes: ${attrs.map(([k, v]) => (v === "" ? k : `${k}="${v}"`)).join(" ")}`);

  if (fw) {
    out.push("", `### ${fw.name}${fw.version ? ` ${fw.version}` : ""} components (nearest first)`);
    const shown = (user.length ? user : fw.components).slice(0, 8);
    if (!shown.length) out.push("No component found above this element.");
    shown.forEach((c, i) => {
      const where = c.source ? ` — ${fw.name === "React" ? "rendered at " : ""}\`${formatSource(c.source)}\`` : "";
      out.push(`${i + 1}. \`${c.name}\`${c.kind ? ` (${c.kind})` : ""}${where}`);
    });
    const rest = fw.components.length - shown.length;
    if (rest > 0) out.push(`… and ${rest} more${user.length ? " (libraries and framework internals)" : ""}`);
    if (fw.props !== undefined) {
      const json = JSON.stringify(fw.props, null, 2);
      const max = options.maxProps ?? 2500;
      out.push(
        "",
        `Props of \`${fw.propsOf ?? nearest?.name ?? "component"}\`:`,
        fence("json", json.length > max ? `${json.slice(0, max)}\n… (cut)` : json),
      );
    }
  }

  if (info.html) out.push("", `### HTML${info.htmlTruncated ? " (trimmed)" : ""}`, fence("html", info.html));
  if (info.styles.length) {
    out.push("", "### Computed styles (non-default)");
    out.push(fence("css", info.styles.map(([k, v]) => `${k}: ${v};`).join("\n")));
    if (info.parentLayout) out.push(`Parent: ${info.parentLayout}`);
  }
  if (options.errors?.length) {
    out.push("", "### Recent console errors");
    for (const e of options.errors.slice(0, 5))
      out.push(
        `- [${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}] ${e.message.split("\n")[0]!.slice(0, 300)}${e.source ? ` (${sourcePath(e.source)}:${e.line ?? "?"})` : ""}`,
      );
  }
  if (options.image) out.push("", "_A screenshot of the element is attached._");
  return `${out.join("\n")}\n`;
}

/** Session storage key under which the element panel hands the last pick to the AI panel. */
export const ELEMENT_HANDOFF_KEY = "pickedElement";

export interface ElementHandoff {
  tabId: number;
  url: string;
  markdown: string;
  image?: string;
  at: number;
}
