// "Field data (CrUX)" lines of the Performance "Copy for agent" report, from what the CrUX section loaded.
import { type CruxResult, FORM_FACTOR_TEXT, formatPeriod } from "../crux";
import { formatVital, msLabel, RATING_TEXT, VITALS } from "../viz";

const share = (f: number) => `${Math.round(f * 100)}%`;

/** Markdown body (no heading): scope, period, then one line per vital with its p75, rating and distribution. */
export function cruxMarkdown(result: CruxResult): string {
  const { record, fellBack } = result;
  const what = record.scope === "url" ? `URL ${record.target}` : `origin ${record.target}`;
  const lines = [
    `75th percentile of real Chrome visits over 28 days (${FORM_FACTOR_TEXT[record.formFactor].toLowerCase()}), for the ${what}${record.period ? `, ${formatPeriod(record.period)}` : ""}.`,
  ];
  if (fellBack) lines.push("The URL itself has no field data: these are the origin's.");
  lines.push("");
  for (const m of record.metrics) {
    const t = VITALS[m.name];
    const d = m.distribution;
    lines.push(
      `- ${t.label} p75 ${formatVital(m.name, m.p75)}${m.rating ? ` (${RATING_TEXT[m.rating].toLowerCase()})` : ""}${
        d ? `: ${share(d.good)} good, ${share(d.ni)} needs improvement, ${share(d.poor)} poor` : ""
      }`,
    );
  }
  if (record.rtt !== null) lines.push(`- Round trip time p75 ${msLabel(record.rtt)}`);
  return lines.join("\n");
}
