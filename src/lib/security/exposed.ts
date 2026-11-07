// Source maps and files a server should not serve, with content signatures so a 200 alone proves nothing.
import type { Level } from "../headers";

/** The `sourceMappingURL` a script or stylesheet ends with, or null. Inline `data:` maps are returned as is. */
export function findSourceMapUrl(text: string): string | null {
  const tail = text.slice(-4096);
  let last: string | null = null;
  for (const m of tail.matchAll(/(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*'"]+)/g)) last = m[1] ?? null;
  return last;
}

/** Whether `text` (the beginning of a response) is a source map. */
export function isSourceMap(text: string): boolean {
  const body = text.replace(/^\)\]\}'[^\n]*\n/, "").trimStart();
  return body.startsWith("{") && /"version"\s*:\s*3/.test(body.slice(0, 4096)) && /"(mappings|sources|sections)"\s*:/.test(body);
}

export interface ProbeResponse {
  status: number;
  /** The first bytes of the body, decoded as UTF-8. */
  text: string;
  bytes: Uint8Array;
  type: string;
  url: string;
}

export interface Probe {
  path: string;
  /** Why the file matters, in a line. */
  why: string;
  /** Level when the file is there and its content matches. */
  found: Level;
  /** Does the body look like the real file (rather than an error or fallback page)? */
  matches: (r: ProbeResponse) => boolean;
}

const looksHtml = (t: string) => /^\s*(<!doctype|<html|<head|<body|<\?xml)/i.test(t);

export const PROBES: Probe[] = [
  {
    path: "/.git/HEAD",
    why: "A readable .git folder lets anyone download the repository: source, history, sometimes credentials.",
    found: "bad",
    matches: (r) => /^(ref: refs\/|[0-9a-f]{40}\s*$)/.test(r.text.trim()),
  },
  {
    path: "/.git/config",
    why: "Git configuration: remote URLs, sometimes with tokens in them.",
    found: "bad",
    matches: (r) => /^\s*\[core\]/m.test(r.text) && !looksHtml(r.text),
  },
  ...["/.env", "/.env.local", "/.env.production"].map(
    (path): Probe => ({
      path,
      why: "Environment file: usually database passwords and API keys.",
      found: "bad",
      matches: (r) => {
        if (looksHtml(r.text)) return false;
        const lines = r.text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
        const assignments = lines.filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(l));
        return assignments.length > 0 && assignments.length >= lines.length * 0.6;
      },
    }),
  ),
  {
    path: "/.DS_Store",
    why: "macOS folder metadata: lists the file names in the folder, including ones never linked.",
    found: "warn",
    matches: (r) => [0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31].every((b, i) => r.bytes[i] === b),
  },
  {
    path: "/server-status",
    why: "Apache mod_status: live requests, client IPs and internal URLs.",
    found: "warn",
    matches: (r) => /Apache Server Status|Server Version:.*Apache/i.test(r.text),
  },
  {
    path: "/phpinfo.php",
    why: "phpinfo(): server paths, modules, environment variables.",
    found: "bad",
    matches: (r) => /<title>\s*phpinfo\(\)|PHP Version \d/i.test(r.text),
  },
  {
    path: "/wp-config.php.bak",
    why: "A WordPress config backup is served as text, database password included.",
    found: "bad",
    matches: (r) => /DB_PASSWORD|define\s*\(\s*['"]DB_/.test(r.text),
  },
  {
    path: "/.well-known/security.txt",
    why: "Tells researchers how to report a vulnerability (RFC 9116). Present is good.",
    found: "good",
    matches: (r) => /^\s*Contact:/im.test(r.text) && !looksHtml(r.text),
  },
];

export type ProbeState = "exposed" | "present" | "fallback" | "unverified" | "blocked" | "absent" | "error";

export interface ProbeVerdict {
  state: ProbeState;
  level: Level;
  detail: string;
}

/** Whether `r` is the same page the site answers for a path that cannot exist (an SPA fallback, a soft 404). */
export function sameAsBaseline(r: ProbeResponse, baseline: ProbeResponse | null): boolean {
  if (!baseline || r.status !== baseline.status) return false;
  if (r.text === baseline.text) return true;
  const a = r.text.length;
  const b = baseline.text.length;
  return looksHtml(r.text) && looksHtml(baseline.text) && Math.abs(a - b) <= Math.max(64, b * 0.03);
}

/** What a probe's answer means, compared with the answer for a random path. */
export function judgeProbe(probe: Probe, r: ProbeResponse | { error: string }, baseline: ProbeResponse | null): ProbeVerdict {
  const goodWhenFound = probe.found === "good";
  if ("error" in r) return { state: "error", level: "info", detail: r.error };
  if (r.status >= 200 && r.status < 300) {
    if (probe.matches(r))
      return goodWhenFound
        ? { state: "present", level: "good", detail: "Present" }
        : { state: "exposed", level: probe.found, detail: `HTTP ${r.status} and the content matches: ${probe.why}` };
    if (sameAsBaseline(r, baseline))
      return {
        state: "fallback",
        level: goodWhenFound ? "info" : "good",
        detail: `HTTP ${r.status}, but the same page as any unknown path (fallback): not there`,
      };
    return {
      state: "unverified",
      level: "info",
      detail: `HTTP ${r.status}, but the content does not look like ${probe.path.split("/").pop()}`,
    };
  }
  if (r.status === 401 || r.status === 403)
    return { state: "blocked", level: "info", detail: `HTTP ${r.status}: denied (it may or may not exist)` };
  if (goodWhenFound)
    return { state: "absent", level: "info", detail: `HTTP ${r.status}: no security.txt, researchers have no published contact` };
  return { state: "absent", level: "good", detail: `HTTP ${r.status}: not served` };
}

/** A path no site has, to learn what the server answers for unknown URLs. */
export function baselinePath(random = Math.random): string {
  const id = Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `/devkit-probe-${id}.txt`;
}
