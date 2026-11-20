// "Copy for agent" and JSON export of the Consent check. Names only: cookie and storage values are never
// captured, request URLs keep their host, path and a few known parameters (gcs, tid…), not identifiers.
import { agentDoc, bySeverity, code, plural } from "../agent-md";
import {
  CATEGORY_LABEL,
  CHOICE_LABEL,
  type ConsentAnalysis,
  type ConsentComparison,
  type ConsentFinding,
  isTracking,
  trackingHits,
} from "../consent";

const FIX: Record<string, string> = {
  "ads-cookies": "Load the tag that sets them only after Accept (CMP blocking, or GTM triggers on the consent event).",
  "analytics-cookies":
    "Hold the analytics tag until consent, or run it cookieless (Consent Mode with analytics_storage denied, or an exempt configuration).",
  "tracking-storage": "Write these keys only after consent; the tag that writes them should wait for the CMP.",
  "ads-requests": "Block these tags until the visitor accepts: they must not load before the CMP's answer.",
  "analytics-requests": "Delay them until consent, or make sure they run without identifiers while consent is denied.",
  "consent-mode-missing":
    "Before the GTM / gtag snippet: `gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', wait_for_update: 500 })`.",
  "consent-default-granted": "Set these signals to 'denied' in the default; the CMP sends 'granted' in an update after Accept.",
  "consent-update-before": "Make the CMP send gtag('consent', 'update', …) only from the visitor's choice (or a stored earlier choice).",
  "no-cmp": "Add a consent banner (CMP) if the site sets non-essential cookies, or confirm the custom banner blocks them.",
  "tcf-tracking-before-string":
    "Make the ad tags wait for the TC string (`__tcfapi('addEventListener', 2, …)` with tcloaded / useractioncomplete).",
  "reject-tracking-storage": "After Reject, the tags that set these must not run: check the CMP's blocking rules.",
  "reject-tracking-requests": "Map these tags to their consent purpose so Reject blocks them.",
  "reject-granted": "Send `gtag('consent', 'update', { …: 'denied' })` on Reject.",
  "accept-no-update": "On Accept, send `gtag('consent', 'update', { ad_storage: 'granted', … })` for the purposes accepted.",
};

const findingItem = (f: ConsentFinding): string =>
  [
    `- **${f.label}**: ${f.detail}`,
    ...(f.items ?? []).slice(0, 25).map((i) => `  - ${code(i)}`),
    (f.items?.length ?? 0) > 25 ? `  - … and ${f.items!.length - 25} more` : "",
    FIX[f.id] ? `  - Fix: ${FIX[f.id]}` : "",
  ]
    .filter(Boolean)
    .join("\n");

const PHASE_TEXT = {
  before: "after devkit cleared the site's cookies and storage and reloaded, before any interaction",
  current: "current state, without clearing (may already include an earlier choice)",
  after: "after a choice in the banner",
} as const;

function trackerLines(a: ConsentAnalysis): string[] {
  const cookies = a.cookies
    .filter((c) => !c.preexisting && c.category !== "unknown")
    .map(
      (c) =>
        `- cookie ${code(c.name)}: ${CATEGORY_LABEL[c.category]}${c.vendor ? `, ${c.vendor}` : ""}, ${c.firstParty ? "first party" : `third party (${c.domain.replace(/^\./, "")})`}${c.partitioned ? ", partitioned" : ""}`,
    );
  const unknownCookies = a.cookies.filter((c) => !c.preexisting && c.category === "unknown");
  const keys = a.storage
    .filter((k) => k.category !== "unknown")
    .map((k) => `- ${k.area}Storage ${code(k.key)}: ${CATEGORY_LABEL[k.category]}${k.vendor ? `, ${k.vendor}` : ""}`);
  const requests = a.requests
    .filter((g) => !g.firstParty || g.category !== "unknown")
    .slice(0, 40)
    .map(
      (g) =>
        `- ${code(g.host)}: ${CATEGORY_LABEL[g.category]}${g.vendor ? `, ${g.vendor}` : ""}, ${plural(g.count, "request")}${g.deniedPings ? ` (${g.deniedPings} with consent denied)` : ""}${g.loader ? ", tag loader" : ""}`,
    );
  return [
    ...cookies,
    unknownCookies.length ? `- other cookies: ${unknownCookies.map((c) => code(c.name)).join(", ")}` : "",
    ...keys,
    ...requests,
  ];
}

function consentModeLines(a: ConsentAnalysis): string[] {
  const cm = a.consentMode;
  if (!cm.present) return [a.googleTags ? "- No gtag('consent', …) command in the dataLayer." : ""];
  return cm.signals
    .filter((s) => s.default !== undefined || s.update !== undefined)
    .map((s) => `- ${code(s.signal)}: default ${s.default ?? "not set"}${s.update ? `, update ${s.update}` : ""}`);
}

function comparisonLines(c: ConsentComparison): string[] {
  return [
    `Capture ${CHOICE_LABEL[c.choice]} (${new Date(c.after.capture.at).toISOString()}):`,
    ...bySeverity(c.findings).map(findingItem),
    c.cookiesAdded.length ? `- Cookies added: ${c.cookiesAdded.map((k) => code(k.name)).join(", ")}` : "- No cookie added.",
    c.storageAdded.length ? `- Storage keys added: ${c.storageAdded.map((k) => code(k.key)).join(", ")}` : "",
    c.requestsAdded.length ? `- Hosts added: ${c.requestsAdded.map((g) => code(g.host)).join(", ")}` : "",
    ...c.signals.map((s) => `- Consent Mode ${code(s.signal)}: ${s.before} → ${s.after}`),
  ];
}

/** Markdown for a coding agent: the findings first, then what was seen, then the before / after comparisons. */
export function consentMarkdown(a: ConsentAnalysis, comparisons: ConsentComparison[] = [], ctx: { heading?: "##" | "###" } = {}): string {
  const findings = bySeverity(a.findings);
  const bad = findings.filter((f) => f.level === "bad");
  const warn = findings.filter((f) => f.level === "warn");
  const notes = findings.filter((f) => f.level === "info" || f.level === "good");
  const result = bad.length
    ? `${plural(bad.length, "problem")}${warn.length ? ` and ${plural(warn.length, "warning")}` : ""} with consent.`
    : warn.length
      ? `${plural(warn.length, "warning")} with consent.`
      : "No problem found (heuristic).";
  return agentDoc({
    title: "Consent check (GDPR / ePrivacy)",
    url: a.capture.url,
    heading: ctx.heading,
    result,
    context: [
      `Captured ${PHASE_TEXT[a.capture.phase]}.`,
      `Heuristic: cookies, storage keys and hosts are matched against devkit's list of common trackers by name and domain. Cookie and storage values are never read into the report.`,
      a.cmps.length ? `Consent banner: ${a.cmps.map((c) => c.name).join(", ")}.` : "",
    ],
    sections: [
      { title: "To fix", body: bad.map(findingItem) },
      { title: "Worth checking", body: warn.map(findingItem) },
      { title: "Notes", body: notes.map(findingItem) },
      { title: "Consent Mode", body: consentModeLines(a) },
      { title: "Seen on the page", body: trackerLines(a) },
      ...comparisons.map((c, i) => ({ title: `Comparison ${i + 1}: ${CHOICE_LABEL[c.choice]}`, body: comparisonLines(c) })),
    ],
    verify:
      bad.length || warn.length
        ? "Run Inspect › Consent check › Check before consent again in devkit, then accept or reject in the banner and press Capture now."
        : undefined,
  });
}

/** JSON export: every capture as recorded (names, stripped URLs), its classification and findings. */
export function consentJson(analyses: ConsentAnalysis[], comparisons: ConsentComparison[]): string {
  return JSON.stringify(
    {
      tool: "devkit consent check",
      note: "Heuristic classification by name and domain. Cookie and storage values are never captured.",
      captures: analyses.map((a) => ({
        ...a.capture,
        findings: a.findings,
        consentMode: a.consentMode,
        cmps: a.cmps,
        cookies: a.cookies.map(({ name, domain, path, partitioned, httpOnly, session, preexisting, category, vendor, firstParty }) => ({
          name,
          domain,
          path,
          partitioned,
          httpOnly,
          session,
          preexisting,
          category,
          vendor,
          firstParty,
        })),
        storage: a.storage.map(({ area, key, category, vendor }) => ({ area, key, category, vendor })),
        requests: a.requests.map(({ host, firstParty, category, vendor, count, deniedPings, types, paths, gcs, loader }) => ({
          host,
          firstParty,
          category,
          vendor,
          count,
          trackingHits: isTracking({ category, vendor, loader }) ? count - deniedPings : 0,
          deniedPings,
          types,
          paths,
          gcs,
        })),
      })),
      comparisons: comparisons.map((c) => ({
        choice: c.choice,
        before: c.before.capture.id,
        after: c.after.capture.id,
        cookiesAdded: c.cookiesAdded.map((k) => ({ name: k.name, domain: k.domain, category: k.category, vendor: k.vendor })),
        cookiesRemoved: c.cookiesRemoved.map((k) => ({ name: k.name, domain: k.domain })),
        storageAdded: c.storageAdded.map((k) => ({ area: k.area, key: k.key, category: k.category })),
        requestsAdded: c.requestsAdded.map((g) => ({
          host: g.host,
          category: g.category,
          vendor: g.vendor,
          trackingHits: trackingHits(g),
        })),
        signals: c.signals,
        findings: c.findings,
      })),
    },
    null,
    2,
  );
}
