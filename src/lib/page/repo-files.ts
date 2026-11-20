// Page functions for Repo dependencies, run in GitHub / GitLab pages (ISOLATED world). Self-contained: they are
// serialized by `runInTab` and also called directly by the in-page box's content script.

import type { RepoFileRequest, RepoFileResult, RepoPageFacts } from "../repo-deps";

/** Reads which forge, project and ref the page shows, and the files its folder listing links to. */
export function readRepoPage(): RepoPageFacts {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() || null;
  const siteName = meta('meta[property="og:site_name"]');
  const nwo = meta('meta[name="octolytics-dimension-repository_nwo"]');
  const glPath = document.body?.dataset.projectFullPath ?? null;
  const site: RepoPageFacts["site"] =
    siteName === "GitHub" || nwo || meta('meta[name="expected-hostname"]') ? "github" : siteName === "GitLab" || glPath ? "gitlab" : null;
  let ref: string | null = null;
  if (site === "github") {
    const picker = document.querySelector(
      '#ref-picker-repos-header-ref-selector, button[id^="ref-picker"], [data-testid="anchor-button"][id*="ref-selector"]',
    );
    ref = picker?.textContent?.trim() || null;
    if (!ref) {
      for (const s of document.querySelectorAll('script[type="application/json"][data-target="react-app.embeddedData"]')) {
        const m = /"refInfo":\{"name":"((?:[^"\\]|\\.)*)"/.exec(s.textContent ?? "");
        if (m) {
          try {
            ref = JSON.parse(`"${m[1]}"`) as string;
          } catch {
            ref = m[1]!;
          }
          break;
        }
      }
    }
  } else if (site === "gitlab") {
    ref =
      document.querySelector<HTMLElement>("#js-ambiguous-ref-modal")?.dataset.ref ||
      document.querySelector('[data-testid="ref-dropdown-container"] .gl-new-dropdown-button-text')?.textContent?.trim() ||
      null;
  }
  const scope =
    site === "github"
      ? '[data-testid="directory-content"] a[href*="/blob/"], table[aria-labelledby="folders-and-files"] a[href*="/blob/"]'
      : 'a.tree-item-link[href*="/-/blob/"], #tree-holder table a[href*="/-/blob/"]';
  const links = site ? [...new Set([...document.querySelectorAll<HTMLAnchorElement>(scope)].map((a) => a.href))].slice(0, 2000) : [];
  // On GitLab, no project path means a group or another non-project page.
  return { site, project: site === "gitlab" ? (glPath ?? "") : nwo, ref, links };
}

/**
 * Fetches repository files from the page, with the page's session, so private repositories work too. Files larger
 * than `maxBytes` come back without their text.
 */
export async function fetchRepoFiles(files: RepoFileRequest[], maxBytes: number): Promise<RepoFileResult[]> {
  const findLines = (value: unknown, depth: number): string[] | null => {
    if (depth > 12 || typeof value !== "object" || value === null) return null;
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.rawLines) && rec.rawLines.every((l) => typeof l === "string")) return rec.rawLines as string[];
    for (const v of Object.values(rec)) {
      const found = findLines(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const fromBlobPage = async (f: RepoFileRequest): Promise<RepoFileResult> => {
    const res = await fetch(f.blob!, { credentials: "same-origin", headers: { accept: "text/html" } });
    if (!res.ok) return { path: f.path, status: res.status };
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    for (const s of doc.querySelectorAll('script[type="application/json"][data-target$="embeddedData"]')) {
      try {
        const lines = findLines(JSON.parse(s.textContent ?? ""), 0);
        if (lines) return { path: f.path, status: res.status, text: lines.join("\n") };
      } catch {
        // Not JSON: next script.
      }
    }
    return { path: f.path, status: 0, error: "The file page did not include the file's content." };
  };
  const one = async (f: RepoFileRequest): Promise<RepoFileResult> => {
    try {
      const res = await fetch(f.raw, { credentials: "same-origin" });
      if (!res.ok) return { path: f.path, status: res.status };
      const length = Number(res.headers.get("content-length"));
      if (length > maxBytes) return { path: f.path, status: res.status, tooLarge: true };
      const text = await res.text();
      if (text.length > maxBytes) return { path: f.path, status: res.status, tooLarge: true };
      // A sign-in page instead of the file: the repository needs a session this tab does not have.
      if ((res.headers.get("content-type") ?? "").includes("text/html") && /^\s*<(?:!doctype|html)/i.test(text))
        return { path: f.path, status: 401 };
      return { path: f.path, status: res.status, text };
    } catch (e) {
      if (f.blob)
        try {
          return await fromBlobPage(f);
        } catch {
          // Fall through to the first error.
        }
      return { path: f.path, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return Promise.all(files.map(one));
}
