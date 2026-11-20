// "Copy for agent" and "Copy report" Markdown of the Agent tools (WebMCP) and Agent readiness panels. Pure: each
// takes what its panel computed, in the shared shape of agent-md.ts.
import { agentDoc, code, findingList, plural } from "../agent-md";
import type { WebMcpSnapshot } from "../page/webmcp";
import { type CrawlerAccess, IMPACT_TEXT, type Impact, PURPOSE_TEXT, type Readiness, type ReadinessInputs } from "../readiness";
import { RISK_TEXT, type ToolAnalysis } from "../webmcp";

export interface AgentsCtx {
  url: string;
  heading?: "##" | "###";
}

const DISCLAIMER = "This score is a technical orientation and not a guarantee of compatibility with any specific AI agent.";

/** Agent tools panel: every WebMCP tool with its risk and the problems of its name, description, schema and annotations. */
export function agentToolsMarkdown(snap: WebMcpSnapshot, tools: ToolAnalysis[], ctx: AgentsCtx): string {
  const apis = [
    snap.apis.document.present ? "document.modelContext" : "",
    snap.apis.navigator.present ? "navigator.modelContext" : "",
    snap.apis.testing.present ? "navigator.modelContextTesting" : "",
  ].filter(Boolean);
  const problems = tools.flatMap((t) => t.findings.filter((f) => f.level === "bad").map((f) => ({ t, f })));
  const warnings = tools.flatMap((t) => t.findings.filter((f) => f.level === "warn").map((f) => ({ t, f })));
  const result = !tools.length
    ? "No WebMCP tool found on this page."
    : `${plural(tools.length, "tool")}; ${problems.length || warnings.length ? [problems.length ? plural(problems.length, "problem") : "", warnings.length ? plural(warnings.length, "warning") : ""].filter(Boolean).join(", ") : "no problem found"}.`;
  const inventory = tools.map(
    (t) =>
      `- ${code(t.tool.name || "(unnamed)")}: ${RISK_TEXT[t.risk]} risk (${t.riskReasons.join("; ")}). Source: ${t.tool.sources.join(", ")}${t.tool.form ? `, form ${code(t.tool.form.selector)}` : ""}.`,
  );
  const item = ({ t, f }: { t: ToolAnalysis; f: { area: string; message: string } }) => ({
    text: `${code(t.tool.name || "(unnamed)")} (${f.area}): ${f.message}`,
    details: [t.tool.form ? `Where: the form ${code(t.tool.form.selector)}` : "Where: the registerTool() call that defines it"],
  });
  return agentDoc({
    title: "Agent tools (devkit panel: Inspect › Agent tools)",
    url: ctx.url,
    result,
    context: [
      `WebMCP APIs on the page: ${apis.length ? apis.join(", ") : "none (experimental: Chrome origin trial or chrome://flags/#enable-webmcp-testing)"}.`,
      "Risk classes come from the tool names, descriptions and annotations: a heuristic.",
    ],
    heading: ctx.heading,
    sections: [
      { title: "Tools", body: inventory },
      { title: "To fix", body: findingList(problems.map(item)) },
      { title: "Worth checking", body: findingList(warnings.map(item)) },
    ],
    verify: "Reload the page and refresh devkit's Agent tools panel.",
  });
}

const crawlerLine = (c: CrawlerAccess) =>
  `- ${c.agent} (${c.operator}, ${PURPOSE_TEXT[c.purpose]}): ${c.root.allowed ? "allowed" : "blocked"} on /${c.root.rule ? ` by ${code(c.root.rule)}` : ""}${c.page.allowed !== c.root.allowed ? `, ${c.page.allowed ? "allowed" : "blocked"} on this page` : ""}`;

function filesLines(inputs: ReadinessInputs): string[] {
  const out: string[] = [];
  const llms = inputs.llms;
  if (llms !== undefined)
    out.push(
      llms?.present
        ? `- llms.txt: present (${llms.bytes} bytes${llms.title ? `, "${llms.title}"` : ""}, ${plural(llms.links, "link")})`
        : "- llms.txt: none",
    );
  if (inputs.llmsFull !== undefined)
    out.push(`- llms-full.txt: ${inputs.llmsFull?.present ? `present (${inputs.llmsFull.bytes} bytes)` : "none"}`);
  if (inputs.aiTxt !== undefined)
    out.push(
      `- ai.txt: ${inputs.aiTxt?.present ? (inputs.aiTxt.optOutAll ? "opts the whole site out of AI training" : inputs.aiTxt.optOutPartial ? "opts some files out of AI training" : "present, allows AI training") : "none"}`,
    );
  if (inputs.sitemap !== undefined) out.push(`- Sitemap: ${inputs.sitemap?.found ? inputs.sitemap.url : "not found"}`);
  return out;
}

/** "Copy report": the score, the breakdown, the files and crawlers, the recommendations. */
export function readinessReport(r: Readiness, inputs: ReadinessInputs, ctx: AgentsCtx): string {
  const crawlers = inputs.crawlers ?? [];
  const blocked = crawlers.filter((c) => !c.root.allowed);
  const byImpact = (impact: Impact) => r.recommendations.filter((x) => x.impact === impact).map((x) => `- ${x.text}`);
  return [
    `# Agent readiness: ${r.total}/100`,
    `Page: ${ctx.url}`,
    DISCLAIMER,
    "",
    "## Breakdown",
    ...r.areas.map((a) => `- ${a.label}: ${a.score}/${a.max}`),
    "",
    "## Agent files",
    ...filesLines(inputs),
    ...(crawlers.length
      ? [
          "",
          `## AI crawlers (robots.txt): ${crawlers.length - blocked.length} allowed · ${blocked.length} blocked`,
          ...crawlers.map(crawlerLine),
        ]
      : []),
    ...(["high", "medium", "low"] as Impact[]).flatMap((i) => {
      const lines = byImpact(i);
      return lines.length ? ["", `## ${IMPACT_TEXT[i]}`, ...lines] : [];
    }),
  ].join("\n");
}

/** "Copy for agent": what to change in the site to raise the score, most impact first. */
export function readinessMarkdown(r: Readiness, inputs: ReadinessInputs, ctx: AgentsCtx): string {
  const fixes = r.recommendations.filter((x) => x.impact !== "low" && !/may be intentional/.test(x.text));
  const later = r.recommendations.filter((x) => x.impact === "low" || /may be intentional/.test(x.text));
  return agentDoc({
    title: "Agent readiness (devkit panel: Inspect › Agent readiness)",
    url: ctx.url,
    result: `${r.total}/100 (${r.areas.map((a) => `${a.label} ${a.score}/${a.max}`).join(", ")}).`,
    context: [DISCLAIMER, "The score is a heuristic computed locally by devkit; every rule is listed in the panel."],
    heading: ctx.heading,
    sections: [
      { title: "To fix", body: findingList(fixes.map((x) => ({ text: `${IMPACT_TEXT[x.impact]}: ${x.text}` }))) },
      { title: "Worth checking", body: findingList(later.map((x) => ({ text: x.text }))) },
      { title: "Agent files", body: filesLines(inputs) },
    ],
    verify: "Deploy, reload the page and refresh devkit's Agent readiness panel.",
  });
}
