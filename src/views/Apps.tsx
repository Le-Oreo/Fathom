import { useEffect } from "react";
import { APPS } from "../catalog";
import { Icon } from "../components/Icon";
import { openApp, openFap } from "../state/actions";
import { appSize, appTitle, loadInstalled, removeInstalled, useApps } from "../state/apps";
import { useDevice, useDeviceName } from "../state/device";
import { useUi } from "../state/ui";
import { View } from "./View";

function Installed() {
  const { installed, loading } = useApps();
  const on = useDevice((s) => s.status === "connected");
  const here = useUi((s) => s.view === "apps");
  useEffect(() => {
    if (on && here && useApps.getState().installed === null) void loadInstalled();
  }, [on, here]);
  if (installed === null) return null;
  return (
    <section className="panel rise" id="installed-apps" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>
          <Icon name="app-window" />
          Installed apps
        </h2>
        <button className="link" data-action="reload-apps" disabled={loading} onClick={() => void loadInstalled()}>
          Refresh
        </button>
      </div>
      {installed.length ? (
        installed.map((a) => (
          <div className="setting" key={a.path} data-fap={a.path}>
            <span>
              <b>{appTitle(a.name)}</b>
              <span className="muted">
                {a.category} · {appSize(a)}
              </span>
            </span>
            <div className="actions">
              <button className="btn" data-action="open-fap" onClick={() => void openFap(a.path)}>
                <Icon name="arrow-up-right" size={16} />
                Open
              </button>
              <button className="btn" data-action="remove-fap" onClick={() => void removeInstalled(a)}>
                <Icon name="trash" size={16} />
                Remove
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="empty">
          <Icon name="app-window" size={22} />
          No apps installed in /ext/apps yet.
        </div>
      )}
    </section>
  );
}

export function Apps() {
  const name = useDeviceName();
  const hidden = useApps((s) => s.hidden);
  return (
    <View id="apps">
      <div className="head rise">
        <div>
          <h1 id="h-apps">Apps</h1>
          <p>Open an app on {name}. Its screen appears on the Screen page.</p>
        </div>
      </div>
      <div className="apps" id="app-grid">
        {APPS.map((a, i) =>
          hidden.has(a.name) ? null : (
            <button key={a.name} className="app-card rise" data-app={i} onClick={() => void openApp(a)}>
              <span className="ico">
                <Icon name={a.icon} size={22} />
              </span>
              <b>{a.name}</b>
              <span>{a.note}</span>
              <span className="go">
                <Icon name="arrow-up-right" size={18} />
              </span>
            </button>
          ),
        )}
      </div>
      <Installed />
    </View>
  );
}
