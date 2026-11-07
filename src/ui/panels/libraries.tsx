import { useEffect, useMemo, useState } from "react";
import { collectLibrarySignals } from "../../lib/page/libraries";
import {
  type Advisory,
  analyzeLibraries,
  snapshotDetections,
  cveUrl,
  DISCLAIMER,
  type Detection,
  ghsaUrl,
  type LibraryResult,
  libraryMarkdown,
  pageProbes,
  SEVERITY_LEVEL,
  type Severity,
  SOURCE_LABEL,
  scanContent,
  statusCounts,
  type VulnDb,
} from "../../lib/security/libraries";
import { siteOf } from "../../lib/security/third-party";
import { Legend, type Part, SegmentBar, StatusIcon } from "../charts";
import { Button, bytes, CopyButton, Empty, ErrorText, Notice, Section } from "../components";
import { useAsync } from "../hooks";
import { AccessGate, useInPage, usePage } from "../page";
import { fetchCapped, pool } from "./security";

const MB = 1024 * 1024;
const MAX_FILE = 2 * MB;
const BUDGET = 8 * MB;
const MAX_INLINE = 512 * 1024;
const MAX_INLINE_TOTAL = 2 * MB;

let dbLoad: Promise<VulnDb> | null = null;
/** The bundled Retire.js snapshot (public/vuln-db.json), fetched once per page. */
function loadDb(): Promise<VulnDb> {
  dbLoad ??= fetch("/vuln-db.json")
    .then((r) => {
      if (!r.ok) throw new Error(`The vulnerability database did not load (HTTP ${r.status}).`);
      return r.json() as Promise<VulnDb>;
    })
    .catch((e) => {
      dbLoad = null;
      throw e;
    });
  return dbLoad;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const dbDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const SEVERITY_TEXT: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
};

const resultLevel = (r: LibraryResult) =>
  r.status === "vulnerable" && r.severity ? SEVERITY_LEVEL[r.severity] : r.status === "eol" ? "warn" : r.status === "ok" ? "good" : "none";

const STATUS_TEXT = (r: LibraryResult) =>
  r.status === "vulnerable"
    ? `${plural(r.advisories.length, "advisory", "advisories")} · worst ${r.severity}`
    : r.status === "eol"
      ? "End of life"
      : r.status === "ok"
        ? "No known advisory"
        : "Version unknown";

interface Scan {
  detections: Detection[];
  total: number;
  done: number;
  bytes: number;
  capped: number;
  failed: number;
  skipped: number;
  running: boolean;
}

const NO_SCAN: Scan = { detections: [], total: 0, done: 0, bytes: 0, capped: 0, failed: 0, skipped: 0, running: false };

function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span className={`pill sev sev-${severity}`}>
      <span className="viz-key" style={{ background: SEVERITY_COLOR[severity] }} aria-hidden="true" />
      {severity}
    </span>
  );
}

function AdvisoryItem({ a }: { a: Advisory }) {
  const ids: [string, string][] = [
    ...a.cve.map((id) => [id, cveUrl(id)] as [string, string]),
    ...a.ghsa.map((id) => [id, ghsaUrl(id)] as [string, string]),
  ];
  return (
    <li className="lib-adv">
      <div className="lib-adv-head">
        <SeverityPill severity={a.severity} />
        {ids.length ? (
          ids.map(([id, url]) => (
            <a key={id} href={url} target="_blank" rel="noreferrer" className="mono small">
              {id}
            </a>
          ))
        ) : a.info[0] ? (
          <a href={a.info[0]} target="_blank" rel="noreferrer" className="small">
            No CVE · details
          </a>
        ) : (
          <span className="small muted">No CVE</span>
        )}
      </div>
      <div className="small lib-adv-summary" title={a.summary}>
        {a.summary || "No summary in the database."}
      </div>
      <div className="small muted">
        Affects {a.range} · {a.fixedIn ? <>fixed in {a.fixedIn}</> : "no fixed version known"}
      </div>
    </li>
  );
}

function LibraryCard({ r, db, page }: { r: LibraryResult; db: VulnDb; page: string }) {
  const [all, setAll] = useState(false);
  const advisories = all ? r.advisories : r.advisories.slice(0, 4);
  const level = resultLevel(r);
  return (
    <li className={`lib-card lib-${r.status}`}>
      <div className="lib-head">
        <StatusIcon level={level} label={r.status === "vulnerable" ? `Vulnerable, worst ${r.severity}` : STATUS_TEXT(r)} />
        <b className="lib-name">{r.name}</b>
        <span className="mono">{r.version ?? "?"}</span>
        <span className="grow" />
        <span className={`small lib-status t-${level === "none" ? "info" : level}`}>{STATUS_TEXT(r)}</span>
      </div>
      {r.upgrade ? (
        <div className="small lib-upgrade">
          Upgrade to <b className="mono">≥ {r.upgrade}</b>
          {r.upgradeMajor ? <span className="muted"> · a new major version, check its migration guide</span> : null}
        </div>
      ) : r.status === "vulnerable" || r.status === "eol" ? (
        <div className="small lib-upgrade">No release in the database is free of these issues: plan a replacement.</div>
      ) : null}
      {r.eol ? (
        <p className="small lib-eol">
          <b>{r.eol.kind === "eol" ? "End of life." : "Maintenance mode."}</b> {r.eol.text}
        </p>
      ) : null}
      <ul className="lib-where" aria-label="Where it was found">
        {r.sources.map((s) => (
          <li key={`${s.kind} ${s.where}`} className="small">
            <span className="muted">{SOURCE_LABEL[s.kind]}</span>{" "}
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="mono ellipsis" title={s.url}>
                {s.kind === "uri" ? s.url.replace(/^https?:\/\//, "") : pathOf(s.url)}
              </a>
            ) : (
              <span className="mono ellipsis" title={s.where}>
                {s.where}
              </span>
            )}
          </li>
        ))}
      </ul>
      {advisories.length ? (
        <ul className="lib-advs" aria-label={`Advisories for ${r.name} ${r.version}`}>
          {advisories.map((a) => (
            <AdvisoryItem key={a.key} a={a} />
          ))}
        </ul>
      ) : null}
      {r.advisories.length > 4 || r.status !== "ok" ? (
        <div className="row">
          {r.advisories.length > 4 ? (
            <Button size="small" variant="ghost" onClick={() => setAll(!all)} aria-expanded={all}>
              {all ? "Fewer advisories" : `${plural(r.advisories.length - 4, "more advisory", "more advisories")}`}
            </Button>
          ) : null}
          <span className="grow" />
          {r.status !== "ok" ? <CopyButton text={libraryMarkdown(r, { page, source: db.source })} label="Copy for agent" /> : null}
        </div>
      ) : null}
    </li>
  );
}

function Summary({ results }: { results: LibraryResult[] }) {
  const c = statusCounts(results);
  const vulnerable = c.critical + c.high + c.medium + c.low;
  const parts: Part[] = [
    ...(["critical", "high", "medium", "low"] as const).map((s) => ({
      key: s,
      label: SEVERITY_TEXT[s],
      value: c[s],
      color: SEVERITY_COLOR[s],
      detail: c[s],
    })),
    { key: "eol", label: "End of life", value: c.eol, color: "var(--warn)", detail: c.eol },
    { key: "ok", label: "No known advisory", value: c.ok, color: "var(--good)", detail: c.ok },
    { key: "unknown", label: "Version unknown", value: c.unknown, color: "var(--viz-other)", detail: c.unknown },
  ];
  const worst = c.critical || c.high ? "bad" : c.medium ? "warn" : vulnerable ? "info" : "good";
  return (
    <div className="stack lib-summary">
      <div>
        <b className={`lib-count t-${worst}`}>{plural(vulnerable, "vulnerable library", "vulnerable libraries")}</b>
        <span className="muted"> of {results.length} found</span>
      </div>
      <SegmentBar
        tall
        parts={parts}
        label={`${results.length} libraries: ${parts
          .filter((p) => p.value)
          .map((p) => `${p.value} ${p.label.toLowerCase()}`)
          .join(", ")}`}
      />
      <Legend parts={parts.filter((p) => p.value > 0)} />
    </div>
  );
}

export function VulnerableLibraries() {
  const page = usePage();
  const db = useAsync(loadDb, []);
  const probes = useMemo(() => (db.data ? pageProbes(db.data) : []), [db.data]);
  const snap = useInPage(collectLibrarySignals, [probes, MAX_INLINE, MAX_INLINE_TOTAL], "MAIN", Boolean(db.data));
  const [scan, setScan] = useState<Scan>(NO_SCAN);
  const [ctrl, setCtrl] = useState<AbortController | null>(null);

  // What the page itself tells: globals, script URLs, inline scripts.
  const pageDetections = useMemo(() => {
    const data = snap.data;
    if (!data || !db.data) return [];
    return snapshotDetections(data, db.data);
  }, [snap.data, db.data]);

  // This site's script files, fetched within a budget, for banners and version constants.
  useEffect(() => {
    const data = snap.data;
    const base = db.data;
    if (!data || !base) return;
    const pageSite = siteOf(new URL(data.origin).hostname);
    const own = (u: string) => {
      try {
        const o = new URL(u);
        return o.origin === data.origin || (page.access === "all" && siteOf(o.hostname) === pageSite);
      } catch {
        return false;
      }
    };
    const files = data.scripts.filter(own);
    const abort = new AbortController();
    setCtrl(abort);
    const state: Scan = { ...NO_SCAN, total: files.length, skipped: data.scripts.length - files.length, running: files.length > 0 };
    setScan({ ...state });
    let budget = BUDGET;
    pool(files, 4, abort.signal, async (url) => {
      if (budget <= 0) {
        state.capped++;
        state.done++;
        setScan({ ...state });
        return;
      }
      try {
        const r = await fetchCapped(url, Math.min(MAX_FILE, budget), abort.signal, { credentials: "include" });
        budget -= r.size;
        state.bytes += r.size;
        if (r.truncated) state.capped++;
        if (r.status < 400) state.detections = [...state.detections, ...scanContent(r.text, pathOf(url), base, url)];
        else state.failed++;
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
  }, [snap.data, db.data, page.access]);

  const results = useMemo(
    () => (db.data && snap.data ? analyzeLibraries([...pageDetections, ...scan.detections], db.data, snap.data.present) : []),
    [db.data, snap.data, pageDetections, scan.detections],
  );
  const flagged = results.filter((r) => r.status === "vulnerable" || r.status === "eol");
  const source = db.data?.source;
  const ageDays = source ? (Date.now() - Date.parse(`${source.date}T00:00:00Z`)) / 86_400_000 : 0;
  const data = snap.data;

  return (
    <AccessGate>
      <Section
        title="Vulnerable libraries"
        actions={
          <>
            {flagged.length > 1 && db.data ? (
              <CopyButton
                text={flagged.map((r) => libraryMarkdown(r, { page: page.url, source: db.data!.source })).join("\n\n")}
                label="Copy all for agent"
              />
            ) : null}
            {scan.running && ctrl ? (
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
              <Button size="small" onClick={snap.run} disabled={!db.data}>
                Rescan
              </Button>
            )}
          </>
        }
        hint="Versions read from page globals, script URLs and file names, and the banners of this site's scripts, matched against the Retire.js database bundled with devkit. Nothing is sent anywhere."
      >
        <ErrorText error={db.error ?? snap.error} />
        {data && db.data ? (
          <>
            {results.length ? <Summary results={results} /> : null}
            <p className="small muted" style={{ margin: 0 }} aria-live="polite">
              {scan.running
                ? `Reading this site's scripts: ${scan.done}/${scan.total} · ${bytes(scan.bytes)}…`
                : `${plural(data.scripts.length, "script URL")} · ${plural(scan.done - scan.failed, "file")} read (${bytes(scan.bytes)})`}
              {data.inline.length ? ` · ${plural(data.inline.length, "inline script")}` : ""}
              {scan.capped ? ` · ${scan.capped} cut at the ${bytes(BUDGET)} budget` : ""}
              {scan.failed ? ` · ${scan.failed} failed` : ""}
              {scan.skipped ? ` · ${plural(scan.skipped, "third-party script")} matched by URL only` : ""}
            </p>
            <Notice kind="info">{DISCLAIMER}</Notice>
            {results.length ? (
              <ul className="lib-list">
                {results.map((r) => (
                  <LibraryCard key={r.key} r={r} db={db.data!} page={page.url} />
                ))}
              </ul>
            ) : scan.running ? (
              <Empty>Nothing yet…</Empty>
            ) : (
              <Notice kind="good">
                No library from the database found. Libraries bundled into the app's own code without their banner (most npm builds) cannot
                be seen this way: check the project's lockfile with npm audit.
              </Notice>
            )}
          </>
        ) : (
          <Empty>{db.loading || snap.loading ? "Reading the page…" : ""}</Empty>
        )}
        {source ? (
          <p className="small muted lib-db" style={{ margin: 0 }}>
            Database from{" "}
            <a href={`${source.url}/tree/${source.commit}/${source.file}`} target="_blank" rel="noreferrer">
              Retire.js
            </a>
            , {dbDate(source.date)} · {plural(Object.keys(db.data!.libraries).length, "library", "libraries")} ·{" "}
            <a href="/vuln-db.LICENSE.txt" target="_blank" rel="noreferrer">
              {source.license}
            </a>
            {ageDays > 180 ? (
              <span className="t-warn"> · {Math.floor(ageDays / 30)} months old: update devkit for newer advisories</span>
            ) : null}
          </p>
        ) : null}
      </Section>
    </AccessGate>
  );
}
