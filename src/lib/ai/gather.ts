import { browser } from "wxt/browser";
import { type AuditOptions, DEFAULT_AUDIT_OPTIONS } from "../a11y";
import { loadAudit, runAxeAudit, saveAudit } from "../axe";
import { fetchHeaders, securityReport } from "../headers";
import { REPORT_HANDOFF_KEY, type ReportHandoff } from "../bug-report";
import { runInTab } from "../inject";
import { ELEMENT_HANDOFF_KEY, type ElementHandoff } from "../element";
import { analyzeJsonLd } from "../jsonld";
import { collectMeta, collectPerf, collectSelection, collectTechSignals, readBodyText } from "../page/collect";
import { readErrors } from "../page/errors";
import { secretsMarkdown } from "../agent/security";
import { collectLibrarySignals } from "../page/libraries";
import { collectSecretSources } from "../page/security";
import { analyzeLibraries, libraryMarkdown, pageProbes, snapshotDetections, type VulnDb } from "../security/libraries";
import { scanSecrets } from "../security/secrets";
import { seoReport } from "../seo";
import { detectTech } from "../tech";
import type { CapturedError, ContextPart, PageContext, PageText } from "./context";

/** Reads the parts of the page an AI call needs. Parts that fail are left out, not fatal. */
export async function gatherContext(
  tab: { id?: number; url?: string; title?: string; windowId: number },
  parts: ContextPart[],
  extra: { selection?: string } = {},
): Promise<PageContext> {
  const tabId = tab.id!;
  const url = tab.url ?? "";
  const ctx: PageContext = { url, title: tab.title ?? "" };
  const want = (p: ContextPart) => parts.includes(p);
  const safe = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  const needsMeta = want("meta") || want("seo") || want("jsonld");
  const needsHeaders = want("headers") || want("security") || want("tech");
  const [page, selection, meta, signals, headers, perf, errors, a11y, screenshot, secrets, libraries] = await Promise.all([
    want("text") ? safe(() => readPage(tabId)) : undefined,
    want("selection") ? (extra.selection ? Promise.resolve(extra.selection) : safe(() => runInTab(tabId, collectSelection))) : undefined,
    needsMeta ? safe(() => runInTab(tabId, collectMeta)) : undefined,
    want("tech") ? safe(() => runInTab(tabId, collectTechSignals, [], "MAIN")) : undefined,
    needsHeaders && /^https?:/.test(url) ? safe(() => fetchHeaders(url)) : undefined,
    want("perf") ? safe(() => runInTab(tabId, collectPerf)) : undefined,
    want("errors") ? safe(() => runInTab(tabId, readErrors, [], "MAIN")) : undefined,
    want("a11y") ? safe(() => readAudit(tabId, url)) : undefined,
    want("screenshot") ? safe(() => browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75 })) : undefined,
    want("secrets") ? safe(() => readSecrets(tabId, url)) : undefined,
    want("libraries") ? safe(() => readLibraries(tabId, url)) : undefined,
  ]);
  if (secrets) ctx.secrets = secrets;
  if (libraries) ctx.libraries = libraries;
  if (page) ctx.page = page;
  if (selection) ctx.selection = selection;
  if (meta) {
    ctx.meta = meta;
    ctx.title ||= meta.title;
    if (want("seo")) ctx.seo = seoReport(meta);
    if (want("jsonld")) ctx.jsonld = analyzeJsonLd(meta.jsonLd);
  }
  if (headers) {
    ctx.headers = headers.headers;
    if (want("security")) ctx.security = securityReport(headers.headers, headers.url).checks;
  }
  if (signals) ctx.tech = detectTech(signals, headers?.headers);
  if (perf) ctx.perf = perf;
  if (errors) ctx.errors = errors.errors as CapturedError[];
  if (a11y) ctx.a11y = a11y;
  if (screenshot) ctx.screenshot = screenshot;
  if (want("element")) {
    const stored = await safe(() => browser.storage.session.get(ELEMENT_HANDOFF_KEY));
    const handoff = stored?.[ELEMENT_HANDOFF_KEY] as ElementHandoff | undefined;
    if (handoff?.tabId === tabId) {
      ctx.element = handoff.markdown;
      ctx.elementImage = handoff.image;
    }
  }
  if (want("report")) {
    const stored = await safe(() => browser.storage.session.get(REPORT_HANDOFF_KEY));
    const handoff = stored?.[REPORT_HANDOFF_KEY] as ReportHandoff | undefined;
    if (handoff?.tabId === tabId) {
      ctx.report = handoff.markdown;
      ctx.reportImage = handoff.image;
    }
  }
  return ctx;
}

/** The Secrets panel's scan of the page's own sources (inline scripts, globals, storage…), values masked. */
async function readSecrets(tabId: number, url: string): Promise<string> {
  const snap = await runInTab(tabId, collectSecretSources, [2 * 1024 * 1024], "MAIN");
  return secretsMarkdown(scanSecrets(snap.sources), { url, scan: { sources: snap.sources.length } });
}

/** Libraries the page reveals (globals, script URLs, inline scripts) checked against the bundled database. */
async function readLibraries(tabId: number, url: string): Promise<string> {
  const res = await fetch(browser.runtime.getURL("/vuln-db.json"));
  const db = (await res.json()) as VulnDb;
  const snap = await runInTab(tabId, collectLibrarySignals, [pageProbes(db), 512 * 1024, 2 * 1024 * 1024], "MAIN");
  const results = analyzeLibraries(snapshotDetections(snap, db), db, snap.present);
  const flagged = results.filter((r) => r.status === "vulnerable" || r.status === "eol");
  const known = results.filter((r) => r.version).map((r) => `${r.name} ${r.version}`);
  const head = `## Vulnerable libraries (devkit panel: Security › Libraries)\nPage: ${url}\nResult: ${flagged.length ? `${flagged.length} of ${results.length} detected libraries flagged` : `none of the ${results.length} detected libraries is flagged`}. Detected: ${known.join(", ") || "none"}. Script files were not fetched for this summary; the Libraries panel scans them too.`;
  return [
    head,
    ...flagged.map((r) =>
      libraryMarkdown(r, { page: url, source: db.source })
        .replace(/^## /gm, "### ")
        .replace(/^### Advisories/gm, "#### Advisories"),
    ),
  ].join("\n\n");
}

/** The tab's last axe audit of this page, else a fresh one with the panel's options. A focused rule is read once. */
async function readAudit(tabId: number, url: string): Promise<PageContext["a11y"]> {
  const stored = await loadAudit(tabId, url);
  if (stored) {
    if (stored.focus) await saveAudit({ tabId, audit: stored.audit });
    return { audit: stored.audit, focus: stored.focus };
  }
  const { a11yOptions } = await browser.storage.local.get("a11yOptions");
  return { audit: await runAxeAudit(tabId, { ...DEFAULT_AUDIT_OPTIONS, ...(a11yOptions as Partial<AuditOptions> | undefined) }) };
}

/** Main content through Readability (page-snapshot.js), else the body's text. */
async function readPage(tabId: number): Promise<PageText> {
  try {
    const [res] = await browser.scripting.executeScript({ target: { tabId }, files: ["/page-snapshot.js"] });
    const value = res?.result as PageText | undefined;
    if (value?.text) return value;
  } catch {
    /* fall back below */
  }
  const text = await runInTab(tabId, readBodyText);
  return { title: "", text, readable: false };
}
