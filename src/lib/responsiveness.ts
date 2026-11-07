// Why a page feels slow: interactions from Event Timing, the scripts behind them from Long Animation Frames,
// back/forward cache verdicts from `notRestoredReasons`, and the page's speculation rules. Pure, no DOM.
import type { EventEntry, FrameEntry, ScriptEntry } from "./page/responsiveness";
import { RATING_TEXT, rateVital } from "./viz";

/* Interactions */

export type Phase = "input-delay" | "processing" | "presentation";
/** Where a script ran relative to the interaction it is attributed to. "before" ran in the same frame, ahead of the input. */
export type ScriptPhase = Phase | "before";

export const PHASES: { id: Phase; label: string; short: string; detail: string }[] = [
  { id: "input-delay", label: "Input delay", short: "Delay", detail: "from the input to the first event handler" },
  { id: "processing", label: "Processing", short: "Handlers", detail: "the event handlers themselves" },
  { id: "presentation", label: "Presentation delay", short: "Paint", detail: "from the end of the handlers to the next paint" },
];

export const SCRIPT_PHASE_TEXT: Record<ScriptPhase, string> = {
  before: "Before the input",
  "input-delay": "Input delay",
  processing: "Event handler",
  presentation: "Before the paint",
};

export interface AttributedScript extends ScriptEntry {
  phase: ScriptPhase;
}

export interface Interaction {
  id: number;
  /** Event that names it: click, keydown, pointerdown… */
  name: string;
  kind: "pointer" | "keyboard" | "other";
  target: string | null;
  start: number;
  end: number;
  duration: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  /** Event types seen for this interaction, in order. */
  events: string[];
  frames: FrameEntry[];
  /** Scripts of the overlapping long animation frames, longest first. */
  scripts: AttributedScript[];
}

const POINTER = /^(pointer|mouse|click|dblclick|contextmenu|touch|auxclick)/;
const KEYBOARD = /^key/;
const NAME_RANK = ["click", "keydown", "pointerup", "pointerdown", "keyup", "keypress", "mouseup", "mousedown"];

/** Interactions (entries sharing an `interactionId`), each split into its three phases, slowest first. */
export function groupInteractions(events: EventEntry[], frames: FrameEntry[] = []): Interaction[] {
  const groups = new Map<number, EventEntry[]>();
  for (const e of events) {
    if (!(e.interactionId > 0)) continue;
    const g = groups.get(e.interactionId);
    if (g) g.push(e);
    else groups.set(e.interactionId, [e]);
  }
  const out: Interaction[] = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => a.startTime - b.startTime);
    const start = Math.min(...list.map((e) => e.startTime));
    const duration = Math.max(...list.map((e) => e.duration));
    const end = Math.max(...list.map((e) => e.startTime + e.duration));
    const processingStart = Math.min(...list.map((e) => e.processingStart));
    const processingEnd = Math.max(...list.map((e) => e.processingEnd));
    const names = Array.from(new Set(list.map((e) => e.name)));
    const name = NAME_RANK.find((n) => names.includes(n)) ?? names[0] ?? "event";
    const inputDelay = Math.max(0, processingStart - start);
    const processing = Math.max(0, processingEnd - processingStart);
    // Event Timing rounds `duration` to 8 ms: the presentation phase takes the rest, never below zero.
    const presentation = Math.max(0, duration - inputDelay - processing);
    const matched = framesDuring(frames, start, Math.max(end, processingEnd));
    out.push({
      id,
      name,
      kind: POINTER.test(name) ? "pointer" : KEYBOARD.test(name) ? "keyboard" : "other",
      target: list.find((e) => e.target)?.target ?? null,
      start,
      end: start + Math.max(duration, inputDelay + processing),
      duration,
      inputDelay,
      processing,
      presentation,
      events: names,
      frames: matched,
      scripts: attributeScripts(matched, start, processingStart, processingEnd),
    });
  }
  return out.sort((a, b) => b.duration - a.duration || a.start - b.start);
}

/** Long animation frames that overlap [start, end]. */
export function framesDuring(frames: FrameEntry[], start: number, end: number): FrameEntry[] {
  return frames.filter((f) => f.startTime < end && f.startTime + f.duration > start);
}

function attributeScripts(frames: FrameEntry[], start: number, processingStart: number, processingEnd: number): AttributedScript[] {
  const out: AttributedScript[] = [];
  for (const f of frames)
    for (const s of f.scripts) {
      const sEnd = s.startTime + s.duration;
      const phase: ScriptPhase =
        sEnd <= start
          ? "before"
          : s.startTime < processingStart
            ? "input-delay"
            : s.startTime < processingEnd
              ? "processing"
              : "presentation";
      out.push({ ...s, phase });
    }
  return out.sort((a, b) => b.duration - a.duration);
}

/** INP as web-vitals computes it: the worst interaction, ignoring one outlier per 50 interactions. */
export function inpEstimate(interactions: Pick<Interaction, "duration">[]): number | null {
  if (!interactions.length) return null;
  const sorted = interactions.map((i) => i.duration).sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]!;
}

export const interactionLabel = (i: Pick<Interaction, "name" | "target">) => (i.target ? `${i.name} on ${i.target}` : i.name);

/** The phase that took the longest. */
export function dominantPhase(i: Pick<Interaction, "inputDelay" | "processing" | "presentation">): Phase {
  const v: [Phase, number][] = [
    ["input-delay", i.inputDelay],
    ["processing", i.processing],
    ["presentation", i.presentation],
  ];
  return v.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/* Scripts */

/** Readable name of a script entry's code: its function, else what invoked it. */
export function scriptName(s: Pick<ScriptEntry, "sourceFunctionName" | "invoker" | "invokerType">): string {
  if (s.sourceFunctionName) return s.sourceFunctionName;
  if (s.invoker) return s.invoker;
  return s.invokerType ? `(${s.invokerType})` : "(anonymous)";
}

/** "file.js @ char 175", or the invoker when Chrome gives no source URL (inline handlers, extensions, cross-origin). */
export function scriptSource(
  s: Pick<ScriptEntry, "sourceURL" | "sourceCharPosition" | "invoker">,
  short?: (url: string) => string,
): string {
  if (!s.sourceURL) return s.invoker ? `${s.invoker} (no source URL)` : "(no source URL)";
  const name = short ? short(s.sourceURL) : s.sourceURL;
  return s.sourceCharPosition >= 0 ? `${name} @ char ${s.sourceCharPosition}` : name;
}

export interface BlockingScript {
  /** Source URL, or a label for code without one. */
  key: string;
  url: string | null;
  total: number;
  count: number;
  forcedLayout: number;
  /** In frames that overlapped an interaction. */
  duringInteractions: number;
  thirdParty: boolean;
  invokerTypes: string[];
  functions: { name: string; charPosition: number; total: number; count: number; forcedLayout: number }[];
}

const originOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** Script time in long animation frames, summed per source file ("which file blocks the main thread"), heaviest first. */
export function blockingScripts(frames: FrameEntry[], pageUrl: string, interactions: Pick<Interaction, "frames">[] = []): BlockingScript[] {
  const pageOrigin = originOf(pageUrl);
  const inInteraction = new Set<FrameEntry>(interactions.flatMap((i) => i.frames));
  const m = new Map<string, BlockingScript>();
  for (const f of frames)
    for (const s of f.scripts) {
      const key = s.sourceURL || (s.invokerType ? `(${s.invokerType}, no source URL)` : "(no source URL)");
      let b = m.get(key);
      if (!b) {
        const o = originOf(s.sourceURL);
        b = {
          key,
          url: s.sourceURL || null,
          total: 0,
          count: 0,
          forcedLayout: 0,
          duringInteractions: 0,
          thirdParty: Boolean(o && pageOrigin && o !== pageOrigin && /^https?:/.test(o)),
          invokerTypes: [],
          functions: [],
        };
        m.set(key, b);
      }
      b.total += s.duration;
      b.count++;
      b.forcedLayout += s.forcedStyleAndLayoutDuration;
      if (inInteraction.has(f)) b.duringInteractions += s.duration;
      if (s.invokerType && !b.invokerTypes.includes(s.invokerType)) b.invokerTypes.push(s.invokerType);
      const fname = scriptName(s);
      const fn = b.functions.find((x) => x.name === fname && x.charPosition === s.sourceCharPosition);
      if (fn) {
        fn.total += s.duration;
        fn.count++;
        fn.forcedLayout += s.forcedStyleAndLayoutDuration;
      } else
        b.functions.push({
          name: fname,
          charPosition: s.sourceCharPosition,
          total: s.duration,
          count: 1,
          forcedLayout: s.forcedStyleAndLayoutDuration,
        });
    }
  const out = Array.from(m.values());
  for (const b of out) b.functions.sort((a, z) => z.total - a.total);
  return out.sort((a, b) => b.total - a.total);
}

export interface FrameTotals {
  count: number;
  /** Sum of `blockingDuration`: the part of each frame over 50 ms, like Total Blocking Time. */
  blocking: number;
  longest: number;
  /** Script time with an attributed script, against the frames' total. */
  scripts: number;
  total: number;
}

export function frameTotals(frames: FrameEntry[]): FrameTotals {
  return {
    count: frames.length,
    blocking: frames.reduce((s, f) => s + (f.blockingDuration || 0), 0),
    longest: Math.max(0, ...frames.map((f) => f.duration)),
    scripts: frames.reduce((s, f) => s + f.scripts.reduce((t, x) => t + x.duration, 0), 0),
    total: frames.reduce((s, f) => s + f.duration, 0),
  };
}

/** Line and column (1-based) of a character offset, and the line's text around it. */
export function lineColumn(text: string, pos: number): { line: number; column: number; snippet: string } | null {
  if (!(pos >= 0) || pos > text.length) return null;
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos; i++)
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  const nl = text.indexOf("\n", pos);
  const lineText = text.slice(lineStart, nl === -1 ? text.length : nl);
  const col = pos - lineStart;
  // Minified bundles are one long line: keep ~60 characters before and ~100 after the position.
  const from = Math.max(0, col - 60);
  const to = Math.min(lineText.length, col + 100);
  const snippet = `${from > 0 ? "…" : ""}${lineText.slice(from, to).trim()}${to < lineText.length ? "…" : ""}`;
  return { line, column: col + 1, snippet };
}

/* Suggestions: heuristics on the measured numbers, labeled as such wherever they are shown. */

const ms = (n: number) => `${Math.round(n)} ms`;
const host = (url: string | null) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};
const fileName = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean).pop() || u.host;
  } catch {
    return url;
  }
};
const who = (s: Pick<ScriptEntry, "sourceFunctionName" | "invoker" | "invokerType" | "sourceURL">) =>
  `\`${scriptName(s)}\`${s.sourceURL ? ` in ${fileName(s.sourceURL)}` : ""}`;

export function suggestions(i: Interaction, pageUrl: string): string[] {
  const out: string[] = [];
  const phase = dominantPhase(i);
  const top = (p: ScriptPhase) => i.scripts.find((s) => s.phase === p);
  if (phase === "input-delay" && i.inputDelay >= 40) {
    const s = top("input-delay") ?? top("before");
    out.push(
      s
        ? `The main thread was busy for ${ms(i.inputDelay)} before the first handler ran; ${who(s)} (${s.invokerType || "script"}) ran ${ms(s.duration)} in that window. Split that work into smaller tasks (await scheduler.yield(), or setTimeout between chunks) or start it later.`
        : `The main thread was busy for ${ms(i.inputDelay)} before the first handler ran, with no script long enough to be attributed (under 5 ms each, rendering or garbage collection). Record again with the Performance panel of DevTools to see that task.`,
    );
  }
  if (phase === "processing" && i.processing >= 40) {
    const s = top("processing");
    out.push(
      s
        ? `The ${i.name} handlers took ${ms(i.processing)}, ${ms(s.duration)} of it in ${who(s)}. Update what the user sees first, then yield (await scheduler.yield()) before the rest, and move work the next paint does not need out of the handler.`
        : `The ${i.name} handlers took ${ms(i.processing)}. Update what the user sees first, then yield (await scheduler.yield()) before the rest.`,
    );
  }
  if (phase === "presentation" && i.presentation >= 40) {
    const frame = i.frames.find((f) => f.startTime + f.duration >= i.start + i.inputDelay + i.processing);
    const render = frame && frame.renderStart > 0 ? frame.startTime + frame.duration - frame.renderStart : 0;
    const layout = frame && frame.styleAndLayoutStart > 0 ? frame.startTime + frame.duration - frame.styleAndLayoutStart : 0;
    const s = top("presentation");
    out.push(
      `${ms(i.presentation)} passed between the end of the handlers and the next paint${render > 0 ? ` (rendering ${ms(render)}, style and layout ${ms(layout)})` : ""}${s ? `; ${who(s)} ran ${ms(s.duration)} before the paint (${s.invokerType || "script"})` : ""}. Touch less DOM in the update, keep requestAnimationFrame callbacks short, and use content-visibility: auto for off-screen sections.`,
    );
  }
  for (const s of i.scripts)
    if (s.forcedStyleAndLayoutDuration >= 10) {
      out.push(
        `${who(s)} forced style and layout for ${ms(s.forcedStyleAndLayoutDuration)} (layout thrashing): read geometry (offsetWidth, getBoundingClientRect) before writing styles, or batch the writes.`,
      );
      break;
    }
  const pageOrigin = originOf(pageUrl);
  const third = i.scripts.find(
    (s) => s.duration >= 30 && s.sourceURL && originOf(s.sourceURL) !== pageOrigin && /^https?:/.test(s.sourceURL),
  );
  if (third)
    out.push(
      `${host(third.sourceURL)} is a third party and ran ${ms(third.duration)} during this interaction: load it later (after the first interaction, or with a facade) or check whether the page still needs it.`,
    );
  const paused = i.scripts.find((s) => s.pauseDuration >= 10);
  if (paused) out.push(`${who(paused)} spent ${ms(paused.pauseDuration)} paused in a synchronous call (alert, confirm, synchronous XHR).`);
  return out;
}

/* Markdown for a coding agent */

export interface SourceLocation {
  line: number;
  column: number;
  snippet: string;
}

function scriptRow(s: AttributedScript, locate?: (s: ScriptEntry) => SourceLocation | null): string {
  const loc = locate?.(s);
  const where = s.sourceURL
    ? `${s.sourceURL}${loc ? `:${loc.line}:${loc.column}` : s.sourceCharPosition >= 0 ? ` (char ${s.sourceCharPosition})` : ""}`
    : "(no source URL)";
  const cell = (t: string) => t.replace(/\|/g, "\\|");
  return `| ${SCRIPT_PHASE_TEXT[s.phase]} | \`${cell(scriptName(s))}\` | ${cell(where)} | ${cell(s.invoker || "–")} (${s.invokerType || "–"}) | ${ms(s.duration)} | ${ms(s.forcedStyleAndLayoutDuration)} |`;
}

/** One slow interaction as Markdown: phases, the scripts that ran, and suggestions labeled as heuristics. */
export function interactionMarkdown(
  i: Interaction,
  pageUrl: string,
  opts: { focus?: ScriptEntry; locate?: (s: ScriptEntry) => SourceLocation | null } = {},
): string {
  const rating = rateVital("inp", i.duration);
  const lines = [
    `# Slow interaction on ${pageUrl}`,
    "",
    `- Interaction: ${i.name}${i.target ? ` on \`${i.target}\`` : ""}, ${(i.start / 1000).toFixed(1)} s after the page started loading`,
    `- Duration: ${ms(i.duration)}${rating ? ` (${RATING_TEXT[rating].toLowerCase()} on the INP scale: good up to 200 ms, poor above 500 ms)` : ""}`,
    `  - Input delay: ${ms(i.inputDelay)}`,
    `  - Processing (event handlers): ${ms(i.processing)}`,
    `  - Presentation delay (until the next paint): ${ms(i.presentation)}`,
    `- Events: ${i.events.join(", ")}`,
  ];
  if (opts.focus) {
    const f = opts.focus;
    const loc = opts.locate?.(f);
    lines.push(
      "",
      "## Script to look at",
      "",
      `\`${scriptName(f)}\` ${f.sourceURL ? `in ${f.sourceURL}${loc ? ` at line ${loc.line}, column ${loc.column}` : f.sourceCharPosition >= 0 ? ` at character ${f.sourceCharPosition}` : ""}` : "(no source URL)"}, invoked by ${f.invoker || "–"} (${f.invokerType || "–"}): ${ms(f.duration)}, forced style and layout ${ms(f.forcedStyleAndLayoutDuration)}.`,
    );
    if (loc?.snippet) lines.push("", "```js", loc.snippet, "```");
  }
  lines.push("", "## Scripts that ran in the overlapping long animation frames", "");
  if (i.scripts.length) {
    lines.push("| When | Function | Source | Invoker | Duration | Forced style/layout |", "|---|---|---|---|---|---|");
    for (const s of i.scripts.slice(0, 15)) lines.push(scriptRow(s, opts.locate));
    if (i.scripts.length > 15) lines.push("", `(${i.scripts.length - 15} shorter scripts left out.)`);
  } else
    lines.push(
      i.frames.length
        ? "Long animation frames overlapped this interaction, but no script over 5 ms was attributed in them: the time went to rendering, style and layout, or short tasks."
        : "No long animation frame (over 50 ms) overlapped this interaction.",
    );
  const tips = suggestions(i, pageUrl);
  if (tips.length) {
    lines.push("", "## Suggestions (heuristics from these numbers, not a diagnosis)", "");
    for (const t of tips) lines.push(`- ${t}`);
  }
  lines.push(
    "",
    "Measured in Chrome by devkit with the Event Timing and Long Animation Frames APIs. Character positions are offsets in the file as served (before source maps).",
  );
  return lines.join("\n");
}

/** One source file's main-thread time as Markdown. */
export function scriptFileMarkdown(b: BlockingScript, pageUrl: string, interactions: Interaction[]): string {
  const lines = [
    `# Main-thread time of ${b.url ?? b.key}`,
    "",
    `- Page: ${pageUrl}`,
    `- ${ms(b.total)} in ${b.count} script ${b.count === 1 ? "entry" : "entries"} of long animation frames (over 50 ms)${b.duringInteractions ? `, ${ms(b.duringInteractions)} of it during interactions` : ""}`,
    `- Forced style and layout: ${ms(b.forcedLayout)}`,
    `- Invoked as: ${b.invokerTypes.join(", ") || "–"}${b.thirdParty ? "\n- Third party (another origin than the page)" : ""}`,
    "",
    "## Functions",
    "",
    "| Function | Character position | Total | Runs | Forced style/layout |",
    "|---|---|---|---|---|",
    ...b.functions
      .slice(0, 20)
      .map(
        (f) =>
          `| \`${f.name.replace(/\|/g, "\\|")}\` | ${f.charPosition >= 0 ? f.charPosition : "–"} | ${ms(f.total)} | ${f.count} | ${ms(f.forcedLayout)} |`,
      ),
  ];
  const hit = interactions.filter((i) => i.scripts.some((s) => (s.sourceURL || null) === b.url));
  if (hit.length) {
    lines.push("", "## Slow interactions it ran in", "");
    for (const i of hit.slice(0, 5))
      lines.push(
        `- ${interactionLabel(i)}: ${ms(i.duration)} (delay ${ms(i.inputDelay)}, handlers ${ms(i.processing)}, paint ${ms(i.presentation)})`,
      );
  }
  if (b.forcedLayout >= 10 || b.thirdParty || b.total >= 200) {
    lines.push("", "## Suggestions (heuristics from these numbers, not a diagnosis)", "");
    if (b.total >= 200)
      lines.push(
        "- Split its long tasks into chunks that yield to the main thread (await scheduler.yield()), or defer work not needed for the first paint or the next interaction.",
      );
    if (b.forcedLayout >= 10)
      lines.push(
        "- It forces synchronous style and layout: read geometry before writing styles, or batch the writes in one requestAnimationFrame.",
      );
    if (b.thirdParty)
      lines.push("- It is a third party: load it after the first interaction, use a facade, or check whether the page still needs it.");
  }
  lines.push(
    "",
    "Measured in Chrome by devkit with the Long Animation Frames API. Character positions are offsets in the file as served (before source maps).",
  );
  return lines.join("\n");
}

/* Back/forward cache */

export interface NotRestoredReasonsJson {
  url?: string | null;
  src?: string | null;
  id?: string | null;
  name?: string | null;
  reasons?: ({ reason: string } | string)[] | null;
  children?: NotRestoredReasonsJson[] | null;
}

export interface ReasonInfo {
  code: string;
  title: string;
  detail: string;
}

/** Plain-language explanations for the reasons Chrome reports most. Codes vary across Chrome versions: matched loosely. */
const REASONS: { test: RegExp; title: string; detail: string }[] = [
  {
    test: /unload/,
    title: "An unload handler",
    detail:
      "The page (or a script it loads) listens to the unload event. Use pagehide or visibilitychange instead; Chrome is phasing unload out.",
  },
  {
    test: /no-?store.*(js-network|network-request)/,
    title: "Cache-Control: no-store, then a script request",
    detail:
      "Chrome can cache some no-store pages, but not once their scripts make a network request (fetch, XHR). Drop no-store from HTML that holds no private data.",
  },
  {
    test: /no-?store.*cookie/,
    title: "Cache-Control: no-store, then a cookie change",
    detail:
      "Chrome can cache some no-store pages, but not when a cookie changed while the user was away (a sign of logout or new private data).",
  },
  {
    test: /no-?store/,
    title: "Cache-Control: no-store",
    detail:
      "The document was served with Cache-Control: no-store. Drop no-store from HTML that holds no private data, or use no-cache (revalidate) instead.",
  },
  {
    test: /broadcast/,
    title: "An open BroadcastChannel",
    detail: "A BroadcastChannel was open (or received a message) when the page was hidden. Close it on pagehide and reopen it on pageshow.",
  },
  {
    test: /websocket/,
    title: "An open WebSocket",
    detail:
      "A WebSocket was open when the user left. Close it on pagehide and reconnect on pageshow (event.persisted is true on a restore).",
  },
  { test: /webtransport/, title: "An open WebTransport", detail: "Close the WebTransport session on pagehide and reopen it on pageshow." },
  { test: /webrtc/, title: "A WebRTC connection", detail: "Close RTCPeerConnections on pagehide." },
  {
    test: /^lock$|web-?lock/,
    title: "A held Web Lock",
    detail: "The page held a navigator.locks lock. Release it on pagehide.",
  },
  {
    test: /idb|indexeddb/,
    title: "IndexedDB activity",
    detail:
      "An IndexedDB connection blocked a version change or a transaction was running. Close connections on pagehide or handle versionchange.",
  },
  {
    test: /outstanding-network|fetch|xhr|network-request/,
    title: "A request still in flight",
    detail: "A fetch or XHR was still running when the user left. Abort non-essential requests on pagehide (AbortController).",
  },
  {
    test: /^masked$/,
    title: "Hidden reason (another origin, or Chrome-internal)",
    detail:
      "Chrome hides reasons from cross-origin frames and some internal ones. DevTools > Application > Back/forward cache shows the full list.",
  },
  {
    test: /navigation-failure|error-document/,
    title: "The navigation failed",
    detail: "Error pages are never cached.",
  },
  {
    test: /parser-aborted/,
    title: "The page never finished loading",
    detail: "The user left before the HTML finished parsing.",
  },
  {
    test: /shared-?worker/,
    title: "A SharedWorker",
    detail: "Pages with a SharedWorker are not cached in this Chrome version.",
  },
  {
    test: /dedicated-worker|worklet/,
    title: "A worker or worklet",
    detail: "A dedicated worker or worklet was doing something not supported in the cache.",
  },
  {
    test: /service-?worker/,
    title: "A service worker change",
    detail: "A service worker claimed, posted to, or was unregistered for the page while it was in the cache.",
  },
  {
    test: /auth-required/,
    title: "HTTP authentication",
    detail: "The document needed HTTP authentication.",
  },
  {
    test: /keyboard-lock|pointer-lock|fullscreen/,
    title: "A lock or fullscreen request",
    detail: "Keyboard lock, pointer lock or fullscreen was active.",
  },
  {
    test: /opener|related-active|window\.open/,
    title: "A window that can script this page",
    detail: "Another window opened by or opening this page keeps a reference to it (window.opener). Open links with rel=noopener.",
  },
  {
    test: /disabled|back-?forward-?cache-disabled/,
    title: "Back/forward cache turned off",
    detail: "The browser has the back/forward cache turned off (a flag, a policy or an automation setting).",
  },
  {
    test: /payment|speech|webxr|webhid|webusb|serial|bluetooth|idle-manager|media-session|picture-in-picture|webauthn|otp|nfc|sensor/,
    title: "A device or platform API in use",
    detail: "The page was using an API that cannot be paused safely (payment, speech, XR, USB, HID…).",
  },
];

export function explainReason(code: string): ReasonInfo {
  const c = code.trim().toLowerCase();
  const hit = REASONS.find((r) => r.test.test(c));
  return hit
    ? { code, title: hit.title, detail: hit.detail }
    : { code, title: code, detail: "Chrome's reason code. DevTools > Application > Back/forward cache explains it." };
}

export interface ReasonFrame {
  /** URL of the frame, or its `src` when Chrome hides the URL. */
  label: string;
  main: boolean;
  reasons: ReasonInfo[];
  children: ReasonFrame[];
}

/** The `notRestoredReasons` tree with an explanation for every reason. */
export function reasonTree(nrr: NotRestoredReasonsJson, main = true): ReasonFrame {
  const codes = (nrr.reasons ?? []).map((r) => (typeof r === "string" ? r : r.reason)).filter(Boolean);
  return {
    label:
      nrr.url || nrr.src || (nrr.name ? `frame “${nrr.name}”` : nrr.id ? `frame #${nrr.id}` : main ? "This page" : "Cross-origin frame"),
    main,
    reasons: codes.map(explainReason),
    children: (nrr.children ?? []).map((c) => reasonTree(c, false)),
  };
}

export const countReasons = (f: ReasonFrame): number => f.reasons.length + f.children.reduce((s, c) => s + countReasons(c), 0);

/** All reason codes of a tree, deduplicated, main frame first. */
export function reasonCodes(f: ReasonFrame): string[] {
  const out: string[] = [];
  const walk = (x: ReasonFrame) => {
    for (const r of x.reasons) if (!out.includes(r.code)) out.push(r.code);
    for (const c of x.children) walk(c);
  };
  walk(f);
  return out;
}

export type BfcacheState =
  | { status: "restored"; via: "test" }
  | { status: "not-restored"; via: "test" | "history"; tree: ReasonFrame | null }
  | { status: "unknown"; why: string };

/**
 * What the navigation entry says on its own. A restored page keeps its original entry, so a normal load cannot tell:
 * only a back/forward load that was not restored carries reasons.
 */
export function bfcacheFromNavigation(
  nav: { type: string; notRestoredReasons: NotRestoredReasonsJson | null; supported: boolean } | null,
): BfcacheState {
  if (!nav) return { status: "unknown", why: "No navigation entry for this page." };
  if (nav.type === "back_forward") {
    if (nav.notRestoredReasons) return { status: "not-restored", via: "history", tree: reasonTree(nav.notRestoredReasons) };
    return {
      status: "unknown",
      why: nav.supported
        ? "This page was loaded with back or forward, without being restored, and Chrome gave no reason."
        : "This page was loaded with back or forward, but this Chrome version does not report why it was not restored (Chrome 123+ does).",
    };
  }
  return {
    status: "unknown",
    why: "This page was loaded normally, not from back or forward. Test it, or go to another page and come back.",
  };
}

/* Speculation rules and preloading */

export type Eagerness = "immediate" | "eager" | "moderate" | "conservative";

export const EAGERNESS_TEXT: Record<Eagerness, string> = {
  immediate: "as soon as the rule is seen",
  eager: "as soon as possible (Chrome treats it close to immediate, or on a short hover)",
  moderate: "after a short hover (about 200 ms) or on pointer down",
  conservative: "on pointer or touch down",
};

export interface SpecRule {
  action: "prefetch" | "prerender" | "prefetch_with_subresources";
  source: "list" | "document";
  urls: string[];
  where: string | null;
  eagerness: string;
  /** True when the rule sets no eagerness and Chrome applies the default for its source. */
  defaulted: boolean;
  requires: string[];
  referrerPolicy: string | null;
  tag: string | null;
  noVarySearch: string | null;
}

export interface SpecRuleSet {
  origin: string;
  rules: SpecRule[];
  tag: string | null;
  error: string | null;
}

/** Human text of a document rule's `where` predicate. */
export function describeWhere(p: unknown): string {
  if (!p || typeof p !== "object") return "every link";
  const o = p as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]);
  const quote = (v: unknown) =>
    list(v)
      .map((x) => (typeof x === "string" ? `"${x}"` : x && typeof x === "object" ? JSON.stringify(x) : String(x)))
      .join(" or ");
  if ("and" in o)
    return list(o.and)
      .map((x) => wrap(describeWhere(x)))
      .join(" and ");
  if ("or" in o)
    return list(o.or)
      .map((x) => wrap(describeWhere(x)))
      .join(" or ");
  if ("not" in o) return `not ${wrap(describeWhere(o.not))}`;
  const href = o.href_matches ?? o.href_matches_pattern;
  if (href !== undefined) return `href matches ${quote(href)}`;
  const sel = o.selector_matches ?? o.selector_matches_selector;
  if (sel !== undefined) return `link matches ${quote(sel)}`;
  return JSON.stringify(p);
}
const wrap = (s: string) => (/ (and|or) /.test(s) ? `(${s})` : s);

const ACTIONS = ["prefetch", "prerender", "prefetch_with_subresources"] as const;

/** Rules of one `<script type="speculationrules">` (or a file named by the Speculation-Rules header). */
export function parseSpeculationRules(text: string, origin: string): SpecRuleSet {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { origin, rules: [], tag: null, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { origin, rules: [], tag: null, error: "Not a JSON object." };
  const o = json as Record<string, unknown>;
  const rules: SpecRule[] = [];
  const unknown = Object.keys(o).filter((k) => !(ACTIONS as readonly string[]).includes(k) && k !== "tag");
  for (const action of ACTIONS) {
    const raw = o[action];
    if (raw === undefined) continue;
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      if (!r || typeof r !== "object") continue;
      const rule = r as Record<string, unknown>;
      const source: SpecRule["source"] = rule.source === "document" || (!rule.urls && rule.where) ? "document" : "list";
      const eagerness = typeof rule.eagerness === "string" ? rule.eagerness : source === "list" ? "immediate" : "conservative";
      const nvs = rule.expects_no_vary_search;
      rules.push({
        action,
        source,
        urls: Array.isArray(rule.urls) ? rule.urls.map(String) : [],
        where: source === "document" ? describeWhere(rule.where) : null,
        eagerness,
        defaulted: typeof rule.eagerness !== "string",
        requires: Array.isArray(rule.requires) ? rule.requires.map(String) : [],
        referrerPolicy: typeof rule.referrer_policy === "string" ? rule.referrer_policy : null,
        tag: typeof rule.tag === "string" ? rule.tag : null,
        noVarySearch: typeof nvs === "string" ? nvs : null,
      });
    }
  }
  return {
    origin,
    rules,
    tag: typeof o.tag === "string" ? o.tag : null,
    error: unknown.length && !rules.length ? `No prefetch or prerender rule (keys: ${unknown.join(", ")}).` : null,
  };
}

/** URLs of a `Speculation-Rules` header: a structured-field list of quoted strings. */
export function parseSpeculationHeader(value: string | undefined | null): string[] {
  if (!value) return [];
  return Array.from(value.matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => m[1]!.replace(/\\(.)/g, "$1"));
}

export interface PreloadState {
  /** The page was prerendered, then shown: `activationStart` ms after navigation start. */
  prerendered: number | null;
  prefetched: boolean;
  deliveryType: string;
}

export function preloadState(nav: { activationStart?: number; deliveryType?: string } | null): PreloadState {
  const a = nav?.activationStart ?? 0;
  const d = nav?.deliveryType ?? "";
  return { prerendered: a > 0 ? a : null, prefetched: d === "navigational-prefetch", deliveryType: d };
}
