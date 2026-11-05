import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { EXPORTERS, type ExportFormat, type HarRequestLike } from "../lib/har";
import { parseJson } from "../lib/utils/json";
import { Button, bytes, Code, download, Empty, JsonTree, KV, msText, ToastProvider } from "./components";

interface Entry {
  id: number;
  request: HarRequestLike & { queryString?: { name: string; value: string }[] };
  response: {
    status: number;
    statusText: string;
    headers: { name: string; value: string }[];
    content: { size: number; mimeType: string };
    _transferSize?: number;
  };
  time: number;
  startedDateTime: string;
  _resourceType?: string;
  getContent?: (cb: (content: string, encoding: string) => void) => void;
}

let nextId = 1;

function Panel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [format, setFormat] = useState<ExportFormat>("curl");
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    const net = browser.devtools.network;
    net.getHAR(((har: { entries: Entry[] }) => setEntries(har.entries.map((e) => Object.assign(e, { id: nextId++ })))) as never);
    const onFinished = (req: unknown) => setEntries((es) => [...es.slice(-1999), Object.assign(req as Entry, { id: nextId++ })]);
    const onNavigated = () => setEntries([]);
    net.onRequestFinished.addListener(onFinished as never);
    net.onNavigated.addListener(onNavigated);
    return () => {
      net.onRequestFinished.removeListener(onFinished as never);
      net.onNavigated.removeListener(onNavigated);
    };
  }, []);
  useEffect(() => {
    setBody(null);
    selected?.getContent?.((content, encoding) => setBody(encoding === "base64" ? `[base64, ${content.length} chars]` : content));
  }, [selected]);
  const types = useMemo(() => Array.from(new Set(entries.map((e) => e._resourceType ?? "other"))).sort(), [entries]);
  const shown = entries.filter(
    (e) => (type === "all" || (e._resourceType ?? "other") === type) && e.request.url.toLowerCase().includes(filter.toLowerCase()),
  );
  const json = body ? parseJson(body) : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "minmax(300px, 45%) 1fr" : "1fr", height: "100vh" }}>
      <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)", minHeight: 0 }}>
        <div className="row" style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
          <input
            type="search"
            className="grow"
            style={{ width: "auto" }}
            placeholder="Filter URL"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto" }}>
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <Button
            size="small"
            onClick={() =>
              browser.devtools.network.getHAR((har: unknown) => download(`devkit-${Date.now()}.har`, JSON.stringify({ log: har }, null, 2)))
            }
          >
            Export HAR
          </Button>
          <Button size="small" onClick={() => setEntries([])}>
            Clear
          </Button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {shown.length ? (
            <table className="kv">
              <tbody>
                {shown.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e)}
                    style={{ cursor: "pointer", background: selected?.id === e.id ? "var(--accent-soft)" : undefined }}
                  >
                    <th style={{ width: 70 }}>
                      <span className={e.response.status >= 400 || e.response.status === 0 ? "t-bad" : ""}>
                        {e.response.status || "ERR"}
                      </span>{" "}
                      {e.request.method}
                    </th>
                    <td className="ellipsis" style={{ maxWidth: 0 }} title={e.request.url}>
                      {e.request.url.replace(/^https?:\/\//, "")}
                    </td>
                    <td style={{ width: 120, color: "var(--fg-3)" }}>
                      {bytes(e.response._transferSize ?? e.response.content.size)} · {msText(e.time)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Requests appear here as the page loads. Reload to see them all.</Empty>
          )}
        </div>
      </div>
      {selected ? (
        <div style={{ overflow: "auto", padding: 12 }} className="stack">
          <div className="row">
            <b className="grow break mono small">
              {selected.request.method} {selected.request.url}
            </b>
            <Button size="small" variant="ghost" onClick={() => setSelected(null)}>
              ✕
            </Button>
          </div>
          <div className="row">
            {(Object.keys(EXPORTERS) as ExportFormat[]).map((f) => (
              <Button key={f} size="small" variant={f === format ? "primary" : undefined} onClick={() => setFormat(f)}>
                {f === "curl" ? "cURL" : f === "httpie" ? "HTTPie" : f[0]!.toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
          <Code text={EXPORTERS[format](selected.request)} maxHeight={220} />
          <h3>
            Response {selected.response.status} {selected.response.statusText}
          </h3>
          <KV rows={selected.response.headers.map((h) => [h.name, h.value])} />
          <h3>Request headers</h3>
          <KV rows={selected.request.headers.map((h) => [h.name, h.value])} />
          {selected.request.postData?.text ? (
            <>
              <h3>Request body</h3>
              <Code text={selected.request.postData.text} />
            </>
          ) : null}
          <h3>Response body</h3>
          {body === null ? (
            <Empty>…</Empty>
          ) : json?.ok ? (
            <div className="tree card">
              <JsonTree value={json.value} />
            </div>
          ) : (
            <Code text={body.slice(0, 200_000)} />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DevtoolsPanelApp() {
  return (
    <ToastProvider>
      <Panel />
    </ToastProvider>
  );
}
