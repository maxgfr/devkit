// Package descriptions and latest versions from the registries, for Repo dependencies. Runs in extension pages and
// the background (the in-page box asks the background). Only registries that allow any origin are read, so devkit
// needs no extra permission; answers are cached in storage.session for the browser session.
import { browser } from "wxt/browser";
import { type Dependency, type PackageInfo, packageKey, parseRegistry, registryUrl } from "./repo-deps";

export const INFO_CACHE_PREFIX = "pkginfo:";
/** At most this many packages are looked up per list, this many at a time. */
export const INFO_LIMIT = 200;
export const INFO_CONCURRENCY = 6;

type Wanted = Pick<Dependency, "name" | "ecosystem" | "source">;

/** Runs `task` over `items`, `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchOne(dep: Wanted, fetcher: typeof fetch): Promise<PackageInfo | null> {
  const url = registryUrl(dep);
  if (!url) return null;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, credentials: "omit" });
    if (res.status === 404) return { missing: true };
    if (!res.ok) return null;
    return parseRegistry(dep.ecosystem, await res.json());
  } catch {
    // Offline, blocked or not JSON: no description, the links still work.
    return null;
  }
}

/**
 * Description and latest version of each package (keyed by `packageKey`), from the cache or the registry. Calls
 * `onUpdate` with everything known so far as answers arrive. Packages past `INFO_LIMIT` are left out.
 */
export async function loadPackageInfo(
  deps: Wanted[],
  onUpdate?: (info: Record<string, PackageInfo>) => void,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, PackageInfo>> {
  const unique = new Map<string, Wanted>();
  for (const d of deps) if (registryUrl(d) && !unique.has(packageKey(d))) unique.set(packageKey(d), d);
  const wanted = [...unique.entries()].slice(0, INFO_LIMIT);
  const info: Record<string, PackageInfo> = {};
  if (!wanted.length) return info;
  const cached = await browser.storage.session.get(wanted.map(([k]) => INFO_CACHE_PREFIX + k)).catch(() => ({}) as Record<string, unknown>);
  const todo: [string, Wanted][] = [];
  for (const [k, d] of wanted) {
    const hit = (cached as Record<string, PackageInfo | undefined>)[INFO_CACHE_PREFIX + k];
    if (hit) info[k] = hit;
    else todo.push([k, d]);
  }
  if (Object.keys(info).length) onUpdate?.({ ...info });
  let pending: Record<string, PackageInfo> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (Object.keys(pending).length) browser.storage.session.set(prefixed(pending)).catch(() => undefined);
    pending = {};
    onUpdate?.({ ...info });
  };
  await mapLimit(todo, INFO_CONCURRENCY, async ([k, d]) => {
    const got = await fetchOne(d, fetcher);
    if (!got) return;
    info[k] = got;
    pending[k] = got;
    timer ??= setTimeout(flush, 150);
  });
  if (timer) clearTimeout(timer);
  flush();
  return info;
}

const prefixed = (info: Record<string, PackageInfo>) =>
  Object.fromEntries(Object.entries(info).map(([k, v]) => [INFO_CACHE_PREFIX + k, v] as const));

/** Message the in-page box sends to the background to get package info. */
export interface PackageInfoMessage {
  type: "devkit:package-info";
  deps: Wanted[];
}
