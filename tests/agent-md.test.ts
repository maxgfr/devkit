import { describe, expect, it } from "vitest";
import { agentDoc, bySeverity, clip, code, fence, findingList, plural } from "../src/lib/agent-md";

describe("agent Markdown helpers", () => {
  it("quotes code that contains backticks", () => {
    expect(code("a`b")).toBe("``a`b``");
    expect(code("`x`")).toBe("`` `x` ``");
    expect(fence("```js\nx\n```", "md")).toBe("````md\n```js\nx\n```\n````");
  });
  it("clips long values and says how much is left", () => {
    expect(clip("abcdef", 3)).toBe("abc… (3 more characters)");
    expect(clip("abc", 3)).toBe("abc");
  });
  it("orders problems before warnings", () => {
    const levels = bySeverity([{ level: "good" as const }, { level: "warn" as const }, { level: "bad" as const }]).map((x) => x.level);
    expect(levels).toEqual(["bad", "warn", "good"]);
  });
  it("builds a document and drops empty sections", () => {
    const md = agentDoc({
      title: "SEO checks",
      url: "https://a.test/",
      result: plural(2, "problem"),
      sections: [
        { title: "To fix", body: findingList([{ text: "No title", details: ["Add one"] }]) },
        { title: "Empty", body: [] },
      ],
      verify: "reload.",
    });
    expect(md).toBe("## SEO checks\nPage: https://a.test/\nResult: 2 problems\n\n### To fix\n\n1. No title\n   - Add one\n\nTo check the fix: reload.");
  });
});
