import { useEffect, useRef } from "react";
import { allFolders, blockedFor, rootOf } from "../files/logic";
import { closeMover, pickMoveTarget, useFiles } from "../state/files";
import { useSettings } from "../state/settings";
import { Icon } from "./Icon";

export function Mover() {
  const m = useFiles((s) => s.mover);
  const listings = useFiles((s) => s.listings);
  const hidden = useSettings((s) => s.prefs.hidden);
  const dlg = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (m && !d.open) {
      d.returnValue = "";
      d.showModal();
    }
    if (!m && d.open) d.close();
  }, [m]);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    const onClose = () => useFiles.getState().mover && closeMover(d.returnValue === "ok");
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, []);

  const names = m?.names ?? [];
  return (
    <dialog id="mover" aria-labelledby="mv-title" ref={dlg}>
      <form method="dialog" className="dlg">
        <h2 id="mv-title">{names.length === 1 ? `Move ${names[0]} to…` : `Move ${names.length} items to…`}</h2>
        <p>Pick a folder.</p>
        <div className="mv-list" id="mv-list">
          {m &&
            allFolders(listings, hidden).map(({ path, depth, label }) => {
              const here = path === m.from,
                root = rootOf(path);
              return (
                <button
                  key={path}
                  type="button"
                  className="item"
                  data-mv={path}
                  style={{ "--d": depth } as React.CSSProperties}
                  aria-pressed={m.to === path}
                  disabled={here || blockedFor(names, m.from, path)}
                  onClick={() => pickMoveTarget(path)}
                >
                  <Icon name={root ? root[2] : "folder"} size={16} />
                  <span className="grow">{label}</span>
                  {here && <span className="end">Here now</span>}
                </button>
              );
            })}
        </div>
        <div className="dlg-actions">
          <button value="ok" className="btn primary" id="mv-ok" disabled={!m?.to}>
            Move here
          </button>
          <button value="cancel" className="btn">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
