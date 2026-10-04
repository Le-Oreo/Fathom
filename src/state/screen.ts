import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import type { ScreenFrame, ScreenStream } from "../device/api";
import { forgetHeld } from "../input";
import { GIFEncoder } from "gifenc";
import { drawFrame, oriented, PALETTES, type PaletteName } from "../lcd";
import { saveFile } from "../platform";
import { logActivity } from "./activity";
import { deviceName, isConnected, useDevice } from "./device";
import { getPrefs, useSettings } from "./settings";
import { toast } from "./ui";

export interface Shot {
  id: number;
  name: string;
  url: string;
}
interface ScreenState {
  paused: boolean;
  /* when recording started, or null */
  recording: number | null;
  shots: Shot[];
  label: string;
}
export const useScreen = create<ScreenState>(() => ({ paused: false, recording: null, shots: [], label: "" }));

type Painter = (f: ScreenFrame, changed: boolean) => void;
const painters = new Set<Painter>();
const consumers = new Set<object>();
let latest: ScreenFrame | null = null;
let lastAt = 0;
let stream: ScreenStream | null = null;

function onFrame(f: ScreenFrame) {
  const now = performance.now();
  let diff = 0;
  if (latest) for (let i = 0; i < 1024; i++) if (latest.data[i] !== f.data[i]) diff++;
  const changed = !!latest && diff > 0 && (diff > 300 || now - lastAt > 200);
  latest = f;
  lastAt = now;
  if (useScreen.getState().recording !== null) record(f, now);
  if (f.label !== undefined && f.label !== useScreen.getState().label) useScreen.setState({ label: f.label });
  painters.forEach((p) => p(f, changed));
}

export function addPainter(p: Painter) {
  painters.add(p);
  if (latest) p(latest, false);
  return () => void painters.delete(p);
}
export const latestFrame = () => latest;
export const screenLive = () => !!stream && !useScreen.getState().paused;

export function updateStream() {
  const p = getPrefs();
  const run =
    isConnected() &&
    !useDevice.getState().console &&
    !useScreen.getState().paused &&
    consumers.size > 0 &&
    !(p.bgPause && document.hidden);
  if (run && !stream) stream = api.screen.stream(onFrame, Number(p.fps) || 15);
  else if (!run && stream) {
    stream.stop();
    stream = null;
  }
}
/* A screen came into view (or left it). */
export function setConsumer(token: object, showing: boolean) {
  if (showing) consumers.add(token);
  else consumers.delete(token);
  updateStream();
}

export function startScreen() {
  document.addEventListener("visibilitychange", updateStream);
  useSettings.subscribe((s, old) => {
    if (s.prefs.fps !== old.prefs.fps) stream?.setFps(Number(s.prefs.fps) || 15);
    if (s.prefs.bgPause !== old.prefs.bgPause) updateStream();
  });
  useDevice.subscribe((s, old) => {
    if (s.status === old.status && s.console === old.console) return;
    forgetHeld();
    stream?.stop();
    stream = null;
    updateStream();
  });
}

export function togglePause() {
  useScreen.setState((s) => ({ paused: !s.paused }));
  updateStream();
}

export interface RecFrame {
  at: number;
  frame: ScreenFrame;
}
export const MAX_GIF_FRAMES = 4500;
const MAX_DELAY = 10_000;
let rec: RecFrame[] = [];

function record(frame: ScreenFrame, at: number) {
  rec.push({ at, frame });
  if (rec.length >= MAX_GIF_FRAMES) void stopRecording();
}

export function squash(frames: RecFrame[]) {
  const out: RecFrame[] = [];
  for (const f of frames) {
    const prev = out[out.length - 1];
    const same =
      prev && prev.frame.orientation === f.frame.orientation && prev.frame.data.every((b, i) => b === f.frame.data[i]);
    if (!same) out.push(f);
  }
  return out;
}

const GIF_PIXEL_BUDGET = 300_000_000;
export function gifScale(frames: number, scale: number) {
  let k = Math.max(1, Math.round(scale));
  while (k > 1 && frames * 128 * 64 * k * k > GIF_PIXEL_BUDGET) k--;
  return k;
}

export async function encodeGif(frames: RecFrame[], end: number, colors: PaletteName, scale: number) {
  frames = squash(frames);
  const pal = PALETTES[colors] ?? PALETTES.orange,
    k = gifScale(frames.length, scale),
    o = frames[0].frame.orientation,
    { w, h } = oriented(frames[0].frame.data, o),
    W = w * k,
    H = h * k;
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const { at, frame } = frames[i],
      pic = oriented(frame.data, o),
      index = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) index[y * W + x] = pic.dark((x / k) | 0, (y / k) | 0);
    const next = i + 1 < frames.length ? frames[i + 1].at : end;
    gif.writeFrame(index, W, H, {
      palette: [[...pal.bg], [...pal.px]],
      delay: Math.min(MAX_DELAY, Math.max(20, next - at)),
      ...(i === 0 ? { repeat: 0 } : {}),
    });
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return gif.bytes();
}

async function stopRecording() {
  const frames = rec,
    end = performance.now();
  rec = [];
  useScreen.setState({ recording: null });
  if (!frames.length) return toast("Nothing to save: no frames came in while recording.", "record", true);
  const p = getPrefs();
  toast("Saving the GIF…", "record");
  const bytes = await encodeGif(frames, end, p.shotColors as PaletteName, Number(p.shotScale) || 4);
  const name = `${deviceName().toLowerCase()}-${stamp()}.gif`;
  let saved: string | null;
  try {
    saved = await saveFile(name, bytes, "image/gif");
  } catch {
    return toast("Couldn't save the GIF", "record", true);
  }
  if (!saved) return;
  toast(`Saved ${saved}`, "record");
  logActivity("record", "Recorded a GIF");
}

export function toggleRecording() {
  if (useScreen.getState().recording !== null) return void stopRecording();
  rec = latest ? [{ at: performance.now(), frame: latest }] : [];
  useScreen.setState({ recording: Date.now() });
}

const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, "");

let shotId = 0;
export async function screenshot() {
  const p = getPrefs(),
    palette = PALETTES[p.shotColors as PaletteName] ?? PALETTES.orange,
    k = Number(p.shotScale) || 4;
  const small = document.createElement("canvas");
  drawFrame(small, latest?.data ?? new Uint8Array(1024), palette, latest?.orientation);
  const big = document.createElement("canvas");
  big.width = small.width * k;
  big.height = small.height * k;
  const ctx = big.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, big.width, big.height);
  }
  const url = small.toDataURL();
  document.querySelectorAll<HTMLElement>(".scr .glass").forEach((g) =>
    g.animate?.([{ background: "rgba(255,255,255,.55)" }, { background: "rgba(255,255,255,0)" }], {
      duration: 320,
      easing: "ease-out",
    }),
  );
  buddyReact("screenshot");
  const name = `${deviceName().toLowerCase()}-${stamp()}.png`;
  const blob = await new Promise<Blob | null>((r) => big.toBlob(r, "image/png"));
  let saved: string | null;
  try {
    saved = blob ? await saveFile(name, new Uint8Array(await blob.arrayBuffer()), "image/png") : null;
  } catch {
    return toast("Couldn't save the screenshot", "camera", true);
  }
  if (!saved) return;
  useScreen.setState((s) => ({ shots: [{ id: ++shotId, name: saved, url }, ...s.shots] }));
  toast(`Saved ${saved}`, "camera");
  logActivity("camera", "Took a screenshot");
}
