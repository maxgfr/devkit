import { describe, expect, it } from "vitest";
import { type NetRule, newRule, ruleProblem, toDnrRules } from "../src/lib/dnr";
import { type EnvGroup, matchEnv, normalizeOrigin, switchUrl } from "../src/lib/envs";
import { toCurl, toFetch, toHttpie } from "../src/lib/har";

describe("DNR rules", () => {
  it("builds header, redirect, block and CORS rules in order, skipping disabled ones", () => {
    const rules: NetRule[] = [
      { ...newRule("header"), match: "||api.ex.com/", header: "X-Flag", value: "on" } as NetRule,
      { ...newRule("block"), match: "||tracker.com", enabled: false },
      { ...newRule("redirect"), match: "^https://cdn\\.ex\\.com/(.*)$", regex: true, to: "http://localhost:3000/\\1" } as NetRule,
      { ...newRule("cors"), match: "||localhost:8080" },
    ];
    const out = toDnrRules(rules);
    expect(out.map((r) => r.id)).toEqual([1, 3, 4]);
    expect(out[0]!.action).toMatchObject({ type: "modifyHeaders", requestHeaders: [{ header: "x-flag", operation: "set", value: "on" }] });
    expect(out[1]!.condition).toMatchObject({ regexFilter: "^https://cdn\\.ex\\.com/(.*)$" });
    expect(out[1]!.action).toMatchObject({ redirect: { regexSubstitution: "http://localhost:3000/\\1" } });
    expect(JSON.stringify(out[2]!.action)).toContain("access-control-allow-origin");
  });

  it("explains unusable rules", () => {
    expect(ruleProblem(newRule("block"))).toMatch(/URL filter/);
    expect(ruleProblem({ ...newRule("redirect"), match: "||a.com", to: "localhost" } as NetRule)).toMatch(/absolute/);
    expect(ruleProblem({ ...newRule("header"), match: "||a.com", header: "bad header" } as NetRule)).toMatch(/header name/);
  });
});

describe("environments", () => {
  const groups: EnvGroup[] = [
    {
      id: "1",
      name: "shop",
      envs: [
        { label: "local", origin: "http://localhost:3000", color: "#0f0", danger: false },
        { label: "prod", origin: "shop.com", color: "#f00", danger: true },
      ],
    },
  ];
  it("matches an origin and switches keeping path, query and hash", () => {
    const m = matchEnv(groups, "https://shop.com/cart?x=1#top");
    expect(m?.env.label).toBe("prod");
    expect(switchUrl("https://shop.com/cart?x=1#top", groups[0]!.envs[0]!)).toBe("http://localhost:3000/cart?x=1#top");
    expect(normalizeOrigin("shop.com/")).toBe("https://shop.com");
  });
});

describe("request exporters", () => {
  const req = {
    method: "POST",
    url: "https://api.ex.com/items?x=1",
    headers: [
      { name: ":authority", value: "api.ex.com" },
      { name: "content-type", value: "application/json" },
      { name: "authorization", value: "Bearer it's" },
      { name: "accept-encoding", value: "gzip" },
    ],
    postData: { text: '{"a":1}' },
  };
  it("writes cURL with quoting, data and --compressed", () => {
    const c = toCurl(req);
    expect(c).toContain("curl 'https://api.ex.com/items?x=1'");
    expect(c).toContain(`-H 'authorization: Bearer it'\\''s'`);
    expect(c).toContain(`--data-raw '{"a":1}'`);
    expect(c).toContain("--compressed");
    expect(c).not.toContain(":authority");
    expect(c).not.toContain("-X POST");
  });
  it("writes fetch and HTTPie", () => {
    expect(toFetch(req)).toContain('"method": "POST"');
    expect(toHttpie(req)).toMatch(/^printf %s .* \| http POST/);
  });
});
