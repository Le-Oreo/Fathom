import { useEffect, useRef } from "react";
import { finePointer, reduceMotion } from "./motion";
import { useUi, type ViewId } from "./state/ui";

export function useOnEnter(view: ViewId, fn: () => void) {
  const cb = useRef(fn);
  useEffect(() => {
    cb.current = fn;
  });
  useEffect(() => {
    let prev = useUi.getState();
    if (prev.view === view) cb.current();
    return useUi.subscribe((s) => {
      if (s.view === view && (prev.view !== view || s.replay !== prev.replay)) cb.current();
      prev = s;
    });
  }, [view]);
}

export function useTilt<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const stage = ref.current;
    if (!stage || !finePointer) return;
    const move = (e: PointerEvent) => {
      const scr = stage.querySelector<HTMLElement>(".scr");
      if (!scr || reduceMotion()) return;
      const r = stage.getBoundingClientRect(),
        x = (e.clientX - r.left) / r.width - 0.5,
        y = (e.clientY - r.top) / r.height - 0.5;
      scr.classList.add("tracking");
      scr.style.setProperty("--ry", `${(x * 6).toFixed(2)}deg`);
      scr.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
    };
    const leave = () => {
      const scr = stage.querySelector<HTMLElement>(".scr");
      if (!scr) return;
      scr.classList.remove("tracking");
      scr.style.setProperty("--rx", "0deg");
      scr.style.setProperty("--ry", "0deg");
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", leave);
    return () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
    };
  }, []);
  return ref;
}
