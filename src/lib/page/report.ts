// Bug report collectors, injected with runInTab: each must stand alone (no outer scope).
import type { EnvSnapshot, RequestsSnapshot } from "../bug-report";

/** Where and how the page runs: viewport, browser, preferences. */
export async function collectEnvironment(): Promise<EnvSnapshot> {
  type UAData = {
    brands?: { brand: string; version: string }[];
    mobile?: boolean;
    platform?: string;
    getHighEntropyValues?: (hints: string[]) => Promise<{
      fullVersionList?: { brand: string; version: string }[];
      platform?: string;
      platformVersion?: string;
    }>;
  };
  const ua = (navigator as unknown as { userAgentData?: UAData }).userAgentData;
  let high: Awaited<ReturnType<NonNullable<UAData["getHighEntropyValues"]>>> | undefined;
  try {
    high = await ua?.getHighEntropyValues?.(["fullVersionList", "platformVersion"]);
  } catch {
    high = undefined;
  }
  const brands = (high?.fullVersionList ?? ua?.brands ?? []).filter((b) => !/Not.?A.?Brand/i.test(b.brand));
  const nav = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
  const conn = (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  return {
    url: location.href,
    title: document.title,
    time: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: Math.round(window.devicePixelRatio * 100) / 100,
    screen: { width: screen.width, height: screen.height },
    userAgent: navigator.userAgent,
    brands: brands.length ? brands : undefined,
    platform: high?.platform ?? ua?.platform,
    platformVersion: high?.platformVersion,
    mobile: ua?.mobile,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    language: navigator.language,
    languages: [...(navigator.languages ?? [])],
    online: navigator.onLine,
    connection: conn?.effectiveType ? `${conn.effectiveType}${conn.saveData ? ", data saver" : ""}` : undefined,
    documentStatus: nav?.responseStatus || undefined,
  };
}

/** Every request Resource Timing knows of, with its status (Chrome 109+), plus the document itself. */
export function collectRequests(): RequestsSnapshot {
  type Timing = PerformanceResourceTiming & { responseStatus?: number };
  const resources = performance.getEntriesByType("resource") as Timing[];
  const nav = performance.getEntriesByType("navigation")[0] as Timing | undefined;
  const statusSupported = typeof PerformanceResourceTiming !== "undefined" && "responseStatus" in PerformanceResourceTiming.prototype;
  const entries = [...(nav ? [nav] : []), ...resources].map((r) => ({
    name: r.name,
    type: r.entryType === "navigation" ? "document" : r.initiatorType,
    status: r.responseStatus ?? 0,
    duration: Math.round(r.duration),
    transfer: r.transferSize,
    startTime: Math.round(r.startTime),
  }));
  return { origin: location.origin, entries, statusSupported, bufferFull: resources.length >= 250 };
}

/** The page's visible text, capped. */
export function collectTextExcerpt(max: number): { text: string; total: number } {
  // biome-ignore lint/performance/useDomNodeTextContent: innerText skips hidden text and keeps line breaks
  const raw = (document.body?.innerText ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: raw.length > max ? `${raw.slice(0, max)}…` : raw, total: raw.length };
}
