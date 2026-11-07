import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  affects,
  analyzeLibraries,
  checkVersion,
  compareVersions,
  isAtOrAbove,
  libraryMarkdown,
  normalizeVersion,
  pageProbes,
  recommendedVersion,
  scanContent,
  scanUrl,
  statusCounts,
  type VulnDb,
} from "../src/lib/security/libraries";

const db = JSON.parse(readFileSync(join(process.cwd(), "public/vuln-db.json"), "utf8")) as VulnDb;
const ids = (lib: string, version: string) => checkVersion(db, lib, version).advisories.flatMap((a) => a.cve);

describe("database snapshot", () => {
  it("names its source, commit, date and license", () => {
    expect(db.source.name).toBe("Retire.js");
    expect(db.source.license).toBe("Apache-2.0");
    expect(db.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(db.source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(db.libraries).length).toBeGreaterThan(50);
  });

  it("carries no file hashes and no JavaScript expressions, only property paths", () => {
    const text = JSON.stringify(db);
    expect(text).not.toContain('"hashes"');
    expect(text).not.toContain('"func"');
    for (const l of Object.values(db.libraries))
      for (const g of l.globals ?? [])
        for (const part of [...(g.path ?? []), ...(g.join ?? []).flat()]) expect(part).toMatch(/^[A-Za-z_$][\w$]*$/);
  });

  it("every pattern compiles", () => {
    for (const l of Object.values(db.libraries))
      for (const p of [...(l.uri ?? []), ...(l.filename ?? []), ...(l.filecontent ?? [])])
        expect(() => new RegExp(p.replaceAll("§§version§§", "[0-9][0-9.a-z_\\-]+"))).not.toThrow();
  });
});

describe("version comparison (Retire.js semantics)", () => {
  it("compares numerically, part by part", () => {
    expect(isAtOrAbove("3.4.1", "3.4.0")).toBe(true);
    expect(isAtOrAbove("3.10.0", "3.9.0")).toBe(true);
    expect(isAtOrAbove("3.4", "3.4.0")).toBe(true);
    expect(isAtOrAbove("1.12.4", "3.0.0")).toBe(false);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("3.0.0-rc.1", "3.0.0")).toBe(-1);
    expect(compareVersions("3.0.0-beta1", "3.0.0")).toBe(-1);
    expect(compareVersions("3.5.0", "3.5.0")).toBe(0);
    expect(compareVersions("4.0.0-beta.2", "3.4.1")).toBe(1);
  });

  it("applies atOrAbove, above, below and excludes", () => {
    expect(affects({ atOrAbove: "1.2.0", below: "3.5.0" }, "3.4.1")).toBe(true);
    expect(affects({ atOrAbove: "1.2.0", below: "3.5.0" }, "3.5.0")).toBe(false);
    expect(affects({ atOrAbove: "1.2.0", below: "3.5.0" }, "1.1.9")).toBe(false);
    expect(affects({ above: "2.0.0", below: "3.0.0" }, "2.0.0")).toBe(false);
    expect(affects({ above: "2.0.0", below: "3.0.0" }, "2.0.1")).toBe(true);
    expect(affects({ below: "3.0.0", excludes: ["2.2.4"] }, "2.2.4")).toBe(false);
    expect(affects({}, "1.0.0")).toBe(true);
  });

  it("normalizes found versions", () => {
    expect(normalizeVersion("3.4.1.min")).toBe("3.4.1");
    expect(normalizeVersion(" v3.4.1")).toBe("3.4.1");
    expect(normalizeVersion(150)).toBe("150");
    expect(normalizeVersion("dev")).toBeNull();
    expect(normalizeVersion({})).toBeNull();
  });
});

describe("advisories for real versions", () => {
  it("jQuery 3.4.1: the htmlPrefilter XSS pair, fixed in 3.5.0", () => {
    const cves = ids("jquery", "3.4.1");
    expect(cves).toEqual(expect.arrayContaining(["CVE-2020-11022", "CVE-2020-11023"]));
    expect(cves).not.toContain("CVE-2019-11358");
    const a = checkVersion(db, "jquery", "3.4.1").advisories.find((x) => x.cve.includes("CVE-2020-11022"))!;
    expect(a.severity).toBe("medium");
    expect(a.fixedIn).toBe("3.5.0");
    expect(recommendedVersion(db, "jquery", "3.4.1")).toBe("3.5.0");
  });

  it("jQuery 1.12.4: prototype pollution, CORS script execution, end of life, a major upgrade", () => {
    const { advisories, eol } = checkVersion(db, "jquery", "1.12.4");
    const cves = advisories.flatMap((a) => a.cve);
    expect(cves).toEqual(expect.arrayContaining(["CVE-2015-9251", "CVE-2019-11358", "CVE-2020-11022", "CVE-2020-11023"]));
    expect(eol?.kind).toBe("eol");
    expect(advisories.some((a) => /end-of-life/i.test(a.summary))).toBe(false);
    const [r] = analyzeLibraries([{ lib: "jquery", version: "1.12.4", kind: "global", where: "window.jQuery.fn.jquery" }], db);
    expect(r).toMatchObject({ status: "vulnerable", upgrade: "3.5.0", upgradeMajor: true });
  });

  it("jQuery 3.0.0-rc.1: the pre-release denial of service", () => {
    expect(ids("jquery", "3.0.0-rc.1")).toContain("CVE-2016-10707");
    expect(ids("jquery", "3.0.0")).not.toContain("CVE-2016-10707");
  });

  it("jQuery 3.7.1 is up to date per the database", () => {
    const [r] = analyzeLibraries([{ lib: "jquery", version: "3.7.1", kind: "global", where: "window.jQuery.fn.jquery" }], db);
    expect(r).toMatchObject({ status: "ok", advisories: [], upgrade: null });
  });

  it("lodash 4.17.15: prototype pollution CVE-2020-8203, high", () => {
    const a = checkVersion(db, "lodash", "4.17.15").advisories.find((x) => x.cve.includes("CVE-2020-8203"))!;
    expect(a.severity).toBe("high");
    expect(a.fixedIn).toBe("4.17.19");
    const up = recommendedVersion(db, "lodash", "4.17.15")!;
    expect(checkVersion(db, "lodash", up).advisories).toEqual([]);
    expect(compareVersions(up, "4.17.21")).toBe(1);
  });

  it("Bootstrap 3.3.7: tooltip and data-attribute XSS, end of life", () => {
    const { advisories, eol } = checkVersion(db, "bootstrap", "3.3.7");
    expect(advisories.flatMap((a) => a.cve)).toEqual(expect.arrayContaining(["CVE-2019-8331", "CVE-2018-14042", "CVE-2018-14040"]));
    expect(eol?.text).toMatch(/end-of-life/i);
    const up = recommendedVersion(db, "bootstrap", "3.3.7")!;
    expect(up.startsWith("4.")).toBe(true);
    expect(checkVersion(db, "bootstrap", up)).toEqual({ advisories: [], eol: null });
  });

  it("AngularJS 1.8.3: vulnerable, end of life, no release to upgrade to", () => {
    const [r] = analyzeLibraries([{ lib: "angularjs", version: "1.8.3", kind: "global", where: "window.angular.version.full" }], db);
    expect(r!.status).toBe("vulnerable");
    expect(r!.advisories.length).toBeGreaterThan(0);
    expect(r!.eol).toMatchObject({ kind: "eol" });
    expect(r!.eol!.text).toMatch(/31 December 2021/);
    expect(r!.upgrade).toBeNull();
    expect(r!.advisories.some((a) => a.fixedIn === null)).toBe(true);
  });

  it("orders advisories worst first", () => {
    const sev = checkVersion(db, "lodash", "4.17.4").advisories.map((a) => a.severity);
    const rank = { critical: 4, high: 3, medium: 2, low: 1 };
    expect(sev.map((s) => rank[s])).toEqual([...sev.map((s) => rank[s])].sort((a, b) => b - a));
  });
});

describe("detection", () => {
  it("reads versions from file names and CDN paths", () => {
    expect(scanUrl("https://example.com/js/jquery-3.4.1.min.js", db)).toEqual([
      expect.objectContaining({ lib: "jquery", version: "3.4.1", kind: "filename" }),
    ]);
    expect(scanUrl("https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js", db)[0]).toMatchObject({
      lib: "jquery",
      version: "3.4.1",
      kind: "uri",
    });
    expect(scanUrl("https://ajax.googleapis.com/ajax/libs/angularjs/1.8.2/angular.min.js", db)[0]).toMatchObject({
      lib: "angularjs",
      version: "1.8.2",
    });
    expect(scanUrl("https://cdn.jsdelivr.net/npm/bootstrap@3.3.7/dist/js/bootstrap.min.js", db)[0]).toMatchObject({
      lib: "bootstrap",
      version: "3.3.7",
      kind: "uri",
    });
    expect(scanUrl("https://unpkg.com/lodash@4.17.15/lodash.min.js", db)[0]).toMatchObject({ lib: "lodash", version: "4.17.15" });
    expect(scanUrl("https://example.com/assets/app-3f9a1c.js", db)).toEqual([]);
  });

  it("reads versions from banners and version constants", () => {
    expect(
      scanContent("/*! jQuery v3.4.1 | (c) JS Foundation and other contributors | jquery.org/license */\n!function(e){}", "a.js", db),
    ).toEqual([expect.objectContaining({ lib: "jquery", version: "3.4.1", kind: "content", where: "a.js" })]);
    expect(scanContent("/*!\n * Bootstrap v3.3.7 (http://getbootstrap.com)\n */", "b.js", db)[0]).toMatchObject({
      lib: "bootstrap",
      version: "3.3.7",
    });
    const lodash = "/**\n * @license\n * Lodash <https://lodash.com/>\n */\n;(function() {\n  var undefined;\n  var VERSION = '4.17.15';\n";
    expect(scanContent(lodash, "c.js", db)[0]).toMatchObject({ lib: "lodash", version: "4.17.15" });
    expect(scanContent("/** AngularJS v1.7.9 (c) 2010-2020 Google, Inc. http://angularjs.org */", "d.js", db)[0]).toMatchObject({
      lib: "angularjs",
      version: "1.7.9",
    });
    expect(scanContent("console.log('hello')", "e.js", db)).toEqual([]);
  });

  it("probes cover the usual globals, as property paths", () => {
    const probes = pageProbes(db);
    const exprs = probes.map((p) => p.expr);
    for (const e of [
      "window.jQuery.fn.jquery",
      "window.angular.version.full",
      "window.Vue.version",
      "window.React.version",
      "window._.VERSION",
      "window.moment.version",
      "window.Handlebars.VERSION",
      "window.DOMPurify.version",
      "window.bootstrap.Tooltip.VERSION",
      "[ng-version] attribute",
    ])
      expect(exprs).toContain(e);
    expect(probes.find((p) => p.expr === "window.jQuery.fn.jquery" && p.lib === "jquery")?.presence).toBe(true);
    // jQuery is not Bootstrap's own global: no "version unknown" Bootstrap on every jQuery page.
    expect(probes.find((p) => p.lib === "bootstrap" && p.expr.startsWith("window.jQuery"))?.presence).toBeUndefined();
  });

  it("merges the places one version was seen, and keeps distinct versions apart", () => {
    const url = "https://example.com/js/jquery-3.4.1.min.js";
    const results = analyzeLibraries(
      [
        { lib: "jquery", version: "3.4.1", kind: "global", where: "window.jQuery.fn.jquery" },
        ...scanUrl(url, db),
        ...scanContent("/*! jQuery v3.4.1 | (c) JS Foundation */", "/js/jquery-3.4.1.min.js", db, url),
        { lib: "jquery", version: "3.7.1", kind: "global", where: "window.$.fn.jquery" },
        { lib: "lodash", version: "4.18.1", kind: "global", where: "window._.VERSION" },
      ],
      db,
      [{ lib: "jquery", expr: "window.jQuery" }],
    );
    expect(results.map((r) => `${r.name} ${r.version} ${r.status}`)).toEqual([
      "jQuery 3.4.1 vulnerable",
      "jQuery 3.7.1 ok",
      "Lodash 4.18.1 ok",
    ]);
    expect(results[0]!.sources.map((s) => s.kind)).toEqual(["global", "content", "filename"]);
    expect(statusCounts(results)).toMatchObject({ medium: 1, ok: 2, high: 0 });
  });

  it("reads lodash.min.js as published on npm, which has no version in its banner", () => {
    const min =
      '/**\n * @license\n * Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE\n */\n;(function(){var T;An.VERSION="4.17.15",r("bind bindKey curry curryRight partial partialRight".split(" "),function(n){})})';
    expect(scanContent(min, "lodash.min.js", db)).toEqual([expect.objectContaining({ lib: "lodash", version: "4.17.15" })]);
  });

  it("Vue 2: end of life, and a range ending at a pre-release points to its release", () => {
    const [r] = analyzeLibraries([{ lib: "vue", version: "2.6.14", kind: "global", where: "window.Vue.version" }], db);
    expect(r!.eol).toMatchObject({ kind: "eol" });
    expect(r!.eol!.text).toMatch(/31 December 2023/);
    expect(r!.upgrade).toBe("3.0.0");
    expect(r!.upgradeMajor).toBe(true);
  });

  it("reports a library whose version does not read as unknown", () => {
    const [r] = analyzeLibraries([], db, [{ lib: "bootstrap", expr: "window.bootstrap" }]);
    expect(r).toMatchObject({ status: "unknown", version: null, name: "Bootstrap" });
  });
});

describe("Copy for agent", () => {
  it("names the library, where it was found, the advisories and the upgrade", () => {
    const [r] = analyzeLibraries(
      [
        {
          lib: "jquery",
          version: "3.4.1",
          kind: "filename",
          where: "https://example.com/jquery-3.4.1.min.js",
          url: "https://example.com/jquery-3.4.1.min.js",
        },
      ],
      db,
    );
    const md = libraryMarkdown(r!, { page: "https://example.com/", source: db.source });
    expect(md).toContain("## Vulnerable library: jQuery 3.4.1");
    expect(md).toContain("npm package: `jquery`");
    expect(md).toContain("file name `https://example.com/jquery-3.4.1.min.js`");
    expect(md).toContain("upgrade to jQuery 3.5.0 or later");
    expect(md).toMatch(/\*\*medium\*\* CVE-2020-11022[^\n]*Fixed in 3\.5\.0/);
    expect(md).toContain("https://nvd.nist.gov/vuln/detail/CVE-2020-11022");
    expect(md).toContain("Detection by version only");
    expect(md).toContain(`Retire.js database, ${db.source.date}`);
  });
});
