import type { FileEntry } from "../device/api";
import type { IconName } from "../icon-map";

export const ROOTS: [path: string, label: string, icon: IconName][] = [
  ["/ext", "SD card", "hard-drive"],
  ["/int", "Internal", "cpu"],
];

/* ext: [label, icon, the app that opens it] */
const KINDS: Record<string, [string, IconName, string?]> = {
  sub: ["Sub-GHz signal", "subghz", "Sub-GHz"],
  ir: ["Infrared remote", "ir", "Infrared"],
  nfc: ["NFC tag", "nfc", "NFC"],
  rfid: ["RFID tag", "rfid", "RFID 125 kHz"],
  ibtn: ["iButton key", "ibutton", "iButton"],
  txt: ["Text", "file-text"],
  fap: ["App", "app-window"],
  fmf: ["Music", "music"],
  save: ["App data", "file-cog"],
  settings: ["Flipper settings", "file-cog"],
  tar: ["Archive", "archive"],
  fuf: ["Update package", "package"],
};
export interface Kind {
  label: string;
  icon: IconName;
  app?: string;
  ext: string;
}
export function kindOf(name: string, dir: boolean): Kind {
  if (dir) return { label: "Folder", icon: "folder", ext: "" };
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  const k = KINDS[ext];
  return k
    ? { label: k[0], icon: k[1], app: k[2], ext }
    : { label: ext ? `${ext.toUpperCase()} file` : "File", icon: "file", ext };
}

export const PREVIEW_LIMIT = 262144;
export const isTextName = (name: string) => /\.(txt|md|csv|json|log|fmf)$/i.test(name);

export const isHidden = (name: string) => name.startsWith(".");
export const parentOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};
export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const rootOf = (p: string) => ROOTS.find((r) => r[0] === p);
export const labelOf = (p: string) => rootOf(p)?.[1] ?? baseName(p);
export const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
export const badName = (name: string) => /[\\/]/.test(name);

/* ---------- sizes and dates ---------- */
export function bytesOf(s: string) {
  const m = /([\d.]+)\s*(B|KB|MB|GB)/i.exec(s || "");
  if (!m) return 0;
  const unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[m[2].toUpperCase() as "B" | "KB" | "MB" | "GB"];
  return Math.round(Number(m[1]) * unit);
}
export const fmtSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;
export const fmtGB = (b: number) => (b / 1073741824).toFixed(1);

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad = (n: number) => String(n).padStart(2, "0");
export function dateValue(s: string, now = new Date()) {
  const t = /(\d{1,2}):(\d{2})/.exec(s);
  if (/^just now/i.test(s)) return now.getTime();
  if (/^today/i.test(s))
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t ? +t[1] : 0, t ? +t[2] : 0).getTime();
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})/.exec(s);
  return m ? new Date(now.getFullYear(), MONTHS.indexOf(m[1]), +m[2]).getTime() : 0;
}
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayLabel = (d: Date, now: Date) =>
  `${MONTHS[d.getMonth()]} ${pad(d.getDate())}${d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fmtDate(ms: number | undefined, nowMs = Date.now()) {
  if (!ms) return "";
  const d = new Date(ms),
    now = new Date(nowMs);
  if (nowMs - ms < 60000 && nowMs >= ms) return "Just now";
  return sameDay(d, now) ? `Today ${clock(d)}` : dayLabel(d, now);
}
/* A day only: "Today", "Sep 28". */
export function fmtDay(ms: number | undefined, nowMs = Date.now()) {
  if (!ms) return "";
  const d = new Date(ms),
    now = new Date(nowMs);
  return sameDay(d, now) ? "Today" : dayLabel(d, now);
}
export function fmtTime(ms: number, nowMs = Date.now()) {
  const d = new Date(ms),
    now = new Date(nowMs);
  if (nowMs - ms < 60000 && nowMs >= ms) return "Just now";
  return sameDay(d, now) ? clock(d) : dayLabel(d, now);
}
/* Inside a sentence: "today at 10:21", "Sep 29". */
export function fmtWhen(ms: number, nowMs = Date.now()) {
  const d = new Date(ms),
    now = new Date(nowMs);
  return sameDay(d, now) ? `today at ${clock(d)}` : dayLabel(d, now);
}

/* ---------- listing ---------- */
export type SortKey = "name" | "size" | "date";
export interface ListOptions {
  filter: string;
  sortBy: SortKey;
  sortDir: 1 | -1;
  foldersFirst: boolean;
  hidden: boolean;
}
export const visible = (list: FileEntry[], hidden: boolean) => list.filter((f) => hidden || !isHidden(f.name));

export function listing(entries: FileEntry[], o: ListOptions) {
  const q = o.filter.trim().toLowerCase();
  const val = (f: FileEntry) =>
    o.sortBy === "size" ? (f.dir ? -1 : f.size) : o.sortBy === "date" ? (f.modified ?? 0) : f.name.toLowerCase();
  return visible(entries, o.hidden)
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (o.foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
      const va = val(a),
        vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : a.name.localeCompare(b.name)) * o.sortDir;
    });
}

export type Listings = ReadonlyMap<string, FileEntry[]>;
export function subfolders(listings: Listings, p: string, hidden: boolean) {
  return visible(listings.get(p) ?? [], hidden)
    .filter((f) => f.dir)
    .map((f) => `${p}/${f.name}`)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
export function allFolders(listings: Listings, hidden: boolean) {
  const out: { path: string; depth: number; label: string }[] = [];
  const walk = (p: string, depth: number) => {
    out.push({ path: p, depth, label: labelOf(p) });
    subfolders(listings, p, hidden).forEach((c) => walk(c, depth + 1));
  };
  ROOTS.forEach(([p]) => walk(p, 0));
  return out;
}

/* ---------- names and moves ---------- */
export function uniqueName(taken: readonly string[], name: string) {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf("."),
    base = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const c = `${base}_${i}${ext}`;
    if (!taken.includes(c)) return c;
  }
}
export function canMoveInto(names: readonly string[], from: string, to: string) {
  if (!to || to === from) return false;
  return names.some((n) => !isUnder(to, `${from}/${n}`));
}
export const blockedFor = (names: readonly string[], from: string, p: string) =>
  names.every((n) => isUnder(p, `${from}/${n}`));
