import { browser } from "wxt/browser";
import { runInTab } from "./inject";
import { clearWebStorage, toggleCss, toggleDesignMode, toggleOutline, unregisterServiceWorkers } from "./page/toggles";
import { ALL_SITES, type PermissionNeed } from "./permissions";
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

const ALL_DATA = {
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
