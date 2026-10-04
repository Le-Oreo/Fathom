import { create } from "zustand";
import { cleanPrefs, defaults, type Prefs } from "../settings/schema";
import { prefStorage } from "../settings/storage";

interface SettingsState {
  prefs: Prefs;
  saved: number;
}

export const useSettings = create<SettingsState>(() => ({ prefs: defaults(), saved: 0 }));

export const getPrefs = () => useSettings.getState().prefs;

export function setPref<K extends keyof Prefs>(id: K, value: Prefs[K]) {
  const { prefs, saved } = useSettings.getState();
  if (prefs[id] === value) return;
  const next = { ...prefs, [id]: value };
  useSettings.setState({ prefs: next, saved: id === "_lastView" ? saved : saved + 1 });
  prefStorage.save(next);
}

export function replacePrefs(next: Partial<Prefs>) {
  const prefs = { ...defaults(), ...next };
  useSettings.setState({ prefs });
  prefStorage.save(prefs);
}

export async function loadSettings() {
  const raw = await prefStorage.load();
  useSettings.setState({ prefs: { ...defaults(), ...cleanPrefs(raw) } });
}
