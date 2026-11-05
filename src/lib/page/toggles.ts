// Functions injected into the page with `runInTab`: each must stand alone (no outer scope).

export function toggleDesignMode(): string {
  document.designMode = document.designMode === "on" ? "off" : "on";
  return document.designMode === "on" ? "Design mode on: click any text to edit it." : "Design mode off.";
}

export function toggleOutline(): string {
  const id = "devkit-outline";
  const existing = document.getElementById(id);
  if (existing) {
    existing.remove();
    return "Outlines off.";
  }
  const style = document.createElement("style");
  style.id = id;
  style.textContent = "*{outline:1px solid rgba(255,0,128,.45)!important;outline-offset:-1px!important}";
  document.documentElement.append(style);
  return "Outlines on.";
}

export function toggleCss(): string {
  const root = document.documentElement;
  const off = root.dataset.devkitCssOff !== "1";
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as HTMLElement | null;
    if (owner?.id === "devkit-outline") continue;
    sheet.disabled = off;
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[style]"))) {
    if (off) {
      el.dataset.devkitStyle = el.getAttribute("style") ?? "";
      el.removeAttribute("style");
    }
  }
  if (!off) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-devkit-style]"))) {
      el.setAttribute("style", el.dataset.devkitStyle ?? "");
      delete el.dataset.devkitStyle;
    }
  }
  root.dataset.devkitCssOff = off ? "1" : "0";
  return off ? "CSS disabled." : "CSS restored.";
}

export function clearWebStorage(): string {
  const local = localStorage.length;
  const session = sessionStorage.length;
  localStorage.clear();
  sessionStorage.clear();
  return `Cleared ${local} localStorage and ${session} sessionStorage keys.`;
}

export async function unregisterServiceWorkers(): Promise<number> {
  if (!("serviceWorker" in navigator)) return 0;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  return registrations.length;
}

export function viewportDelta(): { dw: number; dh: number; w: number; h: number } {
  return {
    dw: window.outerWidth - window.innerWidth,
    dh: window.outerHeight - window.innerHeight,
    w: window.innerWidth,
    h: window.innerHeight,
  };
}
