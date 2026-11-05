import { browser } from "wxt/browser";

export interface Env {
  label: string;
  /** `https://staging.example.com`, `http://localhost:3000` */
  origin: string;
  color: string;
  danger: boolean;
}

export interface EnvGroup {
  id: string;
  name: string;
  envs: Env[];
}

export const ENVS_KEY = "envGroups";

export function normalizeOrigin(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return value.trim();
  }
}

/** The group and env `url` belongs to. */
export function matchEnv(groups: EnvGroup[], url: string | undefined): { group: EnvGroup; env: Env } | null {
  if (!url) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  for (const group of groups) for (const env of group.envs) if (normalizeOrigin(env.origin) === origin) return { group, env };
  return null;
}

/** Same path, query and hash on another origin. */
export function switchUrl(url: string, target: Env): string {
  const u = new URL(url);
  return normalizeOrigin(target.origin) + u.pathname + u.search + u.hash;
}

export async function loadEnvs(): Promise<EnvGroup[]> {
  const { [ENVS_KEY]: groups } = await browser.storage.local.get(ENVS_KEY);
  return (groups as EnvGroup[] | undefined) ?? [];
}

export async function saveEnvs(groups: EnvGroup[]): Promise<void> {
  await browser.storage.local.set({ [ENVS_KEY]: groups });
}

/** Injected into a page that belongs to an env: a thin colored ribbon with the env's name. */
export function showRibbon(label: string, color: string): void {
  const id = "devkit-env-ribbon";
  document.getElementById(id)?.remove();
  const el = document.createElement("div");
  el.id = id;
  el.textContent = label;
  el.title = "devkit environment (click to hide)";
  el.setAttribute(
    "style",
    `position:fixed;z-index:2147483647;top:0;left:50%;transform:translateX(-50%);padding:2px 10px;border-radius:0 0 6px 6px;font:600 11px/1.4 system-ui,sans-serif;color:#fff;background:${color};box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer;letter-spacing:.04em;text-transform:uppercase`,
  );
  el.addEventListener("click", () => el.remove());
  document.documentElement.append(el);
}
