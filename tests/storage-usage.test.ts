import { describe, expect, it } from "vitest";
import type { StorageSnapshot } from "../src/lib/page/storage";
import { formatBytes, quotaShare, storageMarkdown, usageBreakdown } from "../src/lib/storage-usage";

describe("formatBytes", () => {
  it("reads like Chrome's settings", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(34 * 1024 * 1024)).toBe("34.0 MB");
    expect(formatBytes(120 * 1024 ** 3)).toBe("120 GB");
    expect(formatBytes(null)).toBe("–");
  });
});

describe("quotaShare", () => {
  it("stays honest for tiny shares", () => {
    expect(quotaShare(0, 100)).toBe("0% of the quota");
    expect(quotaShare(1, 1e9)).toBe("<0.01% of the quota");
    expect(quotaShare(5, 1000)).toBe("0.50% of the quota");
    expect(quotaShare(50, 100)).toBe("50% of the quota");
    expect(quotaShare(5, 0)).toBe("quota unknown");
  });
});

describe("usageBreakdown", () => {
  it("splits the estimate by kind, largest first, and puts the unexplained rest in other", () => {
    const parts = usageBreakdown({ usage: 1000, quota: 1e9, details: { caches: 600, indexedDB: 300, mystery: 20 } });
    expect(parts.map((p) => [p.kind, p.bytes])).toEqual([
      ["caches", 600],
      ["indexedDB", 300],
      ["other", 100],
    ]);
  });
  it("returns nothing without an estimate", () => {
    expect(usageBreakdown(null)).toEqual([]);
  });
});

describe("storageMarkdown", () => {
  it("summarizes every store", () => {
    const s: StorageSnapshot = {
      origin: "https://app.example",
      estimate: { usage: 2048, quota: 1024 ** 3, details: { indexedDB: 2048 } },
      persisted: false,
      local: { count: 2, bytes: 40, top: [] },
      session: { count: 0, bytes: 0, top: [] },
      idb: [{ name: "app-db", version: 3, stores: [{ name: "items", count: 12 }] }],
      caches: [{ name: "v1", entries: 4, bytes: 4096, measured: 3, opaque: 1 }],
      opfs: { files: 0, bytes: 0, top: [] },
      serviceWorkers: [{ scope: "https://app.example/", script: "https://app.example/sw.js", state: "activated" }],
      documentCookies: { count: 1, bytes: 10 },
      errors: [],
    };
    const md = storageMarkdown(s, { count: 3, bytes: 90, httpOnly: 2 });
    expect(md).toContain("## Storage of https://app.example");
    expect(md).toContain("Used: 2.00 KB");
    expect(md).toContain("Persistent storage: no");
    expect(md).toContain("app-db v3: items (12)");
    expect(md).toContain("v1: 4 entries, 4.00 KB measured, 1 opaque");
    expect(md).toContain("Cookies: 3 (90 B), 2 HttpOnly");
    expect(md).toContain("sw.js (scope https://app.example/, activated)");
    expect(md).not.toContain("OPFS");
  });
});
