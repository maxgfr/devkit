import { browser } from "wxt/browser";
import { quickReport } from "./bug-report-gather";
import { readCookies } from "./cookie-jar";
import { toNetscape } from "./cookies-export";
import { runInTab } from "./inject";
import { DATA_VIEWER_FILE, dataViewerMessage } from "./data-viewer";
import { JSON_VIEWER_HOST_ID } from "./json-viewer";
import { forceJsonViewer, jsonViewerState } from "./page/json-viewer";
import { PENDING_ROUTE_KEY } from "./panels";
import { clearWebStorage, toggleCss, toggleDesignMode, toggleOutline, unregisterServiceWorkers } from "./page/toggles";
import { ALL_SITES, type PermissionNeed } from "./permissions";
import { formatBytes } from "./storage-usage";
import { originOf, originPattern, type Tab } from "./tab";

export type Category = "cache" | "inspect" | "security" | "page" | "network" | "ai" | "utils";

export const CATEGORIES: Record<Category, string> = {
  cache: "Cache & storage",
  inspect: "Inspect",
  security: "Security",
  page: "Page",
  network: "Network",
  ai: "AI",
  utils: "Utilities",
};

export interface ActionContext {
  tab: Tab;
  tabId: number;
  url: string;
  origin: string;
}

export interface ActionResult {
  message: string;
  /** Text the caller should put on the clipboard, when it can. */
  copy?: string;
}

export interface ActionDef {
  id: string;
  title: string;
  description: string;
  category: Category;
  keywords?: string;
  /** Needs a web page (http/https) as the active tab. */
  needsPage: boolean;
  /** Injects a script: needs host access to the page. */
  scripts?: boolean;
  needs?: (ctx: ActionContext) => PermissionNeed;
  run: (ctx: ActionContext) => Promise<ActionResult>;
}

/** Every kind of site data "Fresh start" removes (the Consent check clears the same). */
export const ALL_DATA = {
  cache: true,
  cacheStorage: true,
  cookies: true,
  fileSystems: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true,
} as const;

async function removeSiteData(origin: string, types: Partial<Record<keyof typeof ALL_DATA, boolean>>) {
  await browser.browsingData.remove({ origins: [origin] }, types);
}

export const NO_CACHE_RULE_BASE = 900_000;

export async function isNoCacheOn(tabId: number): Promise<boolean> {
  const rules = await browser.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.id === NO_CACHE_RULE_BASE + tabId);
}

export const ACTIONS: ActionDef[] = [
  {
    id: "hard-reload",
    title: "Hard reload",
    description: "Reload the page, bypassing the HTTP cache",
    category: "cache",
    keywords: "refresh bypass cache f5",
    needsPage: false,
    run: async ({ tabId }) => {
      await browser.tabs.reload(tabId, { bypassCache: true });
      return { message: "Reloaded without cache." };
    },
  },
  {
    id: "clear-cache",
    title: "Clear this site's cache",
    description: "HTTP cache and Cache Storage of this origin, then reload",
    category: "cache",
    keywords: "empty cache purge",
    needsPage: true,
    needs: () => ({ permissions: ["browsingData"] }),
    run: async ({ tabId, origin }) => {
      await removeSiteData(origin, { cache: true, cacheStorage: true });
      await browser.tabs.reload(tabId, { bypassCache: true });
      return { message: `Cache cleared for ${origin}.` };
    },
  },
  {
    id: "fresh-start",
    title: "Fresh start",
    description: "Clear every kind of site data for this origin, then hard reload",
    category: "cache",
    keywords: "nuke reset clear all site data cookies storage",
    needsPage: true,
    scripts: true,
    needs: () => ({ permissions: ["browsingData"] }),
    run: async ({ tabId, origin }) => {
      await runInTab(tabId, clearWebStorage).catch(() => undefined);
      await removeSiteData(origin, ALL_DATA);
      await browser.tabs.reload(tabId, { bypassCache: true });
      return { message: `All site data cleared for ${origin}.` };
    },
  },
  {
    id: "clear-cookies",
    title: "Clear cookies",
    description: "Cookies of this site (Chrome removes them for the whole registrable domain)",
    category: "cache",
    keywords: "delete cookies session logout",
    needsPage: true,
    needs: () => ({ permissions: ["browsingData"] }),
    run: async ({ origin }) => {
      await removeSiteData(origin, { cookies: true });
      return { message: `Cookies cleared for ${origin}.` };
    },
  },
  {
    id: "copy-cookies-txt",
    title: "Copy cookies.txt",
    description: "This site's cookies in Netscape format, for curl, wget or yt-dlp",
    category: "cache",
    keywords: "cookies.txt netscape curl yt-dlp wget export cookie jar",
    needsPage: true,
    // Chrome only lists the cookies of hosts devkit can access: ask for this site like the cookie editor.
    scripts: true,
    needs: () => ({ permissions: ["cookies"] }),
    run: async ({ url }) => {
      const cookies = await readCookies({ url });
      if (!cookies.length) return { message: "No cookie for this page." };
      return {
        message: `cookies.txt copied (${cookies.length} cookie${cookies.length > 1 ? "s" : ""}). It holds session tokens: keep it private.`,
        copy: toNetscape(cookies),
      };
    },
  },
  {
    id: "clear-storage",
    title: "Clear local & session storage",
    description: "localStorage and sessionStorage of this page",
    category: "cache",
    keywords: "localstorage sessionstorage web storage",
    needsPage: true,
    scripts: true,
    run: async ({ tabId }) => ({ message: await runInTab(tabId, clearWebStorage) }),
  },
  {
    id: "unregister-sw",
    title: "Unregister service workers",
    description: "Every service worker of this origin",
    category: "cache",
    keywords: "sw pwa worker offline",
    needsPage: true,
    scripts: true,
    run: async ({ tabId }) => {
      const count = await runInTab(tabId, unregisterServiceWorkers);
      return { message: count ? `Unregistered ${count} service worker${count > 1 ? "s" : ""}.` : "No service worker registered." };
    },
  },
  {
    id: "toggle-no-cache",
    title: "Toggle no-cache for this tab",
    description: "Send Cache-Control: no-cache on every request of this tab",
    category: "cache",
    keywords: "disable cache headers",
    needsPage: false,
    needs: () => ({ origins: [ALL_SITES] }),
    run: async ({ tabId }) => {
      const id = NO_CACHE_RULE_BASE + tabId;
      if (await isNoCacheOn(tabId)) {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
        return { message: "No-cache off for this tab." };
      }
      await browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "cache-control", operation: "set", value: "no-cache" },
                { header: "pragma", operation: "set", value: "no-cache" },
              ],
            },
            condition: { tabIds: [tabId] },
          },
        ],
      } as never);
      return { message: "No-cache on for this tab (until the browser restarts)." };
    },
  },
  {
    id: "toggle-design-mode",
    title: "Toggle design mode",
    description: "Make every text on the page editable",
    category: "page",
    keywords: "edit contenteditable designmode",
    needsPage: true,
    scripts: true,
    run: async ({ tabId }) => ({ message: await runInTab(tabId, toggleDesignMode) }),
  },
  {
    id: "toggle-outline",
    title: "Toggle element outlines",
    description: "Outline every element to debug layout",
    category: "page",
    keywords: "border debug layout css",
    needsPage: true,
    scripts: true,
    run: async ({ tabId }) => ({ message: await runInTab(tabId, toggleOutline) }),
  },
  {
    id: "toggle-css",
    title: "Toggle CSS",
    description: "Disable or restore every stylesheet and inline style",
    category: "page",
    keywords: "styles disable unstyled",
    needsPage: true,
    scripts: true,
    run: async ({ tabId }) => ({ message: await runInTab(tabId, toggleCss) }),
  },
  {
    id: "toggle-js",
    title: "Toggle JavaScript for this site",
    description: "Block or allow JavaScript on this origin, then reload",
    category: "page",
    keywords: "disable javascript noscript",
    needsPage: true,
    needs: () => ({ permissions: ["contentSettings"] }),
    run: async ({ tabId, url, origin }) => {
      const { setting } = await browser.contentSettings.javascript.get({ primaryUrl: url });
      const next = setting === "block" ? "allow" : "block";
      await browser.contentSettings.javascript.set({ primaryPattern: originPattern(origin), setting: next });
      await browser.tabs.reload(tabId);
      return { message: next === "block" ? `JavaScript blocked on ${origin}.` : `JavaScript allowed on ${origin}.` };
    },
  },
  {
    id: "pick-element",
    title: "Pick an element",
    description: "Click an element of the page, copy its component, source and styles for a coding agent",
    category: "page",
    keywords: "inspect select element react component props source file line selector agent claude cursor",
    needsPage: true,
    run: async ({ tab }) => {
      // Opening the side panel needs the user gesture: call it before anything is awaited.
      browser.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
      await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "element", params: { pick: "1", at: String(Date.now()) } } });
      return { message: "Click an element in the page (Esc cancels)." };
    },
  },
  {
    id: "copy-bug-report",
    title: "Copy a bug report",
    description: "Steps, console errors, failed requests and environment as Markdown for a coding agent",
    category: "ai",
    keywords: "bug report issue repro reproduce steps jam ticket agent claude cursor playwright failed requests errors clipboard",
    needsPage: true,
    scripts: true,
    run: async ({ tab }) => {
      const { markdown, redacted } = await quickReport(tab);
      const size = formatBytes(new Blob([markdown]).size);
      return {
        message: `Bug report copied (${size}${redacted ? `, ${redacted} value${redacted > 1 ? "s" : ""} redacted` : ""}).`,
        copy: markdown,
      };
    },
  },
  {
    id: "measure-distances",
    title: "Measure distances",
    description: "Hover for the box model, click two elements for the gap between them, drag for an area",
    category: "page",
    keywords: "ruler spacing distance gap padding margin box model px pixel dimensions",
    needsPage: true,
    run: async ({ tab }) => {
      browser.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
      await browser.storage.session.set({ [PENDING_ROUTE_KEY]: { panel: "measure", params: { start: "1", at: String(Date.now()) } } });
      return { message: "Hover the page to measure (Esc exits)." };
    },
  },
  {
    id: "format-json",
    // The id keeps its JSON name: the action now formats every data format.
    title: "Format this data page",
    description:
      "JSON, XML / RSS / Atom, CSV / TSV, YAML or JSON Lines in this tab: collapsible tree or sortable table, filter, copy and download",
    category: "utils",
    keywords:
      "json formatter pretty viewer beautify api response tree xml rss atom feed csv tsv table yaml yml jsonl ndjson json lines data",
    needsPage: true,
    // No `scripts`: the palette's activeTab grant is enough, no site access is asked.
    run: async ({ tabId }) => {
      await runInTab(tabId, forceJsonViewer);
      await browser.scripting.executeScript({ target: { tabId }, files: [`/${DATA_VIEWER_FILE}` as const] });
      const { state, format, contentType } = await runInTab(tabId, jsonViewerState, [JSON_VIEWER_HOST_ID]);
      return { message: dataViewerMessage(state, format, contentType) };
    },
  },
  {
    id: "copy-markdown-link",
    title: "Copy as Markdown link",
    description: "[Page title](url) on the clipboard",
    category: "utils",
    keywords: "markdown link url title",
    needsPage: false,
    run: async ({ tab, url }) => {
      const text = `[${(tab.title ?? url).replace(/([[\]])/g, "\\$1")}](${url})`;
      return { message: "Markdown link copied.", copy: text };
    },
  },
];

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function actionContext(tab: Tab): ActionContext | null {
  if (tab.id === undefined) return null;
  const url = tab.url ?? "";
  return { tab, tabId: tab.id, url, origin: originOf(url) ?? "" };
}

/** What stops `action` from running on `ctx`, or null. Permissions are checked separately. */
export function actionBlocker(action: ActionDef, ctx: ActionContext | null): string | null {
  if (!ctx) return "No active tab.";
  if (action.needsPage && !ctx.origin)
    return ctx.url ? "Only works on web pages (http/https)." : "devkit cannot see this tab's address: grant access to this site.";
  return null;
}
