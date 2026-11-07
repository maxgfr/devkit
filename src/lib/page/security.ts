// Functions injected into the page with `runInTab` for the Security tab: each must stand alone (no outer scope).
import type { SecretSource } from "../security/secrets";

export interface SecretSnapshot {
  origin: string;
  sources: SecretSource[];
  /** Script URLs the page loaded or declared (same-origin ones get fetched and scanned). */
  scripts: string[];
}

/**
 * Text the page ships or keeps: inline scripts and JSON blobs, HTML comments, meta tags, data
 * attributes, well-known config globals, Web Storage and readable cookies. Runs in the MAIN world to
 * see the globals.
 */
export function collectSecretSources(maxPerSource: number): SecretSnapshot {
  const sources: SecretSource[] = [];
  const cap = (s: string) => (s.length > maxPerSource ? s.slice(0, maxPerSource) : s);
  const scripts = Array.from(document.scripts);
  scripts.forEach((s, i) => {
    if (s.src) return;
    const text = s.textContent ?? "";
    if (!text.trim()) return;
    const json = /json/i.test(s.type);
    sources.push({
      kind: json ? "json" : "inline-script",
      label: s.id ? `<script id="${s.id}">` : `inline script #${i + 1}${s.type ? ` (${s.type})` : ""}`,
      text: cap(text),
    });
  });
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  let n = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    n++;
    if (text.trim().length >= 12) sources.push({ kind: "comment", label: `HTML comment #${n}`, text: cap(text) });
  }
  const meta = Array.from(document.querySelectorAll("meta[content]"))
    .map(
      (m) =>
        `${m.getAttribute("name") ?? m.getAttribute("property") ?? m.getAttribute("http-equiv") ?? "meta"}="${m.getAttribute("content")}"`,
    )
    .join("\n");
  if (meta) sources.push({ kind: "meta", label: "meta tags", text: cap(meta) });
  const attrs: string[] = [];
  for (const el of Array.from(document.querySelectorAll("body *, head *")).slice(0, 20000)) {
    for (const a of Array.from(el.attributes)) {
      if ((a.name.startsWith("data-") || (a.name === "value" && (el as HTMLInputElement).type === "hidden")) && a.value.length >= 16)
        attrs.push(`<${el.localName} ${a.name}="${a.value.slice(0, 4000)}">`);
    }
  }
  if (attrs.length) sources.push({ kind: "attribute", label: "HTML attributes (data-*, hidden inputs)", text: cap(attrs.join("\n")) });
  const GLOBALS = [
    "__NEXT_DATA__",
    "__NUXT__",
    "__NUXT_DATA__",
    "__ENV__",
    "__env",
    "_env_",
    "ENV",
    "env",
    "__APP_CONFIG__",
    "__CONFIG__",
    "__RUNTIME_CONFIG__",
    "__INITIAL_STATE__",
    "__PRELOADED_STATE__",
    "__APOLLO_STATE__",
    "__remixContext",
    "firebaseConfig",
  ];
  const w = window as unknown as Record<string, unknown>;
  for (const name of GLOBALS) {
    // A global also written as <script id="…"> is already scanned.
    if (document.getElementById(name)) continue;
    let value: unknown;
    try {
      value = w[name];
    } catch {
      continue;
    }
    if (value === undefined || value === null || typeof value === "function" || value instanceof Node) continue;
    let text = "";
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      continue;
    }
    if (text && text.length > 2) sources.push({ kind: "global", label: `window.${name}`, text: cap(text) });
  }
  for (const [area, store] of [
    ["localStorage", localStorage],
    ["sessionStorage", sessionStorage],
  ] as const) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? "";
        sources.push({ kind: "storage", label: `${area}["${key}"]`, text: cap(`${key}=${store.getItem(key) ?? ""}`) });
      }
    } catch {
      /* storage disabled */
    }
  }
  for (const pair of document.cookie ? document.cookie.split(/;\s*/) : []) {
    const name = pair.split("=")[0] ?? "";
    let text = pair;
    try {
      text = decodeURIComponent(pair);
    } catch {
      /* keep raw */
    }
    sources.push({ kind: "cookie", label: `cookie "${name}"`, text: cap(text) });
  }
  const urls = new Set<string>();
  for (const s of scripts) if (s.src) urls.add(s.src);
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"], link[rel="preload"][as="script"]')))
    if (l.href) urls.add(l.href);
  for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    if (e.initiatorType === "script" || /\.m?js(\?|$)/.test(new URL(e.name, location.href).pathname)) urls.add(e.name);
  return { origin: location.origin, sources, scripts: [...urls].filter((u) => /^https?:/.test(u)) };
}

export interface SurfaceSnapshot {
  url: string;
  resources: { name: string; type: string; transfer: number; encoded: number; decoded: number }[];
  scripts: { src: string; integrity: string; crossorigin: string | null; type: string }[];
  styles: { href: string; integrity: string; crossorigin: string | null }[];
  preloads: { href: string; as: string; crossorigin: string | null }[];
  iframes: { src: string; sandbox: string | null; allow: string }[];
  images: string[];
  media: string[];
  forms: string[];
  inlineScripts: number;
  inlineHandlers: number;
  inlineStyles: number;
  styleAttributes: number;
  dataImages: boolean;
  metaCsp: string[];
  /** Any element pointing to http:// (for mixed content on https pages). */
  insecure: { tag: string; url: string }[];
}

/** Where the page loads things from: resource timing plus the DOM's scripts, styles, frames, images and forms. */
export function collectSurface(): SurfaceSnapshot {
  const abs = (u: string | null) => {
    if (!u) return "";
    try {
      return new URL(u, location.href).href;
    } catch {
      return "";
    }
  };
  const scriptEls = Array.from(document.scripts);
  const inline = scriptEls.filter((s) => !s.src && !/json|template|text\/(x-)?(html|template)/i.test(s.type));
  const handlerAttrs = ["onclick", "onload", "onerror", "onmouseover", "onsubmit", "onchange", "oninput", "onfocus", "onblur", "onkeydown"];
  let inlineHandlers = 0;
  let styleAttributes = 0;
  const insecure: { tag: string; url: string }[] = [];
  for (const el of Array.from(document.querySelectorAll("*")).slice(0, 30000)) {
    if (el.hasAttribute("style")) styleAttributes++;
    for (const h of handlerAttrs) if (el.hasAttribute(h)) inlineHandlers++;
    for (const attr of ["src", "href", "action", "data", "poster"]) {
      const v = el.getAttribute(attr);
      if (v && /^http:\/\//i.test(v) && !(el.localName === "a" && attr === "href")) insecure.push({ tag: el.localName, url: v });
    }
  }
  return {
    url: location.href,
    resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map((r) => ({
      name: r.name,
      type: r.initiatorType,
      transfer: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize,
    })),
    scripts: scriptEls
      .filter((s) => s.src)
      .map((s) => ({ src: s.src, integrity: s.integrity, crossorigin: s.getAttribute("crossorigin"), type: s.type })),
    styles: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')).map((l) => ({
      href: l.href,
      integrity: l.integrity,
      crossorigin: l.getAttribute("crossorigin"),
    })),
    preloads: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][href], link[rel="modulepreload"][href]')).map(
      (l) => ({ href: l.href, as: l.rel === "modulepreload" ? "script" : l.as, crossorigin: l.getAttribute("crossorigin") }),
    ),
    iframes: Array.from(document.querySelectorAll("iframe")).map((f) => ({
      src: abs(f.getAttribute("src")) || (f.hasAttribute("srcdoc") ? "about:srcdoc" : "about:blank"),
      sandbox: f.getAttribute("sandbox"),
      allow: f.getAttribute("allow") ?? "",
    })),
    images: Array.from(document.images)
      .map((i) => i.currentSrc || i.src)
      .filter(Boolean),
    media: Array.from(document.querySelectorAll("video[src], audio[src], source[src]"))
      .map((m) => abs(m.getAttribute("src")))
      .filter(Boolean),
    forms: Array.from(document.forms).map((f) => abs(f.getAttribute("action")) || location.href),
    inlineScripts: inline.length,
    inlineHandlers,
    inlineStyles: document.querySelectorAll("style").length,
    styleAttributes,
    dataImages: Array.from(document.images).some((i) => i.src.startsWith("data:")),
    metaCsp: Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')).map(
      (m) => m.getAttribute("content") ?? "",
    ),
    insecure: insecure.slice(0, 200),
  };
}
