import { createLlmSettingsStore, type LlmSettingsStore, liveCatalog, secureStorage } from "llm-connect";

export interface DevkitAiPrefs {
  effort?: string;
  webSearch?: boolean;
}

/**
 * One store per extension page. Every devkit page shares the extension origin, so the side panel
 * and the options page read the same saved settings (key encrypted by `secureStorage`).
 */
let store: LlmSettingsStore<DevkitAiPrefs> | null = null;

export function aiStore(): LlmSettingsStore<DevkitAiPrefs> {
  store ??= createLlmSettingsStore<DevkitAiPrefs>({
    catalog: liveCatalog({ fallbackUrl: "/models.json" }),
    storage: secureStorage({ prefsKey: "devkit-ai", dbName: "devkit-secrets" }),
    defaults: { rememberKey: true },
  });
  return store;
}

export const AI_PREFS_KEY = "devkit-ai";
