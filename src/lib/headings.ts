// The page's heading outline: tree, problems, verdict and table of contents. Pure: the collector is in page/headings.ts.
import type { Level } from "./headers";
import type { HeadingsSnapshot, RawHeading } from "./page/headings";

export type HeadingIssueId =
  | "none"
  | "no-h1"
  | "multiple-h1"
  | "first-not-h1"
  | "skipped-level"
  | "empty"
  | "aria-level-missing"
  | "aria-hidden"
  | "too-long"
  | "duplicate"
  | "empty-section"
  | "title-mismatch";

export interface HeadingIssue {
  id: HeadingIssueId;
  level: Level;
  label: string;
  detail: string;
  /** The headings it is about (indexes in the snapshot), first one first. */
  at: number[];
  /** For skipped levels: the level the heading should have. */
  expected?: number;
}

/** Announced by screen readers: what the outline and the structure checks are about. */
export const isExposed = (h: Pick<RawHeading, "visibility">) => h.visibility === "visible" || h.visibility === "sr-only";

/** What a heading says: its text, else its accessible name. */
export const headingText = (h: Pick<RawHeading, "text" | "name">) => h.text || h.name || "";

export const LONG_HEADING = 120;

/** Session storage key of the heading the developer asked the AI about, read once by the next AI call on that tab. */
export const HEADINGS_FOCUS_KEY = "headingsFocus";

export interface HeadingsFocus {
  tabId: number;
  url: string;
  index: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const STOP = new Set(
  "the and for with from your our you are this that how what why who when where into over a an of to in on at by is be it its le la les des du de et en un une pour avec sur dans par au aux der die das und mit von el los las del y con por para".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set(
    norm(s)
      .split(" ")
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

export function headingIssues(snap: Pick<HeadingsSnapshot, "headings" | "title">): HeadingIssue[] {
  const out: HeadingIssue[] = [];
  const all = snap.headings;
  const exposed = all.filter(isExposed);
  if (!all.length) {
    out.push({ id: "none", level: "bad", label: "No heading", detail: "The page has no h1–h6 nor role=heading.", at: [] });
    return out;
  }
  const h1 = exposed.filter((h) => h.level === 1);
  if (!h1.length) {
    const hiddenH1 = all.find((h) => h.level === 1);
    out.push({
      id: "no-h1",
      level: "bad",
      label: "No h1",
      detail: hiddenH1
        ? `The only h1 is ${hiddenH1.visibility === "aria-hidden" ? "hidden from screen readers (aria-hidden)" : "hidden"}: "${headingText(hiddenH1).slice(0, 80)}".`
        : "No heading names the page's main topic.",
      at: hiddenH1 ? [hiddenH1.index] : [],
    });
  } else if (h1.length > 1) {
    out.push({
      id: "multiple-h1",
      level: "warn",
      label: `${h1.length} h1`,
      detail: h1
        .map((h) => `"${headingText(h).slice(0, 60)}"`)
        .join(", ")
        .slice(0, 240),
      at: h1.map((h) => h.index),
    });
  }
  const first = exposed[0];
  if (first && first.level !== 1 && h1.length) {
    const before = exposed.slice(0, exposed.indexOf(h1[0]!));
    out.push({
      id: "first-not-h1",
      level: "warn",
      label: "Headings before the h1",
      detail: `${before.length} heading${before.length === 1 ? "" : "s"} come${before.length === 1 ? "s" : ""} before the h1, starting with h${first.level} "${headingText(first).slice(0, 60)}".`,
      at: before.map((h) => h.index),
    });
  }
  for (let i = 1; i < exposed.length; i++) {
    const prev = exposed[i - 1]!;
    const h = exposed[i]!;
    if (h.level > prev.level + 1) {
      const missing = Array.from({ length: h.level - prev.level - 1 }, (_, k) => `h${prev.level + 1 + k}`).join(", ");
      out.push({
        id: "skipped-level",
        level: "warn",
        label: `Skipped level: h${prev.level} → h${h.level}`,
        detail: `"${headingText(h).slice(0, 80)}" follows h${prev.level} "${headingText(prev).slice(0, 60)}" (${missing} skipped).`,
        at: [h.index],
        expected: prev.level + 1,
      });
    }
  }
  for (const h of exposed) {
    if (!headingText(h))
      out.push({
        id: "empty",
        level: "bad",
        label: `Empty h${h.level}`,
        detail: "No text and no accessible name: announced as an empty heading.",
        at: [h.index],
      });
    else if (headingText(h).length > LONG_HEADING)
      out.push({
        id: "too-long",
        level: "warn",
        label: `Long h${h.level}`,
        detail: `${h.text.length >= 200 ? "200+" : headingText(h).length} characters: "${headingText(h).slice(0, 80)}…"`,
        at: [h.index],
      });
  }
  for (const h of all)
    if (h.ariaLevelMissing && isExposed(h))
      out.push({
        id: "aria-level-missing",
        level: "warn",
        label: 'role="heading" without aria-level',
        detail: `<${h.tag}> "${headingText(h).slice(0, 60)}" is announced as level 2.`,
        at: [h.index],
      });
  for (const h of all)
    if (h.visibility === "aria-hidden")
      out.push({
        id: "aria-hidden",
        level: "warn",
        label: `Visible h${h.level} hidden from screen readers`,
        detail: `"${headingText(h).slice(0, 80)}" is on screen but under aria-hidden="true".`,
        at: [h.index],
      });
  const groups = new Map<string, RawHeading[]>();
  for (const h of exposed) {
    const key = `${h.level}:${norm(headingText(h))}`;
    if (!norm(headingText(h))) continue;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const g of groups.values())
    if (g.length > 1)
      out.push({
        id: "duplicate",
        level: "warn",
        label: `Same h${g[0]!.level} ${g.length} times`,
        detail: `"${headingText(g[0]!).slice(0, 80)}"`,
        at: g.map((h) => h.index),
      });
  for (let i = 0; i < exposed.length; i++) {
    const h = exposed[i]!;
    const next = exposed[i + 1];
    // A heading that only introduces sub-headings has no text of its own: only report it when nothing follows under it.
    if (h.words === 0 && h.visibility === "visible" && headingText(h) && (!next || next.level <= h.level))
      out.push({
        id: "empty-section",
        level: "info",
        label: `Empty section under h${h.level}`,
        detail: `"${headingText(h).slice(0, 80)}" is followed by ${next ? `h${next.level} "${headingText(next).slice(0, 60)}"` : "the end of the page"} with no text in between.`,
        at: [h.index],
      });
  }
  if (h1.length === 1 && snap.title.trim()) {
    const a = words(headingText(h1[0]!));
    const b = words(snap.title);
    if (a.size && b.size && ![...a].some((w) => b.has(w)))
      out.push({
        id: "title-mismatch",
        level: "info",
        label: "h1 and <title> share no word",
        detail: `h1 "${headingText(h1[0]!).slice(0, 60)}" vs title "${snap.title.trim().slice(0, 60)}" (heuristic: they usually name the same topic).`,
        at: [h1[0]!.index],
      });
  }
  const rank: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

/** Issues by heading index, worst first. */
export function issuesByHeading(issues: HeadingIssue[]): Map<number, HeadingIssue[]> {
  const m = new Map<number, HeadingIssue[]>();
  for (const issue of issues) for (const i of issue.at) m.set(i, [...(m.get(i) ?? []), issue]);
  return m;
}

export interface OutlineNode {
  /** Absent on a gap: a level skipped between the parent and its children. */
  heading?: RawHeading;
  level: number;
  children: OutlineNode[];
}

/**
 * Nests headings by level; a skipped level shows as a gap node ("h3 missing") between a heading and the one under it.
 * Headings with nothing above them sit at the top whatever their level: the h1 checks already cover a missing h1.
 */
export function buildOutline(headings: RawHeading[]): OutlineNode[] {
  const root: OutlineNode = { level: 0, children: [] };
  const stack: OutlineNode[] = [root];
  for (const h of headings) {
    while (stack.length > 1 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    let parent = stack[stack.length - 1]!;
    for (let l = parent.level + 1; parent !== root && l < h.level; l++) {
      const gap: OutlineNode = { level: l, children: [] };
      parent.children.push(gap);
      stack.push(gap);
      parent = gap;
    }
    const node: OutlineNode = { heading: h, level: h.level, children: [] };
    parent.children.push(node);
    stack.push(node);
  }
  return root.children;
}

/** Headings per level, h1 first. */
export function levelCounts(headings: Pick<RawHeading, "level">[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const h of headings) counts[h.level - 1]! += 1;
  return counts;
}

export function headingsVerdict(issues: Pick<HeadingIssue, "level" | "id">[], total: number): { level: Level; text: string } {
  if (!total) return { level: "bad", text: "No heading" };
  const bad = issues.filter((i) => i.level === "bad").length;
  const warn = issues.filter((i) => i.level === "warn").length;
  if (!bad && !warn) return { level: "good", text: `${total} heading${total === 1 ? "" : "s"}, no issue` };
  return {
    level: bad ? "bad" : "warn",
    text: [bad ? `${bad} to fix` : "", warn ? `${warn} to review` : ""].filter(Boolean).join(", "),
  };
}

/* Table of contents */

/** A URL fragment for a heading without id: lowercase words joined by dashes, accents dropped. */
export function slugify(text: string): string {
  return (
    norm(text)
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "section"
  );
}

export interface TocItem {
  level: number;
  /** Nesting depth in the table (0 = top), skipped levels do not add depth. */
  depth: number;
  text: string;
  /** The heading's id, or a proposed slug when it has none. */
  anchor: string;
  hasId: boolean;
  index: number;
}

/** Visible headings down to `maxLevel`, with their anchors; slugs are proposed (and kept unique) for headings without id. */
export function tocItems(headings: RawHeading[], maxLevel = 6): TocItem[] {
  const used = new Set(headings.map((h) => h.id).filter(Boolean) as string[]);
  const stack: number[] = [];
  const out: TocItem[] = [];
  for (const h of headings) {
    if (h.visibility !== "visible" || h.level > maxLevel || !headingText(h)) continue;
    while (stack.length && stack[stack.length - 1]! >= h.level) stack.pop();
    const depth = stack.length;
    stack.push(h.level);
    let anchor = h.id ?? "";
    if (!anchor) {
      const base = slugify(headingText(h));
      anchor = base;
      for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
      used.add(anchor);
    }
    out.push({ level: h.level, depth, text: headingText(h), anchor, hasId: Boolean(h.id), index: h.index });
  }
  return out;
}

const mdText = (s: string) => s.replace(/([\\[\]*_`<>])/g, "\\$1");
const htmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function tocMarkdown(items: TocItem[]): string {
  return items.map((it) => `${"  ".repeat(it.depth)}- [${mdText(it.text)}](#${encodeURI(it.anchor)})`).join("\n");
}

export function tocHtml(items: TocItem[]): string {
  if (!items.length) return "";
  type Node = { item: TocItem; children: Node[] };
  const root: Node[] = [];
  const stack: Node[] = [];
  for (const item of items) {
    const node: Node = { item, children: [] };
    stack.length = Math.min(stack.length, item.depth);
    (stack.length ? stack[stack.length - 1]!.children : root).push(node);
    stack.push(node);
  }
  const render = (nodes: Node[], indent: string): string[] => [
    `${indent}<ol>`,
    ...nodes.flatMap((n) => {
      const link = `<a href="#${htmlText(encodeURI(n.item.anchor))}">${htmlText(n.item.text)}</a>`;
      return n.children.length
        ? [`${indent}  <li>${link}`, ...render(n.children, `${indent}    `), `${indent}  </li>`]
        : [`${indent}  <li>${link}</li>`];
    }),
    `${indent}</ol>`,
  ];
  return ['<nav aria-label="Table of contents">', ...render(root, "  "), "</nav>"].join("\n");
}

const VIS_NOTE: Record<RawHeading["visibility"], string> = {
  visible: "",
  "sr-only": "visually hidden, announced",
  "aria-hidden": "on screen, not announced (aria-hidden)",
  hidden: "hidden",
};

/** The outline as indented lines, for coding agents and the AI: level, text, selector, flags and, optionally, the section's opening. */
export function outlineLines(
  snap: Pick<HeadingsSnapshot, "headings">,
  issues: HeadingIssue[],
  opts: { max?: number; excerpt?: number; hidden?: boolean } = {},
): string[] {
  const { max = 120, excerpt = 0, hidden = true } = opts;
  const byHeading = issuesByHeading(issues);
  const list = snap.headings.filter((h) => hidden || isExposed(h));
  const stack: number[] = [];
  const out = list.slice(0, max).map((h) => {
    while (stack.length && stack[stack.length - 1]! >= h.level) stack.pop();
    const depth = stack.length;
    stack.push(h.level);
    const flags = [
      h.role ? `role=heading on <${h.tag}>` : "",
      VIS_NOTE[h.visibility],
      h.landmark && h.landmark !== "main" ? `in ${h.landmark}` : "",
      `${h.words} word${h.words === 1 ? "" : "s"}`,
      ...(byHeading.get(h.index) ?? []).filter((i) => i.level !== "info" || i.id === "empty-section").map((i) => i.label),
    ].filter(Boolean);
    const text = headingText(h) ? `"${headingText(h).slice(0, 140)}"` : "(empty)";
    const section =
      excerpt && h.section ? `\n${"  ".repeat(depth + 1)}> ${h.section.slice(0, excerpt)}${h.section.length > excerpt ? "…" : ""}` : "";
    return `${"  ".repeat(depth)}- h${h.level} ${text} \`${h.selector}\` (${flags.join("; ")})${section}`;
  });
  if (list.length > max) out.push(`… and ${list.length - max} more headings.`);
  return out;
}
