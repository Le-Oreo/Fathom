import { isMac } from "../motion";
import { useDevice } from "../state/device";
import { openPalette } from "../state/ui";
import { FlipperPicker } from "./FlipperPicker";
import { Icon } from "./Icon";

export function Topbar() {
  const { status, power } = useDevice();
  const on = status === "connected";
  return (
    <header className="topbar" data-tauri-drag-region>
      <button
        className="search"
        aria-label="Search or jump to (Ctrl K)"
        data-action="palette"
        onClick={() => on && openPalette()}
      >
        <Icon name="search" size={17} />
        <span className="q">Search or jump to…</span>
        <span className="keycap" id="kbd-k">
          {isMac ? "⌘K" : "Ctrl K"}
        </span>
      </button>
      <div className="push" />
      <FlipperPicker />
      <div className="battery" id="battery">
        {on && power && (
          <>
            {power.charging && <Icon name="zap" size={15} />}
            <span className="cell" style={{ "--b": power.battery } as React.CSSProperties}>
              <i />
            </span>
            {power.battery}%
          </>
        )}
      </div>
    </header>
  );
}
