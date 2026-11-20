// Functions injected into the page with `runInTab`: each must stand alone (no outer scope).

export interface MetaSnapshot {
  url: string;
  title: string;
  lang: string;
  charset: string;
  doctype: string;
  /** `attr` is the attribute the key came from (Facebook reads `og:` tags from `property` only). */
  meta: { key: string; value: string; attr?: MetaAttr }[];
  /** `href` is resolved by the browser; `rawHref` is the attribute as written (to catch relative URLs). */
  links: { rel: string; href: string; rawHref?: string; hreflang?: string; type?: string; sizes?: string }[];
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
  /** Body text, images and links for the SEO counters. Absent from snapshots built by hand (tests). */
  content?: PageContent;
}

export type MetaAttr = "name" | "property" | "http-equiv" | "itemprop" | "charset";

export interface PageContent {
  /** Words of the rendered body text (`innerText`, so hidden text is left out). */
  words: number;
  /** Every `<img>`: `alt` is null when the attribute is missing ("" marks a decorative image). */
  images: { alt: string | null; title: boolean }[];
  /** `<a href>` and `<area href>` to http(s) URLs, hash removed, the first 5,000; `anchors` counts them all. */
  links: { href: string; rel: string }[];
  anchors: number;
}

/**
 * Reads the page's meta data. With `root` and `pageUrl` it reads a parsed document instead (the site crawl's
 * DOMParser output, served HTML only): links resolve against its `<base>`, and the word count reads every text
 * node outside script, style, noscript and template, as nothing is rendered there.
 */
export function collectMeta(root?: Document, pageUrl?: string): MetaSnapshot {
  const document = root ?? globalThis.document;
  // A parsed document resolves nothing against the page: links resolve here, against its <base> or the page URL.
  let base: string | null = null;
  if (root && pageUrl) {
    try {
      base = new URL(root.querySelector("base[href]")?.getAttribute("href") ?? "", pageUrl).href;
    } catch {
      base = pageUrl;
    }
  }
  const hrefOf = (el: HTMLLinkElement | HTMLAnchorElement | HTMLAreaElement) => {
    if (!base) return el.href;
    try {
      return new URL(el.getAttribute("href") ?? "", base).href;
    } catch {
      return el.getAttribute("href") ?? "";
    }
  };
  const attrs = ["name", "property", "http-equiv", "itemprop"] as const;
  const meta = Array.from(document.querySelectorAll("meta"))
    .map((m) => {
      const attr: MetaAttr | undefined =
        attrs.find((a) => m.getAttribute(a) !== null) ?? (m.hasAttribute("charset") ? "charset" : undefined);
      return {
        key: attr === "charset" ? "charset" : attr ? (m.getAttribute(attr) ?? "") : "",
        value: m.getAttribute("content") ?? m.getAttribute("charset") ?? "",
        attr,
      };
    })
    .filter((m) => m.key);
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel]")).map((l) => ({
    rel: l.rel,
    href: hrefOf(l),
    rawHref: l.getAttribute("href") ?? undefined,
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
  const parsedText = (body: HTMLElement | null) => {
    const parts: string[] = [];
    if (!body) return "";
    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (!node.parentElement?.closest("script, style, noscript, template")) parts.push(node.nodeValue ?? "");
    return parts.join(" ");
  };
  // biome-ignore lint/performance/useDomNodeTextContent: innerText skips hidden text, like a reader
  const bodyText = root ? parsedText(document.body) : (document.body?.innerText ?? "");
  const words = (bodyText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const anchors: { href: string; rel: string }[] = [];
  let anchorCount = 0;
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href], area[href]"))) {
    const href = hrefOf(a);
    if (!/^https?:/i.test(href)) continue;
    anchorCount++;
    if (anchors.length < 5000) anchors.push({ href: href.split("#")[0]!, rel: a.getAttribute("rel") ?? "" });
  }
  const images = Array.from(document.querySelectorAll("img")).map((img) => ({
    alt: img.getAttribute("alt"),
    title: img.hasAttribute("title"),
  }));
  return {
    url: pageUrl ?? location.href,
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
      images: images.length,
      iframes: document.querySelectorAll("iframe").length,
      forms: document.forms.length,
      domDepth,
      htmlBytes: new Blob([document.documentElement.outerHTML]).size,
    },
    content: { words, images, links: anchors, anchors: anchorCount },
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
