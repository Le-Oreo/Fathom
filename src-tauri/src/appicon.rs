use tauri::{image::Image, AppHandle, Manager};

use crate::error::{DeviceError, ErrorCode};

macro_rules! icons {
    ($($id:literal),* $(,)?) => {
        &[$((
            $id,
            include_bytes!(concat!("../icons/app/", $id, ".png")).as_slice(),
            include_bytes!(concat!("../icons/app/", $id, ".ico")).as_slice(),
        )),*]
    };
}

const CLASSIC: (&str, &[u8], &[u8]) = (
    "classic",
    include_bytes!("../icons/128x128@2x.png"),
    include_bytes!("../icons/icon.ico"),
);
const ICONS: &[(&str, &[u8], &[u8])] = icons!(
    "charcoal",
    "navy",
    "teal",
    "sky",
    "purple",
    "cream",
    "new-year",
    "lunar-new-year",
    "valentines",
    "st-patricks",
    "easter",
    "4th-of-july",
    "halloween",
    "thanksgiving",
    "hanukkah",
    "christmas",
);

fn find(id: &str) -> Option<(&'static str, &'static [u8], &'static [u8])> {
    std::iter::once(CLASSIC)
        .chain(ICONS.iter().copied())
        .find(|(i, ..)| *i == id)
}

#[tauri::command]
pub fn app_icon_set(app: AppHandle, id: String) -> Result<(), DeviceError> {
    let (id, png, _ico) =
        find(&id).ok_or_else(|| DeviceError::new(ErrorCode::InvalidName, id.clone()))?;
    let image =
        Image::from_bytes(png).map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    for window in app.webview_windows().values() {
        let _ = window.set_icon(image.clone());
    }
    #[cfg(windows)]
    shortcuts::point_at(&app, id, _ico);
    #[cfg(not(windows))]
    let _ = id;
    Ok(())
}

#[cfg(windows)]
mod shortcuts {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    use tauri::{AppHandle, Manager};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    const SCRIPT: &str = r#"
$exe = $env:FATHOM_EXE; $icon = $env:FATHOM_ICON
$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'))
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
  Get-ChildItem -LiteralPath $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $l = $sh.CreateShortcut($_.FullName)
      if ($l.TargetPath -ieq $exe) { $l.IconLocation = $icon; $l.Save() }
    } catch {}
  }
}
try { & (Join-Path $env:SystemRoot 'System32\ie4uinit.exe') -show } catch {}
"#;

    pub fn point_at(app: &AppHandle, id: &'static str, ico: &'static [u8]) {
        let Ok(dir) = app.path().app_local_data_dir().map(|d| d.join("icons")) else {
            return;
        };
        let mark = dir.join("applied.txt");
        if std::fs::read_to_string(&mark).is_ok_and(|s| s == id) {
            return;
        }
        std::thread::spawn(move || {
            let Ok(exe) = std::env::current_exe() else {
                return;
            };
            let _ = std::fs::create_dir_all(&dir);
            let icon: PathBuf = if id == "classic" {
                exe.clone()
            } else {
                for old in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    if old.path().extension().is_some_and(|e| e == "ico") {
                        let _ = std::fs::remove_file(old.path());
                    }
                }
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let path = dir.join(format!("fathom-{id}-{stamp}.ico"));
                if std::fs::write(&path, ico).is_err() {
                    return;
                }
                path
            };
            let ok = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    SCRIPT,
                ])
                .env("FATHOM_EXE", &exe)
                .env("FATHOM_ICON", format!("{},0", icon.display()))
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .is_ok_and(|s| s.success());
            if ok {
                let _ = std::fs::write(&mark, id);
            }
        });
    }
}
