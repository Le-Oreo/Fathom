import {
  clearSel,
  deleteItems,
  goUp,
  openItem,
  renameItem,
  selectAll,
  selectedNames,
  useFiles,
} from "../../state/files";
import { cancelDrag, dragging } from "./drag";

export function filesKey(e: KeyboardEvent) {
  if (dragging() && e.key === "Escape") {
    cancelDrag();
    return true;
  }
  const item = (e.target as Element).closest?.<HTMLElement>("[data-file]"),
    name = item?.dataset.file,
    s = useFiles.getState();
  if (e.key === "Escape" && (s.sel.size || s.selecting)) {
    clearSel();
    return true;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    selectAll();
    return true;
  }
  if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
    goUp();
    return true;
  }
  if (e.key === "Delete") {
    void deleteItems(s.sel.size ? selectedNames() : name ? [name] : []);
    return true;
  }
  if (e.key === "F2") {
    const n = s.sel.size === 1 ? selectedNames()[0] : name;
    if (n) void renameItem(n);
    return true;
  }
  if (item && name && (e.key === "Enter" || e.key === " ")) {
    openItem(name, item.dataset.dir === "1");
    return true;
  }
  if (item && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
    const all = [...document.querySelectorAll<HTMLElement>("#file-rows [data-file], #fgrid [data-file]")],
      i = all.indexOf(item),
      step = /Up|Left/.test(e.key) ? -1 : 1;
    all[Math.max(0, Math.min(all.length - 1, i + step))]?.focus();
    return true;
  }
  return false;
}
