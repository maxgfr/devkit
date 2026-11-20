import { DATA_VIEWER_MESSAGE, looksLikeDataPage } from "../lib/data-viewer";

/**
 * Options › Data page viewer: runs on every page once turned on, so it only checks whether the tab
 * holds a data document (JSON, XML / RSS / Atom, CSV / TSV, YAML, JSON Lines) and, if so, asks the
 * background to inject the viewer itself (/data-viewer.js). The file keeps its JSON name so the
 * script registered by earlier versions keeps working.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  registration: "runtime",
  main() {
    if (looksLikeDataPage(document, location.href)) browser.runtime.sendMessage({ type: DATA_VIEWER_MESSAGE }).catch(() => undefined);
  },
});
