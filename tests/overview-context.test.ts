import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readinessMarkdown } from "../src/lib/agent/agents";
import { dataLayerMarkdown, hasFindings, landmarksMarkdown } from "../src/lib/agent/inspect";
import { pageReportMarkdown } from "../src/lib/agent/page";
import { dataLayerContext, landmarksContext, type PageContext, readinessContext, renderContext } from "../src/lib/ai/context";
import { AI_ACTIONS } from "../src/lib/ai/prompts";
import { analyzeDataLayer } from "../src/lib/datalayer";
import { analyzeJsonLd } from "../src/lib/jsonld";
import { landmarkIssues } from "../src/lib/landmarks";
import { readDataLayer } from "../src/lib/page/datalayer";
import { collectHeadings } from "../src/lib/page/headings";
import { collectLandmarks } from "../src/lib/page/landmarks";
import type { WebMcpSnapshot } from "../src/lib/page/webmcp";
import { parseLlmsTxt, type ReadinessInputs, readinessScore } from "../src/lib/readiness";
import { dataLayerVerdict, landmarksVerdict, printReportMarkdown, readinessVerdict } from "../src/lib/report";
import { analyzeTools } from "../src/lib/webmcp";

/** `gtag(...)` as the page pushes it: an `arguments` object. */
function args(..._a: unknown[]): IArguments {
  // biome-ignore lint/complexity/noArguments: gtag pushes the arguments object itself
  return arguments;
}

const EMAIL = "sam.smith@example.com";
const PAGE = `
  <header><nav><a href="/">Home</a></nav></header>
  <main><h1>Overview context</h1><p>Text.</p><nav><a href="#a">Aside links</a></nav></main>
  <footer><p>Footer</p></footer>`;

const WEBMCP: WebMcpSnapshot = {
  url: "https://a.test/",
  secureContext: true,
  apis: {
    document: { present: false, methods: [] },
    navigator: { present: false, methods: [] },
    testing: { present: true, methods: ["listTools", "executeTool"] },
  },
  enumerable: true,
  executable: true,
  tools: [
    {
      name: "delete_account",
      description: "Deletes the signed-in user's account and all its data. Cannot be undone.",
      inputSchema: { type: "object", properties: { confirm: { type: "boolean", description: "Must be true" } } },
      annotations: null,
      sources: ["navigator.modelContextTesting"],
    },
  ],
  errors: [],
};

function readinessOf(over: Partial<ReadinessInputs> = {}): NonNullable<PageContext["readiness"]> {
  const inputs: ReadinessInputs = {
    jsonLd: analyzeJsonLd([{ raw: '{"@context":"https://schema.org","@type":"Organization","name":"Acme"}', index: 0 }]),
    webmcp: WEBMCP,
    tools: analyzeTools(WEBMCP.tools),
    semantics: { lang: "en", h1: 1, main: true, nav: true, fields: 0, unlabelled: [] } as unknown as ReadinessInputs["semantics"],
    llms: parseLlmsTxt("https://a.test/llms.txt", 200, "text/plain", "# Acme\n\n> The shop.\n"),
    ...over,
  };
  return { score: readinessScore(inputs), inputs };
}

describe("Overview and AI context: landmarks, dataLayer, agent readiness", () => {
  const w = window as unknown as Record<string, unknown>;
  let ctx: PageContext;

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 300, 24));
    document.body.innerHTML = PAGE;
    const dl: unknown[] = [];
    w.dataLayer = dl;
    dl.push(
      args("consent", "default", { ad_storage: "denied", analytics_storage: "denied" }),
      args("js", "2026-11-20"),
      args("config", "G-OVR1234"),
      { event: "sign_up", user: { email: EMAIL } },
    );
    ctx = {
      url: "https://a.test/",
      title: "A",
      landmarks: { snapshot: collectLandmarks(), headings: collectHeadings().headings },
      datalayer: analyzeDataLayer(readDataLayer()),
      readiness: readinessOf(),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete w.dataLayer;
    document.body.innerHTML = "";
  });

  it("renders each new part under its devkit panel, only when asked", () => {
    const out = renderContext(ctx, ["landmarks", "datalayer", "readiness"]);
    expect(out).toContain("## Landmarks (devkit panel: Inspect › Headings)");
    expect(out).toContain("## dataLayer (GA4, Consent Mode, GTM) (devkit panel: Inspect › dataLayer)");
    expect(out).toContain("## Agent readiness (devkit panel: Inspect › Agent readiness)");
    const none = renderContext(ctx, ["meta"]);
    expect(none).not.toContain("Landmarks");
    expect(none).not.toContain("dataLayer");
    expect(none).not.toContain("Agent readiness");
  });

  it("gives the landmark tree with selectors and the landmark issues", () => {
    const md = landmarksContext(ctx.landmarks!);
    expect(md).toContain("5 ARIA landmarks, 5 announced by screen readers");
    expect(md).toMatch(/^main \[main\] \(body > main\)$/m);
    expect(md).toMatch(/^ {4}navigation \[navigation\] \(/m);
    expect(md).toContain("- [warn] 2 unnamed navigation: Give each navigation landmark a distinct aria-label");
  });

  it("gives the dataLayer counts, containers, GA4 and Consent Mode findings, with personal data masked", () => {
    const md = dataLayerContext(ctx.datalayer!);
    expect(md).toMatch(/^Result: \d+ problems?/m);
    expect(md).toContain("`G-OVR1234`: GA4 measurement ID");
    expect(md).toContain("- `dataLayer[0]` default: ad_storage=denied, analytics_storage=denied");
    expect(md).toMatch(/E-mail address in the dataLayer/);
    expect(md).toContain("`dataLayer[3].user.email`");
    expect(md).toContain("### Entries (4, values masked)");
    expect(md).toContain("- dataLayer[3] sign_up — user: {1}");
    // Neither the report nor anything rendered from the context carries the address.
    const all = renderContext(ctx, ["datalayer"]);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("sam.smith");
    expect(JSON.stringify(ctx.datalayer)).not.toContain(EMAIL);
  });

  it("gives the readiness score as a heuristic, every rule, the recommendations, the files and the WebMCP tools", () => {
    const md = readinessContext(ctx.readiness!);
    const { score } = ctx.readiness!;
    expect(md).toContain(`Score: ${score.total}/100. A heuristic`);
    expect(md).toMatch(/^- Structured data \d+\/25: JSON-LD on the page 8\/8 \(1 block\);/m);
    expect(md).toContain("[High impact] Mark delete_account with consequentialHint");
    expect(md).toContain("- llms.txt: present");
    expect(md).toContain("WebMCP APIs on the page: navigator.modelContextTesting.");
    expect(md).toMatch(/- `delete_account`: Critical risk \(/);
    expect(readinessContext(readinessOf({ webmcp: null, tools: [], llms: undefined }))).toContain("Agent files: not checked");
  });

  it("stays within the budget", () => {
    const out = renderContext(ctx, ["landmarks", "datalayer", "readiness"], 1500);
    expect(out.length).toBeLessThanOrEqual(1500 + "\n[… cut]".length);
    expect(out.endsWith("[… cut]")).toBe(true);
  });

  it("the fix plan asks for the new parts, the a11y review for the landmarks", () => {
    const plan = AI_ACTIONS.find((a) => a.id === "fix-plan")!;
    for (const p of ["landmarks", "datalayer", "readiness"] as const) expect(plan.parts).toContain(p);
    expect(plan.parts.slice(0, 2)).toEqual(["secrets", "libraries"]);
    expect(plan.prompt).toContain("never ask for the full value");
    expect(plan.prompt).toContain("personal data");
    expect(AI_ACTIONS.find((a) => a.id === "a11y-review")!.parts).toContain("landmarks");
  });

  it("sums each area up in one Overview line", () => {
    const lm = ctx.landmarks!;
    expect(landmarksVerdict(landmarkIssues(lm.snapshot, lm.headings), 5)).toEqual({ level: "warn", text: "5 landmarks · 1 to review" });
    expect(landmarksVerdict([], 4)).toEqual({ level: "good", text: "4 landmarks, no issue" });
    expect(landmarksVerdict([], 0)).toEqual({ level: "warn", text: "No landmark, no issue" });

    const dl = dataLayerVerdict(ctx.datalayer!);
    expect(dl.level).toBe("bad");
    expect(dl.text).toMatch(/^1 event · Consent Mode: 1 issue · personal data found · \d+ to fix/);
    expect(dataLayerVerdict(analyzeDataLayer({ ...readDataLayer(), layers: [] }))).toEqual({ level: "info", text: "No dataLayer" });

    const total = ctx.readiness!.score.total;
    expect(readinessVerdict({ total }, 1).text).toBe(`${total}/100 · 1 WebMCP tool`);
    expect(readinessVerdict({ total: 85 }, 0)).toEqual({ level: "good", text: "85/100 · no WebMCP tool" });
    expect(readinessVerdict({ total: 50 }, 2).level).toBe("warn");
    expect(readinessVerdict({ total: 49 }, 2).level).toBe("bad");
  });

  it("puts the three reports in the Overview's fix list and print report", () => {
    const page = { url: "https://a.test/" };
    const lmMd = landmarksMarkdown(ctx.landmarks!.snapshot, page, ctx.landmarks!.headings);
    expect(lmMd.startsWith("## Landmarks\nPage: https://a.test/\nResult: 1 warning")).toBe(true);
    expect(lmMd).toContain("### Tree");
    expect(lmMd).toContain('Fix: Give each one its own `aria-label`, e.g. `<nav aria-label="Main">`');
    expect(hasFindings(lmMd)).toBe(true);
    const parts = [
      { area: "Landmarks", panel: "Inspect › Headings", md: lmMd },
      { area: "dataLayer", panel: "Inspect › dataLayer", md: dataLayerMarkdown(ctx.datalayer!, page) },
      {
        area: "Agent readiness",
        panel: "Inspect › Agent readiness",
        md: readinessMarkdown(ctx.readiness!.score, ctx.readiness!.inputs, page),
      },
    ];
    const fix = pageReportMarkdown(parts, page);
    expect(fix).toContain("| Landmarks | 1 warning | Inspect › Headings |");
    expect(fix).toMatch(/\| dataLayer \| \d+ problems?[^|]*\| Inspect › dataLayer \|/);
    expect(fix).toMatch(/\| Agent readiness \| \d+\/100 \(/);
    expect(fix).not.toContain(EMAIL);
    const print = printReportMarkdown(
      [
        { label: "Landmarks", verdict: { level: "warn", text: "5 landmarks · 1 to review" } },
        { label: "Agent readiness", verdict: null },
      ],
      parts,
      { ...page, date: "20/11/2026" },
    );
    expect(print).toContain("| Landmarks | ▲ 5 landmarks · 1 to review |");
    expect(print).toContain("| Agent readiness | Not measured |");
    expect(print).toContain("## Agent readiness (devkit panel: Inspect › Agent readiness)");
  });
});
