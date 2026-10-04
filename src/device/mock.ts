import { LIBRARY_CATEGORIES } from "../catalog";
import { bytesOf, dateValue, fmtSize, isTextName, isUnder, parentOf } from "../files/logic";
import { clockOf } from "../clock";
import { SCREENS } from "../frames";
import { applyInput, drawKeyboard, type KeyboardModel } from "../keyboard";
import { downloadBlob } from "../platform";
import { WAVE } from "../wave";
import {
  DeviceError,
  type BackupList,
  type BackupRecord,
  type Channel,
  type CliLink,
  type ConnectionState,
  type DeviceApi,
  type DeviceErrorCode,
  type DeviceInfo,
  type FileEntry,
  type FlipperClock,
  type ForkRelease,
  type FirmwareRelease,
  type InputType,
  type InstallProgress,
  type PortInfo,
  type Key,
  type LibraryItem,
  type RpcLogEntry,
  type ScreenFrame,
  type ScreenStream,
  type StorageInfo,
  type SyncLink,
  type SyncPlan,
  type TransferOptions,
  type UploadResult,
  type UploadSource,
} from "./api";
import {
  MOCK_BACKUP_DATE,
  MOCK_CLI,
  MOCK_DEVICE,
  MOCK_FILES,
  MOCK_LIBRARY,
  MOCK_RELEASES,
  mockChangelog,
} from "./mock-data";

const GB = 1073741824;
const APP_FRAMES: Record<string, number> = {
  "Sub-GHz": 0,
  "125 kHz RFID": 1,
  NFC: 2,
  Infrared: 3,
  GPIO: 4,
  iButton: 5,
  "Bad USB": 6,
  U2F: 7,
  Apps: 8,
  Settings: 9,
};

const enc = new TextEncoder();
const placeholder = (name: string) =>
  enc.encode(`Placeholder text for ${name}.\nThe mock Flipper doesn't keep real file contents.\n`);

type StreamRec = { onFrame: (f: ScreenFrame) => void; fps: number };

export class MockFlipper implements DeviceApi {
  private files = new Map<string, FileEntry[]>();
  private contents = new Map<string, Uint8Array>();
  private meta = new Map(Object.entries(MOCK_LIBRARY));
  private conn: ConnectionState;
  private plugged = true;
  private rebooting = false;
  private others: PortInfo[] = [];
  private failWith: DeviceErrorCode | null = null;
  private name = MOCK_DEVICE.name;
  private noSd = false;
  private portId = MOCK_DEVICE.port;
  private missing = new Set<string>();
  private firmwareVersion = MOCK_DEVICE.firmware;
  /* which firmware the pretend Flipper runs */
  private origin = { fork: "Official", origin: "https://github.com/flipperdevices/flipperzero-firmware" };
  private get otherFirmware() {
    return this.origin.fork !== "Official";
  }
  private setOrigin(channel: string) {
    this.origin = channel.startsWith("gh:")
      ? {
          fork: channel.toLowerCase().includes("momentum") ? "Momentum" : "Unleashed",
          origin: `https://github.com/${channel.slice(3)}`,
        }
      : { fork: "Official", origin: "https://github.com/flipperdevices/flipperzero-firmware" };
  }
  /* for tests: the pretend Flipper on Momentum */
  setOtherFirmware(on: boolean) {
    this.setOrigin(on ? "gh:Next-Flip/Momentum-Firmware" : "release");
    this.firmwareVersion = on ? "mntm-008" : MOCK_DEVICE.firmware;
    if (this.conn.status === "connected") this.setConn({ ...this.conn, info: this.info() });
  }
  private firmwareOrigin() {
    return this.origin;
  }
  private installing = false;
  private backups: BackupRecord[];
  private sdCopy: number | null = null;
  private clockOffset = -83_000;
  private copiedUpdate: string | null = null;
  private connFns = new Set<(s: ConnectionState) => void>();
  private logFns = new Set<(e: RpcLogEntry) => void>();
  private streams = new Set<StreamRec>();
  private ticker = 0;
  private flipper = { mode: "app" as "menu" | "app" | "update" | "keyboard", sel: 0, offset: 0, update: 0 };
  private kb: KeyboardModel = { pos: { row: 0, col: 0 }, text: "", clearDefault: false };
  showKeyboard(text: string) {
    this.kb = { pos: text ? { row: 2, col: 8 } : { row: 0, col: 0 }, text, clearDefault: !!text };
    this.flipper.mode = "keyboard";
    this.emit();
  }
  keyboardText() {
    return this.kb.text;
  }

  constructor() {
    const now = new Date();
    for (const [dir, list] of Object.entries(MOCK_FILES))
      this.files.set(
        dir,
        list.map((f) => ({
          name: f.name,
          dir: !!f.dir,
          size: f.dir ? 0 : bytesOf(f.size ?? ""),
          modified: dateValue(f.date, now),
        })),
      );
    this.backups = [{ id: "mock-backup-1", created: dateValue(MOCK_BACKUP_DATE, now), sd: false, size: 18_432 }];
    this.conn = { status: "disconnected", ports: this.ports() };
  }

  /* ---------- helpers ---------- */
  private rpc(name: string, detail = "", inbound = false) {
    const e: RpcLogEntry = { dir: inbound ? "in" : "out", name, detail };
    this.logFns.forEach((fn) => fn(e));
  }
  private ports(): PortInfo[] {
    const own = this.plugged && !this.rebooting ? [{ id: MOCK_DEVICE.port, name: MOCK_DEVICE.name }] : [];
    const air =
      this.bluetooth && !this.plugged && !this.rebooting
        ? [{ id: `ble:${MOCK_DEVICE.name}`, name: MOCK_DEVICE.name }]
        : [];
    return [...own, ...this.others, ...air];
  }
  private bluetooth = false;
  private get overAir() {
    return this.portId.startsWith("ble:");
  }
  private info(): DeviceInfo {
    const d = MOCK_DEVICE;
    return {
      name: this.name,
      model: d.model,
      hardware: d.hardware,
      region: d.region,
      firmware: this.firmwareVersion,
      branch: d.branch,
      target: d.target,
      link: this.overAir ? "Bluetooth" : "USB-C",
      port: d.port,
      id: this.portId,
      ...this.firmwareOrigin(),
    };
  }
  private setConn(next: ConnectionState) {
    this.conn = next;
    if (next.status !== "connected") {
      this.endStreams();
      this.cliOut = null;
    }
    this.connFns.forEach((fn) => fn(next));
  }
  private need() {
    if (this.conn.status !== "connected") throw new DeviceError("disconnected");
    if (this.cliOut) throw new DeviceError("console-open");
  }
  private entry(path: string) {
    const dir = parentOf(path),
      name = path.slice(dir.length + 1);
    return { dir, name, list: this.files.get(dir), item: this.files.get(dir)?.find((f) => f.name === name) };
  }
  /* Something under `from` now lives under `to`. */
  private rekey(from: string, to: string) {
    const swap = (k: string) => to + k.slice(from.length);
    for (const m of [this.files, this.contents, this.meta] as Map<string, unknown>[])
      for (const k of [...m.keys()])
        if (isUnder(k, from)) {
          const v = m.get(k);
          m.delete(k);
          m.set(swap(k), v);
        }
  }
  private drop(path: string) {
    for (const m of [this.files, this.contents, this.meta] as Map<string, unknown>[])
      for (const k of [...m.keys()]) if (isUnder(k, path)) m.delete(k);
  }
  private async pace(total: number, opts?: TransferOptions) {
    if (!opts?.onProgress) return;
    let pct = 0;
    opts.onProgress({ done: 0, total });
    while (pct < 100) {
      await new Promise((r) => setTimeout(r, 240));
      if (opts.signal?.aborted) throw new DeviceError("cancelled");
      this.need();
      pct = Math.min(100, pct + 9 + Math.round(Math.random() * 12));
      opts.onProgress({ done: Math.round((total * pct) / 100), total });
    }
  }

  /* No SD card: everything under /ext says so. */
  private sd(path: string) {
    if (this.noSd && isUnder(path, "/ext")) throw new DeviceError("no-sd");
  }

  /* An older or newer firmware without this app. */
  dropApp(name: string) {
    this.missing.add(name);
  }
  /* Take the SD card out, or put it back. */
  setNoSd(on: boolean) {
    this.noSd = on;
  }
  unplug() {
    this.plugged = false;
    this.others = [];
    this.setConn({ status: "disconnected", ports: this.ports() });
  }
  plug(others: string[] = []) {
    this.plugged = true;
    this.others = others.map((name) => ({ id: `/dev/cu.usbmodemflip_${name}1`, name }));
    this.setConn(
      this.conn.status === "connected"
        ? { ...this.conn, ports: this.ports() }
        : { status: "disconnected", ports: this.ports() },
    );
  }
  failConnects(code: DeviceErrorCode | null) {
    this.failWith = code;
  }
  fileNames(path: string) {
    return (this.files.get(path) ?? []).map((f) => f.name);
  }
  hasPath(path: string) {
    return this.files.has(path);
  }

  /* ---------- DeviceApi ---------- */
  connection = {
    current: () => this.conn,
    subscribe: (fn: (s: ConnectionState) => void) => {
      this.connFns.add(fn);
      fn(this.conn);
      return () => void this.connFns.delete(fn);
    },
    connect: async (port?: string) => {
      if (this.conn.status === "connected") return;
      const ports = this.ports();
      if (!ports.length || (port && !ports.some((x) => x.id === port))) {
        this.setConn({ status: "disconnected", ports, error: "disconnected" });
        throw new DeviceError("disconnected");
      }
      /* several plugged in and no pick: the UI asks which */
      if (!port && ports.length > 1) throw new DeviceError("failed");
      if (this.failWith) {
        this.setConn({ status: "disconnected", ports, error: this.failWith });
        throw new DeviceError(this.failWith);
      }
      const pick = ports.find((x) => x.id === port) ?? ports[0];
      if (pick.id.startsWith("ble:")) this.rpc("bluetooth connect", pick.name);
      this.name = pick.name;
      this.portId = pick.id;
      this.rpc("start_rpc_session", pick.id);
      this.setConn({ status: "connected", ports, info: this.info(), current: pick.id });
    },
    setBluetooth: async (on: boolean) => {
      this.bluetooth = on;
      if (this.conn.status !== "connected") this.setConn({ status: "disconnected", ports: this.ports() });
    },
    switchTo: async (port: string) => {
      if (!this.ports().some((x) => x.id === port)) throw new DeviceError("disconnected");
      if (this.installing || this.cliOut) throw new DeviceError("busy");
      if (this.conn.status === "connected") {
        this.rpc("stop_session");
        this.setConn({ status: "disconnected", ports: this.ports() });
      }
      await this.connection.connect(port);
    },
  };

  device = {
    info: async () => {
      this.need();
      this.rpc("system_device_info_request");
      this.rpc("system_device_info_response", `${MOCK_DEVICE.name}, ${this.firmwareVersion}`, true);
      return this.info();
    },
    power: async () => {
      this.need();
      this.rpc("system_power_info_request");
      return { battery: MOCK_DEVICE.battery, charging: MOCK_DEVICE.charging };
    },
    reboot: async () => {
      this.need();
      this.rpc("system_reboot_request", "OS mode");
      this.rebooting = true;
      this.setConn({ status: "disconnected", ports: [] });
      await new Promise((r) => setTimeout(r, 2600));
      this.rebooting = false;
      if (this.plugged) this.setConn({ status: "disconnected", ports: this.ports() });
    },
    playAlert: async () => {
      this.need();
      this.rpc("system_play_audiovisual_alert_request");
    },
    getClock: async (): Promise<FlipperClock> => {
      this.need();
      this.rpc("system_get_datetime_request");
      return clockOf(new Date(Date.now() + this.clockOffset));
    },
    setClock: async (c: FlipperClock) => {
      this.need();
      const at = new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
      if (c.year < 2000 || c.year > 2099 || isNaN(at.getTime())) throw new DeviceError("failed");
      this.rpc("system_set_datetime_request", `${c.year}-${c.month}-${c.day} ${c.hour}:${c.minute}:${c.second}`);
      this.clockOffset = at.getTime() - Date.now();
    },
  };

  storage = {
    info: async (root: "/ext" | "/int"): Promise<StorageInfo | null> => {
      this.need();
      this.rpc("storage_info_request", root);
      const d = MOCK_DEVICE;
      if (root === "/ext" && this.noSd) return null;
      return root === "/ext"
        ? { used: d.sdUsed * GB, total: d.sdTotal * GB }
        : { used: d.intUsed * GB, total: d.intTotal * GB };
    },
    list: async (path: string) => {
      this.need();
      this.sd(path);
      this.rpc("storage_list_request", path);
      const list = this.files.get(path);
      if (!list) throw new DeviceError("not-found");
      return list.map((f) => ({ ...f }));
    },
    stat: async (path: string) => {
      this.need();
      this.sd(path);
      this.rpc("storage_stat_request", path);
      const { item } = this.entry(path);
      if (!item) throw new DeviceError("not-found");
      return { ...item };
    },
    read: async (path: string, opts?: TransferOptions) => {
      this.need();
      this.sd(path);
      this.rpc("storage_read_request", path);
      const { item, name } = this.entry(path);
      if (!item || item.dir) throw new DeviceError("not-found");
      await this.pace(item.size, opts);
      return this.contents.get(path) ?? (isTextName(name) ? placeholder(name) : new Uint8Array(item.size));
    },
    write: async (path: string, data: Uint8Array, opts?: TransferOptions) => {
      this.need();
      this.sd(path);
      const { dir, name } = this.entry(path);
      if (!this.files.has(dir)) throw new DeviceError("not-found");
      this.rpc("storage_write_request", opts?.onProgress ? path : `${path} (${fmtSize(data.length)})`);
      await this.pace(data.length, opts); /* nothing lands until the last part: a cancelled upload leaves no file */
      const list = this.files.get(dir);
      if (!list) throw new DeviceError("not-found");
      const f = list.find((x) => x.name === name);
      if (f?.dir) throw new DeviceError("exists");
      if (f) Object.assign(f, { size: data.length, modified: Date.now() });
      else list.push({ name, dir: false, size: data.length, modified: Date.now() });
      this.contents.set(path, data.slice());
    },
    mkdir: async (path: string) => {
      this.need();
      this.sd(path);
      this.rpc("storage_mkdir_request", path);
      const { list, item, name } = this.entry(path);
      if (!list) throw new DeviceError("not-found");
      if (item) throw new DeviceError("exists");
      list.push({ name, dir: true, size: 0, modified: Date.now() });
      this.files.set(path, []);
    },
    rename: async (from: string, to: string) => {
      this.need();
      this.sd(from);
      this.rpc("storage_rename_request", `${from} → ${to}`);
      const src = this.entry(from),
        dst = this.entry(to);
      if (!src.item || !src.list) throw new DeviceError("not-found");
      if (!dst.list) throw new DeviceError("not-found");
      if (dst.item) throw new DeviceError("exists");
      if (src.item.dir && isUnder(to, from)) throw new DeviceError("invalid-name");
      src.list.splice(src.list.indexOf(src.item), 1);
      dst.list.push({ ...src.item, name: dst.name });
      this.rekey(from, to);
    },
    remove: async (path: string, recursive: boolean) => {
      this.need();
      this.sd(path);
      const { list, item } = this.entry(path);
      this.rpc("storage_delete_request", item?.dir && recursive ? `${path} (and everything in it)` : path);
      if (!list || !item) throw new DeviceError("not-found");
      if (item.dir && !recursive && (this.files.get(path) ?? []).length) throw new DeviceError("not-empty");
      list.splice(list.indexOf(item), 1);
      this.drop(path);
    },
    md5: async (path: string) => {
      this.need();
      this.sd(path);
      this.rpc("storage_md5sum_request", path);
      const { item } = this.entry(path);
      if (!item || item.dir) throw new DeviceError("not-found");
      const data = this.contents.get(path) ?? enc.encode(`${path}:${item.size}`);
      let h = 0x811c9dc5;
      for (const b of data) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return h.toString(16).padStart(8, "0").repeat(4);
    },
    upload: async (source: UploadSource, toDir: string, opts?: TransferOptions): Promise<UploadResult> => {
      if (!("file" in source)) throw new DeviceError("failed", "the browser build uploads Files only");
      const data = new Uint8Array(await source.file.arrayBuffer());
      const path = `${toDir}/${source.file.name}`,
        here = this.contents.get(path);
      if (here && here.length === data.length && here.every((b, i) => b === data[i])) {
        this.need();
        this.rpc("storage_md5sum_request", path);
        opts?.onProgress?.({ done: data.length, total: data.length });
        return { name: source.file.name, files: 1, skipped: 1 };
      }
      await this.storage.write(path, data, opts);
      return { name: source.file.name, files: 1, skipped: 0 };
    },
    download: async (path: string, dir: boolean, folder: string, opts?: TransferOptions) => {
      this.need();
      this.sd(path);
      const name = path.slice(parentOf(path).length + 1);
      if (!dir) {
        const data = await this.storage.read(path, opts);
        if (folder === "browser") downloadBlob(name, new Blob([data as BlobPart]));
        return name;
      }
      if (!this.files.has(path)) throw new DeviceError("not-found");
      let total = 0;
      for (const [k, list] of this.files) if (isUnder(k, path)) for (const f of list) total += f.size;
      this.rpc("storage_list_request", `${path} (and everything in it)`);
      await this.pace(total, opts);
      return name;
    },
  };

  /* links per Flipper, by its id */
  private links: (SyncLink & { flipper: string })[] = [];
  private localFolder = new Map<string, string>([
    ["todo.txt", "Placeholder to-do list."],
    ["lists/shopping.txt", "Placeholder shopping list."],
  ]);
  /* for tests: change the pretend folder */
  setLocalFile(rel: string, text: string | null) {
    if (text === null) this.localFolder.delete(rel);
    else this.localFolder.set(rel, text);
  }
  private plan(remote: string): SyncPlan {
    const there = new Map<string, Uint8Array | number>();
    for (const [dir, list] of this.files)
      if (isUnder(dir, remote))
        for (const f of list)
          if (!f.dir) {
            const path = `${dir}/${f.name}`,
              rel = path.slice(remote.length + 1);
            /* hidden files are left out, as in the app */
            if (!rel.split("/").some((part) => part.startsWith("."))) there.set(rel, this.contents.get(path) ?? f.size);
          }
    const p: SyncPlan = { new: [], changed: [], extra: [], same: 0 };
    /* the SD card doesn't tell upper and lower case apart */
    const find = (rel: string) => [...there.keys()].find((k) => k.toLowerCase() === rel.toLowerCase());
    for (const [rel, text] of this.localFolder) {
      const key = find(rel);
      const data = enc.encode(text),
        have = key === undefined ? undefined : there.get(key);
      const item = { rel, size: data.length };
      if (have === undefined) p.new.push(item);
      else if (typeof have === "number" || have.length !== data.length || have.some((b, i) => b !== data[i]))
        p.changed.push(item);
      else p.same++;
    }
    const local = [...this.localFolder.keys()].map((k) => k.toLowerCase());
    for (const [rel, have] of there)
      if (!local.includes(rel.toLowerCase()))
        p.extra.push({ rel, size: typeof have === "number" ? have : have.length });
    /* in name order, as the app lists them */
    for (const list of [p.new, p.changed, p.extra]) list.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return p;
  }
  sync = {
    links: async () => {
      this.need();
      return this.links
        .filter((l) => l.flipper === this.portId)
        .map(({ id, local, remote }) => ({ id, local, remote }));
    },
    link: async (remote: string): Promise<SyncLink | null> => {
      this.need();
      if (!remote.startsWith("/ext/")) throw new DeviceError("invalid-name");
      const have = this.links.find((l) => l.remote === remote && l.flipper === this.portId);
      if (have) return { id: have.id, local: have.local, remote: have.remote };
      const l = { id: this.links.length + 1, local: "Documents/flipper-notes", remote };
      this.links.push({ ...l, flipper: this.portId });
      return l;
    },
    unlink: async (id: number) => {
      this.links = this.links.filter((l) => l.id !== id);
    },
    preview: async (id: number) => {
      this.need();
      const l = this.links.find((x) => x.id === id && x.flipper === this.portId);
      if (!l) throw new DeviceError("not-found");
      this.rpc("storage_list_request", `${l.remote} (and every folder in it)`);
      return this.plan(l.remote);
    },
    apply: async (id: number, remove: string[], t?: TransferOptions) => {
      this.need();
      const l = this.links.find((x) => x.id === id && x.flipper === this.portId);
      if (!l) throw new DeviceError("not-found");
      const p = this.plan(l.remote);
      const todo = [...p.new, ...p.changed];
      const total = todo.reduce((n, i) => n + i.size, 0);
      let done = 0;
      if (!this.files.has(l.remote)) await this.storage.mkdir(l.remote);
      for (const item of todo) {
        if (t?.signal?.aborted) throw new DeviceError("cancelled");
        const parts = item.rel.split("/");
        let at = l.remote;
        for (const part of parts.slice(0, -1)) {
          at = `${at}/${part}`;
          if (!this.files.has(at)) await this.storage.mkdir(at);
        }
        await this.storage.write(`${l.remote}/${item.rel}`, enc.encode(this.localFolder.get(item.rel) ?? ""));
        done += item.size;
        t?.onProgress?.({ done, total });
      }
      let removed = 0;
      const copied = todo.map((i) => i.rel.toLowerCase());
      for (const item of p.extra)
        if (remove.includes(item.rel) && !copied.includes(item.rel.toLowerCase())) {
          await this.storage.remove(`${l.remote}/${item.rel}`, false);
          removed++;
        }
      return { copied: todo.length, removed };
    },
  };

  /* ---------- the screen ---------- */
  private buffer() {
    const f = this.flipper;
    const src = f.mode === "update" ? SCREENS.update : f.mode === "menu" ? SCREENS.menu[f.sel] : SCREENS.app[f.sel];
    const buf = new Uint8Array(src);
    const set = (x: number, y: number) => {
      buf[(y >> 3) * 128 + x] |= 1 << (y & 7);
    };
    if (f.mode === "app" && f.sel === 0) {
      const hi = 34,
        lo = 47,
        off = Math.floor(f.offset);
      let prev = WAVE.levels[off % WAVE.period];
      for (let i = 0; i < 122; i++) {
        const lv = WAVE.levels[(i + off) % WAVE.period];
        set(3 + i, lv ? hi : lo);
        if (lv !== prev) for (let y = hi; y <= lo; y++) set(3 + i, y);
        prev = lv;
      }
    }
    if (f.mode === "update") {
      /* fill the progress bar drawn in the update frame */
      const w = Math.round((96 * f.update) / 100);
      for (let x = 16; x < 16 + w; x++) for (let y = 38; y <= 43; y++) set(x, y);
    }
    return buf;
  }
  private frame(): ScreenFrame {
    const f = this.flipper;
    if (f.mode === "keyboard") return { data: drawKeyboard(this.kb), orientation: "horizontal", label: "the keyboard" };
    const label = f.mode === "update" ? "the updater" : f.mode === "menu" ? "the main menu" : SCREENS.names[f.sel];
    return { data: this.buffer(), orientation: "horizontal", label };
  }
  private emit() {
    if (!this.streams.size) return;
    const fr = this.frame();
    this.streams.forEach((s) => s.onFrame(fr));
  }
  private retick() {
    clearInterval(this.ticker);
    if (!this.streams.size) return;
    const fps = Math.max(...[...this.streams].map((s) => s.fps));
    this.ticker = window.setInterval(() => {
      const f = this.flipper;
      if (f.mode === "app" && f.sel === 0) {
        f.offset += 11 / fps;
        this.emit();
      }
    }, 1000 / fps);
  }
  private endStreams() {
    this.streams.clear();
    this.retick();
  }

  screen = {
    stream: (onFrame: (f: ScreenFrame) => void, fps: number): ScreenStream => {
      const rec: StreamRec = { onFrame, fps };
      if (this.conn.status === "connected") {
        this.rpc("gui_start_screen_stream_request", "ScreenFrame stream");
        this.streams.add(rec);
        this.retick();
        queueMicrotask(() => this.streams.has(rec) && onFrame(this.frame()));
      }
      return {
        stop: () => {
          if (!this.streams.delete(rec)) return;
          this.rpc("gui_stop_screen_stream_request");
          this.retick();
        },
        setFps: (n: number) => {
          rec.fps = n;
          this.retick();
        },
      };
    },
  };

  input = {
    send: async (key: Key, type: InputType) => {
      this.need();
      if (this.flipper.mode === "keyboard") {
        this.kb = applyInput(this.kb, key, type);
        if (key === "back" && type === "short") this.flipper.mode = "menu";
        this.emit();
        return;
      }
      if (type !== "short" && type !== "long" && type !== "repeat") return;
      if (type !== "repeat") this.rpc("gui_send_input_event_request", `${key.toUpperCase()}, ${type} press`);
      const f = this.flipper,
        n = SCREENS.menu.length;
      if (f.mode === "update") return;
      if (f.mode === "menu") {
        if (key === "up") f.sel = (f.sel + n - 1) % n;
        if (key === "down") f.sel = (f.sel + 1) % n;
        if (key === "ok") f.mode = "app";
      } else if (key === "back") f.mode = "menu";
      this.emit();
    },
  };

  apps = {
    start: async (name: string, args?: string) => {
      this.need();
      this.rpc("app_start_request", args ? `${name} ${args}` : name);
      if (name.startsWith("/ext/apps/")) {
        if (!this.entry(name).item) throw new DeviceError("no-app");
        return;
      }
      if (APP_FRAMES[name] === undefined || this.missing.has(name)) throw new DeviceError("no-app");
      Object.assign(this.flipper, { mode: "app", sel: APP_FRAMES[name] });
      this.emit();
    },
  };

  library = {
    scan: async (): Promise<LibraryItem[]> => {
      this.need();
      const out: LibraryItem[] = [];
      for (const c of LIBRARY_CATEGORIES) {
        const dirs = [c.folder];
        for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
          this.rpc("storage_list_request", dir);
          for (const f of this.files.get(dir) ?? []) {
            if (f.name.startsWith(".")) continue;
            if (f.dir) {
              if (!(dir === c.folder && f.name === "assets")) dirs.push(`${dir}/${f.name}`);
              continue;
            }
            if (!f.name.toLowerCase().endsWith(c.ext)) continue;
            const path = `${dir}/${f.name}`,
              m = this.meta.get(path);
            out.push({
              category: c.id,
              name: f.name,
              path,
              meta: m?.meta ?? "",
              detail: m?.detail ?? "",
              fields: m?.fields ?? [],
              size: f.size,
              modified: f.modified,
            });
          }
        }
      }
      return out;
    },
  };

  private async ticks(n: number, ms: number, total: number, t?: TransferOptions) {
    for (let i = 1; i <= n; i++) {
      if (t?.signal?.aborted) throw new DeviceError("cancelled");
      await new Promise((r) => setTimeout(r, ms));
      this.need();
      t?.onProgress?.({ done: Math.round((total * i) / n), total });
    }
  }

  firmware = {
    latest: async (channel: Channel): Promise<FirmwareRelease | null> => {
      const version = channel.startsWith("gh:")
        ? channel.toLowerCase().includes("momentum")
          ? "mntm-009"
          : "unlshd-079"
        : MOCK_RELEASES[channel as keyof typeof MOCK_RELEASES];
      return { version, channel, changelog: mockChangelog(version), date: Date.now() - 6 * 86400000 };
    },
    forkLatest: async (): Promise<ForkRelease | null> => {
      if (!this.otherFirmware) return null;
      const momentum = this.origin.fork === "Momentum",
        version = momentum ? "mntm-009" : "unlshd-079";
      return { fork: this.origin.fork, version, url: `${this.origin.origin}/releases/tag/${version}` };
    },
    pick: async (): Promise<FirmwareRelease | null> => ({
      version: "f7-update-local.tgz",
      channel: "release",
      file: "mock-package",
    }),
    install: async (release: FirmwareRelease, onProgress: (p: InstallProgress) => void, signal?: AbortSignal) => {
      this.need();
      if (this.installing) throw new DeviceError("busy");
      this.installing = true;
      const version = release.file ? MOCK_DEVICE.latest : release.version;
      const dir = `/ext/update/${MOCK_DEVICE.target}-update-${version}`;
      const files = ["update.fuf", "firmware.dfu", "radio.bin", "resources.tar.gz"];
      const copied = this.copiedUpdate === dir;
      const calls: [string, string][][] = [
        [["storage_info_request", "/ext"]],
        [["storage_write_request", "/int/.region_data"]],
        [],
        [
          ["storage_mkdir_request", dir],
          ...files.map((f): [string, string] => ["storage_md5sum_request", `${dir}/${f}`]),
          ...(copied ? [] : files.map((f): [string, string] => ["storage_write_request", `${dir}/${f}`])),
        ],
        [
          ["system_update_request", `${dir}/update.fuf`],
          ["system_reboot_request", "UPDATE mode"],
        ],
        [],
      ];
      try {
        for (let step = 0; step < calls.length; step++) {
          if (step === 0 && this.noSd) throw new DeviceError("no-sd");
          if (step === 5) {
            this.rebooting = true;
            this.setConn({ status: "disconnected", ports: [] });
          }
          for (let sub = 10; sub <= 100; sub += 10) {
            if (step < 4 && signal?.aborted) throw new DeviceError("cancelled");
            await new Promise((r) => setTimeout(r, 130));
            if (step < 5) this.need();
            else if (!this.plugged) {
              const until = Date.now() + 20000;
              while (!this.plugged && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
              if (!this.plugged) throw new DeviceError("update-stuck");
            }
            if (sub === 10) calls[step].forEach(([n, d]) => this.rpc(n, d));
            if (step === 3 && sub === 100) this.copiedUpdate = dir;
            if (step === 5) {
              Object.assign(this.flipper, { mode: "update", update: sub });
              this.emit();
            }
            onProgress({ step, pct: sub });
          }
        }
        this.firmwareVersion = version;
        if (!release.file) this.setOrigin(release.channel);
        this.copiedUpdate = null;
        Object.assign(this.flipper, { mode: "menu", sel: 0 });
        this.emit();
        this.rebooting = false;
        this.rpc("start_rpc_session", "reconnected after the update");
        this.setConn({ status: "connected", ports: this.ports(), info: this.info(), current: this.portId });
      } finally {
        this.installing = false;
        if (this.rebooting) {
          this.rebooting = false;
          if (this.plugged) this.setConn({ status: "disconnected", ports: this.ports() });
        }
      }
    },
  };

  backup = {
    create: async ({ sd }: { sd: boolean }, t?: TransferOptions): Promise<BackupRecord> => {
      this.need();
      if (this.installing) throw new DeviceError("busy");
      if (sd && this.noSd) throw new DeviceError("no-sd");
      this.rpc("storage_list_request", "/int (and every folder in it)");
      this.rpc("storage_read_request", "/int/… (each file)");
      if (sd) {
        this.rpc("storage_list_request", "/ext (and every folder in it)");
        this.rpc("storage_md5sum_request", "/ext/… (files copied before)");
        this.rpc("storage_read_request", "/ext/… (new and changed files)");
      }
      this.installing = true;
      try {
        await this.ticks(sd ? 8 : 4, 90, sd ? 7_400_000 : 18_432, t);
      } finally {
        this.installing = false;
      }
      const rec: BackupRecord = { id: `mock-backup-${this.backups.length + 1}`, created: Date.now(), sd, size: 18_432 };
      this.backups.unshift(rec);
      if (sd) this.sdCopy = rec.created;
      return rec;
    },
    list: async (): Promise<BackupList> => ({ backups: this.backups.slice(), sdCopy: this.sdCopy }),
    restore: async (id: string, { sd }: { sd: boolean }, t?: TransferOptions) => {
      this.need();
      if (this.installing) throw new DeviceError("busy");
      if (!this.backups.some((b) => b.id === id)) throw new DeviceError("not-found");
      if (sd && this.sdCopy === null) throw new DeviceError("not-found");
      if (sd && this.noSd) throw new DeviceError("no-sd");
      this.rpc("storage_write_request", "/int/… (each file in the backup)");
      if (sd) {
        this.rpc("storage_md5sum_request", "/ext/… (each file in the SD card copy)");
        this.rpc("storage_write_request", "/ext/… (files that differ)");
      }
      this.installing = true;
      try {
        await this.ticks(sd ? 8 : 4, 90, sd ? 7_400_000 : 18_432, t);
      } finally {
        this.installing = false;
      }
      /* then the Flipper restarts, as after qFlipper's restore */
      await this.device.reboot();
    },
  };

  private cliOut: ((b: Uint8Array) => void) | null = null;
  private cliLine = "";
  private say(text: string) {
    this.cliOut?.(enc.encode(text));
  }
  private cliType(text: string) {
    if (!this.cliOut) throw new DeviceError("disconnected");
    for (const ch of text) {
      if (ch === "\r") {
        const cmd = this.cliLine;
        this.cliLine = "";
        const out = cmd.trim() ? this.answer(cmd).lines : [];
        this.say(`\r\n${out.map((l) => `${l}\r\n`).join("")}>: `);
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.cliLine) {
          this.cliLine = this.cliLine.slice(0, -1);
          this.say("\b \b");
        }
      } else if (ch === "\x03") {
        this.cliLine = "";
        this.say("^C\r\n>: ");
      } else if (ch >= " " && ch !== "\x7f") {
        this.cliLine += ch;
        this.say(ch);
      }
    }
  }

  cli = {
    attach: async (onData: (b: Uint8Array) => void): Promise<CliLink> => {
      if (this.conn.status !== "connected") throw new DeviceError("disconnected");
      if (this.overAir) throw new DeviceError("usb-only");
      const link: CliLink = {
        write: async (t) => this.cliType(t),
        detach: async () => {
          if (!this.cliOut) return;
          this.cliOut = null;
          this.rpc("start_rpc_session", MOCK_DEVICE.port);
          this.setConn({ ...this.conn, console: false });
        },
      };
      if (this.cliOut) {
        this.cliOut = onData;
        this.cliLine = "";
        this.say("^C\r\n>: ");
        return link;
      }
      /* never in the middle of an install, backup or restore */
      if (this.installing) throw new DeviceError("busy");
      this.rpc("stop_session", "for the Console");
      this.endStreams();
      this.cliOut = onData;
      this.cliLine = "";
      this.setConn({ ...this.conn, console: true });
      this.say("\r\n>: ");
      return link;
    },
  };

  /* What the CLI prints for a command. */
  private answer(raw: string): { lines: string[]; error: boolean } {
    const cmd = raw.trim().replace(/\s+/g, " ");
    const d = MOCK_DEVICE;
    if (cmd === "help" || cmd === "?")
      return {
        lines: ["Try: info device, storage list /ext, free, ps, log, date, led bl 255, vibro 1, clear"],
        error: false,
      };
    if (cmd === "info device")
      return {
        lines: [
          `hardware_model      : ${d.model}`,
          `hardware_name       : ${d.name}`,
          `hardware_region     : ${d.region}`,
          `firmware_version    : ${this.firmwareVersion}`,
          "firmware_branch     : release",
        ],
        error: false,
      };
    if (Object.hasOwn(MOCK_CLI, cmd)) return { lines: MOCK_CLI[cmd], error: false };
    if (cmd.startsWith("storage list")) {
      const p = cmd.split(" ")[2] || "/ext",
        list = this.files.get(p);
      if (!list) return { lines: [`Storage error: invalid name/path ${p}`], error: true };
      return {
        lines: list.length
          ? list.map((f) => `\t[${f.dir ? "D" : "F"}] ${f.name}${f.dir ? "" : " " + fmtSize(f.size)}`)
          : ["\tEmpty, no files"],
        error: false,
      };
    }
    if (cmd === "date") return { lines: [new Date().toISOString().slice(0, 19).replace("T", " ")], error: false };
    if (/^led (r|g|b|bl) \d{1,3}$/.test(cmd) || /^vibro [01]$/.test(cmd)) return { lines: [], error: false };
    return { lines: [`\`${cmd}\` command not found`], error: true };
  }

  log = {
    subscribe: (fn: (e: RpcLogEntry) => void) => {
      this.logFns.add(fn);
      return () => void this.logFns.delete(fn);
    },
  };
}
