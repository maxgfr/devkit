// The whole page as one fix list for a coding agent: a status table, then the report of every area
// that has something to fix, in the order a developer should take them. Pure: Overview gathers the data.
import { plural } from "../agent-md";
import { hasFindings } from "./inspect";

export interface PagePart {
  /** Area name as the panels call it, e.g. "Security headers". */
  area: string;
  /** Where to re-run it in devkit, e.g. "Security › Headers". */
  panel: string;
  /** The area's own "Copy for agent" Markdown at "##" depth, or null when it could not be measured. */
  md: string | null;
  /** Why it is missing, when md is null. */
  missing?: string;
  /** Overrides the "To fix / Worth checking" detection (for reports with their own shape). */
  findings?: boolean;
}

const resultOf = (md: string) => /^Result: (.+)$/m.exec(md)?.[1]?.trim() ?? "See below.";
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function pageReportMarkdown(parts: PagePart[], ctx: { url: string; title?: string; notCovered?: string[] }): string {
  const withFindings = parts.filter((p) => p.md !== null && (p.findings ?? hasFindings(p.md)));
  const clean = parts.filter((p) => p.md !== null && !(p.findings ?? hasFindings(p.md)));
  const missing = parts.filter((p) => p.md === null);
  const head = [
    `# Fix list for ${ctx.title?.trim() || ctx.url}`,
    `Page: ${ctx.url}`,
    `Result: ${withFindings.length ? `${plural(withFindings.length, "area")} to fix` : "nothing to fix in the areas measured"}${clean.length ? `, ${plural(clean.length, "area")} clean` : ""}${missing.length ? `, ${missing.length} not measured` : ""}.`,
    "Collected by devkit from the page as the browser received it. Fix each problem at its source (templates, components, build or server config), not in the browser, then re-run the devkit panel named for the area.",
  ];
  const table = [
    "| Area | Result | Re-run in devkit |",
    "| --- | --- | --- |",
    ...parts.map(
      (p) => `| ${cell(p.area)} | ${cell(p.md === null ? `Not measured: ${p.missing ?? "no data"}` : resultOf(p.md))} | ${cell(p.panel)} |`,
    ),
  ];
  const out = [head.join("\n"), table.join("\n"), ...withFindings.map((p) => p.md as string)];
  if (ctx.notCovered?.length) out.push(`Not in this list (each has its own "Copy for agent" in devkit): ${ctx.notCovered.join(", ")}.`);
  return out.join("\n\n");
}

/** Pushes every Markdown heading one level down, so a standalone "#" report fits under the page title. */
export const demoteHeadings = (md: string) => md.replace(/^(#{1,5}) /gm, "#$1 ");
