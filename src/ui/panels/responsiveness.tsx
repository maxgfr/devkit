import { useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { injectionError, runInTab } from "../../lib/inject";
import {
  type NavigationInfo,
  type ResponsivenessSnapshot,
  readNavigationInfo,
  readResponsiveness,
  recorderStatus,
  type ScriptEntry,
  startRecorder,
} from "../../lib/page/responsiveness";
import {
  type AttributedScript,
  type BfcacheState,
  type BlockingScript,
  bfcacheFromNavigation,
  blockingScripts,
  countReasons,
  EAGERNESS_TEXT,
  type Eagerness,
  frameTotals,
  groupInteractions,
  type Interaction,
  inpEstimate,
  interactionLabel,
  interactionMarkdown,
  lineColumn,
  type NotRestoredReasonsJson,
  PHASES,
  type Phase,
  parseSpeculationHeader,
  parseSpeculationRules,
  preloadState,
  type ReasonFrame,
  reasonTree,
  SCRIPT_PHASE_TEXT,
  type ScriptPhase,
  type SourceLocation,
  scriptFileMarkdown,
  scriptName,
  type SpecRuleSet,
  suggestions,
} from "../../lib/responsiveness";
import { clamp01, formatVital, niceTicks, RATING_LEVEL, RATING_TEXT, rateVital, shortUrl, VITALS, vitalScale } from "../../lib/viz";
import { Legend, type Part, StatusIcon, ThresholdBar } from "../charts";
import { Button, copyText, Empty, ErrorText, KV, msText, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { useNav } from "../nav";
import { AccessGate, useInPage, usePage } from "../page";
import { useHeaders } from "./inspect";

/* Colors: the three phases take the first three categorical slots, in their fixed order. */
const PHASE_COLOR: Record<ScriptPhase, string> = {
  "input-delay": "var(--viz-1)",
  processing: "var(--viz-2)",
  presentation: "var(--viz-3)",
  before: "var(--viz-other)",
};
const PHASE_PARTS: Part[] = PHASES.map((p) => ({ key: p.id, label: p.label, value: 1, color: PHASE_COLOR[p.id] }));
const INP = VITALS.inp;
const ROWS = 8;

const pct = (f: number) => `${(clamp01(f) * 100).toFixed(2)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const phaseValue = (i: Interaction, p: Phase) => (p === "input-delay" ? i.inputDelay : p === "processing" ? i.processing : i.presentation);

/* Sources: fetched by the extension (its host access skips CORS) to turn character offsets into line:column. */
const sources = new Map<string, Promise<string | null>>();
function sourceText(url: string): Promise<string | null> {
  if (!/^https?:/.test(url)) return Promise.resolve(null);
  let p = sources.get(url);
  if (!p) {
    p = fetch(url, { cache: "force-cache" })
      .then(async (r) => {
        if (!r.ok) return null;
        const text = await r.text();
        return text.length > 8_000_000 ? null : text;
      })
      .catch(() => null);
    sources.set(url, p);
  }
  return p;
}

async function locator(scripts: Pick<ScriptEntry, "sourceURL">[]): Promise<(s: ScriptEntry) => SourceLocation | null> {
  const urls = Array.from(new Set(scripts.map((s) => s.sourceURL).filter(Boolean))).slice(0, 8);
  const texts = new Map<string, string | null>(await Promise.all(urls.map(async (u) => [u, await sourceText(u)] as const)));
  return (s) => {
    const text = texts.get(s.sourceURL);
    return text ? lineColumn(text, s.sourceCharPosition) : null;
  };
}

/* Back/forward cache test: leave for a devkit page, go back, and see whether the same document came back. */
const AWAY = () => browser.runtime.getURL("/bfcache.html");

async function waitFor<T>(probe: () => Promise<T | null>, timeout: number, what: string): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await probe().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timed out ${what}.`);
}

interface BfcacheResult {
  restored: boolean;
  info: NavigationInfo;
  /** From the back navigation to a readable page. */
  ms: number;
}

async function testBfcache(tabId: number, step: (text: string) => void): Promise<BfcacheResult> {
  const before = await runInTab(tabId, readNavigationInfo);
  const away = AWAY();
  step("Leaving the page…");
  await browser.tabs.update(tabId, { url: away });
  await waitFor(
    async () => {
      const t = await browser.tabs.get(tabId);
      return t.url === away && t.status === "complete" ? t : null;
    },
    10_000,
    "opening devkit's test page",
  );
  step("Going back…");
  const t0 = performance.now();
  await browser.tabs.goBack(tabId);
  const info = await waitFor(
    async () => {
      const t = await browser.tabs.get(tabId);
      if (!t.url || t.url === away) return null;
      const i = await runInTab(tabId, readNavigationInfo);
      return i.readyState === "complete" ? i : null;
    },
    15_000,
    "coming back to the page",
  );
  return { restored: info.timeOrigin === before.timeOrigin, info, ms: performance.now() - t0 };
}

/* Charts */

/** One interaction's duration as three stacked phases on the shared axis, with the INP thresholds as hairlines. */
function PhaseTrack({ i, end }: { i: Interaction; end: number }) {
  return (
    <span className="rs-track" aria-hidden="true">
      {[INP.good, INP.poor].map((t) => (t < end ? <i key={t} className="rs-limit" style={{ left: pct(t / end) }} /> : null))}
      <span className="rs-stack" style={{ width: pct(i.duration / end) }}>
        {PHASES.map((p) => {
          const v = phaseValue(i, p.id);
          return v > 0 ? <span key={p.id} className="rs-seg" style={{ flexGrow: v, background: PHASE_COLOR[p.id] }} /> : null;
        })}
      </span>
    </span>
  );
}

function PhaseAxis({ end }: { end: number }) {
  const ticks = [0, INP.good, INP.poor].filter((t) => t < end * 0.93);
  return (
    <div className="viz-axis rs-axis" aria-hidden="true">
      {ticks.map((t, k) => (
        <span key={t} className={k === 0 ? "first" : undefined} style={{ left: pct(t / end) }}>
          {t}
        </span>
      ))}
      <span className="last" style={{ left: "100%" }}>
        {Math.round(end)} ms
      </span>
    </div>
  );
}

const phaseSummary = (i: Interaction) => PHASES.map((p) => `${p.label.toLowerCase()} ${msText(phaseValue(i, p.id))}`).join(", ");

/** What ran around one interaction: the long frames, the interaction's phases, then each script, on one time axis. */
function WhatRan({ i, selected, onSelect }: { i: Interaction; selected: number | null; onSelect: (index: number | null) => void }) {
  const shown = i.scripts.slice(0, 10);
  const t0 = Math.min(i.start, ...i.frames.map((f) => f.startTime), ...shown.map((s) => s.startTime));
  const t1 = Math.max(i.end, ...i.frames.map((f) => f.startTime + f.duration), ...shown.map((s) => s.startTime + s.duration));
  const { end, ticks } = niceTicks(Math.max(1, t1 - t0), 2);
  const at = (t: number) => pct((t - t0) / end);
  const width = (d: number) => pct(d / end);
  const fromFrame = t0 < i.start;
  return (
    <figure
      className="rs-gantt"
      aria-label={`What ran during the interaction: ${i.frames.length} long animation frames, ${i.scripts.length} scripts. ${shown
        .map((s) => `${scriptName(s)} ${msText(s.duration)} (${SCRIPT_PHASE_TEXT[s.phase]})`)
        .join(", ")}.`}
    >
      <div className="rs-grow">
        {i.frames.length ? (
          <div className="rs-grow-row">
            <span className="rs-glabel muted">Long frames</span>
            <span className="rs-gtrack">
              {ticks.slice(1, -1).map((t) => (
                <i key={t} className="grid" style={{ left: pct(t / end) }} />
              ))}
              {i.frames.map((f) => (
                <span
                  key={f.startTime}
                  className="rs-frame"
                  style={{ left: at(f.startTime), width: width(f.duration) }}
                  title={`Long animation frame: ${msText(f.duration)}, ${msText(f.blockingDuration)} blocking`}
                />
              ))}
            </span>
            <span className="rs-gvalue">{msText(i.frames.reduce((s, f) => s + f.duration, 0))}</span>
          </div>
        ) : null}
        <div className="rs-grow-row">
          <span className="rs-glabel">Interaction</span>
          <span className="rs-gtrack">
            {ticks.slice(1, -1).map((t) => (
              <i key={t} className="grid" style={{ left: pct(t / end) }} />
            ))}
            <span className="rs-stack" style={{ left: at(i.start), width: width(i.duration), position: "absolute" }}>
              {PHASES.map((p) => {
                const v = phaseValue(i, p.id);
                return v > 0 ? (
                  <span
                    key={p.id}
                    className="rs-seg"
                    style={{ flexGrow: v, background: PHASE_COLOR[p.id] }}
                    title={`${p.label}: ${msText(v)}`}
                  />
                ) : null;
              })}
            </span>
          </span>
          <span className="rs-gvalue">{msText(i.duration)}</span>
        </div>
        {shown.map((s, k) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a frame can hold the same script twice; the index is its selection
            key={`${s.startTime}:${k}`}
            type="button"
            className="rs-grow-row rs-script"
            aria-pressed={selected === k}
            onClick={() => onSelect(selected === k ? null : k)}
            title={`${scriptName(s)} · ${s.sourceURL || s.invoker || "no source"} · ${SCRIPT_PHASE_TEXT[s.phase]}`}
          >
            <span className="rs-glabel mono">{scriptName(s)}</span>
            <span className="rs-gtrack">
              {ticks.slice(1, -1).map((t) => (
                <i key={t} className="grid" style={{ left: pct(t / end) }} />
              ))}
              <span className="rs-sbar" style={{ left: at(s.startTime), width: width(s.duration), background: PHASE_COLOR[s.phase] }} />
            </span>
            <span className="rs-gvalue">{msText(s.duration)}</span>
          </button>
        ))}
        <div className="rs-grow-row rs-gaxis">
          <span />
          <div className="viz-axis">
            {ticks.map((t, k) => (
              <span key={t} className={k === 0 ? "first" : k === ticks.length - 1 ? "last" : undefined} style={{ left: pct(t / end) }}>
                {k === ticks.length - 1 ? `${t} ms` : t}
              </span>
            ))}
          </div>
          <span />
        </div>
      </div>
      <figcaption className="small muted">
        {fromFrame ? "From the start of the first long frame." : "From the input."} Scripts are colored by the phase they started in
        {shown.some((s) => s.phase === "before") ? "; gray ran before the input" : ""}.
        {i.scripts.length > shown.length ? ` ${i.scripts.length - shown.length} shorter scripts not shown.` : ""}
      </figcaption>
    </figure>
  );
}

function ScriptCard({ s, onCopy }: { s: AttributedScript; onCopy: () => void }) {
  const loc = useAsync(async () => {
    const text = s.sourceURL ? await sourceText(s.sourceURL) : null;
    return text ? lineColumn(text, s.sourceCharPosition) : null;
  }, [s.sourceURL, s.sourceCharPosition]);
  const position = loc.data ? `:${loc.data.line}:${loc.data.column}` : s.sourceCharPosition >= 0 ? ` @ char ${s.sourceCharPosition}` : "";
  const where = s.sourceURL ? `${s.sourceURL}${position}` : "";
  return (
    <div className="rs-card">
      <div className="row">
        <b className="mono grow ellipsis">{scriptName(s)}</b>
        <span className="pill">{SCRIPT_PHASE_TEXT[s.phase]}</span>
      </div>
      <KV
        rows={[
          [
            "Source",
            s.sourceURL ? (
              <span key="source" className="break" title={where}>
                {shortUrl(s.sourceURL)}
                {position}
              </span>
            ) : (
              "No source URL (inline handler, extension, or a cross-origin script)"
            ),
          ],
          ["Invoker", `${s.invoker || "–"} (${s.invokerType || "–"})`],
          ["Duration", msText(s.duration)],
          ["Forced style & layout", msText(s.forcedStyleAndLayoutDuration)],
          ...(s.pauseDuration > 0 ? ([["Paused (sync calls)", msText(s.pauseDuration)]] as [string, string][]) : []),
          ...(s.windowAttribution && s.windowAttribution !== "self" ? ([["Window", s.windowAttribution]] as [string, string][]) : []),
        ]}
      />
      {loc.data?.snippet ? <pre className="code rs-snippet">{loc.data.snippet}</pre> : null}
      <div className="row">
        <Button size="small" variant="primary" onClick={onCopy}>
          Copy for agent
        </Button>
        {s.sourceURL ? (
          <Button size="small" onClick={() => copyText(where)}>
            Copy location
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function InteractionDetail({ i, pageUrl }: { i: Interaction; pageUrl: string }) {
  const toast = useToast();
  const [script, setScript] = useState<number | null>(null);
  const tips = useMemo(() => suggestions(i, pageUrl), [i, pageUrl]);
  const copy = async (focus?: ScriptEntry) => {
    const locate = await locator(i.scripts);
    const ok = await copyText(interactionMarkdown(i, pageUrl, { focus, locate }));
    toast(ok ? "Markdown for your agent copied." : "The clipboard refused the copy.", !ok);
  };
  const selected = script === null ? null : i.scripts[script];
  return (
    <div className="rs-detail">
      <ul className="rs-phases">
        {PHASES.map((p) => (
          <li key={p.id}>
            <span className="viz-key" style={{ background: PHASE_COLOR[p.id] }} />
            <span className="grow">
              {p.label} <span className="muted small">{p.detail}</span>
            </span>
            <b className="viz-num">{msText(phaseValue(i, p.id))}</b>
          </li>
        ))}
      </ul>
      {i.frames.length ? (
        <WhatRan i={i} selected={script} onSelect={setScript} />
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No long animation frame (over 50 ms) overlapped this interaction, so no script is attributed to it.
        </p>
      )}
      {selected ? <ScriptCard s={selected} onCopy={() => copy(selected)} /> : null}
      {tips.length ? (
        <div className="rs-tips">
          <h3>Suggestions</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Heuristics from the numbers above, not a diagnosis.
          </p>
          <ul>
            {tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="row">
        <Button size="small" variant={selected ? undefined : "primary"} onClick={() => copy()}>
          Copy interaction for agent
        </Button>
        <span className="small muted">{i.events.join(" · ")}</span>
      </div>
    </div>
  );
}

function Interactions({ list, pageUrl }: { list: Interaction[]; pageUrl: string }) {
  const [open, setOpen] = useState<number | null | undefined>(undefined);
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, ROWS);
  const end = niceTicks(Math.max(INP.poor * 1.1, ...list.map((i) => i.duration))).end;
  const current = open === undefined ? list[0]?.id : open;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Legend parts={PHASE_PARTS} />
      <PhaseAxis end={end} />
      <ol className="rs-list" aria-label={`Slowest interactions, ${list.length}`}>
        {shown.map((i) => {
          const rating = rateVital("inp", i.duration)!;
          const expanded = current === i.id;
          return (
            <li key={i.id} className={expanded ? "open" : undefined}>
              <button
                type="button"
                className="rs-row"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : i.id)}
                aria-label={`${interactionLabel(i)}: ${msText(i.duration)}, ${RATING_TEXT[rating]}. ${phaseSummary(i)}.`}
              >
                <span className="rs-head">
                  <StatusIcon level={RATING_LEVEL[rating]} label={RATING_TEXT[rating]} />
                  <b>{i.name}</b>
                  <span className="rs-target mono">{i.target ?? ""}</span>
                  <span className="rs-when muted">at {seconds(i.start)}</span>
                  <span className="rs-dur viz-num">{msText(i.duration)}</span>
                </span>
                <PhaseTrack i={i} end={end} />
              </button>
              {expanded ? <InteractionDetail i={i} pageUrl={pageUrl} /> : null}
            </li>
          );
        })}
      </ol>
      <div className="row">
        <span className="small muted grow">
          Hairlines at {INP.good} ms and {INP.poor} ms: INP's good and poor thresholds.
        </span>
        {list.length > ROWS ? (
          <Button size="small" onClick={() => setAll(!all)}>
            {all ? `Show the ${ROWS} slowest` : `Show all ${list.length}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ScriptFiles({ files, pageUrl, interactions }: { files: BlockingScript[]; pageUrl: string; interactions: Interaction[] }) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, ROWS);
  const max = Math.max(1, ...files.map((f) => f.total));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <ul className="rs-files" aria-label="Script time by file">
        {shown.map((f) => {
          const expanded = open === f.key;
          return (
            <li key={f.key} className={expanded ? "open" : undefined}>
              <button
                type="button"
                className="rs-file"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : f.key)}
                title={f.url ?? f.key}
              >
                <span className="rs-fname mono">{f.url ? shortUrl(f.url) : f.key}</span>
                <span className="bl-track">
                  <span className="bl-bar" style={{ width: pct(f.total / max) }} />
                </span>
                <span className="viz-num">
                  {msText(f.total)} · {f.count}×
                </span>
              </button>
              {expanded ? (
                <div className="rs-detail">
                  <div className="row">
                    {f.url ? <span className="break mono small grow">{f.url}</span> : <span className="small grow">{f.key}</span>}
                    {f.thirdParty ? <span className="pill">third party</span> : null}
                  </div>
                  <KV
                    rows={[
                      ["Script time", `${msText(f.total)} in ${f.count} ${f.count === 1 ? "entry" : "entries"}`],
                      ["During interactions", msText(f.duringInteractions)],
                      ["Forced style & layout", msText(f.forcedLayout)],
                      ["Invoked as", f.invokerTypes.join(", ") || "–"],
                    ]}
                  />
                  <table className="rs-fns">
                    <thead>
                      <tr>
                        <th>Function</th>
                        <th>Char</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.functions.slice(0, 10).map((fn) => (
                        <tr key={`${fn.name}:${fn.charPosition}`}>
                          <td className="mono ellipsis">{fn.name}</td>
                          <td className="viz-num">{fn.charPosition >= 0 ? fn.charPosition : "–"}</td>
                          <td className="viz-num">
                            {msText(fn.total)}
                            {fn.count > 1 ? ` · ${fn.count}×` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="row">
                    <Button
                      size="small"
                      variant="primary"
                      onClick={async () => {
                        const ok = await copyText(scriptFileMarkdown(f, pageUrl, interactions));
                        toast(ok ? "Markdown for your agent copied." : "The clipboard refused the copy.", !ok);
                      }}
                    >
                      Copy for agent
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {files.length > ROWS ? (
        <Button size="small" onClick={() => setAll(!all)} className="rs-more">
          {all ? `Show the ${ROWS} heaviest` : `Show all ${files.length}`}
        </Button>
      ) : null}
    </div>
  );
}

function ReasonList({ frame }: { frame: ReasonFrame }) {
  return (
    <li>
      <div className="rs-frame-label">
        <span className="small muted">{frame.main ? "Page" : "Frame"}</span> <span className="mono small break">{frame.label}</span>
      </div>
      {frame.reasons.length ? (
        <ul className="rs-reasons">
          {frame.reasons.map((r) => (
            <li key={r.code}>
              <StatusIcon level="bad" />
              <div>
                <b>{r.title}</b> <code className="muted rs-code">{r.code}</code>
                <div className="small muted">{r.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small muted">No reason in this frame.</div>
      )}
      {frame.children.length ? (
        <ul className="rs-tree">
          {frame.children.map((c, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: frames have no stable id
            <ReasonList key={k} frame={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Bfcache({
  nav,
  onTest,
  testing,
  step,
  result,
  error,
}: {
  nav: NavigationInfo | undefined;
  onTest: () => void;
  testing: boolean;
  step: string;
  result: BfcacheResult | null;
  error: unknown;
}) {
  const state: BfcacheState = result
    ? result.restored
      ? { status: "restored", via: "test" }
      : {
          status: "not-restored",
          via: "test",
          tree: result.info.notRestoredReasons ? reasonTree(result.info.notRestoredReasons as NotRestoredReasonsJson) : null,
        }
    : bfcacheFromNavigation(
        nav
          ? { type: nav.type, notRestoredReasons: nav.notRestoredReasons as NotRestoredReasonsJson | null, supported: nav.reasonsSupported }
          : null,
      );
  const tree = state.status === "not-restored" ? state.tree : null;
  return (
    <Section
      title="Back/forward cache"
      actions={
        <Button size="small" busy={testing} onClick={onTest}>
          {result ? "Test again" : "Test now"}
        </Button>
      }
      hint="Test now opens a devkit page in this tab, then goes back, like DevTools' own test. The page is restored when the very same document comes back; otherwise Chrome reports why (notRestoredReasons, Chrome 123+)."
    >
      {testing ? <Notice>{step || "Testing…"}</Notice> : null}
      <ErrorText error={error} />
      {testing ? null : (
        <div className="rs-verdict">
          <StatusIcon level={state.status === "restored" ? "good" : state.status === "not-restored" ? "bad" : "none"} />
          <b>
            {state.status === "restored" ? "Restored from the cache" : state.status === "not-restored" ? "Not restored" : "Not measured"}
          </b>
          <span className="rs-why muted small">
            {state.status === "restored"
              ? `Back in ${msText(result?.ms)}: the page was eligible.`
              : state.status === "not-restored"
                ? state.via === "test"
                  ? `The page reloaded (${msText(result?.ms)}).`
                  : "The last back/forward navigation to this page reloaded it."
                : state.why}
          </span>
        </div>
      )}
      {!testing && state.status === "not-restored" ? (
        tree && countReasons(tree) ? (
          <ul className="rs-tree root">
            <ReasonList frame={tree} />
          </ul>
        ) : (
          <Empty>Chrome gave no reason{nav?.reasonsSupported ? "" : " (this version does not report them; Chrome 123+ does)"}.</Empty>
        )
      ) : null}
    </Section>
  );
}

const ACTION_TEXT = { prefetch: "Prefetch", prerender: "Prerender", prefetch_with_subresources: "Prefetch (legacy)" } as const;

function Speculation({ nav, header }: { nav: NavigationInfo | undefined; header: string | undefined }) {
  const headerUrls = parseSpeculationHeader(header);
  const external = useAsync(async () => {
    const base = nav?.url;
    return Promise.all(
      headerUrls.map(async (u) => {
        const url = base ? new URL(u, base).href : u;
        try {
          const r = await fetch(url, { cache: "force-cache" });
          return parseSpeculationRules(await r.text(), url);
        } catch (e) {
          return { origin: url, rules: [], tag: null, error: e instanceof Error ? e.message : String(e) } satisfies SpecRuleSet;
        }
      }),
    );
  }, [header, nav?.url]);
  if (!nav) return null;
  const sets: SpecRuleSet[] = [
    ...nav.speculationRules.map((s) => parseSpeculationRules(s.text, `Inline <script type="speculationrules"> #${s.index + 1}`)),
    ...(external.data ?? []),
  ];
  const pre = preloadState(nav);
  const rules = sets.reduce((n, s) => n + s.rules.length, 0);
  return (
    <Section
      title="Speculation rules & preloading"
      hint="What this page asks Chrome to prefetch or prerender for the next navigation, and how this page itself arrived. Which speculations Chrome actually ran is in DevTools > Application > Speculative loads."
    >
      <KV
        rows={[
          [
            "This page",
            pre.prerendered !== null
              ? `Prerendered, shown ${msText(pre.prerendered)} after its navigation started`
              : pre.prefetched
                ? "Prefetched (served from a speculation)"
                : nav.prerendering
                  ? "Being prerendered"
                  : `Loaded normally${pre.deliveryType === "cache" ? " (document from the HTTP cache)" : pre.deliveryType ? ` (delivery: ${pre.deliveryType})` : ""}`,
          ],
          [
            "Rules",
            `${rules} ${rules === 1 ? "rule" : "rules"} in ${sets.length} ${sets.length === 1 ? "set" : "sets"}${nav.supportsSpeculationRules ? "" : " · not supported by this browser"}`,
          ],
          ["Speculation-Rules header", headerUrls.length ? headerUrls.join(", ") : "–"],
        ]}
      />
      {sets.length ? (
        <ul className="rs-rulesets">
          {sets.map((set) => (
            <li key={set.origin}>
              <div className="small muted break">
                {set.origin}
                {set.tag ? ` · tag “${set.tag}”` : ""}
              </div>
              {set.error ? <div className="small t-bad">{set.error}</div> : null}
              <ul className="rs-rules">
                {set.rules.map((r, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rules have no id
                  <li key={k}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="pill accent">{ACTION_TEXT[r.action]}</span>
                      <span className="pill" title={EAGERNESS_TEXT[r.eagerness as Eagerness] ?? r.eagerness}>
                        {r.eagerness}
                        {r.defaulted ? " (default)" : ""}
                      </span>
                      <span className="small muted">{r.source === "list" ? "URL list" : "document rule"}</span>
                    </div>
                    <div className="small break">
                      {r.source === "list" ? (
                        r.urls.map((u) => (
                          <code key={u} className="rs-url">
                            {u}{" "}
                          </code>
                        ))
                      ) : (
                        <span>Links where {r.where}</span>
                      )}
                    </div>
                    <div className="small muted">
                      Starts {EAGERNESS_TEXT[r.eagerness as Eagerness] ?? `with eagerness “${r.eagerness}”`}
                      {r.requires.length ? ` · requires ${r.requires.join(", ")}` : ""}
                      {r.referrerPolicy ? ` · referrer ${r.referrerPolicy}` : ""}
                      {r.noVarySearch ? ` · No-Vary-Search ${r.noVarySearch}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No speculation rules: the next navigation starts from scratch.</Empty>
      )}
      {nav.hints.length ? (
        <details>
          <summary className="small muted">
            {nav.hints.length} resource {nav.hints.length === 1 ? "hint" : "hints"} (preload, prefetch, preconnect…)
          </summary>
          <ul className="list small">
            {nav.hints.map((h, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: hints can repeat
              <li key={k} className="row" style={{ gap: 6 }}>
                <span className="pill">{h.rel}</span>
                {h.as ? <span className="muted">{h.as}</span> : null}
                <span className="mono ellipsis grow" title={h.href}>
                  {shortUrl(h.href)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

export function Responsiveness() {
  const page = usePage();
  const toast = useToast();
  const go = useNav();
  const snap = useInPage(readResponsiveness, [false]);
  const nav = useInPage(readNavigationInfo);
  const headers = useHeaders();
  const [recording, setRecording] = useState<{ since: number; now: number; interactions: number; frames: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [bf, setBf] = useState<{ testing: boolean; step: string; result: BfcacheResult | null; error: unknown }>({
    testing: false,
    step: "",
    result: null,
    error: null,
  });
  const tabId = page.tabId;
  const wasRecording = useRef(false);

  // Pick up a recording still running in the page (the panel was closed or switched), then poll its counts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the page changes
  useEffect(() => {
    if (tabId === undefined || !page.canScript) return;
    let live = true;
    const tick = async () => {
      const s = await runInTab(tabId, recorderStatus).catch(() => null);
      if (!live) return;
      if (!s && wasRecording.current) toast("The page changed: recording stopped.");
      wasRecording.current = Boolean(s);
      setRecording(s);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tabId, page.url, page.canScript]);

  const data: ResponsivenessSnapshot | undefined = snap.data;
  const interactions = useMemo(() => (data ? groupInteractions(data.events, data.frames) : []), [data]);
  const files = useMemo(() => (data ? blockingScripts(data.frames, data.url, interactions) : []), [data, interactions]);
  const totals = useMemo(() => frameTotals(data?.frames ?? []), [data]);
  const inp = inpEstimate(interactions);
  const rating = rateVital("inp", inp);
  const scale = vitalScale("inp", inp);

  if (!page.canScript && !bf.testing) return <AccessGate />;

  const record = async () => {
    if (tabId === undefined) return;
    setBusy(true);
    try {
      if (recording) {
        wasRecording.current = false;
        snap.set(await runInTab(tabId, readResponsiveness, [true]));
        setRecording(null);
      } else {
        const r = await runInTab(tabId, startRecorder);
        wasRecording.current = true;
        setRecording({ since: r.since, now: r.since, interactions: 0, frames: 0 });
      }
    } catch (e) {
      toast(injectionError(e), true);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    if (tabId === undefined) return;
    if (recording) return toast("Stop the recording first: leaving the page would end it.", true);
    setBf({ testing: true, step: "", result: null, error: null });
    try {
      const result = await testBfcache(tabId, (step) => setBf((b) => ({ ...b, step })));
      setBf({ testing: false, step: "", result, error: null });
      nav.run();
      snap.run();
    } catch (e) {
      setBf({ testing: false, step: "", result: null, error: e instanceof Error ? e : new Error(String(e)) });
    }
  };

  // A test result describes one document: drop it once the tab shows another one.
  const tested = bf.result && nav.data?.timeOrigin === bf.result.info.timeOrigin ? bf.result : null;
  const recordedFor = recording
    ? Math.max(0, recording.now - recording.since)
    : data?.recording
      ? data.recording.until - data.recording.since
      : 0;
  return (
    <>
      <Section
        title="Slow interactions"
        actions={
          <>
            <Button size="small" variant={recording ? "primary" : undefined} busy={busy} onClick={record}>
              {recording ? "Stop and analyze" : "Record"}
            </Button>
            <Button size="small" onClick={snap.run} disabled={snap.loading}>
              Refresh
            </Button>
          </>
        }
        hint="Event Timing splits each interaction into input delay, handlers and paint; Long Animation Frames name the scripts that ran. Without recording, Chrome only keeps interactions over 104 ms: record to catch every one over 16 ms while you use the page."
      >
        {recording ? (
          <Notice kind="info">
            <span className="rs-rec" aria-hidden="true" />
            <span className="grow">
              Recording for {seconds(recordedFor)}: <b className="viz-num">{recording.interactions}</b>{" "}
              {recording.interactions === 1 ? "interaction" : "interactions"}, <b className="viz-num">{recording.frames}</b> long{" "}
              {recording.frames === 1 ? "frame" : "frames"}. Use the page, then stop.
            </span>
          </Notice>
        ) : null}
        {bf.testing ? null : <ErrorText error={snap.error} />}
        {data && !data.supported.event ? (
          <Notice kind="warn">This browser does not support Event Timing: no interaction can be measured.</Notice>
        ) : null}
        {data?.supported.event && !data.supported.loaf ? (
          <Notice kind="warn">
            This browser has no Long Animation Frames API (Chrome 123+): interactions are listed without their scripts.
          </Notice>
        ) : null}
        {data ? (
          <>
            <ul className="vitals">
              <li className="vital">
                <div className="vital-head">
                  <b>INP</b>
                  <span className="vital-name">{interactions.length ? "estimate for this tab" : "Interaction to Next Paint"}</span>
                  {rating ? <span className="vital-value">{formatVital("inp", inp)}</span> : null}
                  <span className="vital-rating">
                    <StatusIcon level={rating ? RATING_LEVEL[rating] : "none"} />
                    {rating ? RATING_TEXT[rating] : "Not measured"}
                  </span>
                </div>
                {rating ? (
                  <ThresholdBar
                    good={scale.good}
                    poor={scale.poor}
                    pos={scale.pos}
                    over={scale.over}
                    ticks={[`${INP.good} ms`, `${INP.poor} ms`]}
                    label={`INP estimate ${formatVital("inp", inp)}: ${RATING_TEXT[rating]}. Good up to ${INP.good} ms, poor above ${INP.poor} ms.`}
                  />
                ) : null}
                {rating ? (
                  <p className="vital-why">
                    Worst of {interactions.length} {interactions.length === 1 ? "interaction" : "interactions"}
                    {data.recording ? ` (${seconds(recordedFor)} recorded)` : " still buffered"}, skipping one outlier per 50 as web-vitals
                    does. Field INP (CrUX) is the 75th percentile over real visits.
                  </p>
                ) : (
                  <p className="vital-why">
                    {recording
                      ? "Nothing over 16 ms yet: click, tap or type in the page."
                      : "No interaction over 104 ms buffered. Record, use the page (click, type, open menus), then stop and analyze."}
                  </p>
                )}
              </li>
            </ul>
            {interactions.length ? <Interactions list={interactions} pageUrl={data.url} /> : null}
          </>
        ) : (
          <Empty>{snap.loading ? "Reading the page's performance entries…" : ""}</Empty>
        )}
      </Section>

      {data?.supported.loaf ? (
        <Section
          title="Blocking scripts"
          hint="Script time inside long animation frames (over 50 ms), summed per file: which file blocks the main thread. Chrome only attributes scripts over 5 ms."
        >
          {totals.count ? (
            <>
              <ul className="rs-facts small muted">
                <li>
                  <span className="viz-num t-fg">{totals.count}</span> long {totals.count === 1 ? "frame" : "frames"}
                </li>
                <li>
                  <span className="viz-num t-fg">{msText(totals.blocking)}</span> blocking
                </li>
                <li>
                  longest <span className="viz-num t-fg">{msText(totals.longest)}</span>
                </li>
                <li>
                  scripts <span className="viz-num t-fg">{msText(totals.scripts)}</span> of {msText(totals.total)}
                </li>
              </ul>
              {files.length ? (
                <ScriptFiles files={files} pageUrl={data.url} interactions={interactions} />
              ) : (
                <Empty>Long frames were seen, but no script in them ran over 5 ms: rendering, style and layout took the time.</Empty>
              )}
            </>
          ) : (
            <Empty>No long animation frame yet: the main thread never stayed busy over 50 ms.</Empty>
          )}
        </Section>
      ) : null}

      <Bfcache nav={nav.data} onTest={runTest} testing={bf.testing} step={bf.step} result={tested} error={bf.error} />
      <Speculation nav={nav.data} header={headers.data?.headers["speculation-rules"]} />
      {go ? (
        <p className="small muted" style={{ margin: 0 }}>
          Loading metrics (LCP, CLS, TTFB) and the request waterfall are in{" "}
          <Button variant="ghost" size="small" className="rs-link" onClick={() => go({ panel: "perf" })}>
            Performance
          </Button>
          .
        </p>
      ) : null}
    </>
  );
}
