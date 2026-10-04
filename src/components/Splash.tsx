import { useEffect, useRef, useState } from "react";
import type { Buddy } from "../buddy/Buddy";
import { BuddyHost } from "../buddy/BuddyHost";
import { reduceMotion } from "../motion";
import { deviceName, isConnected, updateAvailable, useDevice } from "../state/device";
import { getPrefs } from "../state/settings";
import { replayView, toast, useUi } from "../state/ui";
import { Icon } from "./Icon";

const SEEN = "fathom-splash";

let atLaunch: boolean | null = null;
function playAtLaunch() {
  if (atLaunch !== null) return atLaunch;
  atLaunch = getPrefs().splash && !reduceMotion();
  try {
    if (sessionStorage.getItem(SEEN) === "1") atLaunch = false;
    sessionStorage.setItem(SEEN, "1");
  } catch {
    /* storage blocked */
  }
  return atLaunch;
}

let updateNoted = false;
function noteUpdate(delay: number) {
  if (updateNoted) return;
  updateNoted = true;
  setTimeout(() => {
    const latest = useDevice.getState().latest;
    if (getPrefs().checkUpdates && updateAvailable() && latest)
      toast(`Firmware ${latest.version} is ready to install`, "install");
  }, delay);
}

export function Splash() {
  const replay = useUi((s) => s.splash);
  return <SplashRun key={replay} play={replay > 0 || playAtLaunch()} first={replay === 0} />;
}

function SplashRun({ play, first }: { play: boolean; first: boolean }) {
  const [phase, setPhase] = useState<"in" | "out" | "gone">(play ? "in" : "gone");
  const [ready, setReady] = useState(false);
  const buddy = useRef<Buddy | null>(null);
  const name = useDevice((s) => s.info?.name);

  useEffect(() => {
    if (first) noteUpdate(play ? 3000 : 900);
    if (!play) return;
    let done = false;
    const timers: number[] = [];
    const finish = () => {
      if (done) return;
      done = true;
      setPhase("out");
      replayView();
      timers.push(window.setTimeout(() => setPhase("gone"), 600));
    };
    timers.push(
      window.setTimeout(() => {
        setReady(isConnected());
        buddy.current?.do("wave");
      }, 1250),
      window.setTimeout(finish, 2600),
    );
    window.addEventListener("fathom-splash-skip", finish);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("fathom-splash-skip", finish);
    };
  }, [play, first]);

  if (phase === "gone") return null;
  return (
    <div
      className={phase === "out" ? "splash out" : "splash"}
      id="splash"
      aria-hidden="true"
      onClick={() => window.dispatchEvent(new Event("fathom-splash-skip"))}
    >
      {getPrefs().dolphin && (
        <BuddyHost
          className="buddy-splash"
          id="buddy-splash"
          opts={{
            px: 4,
            minPx: 2,
            needW: 110,
            needH: 54,
            mood: "show",
            interactive: false,
            script: [{ kind: "enter", from: "left", dur: 1.05 }],
          }}
          onBuddy={(b) => (buddy.current = b)}
        />
      )}
      <b>FATHOM</b>
      <div className="status" id="splash-status">
        {ready ? (
          <>
            <Icon name="check" size={15} />
            Connected to {name ?? deviceName()}
          </>
        ) : (
          <>
            <span className="pulse" />
            Connecting to {name ?? deviceName()}…
          </>
        )}
      </div>
      <div className="line">
        <i />
      </div>
    </div>
  );
}
