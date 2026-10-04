import { useEffect, useRef, type ReactNode } from "react";
import { BuddyHost } from "../buddy/BuddyHost";
import { APPS, LIBRARY_CATEGORIES } from "../catalog";
import { Icon } from "../components/Icon";
import { Lcd } from "../components/Lcd";
import { fmtGB, fmtTime } from "../files/logic";
import { useOnEnter, useTilt } from "../hooks";
import { reduceMotion } from "../motion";
import { openApp, playAlert, reboot } from "../state/actions";
import { backupNow, showBackups } from "../state/backups";
import { useActivity } from "../state/activity";
import { forkUpdate, updateAvailable, useDevice } from "../state/device";
import { pickCategory, useLibrary } from "../state/library";
import { screenshot } from "../state/screen";
import { show } from "../state/ui";
import { View } from "./View";

const STRIP_BUDDY = {
  px: 3,
  minPx: 2,
  needW: 100,
  needH: 48,
  react: true,
  sizable: true,
  script: [{ kind: "idle", dur: 2.4 }, { kind: "wave" }],
};

const go = (v: Parameters<typeof show>[0]) => (e: React.MouseEvent) => {
  e.preventDefault();
  show(v);
};

function Count({ n }: { n: number }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = String(n);
  }, [n]);
  return <b data-count={n} ref={ref} />;
}
function Ring({ p, children }: { p: number; children: ReactNode }) {
  const val = useRef<SVGCircleElement>(null);
  useEffect(() => {
    if (val.current) val.current.style.strokeDashoffset = String(100 - p);
  }, [p]);
  return (
    <div className="ring">
      <svg viewBox="0 0 64 64">
        <circle className="track" cx="32" cy="32" r="27" />
        <circle className="val" cx="32" cy="32" r="27" pathLength={100} data-p={p} ref={val} />
      </svg>
      <span>{children}</span>
    </div>
  );
}
function Bar({ w }: { w: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = w;
  }, [w]);
  return <i data-w={w} ref={ref} />;
}

function animateDock() {
  const view = document.getElementById("view-dock");
  if (!view) return;
  view.querySelectorAll<SVGCircleElement>(".ring .val").forEach((c) => {
    c.style.transition = "none";
    c.style.strokeDashoffset = "100";
    void c.getBoundingClientRect();
    c.style.transition = "";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => (c.style.strokeDashoffset = String(100 - Number(c.dataset.p)))),
    );
  });
  view.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const target = () => Number(el.dataset.count); /* read each frame: new numbers can land mid-count */
    if (reduceMotion()) return void (el.textContent = String(target()));
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1100),
        e = 1 - Math.pow(1 - t, 3);
      el.textContent = (target() * e).toFixed(0);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  view.querySelectorAll<HTMLElement>(".libbars .track i").forEach((i) => {
    i.style.transition = "none";
    i.style.width = "0";
    void i.offsetWidth;
    i.style.transition = "";
    requestAnimationFrame(() => requestAnimationFrame(() => (i.style.width = i.dataset.w ?? "0")));
  });
}

export function Dock() {
  const d = useDevice();
  const activity = useActivity((s) => s.items);
  const library = useLibrary((s) => s.items);
  const tilt = useTilt<HTMLDivElement>();
  useOnEnter("dock", animateDock);

  const info = d.info,
    name = info?.name ?? "",
    battery = d.power?.battery ?? 0,
    sd = d.sd ? Math.round((d.sd.used / d.sd.total) * 100) : 0,
    fork = forkUpdate(d) ? d.forkLatest : null,
    up = !updateAvailable(d) && !fork,
    latest = fork ? fork.version : (d.latest?.version ?? "");
  const counts = LIBRARY_CATEGORIES.map((c) => library.filter((i) => i.category === c.id).length);
  const max = Math.max(1, ...counts);

  return (
    <View id="dock">
      <div className="head rise">
        <div>
          <h1 id="h-dock">Dock</h1>
          <p id="dock-sub">{info ? `${name} is connected over ${info.link}.` : ""}</p>
        </div>
        <div className="actions">
          <button className="btn" data-action="screenshot" onClick={screenshot}>
            <Icon name="camera" />
            Take screenshot
          </button>
          {updateAvailable(d) && (
            <button className="btn primary" id="dock-update" onClick={() => show("firmware")}>
              <Icon name="install" />
              Update to {latest}
            </button>
          )}
        </div>
      </div>
      <BuddyHost className="buddy-strip" id="buddy-strip" aria-hidden="true" opts={STRIP_BUDDY} />
      <div className="panel hero rise">
        <div className="stage" data-tilt ref={tilt}>
          <a
            className="scr-link"
            href="#screen"
            onClick={go("screen")}
            aria-label={`Open the Screen page to control ${name}`}
          >
            <Lcd max={4} glow />
          </a>
          <span className="chip open-hint">
            <Icon name="maximize-2" size={13} />
            Click to control
          </span>
        </div>
        <div className="details">
          <div className="who">
            <div>
              <span className="chip hot">
                <span className="pulse" />
                Live
              </span>
            </div>
            <div className="dev-name" id="dock-name">
              {name}
            </div>
            <div className="model" id="dock-model">
              {info ? `${info.model}, hardware ${info.hardware}, ${info.region} region` : ""}
            </div>
          </div>
          <div className="tiles" id="dock-tiles">
            <div className="tile">
              <span className="label">Battery</span>
              <Ring p={battery}>
                <Count n={battery} />
                <small>%</small>
              </Ring>
              <span className="cap">{d.power?.charging ? "Charging" : "On battery"}</span>
            </div>
            <div className="tile">
              <span className="label">SD card</span>
              <Ring p={sd}>
                <Count n={sd} />
                <small>%</small>
              </Ring>
              <span className="cap">{d.sd ? `${fmtGB(d.sd.used)} of ${fmtGB(d.sd.total)} GB` : "No SD card"}</span>
            </div>
            <div className="tile">
              <span className="label">Firmware</span>
              <div className={up ? "fw-badge ok" : "fw-badge"}>
                <Icon name={up ? "check" : "install"} size={22} />
              </div>
              <span className="cap">
                {info?.firmware}
                {up ? (
                  ", latest"
                ) : (
                  <>
                    ,{" "}
                    <a href="#firmware" onClick={go("firmware")}>
                      {fork ? `${latest} is out` : `${latest} ready`}
                    </a>
                  </>
                )}
              </span>
            </div>
          </div>
          <div className="actions">
            <button className="btn" data-action="backup" onClick={() => void backupNow()}>
              <Icon name="archive" />
              Back up
            </button>
            <button className="btn" data-action="restore" onClick={showBackups}>
              <Icon name="clock" />
              Restore
            </button>
            <button
              className="btn icon"
              aria-label="Restart"
              data-tip="Restart"
              data-action="reboot"
              onClick={() => void reboot()}
            >
              <Icon name="power" />
            </button>
            <button
              className="btn icon"
              aria-label="Play a sound"
              data-tip="Play a sound"
              data-action="find"
              onClick={() => void playAlert()}
            >
              <Icon name="bell" />
            </button>
          </div>
        </div>
      </div>
      <div className="grid3">
        <section className="panel rise">
          <div className="panel-head">
            <h2>
              <Icon name="activity" />
              Recent activity
            </h2>
          </div>
          <ol className="timeline" id="activity">
            {activity.map((a) => (
              <li key={`${a.time}-${a.text}`}>
                <span className="dot">
                  <Icon name={a.icon} size={15} />
                </span>
                <span className="what">{a.text}</span>
                <time>{fmtTime(a.time)}</time>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel rise">
          <div className="panel-head">
            <h2>
              <Icon name="library" />
              Library
            </h2>
            <a className="link" href="#library" onClick={go("library")} id="lib-total">
              {library.length} saved
            </a>
          </div>
          <div className="libbars" id="lib-summary">
            {LIBRARY_CATEGORIES.map((c, i) => (
              <button
                key={c.id}
                className="item"
                data-cat={c.id}
                onClick={() => {
                  pickCategory(c.id);
                  show("library");
                }}
              >
                <Icon name={c.icon} />
                <span className="grow">{c.label}</span>
                <span className="track">
                  <Bar w={`${Math.max(6, (counts[i] / max) * 100)}%`} />
                </span>
                <span className="n">{counts[i]}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel rise">
          <div className="panel-head">
            <h2>
              <Icon name="apps" />
              Open on Flipper
            </h2>
            <a className="link" href="#apps" onClick={go("apps")}>
              All apps
            </a>
          </div>
          <div className="launch" id="launch">
            {APPS.slice(0, 6).map((a) => (
              <button key={a.name} className="app-btn" onClick={() => void openApp(a)}>
                <Icon name={a.icon} size={22} />
                <span>{a.name.replace(" 125 kHz", "")}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </View>
  );
}
