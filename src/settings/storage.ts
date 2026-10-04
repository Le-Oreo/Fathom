import { isTauri } from "@tauri-apps/api/core";

export interface PrefStorage {
  load(): Promise<unknown>;
  save(data: unknown): void;
}

export const PREF_KEY = "fathom-settings";

export const browserStorage: PrefStorage = {
  async load() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    } catch {
      return {}; /* storage blocked or garbled: defaults for this visit */
    }
  },
  save(data) {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(data));
    } catch {
      /* this viewer can't save; settings last for this visit */
    }
  },
};

function appStorage(): PrefStorage {
  const store = import("@tauri-apps/plugin-store").then((m) => m.load("settings.json", { autoSave: 300 }));
  return {
    async load() {
      try {
        return (await (await store).get("prefs")) ?? {};
      } catch {
        return {};
      }
    },
    save(data) {
      void store.then((s) => s.set("prefs", data)).catch(() => {});
    },
  };
}

export const prefStorage: PrefStorage = isTauri() ? appStorage() : browserStorage;
