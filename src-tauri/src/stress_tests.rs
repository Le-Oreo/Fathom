/* Uploads, downloads and everything else at once over a link that acts like a
busy Flipper on Windows: tiny buffers, writes that time out as 0 bytes,
SD card pauses and a live screen stream the whole time. */
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::fake::{FakeConfig, FakeFlipper, FakeHandle};
use crate::rpc::{Session, SessionOptions};
use crate::services::firmware::{self, md5_hex};
use crate::services::storage::{self, OnProgress};
use crate::services::{device, screen};
use crate::transport::flaky::{flaky, Rng};

struct Rig {
    s: Arc<Session>,
    closes: Arc<AtomicUsize>,
    frames: Arc<AtomicUsize>,
    _fake: FakeHandle,
}

async fn rig(seed: u64, stall_ms: u64) -> Rig {
    let (host, device) = flaky(seed, 2048, 4096);
    let fake = FakeFlipper::new(
        "Testfin",
        FakeConfig {
            stall: Some((seed, stall_ms)),
            frames: true,
            ..Default::default()
        },
    )
    .spawn(device);
    let closes = Arc::new(AtomicUsize::new(0));
    let c = closes.clone();
    let s = Session::open(
        host,
        SessionOptions::default(),
        Arc::new(|_| {}),
        Box::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .await
    .expect("session should open");
    let s = Arc::new(s);
    let frames = Arc::new(AtomicUsize::new(0));
    let f = frames.clone();
    screen::start(
        &s,
        Arc::new(move |_| {
            f.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .await
    .expect("screen stream should start");
    Rig {
        s,
        closes,
        frames,
        _fake: fake,
    }
}

impl Rig {
    fn still_connected(&self) {
        assert!(!self.s.is_closed(), "the session closed");
        assert_eq!(self.closes.load(Ordering::SeqCst), 0, "the session closed");
    }
}

fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut r = Rng::new(seed);
    (0..len).map(|_| r.next() as u8).collect()
}

fn nothing() -> OnProgress {
    Arc::new(|_| {})
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fathom-stress-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn same_on_flipper(s: &Session, path: &str, data: &[u8]) {
    let there = storage::md5(s, path).await.unwrap();
    assert_eq!(there, md5_hex(data), "{path} differs on the Flipper");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_big_file_goes_up_whole_with_the_screen_streaming() {
    for seed in 1..=4 {
        let r = rig(seed, 120).await;
        let data = noise(seed, 200 * 1024);
        storage::write(&r.s, "/ext/big.bin", &data, None, None)
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        same_on_flipper(&r.s, "/ext/big.bin", &data).await;
        assert!(r.frames.load(Ordering::SeqCst) > 5, "frames stopped coming");
        r.still_connected();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_sd_card_pause_doesnt_drop_the_connection() {
    /* pauses of up to 7 s: longer than the old 5 s write limit */
    let r = rig(7, 7000).await;
    let data = noise(7, 40 * 512);
    let start = Instant::now();
    storage::write(&r.s, "/ext/slow.bin", &data, None, None)
        .await
        .unwrap();
    assert!(
        start.elapsed() > Duration::from_secs(5),
        "no long pause happened"
    );
    same_on_flipper(&r.s, "/ext/slow.bin", &data).await;
    r.still_connected();
}

fn make_folder(root: &Path, seed: u64, files: usize) -> Vec<(String, Vec<u8>)> {
    let mut r = Rng::new(seed);
    let mut out = Vec::new();
    for i in 0..files {
        let sub = ["", "a", "a/deep", "b"][i % 4];
        let rel = if sub.is_empty() {
            format!("file{i:03}.txt")
        } else {
            format!("{sub}/file{i:03}.txt")
        };
        let size = (r.next() % 6000) as usize;
        let data = noise(seed * 1000 + i as u64, size);
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &data).unwrap();
        out.push((rel, data));
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_of_many_files_goes_up_and_a_second_time_skips_them_all() {
    for seed in [11, 12] {
        let local = temp(&format!("folder{seed}")).join("stuff");
        let files = make_folder(&local, seed, 90);
        let r = rig(seed, 60).await;
        let up = storage::upload(&r.s, &local, "/ext", nothing(), &AtomicBool::new(false))
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        assert_eq!((up.files, up.skipped), (90, 0));
        for (rel, data) in &files {
            same_on_flipper(&r.s, &format!("/ext/stuff/{rel}"), data).await;
        }
        let again = storage::upload(&r.s, &local, "/ext", nothing(), &AtomicBool::new(false))
            .await
            .unwrap();
        assert_eq!((again.files, again.skipped), (90, 90));
        r.still_connected();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_firmware_package_copies_whole() {
    let pkg = firmware::read_package(&firmware::tgz(&[
        ("f7-update-9.9.9/update.fuf", b"placeholder manifest"),
        ("f7-update-9.9.9/firmware.dfu", &noise(21, 120 * 1024)),
        ("f7-update-9.9.9/resources.tar", &noise(22, 160 * 1024)),
        ("f7-update-9.9.9/splash.bin", &noise(23, 9000)),
    ]))
    .unwrap();
    let r = rig(21, 100).await;
    let n = firmware::upload_package(&r.s, &pkg, &nothing(), &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(n, 4);
    firmware::request_update(&r.s, &pkg).await.unwrap();
    r.still_connected();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_big_file_comes_down_whole() {
    let r = rig(31, 60).await;
    let data = noise(31, 150 * 1024);
    storage::write(&r.s, "/ext/down.bin", &data, None, None)
        .await
        .unwrap();
    let back = storage::read(&r.s, "/ext/down.bin", Some(nothing()), None)
        .await
        .unwrap();
    assert!(back == data, "the download differs");
    r.still_connected();
}

/* What the app does on its own while a transfer runs: battery, SD card,
the file list, device info. None of it may break the upload. */
#[tokio::test(flavor = "multi_thread")]
async fn everything_at_once() {
    for seed in [41, 42, 43] {
        let local = temp(&format!("busy{seed}")).join("busy");
        let files = make_folder(&local, seed, 40);
        let r = rig(seed, 60).await;
        let done = Arc::new(AtomicBool::new(false));
        let others = {
            let s = r.s.clone();
            let done = done.clone();
            tokio::spawn(async move {
                let mut rounds = 0;
                while !done.load(Ordering::SeqCst) {
                    device::storage_info(&s, "/ext").await.unwrap();
                    device::power_pairs(&s).await.unwrap();
                    storage::list(&s, "/ext").await.unwrap();
                    storage::stat(&s, "/ext/notes/hello.txt").await.unwrap();
                    device::device_info(&s, "COM5").await.unwrap();
                    rounds += 1;
                }
                rounds
            })
        };
        let big = noise(seed, 60 * 1024);
        storage::write(&r.s, "/ext/big.bin", &big, None, None)
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        storage::upload(&r.s, &local, "/ext", nothing(), &AtomicBool::new(false))
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        done.store(true, Ordering::SeqCst);
        let rounds = others.await.unwrap();
        assert!(rounds > 2, "the other requests didn't get a turn");
        same_on_flipper(&r.s, "/ext/big.bin", &big).await;
        for (rel, data) in &files {
            same_on_flipper(&r.s, &format!("/ext/busy/{rel}"), data).await;
        }
        r.still_connected();
    }
}

/* The Console takes the link over and hands it back, mid-traffic. */
#[tokio::test(flavor = "multi_thread")]
async fn the_console_takes_over_and_hands_back() {
    let mut r = rig(51, 60).await;
    for round in 0..3u64 {
        let data = noise(51 + round, 20 * 1024);
        storage::write(&r.s, "/ext/before.bin", &data, None, None)
            .await
            .unwrap();
        let (link, _rest) =
            r.s.release(Duration::from_secs(2))
                .await
                .unwrap_or_else(|e| panic!("round {round}: {e:?}"));
        let s = Session::open(
            link,
            SessionOptions::default(),
            Arc::new(|_| {}),
            Box::new(|| {}),
        )
        .await
        .unwrap_or_else(|e| panic!("round {round}: {e:?}"));
        r.s = Arc::new(s);
        same_on_flipper(&r.s, "/ext/before.bin", &data).await;
    }
}

/* The long run: cargo test soak -- --ignored */
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn soak() {
    let rounds: u64 = std::env::var("FATHOM_SOAK")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(40);
    for seed in 100..100 + rounds {
        let local = temp(&format!("soak{seed}")).join("soak");
        let files = make_folder(&local, seed, 16);
        let r = rig(seed, 40 + seed % 80).await;
        let done = Arc::new(AtomicBool::new(false));
        let others = {
            let s = r.s.clone();
            let done = done.clone();
            tokio::spawn(async move {
                while !done.load(Ordering::SeqCst) {
                    device::storage_info(&s, "/ext").await.unwrap();
                    storage::list(&s, "/ext").await.unwrap();
                    device::power_pairs(&s).await.unwrap();
                }
            })
        };
        let big = noise(seed, 32 * 1024 + (seed as usize % 7) * 1000);
        storage::write(&r.s, "/ext/big.bin", &big, None, None)
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        storage::upload(&r.s, &local, "/ext", nothing(), &AtomicBool::new(false))
            .await
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        let back = storage::read(&r.s, "/ext/big.bin", None, None)
            .await
            .unwrap();
        assert!(back == big, "seed {seed}: the download differs");
        done.store(true, Ordering::SeqCst);
        others.await.unwrap();
        for (rel, data) in &files {
            same_on_flipper(&r.s, &format!("/ext/soak/{rel}"), data).await;
        }
        r.still_connected();
    }
}
