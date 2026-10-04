import { describe, expect, it } from "vitest";
import { clockOf, dateOf, driftText } from "./clock";

describe("the Flipper's clock", () => {
  it("turns dates into its fields and back", () => {
    const d = new Date(2026, 9, 4, 14, 2, 11); /* a Sunday */
    expect(clockOf(d)).toEqual({ year: 2026, month: 10, day: 4, hour: 14, minute: 2, second: 11, weekday: 7 });
    expect(dateOf(clockOf(d)).getTime()).toBe(d.getTime());
    expect(clockOf(new Date(2026, 9, 5)).weekday).toBe(1);
  });
  it("says how far off it was", () => {
    expect(driftText(-192_000)).toBe("3 min 12 s behind");
    expect(driftText(4_000)).toBe("4 s ahead");
    expect(driftText(900)).toBe("right on time");
    expect(driftText(-2 * 3600_000 - 60_000)).toBe("2 h 1 min behind");
  });
});
