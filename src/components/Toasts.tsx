import { useUi } from "../state/ui";
import { Icon } from "./Icon";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" id="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={t.out ? "toast out" : "toast"}
          style={{ "--tt": `${t.secs}s` } as React.CSSProperties}
        >
          <span className="ico">
            <Icon name={t.icon} size={16} />
          </span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
