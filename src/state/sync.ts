import { create } from "zustand";
import { api } from "../device";
import type { SyncItem, SyncLink } from "../device/api";
import { errorMessage } from "../device/errors";
import { logActivity } from "./activity";
import { refreshFolder } from "./files";
import { startSync } from "./transfers";
import { ask, askWithCheck, toast } from "./ui";

export const useSync = create<{ links: SyncLink[] | null }>(() => ({ links: null }));

export async function loadLinks() {
  try {
    useSync.setState({ links: await api.sync.links() });
  } catch {
    useSync.setState({ links: [] });
  }
}

export async function linkFolder(remote: string) {
  if (!remote.startsWith("/ext/")) return toast("Pick a folder on the SD card to sync into", "folder", true);
  try {
    const l = await api.sync.link(remote);
    if (!l) return;
    await loadLinks();
    toast(`Linked ${l.local} to ${l.remote}`, "folder");
  } catch (err) {
    toast(errorMessage(err), "info", true);
  }
}

export async function unlinkFolder(l: SyncLink) {
  await api.sync.unlink(l.id).catch(() => {});
  await loadLinks();
  toast(`Unlinked ${l.local}. Nothing was deleted.`, "folder");
}

const names = (items: SyncItem[], max = 6) =>
  items.length <= max
    ? items.map((i) => i.rel).join(", ")
    : `${items
        .slice(0, max)
        .map((i) => i.rel)
        .join(", ")} and ${items.length - max} more`;

export async function syncFolder(l: SyncLink) {
  let plan;
  try {
    plan = await api.sync.preview(l.id);
  } catch (err) {
    return toast(errorMessage(err), "info", true);
  }
  const copy = plan.new.length + plan.changed.length;
  if (!copy && !plan.extra.length) return toast(`${l.remote} is already in step with ${l.local}`, "check");
  const lines = [
    plan.new.length ? `New: ${names(plan.new)}.` : "",
    plan.changed.length ? `Changed: ${names(plan.changed)}.` : "",
    plan.same ? `${plan.same} already the same.` : "",
    plan.extra.length ? `Only on the Flipper: ${names(plan.extra)}.` : "",
  ].filter(Boolean);
  const title = copy ? `Copy ${copy} file${copy === 1 ? "" : "s"} to ${l.remote}?` : `Sync ${l.remote}?`;
  let remove: string[] = [];
  if (plan.extra.length) {
    const r = await askWithCheck({
      title,
      body: lines.join(" "),
      ok: copy ? "Sync" : "Continue",
      check: `Also remove the ${plan.extra.length} file${plan.extra.length === 1 ? "" : "s"} only on the Flipper`,
      checked: false,
    });
    if (!r) return;
    if (r.checked) {
      const sure = await ask({
        title: `Remove ${plan.extra.length} file${plan.extra.length === 1 ? "" : "s"} from the Flipper?`,
        body: `${names(plan.extra, 12)}. They're deleted from the SD card. This can't be undone.`,
        ok: "Remove",
        danger: true,
      });
      if (!sure) return;
      remove = plan.extra.map((i) => i.rel);
    }
    if (!copy && !remove.length) return;
  } else if (!(await ask({ title, body: lines.join(" "), ok: "Sync" }))) return;
  startSync(`Sync ${l.local}`, l.remote, async (opts) => {
    const r = await api.sync.apply(l.id, remove, opts);
    void refreshFolder(l.remote);
    logActivity("folder", `Synced ${l.local} to ${l.remote}`);
    toast(`Synced ${l.remote}: ${r.copied} copied${r.removed ? `, ${r.removed} removed` : ""}`, "folder");
    return `${r.copied} copied${r.removed ? `, ${r.removed} removed` : ""}`;
  });
}
