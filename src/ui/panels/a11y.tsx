// Accessibility audit: axe-core run in the page (isolated world), results grouped by rule, failing
// elements outlined in the page on click, Markdown for coding agents and the AI.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  type Audit,
  type AuditOptions,
  type AuditRule,
  type AuditScope,
  auditMarkdown,
  auditSummary,
  DEFAULT_AUDIT_OPTIONS,
  HONESTY,
  IMPACT_TEXT,
  IMPACTS,
  type Impact,
  ruleMarkdown,
  ruleStandard,
  sameDocument,
  scopeLabel,
  standardsLabel,
  targetLabel,
  wcagCriteria,
} from "../../lib/a11y";
import { auditKey, clearHighlight, highlightNode, loadAudit, runAxeAudit, type StoredAudit, saveAudit } from "../../lib/axe";
import { injectionError, runInTab } from "../../lib/inject";
import type { CollectResult, PickerApi, PickResult } from "../../lib/page/element";
import { PENDING_ROUTE_KEY } from "../../lib/panels";
import { a11yVerdict, type Verdict } from "../../lib/report";
import { Button, copyText, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { SegmentBar } from "../charts";
import { useStored } from "../hooks";
import { AccessGate, usePage } from "../page";

/** Above this many elements the Overview leaves the audit to this panel: axe takes about 1.5 s per 15k elements. */
export const AUTO_AUDIT_MAX_ELEMENTS = 3000;

/** The last audit of the current tab's page, kept live across devkit views. */
export function useStoredAudit(): [StoredAudit | null, boolean] {
  const page = usePage();
  const [stored, setStored] = useState<StoredAudit | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setStored(null);
    setReady(false);
    if (page.tabId === undefined) return;
    const tabId = page.tabId;
    let live = true;
    loadAudit(tabId, page.url).then((s) => {
      if (!live) return;
      setStored(s);
      setReady(true);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes[auditKey(tabId)];
      if (area !== "session" || !change) return;
      const next = change.newValue as StoredAudit | undefined;
      setStored(next && sameDocument(next.audit.url, page.url) ? next : null);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [page.tabId, page.url]);
  return [stored, ready];
}

/**
 * The Overview's accessibility row: the last audit of this page, or a fresh one when the page is small
 * enough to audit without a noticeable pause (big pages wait until the panel is opened).
 */
export function useA11yReport(elements: number | undefined): {
  verdict: Verdict | null;
  /** The stored audit of this page, when there is one. */
  audit: Audit | null;
  state: { loading: boolean; error: unknown };
  run: () => void;
} {
  const page = usePage();
  const [stored, ready] = useStoredAudit();
  const [options, , optionsReady] = useStored<AuditOptions>("a11yOptions", DEFAULT_AUDIT_OPTIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tried = useRef("");
  const small = elements !== undefined && elements <= AUTO_AUDIT_MAX_ELEMENTS;
  const run = useCallback(() => {
    if (page.tabId === undefined || !page.canScript || !small) return;
    setLoading(true);
    setError(null);
    runAxeAudit(page.tabId, { ...DEFAULT_AUDIT_OPTIONS, ...options })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [page.tabId, page.canScript, small, options]);
  useEffect(() => {
    const key = `${page.tabId}|${page.url}`;
    if (!ready || !optionsReady || stored || tried.current === key || elements === undefined) return;
    tried.current = key;
    run();
  }, [ready, optionsReady, stored, elements, page.tabId, page.url, run]);
  const verdict: Verdict | null = stored
    ? a11yVerdict(stored.audit)
    : elements !== undefined && !small && !loading
      ? { level: "info", text: "Large page: open to run the audit" }
      : null;
  const waiting = !error && page.canScript && (!ready || (!stored && elements === undefined));
  return { verdict, audit: stored?.audit ?? null, state: { loading: loading || waiting, error }, run };
}

/* Marks */

const IMPACT_COLOR: Record<Impact | "review" | "passed", string> = {
  critical: "var(--impact-critical)",
  serious: "var(--impact-serious)",
  moderate: "var(--impact-moderate)",
  minor: "var(--impact-minor)",
  review: "var(--impact-review)",
  passed: "var(--good)",
};

type Mark = Impact | "review" | "passed";

/** One shape per impact (square ×, diamond !, triangle !, circle –, ring ?, circle ✓), so it reads without color. */
export function ImpactIcon({ kind, label }: { kind: Mark; label?: string }) {
  const fill = IMPACT_COLOR[kind];
  const ink = { stroke: "var(--bg)", strokeWidth: 1.6, strokeLinecap: "round" as const, fill: "none" };
  const shape =
    kind === "critical" ? (
      <>
        <rect x=".5" y=".5" width="11" height="11" rx="2.5" fill={fill} />
        <path d="M4 4l4 4M8 4l-4 4" {...ink} />
      </>
    ) : kind === "serious" ? (
      <>
        <path d="M6 .3l5.7 5.7L6 11.7.3 6z" fill={fill} strokeLinejoin="round" />
        <path d="M6 3.4v3.1" {...ink} />
        <circle cx="6" cy="8.5" r=".8" fill="var(--bg)" />
      </>
    ) : kind === "moderate" ? (
      <>
        <path d="M6 .6l5.6 10.2H.4z" fill={fill} strokeLinejoin="round" />
        <path d="M6 4.3v3" {...ink} />
        <circle cx="6" cy="9" r=".8" fill="var(--bg)" />
      </>
    ) : kind === "minor" ? (
      <>
        <circle cx="6" cy="6" r="5.4" fill={fill} />
        <path d="M3.8 6h4.4" {...ink} />
      </>
    ) : kind === "review" ? (
      <>
        <circle cx="6" cy="6" r="4.8" fill="none" stroke={fill} strokeWidth="1.6" />
        <circle cx="6" cy="6" r="1.5" fill={fill} />
      </>
    ) : (
      <>
        <circle cx="6" cy="6" r="6" fill={fill} />
        <path d="M3.4 6.2l1.8 1.8 3.4-3.7" {...ink} strokeLinejoin="round" />
      </>
    );
  return label ? (
    <svg className="status-icon" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={label}>
      <title>{label}</title>
      {shape}
    </svg>
  ) : (
    <svg className="status-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {shape}
    </svg>
  );
}

/* Summary */

function AuditSummaryCard({ audit, onCopy, onAsk }: { audit: Audit; onCopy: () => void; onAsk: () => void }) {
  const s = auditSummary(audit);
  const parts = [
    ...IMPACTS.map((i) => ({ key: i as Mark, label: IMPACT_TEXT[i], value: s.rules[i] })),
    { key: "review" as Mark, label: "Needs review", value: s.review },
    { key: "passed" as Mark, label: "Passed", value: s.passed },
  ].map((p) => ({ ...p, color: IMPACT_COLOR[p.key], detail: p.value }));
  const total = parts.reduce((n, p) => n + p.value, 0);
  const time = new Date(audit.at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return (
    <div className="card ax-summary">
      <p className="ax-headline">
        {s.violations ? (
          <>
            <b>{s.violations.toLocaleString("en")}</b> {s.violations === 1 ? "rule fails" : "rules fail"} on{" "}
            <b>{s.failingElements.toLocaleString("en")}</b> {s.failingElements === 1 ? "element" : "elements"}
          </>
        ) : (
          <>No violation found by the automated checks</>
        )}
      </p>
      <SegmentBar
        tall
        parts={parts}
        label={`${total} rules checked: ${parts
          .filter((p) => p.value)
          .map((p) => `${p.value} ${p.label.toLowerCase()}`)
          .join(", ")}`}
      />
      <ul className="viz-legend" aria-label="Rules by result">
        {parts
          .filter((p) => p.value)
          .map((p) => (
            <li key={p.key}>
              <ImpactIcon kind={p.key} />
              <span>{p.label}</span>
              <span className="viz-num">{p.value}</span>
            </li>
          ))}
      </ul>
      <p className="small muted ax-meta">
        {scopeLabel(audit.scope)} · {audit.elements.toLocaleString("en")} elements · {audit.ms.toLocaleString("en")} ms · {time}
        {audit.iframes ? ` · ${audit.iframes} ${audit.iframes === 1 ? "iframe" : "iframes"} not audited` : ""}
      </p>
      <div className="row">
        <Button variant="primary" onClick={onCopy}>
          Copy for agent
        </Button>
        <Button onClick={onAsk}>Ask AI about it</Button>
      </div>
    </div>
  );
}

/* Rules */

function FixList({ summary }: { summary: string }) {
  const groups: { head?: string; items: string[] }[] = [];
  for (const raw of summary.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/following:$/.test(line)) groups.push({ head: line, items: [] });
    else (groups.at(-1) ?? groups[groups.push({ items: [] }) - 1]!).items.push(line);
  }
  if (!groups.length) return null;
  return (
    <div className="ax-fix">
      {groups.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text
        <div key={i}>
          {g.head ? <p className="ax-fix-head">{g.head}</p> : null}
          <ul>
            {g.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static text
              <li key={j}>{it}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RuleCard({
  rule,
  kind,
  open,
  active,
  onShow,
  onCopy,
  onAsk,
}: {
  rule: AuditRule;
  kind: "violation" | "review";
  open: boolean;
  active: string | null;
  onShow: (rule: AuditRule, index: number) => void;
  onCopy: (rule: AuditRule) => void;
  onAsk: (rule: AuditRule) => void;
}) {
  const mark: Mark = kind === "review" ? "review" : (rule.impact ?? "minor");
  const criteria = wcagCriteria(rule.tags);
  const markLabel = kind === "review" ? "Needs review" : IMPACT_TEXT[rule.impact ?? "minor"];
  return (
    <li className="ax-rule">
      <details open={open}>
        <summary>
          <svg className="ax-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 2.5L8 6l-3.5 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="ax-rule-head">
            <ImpactIcon kind={mark} label={markLabel} />
            <span className="ax-rule-help">{rule.help}</span>
            <span className="pill viz-num" title={`${rule.nodeCount} ${rule.nodeCount === 1 ? "element" : "elements"}`}>
              {rule.nodeCount}
            </span>
          </span>
          <span className="ax-rule-meta">
            <code className="ax-rule-id">{rule.id}</code>
            <span>{kind === "review" ? "needs review" : (rule.impact ?? "minor")}</span>
            <span>{ruleStandard(rule.tags)}</span>
            {criteria.map((c) => (
              <span key={c.sc}>
                {c.sc} {c.name}
              </span>
            ))}
          </span>
        </summary>
        <div className="ax-rule-body">
          {rule.description ? <p className="small ax-desc">{rule.description}.</p> : null}
          <div className="row">
            <Button size="small" onClick={() => onCopy(rule)}>
              Copy for agent
            </Button>
            <Button size="small" onClick={() => onAsk(rule)} title="Ask your AI to explain and fix this rule">
              Ask AI
            </Button>
            {rule.helpUrl ? (
              <a
                className="ax-learn small"
                href={rule.helpUrl}
                target="_blank"
                rel="noreferrer"
                title={`The ${rule.id} rule explained by Deque`}
              >
                Learn more at Deque
              </a>
            ) : null}
          </div>
          <ol className="ax-nodes">
            {rule.nodes.map((n, i) => {
              const key = `${rule.id}:${i}`;
              const selector = targetLabel(n.target);
              return (
                <li key={key} className={active === key ? "active" : undefined}>
                  <button
                    type="button"
                    className="ax-target"
                    aria-pressed={active === key}
                    title="Scroll to it and outline it in the page"
                    disabled={!n.target.length}
                    onClick={() => onShow(rule, i)}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <rect
                        x="1.5"
                        y="1.5"
                        width="9"
                        height="9"
                        rx="1.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeDasharray="2.4 1.6"
                      />
                      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
                    </svg>
                    <code className="ax-target-sel break">{selector || "(no selector)"}</code>
                  </button>
                  {n.html ? <pre className="ax-html">{n.html}</pre> : null}
                  {i > 0 && n.summary && n.summary === rule.nodes[i - 1]!.summary ? (
                    <p className="small muted ax-same">Same fix as above.</p>
                  ) : (
                    <FixList summary={n.summary} />
                  )}
                </li>
              );
            })}
          </ol>
          {rule.nodeCount > rule.nodes.length ? (
            <p className="small muted" style={{ margin: 0 }}>
              {rule.nodeCount - rule.nodes.length} more not listed. Fix these, then run the audit again.
            </p>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/* Region picker: the element picker's overlay, in the MAIN world */

type PickerWin = { __devkitElement?: PickerApi };
const pickInPage = (): Promise<PickResult> => (window as unknown as PickerWin).__devkitElement!.pick();
const collectInPage = (): Promise<CollectResult> => (window as unknown as PickerWin).__devkitElement!.collect({});
const cancelPickInPage = () => (window as unknown as PickerWin).__devkitElement?.cancel();

async function pickRegion(tabId: number): Promise<AuditScope | null> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["/element-picker.js"], world: "MAIN" } as never);
  const r = await runInTab(tabId, pickInPage, [], "MAIN");
  if (r.status !== "picked") return null;
  const c = await runInTab(tabId, collectInPage, [], "MAIN");
  if (c.status !== "ok") return null;
  return { selector: c.info.selector, shadow: c.info.shadowHost ? [c.info.shadowHost] : undefined };
}

/* Panel */

export function A11yAudit() {
  const page = usePage();
  const toast = useToast();
  const [stored, ready] = useStoredAudit();
  const [options, setOptions, optionsReady] = useStored<AuditOptions>("a11yOptions", DEFAULT_AUDIT_OPTIONS);
  const opts = { ...DEFAULT_AUDIT_OPTIONS, ...options };
  const [scopeText, setScopeText] = useState("");
  const [pickedShadow, setPickedShadow] = useState<string[] | undefined>();
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const autoRan = useRef("");
  const pickingTab = useRef<number | null>(null);
  const tabId = page.tabId;
  const audit = stored?.audit ?? null;

  const scope: AuditScope | null = scopeText.trim() ? { selector: scopeText.trim(), shadow: pickedShadow } : null;

  const run = async (o: AuditOptions = opts, s: AuditScope | null = scope) => {
    if (tabId === undefined) return;
    setRunning(true);
    setError(null);
    setActive(null);
    try {
      await runAxeAudit(tabId, o, s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // First visit of a page: audit it right away. A stored audit of the same page is shown as is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page
  useEffect(() => {
    const key = `${tabId}|${page.url}`;
    if (!ready || !optionsReady || !page.canScript || stored || autoRan.current === key) return;
    autoRan.current = key;
    run(opts, null);
  }, [ready, optionsReady, page.canScript, stored, tabId, page.url]);

  // Per page: forget the region, and take the outline away when leaving the panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per page
  useEffect(() => {
    setError(null);
    setActive(null);
    if (tabId === undefined) return;
    return () => {
      clearHighlight(tabId);
      if (pickingTab.current === tabId) runInTab(tabId, cancelPickInPage, [], "MAIN").catch(() => undefined);
    };
  }, [tabId, page.url]);

  // A new audit (from here, the Overview or the AI) brings its region along.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per audit
  useEffect(() => {
    if (!stored) return;
    setScopeText(stored.audit.scope?.selector ?? "");
    setPickedShadow(stored.audit.scope?.shadow);
  }, [stored?.audit.at]);

  const setOption = (patch: Partial<AuditOptions>) => {
    const next = { ...opts, ...patch };
    setOptions(next);
    run(next, scope);
  };

  const pick = async () => {
    if (tabId === undefined) return;
    setPicking(true);
    pickingTab.current = tabId;
    setError(null);
    try {
      const picked = await pickRegion(tabId);
      if (picked) {
        setScopeText(picked.selector);
        setPickedShadow(picked.shadow);
        await run(opts, picked);
      }
    } catch (e) {
      setError(injectionError(e));
    } finally {
      pickingTab.current = null;
      setPicking(false);
    }
  };
  const cancelPick = () => {
    if (tabId !== undefined) runInTab(tabId, cancelPickInPage, [], "MAIN").catch(() => undefined);
  };
  const wholePage = () => {
    setScopeText("");
    setPickedShadow(undefined);
    run(opts, null);
  };

  const show = async (rule: AuditRule, index: number) => {
    if (tabId === undefined) return;
    const node = rule.nodes[index]!;
    const key = `${rule.id}:${index}`;
    if (active === key) {
      setActive(null);
      await clearHighlight(tabId);
      return;
    }
    const r = await highlightNode(tabId, node.target, `${rule.id} · ${targetLabel(node.target)}`);
    if (r === "shown") setActive(key);
    else {
      setActive(null);
      toast(
        r === "hidden"
          ? "This element takes no space on screen (hidden or collapsed): look for it in the HTML."
          : "This element is no longer in the page. Run the audit again.",
        true,
      );
    }
  };

  const copy = async (text: string, what: string) =>
    toast((await copyText(text)) ? `${what} copied.` : "The clipboard refused the copy.", !text);
  const copyRule = (rule: AuditRule) =>
    copy(
      ruleMarkdown(rule, { url: audit?.url, kind: audit?.incomplete.includes(rule) ? "review" : "violation" }),
      `Markdown for ${rule.id}`,
    );
  const ask = async (rule?: AuditRule) => {
    if (!audit || tabId === undefined) return;
    await saveAudit({ tabId, audit, focus: rule?.id });
    await browser.storage.session.set({
      [PENDING_ROUTE_KEY]: { panel: "ask", params: { action: rule ? "a11y-rule" : "a11y-review", at: String(Date.now()) } },
    });
  };

  const openRules = useMemo(() => (audit ? audit.violations.length <= 4 : false), [audit]);

  return (
    <AccessGate>
      <Section
        title="Accessibility audit"
        actions={
          <Button variant={audit ? undefined : "primary"} busy={running} disabled={!page.canScript || picking} onClick={() => run()}>
            {audit ? "Run again" : "Run audit"}
          </Button>
        }
        hint={
          <>
            axe-core{audit?.axeVersion ? ` ${audit.axeVersion}` : ""} · {standardsLabel(opts)}. {HONESTY}
          </>
        }
      >
        <div className="ax-options">
          <label className="check small">
            <input
              type="checkbox"
              checked={opts.bestPractices}
              disabled={running}
              onChange={(e) => setOption({ bestPractices: e.target.checked })}
            />
            Best practices
          </label>
          <label className="check small">
            <input type="checkbox" checked={opts.aaa} disabled={running} onChange={(e) => setOption({ aaa: e.target.checked })} />
            AAA rules
          </label>
        </div>
        <form
          className="ax-scope"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <label className="field grow">
            Region (CSS selector)
            <input
              type="search"
              value={scopeText}
              placeholder="Whole page (or main, #cart)"
              spellCheck={false}
              onChange={(e) => {
                setScopeText(e.target.value);
                setPickedShadow(undefined);
              }}
            />
          </label>
          {picking ? (
            <Button onClick={cancelPick}>Cancel</Button>
          ) : (
            <Button onClick={pick} disabled={running || !page.canScript} title="Pick the region in the page with the element picker">
              Pick
            </Button>
          )}
          {audit?.scope ? (
            <Button variant="ghost" onClick={wholePage} disabled={running}>
              Whole page
            </Button>
          ) : null}
        </form>
        {picking ? (
          <Notice>
            <span className="grow">
              <b>Picking a region.</b> Click an element of the page. <kbd>↑</kbd> <kbd>↓</kbd> move to the parent or child, <kbd>Esc</kbd>{" "}
              cancels.
            </span>
          </Notice>
        ) : null}
        <ErrorText error={error} />
        {running && !audit ? <Empty>Auditing the page…</Empty> : null}
      </Section>

      {audit ? (
        <>
          <AuditSummaryCard
            audit={audit}
            onCopy={() => copy(auditMarkdown(audit, { title: page.tab?.title }), "Audit as Markdown")}
            onAsk={() => ask()}
          />

          <Section title={`Violations (${audit.violations.length})`}>
            {audit.violations.length ? (
              <ul className="ax-rules" aria-label="Violations">
                {audit.violations.map((r) => (
                  <RuleCard
                    key={r.id}
                    rule={r}
                    kind="violation"
                    open={openRules}
                    active={active}
                    onShow={show}
                    onCopy={copyRule}
                    onAsk={ask}
                  />
                ))}
              </ul>
            ) : (
              <Notice kind="good">
                No rule fails{audit.scope ? " in this region" : ""}. Test with a keyboard and a screen reader next.
              </Notice>
            )}
          </Section>

          {audit.incomplete.length ? (
            <Section title={`Needs review (${audit.incomplete.length})`} hint="axe could not decide on these: check them by hand.">
              <ul className="ax-rules" aria-label="Needs review">
                {audit.incomplete.map((r) => (
                  <RuleCard key={r.id} rule={r} kind="review" open={false} active={active} onShow={show} onCopy={copyRule} onAsk={ask} />
                ))}
              </ul>
            </Section>
          ) : null}

          {audit.passes.length ? (
            <Section title={`Passed (${audit.passes.length})`}>
              <details className="ax-passes">
                <summary className="ax-passes-summary small muted">Rules with no failing element</summary>
                <ul>
                  {audit.passes.map((p) => (
                    <li key={p.id}>
                      <ImpactIcon kind="passed" />
                      <span className="grow">{p.help}</span>
                      <code className="ax-pass-id muted">{p.id}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </Section>
          ) : null}
        </>
      ) : null}
    </AccessGate>
  );
}
