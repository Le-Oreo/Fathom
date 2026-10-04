export type Unsubscribe = () => void;

/* ---------- connection and device ---------- */
export interface DeviceInfo {
  name: string; // hardware_name
  model: string; // "Flipper Zero"
  hardware: string; // shown as "hardware F7"
  region: string; // "US"
  firmware: string; // installed version, "1.3.4"
  branch: string; // firmware_branch, "release"
  target: string; // update target, "f7"
  link: "USB-C" | "Bluetooth";
  port: string;
  id: string;
  fork: string;
  origin: string;
}
export interface PowerInfo {
  battery: number; // percent
  charging: boolean;
}
export interface FlipperClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}
/* Bytes. null when there is no SD card. */
export interface StorageInfo {
  used: number;
  total: number;
}
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export interface PortInfo {
  id: string;
  name: string;
}
export interface ConnectionState {
  status: ConnectionStatus;
  ports: PortInfo[];
  error?: DeviceErrorCode;
  info?: DeviceInfo;
  console?: boolean;
  /* the port (an id from ports) of the Flipper connected */
  current?: string;
}

/* ---------- storage ---------- */
export interface FileEntry {
  name: string;
  dir: boolean;
  size: number; // bytes, 0 for folders
  modified?: number; // ms since 1970, when the device reports it
}
export interface Progress {
  done: number;
  total: number;
}
export interface TransferOptions {
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}
export type UploadSource = { file: File } | { path: string; name: string; size: number; dir: boolean };
export const sourceName = (s: UploadSource) => ("file" in s ? s.file.name : s.name);
export interface UploadResult {
  name: string;
  files: number;
  skipped: number;
}

/* ---------- folder sync ---------- */
export interface SyncLink {
  id: number;
  local: string;
  remote: string;
}
export interface SyncItem {
  rel: string;
  size: number;
}
export interface SyncPlan {
  new: SyncItem[];
  changed: SyncItem[];
  /* files only on the Flipper */
  extra: SyncItem[];
  same: number;
}

/* ---------- screen and keys ---------- */
export type Key = "up" | "down" | "left" | "right" | "ok" | "back";
export type InputType = "press" | "release" | "short" | "long" | "repeat";
export type Orientation = "horizontal" | "horizontal-flip" | "vertical" | "vertical-flip";
export interface ScreenFrame {
  data: Uint8Array;
  orientation: Orientation;
  label?: string;
}
export interface ScreenStream {
  stop(): void;
  setFps(fps: number): void;
}

/* ---------- library ---------- */
export interface LibraryItem {
  category: string; // an id from LIBRARY_CATEGORIES
  name: string;
  path: string;
  meta: string; // first line under the name, e.g. "433.92 MHz"
  detail: string; // second part, e.g. "RAW"
  fields: [string, string][];
  size: number;
  modified?: number;
}

/* ---------- firmware and backups ---------- */
export type Channel = "release" | "rc" | "dev" | `gh:${string}`;
export interface ForkRelease {
  fork: string;
  version: string;
  url: string;
}
export interface FirmwareRelease {
  version: string;
  channel: Channel;
  changelog?: string;
  /* ms since 1970 */
  date?: number;
  file?: string;
}
export interface InstallProgress {
  step: number;
  pct: number;
}
export interface BackupRecord {
  id: string;
  created: number;
  /* this backup brought the SD card copy up to date */
  sd: boolean;
  /* bytes of the internal storage backup */
  size: number;
}
export interface BackupList {
  backups: BackupRecord[];
  sdCopy: number | null;
}

/* ---------- console and log ---------- */
export interface CliLink {
  write(text: string): Promise<void>;
  detach(): Promise<void>;
}
export interface RpcLogEntry {
  dir: "out" | "in";
  name: string;
  detail: string;
}

export interface DeviceApi {
  connection: {
    current(): ConnectionState;
    subscribe(fn: (s: ConnectionState) => void): Unsubscribe;
    connect(port?: string): Promise<void>;
    switchTo(port: string): Promise<void>;
    setBluetooth(on: boolean): Promise<void>;
  };
  device: {
    info(): Promise<DeviceInfo>;
    power(): Promise<PowerInfo>;
    /* Resolves once the Flipper is back and available again. */
    reboot(): Promise<void>;
    playAlert(): Promise<void>;
    getClock(): Promise<FlipperClock>;
    setClock(c: FlipperClock): Promise<void>;
  };
  storage: {
    info(root: "/ext" | "/int"): Promise<StorageInfo | null>;
    list(path: string): Promise<FileEntry[]>;
    stat(path: string): Promise<FileEntry>;
    read(path: string, opts?: TransferOptions): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, opts?: TransferOptions): Promise<void>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    remove(path: string, recursive: boolean): Promise<void>;
    md5(path: string): Promise<string>;
    upload(source: UploadSource, toDir: string, opts?: TransferOptions): Promise<UploadResult>;
    download(path: string, dir: boolean, folder: string, opts?: TransferOptions): Promise<string>;
  };
  /* Per Flipper. */
  sync: {
    links(): Promise<SyncLink[]>;
    link(remoteDir: string): Promise<SyncLink | null>;
    unlink(id: number): Promise<void>;
    preview(id: number): Promise<SyncPlan>;
    apply(id: number, remove: string[], t?: TransferOptions): Promise<{ copied: number; removed: number }>;
  };
  screen: {
    stream(onFrame: (f: ScreenFrame) => void, fps: number): ScreenStream;
  };
  input: {
    send(key: Key, type: InputType): Promise<void>;
  };
  apps: {
    start(name: string, args?: string): Promise<void>;
  };
  library: {
    scan(): Promise<LibraryItem[]>;
  };
  firmware: {
    latest(channel: Channel): Promise<FirmwareRelease | null>;
    forkLatest(): Promise<ForkRelease | null>;
    pick(): Promise<FirmwareRelease | null>;
    install(release: FirmwareRelease, onProgress: (p: InstallProgress) => void, signal?: AbortSignal): Promise<void>;
  };
  /* Kept on the computer, per Flipper. */
  backup: {
    create(opts: { sd: boolean }, t?: TransferOptions): Promise<BackupRecord>;
    list(): Promise<BackupList>;
    restore(id: string, opts: { sd: boolean }, t?: TransferOptions): Promise<void>;
  };
  cli: {
    attach(onData: (bytes: Uint8Array) => void): Promise<CliLink>;
  };
  log: {
    subscribe(fn: (e: RpcLogEntry) => void): Unsubscribe;
  };
}

/* ---------- errors ---------- */
export type DeviceErrorCode =
  | "disconnected"
  | "timeout"
  | "not-found"
  | "exists"
  | "not-empty"
  | "invalid-name"
  | "locked"
  | "no-sd"
  | "busy"
  | "port-busy"
  | "permission"
  | "no-answer"
  | "cancelled"
  /* the firmware has no app by that name */
  | "no-app"
  /* the app is there but wouldn't start */
  | "app-failed"
  /* the update server can't be reached */
  | "offline"
  /* not enough free space for what's about to be copied */
  | "no-room"
  /* the update package is damaged, or isn't one */
  | "bad-package"
  /* the update package is for another kind of Flipper */
  | "wrong-target"
  /* the Flipper didn't come back after an update */
  | "update-stuck"
  /* the Console has the Flipper's command line */
  | "console-open"
  | "ble-pair"
  /* that needs the USB cable (the Console) */
  | "usb-only"
  | "failed"
  | "unsupported";

export class DeviceError extends Error {
  readonly code: DeviceErrorCode;
  constructor(code: DeviceErrorCode, message: string = code) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
  }
}
