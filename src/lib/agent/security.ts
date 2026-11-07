// "Copy for agent" reports of the Secrets, Source maps & exposed files, Third parties, CSP, Cookies and Assets
// panels: what is wrong, where, how to fix it and how to check the fix. Pure: each builder takes what its panel
// already computed, so the page report can join them.
import { agentDoc, bySeverity, clip, code, fence, findingList, plural } from "../agent-md";
import { type Asset, sizeText } from "../assets";
import type { Level } from "../headers";
import type { SurfaceSnapshot } from "../page/security";
import { auditCookies, type CookieFlag, type CookieLike, isAuthLike } from "../security/cookies";
import { analyzeCsp, type CspFinding, type CspPolicy, type StarterCsp } from "../security/csp";
import { type MapCheck, PROBES, type ProbeVerdict } from "../security/exposed";
import type { SecretFinding, SecretLocation } from "../security/secrets";
import { groupBySite, type SurfaceFinding, surfaceFindings } from "../security/third-party";
import { formatBytes } from "../storage-usage";

export interface ReportOptions {
  /** The page the findings come from. */
  url: string;
  /** "##" alone, "###" inside the page report. */
  heading?: "##" | "###";
}

type Item = { text: string; details?: string[] };

/** A numbered list of the first `max` items, then how many were left out. */
function capped(items: Item[], what: string, max = 15): string {
  if (!items.length) return "";
  const list = findingList(items.slice(0, max));
  const more = items.length - max;
  return more > 0 ? `${list}\n\n… and ${plural(more, `more ${what}`)}.` : list;
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/* Secrets */

export interface SecretScanInfo {
  /** Page sources read (inline scripts, comments, storage…). */
  sources?: number;
  /** This origin's scripts fetched and scanned. */
  scripts?: number;
  /** Third-party scripts left out. */
  skipped?: number;
  failed?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The excerpt around a match with every known secret hidden: the excerpt masks its own value, but a second
 * secret can sit in the same 40 characters (an AWS key ID next to its secret key). Any run of 8 characters
 * that belongs to a found value becomes "…"; the masked forms are left as they are.
 */
function scrub(context: string, findings: SecretFinding[]): string {
  const values = findings.map((f) => f.value.replace(/\s+/g, " ")).filter((v) => v.length >= 8);
  const masks = [...new Set(findings.map((f) => f.masked))].filter(Boolean).sort((a, b) => b.length - a.length);
  const parts = masks.length ? context.split(new RegExp(`(${masks.map(escapeRe).join("|")})`)) : [context];
  return parts
    .map((part, i) => {
      if (i % 2 === 1 && masks.length) return part;
      const hidden = new Array<boolean>(part.length).fill(false);
      for (let at = 0; at + 8 <= part.length; at++) {
        const window = part.slice(at, at + 8);
        if (values.some((v) => v.includes(window))) hidden.fill(true, at, at + 8);
      }
      let out = "";
      for (let k = 0; k < part.length; k++) {
        if (!hidden[k]) out += part[k];
        else if (k === 0 || !hidden[k - 1]) out += "…";
      }
      return out;
    })
    .join("");
}

function secretWhere(l: SecretLocation): string {
  const place = l.url ? `script ${code(l.url)}` : code(l.source);
  return `${place}, line ${l.line}${l.column > 1 ? `, column ${l.column}` : ""}`;
}

const STORED: SecretLocation["kind"][] = ["storage", "cookie"];

/** Secrets the page ships or keeps, masked as in the panel, with the rotation and the move server-side. */
export function secretsMarkdown(findings: SecretFinding[], opts: ReportOptions & { scan?: SecretScanInfo }): string {
  const leaks = findings.filter((f) => f.severity === "bad");
  const toCheck = findings.filter((f) => f.severity === "warn");
  const publicOnes = findings.length - leaks.length - toCheck.length;
  const item = (f: SecretFinding): Item => {
    const stored = f.locations.some((l) => STORED.includes(l.kind));
    const details = [
      f.detail ?? "",
      ...f.locations.slice(0, 3).map((l) => {
        const around = scrub(l.context, findings);
        return `Found in ${secretWhere(l)}${around ? `: ${code(clip(around, 160))}` : ""}`;
      }),
      f.locations.length > 3 ? `… and ${plural(f.locations.length - 3, "more place")}.` : "",
      f.severity === "bad"
        ? `Fix: revoke or rotate the ${f.title} at its provider first: it has been public since the page shipped it. Then move the code that needs it to the server (an API route, a serverless function, a backend proxy) and read it from a server-only environment variable, not one the bundler inlines into client code (NEXT_PUBLIC_*, VITE_*, REACT_APP_*…).`
        : "Fix: check whether this is a real credential. If it is, rotate it and move it server-side; if it is a placeholder or public by design, nothing to do.",
      stored ? "It is kept in the browser's storage: find the code that writes it there and stop doing so." : "",
    ];
    return { text: `**${f.title}** ${code(f.masked)}${f.heuristic ? " (heuristic)" : ""}: ${f.why}`, details };
  };
  const result = leaks.length
    ? `${plural(leaks.length, "likely leaked credential")}${toCheck.length ? `, ${plural(toCheck.length, "value")} to check` : ""}.`
    : toCheck.length
      ? `No clear leak; ${plural(toCheck.length, "value")} to check.`
      : "No problem found: no credential pattern in what the page ships.";
  const s = opts.scan;
  const scanned =
    s && (s.sources !== undefined || s.scripts !== undefined)
      ? `Scanned: ${plural(s.sources ?? 0, "page source")} (inline scripts, comments, meta, attributes, globals, storage, readable cookies) and ${plural(s.scripts ?? 0, "script")} from this origin${s.skipped ? `; ${plural(s.skipped, "third-party script")} not fetched` : ""}${s.failed ? `; ${s.failed} failed to load` : ""}.`
      : "";
  return agentDoc({
    title: "Secrets",
    url: opts.url,
    result,
    context: [
      scanned,
      findings.length ? "Values are masked (first and last characters only); the Secrets panel can reveal them." : "",
      publicOnes ? `Left out: ${plural(publicOnes, "value")} public by design (publishable keys, web configs, your own session).` : "",
    ],
    sections: [
      { title: "To fix", body: capped(leaks.map(item), "credential") },
      { title: "Worth checking", body: capped(toCheck.map(item), "value") },
    ],
    verify:
      findings.length - publicOnes
        ? "the old key must now be rejected by its provider; after deploying, reload the page and rescan devkit's Secrets panel: the finding should be gone."
        : undefined,
    heading: opts.heading,
  });
}

/* Source maps & exposed files */

function probeFix(path: string): string {
  if (path.startsWith("/.git/"))
    return `stop deploying the .git folder (deploy a build output, not a checkout) and deny it at the server, e.g. nginx ${code("location ~ /\\.git { deny all; }")}. Assume the repository is public: rotate any credential in its history.`;
  if (path.startsWith("/.env"))
    return `move it out of the web root and deny dotfiles at the server, e.g. nginx ${code("location ~ /\\.(?!well-known/) { deny all; }")}. Rotate every credential it holds.`;
  if (path === "/.DS_Store") return "delete it from the server and exclude .DS_Store from deployments (and from git).";
  if (path === "/server-status")
    return `restrict mod_status to local requests (${code("Require local")} in its <Location> block) or disable it.`;
  if (path === "/phpinfo.php") return "delete the file from the server.";
  if (path.endsWith(".bak")) return "delete the backup from the web root and rotate the database password it holds.";
  return "remove it from the web root or deny it at the server.";
}

/** Source maps and files the server should not serve, from the Source maps check and the optional probe. */
export function exposedMarkdown(
  data: { maps: MapCheck[]; probes?: (ProbeVerdict | null)[] | null; origin?: string | null },
  opts: ReportOptions,
): string {
  const origin = data.origin || originOf(opts.url);
  const probed = data.probes?.some(Boolean) ?? false;
  const exposed = bySeverity(
    PROBES.flatMap((p, i) => {
      const v = data.probes?.[i];
      return v?.state === "exposed" ? [{ probe: p, verdict: v, level: v.level }] : [];
    }),
  );
  const readable = data.maps.filter((m) => m.state === "reachable" || m.state === "inline");
  const unchecked = data.maps.filter((m) => m.state === "pending" || m.state === "error").length;
  const noSecurityTxt = PROBES.findIndex((p) => p.path === "/.well-known/security.txt");
  const securityTxt = data.probes?.[noSecurityTxt]?.state === "absent";

  const fix: Item[] = exposed.map(({ probe, verdict }) => ({
    text: `${code(`${origin}${probe.path}`)} is served (${verdict.detail.replace(/: .*$/, "")}): ${probe.why}`,
    details: [`Fix: ${probeFix(probe.path)}`],
  }));
  const check: Item[] = readable.map((m) =>
    m.state === "inline"
      ? {
          text: `The ${m.kind} ${code(m.file)} ships an inline source map (data: URL): the original source comes with the file.`,
          details: ["Fix: turn off inline source maps in the production build."],
        }
      : {
          text: `The ${m.kind} ${code(m.file)} has a readable source map ${code(m.map ?? "")}${m.size ? ` (${formatBytes(m.size)})` : ""}${m.sources ? ", original sources included (sourcesContent)" : ""}${m.via === "header" ? ", announced by its SourceMap header" : ""}.`,
          details: [
            `Fix: if the code is not meant to be public, build hidden source maps (no sourceMappingURL comment, e.g. Vite ${code("build.sourcemap: 'hidden'")}, webpack ${code("devtool: 'hidden-source-map'")}) and upload them to the error tracker instead of deploying them, or deny ${code("*.map")} at the server.${m.via === "header" ? " Drop the SourceMap header too." : ""}`,
          ],
        },
  );
  if (securityTxt)
    check.push({
      text: `No ${code("/.well-known/security.txt")}: researchers have no published contact.`,
      details: ["Fix: publish one with at least a Contact: and an Expires: line (RFC 9116)."],
    });

  const parts = [
    probed ? (exposed.length ? plural(exposed.length, "exposed file") : "") : "",
    readable.length ? plural(readable.length, "readable source map") : "",
  ].filter(Boolean);
  const result = parts.length
    ? `${parts.join(", ")}.`
    : probed
      ? "No problem found: no exposed file and no readable source map."
      : "No readable source map; exposed files were not probed.";
  return agentDoc({
    title: "Source maps & exposed files",
    url: opts.url,
    result,
    context: [
      `Source maps: ${plural(data.maps.length, "script and stylesheet", "scripts and stylesheets")} of this origin checked${unchecked ? `, ${unchecked} could not be read` : ""}.`,
      probed
        ? `Exposed files: ${plural(PROBES.length, "path")} probed on ${origin}, each answer compared with a random path's and checked for the file's content.`
        : `Exposed files: not probed (the panel's "Probe ${PROBES.length} paths" button).`,
    ],
    sections: [
      { title: "To fix", body: capped(fix, "file") },
      { title: "Worth checking", body: capped(check, "file") },
    ],
    verify:
      fix.length || check.length
        ? "after deploying, open each URL above: it should answer 404 or 403. Then Recheck devkit's Source maps and probe the paths again."
        : undefined,
    heading: opts.heading,
  });
}

/* Third parties & SRI */

function surfaceFix(f: SurfaceFinding, snap: SurfaceSnapshot): string[] {
  const url = f.url ?? "";
  if (f.id.startsWith("sri:")) {
    const style = snap.styles.some((s) => s.href === url) && !snap.scripts.some((s) => s.src === url);
    const tag = style
      ? `<link rel="stylesheet" href="${url}" integrity="sha384-<hash>" crossorigin="anonymous">`
      : `<script src="${url}" integrity="sha384-<hash>" crossorigin="anonymous"></script>`;
    return [
      `Fix: ${code(tag)}`,
      `Hash: ${code(`curl -s '${url}' | openssl dgst -sha384 -binary | openssl base64 -A`)} (or devkit's Utils › Hash & SRI). Pin only a versioned URL: a file that changes in place (tag managers, analytics loaders) breaks once pinned; self-host it or leave it unpinned on purpose.`,
    ];
  }
  if (f.id.startsWith("cors:")) return [`Fix: add ${code('crossorigin="anonymous"')} to the tag that loads it.`];
  if (f.id.startsWith("preload-font:")) return [`Fix: ${code(`<link rel="preload" as="font" href="${url}" crossorigin>`)}`];
  if (f.id.startsWith("preload-cors:")) return ["Fix: give the preload the same crossorigin value as the tag that uses the file."];
  if (f.id.startsWith("mixed:"))
    return ["Fix: request it over https:// in the markup, CSS or code that loads it; if the host has no HTTPS, self-host the file."];
  if (f.id.startsWith("sandbox:"))
    return [
      `Fix: if the embed allows it, add ${code('sandbox="allow-scripts allow-same-origin"')} with only the tokens it needs (allow-popups, allow-forms…).`,
    ];
  return [];
}

/** Integrity, CORS, mixed content and sandbox checks on what the page loads, and the third-party sites it loads from. */
export function thirdPartiesMarkdown(snap: SurfaceSnapshot, opts: ReportOptions): string {
  const findings = bySeverity(surfaceFindings(snap));
  const third = groupBySite(snap).filter((g) => !g.firstParty);
  const item = (f: SurfaceFinding): Item => ({
    text: `${f.title}${f.url ? `: ${code(clip(f.url))}` : ""}. ${f.detail.replace(/ \(Utils › Hash & SRI\)/, "")}`,
    details: surfaceFix(f, snap),
  });
  const fix = findings.filter((f) => f.level === "bad" || f.level === "warn");
  const check = findings.filter((f) => f.level === "info");
  const sites = third.map((g) => ({
    text: `${code(g.site)}: ${plural(g.requests, "request")}${g.bytes ? `, ${formatBytes(g.bytes)}` : ""}${g.hiddenSize ? ` (${g.hiddenSize} unsized)` : ""}${g.hosts.length > 1 || g.hosts[0] !== g.site ? ` from ${g.hosts.slice(0, 4).map(code).join(", ")}${g.hosts.length > 4 ? "…" : ""}` : ""}`,
  }));
  const result = fix.length
    ? `${plural(fix.length, "problem")} to fix; the page loads from ${plural(third.length, "third-party site")}.`
    : `No problem found; the page loads from ${plural(third.length, "third-party site")}.`;
  return agentDoc({
    title: "Third parties & SRI",
    url: opts.url,
    result,
    context: [
      `On the page: ${plural(snap.scripts.length, "external script")}, ${plural(snap.styles.length, "stylesheet")}, ${plural(snap.iframes.length, "iframe")}. Sites come from resource timing since the page loaded.`,
    ],
    sections: [
      { title: "To fix", body: capped(fix.map(item), "finding") },
      { title: "Worth checking", body: capped(check.map(item), "finding") },
      { title: "Third-party sites", body: capped(sites, "site", 20) },
    ],
    verify: findings.length
      ? "reload the page and Refresh devkit's Third parties panel: the checks above should be gone. A wrong hash shows in the console as a blocked load (no valid digest)."
      : undefined,
    heading: opts.heading,
  });
}

/* CSP */

/** The script directive with every flagged source removed, and a nonce where inline scripts lose 'unsafe-inline'. */
function fixedScriptSrc(policy: CspPolicy, findings: CspFinding[]): string | null {
  const own = policy.directives.find((d) => d.name === "script-src") ?? policy.directives.find((d) => d.name === "default-src");
  if (!own) return null;
  const flagged = findings.filter((f) => f.directive === own.name && (f.level === "bad" || f.level === "warn"));
  if (!flagged.length) return null;
  const has = (start: string) => flagged.some((f) => f.message.startsWith(start));
  let values = [...own.values];
  const drop = (test: (v: string) => boolean) => {
    values = values.filter((v) => !test(v.toLowerCase()));
  };
  let nonce = false;
  if (has("'unsafe-inline' without")) {
    drop((v) => v === "'unsafe-inline'");
    nonce = true;
  }
  if (has("'strict-dynamic' without")) nonce = true;
  if (has("'unsafe-eval'")) drop((v) => v === "'unsafe-eval'");
  if (has("Wildcard *")) drop((v) => v === "*");
  for (const scheme of ["http:", "https:", "data:", "blob:"]) if (has(`${scheme} `)) drop((v) => v === scheme);
  for (const f of flagged) {
    const bypass = /^(\S+) serves files anyone/.exec(f.message)?.[1];
    if (bypass) drop((v) => v === bypass);
  }
  values = values.map((v) => (has(`${v.toLowerCase()} is loaded over plain HTTP`) ? `https://${v.slice(7)}` : v));
  if (nonce && !values.some((v) => /^'nonce-/i.test(v))) values.push("'nonce-{RANDOM}'");
  return `script-src ${(values.length ? values : ["'self'"]).join(" ")}`;
}

function cspAdvice(f: CspFinding, policy: CspPolicy, script: string | null, starter?: StarterCsp | null): string[] {
  const fromStarter = (name: string) =>
    starter?.policy
      .replace(/;$/, "")
      .split(/;\s*/)
      .find((d) => d.split(" ")[0] === name);
  const scriptName = policy.directives.some((d) => d.name === "script-src") ? "script-src" : "default-src";
  const m = f.message;
  const suggest = (value: string | undefined, fix = "") => [value ? `Suggested: ${code(value)}` : "", fix ? `Fix: ${fix}` : ""];
  if (f.directive === "(policy)")
    return suggest(undefined, "once the reports are clean, send the same value in a Content-Security-Policy header.");
  if (m.startsWith("Written twice")) return suggest(undefined, `merge both copies into one ${f.directive} directive.`);
  if (m.startsWith("Ignored in a <meta> policy"))
    return suggest(undefined, `send ${f.directive} in the Content-Security-Policy HTTP header instead.`);
  if (f.directive === scriptName && script && f.level !== "info" && f.level !== "good") {
    const notes: string[] = [];
    if (m.startsWith("'unsafe-inline'"))
      notes.push(
        "give each inline <script> a fresh nonce per response (replace {RANDOM}), or hash it, or move it to a file; rewrite inline handlers (onclick=…) as listeners.",
      );
    if (/^(Wildcard \*|https?: allows)/.test(m))
      notes.push(`add back only the hosts the page loads scripts from${starter ? " (the starter policy lists them)" : ""}.`);
    if (m.startsWith("'unsafe-eval'")) notes.push("find what calls eval() or new Function() (often a template compiler) and replace it.");
    if (m.includes("serves files anyone"))
      notes.push("if scripts from that host are needed, list their exact path (a pinned package version) or load them with a nonce.");
    if (scriptName === "default-src") notes.push("add it as its own script-src, next to default-src.");
    return suggest(script, notes.join(" "));
  }
  if (m.startsWith("No script-src or default-src")) return suggest(fromStarter("script-src") ?? "script-src 'self'");
  switch (f.directive) {
    case "default-src":
      return suggest("default-src 'self'");
    case "object-src":
      return suggest("object-src 'none'");
    case "base-uri":
      return suggest("base-uri 'self'");
    case "frame-ancestors":
      return f.level === "info"
        ? []
        : suggest("frame-ancestors 'self'", policy.source === "meta" ? "only works in the HTTP header, not in <meta>." : "");
    case "form-action":
      return suggest(fromStarter("form-action") ?? "form-action 'self'");
    case "report-uri":
      return suggest(
        "report-to csp",
        `with a ${code('Reporting-Endpoints: csp="https://<your-endpoint>/csp"')} header; keep report-uri for older browsers.`,
      );
  }
  if (m.startsWith("Deprecated"))
    return f.directive === "block-all-mixed-content"
      ? suggest("upgrade-insecure-requests", "replace block-all-mixed-content with it.")
      : suggest(undefined, `remove ${f.directive}.`);
  if (m.startsWith("Unknown directive")) return suggest(undefined, `correct or remove ${f.directive}.`);
  if (m.startsWith("Wildcard *")) return suggest(fromStarter(f.directive), "list the hosts the page actually uses.");
  return [];
}

const policyLabel = (p: CspPolicy) =>
  p.source === "meta" ? "<meta http-equiv>" : p.reportOnly ? "header, report-only" : "header, enforced";

/** Every CSP finding with its directive and the value to set; the starter policy when there is none or it is weak. */
export function cspMarkdown(
  data: { policies: CspPolicy[]; https: boolean; xfo?: string; starter?: StarterCsp | null },
  opts: ReportOptions,
): string {
  const many = data.policies.length > 1;
  const all = data.policies.flatMap((policy, i) => {
    const findings = analyzeCsp(policy, { https: data.https, xfo: data.xfo });
    const script = fixedScriptSrc(policy, findings);
    return findings
      .filter((f) => f.level !== "good")
      .map((f) => ({
        level: f.level,
        item: {
          text: `${code(f.directive)}${many ? ` (policy ${i + 1})` : ""}: ${f.message}`,
          details: cspAdvice(f, policy, script, data.starter),
        },
      }));
  });
  const sorted = bySeverity(all);
  const fix = sorted.filter((f) => f.level === "bad" || f.level === "warn").map((f) => f.item);
  const check = sorted.filter((f) => f.level === "info").map((f) => f.item);
  const bad = all.filter((f) => f.level === "bad").length;
  const enforced = data.policies.some((p) => !p.reportOnly);
  const none = !data.policies.length;
  if (none)
    fix.push({
      text: "No Content-Security-Policy header or <meta> tag: injected scripts run unrestricted.",
      details: [
        data.starter
          ? "Fix: send the starter policy below as Content-Security-Policy-Report-Only, watch the reports while using the site, then enforce it."
          : "Fix: add a Content-Security-Policy header, starting with default-src 'self'; object-src 'none'; base-uri 'self'.",
      ],
    });
  const counts = [bad ? plural(bad, "problem") : "", fix.length - bad && !none ? plural(fix.length - bad, "warning") : ""].filter(Boolean);
  const result = none
    ? "No Content-Security-Policy: injected scripts run unrestricted."
    : counts.length
      ? `${counts.join(" and ")} in ${plural(data.policies.length, "policy", "policies")}${enforced ? "" : " (report-only: nothing is blocked)"}.`
      : "No problem found in the policy.";
  const starter =
    data.starter && (none || bad || !enforced)
      ? [
          "Built from the origins this page used so far: deploy it as report-only first.",
          fence(`Content-Security-Policy-Report-Only: ${data.starter.policy}`, "http"),
          ...data.starter.notes.map((n) => `- ${n}`),
        ]
      : [];
  return agentDoc({
    title: "Content-Security-Policy",
    url: opts.url,
    result,
    context: data.policies.map((p, i) => `Policy ${i + 1} (${policyLabel(p)}): ${code(clip(p.raw, 400))}`),
    sections: [
      { title: "To fix", body: capped(fix, "finding", 20) },
      { title: "Worth checking", body: capped(check, "finding") },
      { title: "Starter policy", body: starter },
    ],
    verify:
      fix.length || check.length
        ? "deploy the new header (report-only first), reload the page and Refresh devkit's CSP panel; use the site with the console open and look for CSP violation reports before enforcing."
        : undefined,
    heading: opts.heading,
  });
}

/* Cookies */

const SAME_SITE: Record<string, string> = { no_restriction: "None", lax: "Lax", strict: "Strict" };
const RANK: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };

/** The Set-Cookie line the cookie should be sent with, the value left as a placeholder. */
function setCookieLine(c: CookieLike, flags: CookieFlag[]): { line: string; added: string[] } {
  const ids = new Set(flags.map((f) => f.id));
  const added: string[] = [];
  const attrs = [`${c.name}=<value>`];
  if (!c.hostOnly) {
    if (ids.has("domain")) added.push("no Domain (host-only)");
    else attrs.push(`Domain=${c.domain.replace(/^\./, "")}`);
  }
  attrs.push(`Path=${c.path}`);
  if (c.secure || ids.has("no-secure") || ids.has("samesite-none")) {
    attrs.push("Secure");
    if (!c.secure) added.push("Secure");
  }
  if (c.httpOnly || ids.has("no-httponly")) {
    attrs.push("HttpOnly");
    if (!c.httpOnly) added.push("HttpOnly");
  }
  const sameSite = ids.has("samesite-none-auth") ? "Lax" : (SAME_SITE[c.sameSite] ?? "Lax");
  attrs.push(`SameSite=${sameSite}`);
  if (sameSite !== SAME_SITE[c.sameSite]) added.push(`SameSite=${sameSite}`);
  if (ids.has("long-expiry") && isAuthLike(c.name)) {
    attrs.push("Max-Age=2592000");
    added.push("Max-Age=2592000 (30 days)");
  } else if (!c.session) attrs.push("Expires=<as today>");
  return { line: `Set-Cookie: ${attrs.join("; ")}`, added };
}

/** The cookie flag audit: names, scope and flags only, never a value, with the Set-Cookie attributes to add. */
export function cookiesMarkdown(cookies: CookieLike[], opts: ReportOptions & { now?: number }): string {
  const audit = auditCookies(cookies, opts.url, opts.now);
  const rows = cookies
    .map((c, i) => ({ c, flags: [...(audit.perCookie[i] ?? [])].sort((a, b) => RANK[a.level] - RANK[b.level]) }))
    .filter((r) => r.flags.length);
  const worst = (r: (typeof rows)[number]) => RANK[r.flags[0]!.level];
  const scope = (c: CookieLike) => `${c.hostOnly ? `host ${c.domain}` : `Domain=${c.domain.replace(/^\./, "")}`}, Path=${c.path}`;
  const item = ({ c, flags }: (typeof rows)[number]): Item => {
    const ids = new Set(flags.map((f) => f.id));
    const { line, added } = setCookieLine(c, flags);
    const changes = flags.some((f) => f.level !== "info");
    return {
      text: `${code(c.name)} (${scope(c)}): ${flags.map((f) => f.label).join(", ")}`,
      details: [
        ...flags.map((f) => `${f.label}: ${f.detail}`),
        changes ? `Fix: send it as ${code(line)}${added.length ? ` (adds ${added.join(", ")})` : ""}.` : "",
        ids.has("no-httponly")
          ? "HttpOnly can only come from the server's Set-Cookie, not document.cookie: if front-end code writes or reads this cookie, move that to the server first."
          : "",
        ids.has("samesite-none-auth")
          ? "Keep SameSite=None only if the cookie must travel on cross-site requests; then make sure CSRF is handled."
          : "",
        ids.has("domain") ? `Or name it with the ${code("__Host-")} prefix, which enforces Secure, Path=/ and no Domain.` : "",
        ids.has("huge") || ids.has("large") ? "Store less in it: an ID pointing to server-side data." : "",
      ],
    };
  };
  const fix = rows.filter((r) => worst(r) <= 1).sort((a, b) => worst(a) - worst(b));
  const check = rows.filter((r) => worst(r) > 1);
  const jar = audit.summary.filter((s) => s.id === "count" && s.level === "warn").map((s) => ({ text: `${s.label}: ${s.detail}.` }));
  const bad = fix.filter((r) => worst(r) === 0).length;
  const result = !cookies.length
    ? "No problem found: the page has no cookie."
    : fix.length
      ? `${plural(fix.length, "cookie")} to fix out of ${cookies.length}${bad ? ` (${bad} with a risky flag)` : ""}.`
      : `No problem found in the flags of ${plural(cookies.length, "cookie")}.`;
  return agentDoc({
    title: "Cookies",
    url: opts.url,
    result,
    context: cookies.length
      ? [
          "Cookie values are left out of this report: only names, scope and flags.",
          "Session cookies are recognized by their name (a heuristic).",
        ]
      : [],
    sections: [
      { title: "To fix", body: capped(fix.map(item), "cookie") },
      { title: "Worth checking", body: [capped(check.map(item), "cookie"), ...jar.map((j) => `- ${j.text}`)] },
    ],
    verify:
      fix.length || check.length || jar.length
        ? "after deploying, clear the site's cookies, sign in again and open devkit's Cookies panel: its flag audit should no longer list these cookies."
        : undefined,
    heading: opts.heading,
  });
}

/* Assets */

const FORMAT_HINT: Record<string, string> = {
  PNG: " in AVIF or WebP (lossless WebP for flat graphics)",
  JPEG: " in AVIF or WebP",
  BMP: " in AVIF or WebP",
  TIFF: " in AVIF or WebP",
  GIF: " as an MP4/WebM video or animated WebP if it moves, else WebP",
};

const KIND_WORD: Record<Asset["kind"], string> = {
  image: "image",
  svg: "SVG",
  background: "background image",
  icon: "icon",
  poster: "video poster",
  social: "social image",
};

const srcOf = (a: Asset) => (!a.url ? "inline" : a.url.startsWith("data:") ? "a data: URL" : code(clip(a.url, 200)));
const usedBy = (a: Asset) =>
  `Element${a.labels.length > 1 ? "s" : ""}: ${a.labels.map(code).join(", ")}${a.uses > a.labels.length ? ` (${a.uses} uses)` : ""}`;

/** Broken, oversized and unlabelled images: where they are, the size and format to serve, the alt to add. */
export function assetsMarkdown(assets: Asset[], opts: ReportOptions & { dpr?: number; capped?: boolean }): string {
  const broken = assets.filter((a) => a.status === "broken");
  const oversized = assets.filter((a) => a.oversize).sort((a, b) => (b.oversize?.wasted ?? 0) - (a.oversize?.wasted ?? 0));
  const noAlt = assets.filter((a) => a.alt === "missing");
  const wasted = oversized.reduce((n, a) => n + (a.oversize?.wasted ?? 0), 0);
  const dpr = opts.dpr ?? 1;

  const items: Item[] = [
    ...broken.map((a) => ({
      text: `Broken ${KIND_WORD[a.kind]} ${code(a.name)}: it failed to load.`,
      details: [`Source: ${srcOf(a)}`, usedBy(a), "Fix: correct the URL or restore the file."],
    })),
    ...oversized.map((a) => {
      const o = a.oversize!;
      const r = a.rendered!;
      const target = { width: Math.ceil(r.width * Math.max(dpr, 2)), height: Math.ceil(r.height * Math.max(dpr, 2)) };
      return {
        text: `Oversized ${a.format || "image"} ${code(a.name)}: ${sizeText(a.natural)} px served for ${sizeText(r)} CSS px on screen, ${o.ratio}× what a ${dpr}× screen needs${a.bytes ? ` (${formatBytes(a.bytes)}${o.wasted ? `, about ${formatBytes(o.wasted)} more than needed` : ""})` : ""}.`,
        details: [
          `Source: ${srcOf(a)}`,
          usedBy(a),
          `Fix: serve it at about ${sizeText(target)} px (2× the displayed size)${FORMAT_HINT[a.format] ?? ""}; ${a.kind === "background" ? "for a CSS background, pick the size per screen with image-set() or media queries." : `add a srcset with a few widths${a.sizes ? ` and check its sizes (${code(a.sizes)}) matches the layout` : " and a sizes attribute matching the layout"}.`}`,
        ],
      };
    }),
    ...noAlt.map((a) =>
      a.kind === "svg"
        ? {
            text: `Inline SVG ${code(a.labels[0] ?? a.name)} has no accessible name.`,
            details: [
              usedBy(a),
              `Fix: give it ${code('role="img"')} and ${code('aria-label="…"')} (or a <title> first child) saying what it shows; ${code('aria-hidden="true"')} if it is decorative. In an icon-only button or link, put the aria-label on the control.`,
            ],
          }
        : {
            text: `Image ${code(a.name)} has no alt attribute.`,
            details: [
              `Source: ${srcOf(a)}`,
              usedBy(a),
              `Fix: add ${code('alt="…"')} saying what the image shows (or what the link does), or ${code('alt=""')} if it is decorative.`,
            ],
          },
    ),
  ];
  const parts = [
    broken.length ? `${broken.length} broken` : "",
    oversized.length ? `${oversized.length} oversized${wasted ? ` (about ${formatBytes(wasted)} more than needed)` : ""}` : "",
    noAlt.length ? `${noAlt.length} without alt or accessible name` : "",
  ].filter(Boolean);
  const total = assets.reduce((n, a) => n + (a.bytes ?? 0), 0);
  return agentDoc({
    title: "Assets",
    url: opts.url,
    result: parts.length
      ? `${parts.join(", ")}, out of ${plural(assets.length, "asset")}.`
      : `No problem found: ${plural(assets.length, "asset")}, none broken, oversized or missing an alt.`,
    context: [
      assets.length ? `${plural(assets.length, "asset")} on the page, ${formatBytes(total)} known (sizes from Resource Timing).` : "",
      oversized.length ? `Oversized means more pixels than even a 2× screen uses at the displayed size (this screen: ${dpr}×).` : "",
      opts.capped ? "The page is very large: the scan stopped before the end." : "",
    ],
    sections: [{ title: "To fix", body: capped(items, "asset", 20) }],
    verify: items.length
      ? "after deploying, reload the page and Rescan devkit's Assets panel: the Broken, Oversized and No alt filters should count 0."
      : undefined,
    heading: opts.heading,
  });
}
