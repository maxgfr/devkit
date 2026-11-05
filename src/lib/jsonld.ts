import { jsonErrorPosition, lineColumn } from "./utils/json";

// Structured data analyzer: parses every JSON-LD block of a page, finds its schema.org nodes and
// checks them against what Google's rich results need (required / recommended properties) and
// the usual mistakes (relative URLs, non-ISO dates, prices with a currency sign…).

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  message: string;
  path: string;
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
}

interface TypeRule {
  required?: (string | string[])[];
  recommended?: (string | string[])[];
  note?: string;
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
  HowTo: { required: ["name", "step"], note: "Google no longer shows HowTo rich results (2023)." },
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
]);
const URL_KEYS = new Set(["url", "image", "logo", "item", "contentUrl", "embedUrl", "thumbnailUrl", "sameAs", "mainEntityOfPage", "@id"]);
const DURATION_KEYS = new Set(["duration", "totalTime", "cookTime", "prepTime", "timeRequired"]);

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

const typesOf = (v: Record<string, unknown>): string[] => {
  const t = v["@type"];
  return (Array.isArray(t) ? t : t ? [t] : []).map((x) => String(x).replace(/^(https?:\/\/)?schema\.org\//, ""));
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function checkValue(key: string, value: unknown, path: string, findings: Finding[], baseIsAbsolute: boolean) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== "string") continue;
    if (DATE_KEYS.has(key) && !ISO_DATE.test(v.trim()))
      findings.push({
        severity: "error",
        path,
        message: `${key} "${v}" is not an ISO 8601 date (2026-01-31 or 2026-01-31T09:00:00+01:00)`,
      });
    if (DURATION_KEYS.has(key) && !ISO_DURATION.test(v.trim()))
      findings.push({ severity: "warn", path, message: `${key} "${v}" is not an ISO 8601 duration (PT1H30M)` });
    if (URL_KEYS.has(key) && key !== "@id" && !/^https?:\/\//.test(v) && baseIsAbsolute)
      findings.push({ severity: "warn", path, message: `${key} "${v.slice(0, 80)}" is not an absolute URL` });
    if ((key === "price" || key === "lowPrice" || key === "highPrice") && !/^\d+(\.\d+)?$/.test(v.trim()))
      findings.push({
        severity: "error",
        path,
        message: `${key} "${v}" must be a plain number (use "." as decimal separator, no currency sign)`,
      });
    if (key === "priceCurrency" && !/^[A-Z]{3}$/.test(v))
      findings.push({ severity: "error", path, message: `priceCurrency "${v}" must be an ISO 4217 code such as EUR` });
    if (
      key === "availability" &&
      !/schema\.org\/(InStock|OutOfStock|PreOrder|BackOrder|Discontinued|InStoreOnly|LimitedAvailability|OnlineOnly|PreSale|SoldOut|Reserved|MadeToOrder)$/.test(
        v,
      )
    )
      findings.push({
        severity: "warn",
        path,
        message: `availability "${v}" should be a schema.org ItemAvailability URL (https://schema.org/InStock)`,
      });
    if (/<[a-z][\s\S]*>/i.test(v) && (key === "description" || key === "text" || key === "name" || key === "headline"))
      findings.push({ severity: "info", path, message: `${key} contains HTML markup` });
  }
  if (typeof value === "number" && (key === "ratingValue" || key === "price")) return;
  if (key === "headline" && typeof value === "string" && value.length > 110)
    findings.push({ severity: "warn", path, message: `headline is ${value.length} characters (Google cuts it after 110)` });
}

function checkNode(node: Record<string, unknown>, types: string[], path: string): Finding[] {
  const findings: Finding[] = [];
  for (const type of types) {
    const rule = TYPE_RULES[type];
    if (!rule) continue;
    for (const req of rule.required ?? []) {
      const keys = Array.isArray(req) ? req : [req];
      if (keys.every((k) => isEmpty(node[k])))
        findings.push({
          severity: "error",
          path,
          message: `${type}: missing required ${keys.length > 1 ? `one of ${keys.join(" / ")}` : keys[0]}`,
        });
    }
    for (const rec of rule.recommended ?? []) {
      const keys = Array.isArray(rec) ? rec : [rec];
      if (keys.every((k) => isEmpty(node[k])))
        findings.push({
          severity: "warn",
          path,
          message: `${type}: missing recommended ${keys.length > 1 ? `one of ${keys.join(" / ")}` : keys[0]}`,
        });
    }
    if (rule.note) findings.push({ severity: "info", path, message: rule.note });
  }
  if (types.includes("BreadcrumbList") && Array.isArray(node.itemListElement)) {
    const positions = node.itemListElement.map((i) => Number((i as Record<string, unknown>)?.position));
    if (positions.some((p, i) => p !== i + 1))
      findings.push({ severity: "warn", path, message: `BreadcrumbList positions are ${positions.join(", ")}: expected 1, 2, 3…` });
  }
  for (const key of Object.keys(node)) {
    if (
      key.startsWith("@") &&
      !["@context", "@type", "@id", "@graph", "@value", "@language", "@list", "@reverse", "@vocab", "@base"].includes(key)
    )
      findings.push({ severity: "error", path, message: `Unknown keyword ${key} (JSON-LD keywords are case-sensitive)` });
    checkValue(key, node[key], `${path}.${key}`, findings, true);
  }
  return findings;
}

function walk(value: unknown, path: string, nodes: JsonLdNode[], contexts: Set<string>, depth = 0) {
  if (depth > 30 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`, nodes, contexts, depth + 1);
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
      findings: checkNode(obj, types, path),
    });
  for (const [k, v] of Object.entries(obj)) if (k !== "@context") walk(v, `${path}.${k}`, nodes, contexts, depth + 1);
}

export function analyzeBlock(raw: string, index: number): JsonLdBlock {
  const block: JsonLdBlock = { index, raw, ok: false, contexts: [], nodes: [], findings: [] };
  const text = raw.trim();
  if (!text) {
    block.error = "Empty script";
    block.findings.push({ severity: "error", path: `#${index + 1}`, message: "The <script type=application/ld+json> is empty" });
    return block;
  }
  try {
    block.value = JSON.parse(text);
  } catch (e) {
    block.error = jsonErrorAt(text, e);
    block.findings.push({ severity: "error", path: `#${index + 1}`, message: `Invalid JSON, ${block.error}` });
    return block;
  }
  block.ok = true;
  const contexts = new Set<string>();
  walk(block.value, `#${index + 1}`, block.nodes, contexts);
  block.contexts = Array.from(contexts);
  if (!contexts.size)
    block.findings.push({ severity: "error", path: `#${index + 1}`, message: "No @context: set it to https://schema.org" });
  else if (!block.contexts.some((c) => /schema\.org/.test(c)))
    block.findings.push({ severity: "warn", path: `#${index + 1}`, message: `@context is ${block.contexts.join(", ")}, not schema.org` });
  if (!block.nodes.length) block.findings.push({ severity: "error", path: `#${index + 1}`, message: "No node with an @type" });
  const ids = new Set(block.nodes.map((n) => n.id).filter(Boolean));
  for (const node of block.nodes) {
    for (const [k, v] of Object.entries(node.data)) {
      const ref =
        v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 ? (v as Record<string, unknown>)["@id"] : undefined;
      if (typeof ref === "string" && ref.startsWith("#") && !ids.has(ref) && !Array.from(ids).some((id) => id?.endsWith(ref)))
        node.findings.push({
          severity: "warn",
          path: `${node.path}.${k}`,
          message: `${k} points to ${ref}, which no node in this block defines`,
        });
    }
  }
  return block;
}

export function analyzeJsonLd(scripts: { raw: string; index: number }[]): JsonLdReport {
  const blocks = scripts.map((s) => analyzeBlock(s.raw, s.index));
  const typeCounts = new Map<string, number>();
  for (const b of blocks) for (const n of b.nodes) for (const t of n.types) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  const all = blocks.flatMap((b) => [...b.findings, ...b.nodes.flatMap((n) => n.findings)]);
  return {
    blocks,
    types: Array.from(typeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    counts: {
      error: all.filter((f) => f.severity === "error").length,
      warn: all.filter((f) => f.severity === "warn").length,
      info: all.filter((f) => f.severity === "info").length,
    },
  };
}

export const richResultsTestUrl = (url: string) => `https://search.google.com/test/rich-results?url=${encodeURIComponent(url)}`;
export const schemaValidatorUrl = (url: string) => `https://validator.schema.org/#url=${encodeURIComponent(url)}`;
