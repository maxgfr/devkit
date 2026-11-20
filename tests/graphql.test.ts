import { describe, expect, it } from "vitest";
import {
  detectGraphql,
  endpointOf,
  errorPath,
  graphqlRows,
  multipartField,
  parseGraphqlResponse,
  pickOperation,
  prettyQuery,
  readOperations,
} from "../src/lib/graphql";

const post = (text: string, mimeType = "application/json", url = "https://api.example.com/graphql") => ({
  method: "POST",
  url,
  headers: [{ name: "Content-Type", value: mimeType }],
  postData: { mimeType, text },
});
const get = (query: Record<string, string>, path = "https://api.example.com/graphql") => ({
  method: "GET",
  url: `${path}?${new URLSearchParams(query)}`,
  headers: [],
});

describe("GraphQL documents", () => {
  it("reads operation types and names, skipping fragments, comments and strings", () => {
    expect(readOperations("query Foo { a }")).toEqual([{ type: "query", name: "Foo" }]);
    expect(readOperations("mutation Bar($id: ID!) { like(id: $id) { ok } }")).toEqual([{ type: "mutation", name: "Bar" }]);
    expect(readOperations("subscription Baz { onEvent { id } }")).toEqual([{ type: "subscription", name: "Baz" }]);
    expect(readOperations("{ me { id } }")).toEqual([{ type: "query", name: null }]);
    expect(readOperations("mutation { x }")).toEqual([{ type: "mutation", name: null }]);
    const doc = `# query Fake { x }
      fragment F on User { id name(format: "query Nope { }") }
      query A { me { ...F } }
      mutation B { save(input: { a: 1 }) { ok } }`;
    expect(readOperations(doc)).toEqual([
      { type: "query", name: "A" },
      { type: "mutation", name: "B" },
    ]);
    expect(readOperations("shoes")).toEqual([]);
  });

  it("picks the operation named by operationName, else the first", () => {
    const doc = "query A { a } mutation B { b }";
    expect(pickOperation(doc, "B")).toEqual({ type: "mutation", name: "B" });
    expect(pickOperation(doc)).toEqual({ type: "query", name: "A" });
    expect(pickOperation("{ a }", null)).toEqual({ type: "query", name: null });
  });

  it("pretty-prints a minified document", () => {
    const doc =
      'query GetUser($id: ID!, $n: Int = 10) { user(id: $id) { id, name avatar: picture(size: 64) @include(if: true) posts(first: $n, filter: {tags: ["a", "b"]}) { ...PostFields ... on Article { title } } } } fragment PostFields on Post { id }';
    expect(prettyQuery(doc)).toBe(
      [
        "query GetUser($id: ID!, $n: Int = 10) {",
        "  user(id: $id) {",
        "    id",
        "    name",
        "    avatar: picture(size: 64) @include(if: true)",
        '    posts(first: $n, filter: {tags: ["a", "b"]}) {',
        "      ...PostFields",
        "      ... on Article {",
        "        title",
        "      }",
        "    }",
        "  }",
        "}",
        "",
        "fragment PostFields on Post {",
        "  id",
        "}",
      ].join("\n"),
    );
    expect(prettyQuery("{ a b }")).toBe("{\n  a\n  b\n}");
    // Already indented documents come out the same.
    expect(prettyQuery(prettyQuery(doc))).toBe(prettyQuery(doc));
  });

  it("keeps strings and comments intact", () => {
    const out = prettyQuery('query { search(q: "a { b } c") # why\n { id } }');
    expect(out).toContain('search(q: "a { b } c") # why');
    expect(prettyQuery('{ a(text: """multi\nline""") }')).toContain('"""multi\nline"""');
  });
});

describe("GraphQL request detection", () => {
  it("detects a single POST operation", () => {
    const g = detectGraphql(
      post(JSON.stringify({ operationName: "GetUser", query: "query GetUser($id: ID!) { user(id: $id) { id } }", variables: { id: "1" } })),
    );
    expect(g).toMatchObject({ transport: "json", batched: false, files: 0 });
    expect(g!.operations).toEqual([
      expect.objectContaining({ index: 0, name: "GetUser", type: "query", variables: { id: "1" }, persistedHash: null }),
    ]);
  });

  it("names an anonymous operation from the document, or leaves it anonymous", () => {
    expect(detectGraphql(post(JSON.stringify({ query: "mutation Save { save { ok } }" })))!.operations[0]).toMatchObject({
      name: "Save",
      type: "mutation",
    });
    expect(detectGraphql(post(JSON.stringify({ query: "{ me { id } }" })))!.operations[0]).toMatchObject({ name: null, type: "query" });
  });

  it("detects batched operations", () => {
    const g = detectGraphql(post(JSON.stringify([{ query: "query A { a }" }, { query: "mutation B { b }", variables: { x: 1 } }])));
    expect(g).toMatchObject({ transport: "batch", batched: true });
    expect(g!.operations.map((o) => [o.index, o.name, o.type])).toEqual([
      [0, "A", "query"],
      [1, "B", "mutation"],
    ]);
  });

  it("detects persisted queries, with and without the document", () => {
    const hash = "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38";
    const g = detectGraphql(
      post(JSON.stringify({ operationName: "Feed", variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } })),
    );
    expect(g!.operations[0]).toMatchObject({ name: "Feed", type: null, query: null, persistedHash: hash });
    const withDoc = detectGraphql(
      post(JSON.stringify({ query: "query Feed { feed { id } }", extensions: { persistedQuery: { version: 1, sha256Hash: hash } } })),
    );
    expect(withDoc!.operations[0]).toMatchObject({ name: "Feed", type: "query", persistedHash: hash });
    const relay = detectGraphql(post(JSON.stringify({ id: "q-123", operationName: "Home", variables: { a: 1 } })));
    expect(relay!.operations[0]).toMatchObject({ name: "Home", documentId: "q-123", type: null });
  });

  it("detects GET requests with query, operationName and extensions parameters", () => {
    const g = detectGraphql(get({ query: "query Me { me { id } }", variables: '{"a":1}' }));
    expect(g).toMatchObject({ transport: "get" });
    expect(g!.operations[0]).toMatchObject({ name: "Me", type: "query", variables: { a: 1 } });
    const persisted = detectGraphql(
      get({ operationName: "Feed", variables: "{}", extensions: '{"persistedQuery":{"version":1,"sha256Hash":"abc"}}' }),
    );
    expect(persisted!.operations[0]).toMatchObject({ name: "Feed", persistedHash: "abc", type: null });
  });

  it("detects application/graphql bodies, with variables from the URL", () => {
    const g = detectGraphql(
      post("query Q { a }", "application/graphql", `https://x.dev/api?operationName=Q&variables=${encodeURIComponent('{"v":2}')}`),
    );
    expect(g).toMatchObject({ transport: "graphql-body" });
    expect(g!.operations[0]).toMatchObject({ name: "Q", type: "query", variables: { v: 2 }, query: "query Q { a }" });
  });

  it("detects multipart uploads (graphql-multipart-request spec)", () => {
    const boundary = "----WebKitFormBoundaryX";
    const ops = JSON.stringify({ query: "mutation Upload($file: Upload!) { upload(file: $file) { id } }", variables: { file: null } });
    const text = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="operations"',
      "",
      ops,
      `--${boundary}`,
      'Content-Disposition: form-data; name="map"',
      "",
      '{"0":["variables.file"]}',
      `--${boundary}`,
      'Content-Disposition: form-data; name="0"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const req = post(text, `multipart/form-data; boundary=${boundary}`);
    expect(multipartField(req.postData, "operations")).toBe(ops);
    const g = detectGraphql(req);
    expect(g).toMatchObject({ transport: "multipart", files: 1 });
    expect(g!.operations[0]).toMatchObject({ name: "Upload", type: "mutation" });
    // Chrome may hand the form fields as params instead of the raw text.
    const params = detectGraphql({
      method: "POST",
      url: "https://x.dev/upload",
      postData: { mimeType: "multipart/form-data; boundary=b", params: [{ name: "operations", value: ops }] },
    });
    expect(params!.operations[0]!.name).toBe("Upload");
  });

  it("ignores requests that are not GraphQL", () => {
    expect(detectGraphql(get({ query: "red shoes" }, "https://shop.example.com/search"))).toBeNull();
    expect(detectGraphql({ method: "GET", url: "https://example.com/api/posts/1" })).toBeNull();
    expect(detectGraphql(post(JSON.stringify({ query: "red shoes" }), "application/json", "https://shop.example.com/search"))).toBeNull();
    expect(detectGraphql(post(JSON.stringify({ name: "x" })))).toBeNull();
    expect(detectGraphql(post(JSON.stringify([{ query: "query A { a }" }, { foo: 1 }])))).toBeNull();
    expect(detectGraphql(post("not json"))).toBeNull();
    expect(detectGraphql(post("[]"))).toBeNull();
    expect(detectGraphql({ method: "GET", url: "not a url" })).toBeNull();
  });

  it("lists one row per operation", () => {
    const entries = [
      { request: post(JSON.stringify([{ query: "query A { a }" }, { query: "query B { b }" }])) },
      { request: { method: "GET", url: "https://example.com/" } },
      { request: post(JSON.stringify({ query: "{ c }" })) },
    ];
    expect(graphqlRows(entries).map((r) => [entries.indexOf(r.entry), r.operation.index])).toEqual([
      [0, 0],
      [0, 1],
      [2, 0],
    ]);
  });
});

describe("GraphQL responses", () => {
  it("reads data, errors with path and code, and extensions", () => {
    const [r] = parseGraphqlResponse(
      JSON.stringify({
        data: { user: null },
        errors: [
          { message: "Not found", path: ["user", 0, "name"], locations: [{ line: 1, column: 9 }], extensions: { code: "NOT_FOUND" } },
          { message: "Second" },
        ],
        extensions: { cost: 3 },
      }),
    )!;
    expect(r).toMatchObject({ hasData: true, data: { user: null }, extensions: { cost: 3 } });
    expect(r!.errors).toEqual([
      { message: "Not found", path: ["user", 0, "name"], locations: [{ line: 1, column: 9 }], code: "NOT_FOUND" },
      { message: "Second", path: null, locations: null, code: null },
    ]);
    expect(errorPath(r!.errors[0]!.path)).toBe("user.0.name");
  });

  it("maps batched responses to their operations", () => {
    const out = parseGraphqlResponse(JSON.stringify([{ data: { a: 1 } }, { errors: [{ message: "Denied" }] }]), 2)!;
    expect(out[0]).toMatchObject({ hasData: true, data: { a: 1 }, errors: [] });
    expect(out[1]).toMatchObject({ hasData: false, errors: [{ message: "Denied" }] });
    // A single object answering a whole batch applies to every operation.
    const whole = parseGraphqlResponse(JSON.stringify({ errors: [{ message: "Batching disabled" }] }), 2)!;
    expect(whole.map((r) => r?.errors[0]?.message)).toEqual(["Batching disabled", "Batching disabled"]);
    // A shorter array leaves the rest unanswered.
    expect(parseGraphqlResponse("[{}]", 2)![1]).toBeNull();
  });

  it("returns null for a body that is not JSON", () => {
    expect(parseGraphqlResponse("<html>")).toBeNull();
    expect(parseGraphqlResponse("")).toBeNull();
  });

  it("shows the endpoint without the query string", () => {
    expect(endpointOf("https://api.example.com/graphql?query=x")).toBe("api.example.com/graphql");
  });
});
