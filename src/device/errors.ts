import { DeviceError, type DeviceErrorCode } from "./api";

const MESSAGES: Record<DeviceErrorCode, string> = {
  disconnected: "The Flipper disconnected. Plug it back in and try again.",
  timeout: "The Flipper stopped answering. Unplug it, plug it back in and try again.",
  "not-found": "That file isn't on the Flipper any more",
  exists: "Something with that name is already there",
  "not-empty": "That folder isn't empty",
  "invalid-name": "The Flipper can't use that name",
  locked: "Unlock the Flipper or close the app that's open on it, then try again",
  "no-sd": "There's no SD card in the Flipper",
  busy: "The Flipper is busy with something else. Try again in a moment.",
  "port-busy": "Another app is using the Flipper. Quit qFlipper or close Flipper Lab, then try again.",
  permission: "Fathom isn't allowed to open the Flipper's port. On Linux, add the udev rule.",
  "no-answer":
    "The Flipper doesn't answer. Unlock it and try again, or try another USB-C data cable; some only carry power.",
  cancelled: "Cancelled",
  "no-app": "This Flipper's firmware doesn't have that app",
  "app-failed":
    "The Flipper couldn't start that app. Check the SD card is in; an app installed before a firmware update may need updating too.",
  offline: "Fathom couldn't reach the update server. Check the internet connection and try again.",
  "no-room": "There isn't enough free space on the Flipper for that. Free some space and try again.",
  "bad-package": "That update package is damaged or isn't an update package. Nothing was installed.",
  "wrong-target": "That update package is for another kind of Flipper. Nothing was installed.",
  "update-stuck":
    "The Flipper hasn't come back after updating. Leave the cable in and wait for its screen to finish; if it shows an error, install again.",
  "console-open": "The Console is using the Flipper. Leave the Console to use it here.",
  "ble-pair":
    "Fathom couldn't talk to the Flipper over Bluetooth. Pair it in your computer's Bluetooth settings first (the Flipper shows a PIN), then try again.",
  "usb-only": "That needs the USB cable: the Flipper's command line isn't available over Bluetooth.",
  failed: "The Flipper couldn't do that",
  unsupported: "Fathom can't do that with a real Flipper yet",
};

export const codeMessage = (code: DeviceErrorCode) => MESSAGES[code];

export function errorMessage(err: unknown): string {
  if (err instanceof DeviceError) return MESSAGES[err.code];
  return MESSAGES.failed;
}

export const isCancel = (err: unknown) => err instanceof DeviceError && err.code === "cancelled";
