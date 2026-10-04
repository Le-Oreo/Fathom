import { describe, expect, it } from "vitest";
import type { FileEntry } from "../device/api";
import {
  allFolders,
  blockedFor,
  bytesOf,
  canMoveInto,
  dateValue,
  fmtDate,
  fmtDay,
  fmtSize,
  kindOf,
  listing,
  parentOf,
  subfolders,
  uniqueName,
  type ListOptions,
} from "./logic";

const f = (name: string, size = 0, modified = 0, dir = false): FileEntry => ({ name, size, modified, dir });
const opts = (o: Partial<ListOptions> = {}): ListOptions => ({
  filter: "",
  sortBy: "name",
  sortDir: 1,
  foldersFirst: true,
  hidden: false,
  ...o,
});
const names = (l: FileEntry[]) => l.map((x) => x.name);

describe("listing", () => {
  const dir = [
    f("b.sub", 2048, 3),
    f("A.sub", 12288, 1),
    f("zeta", 0, 2, true),
    f(".hidden", 10, 4),
    f("alpha", 0, 5, true),
  ];

  it("sorts by name, folders first, ignoring case", () => {
    expect(names(listing(dir, opts()))).toEqual(["alpha", "zeta", "A.sub", "b.sub"]);
  });
  it("reverses the order but keeps folders first", () => {
    expect(names(listing(dir, opts({ sortDir: -1 })))).toEqual(["zeta", "alpha", "b.sub", "A.sub"]);
  });
  it("mixes folders in when Folders first is off", () => {
    expect(names(listing(dir, opts({ foldersFirst: false })))).toEqual(["A.sub", "alpha", "b.sub", "zeta"]);
  });
  it("sorts by size and by date", () => {
    expect(names(listing(dir, opts({ sortBy: "size", foldersFirst: false })))).toEqual([
      "alpha",
      "zeta",
      "b.sub",
      "A.sub",
    ]);
    expect(names(listing(dir, opts({ sortBy: "date" })))).toEqual(["zeta", "alpha", "A.sub", "b.sub"]);
  });
  it("filters by name and hides dot files unless asked", () => {
    expect(names(listing(dir, opts({ filter: " SUB " })))).toEqual(["A.sub", "b.sub"]);
    expect(names(listing(dir, opts({ hidden: true })))).toContain(".hidden");
    expect(names(listing(dir, opts()))).not.toContain(".hidden");
  });
});

describe("folders", () => {
  const listings = new Map<string, FileEntry[]>([
    ["/ext", [f("subghz", 0, 0, true), f("apps", 0, 0, true), f("note.txt", 5)]],
    ["/ext/apps", [f("Games", 0, 0, true), f(".cache", 0, 0, true)]],
    ["/ext/apps/Games", []],
    ["/ext/subghz", []],
    ["/int", []],
  ]);
  it("lists subfolders in order and skips hidden ones", () => {
    expect(subfolders(listings, "/ext", false)).toEqual(["/ext/apps", "/ext/subghz"]);
    expect(subfolders(listings, "/ext/apps", false)).toEqual(["/ext/apps/Games"]);
    expect(subfolders(listings, "/ext/apps", true)).toEqual(["/ext/apps/.cache", "/ext/apps/Games"]);
  });
  it("walks every folder depth-first for Move to", () => {
    expect(allFolders(listings, false).map((x) => [x.path, x.depth, x.label])).toEqual([
      ["/ext", 0, "SD card"],
      ["/ext/apps", 1, "apps"],
      ["/ext/apps/Games", 2, "Games"],
      ["/ext/subghz", 1, "subghz"],
      ["/int", 0, "Internal"],
    ]);
  });
  it("finds a path's parent", () => {
    expect(parentOf("/ext/apps/Games")).toBe("/ext/apps");
    expect(parentOf("/ext")).toBe("");
  });
});

describe("name collisions", () => {
  it("keeps a free name", () => expect(uniqueName(["a.sub"], "b.sub")).toBe("b.sub"));
  it("numbers before the extension", () => expect(uniqueName(["a.sub", "a_2.sub"], "a.sub")).toBe("a_3.sub"));
  it("numbers names without an extension and dot files", () => {
    expect(uniqueName(["backups"], "backups")).toBe("backups_2");
    expect(uniqueName([".bt.settings"], ".bt.settings")).toBe(".bt_2.settings");
  });
});

describe("move rules", () => {
  it("won't move into the same folder or nowhere", () => {
    expect(canMoveInto(["a.sub"], "/ext/subghz", "/ext/subghz")).toBe(false);
    expect(canMoveInto(["a.sub"], "/ext/subghz", "")).toBe(false);
  });
  it("won't move a folder into itself or anything under it", () => {
    expect(canMoveInto(["backups"], "/ext/subghz", "/ext/subghz/backups")).toBe(false);
    expect(canMoveInto(["backups"], "/ext/subghz", "/ext/subghz/backups/2026-08")).toBe(false);
    expect(canMoveInto(["backups"], "/ext/subghz", "/ext/infrared")).toBe(true);
  });
  it("allows it when at least one item can go", () => {
    expect(canMoveInto(["backups", "a.sub"], "/ext/subghz", "/ext/subghz/backups")).toBe(true);
  });
  it("doesn't confuse a folder with one that starts with the same name", () => {
    expect(canMoveInto(["back"], "/ext", "/ext/backups")).toBe(true);
    expect(blockedFor(["back"], "/ext", "/ext/backups")).toBe(false);
    expect(blockedFor(["backups"], "/ext", "/ext/backups/x")).toBe(true);
  });
});

describe("sizes, dates and kinds", () => {
  it("reads and writes sizes the way the app shows them", () => {
    expect(bytesOf("12 KB")).toBe(12288);
    expect(fmtSize(bytesOf("12 KB"))).toBe("12 KB");
    expect(fmtSize(500)).toBe("500 B");
    expect(fmtSize(5 * 1048576)).toBe("5.0 MB");
  });
  it("shows dates the way the app shows them", () => {
    const now = new Date(2026, 9, 2, 12, 0).getTime();
    expect(fmtDate(dateValue("Today 10:21", new Date(now)), now)).toBe("Today 10:21");
    expect(fmtDate(dateValue("Sep 01", new Date(now)), now)).toBe("Sep 01");
    expect(fmtDate(now - 5000, now)).toBe("Just now");
    expect(fmtDate(new Date(2025, 2, 3).getTime(), now)).toBe("Mar 03, 2025");
    expect(fmtDay(dateValue("Today 10:21", new Date(now)), now)).toBe("Today");
  });
  it("knows what a file is and which app opens it", () => {
    expect(kindOf("doorbell.sub", false)).toMatchObject({ label: "Sub-GHz signal", app: "Sub-GHz" });
    expect(kindOf(".bt.settings", false).label).toBe("Flipper settings");
    expect(kindOf("README", false).label).toBe("File");
    expect(kindOf("photo.png", false).label).toBe("PNG file");
    expect(kindOf("apps", true).label).toBe("Folder");
  });
});
