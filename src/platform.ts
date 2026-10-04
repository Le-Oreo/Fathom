import { invoke, isTauri } from "@tauri-apps/api/core";
import { iconThumb } from "./appicons";
import type { UploadSource } from "./device/api";

export function downloadBlob(name: string, data: string | Blob) {
  const a = document.createElement("a");
  const url = typeof data === "string" ? data : URL.createObjectURL(data);
  a.href = url;
  a.download = name;
  a.click();
  if (typeof data !== "string") setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function setAppIcon(id: string) {
  if (isTauri()) return invoke("app_icon_set", { id }).catch(() => {});
  const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) return;
  link.dataset.classic ??= link.href;
  link.href = id === "classic" ? link.dataset.classic : iconThumb(id);
}

export async function saveFile(name: string, data: Uint8Array, type: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("file_save", data, { headers: { "x-name": encodeURIComponent(name) } });
  downloadBlob(name, new Blob([data as BlobPart], { type }));
  return name;
}

export interface DownloadFolder {
  token: string;
  label: string;
}
export async function pickDownloadFolder(): Promise<DownloadFolder | null> {
  if (!isTauri()) return { token: "browser", label: "Downloads" };
  return invoke<DownloadFolder | null>("download_folder_pick");
}

export async function pickUploads(): Promise<UploadSource[] | null> {
  if (!isTauri()) return null;
  return invoke<UploadSource[]>("upload_pick");
}

export async function pickUploadFolder(): Promise<UploadSource | null> {
  return invoke<UploadSource | null>("upload_folder_pick");
}

export async function droppedItems(paths: string[]): Promise<UploadSource[]> {
  return invoke<UploadSource[]>("dropped_items", { paths });
}

export async function appDiagnostics(extra: { connection: string; log: string[] }): Promise<string> {
  if (isTauri()) return invoke<string>("diagnostics");
  return [
    `FATHOM ${__APP_VERSION__} (browser build)`,
    navigator.userAgent,
    extra.connection,
    "",
    "RPC log:",
    ...extra.log,
  ].join("\n");
}

export interface AppRelease {
  version: string;
  url: string;
}
let browserRelease: AppRelease | null = null;
export const setBrowserRelease = (r: AppRelease | null) => (browserRelease = r);
/* A FATHOM release newer than this one, or null. */
export async function appLatest(): Promise<AppRelease | null> {
  if (isTauri()) return invoke<AppRelease | null>("app_latest");
  return browserRelease;
}
export async function openRelease(url: string) {
  if (isTauri()) return invoke("app_release_open", { url });
  window.open(url, "_blank", "noopener");
}
