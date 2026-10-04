import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./files", () => ({ onPathMoved: () => () => {} }));
vi.mock("./device", () => ({ useDevice: { subscribe: () => () => {}, getState: () => ({}) } }));
const { addTag, allTags, cleanTag, movePath, removeTag, toggleStar, useMarks } = await import("./marks");

beforeEach(() => useMarks.setState({ id: "flip_Test", marks: {}, loaded: true }));

describe("favourites and tags", () => {
  it("stars, tags in one spelling, and forgets empty marks", () => {
    toggleStar("/ext/subghz/a.sub");
    addTag("/ext/subghz/a.sub", "  Front   Door ");
    addTag("/ext/subghz/a.sub", "front door");
    addTag("/ext/subghz/a.sub", "garage");
    expect(useMarks.getState().marks["/ext/subghz/a.sub"]).toEqual({ star: true, tags: ["front door", "garage"] });
    expect(cleanTag("x".repeat(50))).toHaveLength(32);
    toggleStar("/ext/subghz/a.sub");
    removeTag("/ext/subghz/a.sub", "front door");
    removeTag("/ext/subghz/a.sub", "garage");
    expect(useMarks.getState().marks).toEqual({});
  });

  it("follows a rename or a folder move, and goes with a delete", () => {
    addTag("/ext/subghz/old.sub", "car");
    toggleStar("/ext/subghz/backups/x.sub");
    movePath("/ext/subghz/old.sub", "/ext/subghz/new.sub");
    movePath("/ext/subghz/backups", "/ext/archive/backups");
    expect(Object.keys(useMarks.getState().marks).sort()).toEqual([
      "/ext/archive/backups/x.sub",
      "/ext/subghz/new.sub",
    ]);
    expect(allTags(useMarks.getState().marks)).toEqual(["car"]);
    movePath("/ext/archive", null);
    expect(Object.keys(useMarks.getState().marks)).toEqual(["/ext/subghz/new.sub"]);
  });
});
