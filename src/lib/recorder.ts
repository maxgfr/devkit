// Steps recorder plumbing: the side panel starts and stops it in the page, the background keeps the
// steps per tab in session storage (every write goes through it, one at a time) and starts the
// recorder again after each navigation of a recorded tab.
import { browser } from "wxt/browser";
import { appendStep, type RecorderState, recorderKey, type Step } from "./steps";
import { runInTab } from "./inject";
import type { ReportPageApi } from "./page/recorder";

type ReportWindow = { __devkitReport?: ReportPageApi };

// These run in the page (ISOLATED world, next to /bug-report.js): only globals, no outer scope.
const startInPage = (o: { recordValues: boolean }) => (window as unknown as ReportWindow).__devkitReport?.start(o) ?? false;
const stopInPage = () => {
  (window as unknown as ReportWindow).__devkitReport?.stop();
};
const domInPage = (max: number) => (window as unknown as ReportWindow).__devkitReport?.dom(max) ?? null;

/** Installs /bug-report.js in the page's top frame (once per page load). */
export async function injectReportPage(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["/bug-report.js"] });
}

export async function readRecorder(tabId: number): Promise<RecorderState | null> {
  const key = recorderKey(tabId);
  const stored = await browser.storage.session.get(key);
  return (stored[key] as RecorderState | undefined) ?? null;
}

/** Starts recording in the tab, from a fresh list whose first step opens the current URL. */
export async function startRecording(tab: { id?: number; url?: string }, recordValues: boolean): Promise<RecorderState> {
  const tabId = tab.id!;
  await injectReportPage(tabId);
  await runInTab(tabId, startInPage, [{ recordValues }]);
  const now = Date.now();
  const state: RecorderState = {
    tabId,
    recording: true,
    startedAt: now,
    recordValues,
    lastUrl: tab.url,
    steps: tab.url ? [{ kind: "open", url: tab.url, time: now }] : [],
  };
  await tellBackground({ op: "set", tabId, state });
  return state;
}

export async function stopRecording(tabId: number): Promise<void> {
  await runInTab(tabId, stopInPage).catch(() => undefined);
  // Let the page's last pending step (text typed a moment ago) reach the background first.
  await new Promise((r) => setTimeout(r, 150));
  await tellBackground({ op: "stop", tabId });
}

export async function clearRecording(tabId: number): Promise<void> {
  await runInTab(tabId, stopInPage).catch(() => undefined);
  await tellBackground({ op: "clear", tabId });
}

/** The main region of the page as trimmed HTML (no scripts, styles or form values). */
export async function snapshotDom(tabId: number, max = 8000): Promise<{ html: string; root: string; trimmed: boolean } | null> {
  await injectReportPage(tabId);
  return runInTab(tabId, domInPage, [max]);
}

type RecorderOp = { op: "set"; tabId: number; state: RecorderState } | { op: "stop" | "clear"; tabId: number };

async function tellBackground(op: RecorderOp): Promise<void> {
  const ok = await browser.runtime.sendMessage({ type: "devkit:recorder", ...op });
  if (ok !== true) throw new Error("devkit's background did not answer. Reload the extension and try again.");
}

// Background side. Updates run one after the other: steps arrive faster than storage answers.
let queue: Promise<unknown> = Promise.resolve();

function updateRecorder(tabId: number, fn: (s: RecorderState | null) => RecorderState | null | "remove"): Promise<void> {
  const run = queue.then(async () => {
    const before = await readRecorder(tabId);
    const after = fn(before);
    if (after === "remove") await browser.storage.session.remove(recorderKey(tabId));
    else if (after && after !== before) await browser.storage.session.set({ [recorderKey(tabId)]: after });
  });
  queue = run.catch(() => undefined);
  return run;
}

/** The new state after an operation from the side panel. */
export function applyRecorderOp(s: RecorderState | null, op: RecorderOp, now = Date.now()): RecorderState | null | "remove" {
  if (op.op === "set") return op.state;
  if (op.op === "clear") return "remove";
  return s ? { ...s, recording: false, stoppedAt: now } : s;
}

/** Background listeners: operations from the side panel, steps from the page, navigations of recorded tabs, closed tabs. */
export function registerRecorder(): void {
  browser.runtime.onMessage.addListener((message: { type?: string; step?: Step } & Partial<RecorderOp>, sender, sendResponse) => {
    // Only devkit's own pages (side panel, popped-out window) drive the recorder, never a page script.
    const fromDevkit = sender.url?.startsWith(browser.runtime.getURL("/")) ?? false;
    if (message?.type === "devkit:recorder" && typeof message.tabId === "number" && fromDevkit) {
      const op = message as RecorderOp;
      updateRecorder(op.tabId, (s) => applyRecorderOp(s, op))
        .catch(() => undefined)
        .then(() => sendResponse(true));
      return true;
    }
    const tabId = sender.tab?.id;
    if (message?.type !== "devkit:step" || !message.step || tabId === undefined || sender.frameId !== 0) return;
    const step = message.step;
    updateRecorder(tabId, (s) => (s?.recording ? { ...s, steps: appendStep(s.steps, step) } : s)).catch(() => undefined);
  });

  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) {
      const url = info.url;
      updateRecorder(tabId, (s) =>
        s?.recording && url !== s.lastUrl
          ? { ...s, lastUrl: url, steps: appendStep(s.steps, { kind: "navigate", url, time: Date.now() }) }
          : s,
      ).catch(() => undefined);
    }
    if (info.status === "complete")
      readRecorder(tabId)
        .then(async (s) => {
          if (!s?.recording) return;
          // A new document has no recorder: start it again (a no-op when it is still there).
          await injectReportPage(tabId);
          await runInTab(tabId, startInPage, [{ recordValues: s.recordValues }]);
        })
        .catch(() => undefined);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.remove(recorderKey(tabId)).catch(() => undefined);
  });
}
