import { useEffect, useRef, useState } from "react";
import { fmtWhen } from "../files/logic";
import { useDevice } from "../state/device";
import { pluggedIn, switchFlipper, useFlippers } from "../state/flippers";
import { Icon } from "./Icon";

export function FlipperPicker() {
  const { status, info, ports, current } = useDevice();
  const known = useFlippers((s) => s.known);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const on = status === "connected";
  const here = pluggedIn(ports, known);
  const elsewhere = Object.values(known)
    .filter((k) => !ports.some((p) => p.id === k.port))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 5);
  const canPick = on && (here.length > 1 || elsewhere.length > 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pill = (
    <>
      <span className="pulse" />
      {on && info ? info.name : "No Flipper"}
      <small>{on && info ? info.link : "Listening"}</small>
      {canPick && <Icon name="chevron-down" size={14} />}
    </>
  );
  return (
    <div className="flipper-picker" ref={box}>
      {canPick ? (
        <button
          className="conn"
          id="conn"
          aria-haspopup="menu"
          aria-expanded={open}
          data-action="pick-flipper"
          onClick={() => setOpen((o) => !o)}
        >
          {pill}
        </button>
      ) : (
        <div className={`conn${on ? "" : " off"}`} id="conn">
          {pill}
        </div>
      )}
      {open && (
        <div className="picker-menu" role="menu" id="flipper-menu">
          {here.map((f) => {
            const now = f.port === current;
            return (
              <button
                key={f.port}
                role="menuitem"
                data-port={f.port}
                className={now ? "on" : undefined}
                disabled={now}
                onClick={() => {
                  setOpen(false);
                  void switchFlipper(f.port, f.name);
                }}
              >
                <Icon name={now ? "check" : "usb"} size={16} />
                <span>
                  <b>{f.name}</b>
                  <span className="muted">{now ? "Connected" : "Plugged in. Switch to it"}</span>
                </span>
              </button>
            );
          })}
          {elsewhere.map((k) => (
            <div key={k.id} className="picker-off" data-known={k.id}>
              <Icon name="clock" size={16} />
              <span>
                <b>{k.name}</b>
                <span className="muted">Last seen {fmtWhen(k.lastSeen)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
