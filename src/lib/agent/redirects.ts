// "Copy for agent" report of the Redirect path panel: the hops of one navigation, what to fix in them, and how to
// check the fix. Pure.
import { agentDoc, clip, code, fence, findingList, plural } from "../agent-md";
import type { Check } from "../headers";
import { type Chain, chainText, finalHop, redirectCount, redirectFindings } from "../redirects";

const FIX: Record<string, string> = {
  loop: "Find the rule that sends the last URL back to an earlier one (often an HTTP→HTTPS or www rule fighting a CDN or framework redirect) and keep only one of them.",
  "max-hops": "Collapse the chain: redirect every old URL straight to the final one.",
  hops: "Point internal links, the sitemap and canonical tags at the final URL, and make each legacy URL redirect there in one hop.",
  temporary:
    "Answer 301 (or 308 to keep the method) for canonical moves: in nginx `return 301`, in Next.js `permanent: true`, in Express `res.redirect(301, …)`.",
  downgrade: "Redirect to the https:// URL, and check the proxy passes the original scheme (X-Forwarded-Proto) to the app.",
  client: "Replace the meta refresh or script with a server redirect (301/308) where the page is produced.",
  status: "Make the final URL answer 200, or redirect to a page that exists.",
  error: "Check the final URL resolves and answers (DNS, TLS, firewall).",
};
const fixFor = (c: Check) => FIX[c.id.replace(/-\d+$/, "")];

export function redirectsMarkdown(chain: Chain, ctx: { url?: string; heading?: "##" | "###" } = {}): string {
  const findings = redirectFindings(chain);
  const item = (c: Check) => ({ text: `${c.label}: ${clip(c.detail, 300)}`, details: [fixFor(c) ?? ""] });
  const bad = findings.filter((c) => c.level === "bad").map(item);
  const warn = findings.filter((c) => c.level === "warn").map(item);
  const n = redirectCount(chain);
  const final = finalHop(chain);
  const summary = `${plural(n, "redirect")}, final ${final?.error ?? `HTTP ${final?.status ?? "?"}`} at ${final?.url ?? "?"}`;
  const result =
    bad.length || warn.length
      ? `${summary}: ${[bad.length ? plural(bad.length, "problem") : "", warn.length ? plural(warn.length, "warning") : ""].filter(Boolean).join(", ")}.`
      : `No problem found. ${summary}.`;
  const start = chain.hops[0]?.url;
  return agentDoc({
    title: "Redirect path",
    url: ctx.url ?? start,
    heading: ctx.heading,
    result,
    context: [
      chain.source === "trace"
        ? "Traced by devkit: it requested the URL itself and followed every redirect and meta refresh; JavaScript redirects only run in a tab."
        : "Recorded from the tab's navigation (webRequest and webNavigation, read-only).",
      chain.note ?? "",
    ],
    sections: [
      { title: "To fix", body: findingList(bad) },
      { title: "Worth checking", body: findingList(warn) },
      { title: "Hops", body: fence(chainText(chain)) },
    ],
    verify: start
      ? `Deploy, then trace ${code(start)} again in devkit's Redirect path panel, or run ${code(`curl -sIL ${start}`)}.`
      : undefined,
  });
}
