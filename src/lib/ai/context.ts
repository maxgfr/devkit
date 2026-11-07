import { type Audit, auditContext } from "../a11y";
import type { Check } from "../headers";
import type { JsonLdReport } from "../jsonld";
import type { MetaSnapshot, PerfSnapshot } from "../page/collect";
import type { Tech } from "../tech";

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
  | "report";

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
}

/** A rough token count: about 4 characters per token for English and code. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const ms = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${Math.round(n)} ms`);

function section(title: string, body: string) {
  return `## ${title}\n${body.trim()}\n`;
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
          "Headings:",
          ...m.headings.slice(0, 80).map((h) => `${"  ".repeat(h.level - 1)}- h${h.level} ${h.text}`),
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
    const findings = r.blocks.flatMap((b) => [...b.findings, ...b.nodes.flatMap((n) => n.findings)]);
    out.push(
      section(
        "Structured data (JSON-LD)",
        [
          `Types: ${r.types.map((t) => `${t.type}×${t.count}`).join(", ") || "none"}`,
          ...findings.slice(0, 60).map((f) => `- [${f.severity}] ${f.path}: ${f.message}`),
          ...r.blocks.map((b) => `Block #${b.index + 1}:\n\`\`\`json\n${b.raw.trim().slice(0, 6000)}\n\`\`\``),
        ].join("\n"),
      ),
    );
  }
  if (has("a11y") && ctx.a11y) out.push(section("Accessibility (axe-core audit)", auditContext(ctx.a11y.audit, ctx.a11y.focus)));

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
