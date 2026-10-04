import type { KeyboardEvent, PointerEvent } from "react";
import type { Key } from "../device/api";
import type { IconName } from "../icon-map";
import { keyDown, keyUp } from "../input";
import { Icon } from "./Icon";

const ARROWS: [Key, string, string, IconName][] = [
  ["left", "Left", "Left arrow", "chevron-left"],
  ["up", "Up", "Up arrow", "chevron-up"],
  ["down", "Down", "Down arrow", "chevron-down"],
  ["right", "Right", "Right arrow", "chevron-right"],
];

function holdable(key: Key) {
  return {
    "data-key": key,
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      keyDown(key);
    },
    onPointerUp: () => void keyUp(key),
    onPointerCancel: () => void keyUp(key),
    onLostPointerCapture: () => void keyUp(key),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (!e.repeat) keyDown(key);
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") void keyUp(key);
    },
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
  };
}

export function Keypad() {
  return (
    <div className="keypad" role="group" aria-label="Flipper buttons">
      <div className="dpad">
        {ARROWS.map(([key, label, tip, icon]) => (
          <button key={key} className="key" aria-label={label} data-tip={tip} {...holdable(key)}>
            <Icon name={icon} size={18} />
          </button>
        ))}
      </div>
      <button className="key ok" data-tip="Enter" {...holdable("ok")}>
        OK
      </button>
      <button className="key back" data-tip="Esc" {...holdable("back")}>
        <Icon name="undo" size={16} />
        Back
      </button>
    </div>
  );
}
