import { BuddyHost } from "../buddy/BuddyHost";
import { Icon } from "../components/Icon";
import type { PortInfo } from "../device/api";
import { codeMessage } from "../device/errors";
import { reconnect } from "../state/actions";
import { useDevice } from "../state/device";
import { getPrefs, setPref, useSettings } from "../state/settings";
import { toast } from "../state/ui";
import { View } from "./View";

const SEARCH_BUDDY = { px: 4, minPx: 2, needW: 110, needH: 62, mood: "search" as const, sizable: true };
const NONE: PortInfo[] = [];

const UDEV_RULE =
  'SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", ATTRS{manufacturer}=="Flipper Devices Inc.", TAG+="uaccess"';
const UDEV_COMMAND = `echo '${UDEV_RULE}' | sudo tee /etc/udev/rules.d/41-fathom-flipper.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger`;

/* Turns Bluetooth on (the setting) and says how to pair. */
function pairOverBluetooth() {
  if (!getPrefs().bluetooth) setPref("bluetooth", true);
  toast("Pair the Flipper in your computer's Bluetooth settings; it shows up here once it's in range", "bluetooth");
}

export function Connect() {
  const ports = useDevice((s) => (s.status === "connected" ? NONE : s.ports));
  const error = useDevice((s) => (s.status === "connected" ? undefined : s.error));
  const several = ports.length > 1;
  const bluetooth = useSettings((s) => s.prefs.bluetooth);
  return (
    <View id="connect">
      <div className="connect">
        <section className="panel connect-hero stage rise">
          <BuddyHost
            className="buddy-hero"
            id="buddy-connect"
            role="img"
            aria-label="Fathom's dolphin, listening for your Flipper"
            opts={SEARCH_BUDDY}
          />
          <h2 id="h-connect">{several ? "Which Flipper?" : "Plug in your Flipper"}</h2>
          <p>
            {several
              ? `${ports.length} Flippers are plugged in. Pick the one Fathom should connect to.`
              : "Use a USB-C data cable and unlock the Flipper. Fathom finds it and connects on its own."}
          </p>
          {error && error !== "disconnected" && (
            <p className="note" role="alert" data-error={error}>
              <Icon name="info" />
              {codeMessage(error)}
            </p>
          )}
          {bluetooth && (
            <p className="muted ble-help" id="ble-help">
              Bluetooth is on: turn on Bluetooth on the Flipper (Settings, Bluetooth), pair it in this computer's
              Bluetooth settings (the Flipper shows a PIN to type), and it shows up here.
            </p>
          )}
          {error === "permission" && (
            <div className="udev-help" id="udev-help">
              <p className="muted">
                The .deb and .rpm packages add it for you. With the AppImage, run this once in a terminal, then unplug
                the Flipper and plug it back in:
              </p>
              <pre>{UDEV_COMMAND}</pre>
            </div>
          )}
          <div className="actions" style={{ justifyContent: "center", marginTop: 6 }}>
            {several ? (
              ports.map((p) => (
                <button
                  key={p.id}
                  className="btn"
                  data-action="pick-port"
                  data-port={p.id}
                  onClick={() => void reconnect(p.id)}
                >
                  <Icon name={p.id.startsWith("ble:") ? "bluetooth" : "usb"} />
                  {p.name}
                  {p.id.startsWith("ble:") ? " (Bluetooth)" : ""}
                </button>
              ))
            ) : (
              <>
                <button className="btn primary" data-action="reconnect" onClick={() => void reconnect()}>
                  <Icon name="refresh" />
                  Scan again
                </button>
                <button className="btn" data-action="bluetooth" onClick={pairOverBluetooth}>
                  <Icon name="bluetooth" />
                  Pair over Bluetooth
                </button>
              </>
            )}
          </div>
        </section>
        <section className="panel rise">
          <div className="panel-head">
            <h2>
              <Icon name="info" />
              Nothing happening?
            </h2>
          </div>
          <ul className="list tips">
            <li>
              <Icon name="usb" />
              <span>
                <b>Use a data cable</b>
                <span>Some USB-C cables only carry power.</span>
              </span>
            </li>
            <li>
              <Icon name="power" />
              <span>
                <b>Close other Flipper apps</b>
                <span>qFlipper or a serial terminal can hold the port.</span>
              </span>
            </li>
            <li>
              <Icon name="terminal" />
              <span>
                <b>On Linux, add the udev rule</b>
                <span>It lets Fathom open the port without sudo.</span>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </View>
  );
}
