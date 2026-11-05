import { defineConfig } from "wxt";

// Permissions: only what devkit needs on every page is asked at install. `debugger` and
// `declarativeNetRequest` cannot be optional in Chrome, so they stay required; the rest is
// requested by `ensurePermission()` the first time a feature needs it.
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  hooks: {
    // WXT turns the matches of runtime-registered content scripts into host_permissions. Those
    // scripts are registered only after the user grants "<all_urls>" (optional), so drop it here.
    "build:manifestGenerated": (_wxt, manifest) => {
      manifest.host_permissions = manifest.host_permissions?.filter((p: string) => p !== "<all_urls>");
      if (!manifest.host_permissions?.length) delete manifest.host_permissions;
    },
  },
  manifest: {
    name: "devkit",
    description:
      "Developer toolbox: clear a site's cache and data, inspect the page, rewrite requests, utilities, and AI analysis with your own model.",
    minimum_chrome_version: "116",
    permissions: ["activeTab", "scripting", "storage", "sidePanel", "contextMenus", "declarativeNetRequest", "debugger"],
    optional_permissions: ["browsingData", "cookies", "contentSettings"],
    optional_host_permissions: ["<all_urls>"],
    action: { default_title: "devkit" },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+D" },
        description: "Open the devkit command palette",
      },
      "open-side-panel": {
        suggested_key: { default: "Alt+Shift+S" },
        description: "Open the devkit side panel",
      },
      "fresh-start": {
        suggested_key: { default: "Alt+Shift+X" },
        description: "Clear this site's data and hard reload",
      },
      "hard-reload": {
        description: "Reload the page without cache",
      },
    },
  },
});
