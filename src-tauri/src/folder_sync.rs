use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{DeviceError, ErrorCode};
use crate::files::Transfers;
use crate::manager::Manager;
use crate::services::storage::Progress;
use crate::services::sync::{self, Done, Plan};

type Result<T> = std::result::Result<T, DeviceError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Link {
    id: u64,
    flipper: String,
    local: PathBuf,
    remote: String,
}

/* What the UI sees of a link. */
#[derive(Debug, Clone, Serialize)]
pub struct LinkView {
    pub id: u64,
    pub local: String,
    pub remote: String,
}

#[derive(Default)]
pub struct Links(Mutex<Option<Vec<Link>>>);

fn file(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("sync.json"))
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))
}

fn with<T>(app: &AppHandle, links: &Links, f: impl FnOnce(&mut Vec<Link>) -> T) -> Result<T> {
    let path = file(app)?;
    let mut guard = links.0.lock().unwrap();
    let list = guard.get_or_insert_with(|| {
        std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    });
    let before = serde_json::to_vec(list).unwrap_or_default();
    let out = f(list);
    let after = serde_json::to_vec(list).unwrap_or_default();
    if after != before {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, after)
            .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    }
    Ok(out)
}

fn flipper(m: &Manager) -> Result<String> {
    m.current()
        .info
        .map(|i| i.id)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| ErrorCode::Disconnected.into())
}

fn view(l: &Link) -> LinkView {
    LinkView {
        id: l.id,
        local: l.local.display().to_string(),
        remote: l.remote.clone(),
    }
}

fn find(app: &AppHandle, links: &Links, m: &Manager, id: u64) -> Result<Link> {
    let me = flipper(m)?;
    with(app, links, |list| {
        list.iter().find(|l| l.id == id && l.flipper == me).cloned()
    })?
    .ok_or_else(|| DeviceError::new(ErrorCode::NotFound, "no such link"))
}

#[tauri::command]
pub fn sync_links(
    app: AppHandle,
    links: State<'_, Links>,
    m: State<'_, Arc<Manager>>,
) -> Result<Vec<LinkView>> {
    let me = flipper(&m)?;
    with(&app, &links, |list| {
        list.iter().filter(|l| l.flipper == me).map(view).collect()
    })
}

#[tauri::command]
pub async fn sync_link_add(
    app: AppHandle,
    links: State<'_, Links>,
    m: State<'_, Arc<Manager>>,
    remote: String,
) -> Result<Option<LinkView>> {
    if !remote.starts_with("/ext/") || remote.contains("/../") || remote.ends_with("/..") {
        return Err(DeviceError::new(ErrorCode::InvalidName, remote));
    }
    let me = flipper(&m)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Folder to keep in sync")
        .pick_folder(move |f| {
            let _ = tx.send(f);
        });
    let Some(local) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let remote = remote.trim_end_matches('/').to_string();
    with(&app, &links, |list| {
        if let Some(l) = list
            .iter()
            .find(|l| l.flipper == me && l.local == local && l.remote == remote)
        {
            return Some(view(l));
        }
        let id = list.iter().map(|l| l.id).max().unwrap_or(0) + 1;
        let l = Link {
            id,
            flipper: me.clone(),
            local,
            remote,
        };
        let v = view(&l);
        list.push(l);
        Some(v)
    })
}

#[tauri::command]
pub fn sync_link_remove(
    app: AppHandle,
    links: State<'_, Links>,
    m: State<'_, Arc<Manager>>,
    id: u64,
) -> Result<()> {
    let me = flipper(&m)?;
    with(&app, &links, |list| {
        list.retain(|l| !(l.id == id && l.flipper == me))
    })
}

#[tauri::command]
pub async fn sync_preview(
    app: AppHandle,
    links: State<'_, Links>,
    m: State<'_, Arc<Manager>>,
    id: u64,
) -> Result<Plan> {
    let l = find(&app, &links, &m, id)?;
    sync::plan(&*m.session()?, &l.local, &l.remote).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sync_apply(
    app: AppHandle,
    links: State<'_, Links>,
    m: State<'_, Arc<Manager>>,
    t: State<'_, Transfers>,
    id: u64,
    link: u64,
    remove: Vec<String>,
    progress: Channel<Progress>,
) -> Result<Done> {
    let l = find(&app, &links, &m, link)?;
    let cancel = t.start(id);
    let result = async {
        let s = m.session()?;
        let plan = sync::plan(&s, &l.local, &l.remote).await?;
        sync::apply(
            &s,
            &l.local,
            &l.remote,
            &plan,
            &remove,
            crate::files::throttled(progress),
            &cancel,
        )
        .await
    }
    .await;
    t.finish(id);
    result
}
