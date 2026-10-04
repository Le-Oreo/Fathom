use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::error::{DeviceError, ErrorCode};
use crate::rpc::proto::pb_storage::{self, file::FileType};
use crate::rpc::{Content, RpcError, Session, REQUEST_TIMEOUT};

pub const PART: usize = 512;
/* parts sent before checking progress and Cancel */
const BATCH: usize = 16;
pub const IDLE: Duration = Duration::from_secs(20);

type Result<T> = std::result::Result<T, DeviceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

pub type OnProgress = Arc<dyn Fn(Progress) + Send + Sync>;

fn entry(f: pb_storage::File) -> Entry {
    let dir = f.r#type == FileType::Dir as i32;
    Entry {
        name: f.name,
        dir,
        size: if dir { 0 } else { u64::from(f.size) },
    }
}

fn join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

async fn list_raw(s: &Session, path: &str) -> Result<Vec<Entry>> {
    let req = Content::StorageListRequest(pb_storage::ListRequest {
        path: path.into(),
        ..Default::default()
    });
    let parts = s.request(req, path, IDLE).await?;
    Ok(parts
        .into_iter()
        .flat_map(|m| match m.content {
            Some(Content::StorageListResponse(r)) => r.file,
            _ => vec![],
        })
        .map(entry)
        .collect())
}

async fn stat_raw(s: &Session, path: &str) -> Result<Entry> {
    let req = Content::StorageStatRequest(pb_storage::StatRequest { path: path.into() });
    let parts = s.request(req, path, REQUEST_TIMEOUT).await?;
    parts
        .into_iter()
        .find_map(|m| match m.content {
            Some(Content::StorageStatResponse(r)) => r.file,
            _ => None,
        })
        .map(entry)
        .ok_or_else(|| ErrorCode::NotFound.into())
}

async fn mkdir_raw(s: &Session, path: &str) -> Result<()> {
    let req = Content::StorageMkdirRequest(pb_storage::MkdirRequest { path: path.into() });
    s.request(req, path, REQUEST_TIMEOUT).await?;
    Ok(())
}

async fn rename_raw(s: &Session, from: &str, to: &str) -> Result<()> {
    let req = Content::StorageRenameRequest(pb_storage::RenameRequest {
        old_path: from.into(),
        new_path: to.into(),
    });
    s.request(req, &format!("{from} → {to}"), REQUEST_TIMEOUT)
        .await?;
    Ok(())
}

/* Deleting a big folder can take the Flipper a while. */
async fn delete_raw(s: &Session, path: &str, recursive: bool) -> Result<()> {
    let detail = if recursive {
        format!("{path} (and everything in it)")
    } else {
        path.to_string()
    };
    let req = Content::StorageDeleteRequest(pb_storage::DeleteRequest {
        path: path.into(),
        recursive,
    });
    s.request(req, &detail, Duration::from_secs(60)).await?;
    Ok(())
}

async fn md5_raw(s: &Session, path: &str) -> Result<String> {
    let req = Content::StorageMd5sumRequest(pb_storage::Md5sumRequest { path: path.into() });
    let parts = s.request(req, path, Duration::from_secs(60)).await?;
    parts
        .into_iter()
        .find_map(|m| match m.content {
            Some(Content::StorageMd5sumResponse(r)) => Some(r.md5sum),
            _ => None,
        })
        .ok_or_else(|| ErrorCode::Failed.into())
}

pub async fn read(
    s: &Arc<Session>,
    path: &str,
    progress: Option<OnProgress>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Vec<u8>> {
    let total = match &progress {
        Some(_) => stat(s, path).await.map(|e| e.size).unwrap_or(0),
        None => 0,
    };
    let mut got = 0u64;
    let on_part = Box::new(move |m: &crate::rpc::proto::pb::Main| {
        if let Some(Content::StorageReadResponse(r)) = &m.content {
            got += r.file.as_ref().map_or(0, |f| f.data.len() as u64);
            if let Some(p) = &progress {
                p(Progress {
                    done: got,
                    total: total.max(got),
                });
            }
        }
    });
    let req = Content::StorageReadRequest(pb_storage::ReadRequest { path: path.into() });
    let session = s.clone();
    let path_owned = path.to_string();
    let turn = s.storage_turn().await;
    let reading = tokio::spawn(async move {
        let _turn = turn;
        session.request_parts(req, &path_owned, IDLE, on_part).await
    });
    let parts = match cancel {
        None => reading
            .await
            .map_err(|_| DeviceError::from(ErrorCode::Failed))??,
        Some(cancel) => {
            let mut reading = reading;
            loop {
                tokio::select! {
                    r = &mut reading => break r.map_err(|_| DeviceError::from(ErrorCode::Failed))??,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if cancel.load(Ordering::SeqCst) {
                            return Err(ErrorCode::Cancelled.into());
                        }
                    }
                }
            }
        }
    };
    Ok(parts
        .into_iter()
        .flat_map(|m| match m.content {
            Some(Content::StorageReadResponse(r)) => r.file.map(|f| f.data).unwrap_or_default(),
            _ => vec![],
        })
        .collect())
}

pub async fn list(s: &Session, path: &str) -> Result<Vec<Entry>> {
    let _turn = s.storage_turn().await;
    list_raw(s, path).await
}

pub async fn stat(s: &Session, path: &str) -> Result<Entry> {
    let _turn = s.storage_turn().await;
    stat_raw(s, path).await
}

pub async fn mkdir(s: &Session, path: &str) -> Result<()> {
    let _turn = s.storage_turn().await;
    mkdir_raw(s, path).await
}

pub async fn rename(s: &Session, from: &str, to: &str) -> Result<()> {
    let _turn = s.storage_turn().await;
    rename_raw(s, from, to).await
}

pub async fn delete(s: &Session, path: &str, recursive: bool) -> Result<()> {
    let _turn = s.storage_turn().await;
    delete_raw(s, path, recursive).await
}

pub async fn md5(s: &Session, path: &str) -> Result<String> {
    let _turn = s.storage_turn().await;
    md5_raw(s, path).await
}

pub async fn write(
    s: &Session,
    path: &str,
    data: &[u8],
    progress: Option<(&OnProgress, u64, u64)>,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    let _turn = s.storage_turn().await;
    let exists = matches!(stat_raw(s, path).await, Ok(e) if !e.dir);
    if !exists {
        return write_raw(s, path, data, progress, cancel).await;
    }
    let temp = temp_name(path);
    let _ = delete_raw(s, &temp, false).await;
    write_raw(s, &temp, data, progress, cancel).await?;
    delete_raw(s, path, false).await?;
    rename_raw(s, &temp, path).await
}

pub async fn write_in_place(s: &Session, path: &str, data: &[u8]) -> Result<()> {
    let _turn = s.storage_turn().await;
    write_raw(s, path, data, None, None).await
}

fn temp_name(path: &str) -> String {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    format!("{dir}/.{name}.fathom-part")
}

fn write_part(path: &str, data: &[u8]) -> Content {
    Content::StorageWriteRequest(pb_storage::WriteRequest {
        path: path.into(),
        file: Some(pb_storage::File {
            data: data.to_vec(),
            ..Default::default()
        }),
    })
}

async fn write_raw(
    s: &Session,
    path: &str,
    data: &[u8],
    progress: Option<(&OnProgress, u64, u64)>,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    let chunks: Vec<&[u8]> = if data.is_empty() {
        vec![&[][..]]
    } else {
        data.chunks(PART).collect()
    };
    let n = chunks.len();
    let first = write_part(path, chunks[0]);
    let call = s.begin(&first, path)?;
    let mut sent = 0u64;
    let mut cancelled = false;
    for (i, chunk) in chunks.iter().enumerate() {
        let last = i + 1 == n;
        s.send_part(&call, write_part(path, chunk), !last)?;
        sent += chunk.len() as u64;
        if (i + 1) % BATCH == 0 || last {
            s.flushed().await?;
            if let Some((p, before, total)) = progress {
                p(Progress {
                    done: before + sent,
                    total,
                });
            }
            if s.answered(&call) {
                break; /* an error came back early: finish has it */
            }
            if !last && cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                /* close the write cleanly, then remove the partial file */
                s.send_part(&call, write_part(path, &[]), false)?;
                cancelled = true;
                break;
            }
        }
    }
    let result = s.finish(call, IDLE).await;
    if cancelled {
        let _ = delete_raw(s, path, false).await;
        return Err(ErrorCode::Cancelled.into());
    }
    if let Err(e) = result {
        if !matches!(e, RpcError::Disconnected) {
            let _ = delete_raw(s, path, false).await;
        }
        return Err(e.into());
    }
    Ok(())
}

fn local_files(root: &Path) -> std::io::Result<Vec<(String, u64)>> {
    let meta = std::fs::metadata(root)?;
    if meta.is_file() {
        return Ok(vec![(String::new(), meta.len())]);
    }
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let mut items: Vec<_> = std::fs::read_dir(&dir)?.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for item in items {
            let name = item.file_name().to_string_lossy().into_owned();
            let rel_child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let meta = item.metadata()?;
            if meta.is_dir() {
                out.push((format!("{rel_child}/"), 0));
                stack.push((item.path(), rel_child));
            } else if meta.is_file() {
                out.push((rel_child, meta.len()));
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Uploaded {
    pub name: String,
    pub files: usize,
    pub skipped: usize,
}

pub async fn already_there(s: &Session, path: &str, data: &[u8]) -> Result<bool> {
    match stat(s, path).await {
        Ok(e) if !e.dir && e.size == data.len() as u64 => {
            let here = md5(s, path).await?;
            Ok(here.eq_ignore_ascii_case(&crate::services::firmware::md5_hex(data)))
        }
        Ok(_) => Ok(false),
        Err(e) if e.code == ErrorCode::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

pub async fn upload(
    s: &Session,
    local: &Path,
    remote_dir: &str,
    progress: OnProgress,
    cancel: &AtomicBool,
) -> Result<Uploaded> {
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| DeviceError::new(ErrorCode::InvalidName, local.display().to_string()))?;
    let io = |e: std::io::Error| DeviceError::new(ErrorCode::Failed, e.to_string());
    let files = local_files(local).map_err(io)?;
    let total: u64 = files.iter().map(|(_, n)| n).sum();
    let top = join(remote_dir, &name);
    progress(Progress { done: 0, total });
    if std::fs::metadata(local).map_err(io)?.is_dir() {
        mkdir_ok(s, &top).await?;
    }
    let mut done = 0u64;
    let (mut count, mut skipped) = (0, 0);
    for (rel, size) in files {
        if cancel.load(Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        if let Some(dir) = rel.strip_suffix('/') {
            mkdir_ok(s, &join(&top, dir)).await?;
            continue;
        }
        let (src, dst) = if rel.is_empty() {
            (local.to_path_buf(), top.clone())
        } else {
            (local.join(&rel), join(&top, &rel))
        };
        let data = std::fs::read(&src).map_err(io)?;
        count += 1;
        if already_there(s, &dst, &data).await? {
            skipped += 1;
        } else {
            write(s, &dst, &data, Some((&progress, done, total)), Some(cancel)).await?;
        }
        done += size;
        progress(Progress { done, total });
    }
    progress(Progress { done: total, total });
    Ok(Uploaded {
        name,
        files: count,
        skipped,
    })
}

async fn mkdir_ok(s: &Session, path: &str) -> Result<()> {
    match mkdir(s, path).await {
        Err(e) if e.code == ErrorCode::Exists => Ok(()),
        r => r,
    }
}

pub fn safe_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    /* Windows drops trailing dots and spaces */
    while out.ends_with(['.', ' ']) {
        out.pop();
    }
    if out.is_empty() || out.chars().all(|c| c == '.') {
        return "download".into();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.insert(0, '_');
    }
    out
}

fn local_rel(rel: &str) -> PathBuf {
    rel.split('/')
        .filter(|p| !p.is_empty())
        .map(safe_name)
        .collect()
}

pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

pub(crate) async fn remote_files(s: &Session, root: &str) -> Result<Vec<(String, u64)>> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let path = if rel.is_empty() {
            root.to_string()
        } else {
            join(root, &rel)
        };
        for e in list(s, &path).await? {
            let child = if rel.is_empty() {
                e.name.clone()
            } else {
                format!("{rel}/{}", e.name)
            };
            if e.dir {
                out.push((format!("{child}/"), 0));
                stack.push(child);
            } else {
                out.push((child, e.size));
            }
        }
    }
    Ok(out)
}

pub async fn download(
    s: &Arc<Session>,
    remote: &str,
    dir: bool,
    local_dir: &Path,
    progress: OnProgress,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let name = safe_name(remote.rsplit('/').next().unwrap_or(""));
    let target = free_name(local_dir, &name);
    let io = |e: std::io::Error| DeviceError::new(ErrorCode::Failed, e.to_string());
    let files = if dir {
        remote_files(s, remote).await?
    } else {
        vec![(String::new(), stat(s, remote).await?.size)]
    };
    let total: u64 = files.iter().map(|(_, n)| n).sum();
    progress(Progress { done: 0, total });
    let result: Result<()> = async {
        if dir {
            std::fs::create_dir_all(&target).map_err(io)?;
        }
        let mut done = 0u64;
        for (rel, size) in &files {
            if cancel.load(Ordering::SeqCst) {
                return Err(ErrorCode::Cancelled.into());
            }
            if let Some(d) = rel.strip_suffix('/') {
                std::fs::create_dir_all(target.join(local_rel(d))).map_err(io)?;
                continue;
            }
            let (src, dst) = if rel.is_empty() {
                (remote.to_string(), target.clone())
            } else {
                (join(remote, rel), target.join(local_rel(rel)))
            };
            let p = progress.clone();
            let before = done;
            let part: OnProgress = Arc::new(move |x: Progress| {
                p(Progress {
                    done: before + x.done,
                    total,
                })
            });
            let data = read(s, &src, Some(part), Some(cancel.clone())).await?;
            std::fs::write(&dst, data).map_err(io)?;
            done += size;
        }
        progress(Progress { done: total, total });
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = if dir {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        return Err(e);
    }
    Ok(target)
}
