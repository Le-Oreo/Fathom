import { create } from "zustand";
import { api } from "../device";
import { DeviceError } from "../device/api";
import { errorMessage } from "../device/errors";
import { fmtSize, isUnder, parentOf } from "../files/logic";
import { deviceName, useDevice } from "./device";
import { applyDelete, onFilesChanged } from "./files";
import { ask, toast } from "./ui";

export interface InstalledApp {
  name: string;
  path: string;
  category: string;
  size: number;
}
interface AppsState {
  hidden: Set<string>;
  installed: InstalledApp[] | null;
  loading: boolean;
}
export const useApps = create<AppsState>(() => ({ hidden: new Set(), installed: null, loading: false }));
const get = useApps.getState,
  set = useApps.setState;

const hiddenKey = () => `fathom-hidden-apps:${useDevice.getState().info?.firmware ?? ""}`;
function loadHidden() {
  try {
    set({ hidden: new Set(JSON.parse(localStorage.getItem(hiddenKey()) || "[]") as string[]) });
  } catch {
    set({ hidden: new Set() });
  }
}
export function hideApp(name: string) {
  const hidden = new Set(get().hidden).add(name);
  set({ hidden });
  try {
    localStorage.setItem(hiddenKey(), JSON.stringify([...hidden]));
  } catch {
    /* can't keep it: hidden for this visit only */
  }
}
useDevice.subscribe((s, old) => {
  if (s.info?.firmware !== old.info?.firmware) loadHidden();
  if (s.status !== old.status) set({ installed: null });
});

/* "flappy_bird.fap" -> "Flappy bird" */
export const appTitle = (file: string) => {
  const base = file
    .replace(/\.fap$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
};
export const appSize = (a: InstalledApp) => fmtSize(a.size);

export async function loadInstalled() {
  set({ loading: true });
  const out: InstalledApp[] = [];
  try {
    for (const cat of await api.storage.list("/ext/apps")) {
      if (!cat.dir) continue;
      for (const f of await api.storage.list(`/ext/apps/${cat.name}`))
        if (!f.dir && f.name.toLowerCase().endsWith(".fap"))
          out.push({ name: f.name, path: `/ext/apps/${cat.name}/${f.name}`, category: cat.name, size: f.size });
    }
    out.sort((a, b) => appTitle(a.name).localeCompare(appTitle(b.name)));
    set({ installed: out });
  } catch (err) {
    if (err instanceof DeviceError && (err.code === "not-found" || err.code === "no-sd")) set({ installed: [] });
    else toast(errorMessage(err), "info", true);
  } finally {
    set({ loading: false });
  }
}

export async function removeInstalled(app: InstalledApp) {
  const title = appTitle(app.name);
  const body = `It's removed from ${deviceName()}'s SD card. Its saved data stays in apps_data.`;
  if (!(await ask({ title: `Remove ${title}?`, body, ok: "Remove", danger: true }))) return;
  const done = await applyDelete(parentOf(app.path), [app.name], new Set());
  if (!done.length) return;
  set({ installed: (get().installed ?? []).filter((a) => a.path !== app.path) });
  toast(`Removed ${title}`, "trash");
}

onFilesChanged((dirs) => {
  if (get().installed !== null && dirs.some((d) => isUnder(d, "/ext/apps"))) void loadInstalled();
});
