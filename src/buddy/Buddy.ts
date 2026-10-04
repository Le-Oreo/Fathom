import frames from "../assets/dolphin-frames.json";
import sheetUrl from "../assets/dolphin-sheet.png";
import { onMotionChange, reduceMotion } from "../motion";
import { getPrefs, useSettings } from "../state/settings";
import { reactors, type BuddyEvent } from "./bus";

const BUDDIES: Buddy[] = [];
const STILLS = new Set<() => void>();
const ART = { img: new Image(), ok: false, at: {} as Record<string, [number, number]> };
frames.names.forEach((n, i) => {
  ART.at[n] = [(i % frames.cols) * frames.cell, Math.floor(i / frames.cols) * frames.cell];
});
ART.img.onload = () => {
  ART.ok = true;
  BUDDIES.forEach((b) => b.draw());
  STILLS.forEach((s) => s());
};
ART.img.src = sheetUrl;

const CELL = 64,
  HALF = 32;
const SWIM = ["base", "swim1", "swim2", "swim1", "base", "swim3", "swim4", "swim3"];
const COLORS = {
  bubble: "#40a8f5",
  bubbleFill: "rgba(64,168,245,.22)",
  shine: "#e2f6ff",
  pop: "#9fd6ff",
  sonar: "#ff9a33",
  heart: "#ff7a62",
  heartShine: "#ffd2c6",
  spark: "#ffd27a",
  streak: "#ffc78f",
};
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dith = (a: number, x: number, y: number) => a * 16 > BAYER[(y & 3) * 4 + (x & 3)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
type Pt = [number, number];
// prettier-ignore
const RING: Record<number, Pt[]> = {
  1: [[0, -1], [-1, 0], [1, 0], [0, 1]],
  2: [[-1, -2], [0, -2], [1, -2], [-2, -1], [2, -1], [-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 2], [0, 2], [1, 2]],
  3: [[-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0], [-3, 1], [3, 1], [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3]],
};
const RING_FILL: Record<number, Pt[]> = {};
for (const r of [1, 2, 3]) {
  RING_FILL[r] = [];
  for (let y = -r; y <= r; y++) {
    const xs = RING[r].filter((p) => p[1] === y).map((p) => p[0]);
    if (xs.length) for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x++) RING_FILL[r].push([x, y]);
  }
}
// prettier-ignore
const SHINE: Record<number, Pt[]> = { 1: [], 2: [[-1, -1]], 3: [[-1, -1], [-2, -1], [-1, -2]] };
const HEART = [".#.#.", "#####", "#####", ".###.", "..#.."];

const REACTIONS: Partial<Record<BuddyEvent, string[]>> = {
  hello: ["wave"],
  connected: ["wave"],
  screenshot: ["flip"],
  uploaded: ["bubbles"],
  downloaded: ["hop"],
  firmware: ["flip", "burst", "wave"],
  saved: ["wiggle"],
  backup: ["ring"],
  restored: ["boop"],
  find: ["lookaround", "ping"],
  scan: ["ping"],
  rpc: ["ping"],
  command: ["look"],
};
// prettier-ignore
const MOODS: Record<string, [string, number][]> = {
  ambient: [["swim", 24], ["idle", 13], ["bubbles", 8], ["wave", 7], ["flip", 6], ["roll", 6], ["ring", 5], ["hop", 5], ["dash", 4],
    ["ping", 4], ["look", 3], ["lookaround", 4], ["wiggle", 4], ["boop", 5], ["peek", 3]],
  search: [["ping", 36], ["swim", 26], ["idle", 10], ["lookaround", 10], ["look", 6], ["bubbles", 8], ["wave", 4]],
};
const SOFT = new Set(["idle", "swim", "look", "follow"]);

type Side = "left" | "right";
export interface Act {
  kind: string;
  t?: number;
  n?: number;
  next?: number;
  dur?: number;
  tx?: number;
  ty?: number;
  speed?: number;
  free?: boolean;
  from?: Side;
  to?: Side;
  back?: boolean;
  wait?: number;
  count?: number;
  react?: boolean;
  bub?: Fx;
  blown?: number;
  done?: number;
}
type Running = Act & { t: number; n: number; next: number };
interface Fx {
  k: string;
  x: number;
  y: number;
  age: number;
  life: number;
  r?: number;
  vy?: number;
  ph?: number;
  rx?: number;
  dir?: number;
  len?: number;
  held?: boolean;
}
export interface BuddyOptions {
  px?: number; // CSS px per sprite px, preferred
  minPx?: number;
  needW?: number; // sprite px of room wanted
  needH?: number;
  mood?: "ambient" | "search" | "show";
  script?: Act[]; // actions to run first
  react?: boolean; // follows app events
  interactive?: boolean; // pointer + click
  sizable?: boolean; // follows the Size setting
  peek?: "left" | "right" | "any"; // which side it may swim off and come back from
  onDone?: () => void; // a script that ends in "exit" is over
}

export class Buddy {
  private o: Required<Omit<BuddyOptions, "onDone">> & Pick<BuddyOptions, "onDone">;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private off: (() => void)[] = [];
  W = 0;
  H = 0;
  k = 1;
  css = 1;
  x = 0;
  y = 0;
  dy = 0;
  vx = 0;
  vy = 0;
  face = 1;
  frame = "base";
  t = 0;
  tail = 0;
  bob = 0;
  act: Running | null = null;
  queue: Act[];
  fx: Fx[] = [];
  rest = 0.25;
  pointer: { x: number; y: number } | null = null;
  placed = false;
  gone = false;
  lastPing = -99;
  last = "";

  constructor(
    readonly host: HTMLElement,
    opts: BuddyOptions = {},
  ) {
    this.o = {
      px: 3,
      minPx: 2,
      needW: 64,
      needH: 50,
      mood: "ambient",
      script: [],
      react: false,
      interactive: true,
      sizable: false,
      peek: "any",
      ...opts,
    };
    this.queue = this.o.script.map((a) => ({ ...a }));
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    host.classList.add("buddy");
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    if (this.o.interactive) {
      const move = (e: PointerEvent) => this.onPointer(e),
        leave = () => (this.pointer = null),
        click = (e: MouseEvent) => this.onClick(e);
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerleave", leave);
      host.addEventListener("click", click);
      this.off.push(() => {
        host.removeEventListener("pointermove", move);
        host.removeEventListener("pointerleave", leave);
        host.removeEventListener("click", click);
      });
    }
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.host.isConnected && this.resize()));
    this.ro.observe(host);
    BUDDIES.push(this);
    reactors.add(this);
    startLoop();
    this.resize();
    if (reduceMotion()) this.settle();
  }

  settle() {
    if (!reduceMotion()) return;
    Object.assign(this, {
      act: null,
      queue: [],
      fx: [],
      dy: 0,
      bob: 0,
      gone: false,
      frame: "base",
      vx: 0,
      vy: 0,
      pointer: null,
    });
    if (this.W) {
      this.x = Math.round(this.W / 2);
      this.y = Math.round(this.H / 2) + 1;
    }
    this.draw();
  }
  destroy() {
    this.ro.disconnect();
    this.off.forEach((f) => f());
    BUDDIES.splice(BUDDIES.indexOf(this), 1);
    reactors.delete(this);
    this.canvas.remove();
  }

  resize() {
    const r = this.host.getBoundingClientRect(),
      dpr = window.devicePixelRatio || 1;
    const grow = this.o.sizable ? ({ s: -1, m: 0, l: 1 }[getPrefs().dolphinSize] ?? 0) : 0;
    const top = this.o.px + grow,
      low = Math.max(1, Math.min(this.o.minPx, top)),
      needW = grow > 0 ? 64 : this.o.needW;
    let best = null,
      fallback = null;
    for (let px = top; px >= low; px--) {
      const k = Math.max(1, Math.round(px * dpr)),
        css = k / dpr,
        W = Math.floor(r.width / css),
        H = Math.floor(r.height / css);
      if (W >= 64 && H >= 46) fallback ||= { k, css, W, H };
      if (W >= needW && H >= this.o.needH) {
        best = { k, css, W, H };
        break;
      }
    }
    const pick = best || fallback;
    this.host.classList.toggle("tight", !pick);
    if (!pick) {
      this.W = 0;
      return;
    }
    const first = !this.W;
    Object.assign(this, pick);
    this.canvas.width = this.W * this.k;
    this.canvas.height = this.H * this.k;
    this.canvas.style.width = `${this.W * this.css}px`;
    this.canvas.style.height = `${this.H * this.css}px`;
    if (!this.placed || this.t === 0) {
      this.x = Math.round(this.W / 2);
      this.y = Math.round(this.H / 2) + 1;
      this.placed = true;
    }
    if (!first && !this.act?.free) this.clamp();
    this.draw();
  }
  bounds() {
    const W = this.W,
      H = this.H;
    return {
      x0: Math.min(31, W / 2),
      x1: Math.max(W - 31, W / 2),
      y0: Math.min(22, H / 2),
      y1: Math.max(H - 20, H / 2),
    };
  }
  clamp() {
    const b = this.bounds();
    this.x = Math.max(b.x0, Math.min(b.x1, this.x));
    this.y = Math.max(b.y0, Math.min(b.y1, this.y));
  }
  visible() {
    return this.W > 0 && this.host.isConnected && this.host.offsetParent !== null;
  }

  /* ---------- asking it to do things ---------- */
  do(kind: string, extra: Partial<Act> = {}) {
    if (reduceMotion()) return;
    this.queue.push({ kind, ...extra });
    if (!this.act || SOFT.has(this.act.kind)) {
      this.act = null;
      this.rest = 0;
    }
  }
  react(kind: BuddyEvent) {
    const p = getPrefs(),
      list = REACTIONS[kind];
    if (reduceMotion() || !this.o.react || !p.dolphinReact || !list) return;
    if (kind === "rpc") {
      if ((this.act && !SOFT.has(this.act.kind)) || this.queue.length || this.t - this.lastPing < 16) return;
      this.lastPing = this.t;
    }
    this.queue = this.queue.filter((q) => !q.react);
    list.forEach((k) => this.queue.push({ kind: k, react: true }));
    if (!this.act || SOFT.has(this.act.kind)) {
      this.act = null;
      this.rest = 0;
    }
  }
  private onPointer(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    this.pointer = { x: (e.clientX - r.left) / this.css, y: (e.clientY - r.top) / this.css };
  }
  private onClick(e: MouseEvent) {
    if (reduceMotion() || !this.W || !getPrefs().dolphinTricks) return;
    this.onPointer(e);
    if (this.gone) return;
    this.hearts(2, this.pointer);
    const tricks = ["flip", "roll", "wave", "hop", "ring", "bubbles", "dash", "wiggle", "boop"].filter(
      (k) => k !== this.last,
    );
    this.queue = [{ kind: tricks[Math.floor(Math.random() * tricks.length)], react: true }];
    this.act = null;
    this.rest = 0;
  }
  private pick(): Act {
    if (this.o.mood === "show") return { kind: "idle" };
    const table = MOODS[this.o.mood] || MOODS.ambient,
      fun = { calm: 0.4, normal: 1, playful: 1.9 }[getPrefs().dolphinMood] ?? 1;
    let total = 0;
    const opts = table
      .filter(([k]) => !(k === this.last && !SOFT.has(k)))
      .map(([k, w]): [string, number] => [k, SOFT.has(k) || k === "ping" ? w : w * fun]);
    opts.forEach(([, w]) => (total += w));
    let r = Math.random() * total;
    for (const [k, w] of opts) if ((r -= w) <= 0) return { kind: k };
    return { kind: "idle" };
  }

  /* ---------- actions ---------- */
  private start(next: Act) {
    let a = next;
    const b = this.bounds();
    if (a.kind === "flip" && this.H < 70) a.kind = "hop";
    if (a.kind === "dash" && this.W < 110) a.kind = "swim";
    if (this.gone && a.kind !== "enter" && a.kind !== "exit") {
      /* off-stage: come back before doing anything */
      this.queue.unshift(a);
      a = { kind: "enter", from: this.x < this.W / 2 ? "left" : "right", speed: 30 };
    }
    if (a.kind === "peek") {
      const side: Side = this.o.peek === "any" ? (this.x < this.W / 2 ? "left" : "right") : this.o.peek;
      a = { kind: "exit", to: side, back: true, speed: 30 };
    }
    const A: Running = { t: 0, n: 0, next: 0, ...a };
    this.act = A;
    this.dy = 0;
    switch (A.kind) {
      case "swim": {
        if (A.tx === undefined) {
          let tries = 0;
          do {
            A.tx = rand(b.x0, b.x1);
            A.ty = rand(b.y0, b.y1);
          } while (Math.hypot(A.tx - this.x, (A.ty ?? 0) - this.y) < 10 && ++tries < 6);
        }
        A.speed ||= rand(12, 19);
        if (Math.abs(A.tx - this.x) > 3) this.face = A.tx > this.x ? 1 : -1;
        break;
      }
      case "dash":
        A.tx = this.x < this.W / 2 ? b.x1 : b.x0;
        A.ty = Math.max(b.y0, Math.min(b.y1, this.y + rand(-6, 6)));
        A.speed = 62;
        this.face = A.tx > this.x ? 1 : -1;
        break;
      case "idle":
        A.dur ||= rand(1, 2.6);
        break;
      case "look":
        A.dur ||= rand(0.9, 1.6);
        break;
      case "lookaround":
        A.next = 0.4;
        break;
      case "boop":
        A.ty = Math.max(this.y, b.y0 + Math.min(18, (b.y1 - b.y0) * 0.6));
        break;
      case "wave":
        A.dur ||= 1.5;
        break;
      case "bubbles":
        A.count ||= 3 + Math.floor(Math.random() * 3);
        A.dur = A.count * 0.32 + 1.3;
        A.next = 0.45;
        A.ty = b.y1;
        break;
      case "ring":
        A.ty = b.y1;
        break;
      case "ping":
        A.next = 0.25;
        break;
      case "flip":
        A.ty = Math.min(Math.max(this.y, 39), this.H - 31); /* room for the spin and its little hop */
        break;
      case "enter":
        A.free = true;
        this.x = A.from === "right" ? this.W + 34 : -34;
        this.y = A.ty ?? Math.round(this.H / 2);
        A.tx ??= Math.round(this.W / 2);
        A.ty ??= this.y;
        A.speed ||= A.dur ? (Math.abs(A.tx - this.x) / A.dur) * 1.3 : 36;
        this.face = A.from === "right" ? -1 : 1;
        this.gone = !!A.wait;
        break;
      case "exit":
        A.free = true;
        A.tx = A.to === "left" ? -40 : this.W + 40;
        A.ty = this.y;
        A.speed ||= 44;
        this.face = A.to === "left" ? -1 : 1;
        break;
    }
    this.last = A.kind;
  }
  private finish() {
    const done = this.act;
    this.act = null;
    this.dy = 0;
    this.rest = this.queue.length
      ? 0.05
      : rand(0.35, 1.2) * ({ calm: 2.4, normal: 1, playful: 0.45 }[getPrefs().dolphinMood] ?? 1);
    if (done && done.kind === "exit") {
      this.gone = true;
      if (done.back) this.queue.unshift({ kind: "enter", from: done.to, wait: rand(0.9, 1.8), speed: 26 });
      else this.o.onDone?.();
    }
  }
  private steer(tx: number, ty: number, speed: number, dt: number) {
    const dx = tx - this.x,
      dy = ty - this.y,
      d = Math.hypot(dx, dy);
    if (d < 1.5) return true;
    const s = Math.min(speed, 3 + d * 2.4),
      ease = 1 - Math.pow(0.004, dt);
    this.vx += ((dx / d) * s - this.vx) * ease;
    this.vy += ((dy / d) * s * 0.75 - this.vy) * ease;
    return false;
  }

  step(dt: number) {
    const p = getPrefs();
    this.t += dt;
    this.stepFx(dt);
    if (
      this.pointer &&
      p.dolphinFollow &&
      !this.gone &&
      (!this.act || ["idle", "swim", "look"].includes(this.act.kind)) &&
      !this.queue.length
    )
      this.act = { kind: "follow", t: 0, n: 0, next: 0 };
    if (!this.act) {
      this.rest -= dt;
      if (this.rest <= 0) this.start(this.queue.shift() || this.pick());
    }
    const A = this.act;
    let fps = 3,
      frame: string | null = null,
      bob = true,
      slow = true;
    if (A) {
      A.t += dt;
      const tx = A.tx ?? this.x,
        ty = A.ty ?? this.y,
        speed = A.speed ?? 20;
      switch (A.kind) {
        case "idle":
          if (A.t > (A.dur ?? 0)) this.finish();
          break;
        case "look":
          frame = "curious";
          if (A.t > (A.dur ?? 0)) this.finish();
          break;
        case "swim":
          fps = 8;
          slow = false;
          if (this.steer(tx, ty, speed, dt) || A.t > 7) this.finish();
          break;
        case "follow": {
          if (!this.pointer || !p.dolphinFollow) {
            this.finish();
            break;
          }
          const b = this.bounds(),
            px = this.pointer.x,
            fx = Math.max(b.x0, Math.min(b.x1, px - this.face * 26)),
            fy = Math.max(b.y0, Math.min(b.y1, this.pointer.y));
          const near = this.steer(fx, fy, 22, dt);
          slow = near;
          fps = near ? 3 : 8;
          if (Math.abs(px - this.x) > 10) this.face = px > this.x ? 1 : -1;
          if (near || Math.hypot(fx - this.x, fy - this.y) < 6)
            frame = Math.abs(px - (this.x + this.face * 26)) < 8 ? "reach" : "curious";
          break;
        }
        case "dash":
          fps = 16;
          slow = false;
          if (A.t > A.next) {
            A.next = A.t + 0.035;
            this.fx.push({
              k: "streak",
              x: this.x - this.face * rand(26, 32),
              y: Math.round(this.y + rand(-6, 6)),
              len: Math.round(rand(3, 7)),
              dir: this.face,
              age: 0,
              life: 0.3,
            });
          }
          if (this.steer(tx, ty, speed, dt) || A.t > 3) this.finish();
          break;
        case "enter":
          if (A.wait && A.t < A.wait) break;
          this.gone = false;
          fps = 9;
          slow = false;
          if (this.steer(tx, ty, speed, dt) || A.t > 6 + (A.wait || 0)) this.finish();
          break;
        case "exit":
          fps = 10;
          slow = false;
          this.steer(tx, ty, speed, dt);
          if (this.x > this.W + 34 || this.x < -34 || A.t > 6) this.finish();
          break;
        case "wave":
          fps = 0;
          frame = A.t < 0.12 ? "wave1" : Math.floor((A.t - 0.12) / 0.15) % 2 ? "wave1" : "wave2";
          if (A.t > (A.dur ?? 0)) this.finish();
          break;
        case "bubbles":
          fps = 2.5;
          if (A.t < 0.4) this.y += (ty - this.y) * Math.min(1, dt * 8);
          if (A.t > A.next && A.n < (A.count ?? 0)) {
            A.n++;
            A.next = A.t + rand(0.26, 0.4);
            this.bubble();
          }
          if (A.t > (A.dur ?? 0)) this.finish();
          break;
        case "burst":
          if (!A.n) {
            A.n = 1;
            for (let i = 0; i < 6; i++) this.bubble(rand(-22, 22), rand(-6, 10));
            this.sparks(4);
          }
          if (A.t > 0.7) this.finish();
          break;
        case "ring":
          fps = 2;
          frame = A.t > 0.3 && A.t < 0.55 ? "swim1" : null;
          if (A.t < 0.4) this.y += (ty - this.y) * Math.min(1, dt * 8);
          if (!A.n && A.t > 0.55) {
            A.n = 1;
            const [bx, by] = this.blowhole();
            this.fx.push({ k: "ring", x: bx, y: by - 2, rx: 2, vy: -6, age: 0, life: 3 });
          }
          if (A.t > 2.3) this.finish();
          break;
        case "ping":
          fps = 2;
          frame = "curious";
          if (A.t > A.next && A.n < 3) {
            A.n++;
            A.next = A.t + 0.5;
            this.fx.push({
              k: "arc",
              x: Math.round(this.x + this.face * 30),
              y: Math.round(this.y + this.dy - 1),
              r: 2,
              dir: this.face,
              age: 0,
              life: 1.3,
            });
          }
          if (A.t > 2.1) this.finish();
          break;
        case "wiggle":
          fps = 16;
          bob = false;
          this.dy = -Math.round(Math.abs(Math.sin(A.t * 13)) * 2);
          if (A.t > 1) this.finish();
          break;
        case "lookaround":
          frame = "curious";
          if (A.t > A.next && A.n < 2) {
            A.n++;
            A.next = A.t + 0.5;
            this.face *= -1;
          }
          if (A.t > 1.55) this.finish();
          break;
        case "boop": {
          if (A.t < 0.35) {
            this.y += (ty - this.y) * Math.min(1, dt * 8);
            break;
          }
          if (!A.bub) {
            A.bub = {
              k: "bub",
              x: Math.round(this.x + this.face * 33),
              y: Math.round(this.y + this.dy - 3),
              r: 3,
              vy: -4.5,
              ph: 0,
              age: 0,
              life: 6,
              held: true,
            };
            this.fx.push(A.bub);
            A.blown = A.t;
          }
          if (A.t - (A.blown ?? 0) < 0.6) {
            frame = "curious";
            break;
          }
          fps = 9;
          slow = false;
          const bub = A.bub,
            b = this.bounds(),
            gx = Math.max(b.x0, Math.min(b.x1, bub.x - this.face * 31)),
            gy = Math.max(b.y0, Math.min(b.y1, bub.y + 3));
          this.steer(gx, gy, 24, dt);
          if (bub.k !== "bub" || Math.hypot(bub.x - (this.x + this.face * 31), bub.y - (this.y - 3)) < 4 || A.t > 4) {
            if (bub.k === "bub") {
              bub.k = "pop";
              bub.age = 0;
              bub.life = 0.25;
              this.sparks(2, -4);
            }
            frame = "reach";
            A.done ||= A.t;
          }
          if (A.done && A.t - A.done > 0.35) this.finish();
          break;
        }
        case "hop": {
          bob = false;
          const u = (A.t % 0.42) / 0.42;
          this.dy = -Math.round(Math.sin(Math.PI * u) * 6);
          frame = this.dy < -1 ? "swim2" : "base";
          if (A.t > 0.84) this.finish();
          break;
        }
        case "flip": {
          bob = false;
          const prep = 0.22,
            spin = 0.07 * 7;
          if (A.t < prep) {
            this.y += (ty - this.y) * Math.min(1, dt * 14);
            frame = "swim3";
          } else if (A.t < prep + spin) {
            const u = (A.t - prep) / spin;
            frame = `spin${Math.min(7, 1 + Math.floor(u * 7))}`;
            this.dy = -Math.round(Math.sin(Math.PI * u) * 8);
          } else {
            this.dy = 0;
            frame = "swim1";
            if (!A.n) {
              A.n = 1;
              this.sparks(3, -22);
            }
            if (A.t > prep + spin + 0.2) this.finish();
          }
          break;
        }
        case "roll": {
          bob = false;
          // prettier-ignore
          const seq: [string, number][] = [["roll1", 0.07], ["roll2", 0.06], ["roll3", 0.06], ["roll4", 0.07], ["roll5", 0.55], ["roll4", 0.07], ["roll3", 0.06], ["roll2", 0.06], ["roll1", 0.07]];
          let t = A.t,
            f: string | null = null;
          for (const [name, d] of seq) {
            if (t < d) {
              f = name;
              break;
            }
            t -= d;
          }
          this.vx = this.face * 5;
          slow = false;
          if (!f) this.finish();
          else frame = f;
          break;
        }
      }
    }
    if (slow) {
      const f = Math.pow(0.08, dt);
      this.vx *= f;
      this.vy *= f;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (!this.act?.free) this.clamp();
    this.tail += dt * fps;
    this.frame = frame || SWIM[Math.floor(this.tail) % SWIM.length];
    this.bob = bob ? Math.round(Math.sin(this.t * 2.1) * 1.1) : 0;
  }

  /* ---------- effects ---------- */
  private blowhole(): Pt {
    return [Math.round(this.x + (this.face > 0 ? 3 : -4)), Math.round(this.y + this.dy + this.bob - 17)];
  }
  private bubble(ox = 0, oy = 0) {
    const [bx, by] = this.blowhole();
    this.fx.push({
      k: "bub",
      x: bx + ox,
      y: by + oy,
      r: 1 + Math.floor(Math.random() * 3),
      vy: -rand(8, 14),
      ph: rand(0, 6),
      age: 0,
      life: rand(2.5, 4),
    });
  }
  private hearts(n: number, at: { x: number; y: number } | null) {
    const hx = at ? at.x : this.x + this.face * 10,
      hy = at ? at.y : this.y - 20;
    for (let i = 0; i < n; i++)
      this.fx.push({
        k: "heart",
        x: Math.round(hx - 2 + rand(-4, 4)),
        y: Math.round(hy - 4 - i * 3),
        vy: -rand(16, 22),
        age: -i * 0.14,
        life: 1.1,
      });
  }
  private sparks(n: number, oy = 0) {
    for (let i = 0; i < n; i++)
      this.fx.push({
        k: "spark",
        x: Math.round(this.x + rand(-24, 24)),
        y: Math.round(this.y + oy + rand(-10, 6)),
        age: -i * 0.08,
        life: 0.6,
      });
  }
  private stepFx(dt: number) {
    for (const f of this.fx) {
      f.age += dt;
      if (f.age < 0) continue;
      if (f.k === "bub") {
        f.y += (f.vy ?? 0) * dt;
        if (f.y < (f.r ?? 1) - 1 || f.age > f.life) {
          f.k = "pop";
          f.age = 0;
          f.life = 0.18;
        }
      } else if (f.k === "ring") {
        f.y += (f.vy ?? 0) * dt;
        f.rx = 2 + Math.min(9, f.age * 4);
      } else if (f.k === "arc") f.r = 2 + f.age * 20;
      else if (f.k === "heart") f.y += (f.vy ?? 0) * dt;
      else if (f.k === "streak") f.x -= (f.dir ?? 1) * 10 * dt;
    }
    this.fx = this.fx.filter((f) => f.age < f.life);
  }

  /* ---------- drawing ---------- */
  draw() {
    const { ctx, k } = this;
    if (!this.W) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (const f of this.fx) if (f.k === "streak") this.drawFx(f);
    if (ART.ok && !this.gone) {
      const [sx, sy] = ART.at[this.frame] || ART.at.base;
      const cx = Math.round(this.x),
        cy = Math.round(this.y + this.dy + (this.bob || 0));
      if (this.face < 0) {
        ctx.save();
        ctx.translate(cx, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(ART.img, sx, sy, CELL, CELL, -HALF, cy - HALF, CELL, CELL);
        ctx.restore();
      } else ctx.drawImage(ART.img, sx, sy, CELL, CELL, cx - HALF, cy - HALF, CELL, CELL);
    }
    for (const f of this.fx) if (f.k !== "streak") this.drawFx(f);
  }
  private drawFx(f: Fx) {
    if (f.age < 0) return;
    const ctx = this.ctx,
      a = 1 - f.age / f.life;
    const dot = (x: number, y: number, c: string, alpha = 1) => {
      if (alpha >= 1 || dith(alpha, x, y)) {
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    };
    if (f.k === "bub") {
      const r = f.r ?? 1,
        x = Math.round(f.x + Math.sin(f.age * 4 + (f.ph ?? 0)) * 1.2),
        y = Math.round(f.y),
        fade = Math.min(1, a * 3, (y - r) / 6);
      ctx.fillStyle = COLORS.bubbleFill;
      for (const [i, j] of RING_FILL[r]) ctx.fillRect(x + i, y + j, 1, 1);
      for (const [i, j] of RING[r]) dot(x + i, y + j, COLORS.bubble, fade);
      for (const [i, j] of SHINE[r]) dot(x + i, y + j, COLORS.shine, fade);
    } else if (f.k === "pop") {
      const x = Math.round(f.x),
        y = Math.round(f.y);
      for (const [i, j] of [
        [-2, -2],
        [2, -2],
        [-2, 2],
        [2, 2],
        [0, -3],
      ])
        dot(x + i, y + j, COLORS.pop);
    } else if (f.k === "ring") {
      const rx = f.rx ?? 2,
        ry = Math.max(1, Math.round(rx * 0.32)),
        x = Math.round(f.x),
        y = Math.round(f.y),
        fade = Math.min(1, a * 2.5),
        seen = new Set<number>();
      for (let t = 0; t < Math.PI * 2; t += 0.5 / rx) {
        const px = Math.round(x + Math.cos(t) * rx),
          py = Math.round(y + Math.sin(t) * ry),
          key = px * 997 + py;
        if (!seen.has(key)) {
          seen.add(key);
          dot(px, py, COLORS.bubble, fade);
        }
      }
      dot(Math.round(x - rx * 0.55), y - ry, COLORS.shine, fade);
    } else if (f.k === "arc") {
      const r = f.r ?? 2,
        dir = f.dir ?? 1,
        seen = new Set<number>(),
        fade = Math.min(1, a * 1.6);
      for (let t = -0.72; t <= 0.72; t += 0.6 / r) {
        const px = Math.round(f.x + Math.cos(t) * r * dir),
          py = Math.round(f.y + Math.sin(t) * r),
          key = px * 997 + py;
        if (!seen.has(key)) {
          seen.add(key);
          dot(px, py, COLORS.sonar, fade);
        }
      }
    } else if (f.k === "heart") {
      const x = Math.round(f.x),
        y = Math.round(f.y),
        fade = Math.min(1, a * 2.2);
      HEART.forEach((row, j) => {
        for (let i = 0; i < row.length; i++)
          if (row[i] === "#") dot(x + i, y + j, i === 1 && j === 1 ? COLORS.heartShine : COLORS.heart, fade);
      });
    } else if (f.k === "spark") {
      dot(f.x, f.y, COLORS.spark);
      if (a > 0.45)
        for (const [i, j] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          dot(f.x + i, f.y + j, COLORS.spark);
    } else if (f.k === "streak") {
      const len = f.len ?? 3,
        dir = f.dir ?? 1;
      for (let i = 0; i < len; i++) dot(Math.round(f.x - dir * i), f.y, COLORS.streak, a * (1 - i / len));
    }
  }
}

let running = false;
function startLoop() {
  if (running) return;
  running = true;
  let last = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    if (!document.hidden && !reduceMotion())
      for (const b of BUDDIES.slice())
        if (b.visible()) {
          b.step(dt);
          b.draw();
        }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener("resize", () => BUDDIES.forEach((b) => b.resize()));
  onMotionChange(() => BUDDIES.forEach((b) => b.settle()));
  useSettings.subscribe((s, old) => {
    if (s.prefs.dolphinSize !== old.prefs.dolphinSize || s.prefs.dolphin !== old.prefs.dolphin)
      requestAnimationFrame(() => BUDDIES.forEach((b) => b.resize()));
  });
}

export function paintStill(c: HTMLCanvasElement, name = "base", px = 1) {
  const box = (frames.boxes as Record<string, number[]>)[name] ?? frames.boxes.base;
  const [x0, y0, x1, y1] = box;
  const paint = () => {
    const dpr = window.devicePixelRatio || 1,
      k = Math.max(1, Math.round(px * dpr)),
      w = x1 - x0,
      h = y1 - y0;
    c.width = w * k;
    c.height = h * k;
    c.style.width = `${(w * k) / dpr}px`;
    c.style.height = `${(h * k) / dpr}px`;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    if (ART.ok) {
      const [sx, sy] = ART.at[name];
      ctx.drawImage(ART.img, sx + x0, sy + y0, w, h, 0, 0, w * k, h * k);
    }
  };
  paint();
  STILLS.add(paint);
  return () => void STILLS.delete(paint);
}

export function party(panel: HTMLElement | null) {
  if (reduceMotion() || !panel || !getPrefs().dolphin) return;
  panel.querySelector(".buddy-party")?.remove();
  const host = document.createElement("div");
  host.className = "buddy-party";
  panel.appendChild(host);
  const end = () => {
    if (!host.isConnected) return;
    b.destroy();
    host.remove();
  };
  const b = new Buddy(host, {
    px: 3,
    minPx: 2,
    needW: 110,
    needH: 72,
    mood: "show",
    interactive: false,
    script: [{ kind: "enter", from: "left" }, { kind: "flip" }, { kind: "ring" }, { kind: "wave" }, { kind: "exit" }],
    onDone: end,
  });
  setTimeout(end, 12000);
}

export const buddyInfo = () =>
  BUDDIES.map((b) => ({
    id: b.host.id,
    W: b.W,
    H: b.H,
    k: b.k,
    css: b.css,
    tight: b.host.classList.contains("tight"),
    act: b.act?.kind ?? null,
    frame: b.frame,
  }));
