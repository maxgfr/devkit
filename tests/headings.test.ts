import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headingsMarkdown, hasFindings } from "../src/lib/agent/inspect";
import { pageReportMarkdown } from "../src/lib/agent/page";
import { headingsContext, renderContext } from "../src/lib/ai/context";
import { AI_ACTIONS } from "../src/lib/ai/prompts";
import {
  buildOutline,
  headingIssues,
  headingsVerdict,
  isExposed,
  issuesByHeading,
  levelCounts,
  outlineLines,
  slugify,
  tocHtml,
  tocItems,
  tocMarkdown,
} from "../src/lib/headings";
import { collectHeadings, type HeadingsSnapshot, hideHeadingBadges, type RawHeading, showHeadingBadges } from "../src/lib/page/headings";
import { PANELS } from "../src/lib/panels";

type Draft = Omit<RawHeading, "index" | "selector" | "html"> & Partial<Pick<RawHeading, "selector" | "html">>;
function h(level: number, text: string, extra: Partial<RawHeading> = {}): Draft {
  return {
    level,
    tag: `h${level}`,
    role: false,
    text,
    visibility: "visible",
    top: 0,
    height: 30,
    section: `Text under ${text}.`,
    words: 3,
    ...extra,
  };
}
/** A snapshot of headings in document order: index i, selector `#hi`. */
function snap(headings: Draft[], title = "Acme Mug"): HeadingsSnapshot {
  return {
    url: "https://a.test/",
    title,
    docHeight: 3000,
    viewportHeight: 900,
    headings: headings.map((x, i) => ({
      selector: `#h${i}`,
      html: `<h${x.level} id="h${i}">${x.text}</h${x.level}>`,
      ...x,
      index: i,
      top: i * 100,
    })),
    introWords: 0,
    capped: false,
  };
}
const ids = (s: HeadingsSnapshot) => headingIssues(s).map((i) => i.id);

describe("headings: issues", () => {
  it("passes a clean outline", () => {
    const s = snap([h(1, "Acme Mug"), h(2, "Details"), h(3, "Size"), h(2, "Reviews")]);
    expect(headingIssues(s)).toEqual([]);
    expect(headingsVerdict(headingIssues(s), 4)).toEqual({ level: "good", text: "4 headings, no issue" });
  });
  it("flags a page without headings", () => {
    expect(ids(snap([]))).toEqual(["none"]);
    expect(headingsVerdict([], 0)).toEqual({ level: "bad", text: "No heading" });
  });
  it("flags a missing h1, and names the hidden one", () => {
    expect(ids(snap([h(2, "Details"), h(3, "Size")]))).toContain("no-h1");
    const hidden = headingIssues(snap([h(1, "Acme", { visibility: "hidden" }), h(2, "Details")]));
    expect(hidden[0]).toMatchObject({ id: "no-h1", level: "bad", at: [0] });
    expect(hidden[0]!.detail).toContain("hidden");
    // An sr-only h1 is announced: that is a valid h1.
    expect(ids(snap([h(1, "Acme", { visibility: "sr-only" }), h(2, "Details")]))).not.toContain("no-h1");
  });
  it("flags several h1 with every one of them", () => {
    const issues = headingIssues(snap([h(1, "Acme"), h(2, "Details"), h(1, "Other")]));
    expect(issues.find((i) => i.id === "multiple-h1")).toMatchObject({ level: "warn", label: "2 h1", at: [0, 2] });
  });
  it("flags headings before the h1", () => {
    const issues = headingIssues(snap([h(3, "Menu"), h(1, "Acme"), h(2, "Details")]));
    expect(issues.find((i) => i.id === "first-not-h1")).toMatchObject({ at: [0] });
    expect(ids(snap([h(1, "Acme"), h(2, "Details")]))).not.toContain("first-not-h1");
  });
  it("flags each skipped level with the level expected", () => {
    const issues = headingIssues(snap([h(1, "Acme"), h(2, "Details"), h(4, "Skipped level"), h(2, "Back"), h(5, "Deep")]));
    const skipped = issues.filter((i) => i.id === "skipped-level");
    expect(skipped.map((i) => [i.at[0], i.expected, i.label])).toEqual([
      [2, 3, "Skipped level: h2 → h4"],
      [4, 3, "Skipped level: h2 → h5"],
    ]);
    expect(skipped[1]!.detail).toContain("h3, h4 skipped");
    // Going back up any number of levels is fine.
    expect(ids(snap([h(1, "A"), h(2, "B"), h(3, "C"), h(4, "D"), h(2, "E")]))).toEqual([]);
  });
  it("ignores hidden headings for the structure", () => {
    expect(ids(snap([h(1, "A"), h(3, "Hidden", { visibility: "hidden" }), h(2, "B")]))).toEqual([]);
  });
  it("flags empty headings, unless they have an accessible name", () => {
    expect(headingIssues(snap([h(1, "A"), h(2, "")])).find((i) => i.id === "empty")).toMatchObject({ level: "bad", at: [1] });
    expect(ids(snap([h(1, "A"), h(2, "", { name: "Logo" })]))).not.toContain("empty");
  });
  it("flags role=heading without aria-level", () => {
    const s = snap([h(1, "A"), h(2, "Fake", { tag: "div", role: true, ariaLevelMissing: true })]);
    expect(headingIssues(s).find((i) => i.id === "aria-level-missing")?.detail).toContain("<div>");
  });
  it("flags a visible heading hidden from screen readers", () => {
    const issues = headingIssues(snap([h(1, "A"), h(2, "Shown", { visibility: "aria-hidden" })]));
    expect(issues.find((i) => i.id === "aria-hidden")).toMatchObject({ level: "warn", at: [1] });
  });
  it("flags long and duplicate headings", () => {
    const issues = headingIssues(snap([h(1, "A"), h(2, "x".repeat(130)), h(2, "Pricing"), h(3, "Pricing"), h(2, "pricing!")]));
    expect(issues.find((i) => i.id === "too-long")?.at).toEqual([1]);
    // Same level and same words: h2 "Pricing" and h2 "pricing!", not the h3.
    expect(issues.find((i) => i.id === "duplicate")).toMatchObject({ label: "Same h2 2 times", at: [2, 4] });
  });
  it("notes empty sections only when nothing nests under the heading", () => {
    const issues = headingIssues(
      snap([h(1, "A", { words: 0 }), h(2, "Intro"), h(2, "Empty", { words: 0 }), h(2, "Parent", { words: 0 }), h(3, "Child")]),
    );
    expect(issues.filter((i) => i.id === "empty-section").map((i) => i.at[0])).toEqual([2]);
    expect(issues.find((i) => i.id === "empty-section")?.level).toBe("info");
  });
  it("notes an h1 that shares no word with the title (heuristic)", () => {
    expect(ids(snap([h(1, "Welcome aboard")], "Acme Mug – shop"))).toContain("title-mismatch");
    expect(ids(snap([h(1, "The Acme mug")], "Acme Mug – shop"))).not.toContain("title-mismatch");
    expect(ids(snap([h(1, "Café crème")], "Cafe creme"))).not.toContain("title-mismatch");
  });
  it("sorts problems first and maps them to headings", () => {
    const issues = headingIssues(snap([h(2, "B"), h(4, "D"), h(2, "")]));
    expect(issues.map((i) => i.level)).toEqual(
      [...issues.map((i) => i.level)].sort((a, b) => ["bad", "warn", "info"].indexOf(a) - ["bad", "warn", "info"].indexOf(b)),
    );
    const by = issuesByHeading(issues);
    expect(by.get(1)?.map((i) => i.id)).toEqual(["skipped-level"]);
    expect(headingsVerdict(issues, 3)).toEqual({ level: "bad", text: "2 to fix, 1 to review" });
  });
});

describe("headings: outline", () => {
  it("nests by level and shows skipped levels as gaps", () => {
    const tree = buildOutline(snap([h(1, "A"), h(2, "B"), h(4, "D"), h(2, "E"), h(3, "F")]).headings);
    expect(tree).toHaveLength(1);
    const a = tree[0]!;
    expect(a.heading?.text).toBe("A");
    expect(a.children.map((c) => c.heading?.text)).toEqual(["B", "E"]);
    const gap = a.children[0]!.children[0]!;
    expect(gap.level).toBe(3);
    expect(gap.heading).toBeUndefined();
    expect(gap.children[0]!.heading?.text).toBe("D");
    expect(a.children[1]!.children[0]!.heading?.text).toBe("F");
  });
  it("keeps headings with nothing above them at the top, without gaps", () => {
    const tree = buildOutline(snap([h(3, "Menu"), h(1, "A"), h(2, "B"), h(2, "C"), h(4, "D")]).headings);
    expect(tree.map((n) => n.heading?.text)).toEqual(["Menu", "A"]);
    expect(tree[1]!.children.map((c) => c.heading?.text)).toEqual(["B", "C"]);
    // Below a real heading, the skipped level is shown.
    expect(tree[1]!.children[1]!.children[0]).toMatchObject({ level: 3 });
    expect(tree[1]!.children[1]!.children[0]!.children[0]!.heading?.text).toBe("D");
  });
  it("counts levels and tells what is announced", () => {
    expect(levelCounts([{ level: 1 }, { level: 2 }, { level: 2 }, { level: 6 }])).toEqual([1, 2, 0, 0, 0, 1]);
    expect(isExposed({ visibility: "sr-only" })).toBe(true);
    expect(isExposed({ visibility: "aria-hidden" })).toBe(false);
  });
  it("writes the outline as indented lines with selectors and flags", () => {
    const s = snap([h(1, "A"), h(2, "B", { visibility: "sr-only" }), h(4, "D"), h(2, "", { landmark: "nav", words: 1 })]);
    const lines = outlineLines(s, headingIssues(s), { excerpt: 10 });
    expect(lines[0]).toBe('- h1 "A" `#h0` (3 words)\n  > Text under…');
    expect(lines[1]).toContain('  - h2 "B" `#h1` (visually hidden, announced; 3 words)');
    expect(lines[2]).toContain("    - h4");
    expect(lines[2]).toContain("Skipped level: h2 → h4");
    expect(lines[3]).toContain("  - h2 (empty) `#h3` (in nav; 1 word; Empty h2)");
    expect(outlineLines(s, [], { max: 2 }).at(-1)).toBe("… and 2 more headings.");
  });
});

describe("headings: table of contents", () => {
  it("slugifies like heading anchors usually are", () => {
    expect(slugify("Prix & tarifs : Café crème!")).toBe("prix-tarifs-cafe-creme");
    expect(slugify("!!!")).toBe("section");
  });
  it("keeps ids, proposes unique slugs, skips hidden and deep headings", () => {
    const s = snap([
      h(1, "Acme", { id: "top" }),
      h(2, "Details"),
      h(2, "Details"),
      h(3, "Deep"),
      h(2, "Hidden", { visibility: "sr-only" }),
      h(2, "details-2"),
    ]);
    const items = tocItems(s.headings, 2);
    expect(items.map((i) => [i.anchor, i.depth, i.hasId])).toEqual([
      ["top", 0, true],
      ["details", 1, false],
      ["details-2", 1, false],
      ["details-2-2", 1, false],
    ]);
  });
  it("does not add depth for skipped levels", () => {
    const items = tocItems(snap([h(2, "A"), h(4, "B"), h(3, "C")]).headings);
    expect(items.map((i) => i.depth)).toEqual([0, 1, 1]);
  });
  it("renders Markdown and HTML with escaping", () => {
    const items = tocItems(snap([h(1, "A <b> & [c]", { id: "a" }), h(2, "B"), h(3, "C"), h(2, "D")]).headings);
    expect(tocMarkdown(items)).toBe("- [A \\<b\\> & \\[c\\]](#a)\n  - [B](#b)\n    - [C](#c)\n  - [D](#d)");
    expect(tocHtml(items)).toBe(
      [
        '<nav aria-label="Table of contents">',
        "  <ol>",
        '    <li><a href="#a">A &lt;b&gt; &amp; [c]</a>',
        "      <ol>",
        '        <li><a href="#b">B</a>',
        "          <ol>",
        '            <li><a href="#c">C</a></li>',
        "          </ol>",
        "        </li>",
        '        <li><a href="#d">D</a></li>',
        "      </ol>",
        "    </li>",
        "  </ol>",
        "</nav>",
      ].join("\n"),
    );
    expect(tocHtml([])).toBe("");
  });
});

describe("headings: Copy for agent", () => {
  it("lists problems with selector, HTML and fix, then the outline", () => {
    const s = snap([h(1, "Acme Mug"), h(2, "Details"), h(4, "Skipped level"), h(2, "")]);
    const md = headingsMarkdown(s, { url: s.url });
    expect(md).toMatch(/^## Headings outline\nPage: https:\/\/a\.test\/\nResult: 1 problem, 1 warning/);
    expect(md).toContain("### To fix\n\n1. Empty h2:");
    expect(md).toContain('   - Where: `#h3`: `<h2 id="h3"></h2>`');
    expect(md).toContain("### Worth checking\n\n1. Skipped level: h2 → h4");
    expect(md).toContain("Fix: Change it to an `<h3>`");
    expect(md).toContain("### Outline");
    expect(md).toContain("4 headings, 4 announced by screen readers (h1 ×1, h2 ×2, h4 ×1).");
    expect(md).toContain("To check the fix: Reload the page and refresh devkit's Headings panel");
    expect(hasFindings(md)).toBe(true);
  });
  it("says so when clean, and is not counted as a finding in the page report", () => {
    const s = snap([h(1, "Acme Mug", { id: "a" }), h(2, "Details", { id: "b" })]);
    const md = headingsMarkdown(s, { url: s.url, heading: "##" });
    expect(md).toContain("Result: No problem found.");
    expect(md).not.toContain("without an `id`");
    expect(hasFindings(md)).toBe(false);
    const report = pageReportMarkdown([{ area: "Headings", panel: "Inspect › Headings", md }], { url: s.url });
    expect(report).toContain("| Headings | No problem found. | Inspect › Headings |");
  });
  it("counts the headings nothing can link to", () => {
    const md = headingsMarkdown(snap([h(1, "Acme Mug"), h(2, "Details")]), { url: "https://a.test/" });
    expect(md).toContain("2 visible headings without an `id`");
  });
});

describe("headings: AI", () => {
  it("has the panel and the actions, each sending the outline", () => {
    expect(PANELS.find((p) => p.id === "headings")).toMatchObject({ category: "inspect", short: "Headings" });
    for (const id of ["headings-review", "headings-rewrite", "headings-match", "headings-gaps", "headings-one"]) {
      const a = AI_ACTIONS.find((x) => x.id === id);
      expect(a?.parts).toContain("headings");
    }
    expect(AI_ACTIONS.find((a) => a.id === "headings-one")?.hidden).toBe(true);
    expect(AI_ACTIONS.find((a) => a.id === "fix-plan")?.parts).toContain("headings");
    expect(AI_ACTIONS.find((a) => a.id === "seo-audit")?.parts).toContain("headings");
  });
  it("renders the outline with section openings, the issues and the focus", () => {
    const s = snap([h(1, "Acme Mug"), h(2, "Details", { section: "Ceramic, 350 ml, dishwasher safe." }), h(4, "Skipped level")]);
    const out = headingsContext({ snapshot: s, focus: 2 });
    expect(out).toContain("3 headings, 3 announced by screen readers.");
    expect(out).toContain("> Ceramic, 350 ml, dishwasher safe.");
    expect(out).toContain("- [warn] Skipped level: h2 → h4");
    expect(out).toContain('In focus: the developer asked about the h4 "Skipped level" at `#h2`.');
    const ctx = renderContext(
      {
        url: s.url,
        title: s.title,
        headings: { snapshot: s },
        meta: {
          url: s.url,
          title: s.title,
          lang: "en",
          charset: "UTF-8",
          doctype: "<!DOCTYPE html>",
          meta: [],
          links: [],
          headings: [{ level: 1, text: "Acme Mug" }],
          jsonLd: [],
          microdataTypes: [],
          stats: { elements: 1, scripts: 0, stylesheets: 0, images: 0, iframes: 0, forms: 0, domDepth: 1, htmlBytes: 1 },
        },
      },
      ["headings", "meta"],
    );
    expect(ctx).toContain("## Headings outline (devkit panel: Inspect › Headings)");
    // The meta section does not repeat the headings when the outline is sent.
    expect(ctx).not.toContain("Headings:\n");
    // No focus given: none rendered.
    expect(ctx).not.toContain("In focus");
  });
  it("drops the section openings when there are many headings", () => {
    const many = snap(Array.from({ length: 130 }, (_, i) => h(i ? 2 : 1, `Heading ${i}`)));
    expect(headingsContext({ snapshot: many })).not.toContain("> Text under");
  });
});

describe("headings: in the page", () => {
  // happy-dom has no layout: every box would be 0×0, which the collector reads as hidden.
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 300, 24));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    hideHeadingBadges();
    document.body.innerHTML = "";
    document.title = "";
  });
  it("collects levels, text, names, visibility, landmarks, selectors and sections", () => {
    document.title = "Acme Mug";
    document.body.innerHTML = `
      <p>Intro words here.</p>
      <header><h2 class="logo"><img src="/l.png" alt="Acme logo"></h2></header>
      <main>
        <h1 id="title">  Acme   Mug </h1>
        <p>The best mug. It holds coffee.</p>
        <script>var hidden = "not text";</script>
        <h2 aria-label="Product details">Details</h2>
        <p>Ceramic.</p>
        <h4>Skipped level</h4>
        <div role="heading">Fake heading</div>
        <div role="heading" aria-level="3">Leveled</div>
        <h3 style="display:none">Gone</h3>
        <h3 hidden>Hidden attr</h3>
        <h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Screen readers</h2>
        <div aria-hidden="true"><h2>Decor</h2></div>
        <h2 role="presentation">Not a heading</h2>
        <section><h3>A</h3><h3>B</h3></section>
      </main>
      <nav><h2>Menu</h2><ul><li>Home</li></ul></nav>`;
    const s = collectHeadings();
    const by = (text: string) => s.headings.find((x) => x.text === text || x.name === text)!;
    expect(s.title).toBe("Acme Mug");
    expect(s.introWords).toBe(3);
    expect(s.headings.map((x) => x.text)).not.toContain("Not a heading");
    expect(by("Acme Mug")).toMatchObject({ level: 1, tag: "h1", selector: "#title", landmark: "main", visibility: "visible", words: 6 });
    expect(by("Acme Mug").section).toBe("The best mug. It holds coffee.");
    expect(by("Acme logo")).toMatchObject({ level: 2, text: "", landmark: "header" });
    expect(by("Details").name).toBe("Product details");
    expect(by("Fake heading")).toMatchObject({ level: 2, role: true, tag: "div", ariaLevelMissing: true });
    expect(by("Leveled")).toMatchObject({ level: 3, role: true });
    expect(by("Leveled").ariaLevelMissing).toBeUndefined();
    expect(by("Gone").visibility).toBe("hidden");
    expect(by("Hidden attr").visibility).toBe("hidden");
    expect(by("Screen readers").visibility).toBe("sr-only");
    expect(by("Decor").visibility).toBe("aria-hidden");
    expect(by("Menu")).toMatchObject({ landmark: "nav", words: 1 });
    expect(by("Skipped level").html).toBe("<h4>Skipped level</h4>");
    // Every selector finds its own heading again.
    for (const x of s.headings) {
      const found = document.querySelectorAll(x.selector);
      expect(found.length, x.selector).toBe(1);
      expect((found[0]!.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(x.text);
    }
    expect(s.headings.map((x) => x.index)).toEqual(s.headings.map((_, i) => i));
  });
  it("credits text after a hidden heading to the visible one before it", () => {
    document.body.innerHTML =
      '<h2>Visible</h2><p>One</p><h3 style="display:none">Gone</h3><p>Two three</p><div hidden><h3>Inside</h3><p>Not counted</p></div><p>Four</p>';
    const [visible, gone, inside] = collectHeadings().headings;
    expect(visible).toMatchObject({ text: "Visible", words: 4, section: "One Two three Four" });
    expect(gone).toMatchObject({ visibility: "hidden", words: 0 });
    expect(inside).toMatchObject({ visibility: "hidden", words: 0 });
  });
  it("gives unique selectors deep in the page, and HTML without inner markup", () => {
    const deep = (label: string) =>
      `${"<div>".repeat(12)}<h2 class="t"><!-- c --><svg><path d="M0"/></svg>${label}</h2>${"</div>".repeat(12)}`;
    document.body.innerHTML = `${deep("First")}${deep("Second")}`;
    const [a, b] = collectHeadings().headings;
    for (const x of [a!, b!]) expect(document.querySelectorAll(x.selector)).toHaveLength(1);
    expect(a!.selector.startsWith("body > ")).toBe(true);
    expect(document.querySelector(b!.selector)?.textContent).toBe("Second");
    expect(a!.html).toBe('<h2 class="t">First</h2>');
  });
  it("caps the number of headings", () => {
    document.body.innerHTML = Array.from({ length: 12 }, (_, i) => `<h2>H${i}</h2>`).join("");
    const s = collectHeadings(10);
    expect(s.headings).toHaveLength(10);
    expect(s.capped).toBe(true);
  });
  it("draws badges in a host of its own and removes them", () => {
    document.body.innerHTML = '<h1 id="a">A</h1><h2>B</h2>';
    expect(
      showHeadingBadges([
        { selector: "#a", label: "H1", bad: false },
        { selector: "#nope", label: "H2", bad: true },
        { selector: "[", label: "x", bad: false },
      ]),
    ).toBe(1);
    expect(document.querySelectorAll("devkit-headings")).toHaveLength(1);
    // Showing again replaces the set.
    showHeadingBadges([{ selector: "#a", label: "H1", bad: false }]);
    expect(document.querySelectorAll("devkit-headings")).toHaveLength(1);
    expect(hideHeadingBadges()).toBe(true);
    expect(document.querySelector("devkit-headings")).toBeNull();
    expect(hideHeadingBadges()).toBe(false);
  });
  it("is ignored by its own section walk", () => {
    document.body.innerHTML = '<h1 id="a">A</h1><p>One two</p>';
    showHeadingBadges([{ selector: "#a", label: "H1 label text", bad: false }]);
    expect(collectHeadings().headings[0]!.words).toBe(2);
  });
});
