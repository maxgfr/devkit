import { useMemo, useState } from "react";
import { browser } from "wxt/browser";
import {
  type Asset,
  type AssetKind,
  buildAssets,
  dataUrlBytes,
  filterAssets,
  sizeText,
  summarizeAssets,
  svgDataUrl,
  zipPath,
} from "../../lib/assets";
import { assetsMarkdown } from "../../lib/agent/security";
import { runInTab } from "../../lib/inject";
import { collectAssets, fetchInPage } from "../../lib/page/assets";
import { percent, shares } from "../../lib/viz";
import { type Part, Legend, SegmentBar } from "../charts";
import { Button, bytes, CopyButton, copyText, download, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { AccessGate, type PageCtx, useInPage, usePage } from "../page";

const KIND_COLOR: Record<AssetKind, string> = {
  image: "var(--viz-1)",
  background: "var(--viz-2)",
  svg: "var(--viz-3)",
  poster: "var(--viz-4)",
  icon: "var(--viz-5)",
  social: "var(--viz-other)",
};

const SHOWN = 60;
const ZIP_CAP = 300 * 1024 * 1024;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Whether devkit may read `asset` cross-origin from its own page (host access for its origin). */
const canFetch = (page: PageCtx, a: Asset) => page.access === "all" || (page.access === "site" && !a.crossOrigin);

/** The file's bytes: inline markup, data: URL, or a fetch from devkit (host access) then from the page itself. */
async function assetBlob(page: PageCtx, a: Asset): Promise<Blob> {
  if (a.truncated) throw new Error("too large to bring over from the page");
  if (a.markup !== undefined) return new Blob([a.markup], { type: "image/svg+xml" });
  const url = a.url ?? "";
  if (url.startsWith("data:")) {
    const d = dataUrlBytes(url);
    if (!d) throw new Error("unreadable data: URL");
    return new Blob([d.bytes], { type: d.type });
  }
  if (!url.startsWith("blob:")) {
    try {
      const res = await fetch(url, { credentials: canFetch(page, a) ? "include" : "omit", cache: "force-cache" });
      if (res.ok) return await res.blob();
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof Error && /^HTTP/.test(e.message)) throw e;
      /* CORS or network: the page may still read it */
    }
  }
  const inPage = page.tabId !== undefined ? await runInTab(page.tabId, fetchInPage, [url]).catch(() => null) : null;
  const d = inPage ? dataUrlBytes(inPage.dataUrl) : null;
  if (d) return new Blob([d.bytes], { type: inPage?.type || d.type });
  throw new Error(a.crossOrigin && page.access !== "all" ? `no access to ${hostOf(url)}` : "the file could not be read");
}

function thumbOf(a: Asset): string | null {
  if (a.truncated) return null;
  if (a.markup !== undefined) return svgDataUrl(a.markup);
  if (!a.url || a.url.startsWith("blob:") || a.status === "broken") return null;
  return a.url;
}

export function Assets() {
  const page = usePage();
  const toast = useToast();
  const snap = useInPage(collectAssets);
  const assets = useMemo(() => (snap.data ? buildAssets(snap.data) : []), [snap.data]);
  const summary = useMemo(() => summarizeAssets(assets), [assets]);
  const markdown = useMemo(
    () => (snap.data ? assetsMarkdown(assets, { url: snap.data.url, dpr: snap.data.dpr, capped: snap.data.capped }) : ""),
    [snap.data, assets],
  );
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [missingAlt, setMissingAlt] = useState(false);
  const [oversized, setOversized] = useState(false);
  const [broken, setBroken] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [zip, setZip] = useState<{ done: number; total: number } | null>(null);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[] | null>(null);

  const shown = useMemo(
    () => filterAssets(assets, { kind, missingAlt, oversized, broken, query }),
    [assets, kind, missingAlt, oversized, broken, query],
  );
  const filtered = shown.length !== assets.length;
  const foreignHosts = useMemo(() => [...new Set(assets.filter((a) => a.crossOrigin && a.url).map((a) => hostOf(a.url!)))], [assets]);

  const byBytes = summary.bytes > 0;
  const kindShares = shares(summary.kinds.map((k) => (byBytes ? k.bytes : k.count)));
  const parts: Part[] = summary.kinds.map((k, i) => ({
    key: k.kind,
    label: k.label,
    value: byBytes ? k.bytes : k.count,
    color: KIND_COLOR[k.kind],
    detail: `${k.count} · ${k.known ? bytes(k.bytes) : "–"}${byBytes && k.known ? ` · ${percent(kindShares[i]!)}` : ""}`,
  }));

  const downloadZip = async () => {
    const list = shown.filter((a) => a.status !== "broken");
    if (!list.length) return;
    setSkipped(null);
    setZip({ done: 0, total: list.length });
    const files: { name: string; data: Uint8Array }[] = [];
    const failed: { name: string; reason: string }[] = [];
    const used = new Set<string>();
    let size = 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < list.length) {
        const a = list[next++]!;
        try {
          if (size > ZIP_CAP) throw new Error("the zip reached 300 MB");
          const blob = await assetBlob(page, a);
          size += blob.size;
          files.push({ name: zipPath(a, used), data: new Uint8Array(await blob.arrayBuffer()) });
        } catch (e) {
          failed.push({ name: a.name, reason: e instanceof Error ? e.message : String(e) });
        }
        setZip({ done: ++done, total: list.length });
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (files.length) {
        const { zipStore } = await import("../../lib/zip");
        files.sort((x, y) => x.name.localeCompare(y.name));
        const host = page.origin ? new URL(page.origin).host.replace(/[^\w.-]+/g, "-") : "page";
        download(`${host}-assets.zip`, new Blob([zipStore(files)], { type: "application/zip" }));
      }
      toast(
        files.length
          ? `Zip of ${files.length} file${files.length === 1 ? "" : "s"}${failed.length ? `, ${failed.length} skipped` : ""}.`
          : "Nothing could be downloaded.",
        !files.length,
      );
      setSkipped(failed.length ? failed : null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setZip(null);
    }
  };

  const chips: { id: AssetKind | "all"; label: string; count: number }[] = [
    { id: "all", label: "All", count: assets.length },
    ...summary.kinds.map((k) => ({ id: k.kind, label: k.label, count: k.count })),
  ];

  return (
    <AccessGate>
      <ErrorText error={snap.error} />
      <Section
        title={snap.data ? `Assets (${summary.count}, ${bytes(summary.bytes)})` : "Assets"}
        actions={
          <>
            {markdown && !snap.loading ? <CopyButton text={markdown} label="Copy for agent" /> : null}
            <Button size="small" busy={snap.loading} onClick={snap.run}>
              Rescan
            </Button>
          </>
        }
        hint={
          snap.data
            ? "Bytes from Resource Timing. A dash means the size is hidden (another site, without Timing-Allow-Origin) or the file came from memory."
            : null
        }
      >
        {!snap.data && snap.loading ? <p className="muted">Scanning the page…</p> : null}
        {snap.data && !assets.length ? <Empty>No image, SVG, icon or background image on this page.</Empty> : null}
        {assets.length ? (
          <>
            <SegmentBar
              parts={parts}
              label={`${byBytes ? "Bytes" : "Assets"} by type: ${parts.map((p) => `${p.label} ${p.detail}`).join(", ")}`}
            />
            <Legend parts={parts} />
            {byBytes ? null : <div className="small muted">No byte counts available: the bar splits assets by count.</div>}
            {summary.oversized ? (
              <p className="small as-note">
                <span className="pill t-warn">{summary.oversized} oversized</span>{" "}
                {summary.wasted
                  ? `About ${bytes(summary.wasted)} more than even 2× screens need (estimate from pixel counts).`
                  : "Served larger than even 2× screens need."}
              </p>
            ) : null}
          </>
        ) : null}
        {snap.data?.capped ? (
          <Notice kind="warn">The page is very large: the scan stopped after {snap.data.scanned.toLocaleString()} elements.</Notice>
        ) : null}
        {foreignHosts.length && page.access !== "all" ? (
          <Notice kind="info">
            <span className="grow">
              {foreignHosts.length === 1 ? <b>{foreignHosts[0]}</b> : `${foreignHosts.length} other sites`} also serve
              {foreignHosts.length === 1 ? "s" : ""} assets here. devkit shows them, but downloading them needs access to{" "}
              {foreignHosts.length === 1 ? "that site" : "those sites"}.
            </span>
            <Button size="small" onClick={() => page.requestAccess("all")}>
              Allow on all sites
            </Button>
          </Notice>
        ) : null}
      </Section>

      {assets.length ? (
        <Section
          title={filtered ? `${shown.length} of ${assets.length}` : "Files"}
          actions={
            <Button size="small" variant="primary" busy={Boolean(zip)} disabled={!shown.length || Boolean(zip)} onClick={downloadZip}>
              {zip ? `Zipping ${zip.done}/${zip.total}` : filtered ? `Download ${shown.length} as zip` : "Download all as zip"}
            </Button>
          }
        >
          <div className="as-filters">
            <fieldset className="as-chips" aria-label="Type">
              {chips.map((c) => (
                <button key={c.id} type="button" className="as-chip" aria-pressed={kind === c.id} onClick={() => setKind(c.id)}>
                  {c.label} <span className="viz-num">{c.count}</span>
                </button>
              ))}
            </fieldset>
            <fieldset className="as-chips" aria-label="Flags">
              <FlagChip label="No alt" count={summary.missingAlt} on={missingAlt} set={setMissingAlt} />
              <FlagChip label="Oversized" count={summary.oversized} on={oversized} set={setOversized} />
              <FlagChip label="Broken" count={summary.broken} on={broken} set={setBroken} />
            </fieldset>
            <input
              type="search"
              placeholder="Filter by name, URL, alt or element"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {skipped ? (
            <Notice kind="warn">
              <span className="grow">
                Left out of the zip:{" "}
                {skipped
                  .slice(0, 4)
                  .map((s) => `${s.name} (${s.reason})`)
                  .join(", ")}
                {skipped.length > 4 ? ` and ${skipped.length - 4} more` : ""}.
              </span>
            </Notice>
          ) : null}
          {shown.length ? (
            <ul className="as-list">
              {(all ? shown : shown.slice(0, SHOWN)).map((a) => (
                <AssetRow key={a.key} asset={a} page={page} dpr={snap.data?.dpr ?? 1} />
              ))}
            </ul>
          ) : (
            <Empty>No asset matches these filters.</Empty>
          )}
          {!all && shown.length > SHOWN ? (
            <Button size="small" onClick={() => setAll(true)}>
              Show all {shown.length}
            </Button>
          ) : null}
        </Section>
      ) : null}
    </AccessGate>
  );
}

function FlagChip({ label, count, on, set }: { label: string; count: number; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" className="as-chip flag" aria-pressed={on} disabled={!count && !on} onClick={() => set(!on)}>
      {label} <span className="viz-num">{count}</span>
    </button>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  img: "img",
  input: "input",
  svg: "inline svg",
  background: "background",
  poster: "poster",
  favicon: "favicon",
  manifest: "manifest",
  social: "og / twitter",
};

function AssetRow({ asset: a, page, dpr }: { asset: Asset; page: PageCtx; dpr: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = thumbOf(a);
  const isData = a.url?.startsWith("data:") || a.url?.startsWith("blob:");

  const open = async () => {
    if (a.url && /^https?:/i.test(a.url)) return browser.tabs.create({ url: a.url, index: page.tab ? page.tab.index + 1 : undefined });
    try {
      const blob = await assetBlob(page, a);
      const url = URL.createObjectURL(blob);
      await browser.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast(`Could not open it: ${e instanceof Error ? e.message : e}.`, true);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      download(a.name, await assetBlob(page, a));
    } catch (e) {
      toast(`Could not download ${a.name}: ${e instanceof Error ? e.message : e}.`, true);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string, what: string) => toast((await copyText(text)) ? `${what} copied.` : "The clipboard refused the copy.");

  const o = a.oversize;
  return (
    <li className="as-item">
      <div className="as-thumb" aria-hidden="true">
        {thumb && !thumbFailed ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setThumbFailed(true)} />
        ) : (
          <span className="as-thumb-none">{a.status === "broken" ? "broken" : a.format || "?"}</span>
        )}
      </div>
      <div className="as-body">
        <div className="as-head">
          <span className="as-name" title={isData ? a.name : (a.url ?? a.name)}>
            {a.name}
          </span>
          <span className="pill as-format">{a.format || "image"}</span>
        </div>
        <div className="as-meta small">
          {a.natural ? (
            <span title="Intrinsic size → largest displayed size, CSS px">
              {sizeText(a.natural)}
              {a.rendered && a.kind !== "icon" && a.kind !== "social" ? ` → ${sizeText(a.rendered)}` : ""}
            </span>
          ) : a.rendered && a.rendered.width > 0 ? (
            <span title="Displayed size, CSS px">{sizeText(a.rendered)}</span>
          ) : null}
          {a.sizes ? <span>sizes {a.sizes}</span> : null}
          <span>{bytes(a.bytes)}</span>
          <span className="muted">
            {a.sources.map((s) => SOURCE_TEXT[s]).join(", ")}
            {a.uses > 1 ? ` ×${a.uses}` : ""}
          </span>
        </div>
        <div className="as-flags">
          {a.status === "broken" ? <span className="pill t-bad">Failed to load</span> : null}
          {a.status === "pending" ? <span className="pill">Not loaded yet (lazy)</span> : null}
          {o ? (
            <span
              className="pill t-warn"
              title={`${sizeText(a.natural)} served for ${sizeText(a.rendered)} CSS px, ${sizeText(o.need)} device px at ${dpr}× DPR${o.wasted ? `; about ${bytes(o.wasted)} more than a 2× screen needs` : ""}`}
            >
              Served {o.ratio}× larger than displayed
            </span>
          ) : null}
          {a.alt === "missing" ? (
            <span className="pill t-warn">{a.kind === "svg" ? "No accessible name" : "No alt"}</span>
          ) : a.alt === "decorative" ? (
            <span className="pill">Decorative</span>
          ) : a.alt === "present" ? (
            <span className="as-alt small" title={a.altText}>
              alt “{a.altText}”
            </span>
          ) : null}
          {a.hidden && a.status === "ok" && a.kind !== "icon" && a.kind !== "social" ? <span className="pill">Not displayed</span> : null}
        </div>
        <div className="as-actions">
          <Button size="small" variant="ghost" onClick={open} disabled={a.truncated}>
            Open
          </Button>
          {a.url && !isData ? (
            <Button size="small" variant="ghost" onClick={() => copy(a.url!, "URL")}>
              Copy URL
            </Button>
          ) : null}
          <Button size="small" variant="ghost" busy={busy} onClick={save} disabled={a.truncated || a.status === "broken"}>
            Download
          </Button>
          {a.markup !== undefined ? (
            <Button size="small" variant="ghost" onClick={() => copy(a.markup!, "SVG markup")} disabled={a.truncated}>
              Copy SVG
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
