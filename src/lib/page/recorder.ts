// Steps recorder and DOM snapshot for the bug report, run in the page's ISOLATED world. Bundled into
// /bug-report.js by src/entrypoints/bug-report.ts, which installs `window.__devkitReport`; the side
// panel (and the background, after a navigation) start it through small `runInTab` functions.
// Steps go to the background, which keeps them per tab in session storage.

import { browser } from "wxt/browser";
import { type Step, type StepTarget, sensitiveField, stepTarget } from "../steps";
import { accessibleName, crumbLabel, implicitRole, trimmedHtml, uniqueSelector } from "./element";

export const REPORT_PAGE_VERSION = 1;

export interface ReportPageApi {
  v: number;
  start: (options: { recordValues: boolean }) => boolean;
  stop: () => void;
  recording: () => boolean;
  dom: (max?: number) => { html: string; root: string; trimmed: boolean };
}

interface ReportWindow {
  __devkitReport?: ReportPageApi;
}

const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
const NOT_TYPED = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color", "hidden"]);
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], [role="treeitem"], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** A text field, a textarea or an editable region: typing there becomes a "fill" step. */
export function isTypingTarget(el: Element): boolean {
  if (el.localName === "textarea") return true;
  if (el.localName === "input") return !NOT_TYPED.has(((el as HTMLInputElement).type || "text").toLowerCase());
  return (
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute("contenteditable") === "" ||
    el.getAttribute("contenteditable") === "true"
  );
}

/** What the step names and how a test finds it again: role and name, label, test id, text, or a selector. */
export function describeTarget(el: Element): StepTarget {
  const role = implicitRole(el);
  const { name, label } = accessibleName(el, role);
  const testAttr = TEST_ATTRS.find((a) => el.hasAttribute(a));
  // biome-ignore lint/performance/useDomNodeTextContent: innerText is what the user sees
  const text = isTypingTarget(el) ? "" : clean((el as HTMLElement).innerText ?? el.textContent).slice(0, 120);
  return stepTarget({
    role,
    name,
    label,
    placeholder: el.getAttribute("placeholder") ?? undefined,
    text,
    selector: uniqueSelector(el).selector,
    testId: testAttr ? { attr: testAttr, value: el.getAttribute(testAttr) ?? "" } : undefined,
  });
}

function fieldReason(el: Element): string | null {
  const input = el as HTMLInputElement;
  return sensitiveField({
    tag: el.localName,
    type: el.localName === "input" ? input.type : null,
    name: el.getAttribute("name"),
    id: el.id,
    autocomplete: el.getAttribute("autocomplete"),
    label: input.labels?.[0]?.textContent ?? el.getAttribute("aria-label"),
  });
}

/** The element an event is about, through open shadow roots; text nodes give their parent. */
function eventTarget(e: Event): Element | null {
  const first = e.composedPath()[0] ?? e.target;
  if (first instanceof Element) return first;
  return first instanceof Node ? first.parentElement : null;
}

function keyName(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && e.key.length > 1 && "Shift"].filter(Boolean);
  if (mods.length) return [...mods, e.key.length === 1 ? e.key.toUpperCase() : e.key].join("+");
  return e.key === "Enter" || e.key === "Escape" ? e.key : null;
}

/** Installs the recorder: listeners stay off until `start`. Steps are sent with `send` (the background in the extension). */
export function createRecorder(send: (step: Step) => void) {
  let on = false;
  let recordValues = false;
  let pending: { el: Element; timer: number } | null = null;

  const typedValue = (el: Element): Pick<Step, "value" | "hidden"> => {
    const reason = fieldReason(el);
    if (reason) return { hidden: `${reason}, value not recorded` };
    if (!recordValues) return { hidden: "value masked" };
    const raw = el.localName === "input" || el.localName === "textarea" ? (el as HTMLInputElement).value : (el.textContent ?? "");
    return { value: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw };
  };

  const flush = () => {
    if (!pending) return;
    const { el, timer } = pending;
    pending = null;
    clearTimeout(timer);
    send({ kind: "fill", time: Date.now(), target: describeTarget(el), ...typedValue(el) });
  };

  const emit = (step: Omit<Step, "time">) => {
    flush();
    send({ ...step, time: Date.now() });
  };

  const onClick = (e: MouseEvent) => {
    if (!on || !e.isTrusted || document.querySelector("devkit-picker")) return;
    const raw = eventTarget(e);
    if (!raw) return;
    const el = raw.closest(INTERACTIVE) ?? raw;
    // Fields record what is typed or chosen, not the click that focused them.
    const control = el.localName === "label" ? (el as HTMLLabelElement).control : el;
    if (control && (isTypingTarget(control) || control.localName === "select" || control.localName === "option")) return;
    if (control?.localName === "input" && /^(checkbox|radio|file)$/i.test((control as HTMLInputElement).type)) return;
    emit({ kind: "click", target: describeTarget(el) });
  };

  const onInput = (e: Event) => {
    if (!on) return;
    const el = eventTarget(e);
    if (!el || !isTypingTarget(el)) return;
    if (pending && pending.el !== el) flush();
    if (pending) clearTimeout(pending.timer);
    pending = { el, timer: window.setTimeout(flush, 500) };
  };

  const onChange = (e: Event) => {
    if (!on) return;
    const el = eventTarget(e);
    if (!el) return;
    if (isTypingTarget(el)) return flush();
    if (el.localName === "select") {
      const s = el as HTMLSelectElement;
      const chosen = Array.from(s.selectedOptions)
        .map((o) => clean(o.label || o.text))
        .join(", ");
      return emit({ kind: "select", target: describeTarget(el), value: chosen });
    }
    if (el.localName !== "input") return;
    const input = el as HTMLInputElement;
    if (input.type === "checkbox") emit({ kind: input.checked ? "check" : "uncheck", target: describeTarget(el) });
    else if (input.type === "radio") emit({ kind: "check", target: describeTarget(el) });
    else if (input.type === "file") emit({ kind: "upload", target: describeTarget(el) });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!on || !e.isTrusted || e.isComposing) return;
    const key = keyName(e);
    if (!key) return;
    const el = eventTarget(e);
    const focused = el && el !== document.body && el !== document.documentElement ? el : null;
    emit({ kind: "press", key, target: focused ? describeTarget(focused) : undefined });
  };

  const onLeave = () => flush();

  const listen = (add: boolean) => {
    const m = add ? window.addEventListener : window.removeEventListener;
    m.call(window, "click", onClick as EventListener, true);
    m.call(window, "input", onInput, true);
    m.call(window, "change", onChange, true);
    m.call(window, "keydown", onKey as EventListener, true);
    m.call(window, "focusout", onLeave, true);
    m.call(window, "pagehide", onLeave, true);
  };

  return {
    start(options: { recordValues: boolean }) {
      recordValues = options.recordValues;
      if (!on) listen(true);
      on = true;
      return true;
    },
    stop() {
      flush();
      if (on) listen(false);
      on = false;
    },
    recording: () => on,
  };
}

/** The main region of the page as trimmed HTML, without scripts, styles or any form value. */
export function domSnapshot(max = 8000): { html: string; root: string; trimmed: boolean } {
  const root =
    document.querySelector("main, [role=main]") ?? document.querySelector("#root, #app, #__next, #___gatsby, #svelte") ?? document.body;
  if (!root) return { html: "", root: "body", trimmed: false };
  const clone = root.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll("script, style, noscript, template, link, meta, input[type=hidden]"))) el.remove();
  for (const el of Array.from(clone.querySelectorAll("input, textarea, select, option"))) {
    el.removeAttribute("value");
    if (el.localName === "textarea") el.textContent = "";
  }
  for (const el of Array.from(clone.querySelectorAll("[nonce], [integrity]"))) {
    el.removeAttribute("nonce");
    el.removeAttribute("integrity");
  }
  const { html, trimmed } = trimmedHtml(clone, max);
  return { html, root: crumbLabel(root), trimmed };
}

export function installReportPage(): boolean {
  const w = window as unknown as ReportWindow;
  if (w.__devkitReport?.v === REPORT_PAGE_VERSION) return true;
  w.__devkitReport?.stop();
  const recorder = createRecorder((step) => {
    browser.runtime.sendMessage({ type: "devkit:step", step }).catch(() => undefined);
  });
  w.__devkitReport = { v: REPORT_PAGE_VERSION, ...recorder, dom: domSnapshot };
  return true;
}
