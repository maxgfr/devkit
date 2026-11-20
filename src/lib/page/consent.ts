// Injected with `runInTab`: each function must stand alone (no outer scope, no imports at runtime).
// Read-only: nothing in the page is written, wrapped or clicked. Cookie and storage values are never read,
// only their names.

export interface ConsentPageSnapshot {
  url: string;
  title: string;
  /** Names of the cookies `document.cookie` shows (no HttpOnly ones). */
  documentCookies: string[];
  /** Null when the storage cannot be read (sandboxed frame, blocked storage). */
  localKeys: string[] | null;
  sessionKeys: string[] | null;
  /** Resource timing entries of the top frame, with their full URL (sanitized by the caller). */
  resources: { url: string; type: string }[];
  /** Chrome keeps 250 resource entries by default: past that, later requests are missing. */
  resourceBufferFull: boolean;
  scripts: string[];
  iframes: string[];
}

/** ISOLATED world: names of cookies and storage keys, resource timing, script and frame URLs. */
export function collectConsentPage(): ConsentPageSnapshot {
  const MAX_KEYS = 500;
  const keys = (pick: () => Storage): string[] | null => {
    try {
      const s = pick();
      const out: string[] = [];
      for (let i = 0; i < s.length && out.length < MAX_KEYS; i++) {
        const k = s.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    } catch {
      return null;
    }
  };
  let documentCookies: string[] = [];
  try {
    documentCookies = document.cookie
      ? document.cookie
          .split(";")
          .map((part) => (part.split("=")[0] ?? "").trim())
          .filter(Boolean)
      : [];
  } catch {
    // Cookies blocked for this document.
  }
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const abs = (u: string | null) => {
    if (!u) return "";
    try {
      return new URL(u, location.href).href;
    } catch {
      return "";
    }
  };
  return {
    url: location.href,
    title: document.title,
    documentCookies: [...new Set(documentCookies)],
    localKeys: keys(() => localStorage),
    sessionKeys: keys(() => sessionStorage),
    resources: entries.slice(0, 3000).map((e) => ({ url: e.name, type: e.initiatorType })),
    resourceBufferFull: entries.length >= 250,
    scripts: Array.from(document.scripts)
      .map((s) => s.src)
      .filter(Boolean)
      .slice(0, 500),
    iframes: Array.from(document.querySelectorAll("iframe"))
      .map((f) => abs(f.getAttribute("src")))
      .filter((u) => /^https?:/.test(u))
      .slice(0, 200),
  };
}

export interface TcfState {
  /** `window.__tcfapi` is a function. */
  present: boolean;
  ping: { cmpLoaded: boolean; gdprApplies: boolean | null; cmpStatus: string; displayStatus: string; cmpId: number | null } | null;
  /** Whether getTCData returned a non-empty consent string; null when it did not answer. */
  hasTcString: boolean | null;
  eventStatus: string | null;
}

export interface ConsentGlobals {
  /** Which of the asked global names exist on `window`. */
  globals: string[];
  tcf: TcfState;
}

/**
 * MAIN world: which of `names` exist on `window`, and the IAB TCF API's `ping` and `getTCData` answers.
 * Both commands only read the CMP's state; nothing is registered, written or wrapped.
 */
export async function probeConsentGlobals(names: string[]): Promise<ConsentGlobals> {
  const w = window as unknown as Record<string, unknown>;
  const globals = names.filter((n) => {
    try {
      return typeof w[n] !== "undefined";
    } catch {
      return false;
    }
  });
  const api = w.__tcfapi;
  const tcf: TcfState = { present: typeof api === "function", ping: null, hasTcString: null, eventStatus: null };
  const call = (command: string) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 700);
      try {
        (api as (c: string, v: number, cb: (data: unknown, ok?: boolean) => void) => void)(command, 2, (data, ok) => {
          clearTimeout(timer);
          resolve(ok === false || !data || typeof data !== "object" ? null : (data as Record<string, unknown>));
        });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  if (tcf.present) {
    const ping = await call("ping");
    if (ping)
      tcf.ping = {
        cmpLoaded: Boolean(ping.cmpLoaded),
        gdprApplies: typeof ping.gdprApplies === "boolean" ? ping.gdprApplies : null,
        cmpStatus: String(ping.cmpStatus ?? ""),
        displayStatus: String(ping.displayStatus ?? ""),
        cmpId: typeof ping.cmpId === "number" ? ping.cmpId : null,
      };
    const data = await call("getTCData");
    if (data) {
      tcf.hasTcString = typeof data.tcString === "string" && data.tcString.length > 0;
      tcf.eventStatus = typeof data.eventStatus === "string" ? data.eventStatus : null;
    }
  }
  return { globals, tcf };
}
