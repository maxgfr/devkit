// Runs the axe-core audit in a tab and keeps its last result per tab, for the Accessibility panel,
// the Overview's page report and the AI context.
import { browser } from "wxt/browser";
import { AXE_API_VERSION, type Audit, type AuditOptions, type AuditScope, sameDocument } from "./a11y";
import { injectionError, runInTab } from "./inject";
import type { AuditResponse, AxeApi, HighlightResult } from "./page/axe";

/** The last audit of a tab, and the rule an "Ask AI" asked about (read once by the AI context). */
export interface StoredAudit {
  tabId: number;
  audit: Audit;
  focus?: string;
}

export const auditKey = (tabId: number) => `a11yAudit:${tabId}`;

// These run in the page's ISOLATED world, next to axe-audit.js: only globals, no outer scope.
type Api = { __devkitAxe?: AxeApi };
const ready = (v: number) => (window as unknown as Api).__devkitAxe?.v === v;
const runInPage = (o: AuditOptions, s: AuditScope | null) => (window as unknown as Api).__devkitAxe!.run(o, s);
const highlightInPage = (t: string[], l: string) => (window as unknown as Api).__devkitAxe?.highlight(t, l) ?? "missing";
const clearInPage = () => (window as unknown as Api).__devkitAxe?.clear();

/** Injects axe-audit.js (once per page load: it is ~650 KB), then runs `func` next to it. */
async function inAxe<Args extends unknown[], R>(tabId: number, func: (...args: Args) => R, args: Args): Promise<Awaited<R>> {
  if (!(await runInTab(tabId, ready, [AXE_API_VERSION]).catch(() => false)))
    await browser.scripting.executeScript({ target: { tabId }, files: ["/axe-audit.js"] });
  return runInTab(tabId, func, args);
}

/** Audits the page in `tabId` and stores the result. Throws with a message the user can act on. */
export async function runAxeAudit(tabId: number, options: AuditOptions, scope: AuditScope | null = null): Promise<Audit> {
  let res: AuditResponse;
  try {
    res = await inAxe(tabId, runInPage, [options, scope]);
  } catch (e) {
    throw new Error(injectionError(e));
  }
  if (!res.ok) throw new Error(res.error);
  await saveAudit({ tabId, audit: res.audit });
  return res.audit;
}

export async function highlightNode(tabId: number, target: string[], label: string): Promise<HighlightResult> {
  try {
    return await inAxe(tabId, highlightInPage, [target, label]);
  } catch {
    return "missing";
  }
}

export const clearHighlight = (tabId: number) => runInTab(tabId, clearInPage).catch(() => undefined);

export async function saveAudit(stored: StoredAudit): Promise<void> {
  await browser.storage.session.set({ [auditKey(stored.tabId)]: stored }).catch(() => undefined);
}

/** The tab's last audit, when it was taken on `url` (a page navigated since has its own state). */
export async function loadAudit(tabId: number, url: string): Promise<StoredAudit | null> {
  const key = auditKey(tabId);
  const got: Record<string, unknown> = await browser.storage.session.get(key).catch(() => ({}));
  const stored = got[key] as StoredAudit | undefined;
  return stored && sameDocument(stored.audit.url, url) ? stored : null;
}
