use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::{DeviceError, ErrorCode};
use crate::rpc::Session;
use crate::services::firmware::md5_hex;
use crate::services::storage::{self, OnProgress, Progress};

type Result<T> = std::result::Result<T, DeviceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    /* path under the linked folders, with '/' */
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub new: Vec<Item>,
    pub changed: Vec<Item>,
    pub extra: Vec<Item>,
    /* files already the same on both */
    pub same: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Done {
    pub copied: usize,
    pub removed: usize,
}

fn io(e: std::io::Error) -> DeviceError {
    DeviceError::new(ErrorCode::Failed, e.to_string())
}

fn local_files(root: &Path) -> Result<Vec<Item>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(io)?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let meta = e.metadata().map_err(io)?;
            if meta.is_dir() {
                stack.push((e.path(), child));
            } else if meta.is_file() {
                out.push(Item {
                    rel: child,
                    size: meta.len(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn local_path(root: &Path, rel: &str) -> std::path::PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |p, part| p.join(part))
}

pub async fn plan(s: &Session, local: &Path, remote: &str) -> Result<Plan> {
    if !local.is_dir() {
        return Err(DeviceError::new(
            ErrorCode::NotFound,
            "the computer's folder is gone",
        ));
    }
    let here = local_files(local)?;
    let there: Vec<Item> = match storage::remote_files(s, remote).await {
        Ok(list) => list
            .into_iter()
            /* hidden files are left out on both sides */
            .filter(|(rel, _)| !rel.ends_with('/') && !rel.split('/').any(|p| p.starts_with('.')))
            .map(|(rel, size)| Item { rel, size })
            .collect(),
        Err(e) if e.code == ErrorCode::NotFound => vec![],
        Err(e) => return Err(e),
    };
    let same_name = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let mut p = Plan::default();
    for item in &here {
        match there.iter().find(|t| same_name(&t.rel, &item.rel)) {
            None => p.new.push(item.clone()),
            Some(t) if t.size != item.size => p.changed.push(item.clone()),
            Some(t) => {
                let data = std::fs::read(local_path(local, &item.rel)).map_err(io)?;
                let sum = storage::md5(s, &format!("{remote}/{}", t.rel)).await?;
                if sum.eq_ignore_ascii_case(&md5_hex(&data)) {
                    p.same += 1;
                } else {
                    p.changed.push(item.clone());
                }
            }
        }
    }
    p.extra = there
        .into_iter()
        .filter(|t| !here.iter().any(|h| same_name(&h.rel, &t.rel)))
        .collect();
    p.extra.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(p)
}

async fn mkdirs(s: &Session, remote: &str, rel: &str) -> Result<()> {
    let mut at = remote.to_string();
    let parts: Vec<&str> = rel.split('/').collect();
    for p in &parts[..parts.len() - 1] {
        at = format!("{at}/{p}");
        match storage::mkdir(s, &at).await {
            Err(e) if e.code != ErrorCode::Exists => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

pub async fn apply(
    s: &Session,
    local: &Path,
    remote: &str,
    plan: &Plan,
    remove: &[String],
    progress: OnProgress,
    cancel: &AtomicBool,
) -> Result<Done> {
    let todo: Vec<&Item> = plan.new.iter().chain(plan.changed.iter()).collect();
    let total: u64 = todo.iter().map(|i| i.size).sum();
    progress(Progress { done: 0, total });
    match storage::mkdir(s, remote).await {
        Err(e) if e.code != ErrorCode::Exists => return Err(e),
        _ => {}
    }
    let mut done = 0u64;
    let mut out = Done {
        copied: 0,
        removed: 0,
    };
    for item in todo {
        if cancel.load(Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        mkdirs(s, remote, &item.rel).await?;
        let data = std::fs::read(local_path(local, &item.rel)).map_err(io)?;
        let path = format!("{remote}/{}", item.rel);
        storage::write(
            s,
            &path,
            &data,
            Some((&progress, done, total)),
            Some(cancel),
        )
        .await?;
        done += item.size;
        out.copied += 1;
    }
    {
        /* never a file just copied, whatever its case */
        let copied: Vec<&str> = plan
            .new
            .iter()
            .chain(plan.changed.iter())
            .map(|i| i.rel.as_str())
            .collect();
        for item in plan
            .extra
            .iter()
            .filter(|i| remove.contains(&i.rel))
            .filter(|i| !copied.iter().any(|c| c.eq_ignore_ascii_case(&i.rel)))
        {
            if cancel.load(Ordering::SeqCst) {
                return Err(ErrorCode::Cancelled.into());
            }
            match storage::delete(s, &format!("{remote}/{}", item.rel), false).await {
                Err(e) if e.code != ErrorCode::NotFound => return Err(e),
                _ => out.removed += 1,
            }
        }
    }
    progress(Progress { done: total, total });
    Ok(out)
}
