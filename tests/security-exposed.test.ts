import { describe, expect, it } from "vitest";
import { baselinePath, findSourceMapUrl, isSourceMap, judgeProbe, PROBES, type ProbeResponse } from "../src/lib/security/exposed";

const res = (status: number, text: string, bytes?: number[]): ProbeResponse => ({
  status,
  text,
  bytes: new Uint8Array(bytes ?? [...new TextEncoder().encode(text.slice(0, 64))]),
  type: "text/plain",
  url: "https://ex.com/x",
});
const probe = (path: string) => PROBES.find((p) => p.path === path)!;
const SPA = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

describe("source map detection", () => {
  it("finds the last sourceMappingURL of a script or stylesheet", () => {
    expect(findSourceMapUrl("console.log(1);\n//# sourceMappingURL=app.js.map\n")).toBe("app.js.map");
    expect(findSourceMapUrl("a{color:red}\n/*# sourceMappingURL=main.css.map */")).toBe("main.css.map");
    expect(findSourceMapUrl("x\n//@ sourceMappingURL=old.map")).toBe("old.map");
    expect(findSourceMapUrl("//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==")).toMatch(/^data:/);
  });
  it("ignores files without one", () => {
    expect(findSourceMapUrl("const sourceMappingURL = 1;")).toBeNull();
    expect(findSourceMapUrl("")).toBeNull();
  });
  it("recognizes a source map body", () => {
    expect(isSourceMap('{"version":3,"sources":["a.ts"],"mappings":"AAAA"}')).toBe(true);
    expect(isSourceMap(')]}\'\n{"version":3,"sections":[]}')).toBe(true);
    expect(isSourceMap(SPA)).toBe(false);
    expect(isSourceMap('{"version":2}')).toBe(false);
  });
});

describe("exposed file probes", () => {
  it("reports a real .git/HEAD", () => {
    expect(judgeProbe(probe("/.git/HEAD"), res(200, "ref: refs/heads/main\n"), null)).toMatchObject({ state: "exposed", level: "bad" });
  });
  it("does not report an SPA fallback that answers 200 with index.html", () => {
    const baseline = res(200, SPA);
    for (const p of PROBES) {
      const v = judgeProbe(p, res(200, SPA), baseline);
      expect(v.state, p.path).toBe("fallback");
      expect(v.level === "bad" || v.level === "warn", p.path).toBe(false);
    }
  });
  it("does not report anything on a 404-for-everything server", () => {
    for (const p of PROBES) {
      const v = judgeProbe(p, res(404, "not found"), res(404, "not found"));
      expect(v.state, p.path).toBe("absent");
      expect(["bad", "warn"]).not.toContain(v.level);
    }
  });
  it("a 200 page that is not the file stays unverified, not exposed", () => {
    const v = judgeProbe(probe("/.env"), res(200, "<html><body>Login</body></html>"), res(404, "not found"));
    expect(v).toMatchObject({ state: "unverified", level: "info" });
  });
  it("checks .env, .git/config, .DS_Store, phpinfo and wp-config signatures", () => {
    expect(judgeProbe(probe("/.env"), res(200, "# app\nDB_HOST=localhost\nDB_PASSWORD=fake\n"), null).state).toBe("exposed");
    expect(judgeProbe(probe("/.env"), res(200, "Hello world, this is text"), null).state).toBe("unverified");
    expect(judgeProbe(probe("/.git/config"), res(200, "[core]\n\trepositoryformatversion = 0\n"), null).state).toBe("exposed");
    expect(judgeProbe(probe("/.DS_Store"), res(200, "", [0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0]), null)).toMatchObject({
      state: "exposed",
      level: "warn",
    });
    expect(judgeProbe(probe("/phpinfo.php"), res(200, "<html><title>phpinfo()</title>"), null).state).toBe("exposed");
    expect(judgeProbe(probe("/wp-config.php.bak"), res(200, "<?php define( 'DB_NAME', 'wp' );"), null).state).toBe("exposed");
  });
  it("security.txt present is good, missing is info", () => {
    const p = probe("/.well-known/security.txt");
    expect(judgeProbe(p, res(200, "Contact: mailto:security@example.com\nExpires: 2027-01-01T00:00:00Z\n"), null).level).toBe("good");
    expect(judgeProbe(p, res(404, "not found"), null).level).toBe("info");
  });
  it("403 is neither exposed nor absent", () => {
    expect(judgeProbe(probe("/.git/HEAD"), res(403, "Forbidden"), null).state).toBe("blocked");
  });
  it("random baseline paths", () => {
    expect(baselinePath(() => 0)).toBe("/devkit-probe-aaaaaaaaaaaaaaaa.txt");
    expect(baselinePath()).not.toBe(baselinePath());
  });
});
