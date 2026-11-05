import { describe, expect, it } from "vitest";
import { cachingReport, securityReport } from "../src/lib/headers";

describe("security headers", () => {
  it("grades a hardened response A", () => {
    const r = securityReport(
      {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        server: "nginx",
      },
      "https://example.com/",
    );
    expect(r.grade).toBe("A");
    expect(r.checks.filter((c) => c.level === "bad")).toEqual([]);
  });

  it("flags missing and weak headers", () => {
    const r = securityReport(
      { "content-security-policy": "script-src * 'unsafe-inline' 'unsafe-eval'", server: "Apache/2.4.1", "x-powered-by": "PHP/8.1" },
      "https://example.com/",
    );
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.hsts!.level).toBe("bad");
    expect(byId.csp!.detail).toMatch(/unsafe-inline.*unsafe-eval.*wildcard/);
    expect(byId.framing!.level).toBe("bad");
    expect(byId.leak!.detail).toMatch(/Apache\/2\.4\.1/);
    expect(r.score).toBeLessThan(60);
  });

  it("marks plain http as bad", () => {
    expect(securityReport({}, "http://example.com/").checks[0]).toMatchObject({ id: "https", level: "bad" });
  });

  it("reads caching headers", () => {
    const c = cachingReport({ "cache-control": "max-age=60", etag: '"x"', "cf-cache-status": "HIT", "content-encoding": "br" });
    expect(c.find((x) => x.id === "cdn")!.level).toBe("good");
    expect(c.find((x) => x.id === "compression")!.detail).toBe("br");
  });
});
