import { ISO_4217 } from "./iso4217";
import { checkVocab, type SchemaVocab } from "./schema-vocab";
import { jsonErrorPosition, lineColumn } from "./utils/json";

// Structured data analyzer: parses every JSON-LD block of a page, finds its schema.org nodes and
// checks them against what Google's rich results need (required / recommended properties) and
// the usual mistakes (relative URLs, non-ISO dates, prices with a currency sign…). With the Schema.org
// vocabulary (schema-vocab.ts), it also checks every type, property and enumeration value against it.

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  message: string;
  path: string;
  /**
   * What raised it: `syntax.*` (JSON and JSON-LD itself), `google.*` (rich results rules), `format.*`
   * (value formats Google documents) or `vocab.*` (the Schema.org vocabulary).
   */
  rule: string;
}

export interface JsonLdNode {
  types: string[];
  id?: string;
  path: string;
  data: Record<string, unknown>;
  findings: Finding[];
}

export interface JsonLdBlock {
  index: number;
  raw: string;
  ok: boolean;
  error?: string;
  value?: unknown;
  contexts: string[];
  nodes: JsonLdNode[];
  findings: Finding[];
}

export interface JsonLdReport {
  blocks: JsonLdBlock[];
  types: { type: string; count: number }[];
  counts: Record<Severity, number>;
  /** The Schema.org release the vocabulary checks ran against, when they ran. */
  vocab?: { version: string; date: string };
}

interface TypeRule {
  required?: (string | string[])[];
  recommended?: (string | string[])[];
  note?: string;
  /** Google no longer shows a rich result for this type (the note says since when). */
  retired?: boolean;
}

/** `string[]` in a rule means "at least one of". */
const TYPE_RULES: Record<string, TypeRule> = {
  Article: { recommended: ["headline", "image", "datePublished", "dateModified", "author"] },
  NewsArticle: { recommended: ["headline", "image", "datePublished", "dateModified", "author"] },
  BlogPosting: { recommended: ["headline", "image", "datePublished", "dateModified", "author"] },
  Product: {
    required: ["name", ["offers", "review", "aggregateRating"]],
    recommended: ["image", "description", "sku", "brand", ["gtin", "gtin13", "gtin12", "gtin8", "mpn"]],
  },
  Offer: { required: [["price", "priceSpecification"], "priceCurrency"], recommended: ["availability", "url", "priceValidUntil"] },
  AggregateOffer: { required: ["lowPrice", "priceCurrency"], recommended: ["highPrice", "offerCount"] },
  AggregateRating: { required: ["ratingValue", ["ratingCount", "reviewCount"]], recommended: ["bestRating"] },
  Review: { required: ["author", "reviewRating"], recommended: ["itemReviewed", "datePublished"] },
  Rating: { required: ["ratingValue"], recommended: ["bestRating", "worstRating"] },
  BreadcrumbList: { required: ["itemListElement"] },
  ListItem: { required: ["position"], recommended: ["name", "item"] },
  ItemList: { required: ["itemListElement"] },
  FAQPage: { required: ["mainEntity"], note: "Google shows FAQ rich results only for well-known government and health sites since 2023." },
  Question: { required: ["name", "acceptedAnswer"] },
  Answer: { required: ["text"] },
  HowTo: { required: ["name", "step"], note: "Google no longer shows HowTo rich results (2023).", retired: true },
  // Phased out of Google Search in 2025 (Search Central blog, "Simplifying the search results page", June 12, 2025).
  ClaimReview: { note: "Google no longer shows ClaimReview (fact check) rich results (2025).", retired: true },
  SpecialAnnouncement: { note: "Google no longer shows SpecialAnnouncement rich results (2025).", retired: true },
  Organization: { recommended: ["name", "url", "logo", "sameAs", "contactPoint"] },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "openingHoursSpecification", "geo", "url", "image", "priceRange"],
  },
  Restaurant: { required: ["name", "address"], recommended: ["telephone", "servesCuisine", "menu", "openingHoursSpecification", "geo"] },
  PostalAddress: { recommended: ["streetAddress", "addressLocality", "postalCode", "addressCountry"] },
  Person: { required: ["name"], recommended: ["url", "sameAs"] },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["endDate", "eventStatus", "eventAttendanceMode", "image", "description", "offers", "organizer", "performer"],
  },
  Place: { recommended: ["name", "address"] },
  Recipe: {
    required: ["name", "image"],
    recommended: [
      "author",
      "datePublished",
      "description",
      "recipeIngredient",
      "recipeInstructions",
      "totalTime",
      "recipeYield",
      "nutrition",
      "aggregateRating",
    ],
  },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration", ["contentUrl", "embedUrl"]] },
  ImageObject: { required: [["contentUrl", "url"]], recommended: ["license", "creator", "creditText", "copyrightNotice"] },
  WebSite: { recommended: ["name", "url", "potentialAction"] },
  WebPage: { recommended: ["name", "url"] },
  SearchAction: { required: ["target", "query-input"] },
  JobPosting: {
    required: ["title", "description", "datePosted", "hiringOrganization", ["jobLocation", "applicantLocationRequirements"]],
    recommended: ["validThrough", "employmentType", "baseSalary", "identifier", "directApply"],
  },
  SoftwareApplication: {
    required: ["name", "offers", ["aggregateRating", "review"]],
    recommended: ["applicationCategory", "operatingSystem"],
  },
  Course: { required: ["name", "description"], recommended: ["provider", "offers", "hasCourseInstance"] },
  Book: { required: ["name", "author"], recommended: ["isbn", "workExample"] },
  Dataset: { required: ["name", "description"], recommended: ["license", "creator", "url", "distribution"] },
  ProfilePage: { required: ["mainEntity"] },
  DiscussionForumPosting: {
    required: ["author", "datePublished", ["text", "image", "video"]],
    recommended: ["headline", "url", "interactionStatistic"],
  },
  QAPage: { required: ["mainEntity"] },
};

const DATE_KEYS = new Set([
  "datePublished",
  "dateModified",
  "dateCreated",
  "startDate",
  "endDate",
  "uploadDate",
  "datePosted",
  "validThrough",
  "priceValidUntil",
  "validFrom",
  "birthDate",
  "foundingDate",
  "expires",
  "availabilityStarts",
  "availabilityEnds",
]);
const URL_KEYS = new Set(["url", "image", "logo", "item", "contentUrl", "embedUrl", "thumbnailUrl", "sameAs", "mainEntityOfPage", "@id"]);
const DURATION_KEYS = new Set(["duration", "totalTime", "cookTime", "prepTime", "performTime", "timeRequired"]);
const PRICE_KEYS = new Set(["price", "lowPrice", "highPrice"]);
const CURRENCY_KEYS = new Set(["priceCurrency", "currency"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/;

/** "Unexpected token } in JSON at position 120" → "line 4, column 12: Unexpected token }". */
export function jsonErrorAt(raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/line \d+ column \d+/.test(message)) return message;
  const pos = jsonErrorPosition(raw, message);
  if (pos === null) return message;
  const { line, column } = lineColumn(raw, pos);
  return `line ${line}, column ${column}: ${message.replace(/ in JSON at position \d+.*/, "").replace(/, (\.\.\.)?".*" is not valid JSON$/s, "")}`;
}

const pad = (n: string) => n.padStart(2, "0");

/** "31.12.2026" → "2026-12-31"; "12/31/2026" → "2026-12-31"; undefined when the order is ambiguous (01/02/2026). */
export function isoDateFor(value: string): string | undefined {
  const v = value.trim();
  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(v);
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  let y: string | undefined;
  let m: string | undefined;
  let d: string | undefined;
  if (ymd) [, y, m, d] = ymd;
  else if (dotted) [, d, m, y] = dotted;
  else if (slashed) {
    const [, a = "", b = "", year] = slashed;
    if (Number(a) > 12) [d, m] = [a, b];
    else if (Number(b) > 12) [m, d] = [a, b];
    else return undefined;
    y = year;
  }
  if (!y || !m || !d || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

type DurationUnit = "D" | "H" | "M" | "S";
const DURATION_UNITS: [RegExp, DurationUnit][] = [
  [/^(d|days?|jours?)$/, "D"],
  [/^(h|hrs?|hours?|heures?|std)$/, "H"],
  [/^(m|mn|mins?|minutes?)$/, "M"],
  [/^(s|secs?|seconds?|secondes?)$/, "S"],
];

/** "45 min" → "PT45M", "1h30" → "PT1H30M", "1:15" → "PT1H15M", "pt20m" → "PT20M"; undefined when unsure. */
export function isoDurationFor(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (ISO_DURATION.test(v.toUpperCase())) return v.toUpperCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(v);
  const parts: Record<DurationUnit, number> = { D: 0, H: 0, M: 0, S: 0 };
  if (clock) {
    parts.H = Number(clock[1]);
    parts.M = Number(clock[2]);
  } else {
    // "1h30" means 1 hour 30 minutes.
    const text = v
      .replace(/(\d)\s*h\s*(\d+)$/, "$1h $2min")
      .replace(/\band\b|,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let used = "";
    for (const m of text.matchAll(/(\d+)\s*([a-zé]+)/g)) {
      const unit = DURATION_UNITS.find(([r]) => r.test(m[2]!.replace("é", "e")))?.[1];
      if (!unit) return undefined;
      parts[unit] += Number(m[1]);
      used += m[0];
    }
    if (!used || used.replace(/\s/g, "") !== text.replace(/\s/g, "")) return undefined;
  }
  const date = parts.D ? `${parts.D}D` : "";
  const time = `${parts.H ? `${parts.H}H` : ""}${parts.M ? `${parts.M}M` : ""}${parts.S ? `${parts.S}S` : ""}`;
  if (!date && !time) return undefined;
  return `P${date}${time ? `T${time}` : ""}`;
}

const CURRENCY_SIGNS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "₩": "KRW",
  "₺": "TRY",
  "₽": "RUB",
  "₴": "UAH",
  "₪": "ILS",
};
const CURRENCY_NAMES: Record<string, string> = { euro: "EUR", euros: "EUR", dollar: "USD", dollars: "USD", pound: "GBP", pounds: "GBP" };

/** "89,90 €" → { price: "89.90", currency: "EUR" }; "1.299,00" → "1299.00"; "1,299.00" → "1299.00". */
export function plainPrice(value: string): { price?: string; currency?: string } {
  const v = value.trim();
  const sign = Object.keys(CURRENCY_SIGNS).find((c) => v.includes(c));
  const code = /\b([A-Z]{3})\b/.exec(v)?.[1];
  const currency = sign ? CURRENCY_SIGNS[sign] : code && ISO_4217.has(code) ? code : undefined;
  let s = v.replace(/[^\d.,-]/g, "");
  if (s.includes(",") && s.includes("."))
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (/^\d{1,3}(,\d{3}){2,}$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  return { price: /^-?\d+(\.\d+)?$/.test(s) && s !== v ? s : undefined, currency };
}

/** ISO 4217 code for a currency value that is not one ("eur", "€", "euro"); undefined when there is no obvious one. */
export function currencyFor(value: string): string | undefined {
  const v = value.trim();
  if (ISO_4217.has(v.toUpperCase())) return v.toUpperCase();
  return CURRENCY_SIGNS[v] ?? CURRENCY_NAMES[v.toLowerCase()];
}

const typesOf = (v: Record<string, unknown>): string[] => {
  const t = v["@type"];
  return (Array.isArray(t) ? t : t ? [t] : []).map((x) => String(x).replace(/^(https?:\/\/)?schema\.org\//, ""));
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function checkValue(key: string, value: unknown, path: string, findings: Finding[], withVocab: boolean) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (DATE_KEYS.has(key) && !ISO_DATE.test(t)) {
      const iso = isoDateFor(t);
      findings.push({
        severity: "error",
        rule: "format.date",
        path,
        message: iso
          ? `${key} "${v}" is not an ISO 8601 date: write "${iso}"`
          : `${key} "${v}" is not an ISO 8601 date (2026-01-31 or 2026-01-31T09:00:00+01:00)`,
      });
    }
    if (DURATION_KEYS.has(key) && !ISO_DURATION.test(t)) {
      const iso = isoDurationFor(t);
      findings.push({
        severity: "warn",
        rule: "format.duration",
        path,
        message: iso ? `${key} "${v}" is not an ISO 8601 duration: write "${iso}"` : `${key} "${v}" is not an ISO 8601 duration (PT1H30M)`,
      });
    }
    if (URL_KEYS.has(key) && key !== "@id" && !/^https?:\/\//.test(v))
      findings.push({ severity: "warn", rule: "format.url", path, message: `${key} "${v.slice(0, 80)}" is not an absolute URL` });
    if (URL_KEYS.has(key) && /\s/.test(t))
      findings.push({
        severity: "warn",
        rule: "format.url-space",
        path,
        message: `${key} "${v.slice(0, 80)}" contains spaces: encode them as %20`,
      });
    if (PRICE_KEYS.has(key) && !/^\d+(\.\d+)?$/.test(t)) {
      const fix = plainPrice(t);
      const hint = fix.price ? `: write "${fix.price}"${fix.currency ? ` with priceCurrency "${fix.currency}"` : ""}` : "";
      findings.push({
        severity: "error",
        rule: "format.price",
        path,
        message: `${key} "${v}" must be a plain number (use "." as decimal separator, no currency sign)${hint}`,
      });
    }
    if (CURRENCY_KEYS.has(key) && !ISO_4217.has(v)) {
      const code = currencyFor(v);
      findings.push(
        code
          ? { severity: "error", rule: "format.currency", path, message: `${key} "${v}" must be an ISO 4217 code: write "${code}"` }
          : /^[A-Z]{3,5}$/.test(v)
            ? {
                severity: "warn",
                rule: "format.currency",
                path,
                message: `${key} "${v}" is not an ISO 4217 code (Schema.org accepts crypto tickers, Google expects ISO 4217)`,
              }
            : { severity: "error", rule: "format.currency", path, message: `${key} "${v}" must be an ISO 4217 code such as EUR` },
      );
    }
    // With the vocabulary, its enumeration check covers availability (and every other enumeration).
    if (
      !withVocab &&
      key === "availability" &&
      !/schema\.org\/(InStock|OutOfStock|PreOrder|BackOrder|Discontinued|InStoreOnly|LimitedAvailability|OnlineOnly|PreSale|SoldOut|Reserved|MadeToOrder)$/.test(
        v,
      )
    )
      findings.push({
        severity: "warn",
        rule: "format.availability",
        path,
        message: `availability "${v}" should be a schema.org ItemAvailability URL (https://schema.org/InStock)`,
      });
    if (/<[a-z][\s\S]*>/i.test(v) && (key === "description" || key === "text" || key === "name" || key === "headline"))
      findings.push({ severity: "info", rule: "format.html", path, message: `${key} contains HTML markup` });
  }
  if (key === "headline" && typeof value === "string" && value.length > 110)
    findings.push({
      severity: "warn",
      rule: "google.headline",
      path,
      message: `headline is ${value.length} characters (Google cuts it after 110)`,
    });
}

function checkNode(node: Record<string, unknown>, types: string[], path: string, withVocab: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const type of types) {
    const rule = TYPE_RULES[type];
    if (!rule) continue;
    for (const req of rule.required ?? []) {
      const keys = Array.isArray(req) ? req : [req];
      if (keys.every((k) => isEmpty(node[k])))
        findings.push({
          severity: "error",
          rule: "google.required",
          path,
          message: `${type}: missing required ${keys.length > 1 ? `one of ${keys.join(" / ")}` : keys[0]}`,
        });
    }
    for (const rec of rule.recommended ?? []) {
      const keys = Array.isArray(rec) ? rec : [rec];
      if (keys.every((k) => isEmpty(node[k])))
        findings.push({
          severity: "warn",
          rule: "google.recommended",
          path,
          message: `${type}: missing recommended ${keys.length > 1 ? `one of ${keys.join(" / ")}` : keys[0]}`,
        });
    }
    if (rule.note) findings.push({ severity: "info", rule: "google.note", path, message: rule.note });
  }
  if (types.includes("BreadcrumbList") && Array.isArray(node.itemListElement)) {
    const positions = node.itemListElement.map((i) => Number((i as Record<string, unknown>)?.position));
    if (positions.some((p, i) => p !== i + 1))
      findings.push({
        severity: "warn",
        rule: "google.breadcrumb",
        path,
        message: `BreadcrumbList positions are ${positions.join(", ")}: expected 1, 2, 3…`,
      });
  }
  for (const key of Object.keys(node)) {
    if (
      key.startsWith("@") &&
      !["@context", "@type", "@id", "@graph", "@value", "@language", "@list", "@reverse", "@vocab", "@base"].includes(key)
    )
      findings.push({
        severity: "error",
        rule: "syntax.keyword",
        path,
        message: `Unknown keyword ${key} (JSON-LD keywords are case-sensitive)`,
      });
    checkValue(key, node[key], `${path}.${key}`, findings, withVocab);
  }
  return findings;
}

function walk(value: unknown, path: string, nodes: JsonLdNode[], contexts: Set<string>, withVocab: boolean, depth = 0) {
  if (depth > 30 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`, nodes, contexts, withVocab, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const ctx = obj["@context"];
  if (typeof ctx === "string") contexts.add(ctx);
  else if (ctx && typeof ctx === "object")
    contexts.add(
      typeof (ctx as Record<string, unknown>)["@vocab"] === "string" ? String((ctx as Record<string, unknown>)["@vocab"]) : "(object)",
    );
  const types = typesOf(obj);
  if (types.length)
    nodes.push({
      types,
      id: typeof obj["@id"] === "string" ? obj["@id"] : undefined,
      path,
      data: obj,
      findings: checkNode(obj, types, path, withVocab),
    });
  for (const [k, v] of Object.entries(obj)) if (k !== "@context") walk(v, `${path}.${k}`, nodes, contexts, withVocab, depth + 1);
}

export function analyzeBlock(raw: string, index: number, vocab?: SchemaVocab): JsonLdBlock {
  const at = `#${index + 1}`;
  const block: JsonLdBlock = { index, raw, ok: false, contexts: [], nodes: [], findings: [] };
  const text = raw.trim();
  if (!text) {
    block.error = "Empty script";
    block.findings.push({ severity: "error", rule: "syntax.empty", path: at, message: "The <script type=application/ld+json> is empty" });
    return block;
  }
  try {
    block.value = JSON.parse(text);
  } catch (e) {
    block.error = jsonErrorAt(text, e);
    block.findings.push({ severity: "error", rule: "syntax.json", path: at, message: `Invalid JSON, ${block.error}` });
    return block;
  }
  block.ok = true;
  const contexts = new Set<string>();
  walk(block.value, at, block.nodes, contexts, Boolean(vocab));
  block.contexts = Array.from(contexts);
  if (!contexts.size)
    block.findings.push({ severity: "error", rule: "syntax.no-context", path: at, message: "No @context: set it to https://schema.org" });
  else if (!block.contexts.some((c) => /schema\.org/.test(c)))
    block.findings.push({
      severity: "warn",
      rule: "syntax.context",
      path: at,
      message: `@context is ${block.contexts.join(", ")}, not schema.org`,
    });
  if (!block.nodes.length) block.findings.push({ severity: "error", rule: "syntax.no-type", path: at, message: "No node with an @type" });
  const ids = new Set(block.nodes.map((n) => n.id).filter(Boolean));
  for (const node of block.nodes) {
    for (const [k, v] of Object.entries(node.data)) {
      const ref =
        v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 ? (v as Record<string, unknown>)["@id"] : undefined;
      if (typeof ref === "string" && ref.startsWith("#") && !ids.has(ref) && !Array.from(ids).some((id) => id?.endsWith(ref)))
        node.findings.push({
          severity: "warn",
          rule: "syntax.ref",
          path: `${node.path}.${k}`,
          message: `${k} points to ${ref}, which no node in this block defines`,
        });
    }
  }
  if (vocab) {
    // Each vocabulary finding goes to the deepest node its path starts in.
    const byDepth = [...block.nodes].sort((a, b) => b.path.length - a.path.length);
    for (const f of checkVocab(block.value, vocab, at)) {
      const owner = byDepth.find((n) => f.path === n.path || f.path.startsWith(`${n.path}.`) || f.path.startsWith(`${n.path}[`));
      (owner?.findings ?? block.findings).push(f);
    }
  }
  return block;
}

/** Every finding of a block: its own, then its nodes' in document order. */
export const blockFindings = (block: JsonLdBlock): Finding[] => [...block.findings, ...block.nodes.flatMap((n) => n.findings)];

export const countFindings = (findings: Finding[]): Record<Severity, number> => ({
  error: findings.filter((f) => f.severity === "error").length,
  warn: findings.filter((f) => f.severity === "warn").length,
  info: findings.filter((f) => f.severity === "info").length,
});

/** Analyzes the page's JSON-LD scripts; with `vocab`, also against the Schema.org vocabulary. */
export function analyzeJsonLd(scripts: { raw: string; index: number }[], options: { vocab?: SchemaVocab } = {}): JsonLdReport {
  const { vocab } = options;
  const blocks = scripts.map((s) => analyzeBlock(s.raw, s.index, vocab));
  const typeCounts = new Map<string, number>();
  for (const b of blocks) for (const n of b.nodes) for (const t of n.types) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  return {
    blocks,
    types: Array.from(typeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    counts: countFindings(blocks.flatMap(blockFindings)),
    ...(vocab ? { vocab: { version: vocab.source.version, date: vocab.source.date } } : {}),
  };
}

/* Validation modes */

/** Rich Results: Google's rules and the value formats. Schema.org: the vocabulary and the value formats. */
export type ValidateMode = "rich" | "schema";

/** Whether a finding counts in a mode. Syntax, formats and enumeration values (Google reads them too) count in both. */
export function inMode(f: Finding, mode: ValidateMode): boolean {
  if (f.rule.startsWith("google.")) return mode === "rich";
  if (f.rule.startsWith("vocab.")) return mode === "schema" || f.rule === "vocab.enum";
  return true;
}

/** The report as one mode sees it: same blocks, counts of that mode's findings only. */
export function reportCounts(report: JsonLdReport, mode: ValidateMode): Record<Severity, number> {
  return countFindings(report.blocks.flatMap(blockFindings).filter((f) => inMode(f, mode)));
}

export interface FindingGroup {
  severity: Severity;
  rule: string;
  message: string;
  /** Every place it was found, in order; the group shows as "×N" when there are several. */
  paths: string[];
}

/** Identical findings (same rule, level and message) on several nodes, folded into one with their paths. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const key = `${f.severity}\u0000${f.rule}\u0000${f.message}`;
    const g = groups.get(key);
    if (g) g.paths.push(f.path);
    else groups.set(key, { severity: f.severity, rule: f.rule, message: f.message, paths: [f.path] });
  }
  return Array.from(groups.values());
}

export type BlockStatus = "valid" | "warning" | "error";

export interface BlockBadges {
  status: BlockStatus;
  /** Uses pending (experimental) Schema.org terms; known only when the vocabulary checks ran. */
  experimental: boolean;
  /** Types of the block Google no longer shows a rich result for, with why. */
  unsupported: { type: string; note: string }[];
}

export function blockBadges(block: JsonLdBlock, mode: ValidateMode): BlockBadges {
  const findings = blockFindings(block);
  const shown = findings.filter((f) => inMode(f, mode));
  const status: BlockStatus = shown.some((f) => f.severity === "error")
    ? "error"
    : shown.some((f) => f.severity === "warn")
      ? "warning"
      : "valid";
  const unsupported = Array.from(new Set(block.nodes.flatMap((n) => n.types)))
    .filter((t) => TYPE_RULES[t]?.retired)
    .map((type) => ({ type, note: TYPE_RULES[type]?.note ?? "" }));
  return { status, experimental: findings.some((f) => f.rule === "vocab.pending"), unsupported };
}

/** The schema.org page of a type or property; null for a term of another vocabulary. */
export function schemaDocUrl(term: string): string | null {
  const t = term.replace(/^(?:https?:\/\/)?(?:www\.)?schema\.org\//i, "").replace(/^schema:/, "");
  return /^[A-Za-z][\w-]*$/.test(t) ? `https://schema.org/${t}` : null;
}

/** Pretty JSON of a parsed block, the raw text of a broken one. */
export const blockJson = (block: JsonLdBlock): string => (block.ok ? JSON.stringify(block.value, null, 2) : block.raw.trim());

/** The block as a `<script>` tag, ready to paste in a page; `</` is escaped so no string can close the tag early. */
export function scriptTag(block: JsonLdBlock): string {
  const json = block.ok ? blockJson(block).replace(/<\//g, "<\\/") : block.raw.trim();
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/** `product-1.jsonld` (the block's first type and number); `.txt` for a block that is not valid JSON. */
export function blockFileName(block: JsonLdBlock): string {
  const type = (block.nodes[0]?.types[0] ?? "jsonld").replace(/[^\w-]+/g, "-").toLowerCase();
  return `${type}-${block.index + 1}.${block.ok ? "jsonld" : "txt"}`;
}

/** Canonical, robots meta and X-Robots-Tag at a glance; null where the page sets none. */
export function indexingSignals(
  snap: { meta: { key: string; value: string }[]; links: { rel: string; href: string }[] },
  headers?: Record<string, string>,
): { canonical: string | null; robots: string | null; xRobotsTag: string | null } {
  const canonical = snap.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes("canonical"))?.href ?? null;
  const robots = snap.meta
    .filter((m) => /^(robots|googlebot)$/i.test(m.key))
    .map((m) => (m.key.toLowerCase() === "robots" ? m.value : `${m.key}: ${m.value}`))
    .join(" · ");
  const header = headers ? Object.entries(headers).find(([k]) => k.toLowerCase() === "x-robots-tag")?.[1] : undefined;
  return { canonical, robots: robots || null, xRobotsTag: header ?? null };
}

export const richResultsTestUrl = (url: string) => `https://search.google.com/test/rich-results?url=${encodeURIComponent(url)}`;
export const schemaValidatorUrl = (url: string) => `https://validator.schema.org/#url=${encodeURIComponent(url)}`;
