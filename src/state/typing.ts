import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import { errorMessage } from "../device/errors";
import type { Key } from "../device/api";
import { clearPresses, findSelected, typeSteps, untypeable, type Pos } from "../keyboard";
import { deviceName } from "./device";
import { latestFrame, screenLive } from "./screen";
import { toast } from "./ui";

export const useTyping = create<{ text: string; done: number; total: number; busy: boolean }>(() => ({
  text: "",
  done: 0,
  total: 0,
  busy: false,
}));
const set = useTyping.setState;

export const setTypingText = (text: string) => set({ text });

export async function pasteToType() {
  try {
    const t = (await navigator.clipboard.readText()).replace(/\s+/g, " ").trim();
    set({ text: t.slice(0, 64) });
  } catch {
    toast("Fathom couldn't read the clipboard", "info", true);
  }
}

let stop = false;
export const stopTyping = () => {
  stop = true;
};

async function shows(at: Pos) {
  for (let i = 0; i < 12; i++) {
    const f = latestFrame();
    const p = f && screenLive() && f.orientation === "horizontal" ? findSelected(f.data) : null;
    if (p && p.row === at.row && p.col === at.col) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

export async function typeOnFlipper() {
  const { text, busy } = useTyping.getState();
  if (busy || !text) return;
  const bad = untypeable(text);
  if (bad.length)
    return toast(`The Flipper's keyboard has no ${bad.map((c) => `\u201c${c}\u201d`).join(" ")}`, "info", true);
  if (!screenLive())
    return toast(
      "Turn the live screen on (it's paused or hidden), so Fathom can see the Flipper's keyboard",
      "info",
      true,
    );
  const frame = latestFrame();
  const at = frame && frame.orientation === "horizontal" ? findSelected(frame.data) : null;
  if (!at)
    return toast(
      `Open the screen where ${deviceName()} asks you to type (naming a file, for one), then try again`,
      "info",
      true,
    );
  const steps = [{ presses: clearPresses(), at }, ...typeSteps(text, at)];
  const total = steps.reduce((n, s) => n + s.presses.length, 0);
  stop = false;
  set({ busy: true, done: 0, total });
  let held: Key | null = null;
  let sent = 0;
  try {
    for (const step of steps) {
      for (const p of step.presses) {
        if (stop) {
          toast("Stopped typing", "keyboard");
          return;
        }
        await api.input.send(p.key, p.type);
        held = p.type === "release" ? null : p.key;
        if (++sent % 6 === 0) set({ done: sent });
      }
      if (!(await shows(step.at))) {
        toast(
          `${deviceName()}'s screen isn't showing its keyboard as expected, so Fathom stopped typing`,
          "info",
          true,
        );
        return;
      }
    }
  } catch (err) {
    toast(errorMessage(err), "info", true);
    return;
  } finally {
    /* never leave a key held down */
    if (held) await api.input.send(held, "release").catch(() => {});
    set({ busy: false, done: 0, total: 0 });
  }
  buddyReact("command");
  toast(`Typed \u201c${text}\u201d on ${deviceName()}. Press Save on the Flipper when it's right.`, "keyboard");
}
