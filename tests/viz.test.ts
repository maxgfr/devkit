import { describe, expect, it } from "vitest";
import { securityReport } from "../src/lib/headers";
import type { PerfSnapshot } from "../src/lib/page/collect";
import {
  axisLabels,
  formatVital,
  GRADE_BANDS,
  levelCounts,
  linkBuckets,
  msLabel,
  navigationPhases,
  niceTicks,
  percent,
  rateVital,
  resourceBreakdown,
  resourceKind,
  scoreLevel,
  shares,
  shortUrl,
  vitalScale,
  vitalsSummary,
  waterfallLayout,
} from "../src/lib/viz";

const perf = (over: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  navigation: null,
  lcp: null,
  cls: 0,
  inp: null,
  fcp: null,
  longTasks: { count: 0, total: 0 },
  resources: [],
  ...over,
});

describe("scales", () => {
  it("rounds axis ticks to 1, 2 or 5 steps", () => {
    expect(niceTicks(870)).toEqual({ end: 1000, ticks: [0, 200, 400, 600, 800, 1000] });
    expect(niceTicks(21)).toEqual({ end: 25, ticks: [0, 5, 10, 15, 20, 25] });
    expect(niceTicks(4000).ticks).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(niceTicks(0)).toEqual({ end: 1, ticks: [0, 1] });
    expect(niceTicks(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });
  it("labels durations in ms then s", () => {
    expect(msLabel(0)).toBe("0");
    expect(msLabel(449.6)).toBe("450 ms");
    expect(msLabel(2500)).toBe("2.5 s");
    expect(msLabel(1000)).toBe("1 s");
    expect(msLabel(12_340)).toBe("12.3 s");
  });
  it("computes shares and percentages", () => {
    expect(shares([1, 3])).toEqual([0.25, 0.75]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0)).toBe("0%");
    expect(percent(0.456)).toBe("46%");
  });
});

describe("web vitals", () => {
  it("rates on web.dev thresholds, inclusive of the good bound", () => {
    expect(rateVital("lcp", 2500)).toBe("good");
    expect(rateVital("lcp", 2501)).toBe("needs-improvement");
    expect(rateVital("lcp", 4001)).toBe("poor");
    expect(rateVital("inp", 200)).toBe("good");
    expect(rateVital("inp", 500)).toBe("needs-improvement");
    expect(rateVital("cls", 0.1)).toBe("good");
    expect(rateVital("cls", 0.26)).toBe("poor");
    expect(rateVital("fcp", 1900)).toBe("needs-improvement");
    expect(rateVital("ttfb", 1801)).toBe("poor");
    expect(rateVital("inp", null)).toBeNull();
  });
  it("places values on a 0 → 1.5 × poor scale and flags overflow", () => {
    const s = vitalScale("lcp", 3000);
    expect(s.max).toBe(6000);
    expect(s.good).toBeCloseTo(2500 / 6000);
    expect(s.poor).toBeCloseTo(4000 / 6000);
    expect(s.pos).toBe(0.5);
    expect(vitalScale("lcp", 9000)).toMatchObject({ pos: 1, over: true });
    expect(vitalScale("inp", null).pos).toBeNull();
  });
  it("formats CLS without a unit and times with one", () => {
    expect(formatVital("cls", 0.0412)).toBe("0.041");
    expect(formatVital("lcp", 1234)).toBe("1.23 s");
    expect(formatVital("inp", null)).toBe("–");
  });
  it("summarizes the worst core vital", () => {
    expect(vitalsSummary(perf())).toEqual({ level: "good", text: "Good: CLS 0.000" });
    expect(vitalsSummary(perf({ cls: Number.NaN }))).toEqual({ level: "info", text: "Not measured yet" });
    expect(vitalsSummary(perf({ lcp: 5000, inp: 300 }))).toEqual({ level: "bad", text: "Poor: LCP 5 s" });
    expect(vitalsSummary(perf({ lcp: 1000, inp: 300 })).text).toBe("Needs improvement: INP 300 ms");
  });
});

describe("security meter", () => {
  it("has contiguous grade bands from 0 to 100", () => {
    expect(GRADE_BANDS[0]!.from).toBe(0);
    expect(GRADE_BANDS.at(-1)!.to).toBe(100);
    for (let i = 1; i < GRADE_BANDS.length; i++) expect(GRADE_BANDS[i]!.from).toBe(GRADE_BANDS[i - 1]!.to);
  });
  it("matches securityReport's grade and the score color", () => {
    for (const [headers, url] of [
      [{}, "http://example.com/"],
      [{ "x-content-type-options": "nosniff", "x-frame-options": "DENY" }, "https://example.com/"],
      [
        {
          "strict-transport-security": "max-age=63072000",
          "content-security-policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
        "https://example.com/",
      ],
    ] as const) {
      const r = securityReport(headers, url);
      const band = GRADE_BANDS.find((b) => r.score >= b.from && (r.score < b.to || b.to === 100))!;
      expect(band.grade).toBe(r.grade);
      expect(band.level).toBe(scoreLevel(r.score));
    }
  });
  it("counts checks by level", () => {
    expect(levelCounts([{ level: "good" }, { level: "bad" }, { level: "good" }, { level: "info" }])).toEqual({
      good: 2,
      warn: 0,
      bad: 1,
      info: 1,
    });
  });
});

describe("resources", () => {
  it("classifies by extension, then initiator", () => {
    expect(resourceKind("https://a.com/f/inter.woff2?v=1", "css")).toBe("font");
    expect(resourceKind("https://a.com/app.css", "link")).toBe("style");
    expect(resourceKind("https://a.com/chunk.mjs", "link")).toBe("script");
    expect(resourceKind("https://a.com/favicon.ico", "other")).toBe("image");
    expect(resourceKind("https://a.com/api/user", "fetch")).toBe("fetch");
    expect(resourceKind("https://a.com/api/log", "beacon")).toBe("fetch");
    expect(resourceKind("https://a.com/manifest.json", "link")).toBe("other");
    expect(resourceKind("not a url.js", "x")).toBe("script");
  });
  it("breaks bytes down by kind in a fixed order", () => {
    const b = resourceBreakdown([
      { name: "https://a.com/x.png", type: "img", transfer: 100 },
      { name: "https://a.com/a.js", type: "script", transfer: 300 },
      { name: "https://a.com/b.js", type: "script", transfer: 0 },
    ]);
    expect(b.kinds.map((k) => [k.kind, k.count, k.bytes])).toEqual([
      ["script", 2, 300],
      ["image", 1, 100],
    ]);
    expect(b).toMatchObject({ count: 3, bytes: 400 });
  });
  it("lays out the waterfall on a shared axis, sorted by start", () => {
    const res = [
      { name: "b", type: "img", transfer: 10, duration: 100, startTime: 300 },
      { name: "a", type: "script", transfer: 50, duration: 200, startTime: 100 },
      { name: "c", type: "fetch", transfer: 0, duration: 50, startTime: 700 },
    ];
    const w = waterfallLayout(res, { limit: 2 });
    expect(w.end).toBe(800);
    expect(w.total).toBe(3);
    expect(w.rows.map((r) => r.item.name)).toEqual(["a", "b"]);
    expect(w.rows[0]).toMatchObject({ kind: "script", start: 100, end: 300, left: 0.125, width: 0.25 });
    expect(waterfallLayout(res, { sort: "transfer" }).rows.map((r) => r.item.name)).toEqual(["a", "b", "c"]);
    expect(waterfallLayout(res, { sort: "duration" }).rows[0]!.item.name).toBe("a");
    expect(waterfallLayout(res, { markers: [1900] }).end).toBe(2000);
    expect(waterfallLayout([]).rows).toEqual([]);
  });
});

describe("navigation timeline", () => {
  it("uses phase boundaries when the snapshot has them", () => {
    const n = navigationPhases({
      redirect: 0,
      redirectEnd: 0,
      dnsStart: 2,
      dnsEnd: 10,
      connectStart: 10,
      tlsStart: 20,
      connectEnd: 40,
      requestStart: 41,
      responseStart: 120,
      responseEnd: 150,
      domInteractive: 300,
      domContentLoaded: 320,
      load: 0,
    });
    expect(n.phases.map((p) => [p.id, p.start, p.end])).toEqual([
      ["redirect", 0, 0],
      ["dns", 2, 10],
      ["connect", 10, 20],
      ["tls", 20, 40],
      ["waiting", 41, 120],
      ["download", 120, 150],
      ["dom", 150, 300],
    ]);
    expect(n.markers).toEqual([{ id: "dcl", label: "DOMContentLoaded", at: 320 }]);
    expect(n.end).toBe(320);
  });
  it("has no TLS phase over plain HTTP", () => {
    const n = navigationPhases({ connectStart: 5, tlsStart: 0, connectEnd: 9, responseStart: 20 });
    expect(n.phases.find((p) => p.id === "connect")).toMatchObject({ start: 5, end: 9 });
    expect(n.phases.find((p) => p.id === "tls")).toMatchObject({ start: 9, end: 9 });
  });
  it("lays durations end to end for older snapshots", () => {
    const n = navigationPhases({ redirect: 0, dns: 5, connect: 10, tls: 4, ttfb: 50, download: 10, domInteractive: 100, load: 200 });
    expect(n.phases.map((p) => p.end - p.start)).toEqual([0, 5, 6, 4, 35, 10, 40]);
    expect(n.end).toBe(200);
  });
});

describe("link status", () => {
  it("buckets ok, redirect, broken and pending", () => {
    expect(
      linkBuckets([
        { status: 200 },
        { status: 200, detail: "→ https://b.com/" },
        { status: 301 },
        { status: 404 },
        { status: "error", detail: "timeout" },
        { status: "pending" },
      ]),
    ).toEqual({ ok: 1, redirect: 2, broken: 2, pending: 1 });
  });
});

describe("short request names", () => {
  it("keeps the last path segment and a trimmed query", () => {
    expect(shortUrl("https://cdn.example.com/assets/app.3f2a.js")).toBe("app.3f2a.js");
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(shortUrl("https://example.com/api/search?q=mug")).toBe("search?q=mug");
    expect(shortUrl("https://example.com/i.png?width=1200&height=630&fit=cover")).toBe("i.png?width=1200&hei…");
    expect(shortUrl("https://example.com/caf%C3%A9.css")).toBe("café.css");
    expect(shortUrl("data-not-a-url")).toBe("data-not-a-url");
  });
});

describe("axis labels", () => {
  it("puts the unit on the last tick only, in seconds past 1 s", () => {
    expect(axisLabels([0, 50, 100, 150])).toEqual(["0", "50", "100", "150 ms"]);
    expect(axisLabels([0, 500, 1000, 1500])).toEqual(["0", "0.5", "1", "1.5 s"]);
  });
});
