import { describe, expect, it } from "vitest";
import type { AuditRule, Impact } from "../src/lib/a11y";
import { analyzeJsonLd } from "../src/lib/jsonld";
import { a11yVerdict, errorsVerdict, jsonLdVerdict, securityVerdict, seoVerdict } from "../src/lib/report";

describe("page report card", () => {
  it("states the security grade and its level", () => {
    expect(securityVerdict({ grade: "C", score: 62 })).toEqual({ level: "warn", text: "Grade C · 62/100" });
    expect(securityVerdict({ grade: "A", score: 95 }).level).toBe("good");
    expect(securityVerdict({ grade: "F", score: 10 }).level).toBe("bad");
  });
  it("counts SEO checks to fix and to review", () => {
    expect(seoVerdict([{ level: "good" }, { level: "info" }])).toEqual({ level: "good", text: "No issue" });
    expect(seoVerdict([{ level: "warn" }, { level: "warn" }])).toEqual({ level: "warn", text: "2 to review" });
    expect(seoVerdict([{ level: "bad" }, { level: "warn" }])).toEqual({ level: "bad", text: "1 to fix, 1 to review" });
  });
  it("summarizes JSON-LD findings", () => {
    expect(jsonLdVerdict(analyzeJsonLd([]))).toEqual({ level: "info", text: "No JSON-LD" });
    expect(jsonLdVerdict(analyzeJsonLd([{ raw: "{", index: 0 }]))).toMatchObject({ level: "bad", text: "1 error in 1 block" });
    expect(jsonLdVerdict({ blocks: [{}, {}] as never, counts: { error: 0, warn: 3, info: 1 } })).toEqual({
      level: "warn",
      text: "3 warnings in 2 blocks",
    });
    expect(jsonLdVerdict({ blocks: [{}] as never, counts: { error: 0, warn: 0, info: 2 } })).toEqual({
      level: "good",
      text: "Valid in 1 block",
    });
  });
  it("counts captured errors, repeats included", () => {
    expect(errorsVerdict({ installed: true, errors: [{ count: 3 }, { count: 1 }] })).toEqual({ level: "bad", text: "4 errors captured" });
    expect(errorsVerdict({ installed: true, errors: [] })).toEqual({ level: "good", text: "None captured" });
    expect(errorsVerdict({ installed: false, errors: [] })).toEqual({ level: "info", text: "Not listening on this page" });
  });
  it("sums up the axe audit: violations, the worst impact, rules to review", () => {
    const rule = (impact: Impact, nodeCount = 1): AuditRule => ({
      id: `r-${impact}`,
      impact,
      help: "",
      description: "",
      helpUrl: "",
      tags: [],
      nodeCount,
      nodes: [],
    });
    const passes = [{ id: "p", help: "", nodeCount: 3 }];
    expect(a11yVerdict({ violations: [], incomplete: [], passes })).toEqual({ level: "good", text: "No automated violation" });
    expect(a11yVerdict({ violations: [], incomplete: [rule("serious")], passes })).toEqual({
      level: "good",
      text: "No automated violation · 1 to review",
    });
    expect(a11yVerdict({ violations: [rule("critical"), rule("moderate", 4)], incomplete: [], passes })).toEqual({
      level: "bad",
      text: "2 violations (1 critical)",
    });
    expect(a11yVerdict({ violations: [rule("moderate"), rule("minor")], incomplete: [rule("minor")], passes })).toEqual({
      level: "warn",
      text: "2 violations · 1 to review",
    });
  });
});
