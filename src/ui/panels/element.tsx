import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  buildElementMarkdown,
  buildLocator,
  captureMatches,
  cropRegion,
  ELEMENT_HANDOFF_KEY,
  type ElementError,
  type ElementHandoff,
  type ElementInfo,
  elementLabel,
  formatSource,
} from "../../lib/element";
import { injectionError, runInTab } from "../../lib/inject";
import type { CollectOptions, CollectResult, PickerApi, PickResult } from "../../lib/page/element";
import { readErrors } from "../../lib/page/errors";
import { PENDING_ROUTE_KEY } from "../../lib/panels";
import { Button, Code, copyText, Empty, JsonTree, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
import { AccessGate, usePage } from "../page";
import type { PanelProps } from "./index";
import { dataUrlToBlob } from "./page-tools";

// These run in the page (MAIN world): only globals, no outer scope.
type Api = { __devkitElement?: PickerApi };
const pickInPage = (): Promise<PickResult> => (window as unknown as Api).__devkitElement!.pick();
const collectInPage = (o: CollectOptions): Promise<CollectResult> => (window as unknown as Api).__devkitElement!.collect(o);
const cancelInPage = () => (window as unknown as Api).__devkitElement?.cancel();
const nudgeInPage = (dir: "up" | "down" | "enter") =>
  dir === "enter" ? (window as unknown as Api).__devkitElement?.confirm() : (window as unknown as Api).__devkitElement?.nudge(dir);
const flashInPage = () => (window as unknown as Api).__devkitElement?.flash() ?? false;

/** Installs the picker bundle in the page (once per page load), then runs `func` next to it. */
async function inPicker<Args extends unknown[], R>(tabId: number, func: (...args: Args) => R, args: Args): Promise<Awaited<R>> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["/element-picker.js"], world: "MAIN" } as never);
  return runInTab(tabId, func, args, "MAIN");
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** A PNG of the element, cut out of the visible tab. Null with a reason when it cannot be captured. */
async function captureElement(tab: { id?: number; windowId: number }, info: ElementInfo): Promise<{ image?: string; reason?: string }> {
  if (info.hidden) return { reason: `the element is hidden (${info.hidden})` };
  if (!info.inView) return { reason: "the element is outside the viewport" };
  const [active] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) return { reason: "the tab is not the visible one in its window" };
  const shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(dataUrlToBlob(shot));
  if (!captureMatches(info.viewport, bitmap)) {
    bitmap.close();
    return { reason: "the capture does not match the page's viewport (device emulation on?)" };
  }
  const region = cropRegion(info.rect, info.viewport, bitmap);
  if (!region) return { reason: "the element is not on screen" };
  const scale = Math.min(1, 1600 / region.sw, 1600 / region.sh);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(region.sw * scale)), Math.max(1, Math.round(region.sh * scale)));
  canvas.getContext("2d")!.drawImage(bitmap, region.sx, region.sy, region.sw, region.sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { image: await blobToDataUrl(await canvas.convertToBlob({ type: "image/png" })) };
}

type Phase = "idle" | "picking" | "cancelled" | "picked";

const CRUMBS_SHOWN = 5;

export function ElementPicker({ params }: PanelProps) {
  const page = usePage();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<ElementInfo | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [noImage, setNoImage] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<ElementError[] | null>(null);
  const [withErrors, setWithErrors] = useStored<boolean>("elementWithErrors", false);
  const [allCrumbs, setAllCrumbs] = useState(false);
  const pickingTab = useRef<number | null>(null);
  // The page a result belongs to: a pick that ends after the tab or URL changed is dropped.
  const pageKey = useRef("");
  pageKey.current = `${page.tabId}|${page.url}`;
  const autoPicked = useRef<string | null>(null);

  const tabId = page.tabId;

  const load = useCallback(
    async (options: CollectOptions, quiet = false) => {
      if (tabId === undefined || !page.tab) return;
      setBusy(true);
      try {
        const r = await inPicker(tabId, collectInPage, [options]);
        if (r.status === "none") {
          if (!quiet) setPhase("idle");
          return;
        }
        if (r.status === "detached") {
          if (!quiet) setDetached(true);
          return;
        }
        setDetached(false);
        setInfo(r.info);
        setPhase("picked");
        setAllCrumbs(false);
        if (r.refound) toast("The element was re-rendered: found it again by its selector.");
        const shot = await captureElement(page.tab, r.info).catch((e) => ({
          reason: String(e instanceof Error ? e.message : e),
          image: undefined,
        }));
        setImage(shot.image ?? null);
        setNoImage(shot.reason ?? null);
        const captured = await runInTab(tabId, readErrors, [], "MAIN").catch(() => null);
        setErrors(captured?.installed ? (captured.errors as ElementError[]).slice().sort((a, b) => b.time - a.time) : null);
      } catch (e) {
        if (!quiet) setError(injectionError(e));
      } finally {
        setBusy(false);
      }
    },
    [tabId, page.tab, toast],
  );

  const pick = useCallback(async () => {
    if (tabId === undefined) return;
    setError(null);
    setPhase("picking");
    pickingTab.current = tabId;
    const key = pageKey.current;
    try {
      const r = await inPicker(tabId, pickInPage, []);
      if (pickingTab.current === tabId) pickingTab.current = null;
      if (key !== pageKey.current) return;
      if (r.status === "picked") await load({ scroll: true });
      else if (r.status === "cancelled") setPhase("cancelled");
    } catch (e) {
      pickingTab.current = null;
      if (key !== pageKey.current) return;
      const message = injectionError(e);
      setPhase(info ? "picked" : "idle");
      setError(/removed|unloaded|navigat|closed/i.test(message) ? "The page changed while picking. Pick again." : message);
    }
  }, [tabId, load, info]);

  const cancel = useCallback(() => {
    if (pickingTab.current !== null) runInTab(pickingTab.current, cancelInPage, [], "MAIN").catch(() => undefined);
  }, []);

  // Restore the last pick of this page; cancel a pick still running when the panel goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per page
  useEffect(() => {
    setInfo(null);
    setImage(null);
    setPhase("idle");
    setDetached(false);
    if (page.canScript && !params?.pick) load({}, true);
    return cancel;
  }, [tabId, page.url, page.canScript]);

  // Opened from the palette or the context menu: start picking right away.
  useEffect(() => {
    const key = params?.pick ? `${params.at ?? ""}` : null;
    if (key === null || !page.canScript || tabId === undefined || autoPicked.current === key) return;
    autoPicked.current = key;
    pick();
  }, [params, page.canScript, tabId, pick]);

  // Keys typed in the side panel drive the picker too: focus is often still here.
  useEffect(() => {
    if (phase !== "picking") return;
    const onKey = (e: KeyboardEvent) => {
      const id = pickingTab.current;
      if (id === null) return;
      const dir =
        e.key === "ArrowUp" || e.key === "[" ? "up" : e.key === "ArrowDown" || e.key === "]" ? "down" : e.key === "Enter" ? "enter" : null;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (dir) {
        e.preventDefault();
        runInTab(id, nudgeInPage, [dir], "MAIN").catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, cancel]);

  const includedErrors = withErrors && errors?.length ? errors.slice(0, 5) : undefined;
  const markdown = useMemo(
    () => (info ? buildElementMarkdown(info, { note, errors: includedErrors, image: false }) : ""),
    [info, note, includedErrors],
  );
  const locator = info ? buildLocator(info) : "";

  const copy = async (text: string, what: string) =>
    toast((await copyText(text)) ? `${what} copied.` : "The clipboard refused the copy.", !text);
  const copyImage = async () => {
    if (!image) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": dataUrlToBlob(image) })]);
      toast("Image copied.");
    } catch (e) {
      toast(`The clipboard refused the image: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  const askAi = async () => {
    if (!info || tabId === undefined) return;
    const handoff: ElementHandoff = {
      tabId,
      url: info.url,
      markdown: buildElementMarkdown(info, { note, errors: includedErrors, image: Boolean(image) }),
      image: image ?? undefined,
      at: Date.now(),
    };
    await browser.storage.session.set({ [ELEMENT_HANDOFF_KEY]: handoff });
    await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "ask", params: { action: "element", at: String(handoff.at) } } });
  };

  const fw = info?.framework;
  const userComponents = fw?.components.filter((c) => !c.library) ?? [];
  const nearest = userComponents[0] ?? fw?.components[0];
  const crumbs = info ? (allCrumbs ? info.path : info.path.slice(-CRUMBS_SHOWN)) : [];

  return (
    <AccessGate>
      <Section
        title="Element picker"
        actions={
          phase === "picking" ? (
            <Button onClick={cancel}>Cancel</Button>
          ) : (
            <Button variant={info ? undefined : "primary"} onClick={pick} disabled={!page.canScript || busy}>
              {info ? "Pick another" : "Pick an element"}
            </Button>
          )
        }
        hint={
          phase === "picking" || info
            ? null
            : "Click an element of the page, then copy its component, source, selector and styles as Markdown for a coding agent."
        }
      >
        {phase === "picking" ? (
          <Notice kind="info">
            <span className="grow">
              <b>Picking.</b> Hover the page and click an element. <kbd>↑</kbd> <kbd>↓</kbd> move to the parent or child, <kbd>Enter</kbd>{" "}
              picks, <kbd>Esc</kbd> cancels.
            </span>
          </Notice>
        ) : null}
        {phase === "cancelled" && !info ? <Notice>Pick cancelled. Nothing was selected.</Notice> : null}
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {detached ? (
          <Notice kind="warn">
            This element is no longer in the page (re-rendered or removed), and its selector finds nothing. What follows is from the moment
            you picked it: pick it again for fresh data.
          </Notice>
        ) : null}
        {phase === "idle" && !info && !error ? (
          <ul className="el-intro small">
            <li>React, Vue, Svelte and Angular components, with file:line on dev builds</li>
            <li>Props, a unique selector, a Playwright locator, trimmed HTML and the styles that matter</li>
            <li>A screenshot of the element, and your note on what is wrong</li>
          </ul>
        ) : null}
      </Section>

      {info ? (
        <>
          <div className="card el-card">
            {image ? <img className="el-shot" src={image} alt={`Screenshot of ${elementLabel(info)}`} /> : null}
            <div className="el-title">
              {nearest ? <span className="el-comp">{`<${nearest.name}>`}</span> : null}
              <code className="el-tag break">{elementLabel(info)}</code>
              <span className="pill">
                {Math.round(info.rect.width)} × {Math.round(info.rect.height)}
              </span>
            </div>
            {info.source ? (
              <div className="el-source">
                <code className="el-source-path break">{formatSource(info.source)}</code>
                <span className="muted small">from {info.source.via}</span>
              </div>
            ) : (
              <p className="small muted el-nosource">
                {fw
                  ? fw.dev
                    ? "No file:line in the debug data for this element."
                    : `No source location: this looks like a production build of ${fw.name}, which strips it. Run the dev server to get file:line.`
                  : "No framework detected: plain DOM, or a production build without debug data. Run the dev server for components and file:line."}
              </p>
            )}
            {!image && noImage ? <p className="small muted el-nosource">No screenshot: {noImage}.</p> : null}
            <nav className="el-crumbs" aria-label="Ancestors of the element">
              <ol>
                {!allCrumbs && info.path.length > CRUMBS_SHOWN ? (
                  <li>
                    <button type="button" className="el-crumb" onClick={() => setAllCrumbs(true)} title="Show every ancestor">
                      …
                    </button>
                  </li>
                ) : null}
                {crumbs.map((c) => (
                  <li key={`${c.up}-${c.label}`}>
                    <button
                      type="button"
                      className="el-crumb"
                      aria-current={c.up === 0 ? "true" : undefined}
                      disabled={busy}
                      title={c.up === 0 ? "The picked element" : `Select this ancestor (${c.up} up)`}
                      onClick={() => (c.up === 0 ? undefined : load({ up: c.up, scroll: true }))}
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="row">
              <Button
                size="small"
                onClick={async () => {
                  if (tabId === undefined) return;
                  const ok = await runInTab(tabId, flashInPage, [], "MAIN").catch(() => false);
                  if (!ok) setDetached(true);
                }}
              >
                Show in page
              </Button>
              <Button size="small" busy={busy} onClick={() => load({ scroll: true })}>
                Re-read
              </Button>
              {info.childCount ? <span className="small muted">{info.childCount} children</span> : null}
            </div>
          </div>

          <Section title="For your agent">
            <label className="field">
              What's wrong / what should change?
              <textarea
                className="el-note"
                rows={3}
                value={note}
                placeholder="e.g. The label wraps on mobile; it should stay on one line and truncate."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label className={`check small${errors === null ? " muted" : ""}`}>
              <input type="checkbox" checked={withErrors} disabled={errors === null} onChange={(e) => setWithErrors(e.target.checked)} />
              {errors === null
                ? "Include console errors (turn on capture in Inspect → Console errors)"
                : `Include recent console errors (${errors.length})`}
            </label>
            <div className="row">
              <Button variant="primary" onClick={() => copy(markdown, "Markdown for your agent")}>
                Copy for agent
              </Button>
              <Button onClick={askAi}>Ask AI about it</Button>
            </div>
            <div className="row">
              <Button size="small" onClick={() => copy(info.selector, "Selector")}>
                Copy selector
              </Button>
              <Button size="small" onClick={() => copy(locator, "Locator")}>
                Copy locator
              </Button>
              <Button size="small" onClick={() => copy(info.html, "HTML")}>
                Copy HTML
              </Button>
              {image ? (
                <Button size="small" onClick={copyImage}>
                  Copy image
                </Button>
              ) : null}
            </div>
          </Section>

          <Section title={fw ? `${fw.name}${fw.version ? ` ${fw.version}` : ""} components` : "Components"}>
            {fw ? (
              fw.components.length ? (
                <ol className="el-stack">
                  {(userComponents.length ? userComponents : fw.components).slice(0, 12).map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the stack order is the identity
                    <li key={i}>
                      <code className="el-stack-name">{c.name}</code>
                      {c.kind ? <span className="pill">{c.kind}</span> : null}
                      {c.source ? (
                        <span className="el-stack-src mono break">
                          {fw.name === "React" ? "rendered at " : ""}
                          {formatSource(c.source)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>No component above this element.</Empty>
              )
            ) : (
              <Empty>No framework detected on this element.</Empty>
            )}
            {fw && fw.components.length > userComponents.length && userComponents.length ? (
              <p className="small muted" style={{ margin: 0 }}>
                {fw.components.length - userComponents.length} library or framework components hidden.
              </p>
            ) : null}
            {fw?.props !== undefined ? (
              <details className="el-props">
                <summary className="small el-props-summary">
                  Props of <code>{fw.propsOf}</code>
                </summary>
                <div className="tree el-props-tree">
                  {fw.props && typeof fw.props === "object" && !Array.isArray(fw.props) ? (
                    Object.keys(fw.props).length ? (
                      Object.entries(fw.props).map(([k, v]) => <JsonTree key={k} name={k} value={v} open={0} />)
                    ) : (
                      <span className="muted">No props.</span>
                    )
                  ) : (
                    <JsonTree value={fw.props} open={1} />
                  )}
                </div>
              </details>
            ) : null}
          </Section>

          <Section
            title="Markdown preview"
            hint={`${markdown.length.toLocaleString("en")} characters${info.htmlTruncated ? " · HTML trimmed" : ""}`}
          >
            <Code text={markdown} maxHeight={320} />
          </Section>
        </>
      ) : null}
    </AccessGate>
  );
}
