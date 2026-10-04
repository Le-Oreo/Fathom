import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "../device";
import { errorMessage } from "../device/errors";
import { useDevice } from "./device";
import { transfersActive } from "./transfers";
import { toast } from "./ui";

export interface KnownFlipper {
  id: string;
  name: string;
  /* the USB port id it was last plugged in as */
  port: string;
  lastSeen: number;
}
export const useFlippers = create<{ known: Record<string, KnownFlipper> }>(() => ({ known: {} }));

const KEY = "fathom-flippers";
const appStore = isTauri()
  ? import("@tauri-apps/plugin-store").then((m) => m.load("flippers.json", { autoSave: 300 }))
  : null;
let loaded = false;
async function load() {
  try {
    const raw = appStore ? await (await appStore).get(KEY) : JSON.parse(localStorage.getItem(KEY) || "{}");
    const known: Record<string, KnownFlipper> = {};
    for (const [id, v] of Object.entries((raw ?? {}) as Record<string, Partial<KnownFlipper>>))
      if (v && typeof v.name === "string" && typeof v.port === "string" && typeof v.lastSeen === "number")
        known[id] = { id, name: v.name, port: v.port, lastSeen: v.lastSeen };
    useFlippers.setState((s) => ({ known: { ...known, ...s.known } }));
  } catch {
    /* none kept */
  }
  loaded = true;
}
function save() {
  if (!loaded) return;
  const data = useFlippers.getState().known;
  try {
    if (appStore) void appStore.then((s) => s.set(KEY, data)).catch(() => {});
    else localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* can't keep it: lasts this visit */
  }
}
const ready = load();

/* the one connected now: remembered, and seen just now */
useDevice.subscribe((s, old) => {
  const i = s.info;
  if (s.status !== "connected" || !i?.id || (old.status === "connected" && old.info?.id === i.id)) return;
  const port = s.current ?? "";
  useFlippers.setState((st) => ({
    known: { ...st.known, [i.id]: { id: i.id, name: i.name, port, lastSeen: Date.now() } },
  }));
  void ready.then(save);
});

export function pluggedIn(ports: { id: string; name: string }[], known: Record<string, KnownFlipper>) {
  const byPort = new Map(Object.values(known).map((k) => [k.port, k]));
  return ports.map((p) => ({ port: p.id, name: byPort.get(p.id)?.name ?? p.name, known: byPort.get(p.id) }));
}

export async function switchFlipper(port: string, name: string) {
  if (transfersActive())
    return toast("Wait for the transfers to finish, or cancel them, before switching Flippers", "usb", true);
  try {
    await api.connection.switchTo(port);
  } catch (err) {
    return toast(errorMessage(err), "usb", true);
  }
  toast(`Connected to ${name}`, "anchor");
}
