import { useEffect, useLayoutEffect } from "react";
import { AskDialog } from "./components/AskDialog";
import { Mover } from "./components/Mover";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { Splash } from "./components/Splash";
import { Toasts } from "./components/Toasts";
import { Topbar } from "./components/Topbar";
import { UpdateBanner } from "./components/UpdateBanner";
import { Viewer } from "./components/Viewer";
import { keyDown, KEYMAP, keyUp, releaseAll } from "./input";
import { watchAppUpdates } from "./state/appUpdate";
import { isConnected } from "./state/device";
import { getPrefs } from "./state/settings";
import { closePalette, openPalette, show, useUi } from "./state/ui";
import { Apps } from "./views/Apps";
import { Connect } from "./views/Connect";
import { Console } from "./views/Console";
import { Dock } from "./views/Dock";
import { filesKey } from "./views/files/keys";
import { Files } from "./views/files/Files";
import { Firmware } from "./views/Firmware";
import { Library } from "./views/Library";
import { Screen } from "./views/Screen";
import { Settings } from "./views/Settings";
import { isView, VIEWS } from "./views";

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement,
    ui = useUi.getState();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (ui.palette) closePalette();
    else if (isConnected()) openPalette();
    return;
  }
  if (ui.palette) return;
  const typing = t.closest?.("input, select, textarea");
  if (document.querySelector("dialog[open]") || typing) return;
  if (ui.view === "files" && filesKey(e)) return e.preventDefault();
  if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-8]$/.test(e.key) && isConnected())
    return show(VIEWS[Number(e.key) - 1]);
  if (ui.view !== "screen" || !getPrefs().keys) return;
  if (t.closest?.("[data-key]") && (e.key === "Enter" || e.key === " ")) return;
  if (t !== document.body && !t.closest?.(".scr, .stage")) return;
  const key = KEYMAP[e.key];
  if (key) {
    e.preventDefault();
    if (!e.repeat) keyDown(key); /* holding it repeats on the Flipper's terms, not the keyboard's */
  }
}

function onKeyUp(e: KeyboardEvent) {
  const key = KEYMAP[e.key];
  if (key) void keyUp(key);
}

export default function App() {
  const view = useUi((s) => s.view);
  const replay = useUi((s) => s.replay);

  /* each page's pieces rise in one after another */
  useLayoutEffect(() => {
    document
      .querySelectorAll<HTMLElement>(`#view-${view} .rise`)
      .forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, 9))));
    const content = document.getElementById("content");
    if (content) content.scrollTop = 0;
    window.scrollTo(0, 0);
  }, [view]);

  useEffect(() => {
    if (!replay) return;
    const v = document.getElementById(`view-${useUi.getState().view}`);
    if (!v) return;
    v.classList.remove("on");
    void v.offsetWidth;
    v.classList.add("on");
  }, [replay]);

  useEffect(() => watchAppUpdates(), []);

  useEffect(() => {
    const onPop = () => {
      const v = location.hash.slice(1);
      if (isView(v)) show(v, false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  return (
    <>
      <div className={view === "connect" ? "app offline" : "app"} id="app">
        <Sidebar />
        <div className="main">
          <UpdateBanner />
          <Topbar />
          <main className="content" id="content">
            <Dock />
            <Screen />
            <Apps />
            <Library />
            <Files />
            <Firmware />
            <Console />
            <Settings />
            <Connect />
          </main>
        </div>
      </div>
      <Splash />
      <Toasts />
      <Palette />
      <Viewer />
      <Mover />
      <AskDialog />
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--orange-hi)" }} />
            <stop offset="1" style={{ stopColor: "var(--acc-bot)" }} />
          </linearGradient>
        </defs>
      </svg>
    </>
  );
}
