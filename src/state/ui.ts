import { create } from "zustand";
import type { IconName } from "../icon-map";
import { reduceMotion } from "../motion";
import { isView, type View } from "../views";
import { getPrefs, setPref } from "./settings";

export type ViewId = View | "connect";

export interface Toast {
  id: number;
  text: string;
  icon: IconName;
  secs: number;
  out: boolean;
}
export interface AskOptions {
  title: string;
  body?: string;
  ok?: string;
  value?: string | null;
  danger?: boolean;
  /* a checkbox under the text (askWithCheck) */
  check?: string;
  checked?: boolean;
}
interface AskRequest extends AskOptions {
  id: number;
  resolve: (v: true | string | null) => void;
}

interface UiState {
  view: ViewId;
  replay: number;
  toasts: Toast[];
  ask: AskRequest | null;
  palette: boolean;
  splash: number;
  /* the Settings page's search box */
  settingsFind: string;
}

export const useUi = create<UiState>(() => ({
  view: "dock",
  replay: 0,
  toasts: [],
  ask: null,
  palette: false,
  splash: 0,
  settingsFind: "",
}));

let connected = () => true;
export function setConnectedProbe(fn: () => boolean) {
  connected = fn;
}

function setHash(view: string, push: boolean) {
  try {
    if (push) history.pushState(null, "", `#${view}`);
    else history.replaceState(null, "", `#${view}`);
  } catch {
    /* the viewer doesn't allow changing the URL */
  }
}

export function show(view: ViewId, push = true) {
  if (!connected() && view !== "settings") view = "connect";
  useUi.setState({ view });
  if (isView(view) && getPrefs()._lastView !== view) setPref("_lastView", view);
  if (view !== "connect" && location.hash !== `#${view}`) setHash(view, push);
}

export function replayView() {
  useUi.setState((s) => ({ replay: s.replay + 1 }));
}

/* ---------- toasts ---------- */
let toastId = 0;
export function toast(text: string, icon: IconName = "check", always = false) {
  const p = getPrefs();
  if (!p.toasts && !always) return;
  const secs = Number(p.toastTime) || 3.4,
    id = ++toastId;
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, icon, secs, out: false }] }));
  setTimeout(() => {
    useUi.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) }));
    setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 360);
  }, secs * 1000);
}

/* ---------- the in-page confirm and prompt ---------- */
let askId = 0;
export function ask(opts: AskOptions & { value: string }): Promise<string | null>;
export function ask(opts: AskOptions): Promise<true | null>;
export function ask(opts: AskOptions): Promise<true | string | null> {
  return new Promise((resolve) => {
    useUi.getState().ask?.resolve(null);
    useUi.setState({ ask: { ...opts, value: opts.value ?? null, id: ++askId, resolve } });
  });
}
let lastChecked = false;
export function answerAsk(v: true | string | null, checked = false) {
  const a = useUi.getState().ask;
  if (!a) return;
  lastChecked = checked;
  useUi.setState({ ask: null });
  a.resolve(v);
}
export async function askWithCheck(opts: AskOptions & { check: string }): Promise<{ checked: boolean } | null> {
  const ok = await ask({ ...opts, value: null });
  return ok ? { checked: lastChecked } : null;
}

export const openPalette = () => useUi.setState({ palette: true });
export const closePalette = () => useUi.setState({ palette: false });
export const replaySplash = () => useUi.setState((s) => ({ splash: s.splash + 1 }));

export const setSettingsFind = (settingsFind: string) => useUi.setState({ settingsFind });
/* Opens Settings at one setting and makes it flash. */
export function gotoSetting(id: string) {
  show("settings");
  setSettingsFind("");
  requestAnimationFrame(() => {
    const row = document.getElementById(`row-${id}`);
    if (!row) return;
    row.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
    row.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  });
}
