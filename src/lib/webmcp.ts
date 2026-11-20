// Static analysis of WebMCP tools (see src/lib/page/webmcp.ts for the API itself): naming, description, input
// and output schemas, annotations, and a risk class. Pure. Everything here is a heuristic read of names and
// texts: a tool that is named "get_*" can still change data, and the page decides what a tool really does.
import type { Level } from "./headers";
import type { WebMcpTool } from "./page/webmcp";

export type Risk = "low" | "medium" | "high" | "critical";
export const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];
export const RISK_TEXT: Record<Risk, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

export type FindingArea = "name" | "description" | "input" | "output" | "annotations";

export interface ToolFinding {
  level: Level;
  area: FindingArea;
  message: string;
}

export type NameStyle = "snake_case" | "camelCase" | "kebab-case" | "PascalCase" | "lowercase" | "mixed";

export interface ToolAnalysis {
  tool: WebMcpTool;
  findings: ToolFinding[];
  risk: Risk;
  riskReasons: string[];
  /** readOnlyHint is true. */
  readOnly: boolean;
  /** destructiveHint or consequentialHint is true. */
  flagged: boolean;
  /** Some annotations contradict each other or the name. */
  contradictory: boolean;
  /** 0–1: how well the description does its job (presence, length, not just the name, effects named). */
  descriptionScore: number;
  /** 0–1: how usable the input schema is (valid object, typed and described properties, sane required/enums). */
  schemaScore: number;
  /** Words of the name, lowercased: "deleteAccount" → ["delete", "account"]. */
  words: string[];
}

/** Splits snake_case, camelCase, kebab-case and dotted names into lowercase words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function nameStyle(name: string): NameStyle {
  if (/^[a-z][a-z0-9]*$/.test(name)) return "lowercase";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return "camelCase";
  if (/^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$/.test(name)) return "PascalCase";
  return "mixed";
}

/** Verbs that only read: a tool starting with one is expected to be read-only. */
export const READ_VERBS = new Set(
  "get list search find read fetch query lookup look show view check count describe calculate compute convert preview explain summarize summarise browse filter sort compare estimate validate inspect load retrieve recommend suggest track locate translate".split(
    " ",
  ),
);
/** Verbs that change something the user can undo or redo (Medium). */
export const WRITE_VERBS = new Set(
  "add create update set edit save toggle fill select choose apply change modify rename move upload enable disable start stop open close mark like follow subscribe join register reset clear insert append attach assign configure customize customise schedule rate review vote bookmark favorite favourite navigate go play pause sign log".split(
    " ",
  ),
);
/** Verbs whose effect leaves the page or is hard to take back (High). */
export const HIGH_VERBS = new Set(
  "delete remove cancel send post publish submit transfer destroy erase purge wipe revoke drop reject approve invite share book reserve email unsubscribe archive deploy merge confirm".split(
    " ",
  ),
);
/** Verbs that move money or commit the user to a purchase (Critical). */
export const CRITICAL_VERBS = new Set("pay purchase buy checkout order charge withdraw donate".split(" "));
/** Write verbs that change stored data: a read-only annotation on them is a contradiction. */
const DATA_VERBS = new Set(
  "add create update set edit save change modify rename move upload insert append register reset clear".split(" "),
);
const VERBS = new Set([
  ...READ_VERBS,
  ...WRITE_VERBS,
  ...HIGH_VERBS,
  ...CRITICAL_VERBS,
  "do",
  "run",
  "execute",
  "make",
  "generate",
  "use",
  "ask",
]);

/** Nouns that make a write tool critical whatever its verb: accounts, credentials, money. */
const CRITICAL_NOUNS = [
  "password",
  "passwords",
  "credential",
  "credentials",
  "payment",
  "payments",
  "iban",
  "funds",
  "money",
  "wallet",
  "checkout",
];
/** Descriptions that announce a critical effect. */
const CRITICAL_PHRASES =
  /\b(pay(s|ing)? (for|with|the)|payment|purchas(e|es|ing)|check ?out|charg(e|es|ing) (the|your|a) (card|account|customer)|places? (an|the) order|transfer(s|ring)? (funds|money)|wire transfer|delete(s)? (the|your|an|a user'?s?) account|clos(e|es) (the|your) account|(change|reset|update)s? (the|your)? ?password|credit card|bank account)\b/i;
const EFFECT_WORDS =
  /\b(creat|add|updat|delet|remov|send|sent|post|publish|submit|chang|modif|sav|plac|charg|cancel|book|reserv|transfer|writ|set|replac|overwrit|permanent|irreversib|cannot be undone|can't be undone|undo|will|effect)\w*/i;

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Annotation names the WebMCP spec (readOnly, untrustedContent, consequential, debugging) and MCP (destructive, idempotent, openWorld) define. */
export const KNOWN_ANNOTATIONS = [
  "readOnlyHint",
  "consequentialHint",
  "untrustedContentHint",
  "debugging",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "title",
];

interface SchemaReport {
  findings: ToolFinding[];
  props: number;
  typed: number;
  described: number;
  requiredOk: boolean;
  enumsOk: boolean;
  valid: boolean;
}

/** Checks one JSON Schema node of an input or output schema, recursing into object properties and array items. */
function checkSchemaNode(node: unknown, path: string, area: FindingArea, out: SchemaReport, depth: number) {
  const push = (level: Level, message: string) => out.findings.push({ level, area, message });
  if (!isObject(node)) {
    push("bad", `${path} is not a schema object`);
    out.valid = false;
    return;
  }
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  for (const t of types)
    if (typeof t !== "string" || !JSON_TYPES.has(t)) {
      push("bad", `${path}: "${String(t)}" is not a JSON Schema type`);
      out.valid = false;
    }
  if (Array.isArray(node.enum)) {
    const values = node.enum as unknown[];
    if (!values.length) {
      push("bad", `${path}: enum is empty, no value can match`);
      out.enumsOk = false;
    } else {
      if (new Set(values.map((v) => JSON.stringify(v))).size !== values.length) {
        push("warn", `${path}: enum lists the same value twice`);
        out.enumsOk = false;
      }
      const kinds = new Set(values.map((v) => (v === null ? "null" : typeof v)));
      if (kinds.size > 1) {
        push("warn", `${path}: enum mixes ${Array.from(kinds).join(" and ")} values`);
        out.enumsOk = false;
      }
      const t = types[0];
      if (
        t &&
        values.some((v) => (t === "integer" || t === "number" ? typeof v !== "number" : t === "string" ? typeof v !== "string" : false))
      ) {
        push("warn", `${path}: enum values do not match type "${t}"`);
        out.enumsOk = false;
      }
      if (values.length === 1) push("info", `${path}: an enum of one value is a constant; use "const" or drop the parameter`);
    }
  } else if (node.enum !== undefined) {
    push("bad", `${path}: enum must be an array`);
    out.enumsOk = false;
  }
  if (types.includes("array")) {
    if (node.items === undefined) push("warn", `${path}: array without "items": agents cannot know what goes in it`);
    else if (depth < 4 && isObject(node.items)) checkSchemaNode(node.items, `${path}[]`, area, out, depth + 1);
  }
  if (types.includes("object") || isObject(node.properties)) {
    if (node.properties !== undefined && !isObject(node.properties)) {
      push("bad", `${path}: properties must be an object`);
      out.valid = false;
      return;
    }
    const props = isObject(node.properties) ? node.properties : {};
    const names = Object.keys(props);
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string")) {
        push("bad", `${path}: required must be an array of property names`);
        out.requiredOk = false;
      } else {
        const missing = (node.required as string[]).filter((r) => !names.includes(r));
        if (missing.length) {
          push("bad", `${path}: required lists ${missing.map((m) => `"${m}"`).join(", ")}, not in properties`);
          out.requiredOk = false;
        }
      }
    }
    if (depth > 0 && !names.length && node.additionalProperties === undefined)
      push("warn", `${path}: object without properties: say which keys it takes`);
    const untyped: string[] = [];
    const undescribed: string[] = [];
    for (const key of names) {
      const p = props[key];
      const where = depth === 0 ? key : `${path}.${key}`;
      out.props++;
      if (!isObject(p)) {
        push("bad", `${where}: the property schema is not an object`);
        out.valid = false;
        continue;
      }
      const typed = p.type !== undefined || p.enum !== undefined || p.const !== undefined || p.anyOf || p.oneOf || p.allOf || p.$ref;
      if (typed) out.typed++;
      else untyped.push(where);
      const described = typeof p.description === "string" && p.description.trim().length > 0;
      if (described) out.described++;
      else undescribed.push(where);
      if (described && (p.description as string).trim().toLowerCase() === key.toLowerCase())
        push("warn", `${where}: the description only repeats the name`);
      if (depth < 4) checkSchemaNode(p, where, area, out, depth + 1);
    }
    if (untyped.length)
      push(
        "warn",
        `${untyped.length === 1 ? "Parameter" : `${untyped.length} parameters`} without a type (accept anything): ${untyped.join(", ")}`,
      );
    if (undescribed.length)
      push(
        "warn",
        `${undescribed.length === 1 ? "Parameter" : `${undescribed.length} parameters`} without a description: ${undescribed.join(", ")}`,
      );
  }
}

function checkInputSchema(tool: WebMcpTool): { findings: ToolFinding[]; score: number } {
  const area: FindingArea = "input";
  if (tool.inputSchemaError)
    return {
      findings: [{ level: "bad", area, message: "inputSchema is a string that is not valid JSON" }],
      score: 0,
    };
  const s = tool.inputSchema;
  if (s === null || s === undefined)
    return {
      findings: [
        {
          level: "warn",
          area,
          message:
            'No inputSchema: agents cannot tell which arguments the tool takes. Use {"type":"object","properties":{}} for a tool without arguments.',
        },
      ],
      score: 0.2,
    };
  if (!isObject(s)) return { findings: [{ level: "bad", area, message: "inputSchema is not a JSON Schema object" }], score: 0 };
  const out: SchemaReport = { findings: [], props: 0, typed: 0, described: 0, requiredOk: true, enumsOk: true, valid: true };
  if (s.type !== "object") {
    out.findings.push({
      level: "bad",
      area,
      message: `inputSchema.type is ${s.type === undefined ? "missing" : JSON.stringify(s.type)}: it must be "object"`,
    });
    out.valid = false;
  }
  checkSchemaNode({ ...s, type: "object" }, "inputSchema", area, out, 0);
  if (!out.props && !out.findings.length) out.findings.push({ level: "info", area, message: "Takes no arguments" });
  // Valid object 0.4, typed 0.2, described 0.2, required ⊆ properties 0.1, enums and arrays sane 0.1.
  const ratio = (n: number) => (out.props ? n / out.props : 1);
  const score =
    (out.valid ? 0.4 : 0) +
    0.2 * ratio(out.typed) +
    0.2 * ratio(out.described) +
    (out.requiredOk ? 0.1 : 0) +
    (out.enumsOk && !out.findings.some((f) => /array without/.test(f.message)) ? 0.1 : 0);
  return { findings: out.findings, score: out.valid ? score : Math.min(score, 0.4) };
}

function checkOutputSchema(tool: WebMcpTool): ToolFinding[] {
  const s = tool.outputSchema;
  if (s === undefined || s === null) return [];
  if (!isObject(s)) return [{ level: "bad", area: "output", message: "outputSchema is not a JSON Schema object" }];
  const out: SchemaReport = { findings: [], props: 0, typed: 0, described: 0, requiredOk: true, enumsOk: true, valid: true };
  if (s.type === undefined && !s.anyOf && !s.oneOf && !s.$ref)
    out.findings.push({ level: "warn", area: "output", message: "outputSchema has no type" });
  checkSchemaNode(s, "outputSchema", "output", out, 0);
  // Output properties without a description matter less than input ones.
  return out.findings.map((f) => (f.level === "warn" && /without a description/.test(f.message) ? { ...f, level: "info" as Level } : f));
}

export interface AnalyzeOptions {
  /** The naming style most tools of the page use, to flag the odd one out. */
  majorityStyle?: NameStyle;
}

/** Static analysis and risk class of one tool. */
export function analyzeTool(tool: WebMcpTool, opts: AnalyzeOptions = {}): ToolAnalysis {
  const findings: ToolFinding[] = [];
  const words = nameWords(tool.name);
  const verb = words[0] ?? "";
  const a = tool.annotations ?? {};
  const readOnly = a.readOnlyHint === true;
  const destructive = a.destructiveHint === true;
  const consequential = a.consequentialHint === true;
  const flagged = destructive || consequential;
  const text = `${tool.title ?? ""} ${tool.description}`;

  // Name
  if (!tool.name.trim()) findings.push({ level: "bad", area: "name", message: "The tool has no name" });
  else {
    if (!/^[A-Za-z0-9_.-]+$/.test(tool.name))
      findings.push({
        level: "bad",
        area: "name",
        message: "Use letters, digits, _ - and . only: spaces and other characters break some agents",
      });
    if (tool.name.length > 64)
      findings.push({ level: "warn", area: "name", message: `Name is ${tool.name.length} characters: keep it under 64` });
    else if (tool.name.length < 3) findings.push({ level: "warn", area: "name", message: "Name is too short to say what the tool does" });
    const style = nameStyle(tool.name);
    if (style === "mixed") findings.push({ level: "warn", area: "name", message: "Name mixes conventions: pick snake_case or camelCase" });
    else if (opts.majorityStyle && style !== "lowercase" && opts.majorityStyle !== "lowercase" && style !== opts.majorityStyle)
      findings.push({ level: "warn", area: "name", message: `Name is ${style} while the page's other tools use ${opts.majorityStyle}` });
    if (verb && !VERBS.has(verb))
      findings.push({
        level: "info",
        area: "name",
        message: `Start the name with a verb (search_products, add_to_cart): "${verb}" does not read as one`,
      });
  }

  // Risk, from the name, the description and the annotations.
  const reasons: string[] = [];
  let risk: Risk = "medium";
  const criticalVerb = CRITICAL_VERBS.has(verb) || words.includes("checkout");
  const criticalNoun = words.find((w) => CRITICAL_NOUNS.includes(w));
  const accountDeletion =
    words.includes("account") && words.some((w) => ["delete", "remove", "close", "deactivate", "terminate", "destroy"].includes(w));
  const highVerb =
    HIGH_VERBS.has(verb) || words.slice(1).some((w) => ["delete", "remove", "cancel", "send", "publish", "submit", "transfer"].includes(w));
  const readVerb = READ_VERBS.has(verb);
  if (accountDeletion) reasons.push("The name deletes or closes an account");
  if (criticalVerb) reasons.push(`"${verb}" moves money or places an order`);
  if (criticalNoun && !readVerb) reasons.push(`The name touches ${criticalNoun === "card" ? "payment cards" : criticalNoun}`);
  const criticalText = CRITICAL_PHRASES.exec(text);
  if (accountDeletion || criticalVerb || (criticalNoun && !readVerb)) risk = "critical";
  else if (criticalText && !readOnly) {
    risk = "critical";
    reasons.push(`The description mentions "${criticalText[0]}"`);
  } else if (flagged || highVerb) {
    risk = "high";
    if (destructive) reasons.push("destructiveHint is true");
    if (consequential) reasons.push("consequentialHint is true");
    if (highVerb)
      reasons.push(`"${HIGH_VERBS.has(verb) ? verb : words.find((w) => HIGH_VERBS.has(w))}" sends, publishes or removes something`);
  } else if (readOnly) {
    risk = "low";
    reasons.push("readOnlyHint is true");
  } else if (readVerb) {
    risk = "low";
    reasons.push(`"${verb}" reads data; readOnlyHint is not set, so this rests on the name only`);
  } else {
    risk = "medium";
    reasons.push(
      WRITE_VERBS.has(verb)
        ? `"${verb}" changes state the user can usually undo`
        : "Not marked readOnlyHint: agents assume it can change state",
    );
  }
  if (risk === "critical" && (destructive || consequential))
    reasons.push(`${destructive ? "destructiveHint" : "consequentialHint"} is true`);

  // Annotations
  let contradictory = false;
  for (const [k, v] of Object.entries(a)) {
    if (!KNOWN_ANNOTATIONS.includes(k)) findings.push({ level: "info", area: "annotations", message: `Unknown annotation "${k}"` });
    else if (k !== "title" && typeof v !== "boolean")
      findings.push({ level: "warn", area: "annotations", message: `${k} should be true or false, not ${JSON.stringify(v)}` });
  }
  if (readOnly && flagged) {
    contradictory = true;
    findings.push({
      level: "bad",
      area: "annotations",
      message: `readOnlyHint and ${destructive ? "destructiveHint" : "consequentialHint"} are both true: a read-only tool cannot be destructive`,
    });
  }
  if (readOnly && (risk === "critical" || HIGH_VERBS.has(verb) || CRITICAL_VERBS.has(verb) || DATA_VERBS.has(verb))) {
    contradictory = true;
    findings.push({
      level: "bad",
      area: "annotations",
      message: `readOnlyHint is true but "${tool.name}" reads as a tool that changes data`,
    });
  }
  if (
    a.destructiveHint === false &&
    (risk === "critical" || HIGH_VERBS.has(verb)) &&
    !["send", "post", "publish", "share", "invite", "email", "book", "reserve", "submit", "confirm"].includes(verb)
  )
    findings.push({ level: "warn", area: "annotations", message: `destructiveHint is false but "${tool.name}" reads as destructive` });
  if (readOnly && a.idempotentHint === false)
    findings.push({ level: "info", area: "annotations", message: "idempotentHint means something only for tools that write" });
  if (!tool.annotations || !Object.keys(a).length) {
    if (risk === "critical" || risk === "high")
      findings.push({
        level: "bad",
        area: "annotations",
        message: "No annotations on a sensitive tool: set consequentialHint (or destructiveHint) so agents ask the user before running it",
      });
    else if (risk === "low")
      findings.push({
        level: "warn",
        area: "annotations",
        message: "Set readOnlyHint: true so agents know they can call it without asking",
      });
    else findings.push({ level: "info", area: "annotations", message: "No annotations: agents treat it as a tool that changes state" });
  } else if ((risk === "critical" || risk === "high") && !flagged && !readOnly)
    findings.push({
      level: risk === "critical" ? "bad" : "warn",
      area: "annotations",
      message: "Sensitive tool without consequentialHint (or destructiveHint): agents may run it without asking the user",
    });

  // Description
  const desc = tool.description.trim();
  let descriptionScore = 0;
  if (!desc) findings.push({ level: "bad", area: "description", message: "No description: agents pick tools by their description" });
  else {
    descriptionScore += 0.4;
    if (desc.length < 20)
      findings.push({
        level: "warn",
        area: "description",
        message: `Description is ${desc.length} characters: say what the tool does and when to use it (20–500)`,
      });
    else if (desc.length > 500)
      findings.push({
        level: "warn",
        area: "description",
        message: `Description is ${desc.length} characters: past 500 it costs tokens on every agent call`,
      });
    else descriptionScore += 0.3;
    const plain = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    if (plain(desc) === plain(tool.name) || plain(desc) === words.join(" "))
      findings.push({ level: "warn", area: "description", message: "Description only repeats the name" });
    else descriptionScore += 0.15;
    if (risk !== "low" && !readOnly) {
      if (EFFECT_WORDS.test(desc)) descriptionScore += 0.15;
      else
        findings.push({
          level: "warn",
          area: "description",
          message: "Say what the tool changes (creates, sends, deletes…) so agents and users know its effect",
        });
      if ((risk === "high" || risk === "critical") && !/\b(confirm|irreversib|cannot be undone|can't be undone|permanent)/i.test(desc))
        findings.push({
          level: "info",
          area: "description",
          message: "Say whether the effect can be undone, and that the user should confirm it",
        });
    } else descriptionScore += 0.15;
  }

  const input = checkInputSchema(tool);
  findings.push(...input.findings, ...checkOutputSchema(tool));
  if (tool.form && !tool.form.autosubmit && risk !== "low")
    findings.push({
      level: "info",
      area: "description",
      message: "Declarative form without toolautosubmit: the user submits it after the agent fills it",
    });

  return {
    tool,
    findings,
    risk,
    riskReasons: reasons,
    readOnly,
    flagged,
    contradictory,
    descriptionScore: Math.min(1, descriptionScore),
    schemaScore: input.score,
    words,
  };
}

/** Analyzes every tool of a page, flagging names that break the page's majority convention. */
export function analyzeTools(tools: WebMcpTool[]): ToolAnalysis[] {
  const counts = new Map<NameStyle, number>();
  for (const t of tools) {
    const s = nameStyle(t.name);
    if (s !== "lowercase" && s !== "mixed") counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const majority = Array.from(counts.entries()).sort((x, y) => y[1] - x[1])[0];
  const majorityStyle = majority && majority[1] > tools.length / 2 ? majority[0] : undefined;
  return tools.map((t) => analyzeTool(t, { majorityStyle }));
}

export const riskLevel = (r: Risk): Level => (r === "low" ? "good" : r === "medium" ? "warn" : "bad");

/** How many confirmation steps the tester asks before running a tool: Low 0, Medium 1, High and Critical 2. */
export const confirmSteps = (r: Risk) => (r === "low" ? 0 : r === "medium" ? 1 : 2);

const SENSITIVE_KEY = /pass(word)?|pwd|secret|token|api[-_]?key|auth|credential|card|cvc|cvv|iban|ssn|otp|pin\b|private/i;

/** Arguments with sensitive-looking keys (password, token, card…) masked, for the run history. */
export function maskArgs(args: unknown): unknown {
  if (Array.isArray(args)) return args.map(maskArgs);
  if (!isObject(args)) return args;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, SENSITIVE_KEY.test(k) && v !== "" && v !== null ? "••••" : maskArgs(v)]),
  );
}

/** A JSON Schema property, read for the tester form. */
export interface FieldSpec {
  key: string;
  kind: "string" | "number" | "integer" | "boolean" | "enum" | "array" | "json";
  required: boolean;
  description?: string;
  title?: string;
  options?: (string | number | boolean | null)[];
  /** Arrays of primitives: the type of the items. */
  itemKind?: "string" | "number" | "integer" | "boolean";
  default?: unknown;
  format?: string;
}

/** Turns an input schema into tester form fields; anything nested falls back to a JSON textarea. */
export function formFields(schema: unknown): FieldSpec[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return Object.entries(schema.properties).map(([key, raw]) => {
    const p = isObject(raw) ? raw : {};
    const base = {
      key,
      required: required.includes(key),
      description: typeof p.description === "string" ? p.description : undefined,
      title: typeof p.title === "string" ? p.title : undefined,
      default: p.default,
      format: typeof p.format === "string" ? p.format : undefined,
    };
    const type = Array.isArray(p.type) ? p.type.find((t) => t !== "null") : p.type;
    if (Array.isArray(p.enum) && p.enum.length) return { ...base, kind: "enum" as const, options: p.enum as FieldSpec["options"] };
    if (type === "string" || type === "number" || type === "integer" || type === "boolean") return { ...base, kind: type };
    if (type === "array" && isObject(p.items)) {
      const it = p.items.type;
      if (it === "string" || it === "number" || it === "integer" || it === "boolean")
        return { ...base, kind: "array" as const, itemKind: it };
    }
    return { ...base, kind: "json" as const };
  });
}

/**
 * Builds the arguments object from the tester form's raw values (strings from inputs, booleans from checkboxes).
 * Empty optional fields are left out; numbers and JSON are parsed; errors name the field.
 */
export function buildArgs(
  fields: FieldSpec[],
  values: Record<string, string | boolean>,
): { args: Record<string, unknown>; errors: string[] } {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === "boolean") {
      if (v !== undefined && v !== "") args[f.key] = Boolean(v);
      else if (f.required) args[f.key] = false;
      continue;
    }
    const s = typeof v === "string" ? v : v === undefined ? "" : String(v);
    if (!s.trim()) {
      if (f.required) errors.push(`${f.key} is required`);
      continue;
    }
    const num = (x: string, integer: boolean) => {
      const n = Number(x);
      if (!Number.isFinite(n) || (integer && !Number.isInteger(n)))
        throw new Error(`${f.key}: "${x}" is not ${integer ? "an integer" : "a number"}`);
      return n;
    };
    try {
      if (f.kind === "number" || f.kind === "integer") args[f.key] = num(s, f.kind === "integer");
      else if (f.kind === "enum") {
        const opt = f.options?.find((o) => String(o) === s);
        args[f.key] = opt === undefined ? s : opt;
      } else if (f.kind === "array") {
        const items = s
          .split(/\n|,/)
          .map((x) => x.trim())
          .filter(Boolean);
        args[f.key] =
          f.itemKind === "number" || f.itemKind === "integer"
            ? items.map((x) => num(x, f.itemKind === "integer"))
            : f.itemKind === "boolean"
              ? items.map((x) => x === "true")
              : items;
      } else if (f.kind === "json") args[f.key] = JSON.parse(s);
      else args[f.key] = s;
    } catch (e) {
      errors.push(e instanceof SyntaxError ? `${f.key}: not valid JSON (${e.message})` : e instanceof Error ? e.message : String(e));
    }
  }
  return { args, errors };
}
