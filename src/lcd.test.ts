import { describe, expect, it } from "vitest";
import { fitZoom, oriented } from "./lcd";

describe("fitZoom", () => {
  it("uses whole-number zoom from 2x up", () => {
    expect(fitZoom(600, 6)).toBe(4);
    expect(fitZoom(10_000, 6)).toBe(6);
  });
  it("keeps fractional zoom below 2x", () => {
    expect(fitZoom(300, 1.5)).toBe(1.5);
    expect(fitZoom(200, 4)).toBeCloseTo(188 / 134);
  });
});

describe("oriented", () => {
  /* one dark pixel at the physical top-left corner */
  const corner = new Uint8Array(1024);
  corner[0] = 1;
  const darkAt = (o: Parameters<typeof oriented>[1]) => {
    const p = oriented(corner, o);
    const hits: [number, number][] = [];
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.dark(x, y)) hits.push([x, y]);
    return { size: [p.w, p.h], hits };
  };
  it("turns the picture the way qFlipper does", () => {
    expect(darkAt("horizontal")).toEqual({ size: [128, 64], hits: [[0, 0]] });
    expect(darkAt("horizontal-flip")).toEqual({ size: [128, 64], hits: [[127, 63]] });
    /* 90° clockwise: the top-left corner ends up top-right */
    expect(darkAt("vertical")).toEqual({ size: [64, 128], hits: [[63, 0]] });
    /* 90° the other way: bottom-left */
    expect(darkAt("vertical-flip")).toEqual({ size: [64, 128], hits: [[0, 127]] });
  });
  it("reads the page layout: byte (y >> 3) * 128 + x, bit y & 7", () => {
    const f = new Uint8Array(1024);
    f[2 * 128 + 5] = 1 << 3; /* x 5, y 19 */
    expect(oriented(f).dark(5, 19)).toBe(1);
    expect(oriented(f).dark(5, 18)).toBe(0);
  });
});
