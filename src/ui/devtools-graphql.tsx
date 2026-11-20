import { useEffect, useMemo, useState } from "react";
import {
  detectGraphql,
  endpointOf,
  errorPath,
  type GraphqlOperation,
  type GraphqlRequest,
  type GraphqlResult,
  parseGraphqlResponse,
  prettyQuery,
} from "../lib/graphql";
import { toCurl, toFetch } from "../lib/har";
import { Button, bytes, CopyButton, Code, Empty, JsonTree, KV, msText, Notice } from "./components";
import type { Entry } from "./DevtoolsPanel";

export interface GraphqlRow {
  key: string;
  entry: Entry;
  request: GraphqlRequest;
  operation: GraphqlOperation;
}

// Detection parses request bodies: once per HAR entry, not on every new request.
const detected = new WeakMap<Entry, GraphqlRequest | null>();
// Response bodies come from entry.getContent(), asked once per entry.
const bodies = new WeakMap<Entry, string | null>();
const asked = new WeakSet<Entry>();
/** Bodies read up front for the errors badge: the most recent GraphQL requests only. */
const PREFETCH = 300;

export function graphqlRowsOf(entries: Entry[]): GraphqlRow[] {
  const rows: GraphqlRow[] = [];
  for (const entry of entries) {
    if (!detected.has(entry)) detected.set(entry, detectGraphql(entry.request));
    const request = detected.get(entry);
    if (request)
      for (const operation of request.operations) rows.push({ key: `${entry.id}:${operation.index}`, entry, request, operation });
  }
  return rows;
}

const listeners = new Set<() => void>();

function readBody(entry: Entry) {
  if (asked.has(entry)) return;
  asked.add(entry);
  if (!entry.getContent) {
    bodies.set(entry, null);
    return;
  }
  entry.getContent((content, encoding) => {
    bodies.set(entry, encoding === "base64" ? null : (content ?? null));
    for (const listener of listeners) listener();
  });
}

/** Response bodies of the given entries, read lazily: the most recent ones, plus `also` (the selected one). */
function useBodies(entries: Entry[], also: Entry | undefined): (entry: Entry) => string | null | undefined {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const changed = () => setVersion((v) => v + 1);
    listeners.add(changed);
    return () => {
      listeners.delete(changed);
    };
  }, []);
  useEffect(() => {
    for (const entry of Array.from(new Set(entries)).slice(-PREFETCH)) readBody(entry);
  }, [entries]);
  useEffect(() => {
    if (also) readBody(also);
  }, [also]);
  return (entry) => (bodies.has(entry) ? bodies.get(entry) : undefined);
}

const TYPES = ["query", "mutation", "subscription", "persisted"] as const;
const typeOf = (op: GraphqlOperation) => op.type ?? "persisted";
const label = (op: GraphqlOperation) => op.name ?? "(anonymous)";

function resultFor(body: string | null | undefined, row: GraphqlRow): GraphqlResult | null | undefined {
  if (body === undefined) return undefined;
  if (body === null) return null;
  return parseGraphqlResponse(body, row.request.operations.length)?.[row.operation.index] ?? null;
}

export function GraphqlView({ rows, onClear }: { rows: GraphqlRow[]; onClear: () => void }) {
  const [filter, setFilter] = useState("");
  const [type, setType] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const entries = useMemo(() => rows.map((r) => r.entry), [rows]);
  const selected = rows.find((r) => r.key === selectedKey) ?? null;
  const bodyOf = useBodies(entries, selected?.entry);
  const q = filter.trim().toLowerCase();
  const shown = rows.filter((r) => (type === "all" || typeOf(r.operation) === type) && label(r.operation).toLowerCase().includes(q));
  return (
    <div className="gql" style={{ display: "grid", gridTemplateColumns: selected ? "minmax(320px, 45%) 1fr" : "1fr", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)", minHeight: 0 }}>
        <div className="row" style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
          <input
            type="search"
            className="grow"
            style={{ width: "auto" }}
            placeholder="Filter operation name"
            aria-label="Filter operation name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto" }} aria-label="Operation type">
            <option value="all">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button size="small" onClick={onClear}>
            Clear
          </Button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {shown.length ? (
            <table className="kv gql-list">
              <tbody>
                {shown.map((r) => {
                  const result = resultFor(bodyOf(r.entry), r);
                  const errors = result?.errors.length ?? 0;
                  const status = r.entry.response.status;
                  return (
                    <tr
                      key={r.key}
                      onClick={() => setSelectedKey(r.key)}
                      aria-selected={selected?.key === r.key}
                      style={{ cursor: "pointer", background: selected?.key === r.key ? "var(--accent-soft)" : undefined }}
                    >
                      <th style={{ width: 46 }}>
                        <span className={status >= 400 || status === 0 ? "t-bad" : ""}>{status || "ERR"}</span>
                      </th>
                      <td style={{ maxWidth: 0 }}>
                        <div className="row gql-name">
                          <span className={`pill gql-type gql-${typeOf(r.operation)}`}>{typeOf(r.operation)}</span>
                          <b className="ellipsis" title={label(r.operation)}>
                            {label(r.operation)}
                          </b>
                          {r.request.batched ? (
                            <span className="pill" title="Batched: several operations in one HTTP request">
                              batch {r.operation.index + 1}/{r.request.operations.length}
                            </span>
                          ) : null}
                          {errors ? <span className="pill t-bad">{errors === 1 ? "1 error" : `${errors} errors`}</span> : null}
                        </div>
                        <div className="ellipsis gql-endpoint" title={r.entry.request.url}>
                          {r.entry.request.method} {endpointOf(r.entry.request.url)}
                        </div>
                      </td>
                      <td style={{ width: 110, color: "var(--fg-3)" }}>
                        {bytes(r.entry.response._transferSize ?? r.entry.response.content.size)} · {msText(r.entry.time)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>
              {rows.length
                ? "No operation matches the filter."
                : "GraphQL operations appear here as the page sends them (POST JSON, batches, persisted queries, GET, multipart uploads). Reload to see them all."}
            </Empty>
          )}
        </div>
        <p className="muted small gql-hint">
          Subscriptions over WebSocket (graphql-ws, subscriptions-transport-ws) are not part of the HAR, so they are not listed: see their
          frames in Chrome's Network panel, WS tab. Server-sent events and @defer multipart responses show as plain requests.
        </p>
      </div>
      {selected ? <GraphqlDetail row={selected} body={bodyOf(selected.entry)} onClose={() => setSelectedKey(null)} /> : null}
    </div>
  );
}

function GraphqlDetail({ row, body, onClose }: { row: GraphqlRow; body: string | null | undefined; onClose: () => void }) {
  const { entry, request, operation } = row;
  const pretty = useMemo(() => (operation.query ? prettyQuery(operation.query) : ""), [operation.query]);
  const result = resultFor(body, row);
  const variables = operation.variables === undefined ? "" : JSON.stringify(operation.variables, null, 2);
  return (
    <div style={{ overflow: "auto", padding: 12 }} className="stack gql-detail">
      <div className="row">
        <span className={`pill gql-type gql-${typeOf(operation)}`}>{typeOf(operation)}</span>
        <b className="grow break mono">{label(operation)}</b>
        <Button size="small" variant="ghost" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <p className="muted small break">
        {entry.request.method} {entry.request.url.length > 300 ? `${entry.request.url.slice(0, 300)}…` : entry.request.url} ·{" "}
        {entry.response.status || "ERR"} · {msText(entry.time)} · {bytes(entry.response._transferSize ?? entry.response.content.size)}
        {request.batched ? ` · operation ${operation.index + 1} of ${request.operations.length} in a batched request` : ""}
        {request.files ? ` · ${request.files} file${request.files === 1 ? "" : "s"} uploaded` : ""}
      </p>
      <div className="row">
        {pretty ? <CopyButton text={pretty} label="Copy query" /> : null}
        {variables ? <CopyButton text={variables} label="Copy variables" /> : null}
        <CopyButton text={toCurl(entry.request)} label="Copy as cURL" />
        <CopyButton text={toFetch(entry.request)} label="Copy as fetch" />
      </div>
      {request.batched ? <p className="muted small">cURL and fetch replay the whole batched request.</p> : null}

      <h3>Query</h3>
      {pretty ? (
        <Code text={pretty} maxHeight={320} />
      ) : (
        <Notice>
          Persisted query: the request sends no document, only{" "}
          {operation.persistedHash ? (
            <>
              its hash <code className="break">{operation.persistedHash}</code>
            </>
          ) : (
            <>
              its id <code className="break">{operation.documentId ?? "?"}</code>
            </>
          )}
          . The server holds the query text.
        </Notice>
      )}
      {pretty && operation.persistedHash ? (
        <p className="muted small break">
          Persisted query hash: <code>{operation.persistedHash}</code>
        </p>
      ) : null}

      <h3>Variables</h3>
      {operation.variables === undefined ? (
        <Empty>No variables.</Empty>
      ) : (
        <div className="tree card">
          <JsonTree value={operation.variables} />
        </div>
      )}

      <h3>Response</h3>
      {body === undefined ? (
        <Empty>Reading the response…</Empty>
      ) : body === null ? (
        <Empty>Chrome did not keep the response body (binary, too large or the request failed).</Empty>
      ) : !result ? (
        <Code text={body.slice(0, 200_000)} />
      ) : (
        <>
          {result.errors.length ? (
            <section className="gql-errors" aria-label="GraphQL errors">
              <b className="t-bad">{result.errors.length === 1 ? "1 error" : `${result.errors.length} errors`}</b>
              <ul>
                {result.errors.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: errors have no id and never reorder
                  <li key={i}>
                    <span className="break">{e.message}</span>
                    {e.path ? <code className="gql-path">{errorPath(e.path)}</code> : null}
                    {e.code ? <span className="pill t-bad">{e.code}</span> : null}
                    {e.locations?.length ? (
                      <span className="muted small"> line {e.locations.map((l) => `${l.line}:${l.column}`).join(", ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {result.hasData ? (
            <div className="tree card">
              <JsonTree name="data" value={result.data} />
            </div>
          ) : result.errors.length ? null : (
            <Empty>No data in the response.</Empty>
          )}
          {result.extensions !== undefined ? (
            <div className="tree card">
              <JsonTree name="extensions" value={result.extensions} open={1} />
            </div>
          ) : null}
        </>
      )}

      <h3>Request headers</h3>
      <KV rows={entry.request.headers.map((h) => [h.name, h.value])} />
      <h3>
        Response headers {entry.response.status} {entry.response.statusText}
      </h3>
      <KV rows={entry.response.headers.map((h) => [h.name, h.value])} />
    </div>
  );
}
