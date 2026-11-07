// Injected into the page by runInTab: must not use anything from its enclosing scope (types only).

export type AssetSource = "img" | "input" | "svg" | "background" | "poster" | "favicon" | "manifest" | "social";

export interface RawAsset {
  source: AssetSource;
  /** Absolute URL (http(s), data: or blob:). Absent for inline SVG. */
  url?: string;
  /** Inline SVG markup. */
  markup?: string;
  /** The markup or data URL was cut: too large to bring to the side panel whole. */
  truncated?: boolean;
  /** Bytes of a data: URL or inline markup, counted in the page (before any cut). */
  inlineBytes?: number;
  /** Intrinsic size; null when the file failed to load; absent when unknown (vector, not loaded yet). */
  natural?: { width: number; height: number } | null;
  /** On-screen size of the element, CSS px. */
  rendered?: { width: number; height: number };
  /** Computed `background-size` (first layer), for backgrounds. */
  bgSize?: string;
  /** `alt` attribute; null when missing. Images only. */
  alt?: string | null;
  /** Accessible name of an inline SVG (aria-label, aria-labelledby, <title>). */
  name?: string;
  /** aria-hidden, role=presentation / none, or alt="". */
  decorative?: boolean;
  /** role="img" on an inline SVG. */
  roleImg?: boolean;
  /** An inline SVG that is the only content of a link or button without a name. */
  iconOnlyControl?: boolean;
  label: string;
  sizes?: string;
  mime?: string;
  status: "ok" | "broken" | "pending";
  hidden?: boolean;
  bytes?: { transfer: number; encoded: number; decoded: number };
}

export interface AssetsSnapshot {
  url: string;
  origin: string;
  dpr: number;
  assets: RawAsset[];
  /** Elements looked at, and whether the scan stopped at its cap. */
  scanned: number;
  capped: boolean;
  manifestError?: string;
}

/** Every image, inline SVG, background image, video poster, favicon, manifest icon and social image of the page. */
export async function collectAssets(probeTimeout = 4000): Promise<AssetsSnapshot> {
  const MAX_ELEMENTS = 20000;
  const MAX_MARKUP = 200_000;
  const MAX_DATA_URL = 512 * 1024;
  const MAX_PROBES = 150;

  const abs = (u: string, base = location.href) => {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  };
  const label = (el: Element) => {
    const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return `${el.localName}${el.id ? `#${el.id}` : ""}${cls.map((c) => `.${c}`).join("")}`;
  };
  const timing = new Map<string, PerformanceResourceTiming>();
  for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) timing.set(e.name, e);
  const bytesOf = (url: string) => {
    const e = timing.get(url);
    return e ? { transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize } : undefined;
  };
  const sizeOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };
  const utf8 = (s: string) => new TextEncoder().encode(s).length;
  const dataBytes = (u: string) => {
    const comma = u.indexOf(",");
    if (comma < 0) return 0;
    const body = u.slice(comma + 1);
    if (/;base64$/i.test(u.slice(0, comma))) return Math.floor((body.replace(/=+$/, "").length * 3) / 4);
    try {
      return utf8(decodeURIComponent(body));
    } catch {
      return body.length;
    }
  };
  const isSvgUrl = (u: string) => /^data:image\/svg/i.test(u) || /\.svg(?:[?#]|$)/i.test(u);

  const out: RawAsset[] = [];
  /** Adds a URL asset; data: URLs too long to carry are kept by size only. */
  const push = (a: RawAsset) => {
    if (a.url?.startsWith("data:")) {
      a.inlineBytes = dataBytes(a.url);
      a.mime = /^data:([^;,]+)/i.exec(a.url)?.[1]?.toLowerCase();
      if (a.url.length > MAX_DATA_URL) {
        a.url = `${a.url.slice(0, 64)}…`;
        a.truncated = true;
      }
    } else if (a.url) a.bytes = bytesOf(a.url);
    out.push(a);
  };

  const all: Element[] = [];
  let capped = false;
  const walk = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll("*")) {
      if (all.length >= MAX_ELEMENTS) {
        capped = true;
        return;
      }
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const decorativeOf = (el: Element) => {
    const role = el.getAttribute("role");
    return el.getAttribute("aria-hidden") === "true" || role === "presentation" || role === "none";
  };

  for (const el of all) {
    const name = el.localName;
    if (name === "img" || (name === "input" && (el as HTMLInputElement).type === "image")) {
      const img = el as HTMLImageElement;
      const url = (name === "img" ? img.currentSrc || img.src : (el as HTMLInputElement).src) || "";
      if (!url) continue;
      const rendered = sizeOf(el);
      let status: RawAsset["status"] = "ok";
      let natural: RawAsset["natural"];
      if (name === "img") {
        if (!img.complete) status = "pending";
        else if (img.naturalWidth > 0) natural = { width: img.naturalWidth, height: img.naturalHeight };
        else if (!isSvgUrl(url)) {
          status = "broken";
          natural = null;
        }
      }
      const alt = el.getAttribute("alt");
      push({
        source: name === "img" ? "img" : "input",
        url,
        natural,
        rendered,
        alt,
        decorative: alt === "" || decorativeOf(el),
        label: label(el),
        status,
        hidden: rendered.width === 0 || rendered.height === 0,
      });
    } else if (name === "svg" && !el.parentElement?.closest("svg")) {
      // Sprite icons (<use href="#id">) carry their shapes along, so the markup stands on its own.
      let markup = el.outerHTML;
      const refs = new Map<string, Element>();
      for (const use of el.querySelectorAll("use")) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        const target = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
        if (target && !el.contains(target)) refs.set(href, target);
      }
      if (refs.size) {
        const clone = el.cloneNode(true) as Element;
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        for (const t of refs.values()) defs.append(t.cloneNode(true));
        clone.prepend(defs);
        markup = clone.outerHTML;
      }
      const inlineBytes = utf8(markup);
      const truncated = markup.length > MAX_MARKUP;
      if (truncated) markup = markup.slice(0, MAX_MARKUP);
      const labelled = el.getAttribute("aria-labelledby");
      const byIds = labelled
        ? labelled
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .join(" ")
            .trim()
        : "";
      const title =
        Array.from(el.children)
          .find((c) => c.localName === "title")
          ?.textContent?.trim() ?? "";
      const accName = el.getAttribute("aria-label")?.trim() || byIds || title || undefined;
      const control = el.parentElement?.closest("a[href], button, [role=button]");
      const controlNamed =
        control &&
        (control.textContent?.trim() ||
          control.getAttribute("aria-label")?.trim() ||
          control.getAttribute("aria-labelledby") ||
          control.getAttribute("title")?.trim());
      const rendered = sizeOf(el);
      out.push({
        source: "svg",
        markup,
        truncated,
        inlineBytes,
        name: accName,
        decorative: decorativeOf(el),
        roleImg: el.getAttribute("role") === "img",
        iconOnlyControl: Boolean(control && !controlNamed && !accName),
        label: label(el),
        status: "ok",
        rendered,
        hidden: rendered.width === 0 || rendered.height === 0,
        mime: "image/svg+xml",
      });
    } else if (name === "video" && el.getAttribute("poster")) {
      push({ source: "poster", url: abs(el.getAttribute("poster")!), rendered: sizeOf(el), label: label(el), status: "ok" });
    }

    const cs = getComputedStyle(el);
    const bg = cs.backgroundImage;
    if (bg && bg !== "none" && bg.includes("url(")) {
      const rendered = sizeOf(el);
      const bgSize = cs.backgroundSize.split(",")[0]!.trim();
      for (const m of bg.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/g)) {
        const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
        if (!raw) continue;
        push({
          source: "background",
          url: abs(raw),
          rendered,
          bgSize,
          label: label(el),
          status: "ok",
          hidden: rendered.width === 0 || rendered.height === 0,
        });
      }
    }
  }

  for (const link of document.querySelectorAll<HTMLLinkElement>("link[rel][href]")) {
    const rel = link.rel.toLowerCase().split(/\s+/);
    if (
      rel.includes("icon") ||
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed") ||
      rel.includes("mask-icon")
    )
      push({
        source: "favicon",
        url: link.href,
        sizes: link.getAttribute("sizes") ?? undefined,
        mime: link.type || undefined,
        label: `link[rel=${link.getAttribute("rel")}]`,
        status: "ok",
      });
  }

  let manifestError: string | undefined;
  const manifestLink = document.querySelector<HTMLLinkElement>("link[rel~=manifest][href]");
  if (manifestLink) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(manifestLink.href, {
        credentials: manifestLink.crossOrigin === "use-credentials" ? "include" : "same-origin",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[] };
      for (const icon of Array.isArray(json.icons) ? json.icons : []) {
        if (!icon?.src) continue;
        push({
          source: "manifest",
          url: abs(icon.src, res.url || manifestLink.href),
          sizes: icon.sizes,
          mime: icon.type,
          label: `manifest icon${icon.purpose ? ` (${icon.purpose})` : ""}`,
          status: "ok",
        });
      }
    } catch (e) {
      manifestError = e instanceof Error ? e.message : String(e);
    }
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    "meta[property='og:image'], meta[property='og:image:url'], meta[name='twitter:image'], meta[property='twitter:image']",
  )) {
    if (meta.content)
      push({
        source: "social",
        url: abs(meta.content),
        label: `meta[${meta.getAttribute("property") ? "property" : "name"}=${meta.getAttribute("property") ?? meta.getAttribute("name")}]`,
        status: "ok",
      });
  }

  // Intrinsic sizes the DOM does not give: load each URL once (the browser cache answers most).
  const probes = new Map<string, Promise<{ width: number; height: number } | null | undefined>>();
  const probe = (url: string) =>
    new Promise<{ width: number; height: number } | null | undefined>((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(undefined), probeTimeout);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : undefined);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    });
  for (const a of out) {
    if (a.natural !== undefined || !a.url || a.truncated || a.source === "img" || a.source === "input") continue;
    if (!probes.has(a.url) && probes.size < MAX_PROBES) probes.set(a.url, probe(a.url));
  }
  const sizes = new Map<string, { width: number; height: number } | null | undefined>();
  await Promise.all([...probes].map(async ([u, p]) => sizes.set(u, await p)));
  for (const a of out) {
    if (!a.url || !sizes.has(a.url)) continue;
    const s = sizes.get(a.url);
    if (s === null) {
      a.natural = null;
      a.status = "broken";
    } else if (s) a.natural = s;
    if (!a.bytes && !a.url.startsWith("data:")) a.bytes = bytesOf(a.url);
  }

  return { url: location.href, origin: location.origin, dpr: devicePixelRatio, assets: out, scanned: all.length, capped, manifestError };
}

/** The page's own bytes for `url` (same-origin, blob: or CORS-enabled), as a data URL. Null when the page cannot read it either. */
export async function fetchInPage(url: string): Promise<{ dataUrl: string; type: string } | null> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, type: blob.type };
  } catch {
    return null;
  }
}
