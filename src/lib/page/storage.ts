// What the page's origin keeps on the device. Injected with runInTab (ISOLATED world: content scripts share the
// page origin's storage). Each function must stand alone: no outer scope.

export interface KeySize {
  key: string;
  bytes: number;
}

export interface WebStorageUsage {
  count: number;
  bytes: number;
  top: KeySize[];
}

export interface IdbUsage {
  name: string;
  version: number | null;
  stores: { name: string; count: number | null }[];
  error?: string;
}

export interface CacheUsage {
  name: string;
  entries: number;
  /** Bytes of the entries that were measured (Content-Length, else the body). */
  bytes: number;
  measured: number;
  /** Cross-origin (opaque) responses: their size is hidden, and Chrome pads them in the quota. */
  opaque: number;
}

export interface StorageSnapshot {
  origin: string;
  estimate: { usage: number; quota: number; details: Record<string, number> } | null;
  persisted: boolean | null;
  local: WebStorageUsage | null;
  session: WebStorageUsage | null;
  /** Null when the browser cannot list databases. */
  idb: IdbUsage[] | null;
  caches: CacheUsage[] | null;
  opfs: { files: number; bytes: number; top: KeySize[] } | null;
  serviceWorkers: { scope: string; script: string; state: string }[] | null;
  /** Cookies readable by the page (HttpOnly ones are not). */
  documentCookies: { count: number; bytes: number };
  errors: string[];
}

export async function collectStorageUsage(): Promise<StorageSnapshot> {
  const errors: string[] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T> | T): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const within = <T>(ms: number, p: Promise<T>, what: string) =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s`)), ms))]);
  // Web Storage counts UTF-16 code units, 2 bytes each, for keys and values.
  const webStorage = (s: Storage): WebStorageUsage => {
    const sizes: KeySize[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i) ?? "";
      sizes.push({ key, bytes: (key.length + (s.getItem(key) ?? "").length) * 2 });
    }
    sizes.sort((a, b) => b.bytes - a.bytes);
    return { count: sizes.length, bytes: sizes.reduce((n, k) => n + k.bytes, 0), top: sizes.slice(0, 8) };
  };

  const estimate = await attempt("storage estimate", async () => {
    const e = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: Record<string, number> };
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, details: { ...(e.usageDetails ?? {}) } };
  });
  const persisted = await attempt("persisted", () => navigator.storage.persisted());
  const local = await attempt("localStorage", () => webStorage(localStorage));
  const session = await attempt("sessionStorage", () => webStorage(sessionStorage));

  const idb = await attempt("IndexedDB", async () => {
    if (typeof indexedDB.databases !== "function") return null;
    const list = await indexedDB.databases();
    const out: IdbUsage[] = [];
    for (const info of list.slice(0, 30)) {
      const name = info.name ?? "";
      const entry: IdbUsage = { name, version: info.version ?? null, stores: [] };
      try {
        const db = await within(
          3000,
          new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(name);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error("blocked by an open connection"));
            // Listed databases exist: an upgrade here would mean it vanished meanwhile. Don't create it.
            req.onupgradeneeded = () => {
              req.transaction?.abort();
              reject(new Error("no longer exists"));
            };
          }),
          `opening ${name}`,
        );
        const names = Array.from(db.objectStoreNames);
        if (names.length) {
          const tx = db.transaction(names, "readonly");
          entry.stores = await Promise.all(
            names.map(
              (store) =>
                new Promise<{ name: string; count: number | null }>((resolve) => {
                  const req = tx.objectStore(store).count();
                  req.onsuccess = () => resolve({ name: store, count: req.result });
                  req.onerror = () => resolve({ name: store, count: null });
                }),
            ),
          );
        }
        db.close();
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
      }
      out.push(entry);
    }
    return out;
  });

  const cacheUsage = await attempt("Cache Storage", async () => {
    if (typeof caches === "undefined") return null;
    const names = await caches.keys();
    let budget = 2000;
    const out: CacheUsage[] = [];
    for (const name of names.slice(0, 50)) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      const usage: CacheUsage = { name, entries: requests.length, bytes: 0, measured: 0, opaque: 0 };
      for (const request of requests) {
        if (budget-- <= 0) break;
        const res = await cache.match(request);
        if (!res) continue;
        if (res.type === "opaque") {
          usage.opaque++;
          continue;
        }
        const length = Number(res.headers.get("content-length"));
        usage.bytes += Number.isFinite(length) && length > 0 ? length : (await res.blob()).size;
        usage.measured++;
      }
      out.push(usage);
    }
    return out;
  });

  const opfs = await attempt("origin private file system", async () => {
    if (typeof navigator.storage.getDirectory !== "function") return null;
    const root = await navigator.storage.getDirectory();
    const files: KeySize[] = [];
    type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
    const walk = async (dir: Dir, prefix: string, depth: number) => {
      for await (const [name, handle] of dir.entries()) {
        if (files.length >= 2000) return;
        if (handle.kind === "file") files.push({ key: prefix + name, bytes: (await (handle as FileSystemFileHandle).getFile()).size });
        else if (depth < 6) await walk(handle as Dir, `${prefix}${name}/`, depth + 1);
      }
    };
    await walk(root as Dir, "", 0);
    files.sort((a, b) => b.bytes - a.bytes);
    return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), top: files.slice(0, 8) };
  });

  const serviceWorkers = await attempt("service workers", async () => {
    if (!("serviceWorker" in navigator)) return null;
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.map((r) => {
      const worker = r.active ?? r.waiting ?? r.installing;
      return { scope: r.scope, script: worker?.scriptURL ?? "", state: worker?.state ?? "none" };
    });
  });

  const pairs = document.cookie ? document.cookie.split("; ") : [];
  return {
    origin: location.origin,
    estimate,
    persisted,
    local,
    session,
    idb,
    caches: cacheUsage,
    opfs,
    serviceWorkers,
    documentCookies: { count: pairs.length, bytes: pairs.reduce((n, c) => n + c.length, 0) },
    errors,
  };
}

export async function deleteCache(name: string): Promise<boolean> {
  return caches.delete(name);
}

export function deleteDatabase(name: string): Promise<string> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve("deleted");
    req.onerror = () => resolve(`error: ${req.error?.message ?? "unknown"}`);
    req.onblocked = () => resolve("blocked: close the tabs that use it, then retry");
  });
}
