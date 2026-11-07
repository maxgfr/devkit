import { browser } from "wxt/browser";
import { actionContext, findAction, NO_CACHE_RULE_BASE } from "../lib/actions";
import { loadEnvs, matchEnv, showRibbon } from "../lib/envs";
import { hasPermission } from "../lib/permissions";
import { PENDING_ROUTE_KEY, type Route } from "../lib/panels";

const MENU = {
  page: "devkit-ask-page",
  selection: "devkit-ask-selection",
  jsonld: "devkit-jsonld",
  headers: "devkit-headers",
  element: "devkit-pick-element",
} as const;

function createMenus() {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({ id: MENU.selection, title: "Explain / review with devkit AI", contexts: ["selection"] });
    browser.contextMenus.create({ id: MENU.page, title: "Summarize this page with devkit AI", contexts: ["page"] });
    browser.contextMenus.create({ id: MENU.jsonld, title: "Inspect structured data (JSON-LD)", contexts: ["page"] });
    browser.contextMenus.create({ id: MENU.headers, title: "Inspect headers & security", contexts: ["page"] });
    browser.contextMenus.create({ id: MENU.element, title: "Pick an element for a coding agent", contexts: ["page", "link", "image"] });
  });
}

/** Opens the side panel on `route`. Must run synchronously inside the user gesture that triggered it. */
function openPanel(windowId: number, route: Route) {
  browser.sidePanel.open({ windowId }).catch(() => undefined);
  browser.storage.session.set({ [PENDING_ROUTE_KEY]: route });
}

const errorCounts = new Map<number, number>();
const envBadges = new Map<number, boolean>();

function refreshBadge(tabId: number) {
  if (envBadges.get(tabId)) return;
  const n = errorCounts.get(tabId) ?? 0;
  browser.action.setBadgeBackgroundColor({ tabId, color: "#b91c1c" }).catch(() => undefined);
  browser.action.setBadgeText({ tabId, text: n ? (n > 99 ? "99+" : String(n)) : "" }).catch(() => undefined);
}

async function markEnv(tabId: number, url: string | undefined) {
  const match = matchEnv(await loadEnvs(), url);
  if (!match?.env.danger) {
    if (envBadges.delete(tabId)) refreshBadge(tabId);
    return;
  }
  envBadges.set(tabId, true);
  browser.action.setBadgeBackgroundColor({ tabId, color: match.env.color }).catch(() => undefined);
  browser.action.setBadgeText({ tabId, text: match.env.label.slice(0, 4).toUpperCase() }).catch(() => undefined);
  browser.scripting
    .executeScript({ target: { tabId }, func: showRibbon, args: [`${match.group.name} · ${match.env.label}`, match.env.color] })
    .catch(() => undefined);
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    createMenus();
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  });
  browser.runtime.onStartup.addListener(createMenus);

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.windowId) return;
    if (info.menuItemId === MENU.selection)
      openPanel(tab.windowId, {
        panel: "ask",
        params: { action: "review-selection", selection: info.selectionText ?? "", at: String(Date.now()) },
      });
    else if (info.menuItemId === MENU.page)
      openPanel(tab.windowId, { panel: "ask", params: { action: "summarize", at: String(Date.now()) } });
    else if (info.menuItemId === MENU.jsonld) openPanel(tab.windowId, { panel: "jsonld" });
    else if (info.menuItemId === MENU.headers) openPanel(tab.windowId, { panel: "headers" });
    else if (info.menuItemId === MENU.element) openPanel(tab.windowId, { panel: "element", params: { pick: "1", at: String(Date.now()) } });
  });

  browser.commands.onCommand.addListener(async (command, tab) => {
    if (!tab?.id) return;
    if (command === "open-side-panel") return openPanel(tab.windowId, { panel: "cache-actions" });
    const action = findAction(command);
    const ctx = actionContext(tab);
    if (!action || !ctx) return;
    const need = ctx.origin ? action.needs?.(ctx) : undefined;
    if ((action.needsPage && !ctx.origin) || (need && !(await hasPermission(need)))) {
      // Permissions can only be asked from a page: send the user to the panel where the button asks.
      return openPanel(tab.windowId, { panel: "cache-actions" });
    }
    try {
      await action.run(ctx);
    } catch {
      openPanel(tab.windowId, { panel: "cache-actions" });
    }
  });

  browser.runtime.onMessage.addListener((message: { type?: string; count?: number }, sender) => {
    if (message?.type === "devkit:errors" && sender.tab?.id !== undefined) {
      errorCounts.set(sender.tab.id, message.count ?? 0);
      refreshBadge(sender.tab.id);
    }
  });

  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "loading" && info.url) {
      errorCounts.delete(tabId);
      refreshBadge(tabId);
    }
    if (info.status === "complete") markEnv(tabId, tab.url);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    errorCounts.delete(tabId);
    envBadges.delete(tabId);
    browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [NO_CACHE_RULE_BASE + tabId] }).catch(() => undefined);
  });
});
