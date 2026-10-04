import { useEffect, useRef, useState, type ReactNode } from "react";
import { party } from "../buddy/Buddy";
import { BuddyStill } from "../buddy/BuddyHost";
import { channelName, ghChannel, INSTALL_STEPS, OTHER_FIRMWARE, POINT_OF_NO_RETURN } from "../catalog";
import type { DeviceInfo } from "../device/api";
import { Icon } from "../components/Icon";
import { fmtWhen } from "../files/logic";
import { reduceMotion } from "../motion";
import { checkUpdates } from "../state/actions";
import {
  backupNow,
  backupSize,
  cancelBackupJob,
  jobPercent,
  loadBackups,
  restoreBackup,
  useBackups,
} from "../state/backups";
import { isOfficial, useDevice } from "../state/device";
import { toast } from "../state/ui";
import {
  cancelInstall,
  canInstall,
  failedAdvice,
  install,
  pickPackage,
  retryInstall,
  setBackupFirst,
  setChannel,
  useFirmware,
  type ChannelChoice,
} from "../state/firmware";
import { View } from "./View";

const CHANNELS: { value: ChannelChoice; title: string; note: string }[] = [
  { value: "release", title: "Release", note: "Stable builds, best for most people" },
  { value: "rc", title: "Release candidate", note: "Try the next release before it ships" },
  { value: "dev", title: "Development", note: "Nightly builds that can break" },
  { value: "custom", title: "Custom package", note: "Install an update .tgz from your computer" },
];
const CHANNEL_NAMES: Record<string, string> = {
  release: "Release channel",
  rc: "Release candidate",
  dev: "Development",
  custom: "Custom package",
};
const channelLabel = (c: ChannelChoice) => CHANNEL_NAMES[c] ?? channelName(c);

function Notes({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length)
      out.push(
        <ul key={out.length}>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>,
      );
    items = [];
  };
  const clean = (l: string) => l.replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (item) {
      items.push(clean(item[1]));
      continue;
    }
    flush();
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    out.push(head ? <b key={out.length}>{clean(head[1])}</b> : <p key={out.length}>{clean(line)}</p>);
  }
  flush();
  return <div className="fw-notes">{out}</div>;
}

function Backups() {
  const { list, sdCopy, job } = useBackups();
  const on = useDevice((s) => s.status === "connected");
  const installing = useFirmware((s) => s.installing);
  useEffect(() => {
    if (on && list === null) void loadBackups();
  }, [on, list]);
  const pct = jobPercent(job);
  return (
    <section className="panel rise" id="backups">
      <div className="panel-head">
        <h2>
          <Icon name="archive" />
          Backups
        </h2>
        <button
          className="btn"
          data-action="backup-now"
          disabled={!!job || installing}
          onClick={() => void backupNow()}
        >
          <Icon name="archive" size={16} />
          Back up now
        </button>
      </div>
      {job && (
        <div className="pad backup-job" id="backup-job">
          <div className="progress-head">
            <span className="muted">{job.kind === "backup" ? "Backing up" : "Restoring"}</span>
            <span className="muted">{pct}%</span>
          </div>
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          {job.kind === "backup" ? (
            <button className="link" data-action="cancel-backup" onClick={cancelBackupJob}>
              Cancel
            </button>
          ) : (
            <span className="muted">Keep the cable connected until {"it's"} done.</span>
          )}
        </div>
      )}
      {list && list.length > 0 ? (
        <>
          {list.map((b) => (
            <div className="setting" key={b.id} data-backup={b.id}>
              <span>
                <b>{fmtWhen(b.created)}</b>
                <span className="muted">
                  Internal storage, {backupSize(b)}
                  {b.sd ? " · SD card copy updated" : ""}
                </span>
              </span>
              <button
                className="btn"
                data-action="restore-backup"
                disabled={!!job || installing}
                onClick={() => void restoreBackup(b)}
              >
                <Icon name="clock" size={16} />
                Restore
              </button>
            </div>
          ))}
          <p className="note backup-note">
            <Icon name="info" />
            {sdCopy
              ? `The SD card copy is from ${fmtWhen(sdCopy)}. Restoring it never deletes anything on the card.`
              : "No SD card copy yet. Tick “SD card too” when backing up to keep one."}
          </p>
        </>
      ) : (
        list && (
          <div className="empty">
            <Icon name="archive" size={22} />
            No backups of this Flipper yet.
          </div>
        )
      )}
    </section>
  );
}

function OtherFirmware({ fork, installed, origin }: { fork: string; installed: string; origin: string }) {
  const latest = useDevice((s) => s.forkLatest);
  const flipper = useDevice((s) => s.info?.name ?? "Your Flipper");
  const who = fork || "other firmware";
  const newer = latest && latest.version !== installed;
  return (
    <section className="panel rise other-fw" id="other-fw" style={{ marginBottom: 16 }}>
      <div className="pad">
        <p>
          <b>
            {flipper} is on {who} {installed}.
          </b>{" "}
          {latest === undefined || latest === null
            ? `Fathom can't see where ${who} publishes its releases, so check its own site for updates.`
            : newer
              ? `${latest.version} is out on ${who}'s release page.`
              : `That's ${who}'s newest release.`}{" "}
          {latest ? `Fathom installs ${who}'s updates straight from its release page.` : ""}
        </p>
        {newer && (
          <div className="actions">
            <button
              className="btn primary"
              data-action="install-fork"
              onClick={() => {
                const ch = latest && ghChannel(origin);
                if (ch) void setChannel(ch).then(() => install());
              }}
            >
              <Icon name="install" size={16} />
              Install {latest.version}
            </button>
            <button
              className="btn"
              data-action="copy-fork-link"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(latest.url)
                  .then(() => toast("Copied the link to the release page", "copy"))
                  .catch(() => toast(latest.url, "copy", true))
              }
            >
              <Icon name="copy" size={16} />
              Copy the link to {latest.version}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function otherChoices(info?: DeviceInfo): { value: ChannelChoice; title: string; note: string }[] {
  const list = OTHER_FIRMWARE.map((f) => ({ value: f.channel as ChannelChoice, title: f.name, note: f.note }));
  const mine = info && !isOfficial(info) ? ghChannel(info.origin) : null;
  if (mine && !list.some((f) => f.value.toLowerCase() === mine.toLowerCase()))
    list.push({
      value: mine,
      title: info?.fork || channelName(mine),
      note: "The firmware it's on now, from its GitHub releases",
    });
  return list;
}

export function Firmware() {
  const d = useDevice();
  const fw = useFirmware();
  const panel = useRef<HTMLElement>(null);
  const [doneCard, setDoneCard] = useState(false);
  const name = d.info?.name ?? "your Flipper",
    official = isOfficial(d.info),
    release = fw.release,
    custom = fw.channel === "custom",
    version = release?.version ?? "",
    onThis = fw.channel.startsWith("gh:")
      ? ghChannel(d.info?.origin ?? "")?.toLowerCase() === fw.channel.toLowerCase()
      : official,
    up = onThis && !custom && !fw.loading && (!release || release.version === d.info?.firmware),
    n = INSTALL_STEPS.length;

  useEffect(() => {
    if (!fw.finished) return;
    party(panel.current);
    const t = setTimeout(() => setDoneCard(true), reduceMotion() ? 0 : 900);
    return () => {
      clearTimeout(t);
      setDoneCard(false);
    };
  }, [fw.finished]);

  const busy = fw.installing || fw.finished;
  const title = fw.finished
    ? "Up to date"
    : fw.installing
      ? `Updating to ${fw.target}`
      : fw.failed
        ? "Install stopped"
        : "Ready to install";
  const chip = busy ? (fw.step < n ? `Step ${fw.step + 1} of ${n}` : "Done") : `${n} steps`;
  const eta = fw.finished
    ? "Finished"
    : fw.installing
      ? fw.step >= n - 1
        ? "Follow the progress on the Flipper's screen"
        : `About ${Math.max(1, Math.round((100 - fw.total) / 40))} min left`
      : "About 3 minutes";
  const steps = custom ? INSTALL_STEPS.map((s, i) => (i === 2 ? "Read and check the package" : s)) : INSTALL_STEPS;

  return (
    <View id="firmware">
      <div className="head rise">
        <div>
          <h1 id="h-firmware">Firmware</h1>
          <p>Keep {name} on the latest release.</p>
        </div>
        <div className="actions">
          <button className="btn" data-action="check-updates" onClick={() => void checkUpdates()}>
            <Icon name="refresh" />
            Check for updates
          </button>
        </div>
      </div>
      {!official && d.info && <OtherFirmware fork={d.info.fork} installed={d.info.firmware} origin={d.info.origin} />}
      <div className="fw">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="panel versions rise" id="versions">
            <div className="ver">
              <span>Installed</span>
              <b>{d.info?.firmware}</b>
            </div>
            {up ? (
              <div style={{ marginLeft: "auto" }}>
                <span className="chip hot">
                  <Icon name="check" size={14} />
                  Up to date
                </span>
              </div>
            ) : (
              <>
                <span className="arrow">
                  <Icon name="arrow-right" size={22} />
                </span>
                <div className="ver next">
                  <span>{custom ? "Package" : "Available"}</span>
                  <b className={custom ? "pkg-name" : undefined}>{fw.loading ? "…" : version || "None picked"}</b>
                </div>
                <div style={{ marginLeft: "auto" }}>
                  <span className="chip">{channelLabel(fw.channel)}</span>
                </div>
              </>
            )}
          </section>
          <section className="panel rise">
            <div className="panel-head">
              <h2>
                <Icon name="cpu" />
                Update channel
              </h2>
            </div>
            <div className="pad">
              <fieldset style={{ border: 0, margin: 0, padding: 0 }} disabled={fw.installing}>
                <legend className="sr">Update channel</legend>
                {[...CHANNELS.slice(0, 3), ...otherChoices(d.info), CHANNELS[3]].map((c) => (
                  <label className="choice" key={c.value}>
                    <input
                      type="radio"
                      name="channel"
                      value={c.value}
                      checked={fw.channel === c.value}
                      onChange={() => void setChannel(c.value)}
                    />
                    <span className="grow">
                      <b>{c.title}</b>
                      <span className="muted">{c.note}</span>
                    </span>
                    {c.value === "release" && <span className="chip hot">Recommended</span>}
                  </label>
                ))}
              </fieldset>
              {custom && (
                <div className="pkg-pick">
                  <button className="btn" id="fw-pick" disabled={fw.installing} onClick={() => void pickPackage()}>
                    <Icon name="folder" size={16} />
                    {release ? "Pick another package" : "Pick a package"}
                  </button>
                  <span className="muted">
                    {release ? release.version : "An update .tgz for this Flipper. Only install packages you trust."}
                  </span>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginTop: 18,
                  flexWrap: "wrap",
                }}
              >
                <label className="check">
                  <input
                    type="checkbox"
                    id="fw-backup"
                    checked={fw.backupFirst}
                    disabled={fw.installing}
                    onChange={(e) => setBackupFirst(e.target.checked)}
                  />
                  Back up settings and keys first
                </label>
                <button
                  className="btn primary"
                  id="fw-install"
                  disabled={busy || !canInstall(fw)}
                  data-action="install"
                  onClick={() => void install()}
                >
                  {fw.finished ? (
                    <>
                      <Icon name="check" size={16} />
                      Installed
                    </>
                  ) : (
                    <>
                      <Icon name="install" />
                      {custom
                        ? "Install package"
                        : fw.channel.startsWith("gh:")
                          ? `Install ${channelName(fw.channel)} ${version}`
                          : official
                            ? `Install ${version}`
                            : `Install official ${version}`}
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>
          <section className="panel rise">
            <div className="panel-head">
              <h2>
                <Icon name="file" />
                {custom ? "What's in it" : `What's new in ${version}`}
              </h2>
            </div>
            <div className="pad" id="fw-notes">
              {release?.changelog ? (
                <Notes text={release.changelog} />
              ) : (
                <div className="placeholder">
                  {custom
                    ? "A package from your computer comes without release notes."
                    : fw.loading
                      ? "Loading the release notes…"
                      : "[Release notes load from the update server]"}
                </div>
              )}
            </div>
          </section>
          <Backups />
        </div>
        <section className="panel fw-stage rise" id="fw-panel" ref={panel}>
          <div className="panel-head">
            <h2 id="fw-title">{title}</h2>
            <span className="chip" id="fw-step">
              {chip}
            </span>
          </div>
          <div className="pad">
            <div className="progress-head">
              <span className="pct">
                <span id="fw-pct">{fw.total}</span>
                <small>%</small>
              </span>
              <span className="muted" id="fw-eta">
                {eta}
              </span>
            </div>
            <div className="bar" style={{ height: 10 }}>
              <i id="fw-bar" style={{ width: `${fw.total}%` }} />
            </div>
            <ol className="steps" id="fw-steps">
              {steps.map((s, i) => {
                const failed = !!fw.failed && !fw.installing && i === fw.failed.step;
                return (
                  <li key={s} className={i < fw.step ? "done" : i === fw.step ? (failed ? "now failed" : "now") : ""}>
                    <span className="mark">
                      {i < fw.step ? (
                        <Icon name="check" size={14} />
                      ) : failed ? (
                        <Icon name="x" size={14} />
                      ) : i === fw.step ? null : (
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{i + 1}</span>
                      )}
                    </span>
                    <span>{s}</span>
                    <span className="end">
                      {failed ? "Stopped" : i === fw.step ? `${fw.sub}%` : i < fw.step ? "Done" : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
            {fw.installing && fw.step < POINT_OF_NO_RETURN && (
              <button className="btn" id="fw-cancel" onClick={cancelInstall} style={{ marginTop: 14 }}>
                <Icon name="x" size={16} />
                Cancel
              </button>
            )}
            {fw.failed && !fw.installing && (
              <div className="fw-failed" id="fw-failed" role="alert">
                <p>
                  <b>{fw.failed.message}</b>
                  <span className="muted">{failedAdvice(fw.failed.step)}</span>
                </p>
                <button className="btn primary" id="fw-retry" onClick={() => void retryInstall()}>
                  <Icon name="refresh" size={16} />
                  Retry
                </button>
              </div>
            )}
            {fw.installing && release?.changelog && (
              <details className="fw-notes-live">
                <summary>Release notes for {fw.target}</summary>
                <Notes text={release.changelog} />
              </details>
            )}
            <div id="fw-warn" hidden={fw.finished}>
              <div className="hazard" style={{ marginTop: 18 }} />
              <p className="note">
                <Icon name="plug" />
                Keep the cable connected until {name} restarts.
              </p>
            </div>
            <div id="fw-done">
              {fw.finished && doneCard && (
                <div className="done-card">
                  <BuddyStill name="wave2" px={1} />
                  <span>
                    <b>
                      {name} is running {d.info?.firmware}
                    </b>
                    <span>Settings and saved signals are still there.</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </View>
  );
}
