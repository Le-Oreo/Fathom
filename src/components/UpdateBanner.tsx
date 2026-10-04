import { downloadAppUpdate, laterAppUpdate, useAppUpdate } from "../state/appUpdate";
import { Icon } from "./Icon";

export function UpdateBanner() {
  const { release, skipped } = useAppUpdate();
  if (!release || release.version === skipped) return null;
  return (
    <div className="app-update" id="app-update" role="status">
      <Icon name="install" size={16} />
      <span>
        <b>FATHOM {release.version} is out.</b> You're on {__APP_VERSION__}.
      </span>
      <button className="get" data-action="get-app-update" onClick={downloadAppUpdate}>
        Download
      </button>
      <button className="later" data-action="later-app-update" onClick={laterAppUpdate}>
        Later
      </button>
    </div>
  );
}
