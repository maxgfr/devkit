// Field data (CrUX) in the Performance panel, and its API key in Options.
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { cruxMarkdown } from "../../lib/agent/crux";
import {
  CRUX_CONSOLE,
  CRUX_KEY_HELP,
  type CruxError,
  type CruxFormFactor,
  type CruxMetric,
  type CruxScope,
  cruxIneligible,
  cruxTrend,
  FORM_FACTOR_TEXT,
  type FetchLike,
  formatPeriod,
  labVsField,
  loadCrux,
  SCOPE_TEXT,
  sparkline,
  testCruxKey,
} from "../../lib/crux";
import { CRUX_KEY_FLAG, loadCruxKey, removeCruxKey, saveCruxKey, sessionCruxCache } from "../../lib/crux-store";
import type { PerfSnapshot } from "../../lib/page/collect";
import { formatVital, msLabel, RATING_LEVEL, RATING_TEXT, rateVital, VITALS, type VitalName, vitalsOf } from "../../lib/viz";
import { type Part, SegmentBar, StatusIcon } from "../charts";
import { Button, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { useAsync, useStored } from "../hooks";
import { usePage } from "../page";

const cruxFetchImpl: FetchLike = (url, init) => fetch(url, init);
const openOptions = () => browser.runtime.openOptionsPage();
const share = (f: number) => `${Math.round(f * 100)}%`;

function Chips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="as-chips" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className="as-chip" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

/** p75 over the history windows: a line per run of known points, the latest one dotted. */
function Sparkline({ name, values, periods }: { name: VitalName; values: (number | null)[]; periods: string[] }) {
  const W = 120;
  const H = 28;
  const runs = sparkline(values, W, H);
  const trend = cruxTrend(values);
  if (!runs.length || !trend) return null;
  const last = runs[runs.length - 1]!.at(-1)!;
  const label = `${VITALS[name].label} p75 over ${values.length} weekly 28-day windows${
    periods[0] ? ` since ${periods[0]}` : ""
  }: from ${formatVital(name, trend.from)} to ${formatVital(name, trend.to)}.`;
  return (
    <svg className="crux-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <title>{label}</title>
      {runs.map((run) =>
        run.length > 1 ? (
          <polyline key={`${run[0]!.x}`} points={run.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" />
        ) : (
          <circle key={`${run[0]!.x}`} cx={run[0]!.x} cy={run[0]!.y} r="1.5" />
        ),
      )}
      <circle className="last" cx={last.x} cy={last.y} r="2.5" />
    </svg>
  );
}

function CruxCard({ m, lab, history, periods }: { m: CruxMetric; lab: number | null; history?: (number | null)[]; periods: string[] }) {
  const t = VITALS[m.name];
  const d = m.distribution;
  const labRating = rateVital(m.name, lab);
  const compare = labVsField(m.name, lab, m.p75);
  const parts: Part[] = d
    ? [
        { key: "good", label: "Good", value: d.good, color: "var(--good)", detail: share(d.good) },
        { key: "ni", label: "Needs improvement", value: d.ni, color: "var(--warn)", detail: share(d.ni) },
        { key: "poor", label: "Poor", value: d.poor, color: "var(--bad)", detail: share(d.poor) },
      ]
    : [];
  return (
    <li className="vital crux-card">
      <div className="vital-head">
        <b>{t.label}</b>
        <span className="vital-name" title={t.name}>
          {t.name}, p75
        </span>
        <span className="vital-value">{formatVital(m.name, m.p75)}</span>
        <span className="vital-rating">
          <StatusIcon level={m.rating ? RATING_LEVEL[m.rating] : "none"} />
          {m.rating ? RATING_TEXT[m.rating] : "No p75"}
        </span>
      </div>
      {d ? (
        <>
          <SegmentBar
            parts={parts}
            label={`${t.label} page loads: ${parts.map((p) => `${p.detail} ${p.label.toLowerCase()}`).join(", ")}`}
          />
          <div className="crux-dist small muted">
            <span>{share(d.good)} good</span> · <span>{share(d.ni)} needs improvement</span> · <span>{share(d.poor)} poor</span>
          </div>
        </>
      ) : null}
      <div className="crux-foot">
        {lab !== null && labRating ? (
          <span className="small muted grow">
            This tab: <span className="viz-num">{formatVital(m.name, lab)}</span> ({RATING_TEXT[labRating].toLowerCase()})
            {compare ? `, ${compare}` : ""}
          </span>
        ) : (
          <span className="small muted grow">Not measured in this tab.</span>
        )}
        {history ? <Sparkline name={m.name} values={history} periods={periods} /> : null}
      </div>
    </li>
  );
}

/** "Field data (CrUX)" section of the Performance panel. `onMarkdown` gets the report lines once data loaded. */
export function CruxField({ lab, onMarkdown }: { lab?: PerfSnapshot; onMarkdown?: (md: string | undefined) => void }) {
  const page = usePage();
  const [hasKey, , ready] = useStored<boolean>(CRUX_KEY_FLAG, false);
  const [scope, setScope] = useState<CruxScope>("url");
  const [formFactor, setFormFactor] = useState<CruxFormFactor>("PHONE");
  const ineligible = page.url ? cruxIneligible(page.url) : "No page open.";
  const crux = useAsync(async () => {
    if (!ready || !hasKey || ineligible) return null;
    const key = await loadCruxKey();
    if (!key) return null;
    return loadCrux(page.url, scope, formFactor, key, cruxFetchImpl, sessionCruxCache);
  }, [ready, hasKey, page.url, scope, formFactor, ineligible]);
  const data = crux.data;
  useEffect(() => onMarkdown?.(data ? cruxMarkdown(data) : undefined), [data, onMarkdown]);
  const labValues = new Map(lab ? vitalsOf(lab).map((v) => [v.name, v.value]) : []);
  const err = crux.error as CruxError | null;
  return (
    <Section
      title="Field data (CrUX)"
      hint="Real Chrome users over the last 28 days, from Google's Chrome UX Report: the 75th percentile and the share of good, needs improvement and poor page loads."
    >
      {!ready ? null : !hasKey ? (
        <Notice>
          <span className="grow">See how real visitors experience this page: add a free Chrome UX Report API key in Options.</span>
          <Button size="small" onClick={openOptions}>
            Open Options
          </Button>
        </Notice>
      ) : ineligible ? (
        <Empty>{ineligible}</Empty>
      ) : (
        <>
          <div className="row crux-controls">
            <Chips
              label="Scope"
              value={scope}
              options={[
                ["url", SCOPE_TEXT.url],
                ["origin", SCOPE_TEXT.origin],
              ]}
              onChange={setScope}
            />
            <Chips
              label="Device"
              value={formFactor}
              options={[
                ["PHONE", FORM_FACTOR_TEXT.PHONE],
                ["DESKTOP", FORM_FACTOR_TEXT.DESKTOP],
                ["ALL", FORM_FACTOR_TEXT.ALL],
              ]}
              onChange={setFormFactor}
            />
          </div>
          {err ? (
            <>
              <ErrorText error={err} />
              {err.kind === "invalid-key" || err.kind === "denied" ? (
                <div className="row">
                  <Button size="small" onClick={openOptions}>
                    Check the key in Options
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          {data ? (
            <>
              {data.fellBack ? <Notice>No field data for this URL, showing the origin ({data.record.target}).</Notice> : null}
              <ul className="vitals crux-metrics">
                {data.record.metrics.map((m) => (
                  <CruxCard
                    key={m.name}
                    m={m}
                    lab={labValues.get(m.name) ?? null}
                    history={data.history?.series[m.name]}
                    periods={data.history?.periods ?? []}
                  />
                ))}
              </ul>
              <div className="small muted">
                {data.record.scope === "url" ? "URL" : "Origin"} {data.record.target}
                {data.record.period ? ` · ${formatPeriod(data.record.period)}` : ""}
                {data.record.rtt !== null ? ` · Round trip time p75 ${msLabel(data.record.rtt)}` : ""}
                {data.history ? " · Sparklines: p75 per week, last 6 months" : ""}
              </div>
            </>
          ) : crux.loading ? (
            <Empty>Asking the Chrome UX Report…</Empty>
          ) : null}
        </>
      )}
    </Section>
  );
}

/** Options: the optional CrUX API key, sealed on the device. */
export function CruxSettings() {
  const toast = useToast();
  const [hasKey] = useStored<boolean>(CRUX_KEY_FLAG, false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const test = async () => {
    setBusy("test");
    setStatus(null);
    try {
      const key = draft.trim() || (await loadCruxKey());
      if (!key) return setStatus({ ok: false, text: "Type a key first." });
      await testCruxKey(key, cruxFetchImpl);
      setStatus({ ok: true, text: "The key works." });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      title="Field data (CrUX)"
      hint="Optional. With a Chrome UX Report API key, Inspect › Performance shows how real Chrome users experience the page. The key is free, encrypted on this device, and sent only to Google's CrUX API, with the URL of the page you open in the Performance panel."
    >
      <p className="small muted" style={{ margin: 0 }}>
        Get a key: in the Google Cloud console,{" "}
        <a href={CRUX_CONSOLE} target="_blank" rel="noreferrer">
          enable the Chrome UX Report API
        </a>
        , then create an API key under Credentials (
        <a href={CRUX_KEY_HELP} target="_blank" rel="noreferrer">
          how
        </a>
        ).
      </p>
      <div className="row">
        <input
          className="grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="CrUX API key"
          placeholder={hasKey ? "A key is saved — type a new one to replace it" : "Chrome UX Report API key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          variant="primary"
          busy={busy === "save"}
          disabled={!draft.trim()}
          onClick={async () => {
            setBusy("save");
            const ok = await saveCruxKey(draft).catch(() => false);
            setBusy(null);
            if (ok) {
              setDraft("");
              setStatus(null);
            }
            toast(ok ? "CrUX key saved, encrypted on this device." : "This browser could not store the key.", !ok);
          }}
        >
          Save
        </Button>
        <Button busy={busy === "test"} disabled={!draft.trim() && !hasKey} onClick={test}>
          Test key
        </Button>
        {hasKey ? (
          <Button
            onClick={async () => {
              await removeCruxKey();
              setStatus(null);
              toast("CrUX key removed.");
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
      <div className="small" role="status">
        {status ? (
          <span className={status.ok ? "t-good" : "t-bad"}>{status.text}</span>
        ) : (
          <span className="muted">{hasKey ? "A key is saved." : "No key saved."}</span>
        )}
      </div>
    </Section>
  );
}
