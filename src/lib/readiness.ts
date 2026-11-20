// Agent readiness: a local, transparent 0–100 score of how well a page serves AI agents, plus the agent and
// crawler conventions around it (llms.txt, ai.txt, AI crawlers in robots.txt, sitemap). Pure. The score is a
// technical orientation, a heuristic: it says nothing certain about how any given agent will use the page.
//
// Seven areas, 100 points:
//   Structured data 25 · Agent tool availability 15 · Tool descriptions 15 · Input schemas 15 · Safety 15 ·
//   Testability 10 · Accessibility & semantics 5.
// Every rule below carries its points, and the panel shows them when an area is tapped.
import type { JsonLdReport } from "./jsonld";
import type { SemanticsSnapshot, WebMcpSnapshot } from "./page/webmcp";
import { hasOwnGroup, isAllowed, parseRobots, type Robots, type RobotsGroup } from "./site-files";
import type { ToolAnalysis } from "./webmcp";

export type CrawlerPurpose = "training" | "search" | "user";
export const PURPOSE_TEXT: Record<CrawlerPurpose, string> = { training: "Training", search: "Search", user: "User-triggered" };

export interface AiCrawler {
  agent: string;
  operator: string;
  purpose: CrawlerPurpose;
  note?: string;
  docs?: string;
}

/**
 * AI crawlers and robots.txt tokens checked against robots.txt, from the operators' docs (November 2026):
 * OpenAI https://developers.openai.com/api/docs/bots · Anthropic https://support.claude.com (ClaudeBot, Claude-User,
 * Claude-SearchBot; anthropic-ai is a legacy token) · Google https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
 * · Common Crawl https://commoncrawl.org/ccbot · Perplexity https://docs.perplexity.ai/guides/bots · Apple
 * https://support.apple.com/en-us/119829 · Amazon https://developer.amazon.com/amazonbot · Meta
 * https://developers.facebook.com/docs/sharing/webmasters/web-crawlers · ByteDance and Cohere publish no page;
 * their purpose comes from observed traffic (ai.robots.txt).
 */
export const AI_CRAWLERS: AiCrawler[] = [
  { agent: "GPTBot", operator: "OpenAI", purpose: "training", docs: "https://developers.openai.com/api/docs/bots" },
  {
    agent: "OAI-SearchBot",
    operator: "OpenAI",
    purpose: "search",
    note: "ChatGPT search results",
    docs: "https://developers.openai.com/api/docs/bots",
  },
  {
    agent: "ChatGPT-User",
    operator: "OpenAI",
    purpose: "user",
    note: "Fetches a page a ChatGPT user asked about; OpenAI says robots.txt may not apply",
    docs: "https://developers.openai.com/api/docs/bots",
  },
  { agent: "ClaudeBot", operator: "Anthropic", purpose: "training" },
  { agent: "Claude-User", operator: "Anthropic", purpose: "user", note: "Fetches a page a Claude user asked about" },
  { agent: "Claude-SearchBot", operator: "Anthropic", purpose: "search", note: "Claude's search results" },
  { agent: "anthropic-ai", operator: "Anthropic", purpose: "training", note: "Legacy token, still found in many robots.txt files" },
  {
    agent: "Google-Extended",
    operator: "Google",
    purpose: "training",
    note: "A robots.txt token, not a crawler: Gemini training and grounding; Google Search is unaffected",
  },
  { agent: "CCBot", operator: "Common Crawl", purpose: "training", note: "Open dataset many models train on" },
  { agent: "PerplexityBot", operator: "Perplexity", purpose: "search" },
  { agent: "Perplexity-User", operator: "Perplexity", purpose: "user", note: "User-triggered; Perplexity says robots.txt may not apply" },
  {
    agent: "Applebot-Extended",
    operator: "Apple",
    purpose: "training",
    note: "A robots.txt token: Apple Intelligence training; Siri and Spotlight are unaffected",
  },
  { agent: "Bytespider", operator: "ByteDance", purpose: "training", note: "Undocumented" },
  { agent: "Amazonbot", operator: "Amazon", purpose: "training", note: "Amazon services, may train Amazon's models" },
  { agent: "Meta-ExternalAgent", operator: "Meta", purpose: "training", note: "Training and indexing for Meta AI" },
  { agent: "cohere-ai", operator: "Cohere", purpose: "user", note: "Undocumented; seen fetching pages for user prompts" },
];

export interface CrawlerAccess extends AiCrawler {
  /** Whether it may fetch "/". */
  root: { allowed: boolean; rule?: string };
  /** Whether it may fetch the current page's path. */
  page: { allowed: boolean; rule?: string };
  /** robots.txt names it in a group of its own (rather than `*` deciding). */
  named: boolean;
}

/** Every AI crawler of AI_CRAWLERS checked against robots.txt for "/" and for `path`. No robots.txt: all allowed. */
export function crawlerAccess(robots: Robots | null, path: string): CrawlerAccess[] {
  return AI_CRAWLERS.map((c) => ({
    ...c,
    root: robots ? isAllowed(robots, c.agent, "/") : { allowed: true },
    page: robots ? isAllowed(robots, c.agent, path || "/") : { allowed: true },
    named: robots ? hasOwnGroup(robots, c.agent) : false,
  }));
}

/** A fetched site file: present when it answered under 400 with text, not an HTML error or login page. */
export function isTextFile(status: number, contentType: string, text: string): boolean {
  if (status >= 400 || status === 0) return false;
  if (/text\/html|application\/xhtml/i.test(contentType)) return false;
  return !/^\s*(<!doctype html|<html|<head|<body)/i.test(text) && text.trim().length > 0;
}

export interface LlmsTxt {
  url: string;
  status: number;
  present: boolean;
  bytes: number;
  /** The H1 (required by llmstxt.org). */
  title?: string;
  /** The blockquote summary under it. */
  summary?: string;
  /** H2 sections (file lists). */
  sections: string[];
  /** Markdown links. */
  links: number;
}

/** Reads an llms.txt (https://llmstxt.org): `# Title`, `> summary`, `## Section` lists of `[name](url): notes`. */
export function parseLlmsTxt(url: string, status: number, contentType: string, text: string): LlmsTxt {
  const present = isTextFile(status, contentType, text);
  const bytes = new TextEncoder().encode(text).length;
  if (!present) return { url, status, present, bytes: 0, sections: [], links: 0 };
  const lines = text.split(/\r?\n/);
  const title = lines
    .find((l) => /^#\s+\S/.test(l))
    ?.replace(/^#\s+/, "")
    .trim();
  const summary = lines
    .find((l) => /^>\s*\S/.test(l))
    ?.replace(/^>\s*/, "")
    .trim();
  const sections = lines.filter((l) => /^##\s+\S/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  const links = (text.match(/\[[^\]]*\]\([^)\s]+\)/g) ?? []).length;
  return { url, status, present, bytes, title, summary, sections, links };
}

export interface AiTxt {
  url: string;
  status: number;
  present: boolean;
  groups: RobotsGroup[];
  /** `*` (or no group) disallows "/": an opt-out of AI training for the whole site. */
  optOutAll: boolean;
  /** Some Disallow rules, but not the whole site (file types, folders). */
  optOutPartial: boolean;
}

/** Reads an ai.txt (Spawning's AI training opt-out): robots.txt syntax, rules on paths and file types. */
export function parseAiTxt(url: string, status: number, contentType: string, text: string): AiTxt {
  const present = isTextFile(status, contentType, text);
  if (!present) return { url, status, present, groups: [], optOutAll: false, optOutPartial: false };
  const robots = parseRobots(text);
  const all = robots.groups.find((g) => g.agents.includes("*"));
  const optOutAll = all ? !isAllowed(robots, "*", "/").allowed : false;
  const optOutPartial = !optOutAll && robots.groups.some((g) => g.disallow.some(Boolean));
  return { url, status, present, groups: robots.groups, optOutAll, optOutPartial };
}

export type AreaId = "structured" | "availability" | "descriptions" | "schemas" | "safety" | "testability" | "semantics";

export interface Rule {
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface Area {
  id: AreaId;
  label: string;
  max: number;
  score: number;
  /** What the area measures. */
  about: string;
  /** How to raise it. */
  improve: string;
  rules: Rule[];
}

export type Impact = "high" | "medium" | "low";
export const IMPACT_TEXT: Record<Impact, string> = { high: "High impact", medium: "Medium impact", low: "Low impact" };

export interface Recommendation {
  impact: Impact;
  area: AreaId | "files";
  text: string;
}

export interface ReadinessInputs {
  /** The page's JSON-LD analysis; null while not read. */
  jsonLd: JsonLdReport | null;
  /** WebMCP snapshot; null while not read. */
  webmcp: WebMcpSnapshot | null;
  tools: ToolAnalysis[];
  semantics: SemanticsSnapshot | null;
  /** undefined: not checked yet. */
  llms?: LlmsTxt | null;
  llmsFull?: LlmsTxt | null;
  aiTxt?: AiTxt | null;
  crawlers?: CrawlerAccess[] | null;
  /** Sitemap found (robots.txt Sitemap: line or /sitemap.xml); undefined while not checked. */
  sitemap?: { url: string; found: boolean } | null;
}

export interface Readiness {
  total: number;
  areas: Area[];
  recommendations: Recommendation[];
}

/** Organization-like types (schema.org subtypes the analyzer reports by name). */
const ORG_TYPES = new Set([
  "Organization",
  "Corporation",
  "NewsMediaOrganization",
  "LocalBusiness",
  "OnlineStore",
  "OnlineBusiness",
  "EducationalOrganization",
  "GovernmentOrganization",
  "NGO",
  "Store",
  "Restaurant",
  "Person",
]);

const rule = (label: string, max: number, ratio: number, detail: string): Rule => ({
  label,
  max,
  points: Math.round(Math.max(0, Math.min(1, ratio)) * max * 10) / 10,
  detail,
});
const sum = (rules: Rule[]) => Math.round(rules.reduce((n, r) => n + r.points, 0));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The score, area by area, and recommendations ranked by impact. */
export function readinessScore(inputs: ReadinessInputs): Readiness {
  const recs: Recommendation[] = [];
  const tools = inputs.tools;
  const hasTools = tools.length > 0;

  // Structured data (25): JSON-LD present 8, every block parses 5, Organization 3, WebSite 3, no errors 4, llms.txt 2.
  const jl = inputs.jsonLd;
  const blocks = jl?.blocks.length ?? 0;
  const parsed = jl?.blocks.filter((b) => b.ok).length ?? 0;
  const types = new Set(jl?.types.map((t) => t.type) ?? []);
  const org = Array.from(types).some((t) => ORG_TYPES.has(t));
  const site = types.has("WebSite");
  const errors = jl?.counts.error ?? 0;
  const llms = inputs.llms;
  const structured: Rule[] = [
    rule("JSON-LD on the page", 8, blocks ? 1 : 0, blocks ? n(blocks, "block") : 'No <script type="application/ld+json">'),
    rule("Every block is valid JSON", 5, blocks ? parsed / blocks : 0, blocks ? `${parsed} of ${blocks} parse` : "Nothing to parse"),
    rule("Organization (or Person, LocalBusiness…)", 3, org ? 1 : 0, org ? "Present" : "Who publishes the site is not stated"),
    rule("WebSite", 3, site ? 1 : 0, site ? "Present" : "No WebSite node (name, url, search action)"),
    rule("No schema errors", 4, blocks ? (errors ? 0 : 1) : 0, blocks ? (errors ? n(errors, "error") : "None") : "No JSON-LD to check"),
    rule(
      "llms.txt",
      2,
      llms?.present ? 1 : 0,
      llms === undefined ? "Not checked yet" : llms?.present ? `${llms.bytes} bytes` : "No /llms.txt",
    ),
  ];
  if (!blocks)
    recs.push({
      impact: "high",
      area: "structured",
      text: "Add JSON-LD (schema.org) describing the page: agents read it before the HTML.",
    });
  else {
    if (parsed < blocks)
      recs.push({
        impact: "high",
        area: "structured",
        text: `Fix ${n(blocks - parsed, "JSON-LD block")} that do not parse as JSON (Inspect › Structured data).`,
      });
    if (errors)
      recs.push({ impact: "high", area: "structured", text: `Fix ${n(errors, "structured data error")} (Inspect › Structured data).` });
    if (!org)
      recs.push({
        impact: "medium",
        area: "structured",
        text: "Add an Organization node (name, url, logo, sameAs) so agents know who publishes the site.",
      });
    if (!site) recs.push({ impact: "low", area: "structured", text: "Add a WebSite node (name, url, potentialAction SearchAction)." });
  }
  if (llms && !llms.present)
    recs.push({
      impact: "medium",
      area: "files",
      text: "Add an /llms.txt file: a Markdown index of the site's key pages for language models (https://llmstxt.org).",
    });
  else if (llms?.present && !llms.title)
    recs.push({ impact: "low", area: "files", text: "llms.txt has no `# Title` line: llmstxt.org requires one." });

  // Agent tool availability (15): WebMCP API on the page 3, at least one tool 9, tools listed by the browser's API 3.
  const w = inputs.webmcp;
  const api = Boolean(w && (w.apis.document.present || w.apis.navigator.present));
  const viaApi = tools.some((t) => t.tool.sources.some((s) => s !== "declarative"));
  const availability: Rule[] = [
    rule(
      "WebMCP API on this page",
      3,
      api ? 1 : 0,
      api
        ? w?.apis.document.present
          ? "document.modelContext"
          : "navigator.modelContext"
        : "Not available here: depends on the browser, its flags and the site's origin trial",
    ),
    rule("At least one tool exposed", 9, hasTools ? 1 : 0, hasTools ? n(tools.length, "tool") : "No imperative tool, no form[toolname]"),
    rule(
      "Tools registered through the API (not only forms)",
      3,
      viaApi ? 1 : 0,
      viaApi ? "Yes" : hasTools ? "Declarative forms only" : "None",
    ),
  ];
  if (!hasTools)
    recs.push({
      impact: "low",
      area: "availability",
      text: "Expose the page's key actions as WebMCP tools (document.modelContext.registerTool or <form toolname>): experimental, Chrome origin trial.",
    });

  // Tool descriptions (15): the average description score of the tools (presence 40%, 20–500 characters 30%,
  // more than the name 15%, effects named on write tools 15%). No tools: 0.
  const descAvg = avg(tools.map((t) => t.descriptionScore));
  const weakDesc = tools.filter((t) => t.descriptionScore < 0.7);
  const descriptions: Rule[] = hasTools
    ? [
        rule(
          "Every tool described",
          6,
          tools.filter((t) => t.tool.description.trim()).length / tools.length,
          `${tools.filter((t) => t.tool.description.trim()).length} of ${tools.length}`,
        ),
        rule("Description quality (length, not just the name, effects)", 9, descAvg, `Average ${Math.round(descAvg * 100)}%`),
      ]
    : [rule("Tools to describe", 15, 0, "No tool on the page")];
  if (weakDesc.length)
    recs.push({
      impact: "medium",
      area: "descriptions",
      text: `Improve the description of ${weakDesc.map((t) => t.tool.name || "(unnamed)").join(", ")}: say what it does, when to use it and what it changes (20–500 characters).`,
    });

  // Input schemas (15): the average schema score (valid object 40%, typed 20%, described 20%, required ⊆ properties 10%,
  // enums and arrays sane 10%). No tools: 0.
  const schemaAvg = avg(tools.map((t) => t.schemaScore));
  const badSchemas = tools.filter((t) => t.findings.some((f) => f.area === "input" && f.level === "bad"));
  const noSchema = tools.filter((t) => t.tool.inputSchema == null && !t.tool.inputSchemaError);
  const schemas: Rule[] = hasTools
    ? [
        rule(
          "Valid object schemas",
          7,
          tools.filter((t) => !t.findings.some((f) => f.area === "input" && f.level === "bad") && t.tool.inputSchema != null).length /
            tools.length,
          `${tools.length - badSchemas.length - noSchema.length} of ${tools.length}`,
        ),
        rule("Typed, described, consistent parameters", 8, schemaAvg, `Average ${Math.round(schemaAvg * 100)}%`),
      ]
    : [rule("Schemas to check", 15, 0, "No tool on the page")];
  if (badSchemas.length)
    recs.push({
      impact: "high",
      area: "schemas",
      text: `Fix the input schema of ${badSchemas.map((t) => t.tool.name).join(", ")} (see Agent tools).`,
    });
  if (noSchema.length)
    recs.push({ impact: "medium", area: "schemas", text: `Give ${noSchema.map((t) => t.tool.name).join(", ")} an inputSchema.` });
  const undescribedParams = tools.filter((t) =>
    t.findings.some((f) => f.area === "input" && /without a (description|type)/.test(f.message)),
  );
  if (undescribedParams.length)
    recs.push({
      impact: "low",
      area: "schemas",
      text: `Type and describe every parameter of ${undescribedParams.map((t) => t.tool.name).join(", ")}.`,
    });

  // Safety (15): no Critical tool without consequentialHint/destructiveHint 6, High and Critical tools annotated 4,
  // no contradictory annotations 3, read-only tools say readOnlyHint 2. No tools: full marks, nothing can be triggered.
  const critical = tools.filter((t) => t.risk === "critical");
  const sensitive = tools.filter((t) => t.risk === "critical" || t.risk === "high");
  const contradictory = tools.filter((t) => t.contradictory);
  const readLike = tools.filter((t) => t.risk === "low");
  const safety: Rule[] = hasTools
    ? [
        rule(
          "No Critical tool without a consequential/destructive hint",
          6,
          critical.every((t) => t.flagged) ? 1 : 0,
          critical.length
            ? `${critical.filter((t) => t.flagged).length} of ${n(critical.length, "Critical tool")} flagged`
            : "No Critical tool",
        ),
        rule(
          "High and Critical tools annotated",
          4,
          sensitive.length ? sensitive.filter((t) => t.flagged).length / sensitive.length : 1,
          sensitive.length ? `${sensitive.filter((t) => t.flagged).length} of ${sensitive.length}` : "None to annotate",
        ),
        rule(
          "No contradictory annotations",
          3,
          contradictory.length ? 0 : 1,
          contradictory.length ? contradictory.map((t) => t.tool.name).join(", ") : "None",
        ),
        rule(
          "Read-only tools say readOnlyHint",
          2,
          readLike.length ? readLike.filter((t) => t.readOnly).length / readLike.length : 1,
          readLike.length ? `${readLike.filter((t) => t.readOnly).length} of ${readLike.length}` : "No read-only tool",
        ),
      ]
    : [rule("Nothing an agent could trigger", 15, 1, "No tool, so no risky tool: full marks")];
  const unflaggedCritical = critical.filter((t) => !t.flagged);
  if (unflaggedCritical.length)
    recs.push({
      impact: "high",
      area: "safety",
      text: `Mark ${unflaggedCritical.map((t) => t.tool.name).join(", ")} with consequentialHint: true (or destructiveHint) and ask the user to confirm inside the tool: it moves money, deletes an account or touches credentials.`,
    });
  if (contradictory.length)
    recs.push({
      impact: "high",
      area: "safety",
      text: `Fix the contradictory annotations of ${contradictory.map((t) => t.tool.name).join(", ")}.`,
    });
  const unflaggedHigh = sensitive.filter((t) => t.risk === "high" && !t.flagged);
  if (unflaggedHigh.length)
    recs.push({
      impact: "medium",
      area: "safety",
      text: `Annotate ${unflaggedHigh.map((t) => t.tool.name).join(", ")} with consequentialHint (or destructiveHint).`,
    });
  const readNoHint = readLike.filter((t) => !t.readOnly);
  if (readNoHint.length)
    recs.push({ impact: "low", area: "safety", text: `Set readOnlyHint: true on ${readNoHint.map((t) => t.tool.name).join(", ")}.` });

  // Testability (10): tools listed by an API (getTools / listTools) 5, an API can run them (executeTool) 3, every tool
  // has a schema a tester can build a form from 2. No tools: 0.
  const listed = Boolean(w?.enumerable && tools.some((t) => t.tool.sources.some((s) => s !== "declarative")));
  const runnable = Boolean(w?.executable);
  const formable = tools.filter((t) => t.tool.inputSchema && typeof t.tool.inputSchema === "object").length;
  const testability: Rule[] = hasTools
    ? [
        rule(
          "Tools listed by an API",
          5,
          listed ? 1 : 0,
          listed ? "getTools / listTools answered" : "Only found by reading forms, or no API to list them",
        ),
        rule("An API can run them", 3, runnable ? 1 : 0, runnable ? "executeTool available" : "No executeTool in this browser"),
        rule("Schemas a tester can use", 2, formable / tools.length, `${formable} of ${tools.length}`),
      ]
    : [rule("Tools to test", 10, 0, "No tool on the page")];

  // Accessibility & semantics (5, heuristic): lang 1, exactly one h1 1, a main landmark 1, a nav landmark 1, every
  // form field labelled 1.
  const s = inputs.semantics;
  const semantics: Rule[] = s
    ? [
        rule("<html lang>", 1, s.lang ? 1 : 0, s.lang || "Missing"),
        rule("Exactly one h1", 1, s.h1 === 1 ? 1 : 0, n(s.h1, "h1")),
        rule("A main landmark", 1, s.main ? 1 : 0, s.main ? "<main> or role=main" : "None"),
        rule("A navigation landmark", 1, s.nav ? 1 : 0, s.nav ? "<nav> or role=navigation" : "None"),
        rule(
          "Form fields labelled",
          1,
          s.fields ? (s.fields - s.unlabelled.length) / s.fields : 1,
          s.fields ? `${s.fields - s.unlabelled.length} of ${s.fields}` : "No form field",
        ),
      ]
    : [rule("Page semantics", 5, 0, "Not read yet")];
  if (s) {
    if (!s.lang) recs.push({ impact: "low", area: "semantics", text: 'Set <html lang="…">.' });
    if (s.h1 !== 1)
      recs.push({ impact: "low", area: "semantics", text: s.h1 ? `Keep one h1 (the page has ${s.h1}).` : "Give the page one h1." });
    if (!s.main) recs.push({ impact: "low", area: "semantics", text: "Wrap the main content in <main>." });
    if (!s.nav) recs.push({ impact: "low", area: "semantics", text: "Put the site navigation in <nav>." });
    if (s.unlabelled.length)
      recs.push({
        impact: "medium",
        area: "semantics",
        text: `Label ${n(s.unlabelled.length, "form field")}: ${s.unlabelled.slice(0, 5).join(", ")}${s.unlabelled.length > 5 ? "…" : ""}`,
      });
  }

  // Crawler and file conventions: recommendations only, they do not change the score.
  const blocked = (inputs.crawlers ?? []).filter((c) => !c.root.allowed);
  if (blocked.length)
    recs.push({
      impact: "low",
      area: "files",
      text: `${blocked.length} AI crawler(s) are disallowed in robots.txt (may be intentional): ${blocked.map((c) => c.agent).join(", ")}.`,
    });
  if (inputs.sitemap && !inputs.sitemap.found)
    recs.push({ impact: "low", area: "files", text: "No sitemap found: add one and list it in robots.txt (Sitemap: …)." });

  const areas: Area[] = [
    {
      id: "structured",
      label: "Structured data",
      max: 25,
      score: sum(structured),
      rules: structured,
      about:
        "Machine-readable facts about the page: schema.org JSON-LD (present, valid, who publishes the site, the site itself) and llms.txt.",
      improve: "Add JSON-LD with Organization and WebSite nodes, fix the errors the Structured data panel lists, publish /llms.txt.",
    },
    {
      id: "availability",
      label: "Agent tool availability",
      max: 15,
      score: sum(availability),
      rules: availability,
      about: "Whether the page offers WebMCP tools an in-browser agent can call instead of clicking through the UI.",
      improve:
        "Register tools with document.modelContext.registerTool() or annotate forms with toolname / tooldescription. WebMCP is experimental (Chrome origin trial).",
    },
    {
      id: "descriptions",
      label: "Tool descriptions",
      max: 15,
      score: sum(descriptions),
      rules: descriptions,
      about: "Agents choose a tool from its description: present, 20–500 characters, more than the name, and naming what it changes.",
      improve: "Write one or two sentences per tool: what it does, when to use it, what it changes and whether that can be undone.",
    },
    {
      id: "schemas",
      label: "Input schemas",
      max: 15,
      score: sum(schemas),
      rules: schemas,
      about:
        "The JSON Schema of each tool's arguments: a valid object, every parameter typed and described, required names that exist, sane enums.",
      improve: "Give every parameter a type and a description, use enums for closed lists, keep required in line with properties.",
    },
    {
      id: "safety",
      label: "Safety",
      max: 15,
      score: sum(safety),
      rules: safety,
      about:
        "Whether risky tools say so: Critical ones (money, account deletion, credentials) and High ones (delete, send, publish) carry consequentialHint or destructiveHint, annotations do not contradict the name.",
      improve:
        "Set consequentialHint on tools with real-world effects, readOnlyHint on tools that only read, and confirm with the user inside sensitive tools.",
    },
    {
      id: "testability",
      label: "Testability",
      max: 10,
      score: sum(testability),
      rules: testability,
      about:
        "Whether the tools can be listed and run outside an agent (getTools / listTools, executeTool) and have schemas a test form can be built from.",
      improve:
        "Register tools through the API rather than only through forms, and give each an input schema. Enable chrome://flags/#enable-webmcp-testing to test locally.",
    },
    {
      id: "semantics",
      label: "Accessibility & semantics",
      max: 5,
      score: sum(semantics),
      rules: semantics,
      about:
        "Heuristic basics agents rely on when no tool exists: page language, one h1, main and navigation landmarks, labelled form fields.",
      improve: "Set lang, keep one h1, use <main> and <nav>, label every field. Run the Accessibility audit for the full picture.",
    },
  ];
  const rank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
  return {
    total: areas.reduce((t, a) => t + a.score, 0),
    areas,
    recommendations: recs.sort((a, b) => rank[a.impact] - rank[b.impact]),
  };
}
