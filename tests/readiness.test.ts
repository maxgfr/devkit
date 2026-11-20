import { describe, expect, it } from "vitest";
import { readinessMarkdown, readinessReport } from "../src/lib/agent/agents";
import { analyzeJsonLd } from "../src/lib/jsonld";
import type { SemanticsSnapshot, WebMcpSnapshot, WebMcpTool } from "../src/lib/page/webmcp";
import {
  AI_CRAWLERS,
  crawlerAccess,
  isTextFile,
  parseAiTxt,
  parseLlmsTxt,
  type ReadinessInputs,
  readinessScore,
} from "../src/lib/readiness";
import { hasOwnGroup, isAllowed, parseRobots } from "../src/lib/site-files";
import { analyzeTools } from "../src/lib/webmcp";

// Shaped like lemonde.fr's robots.txt (November 2026): `*` open but for some folders, Google-Extended blocked but for
// a few sections, and a long list of bots shut out, seven of them AI crawlers of AI_CRAWLERS.
const LEMONDE_LIKE = `User-agent: *
Allow: /ws/1/live/*
Disallow: /ajax/
Disallow: /api/
Sitemap: https://www.lemonde.fr/sitemap_news.xml
Sitemap: https://www.lemonde.fr/sitemap_index.xml

User-agent: Googlebot-Image
Allow: /image/

User-agent: Google-Extended
Allow: /innovation-et-mobilite/
Disallow: /

User-agent: Spider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: Bytespider
Disallow: /
`;

const SEMANTICS_OK: SemanticsSnapshot = { lang: "en", h1: 1, main: 1, nav: 1, fields: 0, unlabelled: [] };
const NO_API: WebMcpSnapshot = {
  url: "https://a.test/",
  secureContext: true,
  apis: {
    document: { present: false, methods: [] },
    navigator: { present: false, methods: [] },
    testing: { present: false, methods: [] },
  },
  enumerable: false,
  executable: false,
  tools: [],
  errors: [],
};
const WITH_API: WebMcpSnapshot = {
  ...NO_API,
  apis: { ...NO_API.apis, document: { present: true, methods: ["registerTool", "getTools", "executeTool"] } },
  enumerable: true,
  executable: true,
};
const jsonLd = (...blocks: string[]) => analyzeJsonLd(blocks.map((raw, index) => ({ raw, index })));
const ORG = '{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://a.test/"}';
const SITE = '{"@context":"https://schema.org","@type":"WebSite","name":"Acme","url":"https://a.test/"}';
const LLMS = parseLlmsTxt(
  "https://a.test/llms.txt",
  200,
  "text/plain",
  "# Acme\n\n> The Acme shop.\n\n## Docs\n\n- [Mugs](https://a.test/mugs): all mugs\n",
);

const base = (over: Partial<ReadinessInputs> = {}): ReadinessInputs => ({
  jsonLd: null,
  webmcp: NO_API,
  tools: [],
  semantics: SEMANTICS_OK,
  ...over,
});
const area = (inputs: ReadinessInputs, id: string) => readinessScore(inputs).areas.find((a) => a.id === id)!;
const tool = (t: Partial<WebMcpTool> & { name: string }): WebMcpTool => ({
  description: "",
  inputSchema: { type: "object", properties: {} },
  annotations: null,
  sources: ["document.modelContext"],
  ...t,
});

describe("readinessScore", () => {
  it("has seven areas whose maxima sum to 100, and a total that is their sum", () => {
    const r = readinessScore(base());
    expect(r.areas.map((a) => [a.label, a.max])).toEqual([
      ["Structured data", 25],
      ["Agent tool availability", 15],
      ["Tool descriptions", 15],
      ["Input schemas", 15],
      ["Safety", 15],
      ["Testability", 10],
      ["Accessibility & semantics", 5],
    ]);
    expect(r.areas.reduce((n, a) => n + a.max, 0)).toBe(100);
    for (const a of r.areas) expect(a.rules.reduce((n, x) => n + x.max, 0)).toBe(a.max);
    expect(r.total).toBe(r.areas.reduce((n, a) => n + a.score, 0));
    // No JSON-LD, no tools: safety (nothing to trigger) and semantics only.
    expect(r.total).toBe(20);
  });

  it("scores structured data: presence, validity, Organization, WebSite, errors, llms.txt", () => {
    expect(area(base({ jsonLd: jsonLd(ORG, SITE), llms: LLMS }), "structured").score).toBe(25);
    expect(area(base({ jsonLd: jsonLd(ORG, SITE) }), "structured").score).toBe(23);
    expect(area(base({ jsonLd: jsonLd(ORG) }), "structured").score).toBe(20);
    // One block of two does not parse, and that is an error.
    const broken = area(base({ jsonLd: jsonLd(ORG, "{bad") }), "structured");
    expect(broken.rules.find((r) => r.label === "Every block is valid JSON")!.points).toBe(2.5);
    expect(broken.rules.find((r) => r.label === "No schema errors")!.points).toBe(0);
    expect(area(base({ jsonLd: jsonLd() }), "structured").score).toBe(0);
  });

  it("gives full Safety and no tool points when there is no tool, and says why", () => {
    const r = readinessScore(base());
    const safety = r.areas.find((a) => a.id === "safety")!;
    expect(safety.score).toBe(15);
    expect(safety.rules[0]!.detail).toMatch(/No tool, so no risky tool/);
    for (const id of ["availability", "descriptions", "schemas", "testability"]) expect(area(base(), id).score).toBe(0);
    expect(r.recommendations.some((x) => /Expose the page's key actions as WebMCP tools/.test(x.text))).toBe(true);
  });

  it("scores well-made tools at the top of every tool area", () => {
    const tools = analyzeTools([
      tool({
        name: "search_products",
        description: "Searches the catalog by keyword and returns matching products.",
        inputSchema: { type: "object", properties: { q: { type: "string", description: "Keywords" } }, required: ["q"] },
        annotations: { readOnlyHint: true },
      }),
      tool({
        name: "add_to_cart",
        description: "Adds a product to the shopping cart; the user can remove it later.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "Product id" } }, required: ["id"] },
        annotations: { readOnlyHint: false },
      }),
    ]);
    const inputs = base({ webmcp: WITH_API, tools, jsonLd: jsonLd(ORG, SITE), llms: LLMS });
    const r = readinessScore(inputs);
    expect(r.areas.map((a) => a.score)).toEqual([25, 15, 15, 15, 15, 10, 5]);
    expect(r.total).toBe(100);
  });

  it("takes Safety points for an unannotated Critical tool and contradictions", () => {
    const tools = analyzeTools([
      tool({ name: "delete_account", description: "Deletes the user's account permanently." }),
      tool({ name: "remove_item", description: "Removes an item from the list.", annotations: { readOnlyHint: true } }),
      tool({ name: "get_profile", description: "Returns the profile of the signed-in user." }),
    ]);
    const s = area(base({ webmcp: WITH_API, tools }), "safety");
    expect(s.rules.map((r) => r.points)).toEqual([0, 0, 0, 0]);
    expect(s.score).toBe(0);
    const recs = readinessScore(base({ webmcp: WITH_API, tools })).recommendations;
    expect(recs[0]!.impact).toBe("high");
    expect(recs.some((x) => x.impact === "high" && /Mark delete_account with consequentialHint/.test(x.text))).toBe(true);
    expect(recs.some((x) => /contradictory annotations of remove_item/.test(x.text))).toBe(true);
    expect(recs.some((x) => x.impact === "low" && /Set readOnlyHint: true on get_profile/.test(x.text))).toBe(true);
    const flagged = analyzeTools([
      tool({ name: "delete_account", description: "Deletes the account; cannot be undone.", annotations: { consequentialHint: true } }),
    ]);
    expect(area(base({ webmcp: WITH_API, tools: flagged }), "safety").score).toBe(15);
  });

  it("scores testability from the API that lists and runs the tools", () => {
    const declarative = analyzeTools([tool({ name: "book_table", description: "Books a table.", sources: ["declarative"] })]);
    const t = area(base({ webmcp: NO_API, tools: declarative }), "testability");
    expect(t.rules.map((r) => r.points)).toEqual([0, 0, 2]);
    expect(area(base({ webmcp: NO_API, tools: declarative }), "availability").score).toBe(9);
    const listed = analyzeTools([tool({ name: "get_x", description: "Gets the x of the page." })]);
    expect(area(base({ webmcp: WITH_API, tools: listed }), "testability").score).toBe(10);
  });

  it("scores descriptions and schemas as averages", () => {
    const tools = analyzeTools([
      tool({
        name: "get_a",
        description: "Returns the a of the page, by id.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "Id" } } },
      }),
      tool({ name: "get_b", description: "", inputSchema: null }),
    ]);
    const inputs = base({ webmcp: WITH_API, tools });
    expect(area(inputs, "descriptions").rules[0]!.detail).toBe("1 of 2");
    expect(area(inputs, "descriptions").score).toBe(Math.round(3 + 9 * 0.5));
    const schemas = area(inputs, "schemas");
    expect(schemas.rules[0]!.detail).toBe("1 of 2");
    expect(schemas.score).toBe(Math.round(3.5 + 8 * 0.6));
    const recs = readinessScore(inputs).recommendations.map((r) => r.text);
    expect(recs).toContain("Give get_b an inputSchema.");
    expect(recs.some((x) => /Improve the description of get_b/.test(x))).toBe(true);
  });

  it("scores semantics (heuristic): lang, one h1, main, nav, labelled fields", () => {
    expect(area(base(), "semantics").score).toBe(5);
    const poor = base({ semantics: { lang: "", h1: 2, main: 0, nav: 0, fields: 4, unlabelled: ['input[name="a"]', 'input[name="b"]'] } });
    expect(area(poor, "semantics").rules.map((r) => r.points)).toEqual([0, 0, 0, 0, 0.5]);
    const recs = readinessScore(poor).recommendations.map((r) => r.text);
    expect(recs).toEqual(
      expect.arrayContaining(['Set <html lang="…">.', "Keep one h1 (the page has 2).", "Wrap the main content in <main>."]),
    );
    expect(area(base({ semantics: null }), "semantics").score).toBe(0);
  });

  it("recommends llms.txt, flags blocked crawlers (may be intentional) and a missing sitemap", () => {
    const robots = parseRobots(LEMONDE_LIKE);
    const r = readinessScore(
      base({
        jsonLd: jsonLd(ORG, SITE),
        llms: parseLlmsTxt("https://a.test/llms.txt", 404, "text/html", "<!doctype html><title>Not found</title>"),
        crawlers: crawlerAccess(robots, "/"),
        sitemap: { url: "https://a.test/sitemap.xml", found: false },
      }),
    );
    const texts = r.recommendations.map((x) => `${x.impact}: ${x.text}`);
    expect(texts.some((t) => t.startsWith("medium: Add an /llms.txt file"))).toBe(true);
    expect(texts).toContain(
      "low: 7 AI crawler(s) are disallowed in robots.txt (may be intentional): ClaudeBot, anthropic-ai, Google-Extended, CCBot, Applebot-Extended, Bytespider, Amazonbot.",
    );
    expect(texts.some((t) => t.startsWith("low: No sitemap found"))).toBe(true);
    // The crawler conventions are information: they do not change the score.
    expect(r.total).toBe(readinessScore(base({ jsonLd: jsonLd(ORG, SITE), llms: { ...LLMS, present: false } })).total);
  });
});

describe("AI crawlers", () => {
  it("lists every crawler once with an operator and a purpose", () => {
    const agents = AI_CRAWLERS.map((c) => c.agent);
    expect(new Set(agents).size).toBe(agents.length);
    expect(agents).toEqual(
      expect.arrayContaining([
        "GPTBot",
        "OAI-SearchBot",
        "ChatGPT-User",
        "ClaudeBot",
        "Claude-User",
        "Claude-SearchBot",
        "anthropic-ai",
        "Google-Extended",
        "CCBot",
        "PerplexityBot",
        "Perplexity-User",
        "Applebot-Extended",
        "Bytespider",
        "Amazonbot",
        "Meta-ExternalAgent",
        "cohere-ai",
      ]),
    );
    for (const c of AI_CRAWLERS) {
      expect(c.operator).toBeTruthy();
      expect(["training", "search", "user"]).toContain(c.purpose);
    }
  });

  it("checks a lemonde-like robots.txt: 9 allowed, 7 blocked", () => {
    const access = crawlerAccess(parseRobots(LEMONDE_LIKE), "/innovation-et-mobilite/article");
    const blocked = access.filter((c) => !c.root.allowed).map((c) => c.agent);
    expect(blocked).toEqual(["ClaudeBot", "anthropic-ai", "Google-Extended", "CCBot", "Applebot-Extended", "Bytespider", "Amazonbot"]);
    expect(access.length - blocked.length).toBe(9);
    const google = access.find((c) => c.agent === "Google-Extended")!;
    expect(google.root).toEqual({ allowed: false, rule: "Disallow: /" });
    // Allowed on the section its group opens.
    expect(google.page.allowed).toBe(true);
    expect(google.named).toBe(true);
    expect(access.find((c) => c.agent === "GPTBot")!.named).toBe(false);
    // "Spider" is a substring of "Bytespider"; Claude-User falls to `*`, not to ClaudeBot.
    expect(access.find((c) => c.agent === "Claude-User")!.root.allowed).toBe(true);
  });

  it("allows everything without a robots.txt", () => {
    expect(crawlerAccess(null, "/").every((c) => c.root.allowed && c.page.allowed && !c.named)).toBe(true);
  });

  it("picks the group with the most specific user-agent token", () => {
    const robots = parseRobots("User-agent: Applebot\nDisallow: /\n\nUser-agent: Applebot-Extended\nAllow: /\n");
    expect(isAllowed(robots, "Applebot-Extended", "/").allowed).toBe(true);
    expect(isAllowed(robots, "Applebot", "/").allowed).toBe(false);
    expect(hasOwnGroup(robots, "Applebot-Extended")).toBe(true);
    expect(hasOwnGroup(parseRobots("User-agent: *\nDisallow:\n"), "GPTBot")).toBe(false);
  });
});

describe("agent files", () => {
  it("tells a text file from an HTML error page", () => {
    expect(isTextFile(200, "text/plain", "# Hi")).toBe(true);
    expect(isTextFile(200, "text/markdown; charset=utf-8", "# Hi")).toBe(true);
    expect(isTextFile(200, "text/html", "<!doctype html>")).toBe(false);
    expect(isTextFile(200, "", "<!DOCTYPE html><html>")).toBe(false);
    expect(isTextFile(402, "text/plain", "# Hi")).toBe(false);
    expect(isTextFile(0, "", "")).toBe(false);
    expect(isTextFile(200, "text/plain", "   ")).toBe(false);
  });

  it("parses llms.txt: title, summary, sections, links, size", () => {
    expect(LLMS).toEqual({
      url: "https://a.test/llms.txt",
      status: 200,
      present: true,
      bytes: 75,
      title: "Acme",
      summary: "The Acme shop.",
      sections: ["Docs"],
      links: 1,
    });
    expect(parseLlmsTxt("u", 404, "text/plain", "nope").present).toBe(false);
  });

  it("parses ai.txt opt-outs", () => {
    expect(parseAiTxt("u", 200, "text/plain", "User-Agent: *\nDisallow: /\n")).toMatchObject({
      present: true,
      optOutAll: true,
      optOutPartial: false,
    });
    expect(parseAiTxt("u", 200, "text/plain", "User-Agent: *\nDisallow: *.jpg\nDisallow: *.png\nAllow: /\n")).toMatchObject({
      optOutAll: false,
      optOutPartial: true,
    });
    expect(parseAiTxt("u", 200, "text/plain", "User-Agent: *\nAllow: /\n")).toMatchObject({ optOutAll: false, optOutPartial: false });
    expect(parseAiTxt("u", 404, "text/html", "").present).toBe(false);
  });
});

describe("readiness reports", () => {
  it("copies the score, breakdown, files, crawlers and recommendations", () => {
    const inputs = base({
      jsonLd: jsonLd(ORG),
      llms: { ...LLMS, present: false },
      crawlers: crawlerAccess(parseRobots(LEMONDE_LIKE), "/"),
      sitemap: { url: "https://www.lemonde.fr/sitemap_news.xml", found: true },
    });
    const r = readinessScore(inputs);
    const report = readinessReport(r, inputs, { url: "https://a.test/" });
    expect(report).toMatch(/^# Agent readiness: \d+\/100/);
    expect(report).toContain("not a guarantee of compatibility");
    expect(report).toContain("- Structured data: 20/25");
    expect(report).toContain("## AI crawlers (robots.txt): 9 allowed · 7 blocked");
    expect(report).toContain("- llms.txt: none");
    expect(report).toContain("## Medium impact");
    const md = readinessMarkdown(r, inputs, { url: "https://a.test/" });
    expect(md).toMatch(/^## Agent readiness/);
    expect(md).toContain("### To fix");
    expect(md).toContain("Medium impact: Add an /llms.txt file");
    expect(md).toContain("### Worth checking");
  });
});
