import { create } from "zustand";
import { canMoveInto, kindOf } from "../../files/logic";
import type { IconName } from "../../icon-map";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { droppedItems } from "../../platform";
import { moveItems, openPath, uploadFiles, uploadSources, useFiles } from "../../state/files";
import { getPrefs } from "../../state/settings";
import { useUi } from "../../state/ui";

export interface Ghost {
  label: string;
  icon: IconName;
  x: number;
  y: number;
}
export const useGhost = create<{ ghost: Ghost | null }>(() => ({ ghost: null }));

type Press = { x: number; y: number; name: string; touch: boolean; timer?: number };
let lastPointer = "mouse";
const drag = {
  press: null as Press | null,
  on: false,
  items: [] as string[],
  from: "",
  over: null as HTMLElement | null,
  spring: 0,
  eatClick: false,
};

export const pointerKind = () => lastPointer;
export const dragging = () => drag.on;

function source(e: PointerEvent) {
  if (!getPrefs().dragMove || useUi.getState().view !== "files") return null;
  const t = e.target as Element,
    el = t.closest?.<HTMLElement>("#file-rows [data-file], #fgrid [data-file]");
  return el && !t.closest("button, input, a, select, textarea") ? el : null;
}

function begin(x: number, y: number) {
  const p = drag.press;
  if (!p) return;
  clearTimeout(p.timer);
  const s = useFiles.getState();
  const names = s.sel.has(p.name) ? [...s.sel] : [p.name];
  Object.assign(drag, { on: true, items: names, from: s.path, press: null, eatClick: true });
  const first = (s.listings.get(drag.from) ?? []).find((f) => f.name === names[0]);
  useGhost.setState({
    ghost: {
      label: names.length > 1 ? `${names.length} items` : names[0],
      icon: kindOf(names[0], !!first?.dir).icon,
      x,
      y,
    },
  });
  document.body.classList.add("dragging");
  names.forEach((n) =>
    document
      .querySelectorAll(`#file-rows [data-file="${CSS.escape(n)}"], #fgrid [data-file="${CSS.escape(n)}"]`)
      .forEach((el) => el.classList.add("drag-src")),
  );
  navigator.vibrate?.(12);
  move(x, y);
}

function move(x: number, y: number) {
  const g = document.getElementById("drag-ghost");
  if (g) g.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
  else {
    const cur = useGhost.getState().ghost;
    if (cur) useGhost.setState({ ghost: { ...cur, x, y } });
  }
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
  const path = hit?.dataset.drop || "",
    ok = canMoveInto(drag.items, drag.from, path);
  g?.classList.toggle("ok", ok);
  if (hit !== drag.over) {
    drag.over?.classList.remove("drop-ok", "drop-no");
    clearTimeout(drag.spring);
    drag.over = hit;
    if (hit && path) {
      hit.classList.add(ok ? "drop-ok" : "drop-no");
      if (ok && path !== useFiles.getState().path && !hit.matches("#files-up"))
        drag.spring = window.setTimeout(() => {
          hit.classList.remove("drop-ok", "drop-no");
          drag.over = null;
          void openPath(path);
        }, 900);
    }
  }
  const sc = document.getElementById("content");
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  if (y < r.top + 60) sc.scrollBy(0, -16);
  else if (y > r.bottom - 50) sc.scrollBy(0, 16);
}

function end(x: number, y: number) {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]"),
    path = hit?.dataset.drop || "";
  const items = drag.items,
    from = drag.from;
  cancelDrag();
  if (canMoveInto(items, from, path)) void moveItems(items, from, path);
}

export function cancelDrag() {
  clearTimeout(drag.spring);
  if (drag.press) clearTimeout(drag.press.timer);
  useGhost.setState({ ghost: null });
  document.querySelectorAll(".drop-ok, .drop-no").forEach((el) => el.classList.remove("drop-ok", "drop-no"));
  document.body.classList.remove("dragging");
  document.querySelectorAll(".drag-src").forEach((el) => el.classList.remove("drag-src"));
  Object.assign(drag, { press: null, on: false, over: null });
  setTimeout(() => (drag.eatClick = false), 60);
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || drag.on) return;
  const el = source(e);
  if (!el) return;
  const touch = e.pointerType !== "mouse";
  drag.press = { x: e.clientX, y: e.clientY, name: el.dataset.file ?? "", touch };
  if (touch) drag.press.timer = window.setTimeout(() => drag.press && begin(drag.press.x, drag.press.y), 420);
}
function onPointerMove(e: PointerEvent) {
  const p = drag.press;
  if (p && !drag.on) {
    const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (p.touch) {
      if (d > 10) {
        clearTimeout(p.timer); /* moved early: it's a scroll */
        drag.press = null;
      }
    } else if (d > 5) begin(e.clientX, e.clientY);
  }
  if (drag.on) move(e.clientX, e.clientY);
}
function onPointerUp(e: PointerEvent) {
  if (drag.on) end(e.clientX, e.clientY);
  else if (drag.press) {
    clearTimeout(drag.press.timer);
    drag.press = null;
  }
}
/* the click that ends a drag isn't a click on the row */
function onClickCapture(e: MouseEvent) {
  if (!drag.eatClick) return;
  drag.eatClick = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}
/* files from the computer, onto any folder on the page */
function onDragOver(e: DragEvent) {
  const hit = (e.target as Element).closest?.<HTMLElement>("#view-files [data-drop]");
  if (!hit || !e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  document.querySelectorAll(".drop-ok").forEach((el) => el !== hit && el.classList.remove("drop-ok"));
  hit.classList.add("drop-ok");
}
function onDragLeave(e: DragEvent) {
  (e.target as Element).closest?.("[data-drop]")?.classList.remove("drop-ok");
}
function onDrop(e: DragEvent) {
  const hit = (e.target as Element).closest?.<HTMLElement>("#view-files [data-drop]");
  if (!hit || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  hit.classList.remove("drop-ok");
  uploadFiles(Array.from(e.dataTransfer.files), hit.dataset.drop);
}
function dropTarget(pos: { x: number; y: number }) {
  if (useUi.getState().view !== "files") return null;
  const dpr = window.devicePixelRatio || 1;
  return (
    document
      .elementFromPoint(pos.x / dpr, pos.y / dpr)
      ?.closest<HTMLElement>("#view-files [data-drop], #view-files #drop") ?? null
  );
}
/* The big drop area means the folder that's open. */
const dropPath = (hit: HTMLElement) => (hit.id === "drop" ? useFiles.getState().path : hit.dataset.drop);
function lightUp(hit: HTMLElement | null) {
  document.querySelectorAll(".drop-ok, #drop.over").forEach((el) => {
    if (el !== hit) el.classList.remove("drop-ok", "over");
  });
  /* the big drop area has its own look for "over" */
  hit?.classList.add(hit.id === "drop" ? "over" : "drop-ok");
}
function listenForAppDrops() {
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "leave") return lightUp(null);
    const hit = dropTarget(p.position);
    if (p.type !== "drop") return lightUp(hit);
    lightUp(null);
    const to = hit && dropPath(hit);
    if (to && p.paths.length) void droppedItems(p.paths).then((items) => uploadSources(items, to));
  });
}

const notePointer = (e: PointerEvent) => void (lastPointer = e.pointerType || "mouse");
const onCancel = () => void ((drag.on || drag.press) && cancelDrag());
const onTouchMove = (e: TouchEvent) => void (drag.on && e.preventDefault());
const onMenu = (e: MouseEvent) => void ((drag.on || drag.press?.touch) && e.preventDefault());

export function startDrag() {
  document.addEventListener("pointerdown", notePointer, true);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onCancel);
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("contextmenu", onMenu);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  const appDrops = isTauri() ? listenForAppDrops() : null;
  return () => {
    void appDrops?.then((off) => off());
    document.removeEventListener("pointerdown", notePointer, true);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("contextmenu", onMenu);
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("dragleave", onDragLeave);
    document.removeEventListener("drop", onDrop);
  };
}
