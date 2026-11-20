// GraphQL over HTTP, read from HAR entries (what chrome.devtools.network hands out): which requests
// carry GraphQL operations, what each operation is, and what the server answered for it.
// No dependency: a minimal tokenizer reads the operation type and name and pretty-prints documents.

export type OperationType = "query" | "mutation" | "subscription";

export type GraphqlTransport = "json" | "batch" | "get" | "graphql-body" | "multipart";

export interface GraphqlOperation {
  /** Position in the request (0 unless the request is a batch). */
  index: number;
  /** operationName, or the name in the document; null for an anonymous operation. */
  name: string | null;
  /** null when the request carries no document (persisted query by hash or id). */
  type: OperationType | null;
  query: string | null;
  /** undefined when the request sends no variables. */
  variables: unknown;
  extensions: unknown;
  /** Automatic persisted query hash (extensions.persistedQuery.sha256Hash). */
  persistedHash: string | null;
  /** Persisted document id (Relay `id` / `doc_id`, `documentId`). */
  documentId: string | null;
}

export interface GraphqlRequest {
  transport: GraphqlTransport;
  batched: boolean;
  operations: GraphqlOperation[];
  /** Files attached to a multipart upload (graphql-multipart-request spec), from its `map` field. */
  files: number;
}

export interface GraphqlError {
  message: string;
  path: (string | number)[] | null;
  locations: { line: number; column: number }[] | null;
  /** extensions.code, when the server sets one (Apollo: UNAUTHENTICATED, BAD_USER_INPUT…). */
  code: string | null;
}

export interface GraphqlResult {
  hasData: boolean;
  data: unknown;
  errors: GraphqlError[];
  extensions: unknown;
  /** The whole parsed response object for this operation. */
  raw: unknown;
}

export interface HarRequestInput {
  method: string;
  url: string;
  headers?: { name: string; value: string }[];
  postData?: { mimeType?: string; text?: string; params?: { name: string; value?: string }[] };
}

/* Tokenizer */

export type TokenKind = "name" | "punct" | "string" | "number" | "comment";
export interface Token {
  kind: TokenKind;
  value: string;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      out.push({ kind: "comment", value: src.slice(i, j).trimEnd() });
      i = j;
      continue;
    }
    if (c === '"') {
      let j: number;
      if (src.startsWith('"""', i)) {
        j = i + 3;
        while (j < n && !(src.startsWith('"""', j) && src[j - 1] !== "\\")) j++;
        j = Math.min(n, j + 3);
      } else {
        j = i + 1;
        while (j < n && src[j] !== '"' && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        j = Math.min(n, j + 1);
      }
      out.push({ kind: "string", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith("...", i)) {
      out.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i, i + 256));
    if (name) {
      out.push({ kind: "name", value: name[0] });
      i += name[0].length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (num) {
      out.push({ kind: "number", value: num[0] });
      i += num[0].length;
      continue;
    }
    // Known punctuators and anything unexpected: one character, so a broken document still prints.
    out.push({ kind: "punct", value: c });
    i++;
  }
  return out;
}

const OP_KEYWORDS = new Set(["query", "mutation", "subscription"]);

/** The operations a document defines (fragments skipped), in order. */
export function readOperations(doc: string): { type: OperationType; name: string | null }[] {
  const ops: { type: OperationType; name: string | null }[] = [];
  const toks = tokenize(doc).filter((t) => t.kind !== "comment");
  let depth = 0;
  let atStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "punct" && (t.value === "{" || t.value === "(")) {
      if (depth === 0 && atStart && t.value === "{") ops.push({ type: "query", name: null });
      depth++;
      atStart = false;
      continue;
    }
    if (t.kind === "punct" && (t.value === "}" || t.value === ")")) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && t.value === "}") atStart = true;
      continue;
    }
    if (depth > 0 || !atStart) continue;
    atStart = false;
    if (t.kind === "name" && OP_KEYWORDS.has(t.value)) {
      const next = toks[i + 1];
      ops.push({ type: t.value as OperationType, name: next?.kind === "name" ? next.value : null });
    }
  }
  return ops;
}

/** Type and name of the operation a request runs: the one named operationName, else the first. */
export function pickOperation(doc: string, operationName?: string | null): { type: OperationType | null; name: string | null } {
  const ops = readOperations(doc);
  const found = operationName ? ops.find((o) => o.name === operationName) : ops[0];
  return { type: found?.type ?? ops[0]?.type ?? null, name: operationName || found?.name || null };
}

/** Re-indents a GraphQL document: one field per line, two spaces per level, arguments on one line. */
export function prettyQuery(doc: string): string {
  const toks = tokenize(doc);
  const lines: string[] = [];
  let line = "";
  let indent = 0;
  let paren = 0;
  let prev: Token | null = null;
  const pad = () => "  ".repeat(indent);
  const flush = () => {
    if (line.trim()) lines.push(line.trimEnd());
    line = "";
    prev = null;
  };
  const NO_SPACE_BEFORE = new Set([":", ",", ")", "]", "!", "("]);
  const NO_SPACE_AFTER = new Set(["(", "[", "$", "@"]);
  // Tokens after which a name in a selection set continues the same field (alias, directive, spread…).
  const JOINS = new Set([":", "@", "$", "...", "on", "(", "[", "=", "|", "&"]);
  for (const t of toks) {
    const v = t.value;
    if (t.kind === "comment") {
      const wasEmpty = !line.trim();
      if (!wasEmpty) line += ` ${v}`;
      else line = pad() + v;
      flush();
      continue;
    }
    if (paren === 0 && t.kind === "punct" && v === "{") {
      line = (line.trim() ? `${line.trimEnd()} ` : pad()) + "{";
      flush();
      indent++;
      continue;
    }
    if (paren === 0 && t.kind === "punct" && v === "}") {
      flush();
      indent = Math.max(0, indent - 1);
      line = `${pad()}}`;
      flush();
      if (indent === 0) lines.push("");
      continue;
    }
    if (paren === 0 && indent > 0 && t.kind === "punct" && v === ",") continue;
    if (v === "(" && t.kind === "punct") paren++;
    if (v === ")" && t.kind === "punct") paren = Math.max(0, paren - 1);
    const p = prev as Token | null;
    const startsField =
      paren === 0 && indent > 0 && p !== null && (t.kind === "name" || v === "...") && !JOINS.has(p.value) && !(v === "(" || v === "@");
    if (startsField) flush();
    if (!line.trim()) line = pad();
    else if (p) {
      const tight =
        (t.kind === "punct" && NO_SPACE_BEFORE.has(v)) ||
        (p.kind === "punct" && NO_SPACE_AFTER.has(p.value)) ||
        (p.value === "..." && t.kind === "name" && v !== "on") ||
        (paren > 0 && p.value === "{") ||
        (paren > 0 && v === "}");
      if (!tight) line += " ";
    }
    line += v;
    prev = t;
  }
  flush();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/* Detection */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function tryJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const hasSelection = (doc: string) => readOperations(doc).length > 0;

/** One operation from a `{query, operationName, variables, extensions}` object, or null if it is not one. */
function toOperation(o: unknown, index: number, graphqlUrl: boolean): GraphqlOperation | null {
  if (!isObj(o)) return null;
  const query = typeof o.query === "string" ? o.query : null;
  const ext = isObj(o.extensions) ? o.extensions : undefined;
  const pq = ext && isObj(ext.persistedQuery) ? ext.persistedQuery : undefined;
  const persistedHash = str(pq?.sha256Hash);
  const documentId = str(o.id) ?? str(o.doc_id) ?? str(o.documentId);
  const operationName = str(o.operationName);
  const isOp =
    (query !== null && (hasSelection(query) || (graphqlUrl && query.trim() !== ""))) ||
    persistedHash !== null ||
    (operationName !== null && ("variables" in o || "extensions" in o || documentId !== null || "query" in o));
  if (!isOp) return null;
  const picked = query ? pickOperation(query, operationName) : { type: null, name: operationName };
  return {
    index,
    name: picked.name,
    type: picked.type,
    query,
    variables: o.variables === null ? undefined : o.variables,
    extensions: o.extensions,
    persistedHash,
    documentId: query ? null : documentId,
  };
}

/** A JSON payload: one operation object, or a batch (array) of them. */
function fromPayload(payload: unknown, graphqlUrl: boolean): { batched: boolean; operations: GraphqlOperation[] } | null {
  if (Array.isArray(payload)) {
    if (!payload.length) return null;
    const ops = payload.map((p, i) => toOperation(p, i, graphqlUrl));
    return ops.every((o): o is GraphqlOperation => o !== null) ? { batched: true, operations: ops } : null;
  }
  const op = toOperation(payload, 0, graphqlUrl);
  return op ? { batched: false, operations: [op] } : null;
}

function header(req: HarRequestInput, name: string): string {
  return req.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

/** A multipart/form-data field from the HAR params, or parsed out of the raw body. */
export function multipartField(postData: NonNullable<HarRequestInput["postData"]>, field: string): string | null {
  const param = postData.params?.find((p) => p.name === field);
  if (param?.value !== undefined) return param.value;
  const text = postData.text;
  if (!text) return null;
  const boundary = /boundary="?([^";]+)"?/i.exec(postData.mimeType ?? "")?.[1] ?? /^--([^\r\n]+)/.exec(text)?.[1];
  if (!boundary) return null;
  for (const part of text.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    const m = /content-disposition:[^\r\n]*\bname="([^"]*)"/i.exec(head);
    if (m?.[1] !== field) continue;
    return part
      .slice(split)
      .replace(/^\r?\n\r?\n/, "")
      .replace(/\r?\n$/, "");
  }
  return null;
}

/** The GraphQL operations a HAR request carries, or null when it is not a GraphQL request. */
export function detectGraphql(req: HarRequestInput): GraphqlRequest | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const graphqlUrl = /graphql|gql/i.test(url.pathname);
  const mime = (req.postData?.mimeType || header(req, "content-type")).toLowerCase();
  const text = req.postData?.text;
  const params = url.searchParams;

  if (req.postData && (text || req.postData.params?.length)) {
    if (mime.includes("application/graphql")) {
      if (!text?.trim()) return null;
      const picked = pickOperation(text, params.get("operationName"));
      const variables = tryJson(params.get("variables"));
      const operation: GraphqlOperation = {
        index: 0,
        ...picked,
        query: text,
        variables,
        extensions: undefined,
        persistedHash: null,
        documentId: null,
      };
      return { transport: "graphql-body", batched: false, operations: [operation], files: 0 };
    }
    if (mime.includes("multipart/form-data")) {
      const operations = multipartField(req.postData, "operations");
      const found = fromPayload(tryJson(operations), true);
      if (!found) return null;
      const map = tryJson(multipartField(req.postData, "map"));
      return { transport: "multipart", ...found, files: isObj(map) ? Object.keys(map).length : 0 };
    }
    const found = fromPayload(tryJson(text), graphqlUrl);
    if (found) return { transport: found.batched ? "batch" : "json", ...found, files: 0 };
    return null;
  }

  if (params.has("query") || params.has("extensions") || params.has("operationName")) {
    const payload: Record<string, unknown> = {};
    for (const key of ["query", "operationName", "id", "doc_id", "documentId"]) {
      const v = params.get(key);
      if (v !== null) payload[key] = v;
    }
    for (const key of ["variables", "extensions"]) {
      const v = params.get(key);
      if (v !== null) payload[key] = tryJson(v) ?? v;
    }
    // A `query` URL parameter is also a plain search box on many sites: a GET counts only with a selection set.
    if (typeof payload.query === "string" && !hasSelection(payload.query)) return null;
    const op = toOperation(payload, 0, graphqlUrl);
    return op ? { transport: "get", batched: false, operations: [op], files: 0 } : null;
  }
  return null;
}

/* Responses */

function toError(e: unknown): GraphqlError {
  if (!isObj(e)) return { message: String(e), path: null, locations: null, code: null };
  const path = Array.isArray(e.path) ? e.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number") : null;
  const locations = Array.isArray(e.locations)
    ? e.locations.filter(isObj).map((l) => ({ line: Number(l.line), column: Number(l.column) }))
    : null;
  const ext = isObj(e.extensions) ? e.extensions : undefined;
  return {
    message: typeof e.message === "string" ? e.message : JSON.stringify(e),
    path,
    locations,
    code: str(ext?.code) ?? str(e.code),
  };
}

export function toResult(v: unknown): GraphqlResult | null {
  if (!isObj(v)) return null;
  return {
    hasData: "data" in v,
    data: v.data,
    errors: Array.isArray(v.errors) ? v.errors.map(toError) : [],
    extensions: v.extensions,
    raw: v,
  };
}

/**
 * The response for each operation of a request, from the response body. A batch answers with an array
 * in request order; a single object answering a batch (a transport error) goes to every operation.
 * Returns null when the body is not JSON.
 */
export function parseGraphqlResponse(body: string, count = 1): (GraphqlResult | null)[] | null {
  const json = tryJson(body.trim());
  if (json === undefined) return null;
  if (Array.isArray(json)) return Array.from({ length: Math.max(count, 1) }, (_, i) => toResult(json[i]));
  const one = toResult(json);
  return Array.from({ length: Math.max(count, 1) }, () => one);
}

/** "user.posts.0.title" for an error path. */
export const errorPath = (path: (string | number)[] | null): string => (path?.length ? path.join(".") : "");

/** host + path of the endpoint, without the query string. */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

/** One row per operation, across the given entries; entries that are not GraphQL are skipped. */
export function graphqlRows<E extends { request: HarRequestInput }>(
  entries: E[],
): { entry: E; request: GraphqlRequest; operation: GraphqlOperation }[] {
  const rows: { entry: E; request: GraphqlRequest; operation: GraphqlOperation }[] = [];
  for (const entry of entries) {
    const request = detectGraphql(entry.request);
    if (request) for (const operation of request.operations) rows.push({ entry, request, operation });
  }
  return rows;
}
