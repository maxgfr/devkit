import { useMemo, useState } from "react";
import { browser, type Browser } from "wxt/browser";
import { ACTIONS, isNoCacheOn } from "../../lib/actions";
import { runInTab } from "../../lib/inject";
import { ensurePermission } from "../../lib/permissions";
import { Button, download, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { AccessGate, useInPage, usePage, useRunAction } from "../page";

export function CacheActions() {
  const run = useRunAction();
  const page = usePage();
  const noCache = useAsync(async () => (page.tabId === undefined ? false : isNoCacheOn(page.tabId)), [page.tabId]);
  return (
    <>
      <Section title="Cache & storage" hint={page.origin ? `For ${page.origin}` : "Open a web page to clear its data."}>
        <div className="grid2">
          {ACTIONS.filter((a) => a.category === "cache").map((a) => (
            <button
              key={a.id}
              type="button"
              className="action"
              onClick={async () => {
                await run(a);
                noCache.run();
              }}
            >
              <strong>
                {a.title}
                {a.id === "toggle-no-cache" && noCache.data ? " (on)" : ""}
              </strong>
              <span>{a.description}</span>
            </button>
          ))}
        </div>
      </Section>
      <Notice>
        <span className="small">
          Keyboard: <kbd>Alt+Shift+X</kbd> fresh start · <kbd>Alt+Shift+D</kbd> palette · <kbd>Alt+Shift+S</kbd> side panel. Change them in
          chrome://extensions/shortcuts.
        </span>
      </Notice>
    </>
  );
}

const DATA_TYPES = [
  ["cache", "HTTP cache"],
  ["cacheStorage", "Cache Storage"],
  ["cookies", "Cookies (whole registrable domain)"],
  ["localStorage", "localStorage"],
  ["indexedDB", "IndexedDB"],
  ["serviceWorkers", "Service workers"],
  ["fileSystems", "File systems"],
] as const;

export function SiteData() {
  const page = usePage();
  const toast = useToast();
  const [types, setTypes] = useState<Record<string, boolean>>({
    cache: true,
    cacheStorage: true,
    localStorage: true,
    indexedDB: true,
    serviceWorkers: true,
  });
  const [session, setSession] = useState(true);
  const [reload, setReload] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!page.origin) return <Empty>Open a web page to clear its data.</Empty>;
  return (
    <Section title={`Clear site data for ${page.origin}`}>
      <div className="stack">
        {DATA_TYPES.map(([key, label]) => (
          <label key={key} className="check">
            <input type="checkbox" checked={Boolean(types[key])} onChange={(e) => setTypes({ ...types, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={session} onChange={(e) => setSession(e.target.checked)} />
          sessionStorage (this tab)
        </label>
        <label className="check">
          <input type="checkbox" checked={reload} onChange={(e) => setReload(e.target.checked)} />
          Hard reload afterwards
        </label>
      </div>
      <div className="row">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            if (!(await ensurePermission({ permissions: ["browsingData"] })))
              return toast("devkit needs the browsingData permission.", true);
            setBusy(true);
            try {
              if (session && page.tabId !== undefined && page.canScript)
                await runInTab(page.tabId, () => sessionStorage.clear()).catch(() => undefined);
              await browser.browsingData.remove({ origins: [page.origin!] }, types);
              if (reload && page.tabId !== undefined) await browser.tabs.reload(page.tabId, { bypassCache: true });
              toast("Site data cleared.");
            } catch (e) {
              toast(String(e), true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Clear selected
        </Button>
        <Button onClick={() => setTypes(Object.fromEntries(DATA_TYPES.map(([k]) => [k, true])))}>Select all</Button>
      </div>
    </Section>
  );
}

type Cookie = Browser.cookies.Cookie;

function cookieUrl(c: Cookie) {
  return `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
}

export function Cookies() {
  const page = usePage();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Cookie | null>(null);
  const cookies = useAsync(async () => {
    if (!page.url || !page.origin) return null;
    if (!(await browser.permissions.contains({ permissions: ["cookies"] }))) return "no-permission" as const;
    if (!page.canScript) return "no-access" as const;
    return browser.cookies.getAll({ url: page.url });
  }, [page.url, page.canScript]);
  const list = Array.isArray(cookies.data) ? cookies.data : [];
  const shown = useMemo(
    () => list.filter((c) => `${c.name} ${c.value} ${c.domain}`.toLowerCase().includes(filter.toLowerCase())),
    [list, filter],
  );

  if (!page.origin) return <Empty>Open a web page to see its cookies.</Empty>;
  if (cookies.data === "no-permission")
    return (
      <Notice kind="warn">
        <span className="grow">The cookie editor needs the cookies permission.</span>
        <Button variant="primary" onClick={async () => (await ensurePermission({ permissions: ["cookies"] })) && cookies.run()}>
          Grant
        </Button>
      </Notice>
    );
  if (cookies.data === "no-access") return <AccessGate />;

  const save = async (c: Cookie, original?: Cookie) => {
    try {
      if (original && (original.name !== c.name || original.domain !== c.domain || original.path !== c.path))
        await browser.cookies.remove({ url: cookieUrl(original), name: original.name, storeId: original.storeId });
      await browser.cookies.set({
        url: cookieUrl(c),
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? undefined : c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.session ? undefined : c.expirationDate,
        storeId: c.storeId,
      });
      toast(`Saved ${c.name}.`);
      setEditing(null);
      cookies.run();
    } catch (e) {
      toast(String(e), true);
    }
  };

  return (
    <Section
      title={`Cookies (${list.length})`}
      actions={
        <>
          <Button size="small" onClick={() => download(`cookies-${new URL(page.origin!).host}.json`, JSON.stringify(list, null, 2))}>
            Export
          </Button>
          <Button
            size="small"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "application/json";
              input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                  const items = JSON.parse(await file.text()) as Cookie[];
                  for (const c of items) await save({ ...c, hostOnly: c.hostOnly ?? !c.domain.startsWith(".") });
                  toast(`Imported ${items.length} cookies.`);
                } catch (e) {
                  toast(`Import failed: ${e}`, true);
                }
              };
              input.click();
            }}
          >
            Import
          </Button>
          <Button
            size="small"
            onClick={() =>
              setEditing({
                name: "",
                value: "",
                domain: new URL(page.origin!).hostname,
                path: "/",
                secure: page.origin!.startsWith("https"),
                httpOnly: false,
                sameSite: "lax",
                session: true,
                hostOnly: true,
                storeId: "0",
              } as Cookie)
            }
          >
            Add
          </Button>
        </>
      }
    >
      <ErrorText error={cookies.error} />
      {editing ? (
        <CookieForm cookie={editing} onCancel={() => setEditing(null)} onSave={(c) => save(c, editing.name ? editing : undefined)} />
      ) : null}
      <input type="search" placeholder="Filter cookies" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {shown.length ? (
        <ul className="list">
          {shown.map((c) => (
            <li key={`${c.domain}${c.path}${c.name}`}>
              <div className="row">
                <b className="mono grow ellipsis" title={c.name}>
                  {c.name}
                </b>
                {c.httpOnly ? <span className="pill">HttpOnly</span> : null}
                {c.secure ? <span className="pill">Secure</span> : null}
                <span className="pill" title="SameSite attribute">
                  SameSite: {c.sameSite}
                </span>
                <Button size="small" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  onClick={async () => {
                    await browser.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
                    cookies.run();
                  }}
                >
                  Delete
                </Button>
              </div>
              <div className="mono small break muted">{c.value.length > 200 ? `${c.value.slice(0, 200)}…` : c.value || "(empty)"}</div>
              <div className="small muted">
                {c.domain}
                {c.path} · {c.session ? "session" : `expires ${new Date((c.expirationDate ?? 0) * 1000).toLocaleString()}`}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{cookies.loading ? "Loading…" : "No cookie."}</Empty>
      )}
    </Section>
  );
}

function CookieForm({ cookie, onSave, onCancel }: { cookie: Cookie; onSave: (c: Cookie) => void; onCancel: () => void }) {
  const [c, setC] = useState<Cookie>(cookie);
  const expires = c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 16) : "";
  return (
    <div className="card stack">
      <label className="field">
        Name
        <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
      </label>
      <label className="field">
        Value
        <textarea value={c.value} rows={3} onChange={(e) => setC({ ...c, value: e.target.value })} />
      </label>
      <div className="row">
        <label className="field grow">
          Domain
          <input value={c.domain} onChange={(e) => setC({ ...c, domain: e.target.value, hostOnly: !e.target.value.startsWith(".") })} />
        </label>
        <label className="field grow">
          Path
          <input value={c.path} onChange={(e) => setC({ ...c, path: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={c.secure} onChange={(e) => setC({ ...c, secure: e.target.checked })} /> Secure
        </label>
        <label className="check">
          <input type="checkbox" checked={c.httpOnly} onChange={(e) => setC({ ...c, httpOnly: e.target.checked })} /> HttpOnly
        </label>
        <select
          value={c.sameSite}
          onChange={(e) => setC({ ...c, sameSite: e.target.value as Cookie["sameSite"] })}
          style={{ width: "auto" }}
        >
          <option value="no_restriction">SameSite=None</option>
          <option value="lax">Lax</option>
          <option value="strict">Strict</option>
          <option value="unspecified">unspecified</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={c.session}
            onChange={(e) =>
              setC({ ...c, session: e.target.checked, expirationDate: e.target.checked ? undefined : Date.now() / 1000 + 86400 * 30 })
            }
          />{" "}
          Session
        </label>
      </div>
      {!c.session ? (
        <label className="field">
          Expires (UTC)
          <input
            type="datetime-local"
            value={expires}
            onChange={(e) => setC({ ...c, expirationDate: Date.parse(`${e.target.value}Z`) / 1000 })}
          />
        </label>
      ) : null}
      <div className="row">
        <Button variant="primary" disabled={!c.name} onClick={() => onSave(c)}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function readStorage(kind: "local" | "session"): { key: string; value: string }[] {
  const s = kind === "local" ? localStorage : sessionStorage;
  return Array.from({ length: s.length }, (_, i) => {
    const key = s.key(i) ?? "";
    return { key, value: s.getItem(key) ?? "" };
  });
}

function writeStorage(kind: "local" | "session", op: "set" | "remove" | "clear", key: string, value: string) {
  const s = kind === "local" ? localStorage : sessionStorage;
  if (op === "set") s.setItem(key, value);
  else if (op === "remove") s.removeItem(key);
  else s.clear();
}

export function Storage() {
  const page = usePage();
  const toast = useToast();
  const [kind, setKind] = useState<"local" | "session">("local");
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ key: string; value: string; isNew?: boolean } | null>(null);
  const items = useInPage(readStorage, [kind]);
  const write = async (op: "set" | "remove" | "clear", key = "", value = "") => {
    if (page.tabId === undefined) return;
    await runInTab(page.tabId, writeStorage, [kind, op, key, value]);
    items.run();
  };
  const shown = (items.data ?? []).filter((i) => `${i.key} ${i.value}`.toLowerCase().includes(filter.toLowerCase()));
  const pretty = (v: string) => {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  };
  return (
    <AccessGate>
      <Section
        title={`${kind}Storage (${items.data?.length ?? 0})`}
        actions={
          <>
            <select value={kind} onChange={(e) => setKind(e.target.value as "local" | "session")} style={{ width: "auto" }}>
              <option value="local">localStorage</option>
              <option value="session">sessionStorage</option>
            </select>
            <Button size="small" onClick={() => setEditing({ key: "", value: "", isNew: true })}>
              Add
            </Button>
            <Button
              size="small"
              onClick={() =>
                download(
                  `${kind}Storage.json`,
                  JSON.stringify(Object.fromEntries((items.data ?? []).map((i) => [i.key, i.value])), null, 2),
                )
              }
            >
              Export
            </Button>
            <Button
              size="small"
              variant="danger"
              onClick={async () => {
                await write("clear");
                toast(`${kind}Storage cleared.`);
              }}
            >
              Clear
            </Button>
          </>
        }
      >
        <ErrorText error={items.error} />
        {editing ? (
          <div className="card stack">
            <label className="field">
              Key
              <input value={editing.key} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, key: e.target.value })} />
            </label>
            <label className="field">
              Value
              <textarea rows={8} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
            </label>
            <div className="row">
              <Button
                variant="primary"
                disabled={!editing.key}
                onClick={async () => {
                  await write("set", editing.key, editing.value);
                  setEditing(null);
                }}
              >
                Save
              </Button>
              <Button onClick={() => setEditing({ ...editing, value: pretty(editing.value) })}>Format JSON</Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        <input type="search" placeholder="Filter keys and values" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {shown.length ? (
          <ul className="list">
            {shown.map((i) => (
              <li key={i.key}>
                <div className="row">
                  <b className="mono grow ellipsis">{i.key}</b>
                  <span className="muted small">{i.value.length} chars</span>
                  <Button size="small" onClick={() => setEditing({ key: i.key, value: i.value })}>
                    Edit
                  </Button>
                  <Button size="small" variant="danger" onClick={() => write("remove", i.key)}>
                    Delete
                  </Button>
                </div>
                <div className="mono small muted break">{i.value.length > 240 ? `${i.value.slice(0, 240)}…` : i.value}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{items.loading ? "Loading…" : "Empty."}</Empty>
        )}
      </Section>
    </AccessGate>
  );
}
