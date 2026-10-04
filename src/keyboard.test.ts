import { describe, expect, it } from "vitest";
import {
  applyInput,
  clearPresses,
  drawKeyboard,
  findSelected,
  move,
  ROWS,
  route,
  typePresses,
  untypeable,
  type KeyboardModel,
} from "./keyboard";

const run = (m: KeyboardModel, presses: ReturnType<typeof typePresses>) =>
  presses.reduce((acc, p) => applyInput(acc, p.key, p.type), m);

describe("the Flipper's on-screen keyboard", () => {
  it("moves between rows the way the firmware does", () => {
    expect(move({ row: 0, col: 13 }, "down")).toEqual({ row: 1, col: 12 });
    expect(move({ row: 1, col: 12 }, "down")).toEqual({ row: 2, col: 11 });
    expect(move({ row: 2, col: 11 }, "up")).toEqual({ row: 1, col: 12 });
    expect(move({ row: 0, col: 0 }, "left")).toEqual({ row: 0, col: 13 });
    expect(move({ row: 2, col: 11 }, "right")).toEqual({ row: 2, col: 0 });
    expect(move({ row: 0, col: 4 }, "up")).toEqual({ row: 0, col: 4 });
  });

  it("finds the shortest way, wrapping round a row when that's shorter", () => {
    expect(route({ row: 0, col: 0 }, { row: 0, col: 13 })).toEqual(["left"]);
    expect(route({ row: 0, col: 0 }, { row: 2, col: 0 })).toEqual(["down", "down"]);
  });

  it("sees which key is highlighted, and nothing on other screens", () => {
    ROWS.forEach((r, row) =>
      r.forEach((_, col) =>
        expect(findSelected(drawKeyboard({ pos: { row, col }, text: "", clearDefault: false }))).toEqual({ row, col }),
      ),
    );
    expect(findSelected(new Uint8Array(1024))).toBeNull();
    expect(findSelected(new Uint8Array(1024).fill(255))).toBeNull();
  });

  it("types names with capitals, digits, spaces and underscores from anywhere", () => {
    for (const text of ["Doorbell", "garage_2", "Front Door 7", "aB", "x", "TV remote"])
      for (const start of [
        { row: 0, col: 0 },
        { row: 2, col: 8 },
        { row: 1, col: 9 },
        { row: 0, col: 13 },
      ]) {
        let m: KeyboardModel = { pos: start, text: "Untitled", clearDefault: true };
        m = run(m, clearPresses());
        m = run(m, typePresses(text, m.pos));
        expect(m.text).toBe(text);
      }
  });

  it("clears whatever was typed before", () => {
    const m = run({ pos: { row: 0, col: 0 }, text: "old_name_12", clearDefault: false }, clearPresses());
    expect(m.text).toBe("");
  });

  it("refuses what the keyboard doesn't have", () => {
    expect(() => typePresses("a.b", { row: 0, col: 0 })).toThrow();
    expect(untypeable("hi! (2).txt")).toEqual(["!", "(", ")", "."]);
  });
});
