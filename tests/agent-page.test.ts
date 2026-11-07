import { describe, expect, it } from "vitest";
import { demoteHeadings, pageReportMarkdown } from "../src/lib/agent/page";

const bad = "## SEO\nPage: https://a.test/\nResult: 1 problem.\n\n### To fix\n\n1. No title";
const clean = "## Web Vitals\nPage: https://a.test/\nResult: No problem found.";

describe("page report for agents", () => {
  it("tables every area and keeps only the ones with something to fix", () => {
    const md = pageReportMarkdown(
      [
        { area: "SEO", panel: "Inspect › SEO", md: bad },
        { area: "Web Vitals", panel: "Inspect › Performance", md: clean },
        { area: "Accessibility", panel: "Inspect › A11y", md: null, missing: "run the audit" },
      ],
      { url: "https://a.test/", title: "Home | Shop", notCovered: ["broken links (Inspect › Links)"] },
    );
    expect(md).toContain("# Fix list for Home | Shop");
    expect(md).toContain("Result: 1 area to fix, 1 area clean, 1 not measured.");
    expect(md).toContain("| SEO | 1 problem. | Inspect › SEO |");
    expect(md).toContain("| Accessibility | Not measured: run the audit | Inspect › A11y |");
    expect(md).toContain("### To fix\n\n1. No title");
    expect(md).not.toContain("## Web Vitals");
    expect(md).toContain('each has its own "Copy for agent" in devkit): broken links (Inspect › Links).');
  });
  it("lets a report decide by itself whether it has findings", () => {
    const a11y = "## Accessibility audit\nResult: 2 violations\n\n## Violations\n\n### `image-alt`";
    const md = pageReportMarkdown([{ area: "Accessibility", panel: "Inspect › A11y", md: a11y, findings: true }], {
      url: "https://a.test/",
    });
    expect(md).toContain("### `image-alt`");
    expect(md).toContain("# Fix list for https://a.test/");
  });
  it("demotes headings by one level", () => {
    expect(demoteHeadings("# A\n## B\ntext #1")).toBe("## A\n### B\ntext #1");
  });
});
