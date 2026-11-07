import type { StorageSnapshot } from "./page/storage";

/** Bytes in the units a person reads: 1.2 KB, 34 MB, 120 GB (powers of 1024, like Chrome's own settings). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "–";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** Share of the quota in words that stay honest for tiny values. */
export function quotaShare(usage: number, quota: number): string {
  if (!quota) return "quota unknown";
  const share = usage / quota;
  if (usage === 0) return "0% of the quota";
  if (share < 0.0001) return "<0.01% of the quota";
  if (share < 0.01) return `${(share * 100).toFixed(2)}% of the quota`;
  return `${Math.round(share * 100)}% of the quota`;
}

export type UsageKind = "indexedDB" | "caches" | "serviceWorkerRegistrations" | "fileSystem" | "other";

export const USAGE_LABELS: Record<UsageKind, string> = {
  indexedDB: "IndexedDB",
  caches: "Cache Storage",
  serviceWorkerRegistrations: "Service workers",
  fileSystem: "File system (OPFS)",
  other: "Other",
};

/**
 * navigator.storage.estimate()'s usage split by kind, largest first. Unknown detail keys and the part of the
 * usage the details do not explain are grouped under "other". Web Storage and cookies are not in the estimate.
 */
export function usageBreakdown(estimate: StorageSnapshot["estimate"]): { kind: UsageKind; label: string; bytes: number }[] {
  if (!estimate) return [];
  const sums = new Map<UsageKind, number>();
  let detailed = 0;
  for (const [key, value] of Object.entries(estimate.details)) {
    if (!value) continue;
    const kind: UsageKind = key in USAGE_LABELS ? (key as UsageKind) : "other";
    sums.set(kind, (sums.get(kind) ?? 0) + value);
    detailed += value;
  }
  const rest = estimate.usage - detailed;
  if (rest > 0) sums.set("other", (sums.get("other") ?? 0) + rest);
  return [...sums.entries()].map(([kind, bytes]) => ({ kind, label: USAGE_LABELS[kind], bytes })).sort((a, b) => b.bytes - a.bytes);
}

export interface CookieTotals {
  count: number;
  bytes: number;
  /** Cookies the page cannot read (HttpOnly), when the cookies permission let devkit see them. */
  httpOnly?: number;
}

/** A compact Markdown summary of what the origin stores, to paste into an issue or a coding agent. */
export function storageMarkdown(s: StorageSnapshot, cookies: CookieTotals): string {
  const lines = [`## Storage of ${s.origin}`, ""];
  if (s.estimate) {
    lines.push(
      `- Used: ${formatBytes(s.estimate.usage)} (${quotaShare(s.estimate.usage, s.estimate.quota)}, quota ${formatBytes(s.estimate.quota)})`,
    );
    for (const part of usageBreakdown(s.estimate)) lines.push(`  - ${part.label}: ${formatBytes(part.bytes)}`);
  }
  if (s.persisted !== null)
    lines.push(`- Persistent storage: ${s.persisted ? "yes" : "no (best effort: Chrome may evict it under storage pressure)"}`);
  if (s.local) lines.push(`- localStorage: ${s.local.count} keys, ${formatBytes(s.local.bytes)}`);
  if (s.session) lines.push(`- sessionStorage: ${s.session.count} keys, ${formatBytes(s.session.bytes)}`);
  lines.push(`- Cookies: ${cookies.count} (${formatBytes(cookies.bytes)})${cookies.httpOnly ? `, ${cookies.httpOnly} HttpOnly` : ""}`);
  if (s.idb?.length) {
    lines.push(`- IndexedDB: ${s.idb.length} database${s.idb.length > 1 ? "s" : ""}`);
    for (const db of s.idb) {
      const stores = db.stores.map((st) => `${st.name} (${st.count ?? "?"})`).join(", ");
      lines.push(`  - ${db.name}${db.version !== null ? ` v${db.version}` : ""}: ${db.error ? db.error : stores || "no object store"}`);
    }
  }
  if (s.caches?.length) {
    lines.push(`- Cache Storage: ${s.caches.length} cache${s.caches.length > 1 ? "s" : ""}`);
    for (const c of s.caches)
      lines.push(`  - ${c.name}: ${c.entries} entries, ${formatBytes(c.bytes)} measured${c.opaque ? `, ${c.opaque} opaque` : ""}`);
  }
  if (s.opfs?.files) lines.push(`- OPFS: ${s.opfs.files} files, ${formatBytes(s.opfs.bytes)}`);
  if (s.serviceWorkers?.length)
    for (const w of s.serviceWorkers) lines.push(`- Service worker: ${w.script} (scope ${w.scope}, ${w.state})`);
  return lines.join("\n");
}
