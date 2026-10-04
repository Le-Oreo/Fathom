const query = window.matchMedia("(prefers-reduced-motion: reduce)");
let mode = "system";
let reduced = query.matches;
const listeners = new Set<() => void>();

export const reduceMotion = () => reduced;

export function onMotionChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function setMotionMode(next: string) {
  mode = next;
  const was = reduced;
  reduced = mode === "reduced" || (mode === "system" && query.matches);
  const root = document.documentElement;
  root.classList.toggle("calm", reduced);
  root.classList.toggle("motion-full", mode === "full");
  if (was !== reduced) listeners.forEach((fn) => fn());
}

query.addEventListener?.("change", () => setMotionMode(mode));

export const finePointer = window.matchMedia("(pointer: fine)").matches;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
