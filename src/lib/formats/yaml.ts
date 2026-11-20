// A focused YAML reader for the data page viewer, not a full YAML 1.2 implementation. It reads what
// configuration files and API specs use: block mappings and sequences, plain / single / double-quoted
// scalars typed with the YAML 1.2 core schema, flow collections, literal and folded block scalars,
// comments, anchors and aliases (with `<<` merge keys), standard `!!` tags and several documents.
// Anything else (complex `?` keys, custom tags, `%TAG` directives…) is reported as unsupported, so the
// viewer shows the raw text instead of a wrong tree. Pure.

export interface YamlResult {
  ok: boolean;
  /** The single document, or an array of documents when there are several. */
  value?: unknown;
  documents?: number;
  error?: string;
  /** 1-based line of the error. */
  line?: number;
  /** The error is a YAML feature this reader does not handle, not a syntax error. */
  unsupported?: boolean;
}

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly unsupported = false,
  ) {
    super(message);
  }
}

interface Line {
  /** 1-based line number. */
  num: number;
  /** Leading spaces. */
  indent: number;
  /** The line without its indentation and trailing spaces (comments included). */
  text: string;
  raw: string;
}

const isBlank = (l: Line) => !l.text || l.text.trimStart().startsWith("#");
const DASH = /^-(\s|$)/;
const QUESTION = /^\?(\s|$)/;

/** Index of the `#` that starts a comment (after whitespace, outside quotes), or -1. */
function commentStart(s: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]!))) quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return i;
  }
  return -1;
}

function stripComment(s: string): string {
  const i = commentStart(s);
  return (i < 0 ? s : s.slice(0, i)).trimEnd();
}

/* Scalars */

const NULL_RE = /^(~|null|Null|NULL|)$/;
const TRUE_RE = /^(true|True|TRUE)$/;
const FALSE_RE = /^(false|False|FALSE)$/;
const INT_RE = /^[-+]?[0-9]+$/;
const OCT_RE = /^0o[0-7]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const FLOAT_RE = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const INF_RE = /^[-+]?\.(inf|Inf|INF)$/;
const NAN_RE = /^\.(nan|NaN|NAN)$/;

/** A plain scalar typed with the YAML 1.2 core schema (so `yes`, `on` and `2026-01-01` stay strings). */
export function resolvePlain(s: string): unknown {
  if (NULL_RE.test(s)) return null;
  if (TRUE_RE.test(s)) return true;
  if (FALSE_RE.test(s)) return false;
  if (INT_RE.test(s)) return Number(s);
  if (OCT_RE.test(s)) return Number.parseInt(s.slice(2), 8);
  if (HEX_RE.test(s)) return Number.parseInt(s.slice(2), 16);
  if (FLOAT_RE.test(s)) return Number(s);
  if (INF_RE.test(s)) return s.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (NAN_RE.test(s)) return Number.NaN;
  return s;
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: " ",
  L: " ",
  P: " ",
};

interface Segment {
  text: string;
  /** Ended by an escaped line break (`\` at the end of the line): joins the next one without a space. */
  noSpace?: boolean;
}

/** Folds the lines of a multi-line scalar: one break is a space, a break plus n empty lines is n newlines. */
function fold(segments: Segment[]): string {
  let out = "";
  let empties = 0;
  let glue = false;
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (i > 0 && !seg.text && !last && !seg.noSpace) {
      empties++;
      return;
    }
    if (i > 0) out += glue ? "" : empties ? "\n".repeat(empties) : " ";
    out += seg.text;
    empties = 0;
    glue = Boolean(seg.noSpace);
  });
  return out;
}

/** A quoted scalar starting at `s[start]`: the value and the index after the closing quote, or null when it does not close. */
function readQuoted(s: string, start: number, lineNum: number): { value: string; end: number } | null {
  const double = s[start] === '"';
  const segments: Segment[] = [];
  let out = "";
  let i = start + 1;
  const newLine = (noSpace: boolean) => {
    // Spaces before an escaped line break are content; before a plain break they fold away.
    segments.push({ text: noSpace ? out : out.replace(/[ \t]+$/, ""), noSpace });
    out = "";
    while (s[i] === " " || s[i] === "\t") i++;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (double ? c === '"' : c === "'" && s[i + 1] !== "'") {
      segments.push({ text: out });
      return { value: segments.length === 1 ? segments[0]!.text : fold(segments), end: i + 1 };
    }
    if (!double && c === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (double && c === "\\") {
      const e = s[i + 1];
      if (e === "\n") {
        i += 2;
        newLine(true);
        continue;
      }
      if (e === "x" || e === "u" || e === "U") {
        const len = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlError(`Invalid escape \\${e}${hex}`, lineNum);
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      // A backslash at the very end: the scalar continues on the next line.
      if (e === undefined) return null;
      if (!(e in ESCAPES)) throw new YamlError(`Invalid escape \\${e}`, lineNum);
      out += ESCAPES[e];
      i += 2;
      continue;
    }
    if (c === "\n") {
      i++;
      newLine(false);
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

/* Tags and properties */

const STANDARD_TAGS = new Set(["str", "int", "float", "bool", "null", "map", "seq", "binary", "timestamp", "set", "omap", "pairs"]);

interface Props {
  anchor?: string;
  tag?: string;
  rest: string;
}

/** Leading `&anchor` and `!!tag` of a node, in either order. Custom and verbatim tags are unsupported. */
function readProps(s: string, lineNum: number): Props {
  const props: Props = { rest: s };
  for (let k = 0; k < 2; k++) {
    const m = /^(?:&([^\s,[\]{}]+)|!(!?)([^\s,[\]{}]*))(?:\s+|$)/.exec(props.rest);
    if (!m) break;
    if (m[1] !== undefined) {
      if (props.anchor !== undefined) break;
      props.anchor = m[1];
    } else {
      if (props.tag !== undefined) break;
      const name = m[3]!;
      if (m[2] === "!") {
        if (!STANDARD_TAGS.has(name)) throw new YamlError(`the tag !!${name}`, lineNum, true);
        props.tag = name;
      } else if (name === "") props.tag = "!";
      else throw new YamlError(`the custom tag !${name}`, lineNum, true);
    }
    props.rest = props.rest.slice(m[0].length);
  }
  return props;
}

/** A scalar's value under its tag: `!!str 1` is "1", `!!int "1"` is 1, `!` is a string. */
function applyTag(tag: string | undefined, text: string, quoted: boolean, lineNum: number): unknown {
  if (tag === undefined || tag === "map" || tag === "seq" || tag === "set" || tag === "omap" || tag === "pairs")
    return quoted ? text : resolvePlain(text);
  switch (tag) {
    case "int":
    case "float": {
      const v = resolvePlain(text.trim());
      if (typeof v !== "number") throw new YamlError(`Not a number for !!${tag}: ${text}`, lineNum);
      return v;
    }
    case "bool":
      if (TRUE_RE.test(text)) return true;
      if (FALSE_RE.test(text)) return false;
      throw new YamlError(`Not a boolean for !!bool: ${text}`, lineNum);
    case "null":
      return null;
    default:
      // `!`, `!!str`, `!!binary`, `!!timestamp`: the text as written.
      return text;
  }
}

function keyString(key: unknown): string {
  return key === null ? "null" : String(key);
}

/** Sets a key as an own data property, so `__proto__` stays data. */
function setKey(obj: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/* Flow collections */

class FlowReader {
  i = 0;
  constructor(
    readonly s: string,
    readonly lineNum: number,
    readonly anchors: Map<string, unknown>,
  ) {}

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  get line(): number {
    return this.lineNum + (this.s.slice(0, this.i).match(/\n/g)?.length ?? 0);
  }

  fail(message: string): never {
    throw new YamlError(message, this.line);
  }

  value(): unknown {
    this.ws();
    const props = readProps(this.s.slice(this.i), this.line);
    this.i = this.s.length - props.rest.length;
    const c = this.s[this.i];
    let v: unknown;
    if (c === "[") v = this.seq();
    else if (c === "{") v = this.map();
    else if (c === "*") {
      const m = /^\*([^\s,[\]{}]+)/.exec(this.s.slice(this.i));
      if (!m) this.fail("Invalid alias");
      this.i += m[0].length;
      if (!this.anchors.has(m[1]!)) this.fail(`Unknown alias *${m[1]}`);
      v = this.anchors.get(m[1]!);
    } else if (c === '"' || c === "'") {
      const r = readQuoted(this.s, this.i, this.line);
      if (!r) this.fail("Unterminated quoted string");
      this.i = r.end;
      v = applyTag(props.tag, r.value, true, this.line);
    } else {
      const start = this.i;
      while (this.i < this.s.length) {
        const ch = this.s[this.i]!;
        if (ch === "," || ch === "]" || ch === "}" || ch === "[" || ch === "{") break;
        if (ch === ":" && (this.i + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.i + 1]!))) break;
        this.i++;
      }
      const raw = this.s
        .slice(start, this.i)
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(" ");
      v = applyTag(props.tag, raw, false, this.line);
    }
    if (props.anchor !== undefined) this.anchors.set(props.anchor, v);
    return v;
  }

  seq(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) this.fail("Unterminated flow sequence");
      if (QUESTION.test(this.s.slice(this.i))) throw new YamlError("complex keys (?)", this.line, true);
      let v = this.value();
      this.ws();
      if (this.s[this.i] === ":") {
        // `[a, key: value]`: a single-pair mapping (ESLint configs use it).
        if (v !== null && typeof v === "object") throw new YamlError("collections as mapping keys", this.line, true);
        this.i++;
        this.ws();
        const pair: Record<string, unknown> = {};
        setKey(pair, keyString(v), this.s[this.i] === "," || this.s[this.i] === "]" ? null : this.value());
        v = pair;
        this.ws();
      }
      out.push(v);
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail("Expected , or ] in a flow sequence");
    }
  }

  map(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) this.fail("Unterminated flow mapping");
      if (QUESTION.test(this.s.slice(this.i))) throw new YamlError("complex keys (?)", this.line, true);
      const key = this.value();
      if (key !== null && typeof key === "object") throw new YamlError("collections as mapping keys", this.line, true);
      this.ws();
      let v: unknown = null;
      if (this.s[this.i] === ":") {
        this.i++;
        this.ws();
        v = this.s[this.i] === "," || this.s[this.i] === "}" ? null : this.value();
        this.ws();
      }
      setKey(out, keyString(key), v);
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") this.fail("Expected , or } in a flow mapping");
    }
  }
}

/** Whether the brackets of a flow collection close in `s` (quotes respected). */
function flowClosed(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/* Block structure */

/** The key of a block mapping line (`key: value`, `"key": value`) and the text after the colon, or null. */
export function splitKey(text: string, lineNum = 0): { key: string; rest: string } | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const r = readQuoted(text, 0, lineNum);
    if (!r) return null;
    const m = /^[ \t]*:(\s|$)/.exec(text.slice(r.end));
    return m ? { key: r.value, rest: text.slice(r.end + m[0].length).trim() } : null;
  }
  if (/^[[\]{}#&*!|>%@`,]/.test(text) || /^[-?:](\s|$)/.test(text)) return null;
  const m = /^(.*?[^\s]):(\s|$)/.exec(text);
  if (!m) return null;
  const key = m[1]!.trim();
  if (/\s#/.test(key)) return null;
  return { key, rest: text.slice(m[0].length).trim() };
}

class BlockParser {
  pos = 0;
  readonly anchors = new Map<string, unknown>();
  constructor(readonly lines: Line[]) {}

  /** The next line with content (skips blank and comment lines). */
  peek(): Line | undefined {
    while (this.pos < this.lines.length && isBlank(this.lines[this.pos]!)) this.pos++;
    return this.lines[this.pos];
  }

  /** Structural lines may not be indented with tabs. */
  checkTabs(line: Line) {
    if (line.text.startsWith("\t")) throw new YamlError("Tabs are not allowed in indentation", line.num);
  }

  /** A node whose lines are indented at least `min`. Null when the next content line is less indented. */
  node(min: number): unknown {
    const line = this.peek();
    if (!line || line.indent < min) return null;
    return this.nodeAt(line);
  }

  nodeAt(line: Line): unknown {
    this.checkTabs(line);
    const text = stripComment(line.text);
    if (DASH.test(text)) return this.sequence(line.indent);
    if (QUESTION.test(text)) throw new YamlError("complex keys (?)", line.num, true);
    if (splitKey(text, line.num)) return this.mapping(line.indent);
    // A lone value: a scalar, a flow collection, a block scalar, or properties before a block node.
    this.pos++;
    return this.inline(text, line, line.indent - 1, false);
  }

  mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("Bad indentation of a mapping entry", line.num);
      this.checkTabs(line);
      const text = stripComment(line.text);
      if (QUESTION.test(text)) throw new YamlError("complex keys (?)", line.num, true);
      const kv = splitKey(text, line.num);
      if (!kv) {
        if (DASH.test(text)) throw new YamlError("A sequence item where a mapping key was expected", line.num);
        throw new YamlError("Expected a mapping entry (key: value)", line.num);
      }
      this.pos++;
      const value = this.inline(kv.rest, line, indent, true);
      if (kv.key === "<<" && text.startsWith("<<")) this.merge(out, value, line.num);
      else setKey(out, kv.key, value);
    }
    return out;
  }

  /** `<<: *base` or `<<: [*a, *b]`: copies the keys this mapping does not set itself. */
  merge(out: Record<string, unknown>, value: unknown, lineNum: number) {
    for (const src of Array.isArray(value) ? value : [value]) {
      if (!src || typeof src !== "object" || Array.isArray(src))
        throw new YamlError("A merge key (<<) needs a mapping or a list of mappings", lineNum);
      for (const [k, v] of Object.entries(src)) if (!Object.hasOwn(out, k)) setKey(out, k, v);
    }
  }

  sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      this.checkTabs(line);
      const text = stripComment(line.text);
      if (line.indent > indent || !DASH.test(text)) {
        // A key at the dash's column ends a sequence written as a mapping value (`key:\n- a\nnext: b`).
        if (line.indent === indent && splitKey(text, line.num)) break;
        throw new YamlError("Bad indentation of a sequence item", line.num);
      }
      const after = line.text.slice(1);
      const rest = after.trimStart();
      const col = indent + 1 + (after.length - rest.length);
      const restText = stripComment(rest);
      if (QUESTION.test(restText)) throw new YamlError("complex keys (?)", line.num, true);
      if (restText && (DASH.test(restText) || splitKey(restText, line.num))) {
        // `- key: value` or `- - item`: the rest of the line starts a node indented at its column.
        this.lines[this.pos] = { ...line, indent: col, text: rest };
        out.push(this.nodeAt(this.lines[this.pos]!));
      } else {
        this.pos++;
        out.push(this.inline(restText, line, indent, false));
      }
    }
    return out;
  }

  /**
   * The value written after a key's colon, a sequence dash, or alone on its line, whose parent sits
   * at column `owner`. When empty (or only properties), the value is the block node below.
   */
  inline(rest: string, line: Line, owner: number, inMapping: boolean): unknown {
    const props = readProps(rest, line.num);
    const text = props.rest;
    let value: unknown;
    if (!text) {
      const next = this.peek();
      if (next && next.indent > owner) value = this.nodeAt(next);
      else if (next && inMapping && next.indent === owner && DASH.test(next.text)) value = this.sequence(owner);
      else value = props.tag ? applyTag(props.tag, "", false, line.num) : null;
    } else if (text.startsWith("*")) {
      const m = /^\*([^\s,[\]{}]+)$/.exec(text);
      if (!m) throw new YamlError("Invalid alias", line.num);
      if (!this.anchors.has(m[1]!)) throw new YamlError(`Unknown alias *${m[1]}`, line.num);
      value = this.anchors.get(m[1]!);
    } else if (text.startsWith("|") || text.startsWith(">")) {
      value = this.blockScalar(text, line, owner);
    } else if (text.startsWith("[") || text.startsWith("{")) {
      value = this.flow(text, line);
    } else if (text.startsWith('"') || text.startsWith("'")) {
      value = applyTag(props.tag, this.quoted(text, line), true, line.num);
    } else {
      if (DASH.test(text)) throw new YamlError("A block sequence cannot start on the line of its key", line.num);
      if (QUESTION.test(text)) throw new YamlError("complex keys (?)", line.num, true);
      if (/^[@`]/.test(text)) throw new YamlError(`A plain value cannot start with ${text[0]}`, line.num);
      if (splitKey(text, line.num)) throw new YamlError("Nested mappings must start on their own line", line.num);
      const raw = commentStart(line.text) >= 0 ? text.trim() : this.plainContinuation(text, owner);
      value = applyTag(props.tag, raw, false, line.num);
    }
    if (props.anchor !== undefined) this.anchors.set(props.anchor, value);
    return value;
  }

  /** A plain scalar continued on lines indented past `owner`, folded. */
  plainContinuation(first: string, owner: number): string {
    const parts: Segment[] = [{ text: first.trim() }];
    let blanks = 0;
    for (;;) {
      const l = this.lines[this.pos];
      if (!l) break;
      if (!l.text.trim()) {
        blanks++;
        this.pos++;
        continue;
      }
      if (l.indent <= owner || l.text.trimStart().startsWith("#")) break;
      const t = stripComment(l.text).trim();
      if (splitKey(t, l.num) || DASH.test(t)) throw new YamlError("Mapping values are not allowed here", l.num);
      for (; blanks > 0; blanks--) parts.push({ text: "" });
      parts.push({ text: t });
      this.pos++;
      if (commentStart(l.text) >= 0) break;
    }
    return fold(parts);
  }

  /** A quoted scalar, possibly spanning lines. */
  quoted(text: string, line: Line): string {
    let src = text;
    for (;;) {
      const r = readQuoted(src, 0, line.num);
      if (r) {
        const tail = src.slice(r.end).trim();
        if (tail && !tail.startsWith("#")) throw new YamlError("Unexpected text after a quoted string", line.num);
        return r.value;
      }
      const next = this.lines[this.pos];
      if (!next) throw new YamlError("Unterminated quoted string", line.num);
      src += `\n${next.raw.trim() ? next.raw.trimStart() : ""}`;
      this.pos++;
    }
  }

  /** A flow collection, possibly spanning lines (comments removed line by line). */
  flow(text: string, line: Line): unknown {
    let src = text;
    while (!flowClosed(src)) {
      const next = this.lines[this.pos];
      if (!next) throw new YamlError("Unterminated flow collection", line.num);
      src += `\n${stripComment(next.text)}`;
      this.pos++;
    }
    const reader = new FlowReader(src, line.num, this.anchors);
    const value = reader.value();
    reader.ws();
    if (reader.i < src.length) throw new YamlError("Unexpected text after a flow collection", reader.line);
    return value;
  }

  /** `|` (literal) or `>` (folded), with chomping (`-` strip, `+` keep) and an optional indentation digit. */
  blockScalar(header: string, line: Line, owner: number): string {
    const m = /^([|>])(?:([-+])?([1-9])?|([1-9])([-+]))$/.exec(header.trim());
    if (!m) throw new YamlError("Invalid block scalar header", line.num);
    const literal = m[1] === "|";
    const chomp = m[2] ?? m[5] ?? "";
    const digit = m[3] ?? m[4];
    let indent = digit ? Math.max(owner, 0) + Number(digit) : -1;
    const body: string[] = [];
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos]!;
      if (!l.raw.trim()) {
        body.push(indent >= 0 ? l.raw.slice(indent) : "");
        this.pos++;
        continue;
      }
      if (indent < 0) {
        if (l.indent <= owner) break;
        indent = l.indent;
      }
      if (l.indent < indent) break;
      body.push(l.raw.slice(indent));
      this.pos++;
    }
    // Trailing blank lines are the chomping's business, not the content's.
    let trailing = 0;
    while (body.length && !body[body.length - 1]!.trim()) {
      body.pop();
      trailing++;
    }
    if (!body.length) return chomp === "+" ? "\n".repeat(trailing) : "";
    let text: string;
    if (literal) text = body.join("\n");
    else {
      // Folding: lines join with a space, empty lines are newlines, more-indented lines keep their breaks.
      text = "";
      let empties = 0;
      let prevMore = false;
      body.forEach((l, i) => {
        if (!l.trim()) {
          empties++;
          return;
        }
        const more = /^[ \t]/.test(l);
        if (i === empties) text += "\n".repeat(empties);
        else if (more || prevMore) text += "\n".repeat(empties + 1);
        else text += empties ? "\n".repeat(empties) : " ";
        text += l;
        empties = 0;
        prevMore = more;
      });
    }
    if (chomp === "-") return text;
    if (chomp === "+") return `${text}\n${"\n".repeat(trailing)}`;
    return `${text}\n`;
  }
}

function toLines(src: string[], first: number): Line[] {
  return src.map((raw, i) => {
    const indent = /^ */.exec(raw)![0].length;
    return { num: first + i, indent, text: raw.slice(indent).trimEnd(), raw };
  });
}

/** Parses a YAML stream: one value, or an array of values for several `---` documents. */
export function parseYaml(text: string): YamlResult {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  const docs: { lines: string[]; first: number }[] = [];
  let cur: { lines: string[]; first: number } | null = null;
  try {
    for (let i = 0; i < src.length; i++) {
      const raw = src[i]!;
      if (!cur && raw.startsWith("%")) {
        if (/^%TAG\s/.test(raw)) throw new YamlError("%TAG directives", i + 1, true);
        continue;
      }
      if (/^---(\s|$)/.test(raw)) {
        cur = { lines: [], first: i + 1 };
        docs.push(cur);
        // `--- value` or `--- |`: the value is the document's first line.
        const rest = raw.slice(3).trim();
        cur.lines.push(rest.startsWith("#") ? "" : rest);
        continue;
      }
      if (/^\.\.\.(\s|$)/.test(raw)) {
        cur = null;
        continue;
      }
      if (!cur) {
        if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
        cur = { lines: [], first: i + 1 };
        docs.push(cur);
      }
      cur.lines.push(raw);
    }
    const values = docs.map((d) => {
      const p = new BlockParser(toLines(d.lines, d.first));
      const v = p.node(0);
      const extra = p.peek();
      if (extra) throw new YamlError(extra.indent > 0 ? "Bad indentation" : "Unexpected content after the document's root node", extra.num);
      return v;
    });
    if (!values.length) return { ok: true, value: null, documents: 0 };
    return { ok: true, value: values.length === 1 ? values[0] : values, documents: values.length };
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, error: e.message, line: e.line, ...(e.unsupported ? { unsupported: true } : {}) };
    throw e;
  }
}

/** Banner text for a YAML document that could not be read. */
export function yamlProblemMessage(result: YamlResult): string {
  const at = result.line ? ` (line ${result.line})` : "";
  return result.unsupported
    ? `This YAML uses ${result.error}${at}, which devkit's YAML reader does not support: shown as raw text.`
    : `Invalid YAML at line ${result.line ?? "?"}: ${result.error}`;
}
