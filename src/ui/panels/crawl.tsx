// Site crawl: the pages a site's sitemaps list (or a pasted list), fetched from devkit as served HTML and read
// with the SEO and JSON-LD checks; findings across pages, a sortable table, a page detail, CSV / JSON exports
// and Copy for agent.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { crawlMarkdown } from "../../lib/agent/crawl";
import {
  CRAWL_LIMITS,
  type CrawlAgent,
  type CrawlFinding,
  type CrawlPage,
  type CrawlSettings,
  clampSettings,
  crawlCsv,
  crawlDelayMs,
  crawlFindings,
  crawlJson,
  crawlSummary,
  DEFAULT_CRAWL_SETTINGS,
  type Fetcher,
  fetchPage,
  filterPages,
  issuesByUrl,
  jsonLdCounts,
  PAGE_FILTERS,
  type PageFilter,
  parseUrlList,
  planCrawl,
  type RobotsRead,
  readRobots,
  readSitemaps,
  runQueue,
  type SitemapRead,
  type SkippedUrl,
  type SortKey,
  sitemapRoots,
  sortPages,
} from "../../lib/crawl";
import { inMode, type ValidateMode } from "../../lib/jsonld";
import { ensurePermission } from "../../lib/permissions";
import type { Robots } from "../../lib/site-files";
import { loadSchemaVocab } from "../../lib/schema-vocab";
import { originPattern } from "../../lib/tab";
import { Button, bytes, CopyButton, Dot, download, Empty, KV, Metric, msText, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
import { useNav } from "../nav";
import { usePage } from "../page";
import { Choice } from "./inspect";

const fetcher: Fetcher = (url, init) => fetch(url, init);

type Source = "sitemap" | "list";

interface Discovery {
  origin: string;
  robots: RobotsRead;
  sitemaps: SitemapRead[];
  truncated: boolean;
  /** Every URL found, in sitemap order. */
  urls: string[];
  inSitemap: Set<string>;
}

interface Run {
  origin: string;
  startedAt: string;
  pages: CrawlPage[];
  /** Planned URLs not fetched yet. */
  pending: string[];
  skipped: SkippedUrl[];
  /** Planned in total, for the progress bar. */
  planned: number;
  inSitemap: Set<string>;
  robots: Record<string, Robots | null>;
}

const SKIP_TEXT: Record<SkippedUrl["reason"], string> = {
  "other-host": "on another host",
  robots: "blocked by robots.txt",
  limit: "past the page limit",
  invalid: "not an http(s) URL",
};

const pathOf = (url: string, origin: string) => (url.startsWith(`${origin}/`) ? url.slice(origin.length) || "/" : url);
const n = (v: number) => v.toLocaleString("en-US");

/** A page URL as a button that opens its detail. */
function PageLink({ url, origin, onPick }: { url: string; origin: string; onPick: (url: string) => void }) {
  return (
    <button type="button" className="crawl-link mono" title={url} onClick={() => onPick(url)}>
      {pathOf(url, origin)}
    </button>
  );
}

function FindingView({ f, origin, onPick }: { f: CrawlFinding; origin: string; onPick: (url: string) => void }) {
  return (
    <li>
      <details className="crawl-finding">
        <summary>
          <Dot level={f.level} />
          <span className="grow">{f.title}</span>
          <span className="pill">{n(f.urls.length)}</span>
        </summary>
        <div className="stack small">
          <span className="muted">{f.fix}</span>
          {f.groups?.length ? (
            <ul className="list">
              {f.groups.slice(0, 30).map((g) => (
                <li key={g.value}>
                  <div className="crawl-group-value">{g.value}</div>
                  <div className="row">
                    {g.urls.slice(0, 20).map((u) => (
                      <PageLink key={u} url={u} origin={origin} onPick={onPick} />
                    ))}
                    {g.urls.length > 20 ? <span className="muted">+{g.urls.length - 20}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="row">
              {f.urls.slice(0, 40).map((u) => (
                <PageLink key={u} url={u} origin={origin} onPick={onPick} />
              ))}
              {f.urls.length > 40 ? <span className="muted">+{f.urls.length - 40}</span> : null}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: "url", label: "Page", title: "Path on the site" },
  { key: "status", label: "Status", title: "HTTP status (↪ redirected)" },
  { key: "title", label: "Title", title: "Title length in characters" },
  { key: "description", label: "Desc.", title: "Meta description length in characters" },
  { key: "h1", label: "H1", title: "Number of h1" },
  { key: "jsonld", label: "JSON-LD", title: "JSON-LD errors / warnings" },
  { key: "issues", label: "Find.", title: "Findings (problems and warnings) on the page" },
  { key: "ms", label: "Time", title: "Response time" },
];

function detailRows(p: CrawlPage, mode: ValidateMode): [ReactNode, ReactNode][] {
  const c = jsonLdCounts(p, mode);
  const none = (
    <span key="none" className="muted">
      None
    </span>
  );
  const rows: [string, ReactNode][] = [
    [
      "URL",
      <span key="url" className="mono break">
        {p.url}
      </span>,
    ],
  ];
  if (p.redirected)
    rows.push([
      "Redirected to",
      <span key="final" className="mono break">
        {p.finalUrl}
      </span>,
    ]);
  rows.push(
    [
      "Status",
      p.status ? (
        String(p.status)
      ) : (
        <span key="status" className="t-bad">
          Failed: {p.error}
        </span>
      ),
    ],
    ["Content type", p.contentType || none],
    ["Response", `${msText(p.ms)} · ${bytes(p.bytes)}`],
    ["Title", p.title ? `${p.title} (${p.title.length})` : none],
    ["Description", p.description ? `${p.description} (${p.description.length})` : none],
    [
      "Canonical",
      p.canonical ? (
        <span key="canonical" className="mono break">
          {p.canonical}{" "}
          <span className={`pill${p.canonicalState === "other" ? " t-warn" : ""}`}>
            {p.canonicalState === "self" ? "self" : "elsewhere"}
          </span>
        </span>
      ) : (
        none
      ),
    ],
    ["Meta robots", p.robotsMeta ?? none],
    ["X-Robots-Tag", p.xRobotsTag ?? none],
    [
      "Indexable",
      p.noindex ? (
        <span key="noindex" className="t-bad">
          noindex
        </span>
      ) : p.html ? (
        "yes"
      ) : (
        "–"
      ),
    ],
    ["H1", p.h1.length ? p.h1.join(" | ") : none],
    ["hreflang", n(p.hreflang)],
    ["Words", p.html ? n(p.words) : "–"],
    ["JSON-LD", p.jsonld.blocks ? `${p.jsonld.types.join(", ") || "no type"} · ${c.errors} errors, ${c.warnings} warnings` : none],
    ["In sitemap", p.inSitemap ? "yes" : "no"],
  );
  if (p.error && p.status) rows.push(["Note", p.error]);
  return rows;
}

function PageDetail({
  p,
  mode,
  findings,
  origin,
  onClose,
}: {
  p: CrawlPage;
  mode: ValidateMode;
  findings: CrawlFinding[];
  origin: string;
  onClose: () => void;
}) {
  const page = usePage();
  const nav = useNav();
  const shown = p.jsonld.findings.filter((f) => inMode(f, mode));
  return (
    <Section
      title={<span className="mono">{pathOf(p.url, origin)}</span>}
      actions={
        <>
          <a className="btn small" href={p.url} target="_blank" rel="noreferrer">
            Open
          </a>
          {page.tabId !== undefined ? (
            <Button
              size="small"
              title="Load the page in this tab and open the Structured data panel (it then runs the page's JavaScript)"
              onClick={async () => {
                await browser.tabs.update(page.tabId!, { url: p.url });
                nav?.({ panel: "jsonld" });
              }}
            >
              Inspect in tab
            </Button>
          ) : null}
          <Button size="small" variant="ghost" onClick={onClose} aria-label="Close the page detail">
            Close
          </Button>
        </>
      }
    >
      <KV rows={detailRows(p, mode)} />
      {findings.length ? (
        <ul className="checks">
          {findings.map((f) => (
            <li key={f.id}>
              <Dot level={f.level} />
              <span className="label">{f.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {shown.length ? (
        <details>
          <summary className="small">JSON-LD findings ({shown.length})</summary>
          <ul className="checks">
            {shown.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <li key={i}>
                <Dot level={f.severity === "error" ? "bad" : "warn"} />
                <span className="label">{f.type}</span>
                <span className="detail">
                  {f.message} <span className="muted mono">{f.path}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

export function SiteCrawl() {
  const page = usePage();
  const toast = useToast();
  const [stored, setStored] = useStored<Partial<CrawlSettings>>("crawlSettings", DEFAULT_CRAWL_SETTINGS);
  const settings = useMemo(() => clampSettings(stored), [stored]);
  const set = (patch: Partial<CrawlSettings>) => setStored({ ...settings, ...patch });
  const [mode, setMode] = useStored<ValidateMode>("jsonldMode", "rich");
  const [source, setSource] = useState<Source>("sitemap");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [listText, setListText] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [finding, setFinding] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "issues", dir: "desc" });
  const [filter, setFilter] = useState<PageFilter>("all");
  const [query, setQuery] = useState("");
  const controller = useRef<AbortController | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const origin = page.origin;

  useEffect(() => () => controller.current?.abort(), []);
  // Another site in the tab: its URLs are not this one's (results of a finished crawl stay, under their host).
  useEffect(() => setDiscovery((d) => (d && d.origin !== origin ? null : d)), [origin]);

  const plan = useMemo(
    () =>
      discovery
        ? planCrawl(discovery.urls, { origin: discovery.origin, settings, robots: { [discovery.origin]: discovery.robots.parsed } })
        : null,
    [discovery, settings],
  );

  const findUrls = async () => {
    if (!origin) return;
    setProblem(null);
    // First thing in the click: Chrome shows the access prompt only during a user gesture.
    if (!(await ensurePermission({ origins: [originPattern(origin)] }))) {
      setProblem(`devkit needs access to ${new URL(origin).host} to fetch its robots.txt, sitemaps and pages.`);
      return;
    }
    setFinding(true);
    try {
      const robots = await readRobots(origin, fetcher);
      if (source === "list") {
        const urls = parseUrlList(listText, origin);
        if (!urls.length) setProblem("Paste at least one URL (one per line).");
        setDiscovery({ origin, robots, sitemaps: [], truncated: false, urls, inSitemap: new Set() });
      } else {
        const typed = sitemapUrl.trim();
        const roots = typed ? [new URL(typed, `${origin}/`).href] : sitemapRoots(origin, robots.parsed);
        const result = await readSitemaps(roots, fetcher, {
          allow: (u) => settings.includeOtherHosts || u.startsWith(`${origin}/`),
          maxUrls: 50_000,
        });
        const urls = result.urls.map((u) => u.loc);
        if (!urls.length) setProblem("No page URL found in the sitemaps. Check the sitemap below, type its URL, or paste a URL list.");
        setDiscovery({ origin, robots, sitemaps: result.sitemaps, truncated: result.truncated, urls, inSitemap: new Set(urls) });
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setFinding(false);
    }
  };

  const crawl = async (queue: string[], base: Run) => {
    const ctrl = new AbortController();
    controller.current = ctrl;
    setRunning(true);
    setRun({ ...base, pending: queue });
    const vocab = await loadSchemaVocab().catch(() => undefined);
    const delay = Math.max(settings.delayMs, settings.respectRobots ? crawlDelayMs(base.robots[base.origin], settings.userAgent) : 0);
    const left = await runQueue(
      queue,
      async (url) => {
        const p = await fetchPage(url, { fetcher, vocab, signal: ctrl.signal, inSitemap: base.inSitemap.has(url) });
        setRun((r) => (r ? { ...r, pages: [...r.pages, p], pending: r.pending.filter((u) => u !== url) } : r));
      },
      { concurrency: settings.concurrency, delayMs: delay, signal: ctrl.signal },
    );
    setRun((r) => (r ? { ...r, pending: left } : r));
    setRunning(false);
    controller.current = null;
  };

  const start = async () => {
    if (!discovery || !plan) return;
    setProblem(null);
    let current = plan;
    const robots: Record<string, Robots | null> = { [discovery.origin]: discovery.robots.parsed };
    if (current.otherOrigins.length) {
      const granted = await ensurePermission({ origins: current.otherOrigins.map(originPattern) });
      if (!granted) {
        setProblem("No access to the other hosts: only this site's pages are crawled.");
        current = planCrawl(discovery.urls, { origin: discovery.origin, settings: { ...settings, includeOtherHosts: false }, robots });
      } else if (settings.respectRobots) {
        for (const o of current.otherOrigins) robots[o] = (await readRobots(o, fetcher)).parsed;
        current = planCrawl(discovery.urls, { origin: discovery.origin, settings, robots });
      }
    }
    setSelected(null);
    await crawl(current.queue, {
      origin: discovery.origin,
      startedAt: new Date().toISOString(),
      pages: [],
      pending: current.queue,
      skipped: current.skipped,
      planned: current.queue.length,
      inSitemap: discovery.inSitemap,
      robots,
    });
  };

  const stop = () => controller.current?.abort();
  const resume = async () => {
    if (!run?.pending.length) return;
    if (!(await ensurePermission({ origins: [originPattern(run.origin)] }))) return toast("devkit needs access to this site.", true);
    await crawl(run.pending, run);
  };

  const pages = run?.pages ?? [];
  const findings = useMemo(() => crawlFindings(pages, { mode, skipped: run?.skipped ?? [] }), [pages, mode, run?.skipped]);
  const issues = useMemo(() => issuesByUrl(findings), [findings]);
  const summary = useMemo(() => crawlSummary(pages), [pages]);
  const rows = useMemo(
    () => sortPages(filterPages(pages, { filter, query, mode, issues }), sort.key, sort.dir, { mode, issues }),
    [pages, filter, query, mode, issues, sort],
  );
  const agentMd = useMemo(
    () =>
      run && pages.length && !running
        ? crawlMarkdown({
            origin: run.origin,
            pages,
            skipped: run.skipped,
            pending: run.pending,
            mode,
            sitemaps: discovery?.sitemaps ?? [],
          })
        : "",
    [run, pages, running, mode, discovery],
  );
  const selectedPage = selected ? pages.find((p) => p.url === selected) : undefined;
  const pick = (url: string) => {
    setSelected(url);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const fileBase = run ? `crawl-${new URL(run.origin).host}-${run.startedAt.slice(0, 10)}` : "crawl";

  if (!origin) return <Notice kind="warn">Open a web page (http or https) to crawl its site.</Notice>;

  const skippedCounts = plan
    ? (Object.keys(SKIP_TEXT) as SkippedUrl["reason"][])
        .map((r) => [r, plan.skipped.filter((s) => s.reason === r).length] as const)
        .filter(([, c]) => c > 0)
    : [];
  const done = run ? run.planned - run.pending.length : 0;

  return (
    <>
      <Section
        title="Site crawl"
        hint={
          <>
            Fetches up to {n(settings.maxPages)} pages of <b>{new URL(origin).host}</b> from devkit and runs the SEO and JSON-LD checks on
            each. Served HTML only: no JavaScript runs, so tags a script adds are not seen. devkit asks for access to the site the first
            time.
          </>
        }
      >
        <Choice
          label="Source"
          value={source}
          options={[
            ["sitemap", "Sitemaps"],
            ["list", "URL list"],
          ]}
          onChange={(v) => {
            setSource(v);
            setDiscovery(null);
          }}
        />
        {source === "sitemap" ? (
          <input
            aria-label="Sitemap URL"
            placeholder="robots.txt sitemaps, else /sitemap.xml"
            value={sitemapUrl}
            onChange={(e) => setSitemapUrl(e.target.value)}
          />
        ) : (
          <textarea
            aria-label="URLs to crawl"
            placeholder={`${origin}/\n${origin}/about\n/pricing`}
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            rows={4}
          />
        )}
        <details className="crawl-settings">
          <summary className="small">
            Settings · {n(settings.maxPages)} pages, {settings.concurrency} at a time, {settings.delayMs} ms apart
            {settings.respectRobots ? `, robots.txt for ${settings.userAgent}` : ", robots.txt ignored"}
          </summary>
          <div className="crawl-grid">
            <label className="field">
              Max pages
              <input
                type="number"
                min={1}
                max={CRAWL_LIMITS.maxPages}
                value={settings.maxPages}
                onChange={(e) => set({ maxPages: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Concurrency
              <input
                type="number"
                min={1}
                max={CRAWL_LIMITS.maxConcurrency}
                value={settings.concurrency}
                onChange={(e) => set({ concurrency: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Delay (ms)
              <input
                type="number"
                min={0}
                max={CRAWL_LIMITS.maxDelayMs}
                step={50}
                value={settings.delayMs}
                onChange={(e) => set({ delayMs: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="row">
            <label className="check small">
              <input type="checkbox" checked={settings.respectRobots} onChange={(e) => set({ respectRobots: e.target.checked })} />
              Respect robots.txt (and its Crawl-delay)
            </label>
            {settings.respectRobots ? (
              <Choice<CrawlAgent>
                label="as"
                value={settings.userAgent}
                options={[
                  ["devkit", "devkit"],
                  ["Googlebot", "Googlebot"],
                ]}
                onChange={(v) => set({ userAgent: v })}
              />
            ) : null}
          </div>
          <label className="check small">
            <input type="checkbox" checked={settings.includeOtherHosts} onChange={(e) => set({ includeOtherHosts: e.target.checked })} />
            Include other hosts the sitemap lists (asks for access to each)
          </label>
          <Choice<ValidateMode>
            label="JSON-LD"
            value={mode}
            options={[
              ["rich", "Rich Results"],
              ["schema", "Schema.org"],
            ]}
            onChange={setMode}
          />
          <p className="muted small" style={{ margin: 0 }}>
            The robots.txt choice picks whose rules apply; requests go out with Chrome's own User-Agent, without cookies.
          </p>
        </details>
        <div className="row">
          <Button variant={discovery ? undefined : "primary"} busy={finding} disabled={running} onClick={findUrls}>
            Find URLs
          </Button>
          {plan && !running ? (
            <Button variant="primary" disabled={!plan.queue.length} onClick={start}>
              Crawl {n(plan.queue.length)} {plan.queue.length === 1 ? "page" : "pages"}
            </Button>
          ) : null}
          {running ? (
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          ) : null}
          {run && !running && run.pending.length ? <Button onClick={resume}>Resume ({n(run.pending.length)} left)</Button> : null}
        </div>
        {problem ? <Notice kind="warn">{problem}</Notice> : null}
        {discovery && plan ? (
          <div className="small stack">
            <span>
              {n(discovery.urls.length)} URL{discovery.urls.length === 1 ? "" : "s"} found
              {source === "sitemap"
                ? ` in ${n(discovery.sitemaps.filter((s) => s.kind === "urlset" || s.kind === "sitemapindex").length)} sitemap(s)`
                : " in the list"}
              {discovery.truncated ? " (a limit stopped the reading)" : ""}
              {skippedCounts.length ? ` · skipped: ${skippedCounts.map(([r, c]) => `${n(c)} ${SKIP_TEXT[r]}`).join(", ")}` : ""}
            </span>
            <span className="muted">
              robots.txt:{" "}
              {discovery.robots.parsed ? "read" : discovery.robots.status ? `HTTP ${discovery.robots.status} (none)` : "no answer"}
            </span>
            {discovery.sitemaps.length ? (
              <details>
                <summary className="small muted">Sitemaps ({discovery.sitemaps.length})</summary>
                <ul className="list">
                  {discovery.sitemaps.map((s) => (
                    <li key={s.url} className="row small">
                      <span className="grow ellipsis mono" title={s.url}>
                        {pathOf(s.url, discovery.origin)}
                      </span>
                      <span className={`pill${s.kind === "error" || s.kind === "unknown" ? " t-bad" : ""}`}>
                        {s.kind === "sitemapindex"
                          ? `index · ${s.entries}`
                          : s.kind === "urlset"
                            ? `${s.entries} URLs`
                            : s.kind === "unknown"
                              ? "not a sitemap"
                              : (s.error ?? s.kind)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </Section>

      {run ? (
        <Section
          title={`Results · ${new URL(run.origin).host}`}
          actions={
            pages.length && !running ? (
              <>
                <CopyButton text={agentMd} label="Copy for agent" />
                <Button size="small" onClick={() => download(`${fileBase}.csv`, crawlCsv(pages, mode), "text/csv")}>
                  CSV
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    download(
                      `${fileBase}.json`,
                      crawlJson({
                        origin: run.origin,
                        crawledAt: run.startedAt,
                        settings,
                        mode,
                        sitemaps: discovery?.sitemaps ?? [],
                        pages,
                        skipped: run.skipped,
                        pending: run.pending,
                      }),
                    )
                  }
                >
                  JSON
                </Button>
              </>
            ) : null
          }
        >
          <div className="stack small" aria-live="polite">
            <span>
              {running ? "Crawling… " : run.pending.length ? "Stopped. " : "Done. "}
              {n(done)} / {n(run.planned)} pages
            </span>
            <div
              className="meter"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={run.planned}
              aria-valuenow={done}
              aria-label="Crawl progress"
            >
              <div className="bar" style={{ width: `${run.planned ? (done / run.planned) * 100 : 0}%` }} />
            </div>
          </div>
          <div className="grid2 crawl-metrics">
            <Metric label="Pages" value={n(summary.pages)} />
            <Metric label="Errors" value={n(summary.errors)} level={summary.errors ? "bad" : "good"} />
            <Metric label="noindex" value={n(summary.noindex)} level={summary.noindex ? "warn" : undefined} />
            <Metric label="Avg. time" value={msText(summary.avgMs)} />
          </div>
          {findings.length ? (
            <ul className="crawl-findings">
              {findings.map((f) => (
                <FindingView key={f.id} f={f} origin={run.origin} onPick={pick} />
              ))}
            </ul>
          ) : pages.length && !running ? (
            <Notice kind="good">No finding across {n(pages.length)} pages.</Notice>
          ) : null}
        </Section>
      ) : null}

      {pages.length ? (
        <Section title={`Pages (${rows.length}${rows.length !== pages.length ? ` of ${pages.length}` : ""})`}>
          <div className="row">
            <input
              type="search"
              className="grow"
              placeholder="Filter by URL, title, h1, type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter pages"
            />
            <select value={filter} onChange={(e) => setFilter(e.target.value as PageFilter)} aria-label="Show" style={{ width: "auto" }}>
              {PAGE_FILTERS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {rows.length ? (
            <div className="crawl-table-wrap">
              <table className="crawl-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        title={c.title}
                        aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSort((s) => ({
                              key: c.key,
                              dir: s.key === c.key ? (s.dir === "asc" ? "desc" : "asc") : c.key === "url" ? "asc" : "desc",
                            }))
                          }
                        >
                          {c.label}
                          {sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const c = jsonLdCounts(p, mode);
                    const count = issues.get(p.url)?.filter((f) => f.level !== "info").length ?? 0;
                    return (
                      <tr key={p.url} className={p.url === selected ? "selected" : undefined} onClick={() => pick(p.url)}>
                        <td className="crawl-url">
                          <PageLink url={p.url} origin={run?.origin ?? origin} onPick={pick} />
                        </td>
                        <td className={p.status === 0 || p.status >= 400 ? "t-bad" : p.redirected ? "t-warn" : undefined}>
                          {p.status || "✕"}
                          {p.redirected ? " ↪" : ""}
                          {p.noindex ? <span className="pill t-warn">noindex</span> : null}
                        </td>
                        <td className={p.html && !p.title ? "t-bad" : undefined} title={p.title}>
                          {p.html ? p.title.length : "–"}
                        </td>
                        <td className={p.html && !p.description ? "t-warn" : undefined} title={p.description ?? ""}>
                          {p.html ? (p.description?.length ?? 0) : "–"}
                        </td>
                        <td className={p.html && p.h1.length !== 1 ? "t-warn" : undefined}>{p.html ? p.h1.length : "–"}</td>
                        <td className={c.errors ? "t-bad" : c.warnings ? "t-warn" : undefined} title={p.jsonld.types.join(", ")}>
                          {p.jsonld.blocks ? `${c.errors}/${c.warnings}` : "–"}
                        </td>
                        <td className={count ? "t-warn" : undefined}>{count || ""}</td>
                        <td>{msText(p.ms)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No page matches.</Empty>
          )}
        </Section>
      ) : null}

      <div ref={detailRef}>
        {selectedPage && run ? (
          <PageDetail
            p={selectedPage}
            mode={mode}
            findings={issues.get(selectedPage.url) ?? []}
            origin={run.origin}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
    </>
  );
}
