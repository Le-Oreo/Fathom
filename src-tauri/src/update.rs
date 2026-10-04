use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{DeviceError, ErrorCode};
use crate::files::Transfers;
use crate::manager::Manager;
use crate::services::backup::{self, Record};
use crate::services::device::{self, DeviceInfo};
use crate::services::firmware::{self, Package, Release};
use crate::services::storage::{OnProgress, Progress};

type Result<T> = std::result::Result<T, DeviceError>;

/* qFlipper waits this long for an update to finish */
const UPDATE_WAIT: Duration = Duration::from_secs(10 * 60);
const UPDATE_TYPICAL: Duration = Duration::from_secs(150);
/* the firmware list is fetched again after this long */
const LIST_FRESH: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Updates {
    /* an install or a restore is running: never two at once */
    busy: AtomicBool,
    list: Mutex<Option<(Instant, firmware::Directory)>>,
    picked: Mutex<HashMap<String, PathBuf>>,
    next: AtomicU64,
}

/* Holds Updates::busy for as long as it lives. */
struct Busy<'a>(&'a AtomicBool);
impl<'a> Busy<'a> {
    fn take(flag: &'a AtomicBool) -> Result<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            return Err(DeviceError::new(
                ErrorCode::Busy,
                "an install or restore is running",
            ));
        }
        Ok(Busy(flag))
    }
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct InstallProgress {
    pub step: u8,
    pub pct: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct Picked {
    pub token: String,
    pub name: String,
}

/* Below 100 until the step says it's done. */
fn percent(done: u64, total: u64) -> u8 {
    (done.saturating_mul(100))
        .checked_div(total)
        .map_or(0, |p| p.min(99) as u8)
}

fn offline(e: impl std::fmt::Display) -> DeviceError {
    DeviceError::new(ErrorCode::Offline, e.to_string())
}

const HOSTS: &[&str] = &[
    "update.flipperzero.one",
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

fn host_ok(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|r| r.split(['/', '?']).next())
        .is_some_and(|h| HOSTS.contains(&h))
}

fn http_get(
    url: &str,
    on_progress: &dyn Fn(u64, u64),
    cancel: &AtomicBool,
    limit: u64,
) -> Result<Vec<u8>> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .user_agent("FATHOM")
        .max_redirects(0)
        .build()
        .into();
    let mut at = url.to_string();
    let mut hops = 0;
    let resp = loop {
        if !host_ok(&at) {
            return Err(offline(format!("not an update host: {at}")));
        }
        let resp = agent.get(&at).call().map_err(offline)?;
        if !resp.status().is_redirection() {
            break resp;
        }
        hops += 1;
        let next = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        match next {
            Some(n) if hops <= 5 => at = n,
            _ => return Err(offline("too many redirects")),
        }
    };
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if total > limit {
        return Err(offline("too big"));
    }
    let mut reader = resp.into_body().into_reader();
    let mut out = Vec::with_capacity(total as usize);
    let mut buf = [0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        let n = reader.read(&mut buf).map_err(offline)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() as u64 > limit {
            return Err(offline("too big"));
        }
        on_progress(out.len() as u64, total.max(out.len() as u64));
    }
    Ok(out)
}

async fn get(url: String, limit: u64) -> Result<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || {
        http_get(&url, &|_, _| {}, &AtomicBool::new(false), limit)
    })
    .await
    .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?
}

async fn directory(u: &Updates, fresh: bool) -> Result<firmware::Directory> {
    if !fresh {
        if let Some((at, d)) = &*u.list.lock().unwrap() {
            if at.elapsed() < LIST_FRESH {
                return Ok(d.clone());
            }
        }
    }
    let json = get(firmware::DIRECTORY_URL.into(), 8 * 1024 * 1024).await?;
    let d = firmware::parse_directory(&json)?;
    *u.list.lock().unwrap() = Some((Instant::now(), d.clone()));
    Ok(d)
}

fn target(m: &Manager) -> String {
    m.current()
        .info
        .map(|i| i.target)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "f7".into())
}

#[tauri::command]
pub async fn firmware_latest(
    m: State<'_, Arc<Manager>>,
    u: State<'_, Updates>,
    channel: String,
) -> Result<Option<Release>> {
    if let Some((owner, repo)) = firmware::gh_channel(&channel) {
        let json = get(
            format!("https://api.github.com/repos/{owner}/{repo}/releases/latest"),
            4 * 1024 * 1024,
        )
        .await?;
        let (rel, pkg) = firmware::parse_gh_release(&json, &owner, &repo, &channel, &target(&m))?;
        return Ok(pkg.map(|_| rel));
    }
    let dir = directory(&u, false).await?;
    Ok(firmware::latest(&dir, &channel, &target(&m)).map(|(v, _)| firmware::release(v, &channel)))
}

#[tauri::command]
pub async fn firmware_fork_latest(
    m: State<'_, Arc<Manager>>,
) -> Result<Option<firmware::ForkRelease>> {
    let Some(info) = m.current().info else {
        return Err(ErrorCode::Disconnected.into());
    };
    if firmware::is_official(&info.fork, &info.origin) {
        return Ok(None);
    }
    let Some((owner, repo)) = firmware::github_repo(&info.origin) else {
        return Ok(None);
    };
    let json = get(
        format!("https://api.github.com/repos/{owner}/{repo}/releases/latest"),
        2 * 1024 * 1024,
    )
    .await?;
    let fork = if info.fork.is_empty() {
        repo.clone()
    } else {
        info.fork.clone()
    };
    Ok(Some(firmware::parse_fork_release(
        &json, &fork, &owner, &repo,
    )?))
}

#[tauri::command]
pub async fn app_latest() -> Result<Option<firmware::AppRelease>> {
    let json = get(
        format!(
            "https://api.github.com/repos/{}/releases?per_page=30",
            firmware::APP_REPO
        ),
        4 * 1024 * 1024,
    )
    .await?;
    firmware::newer_app_release(&json, env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
pub fn app_release_open(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://github.com/") || !url.contains("/releases/") {
        return Err(DeviceError::new(ErrorCode::Failed, "not a release page"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))
}

#[tauri::command]
pub async fn firmware_pick(app: AppHandle, u: State<'_, Updates>) -> Result<Option<Picked>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Pick an update package")
        .add_filter("Update package", &["tgz"])
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let token = format!("package-{}", u.next.fetch_add(1, Ordering::SeqCst));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    u.picked.lock().unwrap().insert(token.clone(), path);
    Ok(Some(Picked { token, name }))
}

#[allow(clippy::too_many_arguments)]
async fn fetch_package(
    app: &AppHandle,
    u: &Updates,
    m: &Manager,
    channel: &str,
    version: &str,
    file: Option<&str>,
    progress: &Channel<InstallProgress>,
    cancel: Arc<AtomicBool>,
) -> Result<Package> {
    let step = |pct: u8| {
        let _ = progress.send(InstallProgress { step: 2, pct });
    };
    if let Some(token) = file {
        let path = u
            .picked
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or_else(|| DeviceError::new(ErrorCode::NotFound, "no package picked"))?;
        let data = std::fs::read(&path)
            .map_err(|e| DeviceError::new(ErrorCode::NotFound, e.to_string()))?;
        step(100);
        return firmware::read_package(&data);
    }
    if let Some((owner, repo)) = firmware::gh_channel(channel) {
        let json = get(
            format!("https://api.github.com/repos/{owner}/{repo}/releases/latest"),
            4 * 1024 * 1024,
        )
        .await?;
        let (rel, pkg) = firmware::parse_gh_release(&json, &owner, &repo, channel, &target(m))?;
        let pkg = pkg.ok_or_else(|| {
            DeviceError::new(ErrorCode::NotFound, "no update package for this Flipper")
        })?;
        if rel.version != version {
            return Err(DeviceError::new(
                ErrorCode::NotFound,
                format!("{version} isn't the latest any more"),
            ));
        }
        let data = {
            let p = progress.clone();
            let c = cancel.clone();
            let url = pkg.url.clone();
            let on = move |done: u64, total: u64| {
                let _ = p.send(InstallProgress {
                    step: 2,
                    pct: percent(done, total),
                });
            };
            tauri::async_runtime::spawn_blocking(move || http_get(&url, &on, &c, 256 * 1024 * 1024))
                .await
                .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))??
        };
        if let Some(sha) = &pkg.sha256 {
            if &firmware::sha256_hex(&data) != sha {
                return Err(DeviceError::new(
                    ErrorCode::BadPackage,
                    "checksum doesn't match",
                ));
            }
        }
        step(100);
        return firmware::read_package(&data);
    }
    let dir = directory(u, true).await?;
    let (v, f) = firmware::latest(&dir, channel, &target(m))
        .filter(|(v, _)| v.version == version)
        .or_else(|| {
            /* an older version still listed on the channel */
            dir.channels
                .iter()
                .flat_map(|c| c.versions.iter())
                .find(|v| v.version == version)
                .and_then(|v| {
                    v.files
                        .iter()
                        .find(|f| {
                            f.kind == "update_tgz" && f.target.eq_ignore_ascii_case(&target(m))
                        })
                        .map(|f| (v, f))
                })
        })
        .ok_or_else(|| DeviceError::new(ErrorCode::NotFound, format!("{version} isn't listed")))?;
    let sha = f.sha256.to_ascii_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(DeviceError::new(
            ErrorCode::BadPackage,
            "no checksum listed",
        ));
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?
        .join("firmware");
    let cached = cache.join(format!("{sha}.tgz"));
    if let Ok(data) = std::fs::read(&cached) {
        if firmware::sha256_hex(&data) == sha {
            step(100);
            return firmware::read_package(&data);
        }
    }
    let url = f.url.clone();
    let _ = v;
    let data = {
        let p = progress.clone();
        let c = cancel.clone();
        let on = move |done: u64, total: u64| {
            let _ = p.send(InstallProgress {
                step: 2,
                pct: percent(done, total),
            });
        };
        tauri::async_runtime::spawn_blocking(move || http_get(&url, &on, &c, 256 * 1024 * 1024))
            .await
            .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))??
    };
    if firmware::sha256_hex(&data) != sha {
        return Err(DeviceError::new(
            ErrorCode::BadPackage,
            "checksum doesn't match",
        ));
    }
    let _ = std::fs::create_dir_all(&cache);
    /* only the newest package is worth keeping */
    if let Ok(old) = std::fs::read_dir(&cache) {
        for e in old.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let _ = std::fs::write(&cached, &data);
    step(100);
    firmware::read_package(&data)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn firmware_install(
    app: AppHandle,
    m: State<'_, Arc<Manager>>,
    u: State<'_, Updates>,
    t: State<'_, Transfers>,
    id: u64,
    channel: String,
    version: String,
    file: Option<String>,
    progress: Channel<InstallProgress>,
) -> Result<DeviceInfo> {
    let _busy = Busy::take(&u.busy)?;
    let cancel = t.start(id);
    let result = install(
        &app,
        &m,
        &u,
        &channel,
        &version,
        file.as_deref(),
        &progress,
        cancel,
    )
    .await;
    t.finish(id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn install(
    app: &AppHandle,
    m: &Arc<Manager>,
    u: &Updates,
    channel: &str,
    version: &str,
    file: Option<&str>,
    progress: &Channel<InstallProgress>,
    cancel: Arc<AtomicBool>,
) -> Result<DeviceInfo> {
    let send = |step: u8, pct: u8| {
        let _ = progress.send(InstallProgress { step, pct });
    };
    /* 0: the SD card, and whether this is a development unit */
    send(0, 0);
    let s = m.session()?;
    let port = m.current().info.map(|i| i.port).unwrap_or_default();
    let (_, pairs) = device::device_info(&s, &port).await?;
    let dev_hardware = pairs
        .iter()
        .any(|(k, v)| k == "hardware_region" && v == "0");
    firmware::check_sd(&s, 0).await?;
    send(0, 100);
    send(1, 0);
    let locale = sys_locale::get_locale().unwrap_or_default();
    match get(firmware::REGION_URL.into(), 1024 * 1024).await {
        Ok(bundle) => match firmware::region_data(&bundle, &locale) {
            Ok((country, data)) => {
                match firmware::provision_region(&s, dev_hardware, &data).await {
                    Ok(true) => s.log_in(
                        "region_data",
                        &format!(
                            "written for {}",
                            if country.is_empty() {
                                "unknown"
                            } else {
                                &country
                            }
                        ),
                    ),
                    Ok(false) => s.log_in("region_data", "development hardware, left as it is"),
                    Err(e) => return Err(e),
                }
            }
            Err(e) => s.log_in("region_data", &format!("not updated: {e}")),
        },
        Err(e) => s.log_in("region_data", &format!("not updated: {e}")),
    }
    send(1, 100);
    /* 2: the package */
    send(2, 0);
    let pkg = fetch_package(app, u, m, channel, version, file, progress, cancel.clone()).await?;
    /* 3: onto the SD card, skipping files already there */
    send(3, 0);
    let s = m.session()?;
    let on_copy: OnProgress = {
        let p = progress.clone();
        Arc::new(move |x: Progress| {
            let _ = p.send(InstallProgress {
                step: 3,
                pct: percent(x.done, x.total),
            });
        })
    };
    firmware::upload_package(&s, &pkg, &on_copy, &cancel).await?;
    send(3, 100);
    send(4, 0);
    if cancel.load(Ordering::SeqCst) {
        return Err(ErrorCode::Cancelled.into());
    }
    firmware::request_update(&s, &pkg).await?;
    drop(s);
    send(4, 100);
    send(5, 0);
    let ticking = Arc::new(AtomicBool::new(true));
    let ticker = {
        let p = progress.clone();
        let on = ticking.clone();
        tauri::async_runtime::spawn(async move {
            let start = Instant::now();
            while on.load(Ordering::SeqCst) {
                let pct = (start.elapsed().as_secs_f64() / UPDATE_TYPICAL.as_secs_f64() * 100.0)
                    .min(95.0);
                let _ = p.send(InstallProgress {
                    step: 5,
                    pct: pct as u8,
                });
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
    };
    let back = m.restart_into_update(UPDATE_WAIT).await;
    ticking.store(false, Ordering::SeqCst);
    let _ = ticker.await;
    let info = back?;
    send(5, 100);
    Ok(info)
}

/* ---------- backups ---------- */

fn backup_dir(app: &AppHandle, m: &Manager) -> Result<PathBuf> {
    let id = m
        .current()
        .info
        .map(|i| i.id)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| DeviceError::from(ErrorCode::Disconnected))?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    Ok(root
        .join("backups")
        .join(crate::services::storage::safe_name(&id)))
}

#[derive(Debug, Clone, Serialize)]
pub struct Backups {
    pub list: Vec<Record>,
    /* when the SD card copy was last brought up to date */
    pub sd: Option<i64>,
}

#[tauri::command]
pub async fn backup_list(app: AppHandle, m: State<'_, Arc<Manager>>) -> Result<Backups> {
    let dir = backup_dir(&app, &m)?;
    Ok(Backups {
        list: backup::list(&dir),
        sd: backup::sd_copy_date(&dir),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn backup_create(
    app: AppHandle,
    m: State<'_, Arc<Manager>>,
    u: State<'_, Updates>,
    t: State<'_, Transfers>,
    id: u64,
    sd: bool,
    progress: Channel<Progress>,
) -> Result<Record> {
    let _busy = Busy::take(&u.busy)?;
    let dir = backup_dir(&app, &m)?;
    let cancel = t.start(id);
    let result = match m.session() {
        Ok(s) => backup::create(&s, &dir, sd, crate::files::throttled(progress), cancel).await,
        Err(e) => Err(e),
    };
    t.finish(id);
    result
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    m: State<'_, Arc<Manager>>,
    u: State<'_, Updates>,
    t: State<'_, Transfers>,
    id: u64,
    backup: String,
    sd: bool,
    progress: Channel<Progress>,
) -> Result<()> {
    let _busy = Busy::take(&u.busy)?;
    let dir = backup_dir(&app, &m)?;
    let cancel = t.start(id);
    let result = match m.session() {
        Ok(s) => {
            backup::restore(
                &s,
                &dir,
                &backup,
                sd,
                crate::files::throttled(progress),
                cancel,
            )
            .await
        }
        Err(e) => Err(e),
    };
    t.finish(id);
    result?;
    m.reboot().await
}
