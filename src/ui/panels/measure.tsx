import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { injectionError, runInTab } from "../../lib/inject";
import {
  boxName,
  contentSize,
  fontText,
  GAP_NAME,
  MEASURE_MESSAGE,
  type MeasuredBox,
  type MeasureState,
  type Measurement,
  measurementCss,
  measurementMarkdown,
  px,
  type Rect,
  round,
  sidesShorthand,
  zoomOf,
} from "../../lib/measure";
import type { MeasureApi, MeasureResult } from "../../lib/page/measure";
import { Button, copyText, KV, Notice, Section, useToast } from "../components";
import { AccessGate, usePage } from "../page";
import type { PanelProps } from "./index";

// These run in the page (ISOLATED world, next to the bundle): only globals, no outer scope.
type Api = { __devkitMeasure?: MeasureApi };
const startInPage = (): Promise<MeasureResult> => (window as unknown as Api).__devkitMeasure!.start();
const stopInPage = () => (window as unknown as Api).__devkitMeasure?.stop();
const stateInPage = (): MeasureState | null => (window as unknown as Api).__devkitMeasure?.state() ?? null;
const keyInPage = (key: "up" | "down" | "enter") =>
  key === "enter" ? (window as unknown as Api).__devkitMeasure?.lock() : (window as unknown as Api).__devkitMeasure?.nudge(key);

/** Installs the ruler bundle in the page (once per page load), then runs `func` next to it. */
async function inMeasure<Args extends unknown[], R>(tabId: number, func: (...args: Args) => R, args: Args): Promise<Awaited<R>> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["/measure-tool.js"] } as never);
  return runInTab(tabId, func, args, "ISOLATED");
}

const n = (v: number) => String(round(v));
const KIND_TITLE: Record<Measurement["kind"], string> = {
  box: "Box model",
  distance: "Distance",
  parent: "Inside its parent",
  ruler: "Area",
};

export function Measure({ params }: PanelProps) {
  const page = usePage();
  const toast = useToast();
  const [active, setActive] = useState(false);
  const [m, setM] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState("");
  const [gapId, setGapId] = useState("");
  const measuringTab = useRef<number | null>(null);
  const autoStarted = useRef<string | null>(null);
  const tabId = page.tabId;
  // The page a result belongs to: a run that ends after the tab or URL changed is dropped.
  const pageKey = useRef("");
  pageKey.current = `${page.tabId}|${page.url}`;

  // Every new measurement comes from the page as a runtime message.
  useEffect(() => {
    const onMessage = (msg: unknown, sender: { tab?: { id?: number } }) => {
      const message = msg as { type?: string; state?: MeasureState };
      if (message?.type !== MEASURE_MESSAGE || !message.state || sender.tab?.id !== tabId) return;
      setActive(message.state.active);
      if (message.state.last) setM(message.state.last);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  const stop = useCallback(() => {
    const id = measuringTab.current;
    if (id !== null) runInTab(id, stopInPage, [], "ISOLATED").catch(() => undefined);
  }, []);

  // Restore what this page measured last; stop the ruler when the panel goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per page
  useEffect(() => {
    setM(null);
    setActive(false);
    if (page.canScript && tabId !== undefined)
      runInTab(tabId, stateInPage, [], "ISOLATED")
        .then((s) => {
          if (!s) return;
          setActive(s.active);
          if (s.active) measuringTab.current = tabId;
          setM(s.last);
        })
        .catch(() => undefined);
    return stop;
  }, [tabId, page.url, page.canScript]);

  const start = useCallback(async () => {
    if (tabId === undefined) return;
    setError(null);
    setActive(true);
    measuringTab.current = tabId;
    const key = pageKey.current;
    try {
      const r = await inMeasure(tabId, startInPage, []);
      if (key !== pageKey.current) return;
      if (r.status === "stopped" && measuringTab.current === tabId) {
        measuringTab.current = null;
        setActive(false);
      }
    } catch (e) {
      measuringTab.current = null;
      if (key !== pageKey.current) return;
      setActive(false);
      const message = injectionError(e);
      setError(/removed|unloaded|navigat|closed/i.test(message) ? "The page changed while measuring. Start again." : message);
    }
  }, [tabId]);

  // Opened from the palette: start right away.
  useEffect(() => {
    const key = params?.start ? `${params.at ?? ""}` : null;
    if (key === null || !page.canScript || tabId === undefined || autoStarted.current === key) return;
    autoStarted.current = key;
    start();
  }, [params, page.canScript, tabId, start]);

  // Keys typed in the side panel drive the ruler too: focus is often still here.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const id = measuringTab.current;
      if (id === null || (e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))) return;
      const key =
        e.key === "ArrowUp" || e.key === "[" ? "up" : e.key === "ArrowDown" || e.key === "]" ? "down" : e.key === "Enter" ? "enter" : null;
      if (e.key === "Escape") {
        e.preventDefault();
        stop();
      } else if (key && !(e.target instanceof HTMLButtonElement && key === "enter")) {
        e.preventDefault();
        runInTab(id, keyInPage, [key], "ISOLATED").catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, stop]);

  const gaps = m?.distance?.gaps ?? [];
  const expectedNum = expected.trim() === "" ? null : Number(expected);
  const markdown = useMemo(
    () => (m ? measurementMarkdown(m, { note, expected: expectedNum, expectedGap: gapId || undefined }) : ""),
    [m, note, expectedNum, gapId],
  );
  const copy = async (text: string, what: string) =>
    toast((await copyText(text)) ? `${what} copied.` : "The clipboard refused the copy.", !text);

  return (
    <AccessGate>
      <Section
        title="Measure distances"
        actions={
          active ? (
            <Button onClick={stop}>Stop</Button>
          ) : (
            <Button variant={m ? undefined : "primary"} onClick={start} disabled={!page.canScript}>
              {m ? "Measure again" : "Start measuring"}
            </Button>
          )
        }
        hint={
          active || m
            ? null
            : "Hover the page for an element's box model, click one element then another for the distance between them, or drag to measure an area."
        }
      >
        {active ? (
          <Notice kind="info">
            <span className="grow mz-keys">
              <b>Measuring.</b> Hover an element for its box model. <b>Click</b> it to lock it, hover another for the distance, click again
              to freeze. <kbd>Alt</kbd> distance to the parent · <b>drag</b> an area · <kbd>↑</kbd> <kbd>↓</kbd> parent or child ·{" "}
              <kbd>Esc</kbd> exits.
            </span>
          </Notice>
        ) : null}
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {!active && !m && !error ? (
          <ul className="el-intro small">
            <li>Content, padding, border and margin, tinted as in DevTools, with their px values</li>
            <li>The gap between two elements, or between an element and its parent</li>
            <li>A free ruler: drag a rectangle, read its width and height</li>
          </ul>
        ) : null}
      </Section>

      {m ? (
        <>
          <div className="card mz-card">
            <div className="mz-head">
              <h2>{KIND_TITLE[m.kind]}</h2>
              <span className={`pill${active && !m.frozen ? " accent" : ""}`}>
                {active ? (m.frozen ? "Frozen" : "Live") : "Last measured"}
              </span>
            </div>
            {m.kind === "box" && m.a ? <BoxModel box={m.a} /> : null}
            {(m.kind === "distance" || m.kind === "parent") && m.a && m.b ? <DistanceDiagram m={m} /> : null}
            {m.kind === "ruler" && m.ruler ? <RulerView rect={m.ruler} /> : null}
            {m.a && m.b && m.distance ? <PairDetails m={m} /> : null}
            {m.kind === "box" && m.a ? <BoxDetails box={m.a} /> : null}
            {zoomOf(m) ? (
              <p className="small mz-foot">
                CSS <code>zoom: {round(zoomOf(m)!)}</code> applies here: values are as drawn on screen, the stylesheet's are{" "}
                {round(zoomOf(m)!)}× smaller{gaps[0] ? ` (${px(gaps[0].value / zoomOf(m)!)} for the first gap)` : ""}.
              </p>
            ) : null}
            <p className="small muted mz-foot">
              CSS px · viewport {m.viewport.width} × {m.viewport.height} · device pixel ratio {round(m.viewport.dpr)}
              {m.viewport.dpr !== 1 && gaps[0] ? ` (${px(gaps[0].value)} = ${n(gaps[0].value * m.viewport.dpr)} device px)` : ""}
            </p>
          </div>

          <Section title="For your agent">
            <div className="mz-expect">
              <label className="field">
                Expected
                <span className="mz-px">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={expected}
                    placeholder="16"
                    onChange={(e) => setExpected(e.target.value)}
                    aria-describedby="mz-expected-unit"
                  />
                  <span id="mz-expected-unit" className="muted">
                    px
                  </span>
                </span>
              </label>
              {gaps.length > 1 ? (
                <label className="field grow">
                  For
                  <select value={gapId || gaps[0]!.id} onChange={(e) => setGapId(e.target.value)}>
                    {gaps.map((g) => (
                      <option key={g.id} value={g.id}>
                        {GAP_NAME[g.id]} ({px(g.value)})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <label className="field">
              What's wrong / what should change?
              <textarea
                className="el-note"
                rows={3}
                value={note}
                placeholder="e.g. The cards should sit 16px apart, like the rest of the grid."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div className="row">
              <Button variant="primary" onClick={() => copy(markdown, "Markdown for your agent")}>
                Copy for agent
              </Button>
              <Button onClick={() => copy(measurementCss(m), "CSS values")}>Copy</Button>
            </div>
            <details>
              <summary className="small muted mz-preview">Preview</summary>
              <pre className="code mz-md">{markdown}</pre>
            </details>
          </Section>
        </>
      ) : null}
    </AccessGate>
  );
}

function sizeOf(r: Rect) {
  return `${n(r.width)} × ${n(r.height)}`;
}

function BoxName({ box, which }: { box: MeasuredBox; which: "a" | "b" }) {
  return (
    <div className="mz-who">
      <span className={`mz-key ${which}`} aria-hidden="true">
        {which.toUpperCase()}
      </span>
      <code className="mz-sel break grow" title={box.selector}>
        {boxName(box)}
      </code>
      <span className="pill mz-size">{sizeOf(box.rect)}</span>
    </div>
  );
}

function PairDetails({ m }: { m: Measurement }) {
  const d = m.distance!;
  return (
    <>
      <div className="stack mz-pair">
        <BoxName box={m.a!} which="a" />
        <BoxName box={m.b!} which="b" />
      </div>
      {d.gaps.length ? (
        <ul className="mz-gaps">
          {d.gaps.map((g) => (
            <li key={g.id}>
              <span className="mz-gap-name">{GAP_NAME[g.id]}</span>
              <b className="mz-gap-value">{px(g.value)}</b>
              <span className="mz-gap-between small muted break">{g.between}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          The two boxes touch: no gap between them.
        </p>
      )}
      {d.alignment.map((al) => {
        const [s, e] = al.axis === "x" ? ["Left", "right"] : ["Top", "bottom"];
        const word = (v: number) => (v === 0 ? "aligned" : `offset ${px(v)}`);
        return (
          <p key={al.axis} className="small muted" style={{ margin: 0 }}>
            {s} edges {word(al.start)}, {e} edges {word(al.end)}.
          </p>
        );
      })}
    </>
  );
}

function BoxDetails({ box }: { box: MeasuredBox }) {
  const content = contentSize(box);
  return (
    <>
      <div className="mz-who">
        <code className="mz-sel break grow" title={box.selector}>
          {boxName(box)}
        </code>
      </div>
      <KV
        rows={[
          ["Border box", sizeOf(box.rect)],
          ["Content", sizeOf({ x: 0, y: 0, ...content })],
          ["Padding", sidesShorthand(box.padding)],
          ["Border", sidesShorthand(box.border)],
          ["Margin", sidesShorthand(box.margin)],
          ["Font", fontText(box.font) || "–"],
          ["Layout", `${box.display} · ${box.position} · ${box.boxSizing}`],
        ]}
      />
    </>
  );
}

/** The CSS box model as DevTools draws it: margin, border, padding around the content size. */
function BoxModel({ box }: { box: MeasuredBox }) {
  const content = contentSize(box);
  const v = (x: number) => (round(x) === 0 ? "–" : n(x));
  const layer = (name: string, s: [number, number, number, number], inner: React.ReactNode) => (
    <div className={`mz-bm-layer ${name}`}>
      <span className="mz-bm-name">{name}</span>
      <span className="mz-bm-t">{v(s[0])}</span>
      <span className="mz-bm-l">{v(s[3])}</span>
      <div className="mz-bm-inner">{inner}</div>
      <span className="mz-bm-r">{v(s[1])}</span>
      <span className="mz-bm-b">{v(s[2])}</span>
    </div>
  );
  return (
    <figure
      className="mz-bm"
      aria-label={`Box model: content ${sizeOf({ x: 0, y: 0, ...content })}, padding ${sidesShorthand(box.padding)}, border ${sidesShorthand(box.border)}, margin ${sidesShorthand(box.margin)}`}
    >
      {layer(
        "margin",
        box.margin,
        layer(
          "border",
          box.border,
          layer("padding", box.padding, <div className="mz-bm-content">{sizeOf({ x: 0, y: 0, ...content })}</div>),
        ),
      )}
    </figure>
  );
}

const DIAGRAM_HEIGHT = 180;

/** A to-scale sketch of the two boxes and the guides between them. */
function DistanceDiagram({ m }: { m: Measurement }) {
  const a = m.a!.rect;
  const b = m.b!.rect;
  const d = m.distance!;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  const padX = (x1 - x0) * 0.06 + 4;
  const padY = (y1 - y0) * 0.06 + 4;
  const W = x1 - x0 + padX * 2;
  const H = y1 - y0 + padY * 2;
  const ratio = Math.min(4, Math.max(0.8, W / H));
  // Width and height scale independently once the ratio is clamped: still to scale along each axis.
  const width = Math.min(330, DIAGRAM_HEIGHT * ratio);
  const height = width / ratio;
  const toX = (x: number) => `${((x - x0 + padX) / W) * 100}%`;
  const toY = (y: number) => `${((y - y0 + padY) / H) * 100}%`;
  const box = (r: Rect): CSSProperties => ({
    left: toX(r.x),
    top: toY(r.y),
    width: `${(r.width / W) * 100}%`,
    height: `${(r.height / H) * 100}%`,
  });
  const summary = d.gaps.map((g) => `${GAP_NAME[g.id]} ${px(g.value)}`).join(", ") || "no gap";
  return (
    <figure
      className="mz-diagram"
      style={{ aspectRatio: String(ratio), width: `min(100%, ${DIAGRAM_HEIGHT * ratio}px)` }}
      aria-label={`A ${boxName(m.a!)} and B ${boxName(m.b!)}: ${summary}`}
    >
      <span className="mz-d-box a" style={box(a)}>
        <i>A</i>
      </span>
      <span className="mz-d-box b" style={box(b)}>
        <i>B</i>
      </span>
      {d.extensions.map((e) => (
        <span
          key={`${e.x1},${e.y1},${e.x2},${e.y2}`}
          className={`mz-d-ext ${e.x1 === e.x2 ? "v" : "h"}`}
          style={
            e.x1 === e.x2
              ? { left: toX(e.x1), top: toY(Math.min(e.y1, e.y2)), height: `${(Math.abs(e.y2 - e.y1) / H) * 100}%` }
              : { left: toX(Math.min(e.x1, e.x2)), top: toY(e.y1), width: `${(Math.abs(e.x2 - e.x1) / W) * 100}%` }
          }
        />
      ))}
      {d.gaps.map((g) => (
        <span key={g.id}>
          <span
            className={`mz-d-line ${g.axis}`}
            style={
              g.axis === "x"
                ? { left: toX(Math.min(g.x1, g.x2)), top: toY(g.y1), width: `${(Math.abs(g.x2 - g.x1) / W) * 100}%` }
                : { left: toX(g.x1), top: toY(Math.min(g.y1, g.y2)), height: `${(Math.abs(g.y2 - g.y1) / H) * 100}%` }
            }
          />
          <span
            // A short guide keeps its value beside it rather than on top.
            className={`mz-d-tag${
              g.axis === "x"
                ? (Math.abs(g.x2 - g.x1) / W) * width < 30
                  ? " above"
                  : ""
                : (Math.abs(g.y2 - g.y1) / H) * height < 22
                  ? " beside"
                  : ""
            }`}
            style={{ left: toX((g.x1 + g.x2) / 2), top: toY((g.y1 + g.y2) / 2) }}
          >
            {n(g.value)}
          </span>
        </span>
      ))}
    </figure>
  );
}

function RulerView({ rect }: { rect: Rect }) {
  return (
    <div className="mz-ruler">
      <b className="mz-ruler-size">
        {n(rect.width)} × {n(rect.height)}
      </b>
      <span className="small muted">
        from x {n(rect.x)}, y {n(rect.y)} in the viewport
      </span>
    </div>
  );
}
