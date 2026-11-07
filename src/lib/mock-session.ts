import { browser } from "wxt/browser";
import { claimDebugger, debuggerError, forgetDebugger, isAttached, releaseDebugger } from "./debugger";
import {
  ERROR_REASONS,
  fetchPatterns,
  findMock,
  fulfillParams,
  type Mock,
  MOCK_MESSAGE,
  MOCKS_KEY,
  type MockLogEntry,
  type MockReply,
  type MockRequest,
  type MockTabState,
  mockLabel,
  preflightMethod,
  preflightResponse,
  tabLogKey,
  tabStateKey,
  upsertLog,
} from "./mocks";

/*
 * API mocks run here, in the service worker, so they keep answering when the side panel closes.
 * Chrome keeps a worker alive while it holds a debugger session (118+); a light keep-alive covers
 * 116–117. Every piece of state is mirrored in storage.session, so a restarted worker picks up
 * where it was and the panel reads the state and the log from there.
 */

interface Paused {
  requestId: string;
  networkId?: string;
  resourceType: string;
  request: { url: string; method: string; headers: Record<string, string> };
}

interface NetEvent {
  requestId: string;
  type?: string;
  timestamp?: number;
  wallTime?: number;
  request?: { url: string; method: string };
  response?: { status: number; mimeType: string };
  errorText?: string;
  canceled?: boolean;
}

let mocks: Mock[] = [];
let mocksLoaded: Promise<void> | null = null;
const loadMocks = () =>
  (mocksLoaded ??= browser.storage.local.get(MOCKS_KEY).then(({ [MOCKS_KEY]: list }) => {
    mocks = (list as Mock[] | undefined) ?? [];
  }));

interface TabRuntime {
  state: MockTabState;
  log: MockLogEntry[];
}
const tabs = new Map<number, Promise<TabRuntime>>();

function runtime(tabId: number): Promise<TabRuntime> {
  let rt = tabs.get(tabId);
  if (!rt) {
    rt = browser.storage.session.get([tabStateKey(tabId), tabLogKey(tabId)]).then((got) => ({
      state: (got[tabStateKey(tabId)] as MockTabState | undefined) ?? { on: false, hits: 0 },
      log: (got[tabLogKey(tabId)] as MockLogEntry[] | undefined) ?? [],
    }));
    tabs.set(tabId, rt);
  }
  return rt;
}

async function setState(tabId: number, patch: Partial<MockTabState>, replace = false): Promise<MockTabState> {
  const rt = await runtime(tabId);
  rt.state = replace ? ({ on: false, hits: 0, ...patch } as MockTabState) : { ...rt.state, ...patch };
  await browser.storage.session.set({ [tabStateKey(tabId)]: rt.state });
  keepAlive();
  return rt.state;
}

const flushes = new Map<number, ReturnType<typeof setTimeout>>();
function flushLog(tabId: number, rt: TabRuntime) {
  if (flushes.has(tabId)) return;
  flushes.set(
    tabId,
    setTimeout(() => {
      flushes.delete(tabId);
      browser.storage.session.set({ [tabLogKey(tabId)]: rt.log, [tabStateKey(tabId)]: rt.state }).catch(() => undefined);
    }, 120),
  );
}

async function log(tabId: number, patch: Partial<MockLogEntry> & { id: string }, hit = false) {
  const rt = await runtime(tabId);
  if (!rt.state.on) return;
  rt.log = upsertLog(rt.log, patch);
  if (hit) rt.state = { ...rt.state, hits: rt.state.hits + 1 };
  flushLog(tabId, rt);
}

const send = (tabId: number, method: string, params: Record<string, unknown> = {}) =>
  browser.debugger.sendCommand({ tabId }, method, params);

/** Points `Fetch` at what the enabled mocks can match; turns it off when none can. */
async function applyPatterns(tabId: number) {
  await loadMocks();
  const patterns = fetchPatterns(mocks);
  if (patterns.length) await send(tabId, "Fetch.enable", { patterns });
  else await send(tabId, "Fetch.disable").catch(() => undefined);
}

let alive: ReturnType<typeof setInterval> | null = null;
/** Pings an extension API while a tab is mocked: Chrome before 118 would stop the idle worker. */
async function keepAlive() {
  const any = (await Promise.all([...tabs.values()])).some((r) => r.state.on);
  if (any && !alive) alive = setInterval(() => browser.runtime.getPlatformInfo().catch(() => undefined), 20_000);
  if (!any && alive) {
    clearInterval(alive);
    alive = null;
  }
}

async function start(tabId: number): Promise<MockTabState> {
  try {
    await claimDebugger(tabId, "mocks");
    await send(tabId, "Network.enable", { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 });
    await applyPatterns(tabId);
  } catch (e) {
    await releaseDebugger(tabId, "mocks").catch(() => undefined);
    return setState(tabId, { on: false, error: debuggerError(e) });
  }
  const prev = (await runtime(tabId)).state;
  return setState(tabId, { on: true, hits: prev.on ? prev.hits : 0, since: Date.now() }, true);
}

async function stop(tabId: number): Promise<MockTabState> {
  const rt = await runtime(tabId);
  if (rt.state.on) {
    await send(tabId, "Fetch.disable").catch(() => undefined);
    await releaseDebugger(tabId, "mocks").catch(() => undefined);
  }
  return setState(tabId, { on: false, hits: rt.state.hits }, true);
}

/** The state, after checking the session is still there (a restarted worker or a missed event). */
async function status(tabId: number): Promise<MockTabState> {
  const rt = await runtime(tabId);
  if (rt.state.on && !(await isAttached(tabId))) {
    await forgetDebugger(tabId);
    return setState(tabId, { on: false, detached: "lost" });
  }
  return rt.state;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function onPaused(tabId: number, p: Paused) {
  const id = p.networkId ?? p.requestId;
  const pass = () => send(tabId, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined);
  await loadMocks();
  const rt = await runtime(tabId);
  if (!rt.state.on) return pass();
  const asked = preflightMethod(p.request);
  if (asked) {
    const mock = findMock(mocks, asked, p.request.url);
    if (!mock || mock.mode === "fail") return pass();
    return send(tabId, "Fetch.fulfillRequest", { requestId: p.requestId, ...preflightResponse(p.request) }).catch(pass);
  }
  const mock = findMock(mocks, p.request.method, p.request.url);
  if (!mock) return pass();
  const base = {
    id,
    method: p.request.method,
    url: p.request.url,
    mockId: mock.id,
    mockName: mockLabel(mock),
    delay: mock.delay || undefined,
  };
  if (mock.delay > 0) {
    await log(tabId, { ...base, outcome: "pending" });
    await sleep(mock.delay);
  }
  try {
    if (mock.mode === "fail") {
      await send(tabId, "Fetch.failRequest", { requestId: p.requestId, errorReason: mock.error });
      const what = ERROR_REASONS.find(([r]) => r === mock.error)?.[1];
      await log(tabId, { ...base, outcome: "failed", error: what }, true);
    } else {
      await send(tabId, "Fetch.fulfillRequest", { requestId: p.requestId, ...fulfillParams(mock, p.request) });
      await log(tabId, { ...base, outcome: "mocked", status: mock.status }, true);
    }
  } catch (e) {
    // Chrome refused the answer (an invalid header value, the page went away): let it through.
    await pass();
    await log(tabId, { ...base, mockId: undefined, outcome: "error", error: `Mock not served: ${e instanceof Error ? e.message : e}` });
  }
}

const LOGGED_TYPES = new Set(["XHR", "Fetch"]);
const types = new Map<string, string>();

function onNetwork(tabId: number, method: string, e: NetEvent) {
  if (method === "Network.requestWillBeSent") {
    if (!e.type || !LOGGED_TYPES.has(e.type) || !e.request) return;
    types.set(e.requestId, e.type);
    if (types.size > 2000) types.delete(types.keys().next().value!);
    return log(tabId, {
      id: e.requestId,
      time: e.wallTime ? Math.round(e.wallTime * 1000) : Date.now(),
      method: e.request.method,
      url: e.request.url,
      outcome: "pending",
    });
  }
  if (!types.has(e.requestId)) return;
  if (method === "Network.responseReceived" && e.response)
    return log(tabId, { id: e.requestId, status: e.response.status, mime: e.response.mimeType, outcome: "passed" });
  if (method === "Network.loadingFailed")
    return log(tabId, { id: e.requestId, outcome: "error", error: e.canceled ? "Canceled" : e.errorText });
}

async function body(tabId: number, requestId: string): Promise<MockReply> {
  try {
    const r = (await send(tabId, "Network.getResponseBody", { requestId })) as { body: string; base64Encoded: boolean };
    return { ok: true, body: r.body, base64: r.base64Encoded };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handle(message: MockRequest): Promise<MockReply> {
  const { tabId } = message;
  switch (message.op) {
    case "start":
      return { ok: true, state: await start(tabId) };
    case "stop":
      return { ok: true, state: await stop(tabId) };
    case "status":
      return { ok: true, state: await status(tabId) };
    case "clear": {
      const rt = await runtime(tabId);
      rt.log = [];
      rt.state = { ...rt.state, hits: 0 };
      await browser.storage.session.set({ [tabLogKey(tabId)]: [], [tabStateKey(tabId)]: rt.state });
      return { ok: true, state: rt.state };
    }
    case "body":
      return message.requestId ? body(tabId, message.requestId) : { ok: false, error: "No request" };
  }
}

/** Wires the mock session into the background service worker. Call once, at the top level. */
export function installMockSession() {
  browser.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Fetch.requestPaused") onPaused(tabId, params as unknown as Paused);
    else if (method.startsWith("Network.")) onNetwork(tabId, method, params as unknown as NetEvent);
  });

  browser.debugger.onDetach.addListener(async (source, reason) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    await forgetDebugger(tabId);
    const rt = await runtime(tabId);
    if (rt.state.on) await setState(tabId, { on: false, detached: reason });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
    browser.storage.session.remove([tabStateKey(tabId), tabLogKey(tabId)]).catch(() => undefined);
    forgetDebugger(tabId).catch(() => undefined);
  });

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(MOCKS_KEY in changes)) return;
    mocks = (changes[MOCKS_KEY]!.newValue as Mock[] | undefined) ?? [];
    mocksLoaded = Promise.resolve();
    for (const [tabId, rt] of tabs) if ((await rt).state.on) applyPatterns(tabId).catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((message: MockRequest, _sender, sendResponse) => {
    if (message?.type !== MOCK_MESSAGE) return;
    handle(message).then(sendResponse, (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  // A restarted worker: reload the tabs that were mocked so the keep-alive and patterns resume.
  browser.storage.session.get(null).then((all) => {
    for (const key of Object.keys(all)) {
      const m = /^mocks:tab:(\d+)$/.exec(key);
      if (m && (all[key] as MockTabState).on) runtime(Number(m[1])).then(() => keepAlive());
    }
  });
}
