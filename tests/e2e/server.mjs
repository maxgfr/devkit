import http from "node:http";
import { deflateSync } from "node:zlib";

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
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Mug","image":"/mug.jpg","offers":{"@type":"Offer","price":"€12,50","priceCurrency":"EUR"}}</script>
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

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  const url = new URL(req.url, base);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src * 'unsafe-inline'",
      "x-powered-by": "Express/4.18.2",
      "cache-control": "no-cache",
      "speculation-rules": '"/speculation.json"',
    });
    return res.end(page(base, req.socket.localPort));
  }
  // A click handler that blocks the main thread for 250 ms, and an unload listener that keeps the page out of the
  // back/forward cache: the Responsiveness panel must name both.
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
  if (IMAGES[url.pathname])
    return res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" }).end(IMAGES[url.pathname]);
  if (url.pathname === "/ok") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  if (url.pathname === "/robots.txt")
    return res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /admin\nSitemap: ${base}/sitemap.xml\n`);
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
      const title = /Title: (.*)/.exec(content)?.[1] ?? "?";
      const hasText = content.includes("best mug");
      const element = /## UI element: `<(\w+)>`/.exec(content)?.[1] ?? "none";
      const axe = content.includes("## Accessibility (axe-core audit)") ? (/`(image-alt)`/.exec(content)?.[1] ?? "none") : "none";
      const report = content.includes("# Bug report:");
      sse(
        res,
        `FAKE-MODEL answer. Title seen: ${title}. Page text included: ${hasText}. Picked element: ${element}. Axe rules seen: ${axe}. Bug report included: ${report}. Context length: ${content.length} chars.`,
      );
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log(`listening ${server.address().port}`));
