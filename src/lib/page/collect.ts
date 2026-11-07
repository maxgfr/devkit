// Functions injected into the page with `runInTab`: each must stand alone (no outer scope).

export interface MetaSnapshot {
  url: string;
  title: string;
  lang: string;
  charset: string;
  doctype: string;
  meta: { key: string; value: string }[];
  links: { rel: string; href: string; hreflang?: string; type?: string; sizes?: string }[];
  headings: { level: number; text: string }[];
  jsonLd: { raw: string; index: number }[];
  microdataTypes: string[];
  stats: {
    elements: number;
    scripts: number;
    stylesheets: number;
    images: number;
    iframes: number;
    forms: number;
    domDepth: number;
    htmlBytes: number;
  };
}

export function collectMeta(): MetaSnapshot {
  const meta = Array.from(document.querySelectorAll("meta"))
    .map((m) => ({
      key:
        m.getAttribute("name") ??
        m.getAttribute("property") ??
        m.getAttribute("http-equiv") ??
        m.getAttribute("itemprop") ??
        (m.hasAttribute("charset") ? "charset" : ""),
      value: m.getAttribute("content") ?? m.getAttribute("charset") ?? "",
    }))
    .filter((m) => m.key);
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel]")).map((l) => ({
    rel: l.rel,
    href: l.href,
    hreflang: l.hreflang || undefined,
    type: l.type || undefined,
    sizes: l.getAttribute("sizes") ?? undefined,
  }));
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  }));
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s, index) => ({
    raw: s.textContent ?? "",
    index,
  }));
  const microdataTypes = Array.from(
    new Set(Array.from(document.querySelectorAll("[itemscope][itemtype]")).map((e) => e.getAttribute("itemtype") ?? "")),
  );
  let domDepth = 0;
  const walk = (el: Element, depth: number) => {
    if (depth > domDepth) domDepth = depth;
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  walk(document.documentElement, 1);
  const dt = document.doctype;
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    charset: document.characterSet,
    doctype: dt ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}>` : "",
    meta,
    links,
    headings,
    jsonLd,
    microdataTypes,
    stats: {
      elements: document.getElementsByTagName("*").length,
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      images: document.images.length,
      iframes: document.querySelectorAll("iframe").length,
      forms: document.forms.length,
      domDepth,
      htmlBytes: new Blob([document.documentElement.outerHTML]).size,
    },
  };
}

export interface TechSignals {
  globals: string[];
  generator: string[];
  scripts: string[];
  attributes: string[];
  classSample: string[];
}

/** Runs in the MAIN world: reads the page's own globals. */
export function collectTechSignals(): TechSignals {
  const w = window as unknown as Record<string, unknown>;
  const names = [
    "__NEXT_DATA__",
    "next",
    "__NUXT__",
    "$nuxt",
    "__VUE__",
    "Vue",
    "__SVELTEKIT_DATA__",
    "__sveltekit_dev",
    "ng",
    "angular",
    "getAllAngularRootElements",
    "React",
    "__REACT_DEVTOOLS_GLOBAL_HOOK__",
    "__remixContext",
    "__GATSBY",
    "___gatsby",
    "Ember",
    "Alpine",
    "htmx",
    "Stimulus",
    "Turbo",
    "jQuery",
    "$",
    "Shopify",
    "wp",
    "Drupal",
    "Webflow",
    "Wix",
    "dataLayer",
    "gtag",
    "ga",
    "_paq",
    "plausible",
    "posthog",
    "mixpanel",
    "analytics",
    "amplitude",
    "hj",
    "clarity",
    "__SENTRY__",
    "Sentry",
    "DD_RUM",
    "newrelic",
    "LogRocket",
    "Intercom",
    "$crisp",
    "Stripe",
    "grecaptcha",
    "hcaptcha",
    "turnstile",
    "Astro",
    "__APOLLO_CLIENT__",
    "__REDUX_DEVTOOLS_EXTENSION__",
    "Livewire",
    "Inertia",
    "Qwik",
    "__qwik",
    "solid",
    "_$HY",
    "Preact",
    "__PREACT_DEVTOOLS__",
    "Backbone",
    "Zepto",
    "lodash",
    "_",
    "moment",
    "dayjs",
    "gsap",
    "THREE",
    "Swiper",
    "bootstrap",
    "Lit",
    "litElementVersions",
    "Polymer",
  ];
  const globals = names.filter((n) => {
    try {
      return w[n] !== undefined;
    } catch {
      return false;
    }
  });
  const reactRoot = Array.from(document.querySelectorAll("body *"))
    .slice(0, 400)
    .some((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$") || k.startsWith("_reactRootContainer"),
      ),
    );
  if (reactRoot) globals.push("__react_dom__");
  const attributes: string[] = [];
  for (const sel of [
    "[ng-version]",
    "[data-reactroot]",
    "[data-v-app]",
    "[data-server-rendered]",
    "astro-island",
    "[data-astro-cid]",
    "[q\\:container]",
    "[data-svelte-h]",
    "[x-data]",
    "[hx-get],[hx-post]",
    "[data-turbo]",
    "[wire\\:id]",
    "#__next",
    "#__nuxt",
    "#___gatsby",
    "[data-sveltekit-preload-data]",
  ]) {
    try {
      if (document.querySelector(sel)) attributes.push(sel);
    } catch {
      /* invalid selector in an old engine */
    }
  }
  const ngVersion = document.querySelector("[ng-version]")?.getAttribute("ng-version");
  if (ngVersion) attributes.push(`ng-version=${ngVersion}`);
  const classes = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("[class]")).slice(0, 600)) for (const c of Array.from(el.classList)) classes.add(c);
  return {
    globals,
    generator: Array.from(document.querySelectorAll('meta[name="generator"]')).map((m) => m.getAttribute("content") ?? ""),
    scripts: Array.from(document.scripts)
      .map((s) => s.src)
      .filter(Boolean)
      .slice(0, 200),
    attributes,
    classSample: Array.from(classes).slice(0, 1500),
  };
}

export interface PerfSnapshot {
  navigation: Record<string, number> | null;
  lcp: number | null;
  cls: number;
  inp: number | null;
  fcp: number | null;
  longTasks: { count: number; total: number };
  /** `startTime` and `responseStart` are ms from navigation start; `responseStart` is 0 when the server hides it (no Timing-Allow-Origin). */
  resources: {
    name: string;
    type: string;
    transfer: number;
    decoded: number;
    duration: number;
    startTime: number;
    responseStart: number;
  }[];
}

export async function collectPerf(): Promise<PerfSnapshot> {
  const read = (type: string) =>
    new Promise<PerformanceEntry[]>((resolve) => {
      try {
        const entries: PerformanceEntry[] = [];
        const po = new PerformanceObserver((list) => entries.push(...list.getEntries()));
        po.observe({ type, buffered: true } as PerformanceObserverInit);
        setTimeout(() => {
          po.disconnect();
          resolve(entries);
        }, 60);
      } catch {
        resolve([]);
      }
    });
  const [lcpEntries, shifts, events, paints, longTasks] = await Promise.all([
    read("largest-contentful-paint"),
    read("layout-shift"),
    read("event"),
    read("paint"),
    read("longtask"),
  ]);
  let cls = 0;
  let windowValue = 0;
  let windowStart = 0;
  let last = 0;
  for (const e of shifts as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
    if (e.hadRecentInput) continue;
    if (e.startTime - last > 1000 || e.startTime - windowStart > 5000) {
      windowStart = e.startTime;
      windowValue = 0;
    }
    windowValue += e.value;
    last = e.startTime;
    cls = Math.max(cls, windowValue);
  }
  const interactions = (events as (PerformanceEntry & { interactionId?: number })[]).filter((e) => e.interactionId);
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return {
    navigation: nav
      ? {
          redirect: nav.redirectEnd - nav.redirectStart,
          dns: nav.domainLookupEnd - nav.domainLookupStart,
          connect: nav.connectEnd - nav.connectStart,
          tls: nav.secureConnectionStart ? nav.connectEnd - nav.secureConnectionStart : 0,
          ttfb: nav.responseStart - nav.startTime,
          download: nav.responseEnd - nav.responseStart,
          domInteractive: nav.domInteractive - nav.startTime,
          domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
          load: nav.loadEventEnd - nav.startTime,
          transfer: nav.transferSize,
          decoded: nav.decodedBodySize,
          // Phase boundaries in ms from navigation start, for the timeline.
          redirectEnd: nav.redirectEnd,
          fetchStart: nav.fetchStart,
          dnsStart: nav.domainLookupStart,
          dnsEnd: nav.domainLookupEnd,
          connectStart: nav.connectStart,
          tlsStart: nav.secureConnectionStart,
          connectEnd: nav.connectEnd,
          requestStart: nav.requestStart,
          responseStart: nav.responseStart,
          responseEnd: nav.responseEnd,
        }
      : null,
    lcp: lcpEntries.length ? lcpEntries[lcpEntries.length - 1]!.startTime : null,
    cls,
    inp: interactions.length ? Math.max(...interactions.map((e) => e.duration)) : null,
    fcp: paints.find((p) => p.name === "first-contentful-paint")?.startTime ?? null,
    longTasks: { count: longTasks.length, total: longTasks.reduce((s, t) => s + t.duration, 0) },
    resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map((r) => ({
      name: r.name,
      type: r.initiatorType,
      transfer: r.transferSize,
      decoded: r.decodedBodySize,
      duration: r.duration,
      startTime: r.startTime,
      responseStart: r.responseStart,
    })),
  };
}

export interface A11yHint {
  rule: string;
  count: number;
  samples: string[];
}

export function collectA11yHints(): A11yHint[] {
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const name = (el: Element) =>
    (el.getAttribute("aria-label") ?? "").trim() ||
    (el.getAttribute("aria-labelledby") ? "x" : "") ||
    (el.textContent ?? "").trim() ||
    (el.getAttribute("title") ?? "").trim() ||
    (el.querySelector("img[alt]:not([alt=''])") ? "img" : "");
  const hints: A11yHint[] = [];
  const add = (rule: string, els: Element[]) => {
    if (els.length) hints.push({ rule, count: els.length, samples: els.slice(0, 5).map(describe) });
  };
  add("Images without an alt attribute", Array.from(document.querySelectorAll("img:not([alt])")));
  add(
    "Form fields without a label",
    Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea")).filter((el) => {
      const id = el.id;
      return !(
        el.closest("label") ||
        (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        el.getAttribute("title")
      );
    }),
  );
  add(
    "Buttons without an accessible name",
    Array.from(document.querySelectorAll("button,[role=button]")).filter((el) => !name(el)),
  );
  add(
    "Links without text",
    Array.from(document.querySelectorAll("a[href]")).filter((el) => !name(el)),
  );
  if (!document.documentElement.lang) hints.push({ rule: "The <html> element has no lang", count: 1, samples: ["html"] });
  const ids = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll("[id]"))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  const dupes = Array.from(ids.entries()).filter(([, n]) => n > 1);
  if (dupes.length) hints.push({ rule: "Duplicate ids", count: dupes.length, samples: dupes.slice(0, 5).map(([id, n]) => `#${id} ×${n}`) });
  const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName[1]));
  const skips = levels.filter((l, i) => i > 0 && l - levels[i - 1]! > 1).length;
  if (skips) hints.push({ rule: "Skipped heading levels", count: skips, samples: [] });
  if (!levels.includes(1)) hints.push({ rule: "No <h1> on the page", count: 1, samples: [] });
  const vp = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(vp))
    hints.push({ rule: "Zoom is disabled by the viewport meta", count: 1, samples: [vp] });
  return hints;
}

export interface FontsColors {
  fonts: { family: string; weight: string; style: string; status: string }[];
  families: { family: string; count: number }[];
  colors: { color: string; count: number }[];
}

export function collectFontsColors(): FontsColors {
  const fonts: FontsColors["fonts"] = [];
  for (const f of Array.from(document.fonts as unknown as Iterable<FontFace>))
    fonts.push({ family: f.family.replace(/^["']|["']$/g, ""), weight: f.weight, style: f.style, status: f.status });
  const families = new Map<string, number>();
  const colors = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const el of Array.from(document.querySelectorAll("body, body *")).slice(0, 4000)) {
    const cs = getComputedStyle(el);
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim()))
      bump(families, cs.fontFamily.split(",")[0]!.replace(/["']/g, "").trim());
    for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor])
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") bump(colors, c);
  }
  const top = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  return {
    fonts,
    families: top(families, 20).map(([family, count]) => ({ family, count })),
    colors: top(colors, 40).map(([color, count]) => ({ color, count })),
  };
}

export function collectLinks(): { href: string; text: string; rel: string }[] {
  const seen = new Set<string>();
  const out: { href: string; text: string; rel: string }[] = [];
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.href.split("#")[0]!;
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80), rel: a.rel });
  }
  return out;
}

export function collectSelection(): string {
  return String(window.getSelection() ?? "").slice(0, 20000);
}

export function readBodyText(): string {
  // biome-ignore lint/performance/useDomNodeTextContent: innerText skips hidden text and keeps line breaks
  return document.body?.innerText ?? document.documentElement.textContent ?? "";
}
