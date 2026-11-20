import { mountDataViewer } from "../lib/json-viewer-view";

/**
 * The data page viewer (JSON, XML / RSS / Atom, CSV / TSV, YAML, JSON Lines), injected on demand:
 * by the background when the always-on gate (json-viewer.content.ts) finds a data page, and by the
 * palette's "Format this data page", which sets `__devkitJsonViewerForce` first so text/plain JSON,
 * JSON Lines and XML are formatted too. Safe to run twice.
 */
export default defineUnlistedScript(() => {
  const force = Boolean((window as { __devkitJsonViewerForce?: boolean }).__devkitJsonViewerForce);
  return mountDataViewer(document, { force, url: location.href });
});
