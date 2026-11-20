// One-line verdicts for the Overview's page report card, from data the inspectors already collect.
import { type Audit, auditSummary } from "./a11y";
import type { Check, Level } from "./headers";
import type { DataLayerAnalysis } from "./datalayer";
import type { JsonLdReport } from "./jsonld";
import type { LandmarkIssue } from "./landmarks";
import type { Readiness } from "./readiness";
import { scoreLevel } from "./viz";

export interface Verdict {
  level: Level;
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function securityVerdict(sec: { grade: string; score: number }): Verdict {
  return { level: scoreLevel(sec.score), text: `Grade ${sec.grade} · ${sec.score}/100` };
}

export function seoVerdict(checks: Pick<Check, "level">[]): Verdict {
  const bad = checks.filter((c) => c.level === "bad").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  if (!bad && !warn) return { level: "good", text: "No issue" };
  return {
    level: bad ? "bad" : "warn",
    text: [bad ? `${bad} to fix` : "", warn ? `${warn} to review` : ""].filter(Boolean).join(", "),
  };
}

export function jsonLdVerdict(r: Pick<JsonLdReport, "blocks" | "counts">): Verdict {
  if (!r.blocks.length) return { level: "info", text: "No JSON-LD" };
  const { error, warn } = r.counts;
  const parts = [error ? plural(error, "error") : "", warn ? plural(warn, "warning") : ""].filter(Boolean);
  return {
    level: error ? "bad" : warn ? "warn" : "good",
    text: `${parts.length ? parts.join(", ") : "Valid"} in ${plural(r.blocks.length, "block")}`,
  };
}

export function errorsVerdict(data: { installed: boolean; errors: unknown[] }): Verdict {
  const total = data.errors.reduce<number>((s, e) => s + (Number((e as { count?: number }).count) || 1), 0);
  if (total) return { level: "bad", text: `${plural(total, "error")} captured` };
  if (!data.installed) return { level: "info", text: "Not listening on this page" };
  return { level: "good", text: "None captured" };
}

/** session storage key of the report the print page renders. */
export const PRINT_REPORT_KEY = "printReport";

export interface PrintReport {
  title: string;
  url: string;
  /** ISO date of the read. */
  date: string;
  markdown: string;
}

const MARK: Record<Level, string> = { bad: "✕", warn: "▲", info: "ⓘ", good: "✓" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/**
 * The Overview report for people, as printed: the verdict of each row, then the full report of every area
 * measured (clean ones included), then what could not be measured.
 */
export function printReportMarkdown(
  rows: { label: string; verdict: Verdict | null }[],
  parts: { area: string; md: string | null; missing?: string }[],
  ctx: { url: string; title?: string; date: string },
): string {
  const measured = parts.filter((p) => p.md !== null);
  const missing = parts.filter((p) => p.md === null);
  return [
    `# Page report: ${ctx.title?.trim() || ctx.url}`,
    `Page: ${ctx.url}  \nRead on ${ctx.date} by devkit, in this browser (nothing was uploaded).`,
    [
      "| Area | Result |",
      "| --- | --- |",
      ...rows.map((r) => `| ${cell(r.label)} | ${r.verdict ? `${MARK[r.verdict.level]} ${cell(r.verdict.text)}` : "Not measured"} |`),
    ].join("\n"),
    ...measured.map((p) => p.md as string),
    missing.length ? `## Not measured\n\n${missing.map((p) => `- ${p.area}: ${p.missing ?? "no data"}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The landmarks the page exposes and the landmark issues to look at (notes left out). */
export function landmarksVerdict(issues: Pick<LandmarkIssue, "level">[], exposed: number): Verdict {
  const bad = issues.filter((i) => i.level === "bad").length;
  const warn = issues.filter((i) => i.level === "warn").length;
  const found = exposed ? plural(exposed, "landmark") : "No landmark";
  if (!bad && !warn) return { level: exposed ? "good" : "warn", text: `${found}, no issue` };
  return {
    level: bad ? "bad" : "warn",
    text: [found, bad ? `${bad} to fix` : "", warn ? `${warn} to review` : ""].filter(Boolean).join(" · "),
  };
}

/** Whether the page has a dataLayer, its events, its Consent Mode findings and the rest of its issues. */
export function dataLayerVerdict(a: Pick<DataLayerAnalysis, "layers" | "consent" | "issues" | "counts">): Verdict {
  if (!a.layers.length) return { level: "info", text: "No dataLayer" };
  const c = a.counts;
  const consentIssues = a.issues.filter((i) => i.area === "consent" && i.level !== "info").length;
  const consent = !a.consent.length
    ? "no Consent Mode"
    : consentIssues
      ? `Consent Mode: ${plural(consentIssues, "issue")}`
      : "Consent Mode OK";
  const others = [c.problems ? `${c.problems} to fix` : "", c.warnings ? `${c.warnings} to review` : ""].filter(Boolean).join(", ");
  return {
    level: c.problems ? "bad" : c.warnings ? "warn" : "good",
    text: [plural(c.events, "event"), consent, c.pii ? "personal data found" : "", others].filter(Boolean).join(" · "),
  };
}

/** The agent readiness score (a heuristic), with the panel's thresholds, and how many WebMCP tools it found. */
export function readinessVerdict(r: Pick<Readiness, "total">, tools: number): Verdict {
  return {
    level: r.total >= 80 ? "good" : r.total >= 50 ? "warn" : "bad",
    text: `${r.total}/100 · ${tools ? plural(tools, "WebMCP tool") : "no WebMCP tool"}`,
  };
}

/** From the last axe audit of the page; null when none ran (the Overview does not audit large pages on its own). */
export function a11yVerdict(audit: Pick<Audit, "violations" | "incomplete" | "passes">): Verdict {
  const s = auditSummary(audit);
  const review = s.review ? `${s.review} to review` : "";
  if (!s.violations) return { level: "good", text: ["No automated violation", review].filter(Boolean).join(" · ") };
  const worst = s.rules.critical ? `${s.rules.critical} critical` : s.rules.serious ? `${s.rules.serious} serious` : "";
  return {
    level: s.rules.critical + s.rules.serious ? "bad" : "warn",
    text: [`${plural(s.violations, "violation")}${worst ? ` (${worst})` : ""}`, review].filter(Boolean).join(" · "),
  };
}
