// Next release version from Conventional Commits since the last `v*` tag:
// a breaking change bumps the major (the minor before 1.0), `feat` the minor, `fix` and `perf` the patch.
// Anything else (docs, ci, chore, test, refactor, style) does not release.
// CLI: `node scripts/next-version.ts` prints the version, or nothing, writes it to $GITHUB_OUTPUT
// and the notes to release-notes.md.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export type Bump = "major" | "minor" | "patch" | null;

const HEADER = /^(\w+)(\([^)]*\))?(!)?:\s/;

export function bumpOf(messages: string[]): Bump {
  let bump: Bump = null;
  for (const message of messages) {
    const m = HEADER.exec(message);
    if (!m) continue;
    if (m[3] || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
    if (m[1] === "feat") bump = "minor";
    else if ((m[1] === "fix" || m[1] === "perf") && bump === null) bump = "patch";
  }
  return bump;
}

export function nextVersion(current: string, messages: string[]): string | null {
  const bump = bumpOf(messages);
  if (!bump) return null;
  const [major = 0, minor = 0, patch = 0] = current.replace(/^v/, "").split(".").map(Number);
  if (bump === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Markdown release notes: features, then fixes, one line per commit subject. */
export function releaseNotes(messages: string[]): string {
  const sections: [string, string[]][] = [
    ["Features", ["feat"]],
    ["Fixes", ["fix", "perf"]],
  ];
  const out: string[] = [];
  for (const [title, types] of sections) {
    const lines = messages
      .map((m) => m.split("\n")[0] ?? "")
      .map((subject) => ({ subject, m: HEADER.exec(subject) }))
      .filter(({ m }) => m && types.includes(m[1] ?? ""))
      .map(({ subject, m }) => {
        const scope = m?.[2] ? `**${m[2].slice(1, -1)}**: ` : "";
        return `- ${scope}${subject.slice(m?.[0].length ?? 0)}`;
      });
    if (lines.length) out.push(`### ${title}\n\n${lines.join("\n")}`);
  }
  return out.join("\n\n");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (import.meta.main) {
  let last = "";
  try {
    last = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  } catch {
    // No release yet: every commit counts, from 0.0.0.
  }
  const range = last ? [`${last}..HEAD`] : ["HEAD"];
  const messages = git("log", ...range, "--format=%B%x00")
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
  const version = nextVersion(last || "0.0.0", messages) ?? "";
  console.log(version);
  if (version) writeFileSync("release-notes.md", `${releaseNotes(messages)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprevious=${last}\n`);
}
