import http from "node:http";

// Fake credential planted for the secrets scanner, assembled at runtime so the repository never holds
// a string that secret scanners would take for a real key.
const FAKE_STRIPE_KEY = ["sk", "live", "51DevkitE2eFake9Qw3Er7Ty2Ui8Op4As"].join("_");

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
</head><body>
<h1>Acme Mug</h1><h2>Details</h2><h4>Skipped level</h4>
<p class="px-4 py-2 text-sm">The best mug. ${"Lorem ipsum dolor sit amet. ".repeat(40)}</p>
<img src="/mug.jpg">
<a href="/ok">ok link</a> <a href="/missing">broken link</a>
<form><input name="email"><input name="first_name" placeholder="First name"><textarea name="message"></textarea><select name="country"><option value="">-</option><option value="fr">France</option></select></form>
<div id="app"><section class="toolbar"><button id="save-btn" class="btn" type="button" onclick="window.__saveClicks = (window.__saveClicks || 0) + 1">Save changes</button></section></div>
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
    });
    return res.end(page(base, req.socket.localPort));
  }
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
  if (url.pathname === "/vendor.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("window.__vendor = 1;");
  if (url.pathname === "/.git/HEAD") return res.writeHead(200, { "content-type": "text/plain" }).end("ref: refs/heads/main\n");
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
      sse(
        res,
        `FAKE-MODEL answer. Title seen: ${title}. Page text included: ${hasText}. Picked element: ${element}. Context length: ${content.length} chars.`,
      );
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log(`listening ${server.address().port}`));
