import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DeviceError,
  type BackupRecord,
  type ConnectionState,
  type DeviceApi,
  type DeviceErrorCode,
  type DeviceInfo,
  type FileEntry,
  type FlipperClock,
  type ForkRelease,
  type InstallProgress,
  type LibraryItem,
  type Progress,
  type TransferOptions,
  type UploadResult,
  type Orientation,
  type ScreenFrame,
  type PowerInfo,
  type RpcLogEntry,
  type StorageInfo,
  type SyncLink,
  type SyncPlan,
} from "./api";

const CODES: readonly DeviceErrorCode[] = [
  "disconnected",
  "timeout",
  "not-found",
  "exists",
  "not-empty",
  "invalid-name",
  "locked",
  "no-sd",
  "busy",
  "port-busy",
  "permission",
  "no-answer",
  "cancelled",
  "no-app",
  "app-failed",
  "offline",
  "no-room",
  "bad-package",
  "wrong-target",
  "update-stuck",
  "console-open",
  "ble-pair",
  "usb-only",
  "failed",
  "unsupported",
];

export function toDeviceError(err: unknown): DeviceError {
  if (err instanceof DeviceError) return err;
  if (err && typeof err === "object" && "code" in err) {
    const { code, detail } = err as { code: unknown; detail?: unknown };
    if (CODES.includes(code as DeviceErrorCode))
      return new DeviceError(code as DeviceErrorCode, typeof detail === "string" && detail ? detail : String(code));
  }
  return new DeviceError("failed", String(err));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toDeviceError(err);
  }
}

const START_TRIES = 5;
async function callRaw<T>(cmd: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
  try {
    return await invoke<T>(cmd, body, { headers });
  } catch (err) {
    throw toDeviceError(err);
  }
}

let transferIds = Math.floor(Math.random() * 2 ** 31) * 2 ** 20;
async function transfer<T>(cmd: string, args: Record<string, unknown>, opts?: TransferOptions): Promise<T> {
  if (opts?.signal?.aborted) throw new DeviceError("cancelled");
  const id = ++transferIds;
  const progress = new Channel<Progress>();
  progress.onmessage = (p) => opts?.onProgress?.(p);
  const cancel = () => void invoke("transfer_cancel", { id }).catch(() => {});
  opts?.signal?.addEventListener("abort", cancel);
  try {
    return await call<T>(cmd, { ...args, id, progress });
  } finally {
    opts?.signal?.removeEventListener("abort", cancel);
  }
}

const ORIENTATIONS: Orientation[] = ["horizontal", "horizontal-flip", "vertical", "vertical-flip"];

export class TauriFlipper implements DeviceApi {
  private conn: ConnectionState = { status: "disconnected", ports: [] };
  private connFns = new Set<(s: ConnectionState) => void>();
  private logFns = new Set<(e: RpcLogEntry) => void>();
  private heard = false;
  private screenCalls: Promise<void> = Promise.resolve();

  constructor() {
    void this.start();
  }

  private async start() {
    await Promise.all([
      listen<ConnectionState>("connection", (e) => {
        this.heard = true;
        this.setConn(e.payload);
      }),
      listen<RpcLogEntry>("rpc-log", (e) => this.logFns.forEach((fn) => fn(e.payload))),
    ]);
    const s = await call<ConnectionState>("connection_current").catch(() => null);
    if (s && !this.heard) this.setConn(s);
  }

  private setConn(next: ConnectionState) {
    this.conn = next;
    this.connFns.forEach((fn) => fn(next));
  }

  connection = {
    current: () => this.conn,
    subscribe: (fn: (s: ConnectionState) => void) => {
      this.connFns.add(fn);
      fn(this.conn);
      return () => void this.connFns.delete(fn);
    },
    connect: (port?: string) => call<void>("connection_connect", { port: port ?? null }),
    switchTo: (port: string) => call<void>("connection_switch", { port }),
    setBluetooth: (on: boolean) => call<void>("bluetooth_enable", { on }),
  };

  device: DeviceApi["device"] = {
    info: () => call<DeviceInfo>("device_info"),
    power: () => call<PowerInfo>("device_power"),
    reboot: () => call<void>("device_reboot"),
    playAlert: () => call<void>("device_play_alert"),
    getClock: () => call<FlipperClock>("device_clock_get"),
    setClock: (clock) => call<void>("device_clock_set", { clock }),
  };

  storage: DeviceApi["storage"] = {
    info: (root) => call<StorageInfo | null>("storage_info", { root }),
    list: (path) => call<FileEntry[]>("storage_list", { path }),
    stat: (path) => call<FileEntry>("storage_stat", { path }),
    read: async (path, opts) => {
      opts?.onProgress?.({ done: 0, total: 1 });
      const buf = await call<ArrayBuffer>("storage_read", { path });
      opts?.onProgress?.({ done: buf.byteLength, total: buf.byteLength });
      return new Uint8Array(buf);
    },
    write: async (path, data, opts) => {
      opts?.onProgress?.({ done: 0, total: data.length });
      await callRaw("storage_write", data, { "x-path": encodeURIComponent(path) });
      opts?.onProgress?.({ done: data.length, total: data.length });
    },
    mkdir: (path) => call<void>("storage_mkdir", { path }),
    rename: (from, to) => call<void>("storage_rename", { from, to }),
    remove: (path, recursive) => call<void>("storage_remove", { path, recursive }),
    md5: (path) => call<string>("storage_md5", { path }),
    upload: async (source, toDir, opts) => {
      if ("file" in source) {
        const data = new Uint8Array(await source.file.arrayBuffer());
        opts?.onProgress?.({ done: 0, total: data.length });
        const same = await callRaw<boolean>("storage_write", data, {
          "x-path": encodeURIComponent(`${toDir}/${source.file.name}`),
          "x-skip-same": "1",
        });
        opts?.onProgress?.({ done: data.length, total: data.length });
        return { name: source.file.name, files: 1, skipped: same ? 1 : 0 };
      }
      return transfer<UploadResult>("transfer_upload", { source: source.path, to: toDir }, opts);
    },
    download: (path, dir, folder, opts) => transfer<string>("transfer_download", { path, dir, folder }, opts),
  };

  sync: DeviceApi["sync"] = {
    links: () => call<SyncLink[]>("sync_links"),
    link: (remote) => call<SyncLink | null>("sync_link_add", { remote }),
    unlink: (id) => call<void>("sync_link_remove", { id }),
    preview: (id) => call<SyncPlan>("sync_preview", { id }),
    apply: (link, remove, opts) => transfer<{ copied: number; removed: number }>("sync_apply", { link, remove }, opts),
  };

  screen: DeviceApi["screen"] = {
    stream: (onFrame, fps) => {
      let gap = 1000 / fps,
        last = 0,
        waiting: ScreenFrame | null = null,
        timer = 0,
        stopped = false;
      const deliver = () => {
        timer = 0;
        if (stopped || !waiting) return;
        last = performance.now();
        const f = waiting;
        waiting = null;
        onFrame(f);
      };
      const channel = new Channel<ArrayBuffer | number[]>();
      channel.onmessage = (buf) => {
        const bytes = new Uint8Array(buf);
        if (stopped || bytes.length !== 1025) return;
        waiting = { data: bytes.slice(1), orientation: ORIENTATIONS[bytes[0]] ?? "horizontal" };
        const wait = last + gap - performance.now();
        if (wait <= 0) deliver();
        else if (!timer) timer = window.setTimeout(deliver, wait);
      };
      let id: number | null = null,
        tries = 0,
        retry = 0;
      const start = () => {
        this.screenCalls = this.screenCalls.then(async () => {
          if (stopped) return;
          try {
            id = await call<number>("screen_start", { channel });
          } catch {
            if (!stopped && ++tries < START_TRIES) retry = window.setTimeout(start, 1000);
          }
        });
      };
      start();
      return {
        stop: () => {
          stopped = true;
          clearTimeout(timer);
          clearTimeout(retry);
          this.screenCalls = this.screenCalls.then(() =>
            id === null ? undefined : call<void>("screen_stop", { id }).catch(() => {}),
          );
        },
        setFps: (n) => {
          gap = 1000 / n;
        },
      };
    },
  };

  input: DeviceApi["input"] = {
    send: (key, type) => call<void>("input_send", { key, kind: type }),
  };

  apps: DeviceApi["apps"] = {
    start: (name, args) => call<void>("app_start", { name, args: args ?? null }),
  };

  library: DeviceApi["library"] = {
    scan: async () => {
      const items = await call<(Omit<LibraryItem, "fields"> & { fields: [string, string][] })[]>("library_scan");
      return items.map((i) => ({ ...i, modified: undefined }));
    },
  };

  firmware: DeviceApi["firmware"] = {
    latest: async (channel) => {
      const r = await call<{ version: string; changelog: string; date: number } | null>("firmware_latest", { channel });
      return r && { version: r.version, channel, changelog: r.changelog || undefined, date: r.date || undefined };
    },
    forkLatest: () => call<ForkRelease | null>("firmware_fork_latest"),
    pick: async () => {
      const p = await call<{ token: string; name: string } | null>("firmware_pick");
      return p && { version: p.name, channel: "release", file: p.token };
    },
    install: async (release, onProgress, signal) => {
      if (signal?.aborted) throw new DeviceError("cancelled");
      const id = ++transferIds;
      const progress = new Channel<InstallProgress>();
      progress.onmessage = (p) => onProgress(p);
      const cancel = () => void invoke("transfer_cancel", { id }).catch(() => {});
      signal?.addEventListener("abort", cancel);
      try {
        await call<DeviceInfo>("firmware_install", {
          id,
          channel: release.channel,
          version: release.version,
          file: release.file ?? null,
          progress,
        });
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  };

  backup: DeviceApi["backup"] = {
    create: ({ sd }, opts) => transfer<BackupRecord>("backup_create", { sd }, opts),
    list: async () => {
      const r = await call<{ list: BackupRecord[]; sd: number | null }>("backup_list");
      return { backups: r.list, sdCopy: r.sd };
    },
    restore: (id, { sd }, opts) => transfer<void>("backup_restore", { backup: id, sd }, opts),
  };

  cli: DeviceApi["cli"] = {
    attach: async (onData) => {
      const channel = new Channel<ArrayBuffer | number[]>();
      channel.onmessage = (buf) => onData(new Uint8Array(buf));
      await call<void>("cli_attach", { channel });
      return {
        write: (data: string) => call<void>("cli_write", { data }),
        detach: () => call<void>("cli_detach"),
      };
    },
  };

  log = {
    subscribe: (fn: (e: RpcLogEntry) => void) => {
      this.logFns.add(fn);
      return () => void this.logFns.delete(fn);
    },
  };
}
