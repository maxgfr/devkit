// Accessibility audit: axe-core results reduced to what the panel, the page report, the AI context
// and "Copy for agent" need. Pure: the in-page runner (src/lib/page/axe.ts) and the UI share it.
import type { Level } from "./headers";

export type Impact = "critical" | "serious" | "moderate" | "minor";
export const IMPACTS: Impact[] = ["critical", "serious", "moderate", "minor"];
export const IMPACT_TEXT: Record<Impact, string> = { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" };

export interface AuditOptions {
  /** axe's best-practice rules (heading order, landmarks, one h1…): not WCAG failures, but common advice. */
  bestPractices: boolean;
  /** WCAG 2.0 AAA rules (enhanced contrast…). */
  aaa: boolean;
}

export const DEFAULT_AUDIT_OPTIONS: AuditOptions = { bestPractices: true, aaa: false };

/** Part of the page to audit: a CSS selector, inside shadow roots when `shadow` lists their hosts. */
export interface AuditScope {
  selector: string;
  shadow?: string[];
}

export interface AuditNode {
  /** Selector path: one entry, or the shadow hosts then the element when it lives in shadow DOM. */
  target: string[];
  html: string;
  /** axe's "Fix any of the following: …" text, or why the check could not decide. */
  summary: string;
}

export interface AuditRule {
  id: string;
  impact: Impact | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  /** Elements involved; only the first MAX_NODES are kept in `nodes`. */
  nodeCount: number;
  nodes: AuditNode[];
}

export interface Audit {
  url: string;
  at: number;
  /** Time axe took in the page. */
  ms: number;
  axeVersion: string;
  options: AuditOptions;
  scope: AuditScope | null;
  violations: AuditRule[];
  incomplete: AuditRule[];
  passes: { id: string; help: string; nodeCount: number }[];
  inapplicable: number;
  /** Elements in the audited part, and iframes axe was told to skip. */
  elements: number;
  iframes: number;
}

export const MAX_NODES = 50;
/** Version of the in-page API (`__devkitAxe`) the side panel expects: a stale copy in the page is replaced. */
export const AXE_API_VERSION = 1;

/** Same page, ignoring the fragment. */
export const sameDocument = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];
const MAX_HTML = 300;

/** axe tags to run for `options`: WCAG 2.0, 2.1 and 2.2 at A and AA, plus the optional groups. */
export function auditTags(options: AuditOptions): string[] {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
  if (options.aaa) tags.push("wcag2aaa");
  if (options.bestPractices) tags.push("best-practice");
  return tags;
}

/** The standards an audit covered, for its header: "WCAG 2.0, 2.1, 2.2 A and AA · best practices". */
export function standardsLabel(options: AuditOptions): string {
  return [`WCAG 2.0, 2.1, 2.2 A${options.aaa ? ", AA and AAA (2.0)" : " and AA"}`, options.bestPractices ? "best practices" : ""]
    .filter(Boolean)
    .join(" · ");
}

export const scopeLabel = (scope: AuditScope | null | undefined) =>
  scope ? [...(scope.shadow ?? []), scope.selector].join(" >>> ") : "Whole page";

export const targetLabel = (target: string[]) => target.join(" >>> ");

export const trimHtml = (html: string, max = MAX_HTML) => {
  // axe can leave an empty style attribute behind after measuring an element: it is noise.
  const flat = html
    .replace(/\s+/g, " ")
    .replace(/ style=""/g, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/* WCAG success criteria */

type ScLevel = "A" | "AA" | "AAA";
const SC: Record<string, [string, ScLevel]> = {
  "1.1.1": ["Non-text Content", "A"],
  "1.2.1": ["Audio-only and Video-only (Prerecorded)", "A"],
  "1.2.2": ["Captions (Prerecorded)", "A"],
  "1.2.3": ["Audio Description or Media Alternative (Prerecorded)", "A"],
  "1.2.4": ["Captions (Live)", "AA"],
  "1.2.5": ["Audio Description (Prerecorded)", "AA"],
  "1.2.6": ["Sign Language (Prerecorded)", "AAA"],
  "1.2.7": ["Extended Audio Description (Prerecorded)", "AAA"],
  "1.2.8": ["Media Alternative (Prerecorded)", "AAA"],
  "1.2.9": ["Audio-only (Live)", "AAA"],
  "1.3.1": ["Info and Relationships", "A"],
  "1.3.2": ["Meaningful Sequence", "A"],
  "1.3.3": ["Sensory Characteristics", "A"],
  "1.3.4": ["Orientation", "AA"],
  "1.3.5": ["Identify Input Purpose", "AA"],
  "1.3.6": ["Identify Purpose", "AAA"],
  "1.4.1": ["Use of Color", "A"],
  "1.4.2": ["Audio Control", "A"],
  "1.4.3": ["Contrast (Minimum)", "AA"],
  "1.4.4": ["Resize Text", "AA"],
  "1.4.5": ["Images of Text", "AA"],
  "1.4.6": ["Contrast (Enhanced)", "AAA"],
  "1.4.7": ["Low or No Background Audio", "AAA"],
  "1.4.8": ["Visual Presentation", "AAA"],
  "1.4.9": ["Images of Text (No Exception)", "AAA"],
  "1.4.10": ["Reflow", "AA"],
  "1.4.11": ["Non-text Contrast", "AA"],
  "1.4.12": ["Text Spacing", "AA"],
  "1.4.13": ["Content on Hover or Focus", "AA"],
  "2.1.1": ["Keyboard", "A"],
  "2.1.2": ["No Keyboard Trap", "A"],
  "2.1.3": ["Keyboard (No Exception)", "AAA"],
  "2.1.4": ["Character Key Shortcuts", "A"],
  "2.2.1": ["Timing Adjustable", "A"],
  "2.2.2": ["Pause, Stop, Hide", "A"],
  "2.2.3": ["No Timing", "AAA"],
  "2.2.4": ["Interruptions", "AAA"],
  "2.2.5": ["Re-authenticating", "AAA"],
  "2.2.6": ["Timeouts", "AAA"],
  "2.3.1": ["Three Flashes or Below Threshold", "A"],
  "2.3.2": ["Three Flashes", "AAA"],
  "2.3.3": ["Animation from Interactions", "AAA"],
  "2.4.1": ["Bypass Blocks", "A"],
  "2.4.2": ["Page Titled", "A"],
  "2.4.3": ["Focus Order", "A"],
  "2.4.4": ["Link Purpose (In Context)", "A"],
  "2.4.5": ["Multiple Ways", "AA"],
  "2.4.6": ["Headings and Labels", "AA"],
  "2.4.7": ["Focus Visible", "AA"],
  "2.4.8": ["Location", "AAA"],
  "2.4.9": ["Link Purpose (Link Only)", "AAA"],
  "2.4.10": ["Section Headings", "AAA"],
  "2.4.11": ["Focus Not Obscured (Minimum)", "AA"],
  "2.4.12": ["Focus Not Obscured (Enhanced)", "AAA"],
  "2.4.13": ["Focus Appearance", "AAA"],
  "2.5.1": ["Pointer Gestures", "A"],
  "2.5.2": ["Pointer Cancellation", "A"],
  "2.5.3": ["Label in Name", "A"],
  "2.5.4": ["Motion Actuation", "A"],
  "2.5.5": ["Target Size (Enhanced)", "AAA"],
  "2.5.6": ["Concurrent Input Mechanisms", "AAA"],
  "2.5.7": ["Dragging Movements", "AA"],
  "2.5.8": ["Target Size (Minimum)", "AA"],
  "3.1.1": ["Language of Page", "A"],
  "3.1.2": ["Language of Parts", "AA"],
  "3.1.3": ["Unusual Words", "AAA"],
  "3.1.4": ["Abbreviations", "AAA"],
  "3.1.5": ["Reading Level", "AAA"],
  "3.1.6": ["Pronunciation", "AAA"],
  "3.2.1": ["On Focus", "A"],
  "3.2.2": ["On Input", "A"],
  "3.2.3": ["Consistent Navigation", "AA"],
  "3.2.4": ["Consistent Identification", "AA"],
  "3.2.5": ["Change on Request", "AAA"],
  "3.2.6": ["Consistent Help", "A"],
  "3.3.1": ["Error Identification", "A"],
  "3.3.2": ["Labels or Instructions", "A"],
  "3.3.3": ["Error Suggestion", "AA"],
  "3.3.4": ["Error Prevention (Legal, Financial, Data)", "AA"],
  "3.3.5": ["Help", "AAA"],
  "3.3.6": ["Error Prevention (All)", "AAA"],
  "3.3.7": ["Redundant Entry", "A"],
  "3.3.8": ["Accessible Authentication (Minimum)", "AA"],
  "3.3.9": ["Accessible Authentication (Enhanced)", "AAA"],
  "4.1.1": ["Parsing (obsolete)", "A"],
  "4.1.2": ["Name, Role, Value", "A"],
  "4.1.3": ["Status Messages", "AA"],
};

export interface Criterion {
  sc: string;
  name: string;
  level: ScLevel;
  url: string;
}

/** Success criteria named by axe tags ("wcag111" → 1.1.1 Non-text Content, level A), in WCAG order. */
export function wcagCriteria(tags: string[]): Criterion[] {
  const out: Criterion[] = [];
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    if (!m) continue;
    const sc = `${m[1]}.${m[2]}.${m[3]}`;
    const known = SC[sc];
    if (!known || out.some((c) => c.sc === sc)) continue;
    const slug = known[0]
      .toLowerCase()
      .replace(/\(obsolete\)/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    out.push({ sc, name: known[0], level: known[1], url: `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html` });
  }
  const key = (sc: string) => sc.split(".").reduce((n, p) => n * 100 + Number(p), 0);
  return out.sort((a, b) => key(a.sc) - key(b.sc));
}

/** Where a rule comes from: "WCAG 2.1 AA", "Best practice", "Experimental"… */
export function ruleStandard(tags: string[]): string {
  for (const t of tags) {
    const m = /^wcag2(1|2)?(a{1,3})$/.exec(t);
    if (m) return `WCAG 2.${m[1] ?? "0"} ${m[2]!.toUpperCase()}`;
  }
  if (tags.includes("best-practice")) return "Best practice";
  if (tags.includes("experimental")) return "Experimental";
  return "axe rule";
}

/** One line per criterion: "1.1.1 Non-text Content (A)". */
export const criteriaText = (tags: string[]) =>
  wcagCriteria(tags)
    .map((c) => `${c.sc} ${c.name} (${c.level})`)
    .join(", ");

/* Raw axe results → Audit */

interface RawCheck {
  message?: string;
}
interface RawNode {
  html?: string;
  target?: unknown[];
  failureSummary?: string;
  any?: RawCheck[];
  all?: RawCheck[];
  none?: RawCheck[];
}
interface RawRule {
  id: string;
  impact?: string | null;
  help?: string;
  description?: string;
  helpUrl?: string;
  tags?: string[];
  nodes?: RawNode[];
}
export interface RawResults {
  testEngine?: { version?: string };
  violations?: RawRule[];
  incomplete?: RawRule[];
  passes?: RawRule[];
  inapplicable?: RawRule[];
}

/** axe's target (a selector, or shadow hosts then the element) as a flat path. Frame paths keep their last part. */
export function targetPath(target: unknown[] | undefined): string[] {
  const last = target?.[target.length - 1];
  if (typeof last === "string") return [last];
  if (Array.isArray(last)) return last.filter((s): s is string => typeof s === "string");
  if (last && typeof last === "object" && "fromShadowDom" in last)
    return targetPath([(last as { fromShadowDom: unknown[] }).fromShadowDom]);
  return [];
}

const impactOf = (v: unknown): Impact | null => (IMPACTS.includes(v as Impact) ? (v as Impact) : null);

function nodeSummary(n: RawNode): string {
  if (n.failureSummary?.trim()) return n.failureSummary.trim();
  const messages = [...(n.any ?? []), ...(n.all ?? []), ...(n.none ?? [])].map((c) => c.message?.trim()).filter(Boolean);
  return [...new Set(messages)].join("\n");
}

function compactRule(r: RawRule): AuditRule {
  const nodes = r.nodes ?? [];
  // A rule's impact is the worst of its nodes; axe sets it on the rule already, fall back on the nodes.
  const impact = impactOf(r.impact) ?? IMPACTS.find((i) => nodes.some((n) => (n as { impact?: string }).impact === i)) ?? null;
  return {
    id: r.id,
    impact,
    help: r.help ?? r.id,
    description: r.description ?? "",
    helpUrl: r.helpUrl ?? "",
    tags: r.tags ?? [],
    nodeCount: nodes.length,
    nodes: nodes.slice(0, MAX_NODES).map((n) => ({ target: targetPath(n.target), html: trimHtml(n.html ?? ""), summary: nodeSummary(n) })),
  };
}

const byImpact = (a: AuditRule, b: AuditRule) =>
  (a.impact ? IMPACTS.indexOf(a.impact) : 9) - (b.impact ? IMPACTS.indexOf(b.impact) : 9) || b.nodeCount - a.nodeCount;

export function compactAudit(
  raw: RawResults,
  meta: { url: string; at: number; ms: number; options: AuditOptions; scope: AuditScope | null; elements: number; iframes: number },
): Audit {
  return {
    ...meta,
    axeVersion: raw.testEngine?.version ?? "",
    violations: (raw.violations ?? []).map(compactRule).sort(byImpact),
    incomplete: (raw.incomplete ?? []).map(compactRule).sort(byImpact),
    passes: (raw.passes ?? []).map((r) => ({ id: r.id, help: r.help ?? r.id, nodeCount: r.nodes?.length ?? 0 })),
    inapplicable: raw.inapplicable?.length ?? 0,
  };
}

/* Summaries */

export interface AuditSummary {
  /** Violated rules by impact. */
  rules: Record<Impact, number>;
  /** Elements failing, by the impact of their rule. */
  elements: Record<Impact, number>;
  violations: number;
  failingElements: number;
  review: number;
  passed: number;
}

export function auditSummary(audit: Pick<Audit, "violations" | "incomplete" | "passes">): AuditSummary {
  const rules = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const elements = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const r of audit.violations) {
    const i = r.impact ?? "minor";
    rules[i]++;
    elements[i] += r.nodeCount;
  }
  return {
    rules,
    elements,
    violations: audit.violations.length,
    failingElements: audit.violations.reduce((s, r) => s + r.nodeCount, 0),
    review: audit.incomplete.length,
    passed: audit.passes.length,
  };
}

/** Panel level of an impact: critical and serious are failures to fix, the rest warnings. */
export const impactLevel = (impact: Impact | null): Level => (impact === "critical" || impact === "serious" ? "bad" : "warn");

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/* Markdown for agents and the AI */

export const HONESTY = "Automated checks catch part of WCAG issues; manual testing (keyboard, screen reader, zoom) is still needed.";

function fence(html: string) {
  const ticks = html.includes("```") ? "````" : "```";
  return `${ticks}html\n${html}\n${ticks}`;
}

function nodeMarkdown(n: AuditNode, i: number): string {
  const lines = [`${i + 1}. \`${targetLabel(n.target) || "(no selector)"}\``];
  if (n.html) lines.push(fence(n.html).replace(/^/gm, "   "));
  if (n.summary)
    lines.push(
      n.summary
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (/following:$/.test(l) ? `   ${l}` : `   - ${l}`))
        .join("\n"),
    );
  return lines.join("\n");
}

export function ruleMarkdown(
  rule: AuditRule,
  opts: { kind?: "violation" | "review"; url?: string; maxNodes?: number; heading?: string } = {},
): string {
  const { kind = "violation", maxNodes = 20, heading = "##" } = opts;
  const criteria = criteriaText(rule.tags);
  const meta = [
    kind === "review" ? "Needs review" : rule.impact ? `Impact: ${rule.impact}` : "",
    ruleStandard(rule.tags),
    criteria ? `WCAG ${criteria}` : "",
  ].filter(Boolean);
  const shown = rule.nodes.slice(0, maxNodes);
  const more = rule.nodeCount - shown.length;
  const head = [
    `${heading} \`${rule.id}\`: ${rule.help}`,
    meta.join(" · "),
    opts.url ? `Page: ${opts.url}` : "",
    rule.description ? `Rule: ${rule.description}` : "",
    rule.helpUrl ? `How to fix: ${rule.helpUrl}` : "",
  ].filter(Boolean);
  const body = [
    `${plural(rule.nodeCount, "element")}${kind === "review" ? " to check by hand" : " failing"}:`,
    ...shown.map(nodeMarkdown),
    more > 0 ? `… and ${plural(more, "more element")} (see the full audit).` : "",
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${body.join("\n\n")}`;
}

export function auditMarkdown(audit: Audit, opts: { maxNodes?: number; title?: string } = {}): string {
  const s = auditSummary(audit);
  const impacts = IMPACTS.filter((i) => s.rules[i])
    .map((i) => `${s.rules[i]} ${i}`)
    .join(", ");
  const head = [
    `# Accessibility audit${opts.title ? `: ${opts.title}` : ""}`,
    `Page: ${audit.url}`,
    `Engine: axe-core ${audit.axeVersion} · ${standardsLabel(audit.options)} · scope: ${scopeLabel(audit.scope)}`,
    `Result: ${plural(s.violations, "violation")}${impacts ? ` (${impacts})` : ""} on ${plural(s.failingElements, "element")} · ${s.review} rules need review · ${s.passed} rules pass`,
    audit.iframes ? `Not audited: ${plural(audit.iframes, "iframe")}.` : "",
    HONESTY,
  ].filter(Boolean);
  const out = [head.join("\n")];
  if (audit.violations.length)
    out.push("## Violations", ...audit.violations.map((r) => ruleMarkdown(r, { heading: "###", maxNodes: opts.maxNodes })));
  else out.push("## Violations\nNone found by the automated checks.");
  if (audit.incomplete.length)
    out.push(
      "## Needs review (axe could not decide)",
      ...audit.incomplete.map((r) => ruleMarkdown(r, { kind: "review", heading: "###", maxNodes: Math.min(opts.maxNodes ?? 20, 5) })),
    );
  return out.join("\n\n");
}

/** The audit as AI context: everything when it fits, the rule in focus in full first. */
export function auditContext(audit: Audit, focus?: string): string {
  const rule = focus ? [...audit.violations, ...audit.incomplete].find((r) => r.id === focus) : undefined;
  const parts: string[] = [];
  if (rule) parts.push(`In focus: the developer asked about \`${rule.id}\`.\n\n${ruleMarkdown(rule, { heading: "###", maxNodes: 30 })}`);
  parts.push(auditMarkdown(audit, { maxNodes: rule ? 5 : 10 }).replace(/^# /, "### "));
  return parts.join("\n\n");
}
