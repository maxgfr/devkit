// Recorded steps of the bug report: shapes, merging, words and the Playwright test. Kept apart from
// src/lib/bug-report.ts so the in-page recorder bundle (src/lib/page/recorder.ts) stays small.

import { buildLocator } from "./element";

export interface StepTarget {
  /** What a person reads: button "Save changes", textbox "Email", a#more. */
  label: string;
  /** Playwright locator expression. */
  locator: string;
  selector: string;
}

export type StepKind = "open" | "navigate" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "upload";

export interface Step {
  kind: StepKind;
  time: number;
  target?: StepTarget;
  /** Typed text, an option, a key, when recorded. */
  value?: string;
  /** The value was not recorded, and why ("masked", "password field"…). */
  hidden?: string;
  key?: string;
  url?: string;
}

export interface RecorderState {
  tabId: number;
  recording: boolean;
  startedAt: number;
  stoppedAt?: number;
  /** Typed values are recorded (never for passwords, card numbers or hidden fields). */
  recordValues: boolean;
  lastUrl?: string;
  steps: Step[];
}

export const RECORDER_PREFIX = "recorder:";
export const recorderKey = (tabId: number) => `${RECORDER_PREFIX}${tabId}`;
export const MAX_STEPS = 300;

/**
 * Adds `step` to `steps`: consecutive typing in one field becomes one step (the latest value), the
 * same navigation reported twice is kept once, and the list keeps the last `max` steps.
 */
export function appendStep(steps: Step[], step: Step, max = MAX_STEPS): Step[] {
  const last = steps[steps.length - 1];
  if (last && step.kind === "fill" && last.kind === "fill" && last.target?.selector === step.target?.selector)
    return [...steps.slice(0, -1), { ...step, time: last.time }];
  if (
    last &&
    (step.kind === "navigate" || step.kind === "open") &&
    (last.kind === "navigate" || last.kind === "open") &&
    last.url === step.url
  )
    return steps;
  const next = [...steps, step];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Field kinds whose value is never recorded, whatever the setting. */
export function sensitiveField(field: {
  tag: string;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  label?: string | null;
}): string | null {
  const type = (field.type ?? "").toLowerCase();
  const auto = (field.autocomplete ?? "").toLowerCase();
  if (type === "password" || /(^|\s)(current|new)-password/.test(auto)) return "password field";
  if (type === "hidden") return "hidden field";
  if (/(^|\s)cc-|one-time-code/.test(auto)) return auto.includes("one-time-code") ? "one-time code" : "card field";
  const words = `${field.name ?? ""} ${field.id ?? ""} ${field.label ?? ""}`.toLowerCase();
  if (/card.?(number|num|no)|cc.?(num|number)|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|expir/.test(words)) return "card field";
  if (/passw|\bpwd\b|passcode|\bpin\b/.test(words)) return "password field";
  if (/secret|token|api.?key|\botp\b|\bssn\b|\biban\b/.test(words)) return "secret field";
  return null;
}

const quoted = (s: string, max = 60) => `"${s.length > max ? `${s.slice(0, max)}…` : s}"`;

function pathOf(url: string, origin?: string): string {
  try {
    const u = new URL(url);
    return origin && u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : url;
  } catch {
    return url;
  }
}

/** One step in words, for the numbered list. */
export function describeStep(step: Step, origin?: string): string {
  const t = step.target?.label ?? "the page";
  switch (step.kind) {
    case "open":
      return `Open ${step.url}`;
    case "navigate":
      return `Page navigated to ${pathOf(step.url ?? "", origin)}`;
    case "click":
      return `Click ${t}`;
    case "fill":
      return step.value !== undefined ? `Type ${quoted(step.value)} in ${t}` : `Type in ${t} (${step.hidden ?? "value masked"})`;
    case "select":
      return `Select ${quoted(step.value ?? "")} in ${t}`;
    case "check":
      return `Check ${t}`;
    case "uncheck":
      return `Uncheck ${t}`;
    case "press":
      return step.target ? `Press ${step.key} in ${t}` : `Press ${step.key}`;
    case "upload":
      return `Choose a file in ${t}`;
  }
}

const jsString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

/** A Playwright test that replays the steps, to paste into a spec and finish with the assertion that shows the bug. */
export function playwrightTest(steps: Step[], start: { url: string; title?: string }): string {
  const lines: string[] = [];
  const first = steps.find((s) => s.kind === "open" || s.kind === "navigate");
  if (!first || steps[0] !== first) lines.push(`await page.goto(${jsString(first?.url ?? start.url)});`);
  let prev: Step | undefined;
  for (const s of steps) {
    const loc = s.target?.locator;
    switch (s.kind) {
      case "open":
        lines.push(`await page.goto(${jsString(s.url ?? start.url)});`);
        break;
      case "navigate":
        // Right after an interaction, the navigation is its result: assert it instead of going there.
        if (prev && prev.kind !== "open" && prev.kind !== "navigate" && s.time - prev.time < 5000)
          lines.push(`await expect(page).toHaveURL(${jsString(s.url ?? "")});`);
        else lines.push(`await page.goto(${jsString(s.url ?? "")});`);
        break;
      case "click":
        if (loc) lines.push(`await ${loc}.click();`);
        break;
      case "fill":
        if (loc)
          lines.push(
            s.value !== undefined
              ? `await ${loc}.fill(${jsString(s.value)});`
              : `await ${loc}.fill('…'); // ${s.hidden ?? "value masked"}: type what the user typed`,
          );
        break;
      case "select":
        if (loc) lines.push(`await ${loc}.selectOption({ label: ${jsString(s.value ?? "")} });`);
        break;
      case "check":
        if (loc) lines.push(`await ${loc}.check();`);
        break;
      case "uncheck":
        if (loc) lines.push(`await ${loc}.uncheck();`);
        break;
      case "press":
        lines.push(loc ? `await ${loc}.press(${jsString(s.key ?? "")});` : `await page.keyboard.press(${jsString(s.key ?? "")});`);
        break;
      case "upload":
        if (loc) lines.push(`await ${loc}.setInputFiles('path/to/file'); // the file name is not recorded`);
        break;
    }
    prev = s;
  }
  lines.push("// Then assert what goes wrong, for example:", "// await expect(page.getByRole('alert')).toBeHidden();");
  const name = (start.title || "the bug").replace(/\s+/g, " ").trim().slice(0, 60);
  return [
    "import { test, expect } from '@playwright/test';",
    "",
    `test(${jsString(`reproduces: ${name}`)}, async ({ page }) => {`,
    ...lines.map((l) => `  ${l}`),
    "});",
  ].join("\n");
}

/** A target from the pieces the in-page recorder reads; the locator is the element picker's. */
export function stepTarget(t: {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text: string;
  selector: string;
  testId?: { attr: string; value: string };
}): StepTarget {
  const short = (s?: string) => (s && s.length <= 60 ? s : s ? `${s.slice(0, 60)}…` : undefined);
  const name = short(t.name);
  const text = t.text.replace(/\s+/g, " ").trim();
  const label =
    t.role && name
      ? `${t.role} ${quoted(name)}`
      : t.label
        ? `field ${quoted(t.label)}`
        : t.placeholder
          ? `field ${quoted(t.placeholder)}`
          : t.testId
            ? `[${t.testId.attr}="${t.testId.value}"]`
            : text && text.length <= 40
              ? `${quoted(text)}${t.role ? ` (${t.role})` : ""}`
              : `\`${t.selector}\``;
  return { label, locator: buildLocator(t), selector: t.selector };
}
