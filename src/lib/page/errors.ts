// Error capture, injected in the MAIN world (by the runtime content script at document_start, or
// on demand). Must stand alone: no outer scope.

export function installErrorCapture(): number {
  type Entry = {
    kind: string;
    message: string;
    source?: string;
    line?: number;
    column?: number;
    stack?: string;
    time: number;
    count: number;
  };
  const w = window as unknown as { __devkitErrors?: Entry[] };
  if (w.__devkitErrors) return w.__devkitErrors.length;
  const list: Entry[] = [];
  w.__devkitErrors = list;
  const total = () => list.reduce((s, e) => s + e.count, 0);
  const push = (e: Omit<Entry, "time" | "count">) => {
    const same = list.find((x) => x.kind === e.kind && x.message === e.message && x.source === e.source && x.line === e.line);
    if (same) same.count++;
    else if (list.length < 300)
      list.push({ ...e, message: e.message.slice(0, 2000), stack: e.stack?.slice(0, 4000), time: Date.now(), count: 1 });
    window.postMessage({ __devkit: "errors", count: total() }, "*");
  };
  const text = (v: unknown): string => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  window.addEventListener(
    "error",
    (ev: Event) => {
      if (ev instanceof ErrorEvent) {
        push({
          kind: "error",
          message: ev.message || text(ev.error),
          source: ev.filename,
          line: ev.lineno,
          column: ev.colno,
          stack: ev.error instanceof Error ? ev.error.stack : undefined,
        });
        return;
      }
      const el = ev.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (el && el !== (window as unknown) && el.tagName)
        push({
          kind: "resource",
          message: `Failed to load <${el.tagName.toLowerCase()}> ${el.src || el.href || ""}`,
          source: el.src || el.href,
        });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    push({ kind: "rejection", message: `Unhandled rejection: ${text(r)}`, stack: r instanceof Error ? r.stack : undefined });
  });
  const original = console.error;
  console.error = function (...args: unknown[]) {
    push({ kind: "console", message: args.map(text).join(" "), stack: new Error().stack?.split("\n").slice(2).join("\n") });
    return original.apply(this, args);
  };
  return 0;
}

export function readErrors(): { installed: boolean; errors: unknown[] } {
  const w = window as unknown as { __devkitErrors?: unknown[] };
  return { installed: Boolean(w.__devkitErrors), errors: w.__devkitErrors ? [...w.__devkitErrors] : [] };
}

export function clearErrors(): void {
  const w = window as unknown as { __devkitErrors?: unknown[] };
  if (w.__devkitErrors) w.__devkitErrors.length = 0;
  window.postMessage({ __devkit: "errors", count: 0 }, "*");
}

export const ERROR_SCRIPT_IDS = ["devkit-errors-main", "devkit-errors-relay"];
