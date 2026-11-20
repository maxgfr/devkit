import { mountJsonViewer } from "../lib/json-viewer-view";

/**
 * Formats JSON documents opened in a tab. Registered at runtime when the user turns on
 * Options › JSON viewer, and injected on demand by the palette's "Format this JSON page" (which
 * sets `__devkitJsonViewerForce` first so text/plain JSON is formatted too). Safe to run twice.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  registration: "runtime",
  main() {
    const force = Boolean((window as { __devkitJsonViewerForce?: boolean }).__devkitJsonViewerForce);
    return mountJsonViewer(document, { force, url: location.href });
  },
});
