// Shared shape of the "Copy for agent" Markdown: one heading naming the area and the page, a one-line result,
// the problems first (most severe first, each with where and how to fix), and the check to re-run.
// Pure: every panel's report builder uses it, and so does the page report that joins them.
import type { Level } from "./headers";

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** Inline code that survives backticks inside the value. */
export function code(text: string): string {
  const s = String(text);
  const ticks = s.includes("`") ? "``" : "`";
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

/** A fenced block that survives fences inside the value. */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** Cuts long values (inline scripts, HTML, URLs) so one finding cannot drown the report. */
export function clip(text: string, max = 300): string {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}… (${plural(s.length - max, "more character")})` : s;
}

export const LEVEL_WORD: Record<Level, string> = { bad: "Problem", warn: "Warning", good: "OK", info: "Info" };

/** Most severe first: problems, then warnings, then the rest. */
export function bySeverity<T extends { level: Level }>(items: T[]): T[] {
  const rank: Partial<Record<Level, number>> = { bad: 0, warn: 1 };
  return [...items].sort((a, b) => (rank[a.level] ?? 2) - (rank[b.level] ?? 2));
}

export interface AgentDoc {
  /** What was checked, e.g. "SEO checks". */
  title: string;
  /** The page the findings come from. */
  url?: string;
  /** One line: what the developer should take away. */
  result?: string;
  /** Extra context lines under the result (engine, scope, limits). */
  context?: string[];
  /** Sections in order; empty ones are dropped. */
  sections: { title: string; body: string | string[] }[];
  /** How to check the fix, e.g. "Reload the page and refresh devkit's SEO panel." */
  verify?: string;
  /** Heading depth of the title: "##" alone, "###" inside the page report. */
  heading?: "##" | "###";
}

export function agentDoc(doc: AgentDoc): string {
  const h = doc.heading ?? "##";
  const sub = h === "##" ? "###" : "####";
  const head = [`${h} ${doc.title}`, doc.url ? `Page: ${doc.url}` : "", doc.result ? `Result: ${doc.result}` : "", ...(doc.context ?? [])]
    .filter(Boolean)
    .join("\n");
  const out = [head];
  for (const s of doc.sections) {
    const body = Array.isArray(s.body) ? s.body.filter(Boolean).join("\n") : s.body;
    if (body.trim()) out.push(`${sub} ${s.title}\n\n${body}`);
  }
  if (doc.verify) out.push(`To check the fix: ${doc.verify}`);
  return out.join("\n\n");
}

/** Numbered list of findings, each one line plus optional indented details. */
export function findingList(items: { text: string; details?: string[] }[]): string {
  return items
    .map((it, i) => [`${i + 1}. ${it.text}`, ...(it.details ?? []).filter(Boolean).map((d) => `   - ${d}`)].join("\n"))
    .join("\n");
}
