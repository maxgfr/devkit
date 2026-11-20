// "Copy for agent" report of the Site crawl panel: the findings across the crawled pages, each with the pages
// concerned (paths on the crawled site), the fix, and how to check it. Pure: takes what the panel crawled.
import { agentDoc, clip, code, findingList, plural } from "../agent-md";
import { type CrawlFinding, type CrawlPage, crawlFindings, crawlSummary, type SitemapRead, type SkippedUrl } from "../crawl";
import type { ValidateMode } from "../jsonld";
import { NO_PROBLEM } from "./inspect";

export interface CrawlReportData {
  origin: string;
  pages: CrawlPage[];
  skipped: SkippedUrl[];
  /** Planned URLs not fetched yet (the crawl was stopped). */
  pending: string[];
  mode: ValidateMode;
  sitemaps: SitemapRead[];
}

/** A URL of the crawled site as its path, others in full. */
const where = (url: string, origin: string) => code(url.startsWith(`${origin}/`) ? url.slice(origin.length) || "/" : url);

function urlsLine(urls: string[], origin: string, max = 8): string {
  const shown = urls.slice(0, max).map((u) => where(u, origin));
  return `${shown.join(", ")}${urls.length > max ? ` and ${plural(urls.length - max, "more page")}` : ""}`;
}

const QUOTED = new Set(["duplicate-title", "duplicate-description", "duplicate-h1"]);

function item(f: CrawlFinding, origin: string) {
  const details = f.groups?.length
    ? f.groups.slice(0, 8).map((g) => {
        const value = QUOTED.has(f.id)
          ? `"${clip(g.value, 120)}"`
          : f.id === "canonical-elsewhere" || f.id === "redirected"
            ? where(g.value, origin)
            : g.value;
        return `${value}${f.id === "canonical-elsewhere" ? " ← " : f.id === "redirected" ? " ← " : ": "}${urlsLine(g.urls, origin, 6)}`;
      })
    : [urlsLine(f.urls, origin)];
  if (f.groups && f.groups.length > 8) details.push(`… and ${plural(f.groups.length - 8, "more group")}`);
  return { text: `${f.title}: ${plural(f.urls.length, "page")}.`, details: [...details, `Fix: ${f.fix}`] };
}

export function crawlMarkdown(data: CrawlReportData, ctx: { heading?: "##" | "###" } = {}): string {
  const findings = crawlFindings(data.pages, { mode: data.mode, skipped: data.skipped });
  const bad = findings.filter((f) => f.level === "bad");
  const warn = findings.filter((f) => f.level === "warn");
  const info = findings.filter((f) => f.level === "info");
  const s = crawlSummary(data.pages);
  const sitemaps = data.sitemaps.filter((m) => m.kind === "urlset" || m.kind === "sitemapindex");
  const result =
    bad.length || warn.length
      ? [bad.length ? plural(bad.length, "problem") : "", warn.length ? plural(warn.length, "warning") : ""].filter(Boolean).join(", ") +
        ` across ${plural(s.pages, "page")}.`
      : `${NO_PROBLEM} (${plural(s.pages, "page")} crawled)`;
  return agentDoc({
    title: "Site crawl",
    url: data.origin,
    heading: ctx.heading,
    result,
    context: [
      `Crawled ${plural(s.pages, "page")}: ${s.ok} answered 2xx, ${s.errors} an error, ${s.redirects} redirected, ${s.noindex} noindex, ${s.withJsonLd} with JSON-LD.`,
      sitemaps.length
        ? `From ${plural(sitemaps.length, "sitemap")}: ${sitemaps
            .slice(0, 5)
            .map((m) => code(m.url))
            .join(", ")}.`
        : "",
      data.pending.length ? `Stopped early: ${plural(data.pending.length, "planned URL")} not fetched.` : "",
      `devkit read the served HTML of each page (no JavaScript ran), so tags a script adds after load are not seen. JSON-LD checked with the ${data.mode === "rich" ? "Rich Results" : "Schema.org"} rules.`,
    ],
    sections: [
      { title: "To fix", body: findingList(bad.map((f) => item(f, data.origin))) },
      { title: "Worth checking", body: findingList(warn.map((f) => item(f, data.origin))) },
      { title: "Notes", body: info.map((f) => `- ${f.title}: ${urlsLine(f.urls, data.origin, 5)}.`) },
    ],
    verify:
      "Deploy the fixes, then run devkit's Site crawl again (Inspect › Site crawl) and open a page in the SEO or Structured data panel for its details.",
  });
}
