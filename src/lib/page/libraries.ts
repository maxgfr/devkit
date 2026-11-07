// Injected with `runInTab` in the MAIN world for the vulnerable libraries panel: stands alone (no outer scope).
import type { PageProbe } from "../security/libraries";

export interface LibrarySnapshot {
  url: string;
  origin: string;
  /** Versions read from page globals and attributes. */
  globals: { lib: string; version: string; expr: string }[];
  /** Libraries whose global exists but whose version did not read. */
  present: { lib: string; expr: string }[];
  /** Script URLs the page loaded or declared. */
  scripts: string[];
  /** Inline scripts, capped. */
  inline: { label: string; text: string }[];
}

/**
 * Walks `probes` (property paths, attributes; data, never code) over the page's globals, and lists the
 * page's script URLs and inline scripts for the panel to match against the database.
 */
export function collectLibrarySignals(probes: PageProbe[], maxInline: number, maxInlineTotal: number): LibrarySnapshot {
  const w = window as unknown as Record<string, unknown>;
  const read = (base: unknown, path: string[] | undefined): unknown => {
    let v = base;
    for (const k of path ?? []) {
      if (v === null || v === undefined || (typeof v !== "object" && typeof v !== "function")) return undefined;
      try {
        v = (v as Record<string, unknown>)[k];
      } catch {
        return undefined;
      }
    }
    return v;
  };
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  const globals: LibrarySnapshot["globals"] = [];
  const present: LibrarySnapshot["present"] = [];
  for (const p of probes) {
    try {
      if (p.when && !read(w, p.when)) continue;
      if (p.unless && read(w, p.unless)) continue;
      let value = "";
      if (p.selector) {
        const el = document.querySelector(p.selector);
        if (!el) continue;
        value = p.attr ? (el.getAttribute(p.attr) ?? "") : text(read(el, p.path));
      } else if (p.join) {
        const parts = p.join.map((path) => text(read(w, path)));
        value = parts.every(Boolean) ? parts.join(".") : "";
      } else value = text(read(w, p.path));
      if (value && p.cut) value = value.split(p.cut)[0] ?? "";
      if (value && p.template) value = p.template.replace("$", value);
      if (value && /^v?\d[\w.+-]{0,39}$/.test(value)) globals.push({ lib: p.lib, version: value, expr: p.expr });
      else if (p.presence) {
        const name = (p.path ?? p.join?.[0] ?? [])[0] ?? "";
        const root = name ? read(w, [name]) : undefined;
        if (root && (typeof root === "object" || typeof root === "function")) present.push({ lib: p.lib, expr: `window.${name}` });
      }
    } catch {
      /* a hostile getter: skip this probe */
    }
  }
  const urls = new Set<string>();
  for (const s of Array.from(document.scripts)) if (s.src) urls.add(s.src);
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"], link[rel="preload"][as="script"]')))
    if (l.href) urls.add(l.href);
  for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    try {
      if (e.initiatorType === "script" || /\.m?js$/.test(new URL(e.name).pathname)) urls.add(e.name);
    } catch {
      /* not a URL */
    }
  }
  const inline: LibrarySnapshot["inline"] = [];
  let total = 0;
  Array.from(document.scripts).forEach((s, i) => {
    if (s.src || (s.type && !/^(text|application)\/(java|ecma)script$|^module$/i.test(s.type))) return;
    const body = s.textContent ?? "";
    if (body.trim().length < 20 || total >= maxInlineTotal) return;
    const cut = body.slice(0, Math.min(maxInline, maxInlineTotal - total));
    total += cut.length;
    inline.push({ label: s.id ? `<script id="${s.id}">` : `inline script #${i + 1}`, text: cut });
  });
  return {
    url: location.href,
    origin: location.origin,
    globals,
    present,
    scripts: [...urls].filter((u) => /^https?:/.test(u)),
    inline,
  };
}
