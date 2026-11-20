import { browser } from "wxt/browser";
import { fetchRepoFiles, readRepoPage } from "../lib/page/repo-files";
import { loadRepoDeps, type PackageInfo } from "../lib/repo-deps";
import type { PackageInfoMessage } from "../lib/repo-deps-info";
import { BOX_TAG, boxAnchor, fillDepsBox, renderDepsBox } from "../lib/repo-deps-view";

/**
 * The opt-in Dependencies box on github.com and gitlab.com, registered at runtime from Options or the Repo
 * dependencies panel once the user grants access to those two sites. Both sites navigate in-app, so it follows URL
 * changes, and puts its box back when the page re-renders over it.
 */
export default defineContentScript({
  matches: ["https://github.com/*", "https://gitlab.com/*"],
  registration: "runtime",
  runAt: "document_idle",
  main() {
    let shown: { key: string; box: HTMLElement | null } | null = null;
    let loading: string | null = null;

    const place = (box: HTMLElement, host: "github" | "gitlab") => {
      const anchor = boxAnchor(host);
      if (!anchor) return false;
      if (anchor.nextElementSibling !== box) anchor.after(box);
      return true;
    };

    const update = async () => {
      const url = location.href.split("#")[0]!;
      // Folder pages only: a file page shows that file.
      const isFolder = !/\/(?:-\/)?blob\//.test(location.pathname);
      if (shown?.key !== url) {
        for (const old of document.querySelectorAll(BOX_TAG)) old.remove();
        shown = null;
      }
      if (!isFolder) return;
      if (shown) {
        // Same page, re-rendered: put the box back if the page dropped it, or below the README once it shows up.
        if (shown.box) place(shown.box, shown.box.dataset.host === "gitlab" ? "gitlab" : "github");
        return;
      }
      if (loading === url) return;
      loading = url;
      try {
        const result = await loadRepoDeps(url, readRepoPage(), fetchRepoFiles);
        if (location.href.split("#")[0] !== url) return;
        const useful = result?.manifests.some((m) => m.deps.length || m.workspaces.length);
        if (!result || !useful) {
          shown = { key: url, box: null };
          return;
        }
        const box = renderDepsBox(result);
        box.dataset.host = result.loc.host;
        shown = { key: url, box };
        place(box, result.loc.host);
        const deps = result.manifests.flatMap((m) => m.deps).map(({ name, ecosystem, source }) => ({ name, ecosystem, source }));
        const message: PackageInfoMessage = { type: "devkit:package-info", deps };
        const info = (await browser.runtime.sendMessage(message).catch(() => null)) as Record<string, PackageInfo> | null;
        if (info) fillDepsBox(box, info);
      } finally {
        if (loading === url) loading = null;
      }
    };

    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        update();
      }, 300);
    };
    // The root, not the body: Turbo swaps the whole body on navigation.
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("turbo:load", schedule);
    window.addEventListener("popstate", schedule);
    update();
  },
});
