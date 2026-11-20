import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headingsMarkdown } from "../src/lib/agent/inspect";
import {
  buildCombinedTree,
  buildLandmarkTree,
  type CombinedNode,
  issuesByLandmark,
  landmarkIssues,
  landmarkLabel,
  landmarksOutline,
  landmarkTag,
} from "../src/lib/landmarks";
import { collectHeadings } from "../src/lib/page/headings";
import { collectLandmarks, type LandmarksSnapshot, type RawLandmark } from "../src/lib/page/landmarks";
import { PANELS } from "../src/lib/panels";

const GITHUB = `
  <header aria-label="Global navigation menu">
    <h2>Navigation Menu</h2>
    <nav aria-label="Breadcrumbs"><a href="/maxgfr">maxgfr</a> / <a href="/maxgfr/skycmd">skycmd</a></nav>
    <nav aria-label="Repository"><a href="#code">Code</a> <a href="#issues">Issues</a></nav>
  </header>
  <div class="flash"><h2>Skip to content</h2></div>
  <main>
    <h1>skycmd</h1>
    <section aria-labelledby="protect-title"><h2 id="protect-title">Your main branch isn't protected</h2><p>Protect it.</p></section>
    <section><h2>Unnamed section</h2></section>
    <nav aria-label="Repository files"><h2>Folders and files</h2></nav>
    <article><header><h2>README</h2></header><footer>Article footer</footer></article>
  </main>
  <footer>
    <h2>Footer</h2>
    <nav aria-label="Footer"><a href="/terms">Terms</a></nav>
  </footer>`;

const EXPECTED = `Global navigation menu [banner]
    Breadcrumbs [navigation]
    Repository [navigation]
main [main]
    Your main branch isn't protected [region]
    Repository files [navigation]
contentinfo [contentinfo]
    Footer [navigation]`;

const lmOf = (s: LandmarksSnapshot, name: string) => s.landmarks.find((l) => landmarkLabel(l) === name)!;

describe("landmarks: in the page", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 300, 24));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("maps GitHub's structure as browsers do", () => {
    document.body.innerHTML = GITHUB;
    const s = collectLandmarks();
    expect(landmarksOutline(s)).toBe(EXPECTED);
    expect(s.capped).toBe(false);
    expect(s.landmarks.map((l) => l.index)).toEqual(s.landmarks.map((_, i) => i));
    const banner = lmOf(s, "Global navigation menu [banner]");
    expect(banner).toMatchObject({ tag: "header", explicitRole: false, parent: -1, depth: 0, visibility: "visible", top: 10, height: 24 });
    const crumbs = lmOf(s, "Breadcrumbs [navigation]");
    expect(crumbs).toMatchObject({ parent: banner.index, depth: 1 });
    // Every selector finds its own landmark again.
    for (const l of s.landmarks) expect(document.querySelectorAll(l.selector), l.selector).toHaveLength(1);
  });

  it("assigns each heading to its nearest landmark, in collectHeadings' order", () => {
    document.body.innerHTML = GITHUB;
    const s = collectLandmarks();
    const h = collectHeadings().headings;
    const texts = (idx: number[]) => idx.map((i) => h[i]!.text);
    expect(texts(lmOf(s, "Global navigation menu [banner]").headingIndexes)).toEqual(["Navigation Menu"]);
    // The unnamed section and the article's header are no landmarks: their headings belong to main.
    expect(texts(lmOf(s, "main [main]").headingIndexes)).toEqual(["skycmd", "Unnamed section", "README"]);
    expect(texts(lmOf(s, "Your main branch isn't protected [region]").headingIndexes)).toEqual(["Your main branch isn't protected"]);
    expect(texts(lmOf(s, "Repository files [navigation]").headingIndexes)).toEqual(["Folders and files"]);
    expect(texts(s.headingsOutside)).toEqual(["Skip to content"]);
  });

  it("keeps header and footer inside sectioning content out, and needs names for section and form", () => {
    document.body.innerHTML = `
      <article><header>Post header</header><footer>Post footer</footer></article>
      <div role="main"><header>In role=main</header></div>
      <section>No name</section>
      <section title="Titled">Named by title</section>
      <form>No name</form>
      <form aria-label="Sign up"><input></form>
      <aside>Top aside</aside>
      <section aria-label="Box"><aside>Nested unnamed aside</aside><aside aria-label="Related">Named</aside></section>
      <search>Search</search>`;
    expect(landmarksOutline(collectLandmarks())).toBe(
      [
        "main [main]",
        "Titled [region]",
        "Sign up [form]",
        "complementary [complementary]",
        "Box [region]",
        "    Related [complementary]",
        "search [search]",
      ].join("\n"),
    );
  });

  it("lets an explicit role win, and none / presentation remove the landmark", () => {
    document.body.innerHTML = `
      <div role="banner">Banner div</div>
      <nav role="navigation" aria-label="Main">Redundant</nav>
      <nav role="presentation">Removed</nav>
      <header role="none">Removed</header>
      <ul role="navigation" aria-label="Menu"><li>x</li></ul>
      <form role="search">Search form</form>
      <nav role="list">Not a landmark</nav>
      <div role="region">Unnamed region</div>
      <div role="region" aria-label="Named region">Named region</div>`;
    const s = collectLandmarks();
    expect(landmarksOutline(s)).toBe(
      ["banner [banner]", "Main [navigation]", "Menu [navigation]", "search [search]", "Named region [region]"].join("\n"),
    );
    const div = lmOf(s, "banner [banner]");
    expect(div).toMatchObject({ tag: "div", explicitRole: true });
    expect(div.redundantRole).toBeUndefined();
    expect(landmarkTag(div)).toBe("banner");
    const nav = lmOf(s, "Main [navigation]");
    expect(nav.redundantRole).toBe(true);
    expect(landmarkTag(nav)).toBe("nav");
    expect(lmOf(s, "search [search]")).toMatchObject({ tag: "form", explicitRole: true });
    expect(lmOf(s, "search [search]").redundantRole).toBeUndefined();
  });

  it("names from aria-labelledby, then aria-label, then title", () => {
    document.body.innerHTML = `
      <span id="a">First</span><span id="b">  second
      part </span>
      <nav aria-labelledby="a b" aria-label="Ignored" title="Ignored">x</nav>
      <nav aria-labelledby="missing" aria-label=" Label ">x</nav>
      <nav aria-label="" title="From title">x</nav>`;
    expect(collectLandmarks().landmarks.map((l) => l.name)).toEqual(["First second part", "Label", "From title"]);
  });

  it("reads visibility and skips devkit's own overlays", () => {
    document.body.innerHTML = `
      <nav aria-label="Shown">x</nav>
      <nav aria-label="Gone" hidden>x</nav>
      <nav aria-label="None" style="display:none">x</nav>
      <div aria-hidden="true"><nav aria-label="Decor">x</nav></div>
      <devkit-headings><nav aria-label="Ours">x</nav></devkit-headings>`;
    const s = collectLandmarks();
    expect(s.landmarks.map((l) => [l.name, l.visibility])).toEqual([
      ["Shown", "visible"],
      ["Gone", "hidden"],
      ["None", "hidden"],
      ["Decor", "aria-hidden"],
    ]);
    expect(lmOf(s, "Gone [navigation]").top).toBe(0);
    expect(landmarksOutline(s)).toBe("Shown [navigation]");
    expect(landmarksOutline(s, { hidden: true })).toContain("Gone [navigation] (hidden)");
  });

  it("caps the number of landmarks", () => {
    document.body.innerHTML = Array.from({ length: 6 }, (_, i) => `<nav aria-label="N${i}">x</nav>`).join("");
    const s = collectLandmarks(4);
    expect(s.landmarks).toHaveLength(4);
    expect(s.capped).toBe(true);
  });
});

type Draft = Partial<RawLandmark> & Pick<RawLandmark, "role">;
function snap(drafts: Draft[], headingsOutside: number[] = []): LandmarksSnapshot {
  return {
    url: "https://a.test/",
    headingsOutside,
    capped: false,
    landmarks: drafts.map((d, index) => ({
      index,
      tag: {
        banner: "header",
        navigation: "nav",
        main: "main",
        complementary: "aside",
        contentinfo: "footer",
        region: "section",
        search: "search",
        form: "form",
      }[d.role],
      explicitRole: false,
      visibility: "visible",
      selector: `#l${index}`,
      parent: -1,
      depth: 0,
      headingIndexes: [],
      headingStart: 0,
      top: 0,
      height: 10,
      ...d,
    })),
  };
}
const ids = (s: LandmarksSnapshot) => landmarkIssues(s).map((i) => i.id);

describe("landmarks: issues", () => {
  it("finds nothing wrong in a tidy page", () => {
    expect(
      landmarkIssues(snap([{ role: "banner" }, { role: "navigation", parent: 0 }, { role: "main" }, { role: "contentinfo" }])),
    ).toEqual([]);
  });
  it("flags a missing main, and several", () => {
    expect(ids(snap([{ role: "banner" }]))).toContain("no-main");
    expect(landmarkIssues(snap([{ role: "main", visibility: "hidden" }]))[0]).toMatchObject({ id: "no-main", at: [0] });
    const two = landmarkIssues(snap([{ role: "main" }, { role: "main" }]));
    expect(two[0]).toMatchObject({ id: "multiple-main", level: "warn", label: "2 main landmarks", at: [0, 1] });
    // A hidden second main (an inactive view) is fine.
    expect(ids(snap([{ role: "main" }, { role: "main", visibility: "hidden" }]))).not.toContain("multiple-main");
  });
  it("flags several top-level banners and contentinfos, and nested ones", () => {
    const s = snap([
      { role: "banner" },
      { role: "banner" },
      { role: "main" },
      { role: "contentinfo" },
      { role: "contentinfo" },
      { role: "banner", parent: 2, explicitRole: true, tag: "div" },
    ]);
    const issues = landmarkIssues(s);
    expect(issues.find((i) => i.id === "multiple-banner")).toMatchObject({ label: "2 top-level banner landmarks", at: [0, 1] });
    expect(issues.find((i) => i.id === "multiple-contentinfo")?.at).toEqual([3, 4]);
    expect(issues.find((i) => i.id === "not-top-level")).toMatchObject({ label: "banner inside another landmark", at: [5] });
    expect(
      issuesByLandmark(issues)
        .get(5)
        ?.map((i) => i.id),
    ).toEqual(["not-top-level"]);
  });
  it("flags same-role landmarks a screen reader cannot tell apart", () => {
    const issues = landmarkIssues(
      snap([
        { role: "main" },
        { role: "navigation" },
        { role: "navigation" },
        { role: "complementary", name: "Related" },
        { role: "complementary", name: "related " },
        { role: "region", name: "A" },
        { role: "region", name: "B" },
        { role: "navigation", name: "Footer" },
      ]),
    );
    const dup = issues.filter((i) => i.id === "not-unique");
    expect(dup.map((i) => [i.label, i.at])).toEqual([
      ["2 unnamed navigation", [1, 2]],
      ['2 complementary named "Related"', [3, 4]],
    ]);
  });
  it("flags hidden landmarks, redundant roles and headings outside landmarks", () => {
    const issues = landmarkIssues(
      snap(
        [
          { role: "main", explicitRole: true, redundantRole: true },
          { role: "navigation", name: "Decor", visibility: "aria-hidden" },
          { role: "navigation", name: "Menu", visibility: "hidden" },
        ],
        [0, 3],
      ),
    );
    expect(issues.map((i) => [i.id, i.level])).toEqual([
      ["aria-hidden", "warn"],
      ["hidden", "info"],
      ["redundant-role", "info"],
      ["outside", "info"],
    ]);
    expect(issues.find((i) => i.id === "redundant-role")!.label).toBe('Redundant role="main"');
    expect(issues.find((i) => i.id === "outside")).toMatchObject({ label: "2 headings outside landmarks", headings: [0, 3] });
  });
  it("leaves the outside note to pages that use landmarks at all", () => {
    expect(ids(snap([], [0, 1]))).toEqual(["no-main"]);
  });
});

describe("landmarks: trees and outline", () => {
  const s = snap([
    { role: "banner", name: "Top" },
    { role: "navigation", name: "Menu", parent: 0, depth: 1, headingIndexes: [1], headingStart: 1 },
    { role: "main", headingIndexes: [2, 4], headingStart: 2 },
    { role: "region", name: "Box", parent: 2, depth: 1, headingIndexes: [3], headingStart: 3, visibility: "hidden" },
  ]);
  it("labels like HeadingsMap", () => {
    expect(landmarkLabel({ role: "navigation", name: "Breadcrumbs" })).toBe("Breadcrumbs [navigation]");
    expect(landmarkLabel({ role: "main" })).toBe("main [main]");
  });
  it("nests landmarks and lifts the children of dropped ones", () => {
    const tree = buildLandmarkTree(s);
    expect(tree.map((n) => [n.landmark.index, n.children.map((c) => c.landmark.index)])).toEqual([
      [0, [1]],
      [2, [3]],
    ]);
    const lifted = buildLandmarkTree(
      { landmarks: s.landmarks.map((l) => (l.index === 2 ? { ...l, visibility: "hidden" as const } : l)) },
      (l) => l.visibility === "visible",
    );
    expect(lifted.map((n) => n.landmark.index)).toEqual([0]);
    expect(landmarksOutline(s, { hidden: true, selectors: true })).toBe(
      "Top [banner] (#l0)\n    Menu [navigation] (#l1)\nmain [main] (#l2)\n    Box [region] (hidden; #l3)",
    );
  });
  it("nests each landmark's headings in document order, with the others outside", () => {
    const h = (index: number, level: number) => ({
      index,
      level,
      tag: `h${level}`,
      role: false,
      text: `H${index}`,
      visibility: "visible" as const,
      selector: `#h${index}`,
      html: "",
      top: 0,
      height: 10,
      section: "",
      words: 0,
    });
    const headings = [h(0, 2), h(1, 2), h(2, 1), h(3, 2), h(4, 2)];
    const shape = (nodes: CombinedNode[]): unknown[] =>
      nodes.map((n) =>
        n.kind === "heading"
          ? `H${n.node.heading!.index}${n.node.children.length ? `>${n.node.children.map((c) => c.heading!.index).join(",")}` : ""}`
          : n.kind === "outside"
            ? ["outside", shape(n.children)]
            : [n.landmark.index, shape(n.children)],
      );
    const withOutside = { ...s, headingsOutside: [0] };
    // In main: h1 H2, then the region Box (which starts before H3), then H4 under the h1 run.
    expect(shape(buildCombinedTree(withOutside, headings))).toEqual([
      [0, [[1, ["H1"]]]],
      [2, ["H2", [3, ["H3"]], "H4"]],
      ["outside", ["H0"]],
    ]);
    // Box dropped: its heading goes up to main, nested under the h1.
    expect(shape(buildCombinedTree(withOutside, headings, (l) => l.visibility === "visible"))).toEqual([
      [0, [[1, ["H1"]]]],
      [2, ["H2>3,4"]],
      ["outside", ["H0"]],
    ]);
  });
});

describe("landmarks: Copy for agent and the panel", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 300, 24));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });
  it("adds the landmarks and their issues to the headings report", () => {
    document.body.innerHTML = `<nav><h1>Menu</h1></nav><nav><h2>Other</h2></nav><div><h2>Loose</h2></div>`;
    const headings = collectHeadings();
    const lm = collectLandmarks();
    const md = headingsMarkdown(headings, { url: "https://a.test/" }, lm);
    expect(md).toContain("2 ARIA landmarks, as browsers map them (HTML-AAM).");
    expect(md).toContain("No main landmark: ");
    expect(md).toContain("2 unnamed navigation: ");
    expect(md).toContain("Where: `body > nav:nth-of-type(1)` (`<nav>`)");
    expect(md).toContain("Fix: Wrap the page's main content in one `<main>`.");
    expect(md).toContain('1 heading outside landmarks: h2 "Loose"');
    expect(md).toContain("### Landmarks\n\n```\nnavigation [navigation] (body > nav:nth-of-type(1))");
    // Without landmarks, the report stays the headings one.
    expect(headingsMarkdown(headings, { url: "https://a.test/" })).not.toContain("Landmarks");
  });
  it("keeps the panel's id and short label, and finds it by landmark words", () => {
    const p = PANELS.find((x) => x.id === "headings")!;
    expect(p).toMatchObject({ category: "inspect", short: "Headings", title: "Headings & landmarks" });
    for (const w of ["landmarks", "aria", "banner", "navigation", "region", "contentinfo"]) expect(p.keywords).toContain(w);
  });
});
