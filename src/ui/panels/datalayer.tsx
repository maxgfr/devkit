// Inspect › dataLayer: the page's dataLayer read once (read-only, MAIN world), its GA4 events, gtag commands and
// Consent Mode steps, the problems found in them, and masked snapshots to compare two reads.
import { useMemo, useState } from "react";
import { dataLayerMarkdown } from "../../lib/agent/inspect";
import {
  addSnapshot,
  analyzeDataLayer,
  compareSnapshots,
  type DataLayerAnalysis,
  type DataLayerIssue,
  type DataLayerSavedSnapshot,
  dataLayerReport,
  entryPath,
  eventMatches,
  issuesByEvent,
  type LayerEvent,
  makeSnapshot,
  normalizeEvents,
  paramsPreview,
  SNAPSHOT_LIMIT,
  type SnapshotDiff,
  SNAPSHOTS_KEY,
} from "../../lib/datalayer";
import { readDataLayer } from "../../lib/page/datalayer";
import { originOf } from "../../lib/tab";
import { StatusIcon } from "../charts";
import { Button, Checks, Code, CopyButton, Empty, ErrorText, JsonTree, KV, Metric, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
import { AccessGate, useInPage, usePage } from "../page";

const MAX_ROWS = 300;
const CURRENT = "current";

const worst = (issues: DataLayerIssue[] | undefined) =>
  issues?.find((i) => i.level === "bad") ?? issues?.find((i) => i.level === "warn") ?? issues?.find((i) => i.level === "info");

const when = (at: number) =>
  new Date(at).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function DataLayer() {
  const page = usePage();
  const toast = useToast();
  const read = useInPage(readDataLayer, [], "MAIN");
  const snap = read.data;
  const analysis = useMemo(() => (snap ? analyzeDataLayer(snap) : null), [snap]);
  const [json, setJson] = useState(false);
  const [snapshots, setSnapshots] = useStored<DataLayerSavedSnapshot[]>(SNAPSHOTS_KEY, []);
  const report = useMemo(() => (analysis ? dataLayerReport(analysis) : ""), [analysis]);
  const agentMd = useMemo(() => (analysis ? dataLayerMarkdown(analysis, { url: analysis.url }) : ""), [analysis]);
  const found = Boolean(analysis?.layers.length);

  const save = async () => {
    if (!snap || !analysis) return;
    try {
      await setSnapshots(addSnapshot(snapshots, makeSnapshot(snap, analysis)));
      toast(`Snapshot saved (${Math.min(snapshots.length + 1, SNAPSHOT_LIMIT)}/${SNAPSHOT_LIMIT}), personal data masked.`);
    } catch (e) {
      toast(`Could not save the snapshot: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  return (
    <AccessGate>
      <ErrorText error={read.error} />
      {analysis ? (
        <>
          <Section
            title="dataLayer"
            actions={
              <>
                <Button size="small" onClick={read.run} busy={read.loading}>
                  Read again
                </Button>
                <Button size="small" onClick={save} disabled={!found}>
                  Save snapshot
                </Button>
                <Button
                  size="small"
                  variant={json ? "primary" : undefined}
                  aria-pressed={json}
                  onClick={() => setJson((j) => !j)}
                  disabled={!found}
                >
                  JSON view
                </Button>
                <CopyButton text={report} label="Copy report" />
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            }
          >
            {found ? <Counters a={analysis} /> : <Empty>No dataLayer found on this page.</Empty>}
            <p className="muted small dl-note">
              The dataLayer holds the whole page load, so everything pushed up to now is here — events fired later appear after Read again.
              Read-only: devkit never wraps dataLayer.push and changes nothing in the page. Personal data is always masked.
            </p>
            {analysis.truncated ? (
              <Notice kind="warn">The dataLayer is very large: devkit copied about 1 MB of it and left the rest out.</Notice>
            ) : null}
          </Section>
          {found && json ? (
            <Section
              title="JSON (masked)"
              hint="E-mails, phone numbers, IBANs and card numbers are masked here too; there is no way to reveal them."
            >
              <Code
                text={JSON.stringify(Object.fromEntries(analysis.layers.map((l) => [l.name, l.entries.map((e) => e.value)])), null, 2)}
                maxHeight={560}
              />
            </Section>
          ) : null}
          {found && !json ? (
            <>
              <Section title={`Issues (${analysis.issues.length})`}>
                {analysis.issues.length ? (
                  <Checks
                    checks={analysis.issues.map((i, n) => ({
                      id: `${i.id}-${n}`,
                      label: i.label,
                      level: i.level,
                      detail: i.path ? `${i.path} · ${i.detail}` : i.detail,
                    }))}
                  />
                ) : (
                  <Empty>No problem found in the GA4 events, Consent Mode or the data.</Empty>
                )}
              </Section>
              <Containers a={analysis} />
              <Events a={analysis} />
              <Consent a={analysis} />
            </>
          ) : null}
          <Snapshots
            snapshots={snapshots}
            origin={page.origin}
            current={found ? analysis : null}
            onDelete={(id) => setSnapshots(snapshots.filter((s) => s.id !== id))}
          />
        </>
      ) : (
        <Empty>{read.loading ? "Reading the dataLayer…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

function Counters({ a }: { a: DataLayerAnalysis }) {
  const c = a.counts;
  return (
    <div className="grid2 dl-counters">
      <Metric label="Issues" value={c.issues} level={c.problems ? "bad" : c.warnings ? "warn" : "good"} />
      <Metric label="Events" value={c.events} />
      <Metric label="Unique events" value={c.unique} />
      <Metric label="Layers" value={c.layers} />
      <Metric label="Consent" value={c.consent} />
      <Metric label="Containers" value={c.containers} />
    </div>
  );
}

function Containers({ a }: { a: DataLayerAnalysis }) {
  const rows: [string, string][] = [
    ...a.containers.map((k): [string, string] => [k.id, `${k.kind}${k.layer ? ` · reads ${k.layer}` : ""} · ${k.sources.join(", ")}`]),
    ...a.layers.map((l): [string, string] => [l.name, `${l.length} ${l.length === 1 ? "entry" : "entries"}`]),
  ];
  return (
    <Section title="Containers & layers">
      {a.containers.length ? null : <Empty>No GTM container or Google tag id found.</Empty>}
      <KV rows={rows} />
    </Section>
  );
}

const KIND_LABEL: Partial<Record<LayerEvent["kind"], string>> = {
  consent: "consent",
  config: "config",
  js: "js",
  set: "set",
  get: "get",
  command: "gtag",
  data: "data",
};

function EventRow({ e, issues }: { e: LayerEvent; issues?: DataLayerIssue[] }) {
  const issue = worst(issues);
  const preview = paramsPreview(e);
  return (
    <li>
      <details className="dl-event">
        <summary>
          <span className="dl-idx viz-num">{e.index}</span>
          {issue ? <StatusIcon level={issue.level} label={issue.label} /> : null}
          <b className="dl-name">{e.name}</b>
          {e.gtag && e.kind === "event" ? <span className="pill">gtag</span> : null}
          {KIND_LABEL[e.kind] ? <span className="pill">{KIND_LABEL[e.kind]}</span> : null}
          {e.layer !== "dataLayer" ? <span className="pill accent">{e.layer}</span> : null}
          {preview ? <span className="dl-preview muted small">{preview}</span> : null}
        </summary>
        <div className="dl-body">
          {issues?.length ? (
            <ul className="dl-event-issues small">
              {issues.map((i, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list
                <li key={n}>
                  <StatusIcon level={i.level} label={i.label} /> {i.label}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="tree">
            <JsonTree value={e.value} name={entryPath(e.layer, e.index)} open={3} />
          </div>
        </div>
      </details>
    </li>
  );
}

function Events({ a }: { a: DataLayerAnalysis }) {
  const [query, setQuery] = useState("");
  const [internals, setInternals] = useState(true);
  const byEvent = useMemo(() => issuesByEvent(a.issues), [a.issues]);
  const list = useMemo(
    () => a.events.filter((e) => (internals || !e.name.startsWith("gtm.")) && eventMatches(e, query)),
    [a.events, query, internals],
  );
  return (
    <Section
      title={`Events (${a.counts.events})`}
      actions={
        <label className="check small">
          <input type="checkbox" checked={internals} onChange={(e) => setInternals(e.target.checked)} />
          gtm.* events
        </label>
      }
      hint={`Every entry of the dataLayer, in push order (${a.counts.layers}). Click one to see what was pushed.`}
    >
      <input
        type="search"
        placeholder="Filter by event or parameter"
        aria-label="Filter events"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {list.length ? (
        <ul className="dl-events">
          {list.slice(0, MAX_ROWS).map((e) => (
            <EventRow key={e.seq} e={e} issues={byEvent.get(e.seq)} />
          ))}
        </ul>
      ) : (
        <Empty>No entry matches.</Empty>
      )}
      {list.length > MAX_ROWS ? (
        <p className="muted small">
          First {MAX_ROWS} of {list.length}: filter to narrow down.
        </p>
      ) : null}
    </Section>
  );
}

function Consent({ a }: { a: DataLayerAnalysis }) {
  return (
    <Section title={`Consent timeline (${a.consent.length})`} hint="gtag('consent', …) commands in the order the page sent them.">
      {a.consent.length ? (
        <ol className="dl-consent">
          {a.consent.map((s) => (
            <li key={s.seq}>
              <span className="dl-idx viz-num">{s.index}</span>
              <b>{s.command || "(no command)"}</b>
              {Object.entries(s.states).map(([k, v]) => (
                <span key={k} className={`pill${v === "granted" || v === "denied" ? "" : " t-bad"}`}>
                  {k}: {v}
                </span>
              ))}
              {s.waitForUpdate !== undefined ? <span className="pill">wait_for_update: {s.waitForUpdate} ms</span> : null}
              {s.region ? <span className="pill">region: {s.region.join(", ")}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <Empty>No Consent Mode command in the dataLayer.</Empty>
      )}
    </Section>
  );
}

function Snapshots({
  snapshots,
  origin,
  current,
  onDelete,
}: {
  snapshots: DataLayerSavedSnapshot[];
  origin: string | null;
  current: DataLayerAnalysis | null;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [allSites, setAllSites] = useState(false);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState(CURRENT);
  const shown = snapshots.filter(
    (s) =>
      (allSites || originOf(s.url) === origin) &&
      (!query.trim() || `${s.url} ${s.title}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const eventsOf = (id: string): LayerEvent[] | null => {
    if (id === CURRENT) return current ? current.events : null;
    const s = snapshots.find((x) => x.id === id);
    return s ? normalizeEvents(s.layers) : null;
  };
  const a = before ? eventsOf(before) : null;
  const b = eventsOf(after);
  const diff = a && b && before !== after ? compareSnapshots(a, b) : null;
  const label = (s: DataLayerSavedSnapshot) => `${when(s.at)} · ${s.events} events · ${s.url.replace(/^https?:\/\//, "").slice(0, 50)}`;
  return (
    <Section
      title={`Snapshots (${snapshots.length}/${SNAPSHOT_LIMIT})`}
      actions={
        <label className="check small">
          <input type="checkbox" checked={allSites} onChange={(e) => setAllSites(e.target.checked)} />
          All sites
        </label>
      }
      hint={`Kept masked on this device (browser storage), the ${SNAPSHOT_LIMIT} most recent across sites. Compare two of them, or one with the current read.`}
    >
      {snapshots.length > 3 ? (
        <input
          type="search"
          placeholder="Filter by URL or title"
          aria-label="Filter snapshots"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      {shown.length ? (
        <ul className="list dl-snaps">
          {shown.map((s) => (
            <li key={s.id} className="row">
              <span className="grow">
                <b>{when(s.at)}</b> <span className="muted small">{s.url}</span>
                <span className="small muted">
                  {" "}
                  · {s.events} events · {s.issues} issues{s.truncated ? " · trimmed" : ""}
                </span>
              </span>
              <Button
                size="small"
                onClick={() => {
                  setBefore(s.id);
                  setAfter(CURRENT);
                }}
                disabled={!current}
              >
                Compare with current
              </Button>
              <Button size="small" variant="ghost" onClick={() => onDelete(s.id)} aria-label={`Delete the snapshot of ${when(s.at)}`}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{snapshots.length ? "No snapshot matches." : "No snapshot yet: Save snapshot keeps the current read."}</Empty>
      )}
      {snapshots.length ? (
        <div className="row dl-compare">
          <label className="small muted" htmlFor="dl-before">
            Compare
          </label>
          <select id="dl-before" value={before} onChange={(e) => setBefore(e.target.value)}>
            <option value="">Pick a snapshot…</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
          </select>
          <label className="small muted" htmlFor="dl-after">
            with
          </label>
          <select id="dl-after" value={after} onChange={(e) => setAfter(e.target.value)}>
            <option value={CURRENT}>The current read</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {diff ? <Diff diff={diff} /> : null}
    </Section>
  );
}

function DiffGroup({ title, events, kind }: { title: string; events: LayerEvent[]; kind: string }) {
  if (!events.length) return null;
  return (
    <div className="dl-diff-group">
      <h3 className={`dl-diff-title ${kind}`}>
        {title} ({events.length})
      </h3>
      <ul className="dl-diff-list">
        {events.slice(0, 100).map((e) => (
          <li key={e.seq}>
            <span className="dl-idx viz-num">{e.index}</span> <b>{e.name}</b> <span className="muted small">{paramsPreview(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Diff({ diff }: { diff: SnapshotDiff }) {
  const none = !diff.added.length && !diff.removed.length && !diff.duplicated.length && !diff.changed.length;
  return (
    <div className="dl-diff" aria-live="polite">
      <p className="small">
        <b>{diff.added.length}</b> added · <b>{diff.removed.length}</b> removed · <b>{diff.duplicated.length}</b> duplicated ·{" "}
        <b>{diff.changed.length}</b> changed · {diff.unchanged} unchanged
      </p>
      {none ? <Empty>The two reads hold the same events.</Empty> : null}
      <DiffGroup title="Added" events={diff.added} kind="t-good" />
      <DiffGroup title="Removed" events={diff.removed} kind="t-bad" />
      <DiffGroup title="Duplicated" events={diff.duplicated} kind="t-warn" />
      {diff.changed.length ? (
        <div className="dl-diff-group">
          <h3 className="dl-diff-title t-warn">Changed ({diff.changed.length})</h3>
          <ul className="dl-diff-list">
            {diff.changed.slice(0, 100).map((c) => (
              <li key={c.after.seq}>
                <span className="dl-idx viz-num">{c.after.index}</span> <b>{c.after.name}</b>
                <ul className="dl-changes small mono">
                  {c.changes.map((ch) => (
                    <li key={ch.path}>
                      {ch.path}: {ch.before ?? "(none)"} → {ch.after ?? "(none)"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
