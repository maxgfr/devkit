import { browser } from "wxt/browser";

/*
 * One chrome.debugger attachment per tab, shared by every devkit tool that needs it (Emulation and
 * the full-page screenshot in the side panel, API mocks in the background). Chrome lets an
 * extension attach once per tab, and any of its pages can then send commands on that session.
 * Each tool claims the session under its own name and releases it when done; the last one out
 * detaches. Claims live in storage.session so the panel and the service worker see the same list.
 */

export type DebuggerUser = "emulation" | "screenshot" | "mocks";

const KEY = "debuggerUsers";
type Users = Record<string, DebuggerUser[]>;

async function readUsers(): Promise<Users> {
  const { [KEY]: users } = await browser.storage.session.get(KEY);
  return (users as Users | undefined) ?? {};
}

async function writeUsers(tabId: number, list: DebuggerUser[]) {
  const users = await readUsers();
  if (list.length) users[tabId] = list;
  else delete users[tabId];
  await browser.storage.session.set({ [KEY]: users });
}

/** Tools holding the session on `tabId`. */
export async function debuggerUsers(tabId: number): Promise<DebuggerUser[]> {
  return (await readUsers())[tabId] ?? [];
}

/** Words for attach errors the user can act on. */
export function debuggerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/chrome:\/\/|chrome-extension:\/\/|Cannot access|Cannot attach|webstore/i.test(message))
    return "Chrome does not let extensions debug this page. Open a web page.";
  if (/No tab with given id/i.test(message)) return "The tab is gone.";
  return message;
}

/** Whether this extension holds a debugger session on `tabId` (any of its pages may have attached). */
export async function isAttached(tabId: number): Promise<boolean> {
  try {
    await browser.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "0", returnByValue: true });
    return true;
  } catch (e) {
    // Any other refusal (a page between two documents) still means the session is there.
    return !/not attached|No tab with given id/i.test(String(e instanceof Error ? e.message : e));
  }
}

/** Attaches to `tabId` unless devkit already is, and records `user` as holding the session. */
export async function claimDebugger(tabId: number, user: DebuggerUser): Promise<void> {
  let fresh = true;
  try {
    await browser.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // Another devkit page attached first: the session is ours to share.
    if (!/already attached/i.test(String(e instanceof Error ? e.message : e)) || !(await isAttached(tabId)))
      throw new Error(debuggerError(e));
    fresh = false;
  }
  // A new session has no other holder, whatever an older one left behind.
  if (fresh) return writeUsers(tabId, [user]);
  const list = await debuggerUsers(tabId);
  if (!list.includes(user)) await writeUsers(tabId, [...list, user]);
}

/** Drops `user`'s claim; detaches when nobody else holds the session. Resolves to whether it detached. */
export async function releaseDebugger(tabId: number, user: DebuggerUser): Promise<boolean> {
  const rest = (await debuggerUsers(tabId)).filter((u) => u !== user);
  await writeUsers(tabId, rest);
  if (rest.length) return false;
  await browser.debugger.detach({ tabId }).catch(() => undefined);
  return true;
}

/** Forgets every claim on `tabId`: call it when Chrome reports the session detached. */
export async function forgetDebugger(tabId: number): Promise<void> {
  await writeUsers(tabId, []);
}
