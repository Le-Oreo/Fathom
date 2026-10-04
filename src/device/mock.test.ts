import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcLogEntry, ScreenFrame } from "./api";
import { DeviceError } from "./api";
import { MockFlipper } from "./mock";

let m: MockFlipper;
let log: RpcLogEntry[];
beforeEach(async () => {
  m = new MockFlipper();
  log = [];
  m.log.subscribe((e) => log.push(e));
  await m.connection.connect();
});
afterEach(() => m.unplug());

const names = async (p: string) => (await m.storage.list(p)).map((f) => f.name);

describe("the mock Flipper", () => {
  it("connects and says who it is", async () => {
    expect(m.connection.current()).toMatchObject({
      status: "connected",
      info: { name: "Nautilus", firmware: "1.3.4" },
    });
    expect(log.map((e) => e.name)).toEqual(["start_rpc_session"]);
  });

  it("refuses everything once unplugged", async () => {
    m.unplug();
    await expect(m.storage.list("/ext")).rejects.toMatchObject({ code: "disconnected" });
    await expect(m.connection.connect()).rejects.toBeInstanceOf(DeviceError);
    m.plug();
    expect(m.connection.current()).toMatchObject({ status: "disconnected", ports: [{ name: "Nautilus" }] });
  });

  it("moves a folder with everything in it", async () => {
    await m.storage.rename("/ext/music_player", "/ext/apps/music_player");
    expect(await names("/ext/apps/music_player/melodies")).toEqual(["lullaby.fmf", "scale_practice.fmf"]);
    await expect(m.storage.list("/ext/music_player")).rejects.toMatchObject({ code: "not-found" });
    expect(log).toContainEqual({
      dir: "out",
      name: "storage_rename_request",
      detail: "/ext/music_player → /ext/apps/music_player",
    });
  });

  it("won't overwrite or move a folder into itself", async () => {
    await expect(m.storage.rename("/ext/subghz/doorbell.sub", "/ext/subghz/RAW_0042.sub")).rejects.toMatchObject({
      code: "exists",
    });
    await expect(m.storage.rename("/ext/subghz", "/ext/subghz/backups/subghz")).rejects.toMatchObject({
      code: "invalid-name",
    });
  });

  it("deletes folders only when asked to take everything", async () => {
    await expect(m.storage.remove("/ext/subghz/backups", false)).rejects.toMatchObject({ code: "not-empty" });
    await m.storage.remove("/ext/subghz/backups", true);
    expect(await names("/ext/subghz")).not.toContain("backups");
    expect(m.hasPath("/ext/subghz/backups/2026-08")).toBe(false);
  });

  it("writes, reads back and lists a file", async () => {
    const text = new TextEncoder().encode("hello");
    await m.storage.write("/ext/notes.txt", text);
    expect(new TextDecoder().decode(await m.storage.read("/ext/notes.txt"))).toBe("hello");
    expect((await m.storage.stat("/ext/notes.txt")).size).toBe(5);
  });

  it("leaves no file behind when an upload is cancelled", async () => {
    const ac = new AbortController();
    const going = m.storage.write("/ext/big.bin", new Uint8Array(4096), {
      onProgress: () => ac.abort(),
      signal: ac.signal,
    });
    await expect(going).rejects.toMatchObject({ code: "cancelled" });
    expect(await names("/ext")).not.toContain("big.bin");
  });

  it("indexes the library from the files, descriptive fields only", async () => {
    const items = await m.library.scan();
    expect(items).toHaveLength(19);
    expect(items.some((i) => i.path === "/ext/subghz/backups/2026-08/RAW_0019.sub")).toBe(true);
    expect(items.some((i) => i.path.includes("/assets/"))).toBe(false);
    const raw = items.find((i) => i.name === "RAW_0042.sub");
    expect(raw?.fields.map(([k]) => k)).toEqual(["Frequency", "Preset", "Protocol"]);
    await m.storage.rename("/ext/subghz/RAW_0042.sub", "/ext/subghz/first.sub");
    const after = await m.library.scan();
    expect(after.find((i) => i.name === "first.sub")?.meta).toBe("433.92 MHz");
  });

  it("walks the menu with the keys and opens apps", async () => {
    const frames: ScreenFrame[] = [];
    const s = m.screen.stream((f) => frames.push(f), 15);
    await new Promise((r) => setTimeout(r, 0));
    expect(frames.at(-1)?.label).toBe("Sub-GHz");
    await m.input.send("back", "short");
    expect(frames.at(-1)?.label).toBe("the main menu");
    await m.input.send("down", "short");
    await m.input.send("ok", "short");
    expect(frames.at(-1)?.label).toBe("RFID 125 kHz");
    await m.apps.start("Infrared");
    expect(frames.at(-1)?.label).toBe("Infrared");
    expect(frames.at(-1)?.data).toHaveLength(1024);
    s.stop();
  });

  it("can't be connected to while it restarts", async () => {
    const back = m.device.reboot();
    expect(m.connection.current()).toMatchObject({ status: "disconnected", ports: [] });
    await expect(m.connection.connect()).rejects.toMatchObject({ code: "disconnected" });
    expect(m.connection.current().error).toBe("disconnected");
    await back;
    expect(m.connection.current().ports).toHaveLength(1);
    await m.connection.connect();
    expect(m.connection.current().status).toBe("connected");
  }, 6000);

  it("stops a firmware install when the cable comes out", async () => {
    const steps: number[] = [];
    const going = m.firmware.install({ version: "1.4.0", channel: "release" }, (p) => {
      steps.push(p.step);
      if (steps.length === 3) m.unplug();
    });
    await expect(going).rejects.toMatchObject({ code: "disconnected" });
    expect(m.connection.current().status).toBe("disconnected");
    expect(steps).toHaveLength(3);
  });

  it("installs, carrying on from copied files after a pulled cable", async () => {
    const release = { version: "1.4.0", channel: "release" as const };
    const steps: number[] = [];
    const first = m.firmware.install(release, (p) => {
      steps.push(p.step);
      if (p.step === 3 && p.pct === 100) m.unplug();
    });
    await expect(first).rejects.toMatchObject({ code: "disconnected" });
    m.plug();
    await m.connection.connect();
    log.length = 0;
    const states: string[] = [];
    m.connection.subscribe((s) => states.push(s.status));
    await m.firmware.install(release, () => {});
    expect(log.filter((e) => e.name === "storage_write_request").map((e) => e.detail)).toEqual(["/int/.region_data"]);
    expect(log.some((e) => e.name === "storage_md5sum_request")).toBe(true);
    expect(states).toContain("disconnected");
    expect(m.connection.current()).toMatchObject({ status: "connected", info: { firmware: "1.4.0" } });
  }, 15000);

  it("stops an install on Cancel before the Flipper starts installing", async () => {
    const ac = new AbortController();
    const going = m.firmware.install(
      { version: "1.4.0", channel: "release" },
      (p) => {
        if (p.step === 1) ac.abort();
      },
      ac.signal,
    );
    await expect(going).rejects.toMatchObject({ code: "cancelled" });
    expect(log.some((e) => e.name === "system_update_request")).toBe(false);
  });

  it("backs up with and without the SD card, and restores", async () => {
    const before = (await m.backup.list()).backups.length;
    const rec = await m.backup.create({ sd: true });
    expect(rec.sd).toBe(true);
    const list = await m.backup.list();
    expect(list.backups).toHaveLength(before + 1);
    expect(list.sdCopy).toBe(rec.created);
    await m.backup.restore(rec.id, { sd: true });
    /* restoring restarts the Flipper, like the real one */
    expect(m.connection.current().status).toBe("disconnected");
    await expect(m.backup.restore("nope", { sd: false })).rejects.toMatchObject({ code: "disconnected" });
  }, 10000);

  it("hands the command line to the Console and takes it back", async () => {
    let out = "";
    const dec = new TextDecoder();
    const link = await m.cli.attach((b) => (out += dec.decode(b)));
    expect(m.connection.current().console).toBe(true);
    /* everything else waits while the Console has it */
    await expect(m.storage.list("/ext")).rejects.toMatchObject({ code: "console-open" });
    await link.write("hlep");
    await link.write("\x7f\x7f\x7felp\r");
    expect(out).toContain("Try: info device");
    /* odd commands don't break it; Ctrl+C drops a line */
    for (const cmd of ["constructor", "toString", "__proto__"]) await link.write(`${cmd}\r`);
    expect(out).toContain("`__proto__` command not found");
    await link.write("storage\x03");
    expect(out.endsWith("^C\r\n>: ")).toBe(true);
    await link.detach();
    expect(m.connection.current().console).toBe(false);
    expect(await names("/ext")).toContain("subghz");
    expect(log.map((e) => e.name)).toEqual(expect.arrayContaining(["stop_session", "start_rpc_session"]));
  });
});
