// Injected in the MAIN world with `runInTab`: it must stand alone (no outer scope, no imports at runtime).
// Reads the page's dataLayer arrays and Google tag globals without changing anything: `dataLayer.push` is never
// called nor wrapped, no property is written. Values are copied into plain JSON with bounds on depth and size.

export interface RawLayerEntry {
  /** Position in its dataLayer array. */
  index: number;
  /** A `gtag()` call: the `arguments` object turned into `{ "0": "event", "1": "purchase", "2": {...} }`. */
  gtag: boolean;
  value: unknown;
}

export interface RawDataLayer {
  /** Global name, `dataLayer` unless GTM or the script tag says otherwise. */
  name: string;
  /** Entries in the array, including the ones left out past the size cap. */
  length: number;
  entries: RawLayerEntry[];
}

export interface RawContainer {
  id: string;
  /** Where devkit saw it: a key of `google_tag_manager`, or a gtm.js / gtag.js script URL. */
  source: "google_tag_manager" | "script";
  /** The dataLayer this container reads, when GTM or the script URL names it. */
  layer?: string;
}

export interface DataLayerSnapshot {
  url: string;
  title: string;
  layers: RawDataLayer[];
  containers: RawContainer[];
  /** JSON-LD blocks of the page, for the Product cross-check. */
  jsonLd: { raw: string; index: number }[];
  /** Some entries or values were left out to stay under the size cap. */
  truncated: boolean;
  /** Approximate size of what was copied, in characters of JSON. */
  size: number;
}

export function readDataLayer(): DataLayerSnapshot {
  const MAX_DEPTH = 8;
  const MAX_SIZE = 1_000_000;
  const MAX_KEYS = 300;
  const MAX_ITEMS = 300;
  const MAX_STRING = 4000;
  const ID = /^(GTM|G|AW|DC|GT|UA|HA|MC)-[A-Z0-9-]+$/i;
  const w = window as unknown as Record<string, unknown>;
  let size = 0;
  let truncated = false;

  const tagOf = (node: { nodeName?: unknown; id?: unknown; className?: unknown }) => {
    const tag = String(node.nodeName ?? "node").toLowerCase();
    const id = typeof node.id === "string" && node.id ? `#${node.id}` : "";
    const cls =
      typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    return `<${tag}${id}${cls}>`;
  };

  // `stack` holds the objects on the current path only: a value seen twice in different branches is copied twice,
  // a value that contains itself becomes "[Circular]".
  const copy = (value: unknown, depth: number, stack: unknown[]): unknown => {
    if (size > MAX_SIZE) {
      truncated = true;
      return "[Truncated]";
    }
    if (value === null) {
      size += 4;
      return null;
    }
    switch (typeof value) {
      case "string": {
        const s = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
        if (s !== value) truncated = true;
        size += s.length + 2;
        return s;
      }
      case "number":
        size += 8;
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
        size += 5;
        return value;
      case "undefined":
        return undefined;
      case "bigint":
        size += 12;
        return `${value}n`;
      case "symbol":
        size += 12;
        return String(value);
      case "function": {
        const name = (value as { name?: string }).name;
        size += 20;
        return `[Function${name ? ` ${name}` : ""}]`;
      }
    }
    const obj = value as Record<string, unknown>;
    if (stack.includes(obj)) {
      size += 12;
      return "[Circular]";
    }
    try {
      if (obj === (window as unknown)) return "[Window]";
      if (obj === (document as unknown)) return "[Document]";
      if (typeof obj.nodeType === "number" && typeof obj.nodeName === "string") {
        const t = tagOf(obj as never);
        size += t.length;
        return t;
      }
      const kind = Object.prototype.toString.call(obj);
      if (kind === "[object Date]") {
        const d = obj as unknown as Date;
        return Number.isNaN(d.getTime()) ? "Invalid Date" : d.toISOString();
      }
      if (kind === "[object RegExp]") return String(obj);
      if (kind === "[object Error]") return `[Error: ${String((obj as { message?: unknown }).message ?? "")}]`;
      if (kind === "[object Map]" || kind === "[object Set]" || kind === "[object Promise]" || kind === "[object WeakMap]")
        return `[${kind.slice(8, -1)}]`;
    } catch {
      return "[Unreadable]";
    }
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return "[Too deep]";
    }
    const next = [...stack, obj];
    try {
      const isArgs = Object.prototype.toString.call(obj) === "[object Arguments]";
      if (Array.isArray(obj) && !isArgs) {
        const out: unknown[] = [];
        const n = Math.min(obj.length, MAX_ITEMS);
        if (obj.length > MAX_ITEMS) truncated = true;
        for (let i = 0; i < n; i++) {
          let v: unknown;
          try {
            v = copy(obj[i], depth + 1, next);
          } catch {
            v = "[Unreadable]";
          }
          out.push(v === undefined ? null : v);
          size += 1;
        }
        size += 2;
        return out;
      }
      const out: Record<string, unknown> = {};
      const keys = isArgs ? Array.from({ length: (obj as unknown as { length: number }).length }, (_, i) => String(i)) : Object.keys(obj);
      if (keys.length > MAX_KEYS) truncated = true;
      for (const k of keys.slice(0, MAX_KEYS)) {
        let v: unknown;
        try {
          v = copy(obj[k], depth + 1, next);
        } catch {
          v = "[Unreadable]";
        }
        if (v !== undefined) {
          out[k] = v;
          size += k.length + 4;
        }
      }
      size += 2;
      return out;
    } catch {
      return "[Unreadable]";
    }
  };

  // Names of the dataLayer arrays: the default one, the ones GTM containers say they read, and `l=` of the scripts.
  const names: string[] = ["dataLayer"];
  const containers: RawContainer[] = [];
  const addContainer = (c: RawContainer) => {
    const id = c.id.toUpperCase();
    const known = containers.find((x) => x.id === id);
    if (known) {
      known.layer ??= c.layer;
      return;
    }
    containers.push({ ...c, id });
  };
  try {
    const gtm = w.google_tag_manager as Record<string, unknown> | undefined;
    if (gtm && typeof gtm === "object")
      for (const key of Object.keys(gtm)) {
        if (!ID.test(key)) continue;
        let layer: string | undefined;
        try {
          const dl = (gtm[key] as { dataLayer?: { name?: unknown } } | undefined)?.dataLayer;
          if (dl && typeof dl.name === "string") layer = dl.name;
        } catch {
          // A getter that throws: keep the id without its layer.
        }
        addContainer({ id: key, source: "google_tag_manager", layer });
        if (layer && !names.includes(layer)) names.push(layer);
      }
  } catch {
    // google_tag_manager is not readable.
  }
  for (const s of Array.from(document.scripts)) {
    const src = s.src;
    if (!/googletagmanager\.com\/(gtm\.js|gtag\/js)|\/gtm\.js\?/.test(src)) continue;
    try {
      const u = new URL(src);
      const id = u.searchParams.get("id");
      const l = u.searchParams.get("l") || undefined;
      if (id && ID.test(id)) addContainer({ id, source: "script", layer: l ?? "dataLayer" });
      if (l && !names.includes(l)) names.push(l);
    } catch {
      // Not a URL.
    }
  }

  const layers: RawDataLayer[] = [];
  for (const name of names) {
    let arr: unknown;
    try {
      arr = w[name];
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const entries: RawLayerEntry[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (size > MAX_SIZE) {
        truncated = true;
        break;
      }
      let raw: unknown;
      try {
        raw = arr[i];
      } catch {
        raw = "[Unreadable]";
      }
      const gtag = raw !== null && typeof raw === "object" && Object.prototype.toString.call(raw) === "[object Arguments]";
      const value = copy(raw, 0, []);
      entries.push({ index: i, gtag, value: value === undefined ? null : value });
    }
    layers.push({ name, length: arr.length, entries });
  }

  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s, index) => ({ raw: (s.textContent ?? "").slice(0, 200_000), index }))
    .slice(0, 50);

  return { url: location.href, title: document.title, layers, containers, jsonLd, truncated, size };
}
