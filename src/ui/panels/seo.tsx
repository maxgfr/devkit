// SEO & meta: counters, issues, meta lengths, Open Graph / Twitter checklist and per-network previews, hreflang,
// images and links, indexability and the headings, with a human-readable report and Copy for agent.
import { useMemo, useState } from "react";
import { seoMarkdown } from "../../lib/agent/inspect";
import type { Level } from "../../lib/headers";
import { hreflangReport, RETURN_LINKS_NOTE } from "../../lib/hreflang";
import { collectMeta, type MetaSnapshot } from "../../lib/page/collect";
import {
  indexability,
  linkHref,
  metaValue,
  pageCounts,
  type RobotsVerdict,
  robotsText,
  type SeoCounters,
  seoCounters,
  seoIssues,
  seoReport,
  seoTextReport,
} from "../../lib/seo";
import { EXTERNAL_TOOLS, isAllowed, parseRobots } from "../../lib/site-files";
import {
  imageChecks,
  LENGTH_LIMITS,
  lengthCount,
  NETWORKS,
  type Network,
  networkCard,
  type SocialMistake,
  socialChecklist,
  socialMistakes,
  type TagState,
} from "../../lib/social";
import { Button, Checks, CopyButton, Dot, Empty, ErrorText, Highlight, KV, Metric, Notice, Section } from "../components";
import { useAsync, useStored } from "../hooks";
import { useNav } from "../nav";
import { AccessGate, useInPage, usePage } from "../page";
import { Choice, fetchText, useHeaders } from "./inspect";

const n = (v: number) => v.toLocaleString("en-US");

/** "60/60" next to a value, warned past the limit. */
function Count({ text, max }: { text: string | undefined; max: number }) {
  const c = lengthCount(text, max);
  return (
    <span className={`pill seo-count${c.over ? " t-warn" : ""}`} title={`${c.length} characters, about ${max} shown`}>
      {c.length}/{max}
    </span>
  );
}

function Counters({ c }: { c: SeoCounters }) {
  const issues = c.issues;
  return (
    <div className="grid2 seo-counters">
      <Metric label="Issues" value={issues} level={issues ? "warn" : "good"} />
      <Metric label="Words" value={c.words === null ? "–" : n(c.words)} />
      <Metric label="Headings" value={n(c.headings)} />
      <Metric
        label="Images"
        value={
          c.images ? (
            <>
              {n(c.images.total)}
              {c.images.missingAlt ? <small className="t-warn"> {n(c.images.missingAlt)} ✕ alt</small> : null}
            </>
          ) : (
            "–"
          )
        }
      />
      <Metric
        label="Links"
        value={
          c.links ? (
            <>
              {n(c.links.total)}{" "}
              <small className="muted">
                {n(c.links.internal)} · {n(c.links.external)}
              </small>
            </>
          ) : (
            "–"
          )
        }
      />
    </div>
  );
}

const TAG_MARK: Record<TagState["state"], Level> = { set: "good", fallback: "info", missing: "bad" };

function TagList({ title, tags, missingLevel = "bad" }: { title: string; tags: TagState[]; missingLevel?: Level }) {
  return (
    <div className="seo-tags">
      <div className="small muted">{title}</div>
      <ul className="checks">
        {tags.map((t) => (
          <li key={t.key}>
            <Dot level={t.state === "missing" ? missingLevel : TAG_MARK[t.state]} />
            <span className="label mono">{t.key}</span>
            <span className="detail">
              {t.state === "set" ? t.value : t.state === "fallback" ? `fallback from ${t.from}: ${t.value}` : "missing"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const asChecks = (list: SocialMistake[]) => list.map((m) => ({ id: m.id, label: "", level: m.level, detail: m.text }));

/** The share card of one network. The image is requested only after "Load preview image" (privacy). */
function SocialPreview({ snap }: { snap: MetaSnapshot }) {
  const [network, setNetwork] = useStored<Network>("seoNetwork", "facebook");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const spec = NETWORKS.find((x) => x.id === network) ?? NETWORKS[0]!;
  const size = measured && measured.src === loaded ? measured : undefined;
  const card = networkCard(snap, spec, size);
  const checklist = socialChecklist(snap);
  const mistakes = socialMistakes(snap);
  const showImage = card.image && loaded === card.image;
  const imgChecks = size
    ? imageChecks(size, { width: metaValue(snap, "og:image:width"), height: metaValue(snap, "og:image:height") })
    : null;
  let imageHost = "";
  try {
    imageHost = card.image ? new URL(card.image).host : "";
  } catch {
    /* shown as is */
  }
  const image = (
    <div
      className={`social-img${card.layout === "small" ? " thumb" : ""}`}
      style={card.layout === "large" ? { aspectRatio: card.ratio } : undefined}
    >
      {!card.image ? (
        <span className="small muted">No og:image set.</span>
      ) : failed === card.image ? (
        <span className="small muted break">The image does not load: {card.image}</span>
      ) : showImage ? (
        <img
          src={card.image}
          alt=""
          onLoad={(e) => setMeasured({ src: card.image!, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => setFailed(card.image!)}
        />
      ) : (
        <span className="small muted">{card.ratioText}</span>
      )}
    </div>
  );
  return (
    <Section
      title={`Social (Open Graph / Twitter) · ${checklist.score}/5`}
      actions={
        card.image && !showImage ? (
          <Button size="small" onClick={() => setLoaded(card.image!)} title={`Requests the image from ${imageHost}`}>
            Load preview image
          </Button>
        ) : null
      }
      hint={
        card.image && !showImage
          ? `The image is not requested until you load it (it comes from ${imageHost}).`
          : "Truncation limits are approximate: each network cuts in pixels and changes its layout."
      }
    >
      <Choice
        label="Preview"
        value={network}
        options={NETWORKS.map((x) => [x.id, x.name] as [Network, string])}
        onChange={(v) => {
          setNetwork(v);
        }}
      />
      <div className={`social net-${spec.id} ${card.layout}`} data-network={spec.id}>
        {card.layout === "large" ? image : null}
        <div className="body">
          {spec.id === "facebook" ? <div className="site">{card.domain}</div> : null}
          {spec.id === "slack" ? <div className="site-name">{card.site}</div> : null}
          <b className="title">{card.title}</b>
          {card.description ? <div className="small muted desc">{card.description}</div> : null}
          {spec.id !== "facebook" ? <div className="site">{card.domain}</div> : null}
        </div>
        {card.layout === "small" ? image : null}
      </div>
      <div className="row small muted">
        <span>
          Image ratio {card.ratioText} · {card.layout === "large" ? "large image" : "small thumbnail"}
        </span>
        {card.titleCut || card.descriptionCut ? <span className="t-warn">Cut by {spec.name}</span> : null}
      </div>
      {imgChecks ? <Checks checks={asChecks(imgChecks)} /> : null}
      <KV
        rows={[
          [
            "og:title",
            <span key="t" className="row">
              <Count text={metaValue(snap, "og:title")} max={LENGTH_LIMITS["og:title"]} />
              <span className="grow">{metaValue(snap, "og:title") ?? <span className="muted">missing</span>}</span>
            </span>,
          ],
          [
            "og:description",
            <span key="d" className="row">
              <Count text={metaValue(snap, "og:description")} max={LENGTH_LIMITS["og:description"]} />
              <span className="grow">{metaValue(snap, "og:description") ?? <span className="muted">missing</span>}</span>
            </span>,
          ],
        ]}
      />
      {mistakes.length ? <Checks checks={asChecks(mistakes)} /> : null}
      <div className="seo-tag-grid">
        <TagList title="Essential tags" tags={checklist.essential} />
        <TagList title="Recommended" tags={checklist.recommended} missingLevel="info" />
        <TagList title="Twitter / X (with Open Graph fallback)" tags={checklist.twitter} missingLevel="warn" />
      </div>
    </Section>
  );
}

function Hreflang({ snap }: { snap: MetaSnapshot }) {
  const r = hreflangReport(snap.links, snap.url, linkHref(snap, "canonical"));
  if (!r.entries.length) return null;
  const valid = r.entries.filter((e) => !e.problems.some((p) => p.level === "bad" || p.level === "warn")).length;
  return (
    <Section
      title={`hreflang (${r.entries.length})`}
      actions={
        <div className="row small">
          <span className={`pill ${valid === r.entries.length ? "t-good" : "t-warn"}`}>
            {valid}/{r.entries.length}
          </span>
          <span className={`pill ${r.xDefault ? "t-good" : ""}`}>{r.xDefault ? "x-default" : "no x-default"}</span>
          <span className={`pill ${r.selfReference ? "t-good" : "t-warn"}`}>
            {r.selfReference ? "Self-reference" : "No self-reference"}
          </span>
          <span className="pill">{r.languages === 1 ? "1 language" : `${r.languages} languages`}</span>
        </div>
      }
    >
      <div className="md-table">
        <table className="seo-hreflang">
          <tbody>
            {r.entries.map((e, i) => {
              const bad = e.problems.some((p) => p.level === "bad" || p.level === "warn");
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: entries can repeat (duplicates are a finding)
                <tr key={i}>
                  <td>
                    <Dot level={bad ? "bad" : "good"} />
                  </td>
                  <td className="mono" title={e.name}>
                    {e.lang || "(empty)"}
                  </td>
                  <td className="break">
                    <a href={e.href} target="_blank" rel="noreferrer" className="mono">
                      {e.raw}
                    </a>
                    {e.self ? <span className="pill accent"> this page</span> : null}
                    {e.problems.map((p) => (
                      <div key={p.text} className={`small t-${p.level}`}>
                        {p.text}
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {r.problems.length ? (
        <Checks checks={r.problems.map((p, i) => ({ id: String(i), label: "", level: p.level, detail: p.text }))} />
      ) : null}
      <p className="small muted" style={{ margin: 0 }}>
        {RETURN_LINKS_NOTE}
      </p>
    </Section>
  );
}

function Headings({ snap }: { snap: MetaSnapshot }) {
  const go = useNav();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = snap.headings.filter((h) => !q || h.text.toLowerCase().includes(q) || `h${h.level}` === q);
  return (
    <Section
      title={`Headings (${snap.headings.length})`}
      actions={
        go ? (
          <Button size="small" onClick={() => go({ panel: "headings" })}>
            Open the outline
          </Button>
        ) : null
      }
    >
      {snap.headings.length ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            {[1, 2, 3, 4, 5, 6]
              .map((l) => [l, snap.headings.filter((h) => h.level === l).length] as const)
              .filter(([, c]) => c)
              .map(([l, c]) => `h${l} ×${c}`)
              .join(" · ")}
            {snap.headings[0] ? (
              <span className="muted">
                {" "}
                · first: h{snap.headings[0].level} "{snap.headings[0].text.slice(0, 60) || "(empty)"}"
              </span>
            ) : null}
          </p>
          <details className="seo-details" open={Boolean(q)}>
            <summary className="small muted">All headings</summary>
            <input
              type="search"
              placeholder="Search headings"
              aria-label="Search headings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {list.length ? (
              <ul className="seo-headings">
                {list.slice(0, 500).map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: headings can repeat
                  <li key={i} style={{ paddingLeft: (h.level - 1) * 12 }}>
                    <span className="pill">h{h.level}</span> <Highlight text={h.text || "(empty)"} query={query} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No heading matches.</Empty>
            )}
          </details>
        </>
      ) : (
        <Empty>No heading.</Empty>
      )}
    </Section>
  );
}

export function Seo() {
  const page = usePage();
  const meta = useInPage(collectMeta);
  const headers = useHeaders();
  const snap = meta.data;
  const robots = useAsync(async (): Promise<RobotsVerdict | null> => {
    if (!page.origin || !page.canScript || !page.url) return null;
    const r = await fetchText(`${page.origin}/robots.txt`);
    const u = new URL(page.url);
    if (r.status >= 400) return { status: r.status, allowed: r.status < 500 };
    return { status: r.status, ...isAllowed(parseRobots(r.text), "Googlebot", `${u.pathname}${u.search}`) };
  }, [page.origin, page.url, page.canScript]);
  const checks = useMemo(() => (snap ? seoReport(snap) : []), [snap]);
  const issues = useMemo(() => seoIssues(checks), [checks]);
  const agentMd = useMemo(() => (snap ? seoMarkdown(snap, { url: snap.url }) : ""), [snap]);
  const report = useMemo(
    () => (snap ? seoTextReport(snap, { headers: headers.data, robots: robots.data }) : ""),
    [snap, headers.data, robots.data],
  );
  const tool = (name: string) => EXTERNAL_TOOLS.find((t) => t.name === name);
  return (
    <AccessGate>
      <ErrorText error={meta.error} />
      {snap ? (
        <>
          <Section
            title="SEO checks"
            actions={
              <>
                <Button
                  size="small"
                  onClick={() => {
                    meta.run();
                    headers.run();
                    robots.run();
                  }}
                >
                  Refresh
                </Button>
                <CopyButton text={report} label="Copy report" />
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            }
          >
            <Counters c={seoCounters(snap, checks)} />
            {issues.length ? <Checks checks={issues} /> : <Notice kind="good">No issue found.</Notice>}
            <details className="seo-details">
              <summary className="small muted">All checks ({checks.length})</summary>
              <Checks checks={checks} />
            </details>
            <div className="row small">
              <span className="muted">Test in</span>
              {["PageSpeed Insights", "W3C HTML validator"].map((name) => {
                const t = tool(name);
                return t ? (
                  <a key={name} className="btn small" href={t.url(snap.url)} target="_blank" rel="noreferrer">
                    {name === "W3C HTML validator" ? "W3C" : "PageSpeed"}
                  </a>
                ) : null;
              })}
            </div>
          </Section>
          <MetaSection snap={snap} />
          <SocialPreview key={snap.url} snap={snap} />
          <Headings snap={snap} />
          <Hreflang snap={snap} />
          <ImagesLinks snap={snap} />
          <Section title="Indexability">
            <IndexabilityRows snap={snap} headers={headers} robots={robots} />
          </Section>
          <Section title={`Meta tags (${snap.meta.length})`}>
            <details className="seo-details">
              <summary className="small muted">Show all</summary>
              <KV rows={snap.meta.map((m) => [m.key, m.value])} />
            </details>
          </Section>
          <Section title={`Links in <head> (${snap.links.length})`}>
            <details className="seo-details">
              <summary className="small muted">Show all</summary>
              <KV
                rows={snap.links.map((l) => [`${l.rel}${l.hreflang ? ` (${l.hreflang})` : ""}${l.sizes ? ` ${l.sizes}` : ""}`, l.href])}
              />
            </details>
          </Section>
        </>
      ) : (
        <Empty>{meta.loading ? "Reading the page…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

function MetaSection({ snap }: { snap: MetaSnapshot }) {
  const desc = metaValue(snap, "description");
  const none = (s: string) => <span className="muted">{s}</span>;
  return (
    <Section title="Meta">
      <KV
        rows={[
          [
            "Title",
            <span key="t" className="row">
              <Count text={snap.title} max={LENGTH_LIMITS.title} />
              <span className="grow">{snap.title.trim() || none("missing")}</span>
            </span>,
          ],
          [
            "Meta description",
            <span key="d" className="row">
              <Count text={desc} max={LENGTH_LIMITS.description} />
              <span className="grow">{desc?.trim() || none("missing")}</span>
            </span>,
          ],
          ["Canonical", linkHref(snap, "canonical") ?? none("none")],
          ["Robots (meta)", metaValue(snap, "robots") ?? none("not set (index, follow)")],
          ["Viewport", metaValue(snap, "viewport") ?? none("missing")],
          ["Language", snap.lang || none("not set")],
        ]}
      />
    </Section>
  );
}

function ImagesLinks({ snap }: { snap: MetaSnapshot }) {
  if (!snap.content) return null;
  const c = pageCounts(snap.content, snap.url);
  return (
    <Section
      title="Images · Links"
      hint='Internal links share the page’s hostname (a leading "www." aside); other subdomains count as external.'
    >
      <div className="grid2 seo-stats">
        <Metric label="Images" value={n(c.images.total)} />
        <Metric label="Missing alt" value={n(c.images.missingAlt)} level={c.images.missingAlt ? "warn" : undefined} />
        <Metric label="Without title" value={n(c.images.withoutTitle)} />
        <Metric label="Links" value={n(c.links.total)} />
        <Metric label="Internal" value={n(c.links.internal)} />
        <Metric label="External" value={n(c.links.external)} />
        <Metric label="Unique" value={n(c.links.unique)} />
        <Metric label="Nofollow" value={n(c.links.nofollow)} />
      </div>
    </Section>
  );
}

function IndexabilityRows({
  snap,
  headers,
  robots,
}: {
  snap: MetaSnapshot;
  headers: ReturnType<typeof useHeaders>;
  robots: { data: RobotsVerdict | null | undefined; loading: boolean; error: unknown };
}) {
  const ix = indexability(snap, headers.data?.headers);
  const reading = <span className="muted">Reading…</span>;
  const notRead = <span className="muted">Not read</span>;
  return (
    <ul className="checks">
      <li>
        <Dot level={ix.index ? "good" : "bad"} />
        <span className="label">Indexability</span>
        <span className="detail">
          <b>
            {ix.index ? "index" : "noindex"}, {ix.follow ? "follow" : "nofollow"}
          </b>{" "}
          <span className="muted">
            {ix.sources.length ? ix.sources.map((s) => `${s.source}: ${s.value}`).join(" · ") : "no robots meta, no X-Robots-Tag"}
            {headers.loading ? " · reading X-Robots-Tag…" : headers.error ? " · X-Robots-Tag not read" : ""}
          </span>
        </span>
      </li>
      <li>
        <Dot level={robots.data ? (robots.data.allowed ? "good" : "bad") : "info"} />
        <span className="label">robots.txt (Googlebot)</span>
        <span className="detail">{robots.data ? robotsText(robots.data) : robots.loading ? reading : notRead}</span>
      </li>
      <li>
        <Dot level={headers.data ? (headers.data.status < 300 ? "good" : headers.data.status < 400 ? "warn" : "bad") : "info"} />
        <span className="label">HTTP status</span>
        <span className="detail">
          {headers.data
            ? `${headers.data.status}${headers.data.redirected ? ` (redirected to ${headers.data.url})` : ""}`
            : headers.loading
              ? reading
              : notRead}
        </span>
      </li>
    </ul>
  );
}
