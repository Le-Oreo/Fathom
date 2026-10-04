import { describe, expect, it } from "vitest";
import { cleanPrefs } from "./settings/schema";
import { currentIcon, easterMonth, holidayPick, holidaysNow, iconThumb, ALL_ICONS } from "./appicons";

const on = (y: number, m: number, d = 15) => new Date(y, m - 1, d);
const ids = (d: Date) => holidaysNow(d).map((h) => h.id);

describe("app icons", () => {
  it("offers each holiday only in its month, both when two share one", () => {
    expect(ids(on(2026, 10))).toEqual(["halloween"]);
    expect(ids(on(2026, 12))).toEqual(["hanukkah", "christmas"]);
    expect(ids(on(2026, 2))).toEqual(["lunar-new-year", "valentines"]); /* Feb 17, 2026 */
    expect(ids(on(2028, 1))).toEqual(["new-year", "lunar-new-year"]); /* Jan 26, 2028 */
    expect(ids(on(2028, 2))).toEqual(["valentines"]);
    expect(ids(on(2026, 6))).toEqual([]);
  });

  it("puts Easter in the right month", () => {
    expect(easterMonth(2026)).toBe(4); /* April 5 */
    expect(easterMonth(2027)).toBe(3); /* March 28 */
    expect(ids(on(2027, 3))).toEqual(["st-patricks", "easter"]);
  });

  it("a holiday pick lasts only for its month, then the colour comes back", () => {
    const pick = holidayPick("halloween", on(2026, 10, 3));
    expect(pick).toBe("halloween@2026-10");
    expect(currentIcon("teal", pick, on(2026, 10, 31))).toBe("halloween");
    expect(currentIcon("teal", pick, on(2026, 11, 1))).toBe("teal");
    expect(currentIcon("teal", undefined, on(2026, 10))).toBe("teal");
  });

  it("keeps only real picks from saved settings", () => {
    expect(cleanPrefs({ appIcon: "navy", _holidayIcon: "christmas@2026-12" })).toEqual({
      appIcon: "navy",
      _holidayIcon: "christmas@2026-12",
    });
    expect(cleanPrefs({ appIcon: "halloween", _holidayIcon: "nope@2026-12" })).toEqual({});
  });

  it("has a picture for every icon", () => {
    for (const i of ALL_ICONS) expect(iconThumb(i.id), i.id).toBeTruthy();
  });
});
