import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useDevice } from "../state/device";
import { useUi, type ViewId } from "../state/ui";

export function View({ id, children }: { id: ViewId; children: ReactNode }) {
  const on = useUi((s) => s.view === id);
  const console = useDevice((s) => s.console && s.status === "connected");
  return (
    <section className={on ? "view on" : "view"} id={`view-${id}`} aria-labelledby={`h-${id}`}>
      {console && id !== "console" && id !== "settings" && (
        <p className="console-banner" role="status">
          <Icon name="terminal" size={16} />
          The Console is using the Flipper. It goes back to Fathom in a moment.
        </p>
      )}
      {children}
    </section>
  );
}
