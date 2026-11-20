// Meta refresh of the page, read by the Redirect path panel (a refresh still to come). Must stand alone: no outer
// scope. The background learns it from the probe content script instead (src/entrypoints/redirect-probe.content.ts).

/** The `content` of the page's first `<meta http-equiv=refresh>` outside `<noscript>`, or null. With `wait`, answers once the document is parsed. */
export function pageMetaRefresh(wait = false): Promise<{ content: string } | null> {
  const read = () => {
    for (const meta of Array.from(document.querySelectorAll("meta[http-equiv]"))) {
      if ((meta.getAttribute("http-equiv") ?? "").trim().toLowerCase() !== "refresh") continue;
      if (meta.closest("noscript")) continue;
      const content = meta.getAttribute("content");
      if (content !== null) return { content };
    }
    return null;
  };
  if (!wait || document.readyState !== "loading") return Promise.resolve(read());
  return new Promise((done) => document.addEventListener("DOMContentLoaded", () => done(read()), { once: true }));
}
