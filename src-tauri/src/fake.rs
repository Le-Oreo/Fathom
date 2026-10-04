use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use crate::rpc::framing::{self, Decoder};
use crate::rpc::proto::{pb, pb_gui, pb_storage, pb_system};
use crate::rpc::session::content_name;
use crate::rpc::Content;
use crate::transport::{is_idle, Link};

use pb::CommandStatus as S;

#[derive(Clone, Default)]
pub struct FakeConfig {
    pub silent: bool,
    pub quiet_start: bool,
    /* split every write into pieces of this many bytes */
    pub chunk: Option<usize>,
    /* send all parts of one reply in a single write */
    pub batch: bool,
    pub no_sd: bool,
    pub sd_free: Option<u64>,
    /* a development unit (hardware region 0) */
    pub dev_region: bool,
    /* speaks RPC from the start, as over Bluetooth (no CLI) */
    pub rpc_only: bool,
    /* (seed, most ms): pauses now and then while saving to the SD card */
    pub stall: Option<(u64, u64)>,
    /* sends a screen frame every 30 ms while the stream is on */
    pub frames: bool,
}

enum Node {
    Dir,
    File(Vec<u8>),
}

pub struct FakeFlipper {
    cfg: FakeConfig,
    name: String,
    files: BTreeMap<String, Node>,
    writing: Option<(u32, String, Vec<u8>)>,
    clock: Option<pb_system::DateTime>,
    streaming: bool,
    rng: crate::transport::flaky::Rng,
}

/* Controls a running FakeFlipper. */
pub struct FakeHandle {
    unplugged: Arc<AtomicBool>,
    pub ignore: Arc<Mutex<HashSet<String>>>,
    /* every request it received, by name */
    pub received: Arc<Mutex<Vec<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl FakeHandle {
    /* The cable comes out: both ends of the link close. */
    pub fn unplug(&mut self) {
        self.unplugged.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
    pub fn ignore(&self, name: &str) {
        self.ignore.lock().unwrap().insert(name.into());
    }
    pub fn received(&self) -> Vec<String> {
        self.received.lock().unwrap().clone()
    }
}

impl Drop for FakeHandle {
    fn drop(&mut self) {
        self.unplug();
    }
}

impl FakeFlipper {
    pub fn new(name: &str, cfg: FakeConfig) -> Self {
        let mut files = BTreeMap::new();
        for dir in ["/ext", "/ext/subghz", "/ext/notes", "/ext/many", "/int"] {
            files.insert(dir.to_string(), Node::Dir);
        }
        files.insert(
            "/ext/notes/hello.txt".into(),
            Node::File(b"Placeholder text for hello.txt.\n".to_vec()),
        );
        files.insert(
            "/int/settings.txt".into(),
            Node::File(b"Placeholder text.\n".to_vec()),
        );
        for i in 0..20 {
            files.insert(
                format!("/ext/many/file{i:02}.txt"),
                Node::File(vec![b'x'; i]),
            );
        }
        FakeFlipper {
            name: name.into(),
            files,
            writing: None,
            clock: None,
            streaming: false,
            rng: crate::transport::flaky::Rng::new(cfg.stall.map_or(1, |(seed, _)| seed)),
            cfg,
        }
    }

    pub fn spawn(self, link: Link) -> FakeHandle {
        let unplugged = Arc::new(AtomicBool::new(false));
        let ignore = Arc::new(Mutex::new(HashSet::new()));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (u, i, r) = (unplugged.clone(), ignore.clone(), received.clone());
        let thread = thread::spawn(move || self.run(link, u, i, r));
        FakeHandle {
            unplugged,
            ignore,
            received,
            thread: Some(thread),
        }
    }

    fn run(
        mut self,
        link: Link,
        unplugged: Arc<AtomicBool>,
        ignore: Arc<Mutex<HashSet<String>>>,
        received: Arc<Mutex<Vec<String>>>,
    ) {
        let Link {
            mut reader,
            mut writer,
        } = link;
        let cfg = self.cfg.clone();
        let mut out = |bufs: Vec<Vec<u8>>| -> bool {
            let bufs = if cfg.batch { vec![bufs.concat()] } else { bufs };
            for b in bufs.into_iter().filter(|b| !b.is_empty()) {
                let pieces: Vec<&[u8]> = match cfg.chunk {
                    Some(n) => b.chunks(n.max(1)).collect(),
                    None => vec![&b[..]],
                };
                for p in pieces {
                    if writer.write_all(p).is_err() {
                        return false;
                    }
                }
            }
            true
        };
        if !cfg.silent && !cfg.quiet_start && !cfg.rpc_only {
            out(vec![
                b"\r\n\r\n  Welcome to the placeholder CLI\r\n\r\n>: ".to_vec()
            ]);
        }
        let mut cli = !cfg.rpc_only;
        let mut line = Vec::new();
        let mut decoder = Decoder::default();
        let mut buf = [0u8; 2048];
        let mut last_frame = std::time::Instant::now();
        while !unplugged.load(Ordering::SeqCst) {
            if self.streaming && cfg.frames && last_frame.elapsed().as_millis() >= 30 {
                last_frame = std::time::Instant::now();
                if !out(vec![framing::encode(&frame())]) {
                    return;
                }
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => n,
                Err(e) if is_idle(&e) => continue,
                Err(_) => return,
            };
            let mut data = &buf[..n];
            if cli {
                if cfg.silent {
                    continue;
                }
                while let Some((&b, rest)) = data.split_first() {
                    data = rest;
                    match b {
                        /* Ctrl+C: drop the line */
                        0x03 => {
                            line.clear();
                            out(vec![b"^C\r\n>: ".to_vec()]);
                            continue;
                        }
                        /* backspace, as the Flipper's CLI echoes it */
                        0x7f | 0x08 => {
                            if line.pop().is_some() {
                                out(vec![b"\x08 \x08".to_vec()]);
                            }
                            continue;
                        }
                        b'\r' => {}
                        _ => {
                            line.push(b);
                            /* typed characters echo back one by one */
                            out(vec![vec![b]]);
                            continue;
                        }
                    }
                    let cmd = String::from_utf8_lossy(&line).trim().to_string();
                    line.clear();
                    if cmd == "start_rpc_session" {
                        out(vec![b"\r\n".to_vec()]);
                        cli = false;
                        break;
                    }
                    let reply = match cmd.as_str() {
                        "" => "\r\n>: ".to_string(),
                        "help" => "\r\nPlaceholder help: help, info device\r\n>: ".to_string(),
                        _ => format!("\r\n`{cmd}` command not found\r\n>: "),
                    };
                    out(vec![reply.into_bytes()]);
                }
                if cli {
                    continue;
                }
            }
            let msgs = match decoder.push(data) {
                Ok(m) => m,
                Err(_) => return,
            };
            for msg in msgs {
                let Some(content) = msg.content.clone() else {
                    continue;
                };
                let name = content_name(&content);
                received.lock().unwrap().push(name.clone());
                if ignore.lock().unwrap().contains(&name) {
                    continue;
                }
                let replies = self.handle(msg.command_id, msg.has_next, content, &mut cli);
                if replies.is_none() {
                    /* a reboot: the Flipper vanishes */
                    return;
                }
                let frames = replies.unwrap().iter().map(framing::encode).collect();
                if !out(frames) {
                    return;
                }
            }
        }
    }

    fn handle(
        &mut self,
        id: u32,
        has_next: bool,
        content: Content,
        cli: &mut bool,
    ) -> Option<Vec<pb::Main>> {
        let mut out_of_turn = Vec::new();
        let continues = matches!(&self.writing, Some((wid, ..)) if *wid == id)
            && matches!(content, Content::StorageWriteRequest(_));
        if !continues && content_name(&content).starts_with("storage_") {
            if let Some((wid, ..)) = self.writing.take() {
                out_of_turn.push(reply(
                    wid,
                    S::ErrorContinuousCommandInterrupted,
                    false,
                    None,
                ));
            }
        }
        let mut replies = self.answer(id, has_next, content, cli)?;
        out_of_turn.append(&mut replies);
        Some(out_of_turn)
    }

    fn answer(
        &mut self,
        id: u32,
        has_next: bool,
        content: Content,
        cli: &mut bool,
    ) -> Option<Vec<pb::Main>> {
        let ok = |c: Content| vec![reply(id, S::Ok, false, Some(c))];
        let fail = |s: S| vec![reply(id, s, false, None)];
        let empty = || ok(Content::Empty(pb::Empty {}));
        Some(match content {
            Content::SystemPingRequest(r) => {
                ok(Content::SystemPingResponse(pb_system::PingResponse {
                    data: r.data,
                }))
            }
            Content::SystemDeviceInfoRequest(_) => parts(
                id,
                self.device_info()
                    .into_iter()
                    .map(|(key, value)| {
                        Content::SystemDeviceInfoResponse(pb_system::DeviceInfoResponse {
                            key,
                            value,
                        })
                    })
                    .collect(),
            ),
            Content::SystemPowerInfoRequest(_) => parts(
                id,
                [
                    ("charge_level", "86"),
                    ("charge_state", "charging"),
                    ("battery_voltage", "4.1"),
                ]
                .into_iter()
                .map(|(k, v)| {
                    Content::SystemPowerInfoResponse(pb_system::PowerInfoResponse {
                        key: k.into(),
                        value: v.into(),
                    })
                })
                .collect(),
            ),
            Content::SystemPlayAudiovisualAlertRequest(_) => empty(),
            Content::SystemGetDatetimeRequest(_) => ok(Content::SystemGetDatetimeResponse(
                pb_system::GetDateTimeResponse {
                    datetime: Some(self.clock.unwrap_or(pb_system::DateTime {
                        hour: 9,
                        minute: 30,
                        second: 0,
                        day: 1,
                        month: 1,
                        year: 2024,
                        weekday: 1,
                    })),
                },
            )),
            Content::SystemSetDatetimeRequest(r) => {
                self.clock = r.datetime;
                empty()
            }
            Content::SystemUpdateRequest(r) => {
                use pb_system::update_response::UpdateResultCode as C;
                let code = if !matches!(self.files.get(parent(&r.update_manifest)), Some(Node::Dir))
                {
                    C::ManifestFolderNotFound
                } else if !matches!(self.files.get(&r.update_manifest), Some(Node::File(_))) {
                    C::ManifestPathInvalid
                } else {
                    C::Ok
                };
                ok(Content::SystemUpdateResponse(pb_system::UpdateResponse {
                    code: code as i32,
                }))
            }
            Content::SystemRebootRequest(_) => return None,
            Content::StopSession(_) => {
                *cli = true;
                self.streaming = false;
                empty()
            }
            Content::StorageInfoRequest(r) => match r.path.as_str() {
                "/ext" if self.cfg.no_sd => fail(S::ErrorStorageNotReady),
                "/ext" => ok(Content::StorageInfoResponse(pb_storage::InfoResponse {
                    total_space: 32_000_000_000,
                    free_space: self.cfg.sd_free.unwrap_or(24_000_000_000),
                })),
                "/int" => ok(Content::StorageInfoResponse(pb_storage::InfoResponse {
                    total_space: 1_000_000,
                    free_space: 800_000,
                })),
                _ => fail(S::ErrorStorageInvalidName),
            },
            Content::StorageListRequest(r) => match self.files.get(&r.path) {
                Some(Node::Dir) => {
                    let files = self.children(&r.path);
                    let mut chunks: Vec<Content> = files
                        .chunks(8)
                        .map(|c| {
                            Content::StorageListResponse(pb_storage::ListResponse {
                                file: c.to_vec(),
                            })
                        })
                        .collect();
                    if chunks.is_empty() {
                        chunks.push(Content::StorageListResponse(pb_storage::ListResponse {
                            file: vec![],
                        }));
                    }
                    parts(id, chunks)
                }
                _ => fail(S::ErrorStorageNotExist),
            },
            Content::StorageStatRequest(r) => match self.entry(&r.path) {
                Some(file) => ok(Content::StorageStatResponse(pb_storage::StatResponse {
                    file: Some(file),
                })),
                None => fail(S::ErrorStorageNotExist),
            },
            Content::StorageMkdirRequest(r) => {
                if self.files.contains_key(&r.path) {
                    fail(S::ErrorStorageExist)
                } else if !matches!(self.files.get(parent(&r.path)), Some(Node::Dir)) {
                    fail(S::ErrorStorageNotExist)
                } else {
                    self.files.insert(r.path, Node::Dir);
                    empty()
                }
            }
            Content::StorageWriteRequest(r) => {
                if let Some((_, most)) = self.cfg.stall {
                    if self.rng.upto(6) == 1 {
                        let ms = self.rng.next() % most.max(1);
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                    }
                }
                let chunk = r.file.map(|f| f.data).unwrap_or_default();
                let mut w = match self.writing.take() {
                    Some(w) if w.0 == id => w,
                    _ => {
                        if !matches!(self.files.get(parent(&r.path)), Some(Node::Dir)) {
                            return Some(fail(S::ErrorStorageNotExist));
                        }
                        if matches!(self.files.get(&r.path), Some(Node::Dir)) {
                            return Some(fail(S::ErrorStorageExist));
                        }
                        (id, r.path.clone(), Vec::new())
                    }
                };
                w.2.extend_from_slice(&chunk);
                self.files.insert(w.1.clone(), Node::File(w.2.clone()));
                if has_next {
                    self.writing = Some(w);
                    vec![]
                } else {
                    empty()
                }
            }
            Content::StorageReadRequest(r) => match self.files.get(&r.path) {
                Some(Node::File(d)) => {
                    let chunks: Vec<Content> = if d.is_empty() {
                        vec![vec![]]
                    } else {
                        d.chunks(512).map(<[u8]>::to_vec).collect()
                    }
                    .into_iter()
                    .map(|c| {
                        Content::StorageReadResponse(pb_storage::ReadResponse {
                            file: Some(pb_storage::File {
                                data: c,
                                ..Default::default()
                            }),
                        })
                    })
                    .collect();
                    parts(id, chunks)
                }
                _ => fail(S::ErrorStorageNotExist),
            },
            Content::StorageRenameRequest(r) => {
                if !self.files.contains_key(&r.old_path) {
                    fail(S::ErrorStorageNotExist)
                } else if self.files.contains_key(&r.new_path) {
                    fail(S::ErrorStorageExist)
                } else {
                    let under = format!("{}/", r.old_path);
                    let moved: Vec<String> = self
                        .files
                        .keys()
                        .filter(|k| **k == r.old_path || k.starts_with(&under))
                        .cloned()
                        .collect();
                    for k in moved {
                        let node = self.files.remove(&k).unwrap();
                        self.files
                            .insert(format!("{}{}", r.new_path, &k[r.old_path.len()..]), node);
                    }
                    empty()
                }
            }
            Content::StorageMd5sumRequest(r) => match self.files.get(&r.path) {
                Some(Node::File(d)) => {
                    use md5::{Digest, Md5};
                    let sum: String = Md5::digest(d).iter().map(|b| format!("{b:02x}")).collect();
                    ok(Content::StorageMd5sumResponse(pb_storage::Md5sumResponse {
                        md5sum: sum,
                    }))
                }
                _ => fail(S::ErrorStorageNotExist),
            },
            Content::StorageDeleteRequest(r) => {
                if !self.files.contains_key(&r.path) {
                    fail(S::ErrorStorageNotExist)
                } else if !r.recursive && !self.children(&r.path).is_empty() {
                    fail(S::ErrorStorageDirNotEmpty)
                } else {
                    let under = format!("{}/", r.path);
                    self.files
                        .retain(|k, _| k != &r.path && !k.starts_with(&under));
                    empty()
                }
            }
            Content::GuiStartScreenStreamRequest(_) => {
                self.streaming = true;
                let mut v = empty();
                v.push(frame());
                v
            }
            Content::GuiStopScreenStreamRequest(_) => {
                self.streaming = false;
                empty()
            }
            Content::GuiSendInputEventRequest(_) => empty(),
            Content::AppStartRequest(r) => match r.name.as_str() {
                "Sub-GHz" | "125 kHz RFID" | "NFC" | "Infrared" | "GPIO" | "iButton"
                | "Bad USB" | "U2F" | "Settings" => empty(),
                n if n.starts_with("/ext/apps/") && self.files.contains_key(n) => empty(),
                "Broken" => fail(S::ErrorAppCantStart),
                _ => fail(S::ErrorInvalidParameters),
            },
            _ => fail(S::ErrorNotImplemented),
        })
    }

    fn device_info(&self) -> Vec<(String, String)> {
        [
            ("device_info_major", "2"),
            ("device_info_minor", "2"),
            ("hardware_model", "Flipper Zero"),
            ("hardware_name", self.name.as_str()),
            ("hardware_uid", "placeholder-uid"),
            ("hardware_target", "7"),
            (
                "hardware_region",
                if self.cfg.dev_region { "0" } else { "2" },
            ),
            ("hardware_region_provisioned", "US"),
            ("firmware_version", "1.3.4"),
            ("firmware_branch", "release"),
            ("firmware_target", "7"),
            ("protobuf_version_major", "0"),
            ("protobuf_version_minor", "25"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn entry(&self, path: &str) -> Option<pb_storage::File> {
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        self.files.get(path).map(|n| match n {
            Node::Dir => pb_storage::File {
                r#type: pb_storage::file::FileType::Dir as i32,
                name,
                ..Default::default()
            },
            Node::File(d) => pb_storage::File {
                name,
                size: d.len() as u32,
                ..Default::default()
            },
        })
    }

    fn children(&self, dir: &str) -> Vec<pb_storage::File> {
        self.files
            .keys()
            .filter(|k| parent(k) == dir && k.as_str() != dir)
            .filter_map(|k| self.entry(k))
            .collect()
    }
}

fn parent(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

fn reply(id: u32, status: S, has_next: bool, content: Option<Content>) -> pb::Main {
    pb::Main {
        command_id: id,
        command_status: status as i32,
        has_next,
        content,
    }
}

/* frames arrive outside any request, with command_id 0 */
fn frame() -> pb::Main {
    reply(
        0,
        S::Ok,
        false,
        Some(Content::GuiScreenFrame(pb_gui::ScreenFrame {
            data: vec![0; 1024],
            orientation: 0,
        })),
    )
}

fn parts(id: u32, contents: Vec<Content>) -> Vec<pb::Main> {
    let n = contents.len();
    contents
        .into_iter()
        .enumerate()
        .map(|(i, c)| reply(id, S::Ok, i + 1 < n, Some(c)))
        .collect()
}
