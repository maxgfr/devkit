// Inspect › Headings: the page's h1–h6 and role=heading as an outline, its ARIA landmarks as a tree (alone or with
// their headings nested), what is wrong with both, where each sits in the page (badges in the page, a page map),
// a table of contents to paste, and AI help on top.
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
  buildCombinedTree,
  buildLandmarkTree,
  type CombinedNode,
  isLandmarkExposed,
  type LandmarkIssue,
  type LandmarkNode,
  landmarkIssues,
  landmarkLabel,
  landmarkTag,
  issuesByLandmark,
} from "../../lib/landmarks";
import {
  collectHeadings,
  type HeadingBadge,
  type HeadingsSnapshot,
  hideHeadingBadges,
  highlightHeading,
  type RawHeading,
  showHeadingBadges,
} from "../../lib/page/headings";
import { collectLandmarks, type LandmarksSnapshot, type RawLandmark } from "../../lib/page/landmarks";
import { PENDING_ROUTE_KEY } from "../../lib/panels";
import { BarList, LEVEL_TEXT, StatusIcon } from "../charts";
import { Button, Checks, Code, CopyButton, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
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

type View = "headings" | "landmarks" | "all";

const VIEW_HINT: Record<View, string> = {
  headings: "Click a heading to find it in the page. Dashed rows are levels the page skips.",
  landmarks: "The landmarks a screen reader lists, as browsers map the HTML (HTML-AAM). Click one to find it in the page.",
  all: "Each landmark with the headings it holds. Click a row to find it in the page.",
};

type AnyIssue = Pick<HeadingIssue | LandmarkIssue, "level" | "label">;
const worst = <T extends AnyIssue>(issues: T[] | undefined) =>
  issues?.find((i) => i.level === "bad") ?? issues?.find((i) => i.level === "warn") ?? issues?.find((i) => i.level === "info");

/** Every node that can fold in a tree, by its collapse key. */
function outlineKeys(nodes: OutlineNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.heading && n.children.length) out.push(`h:${n.heading.index}`);
    outlineKeys(n.children, out);
  }
  return out;
}
function landmarkKeys(nodes: LandmarkNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) out.push(`l:${n.landmark.index}`);
    landmarkKeys(n.children, out);
  }
  return out;
}
function combinedKeys(nodes: CombinedNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "heading") outlineKeys([n.node], out);
    else {
      if (n.children.length) out.push(n.kind === "outside" ? "outside" : `l:${n.landmark.index}`);
      combinedKeys(n.children, out);
    }
  }
  return out;
}

export function Headings() {
  const page = usePage();
  const toast = useToast();
  const snap = useInPage(collectHeadings);
  const lmSnap = useInPage(collectLandmarks);
  const data = snap.data;
  const lm = lmSnap.data;
  const issues = useMemo(() => (data ? headingIssues(data) : []), [data]);
  const byHeading = useMemo(() => issuesByHeading(issues), [issues]);
  const lmIssues = useMemo(() => (lm ? landmarkIssues(lm, data?.headings) : []), [lm, data]);
  const byLandmark = useMemo(() => issuesByLandmark(lmIssues), [lmIssues]);
  const [view, setView] = useStored<View>("headings.view", "headings");
  const [showHidden, setShowHidden] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [badges, setBadges] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const landmarkView = view !== "headings";

  // Badges follow the data and the view, and go away with the panel (or when the tab changes).
  useEffect(() => {
    const tabId = page.tabId;
    if (tabId === undefined || !page.canScript) return;
    const onPage = (v: string) => v === "visible" || v === "aria-hidden";
    const list: HeadingBadge[] | null = !badges
      ? null
      : landmarkView
        ? lm
          ? lm.landmarks
              .filter((l) => onPage(l.visibility))
              .map((l) => {
                const issue = worst(byLandmark.get(l.index)?.filter((i) => i.level !== "info"));
                return {
                  selector: l.selector,
                  label: `${landmarkTag(l)}${l.name ? ` · ${l.name.slice(0, 40)}` : ""}${issue ? ` · ${issue.label}` : ""}`,
                  bad: Boolean(issue),
                };
              })
          : null
        : data
          ? data.headings
              .filter((h) => onPage(h.visibility))
              .map((h) => {
                const issue = worst(byHeading.get(h.index)?.filter((i) => i.level !== "info"));
                return {
                  selector: h.selector,
                  label: `H${h.level}${h.role ? " role" : ""}${issue ? ` · ${issue.label}` : ""}`,
                  bad: Boolean(issue),
                };
              })
          : null;
    if (!list) {
      runInTab(tabId, hideHeadingBadges).catch(() => undefined);
      return;
    }
    runInTab(tabId, showHeadingBadges, [list]).catch(() => toast("Could not draw the badges in this page.", true));
    return () => {
      runInTab(tabId, hideHeadingBadges).catch(() => undefined);
    };
  }, [badges, landmarkView, data, lm, byHeading, byLandmark, page.tabId, page.canScript, toast]);

  const locate = async (selector: string, label: string, what: string) => {
    if (page.tabId === undefined) return;
    const res = await runInTab(page.tabId, highlightHeading, [selector, label]).catch(() => "missing" as const);
    if (res === "hidden") toast(`This ${what} is not on screen (hidden or zero size).`);
    else if (res === "missing") toast(`This ${what} is no longer in the page: refresh.`, true);
  };
  const show = (h: RawHeading) => locate(h.selector, `h${h.level} · ${headingText(h).slice(0, 70) || "(empty)"}`, "heading");
  const showLandmark = (l: RawLandmark) => locate(l.selector, `${landmarkTag(l)} · ${landmarkLabel(l).slice(0, 80)}`, "landmark");

  const ask = async (action: string, h?: RawHeading) => {
    if (page.tabId === undefined) return;
    if (h) {
      const focus: HeadingsFocus = { tabId: page.tabId, url: page.url, index: h.index };
      await browser.storage.session.set({ [HEADINGS_FOCUS_KEY]: focus });
    }
    await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "ask", params: { action, at: String(Date.now()) } } });
  };

  const agentMd = useMemo(() => (data ? headingsMarkdown(data, { url: data.url }, lm ?? undefined) : ""), [data, lm]);

  // The trees of the three views, with what is filtered out already gone.
  const keepLandmark = (l: RawLandmark) => showHidden || isLandmarkExposed(l);
  const list = useMemo(() => (data ? data.headings.filter((h) => showHidden || isExposed(h)) : []), [data, showHidden]);
  const outline = useMemo(() => buildOutline(list), [list]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keepLandmark only reads showHidden
  const lmTree = useMemo(() => (lm ? buildLandmarkTree(lm, keepLandmark) : []), [lm, showHidden]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keepLandmark only reads showHidden
  const allTree = useMemo(() => (lm ? buildCombinedTree(lm, list, keepLandmark) : []), [lm, list, showHidden]);
  const foldable = useMemo(
    () => (view === "headings" ? outlineKeys(outline) : view === "landmarks" ? landmarkKeys(lmTree) : combinedKeys(allTree)),
    [view, outline, lmTree, allTree],
  );
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const lmCount = lm?.landmarks.filter(keepLandmark).length ?? 0;
  const chips: { id: View; label: string; count?: number }[] = [
    { id: "headings", label: "Headings", count: list.length },
    { id: "landmarks", label: "Landmarks", count: lm ? lmCount : undefined },
    { id: "all", label: "All" },
  ];

  return (
    <AccessGate>
      <ErrorText error={snap.error} />
      {data ? (
        <>
          <Summary
            data={data}
            issues={issues}
            landmarks={lm ?? undefined}
            lmIssues={lmIssues}
            badges={badges}
            onBadges={() => setBadges((b) => !b)}
            onRefresh={() => {
              snap.run();
              lmSnap.run();
            }}
            agentMd={agentMd}
          />
          <Section
            title={
              view === "headings" ? `Outline (${data.headings.length})` : view === "landmarks" ? "Landmarks" : "Landmarks and headings"
            }
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
            hint={VIEW_HINT[view]}
          >
            <div className="hd-viewbar">
              <fieldset className="as-chips hd-views" aria-label="View">
                {chips.map((c) => (
                  <button key={c.id} type="button" className="as-chip" aria-pressed={view === c.id} onClick={() => setView(c.id)}>
                    {c.label}
                    {c.count !== undefined ? <span className="viz-num"> {c.count}</span> : null}
                  </button>
                ))}
              </fieldset>
              {onlyIssues ? null : (
                <span className="hd-folds">
                  <Button size="small" variant="ghost" onClick={() => setCollapsed(new Set())} disabled={!foldable.length}>
                    Expand all
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => setCollapsed(new Set(foldable))} disabled={!foldable.length}>
                    Collapse all
                  </Button>
                </span>
              )}
            </div>
            {landmarkView ? <ErrorText error={lmSnap.error} /> : null}
            <Trees
              view={view}
              data={data}
              landmarks={lm ?? undefined}
              loadingLandmarks={lmSnap.loading}
              list={list}
              outline={outline}
              lmTree={lmTree}
              allTree={allTree}
              byHeading={byHeading}
              byLandmark={byLandmark}
              onlyIssues={onlyIssues}
              collapsed={collapsed}
              toggle={toggle}
              onShow={show}
              onShowLandmark={showLandmark}
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
  landmarks,
  lmIssues,
  badges,
  onBadges,
  onRefresh,
  agentMd,
}: {
  data: HeadingsSnapshot;
  issues: HeadingIssue[];
  landmarks?: LandmarksSnapshot;
  lmIssues: LandmarkIssue[];
  badges: boolean;
  onBadges: () => void;
  onRefresh: () => void;
  agentMd: string;
}) {
  const verdict = headingsVerdict([...issues, ...lmIssues], data.headings.length);
  const exposed = data.headings.filter(isExposed);
  const counts = levelCounts(exposed);
  const lmExposed = landmarks?.landmarks.filter(isLandmarkExposed).length ?? 0;
  const checks = [
    ...issues.map((i, n) => ({ id: `${i.id}-${n}`, label: i.label, level: i.level, detail: i.detail })),
    ...lmIssues.map((i, n) => ({ id: `lm-${i.id}-${n}`, label: i.label, level: i.level, detail: i.detail })),
  ];
  const rank = { bad: 0, warn: 1, info: 2, good: 3 } as const;
  checks.sort((a, b) => rank[a.level] - rank[b.level]);
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
          {landmarks ? ` · ${lmExposed} landmark${lmExposed === 1 ? "" : "s"}` : ""}
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
      {checks.length ? <Checks checks={checks} /> : null}
    </Section>
  );
}

function Fold({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="hd-fold"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      onClick={onClick}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const NoFold = () => <span className="hd-fold" aria-hidden="true" />;

function Trees({
  view,
  data,
  landmarks,
  loadingLandmarks,
  list,
  outline,
  lmTree,
  allTree,
  byHeading,
  byLandmark,
  onlyIssues,
  collapsed,
  toggle,
  onShow,
  onShowLandmark,
  onAsk,
}: {
  view: View;
  data: { headings: RawHeading[] };
  landmarks?: LandmarksSnapshot;
  loadingLandmarks: boolean;
  list: RawHeading[];
  outline: OutlineNode[];
  lmTree: LandmarkNode[];
  allTree: CombinedNode[];
  byHeading: Map<number, HeadingIssue[]>;
  byLandmark: Map<number, LandmarkIssue[]>;
  onlyIssues: boolean;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  onShow: (h: RawHeading) => void;
  onShowLandmark: (l: RawLandmark) => void;
  onAsk: (h: RawHeading) => void;
}) {
  const maxWords = useMemo(() => Math.max(1, ...list.map((h) => h.words)), [list]);
  const row = (h: RawHeading) => (
    <HeadingRow
      key={h.index}
      h={h}
      issues={byHeading.get(h.index)}
      maxWords={maxWords}
      onShow={onShow}
      onAsk={onAsk}
      nested={view === "all"}
    />
  );
  const lmRow = (l: RawLandmark) => (
    <LandmarkRow key={`l${l.index}`} l={l} issues={byLandmark.get(l.index)} onShow={onShowLandmark} count={view === "landmarks"} />
  );

  const renderOutline = (nodes: OutlineNode[], key: string) => (
    <ul className="hd-tree" key={key}>
      {nodes.map((n, i) => {
        const h = n.heading;
        const open = !h || !collapsed.has(`h:${h.index}`);
        return (
          <li key={h ? h.index : `gap-${key}-${i}`}>
            {h ? (
              <div className="hd-line">
                {n.children.length ? (
                  <Fold open={open} label={headingText(h) || `h${h.level}`} onClick={() => toggle(`h:${h.index}`)} />
                ) : (
                  <NoFold />
                )}
                {row(h)}
              </div>
            ) : (
              <div className="hd-gap">h{n.level} missing</div>
            )}
            {n.children.length && open ? renderOutline(n.children, `${key}-${i}`) : null}
          </li>
        );
      })}
    </ul>
  );

  const renderLandmarks = (nodes: LandmarkNode[], key: string) => (
    <ul className="hd-tree" key={key}>
      {nodes.map((n) => {
        const l = n.landmark;
        const open = !collapsed.has(`l:${l.index}`);
        return (
          <li key={l.index}>
            <div className="hd-line">
              {n.children.length ? <Fold open={open} label={landmarkLabel(l)} onClick={() => toggle(`l:${l.index}`)} /> : <NoFold />}
              {lmRow(l)}
            </div>
            {n.children.length && open ? renderLandmarks(n.children, `${key}-${l.index}`) : null}
          </li>
        );
      })}
    </ul>
  );

  const renderCombined = (nodes: CombinedNode[], key: string) => {
    // Runs of headings render as one outline list each, so their nesting lines stay those of the Headings view.
    const out: ReactNode[] = [];
    let run: OutlineNode[] = [];
    const flush = (at: number) => {
      if (run.length)
        out.push(
          <li key={`run-${key}-${at}`} className="hd-run">
            {renderOutline(run, `${key}-run-${at}`)}
          </li>,
        );
      run = [];
    };
    nodes.forEach((n, i) => {
      if (n.kind === "heading") {
        run.push(n.node);
        return;
      }
      flush(i);
      const ck = n.kind === "outside" ? "outside" : `l:${n.landmark.index}`;
      const open = !collapsed.has(ck);
      const label = n.kind === "outside" ? "Outside landmarks" : landmarkLabel(n.landmark);
      out.push(
        <li key={ck}>
          <div className="hd-line">
            {n.children.length ? <Fold open={open} label={label} onClick={() => toggle(ck)} /> : <NoFold />}
            {n.kind === "outside" ? (
              <div className="hd-row">
                <span className="hd-pseudo">Outside landmarks</span>
              </div>
            ) : (
              lmRow(n.landmark)
            )}
          </div>
          {n.children.length && open ? renderCombined(n.children, `${key}-${i}`) : null}
        </li>,
      );
    });
    flush(nodes.length);
    return (
      <ul className="hd-tree hd-combined" key={key}>
        {out}
      </ul>
    );
  };

  if (view === "headings") {
    if (!data.headings.length) return <Empty>No heading on this page.</Empty>;
    if (!list.length) return <Empty>Every heading is hidden: tick "Hidden ones" to see them.</Empty>;
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
    return renderOutline(outline, "root");
  }

  if (!landmarks) return <Empty>{loadingLandmarks ? "Reading the landmarks…" : ""}</Empty>;
  if (!landmarks.landmarks.length && view === "landmarks")
    return <Empty>No landmark on this page: no header, nav, main, aside or footer, nor landmark role.</Empty>;
  if (onlyIssues) {
    const flagged = landmarks.landmarks.filter((l) => byLandmark.has(l.index));
    const headings = view === "all" ? list.filter((h) => byHeading.has(h.index)) : [];
    return flagged.length || headings.length ? (
      <ul className="hd-tree">
        {flagged.map((l) => (
          <li key={`l${l.index}`}>{lmRow(l)}</li>
        ))}
        {headings.map((h) => (
          <li key={h.index}>{row(h)}</li>
        ))}
      </ul>
    ) : (
      <Empty>No issue on these {view === "all" ? "landmarks and headings" : "landmarks"}.</Empty>
    );
  }
  if (view === "landmarks")
    return lmTree.length ? renderLandmarks(lmTree, "lm") : <Empty>Every landmark is hidden: tick "Hidden ones" to see them.</Empty>;
  return allTree.length ? renderCombined(allTree, "all") : <Empty>Nothing to show: no landmark and no heading.</Empty>;
}

const LM_VIS: Record<RawLandmark["visibility"], string> = { visible: "", "aria-hidden": "not announced", hidden: "hidden" };

function LandmarkRow({
  l,
  issues,
  onShow,
  count,
}: {
  l: RawLandmark;
  issues: LandmarkIssue[] | undefined;
  onShow: (l: RawLandmark) => void;
  /** Show how many headings it holds (the All view shows the headings themselves). */
  count: boolean;
}) {
  const issue = worst(issues);
  const tags = [l.explicitRole ? `role on <${l.tag}>` : `<${l.tag}>`, LM_VIS[l.visibility]].filter(Boolean);
  const n = l.headingIndexes.length;
  return (
    <div className={`hd-row${isLandmarkExposed(l) ? "" : " muted"}`}>
      <button
        type="button"
        className="hd-main"
        onClick={() => onShow(l)}
        title={[l.selector, ...(issues ?? []).map((i) => `${i.label}: ${i.detail}`)].join("\n")}
      >
        <span className="pill hd-role">{l.role}</span>
        {issue ? <StatusIcon level={issue.level} label={issue.label} /> : null}
        <span className="hd-text">{l.name || <i className="muted">unnamed</i>}</span>
        {tags.map((t) => (
          <span key={t} className="pill hd-tag">
            {t}
          </span>
        ))}
        {count && n ? (
          <span className="hd-words" title={`${n} heading${n === 1 ? "" : "s"} directly in this landmark`}>
            <span className="viz-num">{`${n} heading${n === 1 ? "" : "s"}`}</span>
          </span>
        ) : null}
      </button>
    </div>
  );
}

function HeadingRow({
  h,
  issues,
  maxWords,
  onShow,
  onAsk,
  nested,
}: {
  h: RawHeading;
  issues: HeadingIssue[] | undefined;
  maxWords: number;
  onShow: (h: RawHeading) => void;
  onAsk: (h: RawHeading) => void;
  /** Already under its landmark (All view): no landmark pill. */
  nested?: boolean;
}) {
  const issue = worst(issues);
  const text = headingText(h);
  const tags = [
    h.role ? `role=heading on <${h.tag}>` : "",
    VIS_LABEL[h.visibility],
    !nested && h.landmark && h.landmark !== "main" ? h.landmark : "",
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
