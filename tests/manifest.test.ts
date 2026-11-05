import { describe, expect, it } from "vitest";
import config from "../wxt.config";

// Chrome Web Store limits: the store rejects an upload that breaks them.
describe("manifest", () => {
  const manifest = config.manifest as { name: string; description: string; permissions: string[] };
  it("fits the store's length limits", () => {
    expect(manifest.name.length).toBeLessThanOrEqual(75);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });
  it("asks only for the install-time permissions the store listing justifies", () => {
    expect(manifest.permissions.sort()).toEqual(
      ["activeTab", "contextMenus", "debugger", "declarativeNetRequest", "scripting", "sidePanel", "storage"].sort(),
    );
  });
});
