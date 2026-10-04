import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { channelName, ghChannel, INSTALL_STEPS, POINT_OF_NO_RETURN } from "../catalog";
import { api } from "../device";
import type { Channel, FirmwareRelease } from "../device/api";
import { errorMessage, isCancel } from "../device/errors";
import { DeviceError } from "../device/api";
import { backupNow, cancelBackupJob } from "./backups";
import { deviceName, isOfficial, updateAvailable, useDevice } from "./device";
import { useSettings } from "./settings";
import { ask, toast } from "./ui";

export type ChannelChoice = Channel | "custom";

interface FirmwareState {
  installing: boolean;
  step: number;
  sub: number;
  total: number;
  finished: boolean;
  backupFirst: boolean;
  channel: ChannelChoice;
  release: FirmwareRelease | null;
  loading: boolean;
  failed: { message: string; step: number } | null;
  /* the version it was installing, for the done card */
  target: string;
}
export const useFirmware = create<FirmwareState>(() => ({
  installing: false,
  step: -1,
  sub: 0,
  total: 0,
  finished: false,
  backupFirst: true,
  channel: "release",
  release: null,
  loading: false,
  failed: null,
  target: "",
}));
const get = useFirmware.getState,
  set = useFirmware.setState;

useSettings.subscribe((s, old) => {
  if (!get().installing && s.prefs.backupFirst !== old.prefs.backupFirst) set({ backupFirst: s.prefs.backupFirst });
});
useDevice.subscribe((s, old) => {
  if (s.latest !== old.latest && get().channel === "release" && !get().installing) set({ release: s.latest ?? null });
});

export const setBackupFirst = (backupFirst: boolean) => set({ backupFirst });

let channelSeq = 0;
export async function setChannel(channel: ChannelChoice) {
  if (get().installing) return;
  const seq = ++channelSeq;
  set({ channel, failed: null, finished: false, step: -1, sub: 0, total: 0 });
  if (channel === "custom") return set({ release: null, loading: false });
  if (channel === "release") {
    const latest = useDevice.getState().latest;
    if (latest !== undefined) return set({ release: latest, loading: false });
  }
  set({ release: null, loading: true });
  try {
    const release = await api.firmware.latest(channel);
    if (seq === channelSeq) set({ release, loading: false });
  } catch (err) {
    if (seq !== channelSeq) return;
    set({ loading: false });
    toast(errorMessage(err), "info", true);
  }
}

/* Custom package: an update .tgz from the computer. */
export async function pickPackage() {
  if (get().installing) return;
  try {
    const release = await api.firmware.pick();
    if (release) set({ release, failed: null, finished: false, step: -1 });
  } catch (err) {
    toast(errorMessage(err), "info", true);
  }
}

export function canInstall(s: FirmwareState = get()) {
  const r = s.release,
    info = useDevice.getState().info;
  if (!r || s.installing) return false;
  return !!r.file || !info || r.version !== info.firmware;
}

class BackupFailed extends Error {}

let abort: AbortController | null = null;
export const cancelInstall = () => {
  if (!get().installing || get().step >= POINT_OF_NO_RETURN) return;
  abort?.abort();
  cancelBackupJob();
};

const n = INSTALL_STEPS.length;
const progressOf = (step: number, pct: number) => {
  const s = pct >= 100 ? step + 1 : step,
    sub = pct >= 100 ? 0 : pct;
  return { step: s, sub, total: Math.min(100, Math.round((s * 100 + sub) / n)) };
};

export async function install(opts: { retry?: boolean } = {}) {
  if (get().installing) return;
  const name = deviceName(),
    release = get().release;
  if (!release) {
    if (get().channel === "custom") return toast("Pick an update package first", "install", true);
    return toast(`${name} is already on the latest release`, "check");
  }
  if (!release.file && get().channel === "release" && isOfficial(useDevice.getState().info) && !updateAvailable())
    return toast(`${name} is already on the latest release`, "check");
  if (!opts.retry) {
    const power = useDevice.getState().power;
    const low = power && power.battery < 30 && !power.charging;
    const info = useDevice.getState().info;
    /* what it's on now, and what this puts on it */
    const now = !info ? "" : isOfficial(info) ? "the official firmware" : info.fork || "other firmware";
    const next = release.file ? "the package you picked" : channelName(release.channel);
    const sameKind =
      !release.file &&
      !!info &&
      (release.channel.startsWith("gh:")
        ? ghChannel(info.origin)?.toLowerCase() === release.channel.toLowerCase()
        : isOfficial(info));
    const replaces = info && !sameKind ? ` ${name} is on ${now} now: this replaces it with ${next}.` : "";
    const body =
      `${name} restarts into the updater to install it. Keep the cable connected until it's done.` +
      replaces +
      (low ? ` The battery is at ${power.battery}% and not charging: charge it before updating.` : "") +
      (release.file ? " Only install packages you trust." : "");
    if (
      !(await ask({
        title: `Install ${
          release.file
            ? release.version
            : release.channel.startsWith("gh:")
              ? `${channelName(release.channel)} ${release.version}`
              : `firmware ${release.version}`
        }?`,
        body,
        ok: "Install",
      }))
    )
      return;
  }
  abort = new AbortController();
  set({ installing: true, step: 0, sub: 0, total: 0, finished: false, failed: null, target: release.version });
  try {
    if (get().backupFirst && !opts.retry) {
      const ok = await backupNow({ ask: false, sd: false });
      if (!ok) throw abort.signal.aborted ? new DeviceError("cancelled") : new BackupFailed();
    }
    await api.firmware.install(release, ({ step, pct }) => set(progressOf(step, pct)), abort.signal);
  } catch (err) {
    const step = get().step;
    set({ installing: false });
    if (isCancel(err)) {
      set({ step: -1, sub: 0, total: 0 });
      return toast("Install cancelled. Nothing was changed on the Flipper.", "install");
    }
    const message =
      err instanceof BackupFailed
        ? "The backup before the update didn't finish, so nothing was installed. Untick “Back up settings and keys first” to install without one."
        : errorMessage(err);
    set({ failed: { message, step } });
    return toast(message, "info", true);
  } finally {
    abort = null;
  }
  set({ installing: false, finished: true, step: n, sub: 0, total: 100 });
  const now = useDevice.getState().info?.firmware;
  buddyReact("firmware");
  if (!release.file && now && now !== release.version)
    toast(`${name} restarted on ${now}, not ${release.version}. Check its screen.`, "info", true);
  else toast(`${name} is running ${now ?? release.version}`, "check");
}

export const retryInstall = () => install({ retry: true });
export const failedAdvice = (step: number) =>
  step > POINT_OF_NO_RETURN
    ? "Leave the cable in and let the Flipper finish what's on its screen. Retry once it's back."
    : step === POINT_OF_NO_RETURN
      ? "The Flipper didn't start installing, so nothing was changed. Retry, or pick another package."
      : "Nothing that matters on the Flipper was changed. Retry carries on from the files already copied.";
