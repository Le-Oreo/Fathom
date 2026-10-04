import type { Orientation } from "./device/api";

export type Frame = Uint8Array;
type Rgb = readonly [number, number, number];
export const PALETTES = {
  orange: { bg: [255, 130, 0] as Rgb, px: [28, 15, 3] as Rgb },
  mono: { bg: [255, 255, 255] as Rgb, px: [0, 0, 0] as Rgb },
  paper: { bg: [242, 236, 223] as Rgb, px: [23, 19, 13] as Rgb },
};
export type PaletteName = keyof typeof PALETTES;

export const isPortrait = (o: Orientation = "horizontal") => o === "vertical" || o === "vertical-flip";

export function oriented(buf: Frame, o: Orientation = "horizontal") {
  const dark = (x: number, y: number) => (buf[(y >> 3) * 128 + x] >> (y & 7)) & 1;
  switch (o) {
    case "horizontal-flip":
      return { w: 128, h: 64, dark: (x: number, y: number) => dark(127 - x, 63 - y) };
    case "vertical":
      return { w: 64, h: 128, dark: (x: number, y: number) => dark(y, 63 - x) };
    case "vertical-flip":
      return { w: 64, h: 128, dark: (x: number, y: number) => dark(127 - y, x) };
    default:
      return { w: 128, h: 64, dark };
  }
}

export function drawFrame(canvas: HTMLCanvasElement, buf: Frame, palette = PALETTES.orange, o?: Orientation) {
  const pic = oriented(buf, o);
  if (canvas.width !== pic.w || canvas.height !== pic.h) {
    canvas.width = pic.w;
    canvas.height = pic.h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(pic.w, pic.h);
  for (let y = 0; y < pic.h; y++)
    for (let x = 0; x < pic.w; x++) {
      const o4 = (y * pic.w + x) * 4,
        c = pic.dark(x, y) ? palette.px : palette.bg;
      img.data[o4] = c[0];
      img.data[o4 + 1] = c[1];
      img.data[o4 + 2] = c[2];
      img.data[o4 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

export function fitZoom(avail: number, max: number) {
  let k = Math.min(max, (avail - 12) / 134);
  if (k >= 2) k = Math.floor(k);
  return k;
}
