// Refreshes public/vuln-db.json, the vulnerable JavaScript libraries database of the Security tab, from
// Retire.js (https://github.com/RetireJS/retire.js, Apache-2.0). Usage: pnpm vuln-db [git ref]
//
// It downloads repository/jsrepository.json at the latest commit that touched it (or at the given ref)
// and keeps what the panel needs: per library, the URL, file name and file content patterns, the
// global version properties, and each advisory's ranges, severity, CVE / GHSA ids, summary and links.
// File hashes are dropped. Retire's `func` extractors are JavaScript expressions: none is copied as
// code. Plain property paths (`Vue.version`) become paths, a few known expressions are mapped by hand
// below, and anything else is skipped and listed. The license and notice ship next to the data.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "RetireJS/retire.js";
const FILE = "repository/jsrepository.json";

const get = async (url, as = "json") => {
  const res = await fetch(url, { headers: { "user-agent": "devkit-vuln-db" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
};

const ref = process.argv[2];
const [commit] = await get(`https://api.github.com/repos/${REPO}/commits?path=${FILE}&per_page=1${ref ? `&sha=${ref}` : ""}`);
const sha = commit.sha;
const date = commit.commit.committer.date.slice(0, 10);
const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;
const [data, license, notice] = await Promise.all([get(raw(FILE)), get(raw("LICENSE.md"), "text"), get(raw("NOTICE.md"), "text")]);

const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Retire `func` expressions that are not plain property paths, rewritten as data the page script walks. */
const KNOWN = {
  "(window.jQuery || window.$ || window.$jq || window.$j).fn.jquery": ["jQuery", "$", "$jq", "$j"].map((g) => ({
    path: [g, "fn", "jquery"],
  })),
  "tinyMCE.majorVersion + '.'+ tinyMCE.minorVersion": [
    {
      join: [
        ["tinyMCE", "majorVersion"],
        ["tinyMCE", "minorVersion"],
      ],
    },
  ],
  "dojo.version.toString()": [
    {
      join: [
        ["dojo", "version", "major"],
        ["dojo", "version", "minor"],
        ["dojo", "version", "patch"],
      ],
    },
  ],
  "document.querySelector('[ng-version]').getAttribute('ng-version')": [{ selector: "[ng-version]", attr: "ng-version" }],
  // Same attribute as the selector above.
  "window.getAllAngularRootElements()[0].getAttribute(['ng-version'])": [],
  "pendo.VERSION.split('_')[0]": [{ path: ["pendo", "VERSION"], cut: "_" }],
  "__THREE__ ? '0.'+__THREE__+'.0' : undefined": [{ path: ["__THREE__"], template: "0.$.0" }],
  // Would construct a player on the page.
  "new jQuery.jPlayer().version.script": [],
};

const skipped = [];
function probes(lib, func) {
  if (/\brequire\(/.test(func)) return []; // Node only
  if (func in KNOWN) return KNOWN[func];
  // "A && A.b && A.b.c": guards around a property path; the last operand is the path.
  const parts = func.split("&&").map((p) => p.trim());
  if (parts.every((p) => PATH.test(p)))
    return [
      {
        path: parts
          .at(-1)
          .replace(/^window\./, "")
          .split("."),
      },
    ];
  skipped.push(`${lib}: ${func}`);
  return [];
}

const VERSION = "[0-9][0-9.a-z_\\-]+";
const invalid = [];
const patterns = (lib, list) =>
  (list ?? []).filter((p) => {
    try {
      new RegExp(p.replaceAll("§§version§§", VERSION));
      return true;
    } catch {
      invalid.push(`${lib}: ${p}`);
      return false;
    }
  });
/** filecontentreplace entries are "/regex/replacement/". */
const replacements = (lib, list) =>
  (list ?? []).filter((p) => {
    const m = /^\/(.*[^\\])\/([^/]+)\/$/.exec(p);
    if (m && patterns(lib, [m[1]]).length) return true;
    if (!m) invalid.push(`${lib}: ${p}`);
    return false;
  });

const ids = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
const summary = (s) => {
  const one = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 320 ? `${one.slice(0, 319).trimEnd()}…` : one;
};
const IGNORED = new Set(["retire-example", "dont check"]);

const libraries = {};
let advisories = 0;
for (const [name, lib] of Object.entries(data)) {
  if (IGNORED.has(name)) continue;
  const x = lib.extractors ?? {};
  const globals = [...new Set((x.func ?? []).map(String))].flatMap((f) => probes(name, f));
  const vulns = (lib.vulnerabilities ?? []).map((v) => {
    const out = {};
    for (const k of ["atOrAbove", "above", "below"]) if (v[k] !== undefined) out[k] = String(v[k]);
    if (Array.isArray(v.excludes) && v.excludes.length) out.excludes = v.excludes.map(String);
    out.severity = ["low", "medium", "high", "critical"].includes(v.severity) ? v.severity : "medium";
    const cve = ids(v.identifiers?.CVE);
    const ghsa = ids(v.identifiers?.githubID);
    if (cve.length) out.cve = cve;
    if (ghsa.length) out.ghsa = ghsa;
    const text = summary(v.identifiers?.summary);
    if (text) out.summary = text;
    if (v.cwe?.length) out.cwe = ids(v.cwe);
    // Advisory pages for the CVE and GHSA ids are linked from the ids themselves.
    const derived = (u) => /^https:\/\/(nvd\.nist\.gov\/vuln\/detail\/CVE-|github\.com\/advisories\/GHSA-)/.test(u);
    const info = [...new Set(ids(v.info))].filter((u) => /^https?:\/\//.test(u) && !derived(u)).slice(0, 2);
    if (info.length) out.info = info;
    return out;
  });
  advisories += vulns.length;
  const entry = {
    ...(lib.npmname ? { npm: String(lib.npmname) } : {}),
    ...(globals.length ? { globals } : {}),
    uri: patterns(name, x.uri),
    filename: patterns(name, x.filename),
    filecontent: patterns(name, x.filecontent),
    filecontentreplace: replacements(name, x.filecontentreplace),
    vulns,
  };
  for (const k of ["uri", "filename", "filecontent", "filecontentreplace"]) if (!entry[k].length) delete entry[k];
  libraries[name] = entry;
}

const db = {
  source: {
    name: "Retire.js",
    url: `https://github.com/${REPO}`,
    file: FILE,
    commit: sha,
    date,
    license: "Apache-2.0",
    copyright: notice.split("\n")[0].trim(),
    changes:
      "Trimmed by devkit's scripts/vuln-db.mjs: file hashes dropped, func extractors rewritten as property paths, identifiers reduced to CVE and GHSA ids, summaries shortened, links to the NVD and GitHub advisory pages of those ids dropped, at most two other links per advisory.",
  },
  libraries,
};
const out = join(root, "public/vuln-db.json");
writeFileSync(out, `${JSON.stringify(db)}\n`);
writeFileSync(
  join(root, "public/vuln-db.LICENSE.txt"),
  `public/vuln-db.json is derived from the Retire.js vulnerability repository
(${db.source.url}, ${FILE} at commit ${sha}, ${date}).
${db.source.changes}

${notice.trim()}

${license.trim()}
`,
);
console.log(
  `${Object.keys(libraries).length} libraries, ${advisories} advisories, Retire.js ${sha.slice(0, 7)} (${date}) → public/vuln-db.json`,
);
if (skipped.length) console.log(`Skipped func extractors (not a property path):\n  ${skipped.join("\n  ")}`);
if (invalid.length) console.log(`Dropped patterns that do not compile:\n  ${invalid.join("\n  ")}`);
