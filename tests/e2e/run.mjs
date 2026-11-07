// End-to-end test of the built extension in Chromium: `pnpm build && pnpm e2e`.
// Usage: node tests/e2e/run.mjs [extension dir] — set E2E_SHOTS=<dir> to save screenshots.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
// The fake key server.mjs plants in the test page.
const FAKE_STRIPE_KEY = ["sk", "live", "51DevkitE2eFake9Qw3Er7Ty2Ui8Op4As"].join("_");
const source = resolve(process.argv[2] ?? join(here, "../../.output/chrome-mv3"));
const shots = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : undefined;
if (shots) mkdirSync(shots, { recursive: true });

// Grant the optional permissions up front: automation cannot click Chrome's permission prompts.
const work = mkdtempSync(join(tmpdir(), "devkit-e2e-"));
const ext = join(work, "extension");
const profile = join(work, "profile");
cpSync(source, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.permissions.push(...manifest.optional_permissions);
manifest.host_permissions = ["<all_urls>"];
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));

const server = spawn(process.execPath, [join(here, "server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((done) => server.stdout.on("data", (d) => done(Number(/listening (\d+)/.exec(String(d))?.[1]))));
const base = `http://127.0.0.1:${port}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1200, height: 900 },
  colorScheme: "no-override",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  // Playwright turns the back/forward cache off by default; the Responsiveness panel tests it.
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});
context.setDefaultTimeout(8000);
const extErrors = [];
const watchdog = setTimeout(() => {
  console.log("WATCHDOG: aborting after 240 s");
  process.exit(2);
}, 240_000);

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const id = new URL(sw.url()).host;
  check("extension loads", Boolean(id), id);

  const commands = await sw.evaluate(async () => (await chrome.commands.getAll()).map((c) => c.name));
  check(
    "keyboard commands registered",
    ["_execute_action", "open-side-panel", "fresh-start", "hard-reload"].every((c) => commands.includes(c)),
  );

  const site = await context.newPage();
  await site.goto(`${base}/`);
  await site.evaluate(() => {
    localStorage.setItem("devkit-test", JSON.stringify({ a: 1 }));
    document.cookie = "session=abc123; path=/";
  });
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0].id, base);

  const panel = await context.newPage();
  panel.on("pageerror", (e) => extErrors.push(`pageerror: ${e.message}`));
  panel.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && extErrors.push(`console: ${m.text()}`));
  await panel.setViewportSize({ width: 440, height: 900 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  const text = () => panel.locator("main").innerText();
  const open = async (tab, sub) => {
    await panel.getByRole("tab", { name: tab }).click();
    // Sub-navigation pills show short labels; their tooltip starts with the full title.
    if (sub) await panel.locator(`.subnav button[title^="${sub}"]`).first().click();
    await panel.waitForTimeout(600);
  };
  const shot = async (name) => {
    if (shots) await panel.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };
  const action = (title) => panel.locator(".action", { hasText: title }).first().click();
  const sessionRules = () => sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  let t;

  check("panel follows the pinned tab", (await panel.locator(".tabline .host").innerText()).includes("127.0.0.1"));

  // Inspect
  await open("Inspect", "Overview");
  await panel.waitForTimeout(800);
  // Small page: the Overview runs the axe audit on its own.
  await panel
    .locator(".report-row", { hasText: /violations/ })
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  t = await text();
  check("tech stack: Next.js + Express", t.includes("Next.js") && t.includes("Express"));
  check(
    "report card: security grade, JSON-LD errors, axe violations",
    /Security headers\s*Grade [A-F] · \d+\/100/.test(t) &&
      /Structured data\s*2 errors, \d+ warnings in 2 blocks/.test(t) &&
      /Accessibility\s*\d+ violations \(\d+ critical\)/.test(t),
    t.match(/Security headers[^\n]*\n?[^\n]*/)?.[0],
  );
  await shot("inspect-overview");
  await panel.locator(".report-row", { hasText: "Structured data" }).click();
  await panel.waitForTimeout(600);
  check("report card row opens its panel", /Invalid JSON, line \d+/.test(await text()));

  await open("Inspect", "SEO");
  t = await text();
  check("SEO: short description flagged", /Meta description[\s\S]*5 chars/.test(t));
  check("SEO: headings listed", t.includes("Skipped level"));

  await open("Inspect", "Structured data");
  t = await text();
  check("JSON-LD: invalid block reported with a line", /Invalid JSON, line \d+/.test(t), t.match(/Invalid JSON[^\n]*/)?.[0]);
  check("JSON-LD: bad price reported", t.includes('price "€12,50" must be a plain number'));
  check("JSON-LD: relative image reported", t.includes('image "/mug.jpg" is not an absolute URL'));
  await shot("inspect-jsonld");

  await open("Security", "Headers");
  await panel.waitForTimeout(500);
  t = await text();
  check("headers: grade + version leak", /x-powered-by: Express\/4\.18\.2/.test(t) && /\d+\/100/.test(t), t.match(/\d+\/100/)?.[0]);
  await shot("inspect-headers");

  // Security
  await open("Security", "Secrets");
  await panel.waitForTimeout(1200);
  t = await text();
  check(
    "secrets: fake Stripe live key found in an inline script, masked",
    t.includes("Stripe live secret key") &&
      /inline script #\d+/.test(t) &&
      t.includes(`sk_l…${FAKE_STRIPE_KEY.slice(-4)}`) &&
      !t.includes(FAKE_STRIPE_KEY),
  );
  check(
    "secrets: same-origin script fetched, third-party one skipped",
    /1 third-party script not fetched/.test(t),
    t.match(/Scripts:[^\n]*/)?.[0],
  );
  await shot("security-secrets");

  await open("Security", "Source maps");
  await panel.waitForTimeout(1200);
  t = await text();
  check("source maps: app.js map reachable with its sources", /app\.js[\s\S]*Map reachable[^\n]*original sources/.test(t));
  await panel.getByRole("button", { name: /Probe \d+ paths/ }).click();
  await panel.waitForTimeout(1500);
  t = await text();
  check(
    "exposed files: .git/HEAD exposed, nothing else on a 404-for-everything server",
    /10\/10 probed · 1 exposed/.test(t) && /\.git\/HEAD\s+exposed/.test(t) && /\/\.env\s+not served/.test(t),
    t.match(/\d+\/\d+ probed[^\n]*/)?.[0],
  );
  await shot("security-exposed");

  await open("Security", "Third parties");
  await panel.waitForTimeout(500);
  t = await text();
  check(
    "third parties: cross-origin script without integrity",
    t.includes("Cross-origin script without integrity") && t.includes("localhost"),
  );
  await shot("security-third-parties");

  await open("Security", "Vulnerable libraries");
  await panel.waitForTimeout(1200);
  t = await text();
  const jq = await panel
    .locator(".lib-card", { hasText: "jQuery" })
    .innerText()
    .catch(() => "");
  const lodash = await panel
    .locator(".lib-card", { hasText: "Lodash" })
    .innerText()
    .catch(() => "");
  check(
    "vulnerable libraries: jQuery 3.4.1 flagged with CVE-2020-11022, seen as a global, a file name and a banner",
    /jQuery\s+3\.4\.1/.test(jq) &&
      jq.includes("CVE-2020-11022") &&
      jq.includes("≥ 3.5.0") &&
      jq.includes("window.jQuery.fn.jquery") &&
      /file name\s+\/js\/jquery-3\.4\.1\.min\.js/.test(jq) &&
      /file content\s+\/js\/jquery-3\.4\.1\.min\.js/.test(jq),
    jq.split("\n").slice(0, 3).join(" | "),
  );
  check(
    "vulnerable libraries: an up-to-date lodash 4.18.1 is not flagged",
    /Lodash\s+4\.18\.1/.test(lodash) &&
      lodash.includes("No known advisory") &&
      !/CVE-/.test(lodash) &&
      /1 vulnerable library\s+of 2 found/.test(t),
    lodash.split("\n").slice(0, 2).join(" | "),
  );
  await shot("security-libraries");

  await open("Security", "CSP");
  await panel.waitForTimeout(800);
  t = await text();
  check(
    "CSP: unsafe-inline and wildcard flagged, starter policy lists the vendor origin",
    t.includes("'unsafe-inline' without a nonce or hash") && t.includes("Wildcard *") && /script-src 'self' http:\/\/localhost:\d+/.test(t),
  );
  await shot("security-csp");

  await open("Inspect", "Performance");
  t = await text();
  check("performance: vitals shown", t.includes("LCP") && t.includes("TTFB"));
  const rows = await panel.locator(".viz-waterfall li").allInnerTexts();
  check(
    "performance: waterfall rows with type, name, size and duration",
    rows.length > 0 && rows.some((r) => /mug\.jpg/.test(r) && /Img/.test(r) && /\d+ B · \d+ ms/.test(r)),
    `${rows.length} rows`,
  );
  check("performance: navigation timeline", t.includes("Waiting (server)") && t.includes("DOMContentLoaded"));
  await panel.getByRole("button", { name: "Find the slow interactions and their scripts" }).click();
  await panel.waitForTimeout(600);
  check("performance: INP line opens the Responsiveness panel", (await text()).includes("Slow interactions"));

  // Responsiveness: record, click a button whose handler blocks 250 ms, stop, and find the click and its script.
  t = await text();
  check(
    "responsiveness: bfcache not measured yet, with a test button",
    /Back\/forward cache[\s\S]*Not measured/.test(t) && (await panel.getByRole("button", { name: "Test now" }).count()) === 1,
  );
  check(
    "responsiveness: speculation rules from the page and the header",
    t.includes("Prerender") &&
      t.includes("conservative") &&
      t.includes('href matches "/*" and not link matches ".no-prerender"') &&
      t.includes("immediate (default)") &&
      t.includes("/speculation.json") &&
      t.includes('href matches "/docs/*"'),
  );
  await panel.getByRole("button", { name: "Record", exact: true }).click();
  await panel.waitForTimeout(400);
  await site.bringToFront();
  await site.click("#slow-btn");
  await site.waitForFunction(() => document.getElementById("slow-out")?.textContent === "done");
  await site.waitForTimeout(500);
  await panel.bringToFront();
  await panel.waitForTimeout(1200);
  check("responsiveness: recording counts the interaction live", /Recording for [\d.]+ s: [1-9]\d* interactions?/.test(await text()));
  await panel.getByRole("button", { name: "Stop and analyze" }).click();
  await panel.waitForSelector(".rs-row", { timeout: 5000 }).catch(() => undefined);
  await panel.waitForTimeout(400);
  t = await text();
  const slowRow = await panel
    .locator(".rs-row", { hasText: "button#slow-btn" })
    .first()
    .innerText()
    .catch(() => "");
  const slowMs = Number(/(\d+) ms/.exec(slowRow)?.[1] ?? 0);
  check("responsiveness: the slow click is listed with its duration", /click/.test(slowRow) && slowMs >= 250, slowRow.replace(/\s+/g, " "));
  check(
    "responsiveness: INP estimate rated",
    /INP\s*estimate for this tab/.test(t) && /Worst of \d+ interactions?/.test(t) && /Needs improvement|Poor/.test(t),
  );
  check(
    "responsiveness: blocking scripts name slow.js",
    (await panel.locator(".rs-file", { hasText: "slow.js" }).count()) === 1,
    (await panel.locator(".rs-file").allInnerTexts()).join(" | "),
  );
  await panel.locator(".rs-script", { hasText: "onSlowClick" }).first().click();
  await panel.waitForTimeout(500);
  t = await text();
  check("responsiveness: script card with file:line:column and invoker", /slow\.js:5:\d+/.test(t) && t.includes("BUTTON#slow-btn.onclick"));
  await panel.evaluate(() => {
    navigator.clipboard.writeText = async (s) => {
      window.__copied = s;
    };
  });
  await panel.locator(".rs-card").getByRole("button", { name: "Copy for agent" }).click();
  await panel.waitForTimeout(300);
  const md = await panel.evaluate(() => window.__copied ?? "");
  check(
    "responsiveness: Markdown for an agent with the script, position and suggestions",
    md.includes("# Slow interaction on") &&
      /`onSlowClick` in http:\/\/127\.0\.0\.1:\d+\/slow\.js at line 5, column \d+/.test(md) &&
      md.includes("## Suggestions (heuristics"),
  );
  await shot("inspect-responsiveness");

  await panel.getByRole("button", { name: "Test now" }).click();
  await panel.waitForFunction(
    () => /Restored from the cache|The page reloaded \(/.test(document.querySelector("main")?.innerText ?? ""),
    null,
    {
      timeout: 20_000,
    },
  );
  t = await text();
  check(
    "bfcache: test reports the unload handler",
    t.includes("Not restored") && t.includes("An unload handler") && t.includes("unload-listener"),
  );
  await shot("inspect-bfcache");
  await site.goto(`${base}/plain`);
  await panel.waitForTimeout(800);
  await panel.getByRole("button", { name: "Test now" }).click();
  await panel.waitForFunction(
    () => /Restored from the cache|The page reloaded \(/.test(document.querySelector("main")?.innerText ?? ""),
    null,
    {
      timeout: 20_000,
    },
  );
  t = await text();
  check(
    "bfcache: a plain page is restored",
    t.includes("Restored from the cache"),
    t.match(/(Not restored|Restored from the cache)\s*[^\n]*/)?.[0],
  );
  await site.goto(`${base}/`);
  await site.waitForTimeout(400);

  await open("Inspect", "Console errors");
  await panel.getByRole("button", { name: "Capture on all pages" }).click();
  await panel.waitForTimeout(400);
  await site.reload();
  await site.waitForTimeout(500);
  await panel.locator("main").getByRole("button", { name: "Refresh" }).click();
  await panel.waitForTimeout(500);
  t = await text();
  check("errors: startup error captured after enabling capture", t.includes("startup error from test page"));
  const badge = await sw.evaluate((tab) => chrome.action.getBadgeText({ tabId: tab }), tabId);
  check("errors: count on the toolbar badge (JS error + 404 image)", badge === "2", `badge="${badge}"`);

  await open("Inspect", "Link checker");
  await panel.getByRole("button", { name: "Check all" }).click();
  await panel.waitForTimeout(2000);
  t = await text();
  check("links: one broken link found", /1 broken/.test(t) && t.includes("/missing"), t.match(/\d+\/\d+ checked · \d+ broken/)?.[0]);

  await open("Inspect", "robots.txt");
  await panel.waitForTimeout(700);
  t = await text();
  check("site files: robots, sitemap, manifest", t.includes("Disallow: /admin") && t.includes("2 entries") && t.includes("512px icon"));

  await open("Inspect", "Accessibility");
  await panel.waitForSelector(".ax-summary", { timeout: 15_000 }).catch(() => undefined);
  t = await text();
  check(
    "a11y: axe reports image-alt, label and heading-order, with the honesty note",
    ["image-alt", "label", "heading-order"].every((id) => new RegExp(`\\n${id}\\s`).test(t)) &&
      t.includes("Automated checks catch part of WCAG issues; manual testing"),
    t.match(/\d+ rules? fails? on \d+ elements?/)?.[0],
  );
  check("a11y: WCAG criterion named", /image-alt\s+critical\s+WCAG 2\.0 A\s+1\.1\.1 Non-text Content/.test(t));
  const imageAlt = panel.locator(".ax-rule", { has: panel.locator(".ax-rule-id", { hasText: /^image-alt$/ }) });
  await imageAlt.locator("summary").click();
  await imageAlt.locator(".ax-target").first().click();
  await panel.waitForTimeout(400);
  const outlined = await site.evaluate(() => {
    const host = document.querySelector("devkit-a11y");
    return host ? document.querySelector("img").getBoundingClientRect().top >= 0 : false;
  });
  check("a11y: clicking a failing element outlines it in the page", outlined);
  await site.keyboard.press("Escape");
  await panel.waitForTimeout(200);
  check("a11y: the outline goes away on the next key", !(await site.evaluate(() => Boolean(document.querySelector("devkit-a11y")))));
  await panel.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (s) => {
      window.__copied.push(s);
    };
  });
  await imageAlt.getByRole("button", { name: "Copy for agent" }).click();
  await panel.locator(".ax-summary").getByRole("button", { name: "Copy for agent" }).click();
  await panel.waitForTimeout(200);
  const copied = await panel.evaluate(() => window.__copied);
  check(
    "a11y: Copy for agent gives Markdown with the rule, WCAG refs, selector and snippet",
    copied[0]?.includes("## `image-alt`: Images must have alternative text") &&
      copied[0]?.includes("WCAG 1.1.1 Non-text Content (A)") &&
      copied[0]?.includes("1. `img`") &&
      copied[0]?.includes('<img src="/mug.jpg">') &&
      copied[1]?.includes("# Accessibility audit") &&
      copied[1]?.includes('`input[name="email"]`'),
    copied[0]?.split("\n")[0],
  );
  await shot("inspect-a11y");
  await panel.getByLabel("Region (CSS selector)").fill("form");
  await panel.getByLabel("Region (CSS selector)").press("Enter");
  await panel.waitForTimeout(1200);
  t = await text();
  check(
    "a11y: region audit covers only the selector",
    /\nform · \d+ elements/.test(t) && /\nlabel\s/.test(t) && !/\nimage-alt\s/.test(t),
    t.match(/\n(form|Whole page) · [^\n]*/)?.[0],
  );
  await panel.getByRole("button", { name: "Whole page" }).click();
  await panel.waitForTimeout(1200);

  await open("Inspect", "Fonts");
  check("fonts & colors: palette listed", (await text()).includes("Page palette"));

  // Cache
  await open("Cache", "Local & session storage");
  check("storage editor lists the key", (await text()).includes("devkit-test"));
  await open("Cache", "Cookies");
  t = await text();
  check("cookie editor lists the cookie", t.includes("session") && t.includes("abc123"));
  check("cookie audit: session cookie readable by JS", t.includes("readable by JS") && t.includes("1 risky"));

  await site.evaluate(async () => {
    await new Promise((done, fail) => {
      const req = indexedDB.open("devkit-e2e-db", 2);
      req.onupgradeneeded = () => req.result.createObjectStore("items");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("items", "readwrite");
        for (let i = 0; i < 3; i++) tx.objectStore("items").put({ i }, i);
        tx.oncomplete = () => {
          db.close();
          done();
        };
      };
      req.onerror = () => fail(req.error);
    });
    const cache = await caches.open("devkit-e2e-cache");
    await cache.put("/cached.json", new Response("x".repeat(2048), { headers: { "content-length": "2048" } }));
  });
  await open("Cache", "Storage usage");
  await panel.waitForTimeout(800);
  t = await text();
  check(
    "storage usage: quota, IndexedDB records and Cache Storage entries",
    /Quota for this site/.test(t) &&
      t.includes("devkit-e2e-db") &&
      t.includes("items: 3 records") &&
      t.includes("devkit-e2e-cache") &&
      /1 entry · 2\.00 KB/.test(t),
    t.match(/items: [^\n]*/)?.[0],
  );
  check("storage usage: localStorage key sized", t.includes("devkit-test"));

  await open("Cache", "Cache actions");
  await site.evaluate(() => {
    window.__devkitMarker = true;
  });
  await action("Hard reload");
  await site.waitForLoadState("load");
  await site.waitForTimeout(600);
  check("hard reload reloads the page", await site.evaluate(() => window.__devkitMarker !== true));

  await action("Toggle no-cache for this tab");
  await panel.waitForTimeout(400);
  const noCache = await site.evaluate(async () => (await (await fetch("/echo")).json())["cache-control"]);
  check("no-cache rule sends Cache-Control: no-cache", noCache === "no-cache", `cache-control=${noCache}`);
  await action("Toggle no-cache for this tab");
  await panel.waitForTimeout(400);
  check("no-cache rule removed on second toggle", !(await sessionRules()).some((r) => r.id >= 900_000));

  await open("Cache", "Clear site data");
  await panel.getByRole("button", { name: "Clear selected" }).click();
  await site.waitForLoadState("load");
  await site.waitForTimeout(800);
  check("clear site data empties localStorage and reloads", (await site.evaluate(() => localStorage.getItem("devkit-test"))) === null);

  // Page
  await open("Page");
  check(
    "element picker: default panel of the Page tab",
    (await panel.locator(".subnav button[aria-pressed=true]").innerText()) === "Element",
  );
  const overlayOn = () => site.evaluate(() => Boolean(document.querySelector("devkit-picker")));
  const waitOverlay = () =>
    site.waitForFunction(() => Boolean(document.querySelector("devkit-picker")), null, { timeout: 5000 }).catch(() => undefined);
  await panel.getByRole("button", { name: "Pick an element" }).click();
  await waitOverlay();
  check("element picker: overlay injected", await overlayOn());
  await site.keyboard.press("Escape");
  await panel.waitForTimeout(400);
  check("element picker: Esc cancels and removes the overlay", (await text()).includes("Pick cancelled") && !(await overlayOn()));
  await panel.getByRole("button", { name: "Pick an element" }).click();
  await waitOverlay();
  await site.click("#save-btn");
  await panel.waitForSelector(".el-card", { timeout: 8000 }).catch(() => undefined);
  await panel.waitForTimeout(500);
  t = await text();
  check(
    "element picker: React component and file:line",
    t.includes("<SaveButton>") && t.includes("/app/src/components/SaveButton.tsx:14:9") && t.includes("/app/src/Toolbar.tsx:12:7"),
    t.match(/[^\n]*SaveButton\.tsx[^\n]*/)?.[0],
  );
  check("element picker: the page never saw the click", (await site.evaluate(() => window.__saveClicks ?? 0)) === 0);
  check("element picker: overlay removed after the pick", !(await overlayOn()));
  await panel.getByLabel("What's wrong / what should change?").fill("The button should be full width on mobile.");
  t = await text();
  check(
    "element picker: Markdown with selector, locator, props and note",
    t.includes("Selector: `#save-btn`") &&
      t.includes("page.getByRole('button', { name: 'Save changes' })") &&
      t.includes('"onSave": "ƒ handleSave"') &&
      t.includes("The button should be full width on mobile."),
  );
  await shot("page-element");
  await panel.locator(".el-crumb", { hasText: "section.toolbar" }).click();
  await panel.waitForTimeout(600);
  check("element picker: breadcrumb selects the parent", (await panel.locator(".el-tag").innerText()) === "section.toolbar");

  await open("Page", "Page tools");
  await action("Toggle element outlines");
  await panel.waitForTimeout(300);
  check("page tools: outlines injected", await site.evaluate(() => Boolean(document.getElementById("devkit-outline"))));
  await action("Toggle design mode");
  await panel.waitForTimeout(300);
  check("page tools: design mode on", (await site.evaluate(() => document.designMode)) === "on");
  await action("Toggle design mode");

  await open("Page", "Emulation");
  const isDark = () => site.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const baseline = await isDark();
  await panel.getByLabel("prefers-color-scheme").selectOption(baseline ? "light" : "dark");
  await panel.waitForTimeout(800);
  check("emulation: prefers-color-scheme flipped", (await isDark()) !== baseline, `page default dark=${baseline}`);
  await panel.getByRole("button", { name: "Stop & reset" }).click();
  await panel.waitForTimeout(500);
  check("emulation: reset to the page default", (await isDark()) === baseline);

  await open("Page", "Screenshot");
  await panel.getByRole("button", { name: "Full page" }).click();
  const img = await panel
    .getByAltText("Screenshot of the page")
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check("screenshot: full page captured", img);

  await open("Page", "Form filler");
  await panel.getByRole("button", { name: "Fill the forms" }).click();
  await panel.waitForTimeout(300);
  const filled = await site.evaluate(() => ({
    email: document.querySelector("[name=email]").value,
    first: document.querySelector("[name=first_name]").value,
  }));
  check("form filler fills by field name", /@example\.com$/.test(filled.email) && filled.first.length > 1, JSON.stringify(filled));

  // Network
  await open("Network", "Request rules");
  await panel.getByRole("button", { name: "+ Header" }).click();
  await panel.getByLabel("URL filter").fill("||127.0.0.1");
  await panel.getByPlaceholder("x-feature-flag").fill("x-devkit-test");
  await panel.getByPlaceholder("value", { exact: true }).fill("yes");
  await panel.getByRole("button", { name: "Apply" }).click();
  await panel.waitForTimeout(500);
  const echoed = await site.evaluate(async () => (await (await fetch("/echo")).json())["x-devkit-test"]);
  check("request rule adds a header", echoed === "yes", `x-devkit-test=${echoed}`);
  await shot("network-rules");

  await open("Network", "Environments");
  await panel.getByRole("button", { name: "Create a group from this site" }).click();
  await panel.waitForTimeout(500);
  await site.reload();
  await site.waitForTimeout(800);
  check("environments: prod ribbon on the page", await site.evaluate(() => Boolean(document.getElementById("devkit-env-ribbon"))));
  const envBadge = await sw.evaluate((tab) => chrome.action.getBadgeText({ tabId: tab }), tabId);
  check("environments: PROD badge", envBadge === "PROD", `badge="${envBadge}"`);
  check("environments: switch button offered", (await text()).includes("Open on local"));
  await panel.getByRole("button", { name: "Delete group" }).click();

  // API mocks: create from the real response, serve it through the debugger, coexist with Emulation
  const getUser = () =>
    site.evaluate(async () => {
      const r = await fetch("/api/user");
      return { status: r.status, body: await r.json(), mock: r.headers.get("x-devkit-mock") };
    });
  // getTargets() counts Playwright's own CDP client: ask the session itself whether devkit holds it.
  const attachedTo = () =>
    sw.evaluate(
      (tab) =>
        chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: "0" }).then(
          () => true,
          (e) => !/not attached/i.test(String(e)),
        ),
      tabId,
    );
  check("mocks: real API answers before mocking", (await getUser()).body.name === "Real User");
  await open("Network", "Mock API");
  await panel.getByRole("button", { name: "From URL" }).click();
  await panel.getByLabel("URL to fetch").fill(`${base}/api/user`);
  await panel.getByRole("button", { name: "Fetch and create" }).click();
  await panel.getByLabel("Body").waitFor();
  check("mocks: created from the real response", (await panel.getByLabel("Body").inputValue()).includes('"name": "Real User"'));
  await panel.getByLabel("Body").fill('{"id": 1, "name": "Mocked User", "plan": "pro"}');
  await panel.getByLabel("Status", { exact: true }).fill("201");
  await panel.getByRole("button", { name: "Turn on" }).click();
  await panel.waitForTimeout(700);
  let user = await getUser();
  check("mocks: page gets the mocked body and status", user.status === 201 && user.body.name === "Mocked User", JSON.stringify(user));
  await panel.waitForTimeout(400);
  t = await text();
  check("mocks: log shows the hit", /201 · \/api\/user/.test(t) && t.includes("1 request mocked"), t.match(/\d+ requests? mocked/)?.[0]);
  check("mocks: count badge on the panel pill", (await panel.locator(".subnav .mock-badge").innerText()) === "1");
  await shot("network-mocks");

  await panel.getByRole("radio", { name: "Network error" }).check();
  await panel.waitForTimeout(600);
  const failed = await site.evaluate(() =>
    fetch("/api/user").then(
      () => "resolved",
      (e) => e.name,
    ),
  );
  check("mocks: network error mode fails the request", failed === "TypeError", failed);
  await panel.getByRole("radio", { name: "Response" }).check();
  await panel.waitForTimeout(600);

  await site.reload();
  await site.waitForTimeout(600);
  user = await getUser();
  check("mocks: still on after the tab reloads", user.status === 201 && user.mock === "/api/user", JSON.stringify(user));

  await site.evaluate(() => fetch("/echo").then((r) => r.text()));
  await panel.waitForTimeout(500);
  await panel.locator(".mock-row", { hasText: "/echo" }).getByRole("button", { name: "Mock" }).click();
  await panel.waitForTimeout(500);
  const echoBody = await panel.getByLabel("Body").inputValue();
  check(
    "mocks: “Mock” on a logged request prefills what the page received",
    /"host": "127\.0\.0\.1:\d+"/.test(echoBody),
    echoBody.slice(0, 60),
  );
  await panel.getByRole("button", { name: "Delete", exact: true }).click();

  // Emulation shares the session: stopping it must not end mocking.
  await open("Page", "Emulation");
  await panel.getByLabel("prefers-color-scheme").selectOption((await isDark()) ? "light" : "dark");
  await panel.waitForTimeout(500);
  await panel.getByRole("button", { name: "Stop & reset" }).click();
  await panel.waitForTimeout(500);
  user = await getUser();
  check("mocks: survive Emulation's stop & reset", user.status === 201 && (await attachedTo()), JSON.stringify(user));

  // The session ends behind devkit's back (Cancel on Chrome's bar): the panel says so and re-attaches.
  await sw.evaluate((tab) => chrome.debugger.detach({ tabId: tab }), tabId);
  await open("Network", "Mock API");
  await panel.getByRole("button", { name: "Turn back on" }).waitFor();
  check("mocks: a lost session is reported", (await text()).includes("Mocking stopped"));
  await panel.getByRole("button", { name: "Turn back on" }).click();
  await panel.waitForTimeout(700);
  check("mocks: re-attached after the session was lost", (await getUser()).status === 201);

  await panel.getByRole("button", { name: "Turn off" }).click();
  await panel.waitForTimeout(600);
  user = await getUser();
  check("mocks: turning off restores the real response", user.status === 200 && user.body.name === "Real User", JSON.stringify(user));
  check("mocks: debugger detached once nobody needs it", !(await attachedTo()));

  // AI with a fake OpenAI-compatible endpoint
  await open("AI", "AI settings");
  await panel.waitForTimeout(500);
  await panel.getByLabel("Local / custom endpoint").check();
  await panel.getByPlaceholder("http://localhost:11434/v1").fill(`${base}/v1`);
  await panel.getByPlaceholder("llama3.2").fill("fake-model");
  await panel.getByRole("button", { name: "Test connection" }).click();
  await panel.waitForTimeout(1200);
  t = await text();
  check("AI: connection test against the local endpoint", t.includes("Connection works"), t.match(/Connection[^\n]*/)?.[0]);
  await panel.getByRole("button", { name: "Save" }).click();
  await panel.waitForTimeout(500);
  await open("AI", "Ask AI");
  await panel.waitForTimeout(800);
  await action("Summarize the page");
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check(
    "AI: streamed answer with page title and text",
    t.includes("FAKE-MODEL answer") && t.includes("Acme Mug") && t.includes("Page text included: true"),
    t.match(/FAKE-MODEL[^\n]*/)?.[0],
  );
  check("AI: usage shown", /1234 in · 20 out/.test(t));
  await shot("ai-ask");

  // Element picker → Ask AI: the picked element travels as a context part.
  await open("Page", "Element picker");
  await panel.getByRole("button", { name: /^Pick (an element|another)$/ }).click();
  await waitOverlay();
  await site.click("#save-btn");
  await panel.waitForSelector(".el-card", { timeout: 8000 }).catch(() => undefined);
  await panel.getByRole("button", { name: "Ask AI about it" }).click();
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check("element picker: Ask AI sends the picked element", t.includes("Fix the picked element") && t.includes("Picked element: button"));

  // Accessibility audit → Ask AI: the axe results travel as the a11y part.
  await open("Inspect", "Accessibility");
  await panel.waitForSelector(".ax-summary", { timeout: 15_000 }).catch(() => undefined);
  await panel.locator(".ax-summary").getByRole("button", { name: "Ask AI about it" }).click();
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check("a11y: Ask AI sends the axe audit", t.includes("Accessibility review") && t.includes("Axe rules seen: image-alt"));

  await open("AI", "Model browser");
  await panel.waitForTimeout(1500);
  check("AI: model browser lists the catalog", /Model browser \(\d{3,}\)/.test(await text()));

  // Utils
  const field = (n = 0) => panel.locator("main textarea, main input:not([type=checkbox]):not([type=color])").nth(n);
  await open("Utils", "JSON");
  await panel.locator("main textarea").first().fill('{"b":1,"a":[true,null]}');
  await panel.getByRole("button", { name: "TypeScript" }).click();
  check("utils: JSON → TypeScript", (await text()).includes("interface Root"));

  await open("Utils", "JWT");
  await panel
    .getByPlaceholder("eyJhbGciOi…")
    .fill("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXZraXQtdGVzdCIsImlhdCI6MTUxNjIzOTAyMn0.c2lnbmF0dXJl");
  await panel.waitForTimeout(200);
  check("utils: JWT payload decoded", (await text()).includes("devkit-test"));

  await open("Utils", "Encode");
  await panel.getByPlaceholder("Text to encode or decode").fill("hello devkit");
  await panel.waitForTimeout(200);
  check("utils: Base64 encode", (await text()).includes("aGVsbG8gZGV2a2l0"));

  await open("Utils", "Hash");
  await panel.getByPlaceholder("Text to hash (UTF-8)").fill("abc");
  await panel.waitForTimeout(500);
  check("utils: SHA-256", (await text()).includes("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));

  await open("Utils", "Timestamps");
  await field().fill("0");
  await panel.waitForTimeout(200);
  check("utils: timestamp → ISO", (await text()).includes("1970-01-01T00:00:00.000Z"));

  await open("Utils", "Regex");
  await panel.getByLabel("Pattern").fill("(\\d+)-(\\d+)");
  await panel.getByLabel("Flags").fill("g");
  await panel.locator("main textarea").first().fill("10-20 and 30-40");
  await panel.waitForTimeout(200);
  check("utils: regex matches", /2 match/.test(await text()), (await text()).match(/\d+ match\w*/)?.[0]);

  await open("Utils", "Cron");
  await field().fill("*/15 * * * 1-5");
  await panel.waitForTimeout(200);
  t = await text();
  check("utils: cron explained with next runs", t.includes("Next runs") && /15 minutes/.test(t));
  await shot("utils");

  // Popup palette
  const popup = await context.newPage();
  popup.on("pageerror", (e) => extErrors.push(`popup pageerror: ${e.message}`));
  await popup.setViewportSize({ width: 400, height: 560 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByLabel("Search commands").fill("json-ld");
  const first = await popup.getByRole("option").first().innerText();
  check("palette finds the JSON-LD analyzer", /Structured data/.test(first), first.split("\n")[0]);
  await popup.getByLabel("Search commands").fill("pick");
  const pickFirst = await popup.getByRole("option").first().innerText();
  check("palette finds the element picker", /Pick an element/.test(pickFirst), pickFirst.split("\n")[0]);

  // Options
  const options = await context.newPage();
  options.on("pageerror", (e) => extErrors.push(`options pageerror: ${e.message}`));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForTimeout(800);
  const ot = await options.locator("body").innerText();
  check(
    "options page renders settings and permissions",
    ot.includes("AI settings") && ot.includes("Permissions") && ot.includes("Error capture"),
  );

  check("no errors in extension pages", extErrors.length === 0, extErrors.slice(0, 5).join(" | "));
} catch (e) {
  check("run completed", false, e instanceof Error ? e.stack : String(e));
  const last = context.pages().find((p) => p.url().includes("sidepanel.html"));
  if (extErrors.length) console.log(`Extension errors:\n${extErrors.join("\n")}`);
  if (last)
    console.log(
      `Side panel at failure:\n${(
        await last
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 1500)}`,
    );
} finally {
  clearTimeout(watchdog);
  await context.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
