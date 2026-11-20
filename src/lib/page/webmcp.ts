// WebMCP page functions, injected with `runInTab`: each must stand alone (no outer scope). `collectWebMcp` and
// `executeWebMcpTool` run in the MAIN world (they need the page's own `document.modelContext`); `collectSemantics`
// and `highlightToolForm` only read or touch the DOM and run in either world.
//
// What WebMCP is, as of November 2026 (it is experimental and has changed several times):
// - Spec (W3C Web Machine Learning CG draft): https://webmachinelearning.github.io/webmcp/ and the repository
//   https://github.com/webmachinelearning/webmcp. The API lives on `document.modelContext` (`[Exposed=Window,
//   SecureContext]`), with `registerTool(tool, { signal, exposedTo })` (unregister by aborting the signal),
//   `getTools({ fromOrigins })` → Tool snapshots `{ name, title, description, inputSchema, outputSchema,
//   annotations, origin, source }`, and `executeTool(tool, inputObject, { signal })` → Promise<DOMString>.
//   ToolAnnotations: `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging` (all booleans).
// - Chrome docs: https://developer.chrome.com/docs/ai/webmcp (origin trial from Chrome 149, local flag
//   chrome://flags/#enable-webmcp-testing), imperative API https://developer.chrome.com/docs/ai/webmcp/imperative-api
//   (JSON-string arguments to executeTool deprecated from Chrome 155, `outputSchema` from Chrome 159),
//   declarative API https://developer.chrome.com/docs/ai/webmcp/declarative-api.
// - Earlier Chrome builds (early preview, Chrome 146+) exposed `navigator.modelContext` (registerTool,
//   unregisterTool, provideContext({ tools }), clearContext) and, behind the testing flag,
//   `navigator.modelContextTesting.listTools()` (input schemas as JSON strings) and
//   `executeTool(name, argsJson)`; the spec moved the getter to `document` in May 2026. Tools then also used the
//   MCP annotation names `destructiveHint`, `idempotentHint`, `openWorldHint`. Every variant is detected here.
// - Declarative tools (explainer: https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md):
//   `<form toolname tooldescription [toolautosubmit]>`, each named control a property, its description from
//   `toolparamdescription`, `required` controls in `required`, `<select>` options as an enum. Without
//   `toolautosubmit` the browser fills the form and the user submits it; devkit never submits a declarative form:
//   it fills it and leaves the submit to the developer.

export type WebMcpSource = "document.modelContext" | "navigator.modelContext" | "navigator.modelContextTesting" | "declarative";

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  /** Parsed input schema; null when the tool has none. */
  inputSchema: unknown;
  /** The schema as the API returned it when it was a string that is not valid JSON. */
  inputSchemaError?: string;
  outputSchema?: unknown;
  annotations: Record<string, unknown> | null;
  /** Every API that listed the tool, first one first. */
  sources: WebMcpSource[];
  origin?: string;
  /** Declarative tools: the form that defines them. */
  form?: { selector: string; autosubmit: boolean; action: string; method: string };
}

export interface WebMcpSnapshot {
  url: string;
  secureContext: boolean;
  /** Which WebMCP objects exist on this page, and the methods each one has. */
  apis: Record<"document" | "navigator" | "testing", { present: boolean; methods: string[] }>;
  /** Whether some API could list the page's tools (getTools / listTools). */
  enumerable: boolean;
  /** Whether some API can run a tool (executeTool). */
  executable: boolean;
  tools: WebMcpTool[];
  /** Problems while asking the APIs (a rejected promise, a timeout). */
  errors: string[];
}

export async function collectWebMcp(): Promise<WebMcpSnapshot> {
  const KNOWN = [
    "registerTool",
    "unregisterTool",
    "provideContext",
    "clearContext",
    "getTools",
    "listTools",
    "executeTool",
    "registerToolsChangedCallback",
  ];
  const errors: string[] = [];
  const doc = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  const nav = (navigator as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  const testing = (navigator as unknown as { modelContextTesting?: Record<string, unknown> }).modelContextTesting;
  const methodsOf = (o: unknown): string[] => {
    if (!o || (typeof o !== "object" && typeof o !== "function")) return [];
    return KNOWN.filter((m) => {
      try {
        return typeof (o as Record<string, unknown>)[m] === "function";
      } catch {
        return false;
      }
    });
  };
  const apis = {
    document: { present: doc != null, methods: methodsOf(doc) },
    navigator: { present: nav != null, methods: methodsOf(nav) },
    testing: { present: testing != null, methods: methodsOf(testing) },
  };
  const withTimeout = <T>(p: Promise<T> | T, ms: number, what: string): Promise<T> =>
    Promise.race([
      Promise.resolve(p),
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)),
    ]);
  const clone = (v: unknown, depth = 0): unknown => {
    if (v === null || typeof v !== "object")
      return typeof v === "function" || typeof v === "symbol" || typeof v === "bigint" ? undefined : v;
    if (depth > 12) return "[too deep]";
    if (Array.isArray(v)) return v.slice(0, 500).map((x) => clone(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 500)) {
      try {
        const c = clone((v as Record<string, unknown>)[k], depth + 1);
        if (c !== undefined) out[k] = c;
      } catch {
        /* getter threw */
      }
    }
    return out;
  };
  const read = (t: Record<string, unknown>, key: string): unknown => {
    try {
      return t[key];
    } catch {
      return undefined;
    }
  };
  const schema = (v: unknown): { value: unknown; error?: string } => {
    if (v === undefined || v === null || v === "") return { value: null };
    if (typeof v === "string") {
      try {
        return { value: JSON.parse(v) };
      } catch {
        return { value: null, error: v.slice(0, 2000) };
      }
    }
    return { value: clone(v) };
  };
  const byName = new Map<string, WebMcpTool>();
  const add = (raw: unknown, source: WebMcpSource) => {
    if (!raw || typeof raw !== "object") return;
    const t = raw as Record<string, unknown>;
    const name = String(read(t, "name") ?? "");
    const known = byName.get(name);
    if (known) {
      if (!known.sources.includes(source)) known.sources.push(source);
      return;
    }
    const input = schema(read(t, "inputSchema") ?? read(t, "input_schema"));
    const output = schema(read(t, "outputSchema"));
    const annotations = clone(read(t, "annotations"));
    const title = read(t, "title");
    const origin = read(t, "origin");
    byName.set(name, {
      name,
      title: typeof title === "string" && title ? title : undefined,
      description: String(read(t, "description") ?? ""),
      inputSchema: input.value,
      inputSchemaError: input.error,
      outputSchema: output.value ?? undefined,
      annotations:
        annotations && typeof annotations === "object" && !Array.isArray(annotations) ? (annotations as Record<string, unknown>) : null,
      sources: [source],
      origin: typeof origin === "string" ? origin : undefined,
    });
  };
  let enumerable = false;
  const lists: [unknown, WebMcpSource, string[]][] = [
    [doc, "document.modelContext", ["getTools", "listTools"]],
    [nav, "navigator.modelContext", ["getTools", "listTools"]],
    [testing, "navigator.modelContextTesting", ["listTools", "getTools"]],
  ];
  for (const [api, source, methods] of lists) {
    if (!api) continue;
    const method = methods.find((m) => typeof (api as Record<string, unknown>)[m] === "function");
    if (!method) continue;
    try {
      const list = await withTimeout(
        ((api as Record<string, unknown>)[method] as () => unknown).call(api) as Promise<unknown>,
        3000,
        `${source}.${method}()`,
      );
      const items = Array.isArray(list)
        ? list
        : list && typeof list === "object" && Array.isArray((list as { tools?: unknown }).tools)
          ? (list as { tools: unknown[] }).tools
          : null;
      if (items) {
        enumerable = true;
        for (const item of items) add(item, source);
      } else errors.push(`${source}.${method}() did not return a list`);
    } catch (e) {
      errors.push(`${source}.${method}(): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Declarative tools: forms carrying `toolname`.
  const cssPath = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (parent?.id && /^[A-Za-z][\w-]*$/.test(parent.id)) {
        parts.unshift(`#${parent.id}`);
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  };
  const labelOf = (el: Element): string => {
    const id = el.id;
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrap = el.closest("label");
    return ((byFor ?? wrap)?.textContent ?? el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  };
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form[toolname]"))) {
    const name = form.getAttribute("toolname") ?? "";
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const el of Array.from(form.elements)) {
      const ctl = el as HTMLInputElement;
      const key = ctl.getAttribute("name");
      if (!key) continue;
      const tag = el.tagName.toLowerCase();
      const type = (tag === "input" ? ctl.type || "text" : tag).toLowerCase();
      if (["submit", "button", "reset", "image", "hidden", "file", "fieldset", "output", "object"].includes(type)) continue;
      const description = el.getAttribute("toolparamdescription") ?? undefined;
      const title = el.getAttribute("toolparamtitle") ?? (labelOf(el) || undefined);
      let prop: Record<string, unknown>;
      if (tag === "select") {
        const options = Array.from((el as HTMLSelectElement).options).filter((o) => o.value !== "");
        const values = options.map((o) => o.value);
        prop = (el as HTMLSelectElement).multiple
          ? { type: "array", items: { type: "string", enum: values } }
          : { type: "string", enum: values };
        if (options.some((o) => o.text.trim() && o.text.trim() !== o.value))
          prop.anyOf = options.map((o) => ({ const: o.value, title: o.text.trim() }));
      } else if (type === "checkbox") {
        const group = form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(key)}"]`);
        if (group.length > 1) {
          const values = Array.from(group).map((c) => (c as HTMLInputElement).value);
          prop = { type: "array", items: { type: "string", enum: values } };
        } else prop = { type: "boolean" };
      } else if (type === "radio") {
        const values = Array.from(form.querySelectorAll(`input[type="radio"][name="${CSS.escape(key)}"]`)).map(
          (r) => (r as HTMLInputElement).value,
        );
        prop = { type: "string", enum: values };
      } else if (type === "number" || type === "range") {
        const step = ctl.getAttribute("step");
        prop = { type: step && step !== "any" && Number.isInteger(Number(step)) ? "integer" : "number" };
        if (ctl.min !== "") prop.minimum = Number(ctl.min);
        if (ctl.max !== "") prop.maximum = Number(ctl.max);
      } else {
        prop = { type: "string" };
        const format = { email: "email", url: "uri", date: "date", "datetime-local": "date-time", time: "time" }[type];
        if (format) prop.format = format;
        if (ctl.maxLength > 0) prop.maxLength = ctl.maxLength;
        if (ctl.pattern) prop.pattern = ctl.pattern;
      }
      if (properties[key]) continue;
      if (description) prop.description = description;
      if (title) prop.title = title;
      properties[key] = prop;
      if (ctl.required && !required.includes(key)) required.push(key);
    }
    const info = {
      selector: cssPath(form),
      autosubmit: form.hasAttribute("toolautosubmit"),
      action: form.getAttribute("action") ? form.action : "",
      method: (form.getAttribute("method") ?? "get").toLowerCase(),
    };
    const known = byName.get(name);
    if (known) {
      known.form = info;
      if (!known.sources.includes("declarative")) known.sources.push("declarative");
      continue;
    }
    byName.set(name, {
      name,
      description: form.getAttribute("tooldescription") ?? "",
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
      annotations: null,
      sources: ["declarative"],
      form: info,
    });
  }
  return {
    url: location.href,
    secureContext: window.isSecureContext,
    apis,
    enumerable,
    executable: [apis.document, apis.navigator, apis.testing].some((a) => a.methods.includes("executeTool")),
    tools: Array.from(byName.values()),
    errors,
  };
}

export interface WebMcpRun {
  ok: boolean;
  /** Which path ran the tool. */
  via: WebMcpSource | "none";
  /** The result as text (JSON pretty-printed when it parses), capped. */
  result?: string;
  error?: string;
  /** Declarative tools: the form was filled and left for the developer to submit. */
  filled?: boolean;
  ms: number;
  truncated?: boolean;
}

/**
 * Runs one tool with `argsJson`: through `document.modelContext.executeTool` (spec), then
 * `navigator.modelContext.executeTool`, then `navigator.modelContextTesting.executeTool(name, json)`. A tool that
 * comes from a declarative form is never submitted: its fields are filled and the form is outlined, the developer
 * submits it. Gives up after `timeoutMs`.
 */
export async function executeWebMcpTool(name: string, argsJson: string, timeoutMs = 15000): Promise<WebMcpRun> {
  const MAX = 20000;
  const started = performance.now();
  const done = (r: Omit<WebMcpRun, "ms">): WebMcpRun => ({ ...r, ms: Math.round(performance.now() - started) });
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be a JSON object.");
    args = parsed;
  } catch (e) {
    return done({ ok: false, via: "none", error: e instanceof Error ? e.message : String(e) });
  }
  const text = (v: unknown): { result: string; truncated?: boolean } => {
    let s: string;
    if (typeof v === "string") {
      try {
        s = JSON.stringify(JSON.parse(v), null, 2);
      } catch {
        s = v;
      }
    } else if (v === undefined) s = "(no result)";
    else {
      try {
        s = JSON.stringify(v, null, 2) ?? String(v);
      } catch {
        s = String(v);
      }
    }
    return s.length > MAX ? { result: `${s.slice(0, MAX)}…`, truncated: true } : { result: s };
  };
  const errText = (e: unknown) =>
    (e instanceof Error ? `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}` : String(e)).slice(0, 4000);
  const race = <T>(p: Promise<T>, controller?: AbortController): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => {
          controller?.abort();
          reject(new Error(`The tool did not answer within ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs),
      ),
    ]);

  // A declarative tool is filled, never submitted.
  const form = Array.from(document.querySelectorAll<HTMLFormElement>("form[toolname]")).find((f) => f.getAttribute("toolname") === name);
  if (form) {
    const set = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const filled: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      const controls = Array.from(form.elements).filter((e) => e.getAttribute("name") === key) as HTMLInputElement[];
      if (!controls.length) continue;
      const first = controls[0]!;
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      if (first.type === "checkbox" || first.type === "radio") {
        for (const c of controls) {
          const on = first.type === "checkbox" && controls.length === 1 ? Boolean(value) : values.includes(c.value);
          if (c.checked !== on) c.click();
        }
      } else if (first.tagName === "SELECT" && (first as unknown as HTMLSelectElement).multiple) {
        for (const o of Array.from((first as unknown as HTMLSelectElement).options)) o.selected = values.includes(o.value);
        first.dispatchEvent(new Event("change", { bubbles: true }));
      } else set(first, values[0] ?? "");
      filled.push(key);
    }
    form.scrollIntoView({ block: "center", behavior: "smooth" });
    form.style.outline = "2px solid #0e7490";
    form.style.outlineOffset = "2px";
    setTimeout(() => {
      form.style.outline = "";
      form.style.outlineOffset = "";
    }, 4000);
    return done({
      ok: true,
      via: "declarative",
      filled: true,
      result: `Filled ${filled.length ? filled.join(", ") : "no field"} in the form. devkit does not submit declarative tools: review the form in the page and submit it yourself.`,
    });
  }

  const doc = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  const nav = (navigator as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  const testing = (navigator as unknown as { modelContextTesting?: Record<string, unknown> }).modelContextTesting;
  for (const [api, via] of [
    [doc, "document.modelContext"],
    [nav, "navigator.modelContext"],
  ] as const) {
    if (!api || typeof api.executeTool !== "function") continue;
    const list = typeof api.getTools === "function" ? api.getTools : typeof api.listTools === "function" ? api.listTools : null;
    let tool: unknown = name;
    if (list) {
      try {
        const tools = (await race(Promise.resolve((list as () => unknown).call(api)))) as { name?: string }[];
        const found = Array.isArray(tools) ? tools.find((t) => t?.name === name) : undefined;
        if (!found) continue;
        tool = found;
      } catch {
        continue;
      }
    }
    const controller = new AbortController();
    try {
      const value = await race(
        Promise.resolve(
          (api.executeTool as (t: unknown, a: unknown, o: unknown) => unknown).call(api, tool, args, { signal: controller.signal }),
        ),
        controller,
      );
      return done({ ok: true, via, ...text(value) });
    } catch (e) {
      return done({ ok: false, via, error: errText(e) });
    }
  }
  if (testing && typeof testing.executeTool === "function") {
    try {
      const value = await race(
        Promise.resolve((testing.executeTool as (n: string, a: string) => unknown).call(testing, name, JSON.stringify(args))),
      );
      return done({ ok: true, via: "navigator.modelContextTesting", ...text(value) });
    } catch (e) {
      return done({ ok: false, via: "navigator.modelContextTesting", error: errText(e) });
    }
  }
  return done({
    ok: false,
    via: "none",
    error:
      "No WebMCP API on this page can run tools (executeTool). Enable chrome://flags/#enable-webmcp-testing or use a Chrome with the WebMCP origin trial.",
  });
}

export interface SemanticsSnapshot {
  lang: string;
  h1: number;
  main: number;
  nav: number;
  /** Form controls an agent or a screen reader would fill (not hidden, not buttons). */
  fields: number;
  /** Of those, the ones without a label, aria-label, aria-labelledby or title. */
  unlabelled: string[];
}

/** Basic page semantics for the readiness score (heuristic): language, h1, landmarks, labelled fields. */
export function collectSemantics(): SemanticsSnapshot {
  const controls = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    return !["hidden", "submit", "button", "reset", "image"].includes(type);
  });
  const labelled = (el: Element) => {
    if (el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby") || el.getAttribute("title")?.trim()) return true;
    if (el.closest("label")) return true;
    return Boolean(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
  };
  const name = (el: Element) => {
    const n = el.getAttribute("name") ?? el.id;
    return n ? `${el.tagName.toLowerCase()}[name="${n}"]` : el.tagName.toLowerCase();
  };
  return {
    lang: document.documentElement.lang,
    h1: document.querySelectorAll("h1").length,
    main: document.querySelectorAll('main, [role="main"]').length,
    nav: document.querySelectorAll('nav, [role="navigation"]').length,
    fields: controls.length,
    unlabelled: controls
      .filter((el) => !labelled(el))
      .map(name)
      .slice(0, 50),
  };
}
