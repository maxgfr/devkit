// Small SVG/CSS charts for the inspectors. Every mark sits next to its value in text; color never carries meaning alone.
import type { ReactNode } from "react";
import type { Level } from "../lib/headers";
import { axisLabels, clamp01, GRADE_BANDS, levelCounts, type ResourceKind } from "../lib/viz";

const pct = (f: number) => `${(clamp01(f) * 100).toFixed(2)}%`;

export const LEVEL_TEXT: Record<Level, string> = { good: "Good", warn: "Warning", bad: "Bad", info: "Info" };
export const LEVEL_COLOR: Record<Level | "none", string> = {
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  info: "var(--viz-other)",
  none: "var(--viz-other)",
};

/** Resource kinds keep one color each (validated order: see the "Charts" section of styles.css). */
export const KIND_COLOR: Record<ResourceKind, string> = {
  script: "var(--viz-1)",
  style: "var(--viz-2)",
  font: "var(--viz-3)",
  image: "var(--viz-4)",
  fetch: "var(--viz-5)",
  other: "var(--viz-other)",
};

/** Status mark with a distinct shape per level (circle ✓, triangle !, square ×, ring), so it reads without color. */
export function StatusIcon({ level, label }: { level: Level | "none"; label?: string }) {
  const ink = { stroke: "var(--bg)", strokeWidth: 1.6, strokeLinecap: "round" as const, fill: "none" };
  const shape =
    level === "good" ? (
      <>
        <circle cx="6" cy="6" r="6" fill="var(--good)" />
        <path d="M3.4 6.2l1.8 1.8 3.4-3.7" {...ink} strokeLinejoin="round" />
      </>
    ) : level === "warn" ? (
      <>
        <path d="M6 .6l5.6 10.2H.4z" fill="var(--warn)" strokeLinejoin="round" />
        <path d="M6 4.3v3" {...ink} />
        <circle cx="6" cy="9" r=".8" fill="var(--bg)" />
      </>
    ) : level === "bad" ? (
      <>
        <rect x=".5" y=".5" width="11" height="11" rx="2.5" fill="var(--bad)" />
        <path d="M4 4l4 4M8 4l-4 4" {...ink} />
      </>
    ) : (
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="var(--viz-other)" strokeWidth="1.6" />
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

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Text after the label in the legend, e.g. "3 · 12 KB". */
  detail?: ReactNode;
  /** Status shape shown in the legend instead of a plain swatch. */
  level?: Level | "none";
}

/** Swatch + label + numbers, in the order of the marks. */
export function Legend({ parts }: { parts: Part[] }) {
  return (
    <ul className="viz-legend">
      {parts.map((p) => (
        <li key={p.key}>
          {p.level ? <StatusIcon level={p.level} /> : <span className="viz-key" style={{ background: p.color }} />}
          <span>{p.label}</span>
          {p.detail !== undefined ? <span className="viz-num">{p.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** One whole split into parts: a thin bar, 2px surface gaps, widths proportional to the values. */
export function SegmentBar({ parts, label, tall }: { parts: Part[]; label: string; tall?: boolean }) {
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className={`viz-seg${tall ? " tall" : ""}`} role="img" aria-label={label}>
      {shown.map((p) => (
        <span key={p.key} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${p.detail ?? p.value}`} />
      ))}
    </div>
  );
}

/**
 * Left offset of fraction `f` on a bar of `n` flex segments separated by 2px gaps, `i` being the segment it falls in
 * (or, for a boundary, the segment it starts: the gap before it is split in two).
 */
const onSegments = (f: number, n: number, i: number, boundary = false) =>
  `calc(${pct(f)} - ${(clamp01(f) * (n - 1) * 2).toFixed(2)}px + ${i * 2 - (boundary ? 1 : 0)}px)`;

/** A value on a good / needs-improvement / poor scale: three tinted zones, a marker, the two thresholds as ticks. */
export function ThresholdBar({
  good,
  poor,
  pos,
  over,
  ticks,
  label,
}: {
  good: number;
  poor: number;
  pos: number | null;
  over?: boolean;
  ticks: [string, string];
  label: string;
}) {
  const zone = pos === null ? 0 : pos <= good ? 0 : pos <= poor ? 1 : 2;
  return (
    <div className="viz-threshold" role="img" aria-label={label}>
      <div className="zones">
        <span className="z-good" style={{ flexGrow: good }} />
        <span className="z-warn" style={{ flexGrow: poor - good }} />
        <span className="z-bad" style={{ flexGrow: 1 - poor }} />
        {pos !== null ? <span className={`marker${over ? " over" : ""}`} style={{ left: onSegments(pos, 3, zone) }} /> : null}
      </div>
      <div className="viz-axis" aria-hidden="true">
        <span style={{ left: onSegments(good, 3, 1, true) }}>{ticks[0]}</span>
        <span style={{ left: onSegments(poor, 3, 2, true) }}>{ticks[1]}</span>
      </div>
    </div>
  );
}

/** Security score on 0–100 with the grade bands, the current band emphasized. */
export function ScoreMeter({ score, grade }: { score: number; grade: string }) {
  const n = GRADE_BANDS.length;
  const band = Math.max(
    0,
    GRADE_BANDS.findIndex((b) => score >= b.from && (score < b.to || b.to === 100)),
  );
  return (
    <div className="viz-meter" role="img" aria-label={`Score ${score} out of 100, grade ${grade}. Bands: ${bandsText}.`}>
      <div className="bands">
        {GRADE_BANDS.map((b) => (
          <span
            key={b.grade}
            className={`band ${b.level}${b.grade === grade ? " current" : ""}`}
            style={{ flexGrow: b.to - b.from }}
            title={`${b.grade}: ${b.from}–${b.to === 100 ? 100 : b.to - 1}`}
          >
            {b.grade}
          </span>
        ))}
        <span className="marker" style={{ left: onSegments(score / 100, n, band) }} />
      </div>
      <div className="viz-axis" aria-hidden="true">
        {/* Band boundaries; 100 is left out, the last band runs to the end. */}
        {GRADE_BANDS.map((b) => b.from).map((t, i) => (
          <span key={t} className={i === 0 ? "first" : undefined} style={{ left: onSegments(t / 100, n, i, i > 0) }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
const bandsText = GRADE_BANDS.map((b) => `${b.grade} from ${b.from}`).join(", ");

/** Time axis labels over a 0 → `end` scale, unit on the last; the first hugs the left edge, the last the right one. */
function Axis({ ticks, end }: { ticks: number[]; end: number }) {
  const labels = axisLabels(ticks);
  return (
    <div className="viz-axis" aria-hidden="true">
      {ticks.map((t, i) => (
        <span key={t} className={i === 0 ? "first" : i === ticks.length - 1 ? "last" : undefined} style={{ left: pct(t / end) }}>
          {labels[i]}
        </span>
      ))}
    </div>
  );
}

function Gridlines({ ticks, end }: { ticks: number[]; end: number }) {
  return (
    <>
      {ticks.slice(1, -1).map((t) => (
        <i key={t} className="grid" style={{ left: pct(t / end) }} />
      ))}
    </>
  );
}

/** Phases on one time axis (a Gantt row each), with event markers drawn through every row. */
export function Timeline({
  rows,
  markers,
  end,
  ticks,
  label,
}: {
  rows: { key: string; label: string; start: number; end: number; value: string; title?: string }[];
  markers: { key: string; label: string; at: number; value: string }[];
  end: number;
  ticks: number[];
  label: string;
}) {
  return (
    <figure className="viz-timeline" aria-label={label}>
      <div className="rows">
        {rows.map((r) => (
          <div key={r.key} className="tl-row" title={r.title}>
            <span className="tl-label">{r.label}</span>
            <span className="tl-track">
              <Gridlines ticks={ticks} end={end} />
              {markers.map((m) => (
                <i key={m.key} className={`mark m-${m.key}`} style={{ left: pct(m.at / end) }} />
              ))}
              <span
                className={`tl-bar${r.end - r.start <= 0 ? " zero" : ""}`}
                style={{ left: pct(r.start / end), width: pct((r.end - r.start) / end) }}
              />
            </span>
            <span className="tl-value">{r.value}</span>
          </div>
        ))}
        <div className="tl-row axis-row">
          <span />
          <Axis ticks={ticks} end={end} />
          <span />
        </div>
      </div>
      {markers.length ? (
        <figcaption className="viz-legend">
          {markers.map((m) => (
            <span key={m.key}>
              <i className={`mark-key m-${m.key}`} />
              {m.label} <span className="viz-num">{m.value}</span>
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

export interface WaterfallItem {
  key: string;
  name: string;
  url: string;
  kind: ResourceKind;
  kindLabel: string;
  left: number;
  width: number;
  meta: string;
  summary: string;
}

/** Requests on a shared time axis, one row each: short name and numbers above, the bar below. Full URL on hover or focus. */
export function Waterfall({
  items,
  ticks,
  end,
  label,
  more,
}: {
  items: WaterfallItem[];
  ticks: number[];
  end: number;
  label: string;
  more?: ReactNode;
}) {
  return (
    <figure className="viz-waterfall" aria-label={label}>
      <Axis ticks={ticks} end={end} />
      <div className="wf-body">
        <div className="wf-grid" aria-hidden="true">
          <Gridlines ticks={ticks} end={end} />
        </div>
        <ol>
          {items.map((it) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals the full URL for keyboard users
            <li key={it.key} tabIndex={0} aria-label={it.summary}>
              <div className="wf-head">
                <span className="wf-kind">
                  <span className="viz-key" style={{ background: KIND_COLOR[it.kind] }} />
                  {it.kindLabel}
                </span>
                <span className="wf-name">{it.name}</span>
                <span className="wf-meta">{it.meta}</span>
              </div>
              <div className="wf-track">
                <span className="wf-bar" style={{ left: pct(it.left), width: pct(it.width), background: KIND_COLOR[it.kind] }} />
              </div>
              <div className="wf-tip" aria-hidden="true">
                {it.url}
              </div>
            </li>
          ))}
        </ol>
      </div>
      {more}
    </figure>
  );
}

/** Horizontal bars for one series, value at the tip. */
export function BarList({ rows, label }: { rows: { key: string; label: string; value: number; text: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="viz-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="bl-label" title={r.label}>
            {r.label}
          </span>
          <span className="bl-track">
            <span className="bl-bar" style={{ width: pct(r.value / max) }} />
          </span>
          <span className="viz-num">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Checks counted by level on one thin bar, failures first, with the counts in the legend. */
export function CheckSummary({ checks, what = "checks" }: { checks: { level: Level }[]; what?: string }) {
  const counts = levelCounts(checks);
  const parts: Part[] = (["bad", "warn", "good", "info"] as const).map((l) => ({
    key: l,
    label: LEVEL_TEXT[l],
    value: counts[l],
    color: LEVEL_COLOR[l],
    detail: counts[l],
    level: l,
  }));
  return (
    <div className="stack" style={{ gap: 4 }}>
      <SegmentBar parts={parts} label={`${checks.length} ${what}: ${parts.map((p) => `${p.value} ${p.label.toLowerCase()}`).join(", ")}`} />
      <Legend parts={parts.filter((p) => p.value > 0)} />
    </div>
  );
}

/** The page's own colors as proportional swatches (widths by usage count). */
export function SwatchStrip({ colors, label }: { colors: { color: string; hex: string; count: number }[]; label: string }) {
  return (
    <div className="viz-swatches" role="img" aria-label={label}>
      {colors.map((c) => (
        <span key={c.color} style={{ flexGrow: c.count, background: c.color }} title={`${c.hex} · ${c.count}`} />
      ))}
    </div>
  );
}
