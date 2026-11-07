// In-page accessibility audit, bundled with axe-core into axe-audit.js and injected on demand in the
// ISOLATED world (the page's scripts cannot reach or tamper with it). It installs `__devkitAxe` on that
// world's window; the side panel calls it through small `runInTab` functions (src/lib/axe.ts).
import axe from "axe-core";
import { AXE_API_VERSION, type Audit, type AuditOptions, type AuditScope, auditTags, compactAudit, type RawResults } from "../a11y";

export type AuditResponse = { ok: true; audit: Audit } | { ok: false; error: string };
export type HighlightResult = "shown" | "missing" | "hidden";

export interface AxeApi {
  v: number;
  run: (options: AuditOptions, scope: AuditScope | null) => Promise<AuditResponse>;
  highlight: (target: string[], label: string) => HighlightResult;
  clear: () => void;
}

type Win = Window & { __devkitAxe?: AxeApi };

// devkit's own nodes in the page: never audited.
const OWN_NODES = ["#devkit-env-ribbon", "devkit-picker", "devkit-a11y"];

/** The element at the end of a selector path, entering open shadow roots on the way. */
function resolve(target: string[]): Element | null {
  let root: Document | ShadowRoot = document;
  let el: Element | null = null;
  for (const [i, selector] of target.entries()) {
    try {
      el = root.querySelector(selector);
    } catch {
      return null;
    }
    if (!el) return null;
    if (i < target.length - 1) {
      if (!el.shadowRoot) return el;
      root = el.shadowRoot;
    }
  }
  return el;
}

let queue: Promise<unknown> = Promise.resolve();

async function runAudit(options: AuditOptions, scope: AuditScope | null): Promise<AuditResponse> {
  clear();
  let include: axe.ContextProp | undefined;
  if (scope) {
    const path = [...(scope.shadow ?? []), scope.selector];
    try {
      document.querySelector(path[0]!);
    } catch {
      return { ok: false, error: `"${scope.selector}" is not a valid CSS selector.` };
    }
    if (!resolve(path)) return { ok: false, error: `Nothing in the page matches "${scope.selector}".` };
    include = path.length > 1 ? ([{ fromShadowDom: path }] as unknown as axe.ContextProp) : [path[0]!];
  }
  const exclude = OWN_NODES.filter((s) => document.querySelector(s));
  const context = (include ? { include, exclude } : { exclude }) as axe.ElementContext;
  const root = scope ? resolve([...(scope.shadow ?? []), scope.selector]) : document.documentElement;
  const start = performance.now();
  try {
    const raw = await axe.run(context, {
      runOnly: { type: "tag", values: auditTags(options) },
      // Passes only need their rule; the nodes of the other groups carry the details.
      resultTypes: ["violations", "incomplete"],
      // axe would wait for a copy of itself in every frame: devkit injects it in the top frame only.
      iframes: false,
      elementRef: false,
    });
    return {
      ok: true,
      audit: compactAudit(raw as unknown as RawResults, {
        url: location.href,
        at: Date.now(),
        ms: Math.round(performance.now() - start),
        options,
        scope,
        elements: root ? root.querySelectorAll("*").length + 1 : 0,
        iframes: (root ?? document).querySelectorAll("iframe, frame").length,
      }),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* Highlight */

let current: { host: HTMLElement; stop: () => void } | null = null;

function clear() {
  current?.stop();
  current = null;
}

/** Scrolls to the element and outlines it until the next click, key or highlight. */
function highlight(target: string[], label: string): HighlightResult {
  clear();
  const el = resolve(target);
  if (!el) return "missing";
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
  const first = el.getBoundingClientRect();
  if (!first.width && !first.height) return "hidden";

  const host = document.createElement("devkit-a11y");
  // Inline styles through the CSSOM: a page's CSP does not apply to them.
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block; contain: strict;";
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText =
    "position: fixed; box-sizing: border-box; border: 2px solid #22d3ee; outline: 2px solid rgba(11, 18, 32, 0.55); background: rgba(34, 211, 238, 0.14); border-radius: 2px; pointer-events: none;";
  const tag = document.createElement("div");
  tag.style.cssText =
    "position: fixed; max-width: min(460px, calc(100vw - 16px)); padding: 3px 7px; border-radius: 4px; background: #0b1220; color: #e7e9ee; font: 500 12px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.3); pointer-events: none;";
  tag.textContent = label;
  shadow.append(box, tag);
  document.documentElement.append(host);
  try {
    // The top layer puts the outline above modal dialogs and popovers too.
    host.setAttribute("popover", "manual");
    (host as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* no popover support: z-index only */
  }

  let raf = 0;
  const place = () => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    const lh = 24;
    const top = r.top - lh - 6 >= 0 ? r.top - lh - 6 : Math.min(r.bottom + 6, innerHeight - lh - 4);
    tag.style.top = `${Math.max(4, top)}px`;
    tag.style.left = `${Math.max(4, Math.min(r.left - 3, innerWidth - tag.offsetWidth - 4))}px`;
  };
  const redraw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  place();
  const dismiss = () => {
    if (current?.host === host) clear();
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("scroll", redraw, opts);
  window.addEventListener("resize", redraw);
  window.addEventListener("pointerdown", dismiss, opts);
  window.addEventListener("keydown", dismiss, opts);
  const stop = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", redraw, opts);
    window.removeEventListener("resize", redraw);
    window.removeEventListener("pointerdown", dismiss, opts);
    window.removeEventListener("keydown", dismiss, opts);
    host.remove();
  };
  current = { host, stop };
  return "shown";
}

export function installAxeAudit(): boolean {
  const w = window as Win;
  if (w.__devkitAxe?.v === AXE_API_VERSION) return true;
  w.__devkitAxe = {
    v: AXE_API_VERSION,
    // axe refuses to start while it runs: queue the calls.
    run: (options, scope) => {
      const next = queue.then(() => runAudit(options, scope));
      queue = next.catch(() => undefined);
      return next;
    },
    highlight,
    clear,
  };
  return true;
}
