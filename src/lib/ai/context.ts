import { type Audit, auditContext } from "../a11y";
import { filesLines } from "../agent/agents";
import { dataLayerMarkdown } from "../agent/inspect";
import { type DataLayerAnalysis, entryPath, paramsPreview } from "../datalayer";
import type { Check } from "../headers";
import { blockFindings, groupFindings, type JsonLdReport } from "../jsonld";
import { headingIssues, headingText, isExposed, outlineLines } from "../headings";
import { isLandmarkExposed, landmarkIssues, landmarksOutline } from "../landmarks";
import type { MetaSnapshot, PerfSnapshot } from "../page/collect";
import type { HeadingsSnapshot, RawHeading } from "../page/headings";
import type { LandmarksSnapshot } from "../page/landmarks";
import { IMPACT_TEXT, type Readiness, type ReadinessInputs } from "../readiness";
import type { Tech } from "../tech";
import { RISK_TEXT } from "../webmcp";

export interface CapturedError {
  kind: "error" | "rejection" | "console";
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  time: number;
  count: number;
}

export interface PageText {
  title: string;
  byline?: string;
  excerpt?: string;
  text: string;
  lang?: string;
  readable: boolean;
}

export type ContextPart =
  | "text"
  | "selection"
  | "meta"
  | "seo"
  | "tech"
  | "headers"
  | "security"
  | "perf"
  | "errors"
  | "jsonld"
  | "a11y"
  | "screenshot"
  | "element"
  | "report"
  | "secrets"
  | "libraries"
  | "headings"
  | "landmarks"
  | "datalayer"
  | "readiness";

export const PART_LABELS: Record<ContextPart, string> = {
  text: "Page text",
  selection: "Selection",
  meta: "Meta & headings",
  seo: "SEO checks",
  tech: "Tech stack",
  headers: "Response headers",
  security: "Security checks",
  perf: "Performance",
  errors: "Console errors",
  jsonld: "Structured data",
  a11y: "Accessibility audit",
  screenshot: "Screenshot",
  element: "Picked element",
  report: "Bug report",
  secrets: "Secrets (masked)",
  libraries: "Vulnerable libraries",
  headings: "Headings outline",
  landmarks: "Landmarks",
  datalayer: "dataLayer (masked)",
  readiness: "Agent readiness",
};

export interface PageContext {
  url: string;
  title: string;
  page?: PageText;
  selection?: string;
  meta?: MetaSnapshot;
  seo?: Check[];
  tech?: Tech[];
  headers?: Record<string, string>;
  security?: Check[];
  perf?: PerfSnapshot;
  errors?: CapturedError[];
  jsonld?: JsonLdReport;
  /** The axe-core audit, and the rule the developer asked about. */
  a11y?: { audit: Audit; focus?: string };
  screenshot?: string;
  /** The element picker's Markdown, and its crop (sent as the image when the model has vision). */
  element?: string;
  elementImage?: string;
  /** The bug report panel's Markdown, and its screenshot. */
  report?: string;
  reportImage?: string;
  /** The Secrets panel's report of the page's own sources: values masked. */
  secrets?: string;
  /** The Libraries panel's report of what the page tells (no file fetched): flagged libraries only. */
  libraries?: string;
  /** The Headings panel's snapshot, and the heading the developer asked about. */
  headings?: { snapshot: HeadingsSnapshot; focus?: number };
  /** The Headings panel's landmarks, and the page's headings for the "outside every landmark" check. */
  landmarks?: { snapshot: LandmarksSnapshot; headings?: RawHeading[] };
  /** The dataLayer inspector's analysis: its layers and events are masked (no e-mail, phone, IBAN or card in clear). */
  datalayer?: DataLayerAnalysis;
  /** The Agent readiness score and what it was computed from (WebMCP tools, agent files, crawlers). */
  readiness?: { score: Readiness; inputs: ReadinessInputs };
}

/** A rough token count: about 4 characters per token for English and code. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const ms = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${Math.round(n)} ms`);

/** Where each section comes from in devkit, so answers can send the developer to the right panel. */
const PANEL: Record<string, string> = {
  "SEO checks": "Inspect › SEO",
  "Meta & structure": "Inspect › SEO",
  "Detected technologies": "Inspect › Overview",
  "Response headers (document)": "Security › Headers",
  "Security checks": "Security › Headers",
  Performance: "Inspect › Performance",
  "Console errors": "Inspect › Errors",
  "Structured data (JSON-LD)": "Inspect › JSON-LD",
  "Accessibility (axe-core audit)": "Inspect › A11y",
  "Headings outline": "Inspect › Headings",
  Landmarks: "Inspect › Headings",
  "dataLayer (GA4, Consent Mode, GTM)": "Inspect › dataLayer",
  "Agent readiness": "Inspect › Agent readiness",
};

const clipLine = (s: string, max = 240) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The landmark tree (name [role], hidden ones flagged, selectors) and the landmark issues. */
export function landmarksContext(lm: NonNullable<PageContext["landmarks"]>): string {
  const snap = lm.snapshot;
  const issues = landmarkIssues(snap, lm.headings);
  const exposed = snap.landmarks.filter(isLandmarkExposed).length;
  const tree = snap.landmarks.length ? landmarksOutline(snap, { hidden: true, selectors: true }).split("\n") : [];
  return [
    `${snap.landmarks.length} ARIA landmarks${snap.capped ? " (capped)" : ""}, ${exposed} announced by screen readers, as browsers map the HTML (HTML-AAM).`,
    ...(tree.length
      ? [
          "Tree (name [role], 4 spaces per level, then the visibility when not visible and the CSS selector):",
          ...tree.slice(0, 150),
          ...(tree.length > 150 ? [`… and ${tree.length - 150} more`] : []),
        ]
      : []),
    "Issues found by devkit:",
    ...(issues.length ? issues.slice(0, 40).map((i) => `- [${i.level}] ${i.label}: ${clipLine(i.detail, 300)}`) : ["- none"]),
  ].join("\n");
}

/**
 * The dataLayer report of the panel (counts, containers, GA4, Consent Mode and the other findings, consent sequence)
 * and the events, one line each. Built from the masked analysis only: personal data never appears in clear.
 */
export function dataLayerContext(a: DataLayerAnalysis): string {
  // The panel's "Copy for agent" without its "## title" and "Page:" lines: the section heading replaces them.
  const report = dataLayerMarkdown(a, { url: a.url })
    .split("\n")
    .filter((l, i) => !(i === 0 && l.startsWith("## ")) && !(i === 1 && l.startsWith("Page: ")))
    .join("\n")
    .trim();
  const events = a.events.filter((e) => !e.name.startsWith("gtm."));
  return [
    report,
    ...(events.length
      ? [
          "",
          `### Entries (${events.length}, values masked)`,
          "",
          ...events.slice(0, 60).map((e) => {
            const preview = paramsPreview(e);
            return clipLine(`- ${entryPath(e.layer, e.index)} ${e.name}${e.gtag ? " (gtag)" : ""}${preview ? ` — ${preview}` : ""}`);
          }),
          ...(events.length > 60 ? [`… and ${events.length - 60} more`] : []),
        ]
      : []),
    "",
    "Personal data (e-mails, phone numbers, IBANs, card numbers) is masked by devkit: findings give its path, never its value.",
  ].join("\n");
}

/** The readiness score area by area with every rule, the recommendations, the agent files and the WebMCP tools. */
export function readinessContext(r: NonNullable<PageContext["readiness"]>): string {
  const { score, inputs } = r;
  const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const blocked = (inputs.crawlers ?? []).filter((c) => !c.root.allowed).map((c) => c.agent);
  const tools = inputs.tools;
  const w = inputs.webmcp;
  const apis = w
    ? [
        w.apis.document.present ? "document.modelContext" : "",
        w.apis.navigator.present ? "navigator.modelContext" : "",
        w.apis.testing.present ? "navigator.modelContextTesting" : "",
      ].filter(Boolean)
    : [];
  return [
    `Score: ${score.total}/100. A heuristic computed locally by devkit: a technical orientation, not a guarantee of compatibility with any AI agent.`,
    "Breakdown (points per rule):",
    ...score.areas.map(
      (a) => `- ${a.label} ${a.score}/${a.max}: ${a.rules.map((x) => `${x.label} ${pts(x.points)}/${x.max} (${x.detail})`).join("; ")}`,
    ),
    "Recommendations, most impact first:",
    ...(score.recommendations.length
      ? score.recommendations.slice(0, 15).map((x) => `- [${IMPACT_TEXT[x.impact]}] ${clipLine(x.text, 300)}`)
      : ["- none"]),
    ...(filesLines(inputs).length ? ["Agent files:", ...filesLines(inputs)] : ["Agent files: not checked"]),
    inputs.crawlers
      ? `AI crawlers blocked on / by robots.txt: ${blocked.length ? blocked.join(", ") : "none"} (of ${inputs.crawlers.length} checked).`
      : "",
    `WebMCP APIs on the page: ${apis.length ? apis.join(", ") : "none"}.`,
    ...(tools.length
      ? [
          `WebMCP tools (${tools.length}; risk classes are a heuristic from names, descriptions and annotations; devkit panel: Inspect › Agent tools):`,
          ...tools.slice(0, 30).map((t) => {
            const bad = t.findings.filter((f) => f.level === "bad");
            const warn = t.findings.filter((f) => f.level === "warn");
            const first = [...bad, ...warn].slice(0, 3).map((f) => `${f.area}: ${f.message}`);
            return clipLine(
              `- \`${t.tool.name || "(unnamed)"}\`: ${RISK_TEXT[t.risk]} risk (${t.riskReasons.join("; ")}); ${t.tool.form ? `form ${t.tool.form.selector}` : t.tool.sources.join(", ")}; ${bad.length} problems, ${warn.length} warnings${first.length ? ` — ${first.join(" | ")}` : ""}`,
              400,
            );
          }),
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The outline with each section's opening (shorter when there are many headings), the issues, and the heading in focus. */
export function headingsContext(h: NonNullable<PageContext["headings"]>): string {
  const snap = h.snapshot;
  const issues = headingIssues(snap);
  const exposed = snap.headings.filter(isExposed).length;
  const excerpt = snap.headings.length > 120 ? 0 : snap.headings.length > 40 ? 100 : 240;
  const lines = [
    `${snap.headings.length} headings${snap.capped ? " (capped)" : ""}, ${exposed} announced by screen readers. ${snap.introWords} words before the first heading.`,
    `Outline (level, text, CSS selector, flags, words in the section${excerpt ? ", then the section's opening after >" : ""}):`,
    ...outlineLines(snap, issues, { max: 200, excerpt }),
    "Issues found by devkit:",
    ...(issues.length ? issues.slice(0, 60).map((i) => `- [${i.level}] ${i.label}: ${i.detail}`) : ["- none"]),
  ];
  const f = h.focus === undefined ? undefined : snap.headings[h.focus];
  if (f)
    lines.push(
      "",
      `In focus: the developer asked about the h${f.level} "${headingText(f) || "(empty)"}" at \`${f.selector}\`.`,
      `HTML: ${f.html}`,
      `Section text (${f.words} words): ${f.section || "(none)"}`,
    );
  return lines.join("\n");
}

function section(title: string, body: string) {
  return `## ${title}${PANEL[title] ? ` (devkit panel: ${PANEL[title]})` : ""}\n${body.trim()}\n`;
}

/** The context as Markdown sections, the page text cut first so the whole fits `maxChars`. */
export function renderContext(ctx: PageContext, parts: ContextPart[], maxChars = 60_000): string {
  const has = (p: ContextPart) => parts.includes(p);
  const out: string[] = [`# Page\nURL: ${ctx.url}\nTitle: ${ctx.title}\n`];
  if (has("selection") && ctx.selection) out.push(section("Selected text", "```\n" + ctx.selection + "\n```"));
  if (has("element") && ctx.element) out.push(ctx.element.trim() + "\n");
  if (has("report") && ctx.report) out.push(ctx.report.trim() + "\n");
  if (has("meta") && ctx.meta) {
    const m = ctx.meta;
    out.push(
      section(
        "Meta & structure",
        [
          `lang: ${m.lang || "(none)"} · charset: ${m.charset} · ${m.doctype || "no doctype"}`,
          ...m.meta.slice(0, 60).map((x) => `- ${x.key}: ${x.value.slice(0, 300)}`),
          ...m.links
            .filter((l) => /canonical|alternate|manifest|icon|preload|preconnect/.test(l.rel))
            .slice(0, 30)
            .map((l) => `- link[${l.rel}${l.hreflang ? ` ${l.hreflang}` : ""}]: ${l.href}`),
          // The headings part has the full outline: no need to repeat it here.
          ...(has("headings") && ctx.headings
            ? []
            : ["Headings:", ...m.headings.slice(0, 80).map((h) => `${"  ".repeat(h.level - 1)}- h${h.level} ${h.text}`)]),
          `DOM: ${m.stats.elements} elements, depth ${m.stats.domDepth}, ${m.stats.scripts} scripts, ${m.stats.stylesheets} stylesheets, ${m.stats.images} images, ${kb(m.stats.htmlBytes)} of HTML`,
        ].join("\n"),
      ),
    );
  }
  if (has("seo") && ctx.seo) out.push(section("SEO checks", ctx.seo.map((c) => `- [${c.level}] ${c.label}: ${c.detail}`).join("\n")));
  if (has("tech") && ctx.tech)
    out.push(
      section("Detected technologies", ctx.tech.map((t) => `- ${t.name} (${t.category}) — ${t.evidence}`).join("\n") || "None detected"),
    );
  if (has("headers") && ctx.headers)
    out.push(
      section(
        "Response headers (document)",
        Object.entries(ctx.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      ),
    );
  if (has("security") && ctx.security)
    out.push(section("Security checks", ctx.security.map((c) => `- [${c.level}] ${c.label}: ${c.detail}`).join("\n")));
  if (has("perf") && ctx.perf) {
    const p = ctx.perf;
    const nav = p.navigation;
    const heavy = [...p.resources].sort((a, b) => b.transfer - a.transfer).slice(0, 15);
    out.push(
      section(
        "Performance",
        [
          `LCP ${ms(p.lcp)} · CLS ${p.cls.toFixed(3)} · INP ~${ms(p.inp)} · FCP ${ms(p.fcp)} · long tasks ${p.longTasks.count} (${ms(p.longTasks.total)})`,
          nav
            ? `TTFB ${ms(nav.ttfb)} · DOMContentLoaded ${ms(nav.domContentLoaded)} · load ${ms(nav.load)} · document ${kb(nav.transfer ?? 0)} transferred`
            : "",
          `${p.resources.length} resources, ${kb(p.resources.reduce((s, r) => s + r.transfer, 0))} transferred. Heaviest:`,
          ...heavy.map((r) => `- ${r.type} ${kb(r.transfer)} ${ms(r.duration)} ${r.name.slice(0, 160)}`),
        ].join("\n"),
      ),
    );
  }
  if (has("errors") && ctx.errors)
    out.push(
      section(
        "Console errors",
        ctx.errors
          .slice(0, 40)
          .map(
            (e) =>
              `- [${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}] ${e.message}${e.source ? ` (${e.source}:${e.line ?? "?"}:${e.column ?? "?"})` : ""}${e.stack ? `\n  ${e.stack.split("\n").slice(0, 4).join("\n  ")}` : ""}`,
          )
          .join("\n") || "No error captured",
      ),
    );
  if (has("jsonld") && ctx.jsonld) {
    const r = ctx.jsonld;
    const findings = groupFindings(r.blocks.flatMap(blockFindings));
    out.push(
      section(
        "Structured data (JSON-LD)",
        [
          `Types: ${r.types.map((t) => `${t.type}×${t.count}`).join(", ") || "none"}`,
          r.vocab
            ? `Findings: Google rich results rules, value formats and the Schema.org ${r.vocab.version} vocabulary (checked locally).`
            : "Findings: Google rich results rules and value formats.",
          ...findings
            .slice(0, 60)
            .map(
              (f) =>
                `- [${f.severity}] ${f.paths[0]}${f.paths.length > 1 ? ` (×${f.paths.length}, also ${f.paths.slice(1, 4).join(", ")}${f.paths.length > 4 ? ", …" : ""})` : ""}: ${f.message}`,
            ),
          ...r.blocks.map((b) => `Block #${b.index + 1}:\n\`\`\`json\n${b.raw.trim().slice(0, 6000)}\n\`\`\``),
        ].join("\n"),
      ),
    );
  }
  if (has("headings") && ctx.headings) out.push(section("Headings outline", headingsContext(ctx.headings)));
  if (has("landmarks") && ctx.landmarks) out.push(section("Landmarks", landmarksContext(ctx.landmarks)));
  if (has("a11y") && ctx.a11y) out.push(section("Accessibility (axe-core audit)", auditContext(ctx.a11y.audit, ctx.a11y.focus)));
  if (has("secrets") && ctx.secrets)
    out.push(`${ctx.secrets.replace(/^## Secrets/, "## Secrets (devkit panel: Security › Secrets)").trim()}\n`);
  if (has("libraries") && ctx.libraries) out.push(`${ctx.libraries.trim()}\n`);
  if (has("datalayer") && ctx.datalayer) out.push(section("dataLayer (GA4, Consent Mode, GTM)", dataLayerContext(ctx.datalayer)));
  if (has("readiness") && ctx.readiness) out.push(section("Agent readiness", readinessContext(ctx.readiness)));

  const fixed = out.join("\n");
  if (has("text") && ctx.page) {
    const room = Math.max(1000, maxChars - fixed.length - 200);
    const text = ctx.page.text.replace(/\n{3,}/g, "\n\n").trim();
    const cut = text.length > room ? `${text.slice(0, room)}\n[… ${text.length - room} more characters cut]` : text;
    return `${fixed}\n${section(ctx.page.readable ? "Main content (Readability)" : "Page text", cut)}`;
  }
  return fixed.length > maxChars ? `${fixed.slice(0, maxChars)}\n[… cut]` : fixed;
}

/** Characters the context may take, from the model's context window minus room for the answer. */
export function contextBudget(contextWindow: number | undefined, maxOutput: number | undefined): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 32_000;
  const reserve = Math.min(maxOutput && maxOutput > 0 ? maxOutput : 8_000, Math.floor(window / 3));
  return Math.max(8_000, Math.min((window - reserve - 2_000) * 4, 400_000));
}
