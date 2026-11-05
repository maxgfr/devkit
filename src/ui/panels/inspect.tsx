import { useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { cachingReport, fetchHeaders, securityReport } from "../../lib/headers";
import { runInTab } from "../../lib/inject";
import { analyzeJsonLd, type JsonLdBlock, richResultsTestUrl, schemaValidatorUrl } from "../../lib/jsonld";
import { collectA11yHints, collectFontsColors, collectLinks, collectMeta, collectPerf, collectTechSignals } from "../../lib/page/collect";
import { clearErrors, ERROR_SCRIPT_IDS, installErrorCapture, readErrors } from "../../lib/page/errors";
import { ALL_SITES, ensurePermission } from "../../lib/permissions";
import { seoReport, socialPreview } from "../../lib/seo";
import { EXTERNAL_TOOLS, isAllowed, manifestChecks, parseRobots, parseSitemap } from "../../lib/site-files";
import { detectTech } from "../../lib/tech";
import { contrast, parseColor, toHex } from "../../lib/utils/color";
import type { CapturedError } from "../../lib/ai/context";
import {
  Button,
  bytes,
  Checks,
  Code,
  CopyButton,
  Dot,
  Empty,
  ErrorText,
  JsonTree,
  KV,
  Metric,
  msText,
  Notice,
  Section,
  useToast,
} from "../components";
import { useAsync, useStored } from "../hooks";
import { AccessGate, useInPage, usePage } from "../page";

export function useHeaders() {
  const page = usePage();
  return useAsync(async () => {
    if (!page.origin) throw new Error("Open a web page.");
    if (!page.canScript) throw new Error("devkit has no access to this page yet.");
    return fetchHeaders(page.url);
  }, [page.url, page.canScript]);
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

export function Seo() {
  const meta = useInPage(collectMeta);
  const snap = meta.data;
  const checks = useMemo(() => (snap ? seoReport(snap) : []), [snap]);
  const social = snap ? socialPreview(snap) : null;
  return (
    <AccessGate>
      <ErrorText error={meta.error} />
      {snap ? (
        <>
          <Section
            title="SEO checks"
            actions={
              <Button size="small" onClick={meta.run}>
                Refresh
              </Button>
            }
          >
            <Checks checks={checks} />
          </Section>
          {social ? (
            <Section title="Social preview">
              <div className="social">
                {social.image ? (
                  <img src={social.image} alt="" />
                ) : (
                  <div className="muted small" style={{ padding: 10 }}>
                    No og:image
                  </div>
                )}
                <div className="body">
                  <div className="site">{social.site}</div>
                  <b>{social.title}</b>
                  <div className="small muted">{social.description.slice(0, 200)}</div>
                </div>
              </div>
            </Section>
          ) : null}
          <Section title={`Headings (${snap.headings.length})`}>
            {snap.headings.length ? (
              <ul className="list">
                {snap.headings.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: document order
                  <li key={i} style={{ paddingLeft: (h.level - 1) * 12 }}>
                    <span className="pill">h{h.level}</span> {h.text || <i className="muted">(empty)</i>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No heading.</Empty>
            )}
          </Section>
          <Section title={`Meta tags (${snap.meta.length})`}>
            <KV rows={snap.meta.map((m) => [m.key, m.value])} />
          </Section>
          <Section title={`Links in <head> (${snap.links.length})`}>
            <KV rows={snap.links.map((l) => [`${l.rel}${l.hreflang ? ` (${l.hreflang})` : ""}${l.sizes ? ` ${l.sizes}` : ""}`, l.href])} />
          </Section>
        </>
      ) : (
        <Empty>{meta.loading ? "Reading the page…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

function BlockView({ block }: { block: JsonLdBlock }) {
  const [raw, setRaw] = useState(false);
  const findings = [...block.findings, ...block.nodes.flatMap((n) => n.findings)];
  const pretty = block.ok ? JSON.stringify(block.value, null, 2) : block.raw;
  return (
    <div className="card stack">
      <div className="row">
        <b>Block #{block.index + 1}</b>
        {block.nodes.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: document order
          <span key={i} className="pill accent">
            {n.types.join(", ")}
          </span>
        ))}
        <span className="grow" />
        <Button size="small" onClick={() => setRaw(!raw)}>
          {raw ? "Tree" : "Source"}
        </Button>
        <CopyButton text={pretty} />
      </div>
      {findings.length ? (
        <ul className="list">
          {findings.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: findings are ordered
            <li key={i} className="small">
              <Dot level={f.severity === "error" ? "bad" : f.severity} /> {f.message} <span className="muted mono">{f.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small t-good">No problem found.</div>
      )}
      {raw || !block.ok ? (
        <Code text={pretty} />
      ) : (
        <div className="tree">
          <JsonTree value={block.value} open={3} />
        </div>
      )}
    </div>
  );
}

export function JsonLd() {
  const page = usePage();
  const meta = useInPage(collectMeta);
  const [paste, setPaste] = useState("");
  const report = useMemo(() => (meta.data ? analyzeJsonLd(meta.data.jsonLd) : null), [meta.data]);
  const pasted = useMemo(
    () => (paste.trim() ? analyzeJsonLd([{ raw: paste.replace(/^\s*<script[^>]*>|<\/script>\s*$/g, ""), index: 0 }]) : null),
    [paste],
  );
  return (
    <>
      <AccessGate>
        <ErrorText error={meta.error} />
        {report ? (
          <Section
            title="Structured data"
            actions={
              <>
                <Button size="small" onClick={meta.run}>
                  Refresh
                </Button>
                <a className="btn small" href={richResultsTestUrl(page.url)} target="_blank" rel="noreferrer">
                  Rich Results Test
                </a>
                <a className="btn small" href={schemaValidatorUrl(page.url)} target="_blank" rel="noreferrer">
                  Schema validator
                </a>
              </>
            }
          >
            <div className="grid2">
              <Metric label="JSON-LD blocks" value={report.blocks.length} />
              <Metric label="Errors" value={report.counts.error} level={report.counts.error ? "bad" : "good"} />
              <Metric label="Warnings" value={report.counts.warn} level={report.counts.warn ? "warn" : "good"} />
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
            {report.blocks.length ? (
              report.blocks.map((b) => <BlockView key={b.index} block={b} />)
            ) : (
              <Empty>No JSON-LD on this page. The AI tab can write one for you (“Review structured data”).</Empty>
            )}
          </Section>
        ) : null}
      </AccessGate>
      <Section title="Validate a snippet" hint="Paste JSON-LD (with or without its <script> tag) to check it before shipping.">
        <textarea
          rows={6}
          value={paste}
          placeholder='{"@context":"https://schema.org","@type":"Product",…}'
          onChange={(e) => setPaste(e.target.value)}
        />
        {pasted?.blocks[0] ? <BlockView block={pasted.blocks[0]} /> : null}
      </Section>
    </>
  );
}

export function Headers() {
  const page = usePage();
  const headers = useHeaders();
  const sec = headers.data ? securityReport(headers.data.headers, headers.data.url) : null;
  const cache = headers.data ? cachingReport(headers.data.headers) : null;
  const raw = headers.data ? Object.entries(headers.data.headers).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <AccessGate>
      <ErrorText error={headers.error} />
      {sec && headers.data ? (
        <>
          <Section
            title="Security"
            actions={
              <Button size="small" onClick={headers.run}>
                Refresh
              </Button>
            }
            hint="The document is fetched again from devkit with your cookies; Set-Cookie is hidden by the browser."
          >
            <div className="row">
              <div className={`grade t-${sec.score >= 75 ? "good" : sec.score >= 45 ? "warn" : "bad"}`}>{sec.grade}</div>
              <div className="stack" style={{ gap: 0 }}>
                <b>{sec.score}/100</b>
                <span className="muted small">
                  HTTP {headers.data.status} · {headers.data.ms} ms
                </span>
              </div>
            </div>
            <Checks checks={sec.checks} />
          </Section>
          <Section title="Caching & delivery">{cache ? <Checks checks={cache} /> : null}</Section>
          <Section
            title={`Response headers (${raw.length})`}
            actions={<CopyButton text={raw.map(([k, v]) => `${k}: ${v}`).join("\n")} label="Copy all" />}
          >
            <KV rows={raw} />
          </Section>
        </>
      ) : (
        <Empty>{headers.loading ? `Fetching ${page.url}…` : ""}</Empty>
      )}
    </AccessGate>
  );
}

const vital = (v: number | null, good: number, poor: number) => (v === null ? undefined : v <= good ? "good" : v <= poor ? "warn" : "bad");

export function Perf() {
  const perf = useInPage(collectPerf);
  const [sort, setSort] = useState<"transfer" | "duration">("transfer");
  const p = perf.data;
  const byType = useMemo(() => {
    const m = new Map<string, { count: number; transfer: number }>();
    for (const r of p?.resources ?? []) {
      const e = m.get(r.type) ?? { count: 0, transfer: 0 };
      e.count++;
      e.transfer += r.transfer;
      m.set(r.type, e);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].transfer - a[1].transfer);
  }, [p]);
  const max = Math.max(1, ...byType.map(([, v]) => v.transfer));
  return (
    <AccessGate>
      <ErrorText error={perf.error} />
      {p ? (
        <>
          <Section
            title="Web Vitals"
            actions={
              <Button size="small" onClick={perf.run}>
                Refresh
              </Button>
            }
            hint="Measured in this tab, from buffered entries. INP is the slowest interaction so far: interact with the page, then refresh."
          >
            <div className="grid2">
              <Metric label="LCP" value={msText(p.lcp)} level={vital(p.lcp, 2500, 4000)} />
              <Metric label="CLS" value={p.cls.toFixed(3)} level={vital(p.cls, 0.1, 0.25)} />
              <Metric label="INP (approx.)" value={msText(p.inp)} level={vital(p.inp, 200, 500)} />
              <Metric label="FCP" value={msText(p.fcp)} level={vital(p.fcp, 1800, 3000)} />
              <Metric label="TTFB" value={msText(p.navigation?.ttfb)} level={vital(p.navigation?.ttfb ?? null, 800, 1800)} />
              <Metric
                label="Long tasks"
                value={`${p.longTasks.count} · ${msText(p.longTasks.total)}`}
                level={p.longTasks.total > 300 ? "warn" : undefined}
              />
            </div>
          </Section>
          {p.navigation ? (
            <Section title="Navigation timing">
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
            </Section>
          ) : null}
          <Section title={`Resources (${p.resources.length}, ${bytes(p.resources.reduce((s, r) => s + r.transfer, 0))})`}>
            <div className="stack">
              {byType.map(([type, v]) => (
                <div key={type} className="row small">
                  <span style={{ width: 90 }}>{type}</span>
                  <div className="grow">
                    <div className="bar" style={{ width: `${(v.transfer / max) * 100}%` }} />
                  </div>
                  <span className="muted" style={{ width: 110, textAlign: "right" }}>
                    {v.count} · {bytes(v.transfer)}
                  </span>
                </div>
              ))}
            </div>
            <div className="row">
              <span className="muted small grow">Heaviest (0 B = cached or cross-origin without Timing-Allow-Origin)</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as "transfer" | "duration")} style={{ width: "auto" }}>
                <option value="transfer">by size</option>
                <option value="duration">by duration</option>
              </select>
            </div>
            <KV
              rows={[...p.resources]
                .sort((a, b) => b[sort] - a[sort])
                .slice(0, 25)
                .map((r) => [`${r.type} · ${bytes(r.transfer)} · ${msText(r.duration)}`, r.name])}
            />
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
  return (
    <AccessGate>
      <Section
        title={`Console errors (${list.reduce((s, e) => s + e.count, 0)})`}
        actions={
          <>
            <Button size="small" onClick={errors.run}>
              Refresh
            </Button>
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

export function Links() {
  const page = usePage();
  const toast = useToast();
  const links = useInPage(collectLinks);
  const [results, setResults] = useState<LinkResult[]>([]);
  const [running, setRunning] = useState<AbortController | null>(null);
  const [onlyBad, setOnlyBad] = useState(true);
  const start = async () => {
    if (!(await ensurePermission({ origins: [ALL_SITES] }))) return toast("Checking links on other sites needs access to all sites.", true);
    const list = links.data ?? [];
    const ctrl = new AbortController();
    setRunning(ctrl);
    const state: LinkResult[] = list.map((l) => ({ href: l.href, text: l.text, status: "pending" }));
    setResults([...state]);
    let next = 0;
    const worker = async () => {
      while (next < state.length && !ctrl.signal.aborted) {
        const i = next++;
        const r = await checkLink(state[i]!.href, ctrl.signal);
        state[i] = { ...state[i]!, ...r };
        setResults([...state]);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    setRunning(null);
  };
  const bad = results.filter((r) => r.status === "error" || (typeof r.status === "number" && r.status >= 400));
  const done = results.filter((r) => r.status !== "pending").length;
  const shown = onlyBad ? bad : results;
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
            <Button size="small" variant="primary" disabled={!links.data?.length} onClick={start}>
              Check all
            </Button>
          )
        }
        hint={`Same-page anchors are skipped. Requests go from devkit without cookies, 6 at a time.${page.origin ? "" : ""}`}
      >
        {results.length ? (
          <>
            <div className="row small">
              <span>
                {done}/{results.length} checked · <b className={bad.length ? "t-bad" : "t-good"}>{bad.length} broken</b>
              </span>
              <span className="grow" />
              <label className="check">
                <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> Only broken
              </label>
              {bad.length ? <CopyButton text={bad.map((b) => `${b.status}\t${b.href}`).join("\n")} label="Copy broken" /> : null}
            </div>
            <ul className="list">
              {shown.slice(0, 500).map((r) => (
                <li key={r.href} className="row small">
                  <span
                    className={`pill ${r.status === "pending" ? "" : r.status === "error" || r.status >= 400 ? "t-bad" : r.status >= 300 ? "t-warn" : "t-good"}`}
                    style={{ minWidth: 44 }}
                  >
                    {r.status === "pending" ? "…" : r.status}
                  </span>
                  <a className="grow ellipsis mono" href={r.href} target="_blank" rel="noreferrer" title={r.text}>
                    {r.href}
                  </a>
                  {r.detail ? (
                    <span className="muted ellipsis" style={{ maxWidth: 140 }}>
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

export function Fonts() {
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
                <Button size="small" onClick={data.run}>
                  Refresh
                </Button>
              }
            >
              <KV rows={data.data.families.map((f) => [f.family, `${f.count} text elements`])} />
            </Section>
            <Section title={`Font faces (${data.data.fonts.length})`}>
              {data.data.fonts.length ? (
                <KV rows={data.data.fonts.map((f) => [f.family, `${f.weight} ${f.style} · ${f.status}`])} />
              ) : (
                <Empty>No web font: system fonts only.</Empty>
              )}
            </Section>
            <Section title="Page palette" hint="Most used text, background and border colors. Click to copy.">
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

export function A11y() {
  const hints = useInPage(collectA11yHints);
  return (
    <AccessGate>
      <Section
        title="Accessibility hints"
        actions={
          <Button size="small" onClick={hints.run}>
            Refresh
          </Button>
        }
        hint="Fast heuristics, not an audit. For WCAG / RGAA conformance, use a full tool such as ultra11y."
      >
        <ErrorText error={hints.error} />
        {hints.data ? (
          hints.data.length ? (
            <ul className="list">
              {hints.data.map((h) => (
                <li key={h.rule}>
                  <div className="row">
                    <Dot level="warn" />
                    <b className="grow">{h.rule}</b>
                    <span className="pill">{h.count}</span>
                  </div>
                  {h.samples.length ? <div className="mono small muted break">{h.samples.join("  ·  ")}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Notice kind="good">No quick issue found.</Notice>
          )
        ) : null}
      </Section>
    </AccessGate>
  );
}

async function fetchText(url: string): Promise<{ status: number; text: string; type: string }> {
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
  return (
    <AccessGate>
      <Section
        title="robots.txt"
        actions={
          page.origin ? (
            <a className="btn small" href={`${page.origin}/robots.txt`} target="_blank" rel="noreferrer">
              Open
            </a>
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
        <input placeholder={sitemapUrl} value={sitemapInput} onChange={(e) => setSitemapInput(e.target.value)} />
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
                    <a className="grow ellipsis mono" href={u.loc} target="_blank" rel="noreferrer">
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
  if (!page.origin) return <Empty>Open a web page.</Empty>;
  return (
    <Section title="Open this page in" hint={page.url}>
      <div className="grid2">
        {EXTERNAL_TOOLS.map((t) => (
          <a key={t.name} className="action" href={t.url(page.url)} target="_blank" rel="noreferrer">
            <strong>{t.name}</strong>
            <span>{new URL(t.url(page.url)).host}</span>
          </a>
        ))}
      </div>
    </Section>
  );
}
