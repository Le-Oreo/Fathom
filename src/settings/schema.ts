import { COLOR_ICONS, isHolidayPick } from "../appicons";
import type { IconName } from "../icon-map";

export interface Prefs {
  startPage: string;
  splash: boolean;
  toasts: boolean;
  toastTime: string;
  accent: string;
  density: string;
  liveColors: string;
  mirror: boolean;
  pixelGrid: boolean;
  glow: boolean;
  motion: string;
  fps: string;
  bgPause: boolean;
  dolphin: boolean;
  dolphinSize: string;
  dolphinMood: string;
  dolphinReact: boolean;
  dolphinFollow: boolean;
  dolphinTricks: boolean;
  openFolders: string;
  openFiles: string;
  dragMove: boolean;
  fileView: string;
  sortBy: string;
  foldersFirst: boolean;
  hidden: boolean;
  keys: boolean;
  shotColors: string;
  shotScale: string;
  autoConnect: boolean;
  clockSync: boolean;
  bluetooth: boolean;
  backupFirst: boolean;
  checkUpdates: boolean;
  rpcLog: boolean;
  consoleSize: string;
  appIcon: string;
  _lastView?: string;
  _holidayIcon?: string;
}
export type PrefId = Exclude<keyof Prefs, "_lastView" | "_holidayIcon">;

export const SECTIONS: [id: string, label: string, icon: IconName][] = [
  ["general", "General", "settings"],
  ["appearance", "Appearance", "palette"],
  ["performance", "Motion and speed", "gauge"],
  ["dolphin", "Dolphin", "sparkles"],
  ["files", "Files", "folder"],
  ["screen", "Screen and screenshots", "monitor"],
  ["connection", "Connection", "usb"],
  ["updates", "Updates", "cpu"],
  ["console", "Console", "terminal"],
  ["about", "About", "info"],
];

export type Option = [value: string, label: string, color?: string];
export interface SettingDef {
  id: PrefId;
  s: string;
  label: string;
  hint?: string;
  type: "switch" | "select" | "seg" | "swatch" | "icon";
  def: boolean | string;
  options?: Option[];
  /* not shown anywhere yet (Bluetooth comes later) */
  hidden?: boolean;
}

// prettier-ignore
export const SETTINGS: SettingDef[] = [
  { id: "startPage", s: "general", label: "Start on", hint: "The page Fathom opens to.", type: "select", def: "dock",
    options: [["dock", "Dock"], ["screen", "Screen"], ["apps", "Apps"], ["library", "Library"], ["files", "Files"], ["last", "Where I left off"]] },
  { id: "splash", s: "general", label: "Launch animation", hint: "The dolphin swims in while Fathom connects.", type: "switch", def: true },
  { id: "toasts", s: "general", label: "Pop-up messages", hint: "Short notes in the corner when something finishes.", type: "switch", def: true },
  { id: "toastTime", s: "general", label: "Keep messages up for", type: "seg", def: "3.4", options: [["2", "2 s"], ["3.4", "3.5 s"], ["6", "6 s"]] },

  { id: "accent", s: "appearance", label: "Accent color", hint: "Buttons, highlights and the page you're on.", type: "swatch", def: "orange",
    options: [["orange", "Orange", "#ff8200"], ["amber", "Amber", "#f5b400"], ["green", "Green", "#2fbf71"], ["blue", "Blue", "#2d8cff"], ["violet", "Violet", "#8b6cff"], ["pink", "Pink", "#ff4f8b"]] },
  { id: "appIcon", s: "appearance", label: "App icon", hint: "On the shortcut you open Fathom with, and its taskbar button. Holiday icons show up here in their month.", type: "icon", def: "classic",
    options: COLOR_ICONS.map((i) => [i.id, i.label]) },
  { id: "density", s: "appearance", label: "Density", hint: "Compact fits more on the screen.", type: "seg", def: "comfy", options: [["comfy", "Comfortable"], ["compact", "Compact"]] },
  { id: "liveColors", s: "appearance", label: "Flipper screen colors", hint: "How the live screen looks inside Fathom.", type: "select", def: "orange",
    options: [["orange", "Orange backlight"], ["mono", "Black on white"], ["paper", "Ink on paper"]] },
  { id: "mirror", s: "appearance", label: "Screen in the sidebar", hint: "A small live copy under the menu.", type: "switch", def: true },
  { id: "pixelGrid", s: "appearance", label: "Pixel grid", hint: "Faint lines between the Flipper's pixels on the big screen.", type: "switch", def: true },
  { id: "glow", s: "appearance", label: "Screen glow", type: "switch", def: true },

  { id: "motion", s: "performance", label: "Animations", hint: "Reduced stops things moving around. Match system follows your computer.", type: "seg", def: "system",
    options: [["system", "Match system"], ["full", "Full"], ["reduced", "Reduced"]] },
  { id: "fps", s: "performance", label: "Live screen frame rate", hint: "Lower uses less battery.", type: "seg", def: "15", options: [["30", "30 fps"], ["15", "15 fps"], ["5", "5 fps"]] },
  { id: "bgPause", s: "performance", label: "Pause the live screen in the background", hint: "Stops updating while Fathom isn't the window you're using.", type: "switch", def: true },

  { id: "dolphin", s: "dolphin", label: "Show the dolphin", type: "switch", def: true },
  { id: "dolphinSize", s: "dolphin", label: "Size", type: "seg", def: "m", options: [["s", "Small"], ["m", "Medium"], ["l", "Large"]] },
  { id: "dolphinMood", s: "dolphin", label: "Personality", hint: "How often it does tricks on its own.", type: "seg", def: "normal", options: [["calm", "Calm"], ["normal", "Normal"], ["playful", "Playful"]] },
  { id: "dolphinReact", s: "dolphin", label: "Reacts to what you do", hint: "Flips for screenshots, blows bubbles for uploads, waves when you connect.", type: "switch", def: true },
  { id: "dolphinFollow", s: "dolphin", label: "Follows your pointer", type: "switch", def: true },
  { id: "dolphinTricks", s: "dolphin", label: "Does a trick when you click it", type: "switch", def: true },

  { id: "openFolders", s: "files", label: "Open folders with", type: "seg", def: "1", options: [["1", "One click"], ["2", "Double-click"]] },
  { id: "openFiles", s: "files", label: "Open files with", type: "seg", def: "1", options: [["1", "One click"], ["2", "Double-click"]] },
  { id: "dragMove", s: "files", label: "Drag to move", hint: "Drag files onto a folder, the folder list or the path. On a touch screen, press and hold first.", type: "switch", def: true },
  { id: "fileView", s: "files", label: "View", type: "seg", def: "list", options: [["list", "List"], ["grid", "Grid"]] },
  { id: "sortBy", s: "files", label: "Sort by", type: "select", def: "name", options: [["name", "Name"], ["size", "Size"], ["date", "Date modified"]] },
  { id: "foldersFirst", s: "files", label: "Folders first", type: "switch", def: true },
  { id: "hidden", s: "files", label: "Show hidden files", hint: "Names that start with a dot, like the Flipper's own settings files.", type: "switch", def: false },

  { id: "keys", s: "screen", label: "Keyboard controls the Flipper", hint: "Arrow keys, Enter and Esc on the Screen page.", type: "switch", def: true },
  { id: "shotColors", s: "screen", label: "Screenshot colors", type: "select", def: "orange", options: [["orange", "Orange, like the screen"], ["mono", "Black on white"], ["paper", "Ink on paper"]] },
  { id: "shotScale", s: "screen", label: "Screenshot size", hint: "Each Flipper pixel becomes this many pixels.", type: "seg", def: "4", options: [["2", "2×"], ["4", "4×"], ["8", "8×"]] },

  { id: "autoConnect", s: "connection", label: "Connect automatically", hint: "Open a session as soon as a Flipper is plugged in or restarts.", type: "switch", def: true },
  { id: "clockSync", s: "connection", label: "Set the Flipper's clock", hint: "From this computer's clock, each time it connects.", type: "switch", def: true },
  { id: "bluetooth", s: "connection", label: "Use Bluetooth when unplugged", hint: "Finds Flippers paired with this computer over Bluetooth. Everything but the Console works; it's slower than the cable.", type: "switch", def: false },

  { id: "backupFirst", s: "updates", label: "Back up before updates", hint: "Save the Flipper's settings before any firmware install.", type: "switch", def: true },
  { id: "checkUpdates", s: "updates", label: "Check for updates at launch", type: "switch", def: true },

  { id: "rpcLog", s: "console", label: "Show the RPC log", hint: "Every request Fathom sends, next to the console.", type: "switch", def: true },
  { id: "consoleSize", s: "console", label: "Console text size", type: "seg", def: "13.5", options: [["12", "Small"], ["13.5", "Medium"], ["15.5", "Large"]] },
];
export const SHOWN_SETTINGS = SETTINGS.filter((s) => !s.hidden);

export const defaults = (): Prefs => Object.fromEntries(SETTINGS.map((s) => [s.id, s.def])) as unknown as Prefs;

export function cleanPrefs(raw: unknown): Partial<Prefs> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const s of SETTINGS) {
    const v = r[s.id];
    if (v === undefined) continue;
    if (s.type === "switch" && typeof v === "boolean") out[s.id] = v;
    else if (s.options && s.options.some((o) => o[0] === String(v))) out[s.id] = String(v);
  }
  if (typeof r._lastView === "string") out._lastView = r._lastView;
  if (isHolidayPick(r._holidayIcon)) out._holidayIcon = r._holidayIcon;
  return out as Partial<Prefs>;
}
