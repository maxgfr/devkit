import { describe, expect, it } from "vitest";
import type { EventEntry, FrameEntry, ScriptEntry } from "../src/lib/page/responsiveness";
import {
  bfcacheFromNavigation,
  blockingScripts,
  countReasons,
  describeWhere,
  dominantPhase,
  explainReason,
  frameTotals,
  groupInteractions,
  inpEstimate,
  interactionMarkdown,
  lineColumn,
  parseSpeculationHeader,
  parseSpeculationRules,
  preloadState,
  reasonCodes,
  reasonTree,
  scriptFileMarkdown,
  scriptName,
  scriptSource,
  suggestions,
} from "../src/lib/responsiveness";

const PAGE = "https://shop.test/cart";

const ev = (over: Partial<EventEntry>): EventEntry => ({
  name: "click",
  interactionId: 1,
  startTime: 1000,
  duration: 264,
  processingStart: 1001,
  processingEnd: 1251,
  target: "button#slow",
  ...over,
});

const script = (over: Partial<ScriptEntry>): ScriptEntry => ({
  invoker: "BUTTON#slow.onclick",
  invokerType: "event-listener",
  sourceURL: "https://shop.test/slow.js",
  sourceFunctionName: "onSlowClick",
  sourceCharPosition: 175,
  startTime: 1001,
  duration: 250,
  executionStart: 1001,
  forcedStyleAndLayoutDuration: 0,
  pauseDuration: 0,
  windowAttribution: "self",
  ...over,
});

const frame = (over: Partial<FrameEntry>): FrameEntry => ({
  startTime: 995,
  duration: 270,
  renderStart: 1252,
  styleAndLayoutStart: 1255,
  blockingDuration: 220,
  firstUIEventTimestamp: 1000,
  scripts: [script({})],
  ...over,
});

describe("groupInteractions", () => {
  it("groups entries by interactionId and splits the three phases", () => {
    const events = [
      ev({ name: "pointerdown", startTime: 1000, duration: 40, processingStart: 1002, processingEnd: 1005 }),
      ev({ name: "pointerup", startTime: 1000, duration: 264, processingStart: 1001, processingEnd: 1100 }),
      ev({ name: "click", startTime: 1000, duration: 264, processingStart: 1100, processingEnd: 1251 }),
      ev({ name: "pointerover", interactionId: 0, duration: 300 }),
    ];
    const [i, ...rest] = groupInteractions(events, [frame({})]);
    expect(rest).toHaveLength(0);
    expect(i!.name).toBe("click");
    expect(i!.kind).toBe("pointer");
    expect(i!.target).toBe("button#slow");
    expect(i!.inputDelay).toBe(1);
    expect(i!.processing).toBe(250);
    expect(i!.presentation).toBe(13);
    expect(i!.events).toEqual(["pointerdown", "pointerup", "click"]);
    expect(i!.frames).toHaveLength(1);
    expect(i!.scripts[0]!.phase).toBe("processing");
  });

  it("never gives a negative presentation delay when duration is rounded down", () => {
    const [i] = groupInteractions([ev({ duration: 248, processingStart: 1000, processingEnd: 1250 })]);
    expect(i!.presentation).toBe(0);
    expect(i!.end).toBe(1250);
  });

  it("sorts slowest first and labels keyboard interactions", () => {
    const list = groupInteractions([
      ev({ interactionId: 1, duration: 80 }),
      ev({ interactionId: 2, name: "keydown", duration: 120, target: null }),
    ]);
    expect(list.map((i) => i.id)).toEqual([2, 1]);
    expect(list[0]!.kind).toBe("keyboard");
  });

  it("attributes scripts to the phase they started in", () => {
    const f = frame({
      startTime: 900,
      duration: 400,
      scripts: [
        script({ sourceFunctionName: "early", startTime: 900, duration: 50 }),
        script({ sourceFunctionName: "timer", startTime: 960, duration: 41 }),
        script({ sourceFunctionName: "raf", startTime: 1260, duration: 4 }),
      ],
    });
    const [i] = groupInteractions([ev({ processingStart: 1001, processingEnd: 1251 })], [f]);
    const phase = Object.fromEntries(i!.scripts.map((s) => [s.sourceFunctionName, s.phase]));
    expect(phase).toEqual({ early: "before", timer: "input-delay", raf: "presentation" });
  });
});

describe("inpEstimate", () => {
  it("is the worst interaction under 50, then skips one outlier per 50", () => {
    expect(inpEstimate([])).toBeNull();
    expect(inpEstimate([{ duration: 40 }, { duration: 300 }, { duration: 90 }])).toBe(300);
    const many = Array.from({ length: 60 }, (_, k) => ({ duration: k }));
    expect(inpEstimate(many)).toBe(58);
  });
});

describe("dominantPhase", () => {
  it("picks the longest phase", () => {
    expect(dominantPhase({ inputDelay: 120, processing: 30, presentation: 10 })).toBe("input-delay");
    expect(dominantPhase({ inputDelay: 1, processing: 30, presentation: 70 })).toBe("presentation");
  });
});

describe("scripts", () => {
  it("names a script by its function, then its invoker", () => {
    expect(scriptName(script({}))).toBe("onSlowClick");
    expect(scriptName(script({ sourceFunctionName: "" }))).toBe("BUTTON#slow.onclick");
    expect(scriptName(script({ sourceFunctionName: "", invoker: "", invokerType: "classic-script" }))).toBe("(classic-script)");
    expect(scriptSource(script({}), (u) => u.split("/").pop()!)).toBe("slow.js @ char 175");
    expect(scriptSource(script({ sourceURL: "" }))).toBe("BUTTON#slow.onclick (no source URL)");
  });

  it("sums script time per file, flags third parties and interaction time", () => {
    const f1 = frame({});
    const f2 = frame({
      startTime: 5000,
      scripts: [
        script({
          startTime: 5000,
          duration: 60,
          sourceFunctionName: "track",
          sourceURL: "https://cdn.ads.test/t.js",
          forcedStyleAndLayoutDuration: 12,
        }),
        script({ startTime: 5060, duration: 30, sourceFunctionName: "track", sourceURL: "https://cdn.ads.test/t.js" }),
        script({ startTime: 5100, duration: 20, sourceURL: "", invokerType: "user-callback", sourceFunctionName: "" }),
      ],
    });
    const interactions = groupInteractions([ev({})], [f1, f2]);
    const list = blockingScripts([f1, f2], PAGE, interactions);
    expect(list.map((b) => [b.key, b.total, b.count])).toEqual([
      ["https://shop.test/slow.js", 250, 1],
      ["https://cdn.ads.test/t.js", 90, 2],
      ["(user-callback, no source URL)", 20, 1],
    ]);
    expect(list[0]!.thirdParty).toBe(false);
    expect(list[0]!.duringInteractions).toBe(250);
    expect(list[1]!.thirdParty).toBe(true);
    expect(list[1]!.duringInteractions).toBe(0);
    expect(list[1]!.forcedLayout).toBe(12);
    expect(list[1]!.functions).toEqual([{ name: "track", charPosition: 175, total: 90, count: 2, forcedLayout: 12 }]);
  });

  it("totals long animation frames", () => {
    expect(frameTotals([frame({}), frame({ startTime: 3000, duration: 60, blockingDuration: 10, scripts: [] })])).toEqual({
      count: 2,
      blocking: 230,
      longest: 270,
      scripts: 250,
      total: 330,
    });
  });
});

describe("lineColumn", () => {
  it("turns a character offset into line, column and a snippet", () => {
    const text = "const a = 1;\nfunction busy() {\n  while (x) {}\n}";
    expect(lineColumn(text, text.indexOf("function"))).toEqual({ line: 2, column: 1, snippet: "function busy() {" });
    expect(lineColumn(text, text.indexOf("while"))).toMatchObject({ line: 3, column: 3 });
    expect(lineColumn(text, -1)).toBeNull();
    expect(lineColumn(text, 999)).toBeNull();
  });
  it("trims a minified line around the position", () => {
    const text = `${"a".repeat(500)}HERE${"b".repeat(500)}`;
    const loc = lineColumn(text, 500)!;
    expect(loc.line).toBe(1);
    expect(loc.column).toBe(501);
    expect(loc.snippet.startsWith("…")).toBe(true);
    expect(loc.snippet.endsWith("…")).toBe(true);
    expect(loc.snippet).toContain("HERE");
    expect(loc.snippet.length).toBeLessThan(170);
  });
});

describe("suggestions", () => {
  it("points at the handler when processing dominates", () => {
    const [i] = groupInteractions([ev({})], [frame({})]);
    const tips = suggestions(i!, PAGE);
    expect(tips[0]).toContain("The click handlers took 250 ms");
    expect(tips[0]).toContain("`onSlowClick` in slow.js");
  });

  it("points at the task that delayed the input", () => {
    const f = frame({
      startTime: 900,
      duration: 400,
      scripts: [script({ sourceFunctionName: "poll", invokerType: "user-callback", startTime: 950, duration: 150 })],
    });
    const [i] = groupInteractions([ev({ processingStart: 1100, processingEnd: 1110, duration: 120 })], [f]);
    expect(suggestions(i!, PAGE)[0]).toMatch(
      /busy for 100 ms before the first handler ran; `poll` in slow.js \(user-callback\) ran 150 ms/,
    );
  });

  it("explains a slow paint, forced layout and third parties", () => {
    const f = frame({
      startTime: 990,
      duration: 300,
      renderStart: 1020,
      styleAndLayoutStart: 1100,
      scripts: [
        script({
          sourceURL: "https://cdn.ads.test/t.js",
          startTime: 1021,
          duration: 60,
          forcedStyleAndLayoutDuration: 25,
          invokerType: "user-callback",
        }),
      ],
    });
    const [i] = groupInteractions([ev({ processingStart: 1002, processingEnd: 1012, duration: 296 })], [f]);
    const tips = suggestions(i!, PAGE).join("\n");
    expect(tips).toContain("passed between the end of the handlers and the next paint (rendering 270 ms, style and layout 190 ms)");
    expect(tips).toContain("forced style and layout for 25 ms");
    expect(tips).toContain("cdn.ads.test is a third party");
  });

  it("says nothing for a fast interaction", () => {
    const [i] = groupInteractions([ev({ duration: 32, processingStart: 1001, processingEnd: 1010 })]);
    expect(suggestions(i!, PAGE)).toEqual([]);
  });
});

describe("markdown for agents", () => {
  it("lists the interaction, its scripts with positions and labeled suggestions", () => {
    const [i] = groupInteractions([ev({})], [frame({})]);
    const md = interactionMarkdown(i!, PAGE, {
      focus: i!.scripts[0],
      locate: () => ({ line: 2, column: 9, snippet: "function onSlowClick() {" }),
    });
    expect(md).toContain("# Slow interaction on https://shop.test/cart");
    expect(md).toContain("- Interaction: click on `button#slow`");
    expect(md).toContain("needs improvement on the INP scale");
    expect(md).toContain("Processing (event handlers): 250 ms");
    expect(md).toContain("`onSlowClick` in https://shop.test/slow.js at line 2, column 9");
    expect(md).toContain("```js\nfunction onSlowClick() {\n```");
    expect(md).toContain(
      "| Event handler | `onSlowClick` | https://shop.test/slow.js:2:9 | BUTTON#slow.onclick (event-listener) | 250 ms | 0 ms |",
    );
    expect(md).toContain("## Suggestions (heuristics from these numbers, not a diagnosis)");
  });

  it("falls back to character positions and explains frames without scripts", () => {
    const [i] = groupInteractions([ev({})], [frame({ scripts: [] })]);
    const md = interactionMarkdown(i!, PAGE);
    expect(md).toContain("no script over 5 ms was attributed");
    const [j] = groupInteractions([ev({})], [frame({})]);
    expect(interactionMarkdown(j!, PAGE)).toContain("https://shop.test/slow.js (char 175)");
  });

  it("describes one file", () => {
    const f = frame({});
    const interactions = groupInteractions([ev({})], [f]);
    const [b] = blockingScripts([f], PAGE, interactions);
    const md = scriptFileMarkdown(b!, PAGE, interactions);
    expect(md).toContain("# Main-thread time of https://shop.test/slow.js");
    expect(md).toContain("| `onSlowClick` | 175 | 250 ms | 1 | 0 ms |");
    expect(md).toContain("- click on button#slow: 264 ms");
    expect(md).toContain("Split its long tasks");
  });
});

describe("back/forward cache", () => {
  it("explains common reasons and keeps unknown codes", () => {
    expect(explainReason("unload-listener").title).toBe("An unload handler");
    expect(explainReason("response-cache-control-no-store").title).toBe("Cache-Control: no-store");
    expect(explainReason("response-cache-control-no-store-with-js-network-request").title).toMatch(/then a script request/);
    expect(explainReason("broadcastchannel-message").title).toBe("An open BroadcastChannel");
    expect(explainReason("websocket").title).toBe("An open WebSocket");
    expect(explainReason("lock").title).toBe("A held Web Lock");
    expect(explainReason("masked").title).toMatch(/Hidden reason/);
    expect(explainReason("something-new")).toMatchObject({ code: "something-new", title: "something-new" });
  });

  it("builds the frame tree from notRestoredReasons (object and legacy string reasons)", () => {
    const tree = reasonTree({
      url: "https://shop.test/",
      reasons: [{ reason: "unload-listener" }],
      children: [{ src: "https://ads.test/frame", url: null, reasons: ["masked"], children: [] }],
    });
    expect(tree.label).toBe("https://shop.test/");
    expect(tree.main).toBe(true);
    expect(tree.children[0]!.label).toBe("https://ads.test/frame");
    expect(tree.children[0]!.main).toBe(false);
    expect(countReasons(tree)).toBe(2);
    expect(reasonCodes(tree)).toEqual(["unload-listener", "masked"]);
  });

  it("reads the navigation entry honestly", () => {
    expect(bfcacheFromNavigation(null).status).toBe("unknown");
    expect(bfcacheFromNavigation({ type: "navigate", notRestoredReasons: null, supported: true })).toMatchObject({
      status: "unknown",
      why: expect.stringContaining("loaded normally"),
    });
    expect(
      bfcacheFromNavigation({ type: "back_forward", notRestoredReasons: { reasons: [{ reason: "websocket" }] }, supported: true }),
    ).toMatchObject({
      status: "not-restored",
      via: "history",
    });
    expect(bfcacheFromNavigation({ type: "back_forward", notRestoredReasons: null, supported: false })).toMatchObject({
      why: expect.stringContaining("Chrome 123+"),
    });
  });
});

describe("speculation rules", () => {
  it("parses list and document rules with their default eagerness", () => {
    const set = parseSpeculationRules(
      JSON.stringify({
        prerender: [{ where: { and: [{ href_matches: "/*" }, { not: { selector_matches: ".no-prerender" } }] }, eagerness: "moderate" }],
        prefetch: [{ urls: ["/next", "/cart"], requires: ["anonymous-client-ip-when-cross-origin"], referrer_policy: "no-referrer" }],
        tag: "shop",
      }),
      "inline #1",
    );
    expect(set.error).toBeNull();
    expect(set.tag).toBe("shop");
    expect(set.rules).toHaveLength(2);
    const [pre, pf] = [set.rules.find((r) => r.action === "prefetch")!, set.rules.find((r) => r.action === "prerender")!];
    expect(pre).toMatchObject({
      source: "list",
      urls: ["/next", "/cart"],
      eagerness: "immediate",
      defaulted: true,
      referrerPolicy: "no-referrer",
    });
    expect(pf).toMatchObject({ source: "document", eagerness: "moderate", defaulted: false });
    expect(pf.where).toBe('href matches "/*" and not link matches ".no-prerender"');
  });

  it("reports invalid JSON and objects without rules", () => {
    expect(parseSpeculationRules("{", "x").error).toMatch(/^Invalid JSON/);
    expect(parseSpeculationRules('{"prefetchh": []}', "x").error).toMatch(/No prefetch or prerender rule/);
  });

  it("describes predicates", () => {
    expect(describeWhere(undefined)).toBe("every link");
    expect(describeWhere({ or: [{ href_matches: ["/a/*", "/b/*"] }, { selector_matches: "a.hot" }] })).toBe(
      '(href matches "/a/*" or "/b/*") or link matches "a.hot"',
    );
  });

  it("reads the Speculation-Rules header and the preload state", () => {
    expect(parseSpeculationHeader('"/rules.json", "/more.json"')).toEqual(["/rules.json", "/more.json"]);
    expect(parseSpeculationHeader(undefined)).toEqual([]);
    expect(preloadState({ activationStart: 412.3, deliveryType: "" })).toEqual({ prerendered: 412.3, prefetched: false, deliveryType: "" });
    expect(preloadState({ activationStart: 0, deliveryType: "navigational-prefetch" }).prefetched).toBe(true);
    expect(preloadState(null).prerendered).toBeNull();
  });
});
