import { describe, expect, it } from "vitest";
import { bumpOf, nextVersion, releaseNotes } from "../scripts/next-version.ts";

describe("next release version", () => {
  it("does not release docs, ci, chore or test commits", () => {
    expect(nextVersion("0.1.0", ["docs: readme", "ci: cache pnpm", "chore(deps): bump", "test: e2e"])).toBeNull();
  });
  it("bumps the patch for fixes and perf", () => {
    expect(nextVersion("0.1.0", ["fix(utils): cron crash", "docs: x"])).toBe("0.1.1");
    expect(nextVersion("v1.2.3", ["perf: faster palette"])).toBe("1.2.4");
  });
  it("bumps the minor for features, over fixes", () => {
    expect(nextVersion("0.1.4", ["fix: a", "feat(network): b", "fix: c"])).toBe("0.2.0");
  });
  it("treats breaking changes as a minor before 1.0, a major after", () => {
    expect(bumpOf(["feat!: new storage format"])).toBe("major");
    expect(bumpOf(["refactor: x\n\nBREAKING CHANGE: settings reset"])).toBe("major");
    expect(nextVersion("0.3.2", ["feat!: x"])).toBe("0.4.0");
    expect(nextVersion("2.3.2", ["fix(ai)!: x"])).toBe("3.0.0");
  });
  it("ignores messages that are not Conventional Commits", () => {
    expect(nextVersion("0.1.0", ["Merge branch main", "update stuff"])).toBeNull();
  });
  it("writes notes with features first, fixes next, and skips the rest", () => {
    expect(releaseNotes(["fix(utils): cron crash\n\nbody", "docs: x", "feat: palette history", "perf: faster"])).toBe(
      "### Features\n\n- palette history\n\n### Fixes\n\n- **utils**: cron crash\n- faster",
    );
  });
});
