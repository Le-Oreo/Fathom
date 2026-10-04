import { useEffect, useState } from "react";
import { COLOR_ICONS, currentIcon, holidayPick, holidaysNow, iconThumb, type AppIcon } from "../appicons";
import { setPref, useSettings } from "../state/settings";

function useMonth() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function AppIconPicker({ label }: { label: string }) {
  const color = useSettings((s) => s.prefs.appIcon);
  const holiday = useSettings((s) => s.prefs._holidayIcon);
  const now = useMonth();
  const current = currentIcon(color, holiday, now);
  const holidays = holidaysNow(now);

  const pick = (icon: AppIcon) => {
    if (icon.months) setPref("_holidayIcon", holidayPick(icon.id, now));
    else {
      setPref("_holidayIcon", undefined);
      setPref("appIcon", icon.id);
    }
  };
  const tile = (icon: AppIcon) => (
    <button
      key={icon.id}
      type="button"
      role="radio"
      className="app-icon"
      aria-checked={icon.id === current}
      aria-label={icon.label}
      data-tip={icon.label}
      data-pref="appIcon"
      data-val={icon.id}
      onClick={() => pick(icon)}
    >
      <img src={iconThumb(icon.id)} alt="" width={40} height={40} draggable={false} />
    </button>
  );
  return (
    <div className="app-icons" role="radiogroup" aria-label={label}>
      {COLOR_ICONS.map(tile)}
      {holidays.length > 0 && (
        <>
          <span className="app-icons-sep" aria-hidden="true">
            This month
          </span>
          {holidays.map(tile)}
        </>
      )}
    </div>
  );
}
