// The opt-in "Dependencies" box on github.com and gitlab.com repository pages: a content script registered at
// runtime once the user grants access to those two sites only.
import { browser } from "wxt/browser";
import { ensurePermission } from "./permissions";

export const REPO_DEPS_SCRIPT_ID = "devkit-repo-deps";
export const REPO_DEPS_ORIGINS = ["https://github.com/*", "https://gitlab.com/*"];

export async function repoDepsBoxEnabled(): Promise<boolean> {
  return (await browser.scripting.getRegisteredContentScripts({ ids: [REPO_DEPS_SCRIPT_ID] })).length > 0;
}

/** Asks for github.com and gitlab.com (call it from a click) and registers the box. Resolves to whether it is on. */
export async function enableRepoDepsBox(): Promise<boolean> {
  if (!(await ensurePermission({ origins: REPO_DEPS_ORIGINS }))) return false;
  if (await repoDepsBoxEnabled()) return true;
  await browser.scripting.registerContentScripts([
    {
      id: REPO_DEPS_SCRIPT_ID,
      js: ["content-scripts/repo-deps.js"],
      matches: REPO_DEPS_ORIGINS,
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ] as never);
  return true;
}

export async function disableRepoDepsBox(): Promise<void> {
  if (await repoDepsBoxEnabled()) await browser.scripting.unregisterContentScripts({ ids: [REPO_DEPS_SCRIPT_ID] });
}
