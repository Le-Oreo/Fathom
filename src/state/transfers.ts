import { create } from "zustand";
import { buddyReact } from "../buddy/bus";
import { api, usingMock } from "../device";
import { sourceName, type Progress, type UploadSource } from "../device/api";
import { errorMessage, isCancel } from "../device/errors";
import { MOCK_TRANSFERS } from "../device/mock-data";
import type { DownloadFolder } from "../platform";
import { logActivity } from "./activity";
import { useDevice } from "./device";
import { toast } from "./ui";

export type TransferState = "queued" | "running" | "done" | "failed" | "cancelled";
export interface Transfer {
  id: number;
  name: string;
  to: string;
  pct: number;
  down: boolean;
  state: TransferState;
  /* why it failed, in plain words */
  error?: string;
  note?: string;
}

let nextId = 0;
const seed = (): Transfer[] =>
  MOCK_TRANSFERS.map((t) => ({ ...t, id: ++nextId, state: t.pct < 100 ? "running" : "done" }));
export const useTransfers = create<{ list: Transfer[] }>(() => ({ list: usingMock ? seed() : [] }));

const uploaded = new Set<(dir: string, name: string, size: number, isDir: boolean) => void>();
export function onUploaded(fn: (dir: string, name: string, size: number, isDir: boolean) => void) {
  uploaded.add(fn);
  return () => void uploaded.delete(fn);
}

function add(t: Omit<Transfer, "id" | "pct" | "state">) {
  const id = ++nextId;
  useTransfers.setState((s) => ({ list: [{ ...t, id, pct: 0, state: "queued" }, ...s.list] }));
  return id;
}
function patch(id: number, p: Partial<Transfer>) {
  useTransfers.setState((s) => ({ list: s.list.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}
const pctOf = (p: Progress) => (p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0);

/* ---------- the queue ---------- */
type Job = (opts: { onProgress: (p: Progress) => void; signal: AbortSignal }) => Promise<string | void>;
const jobs = new Map<number, Job>();
const owners = new Map<number, string>();
const flipperNow = () => useDevice.getState().info?.id ?? "";
const aborts = new Map<number, AbortController>();
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = [...useTransfers.getState().list].reverse().find((t) => t.state === "queued" && jobs.has(t.id));
      if (!next) return;
      if (owners.get(next.id) !== flipperNow()) {
        patch(next.id, { state: "failed", error: "It was for another Flipper. Connect that one and retry." });
        continue;
      }
      const job = jobs.get(next.id)!,
        ctl = new AbortController();
      aborts.set(next.id, ctl);
      patch(next.id, { state: "running", pct: 0, error: undefined });
      try {
        const note = await job({ onProgress: (p) => patch(next.id, { pct: pctOf(p) }), signal: ctl.signal });
        patch(next.id, { state: "done", pct: 100, note: note || undefined });
      } catch (err) {
        const cancelled = isCancel(err) || ctl.signal.aborted;
        patch(next.id, { state: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : errorMessage(err) });
        if (!cancelled) toast(errorMessage(err), "info", true);
      } finally {
        aborts.delete(next.id);
      }
    }
  } finally {
    pumping = false;
  }
}

function enqueue(t: Omit<Transfer, "id" | "pct" | "state">, job: Job) {
  const id = add(t);
  jobs.set(id, job);
  owners.set(id, flipperNow());
  void pump();
  return id;
}

export function cancelTransfer(id: number) {
  const t = useTransfers.getState().list.find((x) => x.id === id);
  if (!t) return;
  const ctl = aborts.get(id);
  if (t.state === "queued" || (t.state === "running" && !ctl)) patch(id, { state: "cancelled" });
  else ctl?.abort();
}

export function retryTransfer(id: number) {
  const t = useTransfers.getState().list.find((x) => x.id === id);
  if (!t || !jobs.has(id) || (t.state !== "failed" && t.state !== "cancelled")) return;
  if (owners.get(id) !== flipperNow())
    return toast("That was for another Flipper. Connect that one to retry it.", "usb", true);
  /* back to the top of the list, waiting its turn */
  useTransfers.setState((s) => ({
    list: [{ ...t, state: "queued", pct: 0, error: undefined, note: undefined }, ...s.list.filter((x) => x.id !== id)],
  }));
  void pump();
}

/* ---------- uploads and downloads ---------- */
export function startUpload(source: UploadSource, to: string) {
  const name = sourceName(source);
  enqueue({ name, to, down: false }, async (opts) => {
    const r = await api.storage.upload(source, to, opts);
    const size = "file" in source ? source.file.size : source.size;
    uploaded.forEach((fn) => fn(to, r.name, size, !("file" in source) && source.dir));
    const all = r.files > 0 && r.skipped === r.files;
    if (all) {
      toast(`${r.name} is already on the Flipper`, "check");
      return "Already there";
    }
    toast(`Uploaded ${r.name}`, "upload");
    buddyReact("uploaded");
    logActivity("upload", `Uploaded ${r.name}`);
    return r.skipped ? `${r.skipped} of ${r.files} already there` : undefined;
  });
}

export function startDownload(name: string, from: string, dir: boolean, folder: DownloadFolder) {
  enqueue({ name, to: folder.label, down: true }, async (opts) => {
    const saved = await api.storage.download(`${from}/${name}`, dir, folder.token, opts);
    toast(`Downloaded ${saved} to ${folder.label}`, "install");
    buddyReact("downloaded");
  });
}

export function startSync(
  label: string,
  to: string,
  run: (opts: { onProgress: (p: Progress) => void; signal: AbortSignal }) => Promise<string | void>,
) {
  enqueue({ name: label, to, down: false }, run);
}

export const transfersActive = () =>
  useTransfers.getState().list.some((t) => (t.state === "queued" || t.state === "running") && jobs.has(t.id));
