import { browser } from "wxt/browser";

export type OptionalPermission = "browsingData" | "cookies" | "contentSettings";

export interface PermissionNeed {
  permissions?: OptionalPermission[];
  origins?: string[];
}

export const ALL_SITES = "<all_urls>";

export async function hasPermission(need: PermissionNeed): Promise<boolean> {
  return browser.permissions.contains({ permissions: need.permissions ?? [], origins: need.origins ?? [] });
}

/**
 * Makes sure devkit holds `need`, asking the user when it does not. Chrome only shows the prompt
 * during a user gesture, so call it first thing in a click handler. Resolves to whether the
 * permission is held afterwards.
 */
export async function ensurePermission(need: PermissionNeed): Promise<boolean> {
  const request = { permissions: need.permissions ?? [], origins: need.origins ?? [] };
  if (await browser.permissions.contains(request)) return true;
  try {
    return await browser.permissions.request(request);
  } catch {
    // Called outside a user gesture (keyboard command, background): the caller explains.
    return false;
  }
}

export class PermissionDenied extends Error {
  constructor(readonly need: PermissionNeed) {
    const what = [...(need.permissions ?? []), ...(need.origins ?? []).map((o) => (o === ALL_SITES ? "all sites" : o))].join(", ");
    super(`devkit needs permission for: ${what}`);
  }
}

/** `ensurePermission` that throws `PermissionDenied`, for code paths that cannot go on without it. */
export async function requirePermission(need: PermissionNeed): Promise<void> {
  if (!(await ensurePermission(need))) throw new PermissionDenied(need);
}
