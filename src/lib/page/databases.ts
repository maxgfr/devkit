// IndexedDB and Cache Storage, read and written for the viewer panels. Injected with runInTab in the ISOLATED world:
// content scripts share the page origin's IndexedDB and Cache Storage, and the page's scripts cannot see devkit's
// globals there. Each exported function must stand alone: no outer scope, types only.
import type {
  CacheBody,
  CacheEntryDetail,
  CacheEntrySummary,
  CacheRequest,
  CacheSummary,
  CodecLimits,
  IdbDatabaseInfo,
  IdbListResult,
  IdbReadResult,
  IdbRecord,
  IdbRequest,
  IdbStoreInfo,
  Tagged,
} from "../databases";

export interface IdbCodec {
  v: number;
  /** A structured-clone value as tagged JSON, within `limits`. Async: Blob contents are read. */
  encode: (value: unknown, limits: CodecLimits) => Promise<Tagged>;
  /** Tagged JSON back to the value IndexedDB stores. Throws, with the path, on what cannot be written back. */
  revive: (value: Tagged) => unknown;
}

type CodecWindow = typeof globalThis & { __devkitIdbCodec?: IdbCodec };

/**
 * Installs the tagged JSON codec as `__devkitIdbCodec` in the isolated world, once per document and `version`.
 * The format is described in src/lib/databases.ts.
 */
export function installIdbCodec(version: number): boolean {
  const w = globalThis as CodecWindow;
  if (w.__devkitIdbCodec?.v === version) return true;
  const TAG = "$type";
  const TYPED = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "DataView",
  ];
  const ERRORS: Record<string, ErrorConstructor> = {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  };
  const toBase64 = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (b64: string): Uint8Array => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const own = (o: Record<string, unknown>, k: string, v: unknown) =>
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

  const encode = async (root: unknown, limits: CodecLimits): Promise<Tagged> => {
    let nodes = 0;
    const path = new Set<object>();
    const binary = (tag: string, bytes: Uint8Array): Tagged => {
      const cut = bytes.length > limits.binary;
      return {
        [TAG]: tag,
        byteLength: bytes.length,
        base64: toBase64(cut ? bytes.subarray(0, limits.binary) : bytes),
        ...(cut ? { truncated: true } : {}),
      };
    };
    const walk = async (v: unknown, depth: number): Promise<Tagged> => {
      if (++nodes > limits.nodes) return { [TAG]: "Truncated", reason: "nodes" };
      switch (typeof v) {
        case "string":
          return v.length > limits.string
            ? { [TAG]: "Truncated", reason: "string", length: v.length, preview: v.slice(0, limits.string) }
            : v;
        case "number":
          if (Number.isNaN(v)) return { [TAG]: "Number", value: "NaN" };
          if (!Number.isFinite(v)) return { [TAG]: "Number", value: v > 0 ? "Infinity" : "-Infinity" };
          return Object.is(v, -0) ? { [TAG]: "Number", value: "-0" } : v;
        case "boolean":
          return v;
        case "bigint":
          return { [TAG]: "BigInt", value: v.toString() };
        case "undefined":
          return { [TAG]: "undefined" };
        case "symbol":
        case "function":
          return { [TAG]: "Unsupported", kind: typeof v };
      }
      if (v === null) return null;
      const o = v as object;
      if (path.has(o)) return { [TAG]: "Truncated", reason: "cycle" };
      if (depth >= limits.depth) return { [TAG]: "Truncated", reason: "depth" };
      let kind = Object.prototype.toString.call(o).slice(8, -1);
      // Blobs without a toStringTag (some environments): known by their class.
      if (kind === "Object" && typeof Blob === "function" && o instanceof Blob)
        kind = typeof File === "function" && o instanceof File ? "File" : "Blob";
      path.add(o);
      try {
        if (Array.isArray(o)) {
          const out: Tagged[] = [];
          for (let i = 0; i < o.length; i++) out.push(await walk(o[i], depth + 1));
          return out;
        }
        if (ArrayBuffer.isView(o)) {
          const tag = TYPED.includes(kind) ? kind : "Uint8Array";
          return binary(tag, new Uint8Array(o.buffer, o.byteOffset, o.byteLength));
        }
        switch (kind) {
          case "Date": {
            const t = (o as Date).getTime();
            return { [TAG]: "Date", value: Number.isNaN(t) ? null : (o as Date).toISOString() };
          }
          case "RegExp":
            return { [TAG]: "RegExp", source: (o as RegExp).source, flags: (o as RegExp).flags };
          case "Map": {
            const entries: Tagged[] = [];
            for (const [k, val] of o as Map<unknown, unknown>) entries.push([await walk(k, depth + 1), await walk(val, depth + 1)]);
            return { [TAG]: "Map", entries };
          }
          case "Set": {
            const values: Tagged[] = [];
            for (const val of o as Set<unknown>) values.push(await walk(val, depth + 1));
            return { [TAG]: "Set", values };
          }
          case "ArrayBuffer":
            return binary("ArrayBuffer", new Uint8Array(o as ArrayBuffer));
          case "Blob":
          case "File": {
            const blob = o as Blob;
            const out: Record<string, Tagged> = { [TAG]: kind, mime: blob.type, size: blob.size };
            if (kind === "File") {
              out.name = (o as File).name;
              out.lastModified = (o as File).lastModified;
            }
            if (blob.size <= limits.binary) out.base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
            else out.truncated = true;
            return out;
          }
          case "Error": {
            const e = o as Error;
            return { [TAG]: "Error", name: e.name, message: e.message, ...(typeof e.stack === "string" ? { stack: e.stack } : {}) };
          }
          case "Boolean":
          case "Number":
          case "String":
            // Boxed primitives: kept as their primitive.
            return walk((o as { valueOf(): unknown }).valueOf(), depth);
          case "Object": {
            const out: Record<string, Tagged> = {};
            for (const k of Object.keys(o)) own(out, k, await walk((o as Record<string, unknown>)[k], depth + 1));
            return TAG in out ? { [TAG]: "Object", value: out } : out;
          }
          default:
            return { [TAG]: "Unsupported", kind };
        }
      } finally {
        path.delete(o);
      }
    };
    return walk(root, 0);
  };

  const revive = (root: Tagged): unknown => {
    const walk = (v: Tagged, at: string): unknown => {
      if (v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
      const plain = (o: { [k: string]: Tagged }, base: string) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o)) own(out, k, walk(o[k]!, `${base}.${k}`));
        return out;
      };
      const tag = v[TAG];
      if (typeof tag !== "string") return plain(v, at);
      const fail = (why: string): never => {
        throw new Error(`${at}: ${why}`);
      };
      const bytes = () => {
        if (v.truncated === true) fail(`${tag} was too large to load, it cannot be written back`);
        if (typeof v.base64 !== "string") fail(`${tag} needs base64 content`);
        return fromBase64(v.base64 as string);
      };
      switch (tag) {
        case "undefined":
          return undefined;
        case "Number":
          return v.value === "-0" ? -0 : Number(v.value);
        case "BigInt":
          return BigInt(v.value as string);
        case "Date":
          return new Date(v.value === null ? Number.NaN : (v.value as string));
        case "RegExp":
          return new RegExp(v.source as string, (v.flags as string) ?? "");
        case "Map":
          return new Map(
            ((v.entries as Tagged[][]) ?? []).map((pair, i) => [
              walk(pair[0]!, `${at}.entries[${i}][0]`),
              walk(pair[1]!, `${at}.entries[${i}][1]`),
            ]),
          );
        case "Set":
          return new Set(((v.values as Tagged[]) ?? []).map((x, i) => walk(x, `${at}.values[${i}]`)));
        case "Object":
          return plain((v.value as { [k: string]: Tagged }) ?? {}, `${at}.value`);
        case "Error": {
          const name = typeof v.name === "string" ? v.name : "Error";
          const e = new (ERRORS[name] ?? Error)(String(v.message ?? ""));
          if (!ERRORS[name]) e.name = name;
          if (typeof v.stack === "string") e.stack = v.stack;
          return e;
        }
        case "Blob":
          return new Blob([bytes() as BlobPart], { type: String(v.mime ?? "") });
        case "File":
          return new File([bytes() as BlobPart], String(v.name ?? "file"), {
            type: String(v.mime ?? ""),
            lastModified: typeof v.lastModified === "number" ? v.lastModified : Date.now(),
          });
        case "ArrayBuffer":
          return bytes().buffer;
        case "Truncated":
          return fail(`cut by devkit (${v.reason ?? "size"}), it cannot be written back`);
        case "Unsupported":
          return fail(`${v.kind ?? "this value"} cannot be written back`);
        default: {
          if (!TYPED.includes(tag)) return fail(`unknown ${TAG} "${tag}"`);
          const buffer = bytes().buffer;
          if (tag === "DataView") return new DataView(buffer);
          const Ctor = (globalThis as unknown as Record<string, new (b: ArrayBufferLike) => unknown>)[tag];
          if (!Ctor) return fail(`${tag} is not available in this browser`);
          try {
            return new Ctor(buffer);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        }
      }
    };
    return walk(root, "$");
  };

  w.__devkitIdbCodec = { v: version, encode, revive };
  return true;
}

/**
 * Lists, reads and writes IndexedDB for the panel. Needs installIdbCodec first. Takes and answers JSON text: Chrome
 * hands script arguments and results over as sorted dictionaries, which would reorder the keys of every record.
 */
export async function idbOp(request: string): Promise<string> {
  const req = JSON.parse(request) as IdbRequest;
  const codec = (globalThis as CodecWindow).__devkitIdbCodec;
  if (!codec) throw new Error("devkit's IndexedDB reader is not loaded in this page: refresh the panel.");
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available on this page.");

  // Opens the current version without upgrading it. A listed database that triggers an upgrade has vanished:
  // abort so it is not created. devkit closes as soon as the page asks for a version change.
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        reject(new Error(`Opening ${name} did not answer in 4 s (an upgrade may be waiting on another tab).`));
      }, 4000);
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        clearTimeout(timer);
        const db = r.result;
        if (late) return db.close();
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => {
        clearTimeout(timer);
        reject(r.error ?? new Error(`Could not open ${name}.`));
      };
      r.onblocked = () => {
        clearTimeout(timer);
        reject(new Error(`${name} is blocked by another connection.`));
      };
      r.onupgradeneeded = () => {
        clearTimeout(timer);
        r.transaction?.abort();
        reject(new Error(`${name} no longer exists.`));
      };
    });
  const done = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const finished = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("The transaction was aborted."));
    });
  const withDb = async <T>(name: string, fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    const db = await open(name);
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  const storeInfo = (store: IDBObjectStore, count: number | null): IdbStoreInfo => ({
    name: store.name,
    keyPath: store.keyPath as string | string[] | null,
    autoIncrement: store.autoIncrement,
    count,
    indexes: Array.from(store.indexNames, (n) => {
      const index = store.index(n);
      return { name: n, keyPath: index.keyPath as string | string[], unique: index.unique, multiEntry: index.multiEntry };
    }),
  });

  const run = async (): Promise<IdbListResult | IdbReadResult | IdbRecord | { key: Tagged } | null> => {
    switch (req.op) {
      case "list": {
        const origin = location.origin;
        if (typeof indexedDB.databases !== "function") return { supported: false, origin, databases: [] };
        const list = (await indexedDB.databases()).slice(0, 100);
        const databases: IdbDatabaseInfo[] = [];
        for (const info of list) {
          const name = info.name ?? "";
          const entry: IdbDatabaseInfo = { name, version: info.version ?? null, stores: [] };
          try {
            await withDb(name, async (db) => {
              entry.version = db.version;
              const names = Array.from(db.objectStoreNames);
              if (!names.length) return;
              const tx = db.transaction(names, "readonly");
              entry.stores = await Promise.all(
                names.map(async (n) => {
                  const store = tx.objectStore(n);
                  // Metadata first: the store cannot be read once the transaction is over.
                  const info = storeInfo(store, null);
                  info.count = await done(store.count()).catch(() => null);
                  return info;
                }),
              );
            });
          } catch (e) {
            entry.error = e instanceof Error ? e.message : String(e);
          }
          databases.push(entry);
        }
        databases.sort((a, b) => a.name.localeCompare(b.name));
        return { supported: true, origin, databases };
      }
      case "read":
        return withDb(req.db, async (db) => {
          const tx = db.transaction(req.store, "readonly");
          const store = tx.objectStore(req.store);
          const source = req.index ? store.index(req.index) : store;
          const r = req.range;
          const range =
            r.kind === "equals"
              ? IDBKeyRange.only(codec.revive(r.key))
              : r.kind === "prefix"
                ? r.upper === null
                  ? IDBKeyRange.lowerBound(r.lower)
                  : IDBKeyRange.bound(r.lower, r.upper, false, true)
                : null;
          const total = await done(source.count(range ?? undefined));
          // Values are copied out inside the transaction; encoding (which may read Blobs) runs after it.
          const raw = await new Promise<{ key: unknown; primaryKey: unknown; value: unknown }[]>((resolve, reject) => {
            const out: { key: unknown; primaryKey: unknown; value: unknown }[] = [];
            let skipped = req.offset <= 0;
            const cursor = source.openCursor(range);
            cursor.onerror = () => reject(cursor.error);
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c || req.limit <= 0) return resolve(out);
              if (!skipped) {
                skipped = true;
                return c.advance(req.offset);
              }
              out.push({ key: c.key, primaryKey: c.primaryKey, value: c.value });
              if (out.length >= req.limit) return resolve(out);
              c.continue();
            };
          });
          const records: IdbRecord[] = [];
          for (const row of raw)
            records.push({
              key: await codec.encode(row.key, req.limits),
              primaryKey: await codec.encode(row.primaryKey, req.limits),
              value: await codec.encode(row.value, req.limits),
            });
          return { total, offset: req.offset, records };
        });
      case "get":
        return withDb(req.db, async (db) => {
          const key = codec.revive(req.key) as IDBValidKey;
          const store = db.transaction(req.store, "readonly").objectStore(req.store);
          const found = await new Promise<{ value: unknown } | null>((resolve, reject) => {
            const r = store.openCursor(IDBKeyRange.only(key));
            r.onsuccess = () => resolve(r.result ? { value: r.result.value } : null);
            r.onerror = () => reject(r.error);
          });
          if (!found) return null;
          return { key: req.key, primaryKey: req.key, value: await codec.encode(found.value, req.limits) };
        });
      case "put":
      case "add":
        return withDb(req.db, async (db) => {
          const value = codec.revive(req.value);
          const key = req.key === null ? undefined : (codec.revive(req.key) as IDBValidKey);
          const tx = db.transaction(req.store, "readwrite");
          const store = tx.objectStore(req.store);
          const write = req.op === "add" ? store.add.bind(store) : store.put.bind(store);
          // In-line keys come from the value: passing a key too is an error.
          const written = await done(store.keyPath === null && key !== undefined ? write(value, key) : write(value));
          await finished(tx);
          return { key: await codec.encode(written, { depth: 8, string: 10_000, binary: 65_536, nodes: 1000 }) };
        });
      case "delete":
      case "clear":
        return withDb(req.db, async (db) => {
          const tx = db.transaction(req.store, "readwrite");
          const store = tx.objectStore(req.store);
          if (req.op === "clear") store.clear();
          else store.delete(codec.revive(req.key) as IDBValidKey);
          await finished(tx);
          return null;
        });
    }
  };
  return JSON.stringify(await run());
}

/** Lists, reads and deletes Cache Storage entries for the panel. */
export async function cacheOp(
  req: CacheRequest,
): Promise<CacheSummary[] | { total: number; entries: CacheEntrySummary[] } | CacheEntryDetail | CacheEntryDetail[] | boolean> {
  if (typeof caches === "undefined") throw new Error("Cache Storage is not available on this page (it needs https or localhost).");
  const toBase64 = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // caches.open() creates a missing cache: check first, so a stale panel never brings one back.
  const openExisting = async (name: string) => {
    if (!(await caches.has(name))) throw new Error(`The cache ${name} no longer exists.`);
    return caches.open(name);
  };
  const summary = async (request: Request, res: Response | undefined, measure: boolean): Promise<CacheEntrySummary> => {
    const length = res?.headers.get("content-length");
    let size = length !== null && length !== undefined && Number.isFinite(Number(length)) ? Number(length) : null;
    if (size === null && res && measure && res.type !== "opaque") size = (await res.clone().blob()).size;
    return {
      method: request.method,
      url: request.url,
      status: res?.status ?? 0,
      type: res?.type ?? "missing",
      contentType: res?.headers.get("content-type") ?? "",
      size,
    };
  };
  const body = async (res: Response, textCap: number, imageCap: number): Promise<CacheBody> => {
    if (res.type === "opaque" || res.type === "opaqueredirect")
      return { kind: "none", reason: "Opaque response (cross-origin, no-cors): Chrome hides its status, headers and body." };
    const blob = await res.blob();
    const type = (res.headers.get("content-type") ?? blob.type).toLowerCase().split(";")[0]!.trim();
    if (!blob.size) return { kind: "none", reason: "Empty body." };
    if (type.startsWith("image/") && type !== "image/svg+xml") {
      if (blob.size > imageCap) return { kind: "none", reason: `Image of ${blob.size} bytes: too large to preview here.` };
      return { kind: "image", dataUrl: `data:${type};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}` };
    }
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, textCap)).arrayBuffer());
    const looksText =
      /^text\/|[/+](json|xml)$|javascript|ecmascript|svg|x-www-form-urlencoded|graphql|yaml|toml|csv/.test(type) ||
      (!type && !head.subarray(0, 1024).includes(0));
    if (!looksText) return { kind: "none", reason: `Binary body (${type || "no type"}, ${blob.size} bytes).` };
    return { kind: "text", text: new TextDecoder().decode(head), truncated: blob.size > textCap };
  };
  const detail = async (request: Request, res: Response, textCap: number, imageCap: number): Promise<CacheEntryDetail> => ({
    ...(await summary(request, res, true)),
    statusText: res.statusText,
    headers: Array.from(res.headers.entries()),
    body: await body(res, textCap, imageCap),
  });

  switch (req.op) {
    case "list": {
      const names = await caches.keys();
      return Promise.all(names.map(async (name) => ({ name, count: (await (await caches.open(name)).keys()).length })));
    }
    case "entries": {
      const cache = await openExisting(req.cache);
      const requests = await cache.keys();
      const entries: CacheEntrySummary[] = [];
      for (const [i, request] of requests.slice(0, req.limit).entries())
        entries.push(await summary(request, await cache.match(request), i < 300));
      return { total: requests.length, entries };
    }
    case "entry": {
      const cache = await openExisting(req.cache);
      const [request] = await cache.keys(req.url);
      const res = request ? await cache.match(request) : undefined;
      if (!request || !res) throw new Error(`${req.url} is no longer in ${req.cache}.`);
      return detail(request, res, req.textCap, req.imageCap);
    }
    case "delete-entry":
      return (await openExisting(req.cache)).delete(req.url);
    case "export": {
      const cache = await openExisting(req.cache);
      const out: CacheEntryDetail[] = [];
      for (const request of (await cache.keys()).slice(0, req.limit)) {
        const res = await cache.match(request);
        if (res) out.push(await detail(request, res, req.textCap, req.textCap));
      }
      return out;
    }
  }
}
