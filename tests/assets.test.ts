import { afterEach, describe, expect, it } from "vitest";
import {
  backgroundDrawn,
  buildAssets,
  dataUrlBytes,
  fileNameOf,
  filterAssets,
  formatOf,
  oversizeOf,
  summarizeAssets,
  svgDataUrl,
  uniqueName,
  zipPath,
} from "../src/lib/assets";
import { collectAssets, type RawAsset } from "../src/lib/page/assets";
import { crc32, dosDateTime, zipStore } from "../src/lib/zip";

describe("oversizeOf", () => {
  it("flags an image served several times larger than displayed", () => {
    const o = oversizeOf({ width: 1600, height: 1600 }, { width: 400, height: 400 }, 1, 400_000);
    expect(o).toMatchObject({ ratio: 4, need: { width: 400, height: 400 } });
    // Against a 2× screen (800 px), the file has 4× the pixels it needs: 3/4 of the bytes are extra.
    expect(o?.wasted).toBe(300_000);
  });
  it("accounts for the device pixel ratio and for 2× screens", () => {
    expect(oversizeOf({ width: 800, height: 800 }, { width: 400, height: 400 }, 2)).toBeUndefined();
    // Twice the 1× need is a normal retina asset: not flagged on a 1× screen either.
    expect(oversizeOf({ width: 800, height: 800 }, { width: 400, height: 400 }, 1)).toBeUndefined();
    expect(oversizeOf({ width: 2400, height: 2400 }, { width: 400, height: 400 }, 2)?.ratio).toBe(3);
  });
  it("uses the axis that needs the most (object-fit: cover crops the other)", () => {
    expect(oversizeOf({ width: 4000, height: 1000 }, { width: 400, height: 400 }, 1)).toBeUndefined();
  });
  it("ignores unknown or empty sizes", () => {
    expect(oversizeOf(null, { width: 10, height: 10 }, 1)).toBeUndefined();
    expect(oversizeOf({ width: 10, height: 10 }, { width: 0, height: 10 }, 1)).toBeUndefined();
  });
});

describe("backgroundDrawn", () => {
  const nat = { width: 1000, height: 500 };
  const box = { width: 200, height: 200 };
  it("resolves cover, contain, lengths and auto", () => {
    expect(backgroundDrawn(nat, box, "cover")).toEqual({ width: 400, height: 200 });
    expect(backgroundDrawn(nat, box, "contain")).toEqual({ width: 200, height: 100 });
    expect(backgroundDrawn(nat, box, "100px auto")).toEqual({ width: 100, height: 50 });
    expect(backgroundDrawn(nat, box, "auto 50%")).toEqual({ width: 200, height: 100 });
    expect(backgroundDrawn(nat, box, "32px 32px")).toEqual({ width: 32, height: 32 });
    expect(backgroundDrawn(nat, box, "auto")).toEqual(nat);
  });
});

describe("names and formats", () => {
  it("reads formats from MIME types and extensions", () => {
    expect(formatOf("image/webp")).toBe("WebP");
    expect(formatOf("image/svg+xml; charset=utf-8")).toBe("SVG");
    expect(formatOf(undefined, "https://x.test/a/photo.JPEG?w=200")).toBe("JPEG");
    expect(formatOf("image/x-icon")).toBe("ICO");
    expect(formatOf(undefined, "https://x.test/img")).toBe("");
  });
  it("names files from their URL, adding a missing extension", () => {
    expect(fileNameOf({ url: "https://x.test/a/b/hero%20image.png", kind: "image", format: "PNG" }, 0)).toBe("hero-image.png");
    expect(fileNameOf({ url: "https://x.test/img?id=4", kind: "image", format: "WebP" }, 0)).toBe("img.webp");
    expect(fileNameOf({ url: "https://x.test/p.jpeg", kind: "image", format: "JPEG" }, 0)).toBe("p.jpeg");
    expect(fileNameOf({ url: "data:image/png;base64,AAAA", kind: "background", format: "PNG" }, 2)).toBe("background-3.png");
    expect(fileNameOf({ kind: "svg", format: "SVG", hint: "logo" }, 0)).toBe("logo.svg");
  });
  it("keeps names unique, case-insensitively", () => {
    const used = new Set<string>();
    expect(uniqueName(used, "a.png")).toBe("a.png");
    expect(uniqueName(used, "A.png")).toBe("A-2.png");
    expect(uniqueName(used, "a.png")).toBe("a-3.png");
    expect(zipPath({ kind: "icon", name: "a.png" }, used)).toBe("icons/a.png");
  });
  it("decodes data: URLs", () => {
    expect(dataUrlBytes("data:image/png;base64,aGVsbG8=")).toMatchObject({ type: "image/png", bytes: new TextEncoder().encode("hello") });
    expect(dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E")?.bytes).toEqual(new TextEncoder().encode("<svg/>"));
    expect(dataUrlBytes("nope")).toBeNull();
  });
  it("adds the SVG namespace inline markup often omits", () => {
    expect(decodeURIComponent(svgDataUrl("<svg viewBox='0 0 1 1'></svg>"))).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox');
  });
});

const raw = (r: Partial<RawAsset> & Pick<RawAsset, "source">): RawAsset => ({ label: "img", status: "ok", ...r });

describe("buildAssets", () => {
  const snapshot = {
    origin: "https://site.test",
    dpr: 1,
    assets: [
      raw({
        source: "img",
        url: "https://site.test/big.png",
        natural: { width: 800, height: 800 },
        rendered: { width: 100, height: 100 },
        alt: "Mug",
        bytes: { transfer: 0, encoded: 40_000, decoded: 40_000 },
      }),
      raw({
        source: "img",
        url: "https://site.test/big.png",
        natural: { width: 800, height: 800 },
        rendered: { width: 50, height: 50 },
        alt: null,
        label: "img.thumb",
      }),
      raw({
        source: "img",
        url: "https://cdn.test/missing.jpg",
        natural: null,
        status: "broken",
        alt: "",
        bytes: { transfer: 300, encoded: 9, decoded: 9 },
      }),
      raw({ source: "svg", markup: "<svg><path/></svg>", inlineBytes: 18, name: "Star", label: "svg#star" }),
      raw({ source: "svg", markup: "<svg><path/></svg>", inlineBytes: 18, name: "Star", label: "svg#star" }),
      raw({ source: "svg", markup: "<svg><circle/></svg>", inlineBytes: 20, iconOnlyControl: true, label: "svg" }),
      raw({
        source: "background",
        url: "https://site.test/tile.png",
        natural: { width: 64, height: 64 },
        rendered: { width: 200, height: 60 },
        bgSize: "32px 32px",
      }),
      raw({ source: "favicon", url: "https://site.test/favicon.ico", sizes: "32x32" }),
      raw({ source: "manifest", url: "https://site.test/favicon.ico", sizes: "192x192" }),
    ],
  };
  const assets = buildAssets(snapshot);
  const byName = (n: string) => assets.find((a) => a.name === n)!;

  it("merges uses of the same file and keeps the worst alt state", () => {
    expect(assets).toHaveLength(6);
    const big = byName("big.png");
    expect(big).toMatchObject({ kind: "image", uses: 2, alt: "missing", bytes: 40_000, labels: ["img", "img.thumb"], crossOrigin: false });
    expect(big.rendered).toEqual({ width: 100, height: 100 });
    expect(big.oversize?.ratio).toBe(8);
  });
  it("drops the bytes of failed loads and marks them broken and decorative", () => {
    expect(byName("missing.jpg")).toMatchObject({ status: "broken", alt: "decorative", bytes: undefined, crossOrigin: true });
    expect(byName("missing.jpg").oversize).toBeUndefined();
  });
  it("names inline SVGs, dedupes them by markup, flags icon-only controls", () => {
    expect(byName("star.svg")).toMatchObject({ kind: "svg", uses: 2, alt: "present", altText: "Star", format: "SVG", bytes: 18 });
    expect(byName("icon.svg")).toMatchObject({ alt: "missing" });
  });
  it("sizes backgrounds as drawn, and merges favicon and manifest icons", () => {
    expect(byName("tile.png")).toMatchObject({ rendered: { width: 32, height: 32 }, oversize: undefined });
    expect(byName("favicon.ico")).toMatchObject({ kind: "icon", sources: ["favicon", "manifest"], format: "ICO" });
  });
  it("filters and summarizes", () => {
    expect(filterAssets(assets, { kind: "all", missingAlt: true }).map((a) => a.name)).toEqual(["big.png", "icon.svg"]);
    expect(filterAssets(assets, { kind: "all", oversized: true }).map((a) => a.name)).toEqual(["big.png"]);
    expect(filterAssets(assets, { kind: "all", broken: true }).map((a) => a.name)).toEqual(["missing.jpg"]);
    expect(filterAssets(assets, { kind: "svg" })).toHaveLength(2);
    expect(filterAssets(assets, { kind: "all", query: "thumb" }).map((a) => a.name)).toEqual(["big.png"]);
    const s = summarizeAssets(assets);
    expect(s).toMatchObject({ count: 6, missingAlt: 2, oversized: 1, broken: 1, bytes: 40_038 });
    expect(s.kinds.map((k) => [k.kind, k.count, k.known])).toEqual([
      ["image", 2, 1],
      ["svg", 2, 2],
      ["background", 1, 0],
      ["icon", 1, 0],
    ]);
  });
});

describe("collectAssets", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  it("finds images, inline SVG, posters, favicons and social images", async () => {
    document.head.innerHTML = `<link rel="icon" href="/favicon.ico" sizes="32x32"><meta property="og:image" content="/og.png">`;
    document.body.innerHTML = `
      <img src="/a.png" alt="A">
      <img src="data:image/png;base64,aGVsbG8=">
      <button><svg id="close" viewBox="0 0 1 1"><path d="M0 0"/></svg></button>
      <svg aria-hidden="true"><svg></svg></svg>
      <video poster="/poster.jpg"></video>`;
    const snap = await collectAssets(20);
    const by = (s: string) => snap.assets.filter((a) => a.source === s);
    expect(by("img").map((a) => [a.url?.slice(0, 22), a.alt])).toEqual([
      [new URL("/a.png", location.href).href.slice(0, 22), "A"],
      ["data:image/png;base64,", null],
    ]);
    expect(by("img")[1]).toMatchObject({ inlineBytes: 5, mime: "image/png" });
    expect(by("svg")).toHaveLength(2); // the nested <svg> is part of its parent
    expect(by("svg")[0]).toMatchObject({ iconOnlyControl: true, label: "svg#close" });
    expect(by("svg")[1]).toMatchObject({ decorative: true });
    // A sprite icon carries the symbol it uses.
    document.body.innerHTML = `<svg style="display:none"><symbol id="i-x" viewBox="0 0 2 2"><path d="M1 1"/></symbol></svg><svg role="img" aria-label="Close"><use href="#i-x"/></svg>`;
    const sprite = (await collectAssets(20)).assets.filter((a) => a.source === "svg")[1];
    expect(sprite?.markup).toMatch(/^<svg role="img" aria-label="Close"><defs><symbol id="i-x"/);
    expect(sprite?.name).toBe("Close");
    expect(by("poster")[0]?.url).toMatch(/\/poster\.jpg$/);
    expect(by("favicon")[0]).toMatchObject({ sizes: "32x32" });
    expect(by("social")[0]?.url).toMatch(/\/og\.png$/);
  });
});

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it("encodes DOS dates", () => {
    expect(dosDateTime(new Date(2026, 10, 7, 14, 45, 31))).toEqual({ time: (14 << 11) | (45 << 5) | 15, date: (46 << 9) | (11 << 5) | 7 });
  });
  it("writes stored entries a reader can walk", () => {
    const enc = new TextEncoder();
    const files = [
      { name: "images/a.png", data: enc.encode("hello") },
      { name: "svg/é.svg", data: enc.encode("<svg/>") },
    ];
    const zip = zipStore(files);
    const view = new DataView(zip.buffer);
    // End of central directory: 2 entries, central directory where it says.
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    let at = view.getUint32(eocd + 16, true);
    expect(view.getUint32(eocd + 12, true)).toBe(eocd - at);
    const dec = new TextDecoder();
    for (const f of files) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const nameLen = view.getUint16(at + 28, true);
      expect(dec.decode(zip.subarray(at + 46, at + 46 + nameLen))).toBe(f.name);
      const local = view.getUint32(at + 42, true);
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      expect(view.getUint16(local + 6, true) & 0x0800).toBe(0x0800); // UTF-8 names
      expect(view.getUint32(local + 14, true)).toBe(crc32(f.data));
      const size = view.getUint32(local + 18, true);
      const start = local + 30 + view.getUint16(local + 26, true);
      expect(zip.subarray(start, start + size)).toEqual(f.data);
      at += 46 + nameLen;
    }
  });
});
