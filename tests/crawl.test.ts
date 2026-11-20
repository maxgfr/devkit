import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crawlMarkdown } from "../src/lib/agent/crawl";
import {
  type CrawlPage,
  clampSettings,
  crawlCsv,
  crawlDelayMs,
  crawlFindings,
  crawlJson,
  crawlSummary,
  csvCell,
  DEFAULT_CRAWL_SETTINGS,
  type Fetcher,
  fetchPage,
  filterPages,
  issuesByUrl,
  parseUrlList,
  planCrawl,
  readHtml,
  readRobots,
  readSitemaps,
  runQueue,
  sitemapRoots,
  sortPages,
} from "../src/lib/crawl";
import type { SchemaVocab } from "../src/lib/schema-vocab";
import { parseRobots } from "../src/lib/site-files";

const vocab = JSON.parse(readFileSync("public/schema-vocab.json", "utf8")) as SchemaVocab;

interface Route {
  status?: number;
  body?: string | Uint8Array;
  type?: string;
  headers?: Record<string, string>;
  /** Answers as if redirected to this URL. */
  redirectTo?: string;
}

/** A fake `fetch` over a route table; it records the URLs asked for. */
function fakeSite(routes: Record<string, Route>, log: string[] = []): Fetcher {
  return async (url, init) => {
    log.push(url);
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const res = new Response((r.body ?? "") as BodyInit, {
      status: r.status ?? 200,
      headers: { "content-type": r.type ?? "text/html; charset=utf-8", ...r.headers },
    });
    if (r.redirectTo) {
      Object.defineProperty(res, "url", { value: r.redirectTo });
      Object.defineProperty(res, "redirected", { value: true });
    } else Object.defineProperty(res, "url", { value: url });
    return res;
  };
}

const O = "https://shop.test";
const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
const index = (locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
const html = (head: string, body = "") => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

function page(over: Partial<CrawlPage> & { url: string }): CrawlPage {
  return {
    finalUrl: over.url,
    redirected: false,
    status: 200,
    contentType: "text/html",
    html: true,
    ms: 100,
    bytes: 1000,
    title: `Title of ${over.url}`,
    description: `Description of ${over.url}, long enough to be a real meta description of a page.`,
    canonical: over.url,
    canonicalState: "self",
    robotsMeta: null,
    xRobotsTag: null,
    noindex: false,
    h1: [`Heading of ${over.url}`],
    hreflang: 0,
    words: 300,
    jsonld: { blocks: 0, types: [], findings: [] },
    inSitemap: true,
    ...over,
  };
}

describe("sitemaps", () => {
  it("starts from robots.txt sitemaps, else /sitemap.xml", () => {
    expect(sitemapRoots(O, null)).toEqual([`${O}/sitemap.xml`]);
    expect(sitemapRoots(O, parseRobots(`Sitemap: ${O}/a.xml\nSitemap: ${O}/a.xml\nSitemap: ${O}/b.xml`))).toEqual([
      `${O}/a.xml`,
      `${O}/b.xml`,
    ]);
  });

  it("follows sitemap indexes, gunzips .gz sitemaps, reads each sitemap once and keeps URLs unique", async () => {
    const log: string[] = [];
    const fetcher = fakeSite(
      {
        [`${O}/sitemap-index.xml`]: {
          type: "application/xml",
          body: index([`${O}/pages.xml`, `${O}/products.xml.gz`, `${O}/pages.xml`, `${O}/nested.xml`, `${O}/gone.xml`]),
        },
        [`${O}/pages.xml`]: { type: "application/xml", body: urlset([`${O}/`, `${O}/about`]) },
        [`${O}/products.xml.gz`]: { type: "application/gzip", body: new Uint8Array(gzipSync(urlset([`${O}/p/1`, `${O}/about`]))) },
        [`${O}/nested.xml`]: { type: "application/xml", body: index([`${O}/deep.xml`]) },
        [`${O}/deep.xml`]: { type: "application/xml", body: urlset([`${O}/deep`]) },
      },
      log,
    );
    const r = await readSitemaps([`${O}/sitemap-index.xml`], fetcher);
    expect(r.urls.map((u) => u.loc)).toEqual([`${O}/`, `${O}/about`, `${O}/p/1`, `${O}/deep`]);
    expect(r.urls[2]!.sitemap).toBe(`${O}/products.xml.gz`);
    expect(log.filter((u) => u === `${O}/pages.xml`)).toHaveLength(1);
    expect(r.sitemaps.find((s) => s.url === `${O}/gone.xml`)).toMatchObject({
      kind: "error",
      status: 404,
      parent: `${O}/sitemap-index.xml`,
    });
    expect(r.sitemaps.find((s) => s.url === `${O}/deep.xml`)).toMatchObject({ kind: "urlset", entries: 1, parent: `${O}/nested.xml` });
    expect(r.truncated).toBe(false);
  });

  it("stops at the depth, sitemap and URL limits, and skips sitemaps it may not read", async () => {
    const fetcher = fakeSite({
      [`${O}/i.xml`]: { body: index([`${O}/j.xml`, "https://cdn.test/s.xml"]) },
      [`${O}/j.xml`]: { body: index([`${O}/k.xml`]) },
      [`${O}/k.xml`]: { body: urlset([`${O}/k`]) },
    });
    const shallow = await readSitemaps([`${O}/i.xml`], fetcher, { maxDepth: 1, allow: (u) => u.startsWith(O) });
    expect(shallow.urls).toEqual([]);
    expect(shallow.truncated).toBe(true);
    expect(shallow.sitemaps.find((s) => s.url === "https://cdn.test/s.xml")?.kind).toBe("skipped");
    const few = await readSitemaps([`${O}/i.xml`], fetcher, { maxSitemaps: 1 });
    expect(few.sitemaps).toHaveLength(1);
    expect(few.truncated).toBe(true);
    const capped = await readSitemaps([`${O}/s.xml`], fakeSite({ [`${O}/s.xml`]: { body: urlset([`${O}/1`, `${O}/2`, `${O}/3`]) } }), {
      maxUrls: 2,
    });
    expect(capped.urls).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("reads robots.txt; a 404 allows everything", async () => {
    const fetcher = fakeSite({ [`${O}/robots.txt`]: { type: "text/plain", body: "User-agent: *\nDisallow: /admin\nCrawl-delay: 2" } });
    const r = await readRobots(O, fetcher);
    expect(r.parsed?.groups[0]?.disallow).toEqual(["/admin"]);
    expect(crawlDelayMs(r.parsed, "devkit")).toBe(2000);
    expect((await readRobots("https://none.test", fetcher)).parsed).toBeNull();
  });

  it("parses a pasted URL list, relative paths against the site", () => {
    expect(parseUrlList(`${O}/a\n/b, c\n\nmailto:x@y.z ${O}/a`, O)).toEqual([`${O}/a`, `${O}/b`, `${O}/c`]);
  });
});

describe("plan", () => {
  const robots = { [O]: parseRobots("User-agent: *\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /nogoogle") };
  const urls = [`${O}/`, `${O}/private/x`, `${O}/nogoogle`, "https://other.test/a", `${O}/#top`, `${O}/b`, "nonsense"];

  it("keeps the site's URLs, skips other hosts, robots.txt blocks and past the page limit", () => {
    const plan = planCrawl(urls, { origin: O, settings: { ...DEFAULT_CRAWL_SETTINGS, maxPages: 2 }, robots });
    expect(plan.queue).toEqual([`${O}/`, `${O}/nogoogle`]);
    expect(plan.skipped).toEqual([
      { url: `${O}/private/x`, reason: "robots", rule: "Disallow: /private" },
      { url: "https://other.test/a", reason: "other-host" },
      { url: `${O}/b`, reason: "limit" },
      { url: "nonsense", reason: "invalid" },
    ]);
  });

  it("applies the chosen user agent's group, can ignore robots.txt and include other hosts", () => {
    const google = planCrawl(urls, { origin: O, settings: { ...DEFAULT_CRAWL_SETTINGS, userAgent: "Googlebot" }, robots });
    expect(google.queue).toContain(`${O}/private/x`);
    expect(google.skipped.find((s) => s.url === `${O}/nogoogle`)?.reason).toBe("robots");
    const all = planCrawl(urls, {
      origin: O,
      settings: { ...DEFAULT_CRAWL_SETTINGS, respectRobots: false, includeOtherHosts: true },
      robots,
    });
    expect(all.queue).toHaveLength(5);
    expect(all.otherOrigins).toEqual(["https://other.test"]);
  });

  it("clamps settings", () => {
    expect(clampSettings({ maxPages: 9999, concurrency: 0, delayMs: -5 })).toMatchObject({ maxPages: 500, concurrency: 1, delayMs: 0 });
    expect(clampSettings({})).toEqual(DEFAULT_CRAWL_SETTINGS);
  });
});

describe("queue", () => {
  it("runs at most `concurrency` at a time and does every item", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    const left = await runQueue(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        done.push(n);
        running--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(left).toEqual([]);
  });

  it("spaces starts by the delay across workers", async () => {
    const waits: number[] = [];
    let started = 0;
    await runQueue(
      ["a", "b", "c"],
      async () => {
        started++;
      },
      {
        concurrency: 3,
        delayMs: 100,
        now: () => 0,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(started).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("stops on abort and hands back what is left, in order, for resume", async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const fetcher = fakeSite({});
    const items = ["/1", "/2", "/3", "/4", "/5"];
    const left = await runQueue(
      items,
      async (u) => {
        if (u === "/2") controller.abort();
        await fetcher(u, { signal: controller.signal });
        fetched.push(u);
      },
      { concurrency: 1, signal: controller.signal },
    );
    expect(fetched).toEqual(["/1"]);
    expect(left).toEqual(["/2", "/3", "/4", "/5"]);
    const rest = await runQueue(left, async (u) => void fetched.push(u), { concurrency: 2 });
    expect(rest).toEqual([]);
    expect(fetched).toEqual(["/1", "/2", "/3", "/4", "/5"]);
  });
});

describe("pages", () => {
  it("reads served HTML: title, description, canonical, robots, h1, hreflang, words and JSON-LD", () => {
    const facts = readHtml(
      html(
        `<title> Mug  shop </title><meta name="description" content="Mugs."><link rel="canonical" href="/mugs"><meta name="robots" content="noindex">
<link rel="alternate" hreflang="fr" href="/fr/mugs"><link rel="alternate" hreflang="en" href="/mugs">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug"}</script>
<script type="application/ld+json">{"@context":"https://schema.org",}</script>`,
        `<h1>Mugs</h1><p>Two words</p><p>and three more</p><script>var hidden = "not words";</script><h1>Again</h1>`,
      ),
      `${O}/mugs?ref=1`,
      null,
      vocab,
    );
    expect(facts.title).toBe("Mug shop");
    expect(facts.description).toBe("Mugs.");
    expect(facts.canonical).toBe(`${O}/mugs`);
    expect(facts.canonicalState).toBe("other");
    expect(facts.noindex).toBe(true);
    expect(facts.robotsMeta).toBe("noindex");
    expect(facts.h1).toEqual(["Mugs", "Again"]);
    expect(facts.hreflang).toBe(2);
    expect(facts.words).toBe(7);
    expect(facts.jsonld.blocks).toBe(2);
    expect(facts.jsonld.types).toEqual(["Product"]);
    expect(facts.jsonld.findings.some((f) => f.type === "Product" && f.severity === "error" && f.rule === "google.required")).toBe(true);
    expect(facts.jsonld.findings.some((f) => f.type === "(block)" && f.rule === "syntax.json")).toBe(true);
  });

  it("resolves relative links against the page's own <base>, and reads X-Robots-Tag", () => {
    const facts = readHtml(html(`<base href="/en/"><link rel="canonical" href="page">`), `${O}/x`, "googlebot: noindex", vocab);
    expect(facts.canonical).toBe(`${O}/en/page`);
    expect(facts.noindex).toBe(true);
  });

  it("fetches a page: status, redirect, content type, size and time", async () => {
    let clock = 0;
    const fetcher = fakeSite({
      [`${O}/old`]: { redirectTo: `${O}/new`, body: html("<title>New page</title>") },
      [`${O}/file.pdf`]: { type: "application/pdf", body: "%PDF" },
      [`${O}/robots`]: { headers: { "x-robots-tag": "noindex" }, body: html("<title>Hidden</title>") },
    });
    const now = () => (clock += 40);
    const moved = await fetchPage(`${O}/old`, { fetcher, vocab, now, inSitemap: true });
    expect(moved).toMatchObject({
      status: 200,
      finalUrl: `${O}/new`,
      redirected: true,
      html: true,
      title: "New page",
      ms: 40,
      inSitemap: true,
    });
    expect(moved.bytes).toBeGreaterThan(20);
    expect(await fetchPage(`${O}/file.pdf`, { fetcher })).toMatchObject({ html: false, contentType: "application/pdf", title: "" });
    expect(await fetchPage(`${O}/missing`, { fetcher })).toMatchObject({ status: 404, html: false });
    expect(await fetchPage(`${O}/robots`, { fetcher })).toMatchObject({ noindex: true, xRobotsTag: "noindex" });
    const failed = await fetchPage(`${O}/x`, {
      fetcher: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(failed).toMatchObject({ status: 0, error: "Failed to fetch" });
    const controller = new AbortController();
    controller.abort();
    await expect(fetchPage(`${O}/old`, { fetcher, signal: controller.signal })).rejects.toThrow();
  });
});

describe("findings across pages", () => {
  const pages: CrawlPage[] = [
    page({ url: `${O}/`, title: "Acme", description: "Same description used on two pages of the site, long enough." }),
    page({ url: `${O}/a`, title: "Acme", description: "Same description used on two pages of the site, long enough." }),
    page({ url: `${O}/b`, description: null, h1: [] }),
    page({ url: `${O}/c`, noindex: true, title: "Acme" }),
    page({ url: `${O}/d`, canonical: `${O}/`, canonicalState: "other", title: "Acme" }),
    page({ url: `${O}/gone`, status: 404, html: false, title: "", description: null, h1: [] }),
    page({ url: `${O}/old`, redirected: true, finalUrl: `${O}/new` }),
    page({
      url: `${O}/p`,
      jsonld: {
        blocks: 1,
        types: ["Product"],
        findings: [
          { severity: "error", rule: "google.required", message: "Product: missing required offers", path: "#1", type: "Product" },
          { severity: "error", rule: "vocab.property", message: "Unknown property", path: "#1.x", type: "Product" },
          { severity: "warn", rule: "google.recommended", message: "Product: missing recommended sku", path: "#1", type: "Product" },
        ],
      },
    }),
  ];
  const skipped = [{ url: `${O}/private`, reason: "robots" as const, rule: "Disallow: /private" }];
  const findings = crawlFindings(pages, { mode: "rich", skipped });
  const byId = (id: string) => findings.find((f) => f.id === id);

  it("flags duplicates among indexable pages only (noindex and canonicalized pages left out)", () => {
    expect(byId("duplicate-title")?.groups).toEqual([{ value: "Acme", urls: [`${O}/`, `${O}/a`] }]);
    expect(byId("duplicate-description")?.urls).toEqual([`${O}/`, `${O}/a`]);
  });

  it("counts a URL that redirects to a crawled page once in the duplicates", () => {
    const moved = [
      page({ url: `${O}/x`, title: "Same" }),
      page({ url: `${O}/x-old`, title: "Same", redirected: true, finalUrl: `${O}/x` }),
      page({ url: `${O}/y-old`, title: "Other", redirected: true, finalUrl: `${O}/y` }),
    ];
    expect(crawlFindings(moved).find((f) => f.id === "duplicate-title")).toBeUndefined();
  });

  it("flags error statuses, noindex in the sitemap, canonicals elsewhere, redirects, missing tags and robots.txt blocks", () => {
    expect(byId("status")).toMatchObject({ level: "bad", urls: [`${O}/gone`], groups: [{ value: "HTTP 404", urls: [`${O}/gone`] }] });
    expect(byId("noindex-in-sitemap")?.urls).toEqual([`${O}/c`]);
    expect(byId("canonical-elsewhere")?.groups).toEqual([{ value: `${O}/`, urls: [`${O}/d`] }]);
    expect(byId("redirected")?.groups).toEqual([{ value: `${O}/new`, urls: [`${O}/old`] }]);
    expect(byId("missing-description")?.urls).toEqual([`${O}/b`]);
    expect(byId("missing-h1")?.urls).toEqual([`${O}/b`]);
    expect(byId("missing-title")).toBeUndefined();
    expect(byId("robots-blocked")?.groups).toEqual([{ value: "Disallow: /private", urls: [`${O}/private`] }]);
  });

  it("counts JSON-LD errors per type in the chosen mode", () => {
    expect(byId("jsonld-errors")?.groups).toEqual([{ value: "Product: 1 error", urls: [`${O}/p`] }]);
    const schema = crawlFindings(pages, { mode: "schema" });
    expect(schema.find((f) => f.id === "jsonld-errors")?.groups).toEqual([{ value: "Product: 1 error", urls: [`${O}/p`] }]);
    expect(schema.find((f) => f.id === "jsonld-errors")?.title).toContain("Schema.org");
    expect(schema.find((f) => f.id === "jsonld-warnings")).toBeUndefined();
  });

  it("orders findings most severe first and maps them to pages", () => {
    const rank = { bad: 0, warn: 1, info: 2, good: 3 };
    expect(findings.map((f) => rank[f.level])).toEqual([...findings.map((f) => rank[f.level])].sort());
    expect(
      issuesByUrl(findings)
        .get(`${O}/b`)
        ?.map((f) => f.id),
    ).toEqual(["missing-description", "missing-h1"]);
  });

  it("sums up the crawl", () => {
    expect(crawlSummary(pages)).toMatchObject({ pages: 8, ok: 7, errors: 1, redirects: 1, noindex: 1, withJsonLd: 1, avgMs: 100 });
  });

  it("filters and sorts the table", () => {
    const issues = issuesByUrl(findings);
    const ctx = { mode: "rich" as const, issues };
    expect(filterPages(pages, { filter: "errors", ...ctx }).map((p) => p.url)).toEqual([`${O}/gone`]);
    expect(filterPages(pages, { filter: "jsonld-errors", ...ctx }).map((p) => p.url)).toEqual([`${O}/p`]);
    expect(filterPages(pages, { filter: "all", query: "404", ...ctx }).map((p) => p.url)).toEqual([`${O}/gone`]);
    expect(sortPages(pages, "status", "desc", ctx)[0]!.url).toBe(`${O}/gone`);
    expect(sortPages(pages, "url", "asc", ctx).map((p) => p.url)[0]).toBe(`${O}/`);
  });
});

describe("exports", () => {
  it("writes CSV cells safely: quotes, newlines and formula-like text", () => {
    expect(csvCell('Say "hi", then')).toBe('"Say ""hi"", then"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("exports one CSV row per page with the JSON-LD counts of the mode", () => {
    const p = page({
      url: `${O}/p`,
      title: 'Mugs, "the best"',
      jsonld: {
        blocks: 1,
        types: ["Product"],
        findings: [{ severity: "error", rule: "google.required", message: "x", path: "#1", type: "Product" }],
      },
    });
    const csv = crawlCsv([p], "rich");
    const [header, row] = csv.trimEnd().split("\r\n");
    expect(header!.split(",")).toContain("jsonld_errors");
    expect(row).toContain('"Mugs, ""the best"""');
    const cols = header!.split(",");
    expect(row!.split(",")[cols.indexOf("status")]).toBe("200");
    expect(crawlCsv([p], "schema").trimEnd().split("\r\n")[1]).not.toBe(row);
  });

  it("exports JSON with the summary and findings", () => {
    const data = JSON.parse(
      crawlJson({
        origin: O,
        crawledAt: "2026-11-20T00:00:00.000Z",
        settings: DEFAULT_CRAWL_SETTINGS,
        mode: "rich",
        sitemaps: [],
        pages: [page({ url: `${O}/`, description: null })],
        skipped: [],
        pending: [`${O}/next`],
      }),
    );
    expect(data.summary.pages).toBe(1);
    expect(data.findings[0].id).toBe("missing-description");
    expect(data.pending).toEqual([`${O}/next`]);
  });

  it("writes a Markdown summary for a coding agent", () => {
    const pages = [
      page({ url: `${O}/`, title: "Acme" }),
      page({ url: `${O}/a`, title: "Acme" }),
      page({ url: `${O}/gone`, status: 404, html: false }),
    ];
    const md = crawlMarkdown({ origin: O, pages, skipped: [], pending: [], mode: "rich", sitemaps: [] });
    expect(md).toContain("## Site crawl");
    expect(md).toContain("Pages answering an error");
    expect(md).toContain("`/gone`");
    expect(md).toContain('"Acme"');
    expect(md).toContain("served HTML");
    const clean = crawlMarkdown({ origin: O, pages: [page({ url: `${O}/` })], skipped: [], pending: [], mode: "rich", sitemaps: [] });
    expect(clean).toContain("No problem found");
  });
});
