import { createContext, type ReactNode, useCallback, useContext } from "react";
import { type ActionDef, actionBlocker, actionContext } from "../lib/actions";
import { injectionError, runInTab, type World } from "../lib/inject";
import { ensurePermission } from "../lib/permissions";
import { isScriptable, originOf, type Tab } from "../lib/tab";
import { Button, copyText, Notice, useToast } from "./components";
import { type Access, type AsyncState, useAccess, useActiveTab, useAsync } from "./hooks";

export interface PageCtx {
  tab: Tab | undefined;
  tabId: number | undefined;
  url: string;
  origin: string | null;
  access: Access;
  canScript: boolean;
  requestAccess: (scope: "site" | "all") => Promise<boolean>;
  refresh: () => void;
}

const Ctx = createContext<PageCtx | null>(null);

export function PageProvider({ children }: { children: ReactNode }) {
  const { tab, refresh } = useActiveTab();
  const { access, request } = useAccess(tab);
  const url = tab?.url ?? "";
  const value: PageCtx = {
    tab,
    tabId: tab?.id,
    url,
    origin: originOf(url),
    access,
    canScript: (access === "all" || access === "site") && isScriptable(url),
    requestAccess: request,
    refresh,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePage(): PageCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePage outside PageProvider");
  return ctx;
}

/** Runs `func` in the current page, again whenever the tab, its URL or devkit's access change. */
export function useInPage<Args extends unknown[], R>(
  func: (...args: Args) => R | Promise<R>,
  args: Args = [] as unknown as Args,
  world: World = "ISOLATED",
  auto = true,
): AsyncState<Awaited<R>> {
  const page = usePage();
  return useAsync<Awaited<R>>(
    async (): Promise<Awaited<R>> => {
      if (page.tabId === undefined) throw new Error("No active tab.");
      if (!page.canScript)
        throw new Error(
          page.access === "unscriptable" ? "Chrome does not let extensions run on this page." : "devkit has no access to this page yet.",
        );
      try {
        return (await runInTab(page.tabId, func, args, world)) as Awaited<R>;
      } catch (e) {
        throw new Error(injectionError(e));
      }
    },
    [page.tabId, page.url, page.canScript, auto, JSON.stringify(args)],
    auto,
  );
}

/** Banner shown by panels that need to script the page. Renders nothing once access is granted. */
export function AccessGate({ children }: { children?: ReactNode }) {
  const page = usePage();
  if (page.canScript) return <>{children}</>;
  if (page.access === "unscriptable" || (page.url && !page.origin))
    return (
      <Notice kind="warn">
        Chrome does not let extensions run on this page ({page.url.split("/")[0] || "internal page"}). Open a web page to use this tool.
      </Notice>
    );
  return (
    <Notice kind="warn">
      <span className="grow">devkit needs access to {page.origin ? <b>{new URL(page.origin).host}</b> : "this tab"} to read the page.</span>
      {page.origin ? <Button onClick={() => page.requestAccess("site")}>Allow on this site</Button> : null}
      <Button variant="primary" onClick={() => page.requestAccess("all")}>
        Allow on all sites
      </Button>
    </Notice>
  );
}

/** Runs a registered action on the current tab: asks for its permission first, then toasts the result. */
export function useRunAction() {
  const page = usePage();
  const toast = useToast();
  return useCallback(
    async (action: ActionDef) => {
      const ctx = page.tab ? actionContext(page.tab) : null;
      const blocker = actionBlocker(action, ctx);
      if (blocker || !ctx) return toast(blocker ?? "No active tab.", true);
      const need = action.needs?.(ctx);
      if (need && !(await ensurePermission(need))) return toast("Permission refused: devkit cannot do that without it.", true);
      if (action.scripts && !page.canScript && !(await page.requestAccess("site"))) return toast("devkit needs access to this site.", true);
      try {
        const result = await action.run(ctx);
        if (result.copy) await copyText(result.copy);
        toast(result.message);
      } catch (e) {
        toast(injectionError(e), true);
      }
    },
    [page, toast],
  );
}
