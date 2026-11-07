import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { type DebuggerUser, debuggerUsers } from "../../lib/debugger";
import {
  bodyWarning,
  CONTENT_TYPES,
  compilePattern,
  detachReason,
  ERROR_REASONS,
  type ErrorReason,
  exportMocks,
  importMocks,
  isJsonType,
  MAX_DELAY,
  MOCK_MESSAGE,
  MOCK_METHODS,
  MOCKS_KEY,
  type Mock,
  type MockLogEntry,
  type MockMethod,
  type MockOp,
  type MockReply,
  type MockTabState,
  mockFromResponse,
  mockLabel,
  mockMatches,
  mockProblem,
  newMock,
  patternKind,
  prettyJson,
  tabLogKey,
  tabStateKey,
} from "../../lib/mocks";
import { ensurePermission } from "../../lib/permissions";
import { originOf, originPattern } from "../../lib/tab";
import { base64Decode } from "../../lib/utils/encode";
import { Button, bytes, download, Empty, Notice, Section, useToast } from "../components";
import { usePage } from "../page";

const call = (op: MockOp, tabId: number, requestId?: string): Promise<MockReply> =>
  browser.runtime.sendMessage({ type: MOCK_MESSAGE, op, tabId, requestId }).then(
    (r: MockReply | undefined) => r ?? { ok: false, error: "The background did not answer." },
    (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );

/** This tab's mocking state, log and debugger holders, live from storage.session. */
function useMockTab(tabId: number | undefined) {
  const [state, setState] = useState<MockTabState>({ on: false, hits: 0 });
  const [log, setLog] = useState<MockLogEntry[]>([]);
  const [users, setUsers] = useState<DebuggerUser[]>([]);
  useEffect(() => {
    setState({ on: false, hits: 0 });
    setLog([]);
    setUsers([]);
    if (tabId === undefined) return;
    let live = true;
    const sk = tabStateKey(tabId);
    const lk = tabLogKey(tabId);
    browser.storage.session.get([sk, lk]).then((got) => {
      if (!live) return;
      if (got[sk]) setState(got[sk] as MockTabState);
      setLog((got[lk] as MockLogEntry[] | undefined) ?? []);
    });
    debuggerUsers(tabId).then((u) => live && setUsers(u));
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== "session") return;
      if (sk in changes) setState((changes[sk]!.newValue as MockTabState | undefined) ?? { on: false, hits: 0 });
      if (lk in changes) setLog((changes[lk]!.newValue as MockLogEntry[] | undefined) ?? []);
      if ("debuggerUsers" in changes) setUsers(((changes.debuggerUsers!.newValue ?? {}) as Record<string, DebuggerUser[]>)[tabId] ?? []);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);
  return { state, setState, log, users };
}

/** The mock list from storage.local; edits show at once and are saved a moment later. */
function useMockList(): [Mock[], (next: Mock[]) => void, boolean] {
  const [mocks, setMocks] = useState<Mock[]>([]);
  const [ready, setReady] = useState(false);
  const pending = useRef<Mock[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) browser.storage.local.set({ [MOCKS_KEY]: pending.current });
    pending.current = null;
  }, []);
  useEffect(() => {
    browser.storage.local.get(MOCKS_KEY).then((r) => {
      setMocks((r[MOCKS_KEY] as Mock[] | undefined) ?? []);
      setReady(true);
    });
    return flush;
  }, [flush]);
  const save = useCallback(
    (next: Mock[]) => {
      setMocks(next);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 250);
    },
    [flush],
  );
  return [mocks, save, ready];
}

/** Hits on this tab, shown on the Mocks pill of the sub-navigation while mocking is on. */
export function MocksBadge() {
  const page = usePage();
  const { state } = useMockTab(page.tabId);
  if (!state.on) return null;
  return state.hits ? (
    <span className="mock-badge" role="img" aria-label={`${state.hits} mocked`}>
      {state.hits > 99 ? "99+" : state.hits}
    </span>
  ) : (
    <span className="mock-badge dot" role="img" aria-label="mocking on" />
  );
}

/** The real response of `url`, fetched once from the panel (asks access to its site first). */
async function fetchReal(url: string, method: string): Promise<{ status: number; contentType: string; body: string }> {
  const origin = originOf(url);
  if (!origin) throw new Error("Enter an absolute http(s) URL.");
  if (!(await ensurePermission({ origins: [originPattern(origin)] })))
    throw new Error(`devkit needs access to ${new URL(origin).host} to fetch the real response.`);
  const res = await fetch(url, { method, credentials: "include", cache: "no-store" });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: text.length > 1_000_000 ? text.slice(0, 1_000_000) : text,
  };
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[\w.+-]+\+(json|xml)))/i;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function shortUrl(url: string, pageOrigin: string | null): string {
  try {
    const u = new URL(url);
    return u.origin === pageOrigin ? u.pathname + u.search : u.host + u.pathname + u.search;
  } catch {
    return url;
  }
}

export function Mocks() {
  const page = usePage();
  const toast = useToast();
  const tabId = page.tabId;
  const { state, setState, log, users } = useMockTab(tabId);
  const [mocks, setMocks, ready] = useMockList();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromUrl, setFromUrl] = useState<{ url: string; method: MockMethod } | null>(null);
  const [fetching, setFetching] = useState(false);

  // Check the session is really there whenever the panel looks at a tab.
  useEffect(() => {
    if (tabId !== undefined) call("status", tabId).then((r) => r.state && setState(r.state));
  }, [tabId, setState]);

  const toggle = async (on: boolean) => {
    if (tabId === undefined) return;
    setBusy(true);
    const r = await call(on ? "start" : "stop", tabId);
    setBusy(false);
    if (r.state) setState(r.state);
    if (!r.ok) toast(r.error ?? "Mocking failed.", true);
    else if (on && r.state?.on) toast("Mocking on for this tab.");
  };

  const update = (id: string, patch: Partial<Mock>) => setMocks(mocks.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const add = (mock: Mock) => {
    setMocks([mock, ...mocks]);
    setOpen(mock.id);
  };

  const createFromUrl = async () => {
    if (!fromUrl) return;
    setFetching(true);
    try {
      const real = await fetchReal(fromUrl.url.trim(), fromUrl.method === "ANY" ? "GET" : fromUrl.method);
      add(mockFromResponse({ method: fromUrl.method, url: fromUrl.url.trim(), ...real }));
      setFromUrl(null);
      toast(`Mock created from the real response (${real.status}).`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setFetching(false);
    }
  };

  const mockEntry = async (entry: MockLogEntry) => {
    if (tabId === undefined) return;
    const r = await call("body", tabId, entry.id);
    let body: string | undefined;
    if (r.ok && r.body !== undefined) {
      if (!r.base64) body = r.body;
      else if (TEXTUAL.test(entry.mime ?? "")) body = base64Decode(r.body);
    }
    add(mockFromResponse({ method: entry.method, url: entry.url, status: entry.status, contentType: entry.mime, body: body ?? "" }));
    toast(
      body !== undefined
        ? "Mock created with the response the page received."
        : "Mock created. Chrome no longer holds that response: use “Fetch the real response” to fill the body.",
      body === undefined,
    );
  };

  const importFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const imported = importMocks(JSON.parse(await f.text()));
        setMocks([...mocks, ...imported]);
        toast(`${imported.length} mock${imported.length === 1 ? "" : "s"} imported.`);
      } catch (e) {
        toast(`Import failed: ${e instanceof Error ? e.message : e}`, true);
      }
    };
    input.click();
  };

  const active = mocks.filter((m) => m.enabled && !mockProblem(m)).length;
  const canDebug = Boolean(page.origin);
  const shared = users.filter((u) => u !== "mocks");

  return (
    <>
      <Section
        title="Mocking on this tab"
        actions={
          canDebug && tabId !== undefined ? (
            state.on ? (
              <Button busy={busy} onClick={() => toggle(false)}>
                Turn off
              </Button>
            ) : (
              <Button busy={busy} variant="primary" onClick={() => toggle(true)}>
                {state.detached ? "Turn back on" : "Turn on"}
              </Button>
            )
          ) : null
        }
        hint="Answers this tab's matching fetch and XHR calls; other tabs are never touched. It goes through the Chrome debugger, so Chrome shows a “devkit started debugging this browser” bar while it is on. It keeps working across reloads and with the side panel closed."
      >
        {!canDebug ? (
          <Notice kind="warn">Open a web page (http or https) to mock its API calls.</Notice>
        ) : (
          <div className={`mock-status${state.on ? " on" : ""}`} aria-live="polite">
            <span className={`dot ${state.on ? "good" : "info"}`} aria-hidden="true" />
            <b>{state.on ? "On" : "Off"}</b>
            <span className="muted">
              {state.on
                ? `${state.hits} request${state.hits === 1 ? "" : "s"} mocked · ${active} mock${active === 1 ? "" : "s"} active`
                : active
                  ? `${active} mock${active === 1 ? "" : "s"} ready`
                  : "No active mock yet"}
            </span>
          </div>
        )}
        {state.on && !active ? <Notice kind="warn">No mock is enabled and complete: every request goes to the network.</Notice> : null}
        {!state.on && state.detached ? (
          <Notice kind="warn">
            <span className="grow">
              Mocking stopped: {detachReason(state.detached)}. Requests go to the network again. Turn it back on to resume.
            </span>
          </Notice>
        ) : null}
        {state.error ? <Notice kind="bad">Could not start mocking: {state.error}</Notice> : null}
        {shared.length ? (
          <p className="small muted" style={{ margin: 0 }}>
            Shares this tab's debugger session with {shared.join(" and ")}: turning one off keeps the other running.
          </p>
        ) : null}
      </Section>

      <Section
        title={`Mocks (${active} active)`}
        actions={
          <>
            <Button size="small" onClick={() => add(newMock())}>
              + Mock
            </Button>
            <Button
              size="small"
              aria-expanded={Boolean(fromUrl)}
              onClick={() => setFromUrl(fromUrl ? null : { url: page.origin ? `${page.origin}/` : "https://", method: "GET" })}
            >
              From URL
            </Button>
            <Button size="small" onClick={importFile}>
              Import
            </Button>
            <Button size="small" disabled={!mocks.length} onClick={() => download("devkit-mocks.json", exportMocks(mocks))}>
              Export
            </Button>
          </>
        }
        hint="The first enabled mock that matches answers. Saved on this device and shared by every tab you turn mocking on."
      >
        {fromUrl ? (
          <form
            className="card stack mock-from"
            onSubmit={(e) => {
              e.preventDefault();
              createFromUrl();
            }}
          >
            <label className="field">
              URL to fetch once, to start from its real response
              <div className="mock-line">
                <select
                  aria-label="Method"
                  value={fromUrl.method}
                  onChange={(e) => setFromUrl({ ...fromUrl, method: e.target.value as MockMethod })}
                >
                  {["GET", "HEAD", "OPTIONS"].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input
                  className="mono"
                  type="url"
                  aria-label="URL to fetch"
                  value={fromUrl.url}
                  autoFocus
                  onChange={(e) => setFromUrl({ ...fromUrl, url: e.target.value })}
                />
              </div>
            </label>
            <div className="row">
              <Button type="submit" variant="primary" busy={fetching} disabled={!originOf(fromUrl.url.trim())}>
                Fetch and create
              </Button>
              <Button variant="ghost" onClick={() => setFromUrl(null)}>
                Cancel
              </Button>
              <span className="small muted grow">Sent once from devkit, with your cookies.</span>
            </div>
          </form>
        ) : null}
        {mocks.length ? (
          <ul className="mock-list">
            {mocks.map((m) => (
              <MockItem
                key={m.id}
                mock={m}
                open={open === m.id}
                hits={log.filter((e) => e.mockId === m.id && e.outcome !== "pending").length}
                seen={log.length ? log.filter((e) => mockMatches({ ...m, enabled: true }, e.method, e.url)).length : null}
                onToggle={() => setOpen(open === m.id ? null : m.id)}
                onChange={(patch) => update(m.id, patch)}
                onDuplicate={() => {
                  const copy = { ...m, id: crypto.randomUUID(), name: m.name ? `${m.name} (copy)` : "" };
                  const i = mocks.findIndex((x) => x.id === m.id);
                  setMocks([...mocks.slice(0, i + 1), copy, ...mocks.slice(i + 1)]);
                  setOpen(copy.id);
                }}
                onDelete={() => {
                  setMocks(mocks.filter((x) => x.id !== m.id));
                  toast("Mock deleted.");
                }}
              />
            ))}
          </ul>
        ) : ready ? (
          <Empty>No mock yet. Add one, start from a URL's real response, or pick a request in the log below.</Empty>
        ) : null}
        <datalist id="mock-content-types">
          {CONTENT_TYPES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Section>

      <Section
        title="Requests on this tab"
        actions={
          log.length && tabId !== undefined ? (
            <Button size="small" variant="ghost" onClick={() => call("clear", tabId)}>
              Clear
            </Button>
          ) : null
        }
        hint={
          state.on
            ? "Fetch and XHR calls since mocking was turned on, newest first. “Mock” starts a mock from what the page received."
            : undefined
        }
      >
        {log.length ? (
          <ol className="mock-log">
            {log.slice(0, 60).map((e) => (
              <LogRow key={e.id} entry={e} origin={page.origin} onOpen={() => e.mockId && setOpen(e.mockId)} onMock={() => mockEntry(e)} />
            ))}
          </ol>
        ) : (
          <Empty>
            {state.on
              ? "Nothing yet. Requests the page makes show here as they happen."
              : "Turn mocking on to see this tab's fetch and XHR calls here."}
          </Empty>
        )}
      </Section>
    </>
  );
}

function LogRow({
  entry: e,
  origin,
  onOpen,
  onMock,
}: {
  entry: MockLogEntry;
  origin: string | null;
  onOpen: () => void;
  onMock: () => void;
}) {
  const mocked = e.outcome === "mocked" || e.outcome === "failed";
  return (
    <li className={`mock-row ${e.outcome}`}>
      <time className="mono muted" dateTime={new Date(e.time).toISOString()}>
        {clock(e.time)}
      </time>
      <span className="mono mock-method">{e.method}</span>
      <span className="mono ellipsis mock-url" title={e.url}>
        {shortUrl(e.url, origin)}
      </span>
      <span className="mock-result">
        {mocked ? (
          <button type="button" className="pill accent mock-hit" title={`Answered by “${e.mockName}”: open it`} onClick={onOpen}>
            {e.outcome === "failed" ? "failed" : e.status} · {e.mockName}
          </button>
        ) : e.outcome === "pending" ? (
          <span className="muted small mock-result-text">{e.mockName ? `${e.mockName} · waiting ${e.delay} ms` : "pending"}</span>
        ) : (
          <>
            <span className={`small mock-result-text ${e.outcome === "error" ? "t-bad" : "muted"}`} title={e.error}>
              {e.outcome === "error" ? (e.error ?? "failed") : e.status}
            </span>
            {e.outcome === "passed" ? (
              <Button size="small" onClick={onMock} title="New mock prefilled with this response">
                Mock
              </Button>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

const KIND_HINT: Record<ReturnType<typeof patternKind>, string> = {
  substring: "part of the URL",
  wildcard: "a wildcard pattern",
  regex: "a regex",
};

function MockItem({
  mock: m,
  open,
  hits,
  seen,
  onToggle,
  onChange,
  onDuplicate,
  onDelete,
}: {
  mock: Mock;
  open: boolean;
  hits: number;
  /** Log requests the pattern matches; null when the log is empty. */
  seen: number | null;
  onToggle: () => void;
  onChange: (patch: Partial<Mock>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [fetching, setFetching] = useState(false);
  const problem = mockProblem(m);
  const warning = bodyWarning(m);
  const kind = m.match.trim() ? patternKind(m.match) : null;
  const size = useMemo(() => new TextEncoder().encode(m.body).length, [m.body]);
  const id = m.id.slice(0, 8);
  const refetch = async () => {
    if (!m.source) return;
    setFetching(true);
    try {
      const real = await fetchReal(m.source, m.method === "ANY" || m.method === "POST" ? "GET" : m.method);
      const fresh = mockFromResponse({ method: m.method, url: m.source, ...real });
      onChange({ status: fresh.status, contentType: fresh.contentType, body: fresh.body });
      toast(`Filled from the real response (${real.status}).`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setFetching(false);
    }
  };
  return (
    <li className={`mock-item${open ? " open" : ""}${m.enabled ? "" : " off"}`}>
      <div className="mock-head">
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          aria-label={`Enable ${mockLabel(m)}`}
        />
        <button type="button" className="mock-summary" aria-expanded={open} aria-controls={`mock-${id}`} onClick={onToggle}>
          <span className="mono mock-method">{m.method === "ANY" ? "ANY" : m.method}</span>
          <span className="mock-name ellipsis">
            {m.name.trim() ? <b>{m.name}</b> : null}
            <span className={`mono${m.name.trim() ? " muted" : ""}`}>{m.match.trim() || "No URL pattern"}</span>
          </span>
          {problem ? (
            <span className="pill mock-tag t-warn">fix</span>
          ) : (
            <span className={`pill mock-tag${m.mode === "fail" ? " t-bad" : ""}`}>{m.mode === "fail" ? "error" : m.status}</span>
          )}
          {hits ? (
            <span className="pill accent mock-tag" title={`Answered ${hits} request${hits === 1 ? "" : "s"} on this tab`}>
              {hits}×
            </span>
          ) : null}
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="mock-edit stack" id={`mock-${id}`}>
          <label className="field">
            Name
            <input value={m.name} placeholder="Optional, shown in the log" onChange={(e) => onChange({ name: e.target.value })} />
          </label>
          <div className="field">
            <label htmlFor={`pat-${id}`}>URL pattern</label>
            <div className="mock-line">
              <select aria-label="Method" value={m.method} onChange={(e) => onChange({ method: e.target.value as MockMethod })}>
                {MOCK_METHODS.map((x) => (
                  <option key={x} value={x}>
                    {x === "ANY" ? "Any" : x}
                  </option>
                ))}
              </select>
              <input
                id={`pat-${id}`}
                className="mono"
                value={m.match}
                placeholder="/api/user"
                spellCheck={false}
                onChange={(e) => onChange({ match: e.target.value })}
              />
            </div>
            <span className="small muted mock-hint">
              Part of the URL, <code>*</code> wildcard, <code>|</code> anchors, <code>||api.example.com</code> for a domain, or{" "}
              <code>/regex/i</code>.
            </span>
            {kind && seen !== null && compilePattern(m.match) ? (
              <span className={`small mock-hint ${seen ? "t-good" : "muted"}`}>
                Read as {KIND_HINT[kind]} ·{" "}
                {seen ? `matches ${seen} request${seen === 1 ? "" : "s"} in the log` : "matches no request in the log"}
              </span>
            ) : null}
          </div>
          <div className="mock-mode" role="radiogroup" aria-label="Answer with">
            <label className="check">
              <input type="radio" name={`mode-${id}`} checked={m.mode === "respond"} onChange={() => onChange({ mode: "respond" })} />
              Response
            </label>
            <label className="check">
              <input type="radio" name={`mode-${id}`} checked={m.mode === "fail"} onChange={() => onChange({ mode: "fail" })} />
              Network error
            </label>
          </div>
          {m.mode === "respond" ? (
            <>
              <div className="mock-grid">
                <label className="field">
                  Status
                  <input
                    type="number"
                    min={100}
                    max={599}
                    value={Number.isFinite(m.status) ? m.status : ""}
                    onChange={(e) => onChange({ status: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                  />
                </label>
                <label className="field mock-ct">
                  Content type
                  <input list="mock-content-types" value={m.contentType} onChange={(e) => onChange({ contentType: e.target.value })} />
                </label>
                <label className="field">
                  Delay (ms)
                  <input
                    type="number"
                    min={0}
                    max={MAX_DELAY}
                    step={100}
                    value={m.delay}
                    onChange={(e) => onChange({ delay: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
              </div>
              <label className="field">
                Headers
                <textarea
                  className="mock-headers"
                  rows={2}
                  spellCheck={false}
                  placeholder={"X-Request-Id: 42\nSet-Cookie: flag=on"}
                  value={m.headers}
                  onChange={(e) => onChange({ headers: e.target.value })}
                />
              </label>
              <div className="field">
                <div className="mock-body-head">
                  <label htmlFor={`body-${id}`} className="grow">
                    Body
                  </label>
                  {isJsonType(m.contentType) ? (
                    <Button
                      size="small"
                      disabled={!m.body.trim()}
                      onClick={() => {
                        const pretty = prettyJson(m.body);
                        if (pretty === null) toast("The body is not valid JSON yet.", true);
                        else onChange({ body: pretty });
                      }}
                    >
                      Format
                    </Button>
                  ) : null}
                  {m.source ? (
                    <Button size="small" busy={fetching} onClick={refetch} title={`GET ${m.source}`}>
                      Fetch the real response
                    </Button>
                  ) : null}
                </div>
                <textarea
                  id={`body-${id}`}
                  className={`mock-body${warning ? " invalid" : ""}`}
                  spellCheck={false}
                  rows={Math.min(16, Math.max(5, m.body.split("\n").length + 1))}
                  value={m.body}
                  aria-describedby={`body-state-${id}`}
                  onChange={(e) => onChange({ body: e.target.value })}
                />
                <span id={`body-state-${id}`} className={`small ${warning ? "t-warn" : "muted"}`} aria-live="polite">
                  {warning ?? (isJsonType(m.contentType) && m.body.trim() ? `Valid JSON · ${bytes(size)}` : bytes(size))}
                </span>
              </div>
            </>
          ) : (
            <div className="mock-grid fail">
              <label className="field mock-ct">
                Fails with
                <select value={m.error} onChange={(e) => onChange({ error: e.target.value as ErrorReason })}>
                  {ERROR_REASONS.map(([r, label]) => (
                    <option key={r} value={r}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Delay (ms)
                <input
                  type="number"
                  min={0}
                  max={MAX_DELAY}
                  step={100}
                  value={m.delay}
                  onChange={(e) => onChange({ delay: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
          )}
          {problem ? <div className="small t-warn">{problem}: this mock is skipped until then.</div> : null}
          <div className="row">
            <Button size="small" onClick={onDuplicate}>
              Duplicate
            </Button>
            <span className="grow" />
            <Button size="small" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
