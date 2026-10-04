import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { appByName, categoryById, LIBRARY_CATEGORIES } from "../catalog";
import { api } from "../device";
import type { LibraryItem } from "../device/api";
import { openApp } from "./actions";
import { errorMessage } from "../device/errors";
import { isUnder, parentOf } from "../files/logic";
import { applyDelete, applyRename, downloadFile, onFilesChanged } from "./files";
import { useMarks, type Mark } from "./marks";
import { ask, toast } from "./ui";

interface LibraryState {
  items: LibraryItem[];
  cat: string;
  /* index into the category's items, newest first */
  sel: number;
  filter: string;
  /* "" every file, "starred", or a tag */
  mark: string;
}
export const useLibrary = create<LibraryState>(() => ({ items: [], cat: "subghz", sel: 0, filter: "", mark: "" }));
const get = useLibrary.getState,
  set = useLibrary.setState;

export const catItems = (items: LibraryItem[], cat: string) =>
  items
    .filter((i) => i.category === cat)
    .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0) || a.name.localeCompare(b.name));

export function visibleRows(s: Pick<LibraryState, "items" | "cat" | "filter" | "mark">, marks: Record<string, Mark>) {
  const f = s.filter.toLowerCase();
  const marked = (path: string) =>
    !s.mark || (s.mark === "starred" ? !!marks[path]?.star : !!marks[path]?.tags?.includes(s.mark));
  return catItems(s.items, s.cat)
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => (!f || it.name.toLowerCase().includes(f)) && marked(it.path));
}
export const selectedSignal = () => {
  const s = get(),
    rows = visibleRows(s, useMarks.getState().marks);
  return (rows.find((r) => r.i === s.sel) ?? rows[0])?.it;
};

let scanSeq = 0;
export async function scanLibrary(): Promise<unknown> {
  const seq = ++scanSeq;
  try {
    const items = await api.library.scan();
    if (seq !== scanSeq) return null;
    const n = catItems(items, get().cat).length;
    set({ items, sel: Math.min(get().sel, Math.max(0, n - 1)) });
    return null;
  } catch (err) {
    return err;
  }
}
/* anything changed in a category folder or below it */
onFilesChanged((dirs) => {
  if (dirs.some((d) => LIBRARY_CATEGORIES.some((c) => isUnder(d, c.folder)))) void scanLibrary();
});

export const pickCategory = (cat: string) => set({ cat, sel: 0, filter: "" });
export const pickSignal = (sel: number) => set({ sel });
function reselect() {
  const s = get(),
    rows = visibleRows(s, useMarks.getState().marks);
  if (rows.length && !rows.some((r) => r.i === s.sel)) set({ sel: rows[0].i });
}
export const setLibraryFilter = (filter: string) => (set({ filter }), reselect());
export const setLibraryMark = (mark: string) => (set({ mark: get().mark === mark ? "" : mark }), reselect());

export async function rescan() {
  const err = await scanLibrary();
  if (err) return toast(errorMessage(err), "info", true);
  toast("The library is up to date", "refresh");
}

export function openSignal() {
  const it = selectedSignal();
  if (it) void openApp(appByName(categoryById(it.category).app), it.path);
}
export function downloadSignal() {
  const it = selectedSignal();
  if (it) void downloadFile(it.name, parentOf(it.path));
}
export async function renameSignal() {
  const it = selectedSignal();
  if (!it) return;
  const name = await ask({ title: "Rename signal", value: it.name, ok: "Rename" });
  if (!name || name === it.name) return;
  if (await applyRename(parentOf(it.path), it.name, name)) {
    toast(`Renamed to ${name}`, "pencil");
    buddyReact("saved");
  }
}
export async function deleteSignal() {
  const it = selectedSignal();
  if (!it) return;
  const body = "It's removed from the Flipper's SD card. This can't be undone.";
  if (!(await ask({ title: `Delete ${it.name}?`, body, ok: "Delete", danger: true }))) return;
  const done = await applyDelete(parentOf(it.path), [it.name], new Set());
  if (!done.length) return;
  set({ sel: 0 });
  toast(`Deleted ${it.name}`, "trash");
}
