// Spacing ruler: box model geometry, distances between two boxes, and the texts copied from a measurement.
// Pure: shared by the in-page overlay (src/lib/page/measure.ts) and the side panel.

export const MEASURE_MESSAGE = "devkit:measure";

/** top, right, bottom, left — the CSS order. */
export type Sides = [number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxFont {
  family: string;
  size: string;
  weight: string;
  lineHeight: string;
}

/** One element as measured: its border box in viewport CSS px and its box model, zoom applied. */
export interface MeasuredBox {
  selector: string;
  unique: boolean;
  /** tag#id.class, short. */
  label: string;
  rect: Rect;
  margin: Sides;
  border: Sides;
  padding: Sides;
  boxSizing: string;
  display: string;
  position: string;
  font?: BoxFont;
  /** Effective CSS `zoom` (1 when none): the values above are on-screen, zoom applied. */
  zoom?: number;
}

export type GapEdge = "left" | "right" | "top" | "bottom";

/** One distance, drawn as a guide from (x1, y1) to (x2, y2). */
export interface Gap {
  id: string;
  axis: "x" | "y";
  /** "gap": the boxes are apart on this axis; "inset": one edge inside the other box (overlap, nesting). */
  kind: "gap" | "inset";
  value: number;
  /** Plain words: "right edge of A → left edge of B". */
  between: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A dashed extension line, from an edge of a box to where its guide is drawn. */
export interface Extension {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Alignment {
  axis: "x" | "y";
  /** B's start edge minus A's (left or top), and the same for the end edges. 0 = aligned. */
  start: number;
  end: number;
}

export interface Distance {
  gaps: Gap[];
  extensions: Extension[];
  /** On an axis where the boxes overlap without nesting, how far their edges are from lining up. */
  alignment: Alignment[];
  relation: "apart" | "overlap" | "inside" | "contains";
}

export type MeasureKind = "box" | "distance" | "parent" | "ruler";

export interface Measurement {
  kind: MeasureKind;
  /** The hovered box, or the locked one (distance), or the parent (parent). */
  a?: MeasuredBox;
  b?: MeasuredBox;
  distance?: Distance;
  ruler?: Rect;
  /** Frozen by a click: hovering no longer changes it. */
  frozen: boolean;
  viewport: { width: number; height: number; dpr: number; scrollX: number; scrollY: number };
  url: string;
  at: number;
}

export interface MeasureState {
  active: boolean;
  last: Measurement | null;
}

/** Rounded to 2 decimals, trailing zeros dropped: 13, 13.5, 13.33. */
export function round(n: number): number {
  return Math.round(n * 100) / 100 + 0;
}

export const px = (n: number) => `${round(n)}px`;

/** CSS shorthand for four sides: "0", "8px 16px", "4px 8px 12px", "1px 2px 3px 4px". */
export function sidesShorthand(s: Sides): string {
  const [t, r, b, l] = s.map((v) => (round(v) === 0 ? "0" : px(v)));
  if (l === r) {
    if (t === b) return t === r ? t! : `${t} ${r}`;
    return `${t} ${r} ${b}`;
  }
  return `${t} ${r} ${b} ${l}`;
}

const inset = (r: Rect, s: Sides): Rect => ({
  x: r.x + s[3],
  y: r.y + s[0],
  width: Math.max(0, r.width - s[1] - s[3]),
  height: Math.max(0, r.height - s[0] - s[2]),
});

/** The four boxes of the CSS box model, from the border box and the side widths. Negative margins draw as 0. */
export function boxRects(box: Pick<MeasuredBox, "rect" | "margin" | "border" | "padding">) {
  const m = box.margin.map((v) => Math.max(0, v)) as Sides;
  const margin: Rect = {
    x: box.rect.x - m[3],
    y: box.rect.y - m[0],
    width: box.rect.width + m[1] + m[3],
    height: box.rect.height + m[0] + m[2],
  };
  const padding = inset(box.rect, box.border);
  const content = inset(padding, box.padding);
  return { margin, border: box.rect, padding, content };
}

export const contentSize = (box: Pick<MeasuredBox, "rect" | "margin" | "border" | "padding">) => {
  const c = boxRects(box).content;
  return { width: c.width, height: c.height };
};

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const mid = (a: number, b: number) => (a + b) / 2;

/**
 * Distances from box `a` to box `b`, as VisBug or Page Ruler draw them:
 * apart on an axis → the gap between the facing edges; overlapping on both axes (nested or crossing) →
 * the inset of each edge. Guides run through the middle of the shared span, else through `b`'s center.
 */
export function distanceBetween(a: Rect, b: Rect, names: { a: string; b: string } = { a: "A", b: "B" }): Distance {
  const gaps: Gap[] = [];
  const extensions: Extension[] = [];
  const alignment: Alignment[] = [];
  const xApart = b.x >= right(a) || a.x >= right(b);
  const yApart = b.y >= bottom(a) || a.y >= bottom(b);
  // Where a horizontal guide runs (a y), and a vertical one (an x).
  const yOverlap = !yApart ? mid(Math.max(a.y, b.y), Math.min(bottom(a), bottom(b))) : null;
  const xOverlap = !xApart ? mid(Math.max(a.x, b.x), Math.min(right(a), right(b))) : null;
  const gy = yOverlap ?? mid(b.y, bottom(b));
  const gx = xOverlap ?? mid(b.x, right(b));
  /** A dashed line from the nearest edge of `r` (on the other axis) to the guide, when the guide misses `r`. */
  const extend = (r: Rect, axis: "x" | "y", at: number, edge: number) => {
    if (axis === "x") {
      if (gy < r.y) extensions.push({ x1: edge, y1: r.y, x2: edge, y2: gy });
      else if (gy > bottom(r)) extensions.push({ x1: edge, y1: bottom(r), x2: edge, y2: gy });
    } else if (gx < r.x) extensions.push({ x1: r.x, y1: edge, x2: gx, y2: edge });
    else if (gx > right(r)) extensions.push({ x1: right(r), y1: edge, x2: gx, y2: edge });
    return at;
  };

  if (xApart) {
    const aFirst = right(a) <= b.x;
    const from = aFirst ? right(a) : right(b);
    const to = aFirst ? b.x : a.x;
    extend(a, "x", gy, aFirst ? right(a) : a.x);
    gaps.push({
      id: "x",
      axis: "x",
      kind: "gap",
      value: round(to - from),
      between: aFirst ? `right edge of ${names.a} → left edge of ${names.b}` : `right edge of ${names.b} → left edge of ${names.a}`,
      x1: from,
      y1: gy,
      x2: to,
      y2: gy,
    });
  }
  if (yApart) {
    const aFirst = bottom(a) <= b.y;
    const from = aFirst ? bottom(a) : bottom(b);
    const to = aFirst ? b.y : a.y;
    extend(a, "y", gx, aFirst ? bottom(a) : a.y);
    gaps.push({
      id: "y",
      axis: "y",
      kind: "gap",
      value: round(to - from),
      between: aFirst ? `bottom edge of ${names.a} → top edge of ${names.b}` : `bottom edge of ${names.b} → top edge of ${names.a}`,
      x1: gx,
      y1: from,
      x2: gx,
      y2: to,
    });
  }
  if (xApart && !yApart) alignment.push({ axis: "y", start: round(b.y - a.y), end: round(bottom(b) - bottom(a)) });
  if (yApart && !xApart) alignment.push({ axis: "x", start: round(b.x - a.x), end: round(right(b) - right(a)) });

  let relation: Distance["relation"] = "apart";
  if (!xApart && !yApart) {
    const inside = b.x >= a.x && right(b) <= right(a) && b.y >= a.y && bottom(b) <= bottom(a);
    const contains = a.x >= b.x && right(a) <= right(b) && a.y >= b.y && bottom(a) <= bottom(b);
    relation = inside ? "inside" : contains ? "contains" : "overlap";
    const edges: [GapEdge, number, number][] = [
      ["left", a.x, b.x],
      ["right", right(a), right(b)],
      ["top", a.y, b.y],
      ["bottom", bottom(a), bottom(b)],
    ];
    for (const [edge, ea, eb] of edges) {
      const value = round(Math.abs(eb - ea));
      if (value === 0) continue;
      const axis = edge === "left" || edge === "right" ? "x" : "y";
      const lo = Math.min(ea, eb);
      const hi = Math.max(ea, eb);
      gaps.push({
        id: edge,
        axis,
        kind: "inset",
        value,
        between: `${edge} edge of ${names.a} → ${edge} edge of ${names.b}`,
        ...(axis === "x" ? { x1: lo, y1: gy, x2: hi, y2: gy } : { x1: gx, y1: lo, x2: gx, y2: hi }),
      });
    }
  }
  return { gaps, extensions, alignment, relation };
}

export const GAP_NAME: Record<string, string> = {
  x: "Horizontal gap",
  y: "Vertical gap",
  left: "Left inset",
  right: "Right inset",
  top: "Top inset",
  bottom: "Bottom inset",
};

const sizeText = (r: Rect) => `${round(r.width)} × ${round(r.height)}`;

export function fontText(f: BoxFont | undefined): string {
  if (!f) return "";
  const family = f.family
    .split(",")[0]!
    .trim()
    .replace(/^["']|["']$/g, "");
  return `${f.size}/${f.lineHeight === "normal" ? "normal" : f.lineHeight} ${family} ${f.weight}`;
}

/** The selector shown for a box: unique selector when there is one, else its label. */
export const boxName = (b: MeasuredBox) => (b.unique ? b.selector : b.label);

/** CSS declarations for one box: size, padding, border, margin, font. */
export function boxCss(b: MeasuredBox): string[] {
  const content = contentSize(b);
  const sized = b.boxSizing === "border-box" ? b.rect : content;
  const lines = [`width: ${px(sized.width)};`, `height: ${px(sized.height)};`];
  if (b.boxSizing === "border-box") lines.push("box-sizing: border-box;");
  lines.push(`padding: ${sidesShorthand(b.padding)};`);
  if (b.border.some((v) => round(v) !== 0)) lines.push(`border-width: ${sidesShorthand(b.border)};`);
  lines.push(`margin: ${sidesShorthand(b.margin)};`);
  if (b.font) {
    const family = b.font.family.split(",")[0]!.trim();
    lines.push(`font: ${b.font.weight} ${b.font.size}/${b.font.lineHeight} ${family};`);
  }
  return lines;
}

/** "Copy": the measurement as CSS-like declarations, with the distances as comments. */
export function measurementCss(m: Measurement): string {
  if (m.kind === "ruler" && m.ruler)
    return `/* Area at ${round(m.ruler.x)}, ${round(m.ruler.y)} */\nwidth: ${px(m.ruler.width)};\nheight: ${px(m.ruler.height)};`;
  const out: string[] = [];
  const block = (b: MeasuredBox) => {
    out.push(`${boxName(b)} {`, ...boxCss(b).map((l) => `  ${l}`), "}");
  };
  if (m.a && m.b && m.distance) {
    out.push(`/* ${boxName(m.a)} → ${boxName(m.b)} */`);
    for (const g of m.distance.gaps) out.push(`/* ${GAP_NAME[g.id]?.toLowerCase()}: ${px(g.value)} (${g.between}) */`);
    block(m.a);
    block(m.b);
  } else if (m.a) block(m.a);
  return out.join("\n");
}

export interface AgentOptions {
  note?: string;
  /** Expected value in px for gap `expectedGap` (default: the first). */
  expected?: number | null;
  expectedGap?: string;
}

const code = (s: string) => `\`${s.replaceAll("`", "'")}\``;

/** "Copy for agent": one sentence a coding agent can act on, then the numbers behind it. */
export function measurementMarkdown(m: Measurement, options: AgentOptions = {}): string {
  const lines: string[] = [];
  const vp = m.viewport;
  const expected =
    options.expected !== undefined && options.expected !== null && Number.isFinite(options.expected) ? options.expected : null;
  if (m.kind === "ruler" && m.ruler) {
    lines.push(
      `## Measured area on ${m.url}`,
      "",
      `- ${px(m.ruler.width)} × ${px(m.ruler.height)} at x ${round(m.ruler.x)}, y ${round(m.ruler.y)} (viewport)`,
    );
    if (expected !== null) lines.push("", `Expected: ${px(expected)}.`);
  } else if (m.a && m.b && m.distance) {
    const gaps = m.distance.gaps;
    const target = gaps.find((g) => g.id === options.expectedGap) ?? gaps[0];
    const a = code(boxName(m.a));
    const b = code(boxName(m.b));
    if (target) {
      const what =
        target.kind === "gap" ? `${GAP_NAME[target.id]!.toLowerCase()} between ${a} and ${b}` : `${target.id} inset of ${b} inside ${a}`;
      let sentence = `The ${what} is ${px(target.value)}`;
      if (expected !== null) {
        const diff = round(target.value - expected);
        sentence +=
          diff === 0
            ? `, as expected (${px(expected)}).`
            : `; expected ${px(expected)} (${px(Math.abs(diff))} too ${diff > 0 ? "wide" : "narrow"}).`;
      } else sentence += ".";
      lines.push(`## Spacing on ${m.url}`, "", sentence, "");
    } else lines.push(`## Spacing on ${m.url}`, "", `${a} and ${b} touch: no gap between them.`, "");
    lines.push(`- From: ${a} (${m.a.label}, ${sizeText(m.a.rect)} px)`);
    lines.push(`- To: ${b} (${m.b.label}, ${sizeText(m.b.rect)} px)`);
    for (const g of gaps) lines.push(`- ${GAP_NAME[g.id]}: ${px(g.value)} (${g.between})`);
    for (const al of m.distance.alignment) {
      const [s, e] = al.axis === "x" ? ["Left", "right"] : ["Top", "bottom"];
      lines.push(
        `- ${s} edges ${al.start === 0 ? "aligned" : `offset by ${px(al.start)}`}, ${e} edges ${al.end === 0 ? "aligned" : `offset by ${px(al.end)}`}`,
      );
    }
    lines.push("", `${a}: ${boxCss(m.a).join(" ")}`, `${b}: ${boxCss(m.b).join(" ")}`);
  } else if (m.a) {
    lines.push(`## Box model on ${m.url}`, "", `${code(boxName(m.a))} (${m.a.label}): ${boxCss(m.a).join(" ")}`);
    if (expected !== null) lines.push("", `Expected: ${px(expected)}.`);
  }
  lines.push("", `Viewport ${vp.width} × ${vp.height} CSS px, device pixel ratio ${round(vp.dpr)}. Values in CSS px.`);
  const zoom = zoomOf(m);
  if (zoom)
    lines.push(
      `These elements sit in CSS \`zoom: ${round(zoom)}\`: values are as drawn on screen; divide by ${round(zoom)} for the stylesheet's.`,
    );
  const note = options.note?.trim();
  if (note) lines.push("", "### What should change", "", note);
  return lines.join("\n");
}

/** The CSS zoom the measured elements sit in, when it is not 1 (the first one found). */
export function zoomOf(m: Measurement): number | null {
  const z = [m.a?.zoom, m.b?.zoom].find((v) => v !== undefined && Math.abs(v - 1) > 0.001);
  return z ?? null;
}

/** Short summary of a measurement for a list or a toast. */
export function measurementSummary(m: Measurement): string {
  if (m.kind === "ruler" && m.ruler) return `Area ${sizeText(m.ruler)}`;
  if (m.a && m.b && m.distance) {
    const g = m.distance.gaps;
    return g.length ? g.map((x) => `${GAP_NAME[x.id]} ${px(x.value)}`).join(" · ") : "Touching";
  }
  if (m.a) return `${m.a.label} ${sizeText(m.a.rect)}`;
  return "";
}
