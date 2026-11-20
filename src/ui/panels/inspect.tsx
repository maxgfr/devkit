import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  errorsMarkdown,
  fontsMarkdown,
  headersMarkdown,
  headingsMarkdown,
  jsonLdMarkdown,
  linksMarkdown,
  perfMarkdown,
  seoMarkdown,
  siteFilesMarkdown,
} from "../../lib/agent/inspect";
import { demoteHeadings, type PagePart, pageReportMarkdown } from "../../lib/agent/page";
import { cspMarkdown, secretsMarkdown, thirdPartiesMarkdown } from "../../lib/agent/security";
import { auditMarkdown } from "../../lib/a11y";
import { collectSecretSources, collectSurface } from "../../lib/page/security";
import { parseCsp, starterCsp } from "../../lib/security/csp";
import { scanSecrets } from "../../lib/security/secrets";
import { cachingReport, fetchHeaders, filterHeaders, type HeaderFetch, headersTextReport, securityReport } from "../../lib/headers";
import { headingIssues, headingsVerdict } from "../../lib/headings";
import { runInTab } from "../../lib/inject";
import { collectHeadings } from "../../lib/page/headings";
import {
  analyzeJsonLd,
  blockBadges,
  blockFileName,
  blockFindings,
  blockJson,
  type BlockStatus,
  groupFindings,
  indexingSignals,
  inMode,
  type JsonLdBlock,
  reportCounts,
  richResultsTestUrl,
  schemaDocUrl,
  schemaValidatorUrl,
  scriptTag,
  type ValidateMode,
} from "../../lib/jsonld";
import { loadSchemaVocab, type SchemaVocab } from "../../lib/schema-vocab";
import { collectFontsColors, collectLinks, collectMeta, collectPerf, collectTechSignals, type MetaSnapshot } from "../../lib/page/collect";
import { clearErrors, ERROR_SCRIPT_IDS, installErrorCapture, readErrors } from "../../lib/page/errors";
import { ALL_SITES, ensurePermission } from "../../lib/permissions";
import {
  errorsVerdict,
  jsonLdVerdict,
  PRINT_REPORT_KEY,
  type PrintReport,
  printReportMarkdown,
  securityVerdict,
  seoVerdict,
  type Verdict,
} from "../../lib/report";
import { seoReport } from "../../lib/seo";
import { EXTERNAL_TOOLS, isAllowed, manifestChecks, parseRobots, parseSitemap, TOOL_GROUPS } from "../../lib/site-files";
import { detectTech } from "../../lib/tech";
import { contrast, parseColor, toHex } from "../../lib/utils/color";
import {
  formatVital,
  linkBuckets,
  msLabel,
  navigationPhases,
  niceTicks,
  percent,
  RATING_LEVEL,
  RATING_TEXT,
  type ResourceKind,
  rateVital,
  resourceBreakdown,
  shares,
  shortUrl,
  VITALS,
  type VitalName,
  vitalScale,
  vitalsOf,
  vitalsSummary,
  type WaterfallSort,
  waterfallLayout,
} from "../../lib/viz";
import type { CapturedError } from "../../lib/ai/context";
import {
  Button,
  bytes,
  Checks,
  Code,
  CopyButton,
  copyText,
  Dot,
  Empty,
  download,
  ErrorText,
  Highlight,
  JsonTree,
  KV,
  Metric,
  msText,
  Notice,
  Section,
  useToast,
} from "../components";
import {
  BarList,
  CheckSummary,
  KIND_COLOR,
  LEVEL_COLOR,
  LEVEL_TEXT,
  Legend,
  type Part,
  ScoreMeter,
  SegmentBar,
  StatusIcon,
  SwatchStrip,
  ThresholdBar,
  Timeline,
  Waterfall,
} from "../charts";
import { type AsyncState, useAsync, useStored } from "../hooks";
import { useNav } from "../nav";
import { AccessGate, useInPage, usePage } from "../page";
import { useA11yReport } from "./a11y";
import { CruxField } from "./crux";

export function useHeaders() {
  const page = usePage();
  return useAsync(async () => {
    if (!page.origin) throw new Error("Open a web page.");
    if (!page.canScript) throw new Error("devkit has no access to this page yet.");
    return fetchHeaders(page.url);
  }, [page.url, page.canScript]);
}

function Chevron() {
  return (
    <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One line of a summary list: status, label, verdict. A button when it leads somewhere. */
function ReportRow({
  label,
  verdict,
  loading,
  error,
  onOpen,
  openLabel,
}: {
  label: ReactNode;
  verdict: Verdict | null | undefined;
  loading?: boolean;
  error?: unknown;
  onOpen?: () => void;
  openLabel?: string;
}) {
  const level = verdict?.level ?? "none";
  const text = verdict
    ? verdict.text
    : loading
      ? "Measuring…"
      : error
        ? `Not measured: ${error instanceof Error ? error.message : String(error)}`
        : "Not measured";
  const body = (
    <>
      <StatusIcon level={level} label={verdict ? LEVEL_TEXT[verdict.level] : undefined} />
      <span className="rr-label">{label}</span>
      <span className={`rr-value${verdict ? "" : " muted"}`}>{text}</span>
      {onOpen ? <Chevron /> : null}
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" className="report-row" onClick={onOpen} title={openLabel}>
          {body}
        </button>
      ) : (
        <div className="report-row">{body}</div>
      )}
    </li>
  );
}

/** Overview's report card: one verdict per inspector, each measured on its own and opening its panel. */
function PageReport({ meta, headers }: { meta: AsyncState<MetaSnapshot>; headers: AsyncState<HeaderFetch> }) {
  const go = useNav();
  const perf = useInPage(collectPerf);
  const errors = useInPage(readErrors, [], "MAIN");
  const headings = useInPage(collectHeadings);
  const a11y = useA11yReport(meta.data?.stats.elements);
  const page = usePage();
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const [printing, setPrinting] = useState(false);
  /** Everything Overview measured, plus the in-page security reads (no extra request), one part per area. */
  const gatherParts = async (tabId: number): Promise<PagePart[]> => {
    {
      const ctx = { url: page.url };
      const [surface, secretSources, vocab] = await Promise.all([
        runInTab(tabId, collectSurface).catch(() => null),
        runInTab(tabId, collectSecretSources, [2 * 1024 * 1024], "MAIN").catch(() => null),
        loadSchemaVocab().catch(() => undefined),
      ]);
      const h = headers.data?.headers ?? {};
      const policies = [
        ...(h["content-security-policy"] ? parseCsp(h["content-security-policy"], "header", false) : []),
        ...(h["content-security-policy-report-only"] ? parseCsp(h["content-security-policy-report-only"], "header", true) : []),
        ...(surface?.metaCsp ?? []).flatMap((m) => parseCsp(m, "meta", false)),
      ];
      const notRead = (s: { error: unknown }) => (s.error instanceof Error ? s.error.message : "not read yet");
      const parts: PagePart[] = [
        {
          area: "Secrets in the page",
          panel: "Security › Secrets",
          md: secretSources
            ? secretsMarkdown(scanSecrets(secretSources.sources), { ...ctx, scan: { sources: secretSources.sources.length } })
            : null,
          missing: "the page could not be read",
        },
        {
          area: "Security headers",
          panel: "Security › Headers",
          md: headers.data ? headersMarkdown(headers.data, { ...ctx, omitCsp: true }) : null,
          missing: notRead(headers),
        },
        {
          area: "Content-Security-Policy",
          panel: "Security › CSP",
          md:
            headers.data || surface
              ? cspMarkdown(
                  {
                    policies,
                    https: page.url.startsWith("https:"),
                    xfo: h["x-frame-options"],
                    starter: surface ? starterCsp(surface) : null,
                  },
                  ctx,
                )
              : null,
          missing: "no headers and no page read",
        },
        {
          area: "Accessibility",
          panel: "Inspect › A11y",
          md: a11y.audit ? demoteHeadings(auditMarkdown(a11y.audit, { maxNodes: 10 })) : null,
          findings: a11y.audit ? a11y.audit.violations.length > 0 : undefined,
          missing: "run the audit in Inspect › A11y",
        },
        {
          area: "Console errors",
          panel: "Inspect › Errors",
          md: errors.data ? errorsMarkdown({ installed: errors.data.installed, errors: errors.data.errors as CapturedError[] }, ctx) : null,
          missing: notRead(errors),
        },
        {
          area: "Web Vitals and loading",
          panel: "Inspect › Performance",
          md: perf.data ? perfMarkdown(perf.data, ctx) : null,
          missing: notRead(perf),
        },
        {
          area: "Third parties and SRI",
          panel: "Security › Third parties",
          md: surface ? thirdPartiesMarkdown(surface, ctx) : null,
          missing: "the page could not be read",
        },
        { area: "SEO", panel: "Inspect › SEO", md: meta.data ? seoMarkdown(meta.data, ctx) : null, missing: notRead(meta) },
        {
          area: "Headings",
          panel: "Inspect › Headings",
          md: headings.data ? headingsMarkdown(headings.data, ctx) : null,
          missing: notRead(headings),
        },
        {
          area: "Structured data",
          panel: "Inspect › JSON-LD",
          md: meta.data ? jsonLdMarkdown(analyzeJsonLd(meta.data.jsonLd, { vocab }), ctx) : null,
          missing: notRead(meta),
        },
      ];
      return parts;
    }
  };
  const copyForAgent = async () => {
    if (page.tabId === undefined) return;
    setCopying(true);
    try {
      const md = pageReportMarkdown(await gatherParts(page.tabId), {
        url: page.url,
        title: meta.data?.title,
        notCovered: [
          "secrets in this origin's script files (Security › Secrets)",
          "source maps and exposed files (Security › Exposed files)",
          "vulnerable libraries (Security › Libraries)",
          "broken links (Inspect › Links)",
          "robots.txt, sitemap and manifest (Inspect › Site files)",
          "cookie flags (Cache › Cookies)",
          "image weight and alt text (Page › Assets)",
        ],
      });
      const ok = await copyText(md);
      toast(ok ? "Fix list for your agent copied." : "The clipboard refused the copy.", !ok);
    } finally {
      setCopying(false);
    }
  };
  /** A print-ready page of the report in a new devkit tab (rendered locally; Chrome's dialog saves it as PDF). */
  const printReport = async () => {
    if (page.tabId === undefined) return;
    setPrinting(true);
    try {
      const parts = await gatherParts(page.tabId);
      const report: PrintReport = {
        title: meta.data?.title?.trim() || page.url,
        url: page.url,
        date: new Date().toISOString(),
        markdown: printReportMarkdown(
          rows.map((r) => ({ label: r.label, verdict: r.verdict })),
          parts,
          { url: page.url, title: meta.data?.title, date: new Date().toLocaleString("en-GB") },
        ),
      };
      await browser.storage.session.set({ [PRINT_REPORT_KEY]: report });
      await browser.tabs.create({ url: browser.runtime.getURL("/print.html") });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setPrinting(false);
    }
  };
  const rows: { panel: string; label: string; state: { loading: boolean; error: unknown }; verdict: Verdict | null }[] = [
    {
      panel: "headers",
      label: "Security headers",
      state: headers,
      verdict: headers.data ? securityVerdict(securityReport(headers.data.headers, headers.data.url)) : null,
    },
    { panel: "seo", label: "SEO", state: meta, verdict: meta.data ? seoVerdict(seoReport(meta.data)) : null },
    {
      panel: "headings",
      label: "Headings",
      state: headings,
      verdict: headings.data ? headingsVerdict(headingIssues(headings.data), headings.data.headings.length) : null,
    },
    {
      panel: "jsonld",
      label: "Structured data",
      state: meta,
      verdict: meta.data ? jsonLdVerdict(analyzeJsonLd(meta.data.jsonLd)) : null,
    },
    { panel: "errors", label: "Console errors", state: errors, verdict: errors.data ? errorsVerdict(errors.data) : null },
    { panel: "a11y", label: "Accessibility", state: meta.error ? meta : a11y.state, verdict: a11y.verdict },
    { panel: "perf", label: "Web Vitals", state: perf, verdict: perf.data ? vitalsSummary(perf.data) : null },
  ];
  return (
    <Section
      title="Page report"
      actions={
        <>
          <Button size="small" busy={copying} disabled={!meta.data && !headers.data} onClick={copyForAgent}>
            Copy for agent
          </Button>
          <Button
            size="small"
            busy={printing}
            disabled={!meta.data && !headers.data}
            onClick={printReport}
            title="Opens a print-ready page of the report; nothing is uploaded"
          >
            Print / Save as PDF
          </Button>
          <Button
            size="small"
            onClick={() => {
              for (const s of [meta, headers, perf, errors, headings]) s.run();
              a11y.run();
            }}
          >
            Refresh
          </Button>
        </>
      }
    >
      <ul className="report" aria-label="Page report">
        {rows.map((r) => (
          <ReportRow
            key={r.panel}
            label={r.label}
            verdict={r.verdict}
            loading={r.state.loading}
            error={r.state.error}
            onOpen={go ? () => go({ panel: r.panel }) : undefined}
            openLabel={`Open ${r.label}`}
          />
        ))}
      </ul>
    </Section>
  );
}

export function Overview() {
  const page = usePage();
  const signals = useInPage(collectTechSignals, [], "MAIN");
  const meta = useInPage(collectMeta);
  const headers = useHeaders();
  const tech = useMemo(() => (signals.data ? detectTech(signals.data, headers.data?.headers) : []), [signals.data, headers.data]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof tech>();
    for (const t of tech) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return Array.from(m.entries());
  }, [tech]);
  const s = meta.data?.stats;
  return (
    <AccessGate>
      <PageReport meta={meta} headers={headers} />
      <Section
        title="Tech stack"
        actions={
          <Button
            size="small"
            onClick={() => {
              signals.run();
              headers.run();
            }}
          >
            Refresh
          </Button>
        }
      >
        <ErrorText error={signals.error} />
        {groups.length ? (
          <div className="stack">
            {groups.map(([cat, items]) => (
              <div key={cat} className="row">
                <span className="muted small" style={{ width: 82 }}>
                  {cat}
                </span>
                {items.map((t) => (
                  <span key={t.name} className="pill accent" title={t.evidence}>
                    {t.name}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <Empty>{signals.loading ? "Detecting…" : "Nothing recognized."}</Empty>
        )}
      </Section>
      {s ? (
        <Section title="Page">
          <div className="grid2">
            <Metric label="DOM elements" value={s.elements.toLocaleString()} level={s.elements > 3000 ? "warn" : undefined} />
            <Metric label="DOM depth" value={s.domDepth} level={s.domDepth > 32 ? "warn" : undefined} />
            <Metric label="HTML size" value={bytes(s.htmlBytes)} />
            <Metric label="Scripts" value={s.scripts} />
            <Metric label="Stylesheets" value={s.stylesheets} />
            <Metric label="Images" value={s.images} />
            <Metric label="Iframes" value={s.iframes} />
            <Metric label="Forms" value={s.forms} />
          </div>
          <KV
            rows={[
              ["URL", page.url],
              [
                "Status",
                headers.data
                  ? `${headers.data.status}${headers.data.redirected ? ` (redirected to ${headers.data.url})` : ""} · ${headers.data.ms} ms`
                  : "…",
              ],
              ["Language", meta.data?.lang || "–"],
              ["Charset", meta.data?.charset ?? "–"],
              ["Server", headers.data?.headers.server ?? "–"],
            ]}
          />
        </Section>
      ) : null}
    </AccessGate>
  );
}

const STATUS_TEXT: Record<BlockStatus, string> = { valid: "Valid", warning: "Warning", error: "Error" };
const STATUS_LEVEL = { valid: "good", warning: "warn", error: "bad" } as const;
const MODE_TEXT: Record<ValidateMode, string> = { rich: "Rich Results", schema: "Schema.org" };
type OpenOn = "code" | "tree";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function blockVerdict(block: JsonLdBlock, mode: ValidateMode): Verdict {
  const findings = blockFindings(block).filter((f) => inMode(f, mode));
  const e = findings.filter((f) => f.severity === "error").length;
  const w = findings.filter((f) => f.severity === "warn").length;
  const parts = [e ? plural(e, "error") : "", w ? plural(w, "warning") : ""].filter(Boolean);
  return { level: e ? "bad" : w ? "warn" : "good", text: parts.join(", ") || "No problem" };
}

/** Pressed-state chips for a small choice (validation mode, how blocks open). */
export function Choice<T extends string>({
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
    <fieldset className="as-chips jl-choice" aria-label={label}>
      <span className="small muted" aria-hidden="true">
        {label}
      </span>
      {options.map(([v, text]) => (
        <button key={v} type="button" className="as-chip" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

function BlockView({
  block,
  anchor,
  mode,
  openOn,
  query,
}: {
  block: JsonLdBlock;
  anchor?: boolean;
  mode: ValidateMode;
  openOn: OpenOn;
  query?: string;
}) {
  const [view, setView] = useState<OpenOn>(openOn);
  useEffect(() => setView(openOn), [openOn]);
  const all = blockFindings(block);
  const shown = all.filter((f) => inMode(f, mode));
  const hidden = all.filter((f) => !inMode(f, mode) && f.severity !== "info").length;
  const rank = { error: 0, warn: 1, info: 2 } as const;
  const groups = groupFindings(shown).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const badges = blockBadges(block, mode);
  const pretty = blockJson(block);
  const e = shown.filter((f) => f.severity === "error").length;
  const w = shown.filter((f) => f.severity === "warn").length;
  const n = shown.length - e - w;
  const types = new Map<string, number>();
  for (const node of block.nodes) for (const t of node.types) types.set(t, (types.get(t) ?? 0) + 1);
  const other: ValidateMode = mode === "rich" ? "schema" : "rich";
  return (
    <div className="card stack jl-block" id={anchor ? `jsonld-block-${block.index}` : undefined}>
      <div className="row">
        <b>Block #{block.index + 1}</b>
        <span className={`pill t-${STATUS_LEVEL[badges.status]}`}>
          <Dot level={STATUS_LEVEL[badges.status]} /> {STATUS_TEXT[badges.status]}
        </span>
        {badges.experimental ? (
          <span className="pill t-warn" title="Uses pending Schema.org terms: they may still change or be dropped.">
            Experimental
          </span>
        ) : null}
        {badges.unsupported.map((u) => (
          <span key={u.type} className="pill" title={u.note}>
            Not supported: {u.type}
          </span>
        ))}
        {Array.from(types.entries()).map(([t, count]) => {
          const href = schemaDocUrl(t);
          const text = `${t}${count > 1 ? ` ×${count}` : ""}`;
          return href ? (
            <a key={t} className="pill accent" href={href} target="_blank" rel="noreferrer" title={`${t} on schema.org`}>
              {text}
            </a>
          ) : (
            <span key={t} className="pill accent">
              {text}
            </span>
          );
        })}
      </div>
      <div className="row">
        {block.ok ? (
          <Choice
            label="View"
            value={view}
            options={[
              ["code", "Code"],
              ["tree", "Tree"],
            ]}
            onChange={setView}
          />
        ) : null}
        <span className="grow" />
        <CopyButton text={pretty} label="Copy JSON" />
        <CopyButton text={scriptTag(block)} label="Copy <script>" />
        <Button size="small" onClick={() => download(blockFileName(block), pretty, block.ok ? "application/ld+json" : "text/plain")}>
          Download
        </Button>
      </div>
      {!block.ok && block.error ? (
        <Notice kind="bad">{block.error === "Empty script" ? "The script is empty." : `Invalid JSON, ${block.error}`}</Notice>
      ) : null}
      {view === "tree" && block.ok ? (
        <div className="tree">
          <JsonTree value={block.value} open={3} highlight={query} />
        </div>
      ) : (
        <div className="code-wrap">
          <pre className="code jl-code">
            <Highlight text={pretty} query={query} />
          </pre>
        </div>
      )}
      {groups.length ? (
        <details className="jl-findings">
          <summary>
            <Dot level={e ? "bad" : w ? "warn" : "info"} />{" "}
            <span>
              Findings:{" "}
              {[e ? plural(e, "error") : "", w ? plural(w, "warning") : "", n ? plural(n, "note") : ""].filter(Boolean).join(", ")}
            </span>
          </summary>
          <ul className="list">
            {groups.map((g) => (
              <li key={`${g.rule}|${g.severity}|${g.message}`} className="small">
                <Dot level={g.severity === "error" ? "bad" : g.severity} /> {g.message}{" "}
                {g.paths.length > 1 ? (
                  <details className="jl-paths">
                    <summary>
                      <span className="pill">×{g.paths.length}</span>
                    </summary>
                    <ul className="mono muted">
                      {g.paths.map((p, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the same path can repeat
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <span className="muted mono">{g.paths[0]}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="small t-good">No problem found.</div>
      )}
      {hidden ? (
        <div className="small muted">
          {plural(hidden, "more finding")} in {MODE_TEXT[other]} mode.
        </div>
      ) : null}
    </div>
  );
}

function VocabNote({ vocab, error }: { vocab: SchemaVocab | undefined; error: unknown }) {
  if (error) return <Notice kind="warn">The Schema.org vocabulary did not load: the vocabulary checks are off.</Notice>;
  if (!vocab) return null;
  return (
    <p className="small muted" style={{ margin: 0 }}>
      Checked locally against the{" "}
      <a href={vocab.source.url} target="_blank" rel="noreferrer">
        Schema.org
      </a>{" "}
      {vocab.source.version} vocabulary ({vocab.source.date}) ·{" "}
      <a href="/schema-vocab.LICENSE.txt" target="_blank" rel="noreferrer">
        {vocab.source.license}
      </a>
    </p>
  );
}

export function JsonLd() {
  const page = usePage();
  const meta = useInPage(collectMeta);
  const headers = useHeaders();
  const vocab = useAsync(() => loadSchemaVocab(), []);
  const [mode, setMode] = useStored<ValidateMode>("jsonldMode", "rich");
  const [openOn, setOpenOn] = useStored<OpenOn>("jsonldOpenOn", "code");
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState("");
  const report = useMemo(() => (meta.data ? analyzeJsonLd(meta.data.jsonLd, { vocab: vocab.data }) : null), [meta.data, vocab.data]);
  const agentMd = useMemo(() => (report ? jsonLdMarkdown(report, { url: page.url }) : ""), [report, page.url]);
  const pasted = useMemo(
    () =>
      paste.trim()
        ? analyzeJsonLd([{ raw: paste.replace(/^\s*<script[^>]*>|<\/script>\s*$/g, ""), index: 0 }], { vocab: vocab.data })
        : null,
    [paste, vocab.data],
  );
  const signals = meta.data ? indexingSignals(meta.data, headers.data?.headers) : null;
  const counts = report ? reportCounts(report, mode) : null;
  const q = query.trim().toLowerCase();
  const blocks = report ? report.blocks.filter((b) => !q || blockJson(b).toLowerCase().includes(q)) : [];
  const none = <span className="muted">None</span>;
  const xRobots = headers.loading ? (
    <span className="muted">Reading…</span>
  ) : headers.error ? (
    <span className="muted">Not read</span>
  ) : (
    (signals?.xRobotsTag ?? none)
  );
  return (
    <>
      <AccessGate>
        <ErrorText error={meta.error} />
        {report && counts && signals ? (
          <Section
            title="Structured data"
            actions={
              <>
                <Button size="small" onClick={meta.run}>
                  Refresh
                </Button>
                <CopyButton text={agentMd} label="Copy for agent" />
                <a className="btn small" href={richResultsTestUrl(page.url)} target="_blank" rel="noreferrer">
                  Rich Results Test
                </a>
                <a className="btn small" href={schemaValidatorUrl(page.url)} target="_blank" rel="noreferrer">
                  Schema validator
                </a>
              </>
            }
          >
            <KV
              rows={[
                ["Page URL", page.url],
                ["Canonical", signals.canonical ?? none],
                ["Robots", signals.robots ?? none],
                ["X-Robots-Tag", xRobots],
              ]}
            />
            <div className="row jl-controls">
              <Choice
                label="Validate"
                value={mode}
                options={[
                  ["rich", MODE_TEXT.rich],
                  ["schema", MODE_TEXT.schema],
                ]}
                onChange={setMode}
              />
              <Choice
                label="Open blocks on"
                value={openOn}
                options={[
                  ["code", "Code"],
                  ["tree", "Tree"],
                ]}
                onChange={setOpenOn}
              />
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {mode === "rich"
                ? "Google's rich results rules (required and recommended properties) and value formats."
                : "Every type, property and enumeration value against the Schema.org vocabulary, and value formats."}
            </p>
            <div className="grid2">
              <Metric label="JSON-LD blocks" value={report.blocks.length} />
              <Metric label="Errors" value={counts.error} level={counts.error ? "bad" : "good"} />
              <Metric label="Warnings" value={counts.warn} level={counts.warn ? "warn" : "good"} />
              <Metric label="Microdata types" value={meta.data?.microdataTypes.length ?? 0} />
            </div>
            {report.types.length ? (
              <div className="row">
                {report.types.map((t) => (
                  <span key={t.type} className="pill accent">
                    {t.type} ×{t.count}
                  </span>
                ))}
              </div>
            ) : null}
            {meta.data?.microdataTypes.length ? <div className="small muted">Microdata: {meta.data.microdataTypes.join(", ")}</div> : null}
            {report.blocks.length > 1 ? (
              <ul className="report" aria-label="Blocks at a glance">
                {report.blocks.map((b) => (
                  <ReportRow
                    key={b.index}
                    label={`Block #${b.index + 1}${b.nodes.length ? ` · ${b.nodes[0]!.types.join(", ")}` : ""}`}
                    verdict={blockVerdict(b, mode)}
                    onOpen={() => document.getElementById(`jsonld-block-${b.index}`)?.scrollIntoView({ block: "start" })}
                    openLabel={`Go to block #${b.index + 1}`}
                  />
                ))}
              </ul>
            ) : null}
            {report.blocks.length ? (
              <input
                type="search"
                aria-label="Search the blocks"
                placeholder="Search types, properties and values"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            {!report.blocks.length ? (
              <Empty>No JSON-LD on this page. The AI tab can write one for you (“Review structured data”).</Empty>
            ) : blocks.length ? (
              blocks.map((b) => <BlockView key={b.index} block={b} anchor mode={mode} openOn={openOn} query={query} />)
            ) : (
              <Empty>No block contains “{query.trim()}”.</Empty>
            )}
            <VocabNote vocab={vocab.data} error={vocab.error} />
          </Section>
        ) : null}
      </AccessGate>
      <Section title="Validate a snippet" hint="Paste JSON-LD (with or without its <script> tag) to check it before shipping.">
        <textarea
          aria-label="JSON-LD snippet"
          rows={6}
          value={paste}
          placeholder='{"@context":"https://schema.org","@type":"Product",…}'
          onChange={(e) => setPaste(e.target.value)}
        />
        {pasted?.blocks[0] ? <BlockView block={pasted.blocks[0]} mode={mode} openOn={openOn} /> : null}
      </Section>
    </>
  );
}

export function Headers() {
  const page = usePage();
  const headers = useHeaders();
  const sec = headers.data ? securityReport(headers.data.headers, headers.data.url) : null;
  const cache = headers.data ? cachingReport(headers.data.headers) : null;
  const [query, setQuery] = useState("");
  const raw = headers.data ? filterHeaders(headers.data.headers, "") : [];
  const shown = headers.data ? filterHeaders(headers.data.headers, query) : [];
  const agentMd = useMemo(() => (headers.data ? headersMarkdown(headers.data, { url: page.url }) : ""), [headers.data, page.url]);
  const report = useMemo(() => (headers.data ? headersTextReport(headers.data) : ""), [headers.data]);
  return (
    <AccessGate>
      <ErrorText error={headers.error} />
      {sec && headers.data ? (
        <>
          <Section
            title="Security headers"
            actions={
              <>
                <Button size="small" onClick={headers.run}>
                  Refresh
                </Button>
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            }
            hint="The document is fetched again from devkit with your cookies; Set-Cookie is hidden by the browser."
          >
            <div className="score-head">
              <div className={`grade t-${sec.score >= 75 ? "good" : sec.score >= 45 ? "warn" : "bad"}`}>{sec.grade}</div>
              <div className="stack grow" style={{ gap: 6 }}>
                <div className="row">
                  <b className="viz-num">{sec.score}/100</b>
                  <span className="muted small">
                    HTTP {headers.data.status} · {headers.data.ms} ms
                  </span>
                </div>
                <ScoreMeter score={sec.score} grade={sec.grade} />
              </div>
            </div>
            <CheckSummary checks={sec.checks} />
            <Checks checks={sec.checks} />
          </Section>
          <Section title="Caching & delivery">{cache ? <Checks checks={cache} /> : null}</Section>
          <Section
            title={`Response headers (${raw.length})`}
            actions={
              <>
                <CopyButton text={raw.map(([k, v]) => `${k}: ${v}`).join("\n")} label="Copy all" />
                <CopyButton text={report} label="Copy report" />
              </>
            }
          >
            <input
              type="search"
              placeholder="Search headers by name or value"
              aria-label="Search headers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() ? (
              <p className="small muted" style={{ margin: 0 }}>
                {shown.length} of {raw.length} match
              </p>
            ) : null}
            {shown.length ? (
              <KV
                rows={shown.map(([k, v]) => [<Highlight key={k} text={k} query={query} />, <Highlight key={k} text={v} query={query} />])}
              />
            ) : (
              <Empty>No header matches.</Empty>
            )}
          </Section>
        </>
      ) : (
        <Empty>{headers.loading ? `Fetching ${page.url}…` : ""}</Empty>
      )}
    </AccessGate>
  );
}

const NOT_MEASURED: Record<VitalName, string> = {
  lcp: "The page is still loading, or it loaded in a background tab.",
  inp: "No interaction yet: click, tap or type in the page, then refresh.",
  cls: "Layout shifts are not reported in this tab.",
  fcp: "The page has not painted, or it loaded in a background tab.",
  ttfb: "No navigation entry: the page may have been restored from the back/forward cache.",
};
const KIND_SHORT: Record<ResourceKind, string> = { script: "JS", style: "CSS", font: "Font", image: "Img", fetch: "Fetch", other: "Other" };
const WATERFALL_ROWS = 25;

function VitalRow({ name, value }: { name: VitalName; value: number | null }) {
  const go = useNav();
  const t = VITALS[name];
  const rating = rateVital(name, value);
  const scale = vitalScale(name, value);
  const text = formatVital(name, value);
  const threshold = (n: number) => (t.unitless ? String(n) : msLabel(n));
  return (
    <li className="vital">
      <div className="vital-head">
        <b>{t.label}</b>
        <span className="vital-name" title={name === "inp" ? `${t.name}, slowest so far` : t.name}>
          {name === "inp" ? `${t.name}, slowest so far` : t.name}
        </span>
        {rating ? <span className="vital-value">{text}</span> : null}
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
          ticks={[threshold(t.good), threshold(t.poor)]}
          label={`${t.label} ${text}: ${RATING_TEXT[rating]}. Good up to ${threshold(t.good)}, poor above ${threshold(t.poor)}.`}
        />
      ) : (
        <p className="vital-why">{NOT_MEASURED[name]}</p>
      )}
      {name === "inp" && go ? (
        <Button variant="ghost" size="small" className="vital-link" onClick={() => go({ panel: "responsiveness" })}>
          Find the slow interactions and their scripts
        </Button>
      ) : null}
    </li>
  );
}

export function Perf() {
  const page = usePage();
  const perf = useInPage(collectPerf);
  const [sort, setSort] = useState<WaterfallSort>("start");
  const [all, setAll] = useState(false);
  const p = perf.data;
  const nav = useMemo(() => (p?.navigation ? navigationPhases(p.navigation) : null), [p]);
  const navAxis = nav ? niceTicks(nav.end, 2) : null;
  const breakdown = useMemo(() => resourceBreakdown(p?.resources ?? []), [p]);
  const [field, setField] = useState<string>();
  const agentMd = useMemo(() => (p ? perfMarkdown(p, { url: page.url, field }) : ""), [p, page.url, field]);
  const waterfall = useMemo(
    () =>
      p ? waterfallLayout(p.resources, { sort, limit: all ? undefined : WATERFALL_ROWS, markers: nav?.markers.map((m) => m.at) }) : null,
    [p, sort, all, nav],
  );
  const byBytes = breakdown.bytes > 0;
  const kindShares = shares(breakdown.kinds.map((k) => (byBytes ? k.bytes : k.count)));
  const kindParts: Part[] = breakdown.kinds.map((k, i) => ({
    key: k.kind,
    label: k.label,
    value: byBytes ? k.bytes : k.count,
    color: KIND_COLOR[k.kind],
    detail: `${k.count} · ${bytes(k.bytes)} · ${percent(kindShares[i]!)}`,
  }));
  return (
    <AccessGate>
      <ErrorText error={perf.error} />
      {p ? (
        <>
          <Section
            title="Web Vitals"
            actions={
              <>
                <Button size="small" onClick={perf.run}>
                  Refresh
                </Button>
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            }
            hint="Measured in this tab from buffered entries, on web.dev's good / needs improvement / poor thresholds. Field data (CrUX) can differ."
          >
            <ul className="vitals">
              {vitalsOf(p).map((v) => (
                <VitalRow key={v.name} name={v.name} value={v.value} />
              ))}
            </ul>
            <div className="small muted">
              Long tasks (main thread blocked over 50 ms):{" "}
              <span className={`viz-num${p.longTasks.total > 300 ? " t-warn" : ""}`}>
                {p.longTasks.count ? `${p.longTasks.count} · ${msText(p.longTasks.total)}` : "none"}
              </span>
            </div>
          </Section>
          <CruxField lab={p} onMarkdown={setField} />
          {p.navigation && nav && navAxis ? (
            <Section title="Navigation timing" hint="The document request, from navigation start.">
              <Timeline
                rows={nav.phases.map((ph) => ({
                  key: ph.id,
                  label: ph.label,
                  start: ph.start,
                  end: ph.end,
                  value: msText(ph.end - ph.start),
                  title: `${ph.label}: ${msText(ph.start)} → ${msText(ph.end)}`,
                }))}
                markers={nav.markers.map((m) => ({ key: m.id, label: m.label, at: m.at, value: msText(m.at) }))}
                end={navAxis.end}
                ticks={navAxis.ticks}
                label={`Navigation timeline. ${nav.phases.map((ph) => `${ph.label} ${msText(ph.end - ph.start)}`).join(", ")}. ${nav.markers.map((m) => `${m.label} at ${msText(m.at)}`).join(", ")}.`}
              />
              <div className="small muted">
                Document: {bytes(p.navigation.transfer)} transferred, {bytes(p.navigation.decoded)} decoded
              </div>
              <details>
                <summary className="small muted">All timings</summary>
                <KV
                  rows={[
                    ["Redirect", msText(p.navigation.redirect)],
                    ["DNS", msText(p.navigation.dns)],
                    ["Connect (TLS)", `${msText(p.navigation.connect)} (${msText(p.navigation.tls)})`],
                    ["TTFB", msText(p.navigation.ttfb)],
                    ["Download", msText(p.navigation.download)],
                    ["DOM interactive", msText(p.navigation.domInteractive)],
                    ["DOMContentLoaded", msText(p.navigation.domContentLoaded)],
                    ["Load", msText(p.navigation.load)],
                    ["Document", `${bytes(p.navigation.transfer)} transferred, ${bytes(p.navigation.decoded)} decoded`],
                  ]}
                />
              </details>
            </Section>
          ) : null}
          <Section
            title={`Resources (${p.resources.length}, ${bytes(breakdown.bytes)})`}
            hint="0 B: served from cache, or cross-origin without Timing-Allow-Origin."
          >
            {breakdown.kinds.length ? (
              <>
                <SegmentBar
                  parts={kindParts}
                  label={`${byBytes ? "Bytes" : "Requests"} by type: ${kindParts.map((k) => `${k.label} ${k.detail}`).join(", ")}`}
                />
                <Legend parts={kindParts} />
                {byBytes ? null : <div className="small muted">No byte counts available: the bar splits requests by count.</div>}
              </>
            ) : (
              <Empty>No resource loaded besides the document.</Empty>
            )}
            {waterfall?.rows.length ? (
              <>
                <div className="row">
                  <h3 className="grow">Waterfall</h3>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as WaterfallSort)}
                    style={{ width: "auto" }}
                    aria-label="Sort requests"
                  >
                    <option value="start">by start time</option>
                    <option value="transfer">by size</option>
                    <option value="duration">by duration</option>
                  </select>
                </div>
                <Waterfall
                  items={waterfall.rows.map((r, i) => ({
                    key: `${i}:${r.item.name}`,
                    name: shortUrl(r.item.name),
                    url: r.item.name,
                    kind: r.kind,
                    kindLabel: KIND_SHORT[r.kind],
                    left: r.left,
                    width: r.width,
                    meta: `${bytes(r.item.transfer)} · ${msText(r.end - r.start)}`,
                    summary: `${KIND_SHORT[r.kind]} ${r.item.name}: starts at ${msText(r.start)}, takes ${msText(r.end - r.start)}, ${bytes(r.item.transfer)} transferred`,
                  }))}
                  ticks={waterfall.ticks}
                  end={waterfall.end}
                  label={`Request waterfall, ${waterfall.rows.length} of ${waterfall.total} requests, 0 to ${msLabel(waterfall.end)}`}
                  more={
                    waterfall.total > WATERFALL_ROWS ? (
                      <Button size="small" onClick={() => setAll(!all)}>
                        {all ? `Show the first ${WATERFALL_ROWS}` : `Show all ${waterfall.total}`}
                      </Button>
                    ) : null
                  }
                />
              </>
            ) : null}
          </Section>
        </>
      ) : (
        <Empty>{perf.loading ? "Measuring…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

export async function enableErrorCapture(): Promise<boolean> {
  if (!(await ensurePermission({ origins: [ALL_SITES] }))) return false;
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: ERROR_SCRIPT_IDS });
  if (existing.length) return true;
  await browser.scripting.registerContentScripts([
    {
      id: "devkit-errors-main",
      js: ["content-scripts/errors-main.js"],
      matches: ["<all_urls>"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
      persistAcrossSessions: true,
    },
    {
      id: "devkit-errors-relay",
      js: ["content-scripts/errors-relay.js"],
      matches: ["<all_urls>"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ] as never);
  return true;
}

export async function disableErrorCapture(): Promise<void> {
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: ERROR_SCRIPT_IDS });
  if (existing.length) await browser.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

export function Errors() {
  const page = usePage();
  const toast = useToast();
  const errors = useInPage(readErrors, [], "MAIN");
  const registered = useAsync(async () => (await browser.scripting.getRegisteredContentScripts({ ids: ERROR_SCRIPT_IDS })).length > 0, []);
  const list = (errors.data?.errors ?? []) as CapturedError[];
  const agentMd = useMemo(
    () =>
      errors.data
        ? errorsMarkdown({ installed: errors.data.installed, errors: errors.data.errors as CapturedError[] }, { url: page.url })
        : "",
    [errors.data, page.url],
  );
  return (
    <AccessGate>
      <Section
        title={`Console errors (${list.reduce((s, e) => s + e.count, 0)})`}
        actions={
          <>
            <Button size="small" onClick={errors.run}>
              Refresh
            </Button>
            {errors.data ? <CopyButton text={agentMd} label="Copy for agent" /> : null}
            <Button
              size="small"
              onClick={async () => {
                if (page.tabId !== undefined) await runInTab(page.tabId, clearErrors, [], "MAIN");
                errors.run();
              }}
            >
              Clear
            </Button>
          </>
        }
      >
        {registered.data ? (
          <Notice kind="good">
            <span className="grow small">Capture runs on every page from the first script; the badge shows the count.</span>
            <Button
              size="small"
              onClick={async () => {
                await disableErrorCapture();
                registered.run();
              }}
            >
              Turn off
            </Button>
          </Notice>
        ) : (
          <Notice kind="warn">
            <span className="grow small">
              Errors are only seen from the moment devkit listens. Capture them on every page from the start (needs access to all sites):
            </span>
            <Button
              size="small"
              variant="primary"
              onClick={async () => {
                if (await enableErrorCapture()) {
                  toast("Error capture on: reload the page to catch its startup errors.");
                  registered.run();
                } else toast("devkit needs access to all sites for that.", true);
              }}
            >
              Capture on all pages
            </Button>
          </Notice>
        )}
        {errors.data && !errors.data.installed ? (
          <Notice>
            <span className="grow small">Not listening on this page yet.</span>
            <Button
              size="small"
              onClick={async () => {
                if (page.tabId !== undefined) await runInTab(page.tabId, installErrorCapture, [], "MAIN");
                errors.run();
              }}
            >
              Listen now
            </Button>
            <Button size="small" onClick={() => page.tabId !== undefined && browser.tabs.reload(page.tabId)}>
              Reload
            </Button>
          </Notice>
        ) : null}
        <ErrorText error={errors.error} />
        {list.length ? (
          <ul className="list">
            {list.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: capture order
              <li key={i} className="stack" style={{ gap: 2 }}>
                <div className="row">
                  <span className={`pill ${e.kind === "console" ? "" : "accent"}`}>{e.kind}</span>
                  {e.count > 1 ? <span className="pill">×{e.count}</span> : null}
                  <span className="muted small">{new Date(e.time).toLocaleTimeString()}</span>
                </div>
                <div className="mono small t-bad break">{e.message}</div>
                {e.source ? (
                  <div className="mono small muted break">
                    {e.source}
                    {e.line ? `:${e.line}:${e.column ?? 0}` : ""}
                  </div>
                ) : null}
                {e.stack ? (
                  <details>
                    <summary className="small muted">Stack</summary>
                    <pre className="code small">{e.stack}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{errors.loading ? "Reading…" : "No error captured."}</Empty>
        )}
      </Section>
    </AccessGate>
  );
}

interface LinkResult {
  href: string;
  text: string;
  status: number | "error" | "pending";
  detail?: string;
}

async function checkLink(href: string, signal: AbortSignal): Promise<{ status: number | "error"; detail?: string }> {
  const attempt = async (method: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    signal.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await fetch(href, { method, redirect: "follow", credentials: "omit", cache: "no-store", signal: ctrl.signal });
      res.body?.cancel().catch(() => undefined);
      return { status: res.status, detail: res.redirected ? `→ ${res.url}` : undefined };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const head = await attempt("HEAD");
    return head.status === 405 || head.status === 403 || head.status === 501 ? await attempt("GET") : head;
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e) };
  }
}

/** Checked links by outcome on one bar; the pending part shrinks as the check runs. */
function LinkStatus({ results }: { results: LinkResult[] }) {
  const b = linkBuckets(results);
  const parts: Part[] = [
    { key: "ok", label: "OK", value: b.ok, color: LEVEL_COLOR.good, detail: b.ok, level: "good" },
    { key: "redirect", label: "Redirected", value: b.redirect, color: LEVEL_COLOR.warn, detail: b.redirect, level: "warn" },
    { key: "broken", label: "Broken", value: b.broken, color: LEVEL_COLOR.bad, detail: b.broken, level: "bad" },
    { key: "pending", label: "Pending", value: b.pending, color: "var(--bg-3)", detail: b.pending, level: "none" },
  ];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <SegmentBar parts={parts} label={`${results.length} links: ${parts.map((p) => `${p.value} ${p.label.toLowerCase()}`).join(", ")}`} />
      <Legend parts={parts.filter((p) => p.value > 0 || p.key !== "pending")} />
    </div>
  );
}

export function Links() {
  const page = usePage();
  const toast = useToast();
  const links = useInPage(collectLinks);
  const [results, setResults] = useState<LinkResult[]>([]);
  const [running, setRunning] = useState<AbortController | null>(null);
  const [onlyBad, setOnlyBad] = useState(true);
  // The check in progress; replaced (and aborted) when the page changes or the panel closes.
  const current = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per page
  useEffect(() => {
    current.current?.abort();
    current.current = null;
    setRunning(null);
    setResults([]);
  }, [page.tabId, page.url]);
  useEffect(() => () => current.current?.abort(), []);
  const start = async () => {
    if (!(await ensurePermission({ origins: [ALL_SITES] }))) return toast("Checking links on other sites needs access to all sites.", true);
    const list = links.data ?? [];
    const ctrl = new AbortController();
    current.current = ctrl;
    setRunning(ctrl);
    const state: LinkResult[] = list.map((l) => ({ href: l.href, text: l.text, status: "pending" }));
    setResults([...state]);
    let next = 0;
    const worker = async () => {
      while (next < state.length && !ctrl.signal.aborted) {
        const i = next++;
        const r = await checkLink(state[i]!.href, ctrl.signal);
        // Stopped mid-request: leave the link pending rather than report the abort as a failure.
        if (ctrl.signal.aborted || current.current !== ctrl) return;
        state[i] = { ...state[i]!, ...r };
        setResults([...state]);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (current.current === ctrl) setRunning(null);
  };
  const bad = results.filter((r) => r.status === "error" || (typeof r.status === "number" && r.status >= 400));
  const done = results.filter((r) => r.status !== "pending").length;
  const shown = onlyBad ? bad : results;
  const agentMd = useMemo(() => (done ? linksMarkdown(results, { url: page.url }) : ""), [done, results, page.url]);
  return (
    <AccessGate>
      <Section
        title={`Links (${links.data?.length ?? 0} unique)`}
        actions={
          running ? (
            <Button size="small" onClick={() => running.abort()}>
              Stop
            </Button>
          ) : (
            <>
              <Button size="small" variant="primary" disabled={!links.data?.length} onClick={start}>
                Check all
              </Button>
              {done ? <CopyButton text={agentMd} label="Copy for agent" /> : null}
            </>
          )
        }
        hint="Same-page anchors are skipped. Requests go from devkit without cookies, 6 at a time."
      >
        {results.length ? (
          <>
            <div className="row small">
              <span aria-live="polite">
                {done}/{results.length} checked · <b className={bad.length ? "t-bad" : "t-good"}>{bad.length} broken</b>
              </span>
              <span className="grow" />
              <label className="check">
                <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> Only broken
              </label>
              {bad.length ? <CopyButton text={bad.map((b) => `${b.status}\t${b.href}`).join("\n")} label="Copy broken" /> : null}
            </div>
            <LinkStatus results={results} />
            <ul className="list">
              {shown.slice(0, 500).map((r) => (
                <li key={r.href} className="row small">
                  <span
                    className={`pill ${r.status === "pending" ? "" : r.status === "error" || r.status >= 400 ? "t-bad" : r.status >= 300 ? "t-warn" : "t-good"}`}
                    style={{ minWidth: 44 }}
                  >
                    {r.status === "pending" ? "…" : r.status}
                  </span>
                  <a
                    className="grow ellipsis mono"
                    href={r.href}
                    target="_blank"
                    rel="noreferrer"
                    title={r.text ? `${r.href}\n${r.text}` : r.href}
                  >
                    {r.href}
                  </a>
                  {r.detail ? (
                    <span className="muted ellipsis" style={{ maxWidth: 140 }} title={r.detail}>
                      {r.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty>{links.loading ? "Collecting links…" : "Press “Check all”."}</Empty>
        )}
      </Section>
    </AccessGate>
  );
}

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
  }
}

function PaletteStrip({ colors }: { colors: { color: string; count: number }[] }) {
  const top = colors.slice(0, 16).map((c) => {
    const rgba = parseColor(c.color);
    return { ...c, hex: rgba ? toHex(rgba) : c.color };
  });
  const share = shares(top.map((c) => c.count));
  return (
    <SwatchStrip
      colors={top}
      label={`The ${top.length} most used colors by share: ${top
        .slice(0, 6)
        .map((c, i) => `${c.hex} ${percent(share[i]!)}`)
        .join(", ")}${top.length > 6 ? ", …" : ""}`}
    />
  );
}

export function Fonts() {
  const page = usePage();
  const data = useInPage(collectFontsColors);
  const toast = useToast();
  const [picked, setPicked] = useStored<string[]>("pickedColors", []);
  const [fg, setFg] = useState("#111111");
  const [bg, setBg] = useState("#ffffff");
  const ratio = (() => {
    const a = parseColor(fg);
    const b = parseColor(bg);
    return a && b ? contrast(a, b) : null;
  })();
  const pair = ratio !== null;
  const agentMd = useMemo(
    () => (data.data ? fontsMarkdown(data.data, { url: page.url, contrast: pair ? { fg, bg } : undefined }) : ""),
    [data.data, page.url, pair, fg, bg],
  );
  const pick = async () => {
    if (!window.EyeDropper) return toast("The EyeDropper API is not available here.", true);
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      await setPicked([sRGBHex, ...picked.filter((c) => c !== sRGBHex)].slice(0, 16));
      await navigator.clipboard.writeText(sRGBHex).catch(() => undefined);
      toast(`${sRGBHex} copied.`);
    } catch {
      /* cancelled */
    }
  };
  return (
    <>
      <Section
        title="Color picker"
        actions={
          <Button size="small" variant="primary" onClick={pick}>
            Pick a color
          </Button>
        }
        hint="Picks any pixel on screen and copies its hex."
      >
        {picked.length ? (
          <div className="row">
            {picked.map((c) => (
              <button key={c} type="button" className="btn small" onClick={() => navigator.clipboard.writeText(c)} title="Copy">
                <span className="swatch" style={{ background: c }} />
                <span className="mono">{c}</span>
              </button>
            ))}
            <Button size="small" variant="ghost" onClick={() => setPicked([])}>
              Clear
            </Button>
          </div>
        ) : null}
      </Section>
      <Section title="Contrast checker">
        <div className="row">
          <label className="field grow">
            Text
            <input value={fg} onChange={(e) => setFg(e.target.value)} />
          </label>
          <label className="field grow">
            Background
            <input value={bg} onChange={(e) => setBg(e.target.value)} />
          </label>
        </div>
        {ratio !== null ? (
          <div className="row">
            <div className="card" style={{ background: bg, color: fg, padding: "6px 12px" }}>
              Sample text Aa
            </div>
            <b>{ratio}:1</b>
            <span className={`pill ${ratio >= 4.5 ? "t-good" : "t-bad"}`}>AA {ratio >= 4.5 ? "pass" : "fail"}</span>
            <span className={`pill ${ratio >= 3 ? "t-good" : "t-bad"}`}>AA large {ratio >= 3 ? "pass" : "fail"}</span>
            <span className={`pill ${ratio >= 7 ? "t-good" : "t-bad"}`}>AAA {ratio >= 7 ? "pass" : "fail"}</span>
          </div>
        ) : (
          <Empty>Enter two colors (hex, rgb() or hsl()).</Empty>
        )}
      </Section>
      <AccessGate>
        <ErrorText error={data.error} />
        {data.data ? (
          <>
            <Section
              title="Font families in use"
              actions={
                <>
                  <Button size="small" onClick={data.run}>
                    Refresh
                  </Button>
                  <CopyButton text={agentMd} label="Copy for agent" />
                </>
              }
              hint="Text elements set in each family."
            >
              {data.data.families.length ? (
                <BarList
                  label="Font families by number of text elements"
                  rows={data.data.families.map((f) => ({ key: f.family, label: f.family, value: f.count, text: f.count.toLocaleString() }))}
                />
              ) : (
                <Empty>No text found.</Empty>
              )}
            </Section>
            <Section title={`Font faces (${data.data.fonts.length})`}>
              {data.data.fonts.length ? (
                <KV rows={data.data.fonts.map((f) => [f.family, `${f.weight} ${f.style} · ${f.status}`])} />
              ) : (
                <Empty>No web font: system fonts only.</Empty>
              )}
            </Section>
            <Section title="Page palette" hint="Most used text, background and border colors, widths by use. Click a color to copy it.">
              {data.data.colors.length ? <PaletteStrip colors={data.data.colors} /> : null}
              <div className="grid2">
                {data.data.colors.map((c) => {
                  const rgba = parseColor(c.color);
                  const hex = rgba ? toHex(rgba) : c.color;
                  return (
                    <button
                      key={c.color}
                      type="button"
                      className="btn small"
                      onClick={() => navigator.clipboard.writeText(hex)}
                      title={c.color}
                    >
                      <span className="swatch" style={{ background: c.color }} />
                      <span className="mono grow ellipsis">{hex}</span>
                      <span className="muted">{c.count}</span>
                    </button>
                  );
                })}
              </div>
            </Section>
          </>
        ) : null}
      </AccessGate>
    </>
  );
}

export async function fetchText(url: string): Promise<{ status: number; text: string; type: string }> {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") ?? "" };
}

export function SiteFiles() {
  const page = usePage();
  const [agent, setAgent] = useState("Googlebot");
  const [path, setPath] = useState(() => (page.url ? new URL(page.url).pathname : "/"));
  const robots = useAsync(async () => {
    if (!page.origin || !page.canScript) return null;
    const r = await fetchText(`${page.origin}/robots.txt`);
    return { ...r, parsed: r.status < 400 ? parseRobots(r.text) : null };
  }, [page.origin, page.canScript]);
  const sitemapUrl = robots.data?.parsed?.sitemaps[0] ?? (page.origin ? `${page.origin}/sitemap.xml` : "");
  const [sitemapInput, setSitemapInput] = useState("");
  const sitemap = useAsync(
    async () => {
      const url = sitemapInput || sitemapUrl;
      if (!url) return null;
      const r = await fetchText(url);
      return { url, status: r.status, parsed: r.status < 400 ? parseSitemap(r.text) : null };
    },
    [sitemapInput, sitemapUrl],
    Boolean(sitemapUrl),
  );
  const manifest = useAsync(async () => {
    if (page.tabId === undefined || !page.canScript) return null;
    const href = await runInTab(page.tabId, () => (document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null)?.href ?? null);
    if (!href) return { href: null };
    const r = await fetchText(href);
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(r.text);
    } catch {
      /* shown as invalid */
    }
    return { href, status: r.status, json };
  }, [page.tabId, page.url, page.canScript]);
  const verdict = robots.data?.parsed ? isAllowed(robots.data.parsed, agent, path) : null;
  const loaded = Boolean(robots.data || sitemap.data || manifest.data);
  const agentMd = useMemo(
    () =>
      loaded
        ? siteFilesMarkdown(
            { robots: robots.data ?? undefined, sitemap: sitemap.data ?? undefined, manifest: manifest.data ?? undefined },
            { url: page.url },
          )
        : "",
    [loaded, robots.data, sitemap.data, manifest.data, page.url],
  );
  return (
    <AccessGate>
      <Section
        title="robots.txt"
        actions={
          page.origin ? (
            <>
              <a className="btn small" href={`${page.origin}/robots.txt`} target="_blank" rel="noreferrer">
                Open
              </a>
              {loaded ? <CopyButton text={agentMd} label="Copy for agent" /> : null}
            </>
          ) : null
        }
      >
        <ErrorText error={robots.error} />
        {robots.data ? (
          robots.data.parsed ? (
            <>
              <div className="row">
                <input style={{ width: 120 }} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="User agent" />
                <input
                  className="grow"
                  style={{ width: "auto" }}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  aria-label="Path"
                />
                {verdict ? (
                  <span className={`pill ${verdict.allowed ? "t-good" : "t-bad"}`}>{verdict.allowed ? "allowed" : "blocked"}</span>
                ) : null}
              </div>
              {verdict?.rule ? <div className="small muted mono">{verdict.rule}</div> : null}
              <KV
                rows={robots.data.parsed.groups.map((g) => [
                  g.agents.join(", "),
                  [
                    ...g.disallow.map((d) => `Disallow: ${d}`),
                    ...g.allow.map((a) => `Allow: ${a}`),
                    g.crawlDelay ? `Crawl-delay: ${g.crawlDelay}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n") || "(no rule)",
                ])}
              />
              <details>
                <summary className="small muted">Source</summary>
                <Code text={robots.data.text} />
              </details>
            </>
          ) : (
            <Notice kind="warn">robots.txt answered HTTP {robots.data.status}: everything may be crawled.</Notice>
          )
        ) : null}
      </Section>
      <Section title="Sitemap">
        <input aria-label="Sitemap URL" placeholder={sitemapUrl} value={sitemapInput} onChange={(e) => setSitemapInput(e.target.value)} />
        <ErrorText error={sitemap.error} />
        {sitemap.data ? (
          sitemap.data.parsed ? (
            <>
              <div className="small">
                {sitemap.data.parsed.kind === "sitemapindex" ? "Sitemap index" : "URL set"} · {sitemap.data.parsed.urls.length} entries
              </div>
              <ul className="list">
                {sitemap.data.parsed.urls.slice(0, 200).map((u) => (
                  <li key={u.loc} className="row small">
                    {sitemap.data?.parsed?.kind === "sitemapindex" ? (
                      <button type="button" className="btn small" onClick={() => setSitemapInput(u.loc)}>
                        Open
                      </button>
                    ) : null}
                    <a className="grow ellipsis mono" href={u.loc} target="_blank" rel="noreferrer" title={u.loc}>
                      {u.loc}
                    </a>
                    {u.lastmod ? <span className="muted">{u.lastmod.slice(0, 10)}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Notice kind="warn">
              {sitemap.data.url} answered HTTP {sitemap.data.status}.
            </Notice>
          )
        ) : null}
      </Section>
      <Section title="Web app manifest">
        <ErrorText error={manifest.error} />
        {manifest.data ? (
          manifest.data.href ? (
            manifest.data.json ? (
              <>
                <div className="small mono muted break">{manifest.data.href}</div>
                <Checks
                  checks={manifestChecks(manifest.data.json).map((c) => ({
                    id: c.label,
                    label: c.label,
                    level: c.ok ? "good" : "warn",
                    detail: c.detail,
                  }))}
                />
                <details>
                  <summary className="small muted">JSON</summary>
                  <div className="tree">
                    <JsonTree value={manifest.data.json} />
                  </div>
                </details>
              </>
            ) : (
              <Notice kind="bad">
                The manifest at {manifest.data.href} is not valid JSON (HTTP {manifest.data.status}).
              </Notice>
            )
          ) : (
            <Empty>No &lt;link rel="manifest"&gt;.</Empty>
          )
        ) : null}
      </Section>
    </AccessGate>
  );
}

export function External() {
  const page = usePage();
  const toast = useToast();
  if (!page.origin) return <Empty>Open a web page.</Empty>;
  return (
    <>
      <p className="muted small break" style={{ margin: 0 }}>
        Open {page.url} in
      </p>
      {TOOL_GROUPS.map((group) => (
        <Section key={group} title={group}>
          <div className="grid2">
            {EXTERNAL_TOOLS.filter((t) => t.group === group).map((t) => (
              <a
                key={t.name}
                className="action"
                href={t.url(page.url)}
                target="_blank"
                rel="noreferrer"
                onClick={
                  t.pasteUrl
                    ? () => {
                        copyText(page.url).then((ok) => ok && toast(`URL copied: paste it in ${t.name}.`));
                      }
                    : undefined
                }
              >
                <strong>{t.name}</strong>
                <span>
                  {new URL(t.url(page.url)).host}
                  {t.pasteUrl ? " · URL copied to paste" : ""}
                  {t.note ? ` · ${t.note}` : ""}
                </span>
              </a>
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}
