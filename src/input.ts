import { api } from "./device";
import type { InputType, Key } from "./device/api";
import { errorMessage } from "./device/errors";
import { isConnected } from "./state/device";
import { toast } from "./state/ui";

export const LONG_MS = 350;
export const REPEAT_MS = 150;

interface Hold {
  long: boolean;
  timer: number;
}
const held = new Map<Key, Hold>();
let chain: Promise<void> = Promise.resolve();
/* one message per press, however many of its events fail */
let warned = false;

function send(key: Key, type: InputType) {
  chain = chain
    .then(() => api.input.send(key, type))
    .catch((err: unknown) => {
      if (warned) return;
      warned = true;
      toast(errorMessage(err), "info", true);
    });
  return chain;
}

/* The key looks pressed for as long as it's held. */
const look = (key: Key, down: boolean) =>
  document.querySelectorAll(`[data-key="${key}"]`).forEach((b) => b.classList.toggle("down", down));

export function keyDown(key: Key) {
  if (!isConnected() || held.has(key)) return;
  warned = false;
  look(key, true);
  const h: Hold = { long: false, timer: 0 };
  h.timer = window.setTimeout(() => {
    h.long = true;
    void send(key, "long");
    h.timer = window.setInterval(() => void send(key, "repeat"), REPEAT_MS);
  }, LONG_MS);
  held.set(key, h);
  void send(key, "press");
}

export function keyUp(key: Key) {
  const h = held.get(key);
  if (!h) return chain;
  held.delete(key);
  clearTimeout(h.timer);
  clearInterval(h.timer);
  look(key, false);
  if (!h.long) void send(key, "short");
  return send(key, "release");
}

export function forgetHeld() {
  for (const [key, h] of held) {
    clearTimeout(h.timer);
    clearInterval(h.timer);
    look(key, false);
  }
  held.clear();
}

/* The window lost focus mid-press: let go of everything. */
export function releaseAll() {
  for (const key of [...held.keys()]) void keyUp(key);
}

const hits = new WeakMap<Element, number>();

export async function tap(key: Key) {
  if (!isConnected()) return;
  document.querySelectorAll(`[data-key="${key}"]`).forEach((b) => {
    b.classList.add("hit");
    clearTimeout(hits.get(b));
    hits.set(
      b,
      window.setTimeout(() => b.classList.remove("hit"), 150),
    );
  });
  keyDown(key);
  await keyUp(key);
}

export const KEYMAP: Record<string, Key> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "ok",
  Backspace: "back",
  Escape: "back",
};
