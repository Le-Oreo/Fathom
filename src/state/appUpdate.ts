import { create } from "zustand";
import { appLatest, openRelease, type AppRelease } from "../platform";
import { toast } from "./ui";

const KEY = "fathom-skip-release";
const EVERY = 6 * 60 * 60 * 1000;

function skipped() {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export const useAppUpdate = create<{ release: AppRelease | null; skipped: string }>(() => ({
  release: null,
  skipped: skipped(),
}));

export async function checkAppUpdate() {
  try {
    useAppUpdate.setState({ release: await appLatest() });
  } catch {
    /* offline, or no releases to see */
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function watchAppUpdates() {
  void checkAppUpdate();
  timer ??= setInterval(() => void checkAppUpdate(), EVERY);
}

export function laterAppUpdate() {
  const v = useAppUpdate.getState().release?.version ?? "";
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* it shows again next time */
  }
  useAppUpdate.setState({ skipped: v });
}

export function downloadAppUpdate() {
  const r = useAppUpdate.getState().release;
  if (r) openRelease(r.url)?.catch(() => toast("Couldn't open the browser", "info", true));
}
