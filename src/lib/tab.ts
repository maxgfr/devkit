import { browser, type Browser } from "wxt/browser";

export type Tab = Browser.tabs.Tab;

/** The tab the user is looking at, in the window of the calling page. */
export async function activeTab(): Promise<Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** `https://example.com` for a web page, `null` for chrome://, the Web Store, file:// and friends. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

const BLOCKED_HOSTS = ["chrome.google.com", "chromewebstore.google.com"];

/** Whether Chrome lets an extension run scripts in this URL at all. */
export function isScriptable(url: string | undefined): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return !BLOCKED_HOSTS.includes(host);
}

/** Match pattern covering every page of an origin: `https://example.com/*`. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}
