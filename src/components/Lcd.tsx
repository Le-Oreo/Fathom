import { useEffect, useRef } from "react";
import type { ScreenFrame } from "../device/api";
import { drawFrame, fitZoom, isPortrait, PALETTES, type PaletteName } from "../lcd";
import { reduceMotion } from "../motion";
import { useDevice } from "../state/device";
import { addPainter, latestFrame, setConsumer } from "../state/screen";
import { useSettings } from "../state/settings";

const palette = () => PALETTES[useSettings.getState().prefs.liveColors as PaletteName] ?? PALETTES.orange;

type Props = {
  /* the biggest zoom this spot allows */
  max: number;
  mini?: boolean;
  /* the Screen page's: keyboard-focusable */
  focus?: boolean;
  glow?: boolean;
};

export function Lcd({ max, mini = false, focus = false, glow = false }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const scr = useRef<HTMLDivElement>(null);
  const lcd = useRef<HTMLCanvasElement>(null);
  const ghost = useRef<HTMLCanvasElement>(null);
  const on = useDevice((s) => s.status === "connected");
  const colors = useSettings((s) => s.prefs.liveColors);

  /* fitScreens: frame = 128k + 2 * (6 + 3k) */
  useEffect(() => {
    const w = wrap.current,
      s = scr.current;
    if (!w || !s) return;
    const fit = () => {
      if (!w.clientWidth) return;
      const k = fitZoom(w.clientWidth, max);
      s.style.setProperty("--k", k.toFixed(3));
      s.classList.toggle("small", k < 3);
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    ro.observe(w);
    fit();
    return () => ro.disconnect();
  }, [max]);

  useEffect(() => {
    const canvas = lcd.current,
      g = ghost.current,
      el = scr.current;
    if (!canvas || !g || !el) return;
    const token = {};
    let showing = false;
    /* a vertical picture stands the screen on end */
    const draw = (f: ScreenFrame) => {
      el.classList.toggle("portrait", isPortrait(f.orientation));
      drawFrame(canvas, f.data, palette(), f.orientation);
    };
    const off = addPainter((f, changed) => {
      if (!showing) return;
      if (changed && !reduceMotion()) {
        g.width = canvas.width;
        g.height = canvas.height;
        const gctx = g.getContext("2d");
        gctx?.clearRect(0, 0, g.width, g.height);
        gctx?.drawImage(canvas, 0, 0);
        g.classList.remove("fade");
        g.style.opacity = ".7";
        void g.offsetWidth;
        g.classList.add("fade");
        g.style.opacity = "0";
      }
      draw(f);
    });
    const io = new IntersectionObserver((entries) => {
      showing = entries[entries.length - 1].isIntersecting; /* the newest, if several arrive together */
      setConsumer(token, showing);
      const f = latestFrame();
      if (showing && f) draw(f);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      off();
      setConsumer(token, false);
    };
  }, []);

  useEffect(() => {
    scr.current?.classList.toggle("on", on);
  }, [on]);

  useEffect(() => {
    const f = latestFrame();
    if (f && lcd.current)
      drawFrame(lcd.current, f.data, PALETTES[colors as PaletteName] ?? PALETTES.orange, f.orientation);
  }, [colors]);

  const label = focus
    ? "Live Flipper screen. Use the arrow keys, Enter and Escape to control it."
    : "Live Flipper screen";
  return (
    <div className="scr-wrap" ref={wrap}>
      <div className={mini ? "scr mini" : "scr"} ref={scr} data-screen>
        <canvas className="lcd" width={128} height={64} ref={lcd} tabIndex={focus ? 0 : undefined} aria-label={label} />
        <canvas className="lcd ghost" width={128} height={64} ref={ghost} aria-hidden="true" />
        <div className="grid" />
        <div className="glass" />
        <span className="led" />
      </div>
      {glow && <div className="scr-glow" />}
    </div>
  );
}
