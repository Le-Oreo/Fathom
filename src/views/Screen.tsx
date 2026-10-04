import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Keypad } from "../components/Keypad";
import { Lcd } from "../components/Lcd";
import { useTilt } from "../hooks";
import { useDevice, useDeviceName } from "../state/device";
import { screenshot, togglePause, toggleRecording, useScreen } from "../state/screen";
import { pasteToType, setTypingText, stopTyping, typeOnFlipper, useTyping } from "../state/typing";
import { View } from "./View";

function RecButton() {
  const started = useScreen((s) => s.recording);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (started === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [started]);
  if (started === null)
    return (
      <button className="btn" id="rec-btn" data-action="gif" onClick={toggleRecording}>
        <Icon name="record" />
        <span>Record GIF</span>
      </button>
    );
  const s = Math.max(0, Math.floor((now - started) / 1000));
  return (
    <button className="btn latched" id="rec-btn" data-action="gif" onClick={toggleRecording}>
      <span className="rec">
        <span className="dot" />
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <span>Stop</span>
    </button>
  );
}

function TypeIt() {
  const { text, busy, done, total } = useTyping();
  const on = useDevice((s) => s.status === "connected");
  return (
    <section className="panel rise type-it" id="type-it" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>
          <Icon name="keyboard" />
          Type on the Flipper
        </h2>
        <span className="muted" style={{ fontSize: "13.5px" }}>
          When it shows its keyboard
        </span>
      </div>
      <form
        className="pad type-form"
        onSubmit={(e) => {
          e.preventDefault();
          void typeOnFlipper();
        }}
      >
        <input
          id="type-text"
          className="field-input"
          value={text}
          maxLength={64}
          placeholder="A name, like Front_door"
          autoComplete="off"
          spellCheck={false}
          aria-label="Text to type on the Flipper"
          onChange={(e) => setTypingText(e.target.value)}
        />
        <button type="button" className="btn" data-action="paste-type" onClick={() => void pasteToType()}>
          <Icon name="clipboard" size={16} />
          Paste
        </button>
        {busy ? (
          <button type="button" className="btn" data-action="stop-typing" onClick={stopTyping}>
            <Icon name="x" size={16} />
            Stop ({Math.round((done / Math.max(1, total)) * 100)}%)
          </button>
        ) : (
          <button className="btn primary" data-action="type-it" disabled={!on || !text}>
            <Icon name="keyboard" size={16} />
            Type it
          </button>
        )}
      </form>
      <p className="note type-note">
        <Icon name="info" />
        Replaces what's in the Flipper's text box. Letters, digits, spaces and underscores, as its keyboard has.
      </p>
    </section>
  );
}

export function Screen() {
  const name = useDeviceName();
  const { paused, shots, label } = useScreen();
  const tilt = useTilt<HTMLDivElement>();
  return (
    <View id="screen">
      <div className="head rise">
        <div>
          <h1 id="h-screen">Screen</h1>
          <p>Mirror and control {name} in real time.</p>
        </div>
        <div className="actions">
          <RecButton />
          <button className="btn primary" data-action="screenshot" onClick={screenshot}>
            <Icon name="camera" />
            Take screenshot
          </button>
        </div>
      </div>
      <div className="panel stage screen-stage rise" data-tilt ref={tilt}>
        <Lcd max={6} focus glow />
        <div className="stream-row">
          <div className="left">
            {paused ? (
              <span className="chip" id="stream-chip">
                <Icon name="pause" size={13} />
                Paused
              </span>
            ) : (
              <span className="chip hot" id="stream-chip">
                <span className="pulse" />
                Live
              </span>
            )}
            {label && (
              <span>
                Showing <b id="showing">{label}</b>
              </span>
            )}
          </div>
          <Keypad />
          <button className={paused ? "btn latched" : "btn"} id="pause-btn" data-action="pause" onClick={togglePause}>
            <Icon name={paused ? "play" : "pause"} size={16} />
            <span>{paused ? "Resume" : "Pause"}</span>
          </button>
        </div>
      </div>
      <TypeIt />
      <section className="panel rise" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>
            <Icon name="camera" />
            Screenshots
          </h2>
          <span className="muted" style={{ fontSize: "13.5px" }}>
            Saved as PNG
          </span>
        </div>
        <div className="shots" id="shots">
          {shots.length ? (
            shots.map((s) => (
              <figure className="shot" key={s.id}>
                <img src={s.url} alt={`Screenshot ${s.name}`} />
                <figcaption>{s.name}</figcaption>
              </figure>
            ))
          ) : (
            <div className="empty" style={{ width: "100%" }}>
              <Icon name="camera" size={22} />
              Screenshots you take show up here.
            </div>
          )}
        </div>
      </section>
    </View>
  );
}
