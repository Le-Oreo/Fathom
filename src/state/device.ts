import { create } from "zustand";
import { clockOf, dateOf } from "../clock";
import { api } from "../device";
import type {
  ConnectionStatus,
  DeviceErrorCode,
  DeviceInfo,
  FirmwareRelease,
  ForkRelease,
  PortInfo,
  PowerInfo,
  StorageInfo,
} from "../device/api";
import { getPrefs } from "./settings";

interface DeviceState {
  status: ConnectionStatus;
  ports: PortInfo[];
  /* why the last connect failed */
  error?: DeviceErrorCode;
  info?: DeviceInfo;
  power?: PowerInfo;
  sd?: StorageInfo | null;
  latest?: FirmwareRelease | null;
  forkLatest?: ForkRelease | null;
  /* the Console has the Flipper's command line */
  console?: boolean;
  /* the port of the Flipper connected */
  current?: string;
  clock?: { drift: number; set: boolean; at: number };
}

export const useDevice = create<DeviceState>(() => ({ status: "disconnected", ports: [] }));

export const isConnected = () => useDevice.getState().status === "connected";
export const deviceName = () => useDevice.getState().info?.name ?? "your Flipper";
export const useDeviceName = () => useDevice((s) => s.info?.name ?? "your Flipper");

export async function refreshDevice() {
  const info = await api.device.info();
  useDevice.setState({ info });
  const [power, sd, latest, fork] = await Promise.allSettled([
    api.device.power(),
    api.storage.info("/ext"),
    api.firmware.latest("release"),
    isOfficial(info) ? Promise.resolve(null) : api.firmware.forkLatest(),
  ]);
  useDevice.setState({
    ...(power.status === "fulfilled" ? { power: power.value } : {}),
    ...(sd.status === "fulfilled" ? { sd: sd.value } : {}),
    ...(latest.status === "fulfilled" ? { latest: latest.value } : {}),
    forkLatest: fork.status === "fulfilled" ? fork.value : null,
  });
  const failed = [power, sd, latest].find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

export const isOfficial = (i?: DeviceInfo) =>
  !i ||
  (!i.fork && !i.origin) ||
  i.fork.toLowerCase() === "official" ||
  i.origin.includes("github.com/flipperdevices/flipperzero-firmware");
export const updateAvailable = (s: DeviceState = useDevice.getState()) =>
  !!s.latest && !!s.info && isOfficial(s.info) && s.latest.version !== s.info.firmware;
export const forkUpdate = (s: DeviceState = useDevice.getState()) =>
  !!s.forkLatest && !!s.info && s.forkLatest.version !== s.info.firmware;

export async function syncClock(force = false) {
  const before = await api.device.getClock();
  /* its clock counts whole seconds: compare from the middle of one */
  const drift = dateOf(before).getTime() + 500 - Date.now();
  const set = force || getPrefs().clockSync;
  if (set) {
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000)));
    await api.device.setClock(clockOf(new Date()));
  }
  useDevice.setState({ clock: { drift, set, at: Date.now() } });
}
