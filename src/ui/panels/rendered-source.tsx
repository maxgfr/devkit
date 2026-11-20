// Served vs rendered: the HTML the server sends next to the DOM after JavaScript ran, reduced to what matters for
// SEO (what a crawler that does not render sees), with ranked findings, a field-by-field table, the lists of what
// JavaScript added or removed, a pretty-printed line diff of both sources, and Copy for agent.
import { type ReactNode, useMemo, useState } from "react";
import { renderedSourceMarkdown } from "../../lib/agent/rendered-source";
import { fetchServedHtml, readRenderedDom } from "../../lib/page/rendered-source";
import {
  type Change,
  type RenderDiff,
  parseHtml,
  prettyHtml,
  renderDiff,
  type SourceLine,
  seoSnapshot,
  sourceDiff,
} from "../../lib/rendered-source";
import { Button, bytes, Checks, CopyButton, download, Empty, ErrorText, Metric, Notice, Section } from "../components";
import { AccessGate, useInPage, usePage } from "../page";
import { Choice } from "./inspect";

/** Lines of source drawn at once; the rest is in the copy and the download. */
const MAX_LINES = 3000;

const CHANGE_TEXT: Record<Change, string> = {
  same: "same",
  added: "added by JS",
  removed: "removed by JS",
  changed: "changed by JS",
};
const CHANGE_CLASS: Record<Change, string> = { same: "", added: "t-warn", removed: "t-warn", changed: "t-warn" };

const n = (v: number) => v.toLocaleString("en-US");

const fileName = (url: string, side: string) => {
  let host = "page";
  try {
    host = new URL(url).host.replace(/[^\w.-]/g, "_") || "page";
  } catch {
    /* keep the default */
  }
  return `${host}-${side}.html`;
};

interface Computed {
  diff: RenderDiff;
  servedPretty: string;
  renderedPretty: string;
}

export function RenderedSource() {
  const page = usePage();
  const served = useInPage(fetchServedHtml);
  const rendered = useInPage(readRenderedDom);
  const s = served.data;
  const r = rendered.data;
  const computed = useMemo((): Computed | { error: unknown } | null => {
    if (!s?.ok || s.html === undefined || !r) return null;
    try {
      const url = r.url || page.url;
      const servedDoc = parseHtml(s.html);
      const renderedDoc = parseHtml(r.html);
      return {
        diff: renderDiff(seoSnapshot(servedDoc, url), seoSnapshot(renderedDoc, url)),
        servedPretty: prettyHtml(servedDoc),
        renderedPretty: prettyHtml(renderedDoc),
      };
    } catch (e) {
      return { error: e };
    }
  }, [s, r, page.url]);
  const notes = useMemo(() => {
    const out: string[] = [];
    if (s?.ok && s.redirected && s.url) out.push(`The re-fetch was redirected to ${s.url}.`);
    if (s?.ok && s.status && s.status >= 400) out.push(`The re-fetch answered HTTP ${s.status}.`);
    if (s?.ok && s.contentType && !/html/i.test(s.contentType)) out.push(`The re-fetch is not HTML (${s.contentType}).`);
    if (s?.truncated) out.push(`The served HTML was cut at ${bytes(s.html?.length ?? 0)} of ${bytes(s.length ?? 0)}.`);
    if (r?.truncated) out.push(`The rendered DOM was cut at ${bytes(r.html.length)} of ${bytes(r.length)}.`);
    return out;
  }, [s, r]);
  const diff = computed && "diff" in computed ? computed.diff : undefined;
  const agentMd = useMemo(
    () => (diff ? renderedSourceMarkdown(diff, { url: r?.url || page.url, notes }) : ""),
    [diff, notes, r?.url, page.url],
  );
  const loading = served.loading || rendered.loading;
  return (
    <AccessGate>
      <ErrorText error={served.error ?? rendered.error} />
      {s && !s.ok ? <Notice kind="bad">Could not fetch this URL again from the page: {s.error}</Notice> : null}
      {computed && "error" in computed ? <ErrorText error={computed.error} /> : null}
      {diff && computed && "diff" in computed ? (
        <>
          <Section
            title="Served vs rendered"
            hint="Served: this URL fetched again from the page, with its cookies, scripts not run: what a crawler that does not render JavaScript reads. Rendered: the DOM now, after JavaScript. A re-fetch can differ from the first load on personalized or A/B-tested pages."
            actions={
              <>
                <Button
                  size="small"
                  busy={loading}
                  onClick={() => {
                    served.run();
                    rendered.run();
                  }}
                >
                  Refresh
                </Button>
                <CopyButton text={agentMd} label="Copy for agent" />
              </>
            }
          >
            <div className="grid2">
              <Metric label="Served HTML" value={bytes(s?.length ?? 0)} />
              <Metric label="Rendered DOM" value={bytes(r?.length ?? 0)} />
              <Metric
                label="Words served / rendered"
                value={`${n(diff.words.served)} / ${n(diff.words.rendered)}`}
                level={diff.findings.some((f) => f.id === "content-js") ? "bad" : undefined}
              />
              <Metric
                label="Links only after JS"
                value={n(diff.links.added.length)}
                level={diff.links.added.some((l) => l.internal) ? "warn" : undefined}
              />
            </div>
            {notes.map((note) => (
              <Notice key={note} kind="warn">
                {note}
              </Notice>
            ))}
            <Checks checks={diff.findings.map((f) => ({ id: f.id, label: f.text, level: f.level, detail: f.detail }))} />
            <p className="muted small" style={{ margin: 0 }}>
              Heuristics: Google renders JavaScript (later, with a budget), most other crawlers and every share scraper do not.
            </p>
          </Section>
          <FieldTable diff={diff} />
          <Changes diff={diff} />
          <SourceView
            served={computed.servedPretty}
            rendered={computed.renderedPretty}
            rawServed={s?.html ?? ""}
            rawRendered={r?.html ?? ""}
            url={r?.url || page.url}
          />
        </>
      ) : (
        <Empty>{loading ? "Fetching the served HTML and reading the DOM…" : ""}</Empty>
      )}
    </AccessGate>
  );
}

function ChangeTag({ change }: { change: Change }) {
  return <span className={`pill ${CHANGE_CLASS[change]}`}>{CHANGE_TEXT[change]}</span>;
}

const shown = (v: string | null) =>
  v === null ? <span className="muted">none</span> : v === "" ? <span className="muted">empty</span> : v;

function FieldTable({ diff }: { diff: RenderDiff }) {
  const count = (added: number, removed: number, changed = 0): Change =>
    !added && !removed && !changed ? "same" : changed || (added && removed) ? "changed" : added ? "added" : "removed";
  const ldTypes = (list: RenderDiff["served"]["jsonLd"]) => [...new Set(list.flatMap((b) => (b.ok ? b.types : ["invalid"])))].join(", ");
  const internal = (s: RenderDiff["served"]) => s.links.filter((l) => l.internal).length;
  const rows: { label: string; served: ReactNode; rendered: ReactNode; change: Change }[] = [
    ...diff.fields.map((f) => ({ label: f.label, served: shown(f.served), rendered: shown(f.rendered), change: f.change })),
    {
      label: "Indexable",
      served: diff.served.index ? "yes" : "noindex",
      rendered: diff.rendered.index ? "yes" : "noindex",
      change: diff.served.index === diff.rendered.index ? "same" : "changed",
    },
    {
      label: "hreflang",
      served: n(diff.served.hreflang.length),
      rendered: n(diff.rendered.hreflang.length),
      change: count(diff.hreflang.added.length, diff.hreflang.removed.length),
    },
    {
      label: "Open Graph / Twitter",
      served: n(diff.served.social.length),
      rendered: n(diff.rendered.social.length),
      change: count(diff.social.added.length, diff.social.removed.length, diff.social.changed.length),
    },
    {
      label: "JSON-LD",
      served: `${n(diff.served.jsonLd.length)}${diff.served.jsonLd.length ? ` (${ldTypes(diff.served.jsonLd)})` : ""}`,
      rendered: `${n(diff.rendered.jsonLd.length)}${diff.rendered.jsonLd.length ? ` (${ldTypes(diff.rendered.jsonLd)})` : ""}`,
      change: count(diff.jsonLd.added.length, diff.jsonLd.removed.length, diff.jsonLd.changed.length),
    },
    {
      label: "Headings",
      served: n(diff.served.headings.length),
      rendered: n(diff.rendered.headings.length),
      change: count(diff.headings.added.length, diff.headings.removed.length),
    },
    {
      label: "Links (internal)",
      served: `${n(diff.served.links.length)} (${n(internal(diff.served))})`,
      rendered: `${n(diff.rendered.links.length)} (${n(internal(diff.rendered))})`,
      change: count(diff.links.added.length, diff.links.removed.length, diff.links.relChanged.length),
    },
    {
      label: "Images",
      served: n(diff.served.images.length),
      rendered: n(diff.rendered.images.length),
      change: count(diff.images.added.length, diff.images.removed.length),
    },
    {
      label: "Words",
      served: n(diff.words.served),
      rendered: n(diff.words.rendered),
      change: diff.words.served === diff.words.rendered ? "same" : diff.words.rendered > diff.words.served ? "added" : "removed",
    },
  ];
  return (
    <Section title="Field by field">
      <div className="rsrc-scroll">
        <table className="rsrc-table">
          <thead>
            <tr>
              <th scope="col">Signal</th>
              <th scope="col">Served</th>
              <th scope="col">Rendered</th>
              <th scope="col">
                <span className="sr-only">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={row.change === "same" ? undefined : "rsrc-diff"}>
                <th scope="row">{row.label}</th>
                <td>{row.served}</td>
                <td>{row.rendered}</td>
                <td>
                  <ChangeTag change={row.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Group({ title, items }: { title: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <details className="rsrc-group" open={items.length <= 12}>
      <summary>
        {title} <span className="pill">{n(items.length)}</span>
      </summary>
      <ul className="rsrc-list">
        {items.slice(0, 200).map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <li key={i}>{it}</li>
        ))}
        {items.length > 200 ? <li className="muted">… and {n(items.length - 200)} more</li> : null}
      </ul>
    </details>
  );
}

function Changes({ diff }: { diff: RenderDiff }) {
  const types = (b: { ok: boolean; types: string[] }) => (b.ok ? b.types.join(", ") || "no @type" : "invalid JSON");
  const link = (l: { href: string; text: string; rel: string; internal: boolean }) => (
    <>
      <span className="mono">{l.href}</span>
      {l.text ? <span className="muted"> · {l.text}</span> : null}
      {l.rel ? <span className="pill">{l.rel}</span> : null}
      <span className="pill">{l.internal ? "internal" : "external"}</span>
    </>
  );
  const mono = (t: string) => <span className="mono">{t}</span>;
  const pair = (key: string, before: string, after?: string) => (
    <>
      <span className="mono">{key}</span> <span className="muted">{after === undefined ? before : `${before} →`}</span>
      {after === undefined ? null : ` ${after}`}
    </>
  );
  const groups: { title: string; items: ReactNode[] }[] = [
    { title: "Links added by JavaScript", items: diff.links.added.map(link) },
    { title: "Links removed by JavaScript", items: diff.links.removed.map(link) },
    {
      title: "Link rel changed by JavaScript",
      items: diff.links.relChanged.map((l) => pair(l.href, l.served || "no rel", l.rendered || "no rel")),
    },
    { title: "JSON-LD added by JavaScript", items: diff.jsonLd.added.map(types) },
    { title: "JSON-LD removed by JavaScript", items: diff.jsonLd.removed.map(types) },
    { title: "JSON-LD changed by JavaScript", items: diff.jsonLd.changed.map((c) => types(c.rendered)) },
    { title: "Share tags added by JavaScript", items: diff.social.added.map((t) => pair(t.key, t.value)) },
    { title: "Share tags changed by JavaScript", items: diff.social.changed.map((t) => pair(t.key, t.served, t.rendered)) },
    { title: "Share tags removed by JavaScript", items: diff.social.removed.map((t) => mono(t.key)) },
    { title: "hreflang added by JavaScript", items: diff.hreflang.added.map((h) => `${h.lang} → ${h.href}`) },
    { title: "hreflang removed by JavaScript", items: diff.hreflang.removed.map((h) => `${h.lang} → ${h.href}`) },
    { title: "Headings added by JavaScript", items: diff.headings.added.map((h) => `h${h.level} ${h.text}`) },
    { title: "Headings removed by JavaScript", items: diff.headings.removed.map((h) => `h${h.level} ${h.text}`) },
    { title: "Images added by JavaScript", items: diff.images.added.map((i) => mono(i.src)) },
    { title: "Images removed by JavaScript", items: diff.images.removed.map((i) => mono(i.src)) },
  ].filter((g) => g.items.length);
  return (
    <Section title="Added and removed by JavaScript">
      {groups.length ? (
        groups.map((g) => <Group key={g.title} title={g.title} items={g.items} />)
      ) : (
        <Empty>No link, structured data, share tag, hreflang, heading or image differs.</Empty>
      )}
    </Section>
  );
}

type View = "diff" | "served" | "rendered";

function SourceView({
  served,
  rendered,
  rawServed,
  rawRendered,
  url,
}: {
  served: string;
  rendered: string;
  rawServed: string;
  rawRendered: string;
  url: string;
}) {
  const [view, setView] = useState<View>("diff");
  const result = useMemo(() => (view === "diff" ? sourceDiff(served, rendered) : null), [view, served, rendered]);
  const text = view === "served" ? served : rendered;
  const plain = view === "diff" ? [] : text.split("\n");
  const lines: SourceLine[] =
    view === "diff" ? (result?.lines ?? []) : plain.slice(0, MAX_LINES).map((t, i) => ({ kind: "same", text: t, a: i + 1 }));
  const total = view === "diff" ? lines.length : plain.length;
  return (
    <Section
      title="Source"
      hint="Both sides parsed and printed the same way, one tag per line, so the diff shows what differs in the DOM, not in the formatting. Downloads are the raw text."
      actions={
        <>
          <CopyButton text={served} label="Copy served" />
          <CopyButton text={rendered} label="Copy rendered" />
          <Button size="small" onClick={() => download(fileName(url, "served"), rawServed, "text/html")}>
            Download served
          </Button>
          <Button size="small" onClick={() => download(fileName(url, "rendered"), rawRendered, "text/html")}>
            Download rendered
          </Button>
        </>
      }
    >
      <Choice<View>
        label="Show"
        value={view}
        options={[
          ["diff", "Diff"],
          ["served", "Served"],
          ["rendered", "Rendered"],
        ]}
        onChange={setView}
      />
      {result?.tooLarge ? (
        <Notice kind="warn">Too many changed lines to diff here. Download both sides and compare them in your editor.</Notice>
      ) : null}
      {result && !result.tooLarge ? (
        <div className="small">
          <span className="t-good">+{n(result.added)}</span> <span className="t-bad">−{n(result.removed)}</span>{" "}
          <span className="muted">lines added and removed by JavaScript</span>
        </div>
      ) : null}
      {result && !result.tooLarge && !result.added && !result.removed ? <Empty>The two sources are the same.</Empty> : null}
      {lines.length ? (
        <div className="diff card rsrc-source">
          {lines.slice(0, MAX_LINES).map((l, i) =>
            l.kind === "skip" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: line order
              <div key={i} className="rsrc-skip">
                ⋯ {n(l.count)} unchanged {l.count === 1 ? "line" : "lines"}
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: line order
              <div key={i} className={l.kind}>
                {view === "diff" ? (l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  ") : ""}
                {l.text}
              </div>
            ),
          )}
        </div>
      ) : null}
      {total > MAX_LINES ? (
        <p className="muted small" style={{ margin: 0 }}>
          Showing the first {n(MAX_LINES)} of {n(total)} lines: copy or download for the rest.
        </p>
      ) : null}
    </Section>
  );
}
