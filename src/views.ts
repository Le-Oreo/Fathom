import type { IconName } from "./icon-map";

export const VIEWS = ["dock", "screen", "apps", "library", "files", "firmware", "console", "settings"] as const;
export type View = (typeof VIEWS)[number];
export const TITLES: Record<View, string> = {
  dock: "Dock",
  screen: "Screen",
  apps: "Apps",
  library: "Library",
  files: "Files",
  firmware: "Firmware",
  console: "Console",
  settings: "Settings",
};
export const NAV_ICONS: Record<View, IconName> = {
  dock: "anchor",
  screen: "monitor",
  apps: "apps",
  library: "library",
  files: "folder",
  firmware: "cpu",
  console: "terminal",
  settings: "settings",
};
export const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);
