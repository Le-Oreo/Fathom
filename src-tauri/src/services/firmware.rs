use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::AtomicBool;

use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DeviceError, ErrorCode};
use crate::rpc::proto::{pb, pb_system};
use crate::rpc::{Content, Session, REQUEST_TIMEOUT};
use crate::services::device;
use crate::services::storage::{self, OnProgress, Progress};

type Result<T> = std::result::Result<T, DeviceError>;

pub const DIRECTORY_URL: &str = "https://update.flipperzero.one/firmware/directory.json";
pub const REGION_URL: &str = "https://update.flipperzero.one/regions/api/v0/bundle";
pub const REGION_PATH: &str = "/int/.region_data";
pub const UPDATE_DIR: &str = "/ext/update";
const MAX_PACKAGE: u64 = 96 * 1024 * 1024;

/* ---------- the firmware list ---------- */

#[derive(Debug, Clone, Deserialize)]
pub struct Directory {
    pub channels: Vec<DirChannel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DirChannel {
    pub id: String,
    #[serde(default)]
    pub versions: Vec<DirVersion>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DirVersion {
    pub version: String,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub files: Vec<DirFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DirFile {
    pub url: String,
    pub target: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Release {
    pub version: String,
    pub channel: String,
    pub changelog: String,
    /* ms since 1970 */
    pub date: i64,
}

/* The UI's channel names and the update server's. */
pub fn server_channel(ui: &str) -> Option<&'static str> {
    match ui {
        "release" => Some("release"),
        "rc" => Some("release-candidate"),
        "dev" => Some("development"),
        _ => None,
    }
}

pub fn latest<'a>(
    dir: &'a Directory,
    channel: &str,
    target: &str,
) -> Option<(&'a DirVersion, &'a DirFile)> {
    let server = server_channel(channel)?;
    dir.channels
        .iter()
        .filter(|c| c.id == server)
        .flat_map(|c| c.versions.iter())
        .filter_map(|v| package_file(v, target).map(|f| (v, f)))
        .max_by_key(|(v, _)| v.timestamp)
}

fn package_file<'a>(v: &'a DirVersion, target: &str) -> Option<&'a DirFile> {
    v.files
        .iter()
        .find(|f| f.kind == "update_tgz" && f.target.eq_ignore_ascii_case(target))
}

pub fn release(v: &DirVersion, channel: &str) -> Release {
    Release {
        version: v.version.clone(),
        channel: channel.into(),
        changelog: v.changelog.clone(),
        date: v.timestamp * 1000,
    }
}

pub fn parse_directory(json: &[u8]) -> Result<Directory> {
    serde_json::from_slice(json).map_err(|e| DeviceError::new(ErrorCode::Offline, e.to_string()))
}

/* ---------- other people's firmware ---------- */

pub fn is_official(fork: &str, origin: &str) -> bool {
    (fork.is_empty() && origin.is_empty())
        || fork.eq_ignore_ascii_case("official")
        || origin.contains("github.com/flipperdevices/flipperzero-firmware")
}

pub fn github_repo(origin: &str) -> Option<(String, String)> {
    let rest = origin.trim().strip_prefix("https://github.com/")?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let (owner, repo) = rest.split_once('/')?;
    let plain = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !s.starts_with('.')
    };
    (plain(owner) && plain(repo)).then(|| (owner.to_string(), repo.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForkRelease {
    pub fork: String,
    pub version: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
}

pub fn gh_channel(channel: &str) -> Option<(String, String)> {
    github_repo(&format!(
        "https://github.com/{}",
        channel.strip_prefix("gh:")?
    ))
}

#[derive(Debug, Deserialize)]
struct GhFull {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhPackage {
    pub url: String,
    pub sha256: Option<String>,
}

pub fn parse_gh_release(
    json: &[u8],
    owner: &str,
    repo: &str,
    channel: &str,
    target: &str,
) -> Result<(Release, Option<GhPackage>)> {
    let bad = || DeviceError::new(ErrorCode::Offline, "unexpected release data");
    let r: GhFull = serde_json::from_slice(json).map_err(|_| bad())?;
    if !r
        .html_url
        .starts_with(&format!("https://github.com/{owner}/{repo}/releases/"))
        || r.tag_name.is_empty()
        || r.tag_name.len() > 64
    {
        return Err(bad());
    }
    let downloads = format!("https://github.com/{owner}/{repo}/releases/download/");
    let target = target.to_ascii_lowercase();
    let pkg = r
        .assets
        .iter()
        .filter(|a| {
            let n = a.name.to_ascii_lowercase();
            n.ends_with(".tgz")
                && n.contains("update")
                && n.contains(&target)
                && a.browser_download_url.starts_with(&downloads)
        })
        .min_by_key(|a| a.name.len())
        .map(|a| GhPackage {
            url: a.browser_download_url.clone(),
            sha256: a
                .digest
                .as_deref()
                .and_then(|d| d.strip_prefix("sha256:"))
                .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
                .map(|h| h.to_ascii_lowercase()),
        });
    Ok((
        Release {
            version: r.tag_name,
            channel: channel.to_string(),
            changelog: r.body.unwrap_or_default(),
            date: 0,
        },
        pkg,
    ))
}

pub fn parse_fork_release(json: &[u8], fork: &str, owner: &str, repo: &str) -> Result<ForkRelease> {
    let bad = || DeviceError::new(ErrorCode::Offline, "unexpected release data");
    let r: GhRelease = serde_json::from_slice(json).map_err(|_| bad())?;
    let page = format!("https://github.com/{owner}/{repo}/releases/");
    if !r.html_url.starts_with(&page) || r.tag_name.is_empty() || r.tag_name.len() > 64 {
        return Err(bad());
    }
    Ok(ForkRelease {
        fork: fork.to_string(),
        version: r.tag_name,
        url: r.html_url,
    })
}

/* FATHOM's own releases are tagged fathom-v1.2.3 */
pub const APP_REPO: &str = "Le-Oreo/fathom";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppRelease {
    pub version: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct AppReleaseJson {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn version_key(v: &str) -> Option<(u32, u32, u32)> {
    let mut parts = v.split('.').map(|p| p.parse::<u32>().ok());
    let key = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(key)
}

/* The newest published FATHOM release, if it's newer than `current`. */
pub fn newer_app_release(json: &[u8], current: &str) -> Result<Option<AppRelease>> {
    let list: Vec<AppReleaseJson> = serde_json::from_slice(json)
        .map_err(|_| DeviceError::new(ErrorCode::Offline, "unexpected release data"))?;
    let now = version_key(current).unwrap_or_default();
    Ok(list
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease && r.html_url.starts_with("https://github.com/"))
        .filter_map(|r| {
            let v = r.tag_name.strip_prefix("fathom-v")?.to_string();
            Some((
                version_key(&v)?,
                AppRelease {
                    version: v,
                    url: r.html_url,
                },
            ))
        })
        .filter(|(k, _)| *k > now)
        .max_by_key(|(k, _)| *k)
        .map(|(_, r)| r))
}

#[derive(Debug, Deserialize)]
struct Bundle {
    success: Option<BundleOk>,
    error: Option<BundleErr>,
}

#[derive(Debug, Deserialize)]
struct BundleOk {
    bands: HashMap<String, BandJson>,
    countries: HashMap<String, Vec<String>>,
    country: Option<String>,
    default: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BundleErr {
    code: i64,
    text: String,
}

#[derive(Debug, Deserialize)]
struct BandJson {
    start: u32,
    end: u32,
    duty_cycle: u32,
    max_power: i32,
}

pub fn locale_country(locale: &str) -> String {
    locale
        .split(['-', '_', '.', '@'])
        .skip(1)
        .find(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|p| p.to_ascii_uppercase())
        .unwrap_or_default()
}

pub fn region_data(bundle_json: &[u8], locale: &str) -> Result<(String, Vec<u8>)> {
    let bad = |d: &str| DeviceError::new(ErrorCode::Offline, d.to_string());
    let bundle: Bundle =
        serde_json::from_slice(bundle_json).map_err(|_| bad("invalid region data"))?;
    if let Some(e) = bundle.error {
        return Err(bad(&format!("{}: {}", e.code, e.text)));
    }
    let ok = bundle.success.ok_or_else(|| bad("no region data"))?;
    if ok.bands.is_empty() || ok.countries.is_empty() || ok.default.is_empty() {
        return Err(bad("incomplete region data"));
    }
    let country = ok
        .country
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| locale_country(locale));
    let keys = ok.countries.get(&country).unwrap_or(&ok.default);
    let bands = keys
        .iter()
        .filter_map(|k| ok.bands.get(k))
        .map(|b| pb::region::Band {
            start: b.start,
            end: b.end,
            power_limit: b.max_power,
            duty_cycle: b.duty_cycle,
        })
        .collect();
    let msg = pb::Region {
        country_code: country.as_bytes().to_vec(),
        bands,
    };
    Ok((country, msg.encode_to_vec()))
}

pub async fn provision_region(s: &Session, dev_hardware: bool, data: &[u8]) -> Result<bool> {
    if dev_hardware {
        return Ok(false);
    }
    storage::write_in_place(s, REGION_PATH, data).await?;
    Ok(true)
}

/* ---------- the update package ---------- */

#[derive(Debug, Clone)]
pub struct Package {
    pub dir: String,
    pub files: Vec<(String, Vec<u8>)>,
}

impl Package {
    pub fn remote_dir(&self) -> String {
        format!("{UPDATE_DIR}/{}", self.dir)
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

pub fn read_package(tgz: &[u8]) -> Result<Package> {
    let bad = |d: &str| DeviceError::new(ErrorCode::BadPackage, d.to_string());
    let gz = flate2::read::GzDecoder::new(tgz);
    let mut archive = tar::Archive::new(gz);
    let mut dir: Option<String> = None;
    let mut files = Vec::new();
    let mut total = 0u64;
    for entry in archive.entries().map_err(|_| bad("not a .tgz"))? {
        let mut entry = entry.map_err(|_| bad("damaged archive"))?;
        let path = entry.path().map_err(|_| bad("odd path"))?.into_owned();
        let parts: Vec<String> = path
            .components()
            .map(|c| match c {
                std::path::Component::Normal(p) => Ok(p.to_string_lossy().into_owned()),
                std::path::Component::CurDir => Ok(String::new()),
                _ => Err(bad("path leaves the package")),
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect();
        let Some(top) = parts.first() else { continue };
        if !plain_name(top) {
            return Err(bad("odd folder name"));
        }
        match &dir {
            None => dir = Some(top.clone()),
            Some(d) if d != top => return Err(bad("more than one folder")),
            _ => {}
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            continue;
        }
        if !kind.is_file() {
            return Err(bad("links aren't allowed"));
        }
        if parts.len() != 2 {
            continue;
        }
        if !plain_name(&parts[1]) {
            return Err(bad("odd file name"));
        }
        total += entry.size();
        if total > MAX_PACKAGE {
            return Err(bad("too big"));
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut data)
            .map_err(|_| bad("damaged archive"))?;
        files.push((parts[1].clone(), data));
    }
    let dir = dir.ok_or_else(|| bad("empty archive"))?;
    if !files.iter().any(|(n, _)| n == "update.fuf") {
        return Err(bad("no update.fuf"));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Package { dir, files })
}

/* ---------- on the Flipper ---------- */

pub async fn check_sd(s: &Session, needed: u64) -> Result<()> {
    match device::storage_info(s, "/ext").await? {
        None => Err(ErrorCode::NoSd.into()),
        Some(i) if i.total.saturating_sub(i.used) < needed => Err(DeviceError::new(
            ErrorCode::NoRoom,
            format!("{} bytes free, {needed} needed", i.total - i.used),
        )),
        Some(_) => Ok(()),
    }
}

async fn mkdir_ok(s: &Session, path: &str) -> Result<()> {
    match storage::mkdir(s, path).await {
        Err(e) if e.code == ErrorCode::Exists => Ok(()),
        r => r,
    }
}

pub async fn changed_files<'a>(
    s: &Session,
    pkg: &'a Package,
) -> Result<Vec<&'a (String, Vec<u8>)>> {
    let remote = pkg.remote_dir();
    let mut out = Vec::new();
    for f in &pkg.files {
        let here = format!("{remote}/{}", f.0);
        let same = match storage::md5(s, &here).await {
            Ok(sum) => sum.eq_ignore_ascii_case(&md5_hex(&f.1)),
            Err(e) if e.code == ErrorCode::NotFound => false,
            Err(e) => return Err(e),
        };
        if !same {
            out.push(f);
        }
    }
    Ok(out)
}

pub fn md5_hex(data: &[u8]) -> String {
    use md5::{Digest as _, Md5};
    Md5::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub async fn upload_package(
    s: &Session,
    pkg: &Package,
    progress: &OnProgress,
    cancel: &AtomicBool,
) -> Result<usize> {
    mkdir_ok(s, UPDATE_DIR).await?;
    let remote = pkg.remote_dir();
    mkdir_ok(s, &remote).await?;
    let todo = changed_files(s, pkg).await?;
    let total: u64 = todo.iter().map(|(_, d)| d.len() as u64).sum();
    check_sd(s, total).await?;
    progress(Progress { done: 0, total });
    let mut done = 0u64;
    for (name, data) in &todo {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(ErrorCode::Cancelled.into());
        }
        let path = format!("{remote}/{name}");
        storage::write(s, &path, data, Some((progress, done, total)), Some(cancel)).await?;
        done += data.len() as u64;
    }
    progress(Progress { done: total, total });
    Ok(todo.len())
}

fn update_refusal(code: i32) -> DeviceError {
    use pb_system::update_response::UpdateResultCode as C;
    let (err, detail) = match C::try_from(code) {
        Ok(C::TargetMismatch) => (ErrorCode::WrongTarget, "target mismatch"),
        Ok(C::IntFull) => (ErrorCode::NoRoom, "internal storage full"),
        Ok(C::OutdatedManifestVersion) => (ErrorCode::BadPackage, "outdated manifest"),
        Ok(C::UnspecifiedError) | Err(_) => (ErrorCode::Failed, "updater refused"),
        Ok(other) => (ErrorCode::BadPackage, other.as_str_name()),
    };
    DeviceError::new(err, detail)
}

pub async fn request_update(s: &Session, pkg: &Package) -> Result<()> {
    let manifest = format!("{}/update.fuf", pkg.remote_dir());
    let req = Content::SystemUpdateRequest(pb_system::UpdateRequest {
        update_manifest: manifest.clone(),
    });
    let parts = s.request(req, &manifest, REQUEST_TIMEOUT).await?;
    let code = parts
        .into_iter()
        .find_map(|m| match m.content {
            Some(Content::SystemUpdateResponse(r)) => Some(r.code),
            _ => None,
        })
        .unwrap_or(0);
    if code != pb_system::update_response::UpdateResultCode::Ok as i32 {
        return Err(update_refusal(code));
    }
    Ok(())
}
