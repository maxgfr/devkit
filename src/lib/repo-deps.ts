// Repository dependencies (Inspect › Repo dependencies, and the opt-in box on GitHub / GitLab pages): which
// repository and folder a page shows, which manifest files to read there, one parser per manifest, and the links
// and registry lookups for each package. Framework-free: the side panel, the background and the content script
// all import it.

export type RepoHost = "github" | "gitlab";
export type Ecosystem = "npm" | "pypi" | "crates" | "go" | "packagist" | "rubygems";
export type DepKind = "runtime" | "dev" | "peer" | "optional" | "build" | "workspace";

export interface RepoLocation {
  host: RepoHost;
  origin: string;
  /** GitHub owner, or the GitLab namespace path (group and subgroups). */
  owner: string;
  repo: string;
  /** Branch, tag or commit; null when the URL names none (the default branch). */
  ref: string | null;
  /** Folder inside the repository: "" for the root, no leading or trailing slash. */
  dir: string;
}

/** What the page itself says, read from its DOM: it settles self-hosted instances and refs with slashes. */
export interface RepoPageHint {
  host?: RepoHost;
  /**
   * GitLab: the project's full path, which tells groups from projects. An empty string means "not a project page".
   * (GitHub URLs say it on their own, and its meta tags can lag behind in-app navigation.)
   */
  project?: string;
  /** The ref the page's branch picker shows. */
  ref?: string;
}

export interface Dependency {
  name: string;
  /** Requested version or range, as written in the manifest. */
  version?: string;
  kind: DepKind;
  ecosystem: Ecosystem;
  /** Extra, dependency group, Gemfile group or Cargo target the dependency belongs to. */
  group?: string;
  /** Extras, features, environment markers, git or path source… */
  note?: string;
  /** Go: required only by other dependencies (`// indirect`). */
  indirect?: boolean;
  /** Cargo: the name the code uses when the dependency is renamed with `package =`. */
  alias?: string;
  /** Not resolved from the registry: a git checkout, a local path, a URL or a workspace package. */
  source?: "git" | "path" | "url" | "workspace";
}

export interface ParsedManifest {
  /** Path inside the repository. */
  path: string;
  ecosystem: Ecosystem;
  /** The package or module the manifest declares. */
  name?: string;
  deps: Dependency[];
  /** npm workspaces, Cargo workspace members. */
  workspaces: string[];
  error?: string;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Where the page points                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

// First path segments of github.com that are not owners.
const GITHUB_RESERVED = new Set(
  (
    "about account apps blog codespaces collections contact copilot customer-stories dashboard enterprise events explore features " +
    "github-copilot issues join login logout marketplace models new notifications organizations orgs partners pricing pulls readme " +
    "resources search security sessions settings signup site solutions sponsors stars team topics trending users watching discussions"
  ).split(" "),
);
// First path segments of GitLab that are not namespaces.
const GITLAB_RESERVED = new Set("- admin dashboard explore groups help oauth profile projects search users api".split(" "));

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Splits "<ref>/<path>" after /tree/ or /blob/: the page's ref wins when the segments start with it, else the first segment. */
function splitRef(rest: string[], hintRef: string | undefined): { ref: string; path: string[] } {
  if (hintRef) {
    const parts = hintRef.split("/");
    if (parts.length <= rest.length && parts.every((p, i) => p === rest[i])) return { ref: hintRef, path: rest.slice(parts.length) };
  }
  return { ref: rest[0]!, path: rest.slice(1) };
}

function locate(view: string, rest: string[], hintRef: string | undefined): { ref: string | null; dir: string } | null {
  if (view !== "tree" && view !== "blob") return null;
  if (!rest.length) return { ref: null, dir: "" };
  const { ref, path } = splitRef(rest, hintRef);
  return { ref, dir: (view === "blob" ? path.slice(0, -1) : path).join("/") };
}

/**
 * The repository and folder a GitHub or GitLab URL shows, or null when it is not a repository code page (settings,
 * issues, pull requests, organizations…). github.com and gitlab.com are known; other hosts need `hint.host`. On the
 * repository's home page the URL names no ref: the page's one (`hint.ref`, the default branch) is used when given.
 */
export function parseRepoUrl(url: string, hint: RepoPageHint = {}): RepoLocation | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host: RepoHost | undefined = u.hostname === "github.com" ? "github" : u.hostname === "gitlab.com" ? "gitlab" : hint.host;
  if (!host) return null;
  const segs = u.pathname.split("/").filter(Boolean).map(decode);

  if (host === "github") {
    if (segs.length < 2 || GITHUB_RESERVED.has(segs[0]!.toLowerCase())) return null;
    const owner = segs[0]!;
    const repo = segs[1]!.replace(/\.git$/, "");
    if (segs.length === 2) return { host, origin: u.origin, owner, repo, ref: hint.ref ?? null, dir: "" };
    const at = locate(segs[2]!, segs.slice(3), hint.ref);
    return at ? { host, origin: u.origin, owner, repo, ...at } : null;
  }

  if (hint.project === "") return null;
  const dash = segs.indexOf("-");
  let project = dash === -1 ? segs : segs.slice(0, dash);
  if (hint.project) {
    const parts = hint.project.split("/");
    const starts = parts.length <= project.length && parts.every((p, i) => p.toLowerCase() === project[i]!.toLowerCase());
    if (!starts || (dash === -1 && project.length !== parts.length)) return null;
    project = project.slice(0, parts.length);
  }
  if (project.length < 2 || GITLAB_RESERVED.has(project[0]!.toLowerCase())) return null;
  const base = { host, origin: u.origin, owner: project.slice(0, -1).join("/"), repo: project.at(-1)!.replace(/\.git$/, "") };
  if (dash === -1) return { ...base, ref: hint.ref ?? null, dir: "" };
  const at = locate(segs[dash + 1] ?? "", segs.slice(dash + 2), hint.ref);
  return at ? { ...base, ...at } : null;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export const joinPath = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);

/** URL of a file of the repository at the location's ref (HEAD, the default branch, when the URL names none). */
export function repoFileUrl(loc: RepoLocation, path: string, view: "raw" | "blob" | "tree" = "blob"): string {
  const ref = encodePath(loc.ref ?? "HEAD");
  const sep = loc.host === "gitlab" ? "/-" : "";
  return `${loc.origin}/${encodePath(loc.owner)}/${encodeURIComponent(loc.repo)}${sep}/${view}/${ref}/${encodePath(path)}`;
}

export const repoLabel = (loc: RepoLocation) => `${loc.owner}/${loc.repo}${loc.dir ? `/${loc.dir}` : ""}`;

/* ------------------------------------------------------------------------------------------------------------ */
/* Manifests                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** Manifest files looked for in the folder, with the registry their packages come from. */
export const MANIFESTS: { file: string; ecosystem: Ecosystem }[] = [
  { file: "package.json", ecosystem: "npm" },
  { file: "pyproject.toml", ecosystem: "pypi" },
  { file: "requirements.txt", ecosystem: "pypi" },
  { file: "requirements-dev.txt", ecosystem: "pypi" },
  { file: "Cargo.toml", ecosystem: "crates" },
  { file: "go.mod", ecosystem: "go" },
  { file: "composer.json", ecosystem: "packagist" },
  { file: "Gemfile", ecosystem: "rubygems" },
];

/** requirements.txt, requirements-dev.txt, requirements_test.txt, dev-requirements.txt… */
export const REQUIREMENTS_FILE = /^(?:[\w.-]+[-_])?requirements(?:[-_.][\w.-]+)?\.txt$/i;

const DEV_REQUIREMENTS = /(?:^|[-_.])(?:dev|develop|test|tests|lint|docs?|ci)(?:[-_.]|$)/i;

export function manifestEcosystem(path: string): Ecosystem | null {
  const file = path.split("/").at(-1) ?? "";
  if (REQUIREMENTS_FILE.test(file)) return "pypi";
  return MANIFESTS.find((m) => m.file === file)?.ecosystem ?? null;
}

/** Folders on GitHub and GitLab list at most this many entries before "show more": past it, probe every manifest. */
const LISTING_PAGE = 100;

/**
 * Files to fetch in the folder. With the folder's listing from the page, only the manifests it holds (and every
 * requirements*.txt); without it, every known manifest name.
 */
export function manifestCandidates(listing: string[] | null): string[] {
  if (!listing) return MANIFESTS.map((m) => m.file);
  const names = new Set(listing);
  const out = MANIFESTS.map((m) => m.file).filter((f) => names.has(f) || listing.length >= LISTING_PAGE);
  for (const f of listing) if (REQUIREMENTS_FILE.test(f) && !out.includes(f)) out.push(f);
  return out;
}

/**
 * Names of the files directly in `loc.dir`, from the file links of the page's folder listing (hrefs like
 * /owner/repo/blob/<ref>/<path> or /group/project/-/blob/<ref>/<path>). Null when the page listed nothing.
 */
export function listedFiles(loc: RepoLocation, hrefs: string[]): string[] | null {
  const files = new Set<string>();
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href, loc.origin);
    } catch {
      continue;
    }
    const segs = u.pathname.split("/").filter(Boolean).map(decode);
    const at = segs.indexOf("blob");
    if (at < 0) continue;
    const rest = segs.slice(at + 1);
    const { path } = splitRef(rest, loc.ref ?? undefined);
    if (!path.length) continue;
    if (path.slice(0, -1).join("/") === loc.dir) files.add(path.at(-1)!);
  }
  return files.size ? [...files] : null;
}

export const MAX_MANIFEST_BYTES = 512 * 1024;

export interface RepoFileRequest {
  path: string;
  raw: string;
  blob?: string;
}

export interface RepoFileResult {
  path: string;
  status: number;
  text?: string;
  tooLarge?: boolean;
  error?: string;
}

export interface RepoPageFacts {
  site: RepoHost | null;
  project: string | null;
  ref: string | null;
  links: string[];
}

export interface RepoDeps {
  loc: RepoLocation;
  manifests: ParsedManifest[];
  /** Manifests that exist (or may) but could not be read: access, size, network. */
  failed: { path: string; reason: string }[];
  /** How many files were asked for. */
  probed: number;
}

const failure = (f: RepoFileResult) =>
  f.tooLarge
    ? `larger than ${MAX_MANIFEST_BYTES / 1024} KB`
    : f.status === 401 || f.status === 403
      ? "needs a signed-in session with access to the repository"
      : f.status
        ? `HTTP ${f.status}`
        : (f.error ?? "request failed");

/**
 * Finds and parses the manifests of the folder `url` shows. `facts` come from the page (`readRepoPage`) and
 * `fetchFiles` reads files with the page's session (`fetchRepoFiles`, run in the tab or called by the content
 * script). Null when the page is not a repository folder.
 */
export async function loadRepoDeps(
  url: string,
  facts: RepoPageFacts,
  fetchFiles: (files: RepoFileRequest[], maxBytes: number) => Promise<RepoFileResult[]>,
): Promise<RepoDeps | null> {
  const loc = parseRepoUrl(url, { host: facts.site ?? undefined, project: facts.project ?? undefined, ref: facts.ref ?? undefined });
  if (!loc) return null;
  const listing = listedFiles(loc, facts.links);
  const requests = manifestCandidates(listing).map((file) => {
    const path = joinPath(loc.dir, file);
    return { path, raw: repoFileUrl(loc, path, "raw"), blob: loc.host === "github" ? repoFileUrl(loc, path, "blob") : undefined };
  });
  const files = requests.length ? await fetchFiles(requests, MAX_MANIFEST_BYTES) : [];
  return {
    loc,
    manifests: files.filter((f) => f.text !== undefined).map((f) => parseManifest(f.path, f.text!)),
    failed: files.filter((f) => f.text === undefined && f.status !== 404).map((f) => ({ path: f.path, reason: failure(f) })),
    probed: requests.length,
  };
}

/** Parses a manifest by its file name. Never throws: a broken file comes back with `error`. */
export function parseManifest(path: string, text: string): ParsedManifest {
  const ecosystem = manifestEcosystem(path) ?? "npm";
  const file = path.split("/").at(-1) ?? path;
  const empty: ParsedManifest = { path, ecosystem, deps: [], workspaces: [] };
  try {
    const parsed =
      file === "package.json"
        ? parsePackageJson(text)
        : file === "pyproject.toml"
          ? parsePyproject(text)
          : REQUIREMENTS_FILE.test(file)
            ? { deps: parseRequirements(text, DEV_REQUIREMENTS.test(file) ? "dev" : "runtime"), workspaces: [] }
            : file === "Cargo.toml"
              ? parseCargo(text)
              : file === "go.mod"
                ? parseGoMod(text)
                : file === "composer.json"
                  ? parseComposer(text)
                  : file === "Gemfile"
                    ? parseGemfile(text)
                    : { deps: [], workspaces: [] };
    return { ...empty, ...parsed };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

type Parsed = { name?: string; deps: Dependency[]; workspaces: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const joinNotes = (...notes: (string | undefined | false)[]) => notes.filter(Boolean).join(" · ") || undefined;

/* npm */

const NPM_FIELDS: [string, DepKind][] = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

function npmSource(version: string): Dependency["source"] {
  if (/^workspace:/.test(version)) return "workspace";
  if (/^(?:file|link|portal):/.test(version)) return "path";
  if (/^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:)/.test(version) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(version)) return "git";
  if (/^https?:/.test(version)) return "url";
  return undefined;
}

export function parsePackageJson(text: string): Parsed {
  const json = JSON.parse(text) as Record<string, unknown>;
  if (!isObject(json)) throw new Error("package.json is not an object");
  const deps: Dependency[] = [];
  for (const [field, kind] of NPM_FIELDS) {
    const block = json[field];
    if (!isObject(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      if (typeof version !== "string") continue;
      // npm: aliases ("npm:real-name@^1") install another package under this name.
      const alias = /^npm:(@?[^@]+)@?(.*)$/.exec(version);
      if (alias)
        deps.push({ name: alias[1]!, version: alias[2] || undefined, kind, ecosystem: "npm", alias: name, note: `installed as ${name}` });
      else deps.push({ name, version, kind, ecosystem: "npm", source: npmSource(version) });
    }
  }
  const ws = json.workspaces;
  const workspaces = Array.isArray(ws) ? strings(ws) : isObject(ws) ? strings(ws.packages) : [];
  return { name: typeof json.name === "string" ? json.name : undefined, deps, workspaces };
}

/* Python */

/** One PEP 508 requirement ("name[extra] >= 1, < 2 ; python_version < '3.11'"), or null when the line holds none. */
export function parsePep508(line: string, kind: DepKind, group?: string): Dependency | null {
  const [spec = "", ...markerParts] = line.split(";");
  const markers = markerParts.join(";").trim();
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(spec);
  if (!m) return null;
  const extras = m[2]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let rest = m[3]!.trim();
  let source: Dependency["source"];
  let version: string | undefined;
  if (rest.startsWith("@")) {
    rest = rest.slice(1).trim();
    source = /^git\+/.test(rest) ? "git" : /^file:/.test(rest) ? "path" : "url";
    version = rest;
  } else {
    version = rest.replace(/^\(|\)$/g, "").replace(/\s+/g, "") || undefined;
    if (version && !/^(?:[<>=!~]=?|===?)/.test(version)) return null;
  }
  return {
    name: m[1]!,
    version,
    kind,
    ecosystem: "pypi",
    group,
    source,
    note: joinNotes(Boolean(extras?.length) && `extras: ${extras!.join(", ")}`, markers && `when ${markers}`),
  };
}

export function parseRequirements(text: string, kind: DepKind = "runtime"): Dependency[] {
  const deps: Dependency[] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    // Inline comments need whitespace before the #; pip options (--hash=…) end the requirement.
    const line = raw
      .replace(/(^|\s)#.*$/, "")
      .replace(/\s--?[a-z][\w-]*(?:[=\s]\S+)?/g, "")
      .trim();
    if (!line || line.startsWith("-") || /^(?:\.{0,2}\/|[a-z][a-z+]*:\/\/)/i.test(line)) continue;
    const dep = parsePep508(line, kind);
    if (dep) deps.push(dep);
  }
  return deps;
}

function poetryDeps(table: unknown, kind: DepKind, group?: string): Dependency[] {
  if (!isObject(table)) return [];
  const deps: Dependency[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (name.toLowerCase() === "python") continue;
    // A list of constraints (one per Python version or platform): take the first.
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v === "string") {
      deps.push({ name, version: v, kind, ecosystem: "pypi", group });
      continue;
    }
    if (!isObject(v)) continue;
    const source: Dependency["source"] = v.git ? "git" : v.path ? "path" : v.url ? "url" : undefined;
    const extras = strings(v.extras);
    deps.push({
      name,
      version: typeof v.version === "string" ? v.version : typeof v.git === "string" ? v.git : undefined,
      kind: kind === "runtime" && v.optional === true ? "optional" : kind,
      ecosystem: "pypi",
      group,
      source,
      note: joinNotes(
        extras.length > 0 && `extras: ${extras.join(", ")}`,
        typeof v.python === "string" && `python ${v.python}`,
        typeof v.markers === "string" && `when ${v.markers}`,
        typeof v.path === "string" && `path ${v.path}`,
      ),
    });
  }
  return deps;
}

export function parsePyproject(text: string): Parsed {
  const toml = parseToml(text);
  const project = isObject(toml.project) ? toml.project : {};
  const tool = isObject(toml.tool) ? toml.tool : {};
  const poetry = isObject(tool.poetry) ? tool.poetry : {};
  const deps: Dependency[] = [];
  const pep = (list: unknown, kind: DepKind, group?: string) => {
    for (const line of strings(list)) {
      const dep = parsePep508(line, kind, group);
      if (dep) deps.push(dep);
    }
  };
  pep(project.dependencies, "runtime");
  if (isObject(project["optional-dependencies"]))
    for (const [extra, list] of Object.entries(project["optional-dependencies"])) pep(list, "optional", extra);
  // PEP 735 dependency groups never ship with the package: development, tests, docs…
  if (isObject(toml["dependency-groups"])) for (const [name, list] of Object.entries(toml["dependency-groups"])) pep(list, "dev", name);
  deps.push(...poetryDeps(poetry.dependencies, "runtime"));
  deps.push(...poetryDeps(poetry["dev-dependencies"], "dev"));
  if (isObject(poetry.group))
    for (const [name, g] of Object.entries(poetry.group))
      if (isObject(g)) deps.push(...poetryDeps(g.dependencies, name === "main" ? "runtime" : "dev", name === "main" ? undefined : name));
  if (isObject(toml["build-system"])) pep(toml["build-system"].requires, "build");
  const name = typeof project.name === "string" ? project.name : typeof poetry.name === "string" ? poetry.name : undefined;
  return { name, deps, workspaces: [] };
}

/* Rust */

const CARGO_TABLES: [string, DepKind][] = [
  ["dependencies", "runtime"],
  ["dev-dependencies", "dev"],
  ["dev_dependencies", "dev"],
  ["build-dependencies", "build"],
  ["build_dependencies", "build"],
];

function cargoDeps(table: unknown, kind: DepKind, group?: string): Dependency[] {
  if (!isObject(table)) return [];
  const deps: Dependency[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === "string") {
      deps.push({ name: key, version: value, kind, ecosystem: "crates", group });
      continue;
    }
    if (!isObject(value)) continue;
    const renamed = typeof value.package === "string" && value.package !== key ? value.package : undefined;
    const features = strings(value.features);
    const source: Dependency["source"] = value.git ? "git" : value.path && !value.version ? "path" : undefined;
    deps.push({
      name: renamed ?? key,
      alias: renamed ? key : undefined,
      version: typeof value.version === "string" ? value.version : value.workspace === true ? "workspace" : undefined,
      kind: kind === "runtime" && value.optional === true ? "optional" : kind,
      ecosystem: "crates",
      group,
      source,
      note: joinNotes(
        renamed && `used as ${key}`,
        features.length > 0 && `features: ${features.join(", ")}`,
        value["default-features"] === false && "no default features",
        typeof value.git === "string" && value.git,
        typeof value.path === "string" && `path ${value.path}`,
      ),
    });
  }
  return deps;
}

export function parseCargo(text: string): Parsed {
  const toml = parseToml(text);
  const deps: Dependency[] = [];
  for (const [table, kind] of CARGO_TABLES) deps.push(...cargoDeps(toml[table], kind));
  if (isObject(toml.target))
    for (const [cfg, t] of Object.entries(toml.target))
      if (isObject(t)) for (const [table, kind] of CARGO_TABLES) deps.push(...cargoDeps(t[table], kind, cfg));
  const workspace = isObject(toml.workspace) ? toml.workspace : {};
  deps.push(...cargoDeps(workspace.dependencies, "workspace"));
  const pkg = isObject(toml.package) ? toml.package : {};
  return { name: typeof pkg.name === "string" ? pkg.name : undefined, deps, workspaces: strings(workspace.members) };
}

/* Go */

export function parseGoMod(text: string): Parsed {
  const deps: Dependency[] = [];
  let name: string | undefined;
  let block: string | null = null;
  const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1").replace(/^`(.*)`$/, "$1");
  const add = (spec: string, comment: string) => {
    const [path, version] = spec.trim().split(/\s+/);
    if (path && version)
      deps.push({ name: unquote(path), version, kind: "runtime", ecosystem: "go", indirect: /\bindirect\b/.test(comment) });
  };
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.indexOf("//");
    const code = (at >= 0 ? raw.slice(0, at) : raw).trim();
    const comment = at >= 0 ? raw.slice(at + 2) : "";
    if (block !== null) {
      if (code === ")") block = null;
      else if (block === "require" && code) add(code, comment);
      continue;
    }
    const m = /^(\w+)\s*(.*)$/.exec(code);
    if (!m) continue;
    const [, directive, rest] = m;
    if (rest === "(") block = directive!;
    else if (directive === "module") name = unquote(rest!.trim());
    else if (directive === "require") add(rest!, comment);
  }
  return { name, deps, workspaces: [] };
}

/* PHP */

const COMPOSER_PLATFORM = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|composer(?:-plugin-api|-runtime-api)?|ext-.+|lib-.+)$/i;

export function parseComposer(text: string): Parsed {
  const json = JSON.parse(text) as Record<string, unknown>;
  if (!isObject(json)) throw new Error("composer.json is not an object");
  const deps: Dependency[] = [];
  for (const [field, kind] of [
    ["require", "runtime"],
    ["require-dev", "dev"],
  ] as const) {
    const block = json[field];
    if (!isObject(block)) continue;
    for (const [name, version] of Object.entries(block))
      if (typeof version === "string" && !COMPOSER_PLATFORM.test(name) && name.includes("/"))
        deps.push({ name, version, kind, ecosystem: "packagist" });
  }
  return { name: typeof json.name === "string" ? json.name : undefined, deps, workspaces: [] };
}

/* Ruby */

/** Splits Ruby call arguments on commas outside quotes and brackets. */
function rubyArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Strips a trailing Ruby comment (a # outside quotes). */
function stripRubyComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

const rubyString = (s: string) => /^(["'])(.*)\1$/.exec(s.trim())?.[2];
const rubySymbols = (s: string) => [...s.matchAll(/:(\w+)|["'](\w+)["']/g)].map((m) => m[1] ?? m[2]!);
const DEV_GROUPS = new Set(["development", "test", "dev", "ci", "lint", "rubocop"]);

export function parseGemfile(text: string): Parsed {
  const deps: Dependency[] = [];
  const stack: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripRubyComment(raw).trim();
    if (!line) continue;
    const group = /^group\s*\(?\s*(.+?)\s*\)?\s+do\b/.exec(line);
    if (group) {
      stack.push(rubySymbols(group[1]!));
      continue;
    }
    if (/\bdo(?:\s*\|[^|]*\|)?$/.test(line) || /^(?:if|unless|case|begin|while|until)\b/.test(line)) {
      stack.push([]);
      continue;
    }
    if (line === "end") {
      stack.pop();
      continue;
    }
    // `gem "x" if ENV["Y"]`: the modifier does not change what is declared.
    const gem = /^gem\s*\(?\s*(.+?)\)?$/.exec(line.replace(/\s+(?:if|unless)\s+.*$/, ""));
    if (!gem) continue;
    const [first, ...args] = rubyArgs(gem[1]!);
    const name = rubyString(first ?? "");
    if (!name) continue;
    const versions: string[] = [];
    const groups = stack.flat();
    const notes: string[] = [];
    let source: Dependency["source"];
    for (const arg of args) {
      const str = rubyString(arg);
      if (str !== undefined) {
        versions.push(str);
        continue;
      }
      const kv = /^:?(\w+)(?::|\s*=>)\s*(.+)$/.exec(arg);
      if (!kv) continue;
      const [, key, value] = kv;
      if (key === "group" || key === "groups") groups.push(...rubySymbols(value!));
      else if (key === "git" || key === "github" || key === "gitlab") {
        source = "git";
        notes.push(`${key} ${rubyString(value!) ?? value}`);
      } else if (key === "path") {
        source = "path";
        notes.push(`path ${rubyString(value!) ?? value}`);
      } else if (key === "platforms" || key === "platform") notes.push(`platforms: ${rubySymbols(value!).join(", ")}`);
    }
    const dev = groups.length > 0 && groups.every((g) => DEV_GROUPS.has(g));
    deps.push({
      name,
      version: versions.join(", ") || undefined,
      kind: dev ? "dev" : "runtime",
      ecosystem: "rubygems",
      group: groups.length ? groups.join(", ") : undefined,
      source,
      note: joinNotes(...notes),
    });
  }
  return { deps, workspaces: [] };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A minimal TOML reader                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

export type TomlTable = { [key: string]: unknown };

/**
 * Reads the TOML that pyproject.toml and Cargo.toml use: tables and arrays of tables, bare / quoted / dotted keys,
 * basic and literal strings (multi-line too), numbers, booleans, dates (kept as strings), arrays over several lines
 * and inline tables. Throws on what it cannot read.
 */
export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const n = src.length;
  const fail = (msg: string): never => {
    throw new Error(`TOML line ${src.slice(0, i).split("\n").length}: ${msg}`);
  };
  const ws = () => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  };
  const comment = () => {
    if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
  };
  // Whitespace, comments and newlines, inside arrays and between statements.
  const blank = () => {
    for (;;) {
      ws();
      comment();
      if (src[i] === "\n" || src[i] === "\r") i++;
      else return;
    }
  };
  const BARE = /[A-Za-z0-9_-]+/y;
  const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

  const basic = (multi: boolean): string => {
    let out = "";
    for (;;) {
      if (i >= n) fail("unterminated string");
      const ch = src[i]!;
      if (multi && src.startsWith('"""', i)) {
        // Up to two quotes may close the content: """a""""" is a"".
        let end = i + 3;
        while (src[end] === '"' && end < i + 5) end++;
        out += '"'.repeat(end - i - 3);
        i = end;
        return out;
      }
      if (!multi && ch === '"') {
        i++;
        return out;
      }
      if (!multi && ch === "\n") fail("newline in a string");
      if (ch === "\\") {
        const next = src[i + 1] ?? "";
        if (multi && /[ \t\r\n]/.test(next)) {
          // Line-ending backslash: drop the newline and the whitespace that follows.
          const m = /\\[ \t]*\r?\n[ \t\r\n]*/y;
          m.lastIndex = i;
          if (m.exec(src)) {
            i = m.lastIndex;
            continue;
          }
        }
        if (next === "u" || next === "U") {
          const len = next === "u" ? 4 : 8;
          const hex = src.slice(i + 2, i + 2 + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail("bad unicode escape");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + len;
          continue;
        }
        if (next === "x") {
          out += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        const esc = ESCAPES[next];
        if (esc === undefined) fail(`bad escape \\${next}`);
        out += esc;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
  };

  const string = (): string | null => {
    if (src.startsWith('"""', i)) {
      i += 3;
      if (src[i] === "\r") i++;
      if (src[i] === "\n") i++;
      return basic(true);
    }
    if (src.startsWith("'''", i)) {
      i += 3;
      if (src[i] === "\r") i++;
      if (src[i] === "\n") i++;
      const end = src.indexOf("'''", i);
      if (end < 0) fail("unterminated string");
      let close = end + 3;
      while (src[close] === "'" && close < end + 5) close++;
      const out = src.slice(i, close - 3);
      i = close;
      return out;
    }
    if (src[i] === '"') {
      i++;
      return basic(false);
    }
    if (src[i] === "'") {
      const end = src.indexOf("'", i + 1);
      const nl = src.indexOf("\n", i + 1);
      if (end < 0 || (nl >= 0 && nl < end)) fail("unterminated string");
      const out = src.slice(i + 1, end);
      i = end + 1;
      return out;
    }
    return null;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      const quoted = src[i] === '"' || src[i] === "'" ? string() : null;
      if (quoted !== null) parts.push(quoted);
      else {
        BARE.lastIndex = i;
        const m = BARE.exec(src);
        if (!m) fail("expected a key");
        parts.push(m![0]);
        i = BARE.lastIndex;
      }
      ws();
      if (src[i] !== ".") return parts;
      i++;
    }
  };

  const value = (): unknown => {
    ws();
    const s = string();
    if (s !== null) return s;
    const ch = src[i];
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        blank();
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        blank();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail("expected , or ] in an array");
      }
    }
    if (ch === "{") {
      i++;
      const table: TomlTable = {};
      for (;;) {
        blank();
        if (src[i] === "}") {
          i++;
          return table;
        }
        assign(table, key());
        blank();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") fail("expected , or } in an inline table");
      }
    }
    // A bare value ends at whitespace, except the space between a date and its time.
    const SCALAR = /\d{4}-\d{2}-\d{2} \d{2}:[^\s,\]}#]+|[^\s,\]}#]+/y;
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(src);
    if (!m) return fail("expected a value");
    i = SCALAR.lastIndex;
    const raw = m[0];
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?(?:inf|nan)$/.test(raw)) return Number(raw.replace("inf", "Infinity").replace("nan", "NaN"));
    if (/^0[xob][0-9a-fA-F_]+$/.test(raw)) return Number(raw.replace(/_/g, ""));
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    return fail(`unexpected value ${raw.slice(0, 20)}`);
  };

  const descend = (table: TomlTable, k: string): TomlTable => {
    const existing = table[k];
    if (existing === undefined) return (table[k] = {});
    if (Array.isArray(existing)) {
      const last = existing.at(-1);
      if (isObject(last)) return last;
    }
    if (isObject(existing)) return existing;
    return fail(`${k} is already a value`);
  };

  function assign(table: TomlTable, path: string[]) {
    ws();
    if (src[i] !== "=") fail("expected =");
    i++;
    let t = table;
    for (const k of path.slice(0, -1)) t = descend(t, k);
    t[path.at(-1)!] = value();
  }

  for (;;) {
    blank();
    if (i >= n) return root;
    if (src[i] === "[") {
      const array = src[i + 1] === "[";
      i += array ? 2 : 1;
      const path = key();
      if (!src.startsWith(array ? "]]" : "]", i)) fail("expected ] after a table name");
      i += array ? 2 : 1;
      let t = root;
      for (const k of path.slice(0, -1)) t = descend(t, k);
      const last = path.at(-1)!;
      if (array) {
        const list = t[last] === undefined ? (t[last] = []) : t[last];
        if (!Array.isArray(list)) fail(`${last} is not an array of tables`);
        const entry: TomlTable = {};
        (list as unknown[]).push(entry);
        current = entry;
      } else current = descend(t, last);
    } else assign(current, key());
    ws();
    comment();
    if (i < n && src[i] !== "\n" && src[i] !== "\r") fail("expected the end of the line");
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Packages: links and registries                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

export interface PackageLink {
  /** Short label shown on the link. */
  label: string;
  /** Site name, for the tooltip and screen readers. */
  title: string;
  url: string;
}

/** "@scope/name" with each part encoded, the slash kept. */
const npmPath = (name: string) =>
  name
    .split("/")
    .map((p) => (p.startsWith("@") ? `@${encodeURIComponent(p.slice(1))}` : encodeURIComponent(p)))
    .join("/");

export const REGISTRY_NAMES: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  go: "pkg.go.dev",
  packagist: "Packagist",
  rubygems: "RubyGems",
};

/** Links for a package: its registry page first, then the ecosystem's other tools. */
export function packageLinks(dep: Pick<Dependency, "name" | "ecosystem">): PackageLink[] {
  const { name } = dep;
  const q = encodeURIComponent(name);
  switch (dep.ecosystem) {
    case "npm":
      return [
        { label: "npm", title: "npmjs.com", url: `https://www.npmjs.com/package/${npmPath(name)}` },
        { label: "size", title: "BundlePhobia", url: `https://bundlephobia.com/package/${npmPath(name)}` },
        { label: "install", title: "PackagePhobia", url: `https://packagephobia.com/result?p=${q}` },
        { label: "graph", title: "npmgraph", url: `https://npmgraph.js.org/?q=${q}` },
        { label: "files", title: "UNPKG", url: `https://unpkg.com/${npmPath(name)}/` },
      ];
    case "pypi":
      return [{ label: "PyPI", title: "PyPI", url: `https://pypi.org/project/${q}/` }];
    case "crates":
      return [
        { label: "crates", title: "crates.io", url: `https://crates.io/crates/${q}` },
        { label: "docs", title: "docs.rs", url: `https://docs.rs/${q}` },
      ];
    case "go":
      return [{ label: "pkg.go.dev", title: "pkg.go.dev", url: `https://pkg.go.dev/${npmPath(name)}` }];
    case "packagist":
      return [{ label: "Packagist", title: "Packagist", url: `https://packagist.org/packages/${npmPath(name)}` }];
    case "rubygems":
      return [{ label: "RubyGems", title: "RubyGems", url: `https://rubygems.org/gems/${q}` }];
  }
}

export interface PackageInfo {
  description?: string;
  latest?: string;
  /** The registry does not know the package (private, renamed, a typo). */
  missing?: boolean;
}

/**
 * JSON endpoint with the package's description, for the registries that let any origin read it
 * (Access-Control-Allow-Origin: *). Go has no such endpoint; packages not from the registry are skipped.
 */
export function registryUrl(dep: Pick<Dependency, "name" | "ecosystem" | "source">): string | null {
  if (dep.source) return null;
  const q = encodeURIComponent(dep.name);
  switch (dep.ecosystem) {
    case "npm":
      return `https://registry.npmjs.org/${dep.name.startsWith("@") ? `@${encodeURIComponent(dep.name.slice(1))}` : q}/latest`;
    case "pypi":
      return `https://pypi.org/pypi/${q}/json`;
    case "crates":
      return `https://crates.io/api/v1/crates/${q}`;
    case "packagist":
      // repo.packagist.org/p2 is lighter but sends no CORS header; this one does.
      return /^[\w.-]+\/[\w.-]+$/.test(dep.name) ? `https://packagist.org/packages/${npmPath(dep.name)}.json` : null;
    case "rubygems":
      return `https://rubygems.org/api/v1/gems/${q}.json`;
    case "go":
      return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Description and latest version out of a registry's JSON answer. */
export function parseRegistry(ecosystem: Ecosystem, json: unknown): PackageInfo {
  const j = isObject(json) ? json : {};
  switch (ecosystem) {
    case "npm":
      return { description: str(j.description), latest: str(j.version) };
    case "pypi": {
      const info = isObject(j.info) ? j.info : {};
      return { description: str(info.summary), latest: str(info.version) };
    }
    case "crates": {
      const crate = isObject(j.crate) ? j.crate : {};
      return { description: str(crate.description), latest: str(crate.max_stable_version) ?? str(crate.newest_version) };
    }
    case "packagist": {
      const pkg = isObject(j.package) ? j.package : {};
      const versions = isObject(pkg.versions) ? Object.keys(pkg.versions) : [];
      return { description: str(pkg.description), latest: versions.find((v) => /^v?\d+(?:\.\d+)*$/.test(v)) };
    }
    case "rubygems":
      return { description: str(j.info), latest: str(j.version) };
    case "go":
      return {};
  }
}

export const packageKey = (dep: Pick<Dependency, "name" | "ecosystem">) => `${dep.ecosystem}:${dep.name}`;

/* ------------------------------------------------------------------------------------------------------------ */
/* Display                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export const KIND_ORDER: DepKind[] = ["runtime", "peer", "optional", "dev", "build", "workspace"];

export const KIND_LABELS: Record<DepKind, string> = {
  runtime: "Dependencies",
  peer: "Peer dependencies",
  optional: "Optional dependencies",
  dev: "Development dependencies",
  build: "Build dependencies",
  workspace: "Workspace dependencies",
};

export function groupByKind(deps: Dependency[]): { kind: DepKind; deps: Dependency[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, deps: deps.filter((d) => d.kind === kind) })).filter((g) => g.deps.length);
}

/** Packages whose name, group, note or description contains `query` (case-insensitive). */
export function filterDeps(deps: Dependency[], query: string, info: Record<string, PackageInfo> = {}): Dependency[] {
  const q = query.trim().toLowerCase();
  if (!q) return deps;
  return deps.filter((d) => [d.name, d.alias, d.group, d.note, info[packageKey(d)]?.description].some((s) => s?.toLowerCase().includes(q)));
}

/** The dependency list as Markdown, grouped by manifest and kind, each package linked to its registry. */
export function depsMarkdown(loc: RepoLocation, manifests: ParsedManifest[], info: Record<string, PackageInfo> = {}): string {
  const total = manifests.reduce((s, m) => s + m.deps.length, 0);
  const lines = [
    `## Dependencies of ${repoLabel(loc)}${loc.ref ? ` at ${loc.ref}` : ""}`,
    "",
    `${total} package${total === 1 ? "" : "s"} in ${manifests.length} manifest${manifests.length === 1 ? "" : "s"}.`,
  ];
  for (const m of manifests) {
    lines.push("", `### [${m.path}](${repoFileUrl(loc, m.path)}) (${REGISTRY_NAMES[m.ecosystem]})`);
    if (m.error) lines.push("", `Could not read it: ${m.error}`);
    if (m.workspaces.length) lines.push("", `Workspaces: ${m.workspaces.map((w) => `\`${w}\``).join(", ")}`);
    for (const g of groupByKind(m.deps)) {
      lines.push("", `**${KIND_LABELS[g.kind]}** (${g.deps.length})`, "");
      for (const d of g.deps) {
        const meta = info[packageKey(d)];
        const extra = [d.group, d.indirect ? "indirect" : "", d.note, meta?.latest ? `latest ${meta.latest}` : ""]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `- [${d.name}](${packageLinks(d)[0]!.url})${d.version ? ` \`${d.version}\`` : ""}${meta?.description ? ` — ${meta.description}` : ""}${extra ? ` (${extra})` : ""}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
