import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "../components/Icon";
import {
  clearLog,
  clearOutput,
  currentLine,
  fitTerminal,
  forgetCommand,
  mountTerminal,
  outputText,
  QUICK,
  runCommand,
  saveCommand,
  useConsole,
  wantConsole,
} from "../state/console";
import { useDevice, useDeviceName } from "../state/device";
import { toast, useUi } from "../state/ui";
import { View } from "./View";

const STATUS = {
  off: "Not attached",
  attaching: "Attaching…",
  on: "Attached",
  detaching: "Handing back…",
} as const;

export function Console() {
  const name = useDeviceName();
  const { log, attach, problem, saved, history } = useConsole();
  const host = useRef<HTMLDivElement>(null);
  const here = useUi((s) => s.view === "console");
  const connected = useDevice((s) => s.status === "connected");

  /* the terminal lives in this page whenever it shows */
  useEffect(() => {
    if (!here || !host.current) return;
    void mountTerminal(host.current);
    const ro = new ResizeObserver(() => fitTerminal());
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [here]);
  useEffect(() => {
    wantConsole(here && connected);
  }, [here, connected]);
  useEffect(() => () => wantConsole(false), []);

  const save = () => {
    const c = currentLine().trim() || history[history.length - 1] || "";
    if (!c) return toast("Type a command first, then save it", "terminal");
    saveCommand(c);
    toast(`Saved “${c}” as a quick command`, "terminal");
  };

  return (
    <View id="console">
      <div className="head rise">
        <div>
          <h1 id="h-console">Console</h1>
          <p>The Flipper's command line, straight over USB.</p>
        </div>
        <div className="actions">
          <button
            className="btn"
            data-action="copy-output"
            onClick={() => {
              navigator.clipboard?.writeText(outputText()).catch(() => {});
              toast("Copied the console output", "copy");
            }}
          >
            <Icon name="copy" />
            Copy output
          </button>
          <button className="btn" data-action="clear-output" onClick={clearOutput}>
            <Icon name="trash" />
            Clear
          </button>
        </div>
      </div>
      <div className="console">
        <div className="term rise">
          <div className="term-bar">
            <span className={attach === "on" ? "pulse" : "pulse off"} />
            <b>Serial CLI</b>
            <span>{name}</span>
            <span className="push" id="term-state">
              {STATUS[attach]}
            </span>
          </div>
          <div className="term-xterm" id="term-out" ref={host} />
          {problem && attach === "off" && (
            <div className="term-problem" id="term-problem" role="alert">
              <span>{problem}</span>
              <button className="btn" onClick={() => wantConsole(here && connected)}>
                <Icon name="refresh" size={16} />
                Try again
              </button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="panel rise">
            <div className="panel-head">
              <h2>
                <Icon name="terminal" />
                Quick commands
              </h2>
              <button className="link" data-action="save-command" onClick={save}>
                Save this command
              </button>
            </div>
            <div className="chips" id="chips">
              {QUICK.map((c) => (
                <button key={c} data-cmd={c} disabled={attach !== "on"} onClick={() => runCommand(c)}>
                  {c}
                </button>
              ))}
              {saved.map((c) => (
                <span className="saved-cmd" key={`s-${c}`}>
                  <button data-cmd={c} data-saved="" disabled={attach !== "on"} onClick={() => runCommand(c)}>
                    {c}
                  </button>
                  <button
                    className="forget"
                    aria-label={`Remove ${c}`}
                    data-tip="Remove"
                    onClick={() => forgetCommand(c)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <p className="note console-hint">
              <Icon name="info" />
              Up and Down step through past commands.
            </p>
          </section>
          <section className="panel rise" id="rpc-panel">
            <div className="panel-head">
              <h2>
                <Icon name="activity" />
                RPC log
              </h2>
              <button className="link" data-action="clear-log" onClick={clearLog}>
                Clear
              </button>
            </div>
            <ul className="log" id="rpc-log">
              {log.map((e) => (
                <li key={e.id} className={e.dir === "in" ? "in" : undefined}>
                  <span className="arrow">{e.dir === "in" ? "←" : "→"}</span>
                  <span className="what">{e.name}</span>
                  <span className="det">{e.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </View>
  );
}
