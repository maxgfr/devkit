// Injected with `runInTab` (ISOLATED world): each function stands alone. The isolated world shares the page's
// performance timeline but none of its globals, so the recorder below is invisible to the page and survives
// between calls for as long as the document lives.

export interface EventEntry {
  name: string;
  interactionId: number;
  startTime: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
  /** Short description of the event target ("button#save.btn"), null when the node is gone. */
  target: string | null;
}

export interface ScriptEntry {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  startTime: number;
  duration: number;
  executionStart: number;
  forcedStyleAndLayoutDuration: number;
  pauseDuration: number;
  windowAttribution: string;
}

export interface FrameEntry {
  startTime: number;
  duration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  blockingDuration: number;
  firstUIEventTimestamp: number;
  scripts: ScriptEntry[];
}

export interface ResponsivenessSnapshot {
  url: string;
  supported: { event: boolean; loaf: boolean };
  events: EventEntry[];
  frames: FrameEntry[];
  /** Set while (or after, when just stopped) the recorder runs: `since` is a `performance.now()` time. */
  recording: { active: boolean; since: number; until: number } | null;
  now: number;
}

/** Starts collecting every interaction over 16 ms and every long animation frame until `readResponsiveness(true)`. */
export function startRecorder(): { since: number; already: boolean } {
  type Store = { since: number; events: unknown[]; frames: unknown[]; observers: PerformanceObserver[] };
  const w = window as unknown as { __devkitResponsiveness?: Store };
  if (w.__devkitResponsiveness) return { since: w.__devkitResponsiveness.since, already: true };
  const store: Store = { since: performance.now(), events: [], frames: [], observers: [] };
  const describe = (node: unknown): string | null => {
    const el = node as Element | null;
    if (!el || typeof el.tagName !== "string") return null;
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  if (types.includes("event")) {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEventTiming & { interactionId?: number })[]) {
        if (!e.interactionId || store.events.length >= 3000) continue;
        store.events.push({
          name: e.name,
          interactionId: e.interactionId,
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
          target: describe(e.target),
        });
      }
    });
    po.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    store.observers.push(po);
  }
  if (types.includes("long-animation-frame")) {
    const po = new PerformanceObserver((list) => {
      for (const f of list.getEntries() as unknown as Record<string, unknown>[]) {
        if (store.frames.length >= 1000) break;
        store.frames.push(JSON.parse(JSON.stringify(f)));
      }
    });
    po.observe({ type: "long-animation-frame" });
    store.observers.push(po);
  }
  w.__devkitResponsiveness = store;
  return { since: store.since, already: false };
}

/** How much the recorder holds so far, cheap enough to poll. */
export function recorderStatus(): { since: number; now: number; interactions: number; frames: number } | null {
  const store = (
    window as unknown as { __devkitResponsiveness?: { since: number; events: { interactionId: number }[]; frames: unknown[] } }
  ).__devkitResponsiveness;
  if (!store) return null;
  return {
    since: store.since,
    now: performance.now(),
    interactions: new Set(store.events.map((e) => e.interactionId)).size,
    frames: store.frames.length,
  };
}

/**
 * Buffered entries (Chrome keeps event entries over 104 ms, up to 150, and up to 200 long animation frames) merged with
 * what the recorder caught. `stop` disconnects the recorder and forgets it.
 */
export async function readResponsiveness(stop: boolean): Promise<ResponsivenessSnapshot> {
  type Store = { since: number; events: EventEntry[]; frames: Record<string, unknown>[]; observers: PerformanceObserver[] };
  const w = window as unknown as { __devkitResponsiveness?: Store };
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  const supported = { event: types.includes("event"), loaf: types.includes("long-animation-frame") };
  const describe = (node: unknown): string | null => {
    const el = node as Element | null;
    if (!el || typeof el.tagName !== "string") return null;
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const read = (init: PerformanceObserverInit) =>
    new Promise<PerformanceEntry[]>((resolve) => {
      try {
        const out: PerformanceEntry[] = [];
        const po = new PerformanceObserver((list) => out.push(...list.getEntries()));
        po.observe({ ...init, buffered: true } as PerformanceObserverInit);
        setTimeout(() => {
          out.push(...po.takeRecords());
          po.disconnect();
          resolve(out);
        }, 60);
      } catch {
        resolve([]);
      }
    });
  const [ev, lf] = await Promise.all([
    supported.event ? read({ type: "event", durationThreshold: 16 } as PerformanceObserverInit) : Promise.resolve([]),
    supported.loaf ? read({ type: "long-animation-frame" }) : Promise.resolve([]),
  ]);
  const store = w.__devkitResponsiveness;
  const events: EventEntry[] = [];
  const seenEvents = new Set<string>();
  const addEvent = (e: EventEntry) => {
    const k = `${e.name}|${e.interactionId}|${e.startTime}`;
    if (seenEvents.has(k)) return;
    seenEvents.add(k);
    events.push(e);
  };
  for (const e of ev as (PerformanceEventTiming & { interactionId?: number })[])
    if (e.interactionId)
      addEvent({
        name: e.name,
        interactionId: e.interactionId,
        startTime: e.startTime,
        duration: e.duration,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
        target: describe(e.target),
      });
  for (const e of store?.events ?? []) addEvent(e);
  const frames: FrameEntry[] = [];
  const seenFrames = new Set<number>();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const addFrame = (f: Record<string, unknown>) => {
    const start = num(f.startTime);
    if (seenFrames.has(start)) return;
    seenFrames.add(start);
    frames.push({
      startTime: start,
      duration: num(f.duration),
      renderStart: num(f.renderStart),
      styleAndLayoutStart: num(f.styleAndLayoutStart),
      blockingDuration: num(f.blockingDuration),
      firstUIEventTimestamp: num(f.firstUIEventTimestamp),
      scripts: (Array.isArray(f.scripts) ? (f.scripts as Record<string, unknown>[]) : []).map((s) => ({
        invoker: str(s.invoker),
        invokerType: str(s.invokerType),
        sourceURL: str(s.sourceURL),
        sourceFunctionName: str(s.sourceFunctionName),
        sourceCharPosition: typeof s.sourceCharPosition === "number" ? s.sourceCharPosition : -1,
        startTime: num(s.startTime),
        duration: num(s.duration),
        executionStart: num(s.executionStart),
        forcedStyleAndLayoutDuration: num(s.forcedStyleAndLayoutDuration),
        pauseDuration: num(s.pauseDuration),
        windowAttribution: str(s.windowAttribution),
      })),
    });
  };
  for (const f of lf) addFrame(JSON.parse(JSON.stringify(f)) as Record<string, unknown>);
  for (const f of store?.frames ?? []) addFrame(f);
  frames.sort((a, b) => a.startTime - b.startTime);
  const now = performance.now();
  const recording = store ? { active: !stop, since: store.since, until: now } : null;
  if (stop && store) {
    for (const o of store.observers) o.disconnect();
    delete w.__devkitResponsiveness;
  }
  return { url: location.href, supported, events, frames, recording, now };
}

export interface NavigationInfo {
  url: string;
  timeOrigin: number;
  readyState: string;
  type: string;
  /** `notRestoredReasons` as JSON (Chrome 123+), null when the page was not a failed back/forward restore. */
  notRestoredReasons: unknown;
  reasonsSupported: boolean;
  activationStart: number;
  deliveryType: string;
  prerendering: boolean;
  speculationRules: { text: string; index: number }[];
  supportsSpeculationRules: boolean;
  /** `<link rel>` preloading hints on the page. */
  hints: { rel: string; href: string; as: string }[];
}

/** The document's identity (its time origin changes with every new document) plus bfcache and preloading clues. */
export function readNavigationInfo(): NavigationInfo {
  const nav = performance.getEntriesByType("navigation")[0] as
    | (PerformanceNavigationTiming & { notRestoredReasons?: unknown; activationStart?: number; deliveryType?: string })
    | undefined;
  let reasons: unknown = null;
  try {
    const r = nav?.notRestoredReasons as { toJSON?: () => unknown } | null | undefined;
    reasons = r ? JSON.parse(JSON.stringify(r.toJSON ? r.toJSON() : r)) : null;
  } catch {
    reasons = null;
  }
  const scripts = Array.from(document.querySelectorAll('script[type="speculationrules"]'));
  const hints = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel]"))
    .filter((l) => /\b(prefetch|prerender|preload|modulepreload|preconnect|dns-prefetch)\b/i.test(l.rel))
    .slice(0, 100)
    .map((l) => ({ rel: l.rel.toLowerCase(), href: l.href, as: l.getAttribute("as") ?? "" }));
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    type: nav?.type ?? "",
    notRestoredReasons: reasons,
    reasonsSupported: Boolean(nav && "notRestoredReasons" in nav),
    activationStart: nav?.activationStart ?? 0,
    deliveryType: nav?.deliveryType ?? "",
    prerendering: Boolean((document as Document & { prerendering?: boolean }).prerendering),
    speculationRules: scripts.map((s, index) => ({ text: s.textContent ?? "", index })),
    supportsSpeculationRules: typeof HTMLScriptElement.supports === "function" && HTMLScriptElement.supports("speculationrules"),
    hints,
  };
}
