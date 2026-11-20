import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { fetchRepoFiles, readRepoPage } from "../src/lib/page/repo-files";
import {
  type Dependency,
  depsMarkdown,
  filterDeps,
  groupByKind,
  listedFiles,
  loadRepoDeps,
  manifestCandidates,
  manifestEcosystem,
  packageLinks,
  parseCargo,
  parseComposer,
  parseGemfile,
  parseGoMod,
  parseManifest,
  parsePackageJson,
  parsePep508,
  parsePyproject,
  parseRegistry,
  parseRepoUrl,
  parseRequirements,
  parseToml,
  type RepoLocation,
  registryUrl,
  repoFileUrl,
} from "../src/lib/repo-deps";
import { INFO_CACHE_PREFIX, loadPackageInfo, mapLimit } from "../src/lib/repo-deps-info";
import { BOX_TAG, boxAnchor, fillDepsBox, renderDepsBox } from "../src/lib/repo-deps-view";

const pick = (deps: Dependency[], name: string) => deps.find((d) => d.name === name);

describe("parseRepoUrl", () => {
  it("reads a GitHub repository root, folder and file", () => {
    expect(parseRepoUrl("https://github.com/npmhub/npmhub")).toEqual({
      host: "github",
      origin: "https://github.com",
      owner: "npmhub",
      repo: "npmhub",
      ref: null,
      dir: "",
    });
    expect(parseRepoUrl("https://github.com/npmhub/npmhub", { ref: "main" })?.ref).toBe("main");
    expect(parseRepoUrl("https://github.com/maxgfr/skycmd/tree/main/crates/sky-web?x=1#readme")).toMatchObject({
      ref: "main",
      dir: "crates/sky-web",
    });
    expect(parseRepoUrl("https://github.com/maxgfr/skycmd/tree/v1.2.0")).toMatchObject({ ref: "v1.2.0", dir: "" });
    expect(parseRepoUrl("https://github.com/maxgfr/skycmd/blob/main/crates/sky-web/Cargo.toml")).toMatchObject({
      ref: "main",
      dir: "crates/sky-web",
    });
    expect(parseRepoUrl("https://github.com/maxgfr/skycmd/blob/main/package.json")).toMatchObject({ dir: "" });
  });
  it("takes the page's ref when it has slashes, the first segment otherwise", () => {
    const url = "https://github.com/acme/app/tree/feature/login/packages/web";
    expect(parseRepoUrl(url)).toMatchObject({ ref: "feature", dir: "login/packages/web" });
    expect(parseRepoUrl(url, { ref: "feature/login" })).toMatchObject({ ref: "feature/login", dir: "packages/web" });
    // A ref the URL does not start with (a short SHA in the picker) is ignored.
    expect(parseRepoUrl(url, { ref: "abc1234" })).toMatchObject({ ref: "feature" });
    expect(parseRepoUrl("https://github.com/acme/app/tree/release%2F2.0/src")).toMatchObject({ ref: "release/2.0", dir: "src" });
  });
  it("returns null for GitHub pages that are not code", () => {
    for (const url of [
      "https://github.com/",
      "https://github.com/npmhub",
      "https://github.com/settings/profile",
      "https://github.com/orgs/npmhub/repositories",
      "https://github.com/marketplace/actions/checkout",
      "https://github.com/issues",
      "https://github.com/pulls",
      "https://github.com/npmhub/npmhub/issues/12",
      "https://github.com/npmhub/npmhub/pulls",
      "https://github.com/npmhub/npmhub/settings",
      "https://github.com/npmhub/npmhub/actions",
      "https://example.com/npmhub/npmhub",
      "chrome://extensions",
      "not a url",
    ])
      expect(parseRepoUrl(url), url).toBeNull();
  });
  it("reads GitLab projects in nested groups", () => {
    expect(parseRepoUrl("https://gitlab.com/gitlab-org/gitlab-ui")).toMatchObject({
      host: "gitlab",
      owner: "gitlab-org",
      repo: "gitlab-ui",
      ref: null,
      dir: "",
    });
    expect(parseRepoUrl("https://gitlab.com/acme/platform/tools/cli/-/tree/main/packages/core?ref_type=heads")).toMatchObject({
      owner: "acme/platform/tools",
      repo: "cli",
      ref: "main",
      dir: "packages/core",
    });
    expect(parseRepoUrl("https://gitlab.com/acme/cli/-/blob/v2/src/go.mod")).toMatchObject({ ref: "v2", dir: "src" });
    expect(parseRepoUrl("https://gitlab.com/acme/cli/-/issues/3")).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/explore/projects")).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/gitlab-org")).toBeNull();
  });
  it("uses the page's project path to tell a group from a project", () => {
    expect(parseRepoUrl("https://gitlab.com/acme/platform", { project: "" })).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/acme/platform", { project: "acme/other" })).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/Acme/Platform/-/tree/main", { project: "acme/platform" })).toMatchObject({
      owner: "Acme",
      repo: "Platform",
    });
  });
  it("needs a hint for self-hosted GitLab and GitHub Enterprise", () => {
    expect(parseRepoUrl("https://git.acme.dev/team/app/-/tree/main/web")).toBeNull();
    expect(parseRepoUrl("https://git.acme.dev/team/app/-/tree/main/web", { host: "gitlab" })).toMatchObject({
      origin: "https://git.acme.dev",
      owner: "team",
      repo: "app",
      dir: "web",
    });
    expect(parseRepoUrl("https://ghe.acme.dev/acme/app/tree/main", { host: "github" })).toMatchObject({ host: "github", ref: "main" });
  });
  it("builds raw and file URLs, HEAD when no ref is known", () => {
    const gh = parseRepoUrl("https://github.com/npmhub/npmhub")!;
    expect(repoFileUrl(gh, "package.json", "raw")).toBe("https://github.com/npmhub/npmhub/raw/HEAD/package.json");
    const gl = parseRepoUrl("https://gitlab.com/a/b/c/-/tree/feat/x/web", { ref: "feat/x" })!;
    expect(repoFileUrl(gl, "web/package.json")).toBe("https://gitlab.com/a/b/c/-/blob/feat/x/web/package.json");
    expect(repoFileUrl(gl, "web/my file.txt", "raw")).toBe("https://gitlab.com/a/b/c/-/raw/feat/x/web/my%20file.txt");
  });
});

describe("listing and candidates", () => {
  const loc: RepoLocation = { host: "github", origin: "https://github.com", owner: "o", repo: "r", ref: "main", dir: "web" };
  it("keeps the files directly in the folder", () => {
    expect(
      listedFiles(loc, [
        "https://github.com/o/r/blob/main/web/package.json",
        "/o/r/blob/main/web/requirements-dev.txt",
        "/o/r/blob/main/web/src/index.ts",
        "/o/r/blob/main/README.md",
        "/o/r/tree/main/web/src",
      ]),
    ).toEqual(["package.json", "requirements-dev.txt"]);
    expect(listedFiles(loc, [])).toBeNull();
  });
  it("asks only for the manifests the folder lists, or all of them", () => {
    expect(manifestCandidates(["README.md", "Cargo.toml", "requirements_test.txt", "dev-requirements.txt"])).toEqual([
      "Cargo.toml",
      "requirements_test.txt",
      "dev-requirements.txt",
    ]);
    expect(manifestCandidates(null)).toContain("Gemfile");
    expect(manifestCandidates(Array.from({ length: 100 }, (_, i) => `f${i}.txt`))).toContain("package.json");
    expect(manifestEcosystem("a/b/requirements-docs.txt")).toBe("pypi");
    expect(manifestEcosystem("go.mod")).toBe("go");
    expect(manifestEcosystem("pom.xml")).toBeNull();
  });
});

describe("package.json", () => {
  it("reads every dependency field, aliases and workspaces", () => {
    const m = parsePackageJson(
      JSON.stringify({
        name: "@acme/web",
        workspaces: { packages: ["packages/*", "apps/*"] },
        dependencies: { react: "^19.0.0", "@tanstack/react-query": "5.0.0", shared: "workspace:*", lodash4: "npm:lodash@^4.17.21" },
        devDependencies: { typescript: "~5.6.0", local: "file:../local" },
        peerDependencies: { "react-dom": ">=18" },
        optionalDependencies: { fsevents: "^2.3.0" },
        bundledDependencies: ["react"],
      }),
    );
    expect(m.name).toBe("@acme/web");
    expect(m.workspaces).toEqual(["packages/*", "apps/*"]);
    expect(pick(m.deps, "react")).toMatchObject({ version: "^19.0.0", kind: "runtime", ecosystem: "npm" });
    expect(pick(m.deps, "typescript")?.kind).toBe("dev");
    expect(pick(m.deps, "react-dom")?.kind).toBe("peer");
    expect(pick(m.deps, "fsevents")?.kind).toBe("optional");
    expect(pick(m.deps, "shared")?.source).toBe("workspace");
    expect(pick(m.deps, "local")?.source).toBe("path");
    expect(pick(m.deps, "lodash")).toMatchObject({ alias: "lodash4", version: "^4.17.21" });
    expect(parsePackageJson('{"workspaces":["a"]}').workspaces).toEqual(["a"]);
  });
  it("reports broken JSON instead of throwing", () => {
    const m = parseManifest("web/package.json", "{ nope");
    expect(m.error).toBeTruthy();
    expect(m.deps).toEqual([]);
  });
});

describe("Python", () => {
  it("parses PEP 508 requirements", () => {
    expect(parsePep508("requests[socks, security] >= 2.31, < 3 ; python_version < '3.13'", "runtime")).toMatchObject({
      name: "requests",
      version: ">=2.31,<3",
      note: "extras: socks, security · when python_version < '3.13'",
    });
    expect(parsePep508("Django (>=4.2)", "runtime")?.version).toBe(">=4.2");
    expect(parsePep508("numpy", "runtime")?.version).toBeUndefined();
    expect(parsePep508("pkg @ git+https://github.com/o/pkg.git@main", "runtime")).toMatchObject({ name: "pkg", source: "git" });
  });
  it("reads requirements.txt and skips comments, options and includes", () => {
    const deps = parseRequirements(
      [
        "# Production requirements",
        "-r base.txt",
        "-c constraints.txt",
        "--index-url https://pypi.example.com/simple",
        "-e git+https://github.com/o/editable.git#egg=editable",
        "./local-package",
        "flask==3.0.3  # web framework",
        "gunicorn>=22 \\",
        "    --hash=sha256:abc123",
        'uvicorn[standard]~=0.30 ; sys_platform != "win32"',
        "",
        "https://example.com/pkg.whl",
        "pydantic",
      ].join("\n"),
    );
    expect(deps.map((d) => d.name)).toEqual(["flask", "gunicorn", "uvicorn", "pydantic"]);
    expect(pick(deps, "flask")?.version).toBe("==3.0.3");
    expect(pick(deps, "gunicorn")?.version).toBe(">=22");
    expect(pick(deps, "uvicorn")?.note).toContain("extras: standard");
    expect(parseManifest("requirements-dev.txt", "pytest").deps[0]?.kind).toBe("dev");
    expect(parseManifest("requirements.txt", "pytest").deps[0]?.kind).toBe("runtime");
  });
  it("reads a PEP 621 pyproject with optional dependencies, groups and the build system", () => {
    const m = parsePyproject(`
[build-system]
requires = ["hatchling>=1.24"]
build-backend = "hatchling.build"

[project]
name = "acme-api"
version = "1.0.0"
description = """
An API.
"""
dependencies = [
  "fastapi>=0.115",  # web
  'sqlalchemy[asyncio]>=2,<3',
]

[project.optional-dependencies]
redis = ["redis>=5"]

[dependency-groups]
test = ["pytest>=8", "coverage", { include-group = "lint" }]
lint = ["ruff"]
`);
    expect(m.name).toBe("acme-api");
    expect(pick(m.deps, "fastapi")).toMatchObject({ kind: "runtime", version: ">=0.115" });
    expect(pick(m.deps, "sqlalchemy")?.note).toBe("extras: asyncio");
    expect(pick(m.deps, "redis")).toMatchObject({ kind: "optional", group: "redis" });
    expect(pick(m.deps, "pytest")).toMatchObject({ kind: "dev", group: "test" });
    expect(pick(m.deps, "ruff")?.group).toBe("lint");
    expect(pick(m.deps, "hatchling")?.kind).toBe("build");
  });
  it("reads a Poetry pyproject, skipping python", () => {
    const m = parsePyproject(`
[tool.poetry]
name = "acme-cli"
version = "0.3.0"
packages = [{ include = "acme" }]

[tool.poetry.dependencies]
python = "^3.10"
click = "^8.1"
httpx = { version = "^0.27", extras = ["http2"] }
uvloop = { version = "^0.19", optional = true, markers = "sys_platform != 'win32'" }
internal = { git = "https://github.com/acme/internal.git", branch = "main" }
numpy = [
  { version = "^1.26", python = "<3.12" },
  { version = "^2.0", python = ">=3.12" },
]

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
mypy = "*"

[tool.poetry.group.docs]
optional = true

[tool.poetry.group.docs.dependencies]
mkdocs = "^1.6"

[tool.poetry.dev-dependencies]
black = "^24.0"

[[tool.poetry.source]]
name = "private"
url = "https://pypi.acme.dev/simple"
priority = "supplemental"
`);
    expect(m.name).toBe("acme-cli");
    expect(pick(m.deps, "python")).toBeUndefined();
    expect(pick(m.deps, "click")).toMatchObject({ version: "^8.1", kind: "runtime" });
    expect(pick(m.deps, "httpx")).toMatchObject({ version: "^0.27", note: "extras: http2" });
    expect(pick(m.deps, "uvloop")?.kind).toBe("optional");
    expect(pick(m.deps, "internal")?.source).toBe("git");
    expect(pick(m.deps, "numpy")?.version).toBe("^1.26");
    expect(pick(m.deps, "pytest")).toMatchObject({ kind: "dev", group: "dev" });
    expect(pick(m.deps, "mkdocs")).toMatchObject({ kind: "dev", group: "docs" });
    expect(pick(m.deps, "black")?.kind).toBe("dev");
  });
});

describe("Cargo.toml", () => {
  it("reads a workspace root (skycmd's)", () => {
    const m = parseCargo(`[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "Apache-2.0"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rand = { version = "0.8", default-features = false, features = ["std", "std_rng", "small_rng"] }

[profile.release]
opt-level = 3
lto = "thin"

[profile.release.package."*"]
opt-level = 3
`);
    expect(m.workspaces).toEqual(["crates/*"]);
    expect(m.deps.map((d) => d.name)).toEqual(["serde", "serde_json", "rand"]);
    expect(m.deps.every((d) => d.kind === "workspace")).toBe(true);
    expect(pick(m.deps, "serde")?.note).toBe("features: derive");
    expect(pick(m.deps, "rand")?.note).toBe("features: std, std_rng, small_rng · no default features");
  });
  it("reads a member crate: kinds, renames, targets, sub-tables and workspace versions", () => {
    const m = parseCargo(`
[package]
name = "sky-web" # the web crate
version.workspace = true

[dependencies]
serde = { workspace = true }
tokio = { version = "1.40", features = ["rt-multi-thread", "macros"] }
sky-data = { path = "../sky-data" }
web_sys = { package = "web-sys", version = "0.3" }
log = { version = "0.4", optional = true }

[dependencies.axum]
version = "0.7"
features = [
  "ws",   # websockets
  "macros",
]

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.1"

[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", features = ["winuser"] }

[target."cfg(unix)".dev-dependencies]
nix = "0.29"

[[bin]]
name = "sky"
path = "src/main.rs"
`);
    expect(m.name).toBe("sky-web");
    expect(pick(m.deps, "serde")).toMatchObject({ version: "workspace", kind: "runtime" });
    expect(pick(m.deps, "tokio")?.note).toBe("features: rt-multi-thread, macros");
    expect(pick(m.deps, "sky-data")?.source).toBe("path");
    expect(pick(m.deps, "web-sys")).toMatchObject({ alias: "web_sys", version: "0.3" });
    expect(pick(m.deps, "log")?.kind).toBe("optional");
    expect(pick(m.deps, "axum")).toMatchObject({ version: "0.7", note: "features: ws, macros" });
    expect(pick(m.deps, "criterion")?.kind).toBe("dev");
    expect(pick(m.deps, "cc")?.kind).toBe("build");
    expect(pick(m.deps, "winapi")).toMatchObject({ kind: "runtime", group: "cfg(windows)" });
    expect(pick(m.deps, "nix")).toMatchObject({ kind: "dev", group: "cfg(unix)" });
  });
});

describe("TOML reader", () => {
  it("reads strings, numbers, dates, arrays and inline tables", () => {
    const t = parseToml(`
title = "Line\\tone \\u00e9"
literal = 'C:\\path'
multi = """
Roses are red
Violets are \\
    blue"""
lit = '''
raw \\n'''
int = 1_000
hex = 0xff
float = -3.5e2
bool = true
date = 1979-05-27T07:32:00Z
nested = [[1, 2], ["a"]]
point = { x = 1, y = { z = "deep" } }
"quoted key".a = 1
a.b.c = "dotted"
`);
    expect(t.title).toBe("Line\tone é");
    expect(t.literal).toBe("C:\\path");
    expect(t.multi).toBe("Roses are red\nViolets are blue");
    expect(t.lit).toBe("raw \\n");
    expect(t.int).toBe(1000);
    expect(t.hex).toBe(255);
    expect(t.float).toBe(-350);
    expect(t.bool).toBe(true);
    expect(t.date).toBe("1979-05-27T07:32:00Z");
    expect(t.nested).toEqual([[1, 2], ["a"]]);
    expect(t.point).toEqual({ x: 1, y: { z: "deep" } });
    expect(t["quoted key"]).toEqual({ a: 1 });
    expect(t.a).toEqual({ b: { c: "dotted" } });
  });
  it("reads arrays of tables and says where it fails", () => {
    expect(parseToml('[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n[bin.extra]\nx = 1').bin).toEqual([
      { name: "a" },
      { name: "b", extra: { x: 1 } },
    ]);
    expect(() => parseToml('a = "unterminated')).toThrow(/line 1/);
    expect(() => parseToml("a = 1\nb = [1, 2")).toThrow(/line 2/);
    expect(() => parseToml("a = 1 b = 2")).toThrow(/end of the line/);
  });
});

describe("go.mod, composer.json, Gemfile", () => {
  it("reads go.mod require blocks and lines, marking indirect ones", () => {
    const m = parseGoMod(`module github.com/acme/api

go 1.23.0

toolchain go1.23.2

require github.com/spf13/cobra v1.8.1

require (
	github.com/go-chi/chi/v5 v5.1.0
	golang.org/x/sync v0.8.0 // indirect
	// a comment
)

replace github.com/acme/lib => ../lib

exclude (
	github.com/bad/mod v1.0.0
)
`);
    expect(m.name).toBe("github.com/acme/api");
    expect(m.deps.map((d) => d.name)).toEqual(["github.com/spf13/cobra", "github.com/go-chi/chi/v5", "golang.org/x/sync"]);
    expect(pick(m.deps, "golang.org/x/sync")?.indirect).toBe(true);
    expect(pick(m.deps, "github.com/go-chi/chi/v5")).toMatchObject({ version: "v5.1.0", indirect: false });
  });
  it("reads composer.json without platform packages", () => {
    const m = parseComposer(
      JSON.stringify({
        name: "acme/shop",
        require: { php: ">=8.2", "ext-json": "*", "lib-curl": "*", "composer-plugin-api": "^2", "symfony/console": "^7.1" },
        "require-dev": { "phpunit/phpunit": "^11.0" },
      }),
    );
    expect(m.name).toBe("acme/shop");
    expect(m.deps.map((d) => [d.name, d.kind])).toEqual([
      ["symfony/console", "runtime"],
      ["phpunit/phpunit", "dev"],
    ]);
  });
  it("reads a Gemfile with groups, options and blocks", () => {
    const m = parseGemfile(`source "https://rubygems.org"
git_source(:github) { |repo| "https://github.com/#{repo}.git" }

ruby "3.3.0"

gem "rails", "~> 7.1.3", ">= 7.1.3.2"
gem 'pg', '~> 1.1' # database
gem "puma", ">= 5.0", require: false
gem "tzinfo-data", platforms: %i[ windows jruby ]
gem "bootsnap", require: false if ENV["BOOT"]
gem "internal", github: "acme/internal"

group :development, :test do
  gem "debug", platforms: %i[ mri windows ]
  gem "rspec-rails"
end

group :development do
  gem "web-console"
  platforms :mri do
    gem "byebug"
  end
end

gem "rubocop", group: :lint
gem "sidekiq", groups: [:production, :worker]
gem "factory_bot", :group => :test
gemspec
`);
    expect(pick(m.deps, "rails")).toMatchObject({ version: "~> 7.1.3, >= 7.1.3.2", kind: "runtime" });
    expect(pick(m.deps, "pg")?.version).toBe("~> 1.1");
    expect(pick(m.deps, "bootsnap")).toBeTruthy();
    expect(pick(m.deps, "internal")?.source).toBe("git");
    expect(pick(m.deps, "debug")).toMatchObject({ kind: "dev", group: "development, test" });
    expect(pick(m.deps, "byebug")).toMatchObject({ kind: "dev", group: "development" });
    expect(pick(m.deps, "rubocop")?.kind).toBe("dev");
    expect(pick(m.deps, "sidekiq")).toMatchObject({ kind: "runtime", group: "production, worker" });
    expect(pick(m.deps, "factory_bot")?.kind).toBe("dev");
    expect(m.deps.some((d) => d.name === "spec" || d.name === "ruby")).toBe(false);
  });
});

describe("links and registries", () => {
  it("encodes scoped npm names", () => {
    const links = packageLinks({ name: "@tanstack/react-query", ecosystem: "npm" });
    expect(links.map((l) => l.url)).toEqual([
      "https://www.npmjs.com/package/@tanstack/react-query",
      "https://bundlephobia.com/package/@tanstack/react-query",
      "https://packagephobia.com/result?p=%40tanstack%2Freact-query",
      "https://npmgraph.js.org/?q=%40tanstack%2Freact-query",
      "https://unpkg.com/@tanstack/react-query/",
    ]);
    expect(links.some((l) => /runkit/i.test(l.url))).toBe(false);
    expect(registryUrl({ name: "@types/node", ecosystem: "npm" })).toBe("https://registry.npmjs.org/@types%2Fnode/latest");
    expect(registryUrl({ name: "react", ecosystem: "npm" })).toBe("https://registry.npmjs.org/react/latest");
  });
  it("links every ecosystem to its registry", () => {
    expect(packageLinks({ name: "requests", ecosystem: "pypi" })[0]!.url).toBe("https://pypi.org/project/requests/");
    expect(packageLinks({ name: "serde", ecosystem: "crates" }).map((l) => l.url)).toEqual([
      "https://crates.io/crates/serde",
      "https://docs.rs/serde",
    ]);
    expect(packageLinks({ name: "github.com/go-chi/chi/v5", ecosystem: "go" })[0]!.url).toBe("https://pkg.go.dev/github.com/go-chi/chi/v5");
    expect(packageLinks({ name: "symfony/console", ecosystem: "packagist" })[0]!.url).toBe(
      "https://packagist.org/packages/symfony/console",
    );
    expect(packageLinks({ name: "rails", ecosystem: "rubygems" })[0]!.url).toBe("https://rubygems.org/gems/rails");
  });
  it("asks only registries that allow cross-origin reads, never for local packages", () => {
    expect(registryUrl({ name: "github.com/x/y", ecosystem: "go" })).toBeNull();
    expect(registryUrl({ name: "shared", ecosystem: "npm", source: "workspace" })).toBeNull();
    expect(registryUrl({ name: "symfony/console", ecosystem: "packagist" })).toBe("https://packagist.org/packages/symfony/console.json");
    expect(registryUrl({ name: "requests", ecosystem: "pypi" })).toBe("https://pypi.org/pypi/requests/json");
    expect(registryUrl({ name: "serde", ecosystem: "crates" })).toBe("https://crates.io/api/v1/crates/serde");
    expect(registryUrl({ name: "rails", ecosystem: "rubygems" })).toBe("https://rubygems.org/api/v1/gems/rails.json");
  });
  it("reads each registry's answer", () => {
    expect(parseRegistry("npm", { version: "19.3.1", description: "React is a JavaScript library" })).toEqual({
      latest: "19.3.1",
      description: "React is a JavaScript library",
    });
    expect(parseRegistry("pypi", { info: { summary: "Python HTTP for Humans.", version: "2.34.2" } })).toEqual({
      description: "Python HTTP for Humans.",
      latest: "2.34.2",
    });
    expect(parseRegistry("crates", { crate: { description: "A serialization framework", max_stable_version: "1.0.229" } }).latest).toBe(
      "1.0.229",
    );
    expect(
      parseRegistry("packagist", { package: { description: "Logs", versions: { "dev-main": {}, "2.x-dev": {}, "3.13.0": {} } } }),
    ).toEqual({ description: "Logs", latest: "3.13.0" });
    expect(parseRegistry("rubygems", { info: "Ruby on Rails", version: "8.1.4" })).toEqual({
      description: "Ruby on Rails",
      latest: "8.1.4",
    });
    expect(parseRegistry("npm", null)).toEqual({ description: undefined, latest: undefined });
  });
});

describe("display", () => {
  const loc = parseRepoUrl("https://github.com/acme/web/tree/main/app")!;
  const m = parseManifest("app/package.json", JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^4" } }));
  it("groups by kind in a stable order and filters by name or description", () => {
    expect(groupByKind(m.deps).map((g) => g.kind)).toEqual(["runtime", "dev"]);
    expect(filterDeps(m.deps, "VITE").map((d) => d.name)).toEqual(["vitest"]);
    expect(filterDeps(m.deps, "user interfaces", { "npm:react": { description: "For user interfaces" } }).map((d) => d.name)).toEqual([
      "react",
    ]);
  });
  it("writes Markdown with links, versions and descriptions", () => {
    const md = depsMarkdown(loc, [m], { "npm:react": { description: "UI library", latest: "19.3.1" } });
    expect(md).toContain("## Dependencies of acme/web/app at main");
    expect(md).toContain("### [app/package.json](https://github.com/acme/web/blob/main/app/package.json) (npm)");
    expect(md).toContain("- [react](https://www.npmjs.com/package/react) `^19` — UI library (latest 19.3.1)");
    expect(md).toContain("**Development dependencies** (1)");
  });
});

describe("loadRepoDeps", () => {
  it("fetches the listed manifests of the folder and reports unreadable ones", async () => {
    const fetchFiles = vi.fn(async (files: { path: string; raw: string }[]) =>
      files.map((f) =>
        f.path === "web/package.json"
          ? { path: f.path, status: 200, text: '{"dependencies":{"react":"^19"}}' }
          : f.path === "web/Gemfile"
            ? { path: f.path, status: 403 }
            : { path: f.path, status: 404 },
      ),
    );
    const res = await loadRepoDeps(
      "https://github.com/acme/app/tree/feat/x/web",
      {
        site: "github",
        project: "acme/app",
        ref: "feat/x",
        links: ["/acme/app/blob/feat/x/web/package.json", "/acme/app/blob/feat/x/web/Gemfile", "/acme/app/blob/feat/x/web/a.ts"],
      },
      fetchFiles,
    );
    expect(fetchFiles.mock.calls[0]![0]).toEqual([
      {
        path: "web/package.json",
        raw: "https://github.com/acme/app/raw/feat/x/web/package.json",
        blob: "https://github.com/acme/app/blob/feat/x/web/package.json",
      },
      {
        path: "web/Gemfile",
        raw: "https://github.com/acme/app/raw/feat/x/web/Gemfile",
        blob: "https://github.com/acme/app/blob/feat/x/web/Gemfile",
      },
    ]);
    expect(res?.loc.ref).toBe("feat/x");
    expect(res?.manifests[0]?.deps[0]?.name).toBe("react");
    expect(res?.failed).toEqual([{ path: "web/Gemfile", reason: "needs a signed-in session with access to the repository" }]);
    expect(
      await loadRepoDeps("https://github.com/settings", { site: "github", project: null, ref: null, links: [] }, fetchFiles),
    ).toBeNull();
  });
});

describe("page functions", () => {
  it("reads a GitHub page: site, ref from the picker, file links of the listing", () => {
    document.head.innerHTML =
      '<meta property="og:site_name" content="GitHub"><meta name="octolytics-dimension-repository_nwo" content="acme/app">';
    document.body.innerHTML = `<button id="ref-picker-repos-header-ref-selector">feat/x</button>
      <div data-testid="directory-content"><a href="/acme/app/blob/feat/x/package.json">package.json</a><a href="/acme/app/tree/feat/x/src">src</a></div>
      <article class="markdown-body"><a href="/acme/app/blob/feat/x/docs/Gemfile">not in the listing</a></article>`;
    const facts = readRepoPage();
    expect(facts).toMatchObject({ site: "github", project: "acme/app", ref: "feat/x" });
    expect(facts.links.map((l) => new URL(l).pathname)).toEqual(["/acme/app/blob/feat/x/package.json"]);
  });
  it("reads a GitLab page: project path from the body, ref, listing", () => {
    document.head.innerHTML = '<meta content="GitLab" property="og:site_name">';
    document.body.innerHTML = `<div id="js-ambiguous-ref-modal" data-ref="main"></div>
      <div id="tree-holder"><table><tr><td><a class="tree-item-link" href="/acme/tools/cli/-/blob/main/go.mod?ref_type=heads">go.mod</a></td></tr></table></div>`;
    document.body.dataset.projectFullPath = "acme/tools/cli";
    const facts = readRepoPage();
    expect(facts).toMatchObject({ site: "gitlab", project: "acme/tools/cli", ref: "main" });
    const loc = parseRepoUrl("https://gitlab.com/acme/tools/cli", { host: "gitlab", project: facts.project!, ref: facts.ref! })!;
    expect(listedFiles(loc, facts.links)).toEqual(["go.mod"]);
    delete document.body.dataset.projectFullPath;
  });
  it("is neither on another site", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "<p>Hello</p>";
    expect(readRepoPage()).toEqual({ site: null, project: null, ref: null, links: [] });
  });
  it("fetches raw files, caps their size and falls back to GitHub's file page", async () => {
    const page = `<html><body><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
      payload: { codeViewBlobLayoutRoute: { StyledBlob: { rawLines: ["{", '  "name": "x"', "}"] } } },
    })}</script></body></html>`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/raw/main/package.json")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/blob/main/package.json")) return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/raw/main/big.txt")) return new Response("x".repeat(50), { status: 200 });
      if (url.endsWith("/raw/main/login.txt"))
        return new Response("<!DOCTYPE html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/raw/main/go.mod")) return new Response("module x\n", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const base = "https://github.com/o/r";
    const files = await fetchRepoFiles(
      [
        { path: "package.json", raw: `${base}/raw/main/package.json`, blob: `${base}/blob/main/package.json` },
        { path: "big.txt", raw: `${base}/raw/main/big.txt` },
        { path: "login.txt", raw: `${base}/raw/main/login.txt` },
        { path: "go.mod", raw: `${base}/raw/main/go.mod` },
        { path: "Gemfile", raw: `${base}/raw/main/Gemfile` },
      ],
      40,
    );
    vi.unstubAllGlobals();
    expect(files).toEqual([
      { path: "package.json", status: 200, text: '{\n  "name": "x"\n}' },
      { path: "big.txt", status: 200, tooLarge: true },
      { path: "login.txt", status: 401 },
      { path: "go.mod", status: 200, text: "module x\n" },
      { path: "Gemfile", status: 404 },
    ]);
  });
});

describe("package info", () => {
  beforeEach(() => fakeBrowser.reset());
  it("runs at most N tasks at a time", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(3);
  });
  it("fetches each package once, caches answers in storage.session and skips Go", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes("left-pad")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ version: "1.0.0", description: `about ${url}` }), { status: 200 }),
    );
    const deps: Dependency[] = [
      { name: "react", ecosystem: "npm", kind: "runtime" },
      { name: "react", ecosystem: "npm", kind: "dev" },
      { name: "left-pad", ecosystem: "npm", kind: "runtime" },
      { name: "github.com/x/y", ecosystem: "go", kind: "runtime" },
    ];
    const info = await loadPackageInfo(deps, undefined, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(info["npm:react"]).toEqual({ latest: "1.0.0", description: "about https://registry.npmjs.org/react/latest" });
    expect(info["npm:left-pad"]).toEqual({ missing: true });
    expect((await fakeBrowser.storage.session.get(`${INFO_CACHE_PREFIX}npm:react`))[`${INFO_CACHE_PREFIX}npm:react`]).toBeTruthy();
    const again = await loadPackageInfo(deps, undefined, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(again["npm:react"]?.latest).toBe("1.0.0");
  });
});

describe("in-page box", () => {
  it("goes after the README's own container, or after the file list without a README", () => {
    document.body.innerHTML = `<div id="wrap"><div id="files"><div data-testid="directory-content"><table></table></div></div>
      <div id="readme-box"><div><article class="markdown-body"><h1>App</h1></article></div></div></div>`;
    expect(boxAnchor("github")?.id).toBe("readme-box");
    document.body.innerHTML = `<div id="wrap"><div id="files"><div data-testid="directory-content"></div></div></div>`;
    expect(boxAnchor("github")?.id).toBe("files");
    document.body.innerHTML = `<div id="tree-holder"><table class="tree-table"></table><div id="rm"><article class="readme-holder"></article></div></div>`;
    expect(boxAnchor("gitlab")?.id).toBe("rm");
    document.body.innerHTML = "<main></main>";
    expect(boxAnchor("github")).toBeNull();
  });
  it("lists each manifest by kind with links, then fills in descriptions", () => {
    const loc = parseRepoUrl("https://github.com/acme/web", { ref: "main" })!;
    const manifest = parseManifest(
      "package.json",
      JSON.stringify({ workspaces: ["packages/*"], dependencies: { "@scope/ui": "^1" }, devDependencies: { vitest: "^4" } }),
    );
    const box = renderDepsBox({ loc, manifests: [manifest], failed: [], probed: 1 });
    document.body.append(box);
    const root = box.shadowRoot!;
    expect(box.tagName.toLowerCase()).toBe(BOX_TAG);
    expect(root.querySelector("h3 a")?.getAttribute("href")).toBe("https://github.com/acme/web/blob/main/package.json");
    expect([...root.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Dependencies (1)", "Development dependencies (1)"]);
    expect(root.querySelector("li .name")?.getAttribute("href")).toBe("https://www.npmjs.com/package/@scope/ui");
    expect(root.querySelectorAll("li")[0]!.querySelectorAll(".links a")).toHaveLength(4);
    expect(root.textContent).toContain("packages/*");
    fillDepsBox(box, { "npm:@scope/ui": { description: "Scoped UI kit", latest: "1.4.0" } });
    expect(root.querySelector("li .desc")?.textContent).toBe("Scoped UI kit");
    expect(root.querySelector("li .latest")?.textContent).toBe("latest 1.4.0");
    box.remove();
  });
});
