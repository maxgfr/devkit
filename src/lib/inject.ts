import { browser } from "wxt/browser";

export type World = "ISOLATED" | "MAIN";

/**
 * Runs `func` in the top frame of `tabId` and returns its (awaited) result. `func` is serialized:
 * it must not use anything from its enclosing scope, only its arguments.
 */
export async function runInTab<Args extends unknown[], R>(
  tabId: number,
  func: (...args: Args) => R | Promise<R>,
  args: Args = [] as unknown as Args,
  world: World = "ISOLATED",
): Promise<Awaited<R>> {
  const [result] = await browser.scripting.executeScript({ target: { tabId }, func, args, world } as never);
  if (!result) throw new Error("The page did not answer (it may still be loading).");
  if ("error" in result && result.error) throw new Error(String((result.error as { message?: string }).message ?? result.error));
  return result.result as Awaited<R>;
}

/** Explains why a script could not run, in words the user can act on. */
export function injectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot access|permission|host/i.test(message))
    return "devkit has no access to this page yet. Grant access to this site (or all sites) and try again.";
  if (/chrome:\/\/|extensions gallery|cannot be scripted/i.test(message)) return "Chrome does not let extensions run on this page.";
  return message;
}
