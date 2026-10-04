import { useEffect, useRef, useState } from "react";
import { categoryById, LIBRARY_CATEGORIES } from "../catalog";
import { Icon } from "../components/Icon";
import { fmtDate, fmtDay, fmtSize } from "../files/logic";
import { useDeviceName } from "../state/device";
import {
  catItems,
  deleteSignal,
  downloadSignal,
  openSignal,
  pickCategory,
  pickSignal,
  renameSignal,
  rescan,
  setLibraryFilter,
  setLibraryMark,
  useLibrary,
  visibleRows,
} from "../state/library";
import { addTag, allTags, removeTag, toggleStar, useMarks } from "../state/marks";
import { useSettings } from "../state/settings";
import { View } from "./View";

function MiniWave({ seed, on }: { seed: string; on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const accent = useSettings((s) => s.prefs.accent);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    let s = 0;
    for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const hi = getComputedStyle(document.documentElement).getPropertyValue("--orange-hi").trim() || "#ff9a33";
    ctx.clearRect(0, 0, 64, 14);
    ctx.fillStyle = on ? hi : "#6f6f75";
    let x = 4,
      prev = 0;
    ctx.fillRect(0, 11, 4, 1.5);
    while (x < 64) {
      const one = rnd() < 0.5;
      for (const [lv, w] of [
        [1, one ? 5 : 2],
        [0, one ? 2 : 5],
      ]) {
        if (lv !== prev) ctx.fillRect(x, 2, 1.5, 10.5);
        ctx.fillRect(x, lv ? 2 : 11, Math.min(w + 1, 64 - x), 1.5);
        x += w;
        prev = lv;
      }
    }
  }, [seed, on, accent]);
  return <canvas width={64} height={14} data-wave={seed} aria-hidden="true" ref={ref} />;
}

export function Library() {
  const name = useDeviceName();
  const { items, cat, sel, filter, mark } = useLibrary();
  const marks = useMarks((s) => s.marks);
  const [tagDraft, setTagDraft] = useState("");
  const c = categoryById(cat);
  const list = catItems(items, cat);
  const rows = visibleRows({ items, cat, filter, mark }, marks);
  const shown = rows.find((r) => r.i === sel) ?? rows[0];
  const it = shown?.it;
  const itMark = it ? marks[it.path] : undefined;
  const tags = allTags(marks);

  return (
    <View id="library">
      <div className="head rise">
        <div>
          <h1 id="h-library">Library</h1>
          <p>Every signal saved on {name}, indexed so you can browse offline.</p>
        </div>
        <div className="actions">
          <label className="field" style={{ width: 240 }}>
            <Icon name="search" size={16} />
            <input
              type="search"
              id="lib-search"
              placeholder="Filter signals"
              aria-label="Filter signals"
              value={filter}
              onChange={(e) => setLibraryFilter(e.target.value)}
            />
          </label>
          <button className="btn" data-action="rescan" onClick={() => void rescan()}>
            <Icon name="refresh" />
            Rescan
          </button>
        </div>
      </div>
      <div className="lib">
        <section className="panel rise">
          <div className="cats" id="lib-cats" aria-label="Signal types">
            {LIBRARY_CATEGORIES.map((k) => (
              <button
                key={k.id}
                className="item"
                data-cat={k.id}
                aria-pressed={k.id === cat}
                onClick={() => pickCategory(k.id)}
              >
                <Icon name={k.icon} />
                <span className="grow">{k.label}</span>
                <span className="n">{items.filter((x) => x.category === k.id).length}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel rise">
          <div className="panel-head">
            <h2 id="lib-title">
              <Icon name={c.icon} />
              {c.label}
            </h2>
            <span className="chip" id="lib-count">
              {list.length} saved
            </span>
          </div>
          <div className="lib-marks" id="lib-marks" role="group" aria-label="Show">
            {[["", "All"], ["starred", "Starred"], ...tags.map((t) => [t, `#${t}`])].map(([v, label]) => (
              <button
                key={v || "all"}
                className="mark-chip"
                data-mark={v}
                aria-pressed={mark === v}
                onClick={() => setLibraryMark(v)}
              >
                {v === "starred" && <Icon name="star" size={13} />}
                {label}
              </button>
            ))}
          </div>
          <div className="sig-list" id="lib-list" role="listbox" aria-labelledby="lib-title">
            {rows.length ? (
              rows.map(({ it: row, i }) => (
                <button
                  key={row.path}
                  className="item"
                  role="option"
                  data-sig={i}
                  aria-selected={i === shown?.i}
                  onClick={() => pickSignal(i)}
                >
                  <Icon name={c.icon} />
                  <span className="grow">
                    <span className="name">
                      {row.name}
                      {marks[row.path]?.star && (
                        <span className="star-on" aria-label="Starred">
                          <Icon name="star" size={12} />
                        </span>
                      )}
                    </span>
                    <span className="meta">
                      <span className="mono">{row.meta}</span>&nbsp;&nbsp;{row.detail}
                    </span>
                  </span>
                  {cat === "subghz" && <MiniWave seed={row.name} on={i === sel} />}
                  <span className="end">{fmtDay(row.modified)}</span>
                </button>
              ))
            ) : (
              <div className="empty">
                <Icon name="search" size={22} />
                {mark ? "Nothing here is marked that way yet." : `No signals match “${filter}”.`}
              </div>
            )}
          </div>
        </section>
        <section className="panel preview rise" id="lib-preview">
          {it ? (
            <>
              <div className="panel-head">
                <h2 className="mono" style={{ fontSize: 14 }}>
                  {it.name}
                </h2>
                <span className="row" style={{ gap: 8 }}>
                  <button
                    className={itMark?.star ? "btn icon latched" : "btn icon"}
                    data-action="star-signal"
                    aria-pressed={!!itMark?.star}
                    aria-label={itMark?.star ? "Remove the star" : "Star it"}
                    data-tip={itMark?.star ? "Starred" : "Star it"}
                    onClick={() => toggleStar(it.path)}
                  >
                    <Icon name="star" size={16} />
                  </button>
                  <span className="chip">{c.label}</span>
                </span>
              </div>
              <div className="big-icon">
                <Icon name={c.icon} size={46} />
              </div>
              <div className="pad">
                <dl className="kv">
                  {[...it.fields, ["Size", fmtSize(it.size)], ["Saved", fmtDate(it.modified)]].map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Path</dt>
                    <dd>{it.path}</dd>
                  </div>
                </dl>
                <div className="tags" id="lib-tags">
                  {(itMark?.tags ?? []).map((t) => (
                    <span className="tag" key={t}>
                      <Icon name="tag" size={12} />
                      {t}
                      <button aria-label={`Remove the tag ${t}`} onClick={() => removeTag(it.path, t)}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    className="tag-add"
                    id="lib-tag-add"
                    placeholder="Add a tag"
                    aria-label="Add a tag"
                    value={tagDraft}
                    maxLength={32}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      addTag(it.path, tagDraft);
                      setTagDraft("");
                    }}
                  />
                </div>
                <div className="stack">
                  <button className="btn primary wide" data-action="open-signal" onClick={openSignal}>
                    <Icon name="play" size={16} />
                    Open on Flipper
                  </button>
                  <div className="row">
                    <button className="btn" style={{ flex: 1 }} data-action="download-signal" onClick={downloadSignal}>
                      <Icon name="install" size={16} />
                      Download
                    </button>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      data-action="rename-signal"
                      onClick={() => void renameSignal()}
                    >
                      <Icon name="pencil" size={16} />
                      Rename
                    </button>
                    <button
                      className="btn icon"
                      aria-label={`Delete ${it.name}`}
                      data-tip="Delete"
                      data-action="delete-signal"
                      onClick={() => void deleteSignal()}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty">
              <Icon name="library" size={22} />
              Nothing saved here yet.
            </div>
          )}
        </section>
      </div>
    </View>
  );
}
