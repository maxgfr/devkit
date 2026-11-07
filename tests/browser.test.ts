import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ACTIONS, actionBlocker, actionContext, findAction } from "../src/lib/actions";
import { PANELS } from "../src/lib/panels";
import { ensurePermission } from "../src/lib/permissions";
import { isScriptable, originOf } from "../src/lib/tab";
import { searchItems } from "../src/ui/Palette";

beforeEach(() => fakeBrowser.reset());

describe("permissions", () => {
  it("does not prompt when already granted", async () => {
    const contains = vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true as never);
    const request = vi.spyOn(fakeBrowser.permissions, "request");
    expect(await ensurePermission({ permissions: ["browsingData"] })).toBe(true);
    expect(contains).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("asks, and resolves false when the prompt throws (no user gesture)", async () => {
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(false as never);
    vi.spyOn(fakeBrowser.permissions, "request").mockRejectedValue(new Error("must be called during a user gesture"));
    expect(await ensurePermission({ origins: ["<all_urls>"] })).toBe(false);
  });
});

describe("actions & registry", () => {
  it("knows web pages from internal pages", () => {
    expect(originOf("https://ex.com/a?b")).toBe("https://ex.com");
    expect(originOf("chrome://settings")).toBeNull();
    expect(isScriptable("https://chromewebstore.google.com/x")).toBe(false);
  });
  it("blocks page actions outside web pages", () => {
    const action = findAction("clear-cache")!;
    expect(actionBlocker(action, actionContext({ id: 1, url: "chrome://newtab" } as never))).toMatch(/web pages/);
    expect(actionBlocker(action, actionContext({ id: 1, url: "https://ex.com" } as never))).toBeNull();
  });
  it("has unique ids across actions and panels", () => {
    const ids = [...ACTIONS.map((a) => a.id), ...PANELS.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("palette search ranks title prefixes first", () => {
    expect(searchItems("json")[0]!.title).toMatch(/^JSON/);
    expect(searchItems("structured data").some((i) => i.id === "jsonld")).toBe(true);
    expect(searchItems("zzzz")).toEqual([]);
  });
  it("palette finds each tool by what its view shows", () => {
    const finds = (q: string, id: string) =>
      expect(
        searchItems(q).map((i) => i.id),
        q,
      ).toContain(id);
    finds("secret", "secrets");
    finds("csp", "csp");
    finds("sri", "third-parties");
    finds("source map", "exposed");
    finds("element", "element");
    finds("react", "element");
    finds("waterfall", "perf");
    finds("page report", "overview");
    finds("cookie audit", "cookies");
  });
});
