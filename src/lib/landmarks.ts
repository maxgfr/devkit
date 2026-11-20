// The page's ARIA landmarks: tree, problems and text outline. Pure: the collector is in page/landmarks.ts.
import type { Level } from "./headers";
import { buildOutline, headingText, isExposed, type OutlineNode } from "./headings";
import type { RawHeading } from "./page/headings";
import type { LandmarksSnapshot, RawLandmark } from "./page/landmarks";

export type LandmarkIssueId =
  | "no-main"
  | "multiple-main"
  | "multiple-banner"
  | "multiple-contentinfo"
  | "not-top-level"
  | "not-unique"
  | "aria-hidden"
  | "hidden"
  | "redundant-role"
  | "outside";

export interface LandmarkIssue {
  id: LandmarkIssueId;
  level: Level;
  label: string;
  detail: string;
  /** The landmarks it is about (indexes in the snapshot), first one first. */
  at: number[];
  /** For "outside": the headings left out of every landmark. */
  headings?: number[];
}

/** Announced by screen readers and reachable by landmark navigation. */
export const isLandmarkExposed = (l: Pick<RawLandmark, "visibility">) => l.visibility === "visible";

/** HeadingsMap style: "Breadcrumbs [navigation]", or "main [main]" when it has no name. */
export const landmarkLabel = (l: Pick<RawLandmark, "role" | "name">) => `${l.name || l.role} [${l.role}]`;

/** What the markup says: the tag when it gives the role ("nav"), else the role ("navigation" on a div). */
export const landmarkTag = (l: Pick<RawLandmark, "tag" | "role" | "explicitRole">) =>
  l.explicitRole && !["header", "footer", "nav", "main", "aside", "form", "section", "search"].includes(l.tag) ? l.role : l.tag;

const quoted = (l: RawLandmark) => (l.name ? `"${l.name.slice(0, 60)}"` : "unnamed");
const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function landmarkIssues(snap: Pick<LandmarksSnapshot, "landmarks" | "headingsOutside">, headings?: RawHeading[]): LandmarkIssue[] {
  const out: LandmarkIssue[] = [];
  const all = snap.landmarks;
  const exposed = all.filter(isLandmarkExposed);
  const of = (role: RawLandmark["role"]) => exposed.filter((l) => l.role === role);

  const mains = of("main");
  if (!mains.length)
    out.push({
      id: "no-main",
      level: "warn",
      label: "No main landmark",
      detail: all.some((l) => l.role === "main")
        ? "The only <main> is hidden from screen readers: they cannot jump to the content."
        : "No <main> nor role=main: screen reader users cannot jump past the header to the content.",
      at: all.filter((l) => l.role === "main").map((l) => l.index),
    });
  else if (mains.length > 1)
    out.push({
      id: "multiple-main",
      level: "warn",
      label: `${mains.length} main landmarks`,
      detail: "A page has one main landmark; hide the others (hidden attribute) when they are not the current view.",
      at: mains.map((l) => l.index),
    });
  for (const [role, id, tag] of [
    ["banner", "multiple-banner", "header"],
    ["contentinfo", "multiple-contentinfo", "footer"],
  ] as const) {
    const top = of(role).filter((l) => l.parent < 0);
    if (top.length > 1)
      out.push({
        id,
        level: "warn",
        label: `${top.length} top-level ${role} landmarks`,
        detail: `A page has one ${role} (its site-wide <${tag}>); ${top.map(quoted).join(", ")}.`,
        at: top.map((l) => l.index),
      });
  }
  for (const l of exposed)
    if (l.parent >= 0 && (l.role === "main" || l.role === "banner" || l.role === "contentinfo")) {
      const p = all[l.parent];
      out.push({
        id: "not-top-level",
        level: "warn",
        label: `${l.role} inside another landmark`,
        detail: `<${l.tag}> ${landmarkLabel(l)} sits inside ${p ? landmarkLabel(p) : "another landmark"}: ${l.role} belongs at the top of the page.`,
        at: [l.index],
      });
    }
  // Same role, same name (or no name): a screen reader's landmarks list cannot tell them apart. main, banner and
  // contentinfo have their own checks above.
  const groups = new Map<string, RawLandmark[]>();
  for (const l of exposed) {
    if (l.role === "main" || l.role === "banner" || l.role === "contentinfo") continue;
    const key = `${l.role}:${norm(l.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const g of groups.values())
    if (g.length > 1) {
      const first = g[0]!;
      out.push({
        id: "not-unique",
        level: "warn",
        label: first.name ? `${g.length} ${first.role} named "${first.name.slice(0, 40)}"` : `${g.length} unnamed ${first.role}`,
        detail: `Give each ${first.role} landmark a distinct aria-label (or aria-labelledby), e.g. "Main menu" and "Footer links".`,
        at: g.map((l) => l.index),
      });
    }
  for (const l of all)
    if (l.visibility === "aria-hidden")
      out.push({
        id: "aria-hidden",
        level: "warn",
        label: `Visible ${l.role} hidden from screen readers`,
        detail: `${landmarkLabel(l)} is on screen but under aria-hidden="true".`,
        at: [l.index],
      });
  const hidden = all.filter((l) => l.visibility === "hidden");
  if (hidden.length)
    out.push({
      id: "hidden",
      level: "info",
      label: `${hidden.length} hidden landmark${hidden.length === 1 ? "" : "s"}`,
      detail: `${hidden
        .slice(0, 4)
        .map((l) => landmarkLabel(l))
        .join(", ")}${hidden.length > 4 ? ", …" : ""}: not announced; fine for a closed menu or dialog.`,
      at: hidden.map((l) => l.index),
    });
  for (const l of all)
    if (l.redundantRole)
      out.push({
        id: "redundant-role",
        level: "info",
        label: `Redundant role="${l.role}"`,
        detail: `<${l.tag} role="${l.role}"> ${landmarkLabel(l)}: the tag already gives that role.`,
        at: [l.index],
      });
  const outside = headings ? snap.headingsOutside.filter((i) => headings[i] && isExposed(headings[i]!)) : snap.headingsOutside;
  if (outside.length && all.length) {
    const named = headings
      ? outside
          .slice(0, 3)
          .map((i) => `h${headings[i]!.level} "${headingText(headings[i]!).slice(0, 50)}"`)
          .join(", ")
      : "";
    out.push({
      id: "outside",
      level: "info",
      label: `${outside.length} heading${outside.length === 1 ? "" : "s"} outside landmarks`,
      detail: `${named ? `${named}${outside.length > 3 ? ", …" : ""}: ` : ""}landmark navigation skips ${outside.length === 1 ? "it" : "them"}; put the content in <main> or another landmark.`,
      at: [],
      headings: outside,
    });
  }
  const rank: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

/** Issues by landmark index, worst first. */
export function issuesByLandmark(issues: LandmarkIssue[]): Map<number, LandmarkIssue[]> {
  const m = new Map<number, LandmarkIssue[]>();
  for (const issue of issues) for (const i of issue.at) m.set(i, [...(m.get(i) ?? []), issue]);
  return m;
}

export interface LandmarkNode {
  landmark: RawLandmark;
  children: LandmarkNode[];
}

/** The nearest ancestor kept by `keep`, -1 when none. */
function keptParent(all: RawLandmark[], l: RawLandmark, keep: (l: RawLandmark) => boolean): number {
  for (let p = l.parent; p >= 0; p = all[p]?.parent ?? -1) if (all[p] && keep(all[p]!)) return p;
  return -1;
}

/** Nests landmarks under their nearest landmark ancestor; the ones `keep` drops are skipped and their children lifted. */
export function buildLandmarkTree(
  snap: Pick<LandmarksSnapshot, "landmarks">,
  keep: (l: RawLandmark) => boolean = () => true,
): LandmarkNode[] {
  const all = snap.landmarks;
  const nodes = new Map<number, LandmarkNode>();
  const roots: LandmarkNode[] = [];
  for (const l of all) {
    if (!keep(l)) continue;
    const node: LandmarkNode = { landmark: l, children: [] };
    nodes.set(l.index, node);
    const p = keptParent(all, l, keep);
    (p >= 0 ? nodes.get(p)!.children : roots).push(node);
  }
  return roots;
}

export type CombinedNode =
  | { kind: "landmark"; landmark: RawLandmark; children: CombinedNode[] }
  | { kind: "heading"; node: OutlineNode }
  | { kind: "outside"; children: CombinedNode[] };

/**
 * Landmarks with their headings nested under them, in document order: each run of headings between two child
 * landmarks is an outline of its own. Headings in no kept landmark go under an "outside" node at the end.
 */
export function buildCombinedTree(
  snap: Pick<LandmarksSnapshot, "landmarks" | "headingsOutside">,
  headings: RawHeading[],
  keep: (l: RawLandmark) => boolean = () => true,
): CombinedNode[] {
  const all = snap.landmarks;
  const shown = new Map(headings.map((h) => [h.index, h] as const));
  const owner = new Map<number, number>();
  for (const l of all)
    for (const i of l.headingIndexes) {
      if (!shown.has(i)) continue;
      owner.set(i, keep(l) ? l.index : keptParent(all, l, keep));
    }
  const direct = new Map<number, number[]>();
  const outside: number[] = [];
  for (const h of headings) {
    const o = owner.get(h.index) ?? -1;
    if (o < 0) outside.push(h.index);
    else direct.set(o, [...(direct.get(o) ?? []), h.index]);
  }
  const kids = new Map<number, RawLandmark[]>();
  const roots: RawLandmark[] = [];
  for (const l of all) {
    if (!keep(l)) continue;
    const p = keptParent(all, l, keep);
    if (p < 0) roots.push(l);
    else kids.set(p, [...(kids.get(p) ?? []), l]);
  }
  const outline = (idx: number[]): CombinedNode[] => buildOutline(idx.map((i) => shown.get(i)!)).map((node) => ({ kind: "heading", node }));
  const content = (landmarks: RawLandmark[], own: number[]): CombinedNode[] => {
    // A heading comes before a landmark when its index is below the landmark's first following heading.
    type Item = { key: number; landmark?: RawLandmark; heading?: number };
    const items: Item[] = [
      ...landmarks.map((l) => ({ key: l.headingStart - 0.5, landmark: l })),
      ...own.map((i) => ({ key: i, heading: i })),
    ].sort((a, b) => a.key - b.key);
    const out: CombinedNode[] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length) out.push(...outline(run));
      run = [];
    };
    for (const it of items) {
      if (it.heading !== undefined) run.push(it.heading);
      else {
        flush();
        const l = it.landmark!;
        out.push({ kind: "landmark", landmark: l, children: content(kids.get(l.index) ?? [], direct.get(l.index) ?? []) });
      }
    }
    flush();
    return out;
  };
  const tree = content(roots, []);
  if (outside.length) tree.push({ kind: "outside", children: outline(outside) });
  return tree;
}

/** The landmarks as text, 4 spaces per level: "main [main]", "    Breadcrumbs [navigation]". Hidden ones only when asked. */
export function landmarksOutline(snap: Pick<LandmarksSnapshot, "landmarks">, opts: { hidden?: boolean; selectors?: boolean } = {}): string {
  const tree = buildLandmarkTree(snap, (l) => Boolean(opts.hidden) || isLandmarkExposed(l));
  const lines: string[] = [];
  const walk = (nodes: LandmarkNode[], depth: number) => {
    for (const n of nodes) {
      const l = n.landmark;
      const flags = [l.visibility !== "visible" ? l.visibility : "", opts.selectors ? l.selector : ""].filter(Boolean);
      lines.push(`${"    ".repeat(depth)}${landmarkLabel(l)}${flags.length ? ` (${flags.join("; ")})` : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return lines.join("\n");
}

export function landmarkFix(issue: LandmarkIssue): string {
  switch (issue.id) {
    case "no-main":
      return "Wrap the page's main content in one `<main>`.";
    case "multiple-main":
      return "Keep one `<main>`; turn the others into `<section aria-label>` or hide the inactive ones with `hidden`.";
    case "multiple-banner":
      return "Keep the site-wide `<header>` at the top; move the others inside `<article>` / `<section>` (where they are not banners) or use a `<div>`.";
    case "multiple-contentinfo":
      return "Keep the site-wide `<footer>` at the top; move the others inside `<article>` / `<section>` or use a `<div>`.";
    case "not-top-level":
      return "Move it out of the landmark it sits in, so it is a direct part of the page.";
    case "not-unique":
      return 'Give each one its own `aria-label`, e.g. `<nav aria-label="Main">` and `<nav aria-label="Footer">`.';
    case "aria-hidden":
      return 'Remove `aria-hidden="true"` from it or its ancestor.';
    case "hidden":
      return "Nothing if it is a closed menu or dialog; otherwise show it.";
    case "redundant-role":
      return "Drop the `role` attribute: the element already has that role.";
    case "outside":
      return "Move these headings and their content into `<main>` (or `<header>`, `<nav>`, `<footer>` …).";
  }
}
