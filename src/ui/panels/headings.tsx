// Inspect › Headings: the page's h1–h6 and role=heading as an outline, what is wrong with it, where each heading
// sits in the page (badges in the page, a page map), a table of contents to paste, and AI help on top.
import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { headingsMarkdown } from "../../lib/agent/inspect";
import {
  buildOutline,
  HEADINGS_FOCUS_KEY,
  type HeadingIssue,
  type HeadingsFocus,
  headingIssues,
  headingsVerdict,
  headingText,
  isExposed,
  issuesByHeading,
  levelCounts,
  type OutlineNode,
  tocHtml,
  tocItems,
  tocMarkdown,
} from "../../lib/headings";
import { runInTab } from "../../lib/inject";
import {
  collectHeadings,
  type HeadingBadge,
  type HeadingsSnapshot,
  hideHeadingBadges,
  highlightHeading,
  type RawHeading,
  showHeadingBadges,
} from "../../lib/page/headings";
import { PENDING_ROUTE_KEY } from "../../lib/panels";
import { BarList, LEVEL_TEXT, StatusIcon } from "../charts";
import { Button, Checks, Code, CopyButton, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { AccessGate, useInPage, usePage } from "../page";

const VIS_LABEL: Record<RawHeading["visibility"], string> = {
  visible: "",
  "sr-only": "screen readers only",
  "aria-hidden": "not announced",
  hidden: "hidden",
};

const AI_BUTTONS = [
  { action: "headings-review", label: "Review the outline" },
  { action: "headings-rewrite", label: "Rewrite headings" },
  { action: "headings-match", label: "Headings vs sections" },
  { action: "headings-gaps", label: "Missing sections" },
];

const worst = (issues: HeadingIssue[] | undefined) =>
  issues?.find((i) => i.level === "bad") ?? issues?.find((i) => i.level === "warn") ?? issues?.find((i) => i.level === "info");

export function Headings() {
  const page = usePage();
  const toast = useToast();
  const snap = useInPage(collectHeadings);
  const data = snap.data;
  const issues = useMemo(() => (data ? headingIssues(data) : []), [data]);
  const byHeading = useMemo(() => issuesByHeading(issues), [issues]);
  const [showHidden, setShowHidden] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [badges, setBadges] = useState(false);

  // Badges follow the data and go away with the panel (or when the tab changes).
  useEffect(() => {
    const tabId = page.tabId;
    if (tabId === undefined || !page.canScript) return;
    if (!badges || !data) {
      runInTab(tabId, hideHeadingBadges).catch(() => undefined);
      return;
    }
    const list: HeadingBadge[] = data.headings
      .filter((h) => h.visibility === "visible" || h.visibility === "aria-hidden")
      .map((h) => {
        const issue = worst(byHeading.get(h.index)?.filter((i) => i.level !== "info"));
        return {
          selector: h.selector,
          label: `H${h.level}${h.role ? " role" : ""}${issue ? ` · ${issue.label}` : ""}`,
          bad: Boolean(issue),
        };
      });
    runInTab(tabId, showHeadingBadges, [list]).catch(() => toast("Could not draw the badges in this page.", true));
    return () => {
      runInTab(tabId, hideHeadingBadges).catch(() => undefined);
    };
  }, [badges, data, byHeading, page.tabId, page.canScript, toast]);

  const show = async (h: RawHeading) => {
    if (page.tabId === undefined) return;
    const res = await runInTab(page.tabId, highlightHeading, [
      h.selector,
      `h${h.level} · ${headingText(h).slice(0, 70) || "(empty)"}`,
    ]).catch(() => "missing" as const);
    if (res === "hidden") toast("This heading is not on screen (hidden or zero size).");
    else if (res === "missing") toast("This heading is no longer in the page: refresh.", true);
  };

  const ask = async (action: string, h?: RawHeading) => {
    if (page.tabId === undefined) return;
    if (h) {
      const focus: HeadingsFocus = { tabId: page.tabId, url: page.url, index: h.index };
      await browser.storage.session.set({ [HEADINGS_FOCUS_KEY]: focus });
    }
    await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "ask", params: { action, at: String(Date.now()) } } });
  };

  const agentMd = useMemo(() => (data ? headingsMarkdown(data, { url: data.url }) : ""), [data]);

  return (
    <AccessGate>
      <ErrorText error={snap.error} />
      {data ? (
        <>
          <Summary
            data={data}
            issues={issues}
            badges={badges}
            onBadges={() => setBadges((b) => !b)}
            onRefresh={snap.run}
            agentMd={agentMd}
          />
          <Section
            title={`Outline (${data.headings.length})`}
            actions={
              <>
                <label className="check small">
                  <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                  Hidden ones
                </label>
                <label className="check small">
                  <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                  Issues only
                </label>
              </>
            }
            hint="Click a heading to find it in the page. Dashed rows are levels the page skips."
          >
            <Outline
              data={data}
              byHeading={byHeading}
              showHidden={showHidden}
              onlyIssues={onlyIssues}
              onShow={show}
              onAsk={(h) => ask("headings-one", h)}
            />
          </Section>
          <PageMap data={data} byHeading={byHeading} onShow={show} />
          <Toc data={data} />
          <Section title="Ask your AI" hint="Sends the outline with each section's opening, and the issues above, to your model.">
            <div className="row hd-ai">
              {AI_BUTTONS.map((b) => (
                <Button
                  key={b.action}
                  size="small"
                  onClick={() => ask(b.action)}
                  disabled={!data.headings.length && b.action !== "headings-gaps"}
                >
                  {b.label}
                </Button>
              ))}
            </div>
          </Section>
        </>
      ) : (
        <Empty>{snap.loading ? "Reading the headings…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

function Summary({
  data,
  issues,
  badges,
  onBadges,
  onRefresh,
  agentMd,
}: {
  data: HeadingsSnapshot;
  issues: HeadingIssue[];
  badges: boolean;
  onBadges: () => void;
  onRefresh: () => void;
  agentMd: string;
}) {
  const verdict = headingsVerdict(issues, data.headings.length);
  const exposed = data.headings.filter(isExposed);
  const counts = levelCounts(exposed);
  return (
    <Section
      title="Headings"
      actions={
        <>
          <Button size="small" onClick={onRefresh}>
            Refresh
          </Button>
          <Button size="small" variant={badges ? "primary" : undefined} onClick={onBadges} aria-pressed={badges}>
            {badges ? "Hide badges" : "Badges in page"}
          </Button>
          <CopyButton text={agentMd} label="Copy for agent" />
        </>
      }
    >
      <p className="hd-verdict">
        <StatusIcon level={verdict.level} label={LEVEL_TEXT[verdict.level]} />
        <b>{verdict.text}</b>
        <span className="muted small">
          {exposed.length} of {data.headings.length} announced by screen readers{data.capped ? " · first 500 only" : ""}
        </span>
      </p>
      {exposed.length ? (
        <BarList
          label="Headings per level"
          rows={counts
            .slice(0, Math.max(...exposed.map((h) => h.level)))
            .map((n, l) => ({ key: `h${l + 1}`, label: `h${l + 1}`, value: n, text: String(n) }))}
        />
      ) : null}
      {issues.length ? (
        <Checks checks={issues.map((i, n) => ({ id: `${i.id}-${n}`, label: i.label, level: i.level, detail: i.detail }))} />
      ) : null}
    </Section>
  );
}

function Outline({
  data,
  byHeading,
  showHidden,
  onlyIssues,
  onShow,
  onAsk,
}: {
  data: { headings: RawHeading[] };
  byHeading: Map<number, HeadingIssue[]>;
  showHidden: boolean;
  onlyIssues: boolean;
  onShow: (h: RawHeading) => void;
  onAsk: (h: RawHeading) => void;
}) {
  const list = useMemo(() => data.headings.filter((h) => showHidden || isExposed(h)), [data, showHidden]);
  const tree = useMemo(() => buildOutline(list), [list]);
  const maxWords = useMemo(() => Math.max(1, ...list.map((h) => h.words)), [list]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  if (!data.headings.length) return <Empty>No heading on this page.</Empty>;
  if (!list.length) return <Empty>Every heading is hidden: tick "Hidden ones" to see them.</Empty>;
  const row = (h: RawHeading) => (
    <HeadingRow key={h.index} h={h} issues={byHeading.get(h.index)} maxWords={maxWords} onShow={onShow} onAsk={onAsk} />
  );
  if (onlyIssues) {
    const flagged = list.filter((h) => byHeading.has(h.index));
    return flagged.length ? (
      <ul className="hd-tree">
        {flagged.map((h) => (
          <li key={h.index}>{row(h)}</li>
        ))}
      </ul>
    ) : (
      <Empty>No issue on these headings.</Empty>
    );
  }
  const toggle = (i: number) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const render = (nodes: OutlineNode[], key: string) => (
    <ul className="hd-tree" key={key}>
      {nodes.map((n, i) => {
        const h = n.heading;
        const id = h ? h.index : -1;
        const open = !h || !collapsed.has(id);
        return (
          <li key={h ? h.index : `gap-${key}-${i}`}>
            {h ? (
              <div className="hd-line">
                {n.children.length ? (
                  <button
                    type="button"
                    className="hd-fold"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${headingText(h) || `h${h.level}`}`}
                    onClick={() => toggle(id)}
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M4.5 2.5L8 6l-3.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : (
                  <span className="hd-fold" aria-hidden="true" />
                )}
                {row(h)}
              </div>
            ) : (
              <div className="hd-gap">h{n.level} missing</div>
            )}
            {n.children.length && open ? render(n.children, `${key}-${i}`) : null}
          </li>
        );
      })}
    </ul>
  );
  return render(tree, "root");
}

function HeadingRow({
  h,
  issues,
  maxWords,
  onShow,
  onAsk,
}: {
  h: RawHeading;
  issues: HeadingIssue[] | undefined;
  maxWords: number;
  onShow: (h: RawHeading) => void;
  onAsk: (h: RawHeading) => void;
}) {
  const issue = worst(issues);
  const text = headingText(h);
  const tags = [
    h.role ? `role=heading on <${h.tag}>` : "",
    VIS_LABEL[h.visibility],
    h.landmark && h.landmark !== "main" ? h.landmark : "",
  ].filter(Boolean);
  return (
    <div className={`hd-row${isExposed(h) ? "" : " muted"}`}>
      <button
        type="button"
        className="hd-main"
        onClick={() => onShow(h)}
        title={[h.selector, ...(issues ?? []).map((i) => `${i.label}: ${i.detail}`), h.section ? `\n${h.section}` : ""]
          .filter(Boolean)
          .join("\n")}
      >
        <span className="pill hd-level">h{h.level}</span>
        {issue ? <StatusIcon level={issue.level} label={issue.label} /> : null}
        <span className="hd-text">{text || <i className="muted">(empty)</i>}</span>
        {tags.map((t) => (
          <span key={t} className="pill hd-tag">
            {t}
          </span>
        ))}
        <span className="hd-words" title={`${h.words} words in this section`}>
          <span className="hd-wbar" style={{ width: `${Math.round((h.words / maxWords) * 100)}%` }} />
          <span className="viz-num">{h.words}</span>
        </span>
      </button>
      <button
        type="button"
        className="btn small ghost hd-ask"
        onClick={() => onAsk(h)}
        aria-label={`Ask AI about ${text || `this h${h.level}`}`}
      >
        AI
      </button>
    </div>
  );
}

/** Where the headings fall on the page's height: one tick per heading, longer for higher levels, colored when it has an issue. */
function PageMap({
  data,
  byHeading,
  onShow,
}: {
  data: { headings: RawHeading[]; docHeight: number; viewportHeight: number; introWords: number };
  byHeading: Map<number, HeadingIssue[]>;
  onShow: (h: RawHeading) => void;
}) {
  const shown = data.headings.filter((h) => h.visibility === "visible" || h.visibility === "aria-hidden");
  if (!shown.length) return null;
  const exposed = data.headings.filter(isExposed);
  const totalWords = data.introWords + exposed.reduce((s, h) => s + h.words, 0);
  const sections = exposed.filter((h) => h.words > 0);
  const longest = [...exposed].sort((a, b) => b.words - a.words)[0];
  const maxDepth = Math.max(0, ...exposed.map((h) => h.level));
  const screens = data.docHeight / Math.max(1, data.viewportHeight);
  return (
    <Section title="Page map" hint="Each tick is a heading at its height in the page; the longer the tick, the higher the level.">
      <div className="hd-mapwrap">
        <div className="hd-map">
          <div className="hd-screens" aria-hidden="true">
            {Array.from({ length: Math.floor(screens) }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one mark per screen height
              <span key={i} className="hd-screen" style={{ top: `${(((i + 1) * data.viewportHeight) / data.docHeight) * 100}%` }} />
            ))}
          </div>
          <ul aria-label={`Headings along the page, ${screens.toFixed(1)} screens tall`}>
            {shown.map((h) => {
              const issue = worst(byHeading.get(h.index)?.filter((i) => i.level !== "info"));
              return (
                <li key={h.index} style={{ top: `${(h.top / Math.max(1, data.docHeight)) * 100}%` }}>
                  <button
                    type="button"
                    className={`hd-tick${issue ? ` t-${issue.level}` : ""}`}
                    style={{ width: `${((7 - h.level) / 6) * 100}%` }}
                    onClick={() => onShow(h)}
                    aria-label={`h${h.level} ${headingText(h) || "(empty)"}${issue ? `, ${issue.label}` : ""}`}
                    title={`h${h.level} · ${headingText(h) || "(empty)"}${issue ? `\n${issue.label}` : ""}`}
                  >
                    <span />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <dl className="hd-stats">
          <dt>Page height</dt>
          <dd>{screens.toFixed(1)} screens</dd>
          <dt>Deepest level</dt>
          <dd>{maxDepth ? `h${maxDepth}` : "–"}</dd>
          <dt>Words</dt>
          <dd>
            {totalWords.toLocaleString("en")}
            {data.introWords ? ` (${data.introWords.toLocaleString("en")} before the first heading)` : ""}
          </dd>
          <dt>Per section</dt>
          <dd>
            {sections.length
              ? `${Math.round(sections.reduce((s, h) => s + h.words, 0) / sections.length).toLocaleString("en")} words on average`
              : "–"}
          </dd>
          {longest?.words ? (
            <>
              <dt>Longest</dt>
              <dd>
                <button type="button" className="linklike" onClick={() => onShow(longest)}>
                  {headingText(longest).slice(0, 50) || `h${longest.level}`}
                </button>{" "}
                · {longest.words.toLocaleString("en")} words
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </Section>
  );
}

function Toc({ data }: { data: { headings: RawHeading[] } }) {
  const [depth, setDepth] = useState(3);
  const items = useMemo(() => tocItems(data.headings, depth), [data, depth]);
  const md = useMemo(() => tocMarkdown(items), [items]);
  const html = useMemo(() => tocHtml(items), [items]);
  const noId = items.filter((i) => !i.hasId);
  if (!items.length) return null;
  return (
    <Section
      title="Table of contents"
      actions={
        <>
          <label className="small muted" htmlFor="hd-depth">
            Down to
          </label>
          <select id="hd-depth" className="hd-select" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((l) => (
              <option key={l} value={l}>
                h{l}
              </option>
            ))}
          </select>
          <CopyButton text={md} label="Copy Markdown" />
          <CopyButton text={html} label="Copy HTML" />
        </>
      }
    >
      {noId.length ? (
        <Notice kind="info">
          {`${noId.length} of ${items.length} headings have no id, so nothing can link to them. The links below use proposed ids: add them to the headings (${noId
            .slice(0, 3)
            .map((i) => `id="${i.anchor}"`)
            .join(", ")}${noId.length > 3 ? ", …" : ""}).`}
        </Notice>
      ) : null}
      <Code text={md} maxHeight={220} />
    </Section>
  );
}
