import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isUnder } from "../files/logic";
import { useDevice } from "./device";
import { onPathMoved } from "./files";

export interface Mark {
  star?: boolean;
  tags?: string[];
}
type Marks = Record<string, Mark>;

interface MarksState {
  /* the Flipper they belong to */
  id: string;
  marks: Marks;
  loaded: boolean;
}
export const useMarks = create<MarksState>(() => ({ id: "", marks: {}, loaded: false }));
const get = useMarks.getState,
  set = useMarks.setState;

const KEY = (id: string) => `fathom-marks:${id}`;
const appStore = isTauri()
  ? import("@tauri-apps/plugin-store").then((m) => m.load("library.json", { autoSave: 300 }))
  : null;
async function load(id: string): Promise<Marks> {
  try {
    if (appStore) return ((await (await appStore).get(KEY(id))) as Marks | undefined) ?? {};
    return JSON.parse(localStorage.getItem(KEY(id)) || "{}") as Marks;
  } catch {
    return {};
  }
}
function save() {
  const { id, marks, loaded } = get();
  if (!id || !loaded) return;
  try {
    if (appStore) void appStore.then((s) => s.set(KEY(id), marks)).catch(() => {});
    else localStorage.setItem(KEY(id), JSON.stringify(marks));
  } catch {
    /* can't keep them: they last for this visit */
  }
}

function follow(id: string) {
  if (!id || id === get().id) return;
  set({ id, marks: {}, loaded: false });
  void load(id).then((saved) => {
    if (get().id !== id) return;
    set({ marks: { ...saved, ...get().marks }, loaded: true });
    save();
  });
}
useDevice.subscribe((s) => follow(s.info?.id ?? ""));
follow(useDevice.getState().info?.id ?? "");

function change(path: string, fn: (m: Mark) => Mark) {
  const next = fn({ ...get().marks[path] });
  const marks = { ...get().marks };
  if (!next.star && !next.tags?.length) delete marks[path];
  else marks[path] = next;
  set({ marks });
  save();
}

/* "Front door" -> "front door": one spelling per tag. */
export const cleanTag = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 32);

export const toggleStar = (path: string) => change(path, (m) => ({ ...m, star: !m.star }));
export function addTag(path: string, raw: string) {
  const tag = cleanTag(raw);
  if (!tag) return;
  change(path, (m) => ({ ...m, tags: [...new Set([...(m.tags ?? []), tag])].sort() }));
}
export const removeTag = (path: string, tag: string) =>
  change(path, (m) => ({ ...m, tags: (m.tags ?? []).filter((t) => t !== tag) }));

/* Every tag in use, for the filter. */
export const allTags = (marks: Marks) => [...new Set(Object.values(marks).flatMap((m) => m.tags ?? []))].sort();

export function movePath(from: string, to: string | null) {
  const marks = get().marks;
  if (!Object.keys(marks).some((k) => isUnder(k, from))) return;
  const next: Marks = {};
  for (const [k, m] of Object.entries(marks)) {
    if (!isUnder(k, from)) next[k] = m;
    else if (to !== null) next[to + k.slice(from.length)] = m;
  }
  set({ marks: next });
  save();
}
onPathMoved(movePath);
