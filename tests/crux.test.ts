import { describe, expect, it } from "vitest";
import { cruxMarkdown } from "../src/lib/agent/crux";
import { perfMarkdown } from "../src/lib/agent/inspect";
import {
  CRUX_CACHE_MS,
  CRUX_TEST_REQUEST,
  type CruxCache,
  CruxError,
  cruxCacheKey,
  cruxDate,
  cruxError,
  cruxFetch,
  cruxIneligible,
  cruxNumber,
  cruxRequest,
  cruxTarget,
  cruxTrend,
  type FetchLike,
  formatPeriod,
  labVsField,
  loadCrux,
  parseCruxHistory,
  parseCruxRecord,
  sparkline,
  testCruxKey,
} from "../src/lib/crux";
import type { PerfSnapshot } from "../src/lib/page/collect";

// Response shapes written by hand from the public API reference (developer.chrome.com/docs/crux/api and /history-api).
const bins = (good: number, poor: number, d: [number, number, number], str = false) => [
  { start: str ? "0.00" : 0, end: str ? good.toFixed(2) : good, density: d[0] },
  { start: str ? good.toFixed(2) : good, end: str ? poor.toFixed(2) : poor, density: d[1] },
  { start: str ? poor.toFixed(2) : poor, density: d[2] },
];
const RECORD = {
  record: {
    key: { formFactor: "PHONE", url: "https://ex.com/shop" },
    metrics: {
      largest_contentful_paint: { histogram: bins(2500, 4000, [0.7812, 0.1453, 0.0735]), percentiles: { p75: 2380 } },
      interaction_to_next_paint: { histogram: bins(200, 500, [0.61, 0.27, 0.12]), percentiles: { p75: 312 } },
      cumulative_layout_shift: { histogram: bins(0.1, 0.25, [0.9, 0.06, 0.04], true), percentiles: { p75: "0.05" } },
      first_contentful_paint: { histogram: bins(1800, 3000, [0.55, 0.3, 0.15]), percentiles: { p75: 2100 } },
      experimental_time_to_first_byte: { histogram: bins(800, 1800, [0.4, 0.4, 0.2]), percentiles: { p75: 1900 } },
      round_trip_time: { percentiles: { p75: 145 } },
    },
    collectionPeriod: { firstDate: { year: 2026, month: 10, day: 19 }, lastDate: { year: 2026, month: 11, day: 15 } },
  },
  urlNormalizationDetails: { originalUrl: "https://ex.com/shop#top", normalizedUrl: "https://ex.com/shop" },
};
const ORIGIN_RECORD = {
  record: {
    key: { origin: "https://ex.com" },
    metrics: { largest_contentful_paint: { histogram: bins(2500, 4000, [0.8, 0.15, 0.05]), percentiles: { p75: 2000 } } },
    collectionPeriod: { firstDate: { year: 2025, month: 12, day: 7 }, lastDate: { year: 2026, month: 1, day: 3 } },
  },
};
const period = (m: number, d: number) => ({ firstDate: { year: 2026, month: m, day: d }, lastDate: { year: 2026, month: m + 1, day: d } });
const HISTORY = {
  record: {
    key: { formFactor: "PHONE", url: "https://ex.com/shop" },
    metrics: {
      largest_contentful_paint: {
        histogramTimeseries: [
          { start: 0, end: 2500, densities: [0.7, "NaN", 0.78] },
          { start: 2500, end: 4000, densities: [0.2, "NaN", 0.15] },
          { start: 4000, densities: [0.1, "NaN", 0.07] },
        ],
        percentilesTimeseries: { p75s: [2900, null, 2380] },
      },
      cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.12", "0.08", "0.05"] } },
      interaction_to_next_paint: { percentilesTimeseries: { p75s: [null, null, null] } },
    },
    collectionPeriods: [period(8, 3), period(8, 10), period(8, 17)],
  },
};
const NOT_FOUND = { error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } };
const INVALID_KEY = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
  },
};
const QUOTA = { error: { code: 429, message: "Quota exceeded for quota metric 'Queries'", status: "RESOURCE_EXHAUSTED" } };
const DENIED = {
  error: {
    code: 403,
    message: "Chrome UX Report API has not been used in project 123 before or it is disabled.",
    status: "PERMISSION_DENIED",
    details: [{ reason: "SERVICE_DISABLED" }],
  },
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
/** A fake fetch answering by endpoint and scope, recording every call. */
function fakeFetch(answer: (call: Call) => [number, unknown]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, headers: init.headers, body: JSON.parse(init.body) };
      calls.push(call);
      const [status, body] = answer(call);
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    },
  };
}
const memoryCache = (): CruxCache & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
};

describe("CrUX requests", () => {
  it("asks for the URL without its fragment, or for the origin", () => {
    expect(cruxTarget("https://ex.com/shop?a=1#top", "url")).toBe("https://ex.com/shop?a=1");
    expect(cruxTarget("https://ex.com/shop?a=1#top", "origin")).toBe("https://ex.com");
  });

  it("builds record and history bodies per form factor, the key never in the URL", () => {
    const r = cruxRequest("https://ex.com/shop", "url", "PHONE", "record");
    expect(r.endpoint).toBe("https://chromeuxreport.googleapis.com/v1/records:queryRecord");
    expect(r.body).toEqual({
      url: "https://ex.com/shop",
      formFactor: "PHONE",
      metrics: [
        "largest_contentful_paint",
        "interaction_to_next_paint",
        "cumulative_layout_shift",
        "first_contentful_paint",
        "experimental_time_to_first_byte",
        "round_trip_time",
      ],
    });
    const h = cruxRequest("https://ex.com/shop", "origin", "ALL", "history");
    expect(h.endpoint).toMatch(/:queryHistoryRecord$/);
    expect(h.body.origin).toBe("https://ex.com");
    expect(h.body).not.toHaveProperty("formFactor");
    expect(h.body.collectionPeriodCount).toBe(25);
    expect(r.endpoint).not.toContain("key=");
  });

  it("keys the cache by kind, scope, form factor and target", () => {
    const a = cruxCacheKey(cruxRequest("https://ex.com/a", "url", "PHONE", "record"));
    expect(a).toBe("devkit-crux:record:url:PHONE:https://ex.com/a");
    expect(cruxCacheKey(cruxRequest("https://ex.com/a", "url", "DESKTOP", "record"))).not.toBe(a);
    expect(cruxCacheKey(cruxRequest("https://ex.com/b", "origin", "PHONE", "record"))).toBe(
      "devkit-crux:record:origin:PHONE:https://ex.com",
    );
  });

  it("never sends local, private or non-web addresses", () => {
    for (const u of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://192.168.1.4/",
      "http://10.0.0.2/",
      "https://app.local/",
      "http://intranet/",
    ])
      expect(cruxIneligible(u), u).toMatch(/public sites/);
    expect(cruxIneligible("chrome://extensions/")).toMatch(/web pages only/);
    expect(cruxIneligible("not a url")).toBe("No page open.");
    expect(cruxIneligible("https://www.ex.com/page")).toBeNull();
  });
});

describe("CrUX parsing", () => {
  it("reads numbers, CLS strings and missing values", () => {
    expect(cruxNumber(2380)).toBe(2380);
    expect(cruxNumber("0.05")).toBe(0.05);
    expect(cruxNumber("NaN")).toBeNull();
    expect(cruxNumber(null)).toBeNull();
    expect(cruxNumber(undefined)).toBeNull();
    expect(cruxDate({ year: 2026, month: 3, day: 7 })).toBe("2026-03-07");
    expect(cruxDate({ year: 2026 })).toBeNull();
  });

  it("parses p75, ratings, distributions, RTT and the collection period", () => {
    const r = parseCruxRecord(RECORD);
    expect(r).toMatchObject({ scope: "url", formFactor: "PHONE", target: "https://ex.com/shop", rtt: 145 });
    expect(r.period).toEqual({ first: "2026-10-19", last: "2026-11-15" });
    const by = Object.fromEntries(r.metrics.map((m) => [m.name, m]));
    expect(by.lcp).toEqual({ name: "lcp", p75: 2380, rating: "good", distribution: { good: 0.7812, ni: 0.1453, poor: 0.0735 } });
    expect(by.inp!.rating).toBe("needs-improvement");
    expect(by.cls).toMatchObject({ p75: 0.05, rating: "good", distribution: { good: 0.9, ni: 0.06, poor: 0.04 } });
    expect(by.ttfb!.rating).toBe("poor");
    expect(r.metrics.map((m) => m.name)).toEqual(["lcp", "inp", "cls", "fcp", "ttfb"]);
  });

  it("keeps only the metrics the record has, and reads an origin record for all devices", () => {
    const r = parseCruxRecord(ORIGIN_RECORD);
    expect(r).toMatchObject({ scope: "origin", formFactor: "ALL", target: "https://ex.com", rtt: null });
    expect(r.metrics.map((m) => m.name)).toEqual(["lcp"]);
    expect(formatPeriod(r.period)).toBe("Dec 7, 2025 – Jan 3, 2026");
    expect(formatPeriod(parseCruxRecord(RECORD).period)).toBe("Oct 19 – Nov 15, 2026");
    expect(() => parseCruxRecord({})).toThrow(CruxError);
  });

  it("parses the history: one p75 per window, gaps as null, empty series dropped", () => {
    const h = parseCruxHistory(HISTORY);
    expect(h.periods).toEqual(["2026-09-03", "2026-09-10", "2026-09-17"]);
    expect(h.series.lcp).toEqual([2900, null, 2380]);
    expect(h.series.cls).toEqual([0.12, 0.08, 0.05]);
    expect(h.series).not.toHaveProperty("inp");
    expect(cruxTrend(h.series.lcp!)).toEqual({ from: 2900, to: 2380, change: (2380 - 2900) / 2900 });
    expect(cruxTrend([null, 5])).toBeNull();
  });

  it("draws sparkline runs that break at gaps, higher values up", () => {
    const runs = sparkline([10, null, 30, 20], 100, 20, 0);
    expect(runs).toEqual([
      [{ x: 0, y: 20 }],
      [
        { x: 66.67, y: 0 },
        { x: 100, y: 10 },
      ],
    ]);
    expect(sparkline([null, null], 100, 20)).toEqual([]);
    expect(sparkline([5, 5], 100, 20, 0)).toEqual([
      [
        { x: 0, y: 10 },
        { x: 100, y: 10 },
      ],
    ]);
  });

  it("compares the tab's lab value with the field p75", () => {
    expect(labVsField("lcp", 1200, 2300)).toMatch(/^same rating/);
    expect(labVsField("lcp", 1200, 3000)).toMatch(/^better than the field/);
    expect(labVsField("inp", 600, 150)).toMatch(/^worse than the field/);
    expect(labVsField("lcp", null, 3000)).toBeNull();
    expect(labVsField("lcp", 1000, null)).toBeNull();
  });
});

describe("CrUX errors", () => {
  it("turns API errors into actionable messages", () => {
    expect(cruxError(404, NOT_FOUND, "url")).toMatchObject({
      kind: "not-found",
      message: expect.stringMatching(/^No field data for this URL/),
    });
    expect(cruxError(404, NOT_FOUND, "origin").message).toMatch(/^No field data for this origin/);
    expect(cruxError(400, INVALID_KEY).kind).toBe("invalid-key");
    expect(cruxError(429, QUOTA)).toMatchObject({ kind: "quota", message: expect.stringContaining("150 queries a minute") });
    expect(cruxError(403, DENIED)).toMatchObject({ kind: "denied", message: expect.stringContaining("enable the Chrome UX Report API") });
    expect(cruxError(500, { error: { message: "Backend error" } }).message).toBe("The CrUX API answered 500: Backend error.");
  });

  it("masks the key if an error message ever echoes it", () => {
    const e = cruxError(400, { error: { message: "Bad request for AIzaSECRET" } }, "url", "AIzaSECRET");
    expect(e.message).not.toContain("AIzaSECRET");
    expect(e.message).toContain("•••");
  });
});

describe("CrUX loading", () => {
  const url = "https://ex.com/shop#top";

  it("sends the key in a header, caches answers for a day", async () => {
    const { fetch, calls } = fakeFetch(() => [200, RECORD]);
    const cache = memoryCache();
    const req = cruxRequest(url, "url", "PHONE", "record");
    await cruxFetch(req, "AIzaKEY", fetch, cache, 1000);
    expect(calls[0]!.headers["X-Goog-Api-Key"]).toBe("AIzaKEY");
    expect(calls[0]!.url).not.toContain("AIzaKEY");
    await cruxFetch(req, "AIzaKEY", fetch, cache, 1000 + CRUX_CACHE_MS - 1);
    expect(calls).toHaveLength(1);
    await cruxFetch(req, "AIzaKEY", fetch, cache, 1000 + CRUX_CACHE_MS);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify([...cache.map.values()])).not.toContain("AIzaKEY");
  });

  it("does not cache key or quota errors", async () => {
    const { fetch, calls } = fakeFetch(() => [429, QUOTA]);
    const cache = memoryCache();
    const req = cruxRequest(url, "url", "PHONE", "record");
    await expect(cruxFetch(req, "k", fetch, cache)).rejects.toMatchObject({ kind: "quota" });
    await expect(cruxFetch(req, "k", fetch, cache)).rejects.toMatchObject({ kind: "quota" });
    expect(calls).toHaveLength(2);
    expect(cache.map.size).toBe(0);
  });

  it("reports a network failure", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(cruxFetch(cruxRequest(url, "url", "ALL", "record"), "k", fetch)).rejects.toMatchObject({ kind: "network" });
  });

  it("loads the record and its history", async () => {
    const { fetch, calls } = fakeFetch((c) => [200, c.url.endsWith("queryHistoryRecord") ? HISTORY : RECORD]);
    const r = await loadCrux(url, "url", "PHONE", "k", fetch);
    expect(r.fellBack).toBe(false);
    expect(r.record.metrics).toHaveLength(5);
    expect(r.history?.series.lcp).toEqual([2900, null, 2380]);
    expect(calls.map((c) => c.body.url)).toEqual(["https://ex.com/shop", "https://ex.com/shop"]);
  });

  it("falls back to the origin when the URL has no data", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.body.url) return [404, NOT_FOUND];
      return [200, c.url.endsWith("queryHistoryRecord") ? HISTORY : ORIGIN_RECORD];
    });
    const r = await loadCrux(url, "url", "ALL", "k", fetch);
    expect(r.fellBack).toBe(true);
    expect(r.record.scope).toBe("origin");
    expect(calls.map((c) => c.body.origin ?? c.body.url)).toEqual(["https://ex.com/shop", "https://ex.com", "https://ex.com"]);
  });

  it("keeps the record when only the history is missing, and fails when the origin has none either", async () => {
    const partial = fakeFetch((c) => (c.url.endsWith("queryHistoryRecord") ? [404, NOT_FOUND] : [200, RECORD]));
    expect((await loadCrux(url, "url", "PHONE", "k", partial.fetch)).history).toBeNull();
    const none = fakeFetch(() => [404, NOT_FOUND]);
    await expect(loadCrux(url, "url", "PHONE", "k", none.fetch)).rejects.toMatchObject({
      kind: "not-found",
      message: expect.stringMatching(/this origin/),
    });
  });

  it("tests a key: a 404 still proves it works, an invalid key does not", async () => {
    const ok = fakeFetch(() => [404, NOT_FOUND]);
    await expect(testCruxKey("k", ok.fetch)).resolves.toBeUndefined();
    expect(ok.calls[0]!.body).toEqual(CRUX_TEST_REQUEST.body);
    const bad = fakeFetch(() => [400, INVALID_KEY]);
    await expect(testCruxKey("k", bad.fetch)).rejects.toMatchObject({ kind: "invalid-key" });
  });
});

describe("CrUX in the Performance report for agents", () => {
  const perf: PerfSnapshot = {
    lcp: 1200,
    cls: 0.01,
    inp: null,
    fcp: 800,
    longTasks: { count: 0, total: 0 },
    navigation: null,
    resources: [],
  } as unknown as PerfSnapshot;

  it("lists the p75 of each vital with its rating and distribution", () => {
    const md = cruxMarkdown({ record: parseCruxRecord(RECORD), history: null, fellBack: false });
    expect(md).toContain("(phone), for the URL https://ex.com/shop, Oct 19 – Nov 15, 2026.");
    expect(md).toContain("- LCP p75 2.38 s (good): 78% good, 15% needs improvement, 7% poor");
    expect(md).toContain("- CLS p75 0.050 (good)");
    expect(md).toContain("- TTFB p75 1.9 s (poor)");
    expect(md).toContain("- Round trip time p75 145 ms");
    const fell = cruxMarkdown({ record: parseCruxRecord(ORIGIN_RECORD), history: null, fellBack: true });
    expect(fell).toContain("The URL itself has no field data: these are the origin's.");
  });

  it("goes into the Performance report only when loaded", () => {
    const field = cruxMarkdown({ record: parseCruxRecord(RECORD), history: null, fellBack: false });
    expect(perfMarkdown(perf, { url: "https://ex.com/shop", field })).toContain("### Field data (CrUX)\n\n75th percentile");
    expect(perfMarkdown(perf, { url: "https://ex.com/shop" })).not.toContain("Field data (CrUX)\n");
  });
});
