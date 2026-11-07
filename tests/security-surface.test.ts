import { describe, expect, it } from "vitest";
import type { SurfaceSnapshot } from "../src/lib/page/security";
import { auditCookie, auditCookies, type CookieLike } from "../src/lib/security/cookies";
import { analyzeCsp, parseCsp, starterCsp } from "../src/lib/security/csp";
import { groupBySite, siteOf, surfaceFindings } from "../src/lib/security/third-party";

const snapshot = (over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot => ({
  url: "https://shop.example.co.uk/p/1",
  resources: [],
  scripts: [],
  styles: [],
  preloads: [],
  iframes: [],
  images: [],
  media: [],
  forms: [],
  inlineScripts: 0,
  inlineHandlers: 0,
  inlineStyles: 0,
  styleAttributes: 0,
  dataImages: false,
  metaCsp: [],
  insecure: [],
  ...over,
});

describe("sites", () => {
  it("approximates the registrable domain", () => {
    expect(siteOf("cdn.shop.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("www.google-analytics.com")).toBe("google-analytics.com");
    expect(siteOf("me.github.io")).toBe("me.github.io");
    expect(siteOf("a.b.me.github.io")).toBe("me.github.io");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("localhost")).toBe("localhost");
  });
  it("groups resources by site, first party first", () => {
    const groups = groupBySite(
      snapshot({
        resources: [
          { name: "https://static.example.co.uk/app.js", type: "script", transfer: 1000, encoded: 900, decoded: 3000 },
          { name: "https://www.googletagmanager.com/gtm.js", type: "script", transfer: 5000, encoded: 4800, decoded: 9000 },
          { name: "https://www.google-analytics.com/g/collect", type: "beacon", transfer: 0, encoded: 0, decoded: 0 },
          { name: "https://fonts.gstatic.com/a.woff2", type: "css", transfer: 2000, encoded: 2000, decoded: 2000 },
        ],
      }),
    );
    expect(groups.map((g) => g.site)).toEqual(["example.co.uk", "googletagmanager.com", "gstatic.com", "google-analytics.com"]);
    expect(groups[0]!.firstParty).toBe(true);
    expect(groups[3]!.hiddenSize).toBe(1);
  });
});

describe("SRI, CORS, mixed content, sandbox", () => {
  it("flags cross-origin scripts and styles without integrity, not same-origin ones", () => {
    const f = surfaceFindings(
      snapshot({
        scripts: [
          { src: "https://shop.example.co.uk/app.js", integrity: "", crossorigin: null, type: "" },
          { src: "https://cdn.vendor.com/lib.js", integrity: "", crossorigin: null, type: "" },
          { src: "https://cdn.vendor.com/pinned.js", integrity: "sha384-abc", crossorigin: "anonymous", type: "" },
          { src: "https://cdn.vendor.com/broken.js", integrity: "sha384-abc", crossorigin: null, type: "" },
        ],
        styles: [{ href: "https://cdn.vendor.com/x.css", integrity: "", crossorigin: null }],
      }),
    );
    expect(f.map((x) => [x.level, x.url])).toEqual([
      ["warn", "https://cdn.vendor.com/lib.js"],
      ["bad", "https://cdn.vendor.com/broken.js"],
      ["warn", "https://cdn.vendor.com/x.css"],
    ]);
  });
  it("preload crossorigin mismatches and font preloads", () => {
    const f = surfaceFindings(
      snapshot({
        scripts: [{ src: "https://cdn.vendor.com/m.js", integrity: "sha384-a", crossorigin: "anonymous", type: "module" }],
        preloads: [
          { href: "https://cdn.vendor.com/m.js", as: "script", crossorigin: null },
          { href: "https://shop.example.co.uk/f.woff2", as: "font", crossorigin: null },
        ],
      }),
    );
    expect(f.map((x) => x.title)).toEqual(["crossorigin differs between the preload and the tag", "Font preload without crossorigin"]);
  });
  it("mixed content only on https pages, active content is bad", () => {
    const insecure = [
      { tag: "script", url: "http://cdn.vendor.com/a.js" },
      { tag: "img", url: "http://cdn.vendor.com/a.png" },
    ];
    expect(surfaceFindings(snapshot({ insecure })).map((x) => x.level)).toEqual(["bad", "warn"]);
    expect(surfaceFindings(snapshot({ url: "http://localhost:3000/", insecure }))).toEqual([]);
  });
  it("cross-origin iframes without sandbox", () => {
    const f = surfaceFindings(
      snapshot({
        iframes: [
          { src: "https://www.youtube.com/embed/x", sandbox: null, allow: "" },
          { src: "https://ads.vendor.com/f", sandbox: "allow-scripts", allow: "" },
          { src: "about:blank", sandbox: null, allow: "" },
        ],
      }),
    );
    expect(f.map((x) => x.url)).toEqual(["https://www.youtube.com/embed/x"]);
  });
});

describe("CSP", () => {
  const levels = (csp: string, opts?: { https: boolean; xfo?: string }) =>
    Object.fromEntries(analyzeCsp(parseCsp(csp)[0]!, opts).map((f) => [`${f.directive}:${f.message.slice(0, 14)}`, f.level]));
  it("parses directives, duplicates and several policies", () => {
    const [a, b] = parseCsp("default-src 'self'; script-src 'self'; script-src *, img-src 'none'");
    expect(a!.directives.map((d) => d.name)).toEqual(["default-src", "script-src"]);
    expect(a!.duplicates).toEqual(["script-src"]);
    expect(b!.directives[0]).toEqual({ name: "img-src", values: ["'none'"] });
  });
  it("flags unsafe-inline without nonce, wildcard, schemes, data:", () => {
    const f = analyzeCsp(parseCsp("script-src * 'unsafe-inline' https: data:")[0]!);
    const msg = f.filter((x) => x.directive === "script-src" && x.level === "bad").map((x) => x.message.split(":")[0]);
    expect(msg).toEqual(["'unsafe-inline' without a nonce or hash", "Wildcard *", "https", "data"]);
    expect(f.some((x) => x.directive === "object-src" && x.level === "warn")).toBe(true);
    expect(f.some((x) => x.directive === "base-uri")).toBe(true);
    expect(f.some((x) => x.directive === "frame-ancestors" && x.level === "warn")).toBe(true);
    expect(f.some((x) => x.directive === "report-uri")).toBe(true);
  });
  it("a strict nonce policy with strict-dynamic is mostly clean", () => {
    const f = analyzeCsp(
      parseCsp(
        "default-src 'self'; script-src 'nonce-r4nd0m' 'strict-dynamic' 'unsafe-inline' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; report-to csp",
      )[0]!,
    );
    expect(f.filter((x) => x.level === "bad" || x.level === "warn")).toEqual([]);
    expect(f.find((x) => x.message.startsWith("'strict-dynamic'"))?.level).toBe("good");
  });
  it("report-only, meta-only directives, X-Frame-Options fallback, bypass hosts", () => {
    const ro = analyzeCsp(parseCsp("default-src 'self'", "header", true)[0]!);
    expect(ro[0]).toMatchObject({ directive: "(policy)", level: "warn" });
    const meta = analyzeCsp(parseCsp("default-src 'self'; frame-ancestors 'none'", "meta")[0]!);
    expect(meta.find((x) => x.directive === "frame-ancestors")?.message).toMatch(/Ignored in a <meta>/);
    expect(levels("default-src 'self'", { https: true, xfo: "DENY" })["frame-ancestors:Missing, but X"]).toBe("info");
    const cdn = analyzeCsp(parseCsp("script-src 'self' https://cdn.jsdelivr.net")[0]!);
    expect(cdn.some((x) => /known bypass/.test(x.message))).toBe(true);
  });
  it("starter policy from observed origins", () => {
    const s = starterCsp(
      snapshot({
        scripts: [
          { src: "https://shop.example.co.uk/app.js", integrity: "", crossorigin: null, type: "" },
          { src: "https://www.googletagmanager.com/gtm.js", integrity: "", crossorigin: null, type: "" },
        ],
        styles: [{ href: "https://fonts.googleapis.com/css2?family=Inter", integrity: "", crossorigin: null }],
        images: ["https://cdn.example.co.uk/a.png", "https://shop.example.co.uk/b.png"],
        iframes: [{ src: "https://www.youtube.com/embed/x", sandbox: null, allow: "" }],
        resources: [
          { name: "https://fonts.gstatic.com/s/inter.woff2", type: "css", transfer: 1, encoded: 1, decoded: 1 },
          { name: "https://api.example.co.uk/v1/cart", type: "fetch", transfer: 1, encoded: 1, decoded: 1 },
        ],
        inlineScripts: 2,
        styleAttributes: 3,
        dataImages: true,
      }),
    );
    const d = Object.fromEntries(
      s.policy
        .replace(/;$/, "")
        .split("; ")
        .map((x) => [x.split(" ")[0], x.split(" ").slice(1).join(" ")]),
    );
    expect(d["script-src"]).toBe("'self' https://www.googletagmanager.com 'nonce-{RANDOM}'");
    expect(d["style-src"]).toBe("'self' https://fonts.googleapis.com 'unsafe-inline'");
    expect(d["img-src"]).toBe("'self' https://cdn.example.co.uk data:");
    expect(d["font-src"]).toBe("'self' https://fonts.gstatic.com");
    expect(d["connect-src"]).toBe("'self' https://api.example.co.uk");
    expect(d["frame-src"]).toBe("https://www.youtube.com");
    expect(d["object-src"]).toBe("'none'");
    expect(s.policy).toContain("upgrade-insecure-requests");
    expect(s.notes.join(" ")).toMatch(/2 inline scripts/);
  });
});

describe("cookie audit", () => {
  const now = 1_800_000_000;
  const cookie = (over: Partial<CookieLike>): CookieLike => ({
    name: "pref",
    value: "1",
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    session: true,
    hostOnly: true,
    ...over,
  });
  const ids = (c: Partial<CookieLike>, https = true) => auditCookie(cookie(c), https, now).map((f) => `${f.id}:${f.level}`);
  it("flags risky flags", () => {
    expect(ids({})).toEqual([]);
    expect(ids({ secure: false })).toEqual(["no-secure:warn"]);
    expect(ids({ secure: false }, false)).toEqual([]);
    expect(ids({ name: "sessionid", httpOnly: false })).toEqual(["no-httponly:bad"]);
    expect(ids({ name: "csrftoken" })).toEqual([]);
    expect(ids({ name: "author_pref" })).toEqual([]);
    expect(ids({ sameSite: "no_restriction", secure: false }, false)).toEqual(["samesite-none:bad"]);
    expect(ids({ session: false, expirationDate: now + 86400 * 800 })).toEqual(["long-expiry:info"]);
    expect(ids({ value: "x".repeat(3000) })).toEqual(["large:warn"]);
    expect(ids({ name: "auth_token", httpOnly: true, hostOnly: false, domain: ".example.com" })).toEqual(["domain:info"]);
  });
  it("summarizes the jar", () => {
    const a = auditCookies([cookie({ name: "session", value: "abc123" }), cookie({ secure: false })], "https://example.com/", now);
    const by = Object.fromEntries(a.summary.map((c) => [c.id, c.level]));
    expect(by).toMatchObject({ secure: "warn", httponly: "bad", count: "info" });
    expect(a.perCookie[0]!.map((f) => f.id)).toEqual(["no-httponly"]);
  });
});
