import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import {
  browserName,
  buildReport,
  buildReportJson,
  DEFAULT_REPORT_PARTS,
  DEFAULT_SLOW_MS,
  describeStep,
  REPORT_HANDOFF_KEY,
  REPORT_PARTS,
  type RecorderState,
  type ReportHandoff,
  type ReportPart,
  recorderKey,
  reportFileName,
  SLOW_THRESHOLDS,
  triageRequests,
} from "../../lib/bug-report";
import { gatherReport } from "../../lib/bug-report-gather";
import { injectionError, runInTab } from "../../lib/inject";
import { installErrorCapture } from "../../lib/page/errors";
import { PENDING_ROUTE_KEY } from "../../lib/panels";
import { clearRecording, readRecorder, startRecording, stopRecording } from "../../lib/recorder";
import { formatBytes } from "../../lib/storage-usage";
import { formatVital } from "../../lib/viz";
import { Button, Code, copyText, download, ErrorText, Notice, Section, useToast } from "../components";
import { useAsync, useStored } from "../hooks";
import { useNav } from "../nav";
import { AccessGate, usePage } from "../page";
import { enableErrorCapture } from "./inspect";
import { dataUrlToBlob } from "./page-tools";

const STEPS_SHOWN = 12;
const NO_STEPS: RecorderState["steps"] = [];

const elapsed = (ms: number) =>
  ms < 60_000 ? `+${(ms / 1000).toFixed(1)} s` : `+${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** The steps recorded in this tab, live from session storage. */
function useRecorder(tabId: number | undefined): RecorderState | null {
  const [state, setState] = useState<RecorderState | null>(null);
  useEffect(() => {
    setState(null);
    if (tabId === undefined) return;
    const key = recorderKey(tabId);
    readRecorder(tabId).then(setState, () => setState(null));
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "session" && key in changes) setState((changes[key]!.newValue as RecorderState | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [tabId]);
  return state;
}

/** The description typed for this tab, kept for the browser session so switching panels does not lose it. */
function useNote(tabId: number | undefined): [string, (v: string) => void] {
  const [note, setNote] = useState("");
  const key = `reportNote:${tabId}`;
  useEffect(() => {
    setNote("");
    if (tabId === undefined) return;
    browser.storage.session.get(key).then((r) => setNote((r[key] as string | undefined) ?? ""));
  }, [key, tabId]);
  return [
    note,
    (v: string) => {
      setNote(v);
      if (tabId !== undefined) browser.storage.session.set({ [key]: v }).catch(() => undefined);
    },
  ];
}

async function copyImage(dataUrl: string): Promise<string | null> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": dataUrlToBlob(dataUrl) })]);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function BugReport() {
  const page = usePage();
  const toast = useToast();
  const nav = useNav();
  const tabId = page.tabId;
  const [parts, setParts] = useStored<ReportPart[]>("reportParts", DEFAULT_REPORT_PARTS);
  const [slowMs, setSlowMs] = useStored<number>("reportSlowMs", DEFAULT_SLOW_MS);
  const [recordValues, setRecordValues] = useStored<boolean>("reportRecordValues", false);
  const [withShot, setWithShot] = useStored<boolean>("reportScreenshot", false);
  const [note, setNote] = useNote(tabId);
  const [allSteps, setAllSteps] = useState(false);
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const recorder = useRecorder(tabId);

  const gathered = useAsync(async () => {
    if (!page.tab || !page.canScript) return null;
    const g = await gatherReport(page.tab, { screenshot: withShot });
    return { ...g, at: Date.now() };
  }, [tabId, page.url, page.canScript, withShot]);
  const g = gathered.data ?? null;

  // The live recording wins over the steps read with the rest.
  const steps = recorder?.steps ?? NO_STEPS;
  const data = useMemo(
    () =>
      g
        ? {
            ...g,
            description: note,
            slowMs,
            screenshot: Boolean(g.screenshot),
            steps: steps.length
              ? { steps, recording: Boolean(recorder?.recording), recordValues: Boolean(recorder?.recordValues) }
              : undefined,
          }
        : null,
    [g, note, slowMs, steps, recorder?.recording, recorder?.recordValues],
  );
  const built = useMemo(() => (data ? buildReport(data, parts) : null), [data, parts]);

  // Errors thrown while reproducing, and the requests they made: read again once the recording stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the transition only
  useEffect(() => {
    if (recorder && !recorder.recording && recorder.stoppedAt && Date.now() - recorder.stoppedAt < 3000) gathered.run();
  }, [recorder?.recording]);

  const toggle = (p: ReportPart, on: boolean) => setParts(on ? [...parts.filter((x) => x !== p), p] : parts.filter((x) => x !== p));

  const record = async () => {
    if (!page.tab || tabId === undefined) return;
    setRecBusy(true);
    setRecError(null);
    try {
      if (recorder?.recording) await stopRecording(tabId);
      else {
        await startRecording(page.tab, recordValues);
        setAllSteps(false);
      }
    } catch (e) {
      setRecError(injectionError(e));
    } finally {
      setRecBusy(false);
    }
  };

  const copy = async (text: string, what: string) =>
    toast((await copyText(text)) ? `${what} copied (${formatBytes(new Blob([text]).size)}).` : "The clipboard refused the copy.", !text);

  const askAi = async () => {
    if (!built || tabId === undefined) return;
    const handoff: ReportHandoff = {
      tabId,
      url: page.url,
      markdown: built.markdown,
      image: g?.screenshot ?? (parts.includes("element") ? g?.elementImage : undefined),
      at: Date.now(),
    };
    await browser.storage.session.set({ [REPORT_HANDOFF_KEY]: handoff });
    await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "ask", params: { action: "report", at: String(handoff.at) } } });
  };

  if (!page.canScript) return <AccessGate />;

  const errorsTotal = g?.errors?.errors.reduce((s, e) => s + e.count, 0) ?? 0;
  const triage = g?.requests ? triageRequests(g.requests, slowMs) : null;
  const elementTitle = g?.element ? (/^## UI element: (.+)$/m.exec(g.element.markdown)?.[1] ?? "").replace(/`/g, "") : "";

  const detail: Record<ReportPart, string> = {
    steps: recorder?.recording
      ? `Recording · ${steps.length} step${steps.length === 1 ? "" : "s"}`
      : steps.length
        ? `${steps.length} step${steps.length === 1 ? "" : "s"} and a Playwright test`
        : "Nothing recorded yet: start the recorder above",
    environment: g?.env
      ? `${browserName(g.env)} · ${g.env.viewport.width}×${g.env.viewport.height} at ${g.env.dpr}x · ${g.env.colorScheme}`
      : (g?.missing.environment ?? ""),
    errors: g?.errors
      ? g.errors.installed
        ? errorsTotal
          ? `${errorsTotal} captured`
          : "None captured"
        : "Capture is off on this page"
      : (g?.missing.errors ?? ""),
    requests: triage ? `${triage.failed.length} failed · ${triage.slow.length} slow, of ${triage.total}` : (g?.missing.requests ?? ""),
    vitals: g?.vitals
      ? `LCP ${formatVital("lcp", g.vitals.lcp)} · INP ${formatVital("inp", g.vitals.inp)} · CLS ${formatVital("cls", g.vitals.cls)}`
      : (g?.missing.vitals ?? ""),
    tech: g?.tech ? (g.tech.length ? g.tech.map((t) => t.name).join(", ") : "Nothing detected") : (g?.missing.tech ?? ""),
    element: g?.element ? elementTitle || "The last pick" : (g?.missing.element ?? ""),
    storage: g?.storage ? "Names and sizes only, never values" : (g?.missing.storage ?? ""),
    text: g?.text
      ? g.text.total > g.text.text.length
        ? `The first ${g.text.text.length.toLocaleString("en")} of ${g.text.total.toLocaleString("en")} characters`
        : `${g.text.total.toLocaleString("en")} characters`
      : (g?.missing.text ?? ""),
    dom: g?.dom ? `${g.dom.root}${g.dom.trimmed ? ", trimmed" : ""} · no scripts, styles or form values` : (g?.missing.dom ?? ""),
  };
  const available = (p: ReportPart) => (p === "steps" ? steps.length > 0 : Boolean(built?.sizes[p]));
  const size = (p: ReportPart) => (built?.sizes[p] ? formatBytes(built.sizes[p]!) : "–");
  const shownSteps = allSteps ? steps : steps.slice(-STEPS_SHOWN);
  const origin = page.origin ?? undefined;
  const reportBytes = built ? new Blob([built.markdown]).size : 0;

  return (
    <>
      <Section
        title="Bug report"
        actions={
          <Button size="small" busy={gathered.loading} onClick={gathered.run}>
            Refresh
          </Button>
        }
        hint="Everything a coding agent or a teammate needs to reproduce the bug on this page, as one Markdown block."
      >
        <label className="field">
          What happened / what did you expect?
          <textarea
            className="rp-note"
            rows={3}
            value={note}
            placeholder="e.g. Saving the form shows “Something went wrong”; it should save and go back to the list."
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="row">
          <Button variant="primary" disabled={!built} onClick={() => built && copy(built.markdown, "Bug report")}>
            Copy for agent
          </Button>
          <Button disabled={!built} onClick={askAi}>
            Ask AI about it
          </Button>
        </div>
        <div className="row">
          <Button size="small" disabled={!data} onClick={() => data && built && copy(buildReportJson(data, parts, built.redact), "JSON")}>
            Copy as JSON
          </Button>
          <Button
            size="small"
            disabled={!built}
            onClick={() => built && download(reportFileName(page.url, g?.at ?? Date.now(), "md"), built.markdown, "text/markdown")}
          >
            Download .md
          </Button>
        </div>
        <p className="small muted rp-privacy">
          Stays on this device until you copy it.{" "}
          {built?.redacted ? (
            <b className="rp-redacted">
              {built.redacted} value{built.redacted > 1 ? "s" : ""} redacted
            </b>
          ) : (
            "No secret found"
          )}{" "}
          by the Security tab's secret scanner; cookie and storage values are never read.
        </p>
        <ErrorText error={gathered.error} />
      </Section>

      <Section
        title="Steps to reproduce"
        actions={
          <>
            {steps.length && !recorder?.recording ? (
              <Button
                size="small"
                variant="ghost"
                onClick={() => tabId !== undefined && clearRecording(tabId).catch((e) => setRecError(injectionError(e)))}
              >
                Clear
              </Button>
            ) : null}
            <Button size="small" variant={recorder?.recording ? "danger" : undefined} busy={recBusy} onClick={record}>
              {recorder?.recording ? "Stop recording" : steps.length ? "Record again" : "Start recording"}
            </Button>
          </>
        }
      >
        {recorder?.recording ? (
          <p className="rp-live small" role="status">
            <span className="rp-live-dot" aria-hidden="true" />
            <span>
              <b>Recording.</b> Reproduce the bug in the page: clicks, typing, <kbd>Enter</kbd>, <kbd>Esc</kbd>, shortcuts and navigations
              become steps. It keeps going across navigations in this tab.
            </span>
          </p>
        ) : steps.length ? null : (
          <p className="small muted" style={{ margin: 0 }}>
            Start, then do what triggers the bug: devkit writes the steps and a Playwright test that replays them. Off until you start it.
          </p>
        )}
        {recError ? <Notice kind="bad">{recError}</Notice> : null}
        <label className={`check small${recorder?.recording ? " muted" : ""}`}>
          <input
            type="checkbox"
            checked={recordValues}
            disabled={recorder?.recording}
            onChange={(e) => setRecordValues(e.target.checked)}
          />
          Record typed values (never passwords, card numbers or hidden fields)
        </label>
        {steps.length ? (
          <>
            <ol className="rp-steps" start={allSteps ? 1 : Math.max(1, steps.length - STEPS_SHOWN + 1)}>
              {shownSteps.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the recording order is the identity
                <li key={`${s.time}-${i}`}>
                  <span className="rp-step break">{describeStep(s, origin)}</span>
                  <span className="rp-step-time">{elapsed(s.time - (recorder?.startedAt ?? s.time))}</span>
                </li>
              ))}
            </ol>
            {steps.length > STEPS_SHOWN ? (
              <Button size="small" variant="ghost" className="rp-more" onClick={() => setAllSteps(!allSteps)}>
                {allSteps ? `Show the last ${STEPS_SHOWN}` : `Show all ${steps.length} steps`}
              </Button>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section
        title="Include"
        hint={g ? `Read at ${new Date(g.at).toLocaleTimeString()}. Sizes are the redacted text.` : "Reading the page…"}
      >
        <ul className="rp-parts">
          {REPORT_PARTS.map(({ id, label }) => {
            const ok = available(id);
            const on = parts.includes(id) && ok;
            return (
              <li key={id} className={ok ? undefined : "rp-missing"}>
                <label className="rp-part">
                  <input type="checkbox" checked={on} disabled={!ok} onChange={(e) => toggle(id, e.target.checked)} />
                  <span className="rp-part-name">{label}</span>
                  <span className="rp-size">{ok ? size(id) : ""}</span>
                  <span className="rp-part-detail">{detail[id]}</span>
                </label>
                {id === "errors" && g?.errors && !g.errors.installed ? (
                  <div className="rp-part-extra">
                    <span className="small muted">Errors thrown before devkit listens are missing.</span>
                    <div className="row">
                      <Button
                        size="small"
                        onClick={async () => {
                          if (tabId !== undefined) await runInTab(tabId, installErrorCapture, [], "MAIN").catch(() => undefined);
                          gathered.run();
                        }}
                      >
                        Listen now
                      </Button>
                      <Button
                        size="small"
                        onClick={async () => {
                          if (await enableErrorCapture()) {
                            toast("Error capture on: reload the page to catch its startup errors.");
                            if (tabId !== undefined) await runInTab(tabId, installErrorCapture, [], "MAIN").catch(() => undefined);
                            gathered.run();
                          } else toast("devkit needs access to all sites for that.", true);
                        }}
                      >
                        Capture on all pages
                      </Button>
                    </div>
                  </div>
                ) : null}
                {id === "requests" && triage ? (
                  <div className="rp-part-extra row">
                    <label className="row small" htmlFor="rp-slow">
                      Slow from
                    </label>
                    <select id="rp-slow" className="rp-select" value={slowMs} onChange={(e) => setSlowMs(Number(e.target.value))}>
                      {SLOW_THRESHOLDS.map((t) => (
                        <option key={t} value={t}>
                          {t >= 1000 ? `${t / 1000} s` : `${t} ms`}
                        </option>
                      ))}
                    </select>
                    <span className="small muted grow">Cross-origin requests without CORS have no status.</span>
                  </div>
                ) : null}
                {id === "element" && !g?.element && nav ? (
                  <div className="rp-part-extra">
                    <Button size="small" onClick={() => nav({ panel: "element", params: { pick: "1", at: String(Date.now()) } })}>
                      Pick an element
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Screenshots" hint="Images do not fit in Markdown: paste them next to the report.">
        <label className="check small">
          <input type="checkbox" checked={withShot} onChange={(e) => setWithShot(e.target.checked)} />
          Capture the visible part of the page
        </label>
        {withShot && g && !g.screenshot ? (
          <p className="small muted" style={{ margin: 0 }}>
            No screenshot: {g.screenshotMissing ?? "not captured yet"}.
          </p>
        ) : null}
        {g?.screenshot || (g?.elementImage && parts.includes("element")) ? (
          <div className="rp-shots">
            {g.screenshot ? (
              <figure className="rp-shot">
                <img src={g.screenshot} alt="Screenshot of the visible page" />
                <Button
                  size="small"
                  onClick={async () => {
                    const err = await copyImage(g.screenshot!);
                    toast(err ? `The clipboard refused the image: ${err}` : "Screenshot copied.", Boolean(err));
                  }}
                >
                  Copy screenshot
                </Button>
              </figure>
            ) : null}
            {g.elementImage && parts.includes("element") ? (
              <figure className="rp-shot">
                <img src={g.elementImage} alt="Screenshot of the picked element" />
                <Button
                  size="small"
                  onClick={async () => {
                    const err = await copyImage(g.elementImage!);
                    toast(err ? `The clipboard refused the image: ${err}` : "Element image copied.", Boolean(err));
                  }}
                >
                  Copy element image
                </Button>
              </figure>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="Markdown preview"
        hint={built ? `${formatBytes(reportBytes)} · ${built.markdown.length.toLocaleString("en")} characters` : null}
      >
        <Code text={built?.markdown ?? ""} maxHeight={360} empty={gathered.loading ? "Reading the page…" : "Nothing yet."} />
      </Section>
    </>
  );
}
