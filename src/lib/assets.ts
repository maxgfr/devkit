// Page assets: what collectAssets (src/lib/page/assets.ts) found, merged per file, sized and flagged.
import type { AssetSource, AssetsSnapshot, RawAsset } from "./page/assets";

export type AssetKind = "image" | "svg" | "background" | "icon" | "poster" | "social";

export const ASSET_KINDS: { kind: AssetKind; label: string; folder: string }[] = [
  { kind: "image", label: "Images", folder: "images" },
  { kind: "svg", label: "Inline SVG", folder: "svg" },
  { kind: "background", label: "Backgrounds", folder: "backgrounds" },
  { kind: "icon", label: "Icons", folder: "icons" },
  { kind: "poster", label: "Posters", folder: "posters" },
  { kind: "social", label: "Social", folder: "social" },
];

export const KIND_OF: Record<AssetSource, AssetKind> = {
  img: "image",
  input: "image",
  svg: "svg",
  background: "background",
  poster: "poster",
  favicon: "icon",
  manifest: "icon",
  social: "social",
};

export interface Size {
  width: number;
  height: number;
}

export type AltState = "present" | "decorative" | "missing" | "none";

export interface Oversize {
  /** Intrinsic size over the pixels the screen needs (rendered × DPR), on the less oversized axis. */
  ratio: number;
  need: Size;
  /** Rough bytes over what the displayed size needs, when the file size is known. */
  wasted?: number;
}

export interface Asset {
  key: string;
  kind: AssetKind;
  sources: AssetSource[];
  url?: string;
  markup?: string;
  truncated: boolean;
  /** File name for the list and the zip. */
  name: string;
  /** PNG, JPEG, SVG… ("" when unknown). */
  format: string;
  mime?: string;
  natural?: Size | null;
  /** Largest on-screen size among its uses (drawn size for backgrounds). */
  rendered?: Size;
  /** Elements using it, first few. */
  labels: string[];
  uses: number;
  alt: AltState;
  altText?: string;
  status: "ok" | "broken" | "pending";
  oversize?: Oversize;
  bytes?: number;
  crossOrigin: boolean;
  hidden: boolean;
  sizes?: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Drawn size of a background image in a `box`, from its computed `background-size` (first layer). */
export function backgroundDrawn(natural: Size, box: Size, bgSize = "auto"): Size {
  const v = bgSize.trim().toLowerCase();
  if (!natural.width || !natural.height) return natural;
  if (v === "cover" || v === "contain") {
    const s = (v === "cover" ? Math.max : Math.min)(box.width / natural.width, box.height / natural.height);
    return { width: natural.width * s, height: natural.height * s };
  }
  const [wv = "auto", hv = "auto"] = v.split(/\s+/);
  const len = (t: string, of: number): number | null => {
    if (t === "auto") return null;
    if (t.endsWith("%")) return (Number.parseFloat(t) / 100) * of;
    if (t.endsWith("px")) return Number.parseFloat(t);
    return null;
  };
  const w = len(wv, box.width);
  const h = len(hv, box.height);
  if (w !== null && h !== null) return { width: w, height: h };
  if (w !== null) return { width: w, height: (w * natural.height) / natural.width };
  if (h !== null) return { width: (h * natural.width) / natural.height, height: h };
  return natural;
}

/**
 * How much larger than needed an image is served: intrinsic size against rendered size × DPR, on the
 * axis that needs the most (object-fit: cover crops the other). Flagged from `threshold` (2: 4× the pixels),
 * and only when it is also 1.5× more than a 2× screen needs. The waste estimate assumes 2× screens.
 */
export function oversizeOf(
  natural: Size | null | undefined,
  rendered: Size | undefined,
  dpr: number,
  bytes?: number,
  threshold = 2,
): Oversize | undefined {
  if (!natural || !rendered || rendered.width < 1 || rendered.height < 1 || natural.width < 1 || natural.height < 1) return undefined;
  const d = dpr > 0 ? dpr : 1;
  const need = { width: Math.ceil(rendered.width * d), height: Math.ceil(rendered.height * d) };
  const ratio = Math.min(natural.width / need.width, natural.height / need.height);
  // A file sized for 2× screens is not flagged on a 1× one: only what even a 2× screen would not use.
  const hi = Math.max(d, 2);
  const hiRatio = Math.min(natural.width / Math.ceil(rendered.width * hi), natural.height / Math.ceil(rendered.height * hi));
  if (!(ratio >= threshold) || !(hiRatio >= 1.5)) return undefined;
  return { ratio: round1(ratio), need, wasted: bytes ? Math.round(bytes * (1 - 1 / (hiRatio * hiRatio))) : undefined };
}

const EXT_FORMAT: Record<string, string> = {
  png: "PNG",
  apng: "PNG",
  jpg: "JPEG",
  jpeg: "JPEG",
  jfif: "JPEG",
  pjpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  avif: "AVIF",
  svg: "SVG",
  "svg+xml": "SVG",
  ico: "ICO",
  "x-icon": "ICO",
  "vnd.microsoft.icon": "ICO",
  bmp: "BMP",
  tif: "TIFF",
  tiff: "TIFF",
  jxl: "JPEG XL",
  heic: "HEIC",
};

const FORMAT_EXT: Record<string, string> = {
  PNG: "png",
  JPEG: "jpg",
  GIF: "gif",
  WebP: "webp",
  AVIF: "avif",
  SVG: "svg",
  ICO: "ico",
  BMP: "bmp",
  TIFF: "tiff",
  "JPEG XL": "jxl",
  HEIC: "heic",
};

/** Image format from a MIME type ("image/png") or a file name. */
export function formatOf(mime?: string, url?: string): string {
  const m = mime?.toLowerCase().split(";")[0]?.trim();
  if (m?.startsWith("image/")) {
    const f = EXT_FORMAT[m.slice(6)];
    if (f) return f;
  }
  if (url && !url.startsWith("data:")) {
    try {
      const ext = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
      if (ext && EXT_FORMAT[ext]) return EXT_FORMAT[ext]!;
    } catch {
      /* not a URL */
    }
  }
  return "";
}

export const extensionFor = (format: string, fallback = "bin") => FORMAT_EXT[format] ?? fallback;

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** A file name for an asset: the URL's last segment, else a name from its label. Extension added when missing. */
export function fileNameOf(a: { url?: string; kind: AssetKind; format: string; hint?: string }, index: number): string {
  let base = "";
  if (a.url && !a.url.startsWith("data:") && !a.url.startsWith("blob:")) {
    try {
      const seg = new URL(a.url).pathname.split("/").filter(Boolean).pop() ?? "";
      base = slug(decodeURIComponent(seg));
    } catch {
      base = "";
    }
  }
  if (!base) base = slug(a.hint ?? "") || `${a.kind}-${index + 1}`;
  const ext = extensionFor(a.format, "");
  if (ext) {
    const has = /\.([a-z0-9]{2,5})$/i.exec(base)?.[1]?.toLowerCase();
    if (!has || (has !== ext && EXT_FORMAT[has] !== a.format)) base = `${base}.${ext}`;
  }
  return base;
}

/** `name`, or `name-2`, `name-3`… so that it is not in `used` (case-insensitive). Adds it to `used`. */
export function uniqueName(used: Set<string>, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem}-${i}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const altOf = (r: RawAsset): { state: AltState; text?: string } => {
  if (r.source === "img" || r.source === "input") {
    if (r.decorative || r.alt === "") return { state: "decorative" };
    if (r.alt === null || r.alt === undefined) return { state: "missing" };
    return { state: "present", text: r.alt };
  }
  if (r.source === "svg") {
    if (r.decorative) return { state: "decorative" };
    if (r.name) return { state: "present", text: r.name };
    return { state: r.roleImg || r.iconOnlyControl ? "missing" : "none" };
  }
  return { state: "none" };
};

const ALT_RANK: Record<AltState, number> = { missing: 3, none: 2, present: 1, decorative: 0 };

/** Best byte count: encoded body, else decoded, else transfer; data: URLs and inline markup by length. */
function bytesOfRaw(r: RawAsset): number | undefined {
  if (r.inlineBytes !== undefined) return r.inlineBytes;
  const b = r.bytes;
  if (!b) return undefined;
  return b.encoded || b.decoded || b.transfer || undefined;
}

const area = (s: Size | undefined) => (s ? s.width * s.height : 0);

/** Merges the raw finds into one asset per file (per markup for inline SVG), with flags and sizes. */
export function buildAssets(snapshot: Pick<AssetsSnapshot, "assets" | "dpr" | "origin">): Asset[] {
  const byKey = new Map<string, Asset & { svgHint?: string }>();
  for (const r of snapshot.assets) {
    const kind = KIND_OF[r.source];
    const key = r.markup !== undefined ? `svg:${r.markup}` : `${kind}:${r.url}`;
    const rendered = r.source === "background" && r.natural && r.rendered ? backgroundDrawn(r.natural, r.rendered, r.bgSize) : r.rendered;
    const alt = altOf(r);
    const bytes = bytesOfRaw(r);
    const prev = byKey.get(key);
    if (prev) {
      prev.uses++;
      if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
      if (prev.labels.length < 5 && !prev.labels.includes(r.label)) prev.labels.push(r.label);
      if (area(rendered) > area(prev.rendered)) prev.rendered = rendered;
      if (ALT_RANK[alt.state] > ALT_RANK[prev.alt]) {
        prev.alt = alt.state;
        prev.altText = alt.text;
      }
      if (prev.natural === undefined && r.natural !== undefined) prev.natural = r.natural;
      if (r.status === "broken") {
        prev.status = "broken";
        prev.bytes = undefined;
      } else if (prev.bytes === undefined && prev.status !== "broken") prev.bytes = bytes;
      prev.hidden = prev.hidden && Boolean(r.hidden);
      if (!prev.sizes && r.sizes) prev.sizes = r.sizes;
      continue;
    }
    let crossOrigin = false;
    if (r.url && /^https?:/i.test(r.url)) {
      try {
        crossOrigin = new URL(r.url).origin !== snapshot.origin;
      } catch {
        crossOrigin = false;
      }
    }
    const format = r.source === "svg" ? "SVG" : formatOf(r.mime, r.url);
    byKey.set(key, {
      key,
      kind,
      sources: [r.source],
      url: r.url,
      markup: r.markup,
      truncated: Boolean(r.truncated),
      name: "",
      format,
      mime: r.mime,
      natural: r.natural,
      rendered,
      labels: [r.label],
      uses: 1,
      alt: alt.state,
      altText: alt.text,
      status: r.status,
      // A failed load's bytes are the error page's.
      bytes: r.status === "broken" ? undefined : bytes,
      crossOrigin,
      hidden: Boolean(r.hidden),
      sizes: r.sizes,
      svgHint: r.source === "svg" ? (r.name || /#([\w-]+)/.exec(r.label)?.[1])?.toLowerCase() : undefined,
    });
  }
  const used = new Set<string>();
  const list = [...byKey.values()];
  list.forEach((a, i) => {
    a.name = uniqueName(
      used,
      fileNameOf({ url: a.url, kind: a.kind, format: a.format, hint: a.svgHint ?? (a.kind === "svg" ? "icon" : undefined) }, i),
    );
    delete a.svgHint;
    // Vectors scale for free; icons ship several sizes on purpose.
    if (a.format !== "SVG" && a.kind !== "icon" && a.kind !== "social" && a.status === "ok")
      a.oversize = oversizeOf(a.natural, a.rendered, snapshot.dpr, a.bytes);
  });
  return list;
}

export interface AssetFilter {
  kind: AssetKind | "all";
  missingAlt?: boolean;
  oversized?: boolean;
  broken?: boolean;
  query?: string;
}

export function filterAssets(assets: Asset[], f: AssetFilter): Asset[] {
  const q = f.query?.trim().toLowerCase();
  return assets.filter(
    (a) =>
      (f.kind === "all" || a.kind === f.kind) &&
      (!f.missingAlt || a.alt === "missing") &&
      (!f.oversized || Boolean(a.oversize)) &&
      (!f.broken || a.status === "broken") &&
      (!q || [a.name, a.url?.startsWith("data:") ? "" : a.url, a.altText, a.format, ...a.labels].some((s) => s?.toLowerCase().includes(q))),
  );
}

export interface AssetSummary {
  count: number;
  bytes: number;
  /** Assets whose size is unknown (cross-origin without Timing-Allow-Origin, served from memory…). */
  unknownBytes: number;
  /** `known`: assets of the kind with a byte count. */
  kinds: { kind: AssetKind; label: string; count: number; bytes: number; known: number }[];
  missingAlt: number;
  oversized: number;
  broken: number;
  wasted: number;
}

export function summarizeAssets(assets: Asset[]): AssetSummary {
  const kinds = ASSET_KINDS.map((k) => {
    const of = assets.filter((a) => a.kind === k.kind);
    return {
      kind: k.kind,
      label: k.label,
      count: of.length,
      bytes: of.reduce((n, a) => n + (a.bytes ?? 0), 0),
      known: of.filter((a) => a.bytes !== undefined).length,
    };
  }).filter((k) => k.count > 0);
  return {
    count: assets.length,
    bytes: kinds.reduce((n, k) => n + k.bytes, 0),
    unknownBytes: assets.filter((a) => a.bytes === undefined).length,
    kinds,
    missingAlt: assets.filter((a) => a.alt === "missing").length,
    oversized: assets.filter((a) => a.oversize).length,
    broken: assets.filter((a) => a.status === "broken").length,
    wasted: assets.reduce((n, a) => n + (a.oversize?.wasted ?? 0), 0),
  };
}

/** Path of an asset inside the zip: a folder per kind. */
export function zipPath(a: Pick<Asset, "kind" | "name">, used: Set<string>): string {
  const folder = ASSET_KINDS.find((k) => k.kind === a.kind)?.folder ?? "other";
  return uniqueName(used, `${folder}/${a.name}`);
}

/** Bytes of a data: URL. */
export function dataUrlBytes(url: string): { bytes: Uint8Array<ArrayBuffer>; type: string } | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  const meta = m[1] ?? "";
  const type = meta.split(";")[0] || "text/plain";
  if (/;base64$/i.test(meta)) {
    try {
      const bin = atob(m[2]!.replace(/\s+/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { bytes: out, type };
    } catch {
      return null;
    }
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(m[2]!)), type };
  } catch {
    return null;
  }
}

/** A data: URL for inline SVG markup, for thumbnails (an <img> never runs the SVG's scripts). */
export function svgDataUrl(markup: string): string {
  let svg = markup;
  // Inline SVGs often rely on the page's CSS for their size and namespace on the root.
  if (!/\sxmlns=/.test(svg.slice(0, svg.indexOf(">") + 1))) svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function sizeText(s: Size | null | undefined): string {
  if (!s) return "–";
  return `${Math.round(s.width)} × ${Math.round(s.height)}`;
}
