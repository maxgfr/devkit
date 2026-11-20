import type { Finding } from "./jsonld";

// Checks parsed JSON-LD against the Schema.org vocabulary, locally: unknown types and properties (with
// a "Did you mean…?"), properties used on a type outside their domain, nested nodes of a type outside the
// property's range, enumeration values that do not exist, superseded and pending terms. The vocabulary is
// the trimmed snapshot of scripts/schema-vocab.mjs (public/schema-vocab.json), passed in by the caller.
// Lenient on purpose: plain text where a node is expected is accepted (schema.org allows it and Google
// reads strings for many properties); only a typed node that clearly does not fit is flagged.

export interface SchemaVocab {
  source: { name: string; url: string; file: string; version: string; date: string; license: string; licenseUrl: string; terms: string };
  dataTypes: string[];
  /** Type → its direct parents (rdfs:subClassOf). */
  types: Record<string, string[]>;
  /** Property → [domainIncludes, rangeIncludes]. */
  properties: Record<string, [string[], string[]]>;
  /** Enumeration member → the enumeration(s) it belongs to. */
  members: Record<string, string[]>;
  /** Superseded term → its replacement. */
  superseded: Record<string, string>;
  /** Terms of the pending (experimental) section. */
  pending: string[];
}

interface VocabIndex {
  vocab: SchemaVocab;
  ancestors: (type: string) => Set<string>;
  isA: (type: string, of: string) => boolean;
  /** Properties whose domain includes the type or one of its ancestors. */
  propsOf: (type: string) => string[];
  pending: Set<string>;
  typeNames: string[];
  propNames: string[];
}

const indexes = new WeakMap<SchemaVocab, VocabIndex>();

function indexOf(vocab: SchemaVocab): VocabIndex {
  const cached = indexes.get(vocab);
  if (cached) return cached;
  const anc = new Map<string, Set<string>>();
  const ancestors = (type: string): Set<string> => {
    const hit = anc.get(type);
    if (hit) return hit;
    const out = new Set<string>();
    anc.set(type, out);
    for (const parent of vocab.types[type] ?? []) {
      out.add(parent);
      for (const a of ancestors(parent)) out.add(a);
    }
    return out;
  };
  const byDomain = new Map<string, string[]>();
  for (const [prop, [domain]] of Object.entries(vocab.properties))
    for (const d of domain) byDomain.set(d, [...(byDomain.get(d) ?? []), prop]);
  const propsCache = new Map<string, string[]>();
  const index: VocabIndex = {
    vocab,
    ancestors,
    isA: (type, of) => type === of || ancestors(type).has(of),
    propsOf: (type) => {
      let hit = propsCache.get(type);
      if (!hit) {
        hit = [type, ...ancestors(type)].flatMap((t) => byDomain.get(t) ?? []);
        propsCache.set(type, hit);
      }
      return hit;
    },
    pending: new Set(vocab.pending),
    typeNames: Object.keys(vocab.types),
    propNames: Object.keys(vocab.properties),
  };
  indexes.set(vocab, index);
  return index;
}

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions), case-insensitive. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array<number>(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j++) d[0]![j] = j;
  for (let i = 1; i <= s.length; i++)
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[s.length]![t.length]!;
}

/** The closest name within a distance that grows with the word's length (1 up to 4 letters, then a third of it). */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
  const max = Math.max(1, Math.floor(word.length / 3));
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (Math.abs(c.length - word.length) > max) continue;
    const d = editDistance(word, c);
    if (d < bestD || (d === bestD && best !== undefined && c < best)) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= max ? best : undefined;
}

const SCHEMA_URL = /^(?:https?:\/\/)?(?:www\.)?schema\.org\//i;

/** "schema:Product", "https://schema.org/Product", "Product" → "Product"; terms of another vocabulary → null. */
export function schemaTerm(value: string): string | null {
  const v = value.trim();
  if (SCHEMA_URL.test(v)) return v.replace(SCHEMA_URL, "");
  if (v.startsWith("schema:")) return v.slice(7);
  if (/[:/#]/.test(v)) return null;
  return v;
}

function isSchemaContext(ctx: unknown): boolean | undefined {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx === "string") return /schema\.org/i.test(ctx);
  if (Array.isArray(ctx)) {
    const parts = ctx.map(isSchemaContext).filter((x) => x !== undefined);
    return parts.length ? parts.some(Boolean) : undefined;
  }
  if (typeof ctx === "object") {
    const vocab = (ctx as Record<string, unknown>)["@vocab"];
    return typeof vocab === "string" ? /schema\.org/i.test(vocab) : undefined;
  }
  return undefined;
}

const list = (xs: string[], max = 4) => {
  const shown = xs.slice(0, max);
  const more = xs.length > max ? ` (and ${xs.length - max} more)` : "";
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}${more}` : `${shown[0] ?? ""}${more}`;
};

const docUrl = (term: string) => `https://schema.org/${term}`;

/** Properties annotated for Actions (`query-input`, `name-output`…), part of the schema.org Actions spec. */
const ACTION_ANNOTATION = /-(input|output)$/;

/** All Schema.org vocabulary findings for a parsed JSON-LD value; paths start at `base` (`#1`). */
export function checkVocab(value: unknown, vocab: SchemaVocab, base = "#1"): Finding[] {
  const ix = indexOf(vocab);
  const findings: Finding[] = [];
  const seenPending = new Set<string>();
  const enumTypes = (range: string[]) => range.filter((r) => ix.isA(r, "Enumeration"));

  const pending = (term: string, path: string) => {
    if (!ix.pending.has(term) || seenPending.has(term)) return;
    seenPending.add(term);
    findings.push({
      severity: "info",
      rule: "vocab.pending",
      path,
      message: `${term} is a pending Schema.org term (experimental: it may still change or be dropped)`,
    });
  };

  /** A string (or `{"@id"}`) given to an enumeration-typed property. */
  const checkEnum = (prop: string, range: string[], raw: string, path: string) => {
    const enums = enumTypes(range);
    if (!enums.length) return;
    const term = schemaTerm(raw);
    const explicit = SCHEMA_URL.test(raw.trim()) || raw.trim().startsWith("schema:");
    // Text or URL in the range too: only an explicit schema.org value can be wrong.
    const textAllowed = range.some((r) => r === "Text" || ix.isA(r, "Text"));
    if (textAllowed && !explicit) return;
    if (term === null) return;
    const valid = Object.entries(vocab.members)
      .filter(([, of]) => of.some((e) => enums.some((en) => ix.isA(e, en))))
      .map(([m]) => m);
    if (valid.includes(term)) {
      const next = vocab.superseded[term];
      if (next)
        findings.push({ severity: "warn", rule: "vocab.superseded", path, message: `${term} is superseded by ${next} (${docUrl(next)})` });
      pending(term, path);
      return;
    }
    const lower = term.toLowerCase();
    const guess =
      valid.find((m) => m.toLowerCase() === lower) ??
      nearest(term, valid) ??
      (lower.length >= 4
        ? (valid.filter((m) => m.toLowerCase().includes(lower)).sort((a, b) => a.length - b.length)[0] ??
          valid.filter((m) => lower.includes(m.toLowerCase())).sort((a, b) => b.length - a.length)[0])
        : undefined);
    findings.push({
      severity: "error",
      rule: "vocab.enum",
      path,
      message: `${prop} "${raw.slice(0, 60)}" is not a valid ${list(enums, 2)} value${guess ? `. Did you mean ${docUrl(guess)}?` : ` (${docUrl(enums[0]!)} lists them)`}`,
    });
  };

  const walk = (node: unknown, path: string, schema: boolean, depth: number) => {
    if (depth > 30 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const [i, v] of node.entries()) walk(v, `${path}[${i}]`, schema, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ctx = isSchemaContext(obj["@context"]);
    const inSchema = ctx ?? schema;
    if ("@graph" in obj) walk(obj["@graph"], `${path}.@graph`, inSchema, depth + 1);
    if ("@list" in obj) walk(obj["@list"], path, inSchema, depth + 1);
    if (!inSchema || "@value" in obj) return;

    const rawTypes = (Array.isArray(obj["@type"]) ? obj["@type"] : obj["@type"] !== undefined ? [obj["@type"]] : []).filter(
      (t): t is string => typeof t === "string",
    );
    const known: string[] = [];
    for (const raw of rawTypes) {
      const t = schemaTerm(raw);
      if (t === null) continue;
      if (vocab.types[t]) {
        known.push(t);
        const next = vocab.superseded[t];
        if (next)
          findings.push({ severity: "warn", rule: "vocab.superseded", path, message: `${t} is superseded by ${next} (${docUrl(next)})` });
        pending(t, path);
        continue;
      }
      const guess = nearest(t, ix.typeNames);
      findings.push({
        severity: "error",
        rule: "vocab.unknown-type",
        path,
        message: `${t} is not a Schema.org type${guess ? `. Did you mean ${guess}?` : ""}`,
      });
    }
    const typed = rawTypes.length > 0;
    // A Role wraps the value of the property it qualifies (`author: {"@type": "Role", "author": …}`).
    const isRole = known.some((t) => ix.isA(t, "Role"));

    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("@") || key === "") continue;
      const childPath = `${path}.${key}`;
      const prop = schemaTerm(key);
      if (prop === null || ACTION_ANNOTATION.test(prop)) {
        walk(value, childPath, inSchema, depth + 1);
        continue;
      }
      const def = vocab.properties[prop];
      if (!def) {
        if (vocab.types[prop] && !typed) {
          // A type name used as a key (`"Offer": {…}`) is usually a misplaced @type.
          findings.push({
            severity: "error",
            rule: "vocab.unknown-property",
            path: childPath,
            message: `${prop} is a Schema.org type, not a property`,
          });
        } else {
          const own = known.flatMap((t) => ix.propsOf(t));
          const guess = (own.length ? nearest(prop, own) : undefined) ?? nearest(prop, ix.propNames);
          findings.push({
            severity: "error",
            rule: "vocab.unknown-property",
            path: childPath,
            message: `${prop} is not a Schema.org property${guess ? `. Did you mean ${guess}?` : ""}`,
          });
        }
        walk(value, childPath, inSchema, depth + 1);
        continue;
      }
      const [domain, range] = def;
      const next = vocab.superseded[prop];
      if (next)
        findings.push({
          severity: "warn",
          rule: "vocab.superseded",
          path: childPath,
          message: `${prop} is superseded by ${next} (${docUrl(next)})`,
        });
      pending(prop, childPath);
      if (known.length && domain.length && !isRole && !known.some((t) => domain.some((d) => ix.isA(t, d))))
        findings.push({
          severity: "warn",
          rule: "vocab.domain",
          path: childPath,
          message: `${prop} is not a property of ${known.join(" / ")}: Schema.org expects it on ${list(domain)}`,
        });

      const values = Array.isArray(value) ? value : [value];
      values.forEach((v, i) => {
        const at = Array.isArray(value) ? `${childPath}[${i}]` : childPath;
        if (typeof v === "string") checkEnum(prop, range, v, at);
        else if (v && typeof v === "object" && !Array.isArray(v)) {
          const o = v as Record<string, unknown>;
          if (typeof o["@id"] === "string" && o["@type"] === undefined && Object.keys(o).length === 1 && enumTypes(range).length)
            checkEnum(prop, range, o["@id"], at);
          const vt = (Array.isArray(o["@type"]) ? o["@type"] : o["@type"] !== undefined ? [o["@type"]] : [])
            .map((t) => (typeof t === "string" ? schemaTerm(t) : null))
            .filter((t): t is string => t !== null && Boolean(vocab.types[t]));
          if (vt.length && range.length && !vt.some((t) => ix.isA(t, "Role")) && !vt.some((t) => range.some((r) => ix.isA(t, r))))
            findings.push({
              severity: "warn",
              rule: "vocab.range",
              path: at,
              message: `${prop} expects ${list(range)}, not ${vt.join(" / ")}`,
            });
        }
      });
      walk(value, childPath, inSchema, depth + 1);
    }
  };

  walk(value, base, true, 0);
  return findings;
}

/** Fetches the bundled vocabulary once per page (it is not part of any script bundle). */
let load: Promise<SchemaVocab> | null = null;
export function loadSchemaVocab(url = "/schema-vocab.json"): Promise<SchemaVocab> {
  load ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`The Schema.org vocabulary did not load (HTTP ${r.status}).`);
      return r.json() as Promise<SchemaVocab>;
    })
    .catch((e) => {
      load = null;
      throw e;
    });
  return load;
}
