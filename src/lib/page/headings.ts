// Injected into the page by runInTab: each function must stand alone (no outer scope, types only).

/**
 * visible: seen and announced · sr-only: visually hidden but announced (the "sr-only" pattern) ·
 * aria-hidden: seen but not announced · hidden: neither (display:none, hidden, visibility:hidden, zero size).
 */
export type HeadingVisibility = "visible" | "sr-only" | "aria-hidden" | "hidden";

export interface RawHeading {
  /** Document order among the headings. */
  index: number;
  /** 1–6: aria-level when valid, else the tag's level, else 2 (the ARIA default for role=heading). */
  level: number;
  /** Lowercase tag name, e.g. "h2" or "div". */
  tag: string;
  /** Exposed through role="heading" rather than an h1–h6 tag. */
  role: boolean;
  /** role="heading" without a valid aria-level: screen readers announce it as level 2. */
  ariaLevelMissing?: boolean;
  /** Text content, whitespace collapsed, cut at 200 characters. */
  text: string;
  /** Accessible name when it differs from the text (aria-label, aria-labelledby, alt of an image inside). */
  name?: string;
  visibility: HeadingVisibility;
  id?: string;
  /** Nearest landmark: main, nav, aside, header, footer, dialog, form. */
  landmark?: string;
  /** A CSS selector that matches this heading alone. */
  selector: string;
  /** The opening of its HTML, cut at 200 characters. */
  html: string;
  /** Position in the document, CSS px (0 when hidden). */
  top: number;
  height: number;
  /** Visible text between this heading and the next one, first 300 characters. */
  section: string;
  /** Words in that text. */
  words: number;
}

export interface HeadingsSnapshot {
  url: string;
  title: string;
  docHeight: number;
  viewportHeight: number;
  headings: RawHeading[];
  /** Words before the first heading. */
  introWords: number;
  /** Stopped at the cap of headings. */
  capped: boolean;
}

/** Every h1–h6 and role="heading" of the document, in order, with what a reader and a screen reader get. */
export function collectHeadings(max = 500): HeadingsSnapshot {
  const SECTION_CHARS = 300;
  const OWN = new Set(["DEVKIT-HEADINGS", "DEVKIT-A11Y", "DEVKIT-PICKER", "DEVKIT-MEASURE"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "CANVAS"]);
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));

  const all = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")).filter((el) => {
    const role = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    // <h2 role="presentation"> is not a heading for assistive technologies; <div role="heading"> is.
    return /^H[1-6]$/.test(el.tagName) ? !role || role === "heading" : role === "heading";
  });
  const capped = all.length > max;
  const els = all.slice(0, max);
  const indexOf = new Map(els.map((el, i) => [el, i] as const));

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
    // Up to an ancestor with a unique id, or to <body>: the nth-of-type chain is then unique by construction.
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

  const nameOf = (el: HTMLElement, text: string): string | undefined => {
    const label = clean(el.getAttribute("aria-label"));
    if (label) return label === text ? undefined : label;
    const ids = clean(el.getAttribute("aria-labelledby"));
    if (ids) {
      const named = clean(
        ids
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
      if (named) return named === text ? undefined : named;
    }
    if (!text) {
      const alt = clean(
        Array.from(el.querySelectorAll("img[alt], [role=img][aria-label], svg[aria-label]"))
          .map((i) => i.getAttribute("alt") ?? i.getAttribute("aria-label") ?? "")
          .join(" "),
      );
      if (alt) return alt;
    }
    return undefined;
  };

  const visibilityOf = (el: HTMLElement): HeadingVisibility => {
    if (el.closest("[hidden]")) return "hidden";
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return "hidden";
    const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (typeof check === "function" && !check.call(el, { visibilityProperty: true })) return "hidden";
    if (el.closest('[aria-hidden="true"]')) return "aria-hidden";
    // The sr-only pattern, on the heading or an ancestor: clipped to nothing, 1px boxes, or pushed off screen.
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
      const s = n === el ? cs : getComputedStyle(n);
      const clipped = /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip) || /inset\(\s*50%/.test(s.clipPath);
      const tiny = parseFloat(s.width) <= 1 && parseFloat(s.height) <= 1 && s.overflow.includes("hidden");
      const away = (s.position === "absolute" || s.position === "fixed") && (parseFloat(s.left) <= -999 || parseFloat(s.top) <= -999);
      if (clipped || tiny || away) return "sr-only";
    }
    if (typeof check === "function") {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return "hidden";
    }
    return "visible";
  };

  const landmarkOf = (el: Element): string | undefined => {
    const lm = el.closest(
      "main,[role=main],nav,[role=navigation],aside,[role=complementary],header,[role=banner],footer,[role=contentinfo],dialog,[role=dialog],form,[role=search]",
    );
    if (!lm) return undefined;
    const role = lm.getAttribute("role");
    if (role) return { navigation: "nav", complementary: "aside", banner: "header", contentinfo: "footer" }[role] ?? role;
    return lm.tagName.toLowerCase();
  };

  // One walk for the text of every section: text nodes go to the last heading met, hidden subtrees are skipped.
  const sections = els.map(() => ({ text: "", words: 0 }));
  let intro = 0;
  let current = -1;
  const visible = (el: Element) => {
    if (el.hasAttribute("hidden")) return false;
    const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
    if (typeof check === "function") return check.call(el);
    const cs = getComputedStyle(el);
    return cs.display !== "none" && !el.hasAttribute("hidden");
  };
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const el = node as Element;
        if (SKIP.has(el.tagName.toUpperCase()) || OWN.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        // A hidden subtree adds no text, and the hidden headings in it start no section: the text after
        // them still reads as part of the visible heading before.
        if (!visible(el)) return NodeFilter.FILTER_REJECT;
        const at = indexOf.get(el as HTMLElement);
        if (at !== undefined) {
          current = at;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let steps = 0;
    for (let n = walker.nextNode(); n && steps < 200_000; n = walker.nextNode(), steps++) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const text = clean(n.nodeValue);
      if (!text) continue;
      const words = text.split(" ").length;
      if (current < 0) intro += words;
      else {
        const s = sections[current]!;
        s.words += words;
        if (s.text.length < SECTION_CHARS) s.text = `${s.text}${s.text ? " " : ""}${text}`.slice(0, SECTION_CHARS);
      }
    }
  }

  const headings = els.map((el, index): RawHeading => {
    const tag = el.tagName.toLowerCase();
    const role = !/^h[1-6]$/.test(tag);
    const aria = Number(el.getAttribute("aria-level"));
    const ariaValid = Number.isInteger(aria) && aria >= 1;
    const level = Math.min(6, ariaValid ? aria : role ? 2 : Number(tag[1]));
    const text = clean(el.textContent).slice(0, 200);
    const visibility = visibilityOf(el);
    const r = el.getBoundingClientRect();
    const open = el.outerHTML.slice(0, el.outerHTML.indexOf(">") + 1);
    // The opening tag and the text: inner markup (icons, comments) only adds noise to a report.
    const html = `${open}${text.slice(0, 120)}</${tag}>`;
    return {
      index,
      level,
      tag,
      role,
      ariaLevelMissing: role && !ariaValid ? true : undefined,
      text,
      name: nameOf(el, text),
      visibility,
      id: el.id || undefined,
      landmark: landmarkOf(el),
      selector: selectorOf(el),
      html: html.length > 200 ? `${html.slice(0, 199)}…` : html,
      top: visibility === "hidden" ? 0 : Math.round(r.top + scrollY),
      height: Math.round(r.height),
      section: sections[index]!.text,
      words: sections[index]!.words,
    };
  });

  return {
    url: location.href,
    title: document.title,
    docHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, innerHeight),
    viewportHeight: innerHeight,
    headings,
    introWords: intro,
    capped,
  };
}

/** Scrolls to one heading and outlines it with its label, until the next click, key or highlight. */
export function highlightHeading(selector: string, label: string): "shown" | "missing" | "hidden" {
  type W = Window & { __devkitHeadingFocus?: () => void };
  const w = window as W;
  w.__devkitHeadingFocus?.();
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return "missing";
  }
  if (!el) return "missing";
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
  const first = el.getBoundingClientRect();
  if (!first.width && !first.height) return "hidden";
  const host = document.createElement("devkit-headings-focus");
  // Inline styles through the CSSOM: a page's CSP does not apply to them.
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block; contain: strict;";
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText =
    "position: fixed; box-sizing: border-box; border: 2px solid #22d3ee; outline: 2px solid rgba(11, 18, 32, 0.55); background: rgba(34, 211, 238, 0.14); border-radius: 2px; pointer-events: none;";
  const tag = document.createElement("div");
  tag.style.cssText =
    "position: fixed; max-width: min(460px, calc(100vw - 16px)); padding: 3px 7px; border-radius: 4px; background: #0b1220; color: #e7e9ee; font: 500 12px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.3); pointer-events: none;";
  tag.textContent = label;
  shadow.append(box, tag);
  document.documentElement.append(host);
  try {
    host.setAttribute("popover", "manual");
    (host as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* no popover support: z-index only */
  }
  let raf = 0;
  const place = () => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    const top = r.top - 30 >= 0 ? r.top - 30 : Math.min(r.bottom + 6, innerHeight - 28);
    tag.style.top = `${Math.max(4, top)}px`;
    tag.style.left = `${Math.max(4, Math.min(r.left - 3, innerWidth - tag.offsetWidth - 4))}px`;
  };
  const redraw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  place();
  const opts = { capture: true, passive: true } as const;
  const stop = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", redraw, opts);
    window.removeEventListener("resize", redraw);
    window.removeEventListener("pointerdown", stop, opts);
    window.removeEventListener("keydown", stop, opts);
    host.remove();
    if (w.__devkitHeadingFocus === stop) w.__devkitHeadingFocus = undefined;
  };
  window.addEventListener("scroll", redraw, opts);
  window.addEventListener("resize", redraw);
  window.addEventListener("pointerdown", stop, opts);
  window.addEventListener("keydown", stop, opts);
  w.__devkitHeadingFocus = stop;
  return "shown";
}

export interface HeadingBadge {
  selector: string;
  /** e.g. "H2", or "H4 · skipped h3". */
  label: string;
  /** Has a problem: drawn in red. */
  bad: boolean;
}

/** Puts a level badge and a dashed outline on every heading in the page. Replaces the previous set; returns how many are shown. */
export function showHeadingBadges(badges: HeadingBadge[]): number {
  type W = Window & { __devkitHeadingBadges?: () => void };
  const w = window as W;
  w.__devkitHeadingBadges?.();
  // The label carries the level; color only says "has a problem" (devkit cyan, red).
  const OK = "#0e7490";
  const BAD = "#dc2626";
  const host = document.createElement("devkit-headings");
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; display: block; contain: strict;";
  const shadow = host.attachShadow({ mode: "closed" });
  const items: { el: Element; box: HTMLDivElement; tag: HTMLDivElement }[] = [];
  for (const b of badges) {
    let el: Element | null = null;
    try {
      el = document.querySelector(b.selector);
    } catch {
      continue;
    }
    if (!el) continue;
    const color = b.bad ? BAD : OK;
    const box = document.createElement("div");
    box.style.cssText = `position: fixed; box-sizing: border-box; border: 1.5px dashed ${color}; border-radius: 2px; pointer-events: none; display: none;`;
    const tag = document.createElement("div");
    tag.style.cssText = `position: fixed; padding: 1px 5px; border-radius: 3px; background: ${color}; color: #fff; font: 600 11px/1.45 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.3); pointer-events: none; display: none;`;
    tag.textContent = b.label;
    shadow.append(box, tag);
    items.push({ el, box, tag });
  }
  document.documentElement.append(host);
  try {
    host.setAttribute("popover", "manual");
    (host as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* z-index only */
  }
  let raf = 0;
  const place = () => {
    for (const { el, box, tag } of items) {
      const r = el.getBoundingClientRect();
      const off = (!r.width && !r.height) || r.bottom < -40 || r.top > innerHeight + 40;
      box.style.display = off ? "none" : "block";
      tag.style.display = off ? "none" : "block";
      if (off) continue;
      Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      tag.style.left = `${Math.max(2, r.left - 2)}px`;
      tag.style.top = `${Math.max(2, r.top - 19)}px`;
    }
  };
  const redraw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  place();
  // Layout moves without scrolling too (fonts, images, lazy content).
  const timer = setInterval(redraw, 1000);
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("scroll", redraw, opts);
  window.addEventListener("resize", redraw);
  const stop = () => {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    window.removeEventListener("scroll", redraw, opts);
    window.removeEventListener("resize", redraw);
    host.remove();
    if (w.__devkitHeadingBadges === stop) w.__devkitHeadingBadges = undefined;
  };
  w.__devkitHeadingBadges = stop;
  return items.length;
}

export function hideHeadingBadges(): boolean {
  const w = window as Window & { __devkitHeadingBadges?: () => void; __devkitHeadingFocus?: () => void };
  const had = Boolean(w.__devkitHeadingBadges);
  w.__devkitHeadingBadges?.();
  w.__devkitHeadingFocus?.();
  return had;
}
