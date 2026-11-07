// One-line verdicts for the Overview's page report card, from data the inspectors already collect.
import { type Audit, auditSummary } from "./a11y";
import type { Check, Level } from "./headers";
import type { JsonLdReport } from "./jsonld";
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
