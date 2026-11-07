// Reads everything a bug report can hold from the current tab. Each part fails on its own: a part
// that cannot be read is left out with a reason, never fatal.
import { browser } from "wxt/browser";
import {
  buildReport,
  DEFAULT_REPORT_PARTS,
  DEFAULT_SLOW_MS,
  type ReportData,
  type ReportError,
  type ReportPart,
  TEXT_EXCERPT,
} from "./bug-report";
import { buildElementMarkdown, captureMatches, cropRegion, ELEMENT_HANDOFF_KEY, type ElementHandoff, type ElementInfo } from "./element";
import { fetchHeaders } from "./headers";
import { runInTab } from "./inject";
import { collectPerf, collectTechSignals } from "./page/collect";
import type { CollectResult, PickerApi } from "./page/element";
import { readErrors } from "./page/errors";
import { collectEnvironment, collectRequests, collectTextExcerpt } from "./page/report";
import { collectStorageUsage } from "./page/storage";
import { readRecorder, snapshotDom } from "./recorder";
import { type CookieTotals, storageMarkdown } from "./storage-usage";
import { detectTech } from "./tech";

type GatherTab = { id?: number; url?: string; title?: string; windowId: number };

export type Gathered = Omit<ReportData, "description" | "slowMs" | "screenshot"> & {
  /** Why a part is missing, in words for the panel. */
  missing: Partial<Record<ReportPart, string>>;
  elementImage?: string;
};

// Runs in the page (MAIN world): the element picker's last pick, without installing the picker.
const readPick = (): Promise<CollectResult> | CollectResult => {
  const api = (window as unknown as { __devkitElement?: PickerApi }).__devkitElement;
  return api ? api.collect({}) : { status: "none" };
};

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

/** The visible part of the tab as a PNG, when the tab is the one shown in its window. */
export async function captureViewport(tab: GatherTab): Promise<{ image?: string; reason?: string }> {
  const [active] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) return { reason: "the tab is not the visible one in its window" };
  try {
    return { image: await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The element cut out of a viewport capture, like the element picker does. */
async function cropElement(shot: string, info: ElementInfo): Promise<string | undefined> {
  if (info.hidden || !info.inView) return undefined;
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  try {
    if (!captureMatches(info.viewport, bitmap)) return undefined;
    const region = cropRegion(info.rect, info.viewport, bitmap);
    if (!region) return undefined;
    const scale = Math.min(1, 1600 / region.sw, 1600 / region.sh);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(region.sw * scale)), Math.max(1, Math.round(region.sh * scale)));
    canvas.getContext("2d")!.drawImage(bitmap, region.sx, region.sy, region.sw, region.sh, 0, 0, canvas.width, canvas.height);
    return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  } finally {
    bitmap.close();
  }
}

/** Cookie count and size: every cookie when devkit may read them, else what the page sees. */
async function cookieTotals(url: string, fallback: CookieTotals | undefined): Promise<CookieTotals> {
  if (url && (await browser.permissions.contains({ permissions: ["cookies"] }))) {
    const all = await browser.cookies.getAll({ url });
    return {
      count: all.length,
      bytes: all.reduce((n, c) => n + c.name.length + c.value.length, 0),
      httpOnly: all.filter((c) => c.httpOnly).length,
    };
  }
  return fallback ?? { count: 0, bytes: 0 };
}

/** Reads every part from the tab, and a viewport screenshot when `screenshot` is set. */
export async function gatherReport(
  tab: GatherTab,
  options: { screenshot?: boolean } = {},
): Promise<Gathered & { screenshot?: string; screenshotMissing?: string }> {
  const tabId = tab.id!;
  const url = tab.url ?? "";
  const missing: Gathered["missing"] = {};
  const [env, recorder, errors, requests, perf, signals, headers, storage, text, dom, pick, handoff] = await Promise.all([
    safe(() => runInTab(tabId, collectEnvironment)),
    safe(() => readRecorder(tabId)),
    safe(() => runInTab(tabId, readErrors, [], "MAIN")),
    safe(() => runInTab(tabId, collectRequests)),
    safe(() => runInTab(tabId, collectPerf)),
    safe(() => runInTab(tabId, collectTechSignals, [], "MAIN")),
    /^https?:/.test(url) ? safe(() => fetchHeaders(url)) : undefined,
    safe(() => runInTab(tabId, collectStorageUsage)),
    safe(() => runInTab(tabId, collectTextExcerpt, [TEXT_EXCERPT])),
    safe(() => snapshotDom(tabId)),
    safe(() => runInTab(tabId, readPick, [], "MAIN")),
    safe(async () => (await browser.storage.session.get(ELEMENT_HANDOFF_KEY))[ELEMENT_HANDOFF_KEY] as ElementHandoff | undefined),
  ]);

  const out: Gathered & { screenshot?: string; screenshotMissing?: string } = { url, title: env?.title || tab.title || "", missing };
  if (env) out.env = env;
  else missing.environment = "devkit could not read the page.";

  if (recorder?.steps.length) out.steps = { steps: recorder.steps, recording: recorder.recording, recordValues: recorder.recordValues };
  else missing.steps = "Nothing recorded yet.";

  if (errors) out.errors = { installed: errors.installed, errors: errors.errors as ReportError[] };
  else missing.errors = "devkit could not read the captured errors.";

  if (requests) out.requests = requests;
  else missing.requests = "Resource Timing could not be read.";

  if (perf)
    out.vitals = {
      lcp: perf.lcp,
      cls: perf.cls,
      inp: perf.inp,
      fcp: perf.fcp,
      ttfb: perf.navigation?.ttfb ?? null,
      longTasks: perf.longTasks,
    };
  else missing.vitals = "Web Vitals could not be read.";

  if (signals) out.tech = detectTech(signals, headers?.headers).map((t) => ({ name: t.name, category: t.category }));
  else missing.tech = "The page could not be read.";

  if (storage)
    out.storage = storageMarkdown(storage, await cookieTotals(url, storage.documentCookies).catch(() => storage.documentCookies));
  else missing.storage = "The site's storage could not be read.";

  if (text?.text) out.text = text;
  else missing.text = "The page has no visible text.";

  if (dom?.html) out.dom = dom;
  else missing.dom = "The page's DOM could not be read.";

  let shot: { image?: string; reason?: string } | undefined;
  const picked = pick?.status === "ok" ? pick.info : null;
  if (options.screenshot || picked?.inView) shot = await safe(() => captureViewport(tab));
  if (options.screenshot) {
    if (shot?.image) out.screenshot = shot.image;
    else out.screenshotMissing = shot?.reason ?? "the capture failed";
  }
  if (picked) {
    const image = shot?.image ? await safe(() => cropElement(shot.image!, picked)) : undefined;
    out.element = { markdown: buildElementMarkdown(picked, { image: Boolean(image) }), image: Boolean(image) };
    out.elementImage = image;
  } else if (handoff && handoff.tabId === tabId && handoff.url === url) {
    out.element = { markdown: handoff.markdown, image: Boolean(handoff.image) };
    out.elementImage = handoff.image;
  } else
    missing.element =
      pick?.status === "detached" ? "The picked element is no longer in the page: pick it again." : "No element picked on this page yet.";
  return out;
}

/** The report the palette copies: the parts the panel last used (or the defaults), no description, no images. */
export async function quickReport(tab: GatherTab): Promise<{ markdown: string; redacted: number }> {
  const stored = await browser.storage.local.get(["reportParts", "reportSlowMs"]).catch(() => ({}) as Record<string, unknown>);
  const parts = (stored.reportParts as ReportPart[] | undefined) ?? DEFAULT_REPORT_PARTS;
  const slowMs = (stored.reportSlowMs as number | undefined) ?? DEFAULT_SLOW_MS;
  const g = await gatherReport(tab);
  const { markdown, redacted } = buildReport({ ...g, description: "", slowMs, screenshot: false }, parts);
  return { markdown, redacted };
}
