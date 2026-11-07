import { useEffect, useMemo, useState } from "react";
import { fetchHeaders, type Level } from "../../lib/headers";
import { collectSecretSources, collectSurface } from "../../lib/page/security";
import { analyzeCsp, type CspFinding, type CspPolicy, parseCsp, starterCsp } from "../../lib/security/csp";
import {
  baselinePath,
  findSourceMapUrl,
  isSourceMap,
  judgeProbe,
  PROBES,
  type ProbeResponse,
  type ProbeVerdict,
} from "../../lib/security/exposed";
import { mergeFindings, SECRET_RULES, type SecretFinding, type SecretSource, scanSecrets } from "../../lib/security/secrets";
import { groupBySite, siteOf, surfaceFindings } from "../../lib/security/third-party";
import { Button, bytes, CopyButton, Dot, Empty, ErrorText, Metric, Notice, Section } from "../components";
import { useAsync } from "../hooks";
import { AccessGate, useInPage, usePage } from "../page";

const MB = 1024 * 1024;
const MAX_SOURCE = 2 * MB;
const SCRIPT_BUDGET = 8 * MB;

interface Fetched {
  status: number;
  url: string;
  type: string;
  headers: Record<string, string>;
  text: string;
  bytes: Uint8Array;
  /** Bytes read (the body may be longer when `truncated`). */
  size: number;
  truncated: boolean;
}

/** GET `url` from devkit, reading at most `max` bytes of the body, with a timeout. */
async function fetchCapped(url: string, max: number, signal?: AbortSignal, init: RequestInit = {}): Promise<Fetched> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "follow", ...init, signal: ctrl.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= max) {
        truncated = true;
        reader.cancel().catch(() => undefined);
        break;
      }
    }
    const body = new Uint8Array(Math.min(size, max));
    let at = 0;
    for (const c of chunks) {
      const part = c.subarray(0, Math.min(c.length, body.length - at));
      body.set(part, at);
      at += part.length;
      if (at >= body.length) break;
    }
    return {
      status: res.status,
      url: res.url,
      type: res.headers.get("content-type") ?? "",
      headers,
      text: new TextDecoder().decode(body),
      bytes: body,
      size,
      truncated,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Runs `work` over `items`, `n` at a time, until done or aborted. */
async function pool<T>(items: T[], n: number, signal: AbortSignal, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length && !signal.aborted) {
        const i = next++;
        await work(items[i]!, i);
      }
    }),
  );
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* Secrets */

interface ScriptScan {
  findings: SecretFinding[];
  total: number;
  done: number;
  bytes: number;
  skipped: number;
  capped: number;
  failed: number;
  running: boolean;
}

const NO_SCAN: ScriptScan = { findings: [], total: 0, done: 0, bytes: 0, skipped: 0, capped: 0, failed: 0, running: false };

function SecretItem({ f }: { f: SecretFinding }) {
  const [shown, setShown] = useState(false);
  const [all, setAll] = useState(false);
  const locations = all ? f.locations : f.locations.slice(0, 3);
  return (
    <li className="secret">
      <div className="row">
        <Dot level={f.severity} />
        <b>{f.title}</b>
        {f.heuristic ? <span className="pill">heuristic</span> : null}
        <span className="grow" />
        <Button size="small" onClick={() => setShown(!shown)} aria-pressed={shown}>
          {shown ? "Hide" : "Reveal"}
        </Button>
        <CopyButton text={f.value} />
      </div>
      <code className="secret-value">{shown ? f.value : f.masked}</code>
      <div className="small muted">{f.why}</div>
      {f.detail ? <div className="small">{f.detail}</div> : null}
      <ul className="secret-where">
        {locations.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: locations are ordered
          <li key={i}>
            <span className="small">
              {l.url ? (
                <a href={l.url} target="_blank" rel="noreferrer" className="mono" title={l.url}>
                  {l.source}
                </a>
              ) : (
                <span className="mono">{l.source}</span>
              )}{" "}
              <span className="muted">
                line {l.line}
                {l.column > 1 ? `, col ${l.column}` : ""}
              </span>
            </span>
            <span className="mono small muted ellipsis" title={l.context}>
              {l.context}
            </span>
          </li>
        ))}
      </ul>
      {f.locations.length > 3 ? (
        <Button size="small" variant="ghost" onClick={() => setAll(!all)}>
          {all ? "Fewer places" : `${f.locations.length - 3} more place${f.locations.length - 3 === 1 ? "" : "s"}`}
        </Button>
      ) : null}
    </li>
  );
}

export function Secrets() {
  const snap = useInPage(collectSecretSources, [MAX_SOURCE], "MAIN");
  const [scan, setScan] = useState<ScriptScan>(NO_SCAN);
  const [ctrl, setCtrl] = useState<AbortController | null>(null);
  const pageFindings = useMemo(() => (snap.data ? scanSecrets(snap.data.sources) : []), [snap.data]);

  useEffect(() => {
    const data = snap.data;
    if (!data) return;
    const own = data.scripts.filter((u) => new URL(u).origin === data.origin);
    const abort = new AbortController();
    setCtrl(abort);
    const state: ScriptScan = { ...NO_SCAN, total: own.length, skipped: data.scripts.length - own.length, running: own.length > 0 };
    setScan({ ...state });
    let budget = SCRIPT_BUDGET;
    pool(own, 4, abort.signal, async (url) => {
      if (budget <= 0) {
        state.capped++;
        state.done++;
        setScan({ ...state });
        return;
      }
      try {
        const r = await fetchCapped(url, budget, abort.signal, { credentials: "include" });
        budget -= r.size;
        state.bytes += r.size;
        if (r.truncated) state.capped++;
        if (r.status < 400) {
          const source: SecretSource = { kind: "script", label: pathOf(url), url, text: r.text };
          state.findings = mergeFindings(state.findings, scanSecrets([source]));
        } else state.failed++;
      } catch {
        if (!abort.signal.aborted) state.failed++;
      }
      state.done++;
      if (!abort.signal.aborted) setScan({ ...state });
    }).then(() => {
      if (abort.signal.aborted) return;
      state.running = false;
      setScan({ ...state });
      setCtrl(null);
    });
    return () => abort.abort();
  }, [snap.data]);

  const findings = useMemo(() => mergeFindings(pageFindings, scan.findings), [pageFindings, scan.findings]);
  const count = (l: Level) => findings.filter((f) => f.severity === l).length;
  const sources = snap.data?.sources.length ?? 0;
  return (
    <AccessGate>
      <Section
        title="Secrets"
        actions={
          scan.running && ctrl ? (
            <Button
              size="small"
              onClick={() => {
                ctrl.abort();
                setScan({ ...scan, running: false });
              }}
            >
              Stop
            </Button>
          ) : (
            <Button size="small" onClick={snap.run}>
              Rescan
            </Button>
          )
        }
        hint="Pattern matching over what this page ships and keeps: inline scripts and JSON blobs, this origin's scripts, HTML comments, meta tags, data attributes, config globals, Web Storage and readable cookies. A finding is a lead to verify, not proof."
      >
        <ErrorText error={snap.error} />
        {snap.data ? (
          <>
            <div className="grid2">
              <Metric label="Likely leaks" value={count("bad")} level={count("bad") ? "bad" : "good"} />
              <Metric label="To check" value={count("warn")} level={count("warn") ? "warn" : undefined} />
              <Metric label="Public by design" value={count("info")} />
              <Metric
                label="Scanned"
                value={
                  <span className="small">
                    {plural(sources, "source")} · {scan.done}/{plural(scan.total, "script")}
                  </span>
                }
              />
            </div>
            <p className="small muted" style={{ margin: 0 }} aria-live="polite">
              {scan.running
                ? `Fetching this origin's scripts: ${scan.done}/${scan.total} · ${bytes(scan.bytes)}…`
                : `Scripts: ${bytes(scan.bytes)} read`}
              {scan.capped ? ` · ${scan.capped} cut at the ${bytes(SCRIPT_BUDGET)} budget` : ""}
              {scan.failed ? ` · ${scan.failed} failed` : ""}
              {scan.skipped ? ` · ${plural(scan.skipped, "third-party script")} not fetched` : ""}
            </p>
            {findings.length ? (
              <ul className="list">
                {findings.map((f) => (
                  <SecretItem key={f.key} f={f} />
                ))}
              </ul>
            ) : scan.running ? (
              <Empty>Nothing yet…</Empty>
            ) : (
              <Notice kind="good">No credential pattern found.</Notice>
            )}
          </>
        ) : (
          <Empty>{snap.loading ? "Reading the page…" : ""}</Empty>
        )}
      </Section>
      <details>
        <summary className="small muted">What is looked for</summary>
        <ul className="list small">
          {SECRET_RULES.map((r) => (
            <li key={r.title} className="row">
              <Dot level={r.severity} /> {r.title}
            </li>
          ))}
          <li className="row">
            <Dot level="info" /> Firebase web config, Supabase anon key, JWTs in storage (shown as public by design or your own session)
          </li>
        </ul>
        <p className="small muted">
          Values are masked until you reveal them. Placeholders, hex digests and low-entropy values are skipped to keep false positives
          down; generic “secret = …” matches are marked heuristic.
        </p>
      </details>
    </AccessGate>
  );
}

/* Source maps & exposed files */

interface MapCheck {
  file: string;
  kind: "script" | "stylesheet";
  map: string | null;
  via: "comment" | "header" | null;
  state: "pending" | "none" | "inline" | "reachable" | "unreachable" | "error";
  status?: number;
  size?: number;
  sources?: boolean;
}

const MAP_LEVEL: Record<MapCheck["state"], Level | null> = {
  pending: null,
  none: "good",
  inline: "warn",
  reachable: "warn",
  unreachable: "good",
  error: "info",
};

function mapDetail(m: MapCheck): string {
  switch (m.state) {
    case "pending":
      return "Checking…";
    case "none":
      return "No source map reference";
    case "inline":
      return "Inline source map (data: URL): the map ships inside the file";
    case "reachable":
      return `Map reachable${m.size ? ` · ${bytes(m.size)}` : ""}${m.sources ? " · includes the original sources" : ""}`;
    case "unreachable":
      return `Referenced but not served (HTTP ${m.status})`;
    default:
      return "Could not fetch";
  }
}

const PROBE_LABEL: Record<ProbeVerdict["state"], string> = {
  exposed: "exposed",
  present: "present",
  fallback: "fallback",
  unverified: "unverified",
  blocked: "denied",
  absent: "not served",
  error: "error",
};

export function Exposed() {
  const page = usePage();
  const surface = useInPage(collectSurface);
  const [maps, setMaps] = useState<MapCheck[]>([]);
  const [probes, setProbes] = useState<(ProbeVerdict | null)[] | null>(null);
  const [probing, setProbing] = useState<AbortController | null>(null);
  const [baseline, setBaseline] = useState<string>("");

  useEffect(() => {
    const snap = surface.data;
    if (!snap || !page.origin) return;
    const pageSite = siteOf(new URL(page.origin).hostname);
    const allowed = (u: string) => {
      try {
        const o = new URL(u);
        return o.origin === page.origin || (page.access === "all" && /^https?:$/.test(o.protocol) && siteOf(o.hostname) === pageSite);
      } catch {
        return false;
      }
    };
    const scripts = new Set([...snap.scripts.map((s) => s.src), ...snap.resources.filter((r) => r.type === "script").map((r) => r.name)]);
    const styles = new Set([
      ...snap.styles.map((s) => s.href),
      ...snap.resources.filter((r) => /\.css(\?|$)/.test(pathOf(r.name))).map((r) => r.name),
    ]);
    const files: { file: string; kind: MapCheck["kind"] }[] = [
      ...[...scripts].filter(allowed).map((file) => ({ file, kind: "script" as const })),
      ...[...styles].filter((u) => !scripts.has(u) && allowed(u)).map((file) => ({ file, kind: "stylesheet" as const })),
    ].slice(0, 80);
    const state: MapCheck[] = files.map((f) => ({ ...f, map: null, via: null, state: "pending" }));
    setMaps([...state]);
    const abort = new AbortController();
    pool(state, 4, abort.signal, async (m, i) => {
      try {
        const r = await fetchCapped(m.file, 4 * MB, abort.signal, { credentials: "include" });
        const header = r.headers.sourcemap ?? r.headers["x-sourcemap"];
        const ref = header ?? findSourceMapUrl(r.text);
        const next: MapCheck = { ...m, via: header ? "header" : ref ? "comment" : null, map: ref ? new URL(ref, r.url).href : null };
        if (!ref) next.state = "none";
        else if (ref.startsWith("data:")) next.state = "inline";
        else {
          const map = await fetchCapped(next.map!, 256 * 1024, abort.signal);
          const ok = map.status < 400 && isSourceMap(map.text);
          next.state = ok ? "reachable" : "unreachable";
          next.status = map.status;
          next.size = Number(map.headers["content-length"]) || (map.truncated ? undefined : map.size);
          next.sources = ok && /"sourcesContent"\s*:\s*\[\s*"/.test(map.text);
        }
        state[i] = next;
      } catch {
        if (!abort.signal.aborted) state[i] = { ...m, state: "error" };
      }
      if (!abort.signal.aborted) setMaps([...state]);
    });
    return () => abort.abort();
  }, [surface.data, page.origin, page.access]);

  const probe = async () => {
    if (!page.origin) return;
    const ctrl = new AbortController();
    setProbing(ctrl);
    const results: (ProbeVerdict | null)[] = PROBES.map(() => null);
    setProbes([...results]);
    const read = async (path: string): Promise<ProbeResponse | { error: string }> => {
      try {
        const r = await fetchCapped(`${page.origin}${path}`, 64 * 1024, ctrl.signal);
        return { status: r.status, text: r.text, bytes: r.bytes, type: r.type, url: r.url };
      } catch (e) {
        return { error: e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e) };
      }
    };
    const path = baselinePath();
    const base = await read(path);
    const baseResponse = "error" in base ? null : base;
    setBaseline(baseResponse ? `Unknown path ${path} answered HTTP ${baseResponse.status} (${bytes(baseResponse.text.length)}).` : "");
    await pool(PROBES, 3, ctrl.signal, async (p, i) => {
      results[i] = judgeProbe(p, await read(p.path), baseResponse);
      if (!ctrl.signal.aborted) setProbes([...results]);
    });
    setProbing(null);
  };

  const referenced = maps.filter((m) => m.map);
  const exposedMaps = maps.filter((m) => m.state === "reachable" || m.state === "inline");
  const exposedFiles = probes?.filter((p) => p?.state === "exposed").length ?? 0;
  return (
    <AccessGate>
      <Section
        title="Source maps"
        actions={
          <Button size="small" onClick={surface.run}>
            Recheck
          </Button>
        }
        hint={`This origin's scripts and stylesheets${page.access === "all" ? " (and the rest of its site)" : ""}: a reachable map lets anyone read the original source. Fine on purpose for open source; worth a look for an app.`}
      >
        <ErrorText error={surface.error} />
        {maps.length ? (
          <>
            <div className="small" aria-live="polite">
              {maps.filter((m) => m.state !== "pending").length}/{plural(maps.length, "file")} checked · {referenced.length} reference a map
              · <b className={exposedMaps.length ? "t-warn" : "t-good"}>{exposedMaps.length} exposed</b>
            </div>
            <ul className="checks">
              {[...maps]
                .sort((a, b) => Number(Boolean(b.map)) - Number(Boolean(a.map)))
                .map((m) => (
                  <li key={m.file}>
                    {MAP_LEVEL[m.state] ? <Dot level={MAP_LEVEL[m.state]!} /> : <span />}
                    <span className="label mono small ellipsis" title={m.file}>
                      {pathOf(m.file)}
                    </span>
                    <span className="detail small">
                      {m.kind} · {mapDetail(m)}
                      {m.map && !m.map.startsWith("data:") ? (
                        <>
                          {" "}
                          ·{" "}
                          <a href={m.map} target="_blank" rel="noreferrer" className="mono">
                            {pathOf(m.map)}
                          </a>
                          {m.via === "header" ? " (SourceMap header)" : ""}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        ) : (
          <Empty>{surface.loading ? "Reading the page…" : "No script or stylesheet from this origin."}</Empty>
        )}
      </Section>
      <Section
        title="Exposed files"
        actions={
          probing ? (
            <Button size="small" onClick={() => probing.abort()}>
              Stop
            </Button>
          ) : (
            <Button size="small" variant="primary" disabled={!page.origin} onClick={probe}>
              Probe {PROBES.length} paths
            </Button>
          )
        }
        hint={`Requests go to ${page.origin ?? "this origin"} only, 3 at a time, without cookies, no retries. A random path is fetched first so fallback pages (SPAs answering 200 everywhere) are not reported, and each file's content is checked.`}
      >
        <Notice kind="warn">Only run this on sites you own or are allowed to test.</Notice>
        {probes ? (
          <>
            <div className="small" aria-live="polite">
              {probes.filter(Boolean).length}/{PROBES.length} probed ·{" "}
              <b className={exposedFiles ? "t-bad" : "t-good"}>{exposedFiles} exposed</b>
              {baseline ? <span className="muted"> · {baseline}</span> : null}
            </div>
            <ul className="checks">
              {PROBES.map((p, i) => {
                const v = probes[i];
                return (
                  <li key={p.path}>
                    {v ? <Dot level={v.level} /> : <span />}
                    <span className="label mono small">
                      {v?.state === "exposed" || v?.state === "present" ? (
                        <a href={`${page.origin}${p.path}`} target="_blank" rel="noreferrer">
                          {p.path}
                        </a>
                      ) : (
                        p.path
                      )}{" "}
                      {v ? (
                        <span className={`pill${v.level === "bad" ? " t-bad" : v.level === "warn" ? " t-warn" : ""}`}>
                          {PROBE_LABEL[v.state]}
                        </span>
                      ) : null}
                    </span>
                    <span className="detail small">{v ? v.detail : "…"}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <ul className="list small">
            {PROBES.map((p) => (
              <li key={p.path}>
                <span className="mono">{p.path}</span> <span className="muted">{p.why}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AccessGate>
  );
}

/* Third parties & SRI */

const TYPE_LABEL: Record<string, string> = { xmlhttprequest: "xhr", img: "image", css: "css-loaded", link: "link", other: "other" };

export function ThirdParties() {
  const surface = useInPage(collectSurface);
  const snap = surface.data;
  const groups = useMemo(() => (snap ? groupBySite(snap) : []), [snap]);
  const findings = useMemo(() => (snap ? surfaceFindings(snap) : []), [snap]);
  const third = groups.filter((g) => !g.firstParty);
  const totalBytes = groups.reduce((s, g) => s + g.bytes, 0);
  const thirdBytes = third.reduce((s, g) => s + g.bytes, 0);
  const maxBytes = Math.max(1, ...groups.map((g) => g.bytes));
  return (
    <AccessGate>
      <ErrorText error={surface.error} />
      {snap ? (
        <>
          <Section
            title={`Sites (${groups.length})`}
            actions={
              <Button size="small" onClick={surface.run}>
                Refresh
              </Button>
            }
            hint="From resource timing since the page loaded, grouped by approximate registrable domain (a built-in list of common suffixes such as co.uk, not the full Public Suffix List). Cross-origin servers without Timing-Allow-Origin report no size."
          >
            <div className="grid2">
              <Metric label="Third-party sites" value={third.length} />
              <Metric label="Third-party requests" value={third.reduce((s, g) => s + g.requests, 0)} />
              <Metric label="Third-party bytes" value={totalBytes ? `${Math.round((thirdBytes / totalBytes) * 100)}%` : "–"} />
              <Metric label="Total transferred" value={bytes(totalBytes)} />
            </div>
            {groups.length ? (
              <ul className="list sites">
                {groups.map((g) => (
                  <li key={g.site}>
                    <div className="row">
                      <b className="mono grow ellipsis" title={g.hosts.join("\n")}>
                        {g.site}
                      </b>
                      {g.firstParty ? <span className="pill accent">this site</span> : null}
                      <span className="small">
                        {plural(g.requests, "request")} · {bytes(g.bytes)}
                        {g.hiddenSize ? <span className="muted"> (+{g.hiddenSize} unsized)</span> : null}
                      </span>
                    </div>
                    <div className="meter" role="img" aria-label={`${Math.round((g.bytes / Math.max(1, totalBytes)) * 100)}% of bytes`}>
                      <div className={`bar${g.firstParty ? "" : " third"}`} style={{ width: `${(g.bytes / maxBytes) * 100}%` }} />
                    </div>
                    <div className="small muted">
                      {Object.entries(g.types)
                        .sort((a, b) => b[1] - a[1])
                        .map(([t, n]) => `${TYPE_LABEL[t] ?? t} ${n}`)
                        .join(" · ")}
                      {g.hosts.length > 1 || g.hosts[0] !== g.site
                        ? ` — ${g.hosts.slice(0, 3).join(", ")}${g.hosts.length > 3 ? "…" : ""}`
                        : ""}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No resource entry yet.</Empty>
            )}
          </Section>
          <Section
            title={`Checks (${findings.length})`}
            hint="Cross-origin <script> and stylesheet tags without integrity, integrity without crossorigin, preload mismatches, mixed content and cross-origin iframes without sandbox."
          >
            {findings.length ? (
              <ul className="checks">
                {findings.slice(0, 200).map((f) => (
                  <li key={f.id}>
                    <Dot level={f.level} />
                    <span className="label">{f.title}</span>
                    <span className="detail small">
                      {f.url ? (
                        <a href={f.url} target="_blank" rel="noreferrer" className="mono break">
                          {f.url}
                        </a>
                      ) : null}
                      <div className="muted">{f.detail}</div>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Notice kind="good">Nothing to report.</Notice>
            )}
            <div className="small muted">
              {snap.scripts.length} external scripts, {snap.styles.length} stylesheets, {snap.iframes.length} iframes on the page.
            </div>
          </Section>
        </>
      ) : (
        <Empty>{surface.loading ? "Reading the page…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

/* CSP */

function FindingLine({ f, named }: { f: CspFinding; named?: boolean }) {
  return (
    <li>
      <Dot level={f.level} />
      <span className="small">
        {named ? <b className="mono">{f.directive}</b> : null} {f.message}
      </span>
    </li>
  );
}

function PolicyView({ policy, findings }: { policy: CspPolicy; findings: CspFinding[] }) {
  const overall = findings.filter((f) => f.directive === "(policy)");
  const missing = findings.filter((f) => f.directive !== "(policy)" && !policy.directives.some((d) => d.name === f.directive));
  const label = policy.source === "meta" ? "<meta http-equiv>" : policy.reportOnly ? "Header, report-only" : "Header, enforced";
  return (
    <div className="stack">
      <div className="row">
        <span className={`pill${policy.reportOnly ? " t-warn" : " accent"}`}>{label}</span>
        <span className="grow" />
        <CopyButton text={policy.raw} label="Copy policy" />
      </div>
      <ul className="csp">
        {overall.length ? (
          <li>
            <ul className="csp-findings">
              {overall.map((f) => (
                <FindingLine key={f.message} f={f} />
              ))}
            </ul>
          </li>
        ) : null}
        {policy.directives.map((d) => {
          const own = findings.filter((f) => f.directive === d.name);
          return (
            <li key={d.name}>
              <div className="csp-head">
                <b className="mono small">{d.name}</b>
                <span className="mono small csp-values">{d.values.join(" ") || <i className="muted">(no value)</i>}</span>
              </div>
              {own.length ? (
                <ul className="csp-findings">
                  {own.map((f) => (
                    <FindingLine key={f.message} f={f} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
        {missing.length ? (
          <li>
            <div className="csp-head">
              <b className="small">Not set</b>
            </div>
            <ul className="csp-findings">
              {missing.map((f) => (
                <FindingLine key={f.directive + f.message} f={f} named />
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function Csp() {
  const page = usePage();
  const surface = useInPage(collectSurface);
  const headers = useAsync(async () => {
    if (!page.origin) throw new Error("Open a web page.");
    if (!page.canScript) return null;
    return fetchHeaders(page.url);
  }, [page.url, page.canScript]);
  const https = page.url.startsWith("https:");
  const policies = useMemo(() => {
    const h = headers.data?.headers ?? {};
    return [
      ...(h["content-security-policy"] ? parseCsp(h["content-security-policy"], "header", false) : []),
      ...(h["content-security-policy-report-only"] ? parseCsp(h["content-security-policy-report-only"], "header", true) : []),
      ...(surface.data?.metaCsp ?? []).flatMap((m) => parseCsp(m, "meta", false)),
    ];
  }, [headers.data, surface.data]);
  const xfo = headers.data?.headers["x-frame-options"];
  const starter = useMemo(() => (surface.data ? starterCsp(surface.data) : null), [surface.data]);
  const enforced = policies.some((p) => !p.reportOnly);
  return (
    <AccessGate>
      <Section
        title={`Content-Security-Policy (${policies.length})`}
        actions={
          <Button
            size="small"
            onClick={() => {
              headers.run();
              surface.run();
            }}
          >
            Refresh
          </Button>
        }
        hint="From the response headers (the document is fetched again) and <meta http-equiv> tags. Several policies all apply: a load must pass every one."
      >
        <ErrorText error={headers.error ?? surface.error} />
        {headers.loading && !headers.data ? <Empty>Fetching headers…</Empty> : null}
        {headers.data || surface.data ? (
          policies.length ? (
            <>
              {!enforced ? <Notice kind="warn">Only report-only policies: nothing is blocked.</Notice> : null}
              {policies.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: policies keep their order
                <PolicyView key={i} policy={p} findings={analyzeCsp(p, { https, xfo })} />
              ))}
            </>
          ) : (
            <Notice kind="bad">
              No Content-Security-Policy header or meta tag: injected scripts run unrestricted. Start from the policy below.
            </Notice>
          )
        ) : null}
      </Section>
      {starter ? (
        <Section
          title="Starter CSP"
          actions={
            <>
              <CopyButton text={`Content-Security-Policy-Report-Only: ${starter.policy}`} label="Copy header" />
              <CopyButton text={starter.policy} label="Copy value" />
            </>
          }
          hint="A starting point built from the origins this page used so far. Deploy it as Content-Security-Policy-Report-Only, watch the reports while you use the site, then enforce it."
        >
          <pre className="code">{starter.policy.split("; ").join(";\n")}</pre>
          <ul className="list small">
            {starter.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </AccessGate>
  );
}
