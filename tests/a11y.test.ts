import { describe, expect, it } from "vitest";
import {
  auditContext,
  auditMarkdown,
  auditSummary,
  auditTags,
  compactAudit,
  criteriaText,
  MAX_NODES,
  type RawResults,
  ruleMarkdown,
  ruleStandard,
  sameDocument,
  scopeLabel,
  standardsLabel,
  targetPath,
  trimHtml,
  wcagCriteria,
} from "../src/lib/a11y";
import { renderContext } from "../src/lib/ai/context";

// Shaped like axe-core 4.x results (reporter v2), trimmed to the fields devkit reads.
const raw: RawResults = {
  testEngine: { version: "4.14.0" },
  violations: [
    {
      id: "heading-order",
      impact: "moderate",
      help: "Heading levels should only increase by one",
      description: "Ensure the order of headings is semantically correct",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.14/heading-order",
      tags: ["cat.semantics", "best-practice"],
      nodes: [{ html: "<h4>Skipped level</h4>", target: ["h4"], failureSummary: "Fix any of the following:\n  Heading order invalid" }],
    },
    {
      id: "image-alt",
      impact: "critical",
      help: "Images must have alternative text",
      description: "Ensure <img> elements have alternative text or a role of none or presentation",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.14/image-alt",
      tags: ["cat.text-alternatives", "wcag2a", "wcag111", "section508", "TTv5", "EN-301-549", "ACT"],
      nodes: [
        {
          html: '<img src="/mug.jpg">',
          target: ["img"],
          failureSummary:
            "Fix any of the following:\n  Element does not have an alt attribute\n  aria-label attribute does not exist or is empty",
        },
      ],
    },
    {
      id: "label",
      impact: "critical",
      help: "Form elements must have labels",
      description: "Ensure every form element has a label",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.14/label",
      tags: ["cat.forms", "wcag2a", "wcag412", "wcag131"],
      nodes: [
        { html: '<input name="email">', target: ['input[name="email"]'], failureSummary: "Fix any of the following:\n  No label" },
        { html: "<textarea></textarea>", target: [["my-app", "textarea"]], failureSummary: "Fix any of the following:\n  No label" },
      ],
    },
  ],
  incomplete: [
    {
      id: "color-contrast",
      impact: "serious",
      help: "Elements must meet minimum color contrast ratio thresholds",
      tags: ["cat.color", "wcag2aa", "wcag143"],
      nodes: [{ html: "<p>Over an image</p>", target: ["p"], any: [{ message: "Element's background color could not be determined" }] }],
    },
  ],
  passes: [{ id: "document-title", help: "Documents must have <title> element", nodes: [{}] }],
  inapplicable: [{ id: "video-caption" }, { id: "audio-caption" }],
};

const audit = compactAudit(raw, {
  url: "http://127.0.0.1:4000/",
  at: 1_700_000_000_000,
  ms: 120,
  options: { bestPractices: true, aaa: false },
  scope: null,
  elements: 42,
  iframes: 1,
});

describe("axe options", () => {
  it("runs WCAG 2.0, 2.1 and 2.2 A/AA, with the optional groups", () => {
    expect(auditTags({ bestPractices: false, aaa: false })).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    expect(auditTags({ bestPractices: true, aaa: true })).toEqual(expect.arrayContaining(["wcag2aaa", "best-practice"]));
    expect(standardsLabel({ bestPractices: true, aaa: false })).toBe("WCAG 2.0, 2.1, 2.2 A and AA · best practices");
    expect(standardsLabel({ bestPractices: false, aaa: true })).toBe("WCAG 2.0, 2.1, 2.2 A, AA and AAA (2.0)");
  });
});

describe("compacting axe results", () => {
  it("sorts violations by impact, then by elements", () => {
    expect(audit.violations.map((r) => r.id)).toEqual(["label", "image-alt", "heading-order"]);
    expect(audit.axeVersion).toBe("4.14.0");
    expect(audit.inapplicable).toBe(2);
    expect(audit.passes).toEqual([{ id: "document-title", help: "Documents must have <title> element", nodeCount: 1 }]);
  });
  it("flattens shadow DOM targets and keeps why a check needs review", () => {
    const label = audit.violations[0]!;
    expect(label.nodes.map((n) => n.target)).toEqual([['input[name="email"]'], ["my-app", "textarea"]]);
    expect(audit.incomplete[0]!.nodes[0]!.summary).toBe("Element's background color could not be determined");
  });
  it("caps the nodes kept but counts them all", () => {
    const many = compactAudit(
      {
        violations: [
          {
            id: "x",
            impact: "minor",
            nodes: Array.from({ length: MAX_NODES + 7 }, (_, i) => ({ html: `<a>${i}</a>`, target: [`a${i}`] })),
          },
        ],
      },
      { url: "u", at: 0, ms: 0, options: { bestPractices: true, aaa: false }, scope: null, elements: 0, iframes: 0 },
    );
    expect(many.violations[0]!.nodes).toHaveLength(MAX_NODES);
    expect(many.violations[0]!.nodeCount).toBe(MAX_NODES + 7);
  });
  it("reads targets from frames and labelled shadow selectors", () => {
    expect(targetPath(["iframe", "#in-frame"])).toEqual(["#in-frame"]);
    expect(targetPath([{ fromShadowDom: ["x-a", "button"] }])).toEqual(["x-a", "button"]);
    expect(targetPath(undefined)).toEqual([]);
  });
  it("trims long snippets to one line", () => {
    expect(trimHtml(`<div class="a"\n   id="b">${"x".repeat(400)}</div>`)).toMatch(/^<div class="a" id="b">x+…$/);
    expect(trimHtml("<b>x</b>")).toBe("<b>x</b>");
  });
});

describe("WCAG references", () => {
  it("names the success criteria behind axe tags, in WCAG order", () => {
    expect(wcagCriteria(["wcag412", "wcag131", "wcag2a", "wcag1410"]).map((c) => `${c.sc} ${c.level}`)).toEqual([
      "1.3.1 A",
      "1.4.10 AA",
      "4.1.2 A",
    ]);
    expect(wcagCriteria(["wcag111"])[0]).toMatchObject({
      name: "Non-text Content",
      url: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
    });
    expect(criteriaText(["wcag143"])).toBe("1.4.3 Contrast (Minimum) (AA)");
  });
  it("says where a rule comes from", () => {
    expect(ruleStandard(["cat.forms", "wcag2a", "wcag412"])).toBe("WCAG 2.0 A");
    expect(ruleStandard(["wcag21aa", "wcag1410"])).toBe("WCAG 2.1 AA");
    expect(ruleStandard(["wcag22aa", "wcag258"])).toBe("WCAG 2.2 AA");
    expect(ruleStandard(["cat.semantics", "best-practice"])).toBe("Best practice");
  });
});

describe("summary", () => {
  it("counts violated rules and failing elements by impact", () => {
    const s = auditSummary(audit);
    expect(s.rules).toEqual({ critical: 2, serious: 0, moderate: 1, minor: 0 });
    expect(s.elements.critical).toBe(3);
    expect([s.violations, s.failingElements, s.review, s.passed]).toEqual([3, 4, 1, 1]);
  });
  it("labels the scope and compares pages without their fragment", () => {
    expect(scopeLabel(null)).toBe("Whole page");
    expect(scopeLabel({ selector: "form", shadow: ["my-app"] })).toBe("my-app >>> form");
    expect(sameDocument("https://a.com/p#x", "https://a.com/p")).toBe(true);
    expect(sameDocument("https://a.com/p?q=1", "https://a.com/p")).toBe(false);
  });
});

describe("Markdown for agents", () => {
  it("gives one rule with impact, WCAG refs, selectors, snippets and fixes", () => {
    const md = ruleMarkdown(audit.violations[1]!, { url: audit.url });
    expect(md).toContain("## `image-alt`: Images must have alternative text");
    expect(md).toContain("Impact: critical · WCAG 2.0 A · WCAG 1.1.1 Non-text Content (A)");
    expect(md).toContain("How to fix: https://dequeuniversity.com/rules/axe/4.14/image-alt");
    expect(md).toContain("1. `img`");
    expect(md).toContain('   ```html\n   <img src="/mug.jpg">\n   ```');
    expect(md).toContain("   Fix any of the following:\n   - Element does not have an alt attribute");
  });
  it("gives the whole audit with counts, the honesty note and the review list", () => {
    const md = auditMarkdown(audit, { title: "Acme Mug" });
    expect(md).toMatch(/^# Accessibility audit: Acme Mug\nPage: http:\/\/127\.0\.0\.1:4000\//);
    expect(md).toContain("Result: 3 violations (2 critical, 1 moderate) on 4 elements · 1 rules need review · 1 rules pass");
    expect(md).toContain("Not audited: 1 iframe.");
    expect(md).toContain("manual testing");
    expect(md).toContain("2. `my-app >>> textarea`");
    expect(md).toContain("## Needs review (axe could not decide)");
    expect(md).toContain("### `color-contrast`");
    expect(md.indexOf("`label`")).toBeLessThan(md.indexOf("`heading-order`"));
  });
  it("says when nothing failed", () => {
    expect(auditMarkdown({ ...audit, violations: [], incomplete: [] })).toContain("None found by the automated checks.");
  });
});

describe("AI context", () => {
  it("puts the rule in focus first and keeps the audit", () => {
    const text = auditContext(audit, "heading-order");
    expect(text.startsWith("In focus: the developer asked about `heading-order`.")).toBe(true);
    expect(text).toContain("### Accessibility audit");
    expect(text).toContain("`image-alt`");
  });
  it("renders as the a11y part of the page context", () => {
    const out = renderContext({ url: audit.url, title: "Acme", a11y: { audit } }, ["a11y"]);
    expect(out).toContain("## Accessibility (axe-core audit)");
    expect(out).toContain("`label`: Form elements must have labels");
    expect(renderContext({ url: audit.url, title: "Acme", a11y: { audit } }, ["text"])).not.toContain("axe-core");
  });
});
