import { describe, expect, it } from "vitest";
import { parseYaml, resolvePlain, splitKey, yamlProblemMessage } from "../src/lib/formats/yaml";

const ok = (text: string) => {
  const r = parseYaml(text);
  expect(r.error, r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  return r.value;
};

describe("yaml: scalars", () => {
  it("types plain scalars with the YAML 1.2 core schema", () => {
    expect(["~", "null", "NULL", ""].map(resolvePlain)).toEqual([null, null, null, null]);
    expect(["true", "False", "TRUE"].map(resolvePlain)).toEqual([true, false, true]);
    expect(["42", "-7", "+3", "0o17", "0x1F"].map(resolvePlain)).toEqual([42, -7, 3, 15, 31]);
    expect(["1.5", ".5", "1e3", "-2.5E-2"].map(resolvePlain)).toEqual([1.5, 0.5, 1000, -0.025]);
    expect(resolvePlain(".inf")).toBe(Number.POSITIVE_INFINITY);
    expect(resolvePlain("-.Inf")).toBe(Number.NEGATIVE_INFINITY);
    expect(resolvePlain(".nan")).toBeNaN();
    // YAML 1.1 booleans, dates and versions stay strings.
    expect(["yes", "no", "on", "off", "2026-01-01", "1.2.3", "0777x"].map(resolvePlain)).toEqual([
      "yes",
      "no",
      "on",
      "off",
      "2026-01-01",
      "1.2.3",
      "0777x",
    ]);
  });

  it("reads quoted strings with escapes", () => {
    expect(
      ok(String.raw`a: "line\nnext \"q\" \t \u00e9 \x41 \\"
b: 'it''s # not a comment'
c: "# not a comment either"
d: ""`),
    ).toEqual({ a: 'line\nnext "q" \t é A \\', b: "it's # not a comment", c: "# not a comment either", d: "" });
  });

  it("folds multi-line plain and quoted scalars", () => {
    expect(ok("a: one\n  two\n\n  three\nb: 'x\n  y'\nc: \"p\\\n  q\"")).toEqual({ a: "one two\nthree", b: "x y", c: "pq" });
  });

  it("strips comments but keeps # inside values", () => {
    expect(ok("# head\nurl: http://a.test/#frag # trailing\ncolor: '#fff'\nn: 1 # one\n")).toEqual({
      url: "http://a.test/#frag",
      color: "#fff",
      n: 1,
    });
  });

  it("keeps strings that look like keys but are not", () => {
    expect(ok("a: http://x.test:8080/p\nb: key:value\nc: C:\\dir")).toEqual({ a: "http://x.test:8080/p", b: "key:value", c: "C:\\dir" });
  });
});

describe("yaml: block collections", () => {
  it("reads nested mappings and sequences", () => {
    expect(
      ok(`name: devkit
version: 1.2
private: true
nothing:
deps:
  react: ^19
  wxt: { version: 0.20, dev: true }
list:
  - a
  - 2
  -
  - nested:
      deep: yes
tags: [x, "y", 3]
`),
    ).toEqual({
      name: "devkit",
      version: 1.2,
      private: true,
      nothing: null,
      deps: { react: "^19", wxt: { version: 0.2, dev: true } },
      list: ["a", 2, null, { nested: { deep: "yes" } }],
      tags: ["x", "y", 3],
    });
  });

  it("reads sequences at the key's indentation and compact mappings in sequences", () => {
    expect(
      ok(`steps:
- name: checkout
  uses: actions/checkout@v4
- name: test
  run: pnpm test
  with:
    node: 22
after: done`),
    ).toEqual({
      steps: [
        { name: "checkout", uses: "actions/checkout@v4" },
        { name: "test", run: "pnpm test", with: { node: 22 } },
      ],
      after: "done",
    });
  });

  it("reads nested sequences and a root sequence", () => {
    expect(ok("- - a\n  - b\n- - c\n-   d")).toEqual([["a", "b"], ["c"], "d"]);
  });

  it("reads quoted keys and keys with spaces", () => {
    expect(ok(`"a b": 1\n'c: d': 2\nplain key: 3\n"": 4`)).toEqual({ "a b": 1, "c: d": 2, "plain key": 3, "": 4 });
    expect(splitKey("key: value")).toEqual({ key: "key", rest: "value" });
    expect(splitKey("key:")).toEqual({ key: "key", rest: "" });
    expect(splitKey("- a: b")).toBeNull();
    expect(splitKey("http://x")).toBeNull();
  });

  it("keeps __proto__ as a plain key", () => {
    const v = ok("__proto__:\n  polluted: true") as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads multi-line flow collections with comments", () => {
    expect(ok("lint: [2, 2, SwitchCase: 1]")).toEqual({ lint: [2, 2, { SwitchCase: 1 }] });
    expect(ok(`a: [1, 2, # two\n  3]\nb: {\n  x: 1,\n  "y": [true, null],\n}\nc: []\nd: {}`)).toEqual({
      a: [1, 2, 3],
      b: { x: 1, y: [true, null] },
      c: [],
      d: {},
    });
  });

  it("reads JSON, which is YAML", () => {
    const json = { a: [1, { b: "c" }], d: null, e: false, f: "x: y" };
    expect(ok(JSON.stringify(json, null, 2))).toEqual(json);
    expect(ok(JSON.stringify(json))).toEqual(json);
  });
});

describe("yaml: block scalars", () => {
  it("reads literal blocks with chomping", () => {
    expect(ok("a: |\n  line 1\n    indented\n  line 3\n\nb: x")).toEqual({ a: "line 1\n  indented\nline 3\n", b: "x" });
    expect(ok("a: |-\n  text\n\n\nb: 1")).toEqual({ a: "text", b: 1 });
    expect(ok("a: |+\n  text\n\nb: 1")).toEqual({ a: "text\n\n", b: 1 });
    expect(ok("a: |\nb: 1")).toEqual({ a: "", b: 1 });
  });

  it("reads folded blocks", () => {
    expect(ok("a: >\n  one\n  two\n\n  three\n    more\n  four\n")).toEqual({ a: "one two\nthree\n  more\nfour\n" });
    expect(ok("a: >-\n  x\n  y")).toEqual({ a: "x y" });
  });

  it("reads explicit indentation and blocks in sequences", () => {
    expect(ok("a: |2\n    two extra\n  base\n")).toEqual({ a: "  two extra\nbase\n" });
    expect(ok("- |\n  x\n  y\n- >\n  p\n  q\n")).toEqual(["x\ny\n", "p q\n"]);
  });

  it("keeps # in block scalars", () => {
    expect(ok("script: |\n  echo hi # not a comment\n  # neither\n")).toEqual({ script: "echo hi # not a comment\n# neither\n" });
  });
});

describe("yaml: anchors, tags and documents", () => {
  it("resolves anchors, aliases and merge keys", () => {
    expect(
      ok(`base: &base
  image: node
  env: dev
port: &p 8080
web:
  <<: *base
  env: prod
  port: *p
list: [*p, &q two, *q]
multi:
  <<: [*base, {extra: 1}]`),
    ).toEqual({
      base: { image: "node", env: "dev" },
      port: 8080,
      web: { image: "node", env: "prod", port: 8080 },
      list: [8080, "two", "two"],
      multi: { image: "node", env: "dev", extra: 1 },
    });
  });

  it("applies standard tags", () => {
    expect(ok('a: !!str 123\nb: !!int "7"\nc: !!float 1\nd: !!bool true\ne: !!null ""\nf: ! 12\ng: !!map\n  x: 1')).toEqual({
      a: "123",
      b: 7,
      c: 1,
      d: true,
      e: null,
      f: "12",
      g: { x: 1 },
    });
  });

  it("reads several documents and directives", () => {
    const r = parseYaml("%YAML 1.2\n---\na: 1\n---\n- b\n...\n---\nplain text\n");
    expect(r.ok).toBe(true);
    expect(r.documents).toBe(3);
    expect(r.value).toEqual([{ a: 1 }, ["b"], "plain text"]);
    expect(parseYaml("--- |\n  block\n").value).toBe("block\n");
    expect(parseYaml("# only a comment\n")).toEqual({ ok: true, value: null, documents: 0 });
    expect(parseYaml("")).toEqual({ ok: true, value: null, documents: 0 });
  });

  it("handles CRLF and a BOM", () => {
    expect(ok("\uFEFFa: 1\r\nb:\r\n  - x\r\n")).toEqual({ a: 1, b: ["x"] });
  });
});

describe("yaml: errors and unsupported syntax", () => {
  const fail = (text: string) => {
    const r = parseYaml(text);
    expect(r.ok, text).toBe(false);
    return r;
  };

  it("reports syntax errors with their line", () => {
    expect(fail("a: 1\n  b: 2")).toMatchObject({ line: 2 });
    expect(fail("a:\n  - x\n  y: 1")).toMatchObject({ line: 3 });
    expect(fail('a: "open\nb: 1')).toMatchObject({ error: "Unterminated quoted string", line: 1 });
    expect(fail("a: [1, 2\nb: 3")).toMatchObject({ error: "Unterminated flow collection" });
    expect(fail("a: *missing")).toMatchObject({ error: "Unknown alias *missing", line: 1 });
    expect(fail("a: b: c")).toMatchObject({ line: 1 });
    expect(fail("a:\n\t- x")).toMatchObject({ error: "Tabs are not allowed in indentation", line: 2 });
    expect(fail('a: "bad \\q"')).toMatchObject({ line: 1 });
    expect(yamlProblemMessage(fail("x: 1\n  y: 2"))).toMatch(/^Invalid YAML at line 2: /);
  });

  it("labels what it does not support instead of guessing", () => {
    for (const text of [
      "? complex\n: key",
      "a: !Ref Bucket",
      "%TAG ! tag:x.test,2000:\n---\na: 1",
      "a: !<tag:x> 1",
      "a: !!python/object x",
    ]) {
      const r = fail(text);
      expect(r.unsupported, text).toBe(true);
      expect(yamlProblemMessage(r)).toMatch(/devkit's YAML reader does not support: shown as raw text/);
    }
  });
});
