// Injected into the page by runInTab: each function must stand alone (no outer scope, types only).

export interface ServedHtml {
  ok: boolean;
  error?: string;
  /** HTTP status of the re-fetch. */
  status?: number;
  /** Final URL after redirects. */
  url?: string;
  redirected?: boolean;
  contentType?: string;
  /** Characters of the whole response. */
  length?: number;
  /** The response text, cut at `max` characters. */
  html?: string;
  truncated?: boolean;
  ms?: number;
}

/**
 * Fetches the page's own URL again from the page (same origin, so its cookies go along and no permission is needed).
 * A re-fetch: a personalized or A/B-tested page, or the result of a POST, can answer differently than the first load.
 */
export async function fetchServedHtml(max = 5_000_000): Promise<ServedHtml> {
  const started = performance.now();
  try {
    const res = await fetch(location.href, { credentials: "include", cache: "no-store", redirect: "follow" });
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      url: res.url,
      redirected: res.redirected,
      contentType: res.headers.get("content-type") ?? "",
      length: text.length,
      html: text.length > max ? text.slice(0, max) : text,
      truncated: text.length > max,
      ms: Math.round(performance.now() - started),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RenderedDom {
  url: string;
  /** document.documentElement.outerHTML with the doctype, devkit's own overlays left out, cut at `max` characters. */
  html: string;
  length: number;
  truncated: boolean;
}

/** The DOM as it is now, after scripts ran, without the elements devkit itself drew in the page. */
export function readRenderedDom(max = 5_000_000): RenderedDom {
  // devkit's overlays are <devkit-*> elements (headings badges, a11y outlines, picker, measure); its injected
  // styles, ribbon and relays carry a devkit- id.
  const own = (el: Element) => el.tagName.toUpperCase().startsWith("DEVKIT-") || el.id.startsWith("devkit-");
  const root = document.documentElement.cloneNode(true) as Element;
  for (const el of Array.from(root.querySelectorAll("*"))) if (own(el)) el.remove();
  const dt = document.doctype;
  const html = `${dt ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n` : ""}${root.outerHTML}`;
  return { url: location.href, html: html.length > max ? html.slice(0, max) : html, length: html.length, truncated: html.length > max };
}
