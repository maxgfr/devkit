import { browser } from "wxt/browser";

/** Forwards the MAIN-world error count to the background, which shows it on the toolbar badge. */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  registration: "runtime",
  main() {
    let pending: number | null = null;
    window.addEventListener("message", (event) => {
      if (event.source !== window || (event.data as { __devkit?: string } | null)?.__devkit !== "errors") return;
      const count = Number((event.data as { count: number }).count) || 0;
      if (pending !== null) clearTimeout(pending);
      pending = window.setTimeout(() => {
        browser.runtime.sendMessage({ type: "devkit:errors", count }).catch(() => undefined);
      }, 250);
    });
  },
});
