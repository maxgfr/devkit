// Captures the site's screenshots (site/img/*.webp) from the built extension: real panels, dark scheme, 2x,
// on the synthetic demo page (scripts/site-demo.mjs) or the end-to-end test page. Needs `pnpm build` and cwebp.
// The AI answer needs a real model: set DEVKIT_ANTHROPIC_KEY to recapture panel-ai, otherwise it is kept.
// Usage: node scripts/site-shots.mjs [only,these,names]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const only = process.argv[2]?.split(",");
const want = (name) => !only || only.includes(name);
const KEY = process.env.DEVKIT_ANTHROPIC_KEY ?? "";
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
const work = mkdtempSync(join(tmpdir(), "devkit-site-shots-"));
const pngs = join(work, "png");
mkdirSync(pngs);

// The extension with every optional permission granted up front, so no prompt interrupts the run.
const ext = join(work, "extension");
cpSync(join(root, ".output/chrome-mv3"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.permissions.push(...(manifest.optional_permissions ?? []));
manifest.host_permissions = ["<all_urls>"];
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));

const serve = async (script, ...args) => {
  const child = spawn(process.execPath, [join(root, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((done) => child.stdout.on("data", (d) => done(Number(/listening (\d+)/.exec(String(d))?.[1]))));
  return { child, base: `http://localhost:${port}` };
};
// Port 3000, the address Fig. 1 shows in its browser frame.
const demo = await serve("scripts/site-demo.mjs", "3000");
const e2e = await serve("tests/e2e/server.mjs");

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  channel: "chromium",
  headless: true,
  locale: "en-US",
  colorScheme: "dark",
  // No context-wide viewport emulation: the element picker crops a real tab capture, which must match the
  // page's own viewport. The panels get their 420 px, 2x metrics per page through CDP instead.
  viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--lang=en-US", "--window-size=980,720"],
});
context.setDefaultTimeout(20000);
const written = [];
const cdps = new Map();
const cdp = async (page) => {
  if (!cdps.has(page)) cdps.set(page, await context.newCDPSession(page));
  return cdps.get(page);
};
const metrics = async (page, width, height) =>
  (await cdp(page)).send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
const capture = async (page, name) => {
  const { data } = await (await cdp(page)).send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(pngs, `${name}.png`), Buffer.from(data, "base64"));
};
const geo = {};
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(sw.url()).host;
  await sw.evaluate(
    (local) =>
      chrome.storage.local.set({
        envGroups: [
          {
            id: "g",
            name: "acme-kitchen",
            envs: [
              { label: "local", origin: local, color: "#16a34a", danger: false },
              { label: "staging", origin: "https://staging.acme-kitchen.example", color: "#d97706", danger: false },
              { label: "prod", origin: "https://acme-kitchen.example", color: "#dc2626", danger: true },
            ],
          },
        ],
      }),
    demo.base,
  );

  const site = context.pages()[0] ?? (await context.newPage());
  await site.emulateMedia({ colorScheme: "light" });
  // Grow the window until the page itself is 980 × 720.
  const { windowId } = await (await cdp(site)).send("Browser.getWindowForTarget");
  const inner = await site.evaluate(() => [innerWidth, innerHeight]);
  await (await cdp(site)).send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: 980 + 980 - inner[0], height: 720 + 720 - inner[1] },
  });
  await site.goto(`${demo.base}/mugs/stoneware`);
  await site.waitForTimeout(1500); // let the page seed its storage
  if (want("demo-page")) {
    await metrics(site, 980, 720);
    await capture(site, "demo-page");
    await (await cdp(site)).send("Emulation.clearDeviceMetricsOverride");
    written.push([
      "demo-page",
      "a synthetic demo product page (Acme Kitchen, Stoneware Mug) authored for the devkit site and served locally",
    ]);
  }
  const tabOf = (base) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0].id, base);

  const panel = await context.newPage();
  await panel.emulateMedia({ colorScheme: "dark" });
  await metrics(panel, 420, 900);
  const load = async (base) => {
    await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${await tabOf(base)}`);
    await panel.waitForTimeout(800);
  };
  const open = async (tab, title, wait = 1500) => {
    await panel.getByRole("tab", { name: tab, exact: true }).click();
    await panel.locator(`.subnav button[title^="${title}"]`).first().click();
    await panel.waitForTimeout(wait);
  };
  const shot = async (name, page, h = 900) => {
    await metrics(panel, 420, h);
    await panel.waitForTimeout(400);
    await capture(panel, name);
    written.push([name, page]);
    console.log(name);
  };
  const DEMO = "a synthetic demo product page served locally";
  const E2E = "the end-to-end test page served locally";

  await load(demo.base);
  if (want("panel-jsonld")) {
    await open("Inspect", "Structured data");
    await metrics(panel, 420, 720);
    // Start the view at the block list, just under the sticky header.
    await panel.evaluate(() => {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const list = [...document.querySelectorAll("main *")].find((el) => /^Block #1 · Product/.test(el.textContent?.trim() ?? ""));
      if (list) window.scrollBy(0, list.getBoundingClientRect().top - top - 16);
    });
    await panel.waitForTimeout(300);
    for (const [k, re] of [
      ["price", /must be a plain number/],
      ["desc", /description/i],
    ]) {
      const b = await panel.locator("li, .small, div", { hasText: re }).last().boundingBox();
      geo[`panel-${k}`] = b && { x: Math.round(980 + b.x), y: Math.round(b.y + b.height / 2) };
    }
    for (const sel of ["#price", "#crumbs", "#desc"]) {
      const b = await site.locator(sel).evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const x = r.getBoundingClientRect();
        return { x: x.x, y: x.y, w: x.width, h: x.height };
      });
      geo[sel] = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)]));
    }
    await capture(panel, "panel-jsonld");
    written.push(["panel-jsonld", DEMO]);
  }
  if (want("panel-usage")) {
    await open("Cache", "Storage usage", 3000);
    await shot("panel-usage", DEMO);
  }
  if (want("panel-network")) {
    await open("Network", "Environments");
    await shot("panel-network", DEMO);
  }
  if (want("panel-utils")) {
    await open("Utils", "JSON");
    await panel
      .locator("main textarea")
      .first()
      .fill('{"id": 42, "title": "Stoneware Mug", "price": {"amount": 24.9, "currency": "EUR"}, "tags": ["kitchen", "mug"]}');
    await panel.getByRole("button", { name: "TypeScript" }).click();
    await shot("panel-utils", DEMO);
  }
  if (KEY && want("panel-ai")) {
    await open("AI", "AI settings");
    await panel.waitForFunction(() => !document.querySelector("select option")?.textContent?.includes("Loading"), null, { timeout: 30000 });
    await panel.getByRole("combobox", { name: "Provider" }).selectOption("anthropic");
    await panel.locator('input[type="password"]').fill(KEY);
    await panel.getByRole("button", { name: "Save" }).click();
    await open("AI", "Ask AI", 2500);
    await panel.locator(".action", { hasText: "Review structured data" }).click();
    await panel.waitForFunction(() => document.querySelector(".msg.assistant .row.small.muted, .msg.assistant .notice.bad"), null, {
      timeout: 180000,
    });
    await panel.evaluate(() => window.scrollTo(0, 0));
    await shot("panel-ai", `${DEMO}, answered by a real model`, 1000);
  }

  const test = await context.newPage();
  await test.emulateMedia({ colorScheme: "light" });
  await test.goto(`${e2e.base}/`);
  await test.waitForTimeout(1000);
  await load(e2e.base);
  if (want("panel-overview")) {
    await open("Inspect", "Overview", 3000);
    await shot("panel-overview", E2E);
  }
  if (want("panel-page")) {
    await open("Page", "Element picker");
    await panel.getByRole("button", { name: "Pick an element" }).click();
    await test.bringToFront();
    await test.waitForFunction(() => Boolean(document.querySelector("devkit-picker")), null, { timeout: 5000 });
    await test.hover("#save-btn");
    await test.waitForTimeout(300);
    await test.click("#save-btn");
    await panel.waitForSelector(".el-card", { timeout: 8000 });
    await panel.locator("textarea").first().fill("Save should stay disabled until the form changes.");
    await shot("panel-page", E2E);
  }
  if (want("panel-security")) {
    await open("Security", "Secrets", 3000);
    await shot("panel-security", E2E);
  }
} finally {
  await context.close();
  demo.child.kill();
  e2e.child.kill();
}

const createdAt = new Date().toISOString();
for (const [name, page] of written) {
  const out = join(root, "site/img", `${name}.webp`);
  execFileSync("cwebp", ["-quiet", "-q", "88", join(pngs, `${name}.png`), "-o", out]);
  const prompt =
    name === "demo-page"
      ? `Origin: real screenshot of ${page}, captured with Playwright at 2x by scripts/site-shots.mjs. Not generated.`
      : `Origin: real screenshot of the devkit extension (built from this repo, commit ${commit}), captured with Playwright in Chromium at 2x, dark scheme, on ${page}, by scripts/site-shots.mjs. Not generated.`;
  writeFileSync(`${out}.json`, `${JSON.stringify({ prompt, createdAt }, null, 2)}\n`);
  console.log(`site/img/${name}.webp`);
}
if (Object.keys(geo).length) console.log("Fig. 1 geometry", JSON.stringify(geo));
rmSync(work, { recursive: true, force: true });
