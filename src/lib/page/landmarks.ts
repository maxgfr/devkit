// Injected into the page by runInTab: each function must stand alone (no outer scope, types only).

export type LandmarkRole = "banner" | "navigation" | "main" | "complementary" | "contentinfo" | "region" | "search" | "form";

/** visible: seen and announced · aria-hidden: seen but not announced · hidden: neither (display:none, hidden, visibility:hidden). */
export type LandmarkVisibility = "visible" | "aria-hidden" | "hidden";

export interface RawLandmark {
  /** Document order among the landmarks. */
  index: number;
  role: LandmarkRole;
  /** Lowercase tag name, e.g. "nav" or "div". */
  tag: string;
  /** Accessible name: aria-labelledby, else aria-label, else title; whitespace collapsed, cut at 120 characters. */
  name?: string;
  /** The role comes from a role attribute rather than from the tag. */
  explicitRole: boolean;
  /** The role attribute repeats what the tag already gives, e.g. <nav role="navigation">. */
  redundantRole?: boolean;
  visibility: LandmarkVisibility;
  /** A CSS selector that matches this landmark alone. */
  selector: string;
  /** Index of the nearest landmark ancestor, -1 at the top. */
  parent: number;
  /** Landmark ancestors above it. */
  depth: number;
  /** Headings (indexes in collectHeadings' order) whose nearest landmark is this one. */
  headingIndexes: number[];
  /** Index of the first heading that comes after the landmark's start: orders it among its parent's headings. */
  headingStart: number;
  /** Position in the document, CSS px (0 when hidden). */
  top: number;
  height: number;
}

export interface LandmarksSnapshot {
  url: string;
  landmarks: RawLandmark[];
  /** Headings (indexes in collectHeadings' order) inside no landmark. */
  headingsOutside: number[];
  /** Stopped at the cap of landmarks. */
  capped: boolean;
}

/**
 * The page's ARIA landmarks as browsers map them (HTML-AAM): header / footer are banner / contentinfo only outside
 * article, aside, main, nav and section; section and form only with an accessible name; aside outside main and the
 * body only with a name; an explicit role wins and role="none" / "presentation" removes it.
 */
export function collectLandmarks(max = 300): LandmarksSnapshot {
  // Same cap and filter as collectHeadings, so heading indexes line up with its snapshot.
  const HEADINGS_MAX = 500;
  const OWN = new Set(["DEVKIT-HEADINGS", "DEVKIT-HEADINGS-FOCUS", "DEVKIT-A11Y", "DEVKIT-PICKER", "DEVKIT-MEASURE"]);
  const ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "region", "search", "form"]);
  const SECTIONING = "article,aside,main,nav,section,[role=article],[role=complementary],[role=main],[role=navigation],[role=region]";
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));

  const inOwn = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) if (OWN.has(n.tagName.toUpperCase())) return true;
    return false;
  };

  const selectorOf = (el: Element): string => {
    if (el.id) {
      const sel = `#${esc(el.id)}`;
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* id that no selector can express */
      }
    }
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      if (node !== el && node.id) {
        const sel = `#${esc(node.id)}`;
        try {
          if (document.querySelectorAll(sel).length === 1) {
            parts.unshift(sel);
            break;
          }
        } catch {
          /* keep climbing */
        }
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (parent === document.body) {
        parts.unshift("body");
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  };

  const nameOf = (el: Element): string | undefined => {
    const ids = clean(el.getAttribute("aria-labelledby"));
    if (ids) {
      const named = clean(
        ids
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
      if (named) return named.slice(0, 120);
    }
    const label = clean(el.getAttribute("aria-label"));
    if (label) return label.slice(0, 120);
    const title = clean(el.getAttribute("title"));
    return title ? title.slice(0, 120) : undefined;
  };

  /** The role the tag alone gives, or undefined when it is no landmark. */
  const implicitRole = (el: Element, named: boolean): LandmarkRole | undefined => {
    const scoped = () => Boolean(el.parentElement?.closest(SECTIONING));
    switch (el.tagName.toLowerCase()) {
      case "header":
        return scoped() ? undefined : "banner";
      case "footer":
        return scoped() ? undefined : "contentinfo";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "search":
        return "search";
      case "section":
        return named ? "region" : undefined;
      case "form":
        return named ? "form" : undefined;
      case "aside": {
        // An aside inside article, aside, nav or section is complementary only when named (HTML-AAM).
        const inner = el.parentElement?.closest(
          "article,aside,nav,section,[role=article],[role=complementary],[role=navigation],[role=region]",
        );
        return !inner || named ? "complementary" : undefined;
      }
      default:
        return undefined;
    }
  };

  const visibilityOf = (el: HTMLElement): LandmarkVisibility => {
    if (el.closest("[hidden]")) return "hidden";
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return "hidden";
    const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    // display:contents has no box but stays in the accessibility tree.
    if (typeof check === "function" && cs.display !== "contents" && !check.call(el, { visibilityProperty: true })) return "hidden";
    if (el.closest('[aria-hidden="true"]')) return "aria-hidden";
    return "visible";
  };

  type Found = { el: HTMLElement; role: LandmarkRole; name?: string; explicit: boolean; redundant: boolean };
  const found: Found[] = [];
  let capped = false;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("header,footer,nav,main,aside,form,section,search,[role]"))) {
    if (inOwn(el)) continue;
    const name = nameOf(el);
    const implicit = implicitRole(el, Boolean(name));
    const token = clean(el.getAttribute("role")).toLowerCase().split(" ")[0] ?? "";
    let role: LandmarkRole | undefined;
    let explicit = false;
    if (token) {
      // An explicit role wins; region and form still need a name to be landmarks (WAI-ARIA).
      if (ROLES.has(token) && (name || (token !== "region" && token !== "form"))) {
        role = token as LandmarkRole;
        explicit = true;
      }
    } else role = implicit;
    if (!role) continue;
    if (found.length >= max) {
      capped = true;
      break;
    }
    found.push({ el, role, name, explicit, redundant: explicit && implicit === role });
  }

  const at = new Map(found.map((f, i) => [f.el as Element, i] as const));
  const parentOf = (el: Element): number => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const i = at.get(n);
      if (i !== undefined) return i;
    }
    return -1;
  };

  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]"))
    .filter((el) => {
      const role = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase();
      return /^H[1-6]$/.test(el.tagName) ? !role || role === "heading" : role === "heading";
    })
    .slice(0, HEADINGS_MAX);

  const parents = found.map((f) => parentOf(f.el));
  const owned = found.map((): number[] => []);
  const outside: number[] = [];
  headings.forEach((h, i) => {
    const p = parentOf(h);
    if (p < 0) outside.push(i);
    else owned[p]!.push(i);
  });
  // Both lists are in document order: one pass finds the first heading after each landmark's start.
  const starts: number[] = [];
  let k = 0;
  for (const f of found) {
    while (k < headings.length && f.el.compareDocumentPosition(headings[k]!) & Node.DOCUMENT_POSITION_PRECEDING) k++;
    starts.push(k);
  }

  const landmarks = found.map((f, index): RawLandmark => {
    let depth = 0;
    for (let p = parents[index]!; p >= 0; p = parents[p]!) depth++;
    const visibility = visibilityOf(f.el);
    const r = f.el.getBoundingClientRect();
    return {
      index,
      role: f.role,
      tag: f.el.tagName.toLowerCase(),
      name: f.name,
      explicitRole: f.explicit,
      redundantRole: f.redundant || undefined,
      visibility,
      selector: selectorOf(f.el),
      parent: parents[index]!,
      depth,
      headingIndexes: owned[index]!,
      headingStart: starts[index]!,
      top: visibility === "hidden" ? 0 : Math.round(r.top + scrollY),
      height: Math.round(r.height),
    };
  });

  return { url: location.href, landmarks, headingsOutside: outside, capped };
}
