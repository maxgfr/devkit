// "Copy for agent" Markdown of the Served vs rendered panel. Pure: takes the diff the panel computed and returns
// Markdown in the shared shape of agent-md.ts.
import { agentDoc, bySeverity, clip, code, findingList, LEVEL_WORD, plural } from "../agent-md";
import type { RenderDiff } from "../rendered-source";

export interface RenderedSourceCtx {
  url: string;
  heading?: "##" | "###";
  /** Notes on how the two sides were read (re-fetch, caps), shown as context lines. */
  notes?: string[];
}

const FIX: Record<string, string> = {
  "noindex-served": "Serve the HTML without `noindex` when the page is meant to be indexed (decide it on the server, not in JavaScript).",
  "noindex-rendered": 'If the page must stay out of the index, put `<meta name="robots" content="noindex">` in the served HTML.',
  "canonical-js": 'Render `<link rel="canonical">` in the served HTML (server-side rendering or the static template).',
  "canonical-changed": "Make the served canonical and the one JavaScript sets the same URL, or stop changing it on the client.",
  "canonical-removed": "Stop removing the canonical on the client (often a head manager that replaces the whole <head>).",
  "canonical-many": 'Keep exactly one `<link rel="canonical">`: the client-side head manager adds a second one.',
  "content-js": "Server-render (SSR) or pre-render (SSG) the main content so the served HTML carries the text.",
  "content-partly-js": "Server-render the part of the content that matters for search.",
  "title-js": "Render the `<title>` in the served HTML.",
  "title-changed": "Serve the final `<title>` in the HTML instead of changing it on the client.",
  "title-removed": "Stop removing the `<title>` on the client.",
  "description-added": "Render the meta description in the served HTML.",
  "description-changed": "Serve the final meta description instead of changing it on the client.",
  "description-removed": "Stop removing the meta description on the client.",
  "social-js": "Render the Open Graph and Twitter tags in the served HTML: share scrapers do not run JavaScript.",
  "social-changed": "Serve the final Open Graph and Twitter values: share scrapers keep the served ones.",
  "h1-js": "Render the h1 in the served HTML.",
  "links-js": "Render navigation and content links as `<a href>` in the served HTML so crawlers can discover the pages.",
  "jsonld-js": 'Render the JSON-LD `<script type="application/ld+json">` in the served HTML if other crawlers must read it.',
  "jsonld-removed": "Stop removing the served JSON-LD on the client, or drop it from the HTML if it is wrong.",
  "hreflang-js": 'Render the hreflang `<link rel="alternate">` tags in the served HTML or list them in the sitemap.',
  "hreflang-removed": "Stop removing the served hreflang alternates on the client.",
};

/** Served vs rendered panel: the ranked findings with fixes, then the differences field by field. */
export function renderedSourceMarkdown(d: RenderDiff, ctx: RenderedSourceCtx): string {
  const findings = bySeverity(d.findings.filter((f) => f.level !== "good"));
  const problems = findings.filter((f) => f.level === "bad");
  const warnings = findings.filter((f) => f.level === "warn");
  const notes = findings.filter((f) => f.level === "info");
  const item = (f: (typeof findings)[number]) => ({
    text: `${f.text}: ${f.detail}`,
    details: FIX[f.id] ? [`Fix: ${FIX[f.id]}`] : [],
  });
  const fields = d.fields
    .filter((f) => f.change !== "same")
    .map(
      (f) =>
        `- ${f.label} (${f.change}): served ${f.served === null ? "none" : code(clip(f.served, 160))}, rendered ${f.rendered === null ? "none" : code(clip(f.rendered, 160))}`,
    );
  const lists = [
    d.social.added.length ? `- Share tags added by JavaScript: ${d.social.added.map((s) => code(s.key)).join(", ")}` : "",
    d.social.changed.length ? `- Share tags changed by JavaScript: ${d.social.changed.map((s) => code(s.key)).join(", ")}` : "",
    d.jsonLd.added.length
      ? `- JSON-LD added: ${d.jsonLd.added.map((b) => (b.types.length ? b.types.join(", ") : "no @type")).join("; ")}`
      : "",
    d.jsonLd.removed.length
      ? `- JSON-LD removed: ${d.jsonLd.removed.map((b) => (b.types.length ? b.types.join(", ") : "no @type")).join("; ")}`
      : "",
    d.headings.added.length
      ? `- Headings added: ${d.headings.added
          .slice(0, 10)
          .map((h) => `h${h.level} ${code(clip(h.text, 80))}`)
          .join(", ")}`
      : "",
    d.headings.removed.length
      ? `- Headings removed: ${d.headings.removed
          .slice(0, 10)
          .map((h) => `h${h.level} ${code(clip(h.text, 80))}`)
          .join(", ")}`
      : "",
    d.links.added.length
      ? `- Links added (${d.links.added.length}): ${d.links.added
          .slice(0, 15)
          .map((l) => code(clip(l.href, 120)))
          .join(", ")}${d.links.added.length > 15 ? ", …" : ""}`
      : "",
    d.links.removed.length ? `- Links removed: ${d.links.removed.length}` : "",
    `- Words: ${d.words.served.toLocaleString("en")} served, ${d.words.rendered.toLocaleString("en")} rendered`,
  ].filter(Boolean);
  return agentDoc({
    title: "Served HTML vs rendered DOM (devkit panel: Inspect › Served vs rendered)",
    url: ctx.url,
    heading: ctx.heading,
    result: findings.length
      ? [
          problems.length ? plural(problems.length, "problem") : "",
          warnings.length ? plural(warnings.length, "warning") : "",
          notes.length ? plural(notes.length, "note") : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "Same SEO signals in the served HTML and after JavaScript.",
    context: [
      "Served = the page's URL fetched again (no JavaScript run); rendered = the live DOM after JavaScript. The findings are heuristics.",
      ...(ctx.notes ?? []),
    ],
    sections: [
      { title: "To fix", body: findingList(problems.map(item)) },
      { title: "Worth checking", body: findingList(warnings.map(item)) },
      { title: "Notes", body: notes.map((f) => `- ${LEVEL_WORD[f.level]}: ${f.text}. ${f.detail}`) },
      { title: "Differences", body: [...fields, ...lists] },
    ],
    verify: findings.length ? "Reload the page and refresh devkit's Served vs rendered panel." : undefined,
  });
}
