import { beforeAll, describe, expect, it } from "vitest";
import {
  bodyKind,
  buildRange,
  cacheExport,
  checkTagged,
  exportFileName,
  FULL_LIMITS,
  IDB_CODEC_VERSION,
  type IdbStoreInfo,
  inlineKeyProblem,
  isValidKey,
  keyPathText,
  pageLabel,
  pageOffsets,
  parseJsonBody,
  parseKeyText,
  parseRecordText,
  PREVIEW_LIMITS,
  prefixUpperBound,
  previewTagged,
  shortUrl,
  storeExport,
  type Tagged,
} from "../src/lib/databases";
import { type IdbCodec, installIdbCodec } from "../src/lib/page/databases";

let codec: IdbCodec;
beforeAll(() => {
  expect(installIdbCodec(IDB_CODEC_VERSION)).toBe(true);
  codec = (globalThis as unknown as { __devkitIdbCodec: IdbCodec }).__devkitIdbCodec;
});

describe("IndexedDB codec (in-page)", () => {
  it("keeps plain JSON as it is", async () => {
    const value = { a: 1, b: "x", c: [true, null, { d: 2.5 }] };
    expect(await codec.encode(value, FULL_LIMITS)).toEqual(value);
    expect(codec.revive(value as Tagged)).toEqual(value);
  });

  it("tags what JSON cannot hold and revives it", async () => {
    const value = {
      born: new Date("1815-12-10T00:00:00Z"),
      bad: new Date(Number.NaN),
      prefs: new Map<unknown, unknown>([
        ["theme", "dark"],
        [1, new Set([1, 2])],
      ]),
      re: /ab+c/gi,
      big: 12345678901234567890n,
      nothing: undefined,
      nan: Number.NaN,
      inf: Number.NEGATIVE_INFINITY,
      zero: -0,
      buf: new Uint8Array([1, 2, 255]).buffer,
      view: new Uint16Array([1, 65535]),
      err: new RangeError("too far"),
    };
    const tagged = await codec.encode(value, FULL_LIMITS);
    expect(tagged).toMatchObject({
      born: { $type: "Date", value: "1815-12-10T00:00:00.000Z" },
      bad: { $type: "Date", value: null },
      prefs: {
        $type: "Map",
        entries: [
          ["theme", "dark"],
          [1, { $type: "Set", values: [1, 2] }],
        ],
      },
      re: { $type: "RegExp", source: "ab+c", flags: "gi" },
      big: { $type: "BigInt", value: "12345678901234567890" },
      nothing: { $type: "undefined" },
      nan: { $type: "Number", value: "NaN" },
      inf: { $type: "Number", value: "-Infinity" },
      zero: { $type: "Number", value: "-0" },
      buf: { $type: "ArrayBuffer", byteLength: 3, base64: "AQL/" },
      view: { $type: "Uint16Array", byteLength: 4 },
      err: { $type: "Error", name: "RangeError", message: "too far" },
    });
    expect(checkTagged(tagged)).toBeNull();
    // Through JSON, as the panel sends it back.
    const back = codec.revive(JSON.parse(JSON.stringify(tagged))) as typeof value;
    expect(back.born).toBeInstanceOf(Date);
    expect(back.born.toISOString()).toBe("1815-12-10T00:00:00.000Z");
    expect(Number.isNaN(back.bad.getTime())).toBe(true);
    expect(back.prefs).toBeInstanceOf(Map);
    expect(back.prefs.get(1)).toEqual(new Set([1, 2]));
    expect(back.re.flags).toBe("gi");
    expect(back.big).toBe(12345678901234567890n);
    expect("nothing" in back && back.nothing === undefined).toBe(true);
    expect(Number.isNaN(back.nan)).toBe(true);
    expect(back.inf).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(back.zero, -0)).toBe(true);
    expect([...new Uint8Array(back.buf)]).toEqual([1, 2, 255]);
    expect(back.view).toBeInstanceOf(Uint16Array);
    expect([...back.view]).toEqual([1, 65535]);
    expect(back.err).toBeInstanceOf(RangeError);
    expect(back.err.message).toBe("too far");
  });

  it("reads Blob and File contents when small enough", async () => {
    const blob = new Blob(["hi"], { type: "text/plain" });
    const file = new File(["abc"], "a.txt", { type: "text/plain", lastModified: 1000 });
    const tagged = (await codec.encode({ blob, file }, FULL_LIMITS)) as Record<string, Record<string, Tagged>>;
    expect(tagged.blob).toEqual({ $type: "Blob", mime: "text/plain", size: 2, base64: "aGk=" });
    expect(tagged.file).toMatchObject({ $type: "File", name: "a.txt", size: 3, lastModified: 1000, base64: "YWJj" });
    const back = codec.revive(tagged as Tagged) as { blob: Blob; file: File };
    expect(await back.blob.text()).toBe("hi");
    expect(back.file.name).toBe("a.txt");
    expect(await back.file.text()).toBe("abc");

    const big = (await codec.encode(new Blob(["x".repeat(300)]), PREVIEW_LIMITS)) as Record<string, Tagged>;
    expect(big).toMatchObject({ $type: "Blob", size: 300, truncated: true });
    expect(big.base64).toBeUndefined();
    expect(() => codec.revive(big)).toThrow(/too large/);
  });

  it("wraps objects that have their own $type key", async () => {
    const tagged = await codec.encode({ $type: "user", name: "Ada" }, FULL_LIMITS);
    expect(tagged).toEqual({ $type: "Object", value: { $type: "user", name: "Ada" } });
    expect(codec.revive(tagged)).toEqual({ $type: "user", name: "Ada" });
  });

  it("stays within its limits and refuses to write back what it cut", async () => {
    const limits = { depth: 2, string: 5, binary: 2, nodes: 50 };
    const tagged = (await codec.encode({ s: "abcdefgh", deep: { a: { b: 1 } }, bin: new Uint8Array([1, 2, 3]) }, limits)) as Record<
      string,
      Tagged
    >;
    expect(tagged.s).toEqual({ $type: "Truncated", reason: "string", length: 8, preview: "abcde" });
    expect(tagged.deep).toEqual({ a: { $type: "Truncated", reason: "depth" } });
    expect(tagged.bin).toMatchObject({ $type: "Uint8Array", byteLength: 3, truncated: true });
    expect(checkTagged(tagged as Tagged)).toMatch(/^\$\.s: cut by devkit/);
    expect(() => codec.revive(tagged as Tagged)).toThrow(/\$\.s: cut by devkit/);

    const many = await codec.encode(
      Array.from({ length: 10 }, (_, i) => i),
      { ...limits, nodes: 4 },
    );
    expect((many as Tagged[]).at(-1)).toEqual({ $type: "Truncated", reason: "nodes" });
  });

  it("marks cycles and values it cannot carry", async () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(await codec.encode(a, FULL_LIMITS)).toEqual({ name: "a", self: { $type: "Truncated", reason: "cycle" } });
    // Shared (not cyclic) references are copied.
    const shared = { x: 1 };
    expect(await codec.encode([shared, shared], FULL_LIMITS)).toEqual([{ x: 1 }, { x: 1 }]);
    expect(await codec.encode({ [Symbol.toStringTag]: "CryptoKey" }, FULL_LIMITS)).toEqual({ $type: "Unsupported", kind: "CryptoKey" });
  });

  it("revives __proto__ as an own key, not a prototype", () => {
    const back = codec.revive(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.keys(back)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("is installed once per version", () => {
    const w = globalThis as unknown as { __devkitIdbCodec: IdbCodec };
    const before = w.__devkitIdbCodec;
    installIdbCodec(IDB_CODEC_VERSION);
    expect(w.__devkitIdbCodec).toBe(before);
    installIdbCodec(IDB_CODEC_VERSION + 1);
    expect(w.__devkitIdbCodec).not.toBe(before);
    expect(w.__devkitIdbCodec.v).toBe(IDB_CODEC_VERSION + 1);
    installIdbCodec(IDB_CODEC_VERSION);
  });
});

describe("previewTagged", () => {
  it("reads like a console line", () => {
    expect(previewTagged({ id: 1, name: "Ada", tags: ["admin"] })).toBe('{id: 1, name: "Ada", tags: ["admin"]}');
    expect(previewTagged({ born: { $type: "Date", value: "1815-12-10T00:00:00.000Z" } })).toBe("{born: Date(1815-12-10T00:00:00.000Z)}");
    expect(previewTagged({ $type: "Map", entries: [["a", 1]] })).toBe("Map(1)");
    expect(previewTagged({ $type: "Blob", mime: "image/png", size: 2048 })).toBe("Blob(image/png, 2.0 KB)");
    expect(previewTagged({ $type: "Uint8Array", byteLength: 3, base64: "AQID" })).toBe("Uint8Array(3 B)");
    expect(previewTagged({ $type: "BigInt", value: "10" })).toBe("10n");
    expect(previewTagged({ $type: "Object", value: { $type: "x" } })).toBe('{$type: "x"}');
    expect(previewTagged({ "a b": 1 })).toBe('{"a b": 1}');
  });

  it("cuts long values", () => {
    const text = previewTagged({ list: Array.from({ length: 100 }, (_, i) => i) }, 30);
    expect(text.length).toBe(30);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("checkTagged and parseRecordText", () => {
  it("accepts well-formed tags", () => {
    expect(checkTagged({ d: { $type: "Date", value: "2024-01-01T00:00:00Z" }, s: { $type: "Set", values: [1] } })).toBeNull();
  });

  it("names the path of what is wrong", () => {
    expect(checkTagged({ a: [{ $type: "Nope" }] })).toBe('$.a[0]: unknown $type "Nope"');
    expect(checkTagged({ d: { $type: "Date", value: "soon" } })).toMatch(/^\$\.d: Date value/);
    expect(checkTagged({ m: { $type: "Map", entries: [[1]] } })).toMatch(/Map entry 0/);
    expect(checkTagged({ r: { $type: "RegExp", source: "(" } })).toMatch(/^\$\.r: /);
    expect(checkTagged({ b: { $type: "Uint8Array", base64: "!!" } })).toMatch(/base64/);
    expect(checkTagged({ x: { $type: "Unsupported", kind: "CryptoKey" } })).toMatch(/CryptoKey cannot/);
    expect(checkTagged({ t: { $type: 3 } })).toMatch(/must be a string/);
  });

  it("parses the editor's text", () => {
    expect(parseRecordText('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseRecordText("{a: 1}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Invalid JSON/);
    expect(parseRecordText('{"$type": "Truncated", "reason": "depth"}').ok).toBe(false);
  });
});

describe("keys", () => {
  it("knows valid IndexedDB keys", () => {
    expect(isValidKey(1)).toBe(true);
    expect(isValidKey("a")).toBe(true);
    expect(isValidKey([1, "a", [2]])).toBe(true);
    expect(isValidKey({ $type: "Date", value: "2024-01-01T00:00:00Z" })).toBe(true);
    expect(isValidKey({ $type: "ArrayBuffer", base64: "AQ==", byteLength: 1 })).toBe(true);
    expect(isValidKey(true)).toBe(false);
    expect(isValidKey(null)).toBe(false);
    expect(isValidKey({ a: 1 })).toBe(false);
    expect(isValidKey({ $type: "Number", value: "NaN" })).toBe(false);
  });

  it("reads typed keys as JSON, else as text", () => {
    expect(parseKeyText("42")).toEqual({ ok: true, value: 42 });
    expect(parseKeyText('"42"')).toEqual({ ok: true, value: "42" });
    expect(parseKeyText("theme")).toEqual({ ok: true, value: "theme" });
    expect(parseKeyText('["a", 1]')).toEqual({ ok: true, value: ["a", 1] });
    expect(parseKeyText("").ok).toBe(false);
    expect(parseKeyText("true").ok).toBe(false);
  });

  it("checks in-line keys against the key path", () => {
    expect(inlineKeyProblem({ id: 1 }, "id", false)).toBeNull();
    expect(inlineKeyProblem({ name: "x" }, "id", true)).toBeNull();
    expect(inlineKeyProblem({ name: "x" }, "id", false)).toBe('The value has no "id", the store\'s key path.');
    expect(inlineKeyProblem({ user: { id: "u1" } }, "user.id", false)).toBeNull();
    expect(inlineKeyProblem({ id: true }, "id", false)).toMatch(/not a valid key/);
    expect(inlineKeyProblem({ a: 1, b: 2 }, ["a", "b"], false)).toBeNull();
    expect(inlineKeyProblem({ a: 1 }, ["a", "b"], false)).toMatch(/"b"/);
    expect(inlineKeyProblem("text", "id", true)).toMatch(/must be an object/);
    expect(inlineKeyProblem("anything", null, false)).toBeNull();
  });

  it("describes key paths", () => {
    expect(keyPathText(null)).toBe("out-of-line keys");
    expect(keyPathText("id")).toBe("id");
    expect(keyPathText(["a", "b"])).toBe("[a, b]");
  });
});

describe("key ranges", () => {
  it("bounds a prefix by the next string", () => {
    expect(prefixUpperBound("ab")).toBe("ac");
    expect(prefixUpperBound("a￿")).toBe("b");
    expect(prefixUpperBound("￿")).toBeNull();
    expect(prefixUpperBound("")).toBeNull();
  });

  it("builds the range the page reads", () => {
    expect(buildRange("all", "x")).toEqual({ ok: true, value: { kind: "all" } });
    expect(buildRange("prefix", "")).toEqual({ ok: true, value: { kind: "all" } });
    expect(buildRange("prefix", "gr")).toEqual({ ok: true, value: { kind: "prefix", lower: "gr", upper: "gs" } });
    expect(buildRange("equals", "7")).toEqual({ ok: true, value: { kind: "equals", key: 7 } });
    expect(buildRange("equals", "").ok).toBe(false);
  });
});

describe("paging", () => {
  it("labels and moves pages", () => {
    expect(pageLabel(0, 25, 120)).toBe("1–25 of 120");
    expect(pageLabel(100, 20, 120)).toBe("101–120 of 120");
    expect(pageLabel(0, 0, 0)).toBe("No records");
    expect(pageLabel(50, 0, 10)).toBe("None past 50 of 10");
    expect(pageOffsets(0, 25, 120)).toEqual({ prev: null, next: 25 });
    expect(pageOffsets(25, 25, 120)).toEqual({ prev: 0, next: 50 });
    expect(pageOffsets(100, 25, 120)).toEqual({ prev: 75, next: null });
    expect(pageOffsets(10, 25, 120)).toEqual({ prev: 0, next: 35 });
  });
});

describe("Cache Storage helpers", () => {
  it("picks how to show a body", () => {
    expect(bodyKind("application/json; charset=utf-8")).toBe("json");
    expect(bodyKind("application/ld+json")).toBe("json");
    expect(bodyKind("image/png")).toBe("image");
    expect(bodyKind("image/svg+xml")).toBe("text");
    expect(bodyKind("text/html")).toBe("text");
    expect(bodyKind("application/javascript")).toBe("text");
    expect(bodyKind("font/woff2")).toBe("binary");
    expect(bodyKind("")).toBe("binary");
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBody("{")).toBeNull();
  });

  it("shortens same-origin URLs", () => {
    expect(shortUrl("https://a.test/api/x?y=1", "https://a.test")).toBe("/api/x?y=1");
    expect(shortUrl("https://cdn.test/x.js", "https://a.test")).toBe("https://cdn.test/x.js");
    expect(shortUrl("not a url", null)).toBe("not a url");
  });
});

describe("exports", () => {
  const store: IdbStoreInfo = {
    name: "users",
    keyPath: "id",
    autoIncrement: true,
    count: 2,
    indexes: [{ name: "by_email", keyPath: "email", unique: true, multiEntry: false }],
  };

  it("names files safely", () => {
    expect(exportFileName("indexeddb", "my db", "users/v2")).toBe("indexeddb-my-db-users-v2.json");
    expect(exportFileName("cache", "///")).toBe("cache-export.json");
  });

  it("exports a store with its schema and says when it is partial", () => {
    const json = JSON.parse(
      storeExport(
        { origin: "https://a.test", database: "shop", version: 3, store, exportedAt: "2026-01-01T00:00:00.000Z" },
        [{ key: 1, primaryKey: 1, value: { id: 1 } }],
        2,
      ),
    );
    expect(json).toMatchObject({
      format: "devkit-indexeddb",
      database: { name: "shop", version: 3 },
      store: { name: "users", keyPath: "id", autoIncrement: true, indexes: [{ name: "by_email" }] },
      count: 2,
      truncated: "first 1 of 2 records",
      records: [{ key: 1, value: { id: 1 } }],
    });
  });

  it("exports a cache with headers and bodies", () => {
    const json = JSON.parse(
      cacheExport(
        { origin: "https://a.test", cache: "v1", exportedAt: "2026-01-01T00:00:00.000Z" },
        [
          {
            method: "GET",
            url: "https://a.test/a.json",
            status: 200,
            statusText: "OK",
            type: "basic",
            contentType: "application/json",
            size: 2,
            headers: [["content-type", "application/json"]],
            body: { kind: "text", text: "{}", truncated: false },
          },
          {
            method: "GET",
            url: "https://cdn.test/x",
            status: 0,
            statusText: "",
            type: "opaque",
            contentType: "",
            size: null,
            headers: [],
            body: { kind: "none", reason: "Opaque" },
          },
        ],
        2,
      ),
    );
    expect(json.format).toBe("devkit-cache-storage");
    expect(json.truncated).toBeUndefined();
    expect(json.entries[0]).toMatchObject({ url: "https://a.test/a.json", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.entries[1]).toMatchObject({ body: null, bodyNote: "Opaque" });
  });
});
