// Functions injected into the page with `runInTab` around the data viewer script: each must stand alone.

/** Lets the next injection of the viewer also format text/plain documents that sniff as JSON, JSON Lines or XML. */
export function forceJsonViewer(): void {
  (window as { __devkitJsonViewerForce?: boolean }).__devkitJsonViewerForce = true;
}

/** What the viewer did on this page: its state (`tree`, `raw`, `invalid`, `unsupported`, `large`) or null, its format, and the content type. */
export function jsonViewerState(hostId: string): { state: string | null; format: string | null; contentType: string } {
  const host = document.getElementById(hostId);
  return { state: host?.dataset.state ?? null, format: host?.dataset.format ?? null, contentType: document.contentType };
}
