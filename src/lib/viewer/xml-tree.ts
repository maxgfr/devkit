// The collapsible XML tree of the data viewer: elements with their attributes, text, CDATA, comments
// and processing instructions, a summary on top for RSS and Atom feeds. Click a tag to copy its XPath.
import { CHUNK, isHttpUrl, OPEN_DEPTH } from "../json-viewer";
import {
  elementPaths,
  type FeedSummary,
  feedSummary,
  filterXml,
  inlineText,
  topPaths,
  type XmlDoc,
  type XmlElement,
  type XmlFilter,
  type XmlNode,
} from "../formats/xml";
import { type Body, linkTo, type ViewCtx } from "./ctx";
import { EXPAND_ALL_BUDGET } from "./json-tree";

/** Feed items listed in the summary; the tree below has them all. */
export const FEED_ITEMS_SHOWN = 100;

interface NodeCtl {
  el: HTMLElement;
  node: XmlNode;
  path: string;
  depth: number;
  inMatch: boolean;
  toggle?: HTMLButtonElement;
  childrenEl?: HTMLElement;
  closeEl?: HTMLElement;
  tailEl?: HTMLElement;
  entries?: [XmlNode, string][];
  rendered: number;
  open: boolean;
  children: NodeCtl[];
}

export function createXmlTree(ctx: ViewCtx, doc: XmlDoc): Body {
  const { el, button, view } = ctx;
  let filter: XmlFilter | null = null;
  let budget = Number.POSITIVE_INFINITY;
  let roots: NodeCtl[] = [];
  const ctls = new WeakMap<Element, NodeCtl>();
  const feed = feedSummary(doc);

  const text = (s: string, cls = "t"): HTMLElement => {
    const span = el("span", cls);
    const t = s.trim();
    if (isHttpUrl(t)) span.append(linkTo(ctx, t, t));
    else span.textContent = t;
    return span;
  };

  /** `<name a="1">` (or `<name/>`) with a button on the name that copies the path. */
  const openTag = (node: XmlElement, path: string, selfClosing: boolean): HTMLElement => {
    const tag = el("span", "tag");
    const name = button(node.name, "key tagname");
    name.title = `${path} (click to copy the XPath)`;
    tag.append("<", name);
    for (const [k, v] of node.attrs) {
      const value = el("span", "av");
      if (isHttpUrl(v)) value.append('"', linkTo(ctx, v, v), '"');
      else value.textContent = `"${v}"`;
      tag.append(" ", el("span", "an", k), el("span", "eq", "="), value);
    }
    tag.append(selfClosing ? "/>" : ">");
    return tag;
  };

  const closeTag = (node: XmlElement) => el("span", "tag", `</${node.name}>`);

  const childEntries = (node: XmlElement, path: string, inMatch: boolean, matched: boolean): [XmlNode, string][] => {
    const paths = elementPaths(path, node.children);
    return node.children
      .map((c, i) => [c, paths[i]!] as [XmlNode, string])
      .filter(([, p]) => inMatch || matched || !filter || filter.visible.has(p));
  };

  const buildNode = (node: XmlNode, path: string, depth: number, inMatch: boolean): NodeCtl => {
    budget--;
    const div = el("div", `node x-${node.type}`);
    div.dataset.path = path;
    const line = el("div", "line");
    div.append(line);
    const ctl: NodeCtl = { el: div, node, path, depth, inMatch, rendered: 0, open: false, children: [] };
    ctls.set(div, ctl);
    const matched = filter?.matched.has(path) ?? false;
    if (matched) div.classList.add("hit");
    if (node.type !== "element") {
      line.append(el("span", "sp"));
      if (node.type === "text") line.append(text(node.text));
      else if (node.type === "cdata") line.append(el("span", "punct", "<![CDATA["), text(node.text, "t cdata"), el("span", "punct", "]]>"));
      else if (node.type === "comment") line.append(el("span", "comment", `<!--${node.text}-->`));
      else line.append(el("span", "pi", `<?${node.target}${node.text ? ` ${node.text}` : ""}?>`));
      return ctl;
    }
    if (!node.children.length) {
      line.append(el("span", "sp"), openTag(node, path, true));
      return ctl;
    }
    const inline = inlineText(node);
    if (inline) {
      line.append(el("span", "sp"), openTag(node, path, false));
      if (inline.type === "cdata") line.append(el("span", "punct", "<![CDATA["), text(inline.text, "t cdata"), el("span", "punct", "]]>"));
      else line.append(text(inline.text));
      line.append(closeTag(node));
      if (filter?.matched.has(`${path}/text()[1]`)) div.classList.add("hit");
      return ctl;
    }
    const toggle = button("▸", "tog");
    toggle.setAttribute("aria-expanded", "false");
    const elements = node.children.filter((c) => c.type === "element").length;
    toggle.setAttribute("aria-label", `${node.name}, ${node.children.length} child node${node.children.length === 1 ? "" : "s"}`);
    ctl.toggle = toggle;
    const tail = el("span", "tail");
    tail.title = `${elements} child element${elements === 1 ? "" : "s"}, ${node.children.length} node${node.children.length === 1 ? "" : "s"}`;
    tail.append(el("span", "count", "…"), closeTag(node));
    ctl.tailEl = tail;
    line.append(toggle, openTag(node, path, false), tail);
    ctl.entries = childEntries(node, path, inMatch, matched);
    if (!ctl.entries.length) toggle.disabled = true;
    else {
      const open = filter ? !inMatch && filter.visible.has(path) : depth < OPEN_DEPTH;
      if (open && budget > 0) expand(ctl);
    }
    return ctl;
  };

  const renderMore = (ctl: NodeCtl) => {
    const entries = ctl.entries ?? [];
    const list = ctl.childrenEl!;
    list.querySelector(":scope > .more")?.remove();
    const end = Math.min(entries.length, ctl.rendered + CHUNK);
    const inMatch = ctl.inMatch || (filter?.matched.has(ctl.path) ?? false);
    for (let i = ctl.rendered; i < end; i++) {
      const [n, p] = entries[i]!;
      const child = buildNode(n, p, ctl.depth + 1, inMatch);
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
      const close = el("div", "line close");
      close.append(el("span", "sp"), closeTag(ctl.node as XmlElement));
      ctl.closeEl = close;
      ctl.el.append(ctl.childrenEl, close);
      renderMore(ctl);
    }
    ctl.childrenEl.hidden = false;
    ctl.closeEl!.hidden = false;
    ctl.tailEl!.hidden = true;
    ctl.open = true;
    ctl.toggle.textContent = "▾";
    ctl.toggle.setAttribute("aria-expanded", "true");
  }

  const collapse = (ctl: NodeCtl) => {
    if (!ctl.toggle || !ctl.childrenEl) return;
    ctl.childrenEl.hidden = true;
    ctl.closeEl!.hidden = true;
    ctl.tailEl!.hidden = false;
    ctl.open = false;
    ctl.toggle.textContent = "▸";
    ctl.toggle.setAttribute("aria-expanded", "false");
  };

  const expandDeep = (ctl: NodeCtl): boolean => {
    if (budget <= 0) return false;
    expand(ctl);
    for (const child of ctl.children) if (child.toggle && !expandDeep(child)) return false;
    return true;
  };
  const expandAll = (list: NodeCtl[]) => {
    budget = EXPAND_ALL_BUDGET;
    const done = list.every((c) => !c.toggle || expandDeep(c));
    budget = Number.POSITIVE_INFINITY;
    if (!done) ctx.toast(`Expanded the first ${EXPAND_ALL_BUDGET.toLocaleString("en-US")} nodes.`);
  };
  const collapseDeep = (ctl: NodeCtl) => {
    for (const child of ctl.children) collapseDeep(child);
    collapse(ctl);
  };

  const feedEl = (f: FeedSummary): HTMLElement => {
    const box = el("details", "feed");
    box.open = true;
    const summary = el("summary");
    summary.append(
      el("strong", undefined, `${f.kind} feed`),
      ` · ${f.items.length.toLocaleString("en-US")} item${f.items.length === 1 ? "" : "s"}`,
    );
    box.append(summary);
    const head = el("div", "feed-head");
    const title = el("span", "feed-title");
    if (f.link && isHttpUrl(f.link)) title.append(linkTo(ctx, f.link, f.title || f.link));
    else title.textContent = f.title || "(untitled)";
    head.append(title);
    if (f.description) head.append(el("span", "feed-desc", f.description));
    box.append(head);
    const list = el("ol", "feed-items");
    for (const item of f.items.slice(0, FEED_ITEMS_SHOWN)) {
      const li = el("li");
      const label = item.title || item.link || "(untitled)";
      li.append(isHttpUrl(item.link) ? linkTo(ctx, item.link, label) : el("span", undefined, label));
      if (item.date) li.append(el("span", "feed-date", item.date));
      list.append(li);
    }
    box.append(list);
    if (f.items.length > FEED_ITEMS_SHOWN)
      box.append(el("p", "feed-more", `and ${(f.items.length - FEED_ITEMS_SHOWN).toLocaleString("en-US")} more in the tree below`));
    return box;
  };

  const render = () => {
    view.replaceChildren();
    budget = Number.POSITIVE_INFINITY;
    if (feed && !filter) view.append(feedEl(feed));
    const tree = el("div", "tree xml");
    const paths = topPaths(doc);
    roots = doc.nodes
      .map((n, i) => [n, paths[i]!] as [XmlNode, string])
      .filter(([, p]) => !filter || filter.visible.has(p))
      .map(([n, p]) => buildNode(n, p, 0, false));
    tree.append(...roots.map((r) => r.el));
    view.append(tree);
    if (filter && !filter.count) view.append(el("p", "empty", "No tag, attribute or text matches the filter."));
  };

  view.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest("button");
    if (!target || !view.contains(target)) return;
    if (target.classList.contains("more")) {
      const owner = target.parentElement?.closest(".node");
      const parent = owner ? ctls.get(owner) : undefined;
      if (parent) renderMore(parent);
      return;
    }
    const node = target.closest(".node");
    const ctl = node ? ctls.get(node) : undefined;
    if (!ctl) return;
    if (target.classList.contains("tog")) {
      if (ctl.open) (event as MouseEvent).altKey ? collapseDeep(ctl) : collapse(ctl);
      else if ((event as MouseEvent).altKey) expandAll([ctl]);
      else expand(ctl);
    } else if (target.classList.contains("tagname")) {
      ctx.toast((await ctx.copy(ctl.path)) ? `Copied ${ctl.path}` : "Could not copy the path.");
    }
  });

  return {
    render,
    filter(query) {
      filter = filterXml(doc, query);
      render();
      return filter ? filter.count : null;
    },
    expandAll: () => expandAll(roots),
    collapseAll() {
      for (const r of roots) for (const c of r.children) collapseDeep(c);
    },
  };
}
