import { afterEach, describe, expect, it } from "vitest";
import { renderContext } from "../src/lib/ai/context";
import {
  appendStep,
  browserName,
  buildReport,
  buildReportJson,
  createRedactor,
  DEFAULT_REPORT_PARTS,
  describeStep,
  type EnvSnapshot,
  environmentLines,
  osName,
  playwrightTest,
  type ReportData,
  type RequestsSnapshot,
  reportFileName,
  reportSections,
  requestLabel,
  type Step,
  sensitiveField,
  stepTarget,
  triageRequests,
} from "../src/lib/bug-report";
import { createRecorder, describeTarget, domSnapshot, isTypingTarget } from "../src/lib/page/recorder";
import { applyRecorderOp } from "../src/lib/recorder";

// Assembled at runtime so the repository never holds a string secret scanners would take for a real key.
const FAKE_KEY = ["sk", "live", "51DevkitUnitFake9Qw3Er7Ty2Ui8Op4As"].join("_");

const env: EnvSnapshot = {
  url: "https://shop.example/cart",
  title: "Cart",
  time: Date.UTC(2026, 10, 7, 10, 12, 0),
  timezone: "Europe/Paris",
  viewport: { width: 1280, height: 720 },
  dpr: 2,
  screen: { width: 1512, height: 982 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  brands: [
    { brand: "Chromium", version: "142.0.7444.59" },
    { brand: "Google Chrome", version: "142.0.7444.59" },
  ],
  platform: "macOS",
  platformVersion: "15.1.0",
  mobile: false,
  colorScheme: "dark",
  reducedMotion: false,
  language: "en-US",
  languages: ["en-US", "fr"],
  online: true,
  connection: "4g",
};

const target = (label: string, locator: string, selector: string) => ({ label, locator, selector });

describe("environment", () => {
  it("names the browser from the full version list, else the user agent", () => {
    expect(browserName(env)).toBe("Chrome 142.0.7444.59");
    expect(browserName({ brands: [{ brand: "Chromium", version: "142.0.1" }], userAgent: "" })).toBe("Chromium 142.0.1");
    expect(browserName({ userAgent: env.userAgent })).toBe("Chrome 142.0.0.0");
    expect(browserName({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0.1" })).toBe("Edge 120.0.1");
  });

  it("names the OS from the client hints, with Windows 11 from the platform version", () => {
    expect(osName(env)).toBe("macOS 15.1.0");
    expect(osName({ platform: "Windows", platformVersion: "15.0.0", userAgent: "" })).toBe("Windows 11");
    expect(osName({ platform: "Windows", platformVersion: "10.0.0", userAgent: "" })).toBe("Windows 10");
    expect(osName({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" })).toBe("Android 15");
  });

  it("lists URL, time, browser, viewport, preferences and the user agent", () => {
    const lines = environmentLines({ ...env, documentStatus: 500 }).join("\n");
    expect(lines).toContain("- URL: https://shop.example/cart (HTTP 500)");
    expect(lines).toContain("- Time: 2026-11-07T10:12:00.000Z (Europe/Paris)");
    expect(lines).toContain("- Browser: Chrome 142.0.7444.59 on macOS 15.1.0");
    expect(lines).toContain("- Viewport: 1280×720 at DPR 2 · screen 1512×982");
    expect(lines).toContain("dark color scheme · language en-US (en-US, fr)");
    expect(lines).toContain("- Network: online (4g)");
  });
});

describe("requests", () => {
  const snap: RequestsSnapshot = {
    origin: "https://shop.example",
    statusSupported: true,
    bufferFull: false,
    entries: [
      { name: "https://shop.example/cart", type: "document", status: 200, duration: 180, transfer: 9000, startTime: 0 },
      { name: "https://shop.example/api/cart", type: "fetch", status: 500, duration: 40, transfer: 300, startTime: 900 },
      { name: "https://shop.example/img/a.png", type: "img", status: 404, duration: 12, transfer: 0, startTime: 200 },
      { name: "https://cdn.example/big.js", type: "script", status: 200, duration: 2400, transfer: 400_000, startTime: 100 },
      { name: "https://cdn.example/slowish.js", type: "script", status: 200, duration: 1200, transfer: 1000, startTime: 120 },
      { name: "https://ads.example/pixel", type: "img", status: 0, duration: 3000, transfer: 0, startTime: 300 },
    ],
  };

  it("lists failures by time and slow requests by duration, and counts the ones without a status", () => {
    const t = triageRequests(snap, 1000);
    expect(t.failed.map((e) => e.status)).toEqual([404, 500]);
    expect(t.slow.map((e) => e.name)).toEqual([
      "https://ads.example/pixel",
      "https://cdn.example/big.js",
      "https://cdn.example/slowish.js",
    ]);
    expect(t.noStatus).toBe(1);
    expect(triageRequests(snap, 2000).slow).toHaveLength(2);
  });

  it("shortens same-origin URLs to their path", () => {
    expect(requestLabel("https://shop.example/api/cart?x=1", "https://shop.example")).toBe("/api/cart?x=1");
    expect(requestLabel("https://cdn.example/a.js", "https://shop.example")).toBe("https://cdn.example/a.js");
    expect(requestLabel(`https://cdn.example/${"a".repeat(300)}`, "x").endsWith("…")).toBe(true);
  });
});

describe("steps", () => {
  const save = target('button "Save changes"', "page.getByRole('button', { name: 'Save changes' })", "#save");
  const email = target('textbox "Email"', "page.getByRole('textbox', { name: 'Email' })", 'input[name="email"]');

  it("merges typing in one field and drops a navigation reported twice", () => {
    let steps: Step[] = [];
    steps = appendStep(steps, { kind: "open", url: "https://a.example/", time: 1 });
    steps = appendStep(steps, { kind: "navigate", url: "https://a.example/", time: 2 });
    steps = appendStep(steps, { kind: "fill", target: email, hidden: "value masked", time: 3 });
    steps = appendStep(steps, { kind: "fill", target: email, value: "a@b.c", time: 4 });
    steps = appendStep(steps, { kind: "click", target: save, time: 5 });
    expect(steps.map((s) => s.kind)).toEqual(["open", "fill", "click"]);
    expect(steps[1]).toMatchObject({ value: "a@b.c", time: 3 });
    const many = Array.from({ length: 10 }, (_, i): Step => ({ kind: "click", target: save, time: i }));
    expect(many.reduce((acc, s) => appendStep(acc, s, 4), [] as Step[]).map((s) => s.time)).toEqual([6, 7, 8, 9]);
  });

  it("never records passwords, card fields, hidden fields or secrets", () => {
    expect(sensitiveField({ tag: "input", type: "password" })).toBe("password field");
    expect(sensitiveField({ tag: "input", type: "text", autocomplete: "cc-number" })).toBe("card field");
    expect(sensitiveField({ tag: "input", type: "text", autocomplete: "one-time-code" })).toBe("one-time code");
    expect(sensitiveField({ tag: "input", type: "hidden" })).toBe("hidden field");
    expect(sensitiveField({ tag: "input", type: "text", name: "cvv" })).toBe("card field");
    expect(sensitiveField({ tag: "input", type: "text", label: "API key" })).toBe("secret field");
    expect(sensitiveField({ tag: "input", type: "email", name: "email", label: "Email" })).toBeNull();
  });

  it("describes each step in words", () => {
    const origin = "https://a.example";
    expect(describeStep({ kind: "open", url: "https://a.example/", time: 0 }, origin)).toBe("Open https://a.example/");
    expect(describeStep({ kind: "navigate", url: "https://a.example/done?x=1", time: 0 }, origin)).toBe("Page navigated to /done?x=1");
    expect(describeStep({ kind: "click", target: save, time: 0 })).toBe('Click button "Save changes"');
    expect(describeStep({ kind: "fill", target: email, hidden: "value masked", time: 0 })).toBe('Type in textbox "Email" (value masked)');
    expect(describeStep({ kind: "fill", target: email, value: "a@b.c", time: 0 })).toBe('Type "a@b.c" in textbox "Email"');
    expect(describeStep({ kind: "press", key: "Enter", target: email, time: 0 })).toBe('Press Enter in textbox "Email"');
    expect(describeStep({ kind: "press", key: "Escape", time: 0 })).toBe("Press Escape");
  });

  it("turns the steps into a Playwright test, asserting navigations caused by an interaction", () => {
    const test = playwrightTest(
      [
        { kind: "open", url: "https://a.example/", time: 0 },
        { kind: "fill", target: email, hidden: "value masked", time: 1000 },
        { kind: "press", key: "Enter", target: email, time: 1500 },
        { kind: "navigate", url: "https://a.example/done", time: 2000 },
        { kind: "click", target: save, time: 9000 },
        { kind: "navigate", url: "https://a.example/other", time: 30_000 },
        { kind: "select", target: target('combobox "Country"', "page.getByLabel('Country')", "select"), value: "France", time: 31_000 },
      ],
      { url: "https://a.example/", title: "Shop 'cart'" },
    );
    expect(test).toContain("test('reproduces: Shop \\'cart\\'', async ({ page }) => {");
    expect(test).toContain("  await page.goto('https://a.example/');");
    expect(test).toContain("  await page.getByRole('textbox', { name: 'Email' }).fill('…'); // value masked: type what the user typed");
    expect(test).toContain("  await page.getByRole('textbox', { name: 'Email' }).press('Enter');");
    expect(test).toContain("  await expect(page).toHaveURL('https://a.example/done');");
    expect(test).toContain("  await page.goto('https://a.example/other');");
    expect(test).toContain("  await page.getByLabel('Country').selectOption({ label: 'France' });");
  });

  it("starts with a goto when the recording has no open step", () => {
    expect(playwrightTest([{ kind: "click", target: save, time: 0 }], { url: "https://a.example/x" })).toContain(
      "await page.goto('https://a.example/x');",
    );
  });

  it("labels targets by role and name, field label, test id, text, then selector", () => {
    expect(stepTarget({ role: "button", name: "Save", text: "Save", selector: "#s" }).label).toBe('button "Save"');
    expect(stepTarget({ label: "Email", text: "", selector: "#e" }).label).toBe('field "Email"');
    expect(stepTarget({ text: "", selector: "#x", testId: { attr: "data-testid", value: "go" } })).toMatchObject({
      label: '[data-testid="go"]',
      locator: "page.getByTestId('go')",
    });
    expect(stepTarget({ text: "Read more", selector: "div.more" }).label).toBe('"Read more"');
    expect(stepTarget({ text: "", selector: "div > span:nth-of-type(2)" }).label).toBe("`div > span:nth-of-type(2)`");
  });
});

describe("redaction", () => {
  it("masks keys the secret scanner finds and credential-like query parameters", () => {
    const corpus = `fetch /api/orders?api_key=${FAKE_KEY}&page=2 failed\nError: token ${FAKE_KEY}\n/cb?code=abcd1234&state=ok`;
    const r = createRedactor(corpus);
    const out = r.redact(corpus);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("api_key=[redacted]&page=2");
    expect(out).toContain("code=[redacted]&state=ok");
    expect(out).toContain("Error: token sk_l…");
    expect(r.count).toBe(2);
  });

  it("leaves ordinary text alone", () => {
    const r = createRedactor("GET /search?q=mugs&page=2 · Save changes");
    expect(r.count).toBe(0);
    expect(r.redact("GET /search?q=mugs&page=2")).toBe("GET /search?q=mugs&page=2");
  });
});

describe("report", () => {
  const data: ReportData = {
    description: "Saving shows an error; it should save.",
    url: env.url,
    title: env.title,
    env,
    slowMs: 1000,
    steps: {
      recording: false,
      recordValues: false,
      steps: [
        { kind: "open", url: env.url, time: 0 },
        { kind: "click", target: target('button "Save"', "page.getByRole('button', { name: 'Save' })", "#save"), time: 100 },
      ],
    },
    errors: {
      installed: true,
      errors: [
        {
          kind: "console",
          message: `Order failed: 500 for /api/orders?api_key=${FAKE_KEY}`,
          count: 1,
          time: 2,
          stack: "Error\n    at save (https://shop.example/src/app.ts:10:3)\n    at chrome-extension://abc/x.js:1:1",
        },
        {
          kind: "error",
          message: "TypeError: x is undefined",
          source: "https://shop.example/src/cart.ts",
          line: 4,
          column: 2,
          count: 3,
          time: 1,
        },
      ],
    },
    requests: {
      origin: "https://shop.example",
      statusSupported: true,
      bufferFull: false,
      entries: [
        {
          name: `https://shop.example/api/orders?api_key=${FAKE_KEY}`,
          type: "fetch",
          status: 500,
          duration: 33,
          transfer: 120,
          startTime: 5,
        },
      ],
    },
    vitals: { lcp: 1200, cls: 0.3, inp: null, fcp: 800, ttfb: 90, longTasks: { count: 1, total: 120 } },
    tech: [{ name: "Next.js", category: "Framework" }],
    element: { markdown: "## UI element: `<button>` in `SaveButton`\n\n- Selector: `#save`\n", image: true },
    storage: "## Storage of https://shop.example\n\n- localStorage: 2 keys, 40 B",
    text: { text: "Cart\nTotal 12 €", total: 5000 },
    dom: { html: "<main>…</main>", root: "main#content", trimmed: true },
    screenshot: true,
  };

  it("renders every part, redacted, with the parts asked for only", () => {
    const { markdown, sizes, redacted } = buildReport(data, DEFAULT_REPORT_PARTS);
    expect(markdown.startsWith("# Bug report: Cart\n\n## What happened\nSaving shows an error; it should save.")).toBe(true);
    expect(markdown).toContain('## Steps to reproduce (recorded)\n1. Open https://shop.example/cart\n2. Click button "Save"');
    expect(markdown).toContain("```ts\nimport { test, expect } from '@playwright/test';");
    expect(markdown).toContain("- Browser: Chrome 142.0.7444.59 on macOS 15.1.0");
    expect(markdown).toContain("## Console errors (4)");
    expect(markdown).toMatch(/- \[error ×3\] TypeError: x is undefined \(src\/cart\.ts:4:2\)\n- \[console\] Order failed/);
    expect(markdown).toContain("  at save (https://shop.example/src/app.ts:10:3)");
    expect(markdown).not.toContain("chrome-extension://");
    expect(markdown).toContain("- 500 fetch `/api/orders?api_key=[redacted]` · 33 ms · 120 B");
    expect(markdown).toContain("LCP 1.2 s (good) · INP – · CLS 0.300 (poor)");
    expect(markdown).toContain("Next.js (framework)");
    expect(markdown).toContain("## Picked element: `<button>` in `SaveButton`");
    expect(markdown).toContain("_Names and sizes only: no cookie or storage value is read._");
    expect(markdown).not.toContain("## Page text");
    expect(markdown).not.toContain("## DOM snapshot");
    expect(markdown).toContain("A screenshot of the viewport is attached. A screenshot of the picked element is attached.");
    expect(markdown).toContain("1 value that looked like a secret was redacted by devkit.");
    expect(markdown).not.toContain(FAKE_KEY);
    expect(redacted).toBe(1);
    expect(sizes.text).toBeGreaterThan(0);
    expect(sizes.dom).toBeGreaterThan(0);
  });

  it("includes the opt-in parts when asked and says when capture is off", () => {
    const { markdown } = buildReport({ ...data, errors: { installed: false, errors: [] } }, ["text", "dom", "errors"]);
    expect(markdown).toContain("## Page text (excerpt)\n```text\nCart\nTotal 12 €\n```\n_First 15 of 5000 characters._");
    expect(markdown).toContain("## DOM snapshot of `main#content` (trimmed)");
    expect(markdown).toContain("error capture is not running on this page");
    expect(markdown).not.toContain("## Environment");
  });

  it("counts only the redactions in the parts kept", () => {
    expect(buildReport(data, ["steps"]).redacted).toBe(0);
    expect(buildReport(data, ["errors", "requests"]).redacted).toBe(1);
  });

  it("leaves out empty parts instead of failing", () => {
    const sections = reportSections({ description: "", url: "https://a.example/", title: "", slowMs: 1000 });
    expect(sections).toEqual([]);
    expect(buildReport({ description: "", url: "https://a.example/", title: "", slowMs: 1000 }, DEFAULT_REPORT_PARTS).markdown).toContain(
      "# Bug report: https://a.example/",
    );
  });

  it("exports JSON with the same redaction", () => {
    const { redact } = buildReport(data, DEFAULT_REPORT_PARTS);
    const json = JSON.parse(buildReportJson(data, ["steps", "errors", "requests"], redact));
    expect(json.$schema).toBe("devkit-bug-report/1");
    expect(json.steps.list[1].text).toBe('Click button "Save"');
    expect(json.requests.failed[0].status).toBe(500);
    expect(json.environment).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(FAKE_KEY);
  });

  it("names the download after the host and the time", () => {
    expect(reportFileName("https://shop.example:8080/x", Date.UTC(2026, 10, 7, 10, 12, 3), "md")).toBe(
      "bug-report-shop.example-8080-2026-11-07T10-12-03.md",
    );
  });

  it("travels to the AI panel as a context part", () => {
    const md = buildReport(data, ["steps"]).markdown;
    const ctx = renderContext({ url: env.url, title: "Cart", report: md }, ["report"]);
    expect(ctx).toContain("# Bug report: Cart");
  });
});

describe("recorder state", () => {
  it("applies the side panel's operations", () => {
    const state = { tabId: 1, recording: true, startedAt: 1, recordValues: false, steps: [] };
    expect(applyRecorderOp(null, { op: "set", tabId: 1, state })).toBe(state);
    expect(applyRecorderOp(state, { op: "stop", tabId: 1 }, 9)).toMatchObject({ recording: false, stoppedAt: 9 });
    expect(applyRecorderOp(state, { op: "clear", tabId: 1 })).toBe("remove");
  });
});

describe("in-page recorder", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    document.body.innerHTML = "";
  });

  const setup = (recordValues = false) => {
    document.body.innerHTML = `
      <main id="content">
        <button id="save" type="button">Save changes</button>
        <label for="email">Email</label><input id="email" name="email" type="email" value="pre@filled.example">
        <label>Password <input id="pw" type="password" name="password"></label>
        <label><input id="terms" type="checkbox"> I agree</label>
        <select id="country" aria-label="Country"><option value="">-</option><option value="fr">France</option></select>
        <input type="hidden" name="csrf" value="hidden-token">
        <script>window.x = 1</script>
      </main>`;
    const steps: Step[] = [];
    const rec = createRecorder((s) => steps.push(s));
    rec.start({ recordValues });
    stop = rec.stop;
    return { steps, rec };
  };
  const $ = <T extends Element>(sel: string) => document.querySelector(sel) as unknown as T;
  const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  };
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));

  it("knows typing targets", () => {
    setup();
    expect(isTypingTarget($("#email"))).toBe(true);
    expect(isTypingTarget($("#terms"))).toBe(false);
    expect(isTypingTarget($("#save"))).toBe(false);
  });

  it("names targets the way a test finds them", () => {
    setup();
    expect(describeTarget($("#save"))).toMatchObject({
      label: 'button "Save changes"',
      locator: "page.getByRole('button', { name: 'Save changes' })",
      selector: "#save",
    });
    expect(describeTarget($("#email")).label).toBe('textbox "Email"');
  });

  it("records typing (masked by default) before the key that follows, and never a password", () => {
    // happy-dom marks synthetic events untrusted: the recorder only ignores untrusted clicks and keys in a real page.
    const { steps } = setup();
    type($("#email"), "me@example.com");
    $("#email").dispatchEvent(new Event("change", { bubbles: true }));
    type($("#pw"), "hunter2");
    $("#pw").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(steps.map((s) => [s.kind, s.target?.label, s.value, s.hidden])).toEqual([
      ["fill", 'textbox "Email"', undefined, "value masked"],
      ["fill", `field "Password"`, undefined, "password field, value not recorded"],
    ]);
  });

  it("records the typed value when asked, still not for passwords", () => {
    const { steps } = setup(true);
    type($("#email"), "me@example.com");
    $("#email").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    type($("#pw"), "hunter2");
    $("#pw").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(steps[0]?.value).toBe("me@example.com");
    expect(steps[1]?.value).toBeUndefined();
    expect(JSON.stringify(steps)).not.toContain("hunter2");
  });

  it("records choices: select and checkbox", () => {
    const { steps } = setup();
    const select = $<HTMLSelectElement>("#country");
    select.value = "fr";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const box = $<HTMLInputElement>("#terms");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(steps.map((s) => [s.kind, s.value ?? s.target?.label])).toEqual([
      ["select", "France"],
      ["check", 'checkbox "I agree"'],
    ]);
  });

  it("stops listening on stop", () => {
    const { steps, rec } = setup();
    rec.stop();
    type($("#email"), "x");
    $("#email").dispatchEvent(new Event("change", { bubbles: true }));
    expect(steps).toEqual([]);
    expect(rec.recording()).toBe(false);
  });

  it("ignores untrusted clicks and keys (scripts, not the user)", () => {
    const { steps } = setup();
    click($("#save"));
    key($("#email"), "Enter");
    expect(steps).toEqual([]);
  });

  it("snapshots the main region without scripts or form values", () => {
    setup();
    const snap = domSnapshot();
    expect(snap.root).toBe("main#content");
    expect(snap.html).toContain('<button id="save" type="button">Save changes</button>');
    expect(snap.html).not.toContain("pre@filled.example");
    expect(snap.html).not.toContain("hidden-token");
    expect(snap.html).not.toContain("window.x");
  });
});
