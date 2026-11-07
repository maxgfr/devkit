import { afterEach, describe, expect, it } from "vitest";
import {
  boxCss,
  boxRects,
  distanceBetween,
  type MeasuredBox,
  type Measurement,
  measurementCss,
  measurementMarkdown,
  measurementSummary,
  round,
  sidesShorthand,
} from "../src/lib/measure";
import { installMeasure, type MeasureApi, measureBox } from "../src/lib/page/measure";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("sidesShorthand", () => {
  it("collapses like CSS", () => {
    expect(sidesShorthand([0, 0, 0, 0])).toBe("0");
    expect(sidesShorthand([8, 8, 8, 8])).toBe("8px");
    expect(sidesShorthand([8, 16, 8, 16])).toBe("8px 16px");
    expect(sidesShorthand([4, 8, 12, 8])).toBe("4px 8px 12px");
    expect(sidesShorthand([1, 2, 3, 4])).toBe("1px 2px 3px 4px");
    expect(sidesShorthand([0.333, 0, 0, 0])).toBe("0.33px 0 0");
  });
  it("rounds to two decimals without -0", () => {
    expect(round(23.999)).toBe(24);
    expect(Object.is(round(-0.001), -0)).toBe(false);
  });
});

describe("boxRects", () => {
  it("nests margin, border, padding and content around the border box", () => {
    const r = boxRects({ rect: rect(100, 50, 200, 100), margin: [10, 20, 10, -5], border: [1, 1, 1, 1], padding: [8, 16, 8, 16] });
    expect(r.margin).toEqual(rect(100, 40, 220, 120)); // negative margin drawn as 0
    expect(r.padding).toEqual(rect(101, 51, 198, 98));
    expect(r.content).toEqual(rect(117, 59, 166, 82));
  });
});

describe("distanceBetween", () => {
  it("measures a horizontal gap through the shared vertical span", () => {
    const d = distanceBetween(rect(0, 0, 120, 40), rect(144, 10, 120, 40), { a: ".a", b: ".b" });
    expect(d.relation).toBe("apart");
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0]).toMatchObject({ id: "x", kind: "gap", value: 24, x1: 120, x2: 144, y1: 25, y2: 25 });
    expect(d.gaps[0]!.between).toBe("right edge of .a → left edge of .b");
    expect(d.alignment).toEqual([{ axis: "y", start: 10, end: 10 }]);
    expect(d.extensions).toEqual([]);
  });
  it("measures from either side", () => {
    const d = distanceBetween(rect(200, 0, 50, 50), rect(0, 0, 100, 50));
    expect(d.gaps[0]).toMatchObject({ value: 100, between: "right edge of B → left edge of A" });
  });
  it("measures a vertical gap and reports edge alignment", () => {
    const d = distanceBetween(rect(10, 0, 100, 40), rect(10, 56, 100, 20));
    expect(d.gaps.map((g) => [g.id, g.value])).toEqual([["y", 16]]);
    expect(d.alignment).toEqual([{ axis: "x", start: 0, end: 0 }]);
  });
  it("measures both gaps of diagonal boxes, with extension lines from A", () => {
    const d = distanceBetween(rect(0, 0, 100, 100), rect(150, 200, 50, 50));
    expect(d.gaps.map((g) => [g.id, g.value])).toEqual([
      ["x", 50],
      ["y", 100],
    ]);
    // The horizontal guide runs at B's middle (y 225), below A: a dashed line joins A's right edge to it.
    expect(d.extensions).toContainEqual({ x1: 100, y1: 100, x2: 100, y2: 225 });
    expect(d.extensions).toContainEqual({ x1: 100, y1: 100, x2: 175, y2: 100 });
  });
  it("measures the insets of a box inside another (parent and child)", () => {
    const d = distanceBetween(rect(0, 0, 400, 100), rect(16, 16, 120, 40));
    expect(d.relation).toBe("inside");
    expect(Object.fromEntries(d.gaps.map((g) => [g.id, g.value]))).toEqual({ left: 16, right: 264, top: 16, bottom: 44 });
    expect(d.gaps.every((g) => g.kind === "inset")).toBe(true);
  });
  it("skips aligned edges and reports touching boxes as a zero gap", () => {
    expect(distanceBetween(rect(0, 0, 100, 100), rect(0, 0, 100, 50)).gaps.map((g) => g.id)).toEqual(["bottom"]);
    expect(distanceBetween(rect(0, 0, 100, 10), rect(100, 0, 50, 10)).gaps[0]!.value).toBe(0);
  });
  it("names the containing relation and partial overlaps", () => {
    expect(distanceBetween(rect(10, 10, 10, 10), rect(0, 0, 50, 50)).relation).toBe("contains");
    expect(distanceBetween(rect(0, 0, 50, 50), rect(25, 25, 50, 50)).relation).toBe("overlap");
  });
});

const box = (selector: string, r: ReturnType<typeof rect>, extra: Partial<MeasuredBox> = {}): MeasuredBox => ({
  selector,
  unique: true,
  label: `div${selector}`,
  rect: r,
  margin: [0, 0, 0, 0],
  border: [0, 0, 0, 0],
  padding: [0, 0, 0, 0],
  boxSizing: "content-box",
  display: "block",
  position: "static",
  font: { family: '"Inter", sans-serif', size: "16px", weight: "400", lineHeight: "24px" },
  ...extra,
});

const viewport = { width: 1200, height: 800, dpr: 2, scrollX: 0, scrollY: 0 };

describe("measurement texts", () => {
  const a = box("#a", rect(0, 0, 120, 40), { padding: [8, 16, 8, 16], border: [1, 1, 1, 1], boxSizing: "border-box" });
  const b = box("#b", rect(133, 0, 120, 40));
  const m: Measurement = {
    kind: "distance",
    a,
    b,
    distance: distanceBetween(a.rect, b.rect, { a: "#a", b: "#b" }),
    frozen: true,
    viewport,
    url: "https://example.com/",
    at: 1,
  };
  it("writes CSS declarations for each box, border-box sizes as set", () => {
    expect(boxCss(a)).toEqual([
      "width: 120px;",
      "height: 40px;",
      "box-sizing: border-box;",
      "padding: 8px 16px;",
      "border-width: 1px;",
      "margin: 0;",
      'font: 400 16px/24px "Inter";',
    ]);
    expect(boxCss(b)[0]).toBe("width: 120px;");
    const css = measurementCss(m);
    expect(css).toContain("/* #a → #b */");
    expect(css).toContain("/* horizontal gap: 13px (right edge of #a → left edge of #b) */");
    expect(css).toContain("#b {\n  width: 120px;");
  });
  it("tells an agent the gap, the expected value and the difference", () => {
    const md = measurementMarkdown(m, { expected: 16, note: "Match the grid." });
    expect(md).toContain("The horizontal gap between `#a` and `#b` is 13px; expected 16px (3px too narrow).");
    expect(md).toContain("- From: `#a` (div#a, 120 × 40 px)");
    expect(md).toContain("device pixel ratio 2");
    expect(md).toContain("### What should change\n\nMatch the grid.");
    expect(measurementMarkdown(m, { expected: 13 })).toContain("is 13px, as expected (13px).");
    expect(measurementMarkdown(m)).toContain("is 13px.");
  });
  it("targets the chosen gap", () => {
    const p = box("#p", rect(0, 0, 400, 100));
    const inner: Measurement = { ...m, kind: "parent", a: p, b, distance: distanceBetween(p.rect, b.rect, { a: "#p", b: "#b" }) };
    expect(measurementMarkdown(inner, { expected: 24, expectedGap: "bottom" })).toContain(
      "The bottom inset of `#b` inside `#p` is 60px; expected 24px (36px too wide).",
    );
  });
  it("covers boxes and areas", () => {
    const one: Measurement = { kind: "box", a, frozen: false, viewport, url: "https://example.com/", at: 1 };
    expect(measurementMarkdown(one)).toContain("`#a` (div#a): width: 120px;");
    expect(measurementSummary(one)).toBe("div#a 120 × 40");
    const area: Measurement = { kind: "ruler", ruler: rect(10, 20, 240, 130), frozen: true, viewport, url: "u", at: 1 };
    expect(measurementCss(area)).toBe("/* Area at 10, 20 */\nwidth: 240px;\nheight: 130px;");
    expect(measurementSummary(area)).toBe("Area 240 × 130");
    expect(measurementSummary(m)).toBe("Horizontal gap 13px");
    const zoomed: Measurement = { ...m, a: { ...a, zoom: 1.5 }, b: { ...b, zoom: 1.5 } };
    expect(measurementMarkdown(zoomed)).toContain("CSS `zoom: 1.5`: values are as drawn on screen; divide by 1.5");
    expect(measurementMarkdown(m)).not.toContain("zoom");
  });
});

describe("in-page ruler", () => {
  const api = () => (window as unknown as { __devkitMeasure?: MeasureApi }).__devkitMeasure!;
  const host = () => document.querySelector("devkit-measure");
  const pointer = (el: Element, type: string, extra: PointerEventInit = {}) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0, ...extra }));
  const click = (el: Element) => {
    pointer(el, "pointermove");
    pointer(el, "pointerdown");
    pointer(el, "pointerup");
  };
  const frame = () => new Promise((r) => setTimeout(r, 30));
  afterEach(() => {
    api()?.stop();
    document.body.innerHTML = "";
  });

  it("reads the box model with the computed values", () => {
    document.body.innerHTML = `<div id="x" style="padding: 4px 8px; margin: 2px; border: 1px solid; font-size: 14px"></div>`;
    const b = measureBox(document.getElementById("x")!);
    expect(b.selector).toBe("#x");
    expect(b.padding).toEqual([4, 8, 4, 8]);
    expect(b.margin).toEqual([2, 2, 2, 2]);
    expect(b.border).toEqual([1, 1, 1, 1]);
    expect(b.font?.size).toBe("14px");
  });

  it("hovers, locks, freezes, and stops on Escape without the page seeing clicks", async () => {
    document.body.innerHTML = `<div id="a">A</div><div id="b">B</div>`;
    let clicks = 0;
    document.addEventListener("click", () => clicks++);
    expect(installMeasure()).toBe(true);
    const done = api().start();
    expect(host()).not.toBeNull();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    pointer(a, "pointermove");
    await frame();
    expect(api().state()).toMatchObject({ active: true, last: { kind: "box", a: { selector: "#a" } } });
    click(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    pointer(b, "pointermove");
    await frame();
    expect(api().state().last).toMatchObject({ kind: "distance", frozen: false, a: { selector: "#a" }, b: { selector: "#b" } });
    click(b);
    await frame();
    expect(api().state().last).toMatchObject({ kind: "distance", frozen: true });
    // Frozen: hovering elsewhere keeps the pair.
    pointer(a, "pointermove");
    await frame();
    expect(api().state().last).toMatchObject({ kind: "distance", frozen: true, b: { selector: "#b" } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await expect(done).resolves.toEqual({ status: "stopped" });
    expect(host()).toBeNull();
    expect(clicks).toBe(0);
    expect(api().state()).toMatchObject({ active: false, last: { kind: "distance", frozen: true } });
  });

  it("measures an element in its parent with Alt, and moves to the parent with ArrowUp", async () => {
    document.body.innerHTML = `<section id="p"><span id="c">x</span></section>`;
    installMeasure();
    const done = api().start();
    const c = document.getElementById("c")!;
    pointer(c, "pointermove", { altKey: true });
    await frame();
    expect(api().state().last).toMatchObject({ kind: "parent", a: { selector: "#p" }, b: { selector: "#c" } });
    pointer(c, "pointermove");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    await frame();
    expect(api().state().last).toMatchObject({ kind: "box", a: { selector: "#p" } });
    // A second start replaces the first.
    const again = api().start();
    await expect(done).resolves.toEqual({ status: "replaced" });
    api().stop();
    await expect(again).resolves.toEqual({ status: "stopped" });
  });
});
