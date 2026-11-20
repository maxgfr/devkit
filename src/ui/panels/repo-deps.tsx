// Inspect › Repo dependencies: the packages a GitHub or GitLab folder declares (package.json, pyproject.toml,
// requirements*.txt, Cargo.toml, go.mod, composer.json, Gemfile), with descriptions from the registries and links.
import { useEffect, useMemo, useState } from "react";
import { injectionError, runInTab } from "../../lib/inject";
import { fetchRepoFiles, readRepoPage } from "../../lib/page/repo-files";
import {
  type Dependency,
  depsMarkdown,
  filterDeps,
  groupByKind,
  KIND_LABELS,
  loadRepoDeps,
  MANIFESTS,
  type PackageInfo,
  type ParsedManifest,
  packageKey,
  packageLinks,
  parseRepoUrl,
  REGISTRY_NAMES,
  type RepoLocation,
  registryUrl,
  repoFileUrl,
  repoLabel,
} from "../../lib/repo-deps";
import { disableRepoDepsBox, enableRepoDepsBox, repoDepsBoxEnabled } from "../../lib/repo-deps-box";
import { INFO_LIMIT, loadPackageInfo } from "../../lib/repo-deps-info";
import { Button, CopyButton, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { AccessGate, usePage } from "../page";

const SOURCE_LABEL: Record<NonNullable<Dependency["source"]>, string> = {
  git: "git",
  path: "local path",
  url: "URL",
  workspace: "workspace package",
};

const MANIFEST_NAMES = `${MANIFESTS.map((m) => m.file)
  .filter((f) => f !== "requirements-dev.txt")
  .join(", ")
  .replace("requirements.txt", "requirements*.txt")}`;

export function RepoDeps() {
  const page = usePage();
  const onForge = parseRepoUrl(page.url) !== null;
  const state = useAsync(async () => {
    const tabId = page.tabId;
    if (tabId === undefined || !page.canScript) return null;
    try {
      const facts = await runInTab(tabId, readRepoPage);
      return await loadRepoDeps(page.url, facts, (files, max) => runInTab(tabId, fetchRepoFiles, [files, max]));
    } catch (e) {
      throw new Error(injectionError(e));
    }
  }, [page.tabId, page.url, page.canScript]);
  const data = state.data;

  const [info, setInfo] = useState<Record<string, PackageInfo>>({});
  useEffect(() => {
    setInfo({});
    const deps = data?.manifests.flatMap((m) => m.deps) ?? [];
    if (!deps.length) return;
    let live = true;
    loadPackageInfo(deps, (next) => {
      if (live) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [data]);

  const [query, setQuery] = useState("");
  const md = useMemo(() => (data ? depsMarkdown(data.loc, data.manifests, info) : ""), [data, info]);

  if (!page.canScript)
    return (
      <>
        {onForge ? null : <NotARepo />}
        {onForge || page.origin ? (
          <>
            {onForge ? null : (
              <p className="muted small">On GitHub Enterprise or a self-hosted GitLab, devkit needs access to the site to recognize it.</p>
            )}
            <AccessGate />
          </>
        ) : null}
        <BoxToggle />
      </>
    );

  return (
    <>
      <ErrorText error={state.error} />
      {state.loading && !data ? <Empty>Reading the manifests…</Empty> : null}
      {!state.loading && !state.error && !data ? <NotARepo /> : null}
      {data ? (
        <>
          <Summary
            loc={data.loc}
            manifests={data.manifests}
            info={info}
            md={md}
            query={query}
            onQuery={setQuery}
            onRefresh={state.run}
            loading={state.loading}
          />
          {data.failed.length ? (
            <Notice kind="warn">
              <span>
                Could not read{" "}
                {data.failed.map((f, i) => (
                  <span key={f.path}>
                    {i ? ", " : ""}
                    <b className="mono">{f.path}</b> ({f.reason})
                  </span>
                ))}
                .
              </span>
            </Notice>
          ) : null}
          {data.manifests.length ? (
            data.manifests.map((m) => <Manifest key={m.path} loc={data.loc} manifest={m} info={info} query={query} />)
          ) : (
            <Empty>
              No manifest in {data.loc.dir ? <b className="mono">{data.loc.dir}</b> : "the repository root"}. devkit looks for{" "}
              {MANIFEST_NAMES}.
            </Empty>
          )}
        </>
      ) : null}
      <BoxToggle />
    </>
  );
}

function NotARepo() {
  return (
    <Empty>
      Open a repository or folder page on GitHub or GitLab (github.com, gitlab.com, GitHub Enterprise, a self-hosted GitLab): devkit lists
      the dependencies its {MANIFEST_NAMES} declare, with each package's description and links.
    </Empty>
  );
}

function Summary({
  loc,
  manifests,
  info,
  md,
  query,
  onQuery,
  onRefresh,
  loading,
}: {
  loc: RepoLocation;
  manifests: ParsedManifest[];
  info: Record<string, PackageInfo>;
  md: string;
  query: string;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const deps = manifests.flatMap((m) => m.deps);
  const lookups = new Set(deps.filter((d) => registryUrl(d)).map(packageKey));
  const known = [...lookups].filter((k) => info[k]).length;
  const go = deps.some((d) => d.ecosystem === "go");
  const folderUrl = repoFileUrl(loc, loc.dir, "tree");
  return (
    <Section
      title={`Repo dependencies (${deps.length})`}
      actions={
        <>
          <Button size="small" onClick={onRefresh} busy={loading}>
            Refresh
          </Button>
          <CopyButton text={md} label="Copy as Markdown" />
        </>
      }
    >
      <p className="rd-where small">
        <a href={folderUrl} target="_blank" rel="noreferrer" className="mono">
          {repoLabel(loc)}
        </a>
        {loc.ref ? <span className="pill">{loc.ref}</span> : <span className="pill">default branch</span>}
        <span className="muted">
          {manifests.length} manifest{manifests.length === 1 ? "" : "s"}
          {lookups.size
            ? ` · descriptions ${known}/${Math.min(lookups.size, INFO_LIMIT)}${lookups.size > INFO_LIMIT ? ` (first ${INFO_LIMIT} packages)` : ""}`
            : ""}
        </span>
      </p>
      {go ? <p className="muted small">Go modules: links only, pkg.go.dev has no API a browser extension can read.</p> : null}
      {deps.length ? (
        <input type="search" placeholder="Filter by name, group or description" value={query} onChange={(e) => onQuery(e.target.value)} />
      ) : null}
    </Section>
  );
}

function Manifest({
  loc,
  manifest,
  info,
  query,
}: {
  loc: RepoLocation;
  manifest: ParsedManifest;
  info: Record<string, PackageInfo>;
  query: string;
}) {
  const shown = filterDeps(manifest.deps, query, info);
  const groups = groupByKind(shown);
  return (
    <Section
      title={
        <a href={repoFileUrl(loc, manifest.path)} target="_blank" rel="noreferrer" className="mono">
          {manifest.path}
        </a>
      }
      actions={
        <span className="muted small">
          {REGISTRY_NAMES[manifest.ecosystem]} · {query ? `${shown.length} of ${manifest.deps.length}` : manifest.deps.length}
          {manifest.name ? ` · ${manifest.name}` : ""}
        </span>
      }
    >
      {manifest.error ? <Notice kind="bad">Could not read it: {manifest.error}</Notice> : null}
      {manifest.workspaces.length ? (
        <p className="small muted rd-ws">
          Workspaces:{" "}
          {manifest.workspaces.map((w) => (
            <code key={w} className="pill mono">
              {w}
            </code>
          ))}
        </p>
      ) : null}
      {!manifest.deps.length && !manifest.error ? <Empty>No dependency declared.</Empty> : null}
      {manifest.deps.length && !shown.length ? <Empty>No package matches the filter.</Empty> : null}
      {groups.map((g) => (
        <div key={g.kind} className="rd-group">
          <h3>
            {KIND_LABELS[g.kind]} <span className="muted">({g.deps.length})</span>
          </h3>
          <ul className="rd-list">
            {g.deps.map((d, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same package can be listed twice (targets, groups)
              <DepRow key={`${d.name}-${d.group ?? ""}-${i}`} dep={d} info={info[packageKey(d)]} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function DepRow({ dep, info }: { dep: Dependency; info: PackageInfo | undefined }) {
  const [main, ...extra] = packageLinks(dep);
  const tags = [
    dep.group,
    dep.indirect ? "indirect" : "",
    dep.source ? SOURCE_LABEL[dep.source] : "",
    dep.alias ? `as ${dep.alias}` : "",
  ].filter(Boolean);
  return (
    <li className="rd-row">
      <div className="rd-head">
        <a className="rd-name mono" href={main!.url} target="_blank" rel="noreferrer" title={`${dep.name} on ${main!.title}`}>
          {dep.name}
        </a>
        {dep.version ? (
          <span className="rd-ver mono small" title="Requested version">
            {dep.version}
          </span>
        ) : null}
        {info?.latest && info.latest !== dep.version ? (
          <span className="pill rd-latest" title={`Latest version on ${main!.title}`}>
            latest {info.latest}
          </span>
        ) : null}
        {tags.map((t) => (
          <span key={t} className="pill">
            {t}
          </span>
        ))}
        {extra.length ? (
          <span className="rd-links">
            {extra.map((l) => (
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer" title={l.title} aria-label={`${dep.name} on ${l.title}`}>
                {l.label}
              </a>
            ))}
          </span>
        ) : null}
      </div>
      {info?.description ? <p className="rd-desc small">{info.description}</p> : null}
      {info?.missing ? <p className="rd-desc small muted">Not found on {main!.title}.</p> : null}
      {dep.note ? <p className="rd-note small muted mono">{dep.note}</p> : null}
    </li>
  );
}

/** Turns the in-page box on github.com / gitlab.com on or off. */
function BoxToggle() {
  const toast = useToast();
  const on = useAsync(repoDepsBoxEnabled, []);
  return (
    <Section
      title="On GitHub and GitLab pages"
      hint="Adds a Dependencies box below the README of github.com and gitlab.com repositories and folders. Asks for access to those two sites only."
    >
      <div className="row">
        <span className="grow small">{on.data ? "On" : "Off"}</span>
        {on.data ? (
          <Button
            size="small"
            onClick={async () => {
              await disableRepoDepsBox();
              on.run();
            }}
          >
            Turn off
          </Button>
        ) : (
          <Button
            size="small"
            variant="primary"
            onClick={async () => {
              if (await enableRepoDepsBox()) {
                toast("Reload the GitHub or GitLab page to see the box.");
                on.run();
              } else toast("Needs access to github.com and gitlab.com.", true);
            }}
          >
            Turn on
          </Button>
        )}
      </div>
    </Section>
  );
}
