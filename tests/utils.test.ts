import { describe, expect, it } from "vitest";
import { contrast, parseColor, toHex, toHsl } from "../src/lib/utils/color";
import { explainCron } from "../src/lib/utils/cron";
import { diffLines } from "../src/lib/utils/diff";
import { base64Decode, base64Encode, decodeWith, encodeWith, htmlUnescape } from "../src/lib/utils/encode";
import { hash, sri } from "../src/lib/utils/hash";
import { jsonPaths, parseJson, toTypeScript } from "../src/lib/utils/json";
import { decodeJwt } from "../src/lib/utils/jwt";
import { runRegex } from "../src/lib/utils/regex";
import { parseTime } from "../src/lib/utils/time";
import { inspectUuid, uuidV7 } from "../src/lib/utils/uuid";

describe("encoding", () => {
  it("round-trips UTF-8 base64 and base64url", () => {
    expect(base64Encode("héllo ✓")).toBe("aMOpbGxvIOKckw==");
    expect(base64Decode("aMOpbGxvIOKckw")).toBe("héllo ✓");
    expect(base64Encode("??>", true)).toBe("Pz8-");
  });
  it("handles hex, entities and unicode escapes", () => {
    expect(encodeWith("hex", "AZ")).toBe("415a");
    expect(decodeWith("hex", "41 5a")).toBe("AZ");
    expect(htmlUnescape("&lt;a&gt; &#x27;&amp;&#39; &nbsp;")).toBe("<a> '&' \u00a0");
    expect(decodeWith("unicode", encodeWith("unicode", "é😀"))).toBe("é😀");
  });
});

describe("JWT", () => {
  it("decodes header, payload and expiry", () => {
    const part = (o: object) => base64Encode(JSON.stringify(o), true);
    const token = `${part({ alg: "HS256" })}.${part({ sub: "1", exp: 1_000 })}.sig`;
    const d = decodeJwt(`Bearer ${token}`, 2_000_000);
    expect(d.header.alg).toBe("HS256");
    expect(d.expired).toBe(true);
    expect(d.claims[0]!.name).toBe("exp");
    expect(() => decodeJwt("nope")).toThrow(/three parts/);
  });
});

describe("hash", () => {
  it("computes SHA-256 and SRI", async () => {
    expect((await hash("SHA-256", "abc")).hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sri("abc")).toMatch(/^sha384-/);
  });
});

describe("UUID v7", () => {
  it("embeds the time and the version", () => {
    const id = uuidV7(Date.UTC(2026, 0, 2));
    expect(inspectUuid(id)).toMatchObject({ version: 7, variant: "RFC 9562", time: "2026-01-02T00:00:00.000Z" });
  });
});

describe("time", () => {
  it("reads seconds, milliseconds and ISO strings", () => {
    expect(parseTime("1700000000")!.iso).toBe("2023-11-14T22:13:20.000Z");
    expect(parseTime("1700000000000")!.unix).toBe(1700000000);
    expect(parseTime("2026-01-01T00:00:00Z")!.unix).toBe(1767225600);
    expect(parseTime("not a date")).toBeNull();
  });
});

describe("regex & diff", () => {
  it("lists matches with groups", () => {
    const r = runRegex("(?<user>\\w+)@(\\w+)", "g", "a@b c@d");
    expect(r.matches.map((m) => m.named.user)).toEqual(["a", "c"]);
    expect(runRegex("(", "", "x").error).toBeTruthy();
  });
  it("diffs lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc").map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
  });
});

describe("cron", () => {
  it("explains and computes next runs", () => {
    const r = explainCron("30 9 * * 1-5", new Date(2026, 0, 2, 10, 0));
    expect(r.text).toBe("At 09:30, on Monday, Tuesday, Wednesday, Thursday and Friday");
    expect(r.next[0]!.getDay()).toBe(1);
    expect(r.next[0]!.getHours()).toBe(9);
    expect(explainCron("@hourly").text).toBe("At minute 0 of every hour");
    expect(() => explainCron("61 * * * *")).toThrow(/out of range/);
  });
});

describe("JSON tools", () => {
  it("locates syntax errors", () => {
    const r = parseJson('{\n "a": 1,\n}');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(3);
  });
  it("derives TypeScript types and paths", () => {
    const ts = toTypeScript({ id: 1, tags: ["a"], owner: { name: "x" } });
    expect(ts).toContain("interface Root {");
    expect(ts).toContain("owner: Owner;");
    expect(jsonPaths({ a: [{ b: 1 }] })).toEqual(["$.a[0].b = 1"]);
  });
});

describe("colors", () => {
  it("converts and measures contrast", () => {
    const c = parseColor("rgb(14 116 144)")!;
    expect(toHex(c)).toBe("#0e7490");
    expect(toHsl(parseColor("#ff0000")!)).toBe("hsl(0 100% 50%)");
    expect(contrast(parseColor("#000")!, parseColor("#fff")!)).toBe(21);
  });
});
