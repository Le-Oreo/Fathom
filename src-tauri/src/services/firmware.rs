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

#[cfg(test)]
pub fn tgz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    for (path, data) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        b.append_data(&mut h, path, *data).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r#"{"channels":[
      {"id":"release","versions":[
        {"version":"1.4.0","changelog":"Placeholder notes","timestamp":1700000000,"files":[
          {"url":"https://example.invalid/f7-update-1.4.0.tgz","target":"f7","type":"update_tgz","sha256":"aa"},
          {"url":"https://example.invalid/f7-full-1.4.0.dfu","target":"f7","type":"full_dfu","sha256":"bb"}]},
        {"version":"1.3.4","timestamp":1690000000,"files":[
          {"url":"https://example.invalid/f7-update-1.3.4.tgz","target":"f7","type":"update_tgz","sha256":"cc"}]}]},
      {"id":"release-candidate","versions":[
        {"version":"1.5.0-rc","timestamp":1710000000,"files":[
          {"url":"https://example.invalid/f18-update.tgz","target":"f18","type":"update_tgz","sha256":"dd"}]}]}
    ]}"#;

    #[test]
    fn picks_the_newest_package_for_the_target() {
        let d = parse_directory(DIR.as_bytes()).unwrap();
        let (v, f) = latest(&d, "release", "f7").unwrap();
        assert_eq!(v.version, "1.4.0");
        assert!(f.url.ends_with("f7-update-1.4.0.tgz"));
        assert_eq!(release(v, "release").date, 1_700_000_000_000);
        /* the candidate only has a package for another target */
        assert!(latest(&d, "rc", "f7").is_none());
        assert!(latest(&d, "dev", "f7").is_none());
        assert!(latest(&d, "nightly", "f7").is_none());
    }

    #[test]
    fn other_firmware_is_recognised() {
        assert!(is_official("Official", ""));
        assert!(is_official("", ""));
        assert!(!is_official(
            "Momentum",
            "https://github.com/Next-Flip/Momentum-Firmware"
        ));
        assert_eq!(
            github_repo("https://github.com/Next-Flip/Momentum-Firmware.git"),
            Some(("Next-Flip".into(), "Momentum-Firmware".into()))
        );
        assert_eq!(github_repo("https://evil.example/a/b"), None);
        assert_eq!(github_repo("https://github.com/a/../b"), None);
        let json = br#"{"tag_name":"mntm-009","html_url":"https://github.com/Next-Flip/Momentum-Firmware/releases/tag/mntm-009"}"#;
        let r = parse_fork_release(json, "Momentum", "Next-Flip", "Momentum-Firmware").unwrap();
        assert_eq!(r.version, "mntm-009");
        let elsewhere = br#"{"tag_name":"x","html_url":"https://evil.example/"}"#;
        assert!(
            parse_fork_release(elsewhere, "Momentum", "Next-Flip", "Momentum-Firmware").is_err()
        );
    }

    #[test]
    fn app_releases_newer_than_this_one() {
        let json = br#"[
          {"tag_name":"fathom-v0.3.0","html_url":"https://github.com/O/R/releases/tag/fathom-v0.3.0","draft":true},
          {"tag_name":"fathom-v0.2.1","html_url":"https://github.com/O/R/releases/tag/fathom-v0.2.1","prerelease":true},
          {"tag_name":"fathom-v0.2.0","html_url":"https://github.com/O/R/releases/tag/fathom-v0.2.0"},
          {"tag_name":"fathom-v0.10.0","html_url":"https://evil.example/fathom-v0.10.0"},
          {"tag_name":"other-v9.0.0","html_url":"https://github.com/O/R/releases/tag/other-v9.0.0"},
          {"tag_name":"fathom-v0.1.5","html_url":"https://github.com/O/R/releases/tag/fathom-v0.1.5"}
        ]"#;
        let r = newer_app_release(json, "0.1.0").unwrap().unwrap();
        assert_eq!(r.version, "0.2.0");
        assert_eq!(newer_app_release(json, "0.2.0").unwrap(), None);
        assert!(newer_app_release(b"{}", "0.1.0").is_err());
    }

    #[test]
    fn github_releases_give_their_update_package() {
        assert_eq!(
            gh_channel("gh:Next-Flip/Momentum-Firmware"),
            Some(("Next-Flip".into(), "Momentum-Firmware".into()))
        );
        assert_eq!(gh_channel("gh:../x"), None);
        assert_eq!(gh_channel("release"), None);
        let json = br#"{"tag_name":"v9","html_url":"https://github.com/O/R/releases/tag/v9","body":"Placeholder notes",
          "assets":[
            {"name":"flipper-z-f7-update-v9e.tgz","browser_download_url":"https://github.com/O/R/releases/download/v9/flipper-z-f7-update-v9e.tgz"},
            {"name":"flipper-z-f7-update-v9.tgz","browser_download_url":"https://github.com/O/R/releases/download/v9/flipper-z-f7-update-v9.tgz","digest":"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
            {"name":"flipper-z-f7-full-v9.dfu","browser_download_url":"https://github.com/O/R/releases/download/v9/x.dfu"},
            {"name":"flipper-z-f7-update-v.tgz","browser_download_url":"https://elsewhere.example/x.tgz"}]}"#;
        let (rel, pkg) = parse_gh_release(json, "O", "R", "gh:O/R", "f7").unwrap();
        assert_eq!(
            (rel.version.as_str(), rel.changelog.as_str()),
            ("v9", "Placeholder notes")
        );
        let pkg = pkg.unwrap();
        assert!(pkg.url.ends_with("/flipper-z-f7-update-v9.tgz"));
        assert_eq!(pkg.sha256.unwrap(), "a".repeat(64));
        /* no package for another target */
        assert!(parse_gh_release(json, "O", "R", "gh:O/R", "f18")
            .unwrap()
            .1
            .is_none());
    }

    #[test]
    fn locale_countries() {
        assert_eq!(locale_country("en-US"), "US");
        assert_eq!(locale_country("de_DE.UTF-8"), "DE");
        assert_eq!(locale_country("zh-Hans-CN"), "CN");
        assert_eq!(locale_country("en"), "");
    }

    const BUNDLE: &str = r#"{"success":{
      "bands":{"A":{"start":100,"end":200,"duty_cycle":50,"max_power":10},
               "B":{"start":300,"end":400,"duty_cycle":100,"max_power":-5}},
      "countries":{"US":["A","B"],"DE":["B"]},
      "country":null,
      "default":["A"]}}"#;

    #[test]
    fn region_data_follows_the_country() {
        let (c, bytes) = region_data(BUNDLE.as_bytes(), "de-DE").unwrap();
        assert_eq!(c, "DE");
        let r = pb::Region::decode(&bytes[..]).unwrap();
        assert_eq!(r.country_code, b"DE");
        assert_eq!(
            r.bands,
            vec![pb::region::Band {
                start: 300,
                end: 400,
                power_limit: -5,
                duty_cycle: 100
            }]
        );
        let detected = BUNDLE.replace("\"country\":null", "\"country\":\"US\"");
        let (c, bytes) = region_data(detected.as_bytes(), "de-DE").unwrap();
        assert_eq!(c, "US");
        assert_eq!(pb::Region::decode(&bytes[..]).unwrap().bands.len(), 2);
        let (c, bytes) = region_data(BUNDLE.as_bytes(), "fr-FR").unwrap();
        assert_eq!(c, "FR");
        assert_eq!(pb::Region::decode(&bytes[..]).unwrap().bands[0].start, 100);
    }

    #[test]
    fn region_errors_are_errors() {
        assert!(region_data(br#"{"error":{"code":3,"text":"nope"}}"#, "en-US").is_err());
        assert!(region_data(b"{}", "en-US").is_err());
        assert!(region_data(b"not json", "en-US").is_err());
    }

    #[test]
    fn reads_an_update_package() {
        let t = tgz(&[
            ("f7-update-9.9.9/update.fuf", b"placeholder manifest"),
            ("f7-update-9.9.9/firmware.dfu", b"placeholder"),
            ("f7-update-9.9.9/deeper/ignored.txt", b"placeholder"),
        ]);
        let p = read_package(&t).unwrap();
        assert_eq!(p.dir, "f7-update-9.9.9");
        let names: Vec<_> = p.files.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(names, ["firmware.dfu", "update.fuf"]);
        assert_eq!(p.remote_dir(), "/ext/update/f7-update-9.9.9");
    }

    #[test]
    fn refuses_what_isnt_an_update_package() {
        let code = |t: Vec<u8>| read_package(&t).unwrap_err().code;
        assert_eq!(code(b"not a tgz".to_vec()), ErrorCode::BadPackage);
        assert_eq!(
            code(tgz(&[("pkg/readme.txt", b"x")])),
            ErrorCode::BadPackage
        );
        assert_eq!(
            code(tgz(&[("a/update.fuf", b"x"), ("b/update.fuf", b"x")])),
            ErrorCode::BadPackage
        );
        assert_eq!(
            code(tgz(&[("pkg/update.fuf", b"x"), ("pkg/.hidden", b"x")])),
            ErrorCode::BadPackage
        );
    }

    #[test]
    fn update_refusals_get_plain_codes() {
        use pb_system::update_response::UpdateResultCode as C;
        assert_eq!(
            update_refusal(C::TargetMismatch as i32).code,
            ErrorCode::WrongTarget
        );
        assert_eq!(update_refusal(C::IntFull as i32).code, ErrorCode::NoRoom);
        assert_eq!(
            update_refusal(C::ManifestInvalid as i32).code,
            ErrorCode::BadPackage
        );
        assert_eq!(update_refusal(99).code, ErrorCode::Failed);
    }
}
