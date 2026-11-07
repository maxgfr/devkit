import { describe, expect, it } from "vitest";
import {
  bodyWarning,
  compilePattern,
  exportMocks,
  fetchPatterns,
  findMock,
  fulfillParams,
  importMocks,
  LOG_CAP,
  type MockLogEntry,
  mockFromResponse,
  mockMatches,
  mockProblem,
  newMock,
  parseHeaders,
  patternKind,
  preflightMethod,
  preflightResponse,
  upsertLog,
} from "../src/lib/mocks";
import { base64Decode } from "../src/lib/utils/encode";

const API = "http://127.0.0.1:8080/api/user?id=1";

describe("mock URL patterns", () => {
  it("reads substrings, wildcards, anchors and regex literals", () => {
    expect(patternKind("/api/user")).toBe("substring");
    expect(patternKind("/api/*/items")).toBe("wildcard");
    expect(patternKind("||example.com")).toBe("wildcard");
    expect(patternKind("/^https:\\/\\/x\\.com/i")).toBe("regex");
  });

  it("matches a substring anywhere in the URL, without the fragment", () => {
    const re = compilePattern("/api/user")!;
    expect(re.test(API)).toBe(true);
    expect(re.test("http://x.com/api/users")).toBe(true);
    expect(re.test("http://x.com/v2/api")).toBe(false);
    expect(mockMatches(newMock({ match: "#top" }), "GET", "http://x.com/page#top")).toBe(false);
  });

  it("treats * as a wildcard and escapes everything else", () => {
    const re = compilePattern("/api/*/items?page=1")!;
    expect(re.test("http://x.com/api/v2/items?page=1")).toBe(true);
    expect(re.test("http://x.com/api/v2/itemsXpage=1")).toBe(false);
    expect(compilePattern("a.b")!.test("aXb")).toBe(false);
  });

  it("anchors with | and || like Request rules", () => {
    expect(compilePattern("|http://127.0.0.1")!.test(API)).toBe(true);
    expect(compilePattern("|/api")!.test(API)).toBe(false);
    expect(compilePattern("/api/user|")!.test("http://x.com/api/user")).toBe(true);
    expect(compilePattern("/api/user|")!.test("http://x.com/api/users")).toBe(false);
    const domain = compilePattern("||example.com/v1")!;
    expect(domain.test("https://api.example.com/v1/x")).toBe(true);
    expect(domain.test("https://example.com/v1")).toBe(true);
    expect(domain.test("https://notexample.com/v1")).toBe(false);
    expect(domain.test("https://evil.com/?u=https://example.com/v1")).toBe(false);
  });

  it("compiles /regex/flags and refuses broken ones", () => {
    expect(compilePattern("/USER\\?id=\\d+$/i")!.test(API)).toBe(true);
    expect(compilePattern("/([/")).toBeNull();
    expect(compilePattern("   ")).toBeNull();
    expect(mockProblem(newMock({ match: "/([/" }))).toMatch(/regex/);
  });
});

describe("finding the mock for a request", () => {
  const mocks = [
    newMock({ name: "off", match: "/api", enabled: false }),
    newMock({ name: "post", match: "/api/user", method: "POST" }),
    newMock({ name: "broken", match: "/api/user", status: 42 }),
    newMock({ name: "any", match: "/api/user" }),
  ];

  it("skips disabled and broken mocks, honours the method, first match wins", () => {
    expect(findMock(mocks, "GET", API)?.name).toBe("any");
    expect(findMock(mocks, "post", API)?.name).toBe("post");
    expect(findMock(mocks, "GET", "http://x.com/other")).toBeUndefined();
  });

  it("explains what stops a mock", () => {
    expect(mockProblem(newMock())).toMatch(/URL pattern/);
    expect(mockProblem(newMock({ match: "/a", status: 700 }))).toMatch(/100 to 599/);
    expect(mockProblem(newMock({ match: "/a", headers: "bad header line" }))).toMatch(/Not a header/);
    expect(mockProblem(newMock({ match: "/a", delay: -1 }))).toMatch(/Delay/);
    expect(mockProblem(newMock({ match: "/a", mode: "fail", status: 0 }))).toBeNull();
  });

  it("warns about an invalid JSON body without blocking it", () => {
    const bad = newMock({ match: "/a", body: '{"a": }' });
    expect(mockProblem(bad)).toBeNull();
    expect(bodyWarning(bad)).toMatch(/Invalid JSON at line 1, column \d+: served as is/);
    expect(bodyWarning(newMock({ match: "/a", body: '{"a": 1}' }))).toBeNull();
    expect(bodyWarning(newMock({ match: "/a", body: "<p>", contentType: "text/html" }))).toBeNull();
  });
});

describe("CDP payloads", () => {
  it("pre-filters with Fetch globs, one per pattern, and * for regexes", () => {
    expect(fetchPatterns([newMock({ match: "/api/user?x" })]).map((p) => p.urlPattern)).toEqual(["*/api/user\\?x*", "*/api/user\\?x*"]);
    expect(fetchPatterns([newMock({ match: "||example.com/*" })])[0]).toEqual({
      urlPattern: "*example.com/*",
      resourceType: "XHR",
      requestStage: "Request",
    });
    expect(fetchPatterns([newMock({ match: "/a" }), newMock({ match: "/x/i" })]).map((p) => p.urlPattern)).toEqual(["*", "*"]);
    expect(fetchPatterns([newMock({ match: "/a", enabled: false }), newMock()])).toEqual([]);
  });

  it("fulfills with status, content type, custom headers and a base64 body", () => {
    const mock = newMock({ name: "User", match: "/api/user", status: 201, headers: "X-Id: 7\nSet-Cookie: a=1", body: '{"name":"Mocked"}' });
    const p = fulfillParams(mock, { method: "GET", headers: {} });
    expect(p.responseCode).toBe(201);
    expect(base64Decode(p.body!)).toBe('{"name":"Mocked"}');
    expect(p.responseHeaders).toEqual(
      expect.arrayContaining([
        { name: "Content-Type", value: "application/json" },
        { name: "X-Id", value: "7" },
        { name: "Set-Cookie", value: "a=1" },
        { name: "X-Devkit-Mock", value: "User" },
      ]),
    );
    expect(p.responseHeaders.some((h) => /access-control/i.test(h.name))).toBe(false);
  });

  it("encodes UTF-8 bodies and leaves bodies out of 204 and HEAD answers", () => {
    const p = fulfillParams(newMock({ match: "/a", body: '{"city":"Zürich ✓"}' }), { method: "GET", headers: {} });
    expect(base64Decode(p.body!)).toBe('{"city":"Zürich ✓"}');
    expect(fulfillParams(newMock({ match: "/a", status: 204 }), { method: "GET", headers: {} }).body).toBeUndefined();
    expect(fulfillParams(newMock({ match: "/a" }), { method: "HEAD", headers: {} }).body).toBeUndefined();
  });

  it("adds CORS headers for cross-origin requests unless the mock sets them", () => {
    const req = { method: "GET", headers: { Origin: "http://localhost:3000" } };
    const p = fulfillParams(newMock({ match: "/a", headers: "X-Total: 3" }), req);
    expect(p.responseHeaders).toEqual(
      expect.arrayContaining([
        { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Access-Control-Expose-Headers", value: "X-Total" },
      ]),
    );
    const own = fulfillParams(newMock({ match: "/a", headers: "Access-Control-Allow-Origin: *" }), req);
    expect(own.responseHeaders.filter((h) => /allow-origin/i.test(h.name))).toEqual([{ name: "Access-Control-Allow-Origin", value: "*" }]);
  });

  it("answers CORS preflights for mocked requests", () => {
    const req = {
      method: "OPTIONS",
      headers: { origin: "http://a.test", "Access-Control-Request-Method": "put", "access-control-request-headers": "x-a" },
    };
    expect(preflightMethod(req)).toBe("PUT");
    expect(preflightMethod({ method: "OPTIONS", headers: {} })).toBeNull();
    expect(preflightMethod({ method: "GET", headers: { "access-control-request-method": "GET" } })).toBeNull();
    const r = preflightResponse(req);
    expect(r.responseCode).toBe(204);
    expect(r.responseHeaders).toEqual(
      expect.arrayContaining([
        { name: "Access-Control-Allow-Origin", value: "http://a.test" },
        { name: "Access-Control-Allow-Headers", value: "x-a" },
      ]),
    );
  });

  it("parses header lines and reports the others", () => {
    expect(parseHeaders("A: 1\n\n  B :two: parts  \nnope\n: x")).toEqual({
      headers: [
        { name: "A", value: "1" },
        { name: "B", value: "two: parts" },
      ],
      bad: ["nope", ": x"],
    });
  });
});

describe("creating, importing and exporting mocks", () => {
  it("builds a mock from a real response, pretty-printing JSON", () => {
    const m = mockFromResponse({ method: "get", url: API, status: 200, contentType: "application/json; charset=utf-8", body: '{"a":1}' });
    expect(m).toMatchObject({
      method: "GET",
      match: "127.0.0.1:8080/api/user",
      name: "/api/user",
      contentType: "application/json",
      source: API,
    });
    expect(m.body).toBe('{\n  "a": 1\n}');
    expect(mockFromResponse({ method: "BREW", url: "/rel" }).method).toBe("ANY");
  });

  it("round-trips through export and import with fresh ids", () => {
    const mocks = [
      newMock({ name: "a", match: "/a", headers: "X: 1", delay: 300 }),
      newMock({ match: "/b", mode: "fail", error: "TimedOut" }),
    ];
    const back = importMocks(JSON.parse(exportMocks(mocks)));
    expect(back.map(({ id: _, ...m }) => m)).toEqual(mocks.map(({ id: _, ...m }) => m));
    expect(back[0]!.id).not.toBe(mocks[0]!.id);
    expect(exportMocks(mocks)).not.toContain('"id"');
  });

  it("imports lenient shapes and refuses garbage", () => {
    const [m] = importMocks({
      mocks: [{ match: "/x", method: "post", headers: { "X-A": "1" }, body: { ok: true }, delay: 1e9, error: "Nope" }],
    });
    expect(m).toMatchObject({
      method: "POST",
      headers: "X-A: 1",
      body: '{\n  "ok": true\n}',
      delay: 60_000,
      error: "Failed",
      enabled: true,
    });
    expect(() => importMocks({})).toThrow(/list of mocks/);
    expect(() => importMocks([{ name: "no match" }])).toThrow(/Item 1/);
  });
});

describe("request log", () => {
  it("merges Network and Fetch events for one request, keeping the mocked outcome", () => {
    let log: MockLogEntry[] = [];
    log = upsertLog(log, { id: "1", method: "GET", url: API, outcome: "pending" });
    log = upsertLog(log, { id: "1", outcome: "mocked", mockId: "m", mockName: "User", status: 201 });
    log = upsertLog(log, { id: "1", outcome: "passed", status: 201, mime: "application/json" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "mocked", mockName: "User", status: 201, mime: "application/json" });
    log = upsertLog(log, { id: "2", outcome: "passed" });
    expect(log).toHaveLength(1);
  });

  it("puts new requests first and keeps the last LOG_CAP", () => {
    let log: MockLogEntry[] = [];
    for (let i = 0; i < LOG_CAP + 5; i++) log = upsertLog(log, { id: String(i), url: `/r/${i}`, outcome: "pending" });
    expect(log).toHaveLength(LOG_CAP);
    expect(log[0]!.url).toBe(`/r/${LOG_CAP + 4}`);
  });
});
