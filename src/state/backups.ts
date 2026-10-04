import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import type { BackupRecord, Progress } from "../device/api";
import { errorMessage, isCancel } from "../device/errors";
import { fmtGB, fmtSize, fmtWhen } from "../files/logic";
import { logActivity } from "./activity";
import { deviceName, isConnected, useDevice } from "./device";
import { getPrefs } from "./settings";
import { askWithCheck, show, toast } from "./ui";

interface Job {
  kind: "backup" | "restore";
  progress: Progress;
}
interface BackupsState {
  /* null until read for this Flipper */
  list: BackupRecord[] | null;
  sdCopy: number | null;
  job: Job | null;
}
export const useBackups = create<BackupsState>(() => ({ list: null, sdCopy: null, job: null }));
const set = useBackups.setState;

let abort: AbortController | null = null;

export async function loadBackups() {
  try {
    const { backups, sdCopy } = await api.backup.list();
    set({ list: backups, sdCopy });
  } catch {
    set({ list: [], sdCopy: null });
  }
}
/* another Flipper, another set of backups */
let lastId: string | undefined;
useDevice.subscribe((s) => {
  if (s.status === "connected" && s.info?.id !== lastId) {
    lastId = s.info?.id;
    set({ list: null, sdCopy: null });
  }
});

const progressOf = (p: Progress) => (p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0);
export const jobPercent = (j: Job | null) => (j ? progressOf(j.progress) : 0);

export const cancelBackupJob = () => {
  if (useBackups.getState().job?.kind === "backup") abort?.abort();
};

export async function backupNow(opts: { ask: boolean; sd?: boolean } = { ask: true }): Promise<boolean> {
  if (useBackups.getState().job) return false;
  const name = deviceName();
  let sd = opts.sd ?? false;
  if (opts.ask) {
    const used = useDevice.getState().sd?.used;
    const copy = useBackups.getState().sdCopy;
    const check =
      used === undefined
        ? "SD card too"
        : copy
          ? `SD card too (only what changed since ${fmtWhen(copy)})`
          : `SD card too (about ${used >= 1073741824 ? `${fmtGB(used)} GB` : fmtSize(used)} the first time)`;
    const r = await askWithCheck({
      title: `Back up ${name}?`,
      body: "Settings and keys on its internal storage are saved on this computer. Without the box ticked, the SD card isn't included.",
      ok: "Back up",
      check,
      checked: false,
    });
    if (!r) return false;
    sd = r.checked;
  }
  abort = new AbortController();
  set({ job: { kind: "backup", progress: { done: 0, total: 0 } } });
  try {
    await api.backup.create(
      { sd },
      { signal: abort.signal, onProgress: (progress) => set({ job: { kind: "backup", progress } }) },
    );
  } catch (err) {
    if (!isCancel(err)) toast(errorMessage(err), "info", true);
    else toast("Backup cancelled", "archive");
    return false;
  } finally {
    abort = null;
    set({ job: null });
    void loadBackups();
  }
  logActivity("archive", `Backed up ${name}`);
  toast(sd ? `Backed up ${name} and its SD card` : `Backed up ${name}`, "archive");
  buddyReact("backup");
  return true;
}

export function showBackups() {
  show("firmware");
  requestAnimationFrame(() => document.getElementById("backups")?.scrollIntoView({ block: "center" }));
}

async function reconnectAfterRestart(name: string): Promise<boolean> {
  if (!getPrefs().autoConnect) {
    toast(`${name} restarted. Press Scan again to connect.`, "anchor");
    return false;
  }
  try {
    await api.connection.connect();
  } catch (err) {
    toast(`${name} restarted but didn't reconnect. ${errorMessage(err)}`, "anchor", true);
    return false;
  }
  return isConnected();
}

export async function restoreBackup(rec: BackupRecord) {
  if (useBackups.getState().job) return;
  const name = deviceName(),
    when = fmtWhen(rec.created),
    copy = useBackups.getState().sdCopy;
  const body = `Settings and keys go back to the backup from ${when}, then ${name} restarts. Saved signals stay as they are.`;
  const r = await askWithCheck({
    title: `Restore ${name}?`,
    body,
    ok: "Restore",
    check: copy
      ? `Put the SD card copy back too (from ${fmtWhen(copy)}; nothing on the card is deleted)`
      : "Put the SD card back too (there's no SD card copy yet)",
    checked: false,
  });
  if (!r) return;
  if (r.checked && !copy) return toast("There's no SD card copy yet. Back up with the SD card first.", "archive", true);
  abort = new AbortController();
  set({ job: { kind: "restore", progress: { done: 0, total: 0 } } });
  try {
    await api.backup.restore(
      rec.id,
      { sd: r.checked },
      { signal: abort.signal, onProgress: (progress) => set({ job: { kind: "restore", progress } }) },
    );
  } catch (err) {
    set({ job: null });
    abort = null;
    const why = isCancel(err) ? "It was cancelled" : errorMessage(err);
    return toast(
      `The restore didn't finish, so ${name} may have only some of its settings back. ${why}. Restore again to finish.`,
      "info",
      true,
    );
  }
  abort = null;
  set({ job: null });
  buddyReact("restored");
  if (await reconnectAfterRestart(name)) toast(`Restored the backup from ${when}`, "clock");
}

export const backupSize = (rec: BackupRecord) => fmtSize(rec.size);
