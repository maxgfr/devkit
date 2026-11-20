// Where the CrUX API key and the CrUX answers live. The key is sealed like the AI provider key (AES-GCM under a
// non-extractable CryptoKey in IndexedDB, through llm-connect's sealedStore) but in its own database: clearing the
// AI settings destroys theirs, and must not take this key with it. A plain flag in storage.local tells every devkit
// page that a key is saved, so the side panel notices a key added in Options without reading it.
import { sealedStore } from "llm-connect/sealed-store";
import { browser } from "wxt/browser";
import type { CruxCache } from "./crux";

const KEY_NAME = "crux-api-key";
/** storage.local flag: `true` once a key is saved. Never the key itself. */
export const CRUX_KEY_FLAG = "devkit-crux-key";

const sealed = () => sealedStore({ dbName: "devkit-crux" });

export async function loadCruxKey(): Promise<string | null> {
  return (await sealed().get(KEY_NAME))?.trim() || null;
}

/** Seals and stores `key`; false when this browser has no IndexedDB or WebCrypto to seal it with. */
export async function saveCruxKey(key: string): Promise<boolean> {
  const ok = await sealed().set(KEY_NAME, key.trim());
  if (ok) await browser.storage.local.set({ [CRUX_KEY_FLAG]: true });
  return ok;
}

export async function removeCruxKey(): Promise<void> {
  await sealed().delete(KEY_NAME);
  await browser.storage.local.remove(CRUX_KEY_FLAG);
}

/** CrUX answers in storage.session: shared by devkit pages, gone when the browser quits. */
export const sessionCruxCache: CruxCache = {
  async get(key) {
    return (await browser.storage.session.get(key))[key];
  },
  async set(key, value) {
    await browser.storage.session.set({ [key]: value });
  },
};
