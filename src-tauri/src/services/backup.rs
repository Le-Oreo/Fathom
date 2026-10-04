use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{DeviceError, ErrorCode};
use crate::rpc::Session;
use crate::services::firmware::{md5_hex, REGION_PATH};
use crate::services::storage::{self, OnProgress, Progress};

type Result<T> = std::result::Result<T, DeviceError>;

const SD_SKIP: &[&str] = &["update"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    /* ms since 1970 */
    pub created: i64,
    /* the SD card copy was brought up to date by this backup */
    pub sd: bool,
    /* bytes of the internal storage backup */
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct SdEntry {
    size: u64,
    md5: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SdManifest {
    updated: i64,
    files: BTreeMap<String, SdEntry>,
}

fn io(e: std::io::Error) -> DeviceError {
    DeviceError::new(ErrorCode::Failed, e.to_string())
}

pub fn stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn valid_id(id: &str) -> bool {
    id.len() == 20
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | 'T' | 'Z'))
}

pub fn list(dir: &Path) -> Vec<Record> {
    let Ok(items) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<Record> = items
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            if !valid_id(id) || !dir.join(format!("{id}.tgz")).is_file() {
                return None;
            }
            serde_json::from_slice::<Record>(&std::fs::read(e.path()).ok()?).ok()
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.created));
    out
}

async fn tree(s: &Session, root: &str) -> Result<Vec<(String, u64)>> {
    storage::remote_files(s, root).await
}

pub async fn create(
    s: &Arc<Session>,
    dir: &Path,
    sd: bool,
    progress: OnProgress,
    cancel: Arc<AtomicBool>,
) -> Result<Record> {
    std::fs::create_dir_all(dir).map_err(io)?;
    let created = now_ms();
    let id = stamp(created);
    let files = tree(s, "/int").await?;
    let sd_plan = if sd { Some(sd_tree(s).await?) } else { None };
    let total = files.iter().map(|f| f.1).sum::<u64>()
        + sd_plan
            .as_ref()
            .map_or(0, |p| p.iter().map(|f| f.1).sum::<u64>());
    progress(Progress { done: 0, total });
    let tgz = dir.join(format!("{id}.tgz"));
    let part = dir.join(format!("{id}.tgz.part"));
    let written = write_internal(s, &files, &part, &progress, total, &cancel).await;
    let size = match written {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    std::fs::rename(&part, &tgz).map_err(io)?;
    let done = files.iter().map(|f| f.1).sum::<u64>();
    if let Some(plan) = sd_plan {
        let r = update_sd_copy(s, dir, &plan, &progress, done, total, &cancel).await;
        if let Err(e) = r {
            let _ = std::fs::remove_file(&tgz);
            return Err(e);
        }
    }
    let rec = Record {
        id: id.clone(),
        created,
        sd,
        size,
    };
    let json = serde_json::to_vec_pretty(&rec)
        .map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    std::fs::write(dir.join(format!("{id}.json")), json).map_err(io)?;
    progress(Progress { done: total, total });
    Ok(rec)
}

async fn write_internal(
    s: &Arc<Session>,
    files: &[(String, u64)],
    to: &Path,
    progress: &OnProgress,
    total: u64,
    cancel: &Arc<AtomicBool>,
) -> Result<u64> {
    let out = std::fs::File::create(to).map_err(io)?;
    let gz = flate2::write::GzEncoder::new(out, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    let header = |size: u64, dir: bool| {
        let mut h = tar::Header::new_gnu();
        h.set_size(size);
        h.set_mode(if dir { 0o755 } else { 0o644 });
        h.set_entry_type(if dir {
            tar::EntryType::Directory
        } else {
            tar::EntryType::Regular
        });
        h.set_mtime((now_ms() / 1000) as u64);
        h
    };
    let mut h = header(0, true);
    tar.append_data(&mut h, "int/", std::io::empty())
        .map_err(io)?;
    let mut done = 0u64;
    for (rel, size) in files {
        if cancel.load(Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        if let Some(d) = rel.strip_suffix('/') {
            let mut h = header(0, true);
            tar.append_data(&mut h, format!("int/{d}/"), std::io::empty())
                .map_err(io)?;
            continue;
        }
        let p = progress.clone();
        let before = done;
        let part: OnProgress = Arc::new(move |x: Progress| {
            p(Progress {
                done: before + x.done,
                total,
            })
        });
        let data =
            storage::read(s, &format!("/int/{rel}"), Some(part), Some(cancel.clone())).await?;
        let mut h = header(data.len() as u64, false);
        tar.append_data(&mut h, format!("int/{rel}"), &data[..])
            .map_err(io)?;
        done += size;
    }
    let gz = tar.into_inner().map_err(io)?;
    let file = gz.finish().map_err(io)?;
    file.sync_all().map_err(io)?;
    Ok(std::fs::metadata(to).map_err(io)?.len())
}

async fn sd_tree(s: &Session) -> Result<Vec<(String, u64)>> {
    if crate::services::device::storage_info(s, "/ext")
        .await?
        .is_none()
    {
        return Err(ErrorCode::NoSd.into());
    }
    let all = tree(s, "/ext").await?;
    Ok(all
        .into_iter()
        .filter(|(rel, _)| {
            let top = rel.split('/').next().unwrap_or("");
            !SD_SKIP.contains(&top) && !rel.ends_with(".fathom-part")
        })
        .collect())
}

fn read_manifest(dir: &Path) -> SdManifest {
    std::fs::read(dir.join("sd.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, m: &SdManifest) -> Result<()> {
    let json =
        serde_json::to_vec(m).map_err(|e| DeviceError::new(ErrorCode::Failed, e.to_string()))?;
    let part = dir.join("sd.json.part");
    std::fs::write(&part, json).map_err(io)?;
    std::fs::rename(part, dir.join("sd.json")).map_err(io)
}

fn local(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        p.push(storage::safe_name(part));
    }
    p
}

async fn update_sd_copy(
    s: &Arc<Session>,
    dir: &Path,
    plan: &[(String, u64)],
    progress: &OnProgress,
    before: u64,
    total: u64,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    let root = dir.join("sd");
    std::fs::create_dir_all(&root).map_err(io)?;
    let mut manifest = read_manifest(dir);
    let mut done = before;
    let result: Result<()> = async {
        for (rel, size) in plan {
            if cancel.load(Ordering::SeqCst) {
                return Err(ErrorCode::Cancelled.into());
            }
            if let Some(d) = rel.strip_suffix('/') {
                std::fs::create_dir_all(local(&root, d)).map_err(io)?;
                continue;
            }
            let path = format!("/ext/{rel}");
            let known = manifest.files.get(rel).cloned();
            let here = local(&root, rel);
            let unchanged = match &known {
                Some(k) if k.size == *size && here.is_file() => {
                    storage::md5(s, &path).await?.eq_ignore_ascii_case(&k.md5)
                }
                _ => false,
            };
            if !unchanged {
                let p = progress.clone();
                let at = done;
                let part: OnProgress = Arc::new(move |x: Progress| {
                    p(Progress {
                        done: at + x.done,
                        total,
                    })
                });
                let data = storage::read(s, &path, Some(part), Some(cancel.clone())).await?;
                if let Some(parent) = here.parent() {
                    std::fs::create_dir_all(parent).map_err(io)?;
                }
                std::fs::write(&here, &data).map_err(io)?;
                manifest.files.insert(
                    rel.clone(),
                    SdEntry {
                        size: data.len() as u64,
                        md5: md5_hex(&data),
                    },
                );
            }
            done += size;
            progress(Progress { done, total });
        }
        Ok(())
    }
    .await;
    if result.is_ok() {
        manifest.updated = now_ms();
    }
    write_manifest(dir, &manifest)?;
    result
}

pub fn sd_copy_date(dir: &Path) -> Option<i64> {
    let m = read_manifest(dir);
    (m.updated > 0).then_some(m.updated)
}

fn read_internal(tgz: &Path) -> Result<Vec<(String, Option<Vec<u8>>)>> {
    let bad = |d: &str| DeviceError::new(ErrorCode::BadPackage, d.to_string());
    let file = std::fs::File::open(tgz).map_err(io)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut out = Vec::new();
    for entry in archive.entries().map_err(|_| bad("not a .tgz"))? {
        let mut entry = entry.map_err(|_| bad("damaged backup"))?;
        let path = entry.path().map_err(|_| bad("odd path"))?.into_owned();
        let mut parts = Vec::new();
        for c in path.components() {
            match c {
                std::path::Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
                std::path::Component::CurDir => {}
                _ => return Err(bad("path leaves the backup")),
            }
        }
        if parts.first().map(String::as_str) != Some("int") || parts.len() < 2 {
            continue;
        }
        if parts.iter().any(|p| p.contains(['\\', ':'])) {
            return Err(bad("odd name"));
        }
        let flipper = format!("/{}", parts.join("/"));
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            out.push((flipper, None));
        } else if kind.is_file() {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|_| bad("damaged backup"))?;
            out.push((flipper, Some(data)));
        }
    }
    Ok(out)
}

async fn mkdir_ok(s: &Session, path: &str) -> Result<()> {
    match storage::mkdir(s, path).await {
        Err(e) if e.code == ErrorCode::Exists => Ok(()),
        r => r,
    }
}

async fn parents(s: &Session, path: &str, root: &str) -> Result<()> {
    let rel = path
        .strip_prefix(root)
        .unwrap_or("")
        .trim_start_matches('/');
    let mut at = root.to_string();
    let parts: Vec<&str> = rel.split('/').collect();
    for p in &parts[..parts.len().saturating_sub(1)] {
        at = format!("{at}/{p}");
        mkdir_ok(s, &at).await?;
    }
    Ok(())
}

pub async fn restore(
    s: &Arc<Session>,
    dir: &Path,
    id: &str,
    sd: bool,
    progress: OnProgress,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    if !valid_id(id) {
        return Err(DeviceError::new(ErrorCode::NotFound, id.to_string()));
    }
    let tgz = dir.join(format!("{id}.tgz"));
    if !tgz.is_file() {
        return Err(ErrorCode::NotFound.into());
    }
    let items: Vec<_> = read_internal(&tgz)?
        .into_iter()
        .filter(|(p, _)| p != REGION_PATH)
        .collect();
    let manifest = if sd {
        read_manifest(dir)
    } else {
        SdManifest::default()
    };
    if sd && manifest.files.is_empty() {
        return Err(DeviceError::new(ErrorCode::NotFound, "no SD card copy"));
    }
    let total = items
        .iter()
        .map(|(_, d)| d.as_ref().map_or(0, |d| d.len() as u64))
        .sum::<u64>()
        + manifest.files.values().map(|e| e.size).sum::<u64>();
    progress(Progress { done: 0, total });
    let mut done = 0u64;
    for (path, data) in &items {
        if cancel.load(Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        match data {
            None => mkdir_ok(s, path).await?,
            Some(d) => {
                parents(s, path, "/int").await?;
                storage::write(s, path, d, Some((&progress, done, total)), Some(&cancel)).await?;
                done += d.len() as u64;
            }
        }
    }
    if sd {
        if crate::services::device::storage_info(s, "/ext")
            .await?
            .is_none()
        {
            return Err(ErrorCode::NoSd.into());
        }
        let root = dir.join("sd");
        for (rel, e) in &manifest.files {
            if cancel.load(Ordering::SeqCst) {
                return Err(ErrorCode::Cancelled.into());
            }
            let path = format!("/ext/{rel}");
            let same = match storage::md5(s, &path).await {
                Ok(sum) => sum.eq_ignore_ascii_case(&e.md5),
                Err(err) if err.code == ErrorCode::NotFound => false,
                Err(err) => return Err(err),
            };
            if !same {
                let data = std::fs::read(local(&root, rel)).map_err(io)?;
                parents(s, &path, "/ext").await?;
                storage::write(
                    s,
                    &path,
                    &data,
                    Some((&progress, done, total)),
                    Some(&cancel),
                )
                .await?;
            }
            done += e.size;
            progress(Progress { done, total });
        }
    }
    progress(Progress { done: total, total });
    Ok(())
}
