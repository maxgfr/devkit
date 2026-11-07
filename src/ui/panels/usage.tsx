import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { runInTab } from "../../lib/inject";
import { collectStorageUsage, deleteCache, deleteDatabase } from "../../lib/page/storage";
import { type CookieTotals, formatBytes, quotaShare, storageMarkdown, type UsageKind, usageBreakdown } from "../../lib/storage-usage";
import { BarList, Legend, type Part, SegmentBar } from "../charts";
import { Button, CopyButton, Empty, ErrorText, Metric, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { useNav } from "../nav";
import { AccessGate, useInPage, usePage } from "../page";

const KIND_COLOR: Record<UsageKind, string> = {
  indexedDB: "var(--viz-1)",
  caches: "var(--viz-2)",
  fileSystem: "var(--viz-3)",
  serviceWorkerRegistrations: "var(--viz-4)",
  other: "var(--viz-other)",
};

/** A destructive button that asks for a second click instead of a dialog. */
function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="small"
      variant="danger"
      busy={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {armed ? confirm : label}
    </Button>
  );
}

export function StorageUsage() {
  const page = usePage();
  const nav = useNav();
  const toast = useToast();
  const snap = useInPage(collectStorageUsage);
  // Every cookie of the page, HttpOnly included, when devkit may read them; else what the page itself sees.
  const cookies = useAsync<CookieTotals | null>(async () => {
    if (!page.url || !(await browser.permissions.contains({ permissions: ["cookies"] }))) return null;
    const all = await browser.cookies.getAll({ url: page.url });
    return {
      count: all.length,
      bytes: all.reduce((n, c) => n + c.name.length + c.value.length, 0),
      httpOnly: all.filter((c) => c.httpOnly).length,
    };
  }, [page.url]);

  if (!page.canScript) return <AccessGate />;
  const s = snap.data;
  const cookieTotals: CookieTotals = cookies.data ?? s?.documentCookies ?? { count: 0, bytes: 0 };
  const inPage = async <R,>(fn: (name: string) => R | Promise<R>, name: string) =>
    page.tabId === undefined ? undefined : runInTab(page.tabId, fn, [name]);

  const parts: Part[] = usageBreakdown(s?.estimate ?? null).map((p) => ({
    key: p.kind,
    label: p.label,
    value: p.bytes,
    color: KIND_COLOR[p.kind],
    detail: formatBytes(p.bytes),
  }));

  return (
    <>
      <Section
        title="Storage usage"
        hint={`What ${page.origin ? new URL(page.origin).host : "this site"} keeps on this device. The total comes from navigator.storage.estimate(); Web Storage and cookies are counted apart.`}
        actions={
          <>
            <Button size="small" onClick={() => Promise.all([snap.run(), cookies.run()])} busy={snap.loading}>
              Refresh
            </Button>
            {s ? <CopyButton text={storageMarkdown(s, cookieTotals)} label="Copy report" /> : null}
          </>
        }
      >
        <ErrorText error={snap.error} />
        {!s && snap.loading ? <Empty>Reading the site's storage…</Empty> : null}
        {s ? (
          <>
            <div className="grid2">
              <Metric label="Used on disk" value={s.estimate ? formatBytes(s.estimate.usage) : "–"} />
              <Metric label="Quota for this site" value={s.estimate ? formatBytes(s.estimate.quota) : "–"} />
              <Metric label="Web Storage" value={formatBytes((s.local?.bytes ?? 0) + (s.session?.bytes ?? 0))} />
              <Metric label="Cookies" value={`${cookieTotals.count} · ${formatBytes(cookieTotals.bytes)}`} />
            </div>
            {s.estimate ? (
              <>
                <p className="small muted" style={{ margin: 0 }}>
                  {quotaShare(s.estimate.usage, s.estimate.quota)}. The quota is Chrome's share of the free disk space, not space reserved
                  for the site.
                </p>
                {parts.length ? (
                  <>
                    <SegmentBar parts={parts} tall label={`Storage by kind: ${parts.map((p) => `${p.label} ${p.detail}`).join(", ")}`} />
                    <Legend parts={parts} />
                  </>
                ) : (
                  <Empty>Nothing stored in IndexedDB, Cache Storage, service workers or the file system.</Empty>
                )}
              </>
            ) : null}
            {s.persisted !== null ? (
              <Notice kind={s.persisted ? "good" : "info"}>
                {s.persisted
                  ? "Persistent storage: Chrome will not evict this site's data under storage pressure."
                  : "Best-effort storage: Chrome may evict this site's data when the disk runs low (the page has not been granted navigator.storage.persist())."}
              </Notice>
            ) : null}
            {s.caches?.some((c) => c.opaque) ? (
              <Notice kind="warn">
                Cache Storage holds cross-origin (opaque) responses. Chrome pads each one in the quota (several MB), so the usage above can
                be far larger than the bytes actually stored.
              </Notice>
            ) : null}
          </>
        ) : null}
      </Section>

      {s ? (
        <>
          <Section title={`IndexedDB${s.idb ? ` (${s.idb.length})` : ""}`}>
            {s.idb === null ? (
              <Empty>This browser cannot list IndexedDB databases.</Empty>
            ) : s.idb.length === 0 ? (
              <Empty>No database.</Empty>
            ) : (
              <ul className="list usage-list">
                {s.idb.map((db) => (
                  <li key={db.name}>
                    <div className="row">
                      <b className="mono grow ellipsis" title={db.name}>
                        {db.name}
                      </b>
                      {db.version !== null ? <span className="pill">v{db.version}</span> : null}
                      <ConfirmButton
                        label="Delete"
                        confirm="Confirm delete"
                        onConfirm={async () => {
                          const r = await inPage(deleteDatabase, db.name);
                          toast(r === "deleted" ? `Deleted ${db.name}.` : `${db.name}: ${r}`, r !== "deleted");
                          await snap.run();
                        }}
                      />
                    </div>
                    {db.error ? (
                      <span className="small t-warn">{db.error}</span>
                    ) : db.stores.length ? (
                      <span className="small muted">
                        {db.stores
                          .map(
                            (st) =>
                              `${st.name}: ${st.count === null ? "?" : st.count.toLocaleString("en")} record${st.count === 1 ? "" : "s"}`,
                          )
                          .join(" · ")}
                      </span>
                    ) : (
                      <span className="small muted">No object store.</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Cache Storage${s.caches ? ` (${s.caches.length})` : ""}`}>
            {!s.caches?.length ? (
              <Empty>No cache.</Empty>
            ) : (
              <ul className="list usage-list">
                {s.caches.map((c) => (
                  <li key={c.name}>
                    <div className="row">
                      <b className="mono grow ellipsis" title={c.name}>
                        {c.name}
                      </b>
                      <ConfirmButton
                        label="Delete"
                        confirm="Confirm delete"
                        onConfirm={async () => {
                          const ok = await inPage(deleteCache, c.name);
                          toast(ok ? `Deleted cache ${c.name}.` : `Cache ${c.name} was already gone.`);
                          await snap.run();
                        }}
                      />
                    </div>
                    <span className="small muted">
                      {c.entries.toLocaleString("en")} entr{c.entries === 1 ? "y" : "ies"} · {formatBytes(c.bytes)}
                      {c.measured < c.entries - c.opaque ? ` measured on ${c.measured}` : ""}
                      {c.opaque ? ` · ${c.opaque} opaque (size hidden)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Web Storage"
            actions={
              nav ? (
                <Button size="small" onClick={() => nav({ panel: "storage" })}>
                  Open the editor
                </Button>
              ) : null
            }
          >
            {(
              [
                ["localStorage", s.local],
                ["sessionStorage", s.session],
              ] as const
            ).map(([name, usage]) =>
              usage ? (
                <div key={name} className="stack">
                  <span className="small">
                    <b className="mono">{name}</b>{" "}
                    <span className="muted">
                      {usage.count} key{usage.count === 1 ? "" : "s"} · {formatBytes(usage.bytes)}
                    </span>
                  </span>
                  {usage.top.length ? (
                    <BarList
                      label={`Largest ${name} keys`}
                      rows={usage.top.map((k) => ({ key: k.key, label: k.key, value: k.bytes, text: formatBytes(k.bytes) }))}
                    />
                  ) : null}
                </div>
              ) : null,
            )}
            <p className="small muted" style={{ margin: 0 }}>
              Sizes count keys and values as UTF-16, 2 bytes per character, the way Chrome's 5 MB-per-origin limit does.
            </p>
          </Section>

          <Section
            title="Cookies"
            actions={
              nav ? (
                <Button size="small" onClick={() => nav({ panel: "cookies" })}>
                  Open the editor
                </Button>
              ) : null
            }
          >
            <span className="small">
              {cookieTotals.count} cookie{cookieTotals.count === 1 ? "" : "s"} · {formatBytes(cookieTotals.bytes)}
              {cookies.data ? ` · ${cookies.data.httpOnly ?? 0} HttpOnly` : ""}
            </span>
            {!cookies.data ? (
              <span className="small muted">
                Only the cookies the page can read; HttpOnly ones are counted once the cookie editor has its permission.
              </span>
            ) : null}
          </Section>

          {s.opfs?.files ? (
            <Section title={`Origin private file system (${s.opfs.files} files)`}>
              <BarList
                label="Largest OPFS files"
                rows={s.opfs.top.map((f) => ({ key: f.key, label: f.key, value: f.bytes, text: formatBytes(f.bytes) }))}
              />
            </Section>
          ) : null}

          <Section title={`Service workers${s.serviceWorkers ? ` (${s.serviceWorkers.length})` : ""}`}>
            {!s.serviceWorkers?.length ? (
              <Empty>No service worker for this origin.</Empty>
            ) : (
              <ul className="list usage-list">
                {s.serviceWorkers.map((w) => (
                  <li key={w.scope}>
                    <div className="row">
                      <b className="mono grow ellipsis" title={w.script}>
                        {w.script.replace(s.origin, "") || w.script}
                      </b>
                      <span className="pill">{w.state}</span>
                    </div>
                    <span className="small muted">Scope {w.scope}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {s.errors.length ? (
            <details className="small muted">
              <summary>
                {s.errors.length} part{s.errors.length > 1 ? "s" : ""} could not be read
              </summary>
              <ul>
                {s.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="small muted" style={{ margin: 0 }}>
            Cache Storage sizes come from Content-Length or the body, up to 2,000 entries in all. Record counts are read without opening a
            version change.
          </p>
        </>
      ) : null}
    </>
  );
}
