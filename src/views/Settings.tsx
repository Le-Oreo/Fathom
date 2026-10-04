import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppIconPicker } from "../components/AppIconPicker";
import { Icon } from "../components/Icon";
import { appDiagnostics, downloadBlob } from "../platform";
import { cleanPrefs, SECTIONS, SHOWN_SETTINGS, type Prefs, type SettingDef } from "../settings/schema";
import { useConsole } from "../state/console";
import { syncClock, useDevice } from "../state/device";
import { driftText } from "../clock";
import { errorMessage } from "../device/errors";
import { replacePrefs, setPref, useSettings } from "../state/settings";
import { ask, replaySplash, setSettingsFind, toast, useUi } from "../state/ui";
import { reduceMotion } from "../motion";
import { View } from "./View";

function Control({ s, v }: { s: SettingDef; v: Prefs[keyof Prefs] }) {
  const label = s.label;
  if (s.type === "switch")
    return (
      <input
        type="checkbox"
        className="switch"
        data-pref={s.id}
        checked={!!v}
        aria-label={label}
        onChange={(e) => setPref(s.id, e.target.checked)}
      />
    );
  if (s.type === "icon") return <AppIconPicker label={label} />;
  if (s.type === "select")
    return (
      <select data-pref={s.id} aria-label={label} value={String(v)} onChange={(e) => setPref(s.id, e.target.value)}>
        {s.options?.map(([val, l]) => (
          <option key={val} value={val}>
            {l}
          </option>
        ))}
      </select>
    );
  if (s.type === "seg")
    return (
      <div className="seg" role="radiogroup" aria-label={label}>
        {s.options?.map(([val, l]) => (
          <button
            key={val}
            type="button"
            role="radio"
            aria-checked={val === v}
            data-pref={s.id}
            data-val={val}
            onClick={() => setPref(s.id, val)}
          >
            {l}
          </button>
        ))}
      </div>
    );
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {s.options?.map(([val, l, c]) => (
        <button
          key={val}
          type="button"
          role="radio"
          aria-checked={val === v}
          data-pref={s.id}
          data-val={val}
          style={{ "--sw": c } as React.CSSProperties}
          aria-label={l}
          data-tip={l}
          onClick={() => setPref(s.id, val)}
        />
      ))}
    </div>
  );
}

interface Extra {
  s: string;
  find: string;
  node: ReactNode;
}

export function Settings() {
  const prefs = useSettings((s) => s.prefs);
  const saved = useSettings((s) => s.saved);
  const find = useUi((s) => s.settingsFind);
  const [spy, setSpy] = useState("general");
  const chip = useRef<HTMLSpanElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const c = chip.current;
    if (!saved || !c || useUi.getState().view !== "settings") return;
    c.textContent = "Saved";
    c.classList.add("show");
    const t = setTimeout(() => c.classList.remove("show"), 1400);
    return () => clearTimeout(t);
  }, [saved]);

  /* the section list follows your scroll */
  useEffect(() => {
    const content = document.getElementById("content");
    if (!content) return;
    const onScroll = () => {
      if (useUi.getState().view !== "settings") return;
      const top = content.getBoundingClientRect().top + 90;
      const secs = [...document.querySelectorAll<HTMLElement>("#set-body .set-sec")].filter((s) => !s.hidden);
      let cur = "";
      secs.forEach((sec) => {
        if (sec.getBoundingClientRect().top <= top) cur = sec.id.slice(4);
      });
      setSpy(cur || secs[0]?.id.slice(4) || "");
    };
    content.addEventListener("scroll", onScroll, { passive: true });
    return () => content.removeEventListener("scroll", onScroll);
  }, []);

  const extras: Extra[] = [
    {
      s: "connection",
      find: "flipper's clock time date drift set now connection",
      node: <ClockRow key="clock" />,
    },
    {
      s: "general",
      find: "your settings export import reset save file defaults",
      node: (
        <div className="setting" key="your-settings">
          <span>
            <b>Your settings</b>
            <span className="muted">Save them to a file, load them on another computer, or start over.</span>
          </span>
          <div className="actions">
            <button className="btn" data-action="export-settings" onClick={exportSettings}>
              <Icon name="file-down" size={16} />
              Export
            </button>
            <button className="btn" data-action="import-settings" onClick={() => file.current?.click()}>
              <Icon name="file-up" size={16} />
              Import
            </button>
            <button className="btn" data-action="reset-settings" onClick={() => void resetSettings()}>
              <Icon name="rotate-ccw" size={16} />
              Reset
            </button>
          </div>
        </div>
      ),
    },
    {
      s: "about",
      find: "about version fathom licences licenses fonts icons open source",
      node: (
        <div className="setting about-row" key="version">
          <span>
            <b>Fathom {__APP_VERSION__}</b>
            <span className="muted">
              A desktop companion for the Flipper Zero. Not made by or affiliated with Flipper Devices.
            </span>
            <span className="muted licences" id="licences">
              Barlow and Barlow Semi Condensed: SIL Open Font License 1.1. Lucide icons: ISC License. xterm.js: MIT
              License. React, Tauri, zustand and gifenc: MIT License.
            </span>
          </span>
        </div>
      ),
    },
    {
      s: "about",
      find: "copy diagnostics log support help problem bug report",
      node: (
        <div className="setting" key="diagnostics">
          <span>
            <b>Copy diagnostics</b>
            <span className="muted">
              The version, the connection and recent log lines, for someone helping you. No files or identifiers.
            </span>
          </span>
          <button className="btn" data-action="copy-diagnostics" onClick={() => void copyDiagnostics()}>
            <Icon name="copy" size={16} />
            Copy
          </button>
        </div>
      ),
    },
    {
      s: "about",
      find: "replay the launch animation splash intro about",
      node: (
        <div className="setting" key="replay">
          <span>
            <b>Replay the launch animation</b>
            <span className="muted">Plays the start-up sequence again.</span>
          </span>
          <button className="btn" data-action="replay-splash" onClick={replaySplash}>
            <Icon name="play" size={16} />
            Replay
          </button>
        </div>
      ),
    },
  ];

  const words = find.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hit = (text: string) => words.every((w) => text.includes(w));
  const sections = SECTIONS.map(([id, label, icon]) => {
    const rows = SHOWN_SETTINGS.filter((s) => s.s === id).map((s) => ({
      s,
      ok: hit(`${s.label} ${s.hint || ""} ${s.s}`.toLowerCase()),
    }));
    const more = extras.filter((x) => x.s === id).map((x) => ({ x, ok: hit(x.find) }));
    return { id, label, icon, rows, more, any: rows.some((r) => r.ok) || more.some((m) => m.ok) };
  });
  const shown = sections.filter((s) => s.any).length;

  return (
    <View id="settings">
      <div className="head rise">
        <div>
          <h1 id="h-settings">Settings</h1>
          <p>
            Make Fathom work the way you like. Changes save as you go.
            <span className="chip hot set-saved" id="set-saved" aria-live="polite" ref={chip} />
          </p>
        </div>
        <label className="field set-find">
          <Icon name="search" size={16} />
          <input
            type="search"
            id="set-find"
            placeholder="Find a setting"
            aria-label="Find a setting"
            value={find}
            onChange={(e) => setSettingsFind(e.target.value)}
          />
        </label>
      </div>
      <div className="set-wrap">
        <nav className="set-nav rise" id="set-nav" aria-label="Settings sections">
          {sections.map((s) => (
            <a
              key={s.id}
              href="#settings"
              data-set-nav={s.id}
              className={spy === s.id ? "on" : undefined}
              hidden={!s.any}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(`set-${s.id}`)
                  ?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
              }}
            >
              <Icon name={s.icon} size={16} />
              <span>{s.label}</span>
            </a>
          ))}
        </nav>
        <div className="set-body" id="set-body">
          {sections.map((sec) => (
            <section className="panel set-sec" id={`set-${sec.id}`} key={sec.id} hidden={!sec.any}>
              <div className="panel-head">
                <h2>
                  <Icon name={sec.icon} />
                  {sec.label}
                </h2>
              </div>
              {sec.rows.map(({ s, ok }) => (
                <div className="setting" id={`row-${s.id}`} key={s.id} hidden={!ok}>
                  <span>
                    <b>{s.label}</b>
                    {s.hint && <span className="muted">{s.hint}</span>}
                  </span>
                  <Control s={s} v={prefs[s.id]} />
                </div>
              ))}
              {sec.more.map(({ x, ok }) => (ok ? x.node : null))}
            </section>
          ))}
        </div>
      </div>
      <div className="empty" id="set-none" hidden={shown > 0}>
        <Icon name="search" size={22} />
        No settings match “{words.join(" ")}”.
      </div>
      <input
        type="file"
        id="settings-file"
        accept=".json,application/json"
        hidden
        ref={file}
        onChange={(e) => void importSettings(e.target)}
      />
    </View>
  );
}

function ClockRow() {
  const clock = useDevice((s) => s.clock);
  const on = useDevice((s) => s.status === "connected" && !s.console);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const shown = clock ? new Date(now + (clock.set ? 0 : clock.drift)) : null;
  return (
    <div className="setting" id="row-flipper-clock">
      <span>
        <b>The Flipper's clock</b>
        <span className="muted" id="flipper-clock">
          {shown
            ? `${shown.toLocaleString()}. It was ${driftText(clock!.drift)}${clock!.set ? ", and was set from this computer" : ""}.`
            : "Read when the Flipper connects."}
        </span>
      </span>
      <button
        className="btn"
        data-action="set-clock"
        disabled={!on}
        onClick={() =>
          void syncClock(true).then(
            () => toast("Set the Flipper's clock from this computer", "clock"),
            (err) => toast(errorMessage(err), "info", true),
          )
        }
      >
        <Icon name="clock" size={16} />
        Set now
      </button>
    </div>
  );
}

async function copyDiagnostics() {
  const d = useDevice.getState();
  const connection = `Connection: ${d.status}${d.error ? `, last error ${d.error}` : ""}${
    d.info ? `\nFlipper: ${d.info.model} ${d.info.hardware}, firmware ${d.info.firmware}, region ${d.info.region}` : ""
  }`;
  const log = useConsole
    .getState()
    .log.slice()
    .reverse()
    .map((e) => `${e.dir} ${e.name}`);
  try {
    const text = await appDiagnostics({ connection, log });
    await navigator.clipboard.writeText(text);
    toast("Copied the diagnostics", "copy");
  } catch {
    toast("Couldn't copy the diagnostics", "info", true);
  }
}

function exportSettings() {
  const prefs = useSettings.getState().prefs;
  downloadBlob("fathom-settings.json", new Blob([JSON.stringify(prefs, null, 2)], { type: "application/json" }));
  toast("Saved fathom-settings.json", "file-down");
}

async function importSettings(input: HTMLInputElement) {
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  try {
    const next = cleanPrefs(JSON.parse(await f.text()));
    if (!Object.keys(next).length) throw new Error("no settings");
    replacePrefs(next);
    toast(`Loaded ${Object.keys(next).length} settings from ${f.name}`, "file-up");
  } catch {
    toast(`${f.name} isn't a Fathom settings file`, "info", true);
  }
}

async function resetSettings() {
  if (!(await ask({ title: "Reset all settings?", body: "Everything goes back to how Fathom started.", ok: "Reset" })))
    return;
  replacePrefs({});
  toast("Settings are back to the defaults", "rotate-ccw");
}
