import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionState, RpcLogEntry, ScreenFrame } from "./api";
import { DeviceError } from "./api";
import { TauriFlipper, toDeviceError } from "./tauri";

const tick = () => new Promise((r) => setTimeout(r, 0));
const plugged: ConnectionState = { status: "disconnected", ports: [{ id: "flip_Nautilus", name: "Nautilus" }] };

function backend(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push([cmd, args]);
      const h = handlers[cmd];
      if (!h) throw new Error(`no handler for ${cmd}`);
      return h(args);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

afterEach(() => clearMocks());

describe("the real Flipper's DeviceApi", () => {
  it("starts from the current state and follows connection events", async () => {
    backend({ connection_current: () => plugged });
    const t = new TauriFlipper();
    const seen: ConnectionState[] = [];
    t.connection.subscribe((s) => seen.push(s));
    await tick();
    expect(t.connection.current()).toEqual(plugged);

    const connected: ConnectionState = { ...plugged, status: "connected" };
    await emit("connection", connected);
    await tick();
    expect(seen.at(-1)).toEqual(connected);
    expect(t.connection.current().status).toBe("connected");
  });

  it("passes the RPC log through", async () => {
    backend({ connection_current: () => plugged });
    const t = new TauriFlipper();
    const log: RpcLogEntry[] = [];
    t.log.subscribe((e) => log.push(e));
    await tick();
    await emit("rpc-log", { dir: "out", name: "system_device_info_request", detail: "" });
    await tick();
    expect(log).toEqual([{ dir: "out", name: "system_device_info_request", detail: "" }]);
  });

  it("calls the commands with their arguments", async () => {
    const calls = backend({
      connection_current: () => plugged,
      connection_connect: () => null,
      storage_info: ({ root }) => (root === "/ext" ? null : { used: 1, total: 2 }),
    });
    const t = new TauriFlipper();
    await t.connection.connect("flip_Nautilus");
    await t.connection.connect();
    expect(await t.storage.info("/ext")).toBeNull();
    expect(await t.storage.info("/int")).toEqual({ used: 1, total: 2 });
    expect(calls.filter(([c]) => c !== "connection_current")).toEqual([
      ["connection_connect", { port: "flip_Nautilus" }],
      ["connection_connect", { port: null }],
      ["storage_info", { root: "/ext" }],
      ["storage_info", { root: "/int" }],
    ]);
  });

  it("turns Rust errors into DeviceErrors", async () => {
    backend({
      connection_current: () => plugged,
      connection_connect: () => {
        throw { code: "port-busy", detail: "Access is denied." };
      },
    });
    const t = new TauriFlipper();
    const err = await t.connection.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).code).toBe("port-busy");

    expect(toDeviceError({ code: "no-answer", detail: "" }).code).toBe("no-answer");
    expect(toDeviceError({ code: "something-new" }).code).toBe("failed");
    expect(toDeviceError("boom").code).toBe("failed");
  });

  it("attaches the Console, writes what's typed and detaches", async () => {
    const calls = backend({
      connection_current: () => plugged,
      cli_attach: () => null,
      cli_write: () => null,
      cli_detach: () => null,
    });
    const t = new TauriFlipper();
    const link = await t.cli.attach(() => {});
    await link.write("help\r");
    await link.detach();
    const cli = calls.filter(([c]) => c.startsWith("cli_"));
    expect(cli.map(([c, a]) => (c === "cli_write" ? `${c} ${String(a.data)}` : c))).toEqual([
      "cli_attach",
      "cli_write help\r",
      "cli_detach",
    ]);
  });

  it("reads releases and backups, and names update errors plainly", async () => {
    backend({
      connection_current: () => plugged,
      firmware_latest: ({ channel }) =>
        channel === "rc" ? null : { version: "1.4.0", channel, changelog: "", date: 1700000000000 },
      backup_list: () => ({ list: [{ id: "2026-10-03T11-55-12Z", created: 1, sd: true, size: 9 }], sd: 1 }),
      firmware_install: () => {
        throw { code: "update-stuck", detail: "the Flipper didn't come back" };
      },
    });
    const t = new TauriFlipper();
    expect(await t.firmware.latest("release")).toEqual({
      version: "1.4.0",
      channel: "release",
      changelog: undefined,
      date: 1700000000000,
    });
    expect(await t.firmware.latest("rc")).toBeNull();
    expect(await t.backup.list()).toEqual({
      backups: [{ id: "2026-10-03T11-55-12Z", created: 1, sd: true, size: 9 }],
      sdCopy: 1,
    });
    await expect(t.firmware.install({ version: "1.4.0", channel: "release" }, () => {})).rejects.toMatchObject({
      code: "update-stuck",
    });
  });

  it("streams frames at most at the frame rate, the newest always getting through", async () => {
    let channel: { onmessage: (b: ArrayBuffer) => void } | undefined;
    const calls = backend({
      connection_current: () => plugged,
      screen_start: ({ channel: c }) => {
        channel = c as typeof channel;
        return 7;
      },
      screen_stop: () => null,
    });
    const t = new TauriFlipper();
    const got: ScreenFrame[] = [];
    const s = t.screen.stream((f) => got.push(f), 10); /* 100 ms apart */
    await tick();
    const frame = (o: number, fill: number) => {
      const b = new Uint8Array(1025).fill(fill);
      b[0] = o;
      channel?.onmessage(b.buffer);
    };
    frame(2, 1);
    frame(0, 2);
    frame(0, 3);
    expect(got).toHaveLength(1);
    expect(got[0].orientation).toBe("vertical");
    expect(got[0].data).toHaveLength(1024);
    await new Promise((r) => setTimeout(r, 130));
    expect(got).toHaveLength(2);
    expect(got[1].data[0]).toBe(3); /* the middle one was skipped */
    s.stop();
    frame(0, 4);
    await new Promise((r) => setTimeout(r, 130));
    expect(got).toHaveLength(2);
    await tick();
    expect(calls.find(([c]) => c === "screen_stop")?.[1]).toEqual({ id: 7 });
  });

  it("works with files: listing, saving text, and transfers that can be cancelled", async () => {
    let progress: { onmessage: (p: { done: number; total: number }) => void } | undefined;
    let release: (v: string) => void = () => {};
    const calls = backend({
      connection_current: () => plugged,
      storage_list: () => [{ name: "notes", dir: true, size: 0 }],
      storage_write: () => null,
      transfer_download: (args) => {
        progress = args.progress as typeof progress;
        return new Promise<string>((r) => (release = r));
      },
      transfer_cancel: () => null,
    });
    const t = new TauriFlipper();
    expect(await t.storage.list("/ext")).toEqual([{ name: "notes", dir: true, size: 0 }]);
    await t.storage.write("/ext/notes/a b.txt", new TextEncoder().encode("hi"));

    const seen: number[] = [];
    const ctl = new AbortController();
    const done = t.storage.download("/ext/notes", true, "folder-0", {
      onProgress: (p) => seen.push(p.done),
      signal: ctl.signal,
    });
    await tick();
    progress?.onmessage({ done: 5, total: 10 });
    ctl.abort();
    await tick();
    release("notes");
    expect(await done).toBe("notes");
    expect(seen).toEqual([5]);
    const dl = calls.find(([c]) => c === "transfer_download")?.[1];
    expect(dl).toMatchObject({ path: "/ext/notes", dir: true, folder: "folder-0" });
    expect(calls.find(([c]) => c === "transfer_cancel")?.[1]).toEqual({ id: dl?.id });
    /* an already-cancelled transfer never starts */
    await expect(t.storage.download("/ext/x", false, "folder-0", { signal: ctl.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
