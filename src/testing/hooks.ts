import { buddyInfo } from "../buddy/Buddy";
import { buddyReact } from "../buddy/bus";
import { mockDevice } from "../device";
import type { DeviceErrorCode } from "../device/api";
import { reduceMotion } from "../motion";
import { setBrowserRelease } from "../platform";
import { checkAppUpdate } from "../state/appUpdate";
import { useFiles } from "../state/files";
import { getPrefs, setPref } from "../state/settings";
import { show, toast, useUi } from "../state/ui";

export function installTestHooks() {
  Object.assign(window, {
    __fathom: {
      view: () => useUi.getState().view,
      path: () => useFiles.getState().path,
      selected: () => [...useFiles.getState().sel],
      files: (p: string) => mockDevice?.fileNames(p) ?? [],
      hasFolder: (p: string) => mockDevice?.hasPath(p) ?? false,
      prefs: () => getPrefs(),
      setPref,
      show,
      toast,
      unplug: () => mockDevice?.unplug(),
      plug: (others?: string[]) => mockDevice?.plug(others),
      setNoSd: (on: boolean) => mockDevice?.setNoSd(on),
      dropApp: (name: string) => mockDevice?.dropApp(name),
      setOtherFirmware: (on: boolean) => mockDevice?.setOtherFirmware(on),
      showKeyboard: (text: string) => mockDevice?.showKeyboard(text),
      keyboardText: () => mockDevice?.keyboardText() ?? "",
      failConnects: (code: DeviceErrorCode | null) => mockDevice?.failConnects(code),
      newRelease: (version: string | null) => {
        setBrowserRelease(
          version ? { version, url: `https://github.com/example/releases/tag/fathom-v${version}` } : null,
        );
        return checkAppUpdate();
      },
      buddies: buddyInfo,
      buddyReact,
      reduceMotion,
    },
  });
}
