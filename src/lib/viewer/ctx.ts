// What the data viewer's bodies (JSON tree, XML tree, CSV table) share with its shell.

/** Elements are created in the XHTML namespace so they work in XML documents too (`createElement` there makes plain XML elements). */
export const XHTML = "http://www.w3.org/1999/xhtml";

export interface ViewCtx {
  doc: Document;
  app: HTMLElement;
  /** Where the body renders. */
  view: HTMLElement;
  el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, content?: string): HTMLElementTagNameMap[K];
  button(label: string, cls?: string, title?: string): HTMLButtonElement;
  toast(message: string): void;
  copy(text: string): Promise<boolean>;
}

/** A format's parsed view. */
export interface Body {
  /** Renders into `ctx.view`, with the current filter. */
  render(): void;
  /** Sets the filter (an empty query clears it) and renders; the match count, or null once cleared. */
  filter(query: string): number | null;
  expandAll?(): void;
  collapseAll?(): void;
  /** Words for the toolbar's count: `1 match`, `3 matches`. */
  countLabel?(count: number): string;
}

export function elementFactory(doc: Document): Pick<ViewCtx, "el" | "button"> {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, content?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
    if (cls) e.className = cls;
    if (content !== undefined) e.textContent = content;
    return e;
  };
  const button = (label: string, cls?: string, title?: string): HTMLButtonElement => {
    const b = el("button", cls, label);
    b.type = "button";
    if (title) b.title = title;
    return b;
  };
  return { el, button };
}

/** A link for an http(s) URL, opening in a new tab. */
export function linkTo(ctx: Pick<ViewCtx, "el">, href: string, text: string): HTMLAnchorElement {
  const a = ctx.el("a", undefined, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
