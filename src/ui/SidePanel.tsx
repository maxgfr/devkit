import { Suspense, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { CATEGORIES, type Category } from "../lib/actions";
import { PANEL_IDS, PANELS, PENDING_ROUTE_KEY, type Route } from "../lib/panels";
import { PanelBoundary, ToastProvider } from "./components";
import { pinnedTabId } from "./hooks";
import { NavContext } from "./nav";
import { PageProvider, usePage } from "./page";
import { PANEL_COMPONENTS } from "./panels";
import { MocksBadge } from "./panels/mocks";

const SHORT: Record<Category, string> = {
  cache: "Cache",
  inspect: "Inspect",
  security: "Security",
  page: "Page",
  network: "Network",
  ai: "AI",
  utils: "Utils",
};
const DEFAULT_PANEL: Record<Category, string> = {
  cache: "cache-actions",
  inspect: "overview",
  security: "headers",
  page: "element",
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

const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];

function Shell() {
  const [route, setRoute] = useState<Route>({ panel: "cache-actions" });
  const [category, setCategory] = useState<Category>("cache");
  // The view each tab showed last in this session, so coming back to a tab lands where you left it.
  const lastOf = useRef<Partial<Record<Category, string>>>({});
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const go = (r: Route) => {
    if (!PANEL_IDS.has(r.panel)) return;
    const c = PANELS.find((p) => p.id === r.panel)!.category;
    lastOf.current[c] = r.panel;
    setRoute(r);
    setCategory(c);
    browser.storage.local.set({ [LAST_KEY]: { panel: r.panel } });
  };
  const openCategory = (c: Category) => go({ panel: lastOf.current[c] ?? DEFAULT_PANEL[c] });
  // Tab bar keyboard model (WAI-ARIA tabs): arrows, Home and End move between tabs and open them.
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = CATEGORY_KEYS.indexOf(category);
    const n = CATEGORY_KEYS.length;
    const next =
      e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    openCategory(CATEGORY_KEYS[next]!);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
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
        <div className="tabbar" role="tablist" aria-label="Tools" ref={tabsRef} onKeyDown={onTabKey}>
          {CATEGORY_KEYS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              id={`tab-${c}`}
              aria-selected={c === category}
              aria-controls="panel-content"
              tabIndex={c === category ? 0 : -1}
              onClick={() => openCategory(c)}
              title={CATEGORIES[c]}
            >
              {SHORT[c]}
            </button>
          ))}
        </div>
      </div>
      <div className="view" id="panel-content" role="tabpanel" aria-labelledby={`tab-${category}`}>
        <nav className="subnav" aria-label={CATEGORIES[category]}>
          {panels.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === route.panel}
              onClick={() => go({ panel: p.id })}
              title={`${p.title} · ${p.description}`}
            >
              {p.short ?? p.title}
              {p.id === "mocks" ? <MocksBadge /> : null}
            </button>
          ))}
        </nav>
        <main className="content">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            {Panel ? (
              <PanelBoundary key={route.panel + JSON.stringify(route.params ?? {})}>
                <NavContext.Provider value={go}>
                  <Panel params={route.params} />
                </NavContext.Provider>
              </PanelBoundary>
            ) : null}
          </Suspense>
        </main>
      </div>
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
