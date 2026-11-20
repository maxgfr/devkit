// Cache › IndexedDB and Cache › Cache Storage: browse, edit and export what the page's origin keeps in IndexedDB
// and in Cache Storage (service worker caches). The page side is src/lib/page/databases.ts.
import { useCallback, useState } from "react";
import {
  buildRange,
  bodyKind,
  type CacheEntryDetail,
  type CacheEntrySummary,
  type CacheRequest,
  type CacheSummary,
  cacheExport,
  checkTagged,
  exportFileName,
  FULL_LIMITS,
  IDB_CODEC_VERSION,
  type IdbListResult,
  type IdbReadResult,
  type IdbRecord,
  type IdbRequest,
  type IdbStoreInfo,
  inlineKeyProblem,
  keyPathText,
  PREVIEW_LIMITS,
  pageLabel,
  pageOffsets,
  parseJsonBody,
  parseKeyText,
  parseRecordText,
  previewTagged,
  type RangeSpec,
  shortUrl,
  storeExport,
  type Tagged,
} from "../../lib/databases";
import { injectionError, runInTab } from "../../lib/inject";
import { cacheOp, idbOp, installIdbCodec } from "../../lib/page/databases";
import { deleteCache, deleteDatabase } from "../../lib/page/storage";
import { formatBytes } from "../../lib/storage-usage";
import { Button, Code, CopyButton, download, Empty, ErrorText, JsonTree, KV, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { AccessGate, usePage } from "../page";
import { ConfirmButton } from "./usage";

const PAGE_SIZE = 25;
const EXPORT_LIMIT = 5000;
const plural = (n: number | null, one: string, many = `${one}s`) =>
  n === null ? `? ${many}` : `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const keyId = (key: Tagged) => JSON.stringify(key);

/** Runs an IndexedDB request in the page, loading the codec first. */
function useIdb() {
  const { tabId } = usePage();
  return useCallback(
    async <R,>(req: IdbRequest): Promise<R> => {
      if (tabId === undefined) throw new Error("No active tab.");
      try {
        await runInTab(tabId, installIdbCodec, [IDB_CODEC_VERSION]);
        return JSON.parse(await runInTab(tabId, idbOp, [JSON.stringify(req)])) as R;
      } catch (e) {
        throw new Error(injectionError(e));
      }
    },
    [tabId],
  );
}

function useCaches() {
  const { tabId } = usePage();
  return useCallback(
    async <R,>(req: CacheRequest): Promise<R> => {
      if (tabId === undefined) throw new Error("No active tab.");
      try {
        return (await runInTab(tabId, cacheOp, [req])) as R;
      } catch (e) {
        throw new Error(injectionError(e));
      }
    },
    [tabId],
  );
}

const host = (origin: string | null) => (origin ? new URL(origin).host : "this site");

/* IndexedDB */

export function IndexedDbViewer() {
  const page = usePage();
  const idb = useIdb();
  const toast = useToast();
  const [selected, setSelected] = useState<{ db: string; store: string } | null>(null);
  const list = useAsync<IdbListResult>(() => idb({ op: "list" }), [page.tabId, page.url, page.canScript], page.canScript);
  if (!page.canScript) return <AccessGate />;
  const data = list.data;
  const db = selected ? data?.databases.find((d) => d.name === selected.db) : undefined;
  const store = selected ? db?.stores.find((s) => s.name === selected.store) : undefined;

  return (
    <>
      <Section
        title={`IndexedDB${data ? ` (${data.databases.length})` : ""}`}
        hint={`Databases of ${host(page.origin)}, opened at their current version without upgrading them.`}
        actions={
          <Button size="small" onClick={list.run} busy={list.loading}>
            Refresh
          </Button>
        }
      >
        <ErrorText error={list.error} />
        {!data && list.loading ? <Empty>Reading the databases…</Empty> : null}
        {data && !data.supported ? <Empty>This browser cannot list IndexedDB databases.</Empty> : null}
        {data?.supported && !data.databases.length ? <Empty>No database.</Empty> : null}
        {data?.databases.length ? (
          <ul className="list db-tree">
            {data.databases.map((d) => (
              <li key={d.name}>
                <div className="row">
                  <b className="mono grow ellipsis" title={d.name}>
                    {d.name || "(no name)"}
                  </b>
                  {d.version !== null ? <span className="pill">v{d.version}</span> : null}
                  <span className="muted small">{plural(d.stores.length, "store")}</span>
                  <ConfirmButton
                    label="Delete database"
                    confirm="Confirm delete"
                    onConfirm={async () => {
                      if (page.tabId === undefined) return;
                      const r = await runInTab(page.tabId, deleteDatabase, [d.name]);
                      toast(r === "deleted" ? `Deleted ${d.name}.` : `${d.name}: ${r}`, r !== "deleted");
                      if (selected?.db === d.name) setSelected(null);
                      await list.run();
                    }}
                  />
                </div>
                {d.error ? <span className="small t-warn">{d.error}</span> : null}
                {d.stores.length ? (
                  <div className="db-stores">
                    {d.stores.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        className="db-node"
                        aria-pressed={selected?.db === d.name && selected.store === s.name}
                        onClick={() => setSelected({ db: d.name, store: s.name })}
                      >
                        <span className="mono ellipsis">{s.name}</span>
                        <span className="muted small">{plural(s.count, "record")}</span>
                      </button>
                    ))}
                  </div>
                ) : d.error ? null : (
                  <span className="small muted">No object store.</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      {db && store && data ? (
        <StoreView
          key={`${db.name}\u0000${store.name}`}
          origin={data.origin}
          db={db.name}
          version={db.version}
          store={store}
          onChanged={list.run}
        />
      ) : null}
    </>
  );
}

type Editor = { mode: "add" | "edit"; keyText: string; valueText: string; key: Tagged | null };

function StoreView({
  origin,
  db,
  version,
  store,
  onChanged,
}: {
  origin: string;
  db: string;
  version: number | null;
  store: IdbStoreInfo;
  onChanged: () => Promise<void>;
}) {
  const page = usePage();
  const idb = useIdb();
  const toast = useToast();
  const [index, setIndex] = useState("");
  const [mode, setMode] = useState<"all" | "equals" | "prefix">("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<RangeSpec>({ kind: "all" });
  const [rangeError, setRangeError] = useState("");
  const [offset, setOffset] = useState(0);
  const [openKey, setOpenKey] = useState<Tagged | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [exporting, setExporting] = useState(false);
  const records = useAsync<IdbReadResult>(
    () => idb({ op: "read", db, store: store.name, index: index || null, range, offset, limit: PAGE_SIZE, limits: PREVIEW_LIMITS }),
    [db, store.name, index, JSON.stringify(range), offset, page.url],
  );
  const reload = async () => {
    await records.run();
    await onChanged();
  };
  const apply = () => {
    const r = buildRange(mode, query);
    if (!r.ok) return setRangeError(r.error);
    setRangeError("");
    setRange(r.value);
    setOffset(0);
  };
  const r = records.data;
  const pages = r ? pageOffsets(offset, PAGE_SIZE, r.total) : { prev: null, next: null };
  const inline = store.keyPath !== null;

  return (
    <>
      <Section
        title={
          <>
            {db} › {store.name}
          </>
        }
        actions={
          <>
            <Button
              size="small"
              onClick={() => {
                setOpenKey(null);
                setEditor({ mode: "add", keyText: "", valueText: inline ? "{\n  \n}" : '""', key: null });
              }}
            >
              Add
            </Button>
            <Button
              size="small"
              busy={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const all = await idb<IdbReadResult>({
                    op: "read",
                    db,
                    store: store.name,
                    index: null,
                    range: { kind: "all" },
                    offset: 0,
                    limit: EXPORT_LIMIT,
                    limits: FULL_LIMITS,
                  });
                  const meta = { origin, database: db, version, store, exportedAt: new Date().toISOString() };
                  download(exportFileName("indexeddb", db, store.name), storeExport(meta, all.records, all.total));
                  if (all.records.length < all.total) toast(`Exported the first ${all.records.length} of ${all.total} records.`);
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), true);
                } finally {
                  setExporting(false);
                }
              }}
            >
              Export
            </Button>
            <ConfirmButton
              label="Clear store"
              confirm="Confirm clear"
              onConfirm={async () => {
                try {
                  await idb({ op: "clear", db, store: store.name });
                  toast(`Cleared ${store.name}.`);
                  setOpenKey(null);
                  setEditor(null);
                  setOffset(0);
                  await reload();
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), true);
                }
              }}
            />
          </>
        }
      >
        <KV
          rows={[
            ["Key", `${keyPathText(store.keyPath)}${store.autoIncrement ? " · autoIncrement" : ""}`],
            ["Records", plural(store.count, "record")],
            [
              "Indexes",
              store.indexes.length
                ? store.indexes
                    .map((i) => `${i.name} (${keyPathText(i.keyPath)}${i.unique ? ", unique" : ""}${i.multiEntry ? ", multiEntry" : ""})`)
                    .join(" · ")
                : "none",
            ],
          ]}
        />
        <form
          className="row db-query"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <select aria-label="Read through" value={index} onChange={(e) => setIndex(e.target.value)} style={{ width: "auto" }}>
            <option value="">Primary key</option>
            {store.indexes.map((i) => (
              <option key={i.name} value={i.name}>
                Index {i.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Key filter"
            value={mode}
            onChange={(e) => setMode(e.target.value as "all" | "equals" | "prefix")}
            style={{ width: "auto" }}
          >
            <option value="all">All keys</option>
            <option value="equals">Key equals</option>
            <option value="prefix">Key starts with</option>
          </select>
          <input
            aria-label="Key"
            className="grow mono"
            placeholder={mode === "prefix" ? "Text prefix" : 'Key: 42, "42", ["a", 1] or text'}
            disabled={mode === "all"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button size="small" type="submit">
            Apply
          </Button>
        </form>
        {rangeError ? <Notice kind="warn">{rangeError}</Notice> : null}
        <ErrorText error={records.error} />
        {r?.records.length ? (
          <div className="cookie-table-wrap">
            <table className="cookie-table db-table">
              <thead>
                <tr>
                  <th>{index ? `${index} key` : "Key"}</th>
                  {index ? <th>Primary key</th> : null}
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {r.records.map((rec) => (
                  <RecordRow
                    key={`${keyId(rec.key)}\u0000${keyId(rec.primaryKey)}`}
                    rec={rec}
                    showPrimary={Boolean(index)}
                    open={openKey !== null && keyId(openKey) === keyId(rec.primaryKey)}
                    onOpen={() => {
                      setEditor(null);
                      setOpenKey(openKey !== null && keyId(openKey) === keyId(rec.primaryKey) ? null : rec.primaryKey);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{records.loading ? "Loading…" : r ? (range.kind === "all" ? "Empty store." : "No record matches.") : ""}</Empty>
        )}
        {r && r.total > PAGE_SIZE ? (
          <div className="row">
            <Button size="small" disabled={pages.prev === null} onClick={() => setOffset(pages.prev ?? 0)}>
              Previous
            </Button>
            <span className="small muted grow">{pageLabel(offset, r.records.length, r.total)}</span>
            <Button size="small" disabled={pages.next === null} onClick={() => setOffset(pages.next ?? offset)}>
              Next
            </Button>
          </div>
        ) : r?.total ? (
          <span className="small muted">{pageLabel(offset, r.records.length, r.total)}</span>
        ) : null}
      </Section>
      {editor ? (
        <RecordEditor
          db={db}
          store={store}
          editor={editor}
          onCancel={() => setEditor(null)}
          onSaved={async (key) => {
            setEditor(null);
            setOpenKey(key);
            await reload();
          }}
        />
      ) : openKey !== null ? (
        <RecordView
          db={db}
          store={store}
          recordKey={openKey}
          onEdit={(value) =>
            setEditor({ mode: "edit", key: openKey, keyText: JSON.stringify(openKey), valueText: JSON.stringify(value, null, 2) })
          }
          onDeleted={async () => {
            setOpenKey(null);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function RecordRow({ rec, showPrimary, open, onOpen }: { rec: IdbRecord; showPrimary: boolean; open: boolean; onOpen: () => void }) {
  return (
    <tr className={open ? "open" : undefined}>
      <td>
        <button
          type="button"
          className="linklike mono"
          aria-pressed={open}
          aria-label={`Open record ${previewTagged(rec.primaryKey, 60)}`}
          onClick={onOpen}
        >
          {previewTagged(rec.key, 60)}
        </button>
      </td>
      {showPrimary ? <td>{previewTagged(rec.primaryKey, 40)}</td> : null}
      <td className="db-preview">{previewTagged(rec.value, 160)}</td>
    </tr>
  );
}

function RecordView({
  db,
  store,
  recordKey,
  onEdit,
  onDeleted,
}: {
  db: string;
  store: IdbStoreInfo;
  recordKey: Tagged;
  onEdit: (value: Tagged) => void;
  onDeleted: () => Promise<void>;
}) {
  const idb = useIdb();
  const toast = useToast();
  const rec = useAsync<IdbRecord | null>(
    () => idb({ op: "get", db, store: store.name, key: recordKey, limits: FULL_LIMITS }),
    [db, store.name, keyId(recordKey)],
  );
  const value = rec.data?.value;
  const issue = value !== undefined ? checkTagged(value) : null;
  return (
    <Section
      title={<>Record {previewTagged(recordKey, 60)}</>}
      actions={
        rec.data ? (
          <>
            <Button size="small" onClick={() => onEdit(rec.data!.value)}>
              Edit
            </Button>
            <CopyButton text={JSON.stringify(rec.data.value, null, 2)} label="Copy JSON" />
            <ConfirmButton
              label="Delete"
              confirm="Confirm delete"
              onConfirm={async () => {
                try {
                  await idb({ op: "delete", db, store: store.name, key: recordKey });
                  toast("Record deleted.");
                  await onDeleted();
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), true);
                }
              }}
            />
          </>
        ) : null
      }
    >
      <ErrorText error={rec.error} />
      {rec.loading && !rec.data ? <Empty>Loading…</Empty> : null}
      {rec.data === null ? <Empty>This record is gone.</Empty> : null}
      {value !== undefined ? (
        <>
          {issue ? <Notice kind="warn">Part of this record cannot be written back from here ({issue}).</Notice> : null}
          <div className="db-json">
            <JsonTree value={value} open={3} />
          </div>
        </>
      ) : null}
    </Section>
  );
}

function RecordEditor({
  db,
  store,
  editor,
  onCancel,
  onSaved,
}: {
  db: string;
  store: IdbStoreInfo;
  editor: Editor;
  onCancel: () => void;
  onSaved: (key: Tagged) => Promise<void>;
}) {
  const idb = useIdb();
  const toast = useToast();
  const [keyText, setKeyText] = useState(editor.keyText);
  const [valueText, setValueText] = useState(editor.valueText);
  const [saving, setSaving] = useState(false);
  const inline = store.keyPath !== null;
  const adding = editor.mode === "add";
  // Out-of-line keys are typed in when adding; autoIncrement stores may leave it empty.
  const askKey = !inline && adding;
  const parsed = parseRecordText(valueText);
  const key = askKey ? (keyText.trim() ? parseKeyText(keyText) : store.autoIncrement ? null : parseKeyText("")) : null;
  const problem = !parsed.ok
    ? parsed.error
    : key && !key.ok
      ? key.error
      : inline
        ? inlineKeyProblem(parsed.value, store.keyPath, store.autoIncrement && adding)
        : null;

  return (
    <Section title={adding ? `Add to ${store.name}` : `Edit record ${previewTagged(editor.key ?? null, 60)}`}>
      <div className="card stack db-editor">
        {askKey ? (
          <label className="field">
            Key{store.autoIncrement ? " (empty: generated)" : ""}
            <input className="mono" value={keyText} placeholder='42, "42", ["a", 1] or text' onChange={(e) => setKeyText(e.target.value)} />
          </label>
        ) : null}
        <label className="field">
          Value (JSON)
          <textarea rows={12} spellCheck={false} value={valueText} onChange={(e) => setValueText(e.target.value)} />
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          Values JSON cannot hold are objects with a <code>$type</code>: Date, Map, Set, BigInt, RegExp, ArrayBuffer and typed arrays
          (base64), Blob and File, undefined, NaN. Keep them as they are, or write your own the same way.
          {inline ? ` The key comes from ${keyPathText(store.keyPath)} in the value.` : ""}
        </p>
        {problem ? <Notice kind="warn">{problem}</Notice> : null}
        <div className="row">
          <Button
            variant="primary"
            busy={saving}
            disabled={Boolean(problem)}
            onClick={async () => {
              if (!parsed.ok) return;
              setSaving(true);
              try {
                const writeKey = askKey ? (key?.ok ? key.value : null) : inline ? null : editor.key;
                const res = await idb<{ key: Tagged }>({
                  op: adding ? "add" : "put",
                  db,
                  store: store.name,
                  key: writeKey,
                  value: parsed.value,
                });
                toast(adding ? `Added record ${previewTagged(res.key, 40)}.` : "Record saved.");
                await onSaved(res.key);
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), true);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
          <Button disabled={!parsed.ok} onClick={() => parsed.ok && setValueText(JSON.stringify(parsed.value, null, 2))}>
            Format JSON
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Section>
  );
}

/* Cache Storage */

export function CacheStorageViewer() {
  const page = usePage();
  const run = useCaches();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAsync<CacheSummary[]>(() => run({ op: "list" }), [page.tabId, page.url, page.canScript], page.canScript);
  if (!page.canScript) return <AccessGate />;
  const caches = list.data;
  const current = selected ? caches?.find((c) => c.name === selected) : undefined;
  return (
    <>
      <Section
        title={`Cache Storage${caches ? ` (${caches.length})` : ""}`}
        hint={`Caches of ${host(page.origin)}, written by its service worker (Workbox, PWAs, offline pages) or by the page.`}
        actions={
          <Button size="small" onClick={list.run} busy={list.loading}>
            Refresh
          </Button>
        }
      >
        <ErrorText error={list.error} />
        {!caches && list.loading ? <Empty>Reading the caches…</Empty> : null}
        {caches && !caches.length ? <Empty>No cache.</Empty> : null}
        {caches?.length ? (
          <div className="db-stores">
            {caches.map((c) => (
              <button
                key={c.name}
                type="button"
                className="db-node"
                aria-pressed={selected === c.name}
                onClick={() => setSelected(selected === c.name ? null : c.name)}
              >
                <span className="mono ellipsis">{c.name}</span>
                <span className="muted small">{plural(c.count, "entry", "entries")}</span>
              </button>
            ))}
          </div>
        ) : null}
      </Section>
      {current ? (
        <CacheView
          key={current.name}
          origin={page.origin}
          name={current.name}
          onDeleted={async () => {
            if (page.tabId === undefined) return;
            const ok = await runInTab(page.tabId, deleteCache, [current.name]);
            toast(ok ? `Deleted cache ${current.name}.` : `Cache ${current.name} was already gone.`);
            setSelected(null);
            await list.run();
          }}
          onChanged={list.run}
        />
      ) : null}
    </>
  );
}

function CacheView({
  origin,
  name,
  onDeleted,
  onChanged,
}: {
  origin: string | null;
  name: string;
  onDeleted: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const run = useCaches();
  const toast = useToast();
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const entries = useAsync<{ total: number; entries: CacheEntrySummary[] }>(() => run({ op: "entries", cache: name, limit: 500 }), [name]);
  const e = entries.data;
  return (
    <>
      <Section
        title={name}
        actions={
          <>
            <Button
              size="small"
              busy={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const all = await run<CacheEntryDetail[]>({ op: "export", cache: name, textCap: 1_000_000, limit: 1000 });
                  const total = e?.total ?? all.length;
                  download(
                    exportFileName("cache", name),
                    cacheExport({ origin: origin ?? "", cache: name, exportedAt: new Date().toISOString() }, all, total),
                  );
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), true);
                } finally {
                  setExporting(false);
                }
              }}
            >
              Export
            </Button>
            <ConfirmButton label="Delete cache" confirm="Confirm delete" onConfirm={onDeleted} />
          </>
        }
      >
        <ErrorText error={entries.error} />
        {e?.entries.length ? (
          <div className="cookie-table-wrap">
            <table className="cookie-table db-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {e.entries.map((x) => (
                  <tr key={x.url} className={openUrl === x.url ? "open" : undefined}>
                    <td>
                      <button
                        type="button"
                        className="linklike mono"
                        aria-pressed={openUrl === x.url}
                        title={x.url}
                        onClick={() => setOpenUrl(openUrl === x.url ? null : x.url)}
                      >
                        {x.method !== "GET" ? `${x.method} ` : ""}
                        {shortUrl(x.url, origin)}
                      </button>
                    </td>
                    <td>{x.type === "opaque" ? "opaque" : x.status}</td>
                    <td>{x.contentType.split(";")[0] || "–"}</td>
                    <td>{x.size === null ? "–" : formatBytes(x.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{entries.loading ? "Loading…" : e ? "Empty cache." : ""}</Empty>
        )}
        {e && e.total > e.entries.length ? (
          <span className="small muted">
            First {e.entries.length} of {e.total.toLocaleString("en")} entries.
          </span>
        ) : null}
      </Section>
      {openUrl ? (
        <CacheEntryView
          key={openUrl}
          cache={name}
          url={openUrl}
          onDeleted={async () => {
            setOpenUrl(null);
            await entries.run();
            await onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function CacheEntryView({ cache, url, onDeleted }: { cache: string; url: string; onDeleted: () => Promise<void> }) {
  const run = useCaches();
  const toast = useToast();
  const entry = useAsync<CacheEntryDetail>(() => run({ op: "entry", cache, url, textCap: 200_000, imageCap: 300_000 }), [cache, url]);
  const d = entry.data;
  const kind = d ? bodyKind(d.contentType) : "binary";
  const json = d?.body.kind === "text" && kind === "json" ? parseJsonBody(d.body.text) : null;
  return (
    <Section
      title="Cached response"
      actions={
        <>
          <CopyButton text={url} label="Copy URL" />
          <ConfirmButton
            label="Delete entry"
            confirm="Confirm delete"
            onConfirm={async () => {
              try {
                const ok = await run<boolean>({ op: "delete-entry", cache, url });
                toast(ok ? "Entry deleted." : "The entry was already gone.");
                await onDeleted();
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), true);
              }
            }}
          />
        </>
      }
    >
      <ErrorText error={entry.error} />
      {entry.loading && !d ? <Empty>Loading…</Empty> : null}
      {d ? (
        <>
          <KV
            rows={[
              ["URL", d.url],
              ["Status", d.type === "opaque" ? "hidden (opaque)" : `${d.status}${d.statusText ? ` ${d.statusText}` : ""}`],
              ["Response type", d.type],
              ["Content-Type", d.contentType || "–"],
              ["Size", d.size === null ? "–" : formatBytes(d.size)],
            ]}
          />
          {d.headers.length ? (
            <details>
              <summary className="small">Headers ({d.headers.length})</summary>
              <KV rows={d.headers.map(([k, v]) => [k, v])} />
            </details>
          ) : null}
          <h3>Body</h3>
          {d.body.kind === "image" ? (
            <img className="db-image" src={d.body.dataUrl} alt={`Cached body of ${shortUrl(d.url, null)}`} />
          ) : d.body.kind === "none" ? (
            <Empty>{d.body.reason}</Empty>
          ) : json !== null ? (
            <div className="db-json">
              <JsonTree value={json} open={4} />
            </div>
          ) : (
            <Code text={d.body.text} maxHeight={320} />
          )}
          {d.body.kind === "text" && d.body.truncated ? <span className="small muted">Preview cut at 200 KB.</span> : null}
        </>
      ) : null}
    </Section>
  );
}
