// Network › Redirect path: every hop of the tab's last navigations (server redirects, the browser's internal ones,
// meta refresh and JavaScript redirects) with status, Location, timing and headers, and a tracer for any URL.
// The background records the chains (src/lib/redirects-bg.ts); this panel reads them from storage.session.
import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { redirectsMarkdown } from "../../lib/agent/redirects";
import { pageMetaRefresh } from "../../lib/page/redirects";
import { ALL_SITES, ensurePermission, hasPermission, type PermissionNeed } from "../../lib/permissions";
import {
  type Chain,
  chainMs,
  chainText,
  finalHop,
  type Hop,
  KIND_TEXT,
  parseRefresh,
  pickChain,
  REDIRECT_TRACE,
  REDIRECTS_KEY,
  type RedirectStore,
  redirectCount,
  redirectFindings,
  type TraceAnswer,
} from "../../lib/redirects";
import { Button, Checks, CopyButton, Empty, ErrorText, KV, msText, Notice, Section, useToast } from "../components";
import { useAsync } from "../hooks";
import { useNav } from "../nav";
import { useInPage, usePage } from "../page";

/** Watching a navigation needs its requests on every site it passes through. */
export const REDIRECTS_NEED: PermissionNeed = { permissions: ["webRequest", "webNavigation"], origins: [ALL_SITES] };

const WHY =
  "A redirect happens before the page exists, so devkit has to watch the tab's requests: it asks for webRequest and webNavigation, and access to all sites since a chain can cross any of them. It only reads: nothing is blocked, changed or sent anywhere, and the last 5 navigations of each tab stay in session memory until the browser closes.";

function useRedirectAccess() {
  const state = useAsync(() => hasPermission(REDIRECTS_NEED), []);
  useEffect(() => {
    const check = () => state.run();
    browser.permissions.onAdded.addListener(check);
    browser.permissions.onRemoved.addListener(check);
    return () => {
      browser.permissions.onAdded.removeListener(check);
      browser.permissions.onRemoved.removeListener(check);
    };
  }, [state.run]);
  return state.data;
}

function useTabChains(tabId: number | undefined): Chain[] {
  const [chains, setChains] = useState<Chain[]>([]);
  useEffect(() => {
    if (tabId === undefined) return setChains([]);
    const read = (store: RedirectStore | undefined) => setChains(store?.[tabId] ?? []);
    browser.storage.session.get(REDIRECTS_KEY).then((r) => read(r[REDIRECTS_KEY] as RedirectStore | undefined));
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "session" && REDIRECTS_KEY in changes) read(changes[REDIRECTS_KEY]!.newValue as RedirectStore | undefined);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [tabId]);
  return chains;
}

function statusLevel(hop: Hop): "good" | "warn" | "bad" | "info" {
  if (hop.error || hop.status >= 400 || hop.status === 0) return "bad";
  if (hop.status === 301 || hop.status === 308) return "info";
  if (hop.status >= 300 || hop.redirect) return "warn";
  return "good";
}

const kindLabel = (hop: Hop) =>
  hop.redirect === "js" ? "JavaScript redirect (heuristic: the page had no meta refresh)" : hop.redirect ? KIND_TEXT[hop.redirect] : "";

function HopRow({ hop, index }: { hop: Hop; index: number }) {
  const headers = Object.entries(hop.headers).sort(([a], [b]) => a.localeCompare(b));
  const reason = hop.statusLine?.replace(/^HTTP\/[\d.]+\s*\d*\s*/, "");
  const meta = [
    kindLabel(hop),
    hop.ms !== undefined ? msText(hop.ms) : "",
    hop.ip ? `IP ${hop.ip}` : "",
    hop.fromCache ? "from cache" : "",
  ].filter(Boolean);
  return (
    <li className="redir-hop">
      <div className="redir-head">
        <span className="redir-n" aria-hidden="true">
          {index + 1}
        </span>
        <span className={`pill redir-status t-${statusLevel(hop)}`} title={hop.statusLine}>
          {hop.error ? "Error" : hop.status || "–"}
          {reason ? <span className="redir-reason"> {reason}</span> : null}
        </span>
        <span className="redir-url mono">{hop.url}</span>
      </div>
      {meta.length ? <div className="redir-meta small muted">{meta.join(" · ")}</div> : null}
      {hop.error ? <div className="redir-meta small t-bad">{hop.error}</div> : null}
      {hop.location ? (
        <div className="redir-to small">
          <span aria-hidden="true">→</span> <span className="sr-only">Location:</span>
          <span className="mono">{hop.location}</span>
        </div>
      ) : null}
      {headers.length ? (
        <details className="redir-headers">
          <summary>Response headers ({headers.length})</summary>
          <KV rows={headers.map(([k, v]) => [k, v])} />
        </details>
      ) : null}
    </li>
  );
}

function ChainView({ chain }: { chain: Chain }) {
  const findings = useMemo(() => redirectFindings(chain), [chain]);
  const n = redirectCount(chain);
  const final = finalHop(chain);
  return (
    <div className="stack">
      <p className="small muted redir-summary" style={{ margin: 0 }}>
        {n} {n === 1 ? "redirect" : "redirects"} · {chain.hops.length} {chain.hops.length === 1 ? "hop" : "hops"} · {msText(chainMs(chain))}
        {final ? ` · final ${final.error ? "error" : `HTTP ${final.status}`}` : ""}
        {chain.dropped ? ` · ${chain.dropped} earlier hops not kept` : ""}
      </p>
      {chain.note ? <Notice kind="warn">{chain.note}</Notice> : null}
      <Checks checks={findings} />
      <ol className="redir-hops">
        {chain.hops.map((h, i) => (
          // Keyed by chain too, so an opened header list does not stay open on the next navigation's hop.
          // biome-ignore lint/suspicious/noArrayIndexKey: hops are positional within a chain
          <HopRow key={`${chain.id}-${chain.startedAt}-${i}`} hop={h} index={i} />
        ))}
      </ol>
    </div>
  );
}

function ChainActions({ chain, url }: { chain: Chain; url?: string }) {
  return (
    <>
      <CopyButton text={chainText(chain)} label="Copy chain" />
      <CopyButton text={redirectsMarkdown(chain, { url })} label="Copy for agent" />
    </>
  );
}

/** A meta refresh on the page that has not fired yet (a delay, or a page left open). */
function PendingRefresh() {
  const page = usePage();
  const meta = useInPage(pageMetaRefresh, [false]);
  const refresh = meta.data ? parseRefresh(meta.data.content, page.url) : null;
  if (!refresh) return null;
  return (
    <Notice kind="info">
      This page has a meta refresh:{" "}
      {refresh.url === page.url.split("#")[0] ? (
        "it reloads itself"
      ) : (
        <>
          it moves to <b className="mono">{refresh.url}</b>
        </>
      )}{" "}
      after {refresh.delay} s.
    </Notice>
  );
}

function Trace() {
  const page = usePage();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const run = async () => {
    // First thing in the gesture: Chrome only shows the prompt then.
    if (!(await ensurePermission(REDIRECTS_NEED))) return toast("Tracing needs webRequest and access to all sites.", true);
    let target: string;
    try {
      target = new URL(url.trim() || page.url).href;
      if (!/^https?:/.test(target)) throw new Error();
    } catch {
      return setError("Enter an http:// or https:// URL.");
    }
    setBusy(true);
    setError(null);
    try {
      const answer = (await browser.runtime.sendMessage({ type: REDIRECT_TRACE, url: target })) as TraceAnswer | undefined;
      if (!answer?.chain) throw new Error(answer?.error ?? "The background did not answer. Try again.");
      setChain(answer.chain);
    } catch (e) {
      setChain(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Trace a URL"
      actions={chain ? <ChainActions chain={chain} /> : null}
      hint="devkit requests the URL itself, with your cookies, and follows every redirect, Refresh header and meta refresh, up to 20. JavaScript redirects only run when a tab loads the page: open it in the tab to see them."
    >
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          type="url"
          className="grow"
          aria-label="URL to trace"
          placeholder={page.origin ? page.url : "https://example.com/old-page"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button variant="primary" type="submit" busy={busy}>
          Trace
        </Button>
      </form>
      <ErrorText error={error} />
      {chain ? <ChainView chain={chain} /> : null}
    </Section>
  );
}

export function Redirects() {
  const page = usePage();
  const toast = useToast();
  const granted = useRedirectAccess();
  const chains = useTabChains(page.tabId);
  const current = pickChain(chains, page.url) ?? chains[0];
  const earlier = chains.filter((c) => c !== current);
  const record = async () => {
    if (!(await ensurePermission(REDIRECTS_NEED)))
      return toast("Recording redirects needs webRequest, webNavigation and access to all sites.", true);
    if (page.tabId !== undefined) await browser.tabs.reload(page.tabId).catch(() => undefined);
  };
  return (
    <>
      <Section
        title="Redirect path"
        actions={
          granted ? (
            <>
              <Button size="small" onClick={record}>
                Reload and record
              </Button>
              {current ? <ChainActions chain={current} url={page.url} /> : null}
            </>
          ) : null
        }
        hint={granted ? "Every hop of the tab's navigation, as Chrome made it: status, Location, timing and response headers." : undefined}
      >
        {granted === false ? (
          <Notice kind="warn">
            <span className="grow">{WHY}</span>
            <Button variant="primary" onClick={record}>
              Allow and record
            </Button>
          </Notice>
        ) : null}
        {granted ? (
          current ? (
            <ChainView chain={current} />
          ) : (
            <Empty>No navigation recorded in this tab yet. Reload the page to record its path.</Empty>
          )
        ) : null}
        {page.canScript ? <PendingRefresh /> : null}
      </Section>
      {granted && earlier.length ? (
        <Section title={`Earlier in this tab (${earlier.length})`}>
          {earlier.map((c) => (
            <details key={c.id} className="redir-earlier">
              <summary>
                <span className="mono">{c.hops[0]?.url}</span>{" "}
                <span className="muted small">
                  {redirectCount(c)} {redirectCount(c) === 1 ? "redirect" : "redirects"} · final {finalHop(c)?.status ?? "–"}
                </span>
              </summary>
              <ChainView chain={c} />
            </details>
          ))}
        </Section>
      ) : null}
      <Trace />
    </>
  );
}

/** Shown in the Headers panel when the document answered through redirects. */
export function RedirectHint({ url }: { url: string }) {
  const go = useNav();
  return (
    <Notice kind="info">
      <span className="grow">
        This URL redirected to <span className="mono">{url}</span> before answering. Redirect path shows every hop with its status and
        headers.
      </span>
      {go ? (
        <Button size="small" onClick={() => go({ panel: "redirects" })}>
          Open Redirect path
        </Button>
      ) : null}
    </Notice>
  );
}
