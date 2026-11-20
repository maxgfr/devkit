import { afterEach, describe, expect, it, vi } from "vitest";
import { agentToolsMarkdown } from "../src/lib/agent/agents";
import { collectSemantics, collectWebMcp, executeWebMcpTool, type WebMcpTool } from "../src/lib/page/webmcp";
import { analyzeTool, analyzeTools, buildArgs, confirmSteps, formFields, maskArgs, nameStyle, nameWords } from "../src/lib/webmcp";

type Loose = Record<string, unknown>;
const doc = document as unknown as Loose;
const nav = navigator as unknown as Loose;

afterEach(() => {
  delete doc.modelContext;
  delete nav.modelContext;
  delete nav.modelContextTesting;
  document.body.innerHTML = "";
  document.documentElement.lang = "";
});

const tool = (t: Partial<WebMcpTool> & { name: string }): WebMcpTool => ({
  description: "",
  inputSchema: { type: "object", properties: {} },
  annotations: null,
  sources: ["document.modelContext"],
  ...t,
});

describe("collectWebMcp", () => {
  it("reports no API and no tool on a plain page", async () => {
    const snap = await collectWebMcp();
    expect(snap.apis.document.present).toBe(false);
    expect(snap.apis.navigator.present).toBe(false);
    expect(snap.apis.testing.present).toBe(false);
    expect(snap.enumerable).toBe(false);
    expect(snap.executable).toBe(false);
    expect(snap.tools).toEqual([]);
  });

  it("lists tools from document.modelContext.getTools (spec)", async () => {
    doc.modelContext = {
      registerTool: () => undefined,
      executeTool: async () => "{}",
      getTools: async () => [
        {
          name: "search_products",
          title: "Search",
          description: "Search the catalog by keyword and return matching products.",
          inputSchema: { type: "object", properties: { q: { type: "string", description: "Keywords" } }, required: ["q"] },
          annotations: { readOnlyHint: true },
          origin: "https://shop.test",
          execute: () => undefined,
        },
      ],
    };
    const snap = await collectWebMcp();
    expect(snap.apis.document).toEqual({ present: true, methods: ["registerTool", "getTools", "executeTool"] });
    expect(snap.enumerable).toBe(true);
    expect(snap.executable).toBe(true);
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]).toMatchObject({
      name: "search_products",
      title: "Search",
      annotations: { readOnlyHint: true },
      sources: ["document.modelContext"],
      origin: "https://shop.test",
    });
    // Functions are dropped: the snapshot must be JSON-clonable.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("lists tools from navigator.modelContextTesting.listTools with string schemas (early preview)", async () => {
    nav.modelContextTesting = {
      listTools: () => [
        { name: "get_order", description: "Get an order", inputSchema: '{"type":"object","properties":{"id":{"type":"string"}}}' },
        { name: "broken", description: "x", inputSchema: "{not json" },
      ],
      executeTool: async () => "{}",
    };
    nav.modelContext = { registerTool: () => undefined, provideContext: () => undefined, clearContext: () => undefined };
    const snap = await collectWebMcp();
    expect(snap.apis.navigator.methods).toEqual(["registerTool", "provideContext", "clearContext"]);
    expect(snap.apis.testing.methods).toEqual(["listTools", "executeTool"]);
    expect(snap.tools[0]!.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(snap.tools[0]!.sources).toEqual(["navigator.modelContextTesting"]);
    expect(snap.tools[1]!.inputSchema).toBeNull();
    expect(snap.tools[1]!.inputSchemaError).toBe("{not json");
  });

  it("merges the same tool listed by two APIs and records errors", async () => {
    const t = { name: "a_tool", description: "d" };
    doc.modelContext = { getTools: async () => [t] };
    nav.modelContextTesting = { listTools: () => [t] };
    nav.modelContext = {
      getTools: () => {
        throw new Error("boom");
      },
    };
    const snap = await collectWebMcp();
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]!.sources).toEqual(["document.modelContext", "navigator.modelContextTesting"]);
    expect(snap.errors).toEqual(["navigator.modelContext.getTools(): boom"]);
  });

  it("reads declarative tools from form[toolname]", async () => {
    document.body.innerHTML = `
      <form id="book" toolname="book_table" tooldescription="Book a table at the restaurant." action="/book" method="post">
        <label for="n">Name</label><input id="n" name="name" required toolparamdescription="Guest name">
        <input name="guests" type="number" min="1" max="12" step="1" required toolparamdescription="How many guests">
        <input name="email" type="email">
        <select name="time" toolparamdescription="Slot"><option value="">Pick</option><option value="19:00">7 pm</option><option value="20:00">8 pm</option></select>
        <input name="terrace" type="checkbox">
        <input name="seat" type="radio" value="inside"><input name="seat" type="radio" value="outside">
        <input name="csrf" type="hidden" value="x">
        <button type="submit">Book</button>
      </form>`;
    const snap = await collectWebMcp();
    expect(snap.tools).toHaveLength(1);
    const t = snap.tools[0]!;
    expect(t).toMatchObject({
      name: "book_table",
      description: "Book a table at the restaurant.",
      sources: ["declarative"],
      form: { selector: "#book", autosubmit: false, method: "post" },
    });
    const schema = t.inputSchema as { properties: Record<string, Loose>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["name", "guests", "email", "time", "terrace", "seat"]);
    expect(schema.properties.name).toEqual({ type: "string", description: "Guest name", title: "Name" });
    expect(schema.properties.guests).toMatchObject({ type: "integer", minimum: 1, maximum: 12, description: "How many guests" });
    expect(schema.properties.email).toMatchObject({ type: "string", format: "email" });
    expect(schema.properties.time).toMatchObject({ type: "string", enum: ["19:00", "20:00"], description: "Slot" });
    expect(schema.properties.terrace).toEqual({ type: "boolean" });
    expect(schema.properties.seat).toEqual({ type: "string", enum: ["inside", "outside"] });
    expect(schema.required).toEqual(["name", "guests"]);
  });
});

describe("executeWebMcpTool", () => {
  it("runs through document.modelContext.executeTool with the Tool and an object", async () => {
    const listed = { name: "add", description: "Add numbers" };
    const executeTool = vi.fn(async (_t: unknown, args: { a: number; b: number }) => JSON.stringify({ sum: args.a + args.b }));
    doc.modelContext = { getTools: async () => [listed], executeTool };
    const run = await executeWebMcpTool("add", '{"a":2,"b":3}');
    expect(run.ok).toBe(true);
    expect(run.via).toBe("document.modelContext");
    expect(JSON.parse(run.result!)).toEqual({ sum: 5 });
    expect(executeTool.mock.calls[0]![0]).toBe(listed);
    expect(executeTool.mock.calls[0]![1]).toEqual({ a: 2, b: 3 });
  });

  it("falls back to navigator.modelContextTesting.executeTool(name, json)", async () => {
    const executeTool = vi.fn(async (_n: string, json: string) => `echo ${json}`);
    nav.modelContextTesting = { listTools: () => [], executeTool };
    const run = await executeWebMcpTool("get_order", '{"id":"42"}');
    expect(run).toMatchObject({ ok: true, via: "navigator.modelContextTesting", result: 'echo {"id":"42"}' });
    expect(executeTool).toHaveBeenCalledWith("get_order", '{"id":"42"}');
  });

  it("returns the tool's error, and gives up after the timeout", async () => {
    doc.modelContext = {
      getTools: async () => [{ name: "fail" }, { name: "hang" }],
      executeTool: (t: { name: string }) => (t.name === "fail" ? Promise.reject(new TypeError("bad input")) : new Promise(() => undefined)),
    };
    expect(await executeWebMcpTool("fail", "{}")).toMatchObject({ ok: false, error: "TypeError: bad input" });
    const hang = await executeWebMcpTool("hang", "{}", 30);
    expect(hang.ok).toBe(false);
    expect(hang.error).toMatch(/did not answer/);
  });

  it("rejects arguments that are not a JSON object, and pages without an API", async () => {
    expect(await executeWebMcpTool("x", "[1]")).toMatchObject({ ok: false, error: "Arguments must be a JSON object." });
    expect((await executeWebMcpTool("x", "{")).ok).toBe(false);
    expect((await executeWebMcpTool("x", "{}")).error).toMatch(/No WebMCP API/);
  });

  it("fills a declarative form and never submits it", async () => {
    document.body.innerHTML = `<form toolname="subscribe" tooldescription="Subscribe to the newsletter" toolautosubmit>
      <input name="email"><input name="daily" type="checkbox"><select name="topic"><option value="a">A</option><option value="b">B</option></select>
      <button type="submit">Go</button></form>`;
    const form = document.querySelector("form")!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener("submit", submitted);
    const executeTool = vi.fn();
    doc.modelContext = { getTools: async () => [{ name: "subscribe" }], executeTool };
    const run = await executeWebMcpTool("subscribe", '{"email":"a@b.test","daily":true,"topic":"b"}');
    expect(run).toMatchObject({ ok: true, via: "declarative", filled: true });
    expect(run.result).toMatch(/does not submit/);
    expect((form.elements.namedItem("email") as HTMLInputElement).value).toBe("a@b.test");
    expect((form.elements.namedItem("daily") as HTMLInputElement).checked).toBe(true);
    expect((form.elements.namedItem("topic") as HTMLSelectElement).value).toBe("b");
    expect(submitted).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("collectSemantics", () => {
  it("counts lang, h1, landmarks and unlabelled fields", () => {
    document.documentElement.lang = "fr";
    document.body.innerHTML = `<nav></nav><main><h1>A</h1><h1>B</h1>
      <label>Name <input name="name"></label><label for="e">Email</label><input id="e" name="email">
      <input name="q" aria-label="Search"><input name="zip"><textarea name="msg"></textarea><input type="hidden" name="t"><button>Go</button></main>`;
    expect(collectSemantics()).toEqual({
      lang: "fr",
      h1: 2,
      main: 1,
      nav: 1,
      fields: 5,
      unlabelled: ['input[name="zip"]', 'textarea[name="msg"]'],
    });
  });
});

describe("tool names", () => {
  it("splits and classifies names", () => {
    expect(nameWords("deleteAccount")).toEqual(["delete", "account"]);
    expect(nameWords("search_products")).toEqual(["search", "products"]);
    expect(nameWords("get-HTMLPage")).toEqual(["get", "html", "page"]);
    expect(nameStyle("search_products")).toBe("snake_case");
    expect(nameStyle("searchProducts")).toBe("camelCase");
    expect(nameStyle("search-products")).toBe("kebab-case");
    expect(nameStyle("SearchProducts")).toBe("PascalCase");
    expect(nameStyle("search")).toBe("lowercase");
    expect(nameStyle("search_Products-x")).toBe("mixed");
  });

  it("flags empty, invalid, long, non-verb and off-convention names", () => {
    expect(analyzeTool(tool({ name: "" })).findings.some((f) => f.area === "name" && f.level === "bad")).toBe(true);
    expect(analyzeTool(tool({ name: "search products" })).findings.map((f) => f.message)).toContain(
      "Use letters, digits, _ - and . only: spaces and other characters break some agents",
    );
    expect(analyzeTool(tool({ name: `get_${"x".repeat(70)}` })).findings.some((f) => /under 64/.test(f.message))).toBe(true);
    expect(analyzeTool(tool({ name: "products_search" })).findings.some((f) => /Start the name with a verb/.test(f.message))).toBe(true);
    const all = analyzeTools([tool({ name: "get_a" }), tool({ name: "get_b" }), tool({ name: "getC" })]);
    expect(all[2]!.findings.map((f) => f.message)).toContain("Name is camelCase while the page's other tools use snake_case");
    expect(all[0]!.findings.some((f) => /while the page/.test(f.message))).toBe(false);
  });
});

describe("risk classification", () => {
  const risk = (t: Partial<WebMcpTool> & { name: string }) => analyzeTool(tool(t)).risk;
  it("Low for read-only tools", () => {
    expect(risk({ name: "get_weather", annotations: { readOnlyHint: true } })).toBe("low");
    expect(risk({ name: "search_flights" })).toBe("low");
    expect(analyzeTool(tool({ name: "search_flights" })).riskReasons[0]).toMatch(/rests on the name only/);
  });
  it("Medium for reversible writes", () => {
    expect(risk({ name: "add_to_cart" })).toBe("medium");
    expect(risk({ name: "frobnicate" })).toBe("medium");
  });
  it("High for destructive hints and sensitive verbs", () => {
    expect(risk({ name: "delete_item" })).toBe("high");
    expect(risk({ name: "send_message" })).toBe("high");
    expect(risk({ name: "publish_post" })).toBe("high");
    expect(risk({ name: "update_item", annotations: { consequentialHint: true } })).toBe("high");
    expect(risk({ name: "update_item", annotations: { destructiveHint: true } })).toBe("high");
  });
  it("Critical for money, account deletion and credentials", () => {
    expect(risk({ name: "delete_account" })).toBe("critical");
    expect(risk({ name: "deleteAccount" })).toBe("critical");
    expect(risk({ name: "checkout" })).toBe("critical");
    expect(risk({ name: "buy_now" })).toBe("critical");
    expect(risk({ name: "pay_invoice" })).toBe("critical");
    expect(risk({ name: "change_password" })).toBe("critical");
    expect(risk({ name: "confirm_cart", description: "Places an order and charges the card on file." })).toBe("critical");
    // A read-only tool that only mentions payments in its description stays Low.
    expect(risk({ name: "list_invoices", description: "Lists the payment history.", annotations: { readOnlyHint: true } })).toBe("low");
    expect(risk({ name: "get_order_status", annotations: { readOnlyHint: true } })).toBe("low");
  });
  it("asks for more confirmation steps as risk rises", () => {
    expect([confirmSteps("low"), confirmSteps("medium"), confirmSteps("high"), confirmSteps("critical")]).toEqual([0, 1, 2, 2]);
  });
});

describe("annotations", () => {
  const messages = (t: Partial<WebMcpTool> & { name: string }) => analyzeTool(tool(t)).findings.filter((f) => f.area === "annotations");
  it("flags contradictions", () => {
    const a = analyzeTool(tool({ name: "delete_item", annotations: { readOnlyHint: true } }));
    expect(a.contradictory).toBe(true);
    expect(a.findings.some((f) => f.level === "bad" && /readOnlyHint is true but/.test(f.message))).toBe(true);
    const both = analyzeTool(tool({ name: "get_x", annotations: { readOnlyHint: true, destructiveHint: true } }));
    expect(both.contradictory).toBe(true);
    expect(
      messages({ name: "remove_user", annotations: { destructiveHint: false } }).some((f) => /destructiveHint is false/.test(f.message)),
    ).toBe(true);
  });
  it("asks for annotations on sensitive and read tools", () => {
    expect(messages({ name: "delete_account" })[0]).toMatchObject({ level: "bad" });
    expect(messages({ name: "get_weather" })[0]!.message).toMatch(/Set readOnlyHint: true/);
    expect(messages({ name: "delete_account", annotations: { consequentialHint: true } }).filter((f) => f.level === "bad")).toEqual([]);
    expect(messages({ name: "x_tool", annotations: { fancyHint: true, readOnlyHint: "yes" } }).map((f) => f.message)).toEqual([
      'Unknown annotation "fancyHint"',
      'readOnlyHint should be true or false, not "yes"',
    ]);
    expect(messages({ name: "x_tool" }).map((f) => f.message)).toEqual(["No annotations: agents treat it as a tool that changes state"]);
  });
});

describe("descriptions", () => {
  const d = (t: Partial<WebMcpTool> & { name: string }) =>
    analyzeTool(tool(t))
      .findings.filter((f) => f.area === "description")
      .map((f) => f.message);
  it("checks presence, length, repetition and effects", () => {
    expect(d({ name: "get_x" })[0]).toMatch(/No description/);
    expect(d({ name: "get_x", description: "Gets x" })[0]).toMatch(/is 6 characters/);
    expect(d({ name: "get_x", description: "y".repeat(501) })[0]).toMatch(/past 500/);
    expect(d({ name: "search_products", description: "search products" })).toContain("Description only repeats the name");
    expect(d({ name: "add_item", description: "The item tool for the shopping list." })).toContain(
      "Say what the tool changes (creates, sends, deletes…) so agents and users know its effect",
    );
    expect(d({ name: "add_item", description: "Adds an item to the shopping list." })).toEqual([]);
    const good = analyzeTool(
      tool({ name: "get_weather", description: "Returns the forecast for a city.", annotations: { readOnlyHint: true } }),
    );
    expect(good.descriptionScore).toBe(1);
    expect(analyzeTool(tool({ name: "get_weather" })).descriptionScore).toBe(0);
  });
});

describe("input schemas", () => {
  const s = (inputSchema: unknown) => analyzeTool(tool({ name: "get_x", inputSchema })).findings.filter((f) => f.area === "input");
  it("accepts a typed, described schema", () => {
    const a = analyzeTool(
      tool({
        name: "get_x",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string", description: "Query" }, n: { type: "integer", description: "Max" } },
          required: ["q"],
        },
      }),
    );
    expect(a.findings.filter((f) => f.area === "input")).toEqual([]);
    expect(a.schemaScore).toBe(1);
  });
  it("flags missing, invalid and inconsistent schemas", () => {
    expect(s(null)[0]!.message).toMatch(/No inputSchema/);
    expect(s("x")[0]!.message).toBe("inputSchema is not a JSON Schema object");
    expect(
      analyzeTool(tool({ name: "x", inputSchema: null, inputSchemaError: "{" })).findings.some((f) => /not valid JSON/.test(f.message)),
    ).toBe(true);
    expect(s({ type: "string" })[0]!.message).toMatch(/must be "object"/);
    expect(s({ type: "object", properties: { a: { type: "string", description: "A" } }, required: ["a", "b"] })[0]!.message).toBe(
      'inputSchema: required lists "b", not in properties',
    );
    const loose = s({ type: "object", properties: { a: {}, b: { type: "strin", description: "B" } } }).map((f) => f.message);
    expect(loose).toContain("Parameter without a type (accept anything): a");
    expect(loose).toContain("Parameter without a description: a");
    expect(loose).toContain('b: "strin" is not a JSON Schema type');
    const enums = s({
      type: "object",
      properties: {
        e: { type: "string", enum: [], description: "E" },
        f: { type: "string", enum: ["a", "a"], description: "F" },
        g: { type: "string", enum: ["a", 1], description: "G" },
        h: { type: "string", enum: ["only"], description: "H" },
        l: { type: "array", description: "L" },
      },
    }).map((f) => f.message);
    expect(enums).toEqual(
      expect.arrayContaining([
        "e: enum is empty, no value can match",
        "f: enum lists the same value twice",
        "g: enum mixes string and number values",
        'h: an enum of one value is a constant; use "const" or drop the parameter',
        'l: array without "items": agents cannot know what goes in it',
      ]),
    );
  });
  it("checks the output schema when there is one", () => {
    const out = analyzeTool(tool({ name: "get_x", outputSchema: { properties: { a: {} } } })).findings.filter((f) => f.area === "output");
    expect(out.map((f) => f.message)).toContain("outputSchema has no type");
    expect(analyzeTool(tool({ name: "get_x" })).findings.some((f) => f.area === "output")).toBe(false);
  });
});

describe("tester helpers", () => {
  const schema = {
    type: "object",
    properties: {
      q: { type: "string", description: "Query" },
      n: { type: "integer" },
      price: { type: "number" },
      on: { type: "boolean" },
      color: { type: "string", enum: ["red", "blue"] },
      tags: { type: "array", items: { type: "string" } },
      ids: { type: "array", items: { type: "integer" } },
      filter: { type: "object", properties: { a: { type: "string" } } },
    },
    required: ["q"],
  };
  it("turns a schema into form fields", () => {
    expect(formFields(schema).map((f) => [f.key, f.kind, f.itemKind ?? null, f.required])).toEqual([
      ["q", "string", null, true],
      ["n", "integer", null, false],
      ["price", "number", null, false],
      ["on", "boolean", null, false],
      ["color", "enum", null, false],
      ["tags", "array", "string", false],
      ["ids", "array", "integer", false],
      ["filter", "json", null, false],
    ]);
    expect(formFields(null)).toEqual([]);
  });
  it("builds and validates arguments", () => {
    const fields = formFields(schema);
    expect(
      buildArgs(fields, { q: "mug", n: "3", price: "1.5", on: true, color: "blue", tags: "a, b", ids: "1\n2", filter: '{"a":"x"}' }),
    ).toEqual({
      args: { q: "mug", n: 3, price: 1.5, on: true, color: "blue", tags: ["a", "b"], ids: [1, 2], filter: { a: "x" } },
      errors: [],
    });
    const bad = buildArgs(fields, { n: "2.5", filter: "{" });
    expect(bad.errors[0]).toBe("q is required");
    expect(bad.errors[1]).toBe('n: "2.5" is not an integer');
    expect(bad.errors[2]).toMatch(/^filter: not valid JSON/);
  });
  it("masks sensitive-looking arguments for the history", () => {
    expect(maskArgs({ email: "a@b.test", password: "hunter2", nested: { apiKey: "k", note: "n" }, card_number: "4242" })).toEqual({
      email: "a@b.test",
      password: "••••",
      nested: { apiKey: "••••", note: "n" },
      card_number: "••••",
    });
  });
});

describe("agentToolsMarkdown", () => {
  it("lists tools with their risk and the problems to fix", async () => {
    nav.modelContextTesting = {
      listTools: () => [
        {
          name: "get_profile",
          description: "Returns the signed-in user's profile.",
          inputSchema: '{"type":"object","properties":{}}',
          annotations: { readOnlyHint: true },
        },
        { name: "delete_account", description: "Deletes the account.", inputSchema: '{"type":"object","properties":{}}' },
      ],
      executeTool: async () => "{}",
    };
    const snap = await collectWebMcp();
    const md = agentToolsMarkdown(snap, analyzeTools(snap.tools), { url: "https://a.test/" });
    expect(md).toMatch(/^## Agent tools/);
    expect(md).toContain("`delete_account`: Critical risk");
    expect(md).toContain("### To fix");
    expect(md).toContain("No annotations on a sensitive tool");
  });
});
