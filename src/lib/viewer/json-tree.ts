// The collapsible JSON tree of the data viewer, for JSON, YAML (parsed to the same values) and JSON
// Lines (one tree per line). Builds children on first expand and in chunks, so big documents stay fast.
import {
  CHUNK,
  childPath,
  countLabel,
  entriesOf,
  type FilterResult,
  filterJson,
  isContainer,
  isHttpUrl,
  kindOf,
  OPEN_DEPTH,
} from "../json-viewer";
import { type Body, linkTo, type ViewCtx } from "./ctx";

/** Nodes built by one "Expand all" before it stops, to keep the tab responsive. */
export const EXPAND_ALL_BUDGET = 20_000;

/** The root's children as separate items (JSON Lines, YAML documents): their labels and, for lines that do not parse, the error. */
export interface RootItems {
  labels: string[];
  errors?: (string | undefined)[];
  texts?: string[];
}

interface NodeCtl {
  el: HTMLElement;
  value: unknown;
  path: string;
  depth: number;
  /** Inside a container that matched the filter: its whole subtree shows. */
  inMatch: boolean;
  toggle?: HTMLButtonElement;
  childrenEl?: HTMLElement;
  /** Child entries to show (all of them, or the filtered ones). */
  entries?: [string | number, unknown][];
  rendered: number;
  open: boolean;
  children: NodeCtl[];
}

/** `$[2].a.b` of item 2 is `$.a.b` within that item. */
export function itemPath(path: string): { index: number; path: string } | null {
  const m = /^\$\[(\d+)\](.*)$/.exec(path);
  return m ? { index: Number(m[1]), path: `$${m[2]}` } : null;
}

export function createJsonTree(ctx: ViewCtx, value: unknown, items?: RootItems): Body {
  const { el, button, view } = ctx;
  let filter: FilterResult | null = null;
  let budget = Number.POSITIVE_INFINITY;
  let rootCtl: NodeCtl | null = null;
  const ctls = new WeakMap<Element, NodeCtl>();

  const valueEl = (v: unknown): HTMLElement => {
    const kind = kindOf(v);
    if (kind === "string") {
      const s = el("span", "s");
      const str = v as string;
      if (isHttpUrl(str)) s.append('"', linkTo(ctx, str, JSON.stringify(str).slice(1, -1)), '"');
      else s.textContent = JSON.stringify(str);
      return s;
    }
    if (kind === "number") return el("span", "n", String(v));
    if (kind === "boolean") return el("span", "b", String(v));
    return el("span", "null", "null");
  };

  const itemIndex = (path: string, depth: number) => (items && depth === 1 ? itemPath(path)?.index : undefined);

  const buildNode = (key: string | number | null, v: unknown, path: string, depth: number, inMatch: boolean): NodeCtl => {
    budget--;
    const node = el("div", "node");
    node.dataset.path = path;
    const line = el("div", "line");
    line.title = path;
    node.append(line);
    const ctl: NodeCtl = { el: node, value: v, path, depth, inMatch, rendered: 0, open: false, children: [] };
    ctls.set(node, ctl);
    const matched = filter?.matched.has(path) ?? false;
    if (matched) node.classList.add("hit");
    const index = itemIndex(path, depth);
    const error = index !== undefined ? items?.errors?.[index] : undefined;
    const container = !error && isContainer(v);
    if (container) {
      const toggle = button("▸", "tog");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute(
        "aria-label",
        `${key === null ? "Root" : index !== undefined ? items!.labels[index] : String(key)} ${countLabel(v)}`,
      );
      line.append(toggle);
      ctl.toggle = toggle;
    } else line.append(el("span", "sp"));
    if (key !== null) {
      const label = index !== undefined ? items!.labels[index]! : typeof key === "number" ? String(key) : JSON.stringify(key);
      const k = button(label, typeof key === "number" ? "key idx" : "key");
      k.title = `${index !== undefined ? itemPath(path)!.path : path} (click to copy the path)`;
      line.append(k, el("span", "colon", ": "));
    }
    if (error) {
      node.classList.add("bad");
      line.append(el("span", "err", `Invalid JSON: ${error}`), el("span", "src", ` ${(items?.texts?.[index!] ?? "").slice(0, 300)}`));
    } else if (container) {
      line.append(el("span", "count", countLabel(v)));
      const childMatch = inMatch || matched;
      ctl.entries = entriesOf(v).filter(([k]) => childMatch || !filter || filter.visible.has(childPath(path, k)));
      if (!ctl.entries.length) ctl.toggle!.disabled = true;
      else {
        // Filtering opens the path to every match (and a matched container one level), nothing more.
        const open = filter ? !inMatch && filter.visible.has(path) : depth < OPEN_DEPTH;
        if (open && budget > 0) expand(ctl);
      }
    } else line.append(valueEl(v));
    return ctl;
  };

  const renderMore = (ctl: NodeCtl) => {
    const entries = ctl.entries ?? [];
    const list = ctl.childrenEl!;
    list.querySelector(":scope > .more")?.remove();
    const end = Math.min(entries.length, ctl.rendered + CHUNK);
    const inMatch = ctl.inMatch || (filter?.matched.has(ctl.path) ?? false);
    for (let i = ctl.rendered; i < end; i++) {
      const [k, v] = entries[i]!;
      const child = buildNode(k, v, childPath(ctl.path, k), ctl.depth + 1, inMatch);
      ctl.children.push(child);
      list.append(child.el);
    }
    ctl.rendered = end;
    if (end < entries.length) {
      const left = entries.length - end;
      list.append(button(`Show ${Math.min(CHUNK, left).toLocaleString("en-US")} more (${left.toLocaleString("en-US")} left)`, "more"));
    }
  };

  function expand(ctl: NodeCtl) {
    if (!ctl.toggle || ctl.toggle.disabled) return;
    if (!ctl.childrenEl) {
      ctl.childrenEl = el("div", "children");
      ctl.el.append(ctl.childrenEl);
      renderMore(ctl);
    }
    ctl.childrenEl.hidden = false;
    ctl.open = true;
    ctl.toggle.textContent = "▾";
    ctl.toggle.setAttribute("aria-expanded", "true");
  }

  const collapse = (ctl: NodeCtl) => {
    if (!ctl.toggle || !ctl.childrenEl) return;
    ctl.childrenEl.hidden = true;
    ctl.open = false;
    ctl.toggle.textContent = "▸";
    ctl.toggle.setAttribute("aria-expanded", "false");
  };

  /** Expands `ctl` and every built or buildable descendant, within the node budget. */
  const expandDeep = (ctl: NodeCtl): boolean => {
    if (budget <= 0) return false;
    expand(ctl);
    for (const child of ctl.children) if (child.toggle && !expandDeep(child)) return false;
    return true;
  };
  /** Expand all, for the toolbar and Alt-click: stops after EXPAND_ALL_BUDGET new nodes. */
  const expandAll = (ctl: NodeCtl) => {
    budget = EXPAND_ALL_BUDGET;
    const done = expandDeep(ctl);
    budget = Number.POSITIVE_INFINITY;
    if (!done) ctx.toast(`Expanded the first ${EXPAND_ALL_BUDGET.toLocaleString("en-US")} nodes.`);
  };
  const collapseDeep = (ctl: NodeCtl) => {
    for (const child of ctl.children) collapseDeep(child);
    collapse(ctl);
  };

  const render = () => {
    view.replaceChildren();
    budget = Number.POSITIVE_INFINITY;
    const tree = el("div", "tree");
    rootCtl = buildNode(null, value, "$", 0, false);
    tree.append(rootCtl.el);
    view.append(tree);
    if (filter && !filter.count) view.append(el("p", "empty", "No key or value matches the filter."));
  };

  view.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest("button");
    if (!target || !view.contains(target)) return;
    const node = target.closest(".node");
    const ctl = node ? ctls.get(node) : undefined;
    if (target.classList.contains("more")) {
      const owner = target.parentElement?.closest(".node");
      const parent = owner ? ctls.get(owner) : undefined;
      if (parent) renderMore(parent);
      return;
    }
    if (!ctl) return;
    if (target.classList.contains("tog")) {
      if (ctl.open) (event as MouseEvent).altKey ? collapseDeep(ctl) : collapse(ctl);
      else if ((event as MouseEvent).altKey) expandAll(ctl);
      else expand(ctl);
    } else if (target.classList.contains("key")) {
      const item = items ? itemPath(ctl.path) : null;
      const path = item ? item.path : ctl.path;
      const where = item ? ` (${items!.labels[item.index]})` : "";
      ctx.toast((await ctx.copy(path)) ? `Copied ${path}${where}` : "Could not copy the path.");
    }
  });

  return {
    render,
    filter(query) {
      filter = filterJson(value, query);
      render();
      return filter ? filter.count : null;
    },
    expandAll() {
      if (rootCtl) expandAll(rootCtl);
    },
    collapseAll() {
      if (!rootCtl) return;
      for (const child of rootCtl.children) collapseDeep(child);
    },
  };
}
