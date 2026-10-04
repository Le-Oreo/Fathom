import { useEffect, useMemo, useRef, useState } from "react";
import { APPS, categoryById } from "../catalog";
import { allFolders } from "../files/logic";
import type { IconName } from "../icon-map";
import { SECTIONS, SHOWN_SETTINGS } from "../settings/schema";
import { checkUpdates, openApp, playAlert, reboot } from "../state/actions";
import { backupNow, showBackups } from "../state/backups";
import { clearOutput } from "../state/console";
import { useDeviceName } from "../state/device";
import { ensureTree, makeFolder, openPath, useFiles } from "../state/files";
import { install } from "../state/firmware";
import { catItems, pickCategory, pickSignal, useLibrary } from "../state/library";
import { screenshot } from "../state/screen";
import { getPrefs, setPref, useSettings } from "../state/settings";
import { closePalette, gotoSetting, show, toast, useUi } from "../state/ui";
import { NAV_ICONS, TITLES, VIEWS } from "../views";
import { Icon } from "./Icon";

interface Item {
  group: string;
  icon: IconName;
  label: string;
  hint?: string;
  run: () => void;
}

function useItems(open: boolean): Item[] {
  const name = useDeviceName();
  const listings = useFiles((s) => s.listings);
  const library = useLibrary((s) => s.items);
  const hidden = useSettings((s) => s.prefs.hidden);
  useEffect(() => {
    if (open) void ensureTree();
  }, [open]);
  return useMemo(() => {
    if (!open) return [];
    const go: Item[] = VIEWS.map((v, i) => ({
      group: "Go to",
      icon: NAV_ICONS[v],
      label: TITLES[v],
      hint: String(i + 1),
      run: () => show(v),
    }));
    const acts: [string, IconName, () => void][] = [
      ["Take a screenshot", "camera", () => screenshot()],
      [`Back up ${name}`, "archive", () => void backupNow()],
      ["Restore from a backup", "clock", showBackups],
      [`Restart ${name}`, "power", () => void reboot()],
      [`Play a sound on ${name}`, "bell", () => void playAlert()],
      ["Check for updates", "refresh", () => void checkUpdates()],
      [
        "Install the latest firmware",
        "install",
        () => {
          show("firmware");
          void install();
        },
      ],
      [
        "Upload files",
        "upload",
        () => {
          show("files");
          document.getElementById("file-input")?.click();
        },
      ],
      [
        "Clear the console",
        "trash",
        () => {
          clearOutput();
          show("console");
        },
      ],
      [
        "New folder here",
        "plus",
        () => {
          show("files");
          void makeFolder();
        },
      ],
      [
        "Show or hide hidden files",
        "eye",
        () => {
          setPref("hidden", !getPrefs().hidden);
          toast(getPrefs().hidden ? "Showing hidden files" : "Hiding hidden files", "eye");
        },
      ],
      [
        "Switch the file view",
        "apps",
        () => {
          setPref("fileView", getPrefs().fileView === "grid" ? "list" : "grid");
          show("files");
        },
      ],
    ];
    const actions: Item[] = acts.map(([label, icon, run]) => ({ group: "Actions", icon, label, run }));
    const apps: Item[] = APPS.map((a) => ({
      group: "Open on Flipper",
      icon: a.icon,
      label: a.name,
      run: () => void openApp(a),
    }));
    const sigs: Item[] = [...new Set(library.map((i) => i.category))].flatMap((cat) =>
      catItems(library, cat).map((it, i) => ({
        group: "Saved signals",
        icon: categoryById(cat).icon,
        label: it.name,
        hint: categoryById(cat).label,
        run: () => {
          pickCategory(cat);
          pickSignal(i);
          show("library");
        },
      })),
    );
    const folders: Item[] = allFolders(listings, hidden)
      .filter((f) => f.depth > 0)
      .map((f) => ({
        group: "Folders",
        icon: "folder",
        label: f.label,
        hint: f.path,
        run: () => {
          show("files");
          void openPath(f.path);
        },
      }));
    const sets: Item[] = SHOWN_SETTINGS.map((st) => ({
      group: "Settings",
      icon: "settings",
      label: st.label,
      hint: SECTIONS.find((x) => x[0] === st.s)?.[1],
      run: () => gotoSetting(st.id),
    }));
    return [...go, ...actions, ...apps, ...sigs, ...folders, ...sets];
  }, [open, name, listings, library, hidden]);
}

export function Palette() {
  const open = useUi((s) => s.palette);
  return open ? <PaletteOpen /> : null;
}

function PaletteOpen() {
  const items = useItems(true);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return items
      .filter((it) => words.every((w) => `${it.label} ${it.hint || ""} ${it.group}`.toLowerCase().includes(w)))
      .slice(0, 40);
  }, [items, q]);
  const cur = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`opt-${cur}`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const run = (i: number) => {
    const it = shown[i];
    if (!it) return;
    closePalette();
    it.run();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePalette();
      else if (e.key === "ArrowDown" && shown.length) setActive((cur + 1) % shown.length);
      else if (e.key === "ArrowUp" && shown.length) setActive((cur - 1 + shown.length) % shown.length);
      else if (e.key === "Enter") run(cur);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  let last = "";
  return (
    <div className="scrim" id="palette" onClick={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or jump to">
        <div className="q">
          <Icon name="search" size={18} />
          <input
            id="pal-input"
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Search pages, actions and signals"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-res"
            aria-activedescendant={shown.length ? `opt-${cur}` : ""}
          />
          <span className="keycap">Esc</span>
        </div>
        <div className="res" id="pal-res" role="listbox">
          {shown.length ? (
            shown.map((it, i) => {
              const head = it.group !== last ? <div className="grp">{it.group}</div> : null;
              last = it.group;
              return (
                <div key={`${it.group}-${it.label}-${it.hint ?? ""}`} style={{ display: "contents" }}>
                  {head}
                  <div
                    className="opt"
                    role="option"
                    id={`opt-${i}`}
                    data-opt={i}
                    aria-selected={i === cur}
                    onMouseMove={() => i !== cur && setActive(i)}
                    onClick={() => run(i)}
                  >
                    <Icon name={it.icon} size={17} />
                    <b>{it.label}</b>
                    <span className="hint">{it.hint || ""}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="none">Nothing matches. Try a page name, an action or a signal.</div>
          )}
        </div>
        <div className="foot">
          <span>
            <span className="keycap">↑</span> <span className="keycap">↓</span> to move
          </span>
          <span>
            <span className="keycap">Enter</span> to open
          </span>
        </div>
      </div>
    </div>
  );
}
