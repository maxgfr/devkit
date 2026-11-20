import { browser } from "wxt/browser";
import { META_REFRESH_SEEN } from "../lib/redirects";

/**
 * Tells the background whether the page has a `<meta http-equiv=refresh>`, so the Redirect path panel can name a
 * client redirect (meta refresh or JavaScript). Registered at runtime by the background once the user grants
 * webRequest, webNavigation and site access; read-only. It runs at document_start and reports the tag as soon as
 * the parser inserts it: a refresh with no delay can replace the page before an injected script would run.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  registration: "runtime",
  main() {
    let sent = false;
    const send = (content: string | null) => {
      if (sent) return;
      sent = true;
      observer.disconnect();
      browser.runtime.sendMessage({ type: META_REFRESH_SEEN, content }).catch(() => undefined);
    };
    const check = (el: Element) => {
      if (el.tagName !== "META" || (el.getAttribute("http-equiv") ?? "").trim().toLowerCase() !== "refresh") return;
      const content = el.getAttribute("content");
      if (content !== null && !el.closest("noscript")) send(content);
    };
    // Only the nodes the parser adds, and only until <body> starts: the tag belongs in <head>.
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const node of Array.from(r.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === "BODY") observer.disconnect();
          check(node);
        }
    });
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        for (const el of Array.from(document.querySelectorAll("meta[http-equiv]"))) check(el);
        send(null);
      },
      { once: true },
    );
  },
});
