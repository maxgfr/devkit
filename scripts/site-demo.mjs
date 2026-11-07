// Synthetic demo shop page for the site's figures (Acme Kitchen does not exist). Its JSON-LD carries the
// three mistakes Fig. 1 points at, and it seeds a little storage so the Usage panel has something to show.
// Usage: node scripts/site-demo.mjs [port]
import http from "node:http";

const page = (base) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Stoneware Mug, 350 ml – Acme Kitchen</title>
<meta name="description" content="Hand-glazed stoneware mug.">
<link rel="canonical" href="${base}/mugs/stoneware">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Stoneware Mug, 350 ml","image":"/img/mug.jpg","sku":"MUG-350","brand":{"@type":"Brand","name":"Acme Kitchen"},"offers":{"@type":"Offer","price":"€24,90","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Kitchen","item":"${base}/kitchen"},{"@type":"ListItem","position":2,"name":"Mugs"},]}</script>
<script>window.__NEXT_DATA__ = {};</script>
<style>
body{margin:0;font:16px/1.55 Georgia,serif;color:#2b2520;background:#f4efe8}
header{display:flex;justify-content:space-between;padding:18px 48px;border-bottom:1px solid #e2d8cc;font:600 15px system-ui,sans-serif;letter-spacing:.02em}
header nav a{margin-left:22px;color:#6b5d50;text-decoration:none;font-weight:500}
main{display:grid;grid-template-columns:1fr;gap:28px;padding:28px 48px;max-width:640px}
.crumbs{grid-column:1/-1;font:13px system-ui,sans-serif;color:#7a6c5e}
h1{font-size:46px;line-height:1.1;margin:6px 0 10px;font-weight:500}
.price{font:600 26px system-ui,sans-serif;margin:8px 0 18px}
.desc{max-width:44ch;color:#4a4038}
button{margin-top:22px;font:600 15px system-ui,sans-serif;background:#2b2520;color:#f4efe8;border:0;border-radius:4px;padding:13px 26px}
.meta{font:13px system-ui,sans-serif;color:#7a6c5e;margin-top:16px}
</style>
</head><body>
<header><span>ACME KITCHEN</span><nav><a href="/kitchen">Kitchen</a><a href="/table">Table</a><a href="/journal">Journal</a><a href="/cart">Cart (0)</a></nav></header>
<main>
<div class="crumbs" id="crumbs">Kitchen › Mugs › Stoneware Mug</div>
<div>
<h1>Stoneware Mug, 350&nbsp;ml</h1>
<div class="price" id="price">€24,90</div>
<p class="desc" id="desc">Thrown in small batches and finished in a deep slate glaze. Holds a generous 350 ml, keeps coffee warm, and stacks neatly in the cupboard.</p>
<p class="desc">Dishwasher and microwave safe.</p>
<button id="add-to-cart">Add to cart</button>
<div class="meta">SKU MUG-350 · Ships in 2 days</div>
</div>
</main>
<script>
(async () => {
  const products = Array.from({ length: 240 }, (_, i) => ({ sku: "SKU-" + i, name: "Product " + i, notes: "x".repeat(600) }));
  localStorage.setItem("cart", JSON.stringify({ items: [{ sku: "MUG-350", qty: 2 }] }));
  localStorage.setItem("recently-viewed", JSON.stringify(products.slice(0, 60)));
  sessionStorage.setItem("checkout-step", "shipping");
  document.cookie = "consent=essential; path=/; SameSite=Lax";
  await new Promise((done) => {
    const open = indexedDB.open("acme-catalog", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("products", { keyPath: "sku" });
      open.result.createObjectStore("images");
    };
    open.onsuccess = () => {
      const tx = open.result.transaction(["products", "images"], "readwrite");
      for (const p of products) tx.objectStore("products").put(p);
      for (let i = 0; i < 12; i++) tx.objectStore("images").put(new Blob([new Uint8Array(90_000 + i * 7_000)], { type: "image/webp" }), "thumb-" + i);
      tx.oncomplete = () => done();
    };
    open.onerror = () => done();
  });
  if ("caches" in window) {
    const cache = await caches.open("acme-assets-v3");
    for (const [path, size, type] of [["/img/mug.jpg", 420_000, "image/jpeg"], ["/img/mug-2.jpg", 380_000, "image/jpeg"], ["/fonts/serif.woff2", 64_000, "font/woff2"], ["/app.js", 210_000, "text/javascript"]])
      await cache.put(path, new Response(new Uint8Array(size), { headers: { "content-type": type } }));
  }
})();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  if (req.url === "/" || req.url.startsWith("/mugs")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src * 'unsafe-inline'",
      "x-powered-by": "Express/4.18.2",
    });
    return res.end(page(base));
  }
  if (req.url === "/robots.txt") return res.writeHead(200).end(`User-agent: *\nDisallow: /cart\nSitemap: ${base}/sitemap.xml\n`);
  if (req.url === "/kitchen") return res.writeHead(200).end("ok");
  res.writeHead(404).end("not found");
});
server.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log(`listening ${server.address().port}`));
