import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import mark from "../assets/dolphin-mark.png";
import { BuddyHost } from "../buddy/BuddyHost";
import { useDevice } from "../state/device";
import { useSettings } from "../state/settings";
import { show, useUi } from "../state/ui";
import { NAV_ICONS, TITLES, VIEWS } from "../views";
import { Icon } from "./Icon";
import { Lcd } from "./Lcd";

const SIDE_BUDDY = {
  px: 3,
  minPx: 2,
  needW: 64,
  needH: 52,
  react: true,
  sizable: true,
  peek: "left" as const,
  script: [{ kind: "idle", dur: 2.4 }, { kind: "wave" }],
};

export function Sidebar() {
  const view = useUi((s) => s.view);
  const density = useSettings((s) => s.prefs.density);
  const nav = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const move = (animate: boolean) => {
      const p = pill.current,
        a = nav.current?.querySelector<HTMLElement>("a[aria-current='page']");
      if (!p) return;
      if (!a) {
        p.style.opacity = "0";
        return;
      }
      if (!animate) p.style.transition = "none";
      p.style.opacity = "1";
      p.style.transform = `translateY(${a.offsetTop}px)`;
      if (!animate) {
        void p.offsetWidth;
        p.style.transition = "";
      }
    };
    move(placed.current);
    placed.current = true;
    const onResize = () => move(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [view, density]);

  const go = (v: (typeof VIEWS)[number]) => (e: React.MouseEvent) => {
    e.preventDefault();
    show(v);
  };
  const connected = useDevice((s) => s.status === "connected");

  return (
    <nav className="sidebar" aria-label="Main">
      <a className="brand" href="#dock" onClick={go("dock")} aria-label="Fathom home">
        <img className="mark" id="brand-mark" src={mark} width={34} height={23} alt="" />
        <b>FATHOM</b>
      </a>
      <div className="nav" id="nav" ref={nav}>
        <div className="nav-pill" id="nav-pill" ref={pill} aria-hidden="true" />
        {VIEWS.map((v, i) => (
          <Fragment key={v}>
            {v === "settings" && <div className="nav-sep" />}
            <a
              href={`#${v}`}
              data-go={v}
              onClick={go(v)}
              aria-current={v === view ? "page" : undefined}
              aria-disabled={!connected && v !== "settings" ? "true" : undefined}
            >
              <Icon name={NAV_ICONS[v]} />
              {TITLES[v]}
              <span className="kbd">{i + 1}</span>
            </a>
          </Fragment>
        ))}
      </div>
      <BuddyHost className="buddy-dock" id="buddy-side" aria-hidden="true" opts={SIDE_BUDDY} />
      <DeviceCard />
    </nav>
  );
}

function DeviceCard() {
  const { status, info, power } = useDevice();
  const on = status === "connected";
  const bar = useRef<HTMLElement>(null);
  const battery = power?.battery ?? 0;
  /* the battery bar grows in after the card appears */
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (bar.current) bar.current.style.width = on ? `${battery}%` : "0";
    });
    return () => cancelAnimationFrame(id);
  }, [on, battery]);
  return (
    <a
      className={`device-card${on ? "" : " off"}`}
      href="#dock"
      id="device-card"
      onClick={(e) => {
        e.preventDefault();
        show("dock");
      }}
    >
      <Lcd max={1.5} mini />
      <div className="row">
        <b id="card-name">{on && info ? info.name : "No Flipper"}</b>
        <span className="state" id="card-state">
          {on ? (
            <>
              <span className="pulse" />
              Connected
            </>
          ) : (
            "Offline"
          )}
        </span>
      </div>
      <div className="meta" id="card-meta">
        {on && info ? `${info.link}, battery ${battery}%` : "Plug it in to connect"}
      </div>
      <div className="bar">
        <i id="card-bar" ref={bar} />
      </div>
    </a>
  );
}
