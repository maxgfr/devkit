import { Suspense, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { CATEGORIES, type Category } from "../lib/actions";
import { PANEL_IDS, PANELS, PENDING_ROUTE_KEY, type Route } from "../lib/panels";
import { ToastProvider } from "./components";
import { pinnedTabId } from "./hooks";
import { PageProvider, usePage } from "./page";
import { PANEL_COMPONENTS } from "./panels";

const SHORT: Record<Category, string> = { cache: "Cache", inspect: "Inspect", page: "Page", network: "Network", ai: "AI", utils: "Utils" };
const DEFAULT_PANEL: Record<Category, string> = {
  cache: "cache-actions",
  inspect: "overview",
  page: "page-tools",
  network: "rules",
  ai: "ask",
  utils: "json",
};
const LAST_KEY = "lastRoute";

function TabLine() {
  const page = usePage();
  const host = page.origin ? new URL(page.origin).host : page.tab?.title || "No page";
  return (
    <div className="tabline">
      {page.tab?.favIconUrl ? <img src={page.tab.favIconUrl} alt="" /> : <img src="/icon/16.png" alt="" />}
      <span className="host" title={page.url}>
        {host}
      </span>
      {page.access === "site" ? <span className="pill">site access</span> : null}
      {pinnedTabId() ? (
        <span className="pill accent" title="This window follows one tab">
          pinned
        </span>
      ) : page.tabId !== undefined ? (
        <button
          type="button"
          className="btn small ghost"
          title="Open devkit in its own window, attached to this tab"
          onClick={() => browser.windows.create({ url: `/sidepanel.html?tab=${page.tabId}`, type: "popup", width: 460, height: 860 })}
        >
          Pop out
        </button>
      ) : null}
    </div>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>({ panel: "cache-actions" });
  const [category, setCategory] = useState<Category>("cache");
  const go = (r: Route) => {
    if (!PANEL_IDS.has(r.panel)) return;
    setRoute(r);
    setCategory(PANELS.find((p) => p.id === r.panel)!.category);
    browser.storage.local.set({ [LAST_KEY]: { panel: r.panel } });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useEffect(() => {
    const takePending = async () => {
      const { [PENDING_ROUTE_KEY]: pending } = await browser.storage.session.get(PENDING_ROUTE_KEY);
      if (pending) {
        await browser.storage.session.remove(PENDING_ROUTE_KEY);
        go(pending as Route);
        return true;
      }
      return false;
    };
    takePending().then(async (took) => {
      if (took) return;
      const { [LAST_KEY]: last } = await browser.storage.local.get(LAST_KEY);
      if (last) go(last as Route);
    });
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "session" && PENDING_ROUTE_KEY in changes) takePending();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  const panels = PANELS.filter((p) => p.category === category);
  const Panel = PANEL_COMPONENTS[route.panel];
  return (
    <div className="app">
      <div className="topbar">
        <TabLine />
        <div className="tabbar" role="tablist">
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === category}
              onClick={() =>
                go({ panel: route.panel && PANELS.find((p) => p.id === route.panel)?.category === c ? route.panel : DEFAULT_PANEL[c] })
              }
              title={CATEGORIES[c]}
            >
              {SHORT[c]}
            </button>
          ))}
        </div>
      </div>
      <nav className="subnav" aria-label={CATEGORIES[category]}>
        {panels.map((p) => (
          <button key={p.id} type="button" aria-pressed={p.id === route.panel} onClick={() => go({ panel: p.id })} title={p.description}>
            {p.title}
          </button>
        ))}
      </nav>
      <main className="content">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          {Panel ? <Panel key={route.panel + JSON.stringify(route.params ?? {})} params={route.params} /> : null}
        </Suspense>
      </main>
    </div>
  );
}

export function SidePanelApp() {
  return (
    <ToastProvider>
      <PageProvider>
        <Shell />
      </PageProvider>
    </ToastProvider>
  );
}
