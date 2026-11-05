import { describe, expect, it } from "vitest";
import { catalogInfo, estimateCost, formatUsd } from "../src/lib/ai/catalog";
import { contextBudget, renderContext } from "../src/lib/ai/context";
import { AI_ACTIONS } from "../src/lib/ai/prompts";

describe("AI context", () => {
  it("cuts the page text to the budget and keeps the other sections", () => {
    const text = "word ".repeat(20_000);
    const out = renderContext(
      {
        url: "https://ex.com",
        title: "Ex",
        page: { title: "Ex", text, readable: true },
        tech: [{ name: "Next.js", category: "Framework", evidence: "window.next" }],
      },
      ["text", "tech"],
      10_000,
    );
    expect(out.length).toBeLessThan(10_500);
    expect(out).toContain("Next.js (Framework)");
    expect(out).toContain("more characters cut");
  });
  it("leaves out parts that were not asked for", () => {
    const out = renderContext({ url: "u", title: "t", selection: "secret" }, ["text"]);
    expect(out).not.toContain("secret");
  });
  it("sizes the budget from the context window", () => {
    expect(contextBudget(200_000, 64_000)).toBe(400_000);
    expect(contextBudget(8_192, 4_096)).toBe(Math.max(8_000, (8_192 - 2730 - 2_000) * 4));
    expect(contextBudget(undefined, undefined)).toBeGreaterThan(8_000);
  });
  it("every action sends at least one part", () => {
    for (const a of AI_ACTIONS) expect(a.parts.length).toBeGreaterThan(0);
  });
});

describe("catalog helpers", () => {
  const models = [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      provider: "anthropic",
      context_length: 1_000_000,
      output_limit: 64_000,
      cost: { input: 3, output: 15 },
      modalities: { input: ["text", "image"], output: ["text"] },
      capabilities: { reasoning: true, tool_call: true },
    },
  ] as never;
  it("maps llm-models entries to llm-connect catalog info", () => {
    expect(catalogInfo(models, "anthropic", "claude-sonnet-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      cost: { input: 3, output: 15 },
    });
    expect(catalogInfo(models, undefined, "claude-sonnet.5")?.name).toBe("Claude Sonnet 5");
    expect(catalogInfo(models, "openai", "gpt-x")).toBeUndefined();
  });
  it("estimates cost per million tokens", () => {
    expect(estimateCost({ input: 3, output: 15 }, 100_000, 2_000)).toBeCloseTo(0.33);
    expect(formatUsd(null)).toBe("unknown");
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
});
