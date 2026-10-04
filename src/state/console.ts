import { isTauri } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import type { CliLink, RpcLogEntry } from "../device/api";
import { errorMessage } from "../device/errors";
import { getPrefs } from "./settings";

export interface LogLine extends RpcLogEntry {
  id: number;
}
export type Attach = "off" | "attaching" | "on" | "detaching";

interface ConsoleState {
  log: LogLine[];
  attach: Attach;
  /* why the last attach failed */
  problem: string;
  history: string[];
  saved: string[];
}
export const useConsole = create<ConsoleState>(() => ({
  log: [],
  attach: "off",
  problem: "",
  history: [],
  saved: [],
}));
const get = useConsole.getState,
  set = useConsole.setState;

export const QUICK = ["info device", "storage list /ext", "free", "ps", "date", "help"];
const HISTORY_MAX = 100;

const KEY = "fathom-console";
const appStore = isTauri()
  ? import("@tauri-apps/plugin-store").then((m) => m.load("console.json", { autoSave: 300 }))
  : null;
const clean = (v: unknown, max: number) =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200).slice(-max)
    : [];
async function loadKept() {
  try {
    const raw = appStore ? await (await appStore).get(KEY) : (JSON.parse(localStorage.getItem(KEY) || "{}") as unknown);
    const r = (raw ?? {}) as { history?: unknown; saved?: unknown };
    set((s) => ({
      history: [...clean(r.history, HISTORY_MAX), ...s.history].slice(-HISTORY_MAX),
      saved: [...new Set([...clean(r.saved, 24), ...s.saved])],
    }));
  } catch {
    /* nothing kept, or can't read it: start empty */
  }
}
function keep() {
  const { history, saved } = get();
  const data = { history, saved };
  try {
    if (appStore) void appStore.then((s) => s.set(KEY, data)).catch(() => {});
    else localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* can't keep them: they last for this visit */
  }
}
const kept = loadKept();

export function saveCommand(cmd: string) {
  const c = cmd.trim();
  if (!c || get().saved.includes(c) || QUICK.includes(c)) return;
  set((s) => ({ saved: [...s.saved, c].slice(-24) }));
  void kept.then(keep);
}
export function forgetCommand(cmd: string) {
  set((s) => ({ saved: s.saved.filter((c) => c !== cmd) }));
  void kept.then(keep);
}
function remember(cmd: string) {
  const c = cmd.trim();
  if (!c) return;
  set((s) => ({ history: [...s.history.filter((h) => h !== c), c].slice(-HISTORY_MAX) }));
  void kept.then(keep);
}

/* ---------- the terminal ---------- */
let term: Terminal | null = null;
let box: HTMLDivElement | null = null;
let fit: { fit(): void } | null = null;
let link: CliLink | null = null;
let line = "";
let at = 0;
let draft = "";
let pending: string[] = [];

let loading: Promise<[typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit")]> | null = null;
export async function mountTerminal(host: HTMLElement) {
  loading ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  const [{ Terminal }, { FitAddon }] = await loading;
  if (!term) {
    term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
      fontSize: Number(getPrefs().consoleSize) || 13.5,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      scrollback: 4000,
      theme: {
        background: "#070707",
        foreground: "#ffb366",
        cursor: "#ff8c1a",
        selectionBackground: "rgba(255, 140, 26, 0.3)",
      },
    });
    const f = new FitAddon();
    term.loadAddon(f);
    fit = f;
    term.onData(typed);
    term.attachCustomKeyEventHandler((e) => !((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"));
    box = document.createElement("div");
    box.className = "xterm-host";
    host.appendChild(box);
    term.open(box);
    for (const l of pending) termNote([l]);
    pending = [];
    for (const b of early) term.write(b);
    early = [];
  }
  if (box && box.parentElement !== host) host.appendChild(box);
  fitTerminal();
  return term;
}
export const fitTerminal = () => {
  try {
    fit?.fit();
  } catch {
    /* not laid out yet */
  }
};
export const focusTerminal = () => term?.focus();
export function setTerminalSize(px: number) {
  if (!term) return;
  term.options.fontSize = px;
  fitTerminal();
}

let early: Uint8Array[] = [];
function show(bytes: Uint8Array) {
  if (term) term.write(bytes);
  else early.push(bytes);
}

export function termNote(lines: string[]) {
  if (!term) {
    pending.push(...lines);
    return;
  }
  for (const l of lines) term.writeln(`\x1b[2m${l}\x1b[0m`);
}

let writing: Promise<void> = Promise.resolve();
let queued = "";
const send = (text: string) => {
  if (!link || !text) return;
  queued += text;
  const l = link;
  writing = writing.then(async () => {
    const t = queued;
    queued = "";
    if (!t) return;
    try {
      await l.write(t);
    } catch {
      line = "";
    }
  });
};
const rubOut = (n: number) => "\x7f".repeat(n);

/* Keys and pasted text from the terminal. */
function typed(data: string) {
  if (get().attach !== "on") return;
  if (data === "\x1b[A" || data === "\x1b[B") return recall(data === "\x1b[A" ? -1 : 1);
  if (data.startsWith("\x1b")) return;
  let out = "";
  for (const ch of data.replace(/\r\n|\n/g, "\r")) {
    if (ch === "\r") {
      remember(line);
      line = "";
      at = get().history.length;
      out += "\r";
      buddyReact("command");
    } else if (ch === "\x7f" || ch === "\b") {
      if (line) {
        line = line.slice(0, -1);
        out += "\x7f";
      }
    } else if (ch === "\x03") {
      line = "";
      out += "\x03";
    } else if (ch >= " " && ch <= "~") {
      line += ch;
      out += ch;
    }
  }
  send(out);
}

/* Up and Down: put a past command in place of the line. */
function recall(step: number) {
  const h = get().history;
  if (at === h.length) draft = line;
  const next = Math.min(h.length, Math.max(0, at + step));
  if (next === at) return;
  at = next;
  const text = at === h.length ? draft : h[at];
  send(rubOut(line.length) + text);
  line = text;
}

export function runCommand(cmd: string) {
  if (get().attach !== "on") return;
  const c = cmd.trim();
  if (!c) return;
  send(rubOut(line.length) + c + "\r");
  line = "";
  remember(c);
  at = get().history.length;
  buddyReact("command");
  term?.focus();
}
/* The command being typed, for Save. */
export const currentLine = () => line;

export function clearOutput() {
  term?.clear();
}
/* Everything the terminal shows, as plain text. */
export function outputText() {
  if (!term) return "";
  const b = term.buffer.active,
    out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/* ---------- attaching and detaching ---------- */
let wanted = false;
let busy: Promise<void> = Promise.resolve();

export function wantConsole(on: boolean) {
  wanted = on;
  busy = busy.then(sync, sync);
}
async function sync() {
  const s = get().attach;
  if (wanted && s === "off") {
    set({ attach: "attaching", problem: "" });
    line = "";
    at = get().history.length;
    try {
      link = await api.cli.attach(show);
      set({ attach: "on" });
      term?.focus();
    } catch (err) {
      link = null;
      set({ attach: "off", problem: errorMessage(err) });
    }
    /* the page may have closed meanwhile */
    if (!wanted) await sync();
  } else if (!wanted && s === "on") {
    set({ attach: "detaching" });
    const l = link;
    link = null;
    await l?.detach().catch(() => {});
    set({ attach: "off" });
  }
}
export async function releaseStaleConsole() {
  if (get().attach !== "off" || wanted) return;
  try {
    const stale = await api.cli.attach(() => {});
    if (!wanted) await stale.detach();
  } catch {
    /* gone already */
  }
}

export function consoleLost() {
  link = null;
  line = "";
  if (get().attach !== "off") set({ attach: "off" });
}

/* ---------- the RPC log ---------- */
let logId = 0;
export function pushLog(e: RpcLogEntry) {
  useConsole.setState((s) => ({ log: [{ ...e, id: ++logId }, ...s.log].slice(0, 80) }));
}
export const clearLog = () => useConsole.setState({ log: [] });
