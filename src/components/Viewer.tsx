import { useEffect, useRef } from "react";
import { appByName } from "../catalog";
import { baseName, fmtDate, fmtSize, isTextName, kindOf, parentOf, PREVIEW_LIMIT } from "../files/logic";
import { openApp, openFap } from "../state/actions";
import { useDeviceName } from "../state/device";
import {
  cancelEdit,
  closeViewer,
  deleteItems,
  editViewer,
  openMover,
  renameItem,
  saveViewer,
  useFiles,
  type ViewerState,
  downloadFile,
} from "../state/files";

import { Icon } from "./Icon";

const CAPTURES = new Set(["sub", "ir", "nfc", "rfid", "ibtn"]);

function Note({ v, name }: { v: ViewerState; name: string }) {
  const k = kindOf(baseName(v.path), false);
  const [title, body] = CAPTURES.has(k.ext)
    ? ["Fathom shows a saved signal's details, not its contents", `Open it on ${name} to use it, or download a copy.`]
    : isTextName(v.path) && v.entry.size > PREVIEW_LIMIT
      ? ["Too big to preview", "Fathom previews text files up to 256 KB. Download it to read all of it."]
      : ["No preview for this kind of file", "Download it to open it on your computer."];
  return (
    <div className="vw-note">
      <Icon name="info" size={18} />
      <span>
        <b>{title}</b>
        <span>{body}</span>
      </span>
    </div>
  );
}

export function Viewer() {
  const v = useFiles((s) => s.viewer);
  const name = useDeviceName();
  const dlg = useRef<HTMLDialogElement>(null);
  const edit = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (v && !d.open) d.showModal();
    if (!v && d.open) d.close();
  }, [v]);
  useEffect(() => {
    if (v?.editing) edit.current?.focus();
  }, [v?.editing]);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    const onClose = () => useFiles.getState().viewer && closeViewer();
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, []);

  const path = v?.path ?? "",
    dir = parentOf(path),
    file = baseName(path),
    k = kindOf(file, false),
    app = k.app ? appByName(k.app) : null;
  const leave = (then: () => void) => () => {
    closeViewer();
    then();
  };

  return (
    <dialog
      id="viewer"
      className="viewer"
      aria-labelledby="vw-name"
      ref={dlg}
      onClick={(e) => e.target === e.currentTarget && e.detail < 2 && closeViewer()}
    >
      {v && (
        <div className="vw">
          <div className="vw-head">
            <span className="vw-ico" id="vw-ico">
              <Icon name={k.icon} size={22} />
            </span>
            <div className="vw-title">
              <b id="vw-name" className="mono">
                {file}
              </b>
              <span id="vw-path" className="mono">
                {dir}
              </span>
            </div>
            <button
              className="btn icon ghost"
              data-vw="close"
              aria-label="Close"
              data-tip="Close"
              onClick={closeViewer}
            >
              <Icon name="x" />
            </button>
          </div>
          <dl className="vw-info" id="vw-info">
            {[
              ["Type", k.label],
              ["Size", fmtSize(v.entry.size)],
              ["Modified", fmtDate(v.entry.modified)],
              ["Folder", dir],
            ].map(([a, b]) => (
              <div key={a}>
                <dt>{a}</dt>
                <dd className={a === "Folder" ? "mono" : undefined}>{b}</dd>
              </div>
            ))}
          </dl>
          <div className="vw-body" id="vw-body">
            {v.editing ? (
              <textarea
                className="vw-edit"
                id="vw-edit"
                spellCheck={false}
                aria-label={`Edit ${file}`}
                defaultValue={v.text ?? ""}
                ref={edit}
              />
            ) : v.text !== null ? (
              <pre className="vw-text" id="vw-text">
                {v.text}
              </pre>
            ) : (
              <Note v={v} name={name} />
            )}
          </div>
          <div className="vw-foot" id="vw-foot">
            {v.editing ? (
              <>
                <button
                  className="btn primary"
                  data-vw="save"
                  onClick={() => void saveViewer(edit.current?.value ?? "")}
                >
                  <Icon name="save" size={16} />
                  Save
                </button>
                <button className="btn" data-vw="cancel" onClick={cancelEdit}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {(k.ext === "fap" || app) && (
                  <button
                    className="btn primary"
                    data-vw="flipper"
                    onClick={leave(() => void (k.ext === "fap" ? openFap(path) : app && openApp(app, path)))}
                  >
                    <Icon name="arrow-up-right" size={16} />
                    Open on {name}
                  </button>
                )}
                {v.text !== null && (
                  <button className="btn" data-vw="edit" onClick={editViewer}>
                    <Icon name="pencil" size={16} />
                    Edit
                  </button>
                )}
                <button className="btn" data-vw="download" onClick={() => void downloadFile(file, dir)}>
                  <Icon name="install" size={16} />
                  Download
                </button>
                <button className="btn" data-vw="move" onClick={leave(() => void openMover([file], dir))}>
                  <Icon name="folder-input" size={16} />
                  Move
                </button>
                <button className="btn" data-vw="rename" onClick={leave(() => void renameItem(file, dir))}>
                  <Icon name="text-cursor-input" size={16} />
                  Rename
                </button>
                <button
                  className="btn ghost danger-text"
                  data-vw="delete"
                  onClick={leave(() => void deleteItems([file], dir))}
                >
                  <Icon name="trash" size={16} />
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
