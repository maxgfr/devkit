// Inspect › Agent tools (WebMCP tools the page exposes, analyzed and testable with in-panel confirmation) and
// Inspect › Agent readiness (a local 0–100 score, agent files, AI crawlers in robots.txt, recommendations).
import { useCallback, useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { agentToolsMarkdown, readinessMarkdown, readinessReport } from "../../lib/agent/agents";
import { runInTab } from "../../lib/inject";
import { analyzeJsonLd } from "../../lib/jsonld";
import { collectMeta } from "../../lib/page/collect";
import { collectSemantics, collectWebMcp, executeWebMcpTool, type WebMcpRun } from "../../lib/page/webmcp";
import { fetchAgentFiles } from "../../lib/agent-files";
import {
  type Area,
  IMPACT_TEXT,
  type Impact,
  PURPOSE_TEXT,
  type ReadinessInputs,
  type Recommendation,
  readinessScore,
} from "../../lib/readiness";
import {
  buildArgs,
  confirmSteps,
  type FieldSpec,
  formFields,
  maskArgs,
  RISK_TEXT,
  type Risk,
  type ToolAnalysis,
  analyzeTools,
} from "../../lib/webmcp";
import { StatusIcon } from "../charts";
import { Button, Checks, Code, CopyButton, Empty, ErrorText, JsonTree, KV, Metric, Notice, Section, useToast } from "../components";
import { useAsync, useStored } from "../hooks";
import { AccessGate, useInPage, usePage } from "../page";

const EXPERIMENTAL = "WebMCP is experimental (Chrome origin trial). Availability depends on the browser version and page opt-in.";
const UNAVAILABLE =
  "document.modelContext is not available on this page. WebMCP may be unsupported, disabled, or gated behind a Chrome flag / origin trial.";
const DISCLAIMER = "This score is a technical orientation and not a guarantee of compatibility with any specific AI agent.";
const AREA_SHORT: Record<Recommendation["area"], string> = {
  structured: "Structured data",
  availability: "Tools",
  descriptions: "Descriptions",
  schemas: "Schemas",
  safety: "Safety",
  testability: "Testability",
  semantics: "Semantics",
  files: "Agent files",
};

const RISK_COLOR: Record<Risk, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
};

function RiskPill({ risk }: { risk: Risk }) {
  return (
    <span className={`pill sev sev-${risk}`} title={`${RISK_TEXT[risk]} risk (heuristic)`}>
      <span className="viz-key" style={{ background: RISK_COLOR[risk] }} aria-hidden="true" />
      {RISK_TEXT[risk]}
    </span>
  );
}

/** The page's WebMCP snapshot (MAIN world) and the analysis of its tools. */
function useWebMcp() {
  const snap = useInPage(collectWebMcp, [], "MAIN");
  const tools = useMemo(() => (snap.data ? analyzeTools(snap.data.tools) : []), [snap.data]);
  return { snap, tools };
}

const ALLOW_KEY = "webmcpAllowCritical";

/** Origins where the developer allowed Critical tools, for this browser session only (storage.session). */
function useCriticalAllowed(origin: string | null): [boolean, (on: boolean) => Promise<void>] {
  const [origins, setOrigins] = useState<string[]>([]);
  useEffect(() => {
    browser.storage.session.get(ALLOW_KEY).then((r) => setOrigins((r[ALLOW_KEY] as string[] | undefined) ?? []));
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "session" && ALLOW_KEY in changes) setOrigins((changes[ALLOW_KEY]!.newValue as string[] | undefined) ?? []);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  const set = useCallback(
    async (on: boolean) => {
      if (!origin) return;
      const next = on ? Array.from(new Set([...origins, origin])) : origins.filter((o) => o !== origin);
      setOrigins(next);
      await browser.storage.session.set({ [ALLOW_KEY]: next });
    },
    [origin, origins],
  );
  return [Boolean(origin && origins.includes(origin)), set];
}

interface HistoryEntry {
  at: number;
  tool: string;
  args: unknown;
  ok: boolean;
  via: string;
  ms: number;
  preview: string;
}
const HISTORY_KEY = "webmcpHistory";
const HISTORY_MAX = 20;

function FieldInput({
  f,
  value,
  onChange,
}: {
  f: FieldSpec;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const label = (
    <span>
      <span className="mono">{f.key}</span>
      {f.required ? <span className="t-bad"> *</span> : null}
      <span className="muted"> · {f.kind === "array" ? `${f.itemKind}[]` : f.kind}</span>
      {f.description ? <span className="muted"> · {f.description}</span> : null}
    </span>
  );
  if (f.kind === "boolean")
    return (
      <label className="check small">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  if (f.kind === "enum")
    return (
      <label className="field">
        {label}
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">{f.required ? "Choose…" : "(not set)"}</option>
          {f.options?.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </label>
    );
  if (f.kind === "json" || f.kind === "array")
    return (
      <label className="field">
        {label}
        <textarea
          className="mono"
          rows={f.kind === "json" ? 3 : 2}
          value={String(value ?? "")}
          placeholder={f.kind === "json" ? "JSON value" : "One value per line, or comma-separated"}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  return (
    <label className="field">
      {label}
      <input
        className="mono"
        type={f.kind === "number" || f.kind === "integer" ? "number" : "text"}
        step={f.kind === "integer" ? 1 : "any"}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

const initialValues = (fields: FieldSpec[]): Record<string, string | boolean> =>
  Object.fromEntries(
    fields
      .filter((f) => f.default !== undefined)
      .map((f) => [
        f.key,
        f.kind === "boolean" ? Boolean(f.default) : typeof f.default === "string" ? f.default : JSON.stringify(f.default),
      ]),
  );

/**
 * Builds a form from the tool's input schema and runs it with in-panel confirmation: Low runs on one click, Medium
 * asks once, High asks twice (the second time by typing the tool's name), Critical is blocked unless allowed for
 * this site and session, then follows the High flow. Declarative tools are only filled, never submitted.
 */
function ToolTester({
  analysis,
  criticalAllowed,
  onAllowCritical,
  onRan,
}: {
  analysis: ToolAnalysis;
  criticalAllowed: boolean;
  onAllowCritical: (on: boolean) => void;
  onRan: (args: Record<string, unknown>, run: WebMcpRun) => void;
}) {
  const page = usePage();
  const { tool, risk } = analysis;
  const declarative = Boolean(tool.form);
  const fields = useMemo(() => formFields(tool.inputSchema), [tool.inputSchema]);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialValues(fields));
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState("{}");
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<WebMcpRun | null>(null);
  const built = useMemo(() => {
    if (rawMode) {
      try {
        const v = JSON.parse(raw || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) return { args: {}, errors: ["Arguments must be a JSON object"] };
        return { args: v as Record<string, unknown>, errors: [] };
      } catch (e) {
        return { args: {}, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }
    return buildArgs(fields, values);
  }, [rawMode, raw, fields, values]);
  const steps = declarative ? 0 : confirmSteps(risk);
  const blocked = risk === "critical" && !criticalAllowed && !declarative;
  const reset = () => {
    setStep(0);
    setTyped("");
  };
  const execute = async () => {
    if (page.tabId === undefined || built.errors.length) return;
    setBusy(true);
    try {
      const result = await runInTab(page.tabId, executeWebMcpTool, [tool.name, JSON.stringify(built.args), 15000], "MAIN");
      setRun(result);
      onRan(built.args, result);
    } catch (e) {
      setRun({ ok: false, via: "none", error: e instanceof Error ? e.message : String(e), ms: 0 });
    } finally {
      setBusy(false);
      reset();
    }
  };
  const start = () => {
    if (built.errors.length) return;
    if (step >= steps) execute();
    else setStep(1);
  };
  return (
    <div className="stack wm-tester">
      <div className="row">
        <b className="small">Test this tool</b>
        <span className="grow" />
        <label className="check small">
          <input
            type="checkbox"
            checked={rawMode}
            onChange={(e) => {
              if (e.target.checked) setRaw(JSON.stringify(buildArgs(fields, values).args, null, 2));
              setRawMode(e.target.checked);
              reset();
            }}
          />
          Edit as JSON
        </label>
      </div>
      {rawMode ? (
        <textarea
          className="mono"
          rows={5}
          aria-label={`Arguments of ${tool.name} as JSON`}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            reset();
          }}
        />
      ) : fields.length ? (
        fields.map((f) => (
          <FieldInput
            key={f.key}
            f={f}
            value={values[f.key]}
            onChange={(v) => {
              setValues((old) => ({ ...old, [f.key]: v }));
              reset();
            }}
          />
        ))
      ) : (
        <span className="small muted">No arguments.</span>
      )}
      {built.errors.length ? <div className="small t-bad">{built.errors.join(" · ")}</div> : null}
      {risk === "critical" && !declarative && criticalAllowed ? (
        <label className="check small t-bad">
          <input type="checkbox" checked onChange={(e) => onAllowCritical(e.target.checked)} />
          Allow critical tools on this site for this session
        </label>
      ) : null}
      {blocked ? (
        <Notice kind="bad">
          <div className="stack">
            <span>
              <b>Blocked.</b> This tool is classified Critical (money, account deletion or credentials): devkit does not run Critical tools
              unless you allow them for this site.
            </span>
            <label className="check small">
              <input type="checkbox" checked={criticalAllowed} onChange={(e) => onAllowCritical(e.target.checked)} />
              Allow critical tools on this site for this session
            </label>
          </div>
        </Notice>
      ) : step === 0 ? (
        <div className="row">
          <Button
            variant={risk === "low" || declarative ? "primary" : risk === "medium" ? undefined : "danger"}
            busy={busy}
            disabled={Boolean(built.errors.length)}
            onClick={start}
          >
            {declarative ? "Fill the form" : steps ? "Run…" : "Run"}
          </Button>
          <span className="small muted">
            {declarative
              ? "Fills the form in the page and stops: devkit never submits it."
              : risk === "low"
                ? "Read-only by its name or annotations: runs on one click."
                : risk === "medium"
                  ? "Can change state: you confirm once."
                  : "Sensitive: you confirm twice, the second time by typing its name."}
          </span>
        </div>
      ) : step === 1 ? (
        <div className={`wm-confirm ${risk === "medium" ? "warn" : "bad"}`} role="alertdialog" aria-label={`Confirm running ${tool.name}`}>
          <div className="small">
            {risk === "medium" ? (
              <>
                <b>{tool.name}</b> may change data on this site, as you. Run it with these arguments?
              </>
            ) : (
              <>
                <b>{tool.name}</b> is classified {RISK_TEXT[risk]}: {analysis.riskReasons.join("; ")}. It runs on the real site, with your
                session. Continue only if you know what it does.
              </>
            )}
          </div>
          <Code text={JSON.stringify(built.args, null, 2)} />
          <div className="row">
            {risk === "medium" ? (
              <Button variant="primary" busy={busy} onClick={execute}>
                Confirm and run
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setStep(2)}>
                Continue
              </Button>
            )}
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="wm-confirm bad" role="alertdialog" aria-label={`Confirm running ${tool.name}`}>
          <label className="field">
            <span>
              Type <b className="mono">{tool.name}</b> to run it
            </span>
            <input
              className="mono"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Tool name to confirm"
            />
          </label>
          <div className="row">
            <Button variant="danger" busy={busy} disabled={typed !== tool.name} onClick={execute}>
              Run {tool.name}
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {run ? (
        <div className="stack">
          <div className="row small">
            <StatusIcon level={run.ok ? "good" : "bad"} label={run.ok ? "Succeeded" : "Failed"} />
            <span>
              {run.ok ? (run.filled ? "Form filled" : "Result") : "Error"} · {run.ms} ms{run.via !== "none" ? ` · via ${run.via}` : ""}
              {run.truncated ? " · truncated" : ""}
            </span>
          </div>
          <Code text={run.ok ? (run.result ?? "") : (run.error ?? "")} maxHeight={260} />
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({
  analysis,
  criticalAllowed,
  onAllowCritical,
  onRan,
}: {
  analysis: ToolAnalysis;
  criticalAllowed: boolean;
  onAllowCritical: (on: boolean) => void;
  onRan: (args: Record<string, unknown>, run: WebMcpRun) => void;
}) {
  const { tool } = analysis;
  const order = { bad: 0, warn: 1, info: 2, good: 3 } as const;
  const findings = [...analysis.findings].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <Section
      title={
        <span className="row wm-title">
          <span className="mono">{tool.name || "(unnamed)"}</span>
          <RiskPill risk={analysis.risk} />
        </span>
      }
    >
      {tool.title ? <div className="small">{tool.title}</div> : null}
      {tool.description ? <p className="small wm-desc">{tool.description}</p> : <p className="small t-bad">No description.</p>}
      <div className="small muted">
        From {tool.sources.join(", ")}
        {tool.form ? (
          <>
            {" "}
            · form <span className="mono">{tool.form.selector}</span>
            {tool.form.autosubmit ? " · toolautosubmit" : ""}
          </>
        ) : null}
      </div>
      <div className="small">
        <b>Risk (heuristic):</b> {analysis.riskReasons.join("; ")}.
      </div>
      {findings.length ? (
        <Checks
          checks={findings.map((f, i) => ({
            id: `${f.area}-${i}`,
            label: f.area === "input" ? "Input schema" : f.area === "output" ? "Output schema" : f.area[0]!.toUpperCase() + f.area.slice(1),
            level: f.level,
            detail: f.message,
          }))}
        />
      ) : null}
      <details>
        <summary className="small">Annotations</summary>
        {tool.annotations && Object.keys(tool.annotations).length ? (
          <KV rows={Object.entries(tool.annotations).map(([k, v]) => [k, JSON.stringify(v)])} />
        ) : (
          <Empty>None.</Empty>
        )}
      </details>
      <details>
        <summary className="small">Input schema</summary>
        {tool.inputSchemaError ? (
          <Code text={tool.inputSchemaError} />
        ) : tool.inputSchema ? (
          <div className="tree">
            <JsonTree value={tool.inputSchema} open={3} />
          </div>
        ) : (
          <Empty>None.</Empty>
        )}
      </details>
      {tool.outputSchema ? (
        <details>
          <summary className="small">Output schema</summary>
          <div className="tree">
            <JsonTree value={tool.outputSchema} open={3} />
          </div>
        </details>
      ) : null}
      <ToolTester analysis={analysis} criticalAllowed={criticalAllowed} onAllowCritical={onAllowCritical} onRan={onRan} />
    </Section>
  );
}

export function AgentTools() {
  const page = usePage();
  const toast = useToast();
  const { snap, tools } = useWebMcp();
  const data = snap.data;
  const [criticalAllowed, setCriticalAllowed] = useCriticalAllowed(page.origin);
  const [history, setHistory] = useStored<Record<string, HistoryEntry[]>>(HISTORY_KEY, {});
  const [keepHistory, setKeepHistory] = useStored(`${HISTORY_KEY}On`, true);
  const runs = page.origin ? (history[page.origin] ?? []) : [];
  const agentMd = useMemo(() => (data ? agentToolsMarkdown(data, tools, { url: page.url }) : ""), [data, tools, page.url]);
  const counts = useMemo(() => {
    const c: Record<Risk, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const t of tools) c[t.risk]++;
    return c;
  }, [tools]);
  const onRan = (name: string) => (args: Record<string, unknown>, run: WebMcpRun) => {
    if (!run.ok) toast(`${name} failed: ${run.error ?? "error"}`, true);
    if (!keepHistory || !page.origin) return;
    const entry: HistoryEntry = {
      at: Date.now(),
      tool: name,
      args: maskArgs(args),
      ok: run.ok,
      via: run.via,
      ms: run.ms,
      preview: (run.ok ? (run.result ?? "") : (run.error ?? "")).slice(0, 300),
    };
    setHistory({ ...history, [page.origin]: [entry, ...runs].slice(0, HISTORY_MAX) });
  };
  const api = data && (data.apis.document.present || data.apis.navigator.present);
  const apiRow = (present: boolean, methods: string[]) =>
    present ? (methods.length ? `available · ${methods.join(", ")}` : "available") : "not available";
  return (
    <AccessGate>
      <ErrorText error={snap.error} />
      <Section
        title="Agent tools (WebMCP)"
        actions={
          <>
            <Button size="small" onClick={snap.run} busy={snap.loading}>
              Refresh
            </Button>
            {data ? <CopyButton text={agentMd} label="Copy for agent" /> : null}
          </>
        }
      >
        <Notice kind="info">{EXPERIMENTAL}</Notice>
        {data ? (
          <>
            {!api ? <Notice kind="warn">{UNAVAILABLE}</Notice> : null}
            {!data.secureContext ? (
              <Notice kind="warn">The page is not a secure context (https or localhost): WebMCP is only exposed in secure contexts.</Notice>
            ) : null}
            <KV
              rows={[
                ["document.modelContext", apiRow(data.apis.document.present, data.apis.document.methods)],
                ["navigator.modelContext", apiRow(data.apis.navigator.present, data.apis.navigator.methods)],
                ["navigator.modelContextTesting", apiRow(data.apis.testing.present, data.apis.testing.methods)],
                ["Declarative forms", String(data.tools.filter((t) => t.form).length)],
              ]}
            />
            {data.errors.length ? (
              <Notice kind="warn">
                <div className="stack small">
                  {data.errors.map((e) => (
                    <span key={e} className="mono">
                      {e}
                    </span>
                  ))}
                </div>
              </Notice>
            ) : null}
            <div className="grid2">
              <Metric label="Tools" value={tools.length} />
              <Metric label="Critical" value={counts.critical} level={counts.critical ? "bad" : undefined} />
              <Metric label="High" value={counts.high} level={counts.high ? "warn" : undefined} />
              <Metric label="Medium / Low" value={`${counts.medium} / ${counts.low}`} />
            </div>
            {!tools.length ? (
              <Empty>
                No tool found: the page registers none with document.modelContext.registerTool() and has no &lt;form toolname&gt;.
                {data.apis.document.present && !data.enumerable ? " This browser cannot list the page's tools (no getTools)." : ""}
              </Empty>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Risk classes and findings are heuristics read from names, descriptions and annotations. Tools run on the real site, with
                your session.
              </p>
            )}
          </>
        ) : null}
      </Section>
      {tools.map((t) => (
        <ToolCard
          key={`${t.tool.name}-${t.tool.sources.join()}`}
          analysis={t}
          criticalAllowed={criticalAllowed}
          onAllowCritical={setCriticalAllowed}
          onRan={onRan(t.tool.name)}
        />
      ))}
      {data && tools.length ? (
        <Section
          title={`Run history${runs.length ? ` (${runs.length})` : ""}`}
          actions={
            <>
              <label className="check small">
                <input type="checkbox" checked={keepHistory} onChange={(e) => setKeepHistory(e.target.checked)} />
                Keep
              </label>
              {runs.length && page.origin ? (
                <Button
                  size="small"
                  onClick={() => setHistory(Object.fromEntries(Object.entries(history).filter(([o]) => o !== page.origin)))}
                >
                  Clear
                </Button>
              ) : null}
            </>
          }
          hint={`Last ${HISTORY_MAX} runs on this site, kept on this device. Arguments that look sensitive (password, token, card…) are masked.`}
        >
          {runs.length ? (
            <ul className="list">
              {runs.map((r) => (
                <li key={r.at} className="stack wm-run">
                  <div className="row small">
                    <StatusIcon level={r.ok ? "good" : "bad"} label={r.ok ? "Succeeded" : "Failed"} />
                    <b className="mono">{r.tool}</b>
                    <span className="muted">
                      {new Date(r.at).toLocaleTimeString()} · {r.ms} ms · {r.via}
                    </span>
                  </div>
                  <div className="small mono muted break">{JSON.stringify(r.args)}</div>
                  {r.preview ? <div className="small mono break">{r.preview}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No run yet.</Empty>
          )}
        </Section>
      ) : null}
    </AccessGate>
  );
}

/** robots.txt, llms.txt, llms-full.txt, ai.txt and the sitemap of the page's origin. */
function useAgentFiles() {
  const page = usePage();
  return useAsync(
    async () => (page.origin && page.canScript ? fetchAgentFiles(page.origin, page.url) : null),
    [page.origin, page.url, page.canScript],
  );
}

function AreaRow({ area, open, onToggle }: { area: Area; open: boolean; onToggle: () => void }) {
  const ratio = area.max ? area.score / area.max : 0;
  const level = ratio >= 0.8 ? "good" : ratio >= 0.5 ? "warn" : "bad";
  return (
    <li>
      <button type="button" className="ar-area" aria-expanded={open} onClick={onToggle}>
        <span className="ar-label">{area.label}</span>
        <span className="ar-track" aria-hidden="true">
          <span className={`ar-bar ${level}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
        <span className="viz-num">
          {area.score}/{area.max}
        </span>
      </button>
      {open ? (
        <div className="ar-detail stack small">
          <span>{area.about}</span>
          <ul className="ar-rules">
            {area.rules.map((r) => (
              <li key={r.label}>
                <StatusIcon level={r.points >= r.max ? "good" : r.points > 0 ? "warn" : "bad"} />
                <span>{r.label}</span>
                <span className="muted">{r.detail}</span>
                <span className="viz-num">
                  {Number.isInteger(r.points) ? r.points : r.points.toFixed(1)}/{r.max}
                </span>
              </li>
            ))}
          </ul>
          <span>
            <b>How to improve:</b> {area.improve}
          </span>
        </div>
      ) : null}
    </li>
  );
}

export function AgentReadiness() {
  const page = usePage();
  const meta = useInPage(collectMeta);
  const semantics = useInPage(collectSemantics);
  const { snap, tools } = useWebMcp();
  const files = useAgentFiles();
  const [open, setOpen] = useState<string | null>(null);
  const loading = meta.loading || semantics.loading || snap.loading || files.loading;
  const inputs: ReadinessInputs = useMemo(
    () => ({
      jsonLd: meta.data ? analyzeJsonLd(meta.data.jsonLd) : null,
      webmcp: snap.data ?? null,
      tools,
      semantics: semantics.data ?? null,
      llms: files.data ? files.data.llms : undefined,
      llmsFull: files.data ? files.data.llmsFull : undefined,
      aiTxt: files.data ? files.data.aiTxt : undefined,
      crawlers: files.data?.crawlers,
      sitemap: files.data ? files.data.sitemap : undefined,
    }),
    [meta.data, snap.data, tools, semantics.data, files.data],
  );
  const ready = Boolean(meta.data && semantics.data && snap.data && files.data);
  const score = useMemo(() => readinessScore(inputs), [inputs]);
  const report = useMemo(() => (ready ? readinessReport(score, inputs, { url: page.url }) : ""), [ready, score, inputs, page.url]);
  const agentMd = useMemo(() => (ready ? readinessMarkdown(score, inputs, { url: page.url }) : ""), [ready, score, inputs, page.url]);
  const refresh = () => {
    meta.run();
    semantics.run();
    snap.run();
    files.run();
  };
  const crawlers = files.data?.crawlers ?? [];
  const blocked = crawlers.filter((c) => !c.root.allowed);
  const level = score.total >= 80 ? "good" : score.total >= 50 ? "warn" : "bad";
  const f = files.data;
  return (
    <AccessGate>
      <ErrorText error={meta.error ?? semantics.error ?? snap.error ?? files.error} />
      <Section
        title="Agent readiness"
        actions={
          <>
            <Button size="small" onClick={refresh} busy={loading}>
              Refresh
            </Button>
            {ready ? (
              <>
                <CopyButton text={report} label="Copy report" />
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            ) : null}
          </>
        }
      >
        {ready ? (
          <>
            <div className="ar-score" role="img" aria-label={`Agent readiness ${score.total} out of 100 (heuristic)`}>
              <b className={`t-${level}`}>{score.total}</b>
              <span className="muted">/ 100</span>
              <span className="pill">heuristic</span>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {DISCLAIMER}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              Tap an area to see what it measures and how to improve it.
            </p>
            <ul className="ar-areas" aria-label="Score by area">
              {score.areas.map((a) => (
                <AreaRow key={a.id} area={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
              ))}
            </ul>
          </>
        ) : (
          <Empty>Reading the page and its files…</Empty>
        )}
      </Section>
      {f ? (
        <>
          <Section title="Agent files">
            <KV
              rows={[
                [
                  "llms.txt",
                  f.llms.present ? (
                    <span key="llms">
                      Found · {f.llms.bytes} bytes{f.llms.title ? ` · “${f.llms.title}”` : ""} · {f.llms.links} links ·{" "}
                      <a href={f.llms.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </span>
                  ) : (
                    `No llms.txt${f.llms.status ? ` (HTTP ${f.llms.status})` : ""}`
                  ),
                ],
                [
                  "llms-full.txt",
                  f.llmsFull.present ? (
                    <span key="llms-full">
                      Found · {f.llmsFull.bytes} bytes ·{" "}
                      <a href={f.llmsFull.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </span>
                  ) : (
                    "None"
                  ),
                ],
                [
                  "ai.txt",
                  f.aiTxt.present
                    ? f.aiTxt.optOutAll
                      ? "Found · opts the whole site out of AI training"
                      : f.aiTxt.optOutPartial
                        ? "Found · opts some files or folders out of AI training"
                        : "Found · allows AI training"
                    : "None (Spawning's AI training opt-out, optional)",
                ],
                [
                  "Sitemap",
                  f.sitemap.found ? (
                    <span key="sitemap">
                      Found ·{" "}
                      <a href={f.sitemap.url} target="_blank" rel="noreferrer">
                        Open sitemap
                      </a>
                    </span>
                  ) : (
                    "Not found (no Sitemap: line in robots.txt, no /sitemap.xml)"
                  ),
                ],
              ]}
            />
          </Section>
          <Section
            title="AI crawlers (robots.txt)"
            hint={
              f.robots
                ? `${crawlers.length - blocked.length} allowed · ${blocked.length} blocked, for "/" and for this page (${f.path}). Blocking may be intentional.`
                : `No robots.txt (HTTP ${f.robotsStatus || "error"}): every crawler may fetch everything.`
            }
          >
            <table className="rs-fns ar-crawlers">
              <thead>
                <tr>
                  <th>Crawler</th>
                  <th>Purpose</th>
                  <th>/</th>
                  <th>This page</th>
                </tr>
              </thead>
              <tbody>
                {crawlers.map((c) => (
                  <tr key={c.agent} title={[c.note, c.root.rule].filter(Boolean).join(" · ")}>
                    <td>
                      <span className="mono">{c.agent}</span> <span className="muted">{c.operator}</span>
                    </td>
                    <td>{PURPOSE_TEXT[c.purpose]}</td>
                    <td className={c.root.allowed ? "t-good" : "t-bad"}>{c.root.allowed ? "allowed" : "blocked"}</td>
                    <td className={c.page.allowed ? "t-good" : "t-bad"}>{c.page.allowed ? "allowed" : "blocked"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      ) : null}
      {ready ? (
        <Section title={`Recommendations (${score.recommendations.length})`}>
          {score.recommendations.length ? (
            (["high", "medium", "low"] as Impact[]).map((impact) => {
              const list = score.recommendations.filter((r) => r.impact === impact);
              return list.length ? (
                <div key={impact} className="stack">
                  <b className={`small ${impact === "high" ? "t-bad" : impact === "medium" ? "t-warn" : ""}`}>{IMPACT_TEXT[impact]}</b>
                  <Checks
                    checks={list.map((r, i) => ({
                      id: `${impact}-${i}`,
                      label: AREA_SHORT[r.area],
                      level: impact === "high" ? "bad" : impact === "medium" ? "warn" : "info",
                      detail: r.text,
                    }))}
                  />
                </div>
              ) : null;
            })
          ) : (
            <Empty>Nothing to recommend.</Empty>
          )}
        </Section>
      ) : null}
    </AccessGate>
  );
}
