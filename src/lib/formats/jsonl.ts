// JSON Lines / NDJSON / JSON text sequences (RFC 7464) for the data page viewer. Pure.
import { parseJson } from "../utils/json";

export interface JsonLine {
  /** 1-based line of the source. */
  line: number;
  text: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  column?: number;
}

export interface JsonLinesResult {
  items: JsonLine[];
  valid: number;
  invalid: number;
}

/**
 * One JSON value per non-blank line. The record separator of `application/json-seq` (U+001E) is
 * treated as a line start, so both shapes read the same. Each invalid line keeps its error.
 */
export function parseJsonLines(text: string): JsonLinesResult {
  const items: JsonLine[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replaceAll("\u001e", "");
    if (!raw.trim()) continue;
    const parsed = parseJson(raw);
    items.push(
      parsed.ok
        ? { line: i + 1, text: raw, ok: true, value: parsed.value }
        : { line: i + 1, text: raw, ok: false, error: parsed.error ?? "Invalid JSON", column: parsed.column },
    );
  }
  const valid = items.filter((l) => l.ok).length;
  return { items, valid, invalid: items.length - valid };
}

/**
 * Text that reads as JSON Lines rather than one JSON document: at least two non-blank lines, every
 * one of them a JSON object or array. Used to sniff `text/plain` documents.
 */
export function looksLikeJsonLines(text: string): boolean {
  const { items, invalid } = parseJsonLines(text);
  return items.length >= 2 && invalid === 0 && items.every((l) => l.value !== null && typeof l.value === "object");
}

/** Banner text for the invalid lines: `Line 4 is not valid JSON` or `3 of 20 lines are not valid JSON: 4, 7, 9`. */
export function invalidLinesMessage(result: JsonLinesResult): string {
  const bad = result.items.filter((l) => !l.ok).map((l) => l.line);
  if (!bad.length) return "";
  if (bad.length === 1) return `Line ${bad[0]} is not valid JSON`;
  const shown = bad.slice(0, 10).join(", ");
  return `${bad.length} of ${result.items.length} lines are not valid JSON: ${shown}${bad.length > 10 ? "…" : ""}`;
}
