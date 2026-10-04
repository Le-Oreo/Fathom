import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api } from "../device";
import { DeviceError, type FileEntry, type UploadSource } from "../device/api";
import { errorMessage } from "../device/errors";
import {
  badName,
  baseName,
  canMoveInto,
  isTextName,
  isUnder,
  labelOf,
  listing,
  parentOf,
  PREVIEW_LIMIT,
  ROOTS,
  uniqueName,
  type SortKey,
} from "../files/logic";
import { pickDownloadFolder, pickUploadFolder, pickUploads } from "../platform";
import { getPrefs, setPref } from "./settings";
import { onUploaded, startDownload, startUpload } from "./transfers";
import { ask, toast } from "./ui";

export interface ViewerState {
  path: string;
  entry: FileEntry;
  text: string | null;
  editing: boolean;
}
export interface MoverState {
  names: string[];
  from: string;
  to: string;
}
interface FilesState {
  listings: Map<string, FileEntry[]>;
  path: string;
  sel: Set<string>;
  anchor: string;
  filter: string;
  selecting: boolean;
  open: Set<string>;
  sortDir: 1 | -1;
  fresh: Set<string>;
  viewer: ViewerState | null;
  mover: MoverState | null;
  /* the Flipper said there's no SD card */
  noSd: boolean;
}

export const useFiles = create<FilesState>(() => ({
  listings: new Map(),
  path: "/ext/subghz",
  sel: new Set(),
  anchor: "",
  filter: "",
  selecting: false,
  open: new Set(["/ext"]),
  sortDir: 1,
  fresh: new Set(),
  viewer: null,
  noSd: false,
  mover: null,
}));
const get = useFiles.getState,
  set = useFiles.setState;

const changedFns = new Set<(dirs: string[]) => void>();
export function onFilesChanged(fn: (dirs: string[]) => void) {
  changedFns.add(fn);
  return () => void changedFns.delete(fn);
}
const changed = (...dirs: string[]) => changedFns.forEach((fn) => fn(dirs));

/* ---------- the local copy of listings ---------- */
function setListing(path: string, entries: FileEntry[]) {
  const m = new Map(get().listings);
  m.set(path, entries);
  set({ listings: m });
  if (path === get().path) pruneSel();
}
function updateListing(path: string, fn: (l: FileEntry[]) => FileEntry[]) {
  const cur = get().listings.get(path);
  if (cur) setListing(path, fn(cur));
}
const movedFns = new Set<(from: string, to: string | null) => void>();
export function onPathMoved(fn: (from: string, to: string | null) => void) {
  movedFns.add(fn);
  return () => void movedFns.delete(fn);
}
function rekeyCache(from: string, to: string) {
  movedFns.forEach((fn) => fn(from, to));
  const swap = (k: string) => to + k.slice(from.length);
  const listings = new Map([...get().listings].map(([k, v]) => [isUnder(k, from) ? swap(k) : k, v]));
  const open = new Set([...get().open].map((k) => (isUnder(k, from) ? swap(k) : k)));
  const path = isUnder(get().path, from) ? swap(get().path) : get().path;
  set({ listings, open, path });
}
function dropCache(p: string) {
  movedFns.forEach((fn) => fn(p, null));
  set({
    listings: new Map([...get().listings].filter(([k]) => !isUnder(k, p))),
    open: new Set([...get().open].filter((k) => !isUnder(k, p))),
  });
}
function markFresh(p: string) {
  set({ fresh: new Set(get().fresh).add(p) });
  setTimeout(() => {
    const fresh = new Set(get().fresh);
    fresh.delete(p);
    set({ fresh });
  }, 1700);
}
function pruneSel() {
  const names = new Set(currentListing().map((f) => f.name));
  const sel = get().sel;
  if ([...sel].some((n) => !names.has(n))) set({ sel: new Set([...sel].filter((n) => names.has(n))) });
}

export function listOptions(s: Pick<FilesState, "filter" | "sortDir"> = get()) {
  const p = getPrefs();
  return {
    filter: s.filter,
    sortBy: p.sortBy as SortKey,
    sortDir: s.sortDir,
    foldersFirst: p.foldersFirst,
    hidden: p.hidden,
  };
}
export const currentListing = () => listing(get().listings.get(get().path) ?? [], listOptions());

let generation = 0;
async function loadQuiet(path: string) {
  const gen = generation;
  try {
    const entries = await api.storage.list(path);
    if (gen !== generation) return null;
    setListing(path, entries);
    return entries;
  } catch {
    return null;
  }
}
export async function loadListing(path: string) {
  const gen = generation;
  try {
    const entries = await api.storage.list(path);
    if (gen !== generation) return null;
    setListing(path, entries);
    if (isUnder(path, "/ext") && get().noSd) set({ noSd: false });
    return entries;
  } catch (err) {
    if (err instanceof DeviceError && err.code === "no-sd") set({ noSd: true });
    else toast(errorMessage(err), "info", true);
    return null;
  }
}

let tree: Promise<void> | null = null;
export function ensureTree() {
  if (tree) return tree;
  const gen = generation;
  const walk = async (p: string): Promise<void> => {
    if (gen !== generation) return;
    const list = get().listings.get(p) ?? (await loadQuiet(p));
    for (const f of list ?? []) if (f.dir) await walk(`${p}/${f.name}`);
  };
  tree = (async () => {
    for (const [root] of ROOTS) await walk(root);
  })();
  return tree;
}
/* A new session: forget what was read before. */
export function resetFiles() {
  generation++;
  tree = null;
  set({ listings: new Map(), sel: new Set(), anchor: "", viewer: null, mover: null, noSd: false });
}

/* ---------- moving around ---------- */
export async function openPath(p: string) {
  if (!p) return;
  const open = new Set(get().open);
  for (let a = p; a; a = parentOf(a)) open.add(a);
  set({ path: p, sel: new Set(), anchor: "", filter: "", open });
  await loadListing(p);
}
export async function refreshFolder(dir: string) {
  const m = new Map(get().listings);
  for (const k of [...m.keys()]) if (isUnder(k, dir) || isUnder(dir, k)) m.delete(k);
  set({ listings: m });
  const p = get().path;
  if (isUnder(p, dir) || isUnder(dir, p)) await loadListing(p);
  changed(dir);
}
export const goUp = () => {
  const p = parentOf(get().path);
  if (p) void openPath(p);
};
export function openItem(name: string, dir: boolean) {
  const p = `${get().path}/${name}`;
  if (dir) void openPath(p);
  else void openViewer(p);
}
export function toggleTwisty(p: string) {
  const open = new Set(get().open);
  if (open.has(p) && p !== get().path) open.delete(p);
  else open.add(p);
  set({ open });
}
export function setFilter(filter: string) {
  set({ filter });
  pruneSel();
}
export function sortBy(key: SortKey) {
  if (getPrefs().sortBy === key) set({ sortDir: get().sortDir === 1 ? -1 : 1 });
  else {
    set({ sortDir: 1 });
    setPref("sortBy", key);
  }
}

/* ---------- selection ---------- */
export const selectedNames = () => [...get().sel];
export const selectOnly = (name: string) => set({ sel: new Set([name]), anchor: name });
export function toggleSel(name: string) {
  const sel = new Set(get().sel);
  if (sel.has(name)) sel.delete(name);
  else sel.add(name);
  set({ sel, anchor: name });
}
export function rangeSel(name: string) {
  const names = currentListing().map((f) => f.name),
    a = names.indexOf(get().anchor),
    b = names.indexOf(name);
  if (a < 0 || b < 0) return selectOnly(name);
  set({ sel: new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1)) });
}
export const selectAll = () => set({ sel: new Set(currentListing().map((f) => f.name)) });
export const clearSel = () => set({ sel: new Set(), selecting: false });
export function toggleSelecting() {
  const selecting = !get().selecting;
  set(selecting ? { selecting } : { selecting, sel: new Set() });
}

/* ---------- move, rename, delete, new folder ---------- */
export async function moveItems(names: string[], from: string, to: string) {
  if (!canMoveInto(names, from, to)) return 0;
  const src = get().listings.get(from) ?? [];
  const dst = get().listings.get(to) ?? (await loadQuiet(to)) ?? [];
  const taken = dst.map((f) => f.name),
    moved: string[] = [];
  for (const name of names) {
    const item = src.find((f) => f.name === name);
    if (!item) continue;
    const oldPath = `${from}/${name}`;
    if (item.dir && isUnder(to, oldPath)) continue;
    const fresh = uniqueName(taken, name),
      newPath = `${to}/${fresh}`;
    try {
      await api.storage.rename(oldPath, newPath);
    } catch (err) {
      toast(errorMessage(err), "info", true);
      continue;
    }
    taken.push(fresh);
    updateListing(from, (l) => l.filter((f) => f.name !== name));
    updateListing(to, (l) => [...l, { ...item, name: fresh }]);
    rekeyCache(oldPath, newPath);
    markFresh(newPath);
    moved.push(fresh);
  }
  set({ sel: new Set() });
  if (moved.length) {
    toast(`Moved ${moved.length === 1 ? moved[0] : `${moved.length} items`} to ${labelOf(to)}`, "folder-input");
    buddyReact("saved");
    changed(from, to);
  }
  return moved.length;
}

export async function applyRename(from: string, name: string, n: string) {
  if (badName(n)) return (toast("Names can't contain slashes", "info", true), false);
  if ((get().listings.get(from) ?? []).some((x) => x.name === n))
    return (toast(`${n} is already in this folder`, "info", true), false);
  const oldPath = `${from}/${name}`,
    newPath = `${from}/${n}`;
  try {
    await api.storage.rename(oldPath, newPath);
  } catch (err) {
    return (toast(errorMessage(err), "info", true), false);
  }
  updateListing(from, (l) => l.map((x) => (x.name === name ? { ...x, name: n } : x)));
  rekeyCache(oldPath, newPath);
  if (from === get().path) set({ sel: new Set([n]) });
  changed(from);
  return true;
}
/* Returns the new name, or null if nothing changed. */
export async function renameItem(name: string, from = get().path) {
  const f = (get().listings.get(from) ?? []).find((x) => x.name === name);
  if (!f) return null;
  const n = await ask({ title: `Rename ${f.dir ? "folder" : "file"}`, value: name, ok: "Rename" });
  if (!n || n === name) return null;
  return (await applyRename(from, name, n)) ? n : null;
}

export async function applyDelete(from: string, names: string[], dirs: ReadonlySet<string>) {
  const done: string[] = [];
  for (const n of names) {
    const p = `${from}/${n}`;
    try {
      await api.storage.remove(p, dirs.has(n));
    } catch (err) {
      toast(errorMessage(err), "info", true);
      continue;
    }
    updateListing(from, (l) => l.filter((x) => x.name !== n));
    dropCache(p);
    done.push(n);
  }
  set({ sel: new Set() });
  if (done.length) changed(from);
  return done;
}
export async function deleteItems(names: string[], from = get().path) {
  if (!names.length) return false;
  const label = names.length === 1 ? names[0] : `${names.length} items`;
  const body = "It's removed from the Flipper. This can't be undone.";
  if (!(await ask({ title: `Delete ${label}?`, body, ok: "Delete", danger: true }))) return false;
  const list = get().listings.get(from) ?? [];
  const done = await applyDelete(from, names, new Set(list.filter((f) => f.dir).map((f) => f.name)));
  if (done.length) toast(`Deleted ${done.length === 1 ? done[0] : `${done.length} items`}`, "trash");
  return done.length > 0;
}

export async function downloadItems(names: string[], from = get().path) {
  const list = get().listings.get(from) ?? [];
  const items = names.map((n) => list.find((f) => f.name === n)).filter((f): f is FileEntry => !!f);
  if (!items.length) return toast("Pick a file first", "file", true);
  let folder;
  try {
    folder = await pickDownloadFolder();
  } catch (err) {
    return toast(errorMessage(err), "info", true);
  }
  if (!folder) return;
  for (const f of items) startDownload(f.name, from, f.dir, folder);
}
/* One file, from the details drawer or the Library. */
export const downloadFile = (name: string, from: string) =>
  downloadItems([name], from).catch(() => {}) as Promise<void>;

export async function makeFolder() {
  const path = get().path;
  const name = await ask({ title: "New folder", body: `In ${path}`, value: "", ok: "Create" });
  if (!name) return;
  if (badName(name)) return toast("Names can't contain slashes", "info", true);
  const list = get().listings.get(path) ?? [];
  if (list.some((f) => f.name === name)) return toast(`${name} is already in this folder`, "info", true);
  try {
    await api.storage.mkdir(`${path}/${name}`);
  } catch (err) {
    return toast(errorMessage(err), "info", true);
  }
  updateListing(path, (l) => [...l, { name, dir: true, size: 0, modified: Date.now() }]);
  setListing(`${path}/${name}`, []);
  set({ sel: new Set([name]) });
  markFresh(`${path}/${name}`);
  changed(path);
}

export function uploadFiles(files: Iterable<File>, to = get().path) {
  for (const file of files) startUpload({ file }, to);
}
export function uploadSources(sources: UploadSource[], to = get().path) {
  for (const s of sources) startUpload(s, to);
}
export async function pickAndUpload(to = get().path) {
  let picked;
  try {
    picked = await pickUploads();
  } catch (err) {
    toast(errorMessage(err), "info", true);
    return true;
  }
  if (picked === null) return false;
  uploadSources(picked, to);
  return true;
}
export async function pickAndUploadFolder(to = get().path) {
  try {
    const folder = await pickUploadFolder();
    if (folder) uploadSources([folder], to);
  } catch (err) {
    toast(errorMessage(err), "info", true);
  }
}
onUploaded((dir, name, size, isDir) => {
  const fresh = !(get().listings.get(dir) ?? []).some((f) => f.name === name);
  if (isDir) {
    /* what's inside gets read when it's opened */
    const ls = new Map(get().listings);
    for (const k of [...ls.keys()]) if (isUnder(k, `${dir}/${name}`)) ls.delete(k);
    set({ listings: ls });
  }
  updateListing(dir, (l) => {
    const e = { name, dir: isDir, size: isDir ? 0 : size, modified: Date.now() };
    return fresh ? [...l, e] : l.map((f) => (f.name === name ? e : f));
  });
  if (fresh) markFresh(`${dir}/${name}`);
  changed(dir);
});

/* ---------- the details drawer ---------- */
const enc = new TextEncoder(),
  dec = new TextDecoder();
let viewSeq = 0;
export async function openViewer(path: string) {
  const seq = ++viewSeq;
  const dir = parentOf(path),
    name = baseName(path),
    f = (get().listings.get(dir) ?? []).find((x) => x.name === name);
  if (!f) return;
  let entry = f,
    text: string | null = null;
  try {
    entry = await api.storage.stat(path);
    if (isTextName(name) && entry.size <= PREVIEW_LIMIT) text = dec.decode(await api.storage.read(path));
  } catch (err) {
    toast(errorMessage(err), "info", true);
  }
  if (seq === viewSeq) set({ viewer: { path, entry, text, editing: false } });
}
export const closeViewer = () => {
  viewSeq++;
  set({ viewer: null });
};
export function editViewer() {
  const v = get().viewer;
  if (v && v.text !== null) set({ viewer: { ...v, editing: true } });
}
export function cancelEdit() {
  const v = get().viewer;
  if (v) set({ viewer: { ...v, editing: false } });
}
export async function saveViewer(text: string) {
  const v = get().viewer;
  if (!v) return;
  const dir = parentOf(v.path),
    name = baseName(v.path),
    data = enc.encode(text);
  try {
    await api.storage.write(v.path, data);
  } catch (err) {
    return toast(errorMessage(err), "info", true);
  }
  updateListing(dir, (l) => l.map((f) => (f.name === name ? { ...f, size: data.length, modified: Date.now() } : f)));
  toast(`Saved ${name}`, "save");
  if (get().viewer?.path === v.path) await openViewer(v.path);
}

/* ---------- "Move to" ---------- */
export async function openMover(names: string[], from = get().path) {
  if (!names.length) return toast("Pick something to move first", "folder-input", true);
  await ensureTree();
  set({ mover: { names: [...names], from, to: "" } });
}
export function pickMoveTarget(to: string) {
  const m = get().mover;
  if (m) set({ mover: { ...m, to } });
}
export function closeMover(go: boolean) {
  const m = get().mover;
  set({ mover: null });
  if (go && m?.to) void moveItems(m.names, m.from, m.to);
}
