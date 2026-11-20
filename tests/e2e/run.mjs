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
  console.log("WATCHDOG: aborting after 300 s");
  process.exit(2);
}, 300_000);

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
  check("report card: headings row flags the skipped level", /Headings\s*1 to review/.test(t), t.match(/Headings[^\n]*\n?[^\n]*/)?.[0]);
  await shot("inspect-overview");
  await panel.locator(".report-row", { hasText: "Structured data" }).click();
  await panel.waitForTimeout(600);
  check("report card row opens its panel", /Invalid JSON, line \d+/.test(await text()));

  await open("Inspect", "SEO");
  t = await text();
  check("SEO: short description flagged", /Meta description[\s\S]*5 chars/.test(t));
  check("SEO: headings summarized", t.includes("h1 ×1 · h2 ×1 · h4 ×1"), t.match(/h1 ×[^\n]*/)?.[0]);
  await panel.getByRole("button", { name: "Open the outline" }).click();
  await panel.waitForTimeout(800);
  t = await text();
  check("SEO: Open the outline goes to the Headings panel", t.includes("Skipped level: h2 → h4") && t.includes("Page map"));

  await open("Inspect", "Structured data");
  const jsonldMode = (name) => panel.locator('fieldset[aria-label="Validate"] button', { hasText: name }).click();
  const expandFindings = async () => {
    const closed = panel.locator("details.jl-findings:not([open]) > summary");
    for (let n = await closed.count(); n > 0; n--) await closed.first().click();
    await panel.waitForTimeout(200);
  };
  await jsonldMode("Rich Results");
  await panel.getByText("X-Robots-Tag").waitFor();
  await panel.waitForTimeout(400);
  t = await text();
  check("JSON-LD: invalid block reported with a line", /Invalid JSON, line \d+/.test(t), t.match(/Invalid JSON[^\n]*/)?.[0]);
  check(
    "JSON-LD: header shows canonical, robots and X-Robots-Tag",
    /Canonical\s*http:\/\/127\.0\.0\.1:\d+\//.test(t) && /Robots\s*None/.test(t) && /X-Robots-Tag\s*noarchive/.test(t),
    t.match(/X-Robots-Tag[^\n]*\n?[^\n]*/)?.[0],
  );
  check("JSON-LD: every block has a status badge", (await panel.locator(".jl-block").count()) === 2 && /Block #1\s*Error/.test(t));
  check(
    "JSON-LD: findings start collapsed below the code",
    !t.includes('price "€12,50" must be a plain number') && t.includes("Findings:"),
  );
  await expandFindings();
  t = await text();
  check("JSON-LD: bad price reported with the fix", t.includes('price "€12,50" must be a plain number') && t.includes('write "12.50"'));
  check("JSON-LD: relative image reported", t.includes('image "/mug.jpg" is not an absolute URL'));
  check(
    "JSON-LD: Rich Results mode keeps vocabulary findings aside",
    !t.includes("Did you mean") && /more findings? in Schema\.org mode/.test(t),
  );
  await jsonldMode("Schema.org");
  await panel.waitForTimeout(300);
  await expandFindings();
  t = await text();
  check(
    "JSON-LD: Schema.org mode catches a property typo",
    t.includes("descripton is not a Schema.org property. Did you mean description?"),
    t.match(/descripton[^\n]*/)?.[0],
  );
  check("JSON-LD: Schema.org mode drops Google's recommendations", !t.includes("missing recommended"));
  check("JSON-LD: vocabulary source shown", /Schema\.org \d+\.\d+ vocabulary/.test(t));
  await panel.locator('input[aria-label="Search the blocks"]').fill("acme mug");
  await panel.waitForTimeout(200);
  check(
    "JSON-LD: search filters blocks and marks matches",
    (await panel.locator(".jl-block").count()) === 1 && (await panel.locator(".jl-block mark.hl").first().innerText()) === "Acme Mug",
  );
  await panel.locator('input[aria-label="Search the blocks"]').fill("");
  await shot("inspect-jsonld");
  await jsonldMode("Rich Results");

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
  const slowMd = await panel.evaluate(() => window.__copied ?? "");
  check(
    "responsiveness: Markdown for an agent with the script, position and suggestions",
    slowMd.includes("# Slow interaction on") &&
      /`onSlowClick` in http:\/\/127\.0\.0\.1:\d+\/slow\.js at line 5, column \d+/.test(slowMd) &&
      slowMd.includes("## Suggestions (heuristics"),
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
      /1\. `img[^`]*`/.test(copied[0] ?? "") &&
      copied[0]?.includes('<img src="/mug.jpg">') &&
      copied[1]?.includes("# Accessibility audit") &&
      copied[1]?.includes('`input[name="email"]`'),
    copied[0]?.split("\n")[0],
  );
  await shot("inspect-a11y");

  // Copy for agent: the page-wide fix list on Overview, and the per-panel reports it points to.
  const lastCopy = async (button) => {
    const before = await panel.evaluate(() => window.__copied.length);
    await button.click();
    await panel.waitForFunction((n) => window.__copied.length > n, before, { timeout: 10000 }).catch(() => undefined);
    return panel.evaluate(() => window.__copied.at(-1) ?? "");
  };
  await open("Inspect", "Overview");
  await panel.waitForTimeout(2500);
  const fixList = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check(
    "agent: Overview copies one fix list with a status table and every area to fix",
    fixList.startsWith("# Fix list for Acme Mug") &&
      fixList.includes("| Area | Result | Re-run in devkit |") &&
      fixList.includes("## Secrets") &&
      fixList.includes("sk_l…") &&
      !/sk_live_[A-Za-z0-9]{8,}/.test(fixList) &&
      fixList.includes("## Content-Security-Policy") &&
      !fixList.includes("1. Content-Security-Policy: Weak") &&
      fixList.includes("#### `image-alt`") &&
      fixList.includes("`#1.offers.price`") &&
      fixList.includes("| Headings | 1 warning | Inspect › Headings |") &&
      fixList.includes("## Headings outline") &&
      fixList.includes("Skipped level: h2 → h4"),
    fixList.split("\n")[2],
  );
  await open("Security", "Headers");
  await panel.waitForTimeout(1500);
  const headersMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check(
    "agent: Headers gives the header lines to add",
    headersMd.startsWith("## Response headers") && headersMd.includes("`X-Content-Type-Options: nosniff`"),
    headersMd.split("\n")[2],
  );
  await open("Inspect", "Link checker");
  await panel
    .getByRole("button", { name: /Check all/ })
    .first()
    .click();
  await panel.waitForTimeout(4000);
  const linksMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check(
    "agent: Links lists the broken link with a selector to find it",
    linksMd.includes("HTTP 404: `http://") && linksMd.includes('`a[href*="/missing"]`'),
    linksMd.split("\n")[2],
  );
  await open("Inspect", "Accessibility");
  await panel.waitForTimeout(800);
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

  // cookies.txt export: an HttpOnly cookie the page cannot set, then Copy in each format.
  // Chrome caps expiry at 400 days: stay well under it.
  const authExpiry = Math.floor(Date.now() / 1000) + 86400 * 30;
  await sw.evaluate(
    ([u, exp]) => chrome.cookies.set({ url: `${u}/`, name: "auth", value: "t0k3n", httpOnly: true, expirationDate: exp + 0.5 }),
    [base, authExpiry],
  );
  await open("Cache", "Local & session storage");
  await open("Cache", "Cookies");
  await panel.evaluate(() => {
    window.__cookieCopies = [];
    navigator.clipboard.writeText = async (s) => {
      window.__cookieCopies.push(s);
    };
  });
  const exportBar = panel.locator(".cookie-export");
  const copyCookies = async (format) => {
    await exportBar.getByLabel("Export format").selectOption(format);
    await exportBar.getByRole("button", { name: "Copy", exact: true }).click();
    await panel.waitForTimeout(200);
    return panel.evaluate(() => window.__cookieCopies.at(-1) ?? "");
  };
  const cookieLines = (text) => text.split("\n").filter((l) => l && !l.startsWith("# "));
  const txt = await copyCookies("netscape");
  const txtLines = cookieLines(txt);
  check(
    "cookies.txt: Netscape header, tab-separated lines, session expiry 0, #HttpOnly_ prefix",
    txt.startsWith("# Netscape HTTP Cookie File\n") &&
      txtLines.includes("127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tabc123") &&
      txtLines.includes(`#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t${authExpiry}\tauth\tt0k3n`) &&
      txt.endsWith("\n"),
    JSON.stringify(txtLines),
  );
  const header = await copyCookies("header");
  check("cookies: Cookie header string", /^(session=abc123; auth=t0k3n|auth=t0k3n; session=abc123)$/.test(header), header);
  const json = await copyCookies("json");
  check(
    "cookies: JSON export of Chrome's cookie fields",
    JSON.parse(json).some((c) => c.name === "auth" && c.httpOnly === true),
  );
  check(
    "cookies: export format remembered",
    (await sw.evaluate(() => chrome.storage.local.get("cookies.exportFormat")))["cookies.exportFormat"] === "json",
  );
  await exportBar.getByLabel("Export format").selectOption("netscape");
  await panel.getByLabel("Filter cookies").fill("auth");
  await panel.getByRole("checkbox", { name: "Table" }).check();
  await panel.getByRole("checkbox", { name: "Nowrap" }).check();
  const tableText = await panel.locator(".cookie-table").innerText();
  check(
    "cookies: Netscape table view, filtered, with nowrap",
    tableText.includes("Include Subdomains") &&
      tableText.includes(String(authExpiry)) &&
      !tableText.includes("abc123") &&
      (await panel.locator(".cookie-table-wrap.nowrap").count()) === 1,
    tableText.replace(/\s+/g, " "),
  );
  await shot("cache-cookies-table");
  check("cookies: export follows the filter", cookieLines(await copyCookies("netscape")).length === 1);
  await panel.getByRole("checkbox", { name: "Table" }).uncheck();
  await panel.getByLabel("Filter cookies").fill("");
  await sw.evaluate((u) => chrome.cookies.remove({ url: `${u}/`, name: "auth" }), base);

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

  // Measure distances: hover, lock one element, freeze on a second, read the gap in the panel.
  await panel.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (value) => {
      window.__copied.push(value);
    };
  });
  const lastCopied = () => panel.evaluate(() => window.__copied.at(-1) ?? "");
  await open("Page", "Measure distances");
  const measureOn = () => site.evaluate(() => Boolean(document.querySelector("devkit-measure")));
  await panel.getByRole("button", { name: "Start measuring" }).click();
  await site.waitForFunction(() => Boolean(document.querySelector("devkit-measure")), null, { timeout: 5000 }).catch(() => undefined);
  check("measure: overlay injected", await measureOn());
  await site.hover("#m-a");
  await panel.waitForTimeout(400);
  t = await text();
  check("measure: hover shows the box model", t.includes("Box model") && t.includes("#m-a") && t.includes("120 × 40"));
  await site.click("#m-a");
  await site.hover("#m-b");
  await site.click("#m-b");
  // The frozen pair reaches the panel through a message: wait for it rather than a fixed delay (slower on CI).
  await panel
    .waitForFunction(
      () =>
        /Frozen/.test(document.querySelector("main")?.innerText ?? "") &&
        /Horizontal gap\s*24px/.test(document.querySelector("main")?.innerText ?? ""),
      null,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  t = await text();
  check(
    "measure: gap and sizes of two elements",
    /Horizontal gap\s*24px/.test(t) && t.includes("Frozen") && /#m-a\s*120 × 40/.test(t) && /#m-b\s*120 × 40/.test(t),
    JSON.stringify(t.match(/Horizontal gap[\s\S]{0,120}/)?.[0] ?? t.slice(0, 300)),
  );
  check("measure: the page never saw the clicks", (await site.evaluate(() => window.__measureClicks ?? 0)) === 0);
  await panel.getByLabel("Expected").fill("16");
  await panel.getByRole("button", { name: "Copy for agent" }).click();
  await panel.waitForTimeout(200);
  check(
    "measure: copy for agent states the gap and the expected value",
    (await lastCopied()).includes("The horizontal gap between `#m-a` and `#m-b` is 24px; expected 16px (8px too wide)."),
    (await lastCopied()).split("\n")[2],
  );
  await site.keyboard.press("Escape");
  await panel.waitForTimeout(400);
  check("measure: Esc removes the overlay, the panel keeps the result", !(await measureOn()) && (await text()).includes("Last measured"));
  await shot("page-measure");

  // Assets
  await open("Page", "Assets");
  await panel.waitForSelector(".as-item", { timeout: 8000 }).catch(() => undefined);
  await panel.waitForTimeout(400);
  const assetNames = await panel.locator(".as-item .as-name").allInnerTexts();
  check(
    "assets: images, inline SVG, background, manifest icon and social image listed",
    ["mug.jpg", "big.png", "star.svg", "tile.png", "i.png", "og.png"].every((n) => assetNames.includes(n)) && assetNames.length === 6,
    assetNames.join(", "),
  );
  const row = (name) => panel.locator(".as-item", { has: panel.locator(".as-name", { hasText: name }) });
  const bigRow = await row("big.png").innerText();
  check(
    "assets: oversized image flagged",
    bigRow.includes("800 × 800 → 100 × 100") && bigRow.includes("Served 8× larger than displayed"),
    bigRow.replace(/\n/g, " | "),
  );
  check("assets: missing alt flagged", (await row("mug.jpg").innerText()).includes("No alt"));
  await panel.locator(".as-chip", { hasText: "No alt" }).click();
  check("assets: missing alt filter", (await panel.locator(".as-item").count()) === 1);
  await panel.locator(".as-chip", { hasText: "No alt" }).click();
  await row("star.svg").getByRole("button", { name: "Copy SVG" }).click();
  await panel.waitForTimeout(200);
  const svg = await lastCopied();
  check(
    "assets: inline SVG markup copied",
    svg.startsWith('<svg id="icon-star"') && svg.includes('aria-label="Star"') && svg.endsWith("</svg>"),
  );
  const zip = await Promise.all([
    panel.waitForEvent("download", { timeout: 10_000 }).catch(() => null),
    panel.getByRole("button", { name: "Download all as zip" }).click(),
  ]).then(([d]) => d);
  check("assets: download all as zip", Boolean(zip && /-assets\.zip$/.test(zip.suggestedFilename())), zip?.suggestedFilename());
  await shot("page-assets");

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
  await panel.getByRole("button", { name: "New chat" }).click();
  await panel.waitForTimeout(300);
  await action("Fix plan for the whole page");
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 20_000 }).catch(() => undefined);
  await panel.waitForTimeout(1500);
  t = await text();
  check(
    "AI: the fix plan gets the masked secrets and the flagged libraries, never a raw key",
    t.includes("Secrets section: true") && t.includes("Raw secret sent: false") && /First CVE: CVE-\d{4}-\d+/.test(t),
    t.match(/Secrets section[^\n]*/)?.[0],
  );

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

  // Bug report: record steps, trigger a failing request, read the Markdown.
  const preview = () => panel.locator(".section", { hasText: "Markdown preview" }).locator("pre.code").innerText();
  await open("AI", "Bug report");
  await panel.getByLabel("What happened / what did you expect?").fill("Placing the order fails with a 500.");
  await panel.getByRole("button", { name: "Start recording" }).click();
  await panel.getByText("Recording.", { exact: false }).waitFor({ timeout: 5000 });
  await site.bringToFront();
  await site.click("#save-btn");
  await site.fill("#coupon", "SPRING-SALE");
  await site.press("#coupon", "Enter");
  await site.click("#order-btn");
  await site.waitForTimeout(800);
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Stop recording" }).click();
  await panel.waitForTimeout(1500);
  t = await text();
  check(
    "bug report: recorder lists the steps live",
    t.includes('Click button "Save changes"') &&
      t.includes('Type in textbox "Coupon code" (value masked)') &&
      t.includes('Click button "Place order"'),
  );
  let md = await preview();
  check(
    "bug report: steps in order with a Playwright test, typed value masked",
    /\d\. Click button "Save changes"\n\d\. Type in textbox "Coupon code" \(value masked\)\n\d\. Press Enter in textbox "Coupon code"\n\d\. Click button "Place order"/.test(
      md,
    ) &&
      md.includes("await page.getByRole('button', { name: 'Place order' }).click();") &&
      !md.includes("SPRING-SALE"),
    md.match(/## Steps[\s\S]{0,300}/)?.[0],
  );
  check(
    "bug report: failed requests with their status (500 fetch, 404 image)",
    /- 500 fetch `\/api\/orders\?api_key=\[redacted\]`/.test(md) && /- 404 img `\/mug\.jpg`/.test(md),
    md.match(/## Failed[\s\S]{0,300}/)?.[0],
  );
  check("bug report: console error captured", md.includes("Order failed: 500"), md.match(/## Console errors[^\n]*/)?.[0]);
  check(
    "bug report: environment lines",
    /- Browser: Chrom\w* [\d.]+ on /.test(md) &&
      /- Viewport: \d+×\d+ at DPR [\d.]+/.test(md) &&
      md.includes("Placing the order fails with a 500."),
  );
  check(
    "bug report: planted key redacted everywhere",
    !md.includes(FAKE_STRIPE_KEY) &&
      /values? that looked like (a secret was|secrets were) redacted/.test(md) &&
      /\d+ values? redacted/.test(t),
  );
  await shot("ai-report");

  // The recorder survives a navigation of the tab: devkit starts it again in the new document.
  await panel.getByRole("button", { name: "Record again" }).click();
  await panel.getByText("Recording.", { exact: false }).waitFor({ timeout: 5000 });
  await site.bringToFront();
  await site.click("text=Next page");
  await site.waitForLoadState("load");
  await site.waitForTimeout(900);
  await site.click("#save-btn");
  await site.waitForTimeout(400);
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Stop recording" }).click();
  await panel.waitForTimeout(1200);
  md = await preview();
  check(
    "bug report: recording continues across a navigation",
    /Click link "Next page"\n\d\. Page navigated to \/\?from=link\n\d\. Click button "Save changes"/.test(md) &&
      md.includes("await expect(page).toHaveURL("),
    md.match(/## Steps[\s\S]{0,260}/)?.[0],
  );

  await panel.getByRole("button", { name: "Ask AI about it" }).click();
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check("bug report: Ask AI sends the report", t.includes("Fix the reported bug") && t.includes("Bug report included: true"));

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

  // On-page SEO: counters, Open Graph checklist and previews, hreflang, indexability, reports.
  await site.goto(`${base}/seo`);
  await open("Inspect", "SEO");
  await panel.getByText("robots.txt (Googlebot)").waitFor();
  await panel.waitForTimeout(800);
  t = await text();
  check(
    "seo: counters strip (issues, words, headings, images with missing alt, internal · external links)",
    /Issues\s*\d+/.test(t) &&
      /Words\s*\d+/.test(t) &&
      /Headings\s*3\b/.test(t) &&
      /Images\s*3\s*1 ✕ alt/.test(t) &&
      /Links\s*4\s*3 · 1/.test(t),
    t.match(/Issues[\s\S]{0,120}/)?.[0]?.replace(/\s+/g, " "),
  );
  check(
    "seo: issues list missing alt, og: tags written with name=, Open Graph extras and x-default",
    t.includes("1 of 3 images has no alt text.") &&
      t.includes('og:description use name="…"') &&
      t.includes("Open Graph could still add: og:locale, og:image:alt.") &&
      t.includes("No x-default entry — it is the fallback for languages you do not target."),
  );
  check("seo: meta lengths shown against their limits", /Title\s*58\/60/.test(t) && /Meta description\s*148\/160/.test(t));
  check(
    "seo: Open Graph checklist with essential, recommended and Twitter fallbacks",
    t.includes("Social (Open Graph / Twitter) · 5/5") &&
      /og:image:alt\s*missing/.test(t) &&
      /twitter:title\s*fallback from og:title: Acme Mug guide/.test(t) &&
      /twitter:card\s*summary_large_image/.test(t),
  );
  check(
    "seo: hreflang table with this page, de_AT, en-UK, relative URL and the return-links note",
    t.includes("hreflang (4)") &&
      t.includes("this page") &&
      t.includes("Use a hyphen, not an underscore: de-AT.") &&
      t.includes('"UK" is not a country code: use en-GB.') &&
      t.includes("Relative URL: Google needs a fully qualified URL") &&
      t.includes("Return links from the other language versions can only be verified"),
  );
  check(
    "seo: images and links stats",
    /Missing alt\s*1/.test(t) &&
      /Without title\s*2/.test(t) &&
      /Internal\s*3/.test(t) &&
      /External\s*1/.test(t) &&
      /Unique\s*3/.test(t) &&
      /Nofollow\s*1/.test(t),
  );
  check(
    "seo: indexability from meta robots, robots.txt for Googlebot and HTTP status",
    /Indexability\s*index, follow/.test(t) && /robots.txt \(Googlebot\)\s*Allowed/.test(t) && /HTTP status\s*200/.test(t),
  );
  const ogHits = async () => Number(await (await fetch(`${base}/og-hits`)).text());
  check("seo: the share image is not requested before Load preview image", (await ogHits()) === 0);
  await panel.getByRole("button", { name: "Load preview image" }).click();
  await panel
    .getByText(/800×800 is below 1200×630/)
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  t = await text();
  check(
    "seo: Load preview image measures the file (size, ratio, declared size)",
    (await ogHits()) === 1 &&
      t.includes("800×800 is below 1200×630") &&
      t.includes("Aspect ratio 1.00:1") &&
      t.includes("og:image:width/height say 1200×630, the file is 800×800."),
  );
  await panel.locator('fieldset[aria-label="Preview"] button', { hasText: "X (Twitter)" }).click();
  await panel.waitForTimeout(200);
  check("seo: X preview uses the large card at 2:1", (await text()).includes("Image ratio 2:1 · large image"));
  await shot("inspect-seo");
  await panel.locator('fieldset[aria-label="Preview"] button', { hasText: "LinkedIn" }).click();
  await panel.locator("summary", { hasText: "All headings" }).click();
  await panel.getByLabel("Search headings").fill("second");
  await panel.waitForTimeout(200);
  const headingItems = await panel.locator(".seo-headings li").allInnerTexts();
  check(
    "seo: heading search filters the list",
    headingItems.length === 1 && headingItems[0].includes("Second thoughts"),
    headingItems.join(" | "),
  );
  const seoReportText = await lastCopy(panel.getByRole("button", { name: "Copy report" }).first());
  check(
    "seo: Copy report gives a readable summary of every section",
    seoReportText.startsWith("# SEO report: Acme Mug guide") &&
      seoReportText.includes("## Social (Open Graph / Twitter) · 5/5") &&
      seoReportText.includes("## hreflang (4)") &&
      seoReportText.includes("- robots.txt (Googlebot): Allowed"),
    seoReportText.split("\n")[2],
  );
  await site.goto(`${base}/`);
  await open("Security", "Headers");
  await panel.getByLabel("Search headers").waitFor();
  await panel.getByLabel("Search headers").fill("express");
  await panel.waitForTimeout(200);
  t = await text();
  check(
    "headers: search filters the response headers by value",
    /Response headers \(\d+\)/.test(t) && /\n1 of \d+ match/.test(t) && t.includes("x-powered-by") && !t.includes("speculation-rules"),
  );
  const headersReport = await lastCopy(panel.getByRole("button", { name: "Copy report" }));
  check(
    "headers: Copy report lists the checks and every header",
    headersReport.includes("## Security headers") && headersReport.includes("x-powered-by: Express/4.18.2"),
  );
  await open("Inspect", "Open in external tools");
  t = await text();
  check(
    "external: tools grouped, with GTmetrix, W3C CSS, WAVE, Facebook, LinkedIn, Ahrefs, Sistrix and WHOIS",
    ["Structured data", "Performance", "Validation", "Social", "SEO & domain", "Security"].every((g) => t.includes(g)) &&
      [
        "GTmetrix",
        "W3C CSS validator",
        "WAVE accessibility",
        "Facebook Sharing Debugger",
        "LinkedIn Post Inspector",
        "Ahrefs Site Explorer",
        "Sistrix Visibility Index",
        "WHOIS",
      ].every((n) => t.includes(n)),
  );
  const waveHref = await panel.locator("a.action", { hasText: "WAVE accessibility" }).getAttribute("href");
  check("external: WAVE gets the page URL", waveHref === `https://wave.webaim.org/report#/${base}/`, waveHref);
  await context.addInitScript(() => {
    window.print = () => {
      window.__printed = true;
    };
  });
  await open("Inspect", "Overview");
  await panel.waitForTimeout(1500);
  const [printTab] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }),
    panel.getByRole("button", { name: "Print / Save as PDF" }).click(),
  ]);
  await printTab
    .locator(".print-report h1")
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  await printTab.waitForTimeout(800);
  const printText = await printTab
    .locator("body")
    .innerText()
    .catch(() => "");
  check(
    "overview: Print / Save as PDF opens a print-ready report page and prints it",
    printTab.url() === `chrome-extension://${id}/print.html` &&
      printText.includes("Page report: Acme Mug") &&
      printText.includes("nothing was uploaded") &&
      (await printTab.locator(".print-report table").count()) > 0 &&
      (await printTab.evaluate(() => window.__printed === true)),
    printText.split("\n").slice(0, 2).join(" / "),
  );
  await printTab.close();

  // Headings: a page with every heading problem.
  await site.goto(`${base}/headings`);
  await panel.waitForTimeout(800);
  await open("Inspect", "Headings & landmarks");
  await panel
    .locator(".hd-tree")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  t = await text();
  check(
    "headings: issues found (before h1, skipped, empty, role without level, duplicate, aria-hidden)",
    [
      "Headings before the h1",
      "Skipped level: h2 → h4",
      "Empty h2",
      'role="heading" without aria-level',
      "Same h2 2 times",
      "Visible h2 hidden from screen readers",
    ].every((s) => t.includes(s)),
    t.match(/\d+ to fix[^\n]*/)?.[0],
  );
  check(
    "headings: verdict and per-level counts",
    t.includes("1 to fix, 5 to review") && t.includes("announced by screen readers"),
    t.match(/\d+ to fix[^\n]*/)?.[0],
  );
  check("headings: the tree shows the skipped level as a gap", t.includes("h3 missing"));
  check(
    "headings: hidden ones left out until asked, sr-only shown",
    !t.includes("Hidden heading") && t.includes("Screen reader heading") && t.includes("screen readers only"),
  );
  await panel.getByLabel("Hidden ones").check();
  await panel.waitForTimeout(200);
  t = await text();
  check("headings: hidden ones on demand", t.includes("Hidden heading") && t.includes("Decorative heading"));
  await panel.getByLabel("Hidden ones").uncheck();
  await panel.getByLabel("Issues only").check();
  await panel.waitForTimeout(200);
  t = await text();
  check("headings: issues only filter", t.includes("Skipped level") && !/\bh2\s*Details\b/.test(t));
  await panel.getByLabel("Issues only").uncheck();

  await panel.locator(".hd-main", { hasText: "Bottom of the page" }).click();
  await panel.waitForTimeout(400);
  const focused = await site.evaluate(() => {
    const host = document.querySelector("devkit-headings-focus");
    const r = [...document.querySelectorAll("h2")].find((x) => x.textContent === "Bottom of the page").getBoundingClientRect();
    return Boolean(host) && r.top >= 0 && r.bottom <= innerHeight;
  });
  check("headings: clicking a heading scrolls to it and outlines it", focused);
  await site.keyboard.press("Escape");
  await panel.waitForTimeout(200);
  check(
    "headings: the outline goes away on the next key",
    !(await site.evaluate(() => Boolean(document.querySelector("devkit-headings-focus")))),
  );

  await panel.getByRole("button", { name: "Badges in page" }).click();
  await panel.waitForTimeout(500);
  check("headings: badges drawn in the page", await site.evaluate(() => Boolean(document.querySelector("devkit-headings"))));
  await shot("inspect-headings");
  await panel.getByRole("button", { name: "Hide badges" }).click();
  await panel.waitForTimeout(400);
  check("headings: badges removed", !(await site.evaluate(() => Boolean(document.querySelector("devkit-headings")))));
  await panel.getByRole("button", { name: "Badges in page" }).click();
  await panel.waitForTimeout(400);
  await open("Inspect", "Overview");
  await panel.waitForTimeout(400);
  check("headings: leaving the panel removes the badges", !(await site.evaluate(() => Boolean(document.querySelector("devkit-headings")))));

  await open("Inspect", "Headings & landmarks");
  await panel
    .locator(".hd-tree")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check("headings: page map has a tick per visible heading", (await panel.locator(".hd-tick").count()) >= 8);
  await panel.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (s) => {
      window.__copied.push(s);
    };
  });
  const tocMd = await lastCopy(panel.getByRole("button", { name: "Copy Markdown" }));
  check(
    "headings: table of contents as Markdown, ids kept and proposed",
    tocMd.startsWith("- [Acme shop](#acme-shop)\n- [Acme Mug guide](#top)\n  - [Details](#details)") &&
      tocMd.includes("(#faq-2)") &&
      !tocMd.includes("Hidden heading"),
    tocMd.split("\n").slice(0, 3).join(" | "),
  );
  const tocHtmlCopy = await lastCopy(panel.getByRole("button", { name: "Copy HTML" }));
  check(
    "headings: table of contents as HTML",
    tocHtmlCopy.startsWith('<nav aria-label="Table of contents">') && tocHtmlCopy.includes('<a href="#top">'),
  );
  const headingsMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check(
    "headings: Copy for agent with selectors and fixes",
    headingsMd.startsWith("## Headings outline") &&
      headingsMd.includes("Result: 1 problem, 5 warnings") &&
      headingsMd.includes("Fix: Change it to an `<h3>`") &&
      headingsMd.includes("### Outline"),
    headingsMd.split("\n")[2],
  );

  await panel.getByRole("button", { name: "Review the outline" }).click();
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check(
    "headings: Ask AI sends the outline with section text",
    t.includes("Review the heading outline") && t.includes("Headings section: true") && t.includes("Section text sent: true"),
    t.match(/Headings section[^\n]*/)?.[0],
  );
  await open("Inspect", "Headings & landmarks");
  await panel
    .locator(".hd-tree")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  await panel.getByRole("button", { name: "Ask AI about Skipped level" }).click();
  await panel.waitForSelector(".msg.assistant .markdown", { timeout: 15_000 }).catch(() => undefined);
  await panel.waitForTimeout(1200);
  t = await text();
  check(
    "headings: per-heading Ask AI sends the heading in focus",
    t.includes("Fix this heading") && t.includes("Heading in focus: Skipped level"),
  );

  // Landmarks: GitHub's structure, in the Landmarks and All views of the same panel.
  await site.goto(`${base}/landmarks`);
  await panel.waitForTimeout(800);
  await open("Inspect", "Headings & landmarks");
  await panel
    .locator(".hd-tree")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  const viewChip = (name) => panel.locator(".hd-views button", { hasText: name });
  await viewChip("Landmarks").click();
  await panel
    .locator(".hd-role")
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  // The tree as text: one line per row, 4 spaces per level, "name [role]" as HeadingsMap shows it.
  const lmTree = await panel.evaluate(() => {
    const lines = [];
    const walk = (ul, depth) => {
      for (const li of ul.children) {
        const role = li.querySelector(":scope > .hd-line .hd-role")?.textContent;
        if (role) {
          const name = li.querySelector(":scope > .hd-line .hd-text")?.textContent;
          lines.push(`${"    ".repeat(depth)}${name === "unnamed" ? role : name} [${role}]`);
        }
        const sub = li.querySelector(":scope > ul.hd-tree");
        if (sub) walk(sub, depth + 1);
      }
    };
    const root = document.querySelector("main ul.hd-tree");
    if (root) walk(root, 0);
    return lines.join("\n");
  });
  check(
    "landmarks: the Landmarks view lists GitHub's landmarks as HeadingsMap does",
    lmTree ===
      [
        "Global navigation menu [banner]",
        "    Breadcrumbs [navigation]",
        "    Repository [navigation]",
        "main [main]",
        "    Your main branch isn't protected [region]",
        "    Repository files [navigation]",
        "contentinfo [contentinfo]",
        "    Footer [navigation]",
      ].join("\n"),
    lmTree.replace(/\n/g, " | "),
  );
  t = await text();
  check(
    "landmarks: the heading outside every landmark is noted",
    t.includes("1 heading outside landmarks") && t.includes("8 landmarks"),
    t.match(/\d+ landmarks?[^\n]*/)?.[0],
  );
  await shot("inspect-landmarks");
  await panel.locator(".hd-main", { hasText: "Breadcrumbs" }).click();
  await panel.waitForTimeout(400);
  check(
    "landmarks: clicking a landmark outlines it in the page",
    await site.evaluate(() => Boolean(document.querySelector("devkit-headings-focus"))),
  );
  await site.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Badges in page" }).click();
  await panel.waitForTimeout(500);
  check("landmarks: badges drawn on the landmarks", await site.evaluate(() => Boolean(document.querySelector("devkit-headings"))));
  await panel.getByRole("button", { name: "Hide badges" }).click();
  await viewChip("All").click();
  await panel.waitForTimeout(300);
  // The tree alone: the table of contents and the page map below repeat heading texts.
  const treeText = () => panel.locator("main ul.hd-tree").first().innerText();
  t = await treeText();
  check(
    "landmarks: All nests the headings under their landmark, the rest outside",
    t.includes("Folders and files") && t.includes("Outside landmarks") && t.includes("Skip to content") && t.includes("Breadcrumbs"),
  );
  await panel.getByRole("button", { name: "Collapse all" }).click();
  await panel.waitForTimeout(200);
  t = await treeText();
  const folded = !t.includes("Breadcrumbs") && !t.includes("Folders and files") && t.includes("Global navigation menu");
  await panel.getByRole("button", { name: "Expand all" }).click();
  await panel.waitForTimeout(200);
  t = await treeText();
  await shot("inspect-landmarks-all");
  check("landmarks: Collapse all and Expand all", folded && t.includes("Breadcrumbs") && t.includes("Folders and files"));
  await panel.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (s) => {
      window.__copied.push(s);
    };
  });
  const lmMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check(
    "landmarks: Copy for agent has the landmarks",
    lmMd.includes("### Landmarks") && lmMd.includes("    Breadcrumbs [navigation] (") && lmMd.includes("8 ARIA landmarks"),
    lmMd.slice(0, 200),
  );
  await open("Inspect", "Overview");
  await open("Inspect", "Headings & landmarks");
  await panel
    .locator(".hd-views")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  check("landmarks: the chosen view is kept", (await viewChip("All").getAttribute("aria-pressed")) === "true");
  await viewChip("Headings").click();

  // Repo dependencies: a GitHub-like folder served locally (the page's meta tags say GitHub), registries faked.
  await context.route("https://registry.npmjs.org/**", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1).replace(/\/latest$/, ""));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ name, version: "9.9.9", description: `E2E description of ${name}` }),
    });
  });
  await context.route("https://pypi.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ info: { summary: "E2E PyPI summary", version: "3.1.0" } }),
    }),
  );
  await site.goto(`${base}/acme/shop/tree/main/web`);
  await open("Inspect", "Repo dependencies");
  await panel
    .locator(".rd-row")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  await panel
    .locator(".rd-desc", { hasText: "E2E description of react" })
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  t = await text();
  check(
    "repo deps: the folder's package.json and requirements.txt, by kind, with versions",
    t.includes("acme/shop/web") &&
      t.includes("web/package.json") &&
      t.includes("web/requirements.txt") &&
      /Dependencies \(2\)[\s\S]*react[\s\S]*\^19\.0\.0/.test(t) &&
      /Development dependencies \(1\)[\s\S]*vitest/.test(t) &&
      /flask\s*==3\.0\.3/.test(t) &&
      t.includes("extras: socks"),
    t.match(/Repo dependencies[^\n]*/)?.[0],
  );
  check(
    "repo deps: descriptions and latest versions from the registries",
    t.includes("E2E description of react") && t.includes("E2E description of @tanstack/react-query") && t.includes("latest 9.9.9"),
  );
  check("repo deps: an unreadable manifest is reported", /Could not read\s*web\/Gemfile\s*\(needs a signed-in session/.test(t));
  const scoped = await panel.locator(".rd-row", { hasText: "@tanstack/react-query" }).first();
  const scopedLinks = await scoped.locator("a").evaluateAll((as) => as.map((a) => a.href));
  check(
    "repo deps: npm links encode scoped names",
    scopedLinks.includes("https://www.npmjs.com/package/@tanstack/react-query") &&
      scopedLinks.includes("https://packagephobia.com/result?p=%40tanstack%2Freact-query") &&
      scopedLinks.includes("https://unpkg.com/@tanstack/react-query/"),
    scopedLinks.join(" "),
  );
  check(
    "repo deps: the manifest links to its file",
    (await panel.locator(".section h2 a", { hasText: "web/package.json" }).getAttribute("href")) ===
      `${base}/acme/shop/blob/main/web/package.json`,
  );
  await panel.getByPlaceholder("Filter by name, group or description").fill("flask");
  t = await text();
  check("repo deps: the filter keeps matching packages only", t.includes("flask") && !t.includes("vitest") && t.includes("1 of 2"));
  await panel.getByPlaceholder("Filter by name, group or description").fill("");
  const depsMd = await lastCopy(panel.getByRole("button", { name: "Copy as Markdown" }));
  check(
    "repo deps: Copy as Markdown lists packages with links and descriptions",
    depsMd.startsWith("## Dependencies of acme/shop/web at main") &&
      depsMd.includes("- [react](https://www.npmjs.com/package/react) `^19.0.0` — E2E description of react (latest 9.9.9)") &&
      depsMd.includes("### [web/requirements.txt]"),
    depsMd.split("\n")[0],
  );
  await shot("inspect-repo-deps");

  // The in-page box: turned on from the panel (registers the content script), run on the fake page.
  await panel.getByRole("button", { name: "Turn on" }).click();
  await panel.waitForTimeout(500);
  const registeredBox = await sw.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts({ ids: ["devkit-repo-deps"] })).map((s) => s.matches),
  );
  check(
    "repo deps box: turning it on registers the content script for github.com and gitlab.com only",
    JSON.stringify(registeredBox) === JSON.stringify([["https://github.com/*", "https://gitlab.com/*"]]),
    JSON.stringify(registeredBox),
  );
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content-scripts/repo-deps.js"] }), tabId);
  await site
    .waitForFunction(() => document.querySelector("devkit-repo-deps")?.shadowRoot?.textContent?.includes("react"), null, { timeout: 8000 })
    .catch(() => undefined);
  const box = await site.evaluate(() => {
    const host = document.querySelector("devkit-repo-deps");
    return { text: host?.shadowRoot?.textContent ?? "", after: host?.previousElementSibling?.id ?? "" };
  });
  check(
    "repo deps box: injected below the README with the folder's packages",
    box.after === "readme-box" && box.text.includes("Dependencies") && box.text.includes("web/package.json") && box.text.includes("flask"),
    `after #${box.after}`,
  );
  // The panel's lookups are cached in storage.session: the background answers the box from there.
  await site
    .waitForFunction(
      () => document.querySelector("devkit-repo-deps")?.shadowRoot?.textContent?.includes("E2E description of react"),
      null,
      {
        timeout: 8000,
      },
    )
    .catch(() => undefined);
  check(
    "repo deps box: descriptions come through the background",
    (await site.evaluate(() => document.querySelector("devkit-repo-deps")?.shadowRoot?.textContent ?? "")).includes(
      "E2E description of react",
    ),
  );
  // In-app navigation: the URL changes and the page re-renders without a reload.
  await site.evaluate(async () => {
    const html = await (await fetch("/acme/shop")).text();
    history.pushState({}, "", "/acme/shop");
    document.querySelector("main").replaceWith(new DOMParser().parseFromString(html, "text/html").querySelector("main"));
  });
  await site
    .waitForFunction(() => document.querySelector("devkit-repo-deps")?.shadowRoot?.textContent?.includes("express"), null, {
      timeout: 8000,
    })
    .catch(() => undefined);
  const rootBox = await site.evaluate(() => document.querySelector("devkit-repo-deps")?.shadowRoot?.textContent ?? "");
  check(
    "repo deps box: follows in-app navigation to the repository root",
    rootBox.includes("express") && !rootBox.includes("vitest") && rootBox.includes("Workspaces"),
  );
  await panel.getByRole("button", { name: "Turn off" }).click();
  await panel.waitForTimeout(400);
  check(
    "repo deps box: turning it off unregisters the content script",
    (await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ["devkit-repo-deps"] })).length)) === 0,
  );

  await site.goto(`${base}/`);
  await panel.waitForTimeout(800);
  t = await text();
  check("repo deps: explains itself off repository pages", t.includes("Open a repository or folder page on GitHub or GitLab"));

  // dataLayer: GA4 events, Consent Mode, PII, JSON-LD cross-check and snapshots on a shop page.
  await site.goto(`${base}/datalayer`);
  await panel.waitForTimeout(800);
  await open("Inspect", "dataLayer inspector");
  await panel
    .locator(".dl-counters")
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  const counters = (
    await panel
      .locator(".dl-counters")
      .innerText()
      .catch(() => "")
  ).replace(/\s+/g, " ");
  check(
    "datalayer: counters (issues, events, unique, layers, consent, containers)",
    counters.includes("Issues 6") &&
      counters.includes("Events 3") &&
      counters.includes("Unique events 3") &&
      counters.includes("Layers 8") &&
      counters.includes("Consent 2") &&
      counters.includes("Containers 2"),
    counters,
  );
  t = await text();
  check(
    "datalayer: GA4, Consent Mode v2, PII and JSON-LD issues",
    [
      "purchase without transaction_id",
      "value is not numeric",
      "Consent Mode v2: ad_user_data and ad_personalization missing",
      "E-mail address in the dataLayer",
      "SKU differs from the Product markup",
      "Price differs from the Product markup",
    ].every((s) => t.includes(s)),
    t.match(/Issues \(\d+\)[^\n]*/)?.[0],
  );
  check("datalayer: PII reported by path, never by value", t.includes("dataLayer[7].user.email") && !t.includes("jane.doe@example.com"));
  check(
    "datalayer: containers and consent timeline",
    t.includes("GTM-E2E1234") && t.includes("G-E2E5678") && t.includes("ad_storage: denied"),
  );
  check("datalayer: read-only note", t.includes("events fired later appear after Read again"));
  check(
    "datalayer: the page's dataLayer.push is left alone",
    await site.evaluate(() => window.dataLayer.push === Array.prototype.push && window.dataLayer.length === 8),
  );
  await panel.locator(".dl-event summary", { hasText: "login" }).first().click();
  await panel.waitForTimeout(200);
  t = await text();
  check("datalayer: an event opens as a tree, masked", t.includes("j•••@•••.com") && t.includes("[Function"));
  await shot("inspect-datalayer");
  await panel.getByRole("button", { name: "JSON view" }).click();
  await panel.waitForTimeout(200);
  t = await text();
  check(
    "datalayer: JSON view is masked too",
    t.includes("JSON (masked)") && t.includes("j•••@•••.com") && !t.includes("jane.doe@example.com"),
  );
  await panel.getByRole("button", { name: "JSON view" }).click();
  const dlReport = await lastCopy(panel.getByRole("button", { name: "Copy report" }));
  check(
    "datalayer: Copy report",
    dlReport.startsWith("dataLayer report") && dlReport.includes("Issues: 6") && !dlReport.includes("jane.doe@example.com"),
    dlReport.split("\n")[1],
  );
  const dlMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }));
  check(
    "datalayer: Copy for agent with paths and fixes, PII masked",
    dlMd.startsWith("## dataLayer") &&
      dlMd.includes("Result: 3 problems, 3 warnings") &&
      dlMd.includes("Fix: Add `transaction_id`") &&
      dlMd.includes("Where: `dataLayer[7].user.email`") &&
      !dlMd.includes("jane.doe@example.com"),
    dlMd.split("\n")[2],
  );
  await panel.getByRole("button", { name: "Save snapshot" }).click();
  await panel.waitForTimeout(400);
  t = await text();
  const stored = await sw.evaluate(async () =>
    JSON.stringify((await chrome.storage.local.get("datalayerSnapshots")).datalayerSnapshots ?? []),
  );
  check(
    "datalayer: snapshot saved locally, masked",
    t.includes("Snapshots (1/50)") && stored.includes("j•••@•••.com") && !stored.includes("jane.doe@example.com"),
    t.match(/Snapshots \([^)]*\)/)?.[0],
  );
  await site.evaluate(() => window.dataLayer.push({ event: "late_event", step: 2 }));
  await panel.getByRole("button", { name: "Read again" }).click();
  await panel.waitForTimeout(500);
  check(
    "datalayer: Read again picks up later events",
    (await panel.locator(".dl-counters").innerText()).replace(/\s+/g, " ").includes("Events 4"),
  );
  await panel.getByRole("button", { name: "Compare with current" }).first().click();
  await panel.waitForTimeout(300);
  t = await text();
  check(
    "datalayer: snapshot compared with the current read",
    /1 added · 0 removed · 0 duplicated · 0 changed/.test(t) && t.includes("late_event"),
  );
  await panel
    .getByRole("button", { name: /^Delete the snapshot/ })
    .first()
    .click();
  await panel.waitForTimeout(300);
  check("datalayer: snapshot deleted", (await text()).includes("Snapshots (0/50)"));
  await site.goto(`${base}/headings`);
  await panel.waitForTimeout(1200);
  check("datalayer: empty state without a dataLayer", (await text()).includes("No dataLayer found on this page."));
  await site.goto(`${base}/`);

  // Agent tools (WebMCP): a fake navigator.modelContextTesting with a read-only tool and a Critical one.
  await site.goto(`${base}/agent`);
  await open("Inspect", "Agent tools");
  await panel
    .locator(".wm-tester")
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  t = await text();
  check(
    "agent tools: experimental notice, no document.modelContext, testing API found",
    t.includes("WebMCP is experimental (Chrome origin trial)") &&
      t.includes("document.modelContext is not available on this page") &&
      /navigator\.modelContextTesting\s*available · listTools, executeTool/.test(t),
  );
  check("agent tools: both tools listed with their risk", /get_store_hours\s*Low\b/.test(t) && /delete_account\s*Critical\b/.test(t));
  const toolCard = (name) =>
    panel
      .locator(".section", { has: panel.locator(".wm-tester") })
      .filter({ hasText: name })
      .first();
  const hours = toolCard("get_store_hours");
  await hours.locator("select").selectOption("sunday");
  await hours.getByRole("button", { name: "Run", exact: true }).click();
  await hours
    .getByText('"close": "13:00"')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check("agent tools: a Low tool runs on one click and shows its result", (await hours.innerText()).includes('"close": "13:00"'));
  const del = toolCard("delete_account");
  t = await del.innerText();
  check(
    "agent tools: Critical tool blocked by default, with its findings",
    t.includes("Blocked.") &&
      (await del.getByRole("button", { name: /^Run/ }).count()) === 0 &&
      t.includes("No annotations on a sensitive tool") &&
      !(await site.evaluate(() => Boolean(window.__accountDeleted))),
  );
  await del.getByText("Allow critical tools on this site for this session").click();
  await del
    .locator("input[type=checkbox]")
    .first()
    .waitFor({ timeout: 2000 })
    .catch(() => undefined);
  await del.getByRole("checkbox", { name: "confirm" }).check();
  await del.getByRole("button", { name: "Run…" }).click();
  await del.getByRole("button", { name: "Continue" }).click();
  const finalRun = del.getByRole("button", { name: "Run delete_account" });
  const disabledFirst = await finalRun.isDisabled();
  await del.getByLabel("Tool name to confirm").fill("delete_acc");
  const disabledTypo = await finalRun.isDisabled();
  await del.getByLabel("Tool name to confirm").fill("delete_account");
  const enabled = !(await finalRun.isDisabled());
  const notYet = !(await site.evaluate(() => Boolean(window.__accountDeleted)));
  await finalRun.click();
  await del
    .getByText('"deleted": true')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check(
    "agent tools: allowed Critical tool needs two steps, the second typing its name",
    disabledFirst && disabledTypo && enabled && notYet && (await site.evaluate(() => window.__accountDeleted === true)),
    JSON.stringify({ disabledFirst, disabledTypo, enabled, notYet }),
  );
  t = await text();
  check("agent tools: run history kept for the site", /Run history \(2\)/.test(t));
  await del.getByText("Allow critical tools on this site for this session").click();
  await shot("inspect-agent-tools");

  // Agent readiness on the same page: /llms.txt served, robots.txt blocks GPTBot, an Organization node.
  await open("Inspect", "Agent readiness");
  await panel
    .locator(".ar-score")
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  await panel.waitForTimeout(500);
  t = await text();
  check(
    "readiness: score and breakdown",
    /84\s*\/ 100/.test(t) &&
      /Structured data\s*22\/25/.test(t) &&
      /Agent tool availability\s*12\/15/.test(t) &&
      /Safety\s*5\/15/.test(t) &&
      /Testability\s*10\/10/.test(t) &&
      t.includes("not a guarantee of compatibility"),
    t.match(/\d+\s*\/ 100/)?.[0],
  );
  check(
    "readiness: llms.txt found, sitemap found, GPTBot blocked",
    /llms\.txt\s*Found · \d+ bytes · “Acme”/.test(t) &&
      t.includes("Open sitemap") &&
      t.includes("15 allowed · 1 blocked") &&
      /GPTBot OpenAI\s*Training\s*blocked/.test(t),
  );
  check(
    "readiness: recommendations by impact",
    t.includes("High impact") && t.includes("Mark delete_account with consequentialHint") && t.includes("1 AI crawler(s) are disallowed"),
  );
  await panel.locator(".ar-area", { hasText: "Safety" }).click();
  t = await text();
  check(
    "readiness: tapping an area shows its rules",
    t.includes("No Critical tool without a consequential/destructive hint") && t.includes("How to improve"),
  );
  const readinessMd = await lastCopy(panel.getByRole("button", { name: "Copy for agent" }).first());
  check("readiness: Copy for agent", readinessMd.startsWith("## Agent readiness") && readinessMd.includes("84/100"));
  await shot("inspect-agent-readiness");
  await site.goto(`${base}/`);

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
  await popup.getByLabel("Search commands").fill("bug report");
  const reportItems = await popup.getByRole("option").allInnerTexts();
  check(
    "palette finds the bug report panel and its copy action",
    reportItems.some((r) => r.startsWith("Copy a bug report")) && reportItems.some((r) => r.startsWith("Bug report")),
    reportItems.map((r) => r.split("\n")[0]).join(" | "),
  );
  await popup.getByLabel("Search commands").fill("measure");
  const measureFirst = await popup.getByRole("option").first().innerText();
  check("palette finds the spacing ruler", /Measure distances/.test(measureFirst), measureFirst.split("\n")[0]);
  await popup.getByLabel("Search commands").fill("yt-dlp");
  const cookiesTxtFirst = await popup.getByRole("option").first().innerText();
  check("palette finds Copy cookies.txt", /Copy cookies\.txt/.test(cookiesTxtFirst), cookiesTxtFirst.split("\n")[0]);
  await popup.getByLabel("Search commands").fill("consent mode");
  const dlItems = await popup.getByRole("option").allInnerTexts();
  check(
    "palette finds the dataLayer inspector",
    dlItems.some((r) => r.startsWith("dataLayer inspector")),
    dlItems
      .slice(0, 3)
      .map((r) => r.split("\n")[0])
      .join(" | "),
  );
  await popup.getByLabel("Search commands").fill("hn");
  const hnItems = await popup.getByRole("option").allInnerTexts();
  check(
    "palette finds the headings outline",
    hnItems.some((r) => r.startsWith("Headings & landmarks")),
    hnItems
      .slice(0, 3)
      .map((r) => r.split("\n")[0])
      .join(" | "),
  );
  await popup.getByLabel("Search commands").fill("webmcp");
  const webmcpFirst = await popup.getByRole("option").first().innerText();
  await popup.getByLabel("Search commands").fill("llms.txt");
  const llmsFirst = await popup.getByRole("option").first().innerText();
  check(
    "palette finds the agent tools and agent readiness panels",
    /Agent tools/.test(webmcpFirst) && /Agent readiness/.test(llmsFirst),
    `${webmcpFirst.split("\n")[0]} | ${llmsFirst.split("\n")[0]}`,
  );

  // JSON page viewer, on demand: the palette action formats the pinned tab.
  const jsonTab = await context.newPage();
  const tabOf = (u) => sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, u);
  const viewer = (p) => p.locator("#devkit-json-viewer");
  const runFormat = async (tab) => {
    const pal = await context.newPage();
    pal.on("pageerror", (e) => extErrors.push(`palette pageerror: ${e.message}`));
    await pal.goto(`chrome-extension://${id}/popup.html?tab=${tab}`);
    await pal.getByLabel("Search commands").fill("json formatter");
    const items = await pal.getByRole("option").allInnerTexts();
    await pal.getByRole("option").filter({ hasText: "Format this data page" }).first().click();
    const toastText = await pal
      .locator(".toast")
      .first()
      .innerText({ timeout: 4000 })
      .catch(() => "");
    await pal.close().catch(() => undefined);
    return { items, toast: toastText };
  };
  await jsonTab.goto(`${base}/api/posts/1`);
  check(
    "json viewer: off by default, the page stays as Chrome shows it",
    (await viewer(jsonTab).count()) === 0 && (await jsonTab.locator("pre").count()) === 1,
  );
  let fmt = await runFormat(await tabOf(`${base}/api/posts/1`));
  check(
    "palette finds Format this data page",
    fmt.items.some((r) => r.startsWith("Format this data page")),
    fmt.items.map((r) => r.split("\n")[0]).join(" | "),
  );
  check("json viewer: the palette action formats the tab", fmt.toast === "JSON formatted.", fmt.toast);
  await viewer(jsonTab)
    .locator(".node[data-path='$.author.address.city']")
    .waitFor({ timeout: 4000 })
    .catch(() => undefined);
  check(
    "json viewer: tree with counts, colors and links",
    (await viewer(jsonTab).locator(".node[data-path='$'] > .line .count").innerText()) === "{6}" &&
      (await viewer(jsonTab).locator(".node[data-path='$.tags'] > .line .count").innerText()) === "[3]" &&
      (await viewer(jsonTab).locator(".node[data-path='$.author.address.city'] .s").innerText()) === '"London"' &&
      (await viewer(jsonTab).locator(".node[data-path='$.link'] a").getAttribute("href")) === `${base}/ok`,
  );
  await viewer(jsonTab).getByRole("button", { name: "Collapse all" }).click();
  const authorToggle = viewer(jsonTab).locator(".node[data-path='$.author'] > .line .tog");
  const collapsed = await authorToggle.getAttribute("aria-expanded");
  await authorToggle.click();
  check("json viewer: toggles collapse and expand", collapsed === "false" && (await authorToggle.getAttribute("aria-expanded")) === "true");
  await viewer(jsonTab).getByLabel("Filter keys and values").fill("london");
  await jsonTab.waitForTimeout(400);
  check(
    "json viewer: filter keeps the matches and their parents",
    (await viewer(jsonTab).locator(".node.hit[data-path='$.author.address.city']").count()) === 1 &&
      (await viewer(jsonTab).locator(".node[data-path='$.title']").count()) === 0,
  );
  fmt = await runFormat(await tabOf(`${base}/api/posts/1`));
  check("json viewer: running it twice keeps one viewer", (await viewer(jsonTab).count()) === 1, fmt.toast);
  if (shots) await jsonTab.screenshot({ path: join(shots, "json-viewer.png") });
  await jsonTab.goto(`${base}/api/plain`);
  fmt = await runFormat(await tabOf(`${base}/api/plain`));
  check(
    "json viewer: the palette action also formats JSON served as text/plain",
    fmt.toast === "JSON formatted." && (await viewer(jsonTab).locator(".node[data-path='$.items']").count()) === 1,
    fmt.toast,
  );
  await jsonTab.goto(`${base}/`);
  fmt = await runFormat(await tabOf(`${base}/`));
  check(
    "json viewer: leaves HTML pages alone",
    /not a data document \(text\/html\)/.test(fmt.toast) && (await viewer(jsonTab).count()) === 0,
    fmt.toast,
  );

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

  // JSON page viewer, automatic: the Options toggle registers the content script.
  const jsonSection = options.locator("section", { hasText: "Format data pages" }).last();
  await jsonSection.getByRole("button", { name: "Turn on" }).click();
  await options.waitForTimeout(400);
  const registered = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  check(
    "json viewer: Options turns on Format data pages",
    registered.includes("devkit-json-viewer") && (await jsonSection.innerText()).includes("Format data pages (JSON, XML, CSV, YAML): On"),
    registered.join(", "),
  );
  await jsonTab.goto(`${base}/api/posts/1`);
  await viewer(jsonTab)
    .locator(".node[data-path='$.author']")
    .waitFor({ timeout: 4000 })
    .catch(() => undefined);
  check(
    "json viewer: JSON pages open formatted",
    (await viewer(jsonTab).locator(".node[data-path='$.author.name'] .s").count()) === 1 &&
      (await jsonTab.locator("pre").first().isHidden()),
  );
  await jsonTab.goto(`${base}/api/broken`);
  const brokenBanner = await viewer(jsonTab)
    .locator(".banner.error")
    .innerText({ timeout: 4000 })
    .catch(() => "");
  check(
    "json viewer: invalid JSON shows the raw text and where it breaks",
    brokenBanner.startsWith("Invalid JSON at line 3, column 8") && (await viewer(jsonTab).locator(".raw").innerText()).includes('"b": }'),
    brokenBanner,
  );
  await jsonTab.goto(`${base}/`);
  check("json viewer: HTML pages are left alone", (await viewer(jsonTab).count()) === 0);

  // ---- Data page viewer: XML, RSS, CSV, YAML and JSON Lines (issue #27), with Options › Data page viewer on ----
  await checkDataFormats(jsonTab, viewer, runFormat, tabOf);
  // ---- end of the data page viewer block ----
  await jsonSection.getByRole("button", { name: "Turn off" }).click();
  await options.waitForTimeout(400);
  const afterOff = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  check("json viewer: Options turns it off", !afterOff.includes("devkit-json-viewer"), afterOff.join(", "));
  await jsonTab.close();

  check("no errors in extension pages", extErrors.length === 0, extErrors.slice(0, 5).join(" | "));

  /**
   * The data page viewer on each format, while the Options toggle is on (the gate script asks the
   * background to inject the viewer), plus the palette action on XML served as text/plain.
   */
  async function checkDataFormats(page, viewer, runFormat, tabOf) {
    const v = viewer(page);
    const open = async (path, ready) => {
      await page.goto(`${base}${path}`);
      await v
        .locator(ready)
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
    };
    const state = async () => ({
      state: await v.getAttribute("data-state").catch(() => null),
      format: await v.getAttribute("data-format").catch(() => null),
    });

    await open("/data/feed.xml", ".feed");
    const feed = await v
      .locator(".feed")
      .innerText()
      .catch(() => "");
    check(
      "data viewer: RSS (shown as text by Chrome) opens with a feed summary and the element tree",
      /RSS feed · 2 items/.test(feed) &&
        feed.includes("Acme blog") &&
        feed.includes("Second post") &&
        (await v.locator(".node[data-path='/rss/channel/item[1]/title']").innerText()) === "<title>First post</title>",
      JSON.stringify(await state()),
    );
    if (shots) await page.screenshot({ path: join(shots, "data-viewer-rss.png") });

    await open("/data/catalog.xml", ".node[data-path='/catalog']");
    const product = await v
      .locator(".node[data-path='/catalog/product[1]'] > .line .tag")
      .first()
      .innerText()
      .catch(() => "");
    check(
      "data viewer: XML from Chrome's XML viewer shows attributes, CDATA and comments",
      (await state()).format === "xml" &&
        product.startsWith('<product id="p1" href=') &&
        (await v.locator(".node[data-path='/catalog/product[1]/notes']").innerText()) === "<notes><![CDATA[Holds <350 ml>]]></notes>" &&
        (await v.locator(".x-comment").first().innerText()) === "<!-- product catalog -->" &&
        (await page.locator("#webkit-xml-viewer-source-xml").isHidden()),
      product,
    );
    await v.getByLabel("Filter tags, attributes and text").fill("cup");
    await page.waitForTimeout(400);
    check(
      "data viewer: XML filter keeps the matches and their parents",
      (await v.locator(".node.hit[data-path='/catalog/product[2]/name']").count()) === 1 &&
        (await v.locator(".node[data-path='/catalog/product[1]']").count()) === 0,
    );

    await open("/data/broken.xml", ".banner.error");
    const xmlError = await v
      .locator(".banner.error")
      .innerText()
      .catch(() => "");
    check("data viewer: invalid XML shows where it breaks", /^Invalid XML at line 2, column \d+/.test(xmlError), xmlError);

    await page.goto(`${base}/data/styled.xml`);
    await page.waitForTimeout(600);
    check("data viewer: XML with an xml-stylesheet is left as styled", (await v.count()) === 0);

    await open("/data/people.csv", "table.grid tbody tr");
    const headers = await v.locator("table.grid thead th").allInnerTexts();
    const firstCells = async () => (await v.locator("table.grid tbody tr td:first-of-type").allInnerTexts()).map((t) => t.trim());
    check(
      "data viewer: CSV opens as a table with a header and quoted fields",
      headers.map((h) => h.trim()).join("|") === "#|name|score|city" &&
        (await v.locator("table.grid tbody tr").count()) === 3 &&
        (await v.locator("table.grid tbody tr").nth(1).innerText()).includes("Paris, France"),
      headers.join("|"),
    );
    await v.locator("thead .sort", { hasText: "score" }).click();
    const sorted = await firstCells();
    await v.getByLabel("Filter rows").fill("london");
    await page.waitForTimeout(400);
    check(
      "data viewer: CSV sorts by column and filters rows",
      sorted.join(",") === "alan,Ada,Grace" && (await v.locator("table.grid tbody tr").count()) === 1,
      sorted.join(","),
    );
    if (shots) await page.screenshot({ path: join(shots, "data-viewer-csv.png") });

    await open("/data/config.yaml", ".node[data-path='$.build.target']");
    check(
      "data viewer: YAML opens as a tree",
      (await state()).format === "yaml" &&
        (await v.locator(".node[data-path='$.features'] > .line .count").innerText()) === "[2]" &&
        (await v.locator(".node[data-path='$.build.target'] .s").innerText()) === '"chrome\\n"' &&
        (await v.locator(".node[data-path='$.version'] .n").innerText()) === "1.2",
    );

    await open("/data/events.jsonl", ".node[data-path='$[2]']");
    check(
      "data viewer: JSON Lines shows one tree per line and flags the invalid one",
      (await v.locator(".node[data-path='$[0]'] > .line .key").innerText()) === "line 1" &&
        (await v.locator(".node.bad[data-path='$[1]'] .err").count()) === 1 &&
        (await v.locator(".banner.error").innerText()).startsWith("Line 2 is not valid JSON"),
    );

    await page.goto(`${base}/data/note`);
    await page.waitForTimeout(500);
    const untouched = (await v.count()) === 0;
    const fmt = await runFormat(await tabOf(`${base}/data/note`));
    await v
      .locator(".node[data-path='/note/to']")
      .waitFor({ timeout: 4000 })
      .catch(() => undefined);
    check(
      "data viewer: XML served as text/plain is formatted only on request",
      untouched && fmt.toast === "XML formatted." && (await v.locator(".node[data-path='/note/to']").count()) === 1,
      fmt.toast,
    );
  }
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
