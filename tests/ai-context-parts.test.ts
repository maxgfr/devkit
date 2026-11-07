import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderContext } from "../src/lib/ai/context";
import { AI_ACTIONS } from "../src/lib/ai/prompts";
import { analyzeLibraries, snapshotDetections, type VulnDb } from "../src/lib/security/libraries";

const db = JSON.parse(readFileSync(join(process.cwd(), "public/vuln-db.json"), "utf8")) as VulnDb;

describe("AI context: what the fix plan sees", () => {
  it("names the devkit panel each section comes from", () => {
    const out = renderContext(
      {
        url: "https://a.test/",
        title: "A",
        headers: { server: "nginx" },
        security: [{ id: "hsts", label: "HSTS", level: "bad", detail: "Missing" }],
      },
      ["headers", "security"],
    );
    expect(out).toContain("## Response headers (document) (devkit panel: Security › Headers)");
    expect(out).toContain("## Security checks (devkit panel: Security › Headers)");
  });
  it("includes the secrets and libraries reports when asked", () => {
    const ctx = {
      url: "https://a.test/",
      title: "A",
      secrets: "## Secrets\nResult: 1 likely leaked credential.",
      libraries: "## Vulnerable libraries (devkit panel: Security › Libraries)\nResult: 1 of 1 detected libraries flagged.",
    };
    const out = renderContext(ctx, ["secrets", "libraries"]);
    expect(out).toContain("## Secrets (devkit panel: Security › Secrets)\nResult: 1 likely leaked credential.");
    expect(out).toContain("## Vulnerable libraries (devkit panel: Security › Libraries)");
    expect(renderContext(ctx, ["headers"])).not.toContain("Secrets");
  });
  it("the fix plan asks for secrets and libraries first", () => {
    const plan = AI_ACTIONS.find((a) => a.id === "fix-plan")!;
    expect(plan.parts.slice(0, 2)).toEqual(["secrets", "libraries"]);
    expect(plan.prompt).toContain("never ask for the full value");
  });
  it("detects libraries from what the page tells, without fetching files", () => {
    const detections = snapshotDetections({ globals: [], scripts: ["https://shop.test/js/jquery-3.4.1.min.js"], inline: [] }, db);
    const [jquery] = analyzeLibraries(detections, db);
    expect(jquery).toMatchObject({ key: "jquery@3.4.1", version: "3.4.1", status: "vulnerable" });
  });
});
