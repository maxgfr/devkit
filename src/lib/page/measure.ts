// Spacing ruler, run in the page's ISOLATED world. Bundled into /measure-tool.js by
// src/entrypoints/measure-tool.ts, which installs `window.__devkitMeasure`; the side panel drives it
// through small `runInTab` functions and hears every new measurement as a runtime message.

import {
  boxName,
  boxRects,
  distanceBetween,
  fontText,
  MEASURE_MESSAGE,
  type MeasuredBox,
  type MeasureState,
  type Measurement,
  type Rect,
  round,
  type Sides,
  sidesShorthand,
} from "../measure";
import { crumbLabel, uniqueSelector } from "./element";

export const MEASURE_VERSION = 1;

export type MeasureResult = { status: "stopped" | "replaced" };

export interface MeasureApi {
  v: number;
  start: () => Promise<MeasureResult>;
  stop: () => void;
  state: () => MeasureState;
  nudge: (dir: "up" | "down") => void;
  /** Enter: what a click on the current element does. */
  lock: () => void;
}

interface ActiveMeasure {
  stop: (status: MeasureResult["status"]) => void;
  nudge: (dir: "up" | "down") => void;
  lock: () => void;
}

interface MeasureWindow {
  __devkitMeasure?: MeasureApi;
  __devkitMeasurer?: ActiveMeasure;
  __devkitMeasureLast?: Measurement | null;
}

const win = () => window as unknown as MeasureWindow;

type Runtime = { runtime?: { id?: string; sendMessage?: (m: unknown) => Promise<unknown> | undefined } };

/** Tells the side panel (if open). The extension may have been reloaded since: then nobody listens. */
function emit(state: MeasureState) {
  try {
    const rt = (globalThis as unknown as { chrome?: Runtime }).chrome?.runtime;
    if (!rt?.id) return;
    rt.sendMessage?.({ type: MEASURE_MESSAGE, state })?.catch?.(() => undefined);
  } catch {
    /* extension context invalidated */
  }
}

/** The element's parent, crossing out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Border box in viewport CSS px and the box model, CSS `zoom` applied (computed lengths are unzoomed). */
export function measureBox(el: Element): MeasuredBox {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const zoom = (el as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  const sides = (prop: string, suffix = "") =>
    SIDES.map((s) => (Number.parseFloat(cs.getPropertyValue(`${prop}-${s}${suffix}`)) || 0) * zoom) as Sides;
  const { selector, unique } = uniqueSelector(el);
  return {
    selector,
    unique,
    label: crumbLabel(el),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    margin: sides("margin"),
    border: sides("border", "-width"),
    padding: sides("padding"),
    boxSizing: cs.boxSizing,
    display: cs.display,
    position: cs.position,
    font: { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight },
    zoom: round(zoom),
  };
}

/* Overlay */

const Z = "2147483647";
const RED = "#ef4444";
const A_COLOR = "#f43f5e";
const B_COLOR = "#22d3ee";

const SHEET = `
:host { all: initial; }
div, span { box-sizing: border-box; pointer-events: none; }
.ring { position: fixed; display: none; border-style: solid; border-width: 0; }
.ring.m { border-color: rgba(246, 178, 107, 0.6); }
.ring.b { border-color: rgba(255, 220, 130, 0.75); }
.ring.p { border-color: rgba(147, 196, 125, 0.6); }
.ring.c { background: rgba(111, 168, 220, 0.5); }
.outline { position: fixed; display: none; border: 1.5px solid; }
.outline.a { border-color: ${A_COLOR}; border-style: dashed; }
.outline.b { border-color: ${B_COLOR}; }
.badge { position: absolute; top: -1.5px; left: -1.5px; transform: translateY(-100%); padding: 1px 4px; border-radius: 3px 3px 0 0; font: 700 10px/12px system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
.outline.a .badge { background: ${A_COLOR}; }
.outline.b .badge { background: #0e7490; }
.dyn { position: fixed; inset: 0; }
.line { position: fixed; background: ${RED}; }
.line.x::before, .line.x::after { content: ""; position: absolute; top: -3px; width: 1px; height: 7px; background: ${RED}; }
.line.x::before { left: 0; } .line.x::after { right: 0; }
.line.y::before, .line.y::after { content: ""; position: absolute; left: -3px; height: 1px; width: 7px; background: ${RED}; }
.line.y::before { top: 0; } .line.y::after { bottom: 0; }
.ext { position: fixed; border: 0 dashed rgba(239, 68, 68, 0.8); }
.tag { position: fixed; transform: translate(-50%, -50%); padding: 2px 5px; border-radius: 3px; background: ${RED}; color: #fff; font: 600 11px/14px system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.tag.size { background: #0b1220; color: #e7e9ee; }
.side { position: fixed; transform: translate(-50%, -50%); font: 600 10px/12px ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #1f2937; font-variant-numeric: tabular-nums; }
.ruler { position: fixed; display: none; border: 1px solid ${RED}; background: rgba(239, 68, 68, 0.08); }
.info { position: fixed; display: none; max-width: min(460px, calc(100vw - 16px)); padding: 4px 8px; border-radius: 4px; background: #0b1220; color: #e7e9ee; font: 500 12px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
.info div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.info .sel { color: #67e8f9; }
.info .dim { color: #a9afbc; }
.hint { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); max-width: calc(100vw - 24px); padding: 6px 12px; border-radius: 6px; background: #0b1220; color: #e7e9ee; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); }
.hint b { color: #67e8f9; font-weight: 600; }
`;

const div = (cls: string, parent?: Node) => {
  const d = document.createElement("div");
  d.className = cls;
  parent?.appendChild(d);
  return d;
};

const place = (el: HTMLElement, r: Rect) =>
  Object.assign(el.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });

const n = (v: number) => String(round(v));

function overlay() {
  const host = document.createElement("devkit-measure");
  host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${Z}; pointer-events: none; display: block; contain: strict;`;
  const shadow = host.attachShadow({ mode: "closed" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHEET);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    /* very old engine: unstyled */
  }
  const rings = { m: div("ring m", shadow), b: div("ring b", shadow), p: div("ring p", shadow), c: div("ring c", shadow) };
  const outlineA = div("outline a", shadow);
  div("badge", outlineA).textContent = "A";
  const outlineB = div("outline b", shadow);
  div("badge", outlineB).textContent = "B";
  const ruler = div("ruler", shadow);
  const dyn = div("dyn", shadow);
  const info = div("info", shadow);
  const hint = div("hint", shadow);
  document.documentElement.append(host);
  try {
    // The top layer puts the overlay above modal dialogs and popovers too.
    host.setAttribute("popover", "manual");
    (host as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* no popover support: z-index only */
  }

  const hideAll = () => {
    for (const r of Object.values(rings)) r.style.display = "none";
    outlineA.style.display = "none";
    outlineB.style.display = "none";
    ruler.style.display = "none";
    info.style.display = "none";
    dyn.replaceChildren();
  };

  const drawBox = (b: MeasuredBox) => {
    const r = boxRects(b);
    const ring = (el: HTMLElement, rect: Rect, s: Sides) => {
      place(el, rect);
      el.style.borderWidth = s.map((v) => `${Math.max(0, v)}px`).join(" ");
    };
    ring(rings.m, r.margin, b.margin.map((v) => Math.max(0, v)) as Sides);
    ring(rings.b, r.border, b.border);
    ring(rings.p, r.padding, b.padding);
    place(rings.c, r.content);
    // Side values written in the band when it is wide enough to hold them.
    const sideLabels = (outer: Rect, s: Sides) => {
      const [t, rt, bt, l] = s;
      const cx = outer.x + outer.width / 2;
      const cy = outer.y + outer.height / 2;
      const spots: [number, number, number, number][] = [
        [t, cx, outer.y + t / 2, t],
        [rt, outer.x + outer.width - rt / 2, cy, rt],
        [bt, cx, outer.y + outer.height - bt / 2, bt],
        [l, outer.x + l / 2, cy, l],
      ];
      for (const [v, x, y, thick] of spots) {
        if (thick < 13 || round(v) === 0) continue;
        const sp = div("side", dyn);
        sp.textContent = n(v);
        Object.assign(sp.style, { left: `${x}px`, top: `${y}px` });
      }
    };
    sideLabels(r.margin, b.margin.map((v) => Math.max(0, v)) as Sides);
    sideLabels(r.padding, b.padding);
  };

  const outline = (el: HTMLElement, r: Rect) => place(el, { x: r.x - 0.75, y: r.y - 0.75, width: r.width + 1.5, height: r.height + 1.5 });

  const tag = (text: string, x: number, y: number, cls = "tag") => {
    const t = div(cls, dyn);
    t.textContent = text;
    Object.assign(t.style, { left: `${x}px`, top: `${y}px` });
    return t;
  };

  /** The label next to `b`: above it, or for a pair below `avoid` (both boxes), where no guide runs. */
  const showInfo = (b: MeasuredBox, prefix?: string, avoid?: Rect) => {
    info.replaceChildren();
    const head = div("", info);
    if (prefix) {
      const p = document.createElement("span");
      p.className = "dim";
      p.textContent = `${prefix} `;
      head.append(p);
    }
    const sel = document.createElement("span");
    sel.className = "sel";
    sel.textContent = b.label;
    head.append(sel, `  ${n(b.rect.width)} × ${n(b.rect.height)}`);
    const box = div("dim", info);
    box.textContent = `padding ${sidesShorthand(b.padding).replaceAll("px", "")} · border ${sidesShorthand(b.border).replaceAll("px", "")} · margin ${sidesShorthand(b.margin).replaceAll("px", "")}`;
    const font = fontText(b.font);
    if (font) div("dim", info).textContent = font;
    info.style.display = "block";
    const h = info.offsetHeight;
    const r = avoid ?? b.rect;
    const above = r.y - h - (avoid ? 14 : 6);
    const under = r.y + r.height + (avoid ? 14 : 6);
    const top = avoid
      ? under + h <= innerHeight - 4
        ? under
        : above >= 0
          ? above
          : innerHeight - h - 4
      : above >= 0
        ? above
        : Math.min(under, innerHeight - h - 4);
    info.style.top = `${Math.max(4, top)}px`;
    info.style.left = `${Math.max(4, Math.min(b.rect.x, innerWidth - info.offsetWidth - 4))}px`;
  };

  const draw = (m: Measurement | null) => {
    hideAll();
    if (!m) return;
    if (m.kind === "ruler" && m.ruler) {
      place(ruler, m.ruler);
      const r = m.ruler;
      tag(`${n(r.width)} × ${n(r.height)}`, r.x + r.width, r.y + r.height + 14, "tag size");
      return;
    }
    if (m.kind === "box" && m.a) {
      drawBox(m.a);
      showInfo(m.a);
      return;
    }
    if (!m.a || !m.b || !m.distance) return;
    outline(outlineA, m.a.rect);
    outline(outlineB, m.b.rect);
    if (m.kind === "parent") drawBox(m.b);
    for (const e of m.distance.extensions) {
      const d = div("ext", dyn);
      if (e.x1 === e.x2) {
        Object.assign(d.style, {
          left: `${e.x1}px`,
          top: `${Math.min(e.y1, e.y2)}px`,
          height: `${Math.abs(e.y2 - e.y1)}px`,
          borderLeftWidth: "1px",
        });
      } else {
        Object.assign(d.style, {
          left: `${Math.min(e.x1, e.x2)}px`,
          top: `${e.y1}px`,
          width: `${Math.abs(e.x2 - e.x1)}px`,
          borderTopWidth: "1px",
        });
      }
    }
    for (const g of m.distance.gaps) {
      const line = div(`line ${g.axis}`, dyn);
      const len = g.axis === "x" ? Math.abs(g.x2 - g.x1) : Math.abs(g.y2 - g.y1);
      if (g.axis === "x")
        Object.assign(line.style, { left: `${Math.min(g.x1, g.x2)}px`, top: `${g.y1 - 0.5}px`, width: `${len}px`, height: "1px" });
      else Object.assign(line.style, { left: `${g.x1 - 0.5}px`, top: `${Math.min(g.y1, g.y2)}px`, width: "1px", height: `${len}px` });
      const t = tag(n(g.value), (g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2);
      // A short guide keeps its value beside it rather than on top.
      if (len < 34) t.style.transform = g.axis === "x" ? "translate(-50%, calc(-100% - 5px))" : "translate(6px, -50%)";
    }
    const ra = m.a.rect;
    const rb = m.b.rect;
    const top = Math.min(ra.y, rb.y);
    const bottom = Math.max(ra.y + ra.height, rb.y + rb.height);
    showInfo(m.b, "B ·", { x: Math.min(ra.x, rb.x), y: top, width: 0, height: bottom - top });
  };

  const setHint = (html: [string, string][]) => {
    hint.replaceChildren();
    html.forEach(([key, text], i) => {
      if (i) hint.append(" · ");
      if (key) {
        const b = document.createElement("b");
        b.textContent = key;
        hint.append(b, ` ${text}`);
      } else hint.append(text);
    });
  };

  const placeHint = (avoid: Rect | undefined) => {
    const near = avoid && avoid.y + avoid.height > innerHeight - 60 && avoid.y < innerHeight;
    Object.assign(hint.style, near ? { top: "14px", bottom: "auto" } : { top: "auto", bottom: "14px" });
  };

  return { host, draw, setHint, placeHint, remove: () => host.remove() };
}

const rectBetween = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

export function startMeasure(): Promise<MeasureResult> {
  const w = win();
  w.__devkitMeasurer?.stop("replaced");
  return new Promise<MeasureResult>((resolve) => {
    const ui = overlay();
    let raw: Element | null = null;
    let hover: Element | null = null;
    let anchor: Element | null = null;
    let frozen: { a: Element; b: Element; parent: boolean } | null = null;
    let alt = false;
    let down: { x: number; y: number; sx: number; sy: number } | null = null;
    let dragging = false;
    /** The drawn area, in page coordinates so it stays on the page as it scrolls. */
    let area: Rect | null = null;
    let areaFrozen = false;
    const below: Element[] = [];
    let raf = 0;
    let sent = "";
    let sendTimer = 0;

    const viewport = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY });
    const base = (kind: Measurement["kind"], frozenNow: boolean): Measurement => ({
      kind,
      frozen: frozenNow,
      viewport: viewport(),
      url: location.href,
      at: Date.now(),
    });
    const pair = (a: Element, b: Element, kind: "distance" | "parent", frozenNow: boolean): Measurement => {
      const ma = measureBox(a);
      const mb = measureBox(b);
      return { ...base(kind, frozenNow), a: ma, b: mb, distance: distanceBetween(ma.rect, mb.rect, { a: boxName(ma), b: boxName(mb) }) };
    };
    const usable = (el: Element | null) => (el?.isConnected ? el : null);

    const current = (): Measurement | null => {
      if (area && (dragging || areaFrozen))
        return { ...base("ruler", areaFrozen), ruler: { ...area, x: area.x - scrollX, y: area.y - scrollY } };
      if (frozen && usable(frozen.a) && usable(frozen.b)) return pair(frozen.a, frozen.b, frozen.parent ? "parent" : "distance", true);
      const h = usable(hover);
      const a = usable(anchor);
      if (h && alt) {
        const p = parentOf(h);
        if (p) return pair(p, h, "parent", false);
      }
      if (a && h && h !== a) return pair(a, h, "distance", false);
      const one = h ?? a;
      return one ? { ...base("box", false), a: measureBox(one) } : null;
    };

    const hintFor = () => {
      if (dragging) ui.setHint([["", "Release to keep the area"]]);
      else if (areaFrozen || frozen)
        ui.setHint([
          ["Click", "to start again"],
          ["Drag", "to measure an area"],
          ["Esc", "to exit"],
        ]);
      else if (anchor)
        ui.setHint([
          ["", "Hover another element"],
          ["Click", "to freeze"],
          ["Click A", "to release"],
          ["Esc", "to exit"],
        ]);
      else
        ui.setHint([
          ["Click", "to lock"],
          ["Alt", "distance to parent"],
          ["Drag", "an area"],
          ["↑ ↓", "parent / child"],
          ["Esc", "to exit"],
        ]);
    };

    const flush = (m: Measurement | null) => {
      // Positions move on scroll; the message goes out when the numbers or the elements change.
      const sig = m
        ? JSON.stringify([
            m.kind,
            m.frozen,
            m.a?.selector,
            m.b?.selector,
            m.a && [m.a.rect.width, m.a.rect.height],
            m.b && [m.b.rect.width, m.b.rect.height],
            m.distance?.gaps.map((g) => [g.id, g.value]),
            m.ruler && [m.ruler.width, m.ruler.height],
          ])
        : "";
      if (!m || sig === sent) return;
      sent = sig;
      w.__devkitMeasureLast = m;
      clearTimeout(sendTimer);
      sendTimer = window.setTimeout(() => emit({ active: true, last: w.__devkitMeasureLast ?? null }), 60);
    };

    const redraw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const m = current();
        ui.draw(m);
        hintFor();
        ui.placeHint(m?.b?.rect ?? m?.a?.rect ?? m?.ruler);
        flush(m);
      });
    };

    let cursor: CSSStyleSheet | null = null;
    try {
      cursor = new CSSStyleSheet();
      cursor.replaceSync("* { cursor: crosshair !important; user-select: none !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursor];
    } catch {
      cursor = null;
    }

    const targetOf = (e: Event): Element | null => {
      const t = e.composedPath()[0];
      if (!(t instanceof Element) || t === ui.host) return null;
      return t;
    };
    const swallow = (e: Event) => {
      if (!targetOf(e)) return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    };

    /** What a click on `t` does: lock it, freeze the pair, release, or start again. */
    const clickOn = (t: Element, withAlt: boolean) => {
      if (frozen || areaFrozen) {
        frozen = null;
        areaFrozen = false;
        area = null;
        anchor = t;
      } else if (withAlt) {
        const p = parentOf(t);
        if (p) frozen = { a: p, b: t, parent: true };
      } else if (!anchor) anchor = t;
      else if (t === anchor) anchor = null;
      else frozen = { a: anchor, b: t, parent: false };
      redraw();
    };

    const onMove = (e: PointerEvent) => {
      alt = e.altKey;
      if (down) {
        if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
          dragging = true;
          areaFrozen = false;
          frozen = null;
        }
        if (dragging) area = rectBetween(down.x + down.sx, down.y + down.sy, e.clientX + scrollX, e.clientY + scrollY);
      }
      const t = targetOf(e);
      if (t && t !== raw) {
        raw = t;
        hover = t;
        below.length = 0;
      }
      redraw();
    };
    const onDown = (e: PointerEvent) => {
      if (!swallow(e) || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY };
      dragging = false;
    };
    const onUp = (e: PointerEvent) => {
      if (!swallow(e) || !down) return;
      const wasDrag = dragging;
      down = null;
      dragging = false;
      if (wasDrag) {
        areaFrozen = Boolean(area && area.width > 0 && area.height > 0);
        redraw();
        return;
      }
      const t = hover ?? targetOf(e);
      if (t) clickOn(t, e.altKey);
    };
    const block = (e: Event) => {
      swallow(e);
    };

    const nudge = (dir: "up" | "down") => {
      const move = (el: Element): Element => {
        if (dir === "up") {
          const p = parentOf(el);
          if (p && p.localName !== "html") {
            below.push(el);
            return p;
          }
          return el;
        }
        return below.pop() ?? el.firstElementChild ?? el;
      };
      if (frozen) frozen = { ...frozen, b: move(frozen.b) };
      else if (hover) hover = move(hover);
      else if (anchor) anchor = move(anchor);
      redraw();
    };
    const lock = () => {
      const t = frozen?.b ?? hover ?? anchor;
      if (t) clickOn(t, alt);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        alt = e.type === "keydown";
        redraw();
        return;
      }
      if (e.type !== "keydown") return;
      const handled = ["Escape", "ArrowUp", "ArrowDown", "Enter", "[", "]"];
      if (!handled.includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") stop("stopped");
      else if (e.key === "Enter") lock();
      else nudge(e.key === "ArrowUp" || e.key === "[" ? "up" : "down");
    };
    const onBlur = () => {
      alt = false;
      down = null;
      dragging = false;
    };

    const opts = { capture: true, passive: false } as const;
    const swallowed = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "selectstart", "dragstart"];
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointerup", onUp, opts);
    for (const t of swallowed) window.addEventListener(t, block, opts);
    window.addEventListener("keydown", onKey, opts);
    window.addEventListener("keyup", onKey, opts);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointercancel", onBlur, opts);
    window.addEventListener("scroll", redraw, { capture: true, passive: true });
    window.addEventListener("resize", redraw);

    const stop = (status: MeasureResult["status"]) => {
      cancelAnimationFrame(raf);
      clearTimeout(sendTimer);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      for (const t of swallowed) window.removeEventListener(t, block, opts);
      window.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("keyup", onKey, opts);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointercancel", onBlur, opts);
      window.removeEventListener("scroll", redraw, { capture: true });
      window.removeEventListener("resize", redraw);
      if (cursor) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== cursor);
      ui.remove();
      if (w.__devkitMeasurer === active) w.__devkitMeasurer = undefined;
      if (status === "stopped") emit({ active: false, last: w.__devkitMeasureLast ?? null });
      resolve({ status });
    };
    const active: ActiveMeasure = { stop, nudge, lock };
    w.__devkitMeasurer = active;
    hintFor();
    emit({ active: true, last: w.__devkitMeasureLast ?? null });
  });
}

export function installMeasure(): boolean {
  const w = win();
  if (w.__devkitMeasure?.v === MEASURE_VERSION) return true;
  w.__devkitMeasure?.stop();
  w.__devkitMeasure = {
    v: MEASURE_VERSION,
    start: startMeasure,
    stop: () => win().__devkitMeasurer?.stop("stopped"),
    state: () => ({ active: Boolean(win().__devkitMeasurer), last: win().__devkitMeasureLast ?? null }),
    nudge: (dir) => win().__devkitMeasurer?.nudge(dir),
    lock: () => win().__devkitMeasurer?.lock(),
  };
  return true;
}
