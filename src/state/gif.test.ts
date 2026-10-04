import { describe, expect, it } from "vitest";
import type { ScreenFrame } from "../device/api";
import type { RecFrame } from "./screen";

window.matchMedia ??= (q: string) =>
  ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
const { encodeGif, gifScale, squash } = await import("./screen");

const frame = (fill: number): ScreenFrame => ({ data: new Uint8Array(1024).fill(fill), orientation: "horizontal" });

describe("Record GIF", () => {
  it("merges frames where nothing changed", () => {
    const rec: RecFrame[] = [
      { at: 0, frame: frame(0) },
      { at: 50, frame: frame(0) },
      { at: 100, frame: frame(1) },
      { at: 150, frame: frame(1) },
    ];
    expect(squash(rec).map((r) => r.at)).toEqual([0, 100]);
  });

  it("steps the size down for long recordings", () => {
    expect(gifScale(100, 4)).toBe(4);
    expect(gifScale(4500, 8)).toBeLessThan(8);
    expect(gifScale(4500, 8) ** 2 * 4500 * 8192).toBeLessThanOrEqual(300_000_000);
    expect(gifScale(1_000_000, 4)).toBe(1);
  });

  it("writes a looping GIF at the chosen size", async () => {
    const bytes = await encodeGif(
      [
        { at: 0, frame: frame(0) },
        { at: 100, frame: frame(255) },
      ],
      300,
      "orange",
      2,
    );
    const text = new TextDecoder().decode(bytes.subarray(0, 6));
    expect(text).toBe("GIF89a");
    /* logical screen size, little-endian */
    expect([bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8)]).toEqual([256, 128]);
  });
});
