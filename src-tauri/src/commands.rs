use std::sync::Arc;

use tauri::State;

use crate::error::{DeviceError, ErrorCode};
use crate::manager::{ConnectionState, Manager};
use crate::services::device::{self, DeviceInfo, PowerInfo, StorageInfo};
use crate::services::screen;

type Result<T> = std::result::Result<T, DeviceError>;

#[tauri::command]
pub fn connection_current(m: State<'_, Arc<Manager>>) -> ConnectionState {
    m.current()
}

#[tauri::command]
pub async fn connection_connect(m: State<'_, Arc<Manager>>, port: Option<String>) -> Result<()> {
    m.connect(port).await
}

#[tauri::command]
pub async fn connection_switch(
    m: State<'_, Arc<Manager>>,
    t: State<'_, crate::files::Transfers>,
    port: String,
) -> Result<()> {
    if t.busy() {
        return Err(DeviceError::new(ErrorCode::Busy, "a transfer is running"));
    }
    m.switch_to(port).await
}

#[tauri::command]
pub async fn device_info(m: State<'_, Arc<Manager>>) -> Result<DeviceInfo> {
    m.device_info().await
}

#[tauri::command]
pub async fn device_power(m: State<'_, Arc<Manager>>) -> Result<PowerInfo> {
    let session = m.session()?;
    Ok(device::power_info(&session).await?)
}

#[tauri::command]
pub async fn device_reboot(m: State<'_, Arc<Manager>>) -> Result<()> {
    m.reboot().await
}

#[tauri::command]
pub async fn device_play_alert(m: State<'_, Arc<Manager>>) -> Result<()> {
    m.play_alert().await
}

#[tauri::command]
pub async fn device_clock_get(m: State<'_, Arc<Manager>>) -> Result<device::Clock> {
    let session = m.session()?;
    Ok(device::get_clock(&session).await?)
}

#[tauri::command]
pub async fn device_clock_set(m: State<'_, Arc<Manager>>, clock: device::Clock) -> Result<()> {
    let session = m.session()?;
    Ok(device::set_clock(&session, clock).await?)
}

#[tauri::command]
pub async fn storage_info(m: State<'_, Arc<Manager>>, root: String) -> Result<Option<StorageInfo>> {
    if root != "/ext" && root != "/int" {
        return Err(DeviceError::new(ErrorCode::InvalidName, root));
    }
    let session = m.session()?;
    Ok(device::storage_info(&session, &root).await?)
}

#[tauri::command]
pub async fn screen_start(
    m: State<'_, Arc<Manager>>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<u64> {
    let session = m.session()?;
    let on_frame: screen::OnFrame = Arc::new(move |bytes| {
        let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes));
    });
    Ok(screen::start(&session, on_frame).await?)
}

#[tauri::command]
pub async fn screen_stop(m: State<'_, Arc<Manager>>, id: u64) -> Result<()> {
    match m.session() {
        Ok(session) => Ok(screen::stop(&session, id).await?),
        /* the stream ended with its session */
        Err(_) => Ok(()),
    }
}

#[tauri::command]
pub async fn input_send(m: State<'_, Arc<Manager>>, key: String, kind: String) -> Result<()> {
    let (Some(k), Some(t)) = (screen::parse_key(&key), screen::parse_type(&kind)) else {
        return Err(DeviceError::new(
            ErrorCode::InvalidName,
            format!("{key} {kind}"),
        ));
    };
    let session = m.session()?;
    Ok(screen::input(&session, k, t).await?)
}

#[tauri::command]
pub fn bluetooth_enable(ble: State<'_, Arc<crate::transport::ble::Ble>>, on: bool) {
    ble.set_enabled(on);
}

#[tauri::command]
pub async fn cli_attach(
    m: State<'_, Arc<Manager>>,
    t: State<'_, crate::files::Transfers>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<()> {
    if t.busy() {
        return Err(DeviceError::new(ErrorCode::Busy, "a transfer is running"));
    }
    m.cli_attach(Arc::new(move |bytes| {
        let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes));
    }))
    .await
}

/* Text for the CLI, as typed. */
#[tauri::command]
pub fn cli_write(m: State<'_, Arc<Manager>>, data: String) -> Result<()> {
    m.cli_write(data.into_bytes())
}

/* Leaves the CLI and starts RPC again. */
#[tauri::command]
pub async fn cli_detach(m: State<'_, Arc<Manager>>) -> Result<()> {
    m.cli_detach().await
}

#[tauri::command]
pub async fn file_save(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>> {
    use tauri::Manager as _;
    use tauri_plugin_dialog::DialogExt;

    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(DeviceError::new(ErrorCode::Failed, "expected raw bytes"));
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let (name, ext) =
        clean_name(&name).ok_or_else(|| DeviceError::new(ErrorCode::InvalidName, name.clone()))?;
    let data = data.clone();
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter(ext.to_uppercase(), &[ext]);
    if let Ok(pictures) = app.path().picture_dir() {
        let dir = pictures.join("FATHOM");
        let _ = std::fs::create_dir_all(&dir);
        dialog = dialog.set_directory(dir);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let mut path = path
        .into_path()
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
    {
        path.set_extension(ext);
    }
    std::fs::write(&path, data).map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()))
}

fn clean_name(name: &str) -> Option<(String, &'static str)> {
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let ext = match name.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "png" => "png",
        "gif" => "gif",
        _ => return None,
    };
    Some((name, ext))
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
