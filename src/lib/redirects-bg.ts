// Background half of the Redirect path panel. Once the user grants webRequest, webNavigation and site access,
// it watches top-level navigations (read-only, nothing is changed or sent anywhere), keeps the last chains of
// each tab in storage.session, and traces a URL on request. A small content script reports each page's meta
// refresh, to tell a meta refresh from a JavaScript redirect. Listeners attach at the service worker's start when
// the permissions are already held (Chrome only wakes a worker for listeners added in its first run), and as
// soon as they are granted.
import { browser } from "wxt/browser";
import {
  type Chain,
  findMetaRefresh,
  joinClient,
  MAX_REDIRECTS,
  META_REFRESH_SEEN,
  parseRefresh,
  type Recording,
  type RedirectKind,
  recordComplete,
  recordError,
  recordHeaders,
  recordRedirect,
  REDIRECT_TRACE,
  REDIRECTS_KEY,
  type RedirectStore,
  redirectCount,
  sameDocument,
  startRecording,
  type TraceAnswer,
  type TraceMessage,
} from "./redirects";

const PER_TAB = 5;
const MAX_TABS = 20;
const EXTRA = ["responseHeaders"] as never;

type Api = { webRequest?: typeof browser.webRequest; webNavigation?: typeof browser.webNavigation };
const api = () => browser as unknown as Api;
/** The APIs exist only while their optional permissions are granted. */
export const redirectApisAvailable = () => Boolean(api().webRequest?.onBeforeRedirect && api().webNavigation?.onCommitted);

/* Storage: the last chains of each tab, newest first, bounded. Writes are queued so events never race. */
let queue: Promise<unknown> = Promise.resolve();
function update(fn: (store: RedirectStore) => void): Promise<void> {
  const run = queue.then(async () => {
    const store = ((await browser.storage.session.get(REDIRECTS_KEY))[REDIRECTS_KEY] ?? {}) as RedirectStore;
    fn(store);
    const tabs = Object.keys(store);
    // Oldest tabs out first: keys keep insertion order, and each write moves the tab to the end.
    for (const tab of tabs.slice(0, Math.max(0, tabs.length - MAX_TABS))) delete store[tab];
    await browser.storage.session.set({ [REDIRECTS_KEY]: store });
  });
  queue = run.catch(() => undefined);
  return run;
}

function saveTabChain(tabId: number, chain: Chain) {
  return update((store) => {
    const list = store[tabId] ?? [];
    delete store[tabId];
    store[tabId] = [chain, ...list].slice(0, PER_TAB);
  }).then(() => settle(tabId));
}

/* Client redirects: webNavigation says a document came from one; the previous document says how. */
/** Commits not matched to a chain yet. A client one waits (`ready`) until the previous document's probe answers. */
const commits = new Map<number, { url: string; client: boolean; ready: boolean }[]>();
/** Per tab, the URL of the document committed last. */
const documents = new Map<number, string>();
/** Per tab, the meta refresh read from recent documents (null: read, none found). */
const metaSeen = new Map<number, Map<string, string | null>>();

function noteMeta(tabId: number, url: string, content: string | null) {
  const key = url.split("#")[0]!;
  const seen = metaSeen.get(tabId) ?? new Map<string, string | null>();
  seen.delete(key);
  seen.set(key, content);
  while (seen.size > 10) seen.delete(seen.keys().next().value!);
  metaSeen.set(tabId, seen);
}

/** Resolves once the probe of `url` answered in `tabId`, or after `ms`. */
function probed(tabId: number, url: string | undefined, ms: number): Promise<void> {
  const key = url?.split("#")[0];
  const until = Date.now() + ms;
  return new Promise((done) => {
    const poll = () => (!key || metaSeen.get(tabId)?.has(key) || Date.now() > until ? done() : setTimeout(poll, 40));
    poll();
  });
}

function kindFor(tabId: number, prev: Chain): RedirectKind {
  const last = prev.hops.at(-1);
  if (!last) return "client";
  const seen = metaSeen.get(tabId)?.get(last.url.split("#")[0]!);
  if (seen) return "meta";
  if (last.headers.refresh) return "refresh";
  // The page was read and had no meta refresh: a script moved it on. Heuristic, labeled as such in the UI.
  return seen === null ? "js" : "client";
}

/**
 * Marks the tab's chains committed as their commits come in (a commit and the chain's last request event arrive
 * in either order), joining a chain to the previous document's after a client redirect.
 */
function settle(tabId: number) {
  if (!commits.get(tabId)?.length) return Promise.resolve();
  return update((store) => {
    // Read inside the queue, so each commit is used once.
    const pending = commits.get(tabId) ?? [];
    const list = store[tabId];
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const chain = list[i]!;
      const end = chain.hops.at(-1);
      if (chain.committed || !end) continue;
      const at = pending.findIndex((c) => sameDocument(c.url, end.url));
      if (at === -1) continue;
      if (!pending[at]!.ready) break;
      // Older commits nothing matched are stale (pages devkit could not see).
      const commit = pending.splice(0, at + 1).at(-1)!;
      chain.committed = true;
      const prev = list[i + 1];
      // A refresh of the same page (an auto-reloading dashboard) is not a redirect: keep it as its own chain.
      const self = prev && sameDocument(prev.hops.at(-1)?.url ?? "", chain.hops[0]?.url ?? "");
      if (commit.client && prev?.committed && !self)
        list.splice(i, 2, { ...joinClient(prev, chain, kindFor(tabId, prev)), committed: true });
    }
  });
}

const recordings = new Map<string, Recording & { tabId: number }>();
type Details = { requestId: string; tabId: number; frameId?: number; type?: string; url: string; timeStamp: number };

let attached = false;

function attach() {
  if (attached || !redirectApisAvailable()) return;
  attached = true;
  registerProbe().catch(() => undefined);
  const { webRequest, webNavigation } = api() as Required<Api>;
  const filter = { urls: ["<all_urls>"], types: ["main_frame"] } as never;

  webRequest.onBeforeRequest.addListener((d: Details) => {
    // Chrome fires it again for each hop of the same request: keep the chain started on the first.
    if (d.tabId < 0 || recordings.has(d.requestId)) return;
    if (recordings.size > 50) recordings.clear();
    recordings.set(d.requestId, { ...startRecording(d.requestId, d.timeStamp, "tab"), tabId: d.tabId });
  }, filter);
  webRequest.onHeadersReceived.addListener(
    (d: Details & { statusCode: number; statusLine: string; responseHeaders?: { name: string; value?: string }[] }) => {
      const rec = recordings.get(d.requestId);
      if (rec) recordHeaders(rec, d);
    },
    filter,
    EXTRA,
  );
  webRequest.onBeforeRedirect.addListener(
    (
      d: Details & { statusCode: number; statusLine: string; redirectUrl: string; responseHeaders?: { name: string; value?: string }[] },
    ) => {
      const rec = recordings.get(d.requestId);
      if (rec) recordRedirect(rec, d);
    },
    filter,
    EXTRA,
  );
  webRequest.onCompleted.addListener(
    (d: Details & { statusCode: number; statusLine: string; responseHeaders?: { name: string; value?: string }[] }) => {
      const rec = recordings.get(d.requestId);
      if (!rec) return;
      recordings.delete(d.requestId);
      saveTabChain(rec.tabId, recordComplete(rec, d)).catch(() => undefined);
    },
    filter,
    EXTRA,
  );
  webRequest.onErrorOccurred.addListener((d: Details & { error: string }) => {
    const rec = recordings.get(d.requestId);
    if (!rec) return;
    recordings.delete(d.requestId);
    saveTabChain(rec.tabId, recordError(rec, d)).catch(() => undefined);
  }, filter);

  webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
    const client = d.transitionQualifiers.includes("client_redirect");
    const commit = { url: d.url, client, ready: !client };
    const list = commits.get(d.tabId) ?? [];
    list.push(commit);
    commits.set(d.tabId, list.slice(-5));
    if (client)
      // Name the hop from the previous document's meta refresh: wait for its probe (bounded) before joining.
      probed(d.tabId, documents.get(d.tabId), 1500).then(() => {
        commit.ready = true;
        settle(d.tabId).catch(() => undefined);
      });
    documents.set(d.tabId, d.url);
    settle(d.tabId).catch(() => undefined);
  });

  // Traces: devkit's own requests (no tab). Registered once, here: a listener added just before the fetch could
  // reach the network stack after the request started.
  const own = { urls: ["<all_urls>"], tabId: -1 } as never;
  const origin = new URL(browser.runtime.getURL("/")).origin;
  const traced = (d: Details) => (active?.rec && active.rec.chain.id === d.requestId ? active : null);
  webRequest.onBeforeRequest.addListener((d: Details & { initiator?: string }): undefined => {
    if (active && !active.rec && sameDocument(d.url, active.url) && (!d.initiator || d.initiator === origin))
      active.rec = startRecording(d.requestId, d.timeStamp, "trace");
  }, own);
  webRequest.onHeadersReceived.addListener(
    (d: Details & { statusCode: number; statusLine: string }): undefined => {
      const t = traced(d);
      if (t?.rec) recordHeaders(t.rec, d);
    },
    own,
    EXTRA,
  );
  webRequest.onBeforeRedirect.addListener(
    (d: Details & { statusCode: number; statusLine: string; redirectUrl: string }): undefined => {
      const t = traced(d);
      if (t?.rec) recordRedirect(t.rec, d);
    },
    own,
    EXTRA,
  );
  webRequest.onCompleted.addListener(
    (d: Details & { statusCode: number; statusLine: string }): undefined => {
      const t = traced(d);
      if (t?.rec) t.done(recordComplete(t.rec, d));
    },
    own,
    EXTRA,
  );
  webRequest.onErrorOccurred.addListener((d: Details & { error: string }): undefined => {
    const t = traced(d);
    if (t?.rec) t.done(recordError(t.rec, d));
  }, own);
}

/* The content script that reports each page's meta refresh (src/entrypoints/redirect-probe.content.ts). */
const PROBE_ID = "devkit-redirect-probe";

async function registerProbe() {
  if ((await browser.scripting.getRegisteredContentScripts({ ids: [PROBE_ID] })).length) return;
  await browser.scripting.registerContentScripts([
    {
      id: PROBE_ID,
      js: ["content-scripts/redirect-probe.js"],
      matches: ["<all_urls>"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ] as never);
}

async function unregisterProbe() {
  if ((await browser.scripting.getRegisteredContentScripts({ ids: [PROBE_ID] })).length)
    await browser.scripting.unregisterContentScripts({ ids: [PROBE_ID] });
}

/* Trace a URL: devkit requests it and watches its own request hop by hop. One trace at a time. */
type ActiveTrace = { url: string; rec?: Recording; done: (c: Chain) => void };
let active: ActiveTrace | null = null;
let traceQueue: Promise<unknown> = Promise.resolve();

export function traceUrl(url: string): Promise<Chain> {
  const run = traceQueue.then(() => traceAll(url));
  traceQueue = run.catch(() => undefined);
  return run;
}

async function traceAll(start: string): Promise<Chain> {
  let chain = await traceOnce(start);
  const seen = new Set(chain.hops.map((h) => h.url.split("#")[0]!));
  // Follow meta refreshes (and Refresh headers) the way a browser would, within the same 20-redirect budget.
  while (!chain.stopped) {
    const last = chain.hops.at(-1) as (Chain["hops"][number] & { body?: string }) | undefined;
    if (!last || last.error || last.status < 200 || last.status >= 300) break;
    const body = last.body;
    delete last.body;
    const content = last.headers.refresh ?? (body ? findMetaRefresh(body) : null);
    const kind: RedirectKind = last.headers.refresh ? "refresh" : "meta";
    const next = content ? parseRefresh(content, last.url) : null;
    if (!next || sameDocument(next.url, last.url)) break;
    if (seen.has(next.url.split("#")[0]!)) {
      last.redirect = kind;
      last.location = next.url;
      chain.stopped = "loop";
      break;
    }
    if (redirectCount(chain) >= MAX_REDIRECTS) {
      chain.stopped = "max-hops";
      break;
    }
    const more = await traceOnce(next.url);
    for (const h of more.hops) seen.add(h.url.split("#")[0]!);
    chain = joinClient(chain, more, kind);
  }
  for (const h of chain.hops) delete (h as { body?: string }).body;
  return chain;
}

async function traceOnce(url: string): Promise<Chain> {
  let done: (c: Chain) => void = () => undefined;
  const finished = new Promise<Chain>((resolve) => {
    done = resolve;
  });
  const trace: ActiveTrace = { url, done };
  active = trace;
  let res: Response | undefined;
  let body: string | undefined;
  let failure: string | undefined;
  try {
    res = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow" });
    if (/text\/html|xhtml/i.test(res.headers.get("content-type") ?? "")) body = (await res.text()).slice(0, 512 * 1024);
    else await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // onCompleted can come a moment after fetch() settles.
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000));
  const observed = trace.rec ? await Promise.race([finished, timeout]) : undefined;
  active = null;
  const chain: Chain = observed ?? {
    id: `trace-${Date.now()}`,
    source: "trace",
    startedAt: Date.now(),
    hops: [
      {
        url: res?.url || url,
        status: res?.status ?? 0,
        headers: res ? Object.fromEntries(res.headers.entries()) : {},
        ...(failure ? { error: failure } : {}),
      },
    ],
    note: "devkit could not watch this request hop by hop: only the final response is shown.",
  };
  const last = chain.hops.at(-1);
  if (last && body !== undefined && !last.error) (last as { body?: string }).body = body;
  return chain;
}

/** Wires the redirect recorder into the service worker. Call once, at the top level of the background. */
export function registerRedirects() {
  attach();
  browser.permissions.onAdded.addListener(() => {
    attach();
    // Granted again after a revoke: the listeners stayed, the probe was unregistered.
    if (attached && redirectApisAvailable()) registerProbe().catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((removed) => {
    if (removed.permissions?.some((p) => p === "webRequest" || p === "webNavigation")) unregisterProbe().catch(() => undefined);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    commits.delete(tabId);
    documents.delete(tabId);
    metaSeen.delete(tabId);
    update((store) => {
      delete store[tabId];
    }).catch(() => undefined);
  });
  browser.runtime.onMessage.addListener((message: { type?: string; content?: string | null }, sender) => {
    if (message?.type !== META_REFRESH_SEEN || sender.tab?.id === undefined || sender.frameId !== 0 || !sender.url) return;
    noteMeta(sender.tab.id, sender.url, typeof message.content === "string" ? message.content : null);
  });
  browser.runtime.onMessage.addListener((message: TraceMessage, _sender, sendResponse) => {
    if (message?.type !== REDIRECT_TRACE || typeof message.url !== "string") return;
    attach();
    if (!attached) {
      sendResponse({ error: "devkit needs the webRequest permission to trace redirects." } satisfies TraceAnswer);
      return;
    }
    traceUrl(message.url).then(
      (chain) => sendResponse({ chain } satisfies TraceAnswer),
      (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies TraceAnswer),
    );
    return true;
  });
}
