// The "Dependencies" box the content script puts on GitHub and GitLab repository pages, below the README. Plain DOM
// in a shadow root, so the forge's styles do not reach it; it reads their color variables to match light and dark.
import {
  type Dependency,
  groupByKind,
  KIND_LABELS,
  type PackageInfo,
  packageKey,
  packageLinks,
  REGISTRY_NAMES,
  type RepoDeps,
  type RepoHost,
  repoFileUrl,
} from "./repo-deps";

export const BOX_TAG = "devkit-repo-deps";

const SELECTORS: Record<RepoHost, { listing: string; readme: string }> = {
  github: {
    listing: '[data-testid="directory-content"], table[aria-labelledby="folders-and-files"]',
    readme: '#readme, [data-testid="readme"], article.markdown-body',
  },
  gitlab: { listing: "#tree-holder table, .tree-table", readme: "article.readme-holder, .readme-holder, #readme" },
};

/**
 * The element the box goes after: the README's outermost container that is not shared with the file listing, or
 * the listing's container when the folder has no README. Null while the page has rendered neither.
 */
export function boxAnchor(host: RepoHost, root: ParentNode = document): Element | null {
  const listing = root.querySelector(SELECTORS[host].listing);
  const readme = [...root.querySelectorAll(SELECTORS[host].readme)].find((r) => !listing?.contains(r)) ?? null;
  if (readme) {
    if (!listing) return readme;
    let at: Element = readme;
    while (at.parentElement && !at.parentElement.contains(listing)) at = at.parentElement;
    return at;
  }
  return listing?.parentElement ?? listing;
}

const STYLE = `
:host {
  display: block;
  margin: 16px 0;
  --rd-fg: var(--fgColor-default, var(--gl-text-color-default, #1f2328));
  --rd-muted: var(--fgColor-muted, var(--gl-text-color-subtle, #59636e));
  --rd-link: var(--fgColor-accent, var(--gl-link-color-default, #0969da));
  --rd-border: var(--borderColor-default, var(--gl-border-color-default, #d1d9e0));
  --rd-bg: var(--bgColor-default, var(--gl-background-color-default, #ffffff));
  --rd-bg-2: var(--bgColor-muted, var(--gl-background-color-subtle, #f6f8fa));
}
@media (prefers-color-scheme: dark) {
  :host {
    --rd-fg: var(--fgColor-default, var(--gl-text-color-default, #f0f6fc));
    --rd-muted: var(--fgColor-muted, var(--gl-text-color-subtle, #9198a1));
    --rd-link: var(--fgColor-accent, var(--gl-link-color-default, #4493f8));
    --rd-border: var(--borderColor-default, var(--gl-border-color-default, #3d444d));
    --rd-bg: var(--bgColor-default, var(--gl-background-color-default, #0d1117));
    --rd-bg-2: var(--bgColor-muted, var(--gl-background-color-subtle, #151b23));
  }
}
.box { border: 1px solid var(--rd-border); border-radius: 6px; background: var(--rd-bg); color: var(--rd-fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; overflow: hidden; }
header { display: flex; align-items: baseline; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--rd-border); background: var(--rd-bg-2); }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
header .by { margin-left: auto; color: var(--rd-muted); font-size: 12px; }
.manifest { padding: 8px 16px 12px; }
.manifest + .manifest { border-top: 1px solid var(--rd-border); }
h3 { margin: 4px 0; font-size: 13px; font-weight: 600; }
h4 { margin: 10px 0 4px; font-size: 12px; font-weight: 600; color: var(--rd-muted); }
a { color: var(--rd-link); text-decoration: none; }
a:hover { text-decoration: underline; }
ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 2px 24px; }
li { min-width: 0; padding: 3px 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; }
.name { font-weight: 600; }
code, .ver { font: 12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; color: var(--rd-muted); }
.desc { flex-basis: 100%; color: var(--rd-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.links { display: inline-flex; gap: 6px; font-size: 11px; }
.links a { color: var(--rd-muted); }
.links a:hover { color: var(--rd-link); }
.tag { font-size: 11px; color: var(--rd-muted); border: 1px solid var(--rd-border); border-radius: 999px; padding: 0 6px; }
.meta { color: var(--rd-muted); font-size: 12px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const link = (href: string, text: string, props: Record<string, string> = {}) =>
  el("a", { href, target: "_blank", rel: "noreferrer noopener", ...props }, text);

function row(dep: Dependency): HTMLLIElement {
  const [main, ...extra] = packageLinks(dep);
  const li = el(
    "li",
    { "data-key": packageKey(dep) },
    link(main!.url, dep.name, { class: "name", title: `${dep.name} on ${main!.title}` }),
  );
  if (dep.version) li.append(el("span", { class: "ver", title: "Requested version" }, dep.version));
  for (const tag of [dep.group, dep.indirect ? "indirect" : "", dep.source ?? ""]) if (tag) li.append(el("span", { class: "tag" }, tag));
  if (extra.length)
    li.append(
      el(
        "span",
        { class: "links" },
        ...extra.map((l) => link(l.url, l.label, { title: l.title, "aria-label": `${dep.name} on ${l.title}` })),
      ),
    );
  li.append(el("span", { class: "desc" }));
  return li;
}

/** Builds the box (a custom element with an open shadow root) for what `loadRepoDeps` found. */
export function renderDepsBox(result: RepoDeps): HTMLElement {
  const host = document.createElement(BOX_TAG);
  const shadow = host.attachShadow({ mode: "open" });
  const total = result.manifests.reduce((s, m) => s + m.deps.length, 0);
  const box = el(
    "section",
    { class: "box", "aria-label": "Dependencies" },
    el("header", {}, el("h2", {}, "Dependencies"), el("span", { class: "meta" }, String(total)), el("span", { class: "by" }, "devkit")),
  );
  for (const m of result.manifests) {
    const part = el(
      "div",
      { class: "manifest" },
      el("h3", {}, link(repoFileUrl(result.loc, m.path), m.path), " ", el("span", { class: "meta" }, `${REGISTRY_NAMES[m.ecosystem]}`)),
    );
    if (m.error) part.append(el("p", { class: "meta" }, `Could not read it: ${m.error}`));
    if (m.workspaces.length)
      part.append(el("p", { class: "meta" }, "Workspaces: ", ...m.workspaces.flatMap((w, i) => [i ? ", " : "", el("code", {}, w)])));
    for (const g of groupByKind(m.deps))
      part.append(el("h4", {}, `${KIND_LABELS[g.kind]} (${g.deps.length})`), el("ul", {}, ...g.deps.map(row)));
    box.append(part);
  }
  shadow.append(el("style", {}, STYLE), box);
  return host;
}

/** Fills in descriptions and latest versions as they arrive. */
export function fillDepsBox(host: HTMLElement, info: Record<string, PackageInfo>) {
  for (const li of host.shadowRoot?.querySelectorAll<HTMLLIElement>("li[data-key]") ?? []) {
    const meta = info[li.dataset.key!];
    if (!meta) continue;
    const desc = li.querySelector(".desc");
    if (desc && meta.description) {
      desc.textContent = meta.description;
      desc.setAttribute("title", meta.description);
    }
    const ver = li.querySelector(".ver");
    if (meta.latest && ver && !li.querySelector(".latest") && ver.textContent !== meta.latest)
      ver.after(el("span", { class: "tag latest", title: "Latest version on the registry" }, `latest ${meta.latest}`));
  }
}
