import { buddyReact } from "../buddy/bus";
import { firmwareNames, type FlipperApp } from "../catalog";
import { api } from "../device";
import { DeviceError } from "../device/api";
import { errorMessage } from "../device/errors";
import { baseName } from "../files/logic";
import { hideApp } from "./apps";
import { deviceName, isConnected, refreshDevice, updateAvailable, useDevice } from "./device";
import { getPrefs } from "./settings";
import { ask, show, toast } from "./ui";

const fail = (err: unknown) => toast(errorMessage(err), "info", true);

export async function openApp(app: FlipperApp, extra = "") {
  let opened = false;
  for (const name of firmwareNames(app)) {
    try {
      await api.apps.start(name, extra || undefined);
      opened = true;
      break;
    } catch (err) {
      if (err instanceof DeviceError && err.code === "no-app") continue;
      return fail(err);
    }
  }
  if (!opened) {
    hideApp(app.name);
    return toast(`${deviceName()}'s firmware doesn't have ${app.name}`, app.icon, true);
  }
  show("screen");
  toast(`Opened ${extra ? baseName(extra) : app.name} on ${deviceName()}`, app.icon);
}
export async function openFap(path: string) {
  try {
    await api.apps.start(path);
  } catch (err) {
    return fail(err);
  }
  toast(`Opened ${baseName(path)} on ${deviceName()}`, "app-window");
}

export async function reboot() {
  const name = deviceName();
  if (
    !(await ask({
      title: `Restart ${name}?`,
      body: "It disconnects for a few seconds, then Fathom reconnects.",
      ok: "Restart",
    }))
  )
    return;
  try {
    await api.device.reboot();
  } catch (err) {
    return fail(err);
  }
  if (!getPrefs().autoConnect) return toast(`${name} restarted. Press Scan again to connect.`, "anchor");
  try {
    await api.connection.connect();
  } catch (err) {
    return toast(`${name} restarted but didn't reconnect. ${errorMessage(err)}`, "anchor", true);
  }
  if (isConnected()) toast(`${name} is back`, "anchor");
}

export async function playAlert() {
  try {
    await api.device.playAlert();
  } catch (err) {
    return fail(err);
  }
  toast(`${deviceName()} is beeping and blinking`, "bell");
  buddyReact("find");
}

export async function checkUpdates() {
  try {
    await refreshDevice();
  } catch (err) {
    return fail(err);
  }
  const latest = useDevice.getState().latest;
  toast(
    updateAvailable() && latest ? `${latest.version} is ready to install` : "You're on the latest release",
    "refresh",
  );
}

export async function reconnect(port?: string) {
  if (!port && useDevice.getState().ports.length > 1) return toast("Pick the Flipper to connect to", "usb");
  try {
    await api.connection.connect(port);
  } catch (err) {
    if (err instanceof DeviceError && err.code !== "disconnected") return toast(errorMessage(err), "usb", true);
    return toast("No Flipper found. Check the cable and unlock the Flipper, then try again.", "usb", true);
  }
  toast(`Connected to ${deviceName()}`, "anchor");
}
