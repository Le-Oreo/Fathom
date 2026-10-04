import type { IconName } from "./icon-map";

export interface LibraryCategory {
  id: string;
  label: string;
  icon: IconName;
  folder: string;
  ext: string;
  app: string;
}
export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  { id: "subghz", label: "Sub-GHz", icon: "subghz", folder: "/ext/subghz", ext: ".sub", app: "Sub-GHz" },
  { id: "ir", label: "Infrared", icon: "ir", folder: "/ext/infrared", ext: ".ir", app: "Infrared" },
  { id: "nfc", label: "NFC", icon: "nfc", folder: "/ext/nfc", ext: ".nfc", app: "NFC" },
  { id: "rfid", label: "RFID", icon: "rfid", folder: "/ext/lfrfid", ext: ".rfid", app: "RFID 125 kHz" },
  { id: "badusb", label: "Bad USB", icon: "usb", folder: "/ext/badusb", ext: ".txt", app: "Bad USB" },
  { id: "ibutton", label: "iButton", icon: "ibutton", folder: "/ext/ibutton", ext: ".ibtn", app: "iButton" },
];
export const categoryById = (id: string) => LIBRARY_CATEGORIES.find((c) => c.id === id) ?? LIBRARY_CATEGORIES[0];

export interface FlipperApp {
  name: string;
  icon: IconName;
  note: string;
  names?: string[];
}
export const firmwareNames = (a: FlipperApp) => a.names ?? [a.name];
export const APPS: FlipperApp[] = [
  { name: "Sub-GHz", icon: "subghz", note: "Read and send radio signals" },
  { name: "RFID 125 kHz", icon: "rfid", note: "Read low-frequency tags", names: ["125 kHz RFID", "RFID 125 kHz"] },
  { name: "NFC", icon: "nfc", note: "Read and emulate NFC tags" },
  { name: "Infrared", icon: "ir", note: "Universal and saved remotes" },
  { name: "GPIO", icon: "gpio", note: "Pins, USB-UART bridge" },
  { name: "iButton", icon: "ibutton", note: "1-Wire keys" },
  { name: "Bad USB", icon: "usb", note: "Run keystroke scripts", names: ["Bad USB", "BadUSB"] },
  { name: "U2F", icon: "u2f", note: "Use as a security key" },
  { name: "Settings", icon: "settings", note: "The Flipper's own settings" },
];
export const appByName = (name: string) => APPS.find((a) => a.name === name) ?? APPS[0];

export const INSTALL_STEPS = [
  "Check the SD card",
  "Update region data",
  "Download and check the package",
  "Copy it to the SD card",
  "Restart into the updater",
  "Install and restart",
];
export const POINT_OF_NO_RETURN = 4;

export const OTHER_FIRMWARE: { name: string; channel: `gh:${string}`; note: string }[] = [
  {
    name: "Momentum",
    channel: "gh:Next-Flip/Momentum-Firmware",
    note: "Community firmware with more apps and settings",
  },
  {
    name: "Unleashed",
    channel: "gh:DarkFlippers/unleashed-firmware",
    note: "Community firmware with more protocols and apps",
  },
];

export function ghChannel(origin: string): `gh:${string}` | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin.trim());
  return m && !m[1].startsWith(".") && !m[2].startsWith(".") ? `gh:${m[1]}/${m[2]}` : null;
}
export function channelName(channel: string) {
  const known = OTHER_FIRMWARE.find((f) => f.channel.toLowerCase() === channel.toLowerCase());
  if (known) return known.name;
  if (channel.startsWith("gh:")) return channel.split("/")[1] ?? channel;
  return "the official firmware";
}
