import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputType, Key } from "./device/api";

const sent: [Key, InputType][] = [];
vi.mock("./device", () => ({
  api: { input: { send: async (k: Key, t: InputType) => void sent.push([k, t]) } },
}));
vi.mock("./state/device", () => ({ isConnected: () => true }));
vi.mock("./state/ui", () => ({ toast: () => {} }));

const { keyDown, keyUp, LONG_MS, REPEAT_MS } = await import("./input");

beforeEach(() => {
  sent.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("pressing the Flipper's keys", () => {
  it("a quick press: press, short, release", async () => {
    keyDown("ok");
    await keyUp("ok");
    expect(sent).toEqual([
      ["ok", "press"],
      ["ok", "short"],
      ["ok", "release"],
    ]);
  });

  it("a hold: press, long, repeats while held, release (no short)", async () => {
    keyDown("down");
    await vi.advanceTimersByTimeAsync(LONG_MS + REPEAT_MS * 2 + 10);
    await keyUp("down");
    expect(sent).toEqual([
      ["down", "press"],
      ["down", "long"],
      ["down", "repeat"],
      ["down", "repeat"],
      ["down", "release"],
    ]);
    /* nothing more once it's let go */
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 3);
    expect(sent).toHaveLength(5);
  });

  it("the key looks pressed exactly while it's held", async () => {
    document.body.innerHTML = `<button data-key="up"></button>`;
    const b = document.querySelector("button")!;
    keyDown("up");
    expect(b.classList.contains("down")).toBe(true);
    await keyUp("up");
    expect(b.classList.contains("down")).toBe(false);
  });
});
