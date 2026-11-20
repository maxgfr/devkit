// Functions injected into the page with `runInTab` around the JSON viewer script: each must stand alone.

/** Lets the next injection of the viewer also format text/plain documents that parse as JSON. */
export function forceJsonViewer(): void {
  (window as { __devkitJsonViewerForce?: boolean }).__devkitJsonViewerForce = true;
}

/** What the viewer did on this page: its state (`tree`, `raw`, `invalid`, `large`) or null, and the content type. */
export function jsonViewerState(hostId: string): { state: string | null; contentType: string } {
  return { state: document.getElementById(hostId)?.dataset.state ?? null, contentType: document.contentType };
}
