import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { ALL_DATA } from "../../lib/actions";
import { consentJson, consentMarkdown } from "../../lib/agent/consent";
import { plural } from "../../lib/agent-md";
import {
  analyzeCapture,
  buildCapture,
  CATEGORY_LABEL,
  CHOICE_LABEL,
  CMP_GLOBALS,
  type CapturePhase,
  type Choice,
  type ConsentAnalysis,
  type ConsentCapture,
  type ConsentComparison,
  type ConsentFinding,
  type CookieInput,
  compareCaptures,
  cookieBaseline,
  MAX_CAPTURES,
  SETTLE_MS,
  type TrackerCategory,
  thirdPartySites,
  trackingHits,
} from "../../lib/consent";
import { readCookies } from "../../lib/cookie-jar";
import { dedupeCookies } from "../../lib/cookies-export";
import { consentSteps, normalizeEvents } from "../../lib/datalayer";
import { injectionError, runInTab } from "../../lib/inject";
import { collectConsentPage, probeConsentGlobals } from "../../lib/page/consent";
import { readDataLayer } from "../../lib/page/datalayer";
import { clearWebStorage } from "../../lib/page/toggles";
import { ALL_SITES, ensurePermission } from "../../lib/permissions";
import { siteOf } from "../../lib/security/third-party";
import { Button, CopyButton, Dot, download, Empty, Notice, Section, useToast } from "../components";
import { AccessGate, usePage } from "../page";

const storeKey = (tabId: number) => `consent.captures.${tabId}`;

const CAT_CLASS: Record<TrackerCategory, string> = { advertising: "t-bad", analytics: "t-warn", functional: "t-good", unknown: "" };

function CategoryPill({ category }: { category: TrackerCategory }) {
  return <span className={`pill ${CAT_CLASS[category]}`}>{CATEGORY_LABEL[category]}</span>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Resolves once the tab has started loading again and finished (or after `timeout`). Register before reloading. */
function waitForLoad(tabId: number, timeout = 30_000): Promise<void> {
  return new Promise((resolve) => {
    let started = false;
    const finish = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      else if (info.status === "complete" && started) finish();
    };
    const timer = setTimeout(finish, timeout);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/** The site's cookies and those of the third parties the page talks to, as far as Chrome shows them to devkit. */
async function readSiteCookies(url: string, sites: string[]): Promise<CookieInput[] | null> {
  if (!(await browser.permissions.contains({ permissions: ["cookies"] }))) return null;
  const site = siteOf(new URL(url).hostname);
  const lists = await Promise.all([
    readCookies({ url }),
    readCookies({ domain: site }).catch(() => []),
    ...sites.map((s) => readCookies({ domain: s }).catch(() => [])),
  ]);
  return dedupeCookies(lists.flat()) as CookieInput[];
}

async function capturePage(
  tabId: number,
  phase: CapturePhase,
  choice?: Choice,
  baseline?: Map<string, string> | null,
): Promise<ConsentCapture> {
  const errors: string[] = [];
  const page = await runInTab(tabId, collectConsentPage);
  const globals = await runInTab(tabId, probeConsentGlobals, [CMP_GLOBALS], "MAIN").catch((e) => {
    errors.push(`Page globals: ${injectionError(e)}`);
    return null;
  });
  const layer = await runInTab(tabId, readDataLayer, [], "MAIN").catch((e) => {
    errors.push(`dataLayer: ${injectionError(e)}`);
    return null;
  });
  const events = layer ? normalizeEvents(layer.layers) : [];
  const cookies = await readSiteCookies(page.url, thirdPartySites(page)).catch((e) => {
    errors.push(`Cookies: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  return buildCapture({
    phase,
    choice,
    at: Date.now(),
    page,
    globals,
    consent: consentSteps(events),
    googleTags: Boolean(layer && (layer.containers.length || events.some((e) => e.gtag))),
    cookies,
    baseline,
    thirdPartyCookies: await browser.permissions.contains({ origins: [ALL_SITES] }),
    errors,
  });
}

export function Consent() {
  const page = usePage();
  const toast = useToast();
  const [captures, setCaptures] = useState<ConsentCapture[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("accept");
  const tabId = page.tabId;

  useEffect(() => {
    setCaptures([]);
    if (tabId === undefined) return;
    const key = storeKey(tabId);
    browser.storage.session.get(key).then((r) => setCaptures((r[key] as ConsentCapture[] | undefined) ?? []));
  }, [tabId]);

  const save = async (next: ConsentCapture[]) => {
    const list = next.slice(-MAX_CAPTURES);
    setCaptures(list);
    if (tabId !== undefined) await browser.storage.session.set({ [storeKey(tabId)]: list }).catch(() => undefined);
  };

  const analyses = useMemo(() => captures.map(analyzeCapture), [captures]);
  const baseline = analyses.find((a) => a.capture.phase !== "after");
  const comparisons = useMemo<ConsentComparison[]>(
    () =>
      baseline
        ? analyses.filter((a) => a.capture.phase === "after").map((a) => compareCaptures(baseline, a, a.capture.choice ?? "other"))
        : [],
    [analyses, baseline],
  );
  const markdown = useMemo(() => (baseline ? consentMarkdown(baseline, comparisons) : ""), [baseline, comparisons]);

  const checkBeforeConsent = async () => {
    // First thing in the click: Chrome only shows the permission prompt during the user gesture.
    if (!(await ensurePermission({ permissions: ["browsingData", "cookies"] })))
      return toast("The check needs the browsingData and cookies permissions.", true);
    if (tabId === undefined || !page.origin) return;
    try {
      setStatus("Clearing this site's cookies and storage…");
      await runInTab(tabId, clearWebStorage).catch(() => undefined);
      await browser.browsingData.remove({ origins: [page.origin] }, ALL_DATA);
      // What other sites' cookies looked like before the load: tells those this load sets from earlier ones.
      const before = cookieBaseline((await readCookies({}).catch(() => [])) as CookieInput[]);
      setStatus("Reloading the page…");
      const loaded = waitForLoad(tabId);
      await browser.tabs.reload(tabId, { bypassCache: true });
      await loaded;
      setStatus(`Waiting ${SETTLE_MS / 1000} s for tags to settle…`);
      await sleep(SETTLE_MS);
      setStatus("Reading the page…");
      await save([await capturePage(tabId, "before", undefined, before)]);
    } catch (e) {
      toast(injectionError(e), true);
    } finally {
      setStatus(null);
    }
  };

  const captureCurrent = async () => {
    await ensurePermission({ permissions: ["cookies"] });
    if (tabId === undefined) return;
    try {
      setStatus("Reading the page…");
      await save([await capturePage(tabId, "current")]);
    } catch (e) {
      toast(injectionError(e), true);
    } finally {
      setStatus(null);
    }
  };

  const captureAfter = async () => {
    if (tabId === undefined || !baseline) return;
    try {
      setStatus("Reading the page…");
      const prior = new Map(baseline.capture.cookies.filter((c) => c.preexisting).map((c) => [`${c.domain}|${c.path}|${c.name}`, true]));
      const c = await capturePage(tabId, "after", choice);
      // Cookies the baseline already called "from earlier browsing" stay so when they are still there.
      const cookies = c.cookies.map((k) => (prior.has(`${k.domain}|${k.path}|${k.name}`) ? { ...k, preexisting: true } : k));
      await save([...captures, { ...c, cookies }]);
    } catch (e) {
      toast(injectionError(e), true);
    } finally {
      setStatus(null);
    }
  };

  const busy = status !== null;
  return (
    <AccessGate>
      <Section
        title="What loads before the banner"
        hint="What the site sets and loads before you answer its consent banner, and what changes after Accept or Reject. Classification is a heuristic: names and domains of well-known trackers."
      >
        <Notice kind="warn">
          <span>
            <b>Check before consent</b> clears this site's cookies (the whole registrable domain), local and session storage, IndexedDB,
            Cache Storage and service workers, then reloads the tab: you will be signed out of this site. Other sites' cookies are kept.
          </span>
        </Notice>
        <div className="row">
          <Button variant="primary" busy={busy} onClick={checkBeforeConsent} disabled={!page.origin}>
            Check before consent
          </Button>
          <Button busy={busy} onClick={captureCurrent}>
            Read current state
          </Button>
        </div>
        {status ? (
          <p className="muted small" role="status">
            {status}
          </p>
        ) : null}
      </Section>
      {baseline ? (
        <ConsentResults
          baseline={baseline}
          analyses={analyses}
          comparisons={comparisons}
          markdown={markdown}
          choice={choice}
          setChoice={setChoice}
          onCapture={captureAfter}
          busy={busy}
        />
      ) : (
        <Empty>
          Run <b>Check before consent</b> on a page you have not accepted yet, or <b>Read current state</b> to see what is there now.
        </Empty>
      )}
    </AccessGate>
  );
}

function FindingList({ findings }: { findings: ConsentFinding[] }) {
  if (!findings.length) return <Empty>Nothing to report.</Empty>;
  const rank = { bad: 0, warn: 1, good: 2, info: 3 } as const;
  return (
    <ul className="checks consent-findings">
      {[...findings]
        .sort((a, b) => rank[a.level] - rank[b.level])
        .map((f) => (
          <li key={f.id}>
            <Dot level={f.level} />
            <span className="label">{f.label}</span>
            <span className="detail small">
              <div className="muted">{f.detail}</div>
              {f.items?.length ? (
                <div className="mono break">
                  {f.items.slice(0, 20).join(" · ")}
                  {f.items.length > 20 ? ` · and ${f.items.length - 20} more` : ""}
                </div>
              ) : null}
            </span>
          </li>
        ))}
    </ul>
  );
}

function ConsentResults({
  baseline,
  analyses,
  comparisons,
  markdown,
  choice,
  setChoice,
  onCapture,
  busy,
}: {
  baseline: ConsentAnalysis;
  analyses: ConsentAnalysis[];
  comparisons: ConsentComparison[];
  markdown: string;
  choice: Choice;
  setChoice: (c: Choice) => void;
  onCapture: () => void;
  busy: boolean;
}) {
  const a = baseline;
  const c = a.capture;
  const host = (() => {
    try {
      return new URL(c.url).host;
    } catch {
      return c.url;
    }
  })();
  const live = a.cookies.filter((k) => !k.preexisting);
  const pre = a.cookies.filter((k) => k.preexisting);
  const signals = a.consentMode.signals.filter((s) => s.default !== undefined || s.update !== undefined);
  return (
    <>
      <Section
        title={c.phase === "before" ? "Before consent" : "Current state"}
        actions={
          <>
            <CopyButton text={markdown} label="Copy for agent" />
            <Button
              size="small"
              onClick={() =>
                download(`consent-${host.replace(/[^\w.-]+/g, "_")}.json`, consentJson(analyses, comparisons), "application/json")
              }
            >
              Download JSON
            </Button>
          </>
        }
        hint={`${host} · ${new Date(c.at).toLocaleTimeString()} · ${plural(live.length, "cookie")}, ${plural(a.storage.length, "storage key")}, ${plural(a.counts.thirdPartyHosts, "third-party host")}`}
      >
        {c.phase === "current" ? (
          <Notice>Current state, read without clearing anything: it may already include a choice you made earlier on this site.</Notice>
        ) : null}
        <div className="consent-counters">
          <span className={`pill ${a.counts.advertising ? "t-bad" : ""}`}>Advertising {a.counts.advertising}</span>
          <span className={`pill ${a.counts.analytics ? "t-warn" : ""}`}>Analytics {a.counts.analytics}</span>
          <span className="pill">Third-party hosts {a.counts.thirdPartyHosts}</span>
          <span className="pill">Banner {a.cmps.length ? a.cmps.map((x) => x.name).join(", ") : "none found"}</span>
        </div>
        <FindingList findings={a.findings} />
        {c.errors.length ? <Notice kind="warn">{c.errors.join(" · ")}</Notice> : null}
      </Section>

      <Section
        title="After your choice"
        hint="Answer the banner in the page (Accept, Reject or your own settings), then capture again: devkit compares it with the capture above."
      >
        <div className="row">
          <select aria-label="Your choice in the banner" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            <option value="accept">I accepted</option>
            <option value="reject">I rejected</option>
            <option value="other">Other choice</option>
          </select>
          <Button busy={busy} onClick={onCapture}>
            Capture now
          </Button>
        </div>
        {[...comparisons].reverse().map((k) => (
          <ComparisonView key={k.after.capture.id} comparison={k} />
        ))}
      </Section>

      <Section
        title="Consent Mode"
        hint="From gtag('consent', …) commands in the dataLayer. A signal the default leaves out counts as granted."
      >
        {signals.length ? (
          <div className="consent-table-wrap">
            <table className="consent-table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Default</th>
                  <th>Update</th>
                  <th>Now</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.signal}>
                    <td className="mono">{s.signal}</td>
                    <td>{s.default ?? "not set"}</td>
                    <td>{s.update ?? "–"}</td>
                    <td className={s.effective === "granted" ? "t-warn" : s.effective === "denied" ? "t-good" : ""}>{s.effective}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{a.googleTags ? "No Consent Mode command in the dataLayer." : "No Google tag and no Consent Mode command found."}</Empty>
        )}
        {a.consentMode.regional.length ? <p className="small muted">Default limited to: {a.consentMode.regional.join(", ")}</p> : null}
      </Section>

      <Section title="Consent banner" hint="Recognized from globals, scripts and cookies of known consent platforms (heuristic).">
        {a.cmps.length ? (
          <ul className="list">
            {a.cmps.map((x) => (
              <li key={x.id}>
                <b>{x.name}</b> <span className="small muted mono">{x.evidence.join(" · ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No known consent platform found.</Empty>
        )}
        {c.tcf?.present ? (
          <p className="small muted">
            IAB TCF API:{" "}
            {c.tcf.ping
              ? `CMP ${c.tcf.ping.cmpLoaded ? "loaded" : "not loaded"}, status ${c.tcf.ping.cmpStatus || "?"}`
              : "no answer to ping"}
            {c.tcf.ping?.gdprApplies !== undefined && c.tcf.ping?.gdprApplies !== null ? `, gdprApplies ${c.tcf.ping.gdprApplies}` : ""}
            {c.tcf.hasTcString === null ? "" : c.tcf.hasTcString ? ", consent string present" : ", no consent string yet"}
          </p>
        ) : null}
      </Section>

      <Section
        title={`Cookies (${live.length})`}
        hint={
          c.cookieSource === "document"
            ? "From document.cookie: HttpOnly and third-party cookies are missing without the cookies permission."
            : c.thirdPartyCookies
              ? "Names only, values are never read into the check."
              : "Names only. Third-party cookies show only with access to all sites."
        }
      >
        {live.length ? (
          <div className="consent-table-wrap">
            <table className="consent-table">
              <tbody>
                {live.map((k) => (
                  <tr key={`${k.domain}|${k.path}|${k.name}|${k.partitioned}`}>
                    <td className="mono break">{k.name}</td>
                    <td>
                      <CategoryPill category={k.category} />
                    </td>
                    <td className="small">
                      {k.vendor || <span className="muted">–</span>}
                      {k.note ? <div className="muted">{k.note}</div> : null}
                    </td>
                    <td className="small muted mono">
                      {k.firstParty ? "first party" : k.domain.replace(/^\./, "")}
                      {k.partitioned ? " · partitioned" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No cookie.</Empty>
        )}
        {pre.length ? (
          <details>
            <summary className="small">{plural(pre.length, "third-party cookie")} already in the browser (not counted)</summary>
            <p className="small mono break">{pre.map((k) => `${k.name} (${k.domain.replace(/^\./, "")})`).join(" · ")}</p>
          </details>
        ) : null}
      </Section>

      <Section title={`Storage keys (${a.storage.length})`} hint="localStorage and sessionStorage key names of the page's origin.">
        {a.storage.length ? (
          <div className="consent-table-wrap">
            <table className="consent-table">
              <tbody>
                {a.storage.map((k) => (
                  <tr key={`${k.area}|${k.key}`}>
                    <td className="mono break">{k.key}</td>
                    <td>
                      <CategoryPill category={k.category} />
                    </td>
                    <td className="small">{k.vendor || <span className="muted">–</span>}</td>
                    <td className="small muted">{k.area}Storage</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No key.</Empty>
        )}
      </Section>

      <Section
        title={`Requests (${a.requests.length} hosts)`}
        hint="From the top frame's resource timing since the page loaded (requests made inside iframes are not listed). Query strings are dropped, except Google's gcs consent flag."
      >
        <div className="consent-table-wrap">
          <table className="consent-table">
            <tbody>
              {a.requests.map((g) => (
                <tr key={`${g.host}|${g.vendor}|${g.category}`}>
                  <td className="mono break">
                    {g.host}
                    {g.firstParty ? <span className="pill accent">this site</span> : null}
                  </td>
                  <td>
                    <CategoryPill category={g.category} />
                  </td>
                  <td className="small">
                    {g.vendor || <span className="muted">–</span>}
                    {g.loader ? <div className="muted">Tag loader</div> : null}
                    {g.byShape ? <div className="muted">By URL shape</div> : null}
                  </td>
                  <td className="small muted">
                    {plural(g.count, "request")}
                    {g.deniedPings ? ` · ${g.deniedPings} denied ping${g.deniedPings > 1 ? "s" : ""}` : ""}
                    {trackingHits(g) && g.gcs.length ? ` · gcs ${g.gcs.join(", ")}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function ComparisonView({ comparison: k }: { comparison: ConsentComparison }) {
  return (
    <div className="consent-compare">
      <h3>
        Capture {CHOICE_LABEL[k.choice]} <span className="small muted">{new Date(k.after.capture.at).toLocaleTimeString()}</span>
      </h3>
      <FindingList findings={k.findings} />
      <ul className="small consent-diff">
        <li>
          Cookies added:{" "}
          {k.cookiesAdded.length ? (
            <span className="mono">{k.cookiesAdded.map((c) => `${c.name}${c.vendor ? ` (${c.vendor})` : ""}`).join(" · ")}</span>
          ) : (
            "none"
          )}
        </li>
        {k.cookiesRemoved.length ? (
          <li>
            Cookies removed: <span className="mono">{k.cookiesRemoved.map((c) => c.name).join(" · ")}</span>
          </li>
        ) : null}
        <li>
          Storage keys added:{" "}
          {k.storageAdded.length ? <span className="mono">{k.storageAdded.map((s) => s.key).join(" · ")}</span> : "none"}
        </li>
        <li>
          Hosts added:{" "}
          {k.requestsAdded.length ? (
            <span className="mono">{k.requestsAdded.map((g) => `${g.host}${g.vendor ? ` (${g.vendor})` : ""}`).join(" · ")}</span>
          ) : (
            "none"
          )}
        </li>
        {k.signals.map((s) => (
          <li key={s.signal}>
            Consent Mode <span className="mono">{s.signal}</span>: {s.before} → {s.after}
          </li>
        ))}
      </ul>
    </div>
  );
}
