import http from "node:http";
import { deflateSync, gzipSync } from "node:zlib";

// Fake credential planted for the secrets scanner, assembled at runtime so the repository never holds
// a string that secret scanners would take for a real key.
const FAKE_STRIPE_KEY = ["sk", "live", "51DevkitE2eFake9Qw3Er7Ty2Ui8Op4As"].join("_");

// Solid-color PNGs for the Assets panel: an 800×800 photo shown at 100×100 (oversized), a background tile.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (w, h, [r, g, b]) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
const IMAGES = { "/big.png": png(800, 800, [14, 116, 144]), "/tile.png": png(64, 64, [249, 204, 157]) };

const page = (base, port) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Acme Mug – devkit test page</title>
<meta name="description" content="Short">
<link rel="canonical" href="${base}/">
<meta property="og:title" content="Acme Mug">
<meta property="og:image" content="${base}/og.png">
<link rel="manifest" href="/manifest.json">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Mug","descripton":"A mug","image":"/mug.jpg","offers":{"@type":"Offer","price":"€12,50","priceCurrency":"EUR"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home"},]}</script>
<script>window.__NEXT_DATA__ = {}; setTimeout(() => { throw new Error("startup error from test page"); }, 50);</script>
<script>window.__ENV__ = { STRIPE_KEY: "${FAKE_STRIPE_KEY}", API_URL: "/api" };</script>
<script src="/app.js"></script>
<script src="http://localhost:${port}/vendor.js"></script>
<script src="/js/jquery-3.4.1.min.js"></script>
<script src="/js/lodash.js"></script>
<script type="speculationrules">{"prefetch":[{"urls":["/ok"]}],"prerender":[{"where":{"and":[{"href_matches":"/*"},{"not":{"selector_matches":".no-prerender"}}]},"eagerness":"conservative"}]}</script>
</head><body>
<h1>Acme Mug</h1><h2>Details</h2><h4>Skipped level</h4>
<p class="px-4 py-2 text-sm">The best mug. ${"Lorem ipsum dolor sit amet. ".repeat(40)}</p>
<img src="/mug.jpg">
<a href="/ok">ok link</a> <a href="/missing">broken link</a>
<form><input name="email"><input name="first_name" placeholder="First name"><textarea name="message"></textarea><select name="country"><option value="">-</option><option value="fr">France</option></select></form>
<p><button id="slow-btn" type="button">Slow button</button> <output id="slow-out"></output></p>
<div id="spacing" style="display:flex;gap:24px;padding:16px;margin:12px 0"><div id="m-a" style="width:120px;height:40px;background:#e0f2fe"></div><div id="m-b" style="width:120px;height:40px;background:#fee2e2" onclick="window.__measureClicks = (window.__measureClicks || 0) + 1"></div></div>
<img id="big" src="/big.png" alt="Mug, front view" width="100" height="100">
<svg id="icon-star" width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="Star"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5-6.5 4.5 2-7.5L2 9h7z" fill="#f59e0b"/></svg>
<div id="hero" style="width:200px;height:60px;background:url(/tile.png) left top / 32px 32px repeat"></div>
<div id="app"><section class="toolbar"><button id="save-btn" class="btn" type="button" onclick="window.__saveClicks = (window.__saveClicks || 0) + 1">Save changes</button></section></div>
<section id="checkout"><label for="coupon">Coupon code</label> <input id="coupon" name="coupon"> <button id="order-btn" type="button">Place order</button> <a href="/?from=link">Next page</a></section>
<script>
// The bug report's failing request: a 500 whose URL carries the planted key, and the console error it causes.
document.getElementById("order-btn").addEventListener("click", async () => {
  const url = "/api/orders?api_key=" + window.__ENV__.STRIPE_KEY;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) console.error("Order failed: " + res.status + " for " + url);
});
</script>
<script>
// A React 18 dev-build fiber on the button, as react-dom attaches it: the element picker reads it.
(function () {
  function Toolbar() {}
  function SaveButton() {}
  var root = { tag: 3, type: null, return: null };
  var toolbar = { tag: 0, type: Toolbar, elementType: Toolbar, return: root, memoizedProps: {}, _debugOwner: null, _debugSource: { fileName: "/app/src/App.tsx", lineNumber: 21, columnNumber: 5 } };
  var save = { tag: 0, type: SaveButton, elementType: SaveButton, return: toolbar, memoizedProps: { label: "Save changes", onSave: function handleSave() {} }, _debugOwner: toolbar, _debugSource: { fileName: "/app/src/Toolbar.tsx", lineNumber: 12, columnNumber: 7 } };
  document.getElementById("save-btn").__reactFiber$e2e = { tag: 5, type: "button", return: save, _debugOwner: save, _debugSource: { fileName: "/app/src/components/SaveButton.tsx", lineNumber: 14, columnNumber: 9 } };
})();
</script>
<script src="/slow.js"></script>
</body></html>`;

const sse = (res, text) => {
  res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" });
  const words = text.split(/(?<= )/);
  let i = 0;
  const tick = () => {
    if (i < words.length) {
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { content: words[i++] }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(tick, 5);
    } else {
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1234, completion_tokens: 20, total_tokens: 1254 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    }
  };
  tick();
};

// Every heading problem the Headings panel knows, on one page tall enough for the page map.
const HEADINGS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme Mug guide</title></head><body>
<header><h3>Acme shop</h3></header>
<main>
<h1 id="top">Acme Mug guide</h1><p>Everything about the Acme mug, the best mug there is.</p>
<h2 id="details">Details</h2><p>Ceramic, 350 ml, dishwasher safe.</p>
<h4>Skipped level</h4><p>Made in a small workshop.</p>
<h2></h2>
<h2 style="display:none">Hidden heading</h2>
<h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen reader heading</h2><p>Only for screen readers.</p>
<div role="heading">Fake heading</div><p>Styled like a heading.</p>
<h2>FAQ</h2><p>Questions.</p>
<h2>FAQ</h2><p>More questions.</p>
<div aria-hidden="true"><h2>Decorative heading</h2></div>
<div style="height:2400px"></div>
<h2>Bottom of the page</h2><p>The end.</p>
</main>
</body></html>`;

// GitHub's landmark structure (a repository page): a named header with two navs, main with a named section and a
// nav, a footer with a nav, plus an unnamed section, an article header and a heading outside every landmark.
const LANDMARKS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>maxgfr/skycmd</title></head><body>
<header aria-label="Global navigation menu">
<h2>Navigation Menu</h2>
<nav aria-label="Breadcrumbs"><a href="#">maxgfr</a> / <a href="#">skycmd</a></nav>
<nav aria-label="Repository"><a href="#">Code</a> <a href="#">Issues</a></nav>
</header>
<div><h2>Skip to content</h2></div>
<main>
<h1>skycmd</h1><p>A command palette.</p>
<section aria-labelledby="protect"><h2 id="protect">Your main branch isn't protected</h2><p>Protect it.</p></section>
<section><h2>Unnamed section</h2><p>Not a landmark.</p></section>
<nav aria-label="Repository files"><h2>Folders and files</h2><p>src, tests</p></nav>
<article><header><h2>README</h2></header><p>Read me.</p></article>
</main>
<footer><h2>Footer</h2><nav aria-label="Footer"><a href="#">Terms</a></nav></footer>
</body></html>`;

// A GitHub-like repository for Repo dependencies: the pages carry GitHub's meta tags, branch picker and file
// listing markup, and /raw/ redirects like github.com does (to another path here).
const REPO_FILES = {
  "package.json": JSON.stringify({
    name: "acme-shop",
    workspaces: ["web"],
    dependencies: { express: "^5.1.0" },
  }),
  "web/package.json": JSON.stringify({
    name: "@acme/web",
    dependencies: { react: "^19.0.0", "@tanstack/react-query": "^5.0.0" },
    devDependencies: { vitest: "^4.0.0" },
  }),
  "web/requirements.txt": "# API helpers\nflask==3.0.3\n-r base.txt\nrequests[socks]>=2.31 ; python_version >= '3.10'\n",
};
const repoPage = (dir) => {
  const files = Object.keys(REPO_FILES).filter((p) => p.split("/").slice(0, -1).join("/") === dir);
  const listed = [...files, ...(dir === "web" ? ["web/Gemfile"] : [])];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>acme/shop</title>
<meta property="og:site_name" content="GitHub"><meta name="octolytics-dimension-repository_nwo" content="acme/shop">
</head><body><main id="js-repo-pjax-container">
<button id="ref-picker-repos-header-ref-selector" type="button">main</button>
<div id="files"><div data-testid="directory-content"><table aria-labelledby="folders-and-files">
${listed.map((p) => `<tr><td><a class="Link--primary" href="/acme/shop/blob/main/${p}">${p.split("/").at(-1)}</a></td></tr>`).join("\n")}
<tr><td><a href="/acme/shop/tree/main/web">web</a></td></tr>
</table></div></div>
<div id="readme-box"><div><article class="markdown-body"><h1>Acme shop</h1><p>The shop.</p></article></div></div>
</main></body></html>`;
};

// A shop page whose dataLayer has a Consent Mode v1 default, a purchase without transaction_id and a comma value,
// an e-mail address, and a view_item whose item disagrees with the Product markup. google_tag_manager is faked so
// the page loads nothing from Google.
const DATALAYER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme Mug order</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Mug","sku":"MUG-1","offers":{"@type":"Offer","price":"12.50","priceCurrency":"EUR"}}</script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("consent", "default", { ad_storage: "denied", analytics_storage: "denied" });
gtag("js", new Date());
gtag("config", "G-E2E5678");
gtag("consent", "update", { ad_storage: "granted", analytics_storage: "granted" });
dataLayer.push({ event: "view_item", ecommerce: { currency: "EUR", items: [{ item_id: "MUG-2", item_name: "Acme Mug", price: 15 }] } });
dataLayer.push({ ecommerce: null });
dataLayer.push({ event: "purchase", ecommerce: { value: "129,00", currency: "EUR", items: [{ item_id: "MUG-1", item_name: "Acme Mug", price: 12.5, quantity: 1 }] } });
dataLayer.push({ event: "login", user: { email: "jane.doe@example.com" }, eventCallback: function () {} });
window.google_tag_manager = { "GTM-E2E1234": { dataLayer: { name: "dataLayer" } } };
</script></head><body><h1>Thank you for your order</h1></body></html>`;

// WebMCP as Chrome's early preview exposed it behind its testing flag: a read-only tool and a Critical one. Running
// delete_account would set window.__accountDeleted: the Agent tools panel must refuse to.
const AGENT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme store hours</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.test/"}</script>
<script>
(function () {
  var tools = [
    {
      name: "get_store_hours",
      description: "Returns the store's opening hours for a given day of the week.",
      inputSchema: JSON.stringify({ type: "object", properties: { day: { type: "string", enum: ["monday", "tuesday", "sunday"], description: "Day of the week" } }, required: ["day"] }),
      annotations: { readOnlyHint: true },
    },
    {
      name: "delete_account",
      description: "Deletes the signed-in user's account and all its data. Cannot be undone.",
      inputSchema: JSON.stringify({ type: "object", properties: { confirm: { type: "boolean", description: "Must be true" } }, required: ["confirm"] }),
    },
  ];
  Object.defineProperty(navigator, "modelContextTesting", {
    configurable: true,
    value: {
      listTools: function () { return tools; },
      executeTool: function (name, json) {
        var args = JSON.parse(json);
        if (name === "delete_account") { window.__accountDeleted = true; return Promise.resolve(JSON.stringify({ deleted: true })); }
        if (name === "get_store_hours") return Promise.resolve(JSON.stringify({ day: args.day, open: "09:00", close: args.day === "sunday" ? "13:00" : "19:00" }));
        return Promise.reject(new Error("Unknown tool " + name));
      },
    },
  });
})();
</script></head><body>
<nav><a href="/">Home</a></nav>
<main><h1>Store hours</h1><p>Open every day.</p></main>
</body></html>`;

// On-page SEO: complete Open Graph (og:description written with name=, og:image 800×800 declared 1200×630),
// summary_large_image, hreflang with a self-reference, a relative URL, de_AT and en-UK and no x-default,
// images without alt and title, internal, external and nofollow links.
const seoPage = (base) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Acme Mug guide – how to pick the right mug for your coffee</title>
<meta name="description" content="How to pick a mug: size, material and handle. Everything about the Acme mug, the best mug there is for coffee, tea and hot chocolate in the morning.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${base}/seo">
<meta property="og:title" content="Acme Mug guide">
<meta name="og:description" content="How to pick the right mug.">
<meta property="og:image" content="${base}/big.png?og=1">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${base}/seo">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Acme">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" hreflang="en" href="${base}/seo">
<link rel="alternate" hreflang="fr" href="/seo/fr">
<link rel="alternate" hreflang="de_AT" href="${base}/seo/at">
<link rel="alternate" hreflang="en-UK" href="${base}/seo/uk">
</head><body>
<h1>Acme Mug guide</h1><p>Pick a mug you like.</p>
<h2>First steps</h2><p>Look at the size.</p>
<h2>Second thoughts</h2><p>Then the handle.</p>
<img src="/tile.png" alt="Tile"><img src="/tile.png"><img src="/tile.png" alt="" title="Decor">
<a href="/">Home</a> <a href="/ok">OK</a> <a href="/ok">OK again</a> <a href="https://example.com/" rel="nofollow">Elsewhere</a>
</body></html>`;
// IndexedDB and Cache Storage viewer: a database with an in-line key store and an out-of-line one, and a cache
// with JSON, HTML and image entries. Starts from scratch on every load; window.__dbReady says when it is done.
const DATABASES_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Databases – devkit test page</title></head>
<body><h1>Databases</h1>
<script>
(async () => {
  await new Promise((done, fail) => {
    indexedDB.deleteDatabase("devkit-shop");
    const req = indexedDB.open("devkit-shop", 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      const users = db.createObjectStore("users", { keyPath: "id", autoIncrement: true });
      users.createIndex("by_email", "email", { unique: true });
      users.createIndex("by_tags", "tags", { multiEntry: true });
      db.createObjectStore("settings");
    };
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["users", "settings"], "readwrite");
      const users = tx.objectStore("users");
      users.put({ id: 1, name: "Ada", email: "ada@example.com", tags: ["admin"], born: new Date("1815-12-10T00:00:00Z") });
      users.put({ id: 2, name: "Grace", email: "grace@example.com", tags: ["dev", "admin"], prefs: new Map([["theme", "dark"]]) });
      users.put({ id: 3, name: "Linus", email: "linus@example.com", tags: ["dev"] });
      const settings = tx.objectStore("settings");
      settings.put({ seen: new Set([1, 2]), avatar: new Blob(["png"], { type: "image/png" }), bytes: new Uint8Array([1, 2, 3]), big: 10n }, "prefs");
      settings.put("dark", "theme");
      tx.oncomplete = () => { db.close(); done(); };
      tx.onerror = () => fail(tx.error);
    };
  });
  await caches.delete("devkit-shop-v1");
  const cache = await caches.open("devkit-shop-v1");
  await cache.put("/api/products.json", new Response(JSON.stringify({ products: [{ id: 1, name: "Mug" }] }), { headers: { "content-type": "application/json" } }));
  await cache.put("/offline.html", new Response("<h1>Offline</h1>", { headers: { "content-type": "text/html" } }));
  await cache.put("/tile.png", await fetch("/tile.png"));
  window.__dbReady = true;
})().catch((e) => { window.__dbReady = String(e); });
</script>
</body></html>`;
// Consent check: before any interaction the page sets `_ga`, loads a script and a GA-shaped hit from another local
// origin (localhost vs 127.0.0.1) and sets Consent Mode's default to granted. "Accept" adds `_fbp` and a Meta-shaped hit.
const consentPage = (port) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Consent fixture</title>
<script>
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("consent", "default", { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
document.cookie = "_ga=GA1.1.555.777; path=/";
localStorage.setItem("_hjSessionUser_42", "e2e-hj-value");
</script>
<script src="http://localhost:${port}/consent/tracker.js"></script>
</head><body>
<h1>Consent fixture</h1>
<img alt="" src="http://localhost:${port}/g/collect?v=2&tid=G-E2ECONSENT&gcs=G111&cid=555.777&en=page_view">
<button id="accept" type="button">Accept all</button>
<script>
document.getElementById("accept").addEventListener("click", () => {
  gtag("consent", "update", { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
  document.cookie = "_fbp=fb.1.e2e-fbp-value; path=/";
  const img = new Image();
  img.src = "http://localhost:${port}/tr?id=42&ev=PageView";
  document.body.append(img);
});
</script>
</body></html>`;
// Site crawl: a small site of its own on localhost:<port> (127.0.0.1 keeps its robots.txt and sitemap for the
// other panels). robots.txt points to a sitemap index of a plain sitemap and a gzipped one (served as a file, so
// devkit must gunzip it); the pages carry a duplicate title, a missing description, a noindex, a 404, a redirect
// and invalid JSON-LD; one URL is blocked by robots.txt and one is on another host.
const CRAWL_DESC = "Acme mugs: ceramic, 350 ml, dishwasher safe, made to last for years of morning coffee.";
const CRAWL_PAGES = {
  "/crawl/": {
    title: "Acme home",
    description: CRAWL_DESC,
    jsonld: ['{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.test/"}'],
  },
  "/crawl/a": { title: "Acme mugs", description: `${CRAWL_DESC} Page A.` },
  "/crawl/b": { title: "Acme mugs", h1: "Mugs, page B" },
  "/crawl/noindex": { title: "Acme drafts", description: `${CRAWL_DESC} Drafts.`, robots: "noindex, follow" },
  "/crawl/jsonld": {
    title: "Acme product",
    description: `${CRAWL_DESC} Product.`,
    jsonld: ['{"@context":"https://schema.org","@type":"Product","name":"Mug"}', '{"@context":"https://schema.org","@type":"Offer",}'],
  },
  "/crawl/moved": { title: "Acme moved page", description: `${CRAWL_DESC} Moved.` },
  "/crawl/other": { title: "Other host page", description: CRAWL_DESC },
  "/crawl/private/x": { title: "Private", description: CRAWL_DESC },
};
const crawlHtml = (base, path, { title, description, robots, jsonld = [], h1 = title }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ""}${robots ? `<meta name="robots" content="${robots}">` : ""}
<link rel="canonical" href="${base}${path}">
${jsonld.map((j) => `<script type="application/ld+json">${j}</script>`).join("\n")}
</head><body><h1>${h1}</h1><p>Acme makes mugs for coffee, tea and hot chocolate.</p></body></html>`;
function crawlRoute(req, url, base) {
  const xml = (body) => ({ status: 200, headers: { "content-type": "application/xml" }, body });
  const urlset = (paths) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${p.startsWith("http") ? p : base + p}</loc></url>`).join("")}</urlset>`;
  if (/^localhost:/.test(req.headers.host ?? "") && url.pathname === "/robots.txt")
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nDisallow: /crawl/private\n\nSitemap: ${base}/crawl/sitemap-index.xml\n`,
    };
  if (!url.pathname.startsWith("/crawl/")) return null;
  if (url.pathname === "/crawl/sitemap-index.xml")
    return xml(
      `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/crawl/sitemap-pages.xml</loc></sitemap><sitemap><loc>${base}/crawl/sitemap-more.xml.gz</loc></sitemap></sitemapindex>`,
    );
  if (url.pathname === "/crawl/sitemap-pages.xml")
    return xml(urlset(["/crawl/", "/crawl/a", "/crawl/b", "/crawl/private/x", `${base.replace("localhost", "127.0.0.1")}/crawl/other`]));
  if (url.pathname === "/crawl/sitemap-more.xml.gz")
    return {
      status: 200,
      headers: { "content-type": "application/gzip" },
      body: gzipSync(urlset(["/crawl/noindex", "/crawl/gone", "/crawl/old", "/crawl/jsonld"])),
    };
  if (url.pathname === "/crawl/old") return { status: 301, headers: { location: "/crawl/moved" }, body: "" };
  const spec = CRAWL_PAGES[url.pathname];
  if (!spec) return { status: 404, headers: { "content-type": "text/html" }, body: "<!doctype html><title>Not found</title>" };
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: crawlHtml(base, url.pathname, spec) };
}
let ogImageHits = 0;

// Overview and AI context: landmarks (two unnamed navigation landmarks), a dataLayer with a Consent Mode v1 default
// and an e-mail address, and an Organization node. The last AI request's context is kept for /ai-last-context.
const OVERVIEW_CONTEXT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme overview context</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.test/"}</script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("consent", "default", { ad_storage: "denied", analytics_storage: "denied" });
gtag("js", new Date());
gtag("config", "G-OVR1234");
dataLayer.push({ event: "sign_up", user: { email: "sam.smith@example.com" } });
</script></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main><h1>Overview context</h1><p>Landmarks and a dataLayer.</p><nav><a href="#more">More links</a></nav></main>
<footer><p>Footer</p></footer>
</body></html>`;
let lastAiContext = "";

// Served vs rendered: JavaScript changes the title and adds a canonical, a JSON-LD block, an og:image and links.
const RENDERED_SOURCE_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Loading…</title>
<meta name="description" content="Rendered source test page">
</head><body>
<h1>Client app</h1>
<a href="/">Home</a>
<div id="root"></div>
<script>
document.title = "Rendered title from JS";
const canonical = document.createElement("link");
canonical.rel = "canonical";
canonical.href = location.origin + "/rendered-source";
document.head.append(canonical);
const og = document.createElement("meta");
og.setAttribute("property", "og:image");
og.content = location.origin + "/big.png";
document.head.append(og);
const ld = document.createElement("script");
ld.type = "application/ld+json";
ld.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Acme" });
document.head.append(ld);
document.getElementById("root").innerHTML =
  '<h2>Injected section</h2><a href="/js-only-1">JS link one</a> <a href="/js-only-2">JS link two</a> <a href="https://example.org/partner">Partner</a>';
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  const url = new URL(req.url, base);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  const crawled = crawlRoute(req, url, base);
  if (crawled) return res.writeHead(crawled.status, crawled.headers).end(crawled.body);
  if (url.pathname === "/seo") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(seoPage(base));
  if (url.pathname === "/og-hits") return res.writeHead(200, { "content-type": "text/plain" }).end(String(ogImageHits));
  if (url.pathname === "/overview-context")
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(OVERVIEW_CONTEXT_PAGE);
  if (url.pathname === "/ai-last-context") return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(lastAiContext);
  if (url.pathname === "/big.png" && url.searchParams.get("og") === "1") ogImageHits++;
  if (url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src * 'unsafe-inline'",
      "x-powered-by": "Express/4.18.2",
      "cache-control": "no-cache",
      "speculation-rules": '"/speculation.json"',
      "x-robots-tag": "noarchive",
    });
    return res.end(page(base, req.socket.localPort));
  }
  // A click handler that blocks the main thread for 250 ms, and an unload listener that keeps the page out of the
  // back/forward cache: the Responsiveness panel must name both.
  if (url.pathname === "/agent") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(AGENT_PAGE);
  if (url.pathname === "/llms.txt")
    return res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(
        `# Acme\n\n> Acme sells mugs.\n\n## Pages\n\n- [Store hours](${base}/agent): when the shop is open\n- [Mug](${base}/): the Acme mug\n`,
      );
  if (url.pathname === "/databases") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DATABASES_PAGE);
  if (url.pathname === "/headings") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HEADINGS_PAGE);
  if (url.pathname === "/rendered-source")
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(RENDERED_SOURCE_PAGE);
  if (url.pathname === "/landmarks") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LANDMARKS_PAGE);
  if (url.pathname === "/acme/shop" || url.pathname === "/acme/shop/tree/main/web")
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(repoPage(url.pathname.endsWith("/web") ? "web" : ""));
  if (url.pathname.startsWith("/acme/shop/raw/main/")) {
    const path = url.pathname.slice("/acme/shop/raw/main/".length);
    if (path === "web/Gemfile") return res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
    if (!REPO_FILES[path]) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return res.writeHead(302, { location: `/raw-files/acme/shop/main/${path}` }).end();
  }
  if (url.pathname.startsWith("/raw-files/acme/shop/main/"))
    return res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(REPO_FILES[url.pathname.slice("/raw-files/acme/shop/main/".length)] ?? "");
  if (url.pathname === "/consent")
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(consentPage(req.socket.localPort));
  if (url.pathname === "/consent/tracker.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("window.__tracker = 1;");
  if (url.pathname === "/g/collect" || url.pathname === "/tr")
    return res.writeHead(200, { "content-type": "image/png" }).end(IMAGES["/tile.png"]);
  if (url.pathname === "/datalayer") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DATALAYER_PAGE);
  if (url.pathname === "/slow.js")
    return res
      .writeHead(200, { "content-type": "text/javascript" })
      .end(
        'function busyWait(ms) {\n  const end = performance.now() + ms;\n  while (performance.now() < end) {}\n}\ndocument.getElementById("slow-btn").addEventListener("click", function onSlowClick() {\n  busyWait(250);\n  document.getElementById("slow-out").textContent = "done";\n});\naddEventListener("unload", function () {});\n',
      );
  if (url.pathname === "/speculation.json")
    return res
      .writeHead(200, { "content-type": "application/speculationrules+json" })
      .end(JSON.stringify({ prefetch: [{ where: { href_matches: "/docs/*" }, eagerness: "moderate" }], tag: "e2e-header" }));
  if (url.pathname === "/plain")
    return res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><title>Plain page</title><p>Nothing here keeps the page out of the back/forward cache.</p>");
  if (url.pathname === "/echo") {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify(req.headers));
  }
  if (url.pathname === "/api/user") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors });
    return res.end(JSON.stringify({ id: 1, name: "Real User", plan: "free" }));
  }
  if (url.pathname === "/app.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end("window.__app = 1;\n//# sourceMappingURL=app.js.map\n");
  if (url.pathname === "/app.js.map")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ version: 3, file: "app.js", sources: ["src/app.ts"], sourcesContent: ["window.__app = 1;"], mappings: "AAAA" }),
      );
  // Stubs of an old jQuery (known advisories) and a current lodash (none) for the vulnerable libraries panel.
  if (url.pathname === "/js/jquery-3.4.1.min.js")
    return res
      .writeHead(200, { "content-type": "text/javascript" })
      .end(
        '/*! jQuery v3.4.1 | (c) JS Foundation and other contributors | jquery.org/license */\nwindow.jQuery = { fn: { jquery: "3.4.1" } };\n',
      );
  if (url.pathname === "/js/lodash.js")
    return res
      .writeHead(200, { "content-type": "text/javascript" })
      .end(
        "/**\n * @license\n * Lodash <https://lodash.com/>\n */\n;(function () {\n  var VERSION = '4.18.1';\n  window._ = { VERSION: VERSION, runInContext: function () {} };\n})();\n",
      );
  if (url.pathname === "/vendor.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("window.__vendor = 1;");
  if (url.pathname === "/.git/HEAD") return res.writeHead(200, { "content-type": "text/plain" }).end("ref: refs/heads/main\n");
  if (url.pathname === "/api/orders")
    return res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "payment provider unavailable" }));
  // JSON documents for the JSON page viewer: a valid one, a broken one, and JSON served as text/plain.
  if (url.pathname === "/api/posts/1")
    return res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
      JSON.stringify({
        userId: 1,
        id: 1,
        title: "sunt aut facere",
        link: `${base}/ok`,
        tags: ["a", "b", "c"],
        author: { name: "Ada", address: { city: "London", geo: { lat: "51.5" } } },
      }),
    );
  if (url.pathname === "/api/broken") return res.writeHead(200, { "content-type": "application/json" }).end('{\n  "a": 1,\n  "b": }');
  if (url.pathname === "/api/plain") return res.writeHead(200, { "content-type": "text/plain" }).end('{"plain":true,"items":[1,2]}');
  if (IMAGES[url.pathname])
    return res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" }).end(IMAGES[url.pathname]);
  // Redirect path: /r1 → 301 → /r2 → 302 → /final, a meta refresh to /final, and a loop.
  if (url.pathname === "/r1") return res.writeHead(301, { location: "/r2", "x-hop": "first" }).end();
  if (url.pathname === "/r2") return res.writeHead(302, { location: "/final" }).end();
  if (url.pathname === "/final")
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Final</title><h1>Final page</h1>");
  if (url.pathname === "/meta")
    return res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end('<!doctype html><title>Moving</title><meta http-equiv="refresh" content="0; url=/final"><p>Moving…</p>');
  if (url.pathname === "/js-redirect")
    return res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end('<!doctype html><title>Moving</title><script>setTimeout(() => location.replace("/final"), 50)</script>');
  if (url.pathname === "/loop-a") return res.writeHead(302, { location: "/loop-b" }).end();
  if (url.pathname === "/loop-b") return res.writeHead(302, { location: "/loop-a" }).end();
  if (url.pathname === "/ok") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  if (url.pathname === "/robots.txt")
    return res
      .writeHead(200, { "content-type": "text/plain" })
      .end(`User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${base}/sitemap.xml\n`);
  if (url.pathname === "/sitemap.xml")
    return res
      .writeHead(200, { "content-type": "application/xml" })
      .end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc><lastmod>2026-10-01</lastmod></url><url><loc>${base}/ok</loc></url></urlset>`,
      );
  if (url.pathname === "/manifest.json")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name: "Acme", start_url: "/", display: "standalone", icons: [{ src: "/i.png", sizes: "192x192" }] }));
  if (url.pathname === "/v1/models")
    return res
      .writeHead(200, { "content-type": "application/json", ...cors })
      .end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
  if (url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body);
      const user = json.messages.filter((m) => m.role === "user").at(-1);
      const content = typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
      lastAiContext = content;
      const title = /Title: (.*)/.exec(content)?.[1] ?? "?";
      const hasText = content.includes("best mug");
      const element = /## UI element: `<(\w+)>`/.exec(content)?.[1] ?? "none";
      const axe = content.includes("## Accessibility (axe-core audit)") ? (/`(image-alt)`/.exec(content)?.[1] ?? "none") : "none";
      const report = content.includes("# Bug report:");
      const secrets = content.includes("## Secrets (devkit panel: Security › Secrets)");
      const leaked = /sk_live_[A-Za-z0-9]{8,}/.test(content);
      const cve = /CVE-\d{4}-\d+/.exec(content)?.[0] ?? "none";
      const headings = content.includes("## Headings outline (devkit panel: Inspect › Headings)");
      const sectionText = content.includes("> Ceramic, 350 ml, dishwasher safe.");
      const focus = /In focus: the developer asked about the h\d "([^"]*)"/.exec(content)?.[1] ?? "none";
      sse(
        res,
        `FAKE-MODEL answer. Title seen: ${title}. Page text included: ${hasText}. Picked element: ${element}. Axe rules seen: ${axe}. Bug report included: ${report}. Secrets section: ${secrets}. Raw secret sent: ${leaked}. First CVE: ${cve}. Headings section: ${headings}. Section text sent: ${sectionText}. Heading in focus: ${focus}. Context length: ${content.length} chars.`,
      );
    });
    return;
  }
  // GraphQL endpoint for the DevTools panel's GraphQL view: single, batched and persisted (GET) operations.
  if (url.pathname === "/graphql") {
    const answer = (op) => {
      const doc = op?.query ?? "";
      if (op?.operationName === "GetUser" || /query GetUser\b/.test(doc))
        return { data: { user: { id: op.variables?.id ?? "1", name: "Ada" } } };
      if (/query ListPosts\b/.test(doc)) return { data: { posts: [{ id: "p1", title: "Hello" }] } };
      if (/^\s*mutation\s*\{\s*like\b/.test(doc))
        return { data: { like: null }, errors: [{ message: "Not authorized", path: ["like"], extensions: { code: "FORBIDDEN" } }] };
      if (op?.operationName === "Feed" && op?.extensions?.persistedQuery) return { data: { feed: [{ id: 1 }] }, extensions: { cost: 2 } };
      return { errors: [{ message: `Unknown operation ${op?.operationName ?? "(anonymous)"}`, locations: [{ line: 1, column: 1 }] }] };
    };
    const reply = (payload) =>
      res
        .writeHead(200, { "content-type": "application/json", ...cors })
        .end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
    if (req.method === "GET") {
      const json = (k) => (url.searchParams.has(k) ? JSON.parse(url.searchParams.get(k)) : undefined);
      return reply({ operationName: url.searchParams.get("operationName"), variables: json("variables"), extensions: json("extensions") });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => reply(JSON.parse(body || "{}")));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log(`listening ${server.address().port}`));
