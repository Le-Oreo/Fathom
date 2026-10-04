import { currentIcon, monthKey } from "../appicons";
import { api } from "../device";
import { setMotionMode } from "../motion";
import { setAppIcon } from "../platform";
import { setTerminalSize } from "../state/console";
import { setPref, useSettings } from "../state/settings";
import type { Prefs } from "./schema";

function apply(p: Prefs, prev?: Prefs) {
  const root = document.documentElement;
  root.dataset.accent = p.accent;
  root.dataset.density = p.density;
  root.dataset.lcd = p.liveColors;
  root.classList.toggle("no-mirror", !p.mirror);
  root.classList.toggle("no-grid", !p.pixelGrid);
  root.classList.toggle("no-glow", !p.glow);
  root.classList.toggle("no-dolphin", !p.dolphin);
  root.classList.toggle("no-drag", !p.dragMove);
  root.classList.toggle("no-rpclog", !p.rpcLog);
  root.style.setProperty("--term-size", `${p.consoleSize}px`);
  if (prev && prev.consoleSize !== p.consoleSize) setTerminalSize(Number(p.consoleSize) || 13.5);
  if (!prev || prev.motion !== p.motion) setMotionMode(p.motion);
  if (!prev || prev.bluetooth !== p.bluetooth) void api.connection.setBluetooth(p.bluetooth).catch(() => {});
}

let shownIcon = "";
function applyIcon(p: Prefs) {
  const now = new Date();
  if (p._holidayIcon && p._holidayIcon.split("@")[1] !== monthKey(now)) {
    queueMicrotask(() => setPref("_holidayIcon", undefined));
    return;
  }
  const id = currentIcon(p.appIcon, p._holidayIcon, now);
  if (id === shownIcon) return;
  shownIcon = id;
  void setAppIcon(id);
}

export function startApplyingSettings() {
  apply(useSettings.getState().prefs);
  applyIcon(useSettings.getState().prefs);
  const monthly = window.setInterval(() => applyIcon(useSettings.getState().prefs), 60_000);
  const stop = useSettings.subscribe((s, old) => {
    if (s.prefs === old.prefs) return;
    apply(s.prefs, old.prefs);
    applyIcon(s.prefs);
  });
  return () => {
    clearInterval(monthly);
    stop();
  };
}
