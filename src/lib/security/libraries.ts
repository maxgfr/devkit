// Vulnerable JavaScript libraries, Retire.js style: find which library versions a page ships (global
// version properties, script URLs and file names, file banners) and match them against the advisories
// of a bundled Retire.js database snapshot (public/vuln-db.json, refreshed with `pnpm vuln-db`).
// Detection is by version only: it says nothing about whether the vulnerable code path is used.
import type { Level } from "../headers";

export type Severity = "low" | "medium" | "high" | "critical";

/**
 * How to read a version from the page, as data walked by `collectLibrarySignals` (never code to eval):
 * a property path from `window` (or from the element matched by `selector`), several paths joined with
 * dots, or an attribute. `when` / `unless` paths must be truthy / falsy for the probe to apply.
 */
export interface GlobalProbe {
  path?: string[];
  join?: string[][];
  selector?: string;
  attr?: string;
  /** Keep what comes before this separator (`"2.150.0_prod"` → `"2.150.0"`). */
  cut?: string;
  /** Put the value in a template, `$` standing for it (`"0.$.0"`). */
  template?: string;
  when?: string[];
  unless?: string[];
}

export interface DbVuln {
  atOrAbove?: string;
  above?: string;
  below?: string;
  excludes?: string[];
  severity: Severity;
  cve?: string[];
  ghsa?: string[];
  summary?: string;
  cwe?: string[];
  info?: string[];
}

export interface DbLibrary {
  npm?: string;
  globals?: GlobalProbe[];
  uri?: string[];
  filename?: string[];
  filecontent?: string[];
  filecontentreplace?: string[];
  vulns: DbVuln[];
}

export interface VulnDbSource {
  name: string;
  url: string;
  file: string;
  commit: string;
  date: string;
  license: string;
  copyright: string;
  changes: string;
}

export interface VulnDb {
  source: VulnDbSource;
  libraries: Record<string, DbLibrary>;
}

/* Versions */

const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

const comparable = (n: string | undefined): number | string => (n === undefined ? 0 : /^[0-9]+$/.test(n) ? Number.parseInt(n, 10) : n);

/**
 * Retire.js's comparison, kept as is because its ranges are written against it: dot- and dash-separated
 * parts, numbers numerically, a number above a word at the same place (so `3.0.0-rc.1` < `3.0.0`), a
 * missing part counting as 0.
 */
export function isAtOrAbove(a: string, b: string): boolean {
  const v1 = a.split(/[.-]/g);
  const v2 = b.split(/[.-]/g);
  const l = Math.max(v1.length, v2.length);
  for (let i = 0; i < l; i++) {
    const x = comparable(v1[i]);
    const y = comparable(v2[i]);
    if (typeof x !== typeof y) return typeof x === "number";
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** -1, 0 or 1, in Retire.js order. */
export function compareVersions(a: string, b: string): number {
  const ge = isAtOrAbove(a, b);
  const le = isAtOrAbove(b, a);
  return ge && le ? 0 : ge ? 1 : -1;
}

/** Whether `version` falls in the advisory's range (`atOrAbove` ≤ v, `above` < v, v < `below`, not excluded). */
export function affects(v: Pick<DbVuln, "atOrAbove" | "above" | "below" | "excludes">, version: string): boolean {
  if (isDefined(v.below) && isAtOrAbove(version, v.below)) return false;
  if (isDefined(v.atOrAbove) && !isAtOrAbove(version, v.atOrAbove)) return false;
  if (isDefined(v.above) && isAtOrAbove(v.above, version)) return false;
  if (v.excludes?.includes(version)) return false;
  return true;
}

/** Retire.js writes "no fixed version" as an upper bound such as 999.0.0 or 2.999.999. */
export const isOpenBound = (v: string) => v.split(/[.-]/).some((p) => /^\d+$/.test(p) && Number(p) >= 999);
const isRelease = (v: string) => /^\d+(\.\d+)*$/.test(v);
const major = (v: string) => Number.parseInt(v, 10);

/** A version string as found (`3.4.1.min`, ` v3.4.1`) → `3.4.1`, or null when it does not look like one. */
export function normalizeVersion(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== "string") return null;
  const v = raw
    .trim()
    .replace(/^v(?=\d)/i, "")
    .replace(/[.-]min$/, "")
    .replace(/[.\-_]+$/, "");
  return /^\d[\w.+-]{0,39}$/.test(v) ? v : null;
}

/* Names */

const NAMES: Record<string, string> = {
  jquery: "jQuery",
  "jquery-migrate": "jQuery Migrate",
  "jquery-validation": "jQuery Validation",
  "jquery-mobile": "jQuery Mobile",
  "jquery-ui": "jQuery UI",
  "jquery-ui-dialog": "jQuery UI Dialog",
  "jquery-ui-autocomplete": "jQuery UI Autocomplete",
  "jquery-ui-tooltip": "jQuery UI Tooltip",
  "jquery.prettyPhoto": "prettyPhoto",
  "jquery.terminal": "jQuery Terminal",
  "jquery-deparam": "jQuery deparam",
  "tableexport.jquery.plugin": "TableExport",
  knockout: "Knockout",
  swfobject: "SWFObject",
  tinyMCE: "TinyMCE",
  prototypejs: "Prototype",
  ember: "Ember",
  dojo: "Dojo",
  dojox: "DojoX",
  angularjs: "AngularJS",
  "@angular/core": "Angular",
  "backbone.js": "Backbone",
  "mustache.js": "Mustache",
  handlebars: "Handlebars",
  plupload: "Plupload",
  react: "React",
  "react-dom": "React DOM",
  flowplayer: "Flowplayer",
  "moment.js": "Moment.js",
  "underscore.js": "Underscore",
  bootstrap: "Bootstrap",
  ckeditor: "CKEditor 4",
  ckeditor5: "CKEditor 5",
  vue: "Vue",
  ExtJS: "Ext JS",
  svelte: "Svelte",
  axios: "Axios",
  jszip: "JSZip",
  "jquery.datatables": "DataTables",
  nextjs: "Next.js",
  "chart.js": "Chart.js",
  froala: "Froala Editor",
  pendo: "Pendo",
  highcharts: "Highcharts",
  select2: "Select2",
  "blueimp-file-upload": "jQuery File Upload",
  c3: "C3.js",
  lodash: "Lodash",
  "ua-parser-js": "UAParser.js",
  mathjax: "MathJax",
  "pdf.js": "PDF.js",
  pdfobject: "PDFObject",
  threejs: "three.js",
  highlightjs: "highlight.js",
  marked: "Marked",
  alpinejs: "Alpine.js",
  echarts: "Apache ECharts",
  zrender: "ZRender",
  d3: "D3",
  "video.js": "Video.js",
  quill: "Quill",
  swiper: "Swiper",
  mootools: "MooTools",
  protobufjs: "protobuf.js",
};

export const libraryName = (lib: string) => NAMES[lib] ?? lib;

/** npm package of a library when it is not the database key itself (and the key is not a package name). */
const NPM: Record<string, string> = {
  angularjs: "angular",
  "moment.js": "moment",
  "underscore.js": "underscore",
  "backbone.js": "backbone",
  "mustache.js": "mustache",
  nextjs: "next",
  threejs: "three",
  highlightjs: "highlight.js",
  DOMPurify: "dompurify",
  tinyMCE: "tinymce",
  ckeditor: "ckeditor4",
  "pdf.js": "pdfjs-dist",
  "jquery.datatables": "datatables.net",
  ember: "ember-source",
  YUI: "yui",
};

/** The npm package name of `lib`, for npm CDN URLs (jsDelivr, unpkg, esm.sh) and the agent brief. */
export function npmName(db: VulnDb, lib: string): string | undefined {
  const own = NPM[lib] ?? db.libraries[lib]?.npm;
  if (own) return own;
  return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(lib) ? lib : undefined;
}

const npmIndex = new WeakMap<VulnDb, Map<string, string>>();
function libForPackage(db: VulnDb, pkg: string): string | undefined {
  let index = npmIndex.get(db);
  if (!index) {
    index = new Map();
    for (const lib of Object.keys(db.libraries)) {
      const name = npmName(db, lib);
      if (name && !index.has(name)) index.set(name, lib);
    }
    npmIndex.set(db, index);
  }
  return index.get(pkg);
}

/** `https://cdn.jsdelivr.net/npm/bootstrap@3.3.7/dist/js/bootstrap.min.js` → bootstrap 3.3.7. */
const NPM_CDN = /^https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/((?:@[\w.-]+\/)?[\w.-]+)@(\d[\w.+-]*)(?:[/?#]|$)/i;

/* Page probes */

export interface PageProbe extends GlobalProbe {
  lib: string;
  /** What is read, for the "found in" line: `window.jQuery.fn.jquery`. */
  expr: string;
  /** Report the library as "version unknown" when the root global exists but no version reads. */
  presence?: boolean;
}

/** Version properties Retire.js has no `func` for, or reads under another name. */
export const EXTRA_PROBES: Record<string, GlobalProbe[]> = {
  react: [{ path: ["React", "version"] }],
  "react-dom": [{ path: ["ReactDOM", "version"] }],
  // `_` is Lodash when it has runInContext, Underscore otherwise.
  lodash: [{ path: ["_", "VERSION"], when: ["_", "runInContext"] }],
  "underscore.js": [{ path: ["_", "VERSION"], unless: ["_", "runInContext"] }],
  bootstrap: [
    { path: ["bootstrap", "Tooltip", "VERSION"] },
    { path: ["bootstrap", "Modal", "VERSION"] },
    { path: ["jQuery", "fn", "tooltip", "Constructor", "VERSION"] },
    { path: ["jQuery", "fn", "modal", "Constructor", "VERSION"] },
  ],
  "jquery-migrate": [{ path: ["jQuery", "migrateVersion"] }],
  tinyMCE: [
    {
      join: [
        ["tinymce", "majorVersion"],
        ["tinymce", "minorVersion"],
      ],
    },
  ],
  vue: [{ selector: "[data-v-app]", path: ["__vue_app__", "version"] }],
  "jquery.datatables": [{ path: ["jQuery", "fn", "dataTable", "version"] }],
  "chart.js": [{ path: ["Chart", "version"] }],
  d3: [{ path: ["d3", "version"] }],
  highcharts: [{ path: ["Highcharts", "version"] }],
  alpinejs: [{ path: ["Alpine", "version"] }],
  "video.js": [{ path: ["videojs", "VERSION"] }],
  highlightjs: [{ path: ["hljs", "versionString"] }],
  echarts: [{ path: ["echarts", "version"] }],
  "pdf.js": [{ path: ["pdfjsLib", "version"] }],
  quill: [{ path: ["Quill", "version"] }],
};

/** Each library's own globals, distinctive enough that finding one without a version is worth a "version unknown" line. */
const PRESENCE: Record<string, string[]> = {
  jquery: ["jQuery"],
  angularjs: ["angular"],
  vue: ["Vue"],
  react: ["React"],
  "moment.js": ["moment"],
  handlebars: ["Handlebars"],
  DOMPurify: ["DOMPurify"],
  "backbone.js": ["Backbone"],
  ember: ["Ember"],
  prototypejs: ["Prototype"],
  ckeditor: ["CKEDITOR"],
  tinyMCE: ["tinymce", "tinyMCE"],
  bootstrap: ["bootstrap"],
  highcharts: ["Highcharts"],
  "mustache.js": ["Mustache"],
  mootools: ["MooTools"],
};

export function probeExpr(p: GlobalProbe): string {
  const path = (parts: string[]) => parts.join(".");
  let expr = "";
  if (p.selector) expr = p.attr ? `[${p.attr}] attribute` : `${p.selector}.${path(p.path ?? [])}`;
  else if (p.join) expr = p.join.map((j) => `window.${path(j)}`).join(` + "." + `);
  else if (p.path) expr = `window.${path(p.path)}`;
  return expr;
}

/** Every probe for the libraries of `db`: Retire's own, then devkit's extras. */
export function pageProbes(db: VulnDb): PageProbe[] {
  const out: PageProbe[] = [];
  const seen = new Set<string>();
  for (const [lib, entry] of Object.entries(db.libraries)) {
    for (const p of [...(entry.globals ?? []), ...(EXTRA_PROBES[lib] ?? [])]) {
      const key = `${lib} ${JSON.stringify(p)}`;
      if (seen.has(key) || !(p.path || p.join || p.attr)) continue;
      seen.add(key);
      const root = p.selector ? undefined : (p.path ?? p.join?.[0])?.[0];
      out.push({ ...p, lib, expr: probeExpr(p), presence: root && PRESENCE[lib]?.includes(root) ? true : undefined });
    }
  }
  return out;
}

/* Detection */

export type SourceKind = "global" | "uri" | "filename" | "content";

export interface Detection {
  lib: string;
  version: string;
  kind: SourceKind;
  /** Human label of the place: `window.jQuery.fn.jquery`, `/js/jquery-3.4.1.min.js`, `inline script #2`. */
  where: string;
  url?: string;
}

const VERSION_RE = "[0-9][0-9.a-z_\\-]+";
const MAX_MATCHES = 20;

/** File content patterns the database lacks, in its format. */
export const EXTRA_CONTENT: Record<string, string[]> = {
  // lodash.min.js as published on npm (and served by jsDelivr and unpkg) has no version in its banner.
  lodash: ['\\.VERSION="(§§version§§)",[\\w$]{1,3}\\("bind bindKey curry curryRight partial partialRight"'],
};

interface Compiled {
  uri: [string, RegExp][];
  filename: [string, RegExp][];
  filecontent: [string, RegExp][];
  replace: [string, RegExp, string][];
}

const compiledCache = new WeakMap<VulnDb, Compiled>();

function compile(db: VulnDb): Compiled {
  const hit = compiledCache.get(db);
  if (hit) return hit;
  const out: Compiled = { uri: [], filename: [], filecontent: [], replace: [] };
  const re = (p: string, anchored = false) => {
    const src = p.replaceAll("§§version§§", VERSION_RE);
    try {
      return new RegExp(anchored ? `^${src}$` : src, "g");
    } catch {
      return null;
    }
  };
  for (const [lib, l] of Object.entries(db.libraries)) {
    for (const p of l.uri ?? []) {
      const r = re(p);
      if (r) out.uri.push([lib, r]);
    }
    for (const p of l.filename ?? []) {
      const r = re(p, true);
      if (r) out.filename.push([lib, r]);
    }
    for (const p of [...(l.filecontent ?? []), ...(EXTRA_CONTENT[lib] ?? [])]) {
      const r = re(p);
      if (r) out.filecontent.push([lib, r]);
    }
    for (const p of l.filecontentreplace ?? []) {
      const m = /^\/(.*[^\\])\/([^/]+)\/$/.exec(p);
      const r = m ? re(m[1]!) : null;
      if (m && r) out.replace.push([lib, r, m[2]!]);
    }
  }
  compiledCache.set(db, out);
  return out;
}

/** Group 1 of every match of `re` in `text` (or the match rewritten with `replacement`). */
function matches(re: RegExp, text: string, replacement?: string): string[] {
  const found: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && found.length < MAX_MATCHES; m = re.exec(text)) {
    if (m[0] === "") re.lastIndex++;
    const raw = replacement === undefined ? m[1] : m[0].replace(new RegExp(re.source), replacement);
    if (raw) found.push(raw);
  }
  re.lastIndex = 0;
  return found;
}

function dedupe(list: Detection[]): Detection[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.lib} ${d.version} ${d.kind} ${d.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Library versions written in a script URL: CDN paths (`/3.4.1/jquery.min.js`) and file names (`jquery-3.4.1.min.js`). */
/** What the page itself tells (globals, script URLs, inline scripts), without fetching any file. */
export function snapshotDetections(
  data: { globals: { lib: string; version: string; expr: string }[]; scripts: string[]; inline: { label: string; text: string }[] },
  db: VulnDb,
): Detection[] {
  const out: Detection[] = data.globals.map((g) => ({ lib: g.lib, version: g.version.replace(/^v/i, ""), kind: "global", where: g.expr }));
  for (const url of data.scripts) out.push(...scanUrl(url, db));
  for (const s of data.inline) out.push(...scanContent(s.text, s.label, db));
  return out;
}

export function scanUrl(url: string, db: VulnDb): Detection[] {
  const c = compile(db);
  const clean = url.split("#")[0]!;
  const file = clean.split("?")[0]!.split(/[/\\]/).pop() ?? "";
  const out: Detection[] = [];
  for (const [lib, re] of c.uri)
    for (const raw of matches(re, clean)) {
      const version = normalizeVersion(raw);
      if (version) out.push({ lib, version, kind: "uri", where: url, url });
    }
  for (const [lib, re] of c.filename)
    for (const raw of matches(re, file)) {
      const version = normalizeVersion(raw);
      if (version) out.push({ lib, version, kind: "filename", where: url, url });
    }
  const cdn = NPM_CDN.exec(clean);
  const cdnLib = cdn ? libForPackage(db, cdn[1]!.toLowerCase()) : undefined;
  const cdnVersion = cdn ? normalizeVersion(cdn[2]) : null;
  if (cdnLib && cdnVersion) out.push({ lib: cdnLib, version: cdnVersion, kind: "uri", where: url, url });
  // A file name match also matches its URI pattern most of the time: keep one per library and version.
  const seen = new Set<string>();
  return dedupe(out).filter((d) => {
    const key = `${d.lib} ${d.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Versions announced inside a script: license banners (`/*! jQuery v3.4.1`) and version constants. */
export function scanContent(text: string, where: string, db: VulnDb, url?: string): Detection[] {
  const c = compile(db);
  const normalized = text.replace(/\r\n?/g, "\n");
  const out: Detection[] = [];
  for (const [lib, re] of c.filecontent)
    for (const raw of matches(re, normalized)) {
      const version = normalizeVersion(raw);
      if (version) out.push({ lib, version, kind: "content", where, url });
    }
  if (!out.length)
    for (const [lib, re, replacement] of c.replace)
      for (const raw of matches(re, normalized, replacement)) {
        const version = normalizeVersion(raw);
        if (version) out.push({ lib, version, kind: "content", where, url });
      }
  return dedupe(out);
}

/* Matching */

export interface Advisory {
  key: string;
  severity: Severity;
  summary: string;
  cve: string[];
  ghsa: string[];
  cwe: string[];
  info: string[];
  /** Affected range, `>=1.2.0 <3.5.0`. */
  range: string;
  /** First version out of the range, or null when the database knows no fix. */
  fixedIn: string | null;
}

export interface EolNote {
  text: string;
  /** "eol": no more fixes; "maintenance": kept alive but not developed. */
  kind: "eol" | "maintenance";
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
export const severityRank = (s: Severity) => SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);

export const SEVERITY_LEVEL: Record<Severity, Level> = { critical: "bad", high: "bad", medium: "warn", low: "info" };

/** Data entries that announce an end of life rather than a vulnerability. */
const isEolEntry = (v: DbVuln) =>
  !v.cve?.length && !v.ghsa?.length && /end[- ]of[- ]life|no longer (maintained|supported)/i.test(v.summary ?? "");

/** End-of-life facts the database does not carry (or says less clearly). */
const EOL_NOTES: { lib: string; atOrAbove?: string; below?: string; note: EolNote }[] = [
  {
    lib: "angularjs",
    below: "2",
    note: {
      kind: "eol",
      text: "AngularJS 1.x reached end of life on 31 December 2021: no more releases, security fixes included. Moving off it means migrating to Angular or another framework, not upgrading.",
    },
  },
  {
    lib: "vue",
    atOrAbove: "2.0.0",
    below: "3",
    note: {
      kind: "eol",
      text: "Vue 2 reached end of life on 31 December 2023: no more releases, security fixes included. Vue 3 is a migration (a compatibility build helps).",
    },
  },
  {
    lib: "moment.js",
    note: {
      kind: "maintenance",
      text: "Moment.js is a legacy project in maintenance mode since September 2020; its docs suggest Luxon, Day.js, date-fns or Temporal for new code.",
    },
  },
];

const rangeText = (v: DbVuln) =>
  [
    v.atOrAbove ? `>=${v.atOrAbove}` : "",
    v.above ? `>${v.above}` : "",
    v.below && !isOpenBound(v.below) ? `<${v.below}` : v.below ? "(every later version)" : "",
  ]
    .filter(Boolean)
    .join(" ") || "every version";

function toAdvisory(v: DbVuln): Advisory {
  return {
    key: v.cve?.[0] ?? v.ghsa?.[0] ?? v.summary ?? rangeText(v),
    severity: v.severity,
    summary: v.summary ?? "",
    cve: v.cve ?? [],
    ghsa: v.ghsa ?? [],
    cwe: v.cwe ?? [],
    info: v.info ?? [],
    range: rangeText(v),
    fixedIn: v.below && !isOpenBound(v.below) ? v.below : null,
  };
}

/** The advisories of `lib` that apply to `version`, worst first, and its end-of-life note. */
export function checkVersion(db: VulnDb, lib: string, version: string): { advisories: Advisory[]; eol: EolNote | null } {
  const entry = db.libraries[lib];
  const advisories: Advisory[] = [];
  let eol: EolNote | null = null;
  const seen = new Set<string>();
  for (const v of entry?.vulns ?? []) {
    if (!affects(v, version)) continue;
    if (isEolEntry(v)) {
      eol ??= { kind: "eol", text: v.summary! };
      continue;
    }
    const a = toAdvisory(v);
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    advisories.push(a);
  }
  const own = EOL_NOTES.find((n) => n.lib === lib && affects(n, version));
  if (own && (own.note.kind === "eol" || !eol)) eol = own.note;
  advisories.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || compareVersions(b.fixedIn ?? "999", a.fixedIn ?? "999"));
  return { advisories, eol };
}

/**
 * The first release above `version` that the database flags for nothing (no advisory, no end of
 * life), among the versions its ranges end at. Null when every such version is still affected.
 */
export function recommendedVersion(db: VulnDb, lib: string, version: string): string | null {
  const vulns = db.libraries[lib]?.vulns ?? [];
  // A range ending at a pre-release (3.0.0-alpha.0) is left by that release (3.0.0).
  const candidates = [...new Set(vulns.map((v) => v.below?.replace(/^(\d+(?:\.\d+)*)-.*$/, "$1")).filter(isDefined))]
    .filter((v) => isRelease(v) && !isOpenBound(v) && compareVersions(v, version) > 0)
    .sort(compareVersions);
  return candidates.find((c) => vulns.every((v) => !affects(v, c))) ?? null;
}

export type LibraryStatus = "vulnerable" | "eol" | "ok" | "unknown";

export interface LibraryResult {
  /** Stable key: library and version. */
  key: string;
  lib: string;
  name: string;
  npm?: string;
  version: string | null;
  sources: Omit<Detection, "lib" | "version">[];
  status: LibraryStatus;
  /** Worst advisory severity, for vulnerable libraries. */
  severity: Severity | null;
  advisories: Advisory[];
  eol: EolNote | null;
  upgrade: string | null;
  /** The recommended version is a new major version. */
  upgradeMajor: boolean;
}

const STATUS_ORDER: Record<LibraryStatus, number> = { vulnerable: 0, eol: 1, unknown: 2, ok: 3 };

/**
 * One result per library and version: every place it was seen, the advisories that apply and the
 * upgrade to aim for. `present` lists libraries found without a readable version.
 */
export function analyzeLibraries(detections: Detection[], db: VulnDb, present: { lib: string; expr: string }[] = []): LibraryResult[] {
  const groups = new Map<string, Detection[]>();
  for (const d of detections) {
    if (!db.libraries[d.lib]) continue;
    const key = `${d.lib}@${d.version}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const results: LibraryResult[] = [];
  for (const [key, list] of groups) {
    const { lib, version } = list[0]!;
    const { advisories, eol } = checkVersion(db, lib, version);
    const upgrade = advisories.length || eol?.kind === "eol" ? recommendedVersion(db, lib, version) : null;
    results.push({
      key,
      lib,
      name: libraryName(lib),
      npm: npmName(db, lib),
      version,
      sources: dedupeSources(list),
      status: advisories.length ? "vulnerable" : eol?.kind === "eol" ? "eol" : "ok",
      severity: advisories[0]?.severity ?? null,
      advisories,
      eol,
      upgrade,
      upgradeMajor: upgrade !== null && major(upgrade) !== major(version),
    });
  }
  const versioned = new Set(results.map((r) => r.lib));
  const unknown = new Map<string, string[]>();
  for (const p of present) if (db.libraries[p.lib] && !versioned.has(p.lib)) unknown.set(p.lib, [...(unknown.get(p.lib) ?? []), p.expr]);
  for (const [lib, exprs] of unknown)
    results.push({
      key: `${lib}@?`,
      lib,
      name: libraryName(lib),
      npm: npmName(db, lib),
      version: null,
      sources: [...new Set(exprs)].map((where) => ({ kind: "global" as const, where })),
      status: "unknown",
      severity: null,
      advisories: [],
      eol: null,
      upgrade: null,
      upgradeMajor: false,
    });
  return results.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.severity ? severityRank(b.severity) : 0) - (a.severity ? severityRank(a.severity) : 0) ||
      b.advisories.length - a.advisories.length ||
      a.name.localeCompare(b.name),
  );
}

const KIND_ORDER: Record<SourceKind, number> = { global: 0, content: 1, filename: 2, uri: 3 };

function dedupeSources(list: Detection[]): LibraryResult["sources"] {
  const seen = new Set<string>();
  const out: LibraryResult["sources"] = [];
  for (const d of [...list].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])) {
    const key = `${d.kind} ${d.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: d.kind, where: d.where, ...(d.url ? { url: d.url } : {}) });
  }
  return out;
}

/** Vulnerable libraries counted by their worst advisory, plus the other statuses. */
export function statusCounts(results: LibraryResult[]): Record<Severity | "eol" | "ok" | "unknown", number> {
  const out = { critical: 0, high: 0, medium: 0, low: 0, eol: 0, ok: 0, unknown: 0 };
  for (const r of results) {
    if (r.status === "vulnerable" && r.severity) out[r.severity]++;
    else if (r.status !== "vulnerable") out[r.status]++;
  }
  return out;
}

/* Links and Markdown */

export const cveUrl = (id: string) => `https://nvd.nist.gov/vuln/detail/${id}`;
export const ghsaUrl = (id: string) => `https://github.com/advisories/${id}`;

export const SOURCE_LABEL: Record<SourceKind, string> = {
  global: "global",
  content: "file content",
  filename: "file name",
  uri: "URL",
};

export const DISCLAIMER = "Detection by version only: a vulnerable version may not be exploitable in how the page uses it.";

/** A brief for a coding agent: the library, where the page loads it, what is known and what to upgrade to. */
export function libraryMarkdown(r: LibraryResult, ctx: { page?: string; source: VulnDbSource }): string {
  const lines: string[] = [];
  const title = `${r.name} ${r.version ?? "(version unknown)"}`;
  lines.push(`## ${r.status === "vulnerable" ? "Vulnerable library" : r.status === "eol" ? "End-of-life library" : "Library"}: ${title}`);
  lines.push("");
  if (ctx.page) lines.push(`- Page: ${ctx.page}`);
  if (r.npm) lines.push(`- npm package: \`${r.npm}\``);
  lines.push(`- Found in: ${r.sources.map((s) => `${SOURCE_LABEL[s.kind]} \`${s.url ?? s.where}\``).join("; ")}`);
  if (r.upgrade)
    lines.push(
      `- Recommended: upgrade to ${r.name} ${r.upgrade} or later${r.upgradeMajor ? " (a new major version: check its migration guide)" : ""}, the first release the database flags for nothing.`,
    );
  else if (r.advisories.length || r.eol?.kind === "eol")
    lines.push("- Recommended: no release in the database is free of these issues; plan a replacement.");
  if (r.eol) lines.push(`- ${r.eol.kind === "eol" ? "End of life" : "Maintenance"}: ${r.eol.text}`);
  if (r.advisories.length) {
    lines.push("", `### Advisories (${r.advisories.length})`, "");
    for (const a of r.advisories) {
      const ids = [...a.cve, ...a.ghsa];
      const links = [...a.cve.map(cveUrl), ...a.ghsa.map(ghsaUrl), ...a.info].slice(0, 3);
      lines.push(
        `- **${a.severity}**${ids.length ? ` ${ids.join(", ")}` : ""}: ${a.summary || "(no summary)"} Affects ${a.range}. ${a.fixedIn ? `Fixed in ${a.fixedIn}.` : "No fixed version known."}${links.length ? ` ${links.join(" ")}` : ""}`,
      );
    }
  }
  lines.push(
    "",
    `${DISCLAIMER} Find where the page gets it (package.json, a vendored file, a CDN tag, a plugin or theme bundling it) and upgrade it there; then check the app still works.`,
    `Source: ${ctx.source.name} database, ${ctx.source.date} (${ctx.source.url}, commit ${ctx.source.commit.slice(0, 7)}).`,
  );
  return lines.join("\n");
}
