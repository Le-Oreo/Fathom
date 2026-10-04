use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::storage::{self, Entry, OnProgress, Progress};
use crate::error::ErrorCode;
use crate::fake::{FakeConfig, FakeFlipper, FakeHandle};
use crate::rpc::{Session, SessionOptions};
use crate::transport::pipe::pipe;

async fn connect() -> (Arc<Session>, FakeHandle) {
    let (host, device) = pipe();
    let fake = FakeFlipper::new("Testfin", FakeConfig::default()).spawn(device);
    let session = Session::open(
        host,
        SessionOptions::default(),
        Arc::new(|_| {}),
        Box::new(|| {}),
    )
    .await
    .unwrap();
    (Arc::new(session), fake)
}

fn placeholder(n: usize) -> Vec<u8> {
    (0..n).map(|i| b"placeholder "[i % 12]).collect()
}

/* A fresh folder under the system temp folder. */
fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fathom-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn recorder() -> (OnProgress, Arc<Mutex<Vec<Progress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    (Arc::new(move |p| s.lock().unwrap().push(p)), seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn folders_and_names() {
    let (s, _f) = connect().await;
    storage::mkdir(&s, "/ext/new").await.unwrap();
    assert_eq!(
        storage::mkdir(&s, "/ext/new").await.unwrap_err().code,
        ErrorCode::Exists
    );
    assert_eq!(
        storage::stat(&s, "/ext/new").await.unwrap(),
        Entry {
            name: "new".into(),
            dir: true,
            size: 0
        }
    );
    storage::rename(&s, "/ext/notes", "/ext/new/notes")
        .await
        .unwrap();
    let inside = storage::list(&s, "/ext/new/notes").await.unwrap();
    assert_eq!(inside[0].name, "hello.txt");
    assert_eq!(
        storage::stat(&s, "/ext/notes").await.unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        storage::delete(&s, "/ext/new", false)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotEmpty
    );
    storage::delete(&s, "/ext/new", true).await.unwrap();
    assert!(storage::list(&s, "/ext")
        .await
        .unwrap()
        .iter()
        .all(|e| e.name != "new"));
}

#[tokio::test(flavor = "multi_thread")]
async fn write_in_parts_then_read_back() {
    let (s, _f) = connect().await;
    let data = placeholder(5000); /* 10 parts of up to 512 */
    let (p, seen) = recorder();
    storage::write(&s, "/ext/notes/big.txt", &data, Some((&p, 0, 5000)), None)
        .await
        .unwrap();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen.last().unwrap(),
        &Progress {
            done: 5000,
            total: 5000
        }
    );
    assert!(seen.windows(2).all(|w| w[0].done <= w[1].done));

    let (p, got) = recorder();
    let back = storage::read(&s, "/ext/notes/big.txt", Some(p), None)
        .await
        .unwrap();
    assert_eq!(back, data);
    assert_eq!(got.lock().unwrap().last().unwrap().done, 5000);

    use md5::{Digest, Md5};
    let want: String = Md5::digest(&data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(storage::md5(&s, "/ext/notes/big.txt").await.unwrap(), want);

    /* an empty file is one empty part */
    storage::write(&s, "/ext/notes/empty.txt", &[], None, None)
        .await
        .unwrap();
    assert_eq!(
        storage::stat(&s, "/ext/notes/empty.txt")
            .await
            .unwrap()
            .size,
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_upload_leaves_no_file() {
    let (s, _f) = connect().await;
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    /* cancel once the first batch has gone out */
    let p: OnProgress = Arc::new(move |x| {
        if x.done > 0 {
            c.store(true, Ordering::SeqCst)
        }
    });
    let data = placeholder(100_000);
    let err = storage::write(
        &s,
        "/ext/notes/half.bin",
        &data,
        Some((&p, 0, 100_000)),
        Some(&cancel),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(
        storage::stat(&s, "/ext/notes/half.bin")
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    /* and the session carries on */
    assert!(storage::list(&s, "/ext").await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn writing_into_a_missing_folder_fails_cleanly() {
    let (s, _f) = connect().await;
    let err = storage::write(&s, "/ext/nowhere/x.txt", &placeholder(2000), None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(storage::list(&s, "/ext").await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn folders_go_up_and_come_back() {
    let (s, f) = connect().await;
    let local = temp("up");
    let src = local.join("trip");
    std::fs::create_dir_all(src.join("inner")).unwrap();
    std::fs::write(src.join("a.txt"), placeholder(700)).unwrap();
    std::fs::write(src.join("inner/b.txt"), placeholder(1300)).unwrap();
    /* deeper levels and an empty folder come along too */
    std::fs::create_dir_all(src.join("inner/deeper/empty")).unwrap();
    std::fs::write(src.join("inner/deeper/c.txt"), placeholder(100)).unwrap();

    let (p, seen) = recorder();
    let up = storage::upload(&s, &src, "/ext", p, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(
        up,
        storage::Uploaded {
            name: "trip".into(),
            files: 3,
            skipped: 0
        }
    );
    assert_eq!(
        seen.lock().unwrap().last().unwrap(),
        &Progress {
            done: 2100,
            total: 2100
        }
    );
    assert_eq!(
        storage::stat(&s, "/ext/trip/inner/b.txt")
            .await
            .unwrap()
            .size,
        1300
    );
    let deep = storage::stat(&s, "/ext/trip/inner/deeper/c.txt")
        .await
        .unwrap();
    assert_eq!(deep.size, 100);
    assert!(
        storage::stat(&s, "/ext/trip/inner/deeper/empty")
            .await
            .unwrap()
            .dir
    );

    let writes = f
        .received()
        .iter()
        .filter(|n| *n == "storage_write_request")
        .count();
    let (p, _) = recorder();
    let again = storage::upload(&s, &src, "/ext", p, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!((again.files, again.skipped), (3, 3));
    assert_eq!(
        f.received()
            .iter()
            .filter(|n| *n == "storage_write_request")
            .count(),
        writes
    );
    std::fs::write(src.join("a.txt"), placeholder(701)).unwrap();
    let (p, _) = recorder();
    let changed = storage::upload(&s, &src, "/ext", p, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!((changed.files, changed.skipped), (3, 2));
    std::fs::write(src.join("a.txt"), placeholder(700)).unwrap();
    let (p, _) = recorder();
    storage::upload(&s, &src, "/ext", p, &AtomicBool::new(false))
        .await
        .unwrap();

    let back = temp("down");
    let (p, _) = recorder();
    let got = storage::download(
        &s,
        "/ext/trip",
        true,
        &back,
        p,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(got, back.join("trip"));
    assert_eq!(
        std::fs::read(back.join("trip/inner/b.txt")).unwrap(),
        placeholder(1300)
    );
    assert_eq!(
        std::fs::read(back.join("trip/a.txt")).unwrap(),
        placeholder(700)
    );
    assert_eq!(
        std::fs::read(back.join("trip/inner/deeper/c.txt")).unwrap(),
        placeholder(100)
    );
    assert!(back.join("trip/inner/deeper/empty").is_dir());

    /* downloading again never overwrites */
    let (p, _) = recorder();
    let again = storage::download(
        &s,
        "/ext/trip/a.txt",
        false,
        &back,
        p,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(again, back.join("a.txt"));
    let (p, _) = recorder();
    let third = storage::download(
        &s,
        "/ext/trip/a.txt",
        false,
        &back,
        p,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(third, back.join("a (2).txt"));
    let _ = std::fs::remove_dir_all(local);
    let _ = std::fs::remove_dir_all(back);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_download_removes_what_it_wrote() {
    let (s, _f) = connect().await;
    storage::write(&s, "/ext/notes/one.txt", &placeholder(600), None, None)
        .await
        .unwrap();
    let back = temp("cancel");
    let cancel = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicU64::new(0));
    let c = calls.clone();
    let err = storage::download(
        &s,
        "/ext/notes",
        true,
        &back,
        Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }),
        cancel,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(!back.join("notes").exists());
    let _ = std::fs::remove_dir_all(back);
}

#[test]
fn names_from_the_flipper_stay_inside_the_folder() {
    use super::storage::safe_name;
    assert_eq!(safe_name("notes.txt"), "notes.txt");
    assert_eq!(safe_name(r"..\..\AppData\x.bat"), ".._.._AppData_x.bat");
    assert_eq!(safe_name(".."), "download");
    assert_eq!(safe_name("."), "download");
    assert_eq!(safe_name(""), "download");
    assert_eq!(safe_name("C:evil"), "C_evil");
    assert_eq!(safe_name("con.txt"), "_con.txt");
    assert_eq!(safe_name("COM1"), "_COM1");
    assert_eq!(safe_name("trailing. "), "trailing");
    let dir = std::path::Path::new("/tmp/picked");
    for bad in ["..", r"..\x", "/etc/passwd", "C:\\x", "a/../../b"] {
        let p = dir.join(safe_name(bad));
        assert!(
            p.starts_with(dir) && p.parent() == Some(dir),
            "{bad} -> {}",
            p.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn replacing_a_file_keeps_the_original_until_the_new_one_is_complete() {
    let (s, _f) = connect().await;
    let original = placeholder(600);
    storage::write(&s, "/ext/notes/keep.txt", &original, None, None)
        .await
        .unwrap();

    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let p: OnProgress = Arc::new(move |x| {
        if x.done > 0 {
            c.store(true, Ordering::SeqCst)
        }
    });
    let err = storage::write(
        &s,
        "/ext/notes/keep.txt",
        &placeholder(50_000),
        Some((&p, 0, 50_000)),
        Some(&cancel),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(
        storage::read(&s, "/ext/notes/keep.txt", None, None)
            .await
            .unwrap(),
        original
    );
    let names: Vec<String> = storage::list(&s, "/ext/notes")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(
        names.iter().all(|n| !n.contains("fathom-part")),
        "{names:?}"
    );

    /* a finished one replaces it */
    let new = placeholder(900);
    storage::write(&s, "/ext/notes/keep.txt", &new, None, None)
        .await
        .unwrap();
    assert_eq!(
        storage::read(&s, "/ext/notes/keep.txt", None, None)
            .await
            .unwrap(),
        new
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn other_requests_wait_for_a_running_upload() {
    let (s, _f) = connect().await;
    let data = placeholder(200_000);
    let s2 = s.clone();
    let up =
        tokio::spawn(
            async move { storage::write(&s2, "/ext/notes/long.bin", &data, None, None).await },
        );
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    /* a listing in the middle must not break the upload */
    assert!(storage::list(&s, "/ext/notes").await.is_ok());
    up.await.unwrap().unwrap();
    assert_eq!(
        storage::stat(&s, "/ext/notes/long.bin").await.unwrap().size,
        200_000
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_library_lists_saved_files_with_descriptions_only() {
    use crate::services::library::{scan, Cache};
    let (s, fake) = connect().await;
    let header = b"Filetype: Flipper SubGhz Key File\nFrequency: 315000000\nPreset: FuriHalSubGhzPresetOok270Async\nProtocol: RAW\nRAW_Data: placeholder\n";
    storage::write(&s, "/ext/subghz/test.sub", header, None, None)
        .await
        .unwrap();
    storage::write(&s, "/ext/subghz/readme.txt", b"not a capture", None, None)
        .await
        .unwrap();
    let cache = Cache::default();
    let items = scan(&s, &cache, "flip_Test").await.unwrap();
    assert_eq!(
        items.len(),
        1,
        "only .sub files in the Sub-GHz folder: {items:?}"
    );
    let it = &items[0];
    assert_eq!(
        (it.category.as_str(), it.name.as_str()),
        ("subghz", "test.sub")
    );
    assert_eq!(
        (it.meta.as_str(), it.detail.as_str()),
        ("315.00 MHz", "RAW")
    );
    assert!(!format!("{it:?}").contains("placeholder"));

    /* a rescan reads nothing it already knows */
    let reads = |f: &FakeHandle| {
        f.received()
            .iter()
            .filter(|n| *n == "storage_read_request")
            .count()
    };
    let before = reads(&fake);
    scan(&s, &cache, "flip_Test").await.unwrap();
    assert_eq!(reads(&fake), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn apps_open_by_name_and_say_when_the_firmware_has_none() {
    use crate::services::apps;
    let (s, _f) = connect().await;
    apps::start(&s, "Sub-GHz", "").await.unwrap();
    assert_eq!(
        apps::start(&s, "RFID 125 kHz", "").await.unwrap_err().code,
        ErrorCode::NoApp
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_library_looks_in_subfolders_and_carries_on_past_bad_files() {
    use crate::services::library::{scan, Cache};
    let (s, _f) = connect().await;
    let header = b"Frequency: 433920000\nProtocol: Princeton\n";
    storage::mkdir(&s, "/ext/subghz/garage").await.unwrap();
    storage::write(&s, "/ext/subghz/garage/door.sub", header, None, None)
        .await
        .unwrap();
    /* the Flipper's own resources aren't saved files */
    storage::mkdir(&s, "/ext/subghz/assets").await.unwrap();
    storage::write(&s, "/ext/subghz/assets/keys.sub", header, None, None)
        .await
        .unwrap();
    storage::write(&s, "/ext/subghz/.hidden.sub", header, None, None)
        .await
        .unwrap();
    let items = scan(&s, &Cache::default(), "flip_Test").await.unwrap();
    let paths: Vec<&str> = items.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(paths, vec!["/ext/subghz/garage/door.sub"]);
    assert_eq!(items[0].meta, "433.92 MHz");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cached_header_is_forgotten_when_the_file_changes() {
    use crate::services::library::{scan, Cache};
    let (s, _f) = connect().await;
    let cache = Cache::default();
    storage::write(
        &s,
        "/ext/subghz/gate.sub",
        b"Frequency: 433920000\n",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(scan(&s, &cache, "a").await.unwrap()[0].meta, "433.92 MHz");
    /* same size, different frequency, written through FATHOM */
    cache.forget("/ext/subghz/gate.sub");
    storage::write(
        &s,
        "/ext/subghz/gate.sub",
        b"Frequency: 315000000\n",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(scan(&s, &cache, "a").await.unwrap()[0].meta, "315.00 MHz");
    assert!(cache.0.lock().unwrap().keys().all(|(d, _, _)| d == "a"));
}
