import { beforeEach, describe, expect, it } from "vitest";
import { cleanPrefs, defaults, SETTINGS } from "./schema";
import { browserStorage, PREF_KEY } from "./storage";

describe("settings", () => {
  it("has the right defaults", () => {
    const d = defaults();
    expect(d).toMatchObject({
      startPage: "dock",
      accent: "orange",
      density: "comfy",
      fps: "15",
      dolphin: true,
      hidden: false,
      sortBy: "name",
    });
    expect(Object.keys(d)).toHaveLength(SETTINGS.length);
  });

  it("keeps only known settings with allowed values", () => {
    const raw = {
      accent: "green",
      density: "huge",
      fps: 30,
      dolphin: "yes",
      hidden: true,
      junk: 1,
      _lastView: "files",
    };
    expect(cleanPrefs(raw)).toEqual({ accent: "green", fps: "30", hidden: true, _lastView: "files" });
    expect(cleanPrefs(null)).toEqual({});
    expect(cleanPrefs("accent")).toEqual({});
  });

  it("no longer has a way to skip confirmations", () => {
    expect(SETTINGS.some((s) => (s.id as string) === "confirm")).toBe(false);
  });
});

describe("browser storage", () => {
  beforeEach(() => localStorage.clear());

  it("saves and loads", async () => {
    browserStorage.save({ accent: "blue" });
    expect(JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}")).toEqual({ accent: "blue" });
    expect(await browserStorage.load()).toEqual({ accent: "blue" });
  });

  it("loads nothing when the save is garbled", async () => {
    localStorage.setItem(PREF_KEY, "{not json");
    expect(await browserStorage.load()).toEqual({});
    expect(cleanPrefs(await browserStorage.load())).toEqual({});
  });
});
