// Renders the Chrome Web Store images (screenshots 1280×800, small promo tile 440×280) into store/
// from the real extension screenshots in site/img. Usage: node scripts/store-assets.mjs
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "store");
mkdirSync(join(out, "screenshots"), { recursive: true });
const site = pathToFileURL(join(root, "site")).href;

const css = `
@font-face { font-family: "Mona Sans"; src: url("${site}/fonts/mona-sans.woff2") format("woff2"); font-weight: 200 900; font-stretch: 75% 125%; }
@font-face { font-family: "JetBrains Mono"; src: url("${site}/fonts/jetbrains-mono-600.woff2") format("woff2"); font-weight: 600; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; }
body { background: #0b0f17; color: #e6edf5; font-family: "Mona Sans", sans-serif; overflow: hidden; display: flex; }
.copy { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 22px; padding: 0 56px 0 72px; }
.kicker { font: 600 15px/1 "JetBrains Mono", monospace; color: #22d3ee; letter-spacing: .04em; text-transform: uppercase; }
h1 { font-size: 54px; line-height: 1.02; font-weight: 800; font-stretch: 112%; letter-spacing: -.02em; }
p { font-size: 21px; line-height: 1.45; color: #9fb0c3; max-width: 30ch; }
kbd { font: 600 17px "JetBrains Mono", monospace; color: #e6edf5; background: #162131; border: 1px solid #2a3a50; border-radius: 6px; padding: 3px 9px; box-shadow: inset 0 -2px 0 #2a3a50; }
.shot { align-self: flex-end; height: 740px; border: 1px solid #23324a; border-bottom: 0; border-radius: 14px 14px 0 0; overflow: hidden; margin-right: 64px; box-shadow: 0 30px 80px rgba(0,0,0,.5); }
.shot img { display: block; width: 420px; }
.pair { display: flex; align-items: flex-end; gap: 0; margin-right: 0; }
.page { height: 600px; width: 640px; overflow: hidden; border: 1px solid #23324a; border-right: 0; border-radius: 14px 0 0 0; }
.page img { width: 816px; }
`;

const shots = [
  {
    file: "1-structured-data.png",
    kicker: "Inspect › Structured data",
    title: "See why Google ignores your JSON-LD",
    text: "Every block parsed and checked: invalid JSON with its line, wrong prices, relative URLs, missing fields.",
    img: "panel-jsonld.webp",
  },
  {
    file: "2-element.png",
    kicker: "Page › Element picker",
    title: "Point at the bug, hand it to your agent",
    text: "Click any element: its React, Vue or Svelte component, file:line, props and styles, copied as Markdown for your coding agent.",
    img: "panel-page.webp",
  },
  {
    file: "3-security.png",
    kicker: "Security",
    title: "Find what the page leaks",
    text: "Secrets shipped to the browser, source maps and exposed files, libraries with known CVEs, third parties, CSP and a header grade.",
    img: "panel-security.webp",
  },
  {
    file: "4-ai.png",
    kicker: "AI › Ask about the page",
    title: "Ask your own model about the page",
    text: "Any provider, or Ollama and LM Studio on your machine. Your key stays in the browser, with token count and cost shown.",
    img: "panel-ai.webp",
  },
  {
    file: "5-storage.png",
    kicker: "Cache › Storage usage",
    title: "See what a site keeps on your disk",
    text: "IndexedDB, Cache Storage, OPFS, Web Storage and cookies, sized against the quota. Clear exactly what you mean to clear.",
    img: "panel-usage.webp",
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// setContent keeps the current document's origin: start from a file:// page so site/ images and fonts load.
await page.goto(`${site}/index.html`);
for (const s of shots) {
  const width = s.width ?? 420;
  await page.setContent(
    `<style>${css}</style>
     <div class="copy"><span class="kicker">${s.kicker}</span><h1>${s.title}</h1><p>${s.text}</p></div>
     <div class="shot" style="${s.width ? "align-self:center;height:auto;border-radius:14px;border-bottom:1px solid #23324a" : ""}">
       <img src="${site}/img/${s.img}" style="width:${width}px" alt=""></div>`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, "screenshots", s.file) });
  console.log(`store/screenshots/${s.file}`);
}

await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(
  `<style>${css}
   body { flex-direction: column; justify-content: center; padding: 0 36px; gap: 14px; background: radial-gradient(120% 120% at 100% 0%, #10233a 0%, #0b0f17 60%); }
   .brand { display: flex; align-items: center; gap: 14px; font-size: 44px; font-weight: 800; font-stretch: 112%; letter-spacing: -.02em; }
   .brand img { width: 56px; height: 56px; }
   .tag { font-size: 19px; line-height: 1.35; color: #9fb0c3; }
   .tag b { color: #22d3ee; font-weight: 600; }</style>
   <div class="brand"><img src="${site}/img/icon.png" alt="">devkit</div>
   <div class="tag">Cache, inspectors, request rules, utilities and <b>AI with your own model</b>, in one side panel.</div>`,
  { waitUntil: "load" },
);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(out, "promo-small-440x280.png") });
console.log("store/promo-small-440x280.png");
await browser.close();

copyFileSync(join(root, "public/icon/128.png"), join(out, "icon-128.png"));
console.log("store/icon-128.png");
