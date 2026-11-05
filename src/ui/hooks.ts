import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { ALL_SITES } from "../lib/permissions";
import { activeTab, isScriptable, originOf, originPattern, type Tab } from "../lib/tab";

/** The active tab of this window, kept up to date as the user switches and navigates. */
/** Tab id the page is pinned to (`?tab=123`, used by the popped-out panel), or null to follow the active tab. */
export const pinnedTabId = (): number | null => {
  const id = Number(new URLSearchParams(location.search).get("tab"));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function useActiveTab(): { tab: Tab | undefined; refresh: () => void } {
  const [tab, setTab] = useState<Tab | undefined>();
  const refresh = useCallback(() => {
    const pinned = pinnedTabId();
    (pinned ? browser.tabs.get(pinned) : activeTab()).then(setTab, () => setTab(undefined));
  }, []);
  useEffect(() => {
    refresh();
    const onActivated = () => refresh();
    const onUpdated = (_id: number, info: { status?: string; url?: string; title?: string }) => {
      if (info.status === "complete" || info.url || info.title) refresh();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.windows.onFocusChanged.addListener(onActivated);
    browser.permissions.onAdded.addListener(onActivated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.windows.onFocusChanged.removeListener(onActivated);
      browser.permissions.onAdded.removeListener(onActivated);
    };
  }, [refresh]);
  return { tab, refresh };
}

export type Access = "none" | "site" | "all" | "unscriptable" | "unknown";

/** Whether devkit may script the page in `tab`, and how to ask for it. */
export function useAccess(tab: Tab | undefined) {
  const [access, setAccess] = useState<Access>("unknown");
  const origin = originOf(tab?.url);
  const check = useCallback(async () => {
    if (await browser.permissions.contains({ origins: [ALL_SITES] })) return setAccess("all");
    if (!tab?.url) return setAccess("none");
    if (!isScriptable(tab.url)) return setAccess("unscriptable");
    const o = originOf(tab.url);
    setAccess(o && (await browser.permissions.contains({ origins: [originPattern(o)] })) ? "site" : "none");
  }, [tab?.url]);
  useEffect(() => {
    check();
    browser.permissions.onAdded.addListener(check);
    browser.permissions.onRemoved.addListener(check);
    return () => {
      browser.permissions.onAdded.removeListener(check);
      browser.permissions.onRemoved.removeListener(check);
    };
  }, [check]);
  const request = useCallback(
    async (scope: "site" | "all") => {
      const origins = scope === "all" || !origin ? [ALL_SITES] : [originPattern(origin)];
      const ok = await browser.permissions.request({ origins });
      await check();
      return ok;
    },
    [origin, check],
  );
  return { access, request, origin };
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  run: () => Promise<void>;
  set: (value: T | undefined) => void;
}

/** Runs `fn` on demand (and on mount when `auto`), keeping the last result. Re-runs when `deps` change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], auto = true): AsyncState<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const value = await fnRef.current();
      if (id === seq.current) setData(value);
    } catch (e) {
      if (id === seq.current) {
        setError(e);
        setData(undefined);
      }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);
  useEffect(
    () => {
      if (auto) run();
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
    deps,
  );
  return { data, error, loading, run, set: setData };
}

/** A value in chrome.storage.local, shared live across devkit pages. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => Promise<void>, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial is a default only
  useEffect(() => {
    browser.storage.local.get(key).then((r) => {
      if (r[key] !== undefined) setValue(r[key] as T);
      setReady(true);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && key in changes) setValue((changes[key]!.newValue as T) ?? initial);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [key]);
  const save = useCallback(
    async (next: T) => {
      setValue(next);
      await browser.storage.local.set({ [key]: next });
    },
    [key],
  );
  return [value, save, ready];
}
