import type { InputType, Key } from "./device/api";

export const BACKSPACE = "\b";
export const ENTER = "\r";

interface KeyDef {
  ch: string;
  x: number;
  y: number;
}
const k = (ch: string, x: number, y: number): KeyDef => ({ ch, x, y });
export const ROWS: KeyDef[][] = [
  [
    k("q", 1, 8),
    k("w", 10, 8),
    k("e", 19, 8),
    k("r", 28, 8),
    k("t", 37, 8),
    k("y", 46, 8),
    k("u", 55, 8),
    k("i", 64, 8),
    k("o", 73, 8),
    k("p", 82, 8),
    k("0", 91, 8),
    k("1", 100, 8),
    k("2", 110, 8),
    k("3", 120, 8),
  ],
  [
    k("a", 1, 20),
    k("s", 10, 20),
    k("d", 19, 20),
    k("f", 28, 20),
    k("g", 37, 20),
    k("h", 46, 20),
    k("j", 55, 20),
    k("k", 64, 20),
    k("l", 73, 20),
    k(BACKSPACE, 82, 12),
    k("4", 100, 20),
    k("5", 110, 20),
    k("6", 120, 20),
  ],
  [
    k("z", 1, 32),
    k("x", 10, 32),
    k("c", 19, 32),
    k("v", 28, 32),
    k("b", 37, 32),
    k("n", 46, 32),
    k("m", 55, 32),
    k("_", 64, 32),
    k(ENTER, 74, 23),
    k("7", 100, 32),
    k("8", 110, 32),
    k("9", 120, 32),
  ],
];
const ORIGIN_X = 1,
  ORIGIN_Y = 29;

export interface Pos {
  row: number;
  col: number;
}

export function move(p: Pos, key: "up" | "down" | "left" | "right"): Pos {
  let { row, col } = p;
  const size = (r: number) => ROWS[r].length;
  if (key === "up" && row > 0) {
    row--;
    if (col > size(row) - 6) col = col + 1;
  } else if (key === "down" && row < ROWS.length - 1) {
    row++;
    if (col > size(row) - 4) col = col - 1;
  } else if (key === "left") col = col > 0 ? col - 1 : size(row) - 1;
  else if (key === "right") col = col < size(row) - 1 ? col + 1 : 0;
  return { row, col };
}

export function route(from: Pos, to: Pos): ("up" | "down" | "left" | "right")[] {
  const id = (p: Pos) => `${p.row},${p.col}`;
  const seen = new Map<string, { prev: string; key: "up" | "down" | "left" | "right" } | null>([[id(from), null]]);
  const queue: Pos[] = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p.row === to.row && p.col === to.col) break;
    for (const key of ["left", "right", "up", "down"] as const) {
      const n = move(p, key);
      if (n.col < 0 || n.col >= ROWS[n.row].length || seen.has(id(n))) continue;
      seen.set(id(n), { prev: id(p), key });
      queue.push(n);
    }
  }
  const out: ("up" | "down" | "left" | "right")[] = [];
  for (let at = id(to); seen.get(at);) {
    const s = seen.get(at)!;
    out.unshift(s.key);
    at = s.prev;
  }
  return out;
}

/* ---------- reading the screen ---------- */
const px = (d: Uint8Array, x: number, y: number) => (d[(y >> 3) * 128 + x] >> (y & 7)) & 1;
function filled(d: Uint8Array, x: number, y: number, w: number, h: number) {
  let n = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx < 128 && yy < 64) n += px(d, xx, yy);
  return n / (w * h);
}
/* Where a key's highlight (or its icon) sits. */
export function keyBox(row: number, col: number) {
  const key = ROWS[row][col];
  if (key.ch === BACKSPACE) return { x: ORIGIN_X + key.x, y: ORIGIN_Y + key.y, w: 16, h: 9 };
  if (key.ch === ENTER) return { x: ORIGIN_X + key.x, y: ORIGIN_Y + key.y, w: 24, h: 11 };
  return { x: ORIGIN_X + key.x - 1, y: ORIGIN_Y + key.y - 8, w: 7, h: 10 };
}

export function findSelected(d: Uint8Array): Pos | null {
  if (d.length !== 1024) return null;
  for (let x = 6; x < 122; x += 4) if (!px(d, x, 12) || !px(d, x, 26)) return null;
  const hits: Pos[] = [];
  ROWS.forEach((r, row) =>
    r.forEach((_, col) => {
      const b = keyBox(row, col);
      if (filled(d, b.x, b.y, b.w, b.h) > (b.w === 7 ? 0.6 : 0.5)) hits.push({ row, col });
    }),
  );
  return hits.length === 1 ? hits[0] : null;
}

/* ---------- what to press ---------- */
export interface Press {
  key: Key;
  type: InputType;
}
const tap = (key: Key): Press[] => [
  { key, type: "press" },
  { key, type: "short" },
  { key, type: "release" },
];
const hold = (key: Key): Press[] => [
  { key, type: "press" },
  { key, type: "long" },
  { key, type: "release" },
];

export const typeable = (text: string) => /^[A-Za-z0-9_ ]*$/.test(text);
export const untypeable = (text: string) => [...new Set(text.replace(/[A-Za-z0-9_ ]/g, ""))];

export function clearPresses(maxLength = 255): Press[] {
  return [
    { key: "back", type: "press" },
    { key: "back", type: "long" },
    ...Array.from({ length: maxLength }, () => ({ key: "back" as Key, type: "repeat" as InputType })),
    { key: "back", type: "release" },
  ];
}

export function typePresses(text: string, from: Pos): Press[] {
  return typeSteps(text, from).flatMap((s) => s.presses);
}

export function typeSteps(text: string, from: Pos): { presses: Press[]; at: Pos }[] {
  if (!typeable(text)) throw new Error(`can't type ${untypeable(text).join("")}`);
  const steps: { presses: Press[]; at: Pos }[] = [];
  let at = from;
  [...text].forEach((ch, i) => {
    const base = ch === " " ? "_" : ch.toLowerCase();
    let to: Pos | null = null;
    ROWS.forEach((r, row) => r.forEach((key, col) => key.ch === base && (to = { row, col })));
    if (!to) throw new Error(`no key for ${ch}`);
    const out: Press[] = [];
    for (const dir of route(at, to)) out.push(...tap(dir));
    at = to;
    const letter = /[a-z_]/.test(base);
    const upper = ch === " " || (ch !== "_" && ch !== ch.toLowerCase());
    const firstIsUpper = i === 0;
    out.push(...(letter && upper !== firstIsUpper ? hold("ok") : tap("ok")));
    steps.push({ presses: out, at });
  });
  return steps;
}

export interface KeyboardModel {
  pos: Pos;
  text: string;
  clearDefault: boolean;
}
const upperOf = (c: string) => (c === "_" ? " " : c >= "a" && c <= "z" ? c.toUpperCase() : c);
export function applyInput(m: KeyboardModel, key: Key, type: InputType): KeyboardModel {
  if (type === "short" || type === "long" || type === "repeat") {
    if (key === "up" || key === "down" || key === "left" || key === "right") return { ...m, pos: move(m.pos, key) };
  }
  if (key === "back" && (type === "long" || type === "repeat"))
    return { ...m, text: m.clearDefault ? "" : m.text.slice(0, -1) };
  if (key === "ok" && (type === "short" || type === "long")) {
    const ch = ROWS[m.pos.row][m.pos.col].ch;
    let toggle = m.text.length === 0 || m.clearDefault;
    if (type === "long") toggle = !toggle;
    if (ch === ENTER) return m;
    if (ch === BACKSPACE) return { ...m, text: m.clearDefault ? "" : m.text.slice(0, -1), clearDefault: false };
    const c = toggle ? upperOf(ch) : ch;
    return { ...m, text: (m.clearDefault ? "" : m.text) + c, clearDefault: false };
  }
  return m;
}

export function drawKeyboard(m: KeyboardModel): Uint8Array {
  const d = new Uint8Array(1024);
  const set = (x: number, y: number) => {
    if (x >= 0 && x < 128 && y >= 0 && y < 64) d[(y >> 3) * 128 + x] |= 1 << (y & 7);
  };
  for (let x = 2; x < 126; x++) {
    set(x, 12);
    set(x, 26);
  }
  for (let y = 13; y < 26; y++) {
    set(1, y);
    set(126, y);
  }
  const b = keyBox(m.pos.row, m.pos.col);
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) set(x, y);
  return d;
}
