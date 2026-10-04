import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import type { DeviceInfo } from "../device/api";
import { startApplyingSettings } from "../settings/apply";
import { isView } from "../views";
import { consoleLost, pushLog, releaseStaleConsole, termNote } from "./console";
import { loadBackups, useBackups } from "./backups";
import { isConnected, refreshDevice, syncClock, useDevice } from "./device";
import { useFirmware } from "./firmware";
import { openPath, resetFiles, useFiles } from "./files";
import { scanLibrary } from "./library";
import { startScreen, updateStream } from "./screen";
import { useSync } from "./sync";
import { getPrefs } from "./settings";
import { setConnectedProbe, show, useUi, type ViewId } from "./ui";

const blinks = new WeakMap<Element, number>();
function blink() {
  document.querySelectorAll(".scr.on").forEach((s) => {
    s.classList.add("blink");
    clearTimeout(blinks.get(s));
    blinks.set(
      s,
      window.setTimeout(() => s.classList.remove("blink"), 110),
    );
  });
}

const infoLines = (d: DeviceInfo) => [
  `hardware_model      : ${d.model}`,
  `hardware_name       : ${d.name}`,
  `hardware_region     : ${d.region}`,
  `firmware_version    : ${d.firmware}`,
  `firmware_branch     : ${d.branch}`,
];

export function startSession() {
  startApplyingSettings();
  startScreen();
  const busy = () => useFirmware.getState().installing || useBackups.getState().job?.kind === "restore";
  setConnectedProbe(() => isConnected() || busy());
  api.log.subscribe((e) => {
    pushLog(e);
    blink();
    if (e.dir === "out") buddyReact("rpc");
  });

  const p = getPrefs(),
    hash = location.hash.slice(1),
    preferred = p.startPage === "last" ? (p._lastView ?? "") : p.startPage;
  let pending: ViewId | null = isView(hash) ? hash : isView(preferred) ? preferred : "dock";
  let first = true;

  api.connection.subscribe((s) => {
    const was = useDevice.getState().status,
      hadConsole = useDevice.getState().console;
    useDevice.setState({
      status: s.status,
      ports: s.ports,
      error: s.error,
      console: !!s.console,
      current: s.current,
      ...(s.info ? { info: s.info } : {}),
    });
    if (s.status !== "connected") consoleLost();
    else if (s.console && was !== "connected" && useUi.getState().view !== "console") void releaseStaleConsole();
    if (hadConsole && !s.console && s.status === "connected") {
      updateStream();
      if (useUi.getState().view === "files") void openPath(useFiles.getState().path);
      void refreshDevice().catch(() => {});
      void scanLibrary();
    }
    if (s.status === "connected" && was !== "connected") {
      resetFiles();
      useSync.setState({ links: null });
      void refreshDevice().catch(() => {});
      void syncClock().catch(() => {});
      void scanLibrary();
      if (useUi.getState().view === "files") void openPath(useFiles.getState().path);
      if (first && s.info) termNote([">: info device", ...infoLines(s.info), ""]);
      else requestAnimationFrame(() => buddyReact("connected"));
      if (pending) show(pending, false);
      else if (useUi.getState().view === "connect") show("dock", false);
      void loadBackups();
      pending = null;
      first = false;
    }
    if (s.status !== "connected" && was === "connected" && useUi.getState().view !== "settings" && !busy())
      show("connect", false);
    if (s.status === "disconnected" && s.ports.length === 1 && !s.error && getPrefs().autoConnect)
      void api.connection.connect(s.ports[0].id).catch(() => {});
  });
  if (pending) show(pending, false);
}
