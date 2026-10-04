use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Manager as _, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{DeviceError, ErrorCode};
use crate::manager::Manager;
use crate::services::library::Cache;
use crate::services::storage::{self, Entry, OnProgress, Progress};

type Result<T> = std::result::Result<T, DeviceError>;

#[derive(Default)]
pub struct Transfers {
    allowed: Mutex<HashSet<PathBuf>>,
    folders: Mutex<HashMap<String, PathBuf>>,
    next_token: AtomicU64,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /* transfers, installs, backups and restores under way */
    running: std::sync::atomic::AtomicUsize,
}

impl Transfers {
    /* Paths dropped onto the window from the computer. */
    pub fn allow(&self, paths: &[PathBuf]) {
        self.allowed.lock().unwrap().extend(paths.iter().cloned());
    }

    pub fn start(&self, id: u64) -> Arc<AtomicBool> {
        self.running.fetch_add(1, Ordering::SeqCst);
        self.cancels
            .lock()
            .unwrap()
            .entry(id)
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub fn finish(&self, id: u64) {
        self.running.fetch_sub(1, Ordering::SeqCst);
        self.cancels.lock().unwrap().remove(&id);
    }

    pub fn busy(&self) -> bool {
        self.running.load(Ordering::SeqCst) > 0
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Folder {
    pub token: String,
    pub label: String,
}

fn session(m: &Manager) -> Result<Arc<crate::rpc::Session>> {
    m.session()
}

fn header(request: &Request<'_>, name: &str) -> String {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(crate::commands::percent_decode)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn storage_list(m: State<'_, Arc<Manager>>, path: String) -> Result<Vec<Entry>> {
    storage::list(&*session(&m)?, &path).await
}

#[tauri::command]
pub async fn storage_stat(m: State<'_, Arc<Manager>>, path: String) -> Result<Entry> {
    storage::stat(&*session(&m)?, &path).await
}

#[tauri::command]
pub async fn storage_read(m: State<'_, Arc<Manager>>, path: String) -> Result<Response> {
    let data = storage::read(&session(&m)?, &path, None, None).await?;
    Ok(Response::new(data))
}

#[tauri::command]
pub async fn storage_write(
    m: State<'_, Arc<Manager>>,
    t: State<'_, Transfers>,
    cache: State<'_, Cache>,
    request: Request<'_>,
) -> Result<bool> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(DeviceError::new(ErrorCode::Failed, "expected raw bytes"));
    };
    let path = header(&request, "x-path");
    if !path.starts_with("/ext/") && !path.starts_with("/int/") {
        return Err(DeviceError::new(ErrorCode::InvalidName, path));
    }
    let data = data.clone();
    let skip_same = !header(&request, "x-skip-same").is_empty();
    cache.forget(&path);
    t.running.fetch_add(1, Ordering::SeqCst);
    let result = async {
        let s = session(&m)?;
        if skip_same && storage::already_there(&s, &path, &data).await? {
            return Ok(true);
        }
        storage::write(&s, &path, &data, None, None)
            .await
            .map(|_| false)
    }
    .await;
    t.running.fetch_sub(1, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn storage_mkdir(m: State<'_, Arc<Manager>>, path: String) -> Result<()> {
    storage::mkdir(&*session(&m)?, &path).await
}

#[tauri::command]
pub async fn storage_rename(
    m: State<'_, Arc<Manager>>,
    cache: State<'_, Cache>,
    from: String,
    to: String,
) -> Result<()> {
    cache.forget(&from);
    cache.forget(&to);
    storage::rename(&*session(&m)?, &from, &to).await
}

#[tauri::command]
pub async fn storage_remove(
    m: State<'_, Arc<Manager>>,
    cache: State<'_, Cache>,
    path: String,
    recursive: bool,
) -> Result<()> {
    cache.forget(&path);
    storage::delete(&*session(&m)?, &path, recursive).await
}

#[tauri::command]
pub async fn library_scan(
    m: State<'_, Arc<Manager>>,
    cache: State<'_, Cache>,
) -> Result<Vec<crate::services::library::LibraryItem>> {
    let device = m.current().info.map(|i| i.id).unwrap_or_default();
    crate::services::library::scan(&session(&m)?, &cache, &device).await
}

#[tauri::command]
pub async fn app_start(
    m: State<'_, Arc<Manager>>,
    name: String,
    args: Option<String>,
) -> Result<()> {
    crate::services::apps::start(&*session(&m)?, &name, args.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub async fn storage_md5(m: State<'_, Arc<Manager>>, path: String) -> Result<String> {
    storage::md5(&*session(&m)?, &path).await
}

pub(crate) fn throttled(channel: Channel<Progress>) -> OnProgress {
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    Arc::new(move |p: Progress| {
        let mut l = last.lock().unwrap();
        if p.done >= p.total || l.elapsed() >= Duration::from_millis(100) {
            *l = Instant::now();
            let _ = channel.send(p);
        }
    })
}

#[tauri::command]
pub fn transfer_cancel(t: State<'_, Transfers>, id: u64) {
    t.cancels
        .lock()
        .unwrap()
        .entry(id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn transfer_upload(
    m: State<'_, Arc<Manager>>,
    t: State<'_, Transfers>,
    cache: State<'_, Cache>,
    id: u64,
    source: String,
    to: String,
    progress: Channel<Progress>,
) -> Result<storage::Uploaded> {
    let path = PathBuf::from(&source);
    if !t.allowed.lock().unwrap().contains(&path) {
        return Err(DeviceError::new(
            ErrorCode::InvalidName,
            "not a file you picked",
        ));
    }
    let cancel = t.start(id);
    if let Some(name) = path.file_name() {
        cache.forget(&format!(
            "{}/{}",
            to.trim_end_matches('/'),
            name.to_string_lossy()
        ));
    }
    let s = session(&m);
    let result = match s {
        Ok(s) => storage::upload(&s, &path, &to, throttled(progress), &cancel).await,
        Err(e) => Err(e),
    };
    t.finish(id);
    result
}

#[tauri::command]
pub async fn transfer_download(
    m: State<'_, Arc<Manager>>,
    t: State<'_, Transfers>,
    id: u64,
    path: String,
    dir: bool,
    folder: String,
    progress: Channel<Progress>,
) -> Result<String> {
    let Some(local) = t.folders.lock().unwrap().get(&folder).cloned() else {
        return Err(DeviceError::new(
            ErrorCode::InvalidName,
            "no download folder picked",
        ));
    };
    let cancel = t.start(id);
    let result = match session(&m) {
        Ok(s) => storage::download(&s, &path, dir, &local, throttled(progress), cancel).await,
        Err(e) => Err(e),
    };
    t.finish(id);
    result.map(|p| {
        p.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    })
}

fn local_item(path: PathBuf) -> Option<LocalItem> {
    let meta = std::fs::metadata(&path).ok()?;
    Some(LocalItem {
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        dir: meta.is_dir(),
        path: path.to_string_lossy().into_owned(),
    })
}

/* Files to upload, from the native open dialog. */
#[tauri::command]
pub async fn upload_pick(app: AppHandle, t: State<'_, Transfers>) -> Result<Vec<LocalItem>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let picked: Vec<PathBuf> = rx
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();
    t.allow(&picked);
    Ok(picked.into_iter().filter_map(local_item).collect())
}

#[tauri::command]
pub async fn upload_folder_pick(
    app: AppHandle,
    t: State<'_, Transfers>,
) -> Result<Option<LocalItem>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Upload a folder")
        .pick_folder(move |f| {
            let _ = tx.send(f);
        });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    t.allow(std::slice::from_ref(&path));
    Ok(local_item(path))
}

#[tauri::command]
pub fn dropped_items(t: State<'_, Transfers>, paths: Vec<String>) -> Vec<LocalItem> {
    let allowed = t.allowed.lock().unwrap();
    paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| allowed.contains(p))
        .filter_map(local_item)
        .collect()
}

#[tauri::command]
pub async fn download_folder_pick(
    app: AppHandle,
    t: State<'_, Transfers>,
) -> Result<Option<Folder>> {
    let mut dialog = app.dialog().file().set_title("Download to");
    if let Ok(downloads) = app.path().download_dir() {
        let dir = downloads.join("FATHOM");
        let _ = std::fs::create_dir_all(&dir);
        dialog = dialog.set_directory(dir);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let token = format!("folder-{}", t.next_token.fetch_add(1, Ordering::SeqCst));
    let label = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    t.folders.lock().unwrap().insert(token.clone(), path);
    Ok(Some(Folder { token, label }))
}
