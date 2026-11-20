// CSV / TSV for the data page viewer: an RFC 4180 parser, delimiter sniffing, a header guess,
// sorting and filtering. Pure: shared by the content script and the tests.

export type Delimiter = "," | ";" | "\t" | "|";
export const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];

export interface CsvIssue {
  /** 1-based line of the source where the record starts. */
  line: number;
  message: string;
}

export interface CsvResult {
  rows: string[][];
  /** 1-based source line where each record starts (records can span lines inside quotes). */
  lines: number[];
  issues: CsvIssue[];
}

/**
 * RFC 4180, leniently: fields separated by `delimiter`, records by CRLF, LF or CR, fields in double
 * quotes may hold delimiters, line breaks and `""` for a quote. A quote inside an unquoted field is
 * kept as text; text after a closing quote is appended to the field; an unterminated quote runs to
 * the end and is reported. A final line break does not make an empty record; a leading BOM is dropped.
 */
export function parseCsv(text: string, delimiter: Delimiter = ","): CsvResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  const lines: number[] = [];
  const issues: CsvIssue[] = [];
  let row: string[] = [];
  let field = "";
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const n = src.length;
  // True once the current record has any content (so an empty last line is not a record).
  let started = false;
  const endRecord = () => {
    row.push(field);
    rows.push(row);
    lines.push(rowLine);
    row = [];
    field = "";
    started = false;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '"' && field === "") {
      // Quoted field.
      started = true;
      const quoteLine = line;
      i++;
      let closed = false;
      while (i < n) {
        const q = src[i]!;
        if (q === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (q === "\r" || q === "\n") {
          // Line breaks inside quotes are kept as LF, and counted.
          if (q === "\r" && src[i + 1] === "\n") i++;
          field += "\n";
          line++;
          i++;
          continue;
        }
        field += q;
        i++;
      }
      if (!closed) issues.push({ line: quoteLine, message: "Unterminated quoted field" });
      // Anything up to the next delimiter or line break after the closing quote stays in the field.
      while (i < n && src[i] !== delimiter && src[i] !== "\n" && src[i] !== "\r") field += src[i++];
      continue;
    }
    if (c === delimiter) {
      started = true;
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      i++;
      // Blank lines are skipped, like most tools do.
      if (started) endRecord();
      line++;
      rowLine = line;
      continue;
    }
    started = true;
    field += c;
    i++;
  }
  if (started) endRecord();
  return { rows, lines, issues };
}

/** Records of the first `maxChars` characters, cut at the last complete line. */
function sample(text: string, maxChars = 16_384): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars);
}

/**
 * The delimiter that splits the first records into the most consistent number of fields (more than
 * one). Ties go to the order `, ; \t |`, or to tab first when `preferTab` (a TSV content type or URL).
 * Null when no candidate splits anything.
 */
export function sniffDelimiter(text: string, preferTab = false): Delimiter | null {
  const head = sample(text);
  const order: Delimiter[] = preferTab ? ["\t", ",", ";", "|"] : DELIMITERS;
  let best: { d: Delimiter; score: number } | null = null;
  for (const d of order) {
    const rows = parseCsv(head, d).rows.slice(0, 50);
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let mode = 1;
    let modeRows = 0;
    for (const [len, k] of counts) if (k > modeRows || (k === modeRows && len > mode)) [mode, modeRows] = [len, k];
    if (mode < 2) continue;
    // Consistency first, then more fields.
    const score = (modeRows / rows.length) * 1000 + Math.min(mode, 100);
    if (!best || score > best.score) best = { d, score };
  }
  return best?.d ?? null;
}

const NUMBER_RE = /^[-+]?(\d+([.,]\d+)?|\.\d+)([eE][-+]?\d+)?%?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isNumeric(cell: string): boolean {
  return NUMBER_RE.test(cell.trim());
}

/**
 * Heuristic: the first record is a header when its cells are all filled, distinct and not numbers
 * or dates, and either a column below it holds numbers or dates, or there is no data row that looks
 * just like it. The viewer labels this as a guess and lets the user flip it.
 */
export function detectHeader(rows: string[][]): boolean {
  const [first, ...rest] = rows;
  if (!first?.length) return false;
  const cells = first.map((c) => c.trim());
  if (cells.some((c) => !c || isNumeric(c) || DATE_RE.test(c))) return false;
  if (new Set(cells.map((c) => c.toLowerCase())).size !== cells.length) return false;
  if (!rest.length) return true;
  const data = rest.slice(0, 100);
  const typed = cells.some((_, col) => {
    const values = data.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    return values.length > 0 && values.filter((v) => isNumeric(v) || DATE_RE.test(v)).length / values.length >= 0.8;
  });
  if (typed) return true;
  // All text: a header when its values do not repeat in the column below.
  return cells.every((c, col) => !data.some((r) => (r[col] ?? "").trim().toLowerCase() === c.toLowerCase()));
}

function numberOf(cell: string): number | null {
  const t = cell.trim();
  if (!NUMBER_RE.test(t)) return null;
  const n = Number(t.replace(/%$/, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Indexes of `rows` sorted on `column`: numbers numerically when both cells are numbers, otherwise
 * text in natural order (`a2` before `a10`); empty cells always last. Stable.
 */
export function sortRowIndexes(rows: string[][], column: number, direction: "asc" | "desc", indexes?: number[]): number[] {
  const order = indexes ? [...indexes] : rows.map((_, i) => i);
  const sign = direction === "asc" ? 1 : -1;
  return order
    .map((i, pos) => ({ i, pos, cell: rows[i]?.[column] ?? "" }))
    .sort((a, b) => {
      const ae = a.cell.trim() === "";
      const be = b.cell.trim() === "";
      if (ae || be) return ae === be ? a.pos - b.pos : ae ? 1 : -1;
      const an = numberOf(a.cell);
      const bn = numberOf(b.cell);
      const cmp = an !== null && bn !== null ? an - bn : collator.compare(a.cell, b.cell);
      return cmp ? cmp * sign : a.pos - b.pos;
    })
    .map((x) => x.i);
}

/** Indexes of the rows with a cell containing `query` (case-insensitive); all rows when it is empty. */
export function filterRowIndexes(rows: string[][], query: string): number[] {
  const q = query.trim().toLowerCase();
  const all = rows.map((_, i) => i);
  if (!q) return all;
  return all.filter((i) => rows[i]!.some((c) => c.toLowerCase().includes(q)));
}

export interface CsvTable {
  delimiter: Delimiter;
  /** Column names: the header row, or `Column 1`, `Column 2`… */
  columns: string[];
  rows: string[][];
  /** Number of fields each row had before padding. */
  raw: number[];
  /** 1-based source line of each row. */
  lines: number[];
  hasHeader: boolean;
  /** Rows whose number of fields differs from the column count (1-based source lines). */
  ragged: number[];
  /** Fields a row should have: the header's, or the widest row's without a header. */
  fields: number;
  issues: CsvIssue[];
}

/** Parses and shapes a CSV document: delimiter (given or sniffed), header (given or guessed), padded rows. */
export function csvTable(text: string, opts: { delimiter?: Delimiter; header?: boolean; preferTab?: boolean } = {}): CsvTable {
  const delimiter = opts.delimiter ?? sniffDelimiter(text, opts.preferTab) ?? (opts.preferTab ? "\t" : ",");
  const parsed = parseCsv(text, delimiter);
  const hasHeader = opts.header ?? detectHeader(parsed.rows);
  const width = parsed.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const headerRow = hasHeader ? (parsed.rows[0] ?? []) : [];
  const body = hasHeader ? parsed.rows.slice(1) : parsed.rows;
  const lines = hasHeader ? parsed.lines.slice(1) : parsed.lines;
  const expected = hasHeader ? headerRow.length : width;
  const ragged = body.flatMap((r, i) => (r.length !== expected ? [lines[i]!] : []));
  const columns = Array.from({ length: width }, (_, i) => headerRow[i]?.trim() || `Column ${i + 1}`);
  const rows = body.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
  return { delimiter, columns, rows, raw: body.map((r) => r.length), lines, hasHeader, ragged, fields: expected, issues: parsed.issues };
}

export function delimiterName(d: Delimiter): string {
  return d === "," ? "comma" : d === ";" ? "semicolon" : d === "\t" ? "tab" : "pipe";
}
