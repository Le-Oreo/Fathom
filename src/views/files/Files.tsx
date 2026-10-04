import { isTauri } from "@tauri-apps/api/core";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import type { FileEntry } from "../../device/api";
import {
  baseName,
  fmtDate,
  fmtSize,
  isHidden,
  kindOf,
  labelOf,
  listing,
  parentOf,
  rootOf,
  ROOTS,
  subfolders,
  visible,
  type SortKey,
  isUnder,
} from "../../files/logic";
import { useOnEnter } from "../../hooks";
import {
  clearSel,
  deleteItems,
  downloadItems,
  ensureTree,
  goUp,
  loadListing,
  makeFolder,
  openItem,
  openMover,
  openPath,
  rangeSel,
  renameItem,
  selectAll,
  selectedNames,
  selectOnly,
  setFilter,
  sortBy,
  toggleSel,
  toggleSelecting,
  toggleTwisty,
  pickAndUpload,
  pickAndUploadFolder,
  uploadFiles,
  useFiles,
} from "../../state/files";
import { setPref, useSettings } from "../../state/settings";
import { useDevice } from "../../state/device";
import { linkFolder, loadLinks, syncFolder, unlinkFolder, useSync } from "../../state/sync";
import { cancelTransfer, retryTransfer, useTransfers } from "../../state/transfers";
import { View } from "../View";
import { pointerKind, startDrag, useGhost } from "./drag";

const plural = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

/* A click or tap on a file or folder. */
function fileClick(e: React.MouseEvent, f: FileEntry) {
  if ((e.target as Element).closest("button")) return;
  const s = useFiles.getState(),
    p = useSettings.getState().prefs;
  if (e.shiftKey && s.anchor) return rangeSel(f.name);
  if (e.metaKey || e.ctrlKey || s.selecting) return toggleSel(f.name);
  if ((f.dir ? p.openFolders : p.openFiles) === "1") {
    if (e.detail <= 1 || pointerKind() !== "mouse") openItem(f.name, f.dir);
    return;
  }
  selectOnly(f.name); /* double-click mode: the double-click opens it */
}
function fileDoubleClick(e: React.MouseEvent, f: FileEntry) {
  if ((e.target as Element).closest("button") || e.metaKey || e.ctrlKey || e.shiftKey || useFiles.getState().selecting)
    return;
  const p = useSettings.getState().prefs;
  if ((f.dir ? p.openFolders : p.openFiles) === "2") openItem(f.name, f.dir);
}
function rowAction(kind: string, name: string) {
  const sel = useFiles.getState().sel;
  if (kind === "download") return downloadItems([name]);
  if (kind === "move") return void openMover(sel.has(name) ? selectedNames() : [name]);
  if (kind === "rename") return void renameItem(name);
  if (kind === "delete") return void deleteItems(sel.has(name) && sel.size > 1 ? selectedNames() : [name]);
}

function TreeNode({ p, depth, openSet }: { p: string; depth: number; openSet: Set<string> }) {
  const listings = useFiles((s) => s.listings);
  const path = useFiles((s) => s.path);
  const hidden = useSettings((s) => s.prefs.hidden);
  const kids = subfolders(listings, p, hidden),
    open = openSet.has(p),
    root = rootOf(p);
  return (
    <>
      <div className="tnode" style={{ "--d": depth } as React.CSSProperties}>
        {kids.length ? (
          <button
            className="twisty"
            data-twisty={p}
            aria-expanded={open}
            aria-label={`${open ? "Close" : "Open"} ${labelOf(p)}`}
            onClick={() => toggleTwisty(p)}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        ) : (
          <span className="twisty" />
        )}
        <button className="item" data-path={p} data-drop={p} aria-pressed={p === path} onClick={() => void openPath(p)}>
          <Icon name={root ? root[2] : p === path ? "folder-open" : "folder"} size={16} />
          <span className="grow">{labelOf(p)}</span>
        </button>
      </div>
      {open && kids.map((k) => <TreeNode key={k} p={k} depth={depth + 1} openSet={openSet} />)}
    </>
  );
}

function Tree() {
  const open = useFiles((s) => s.open);
  const path = useFiles((s) => s.path);
  const openSet = new Set(open);
  for (let a = path; a; a = parentOf(a)) openSet.add(a);
  return (
    <section className="panel tree rise" id="tree" aria-label="Folders">
      <div className="tree-head">Folders</div>
      {ROOTS.map(([p]) => (
        <TreeNode key={p} p={p} depth={0} openSet={openSet} />
      ))}
    </section>
  );
}

function Crumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  const steps = parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
  return (
    <div className="crumbs" id="crumbs">
      {steps.map((acc, i) =>
        i === steps.length - 1 ? (
          <b key={acc}>{labelOf(acc)}</b>
        ) : (
          <Fragment key={acc}>
            <button data-path={acc} data-drop={acc} onClick={() => void openPath(acc)}>
              {labelOf(acc)}
            </button>
            <Icon name="chevron-right" size={14} />
          </Fragment>
        ),
      )}
    </div>
  );
}

const inApp = isTauri();

function FolderSync() {
  const links = useSync((s) => s.links);
  const path = useFiles((s) => s.path);
  const on = useDevice((s) => s.status === "connected");
  useEffect(() => {
    if (on && links === null) void loadLinks();
  }, [on, links]);
  const here = path.startsWith("/ext/");
  return (
    <section className="panel rise" id="folder-sync">
      <div className="panel-head">
        <h2>
          <Icon name="refresh" />
          Folder sync
        </h2>
        <button
          className="link"
          data-action="link-folder"
          disabled={!here}
          title={here ? undefined : "Open a folder on the SD card first"}
          onClick={() => void linkFolder(path)}
        >
          Link a folder to {here ? baseName(path) : "this folder"}
        </button>
      </div>
      {links?.length ? (
        links.map((l) => (
          <div className="setting" key={l.id} data-link={l.remote}>
            <span>
              <b className="mono">{l.remote}</b>
              <span className="muted">From {l.local}, one way: computer to Flipper</span>
            </span>
            <div className="actions">
              <button className="btn" data-action="sync-folder" onClick={() => void syncFolder(l)}>
                <Icon name="refresh" size={16} />
                Sync
              </button>
              <button
                className="btn icon"
                aria-label={`Unlink ${l.remote}`}
                data-tip="Unlink"
                data-action="unlink-folder"
                onClick={() => void unlinkFolder(l)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
        ))
      ) : (
        <p className="note sync-note">
          <Icon name="info" />
          Link a folder on this computer to the folder open here. Sync then copies what's new or changed, and shows you
          everything first.
        </p>
      )}
    </section>
  );
}

function Transfers() {
  const all = useTransfers((s) => s.list);
  if (!all.length) return <div className="empty">No transfers yet.</div>;
  const active = all.filter((t) => t.state === "running" || t.state === "queued");
  const list = [...active, ...all.filter((t) => !active.includes(t)).slice(0, Math.max(0, 6 - active.length))];
  return (
    <>
      {list.map((t) => {
        const doing = t.state === "running",
          waiting = t.state === "queued",
          failed = t.state === "failed" || t.state === "cancelled";
        const verb = failed
          ? t.state === "cancelled"
            ? "Cancelled"
            : `Couldn't ${t.down ? "download" : "upload"}`
          : waiting
            ? "Waiting to " + (t.down ? "download" : "upload")
            : doing
              ? t.down
                ? "Downloading"
                : "Uploading"
              : t.down
                ? "Downloaded"
                : t.note === "Already there"
                  ? "Already there:"
                  : "Uploaded";
        return (
          <div className={doing ? "transfer" : "transfer done"} key={t.id} data-transfer={t.state}>
            <div className="top">
              <span title={t.error}>
                {verb} <span className="mono">{t.name}</span>
                {t.note && t.note !== "Already there" && <span className="muted"> ({t.note})</span>}
              </span>
              <span className="pct">
                {doing ? `${t.pct}%` : waiting ? "" : <Icon name={failed ? "x" : "check"} size={15} />}
                {(doing || waiting) && (
                  <button
                    className="link tr-act"
                    data-action="cancel-transfer"
                    aria-label={`Cancel ${t.name}`}
                    onClick={() => cancelTransfer(t.id)}
                  >
                    Cancel
                  </button>
                )}
                {failed && (
                  <button
                    className="link tr-act"
                    data-action="retry-transfer"
                    aria-label={`Retry ${t.name}`}
                    onClick={() => retryTransfer(t.id)}
                  >
                    Retry
                  </button>
                )}
              </span>
            </div>
            {doing && (
              <div className="bar stripes">
                <i style={{ width: `${t.pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function DragGhost() {
  const g = useGhost((s) => s.ghost);
  if (!g) return null;
  return createPortal(
    <div
      className="drag-ghost"
      id="drag-ghost"
      style={{ transform: `translate(${Math.round(g.x + 14)}px, ${Math.round(g.y + 14)}px)` }}
    >
      <Icon name={g.icon} size={16} />
      <span>{g.label}</span>
    </div>,
    document.body,
  );
}

export function Files() {
  const { listings, path, sel, filter, selecting, sortDir, fresh, noSd } = useFiles();
  const sdMissing = noSd && isUnder(path, "/ext");
  const prefs = useSettings((s) => s.prefs);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => startDrag(), []);
  useOnEnter("files", () => {
    void loadListing(useFiles.getState().path);
    void ensureTree();
  });

  /* no SD card: what was read before isn't there any more */
  const all = sdMissing ? [] : (listings.get(path) ?? []);
  const rows = listing(all, {
    filter,
    sortBy: prefs.sortBy as SortKey,
    sortDir,
    foldersFirst: prefs.foldersFirst,
    hidden: prefs.hidden,
  });
  const grid = prefs.fileView === "grid";
  const hiddenCount = prefs.hidden ? 0 : all.filter((f) => isHidden(f.name)).length;
  const parent = parentOf(path);
  const n = sel.size;
  const ariaSort = (key: SortKey) => (prefs.sortBy === key ? (sortDir > 0 ? "ascending" : "descending") : "none");
  const empty = sdMissing
    ? "There's no SD card in the Flipper. Put one in and open this folder again, or use Internal storage."
    : filter
      ? `Nothing here matches “${filter}”.`
      : hiddenCount
        ? "Only hidden files are here. Turn on Show hidden files in Settings to see them."
        : "This folder is empty. Drop files here to add some.";
  const countOf = (f: FileEntry) => {
    const kids = listings.get(`${path}/${f.name}`);
    return kids ? plural(visible(kids, prefs.hidden).length) : "";
  };
  const upload = () =>
    void pickAndUpload(path).then((handled) => {
      if (!handled) input.current?.click();
    });

  return (
    <View id="files">
      <div className="head rise">
        <div>
          <h1 id="h-files">Files</h1>
          <Crumbs path={path} />
        </div>
        <div className="actions">
          <button
            className="btn icon"
            id="files-up"
            aria-label="Up one folder"
            data-tip="Up one folder"
            disabled={!parent}
            data-drop={parent}
            data-action="up"
            onClick={goUp}
          >
            <Icon name="folder-up" />
          </button>
          <button className="btn" data-action="mkdir" onClick={() => void makeFolder()}>
            <Icon name="plus" />
            New folder
          </button>
          <button className="btn" data-action="download" onClick={() => downloadItems(selectedNames())}>
            <Icon name="install" />
            Download
          </button>
          {inApp && (
            <button className="btn" data-action="upload-folder" onClick={() => void pickAndUploadFolder(path)}>
              <Icon name="folder-input" />
              Upload folder
            </button>
          )}
          <button className="btn primary" data-action="upload" onClick={upload}>
            <Icon name="upload" />
            Upload
          </button>
          <input
            type="file"
            id="file-input"
            multiple
            hidden
            ref={input}
            onChange={(e) => {
              uploadFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div className="files">
        <Tree />
        <div className="files-main">
          <div className="ftools rise">
            <label className="field grow">
              <Icon name="search" size={16} />
              <input
                type="search"
                id="file-filter"
                placeholder="Filter this folder"
                aria-label="Filter this folder"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <div className="seg" role="radiogroup" aria-label="View">
              <button
                type="button"
                role="radio"
                data-pref="fileView"
                data-val="list"
                aria-label="List"
                data-tip="List"
                aria-checked={!grid}
                onClick={() => setPref("fileView", "list")}
              >
                <Icon name="list" size={16} />
              </button>
              <button
                type="button"
                role="radio"
                data-pref="fileView"
                data-val="grid"
                aria-label="Grid"
                data-tip="Grid"
                aria-checked={grid}
                onClick={() => setPref("fileView", "grid")}
              >
                <Icon name="apps" size={16} />
              </button>
            </div>
            <button
              className="btn"
              id="file-select"
              aria-pressed={selecting}
              data-action="select-mode"
              onClick={toggleSelecting}
            >
              <Icon name="square-check" size={16} />
              Select
            </button>
          </div>
          <div className="selbar" id="selbar" hidden={!(n >= 2 || selecting)}>
            <b id="sel-count">{n ? `${n} selected` : "Tap items to select them"}</b>
            <span className="grow" />
            <button className="btn" data-action="sel-all" onClick={selectAll}>
              Select all
            </button>
            <button
              className="btn"
              disabled={!n}
              data-action="sel-move"
              onClick={() => void openMover(selectedNames())}
            >
              <Icon name="folder-input" size={16} />
              Move to
            </button>
            <button
              className="btn"
              disabled={!n}
              data-action="sel-download"
              onClick={() => downloadItems(selectedNames())}
            >
              <Icon name="install" size={16} />
              Download
            </button>
            <button
              className="btn ghost danger-text"
              disabled={!n}
              data-action="sel-delete"
              onClick={() => void deleteItems(selectedNames())}
            >
              <Icon name="trash" size={16} />
              Delete
            </button>
            <button
              className="btn icon ghost"
              aria-label="Done selecting"
              data-tip="Done"
              data-action="sel-done"
              onClick={clearSel}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <section className="panel rise file-panel" id="file-panel" data-drop-here>
            <table id="file-table" hidden={grid}>
              <thead>
                <tr>
                  <th scope="col" data-sort="name" aria-sort={ariaSort("name")}>
                    <button className="sort" data-sortby="name" onClick={() => sortBy("name")}>
                      Name
                      <Icon name="chevron-down" size={14} />
                    </button>
                  </th>
                  <th scope="col" data-sort="size" style={{ width: 96 }} aria-sort={ariaSort("size")}>
                    <button className="sort" data-sortby="size" onClick={() => sortBy("size")}>
                      Size
                      <Icon name="chevron-down" size={14} />
                    </button>
                  </th>
                  <th scope="col" data-sort="date" style={{ width: 150 }} aria-sort={ariaSort("date")}>
                    <button className="sort" data-sortby="date" onClick={() => sortBy("date")}>
                      Modified
                      <Icon name="chevron-down" size={14} />
                    </button>
                  </th>
                  <th scope="col" style={{ width: 150 }}>
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody id="file-rows">
                {rows.length ? (
                  rows.map((f) => {
                    const p = `${path}/${f.name}`,
                      k = kindOf(f.name, f.dir);
                    return (
                      <tr
                        key={f.name}
                        data-file={f.name}
                        data-dir={f.dir ? 1 : 0}
                        data-drop={f.dir ? p : undefined}
                        aria-selected={sel.has(f.name)}
                        tabIndex={0}
                        className={fresh.has(p) ? "new" : undefined}
                        onClick={(e) => fileClick(e, f)}
                        onDoubleClick={(e) => fileDoubleClick(e, f)}
                      >
                        <td>
                          <span className="cell-name">
                            <Icon name={k.icon} size={17} />
                            <span className={f.dir ? "nm" : "nm mono"}>{f.name}</span>
                            {f.dir && <span className="count">{countOf(f)}</span>}
                          </span>
                        </td>
                        <td className="num">{f.dir ? "" : fmtSize(f.size)}</td>
                        <td className="num">{fmtDate(f.modified)}</td>
                        <td>
                          <div className="row-tools">
                            {!f.dir && (
                              <button
                                data-row="download"
                                aria-label={`Download ${f.name}`}
                                data-tip="Download"
                                onClick={() => rowAction("download", f.name)}
                              >
                                <Icon name="install" size={16} />
                              </button>
                            )}
                            <button
                              data-row="move"
                              aria-label={`Move ${f.name}`}
                              data-tip="Move to"
                              onClick={() => rowAction("move", f.name)}
                            >
                              <Icon name="folder-input" size={16} />
                            </button>
                            <button
                              data-row="rename"
                              aria-label={`Rename ${f.name}`}
                              data-tip="Rename"
                              onClick={() => rowAction("rename", f.name)}
                            >
                              <Icon name="pencil" size={16} />
                            </button>
                            <button
                              data-row="delete"
                              aria-label={`Delete ${f.name}`}
                              data-tip="Delete"
                              onClick={() => rowAction("delete", f.name)}
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty">
                        <Icon name="folder" size={22} />
                        {empty}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="fgrid" id="fgrid" hidden={!grid}>
              {rows.length ? (
                rows.map((f) => {
                  const p = `${path}/${f.name}`,
                    k = kindOf(f.name, f.dir);
                  return (
                    <div
                      key={f.name}
                      className={fresh.has(p) ? "tile new" : "tile"}
                      role="button"
                      tabIndex={0}
                      data-file={f.name}
                      data-dir={f.dir ? 1 : 0}
                      data-drop={f.dir ? p : undefined}
                      aria-selected={sel.has(f.name)}
                      onClick={(e) => fileClick(e, f)}
                      onDoubleClick={(e) => fileDoubleClick(e, f)}
                    >
                      <span className="big">
                        <Icon name={k.icon} size={28} />
                      </span>
                      <b className={f.dir ? "" : "mono"}>{f.name}</b>
                      <span className="meta">{f.dir ? countOf(f) : fmtSize(f.size)}</span>
                    </div>
                  );
                })
              ) : (
                <div className="empty">
                  <Icon name="folder" size={22} />
                  {empty}
                </div>
              )}
            </div>
            <p className="files-note" id="files-note" hidden={!hiddenCount || !rows.length}>
              {hiddenCount} hidden item{hiddenCount === 1 ? "" : "s"} not shown
            </p>
          </section>
          <p className="files-tip rise" id="files-tip">
            <Icon name="move" size={15} />
            <span>Drag anything onto a folder to move it. On a touch screen, press and hold first.</span>
          </p>
          <div className="files-bottom">
            <button
              className={over ? "drop rise over" : "drop rise"}
              id="drop"
              data-action="upload"
              onClick={upload}
              onDragEnter={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                uploadFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <span className="ico">
                <Icon name="upload" size={24} />
              </span>
              <span>
                <b>Drop files or folders to upload</b>
                <span id="drop-hint">
                  They go to <span className="mono">{path}</span>
                </span>
              </span>
            </button>
            <section className="panel rise">
              <div className="panel-head">
                <h2>
                  <Icon name="refresh" />
                  Transfers
                </h2>
              </div>
              <div className="pad" id="transfers">
                <Transfers />
              </div>
            </section>
            <FolderSync />
          </div>
        </div>
      </div>
      <DragGhost />
    </View>
  );
}
