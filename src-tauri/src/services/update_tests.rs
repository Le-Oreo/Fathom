use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::backup;
use super::firmware::{self, Package};
use super::storage::{self, OnProgress, Progress};
use crate::error::ErrorCode;
use crate::fake::{FakeConfig, FakeFlipper, FakeHandle};
use crate::rpc::{Session, SessionOptions};
use crate::transport::pipe::pipe;

async fn connect_with(cfg: FakeConfig) -> (Arc<Session>, FakeHandle) {
    let (host, device) = pipe();
    let fake = FakeFlipper::new("Testfin", cfg).spawn(device);
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

async fn connect() -> (Arc<Session>, FakeHandle) {
    connect_with(FakeConfig::default()).await
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fathom-update-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn recorder() -> (OnProgress, Arc<Mutex<Vec<Progress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    (Arc::new(move |p| s.lock().unwrap().push(p)), seen)
}

fn package() -> Package {
    firmware::read_package(&firmware::tgz(&[
        ("f7-update-9.9.9/update.fuf", b"placeholder manifest"),
        ("f7-update-9.9.9/firmware.dfu", &[b'p'; 3000]),
        ("f7-update-9.9.9/resources.tar", b"placeholder resources"),
    ]))
    .unwrap()
}

fn count(f: &FakeHandle, name: &str) -> usize {
    f.received().iter().filter(|n| *n == name).count()
}

async fn text(s: &Arc<Session>, path: &str) -> String {
    String::from_utf8(storage::read(s, path, None, None).await.unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_package_goes_up_once_and_a_retry_copies_only_what_changed() {
    let (s, f) = connect().await;
    let pkg = package();
    let (p, seen) = recorder();
    let n = firmware::upload_package(&s, &pkg, &p, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(n, 3);
    assert_eq!(seen.lock().unwrap().last().unwrap().done, 3041);
    let files: Vec<_> = storage::list(&s, "/ext/update/f7-update-9.9.9")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(files.len(), 3);
    /* all there: nothing to copy */
    let writes = count(&f, "storage_write_request");
    assert_eq!(
        firmware::upload_package(&s, &pkg, &p, &AtomicBool::new(false))
            .await
            .unwrap(),
        0
    );
    assert_eq!(count(&f, "storage_write_request"), writes);
    /* one file damaged on the card: only that one goes again */
    storage::write(
        &s,
        "/ext/update/f7-update-9.9.9/resources.tar",
        b"broken",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        firmware::upload_package(&s, &pkg, &p, &AtomicBool::new(false))
            .await
            .unwrap(),
        1
    );
    firmware::request_update(&s, &pkg).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn no_card_no_room_and_a_missing_package_are_refused() {
    let (s, _f) = connect_with(FakeConfig {
        no_sd: true,
        ..Default::default()
    })
    .await;
    assert_eq!(
        firmware::check_sd(&s, 0).await.unwrap_err().code,
        ErrorCode::NoSd
    );
    let (s, _f) = connect_with(FakeConfig {
        sd_free: Some(1000),
        ..Default::default()
    })
    .await;
    let (p, _) = recorder();
    let e = firmware::upload_package(&s, &package(), &p, &AtomicBool::new(false))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NoRoom);
    /* nothing copied, so the updater has nothing to install */
    assert_eq!(
        firmware::request_update(&s, &package())
            .await
            .unwrap_err()
            .code,
        ErrorCode::BadPackage
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn region_data_is_written_except_on_development_units() {
    let (s, _f) = connect().await;
    assert!(firmware::provision_region(&s, false, b"placeholder")
        .await
        .unwrap());
    assert_eq!(
        storage::stat(&s, firmware::REGION_PATH).await.unwrap().size,
        11
    );
    let (s, _f) = connect_with(FakeConfig {
        dev_region: true,
        ..Default::default()
    })
    .await;
    assert!(!firmware::provision_region(&s, true, b"placeholder")
        .await
        .unwrap());
    assert_eq!(
        storage::stat(&s, firmware::REGION_PATH)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn backups_round_trip_and_the_sd_copy_only_reads_what_changed() {
    let (s, f) = connect().await;
    let dir = temp("backups");
    storage::mkdir(&s, "/int/folder").await.unwrap();
    storage::write(
        &s,
        "/int/folder/inner.txt",
        b"placeholder inner",
        None,
        None,
    )
    .await
    .unwrap();
    storage::write(&s, firmware::REGION_PATH, b"placeholder region", None, None)
        .await
        .unwrap();
    let (p, _) = recorder();
    let cancel = Arc::new(AtomicBool::new(false));

    let first = backup::create(&s, &dir, true, p.clone(), cancel.clone())
        .await
        .unwrap();
    assert!(first.sd && first.size > 0);
    assert!(dir.join("sd/notes/hello.txt").is_file());
    assert!(dir.join("sd/many/file19.txt").is_file());
    assert!(backup::sd_copy_date(&dir).is_some());

    std::thread::sleep(std::time::Duration::from_millis(1100));
    storage::write(&s, "/ext/notes/new.txt", b"placeholder new", None, None)
        .await
        .unwrap();
    let reads = count(&f, "storage_read_request");
    let second = backup::create(&s, &dir, true, p.clone(), cancel.clone())
        .await
        .unwrap();
    assert_eq!(count(&f, "storage_read_request") - reads, 4);
    assert!(dir.join("sd/notes/new.txt").is_file());
    /* a file deleted from the card stays in the copy */
    storage::delete(&s, "/ext/notes/new.txt", false)
        .await
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    backup::create(&s, &dir, true, p.clone(), cancel.clone())
        .await
        .unwrap();
    assert!(dir.join("sd/notes/new.txt").is_file());
    let list = backup::list(&dir);
    assert_eq!(list.len(), 3);
    assert_eq!(list[1].id, second.id);

    storage::write(&s, "/int/settings.txt", b"changed", None, None)
        .await
        .unwrap();
    storage::write(
        &s,
        firmware::REGION_PATH,
        b"placeholder newer region",
        None,
        None,
    )
    .await
    .unwrap();
    storage::delete(&s, "/int/folder", true).await.unwrap();
    storage::write(&s, "/ext/notes/hello.txt", b"changed", None, None)
        .await
        .unwrap();
    storage::write(&s, "/ext/notes/only-here.txt", b"placeholder", None, None)
        .await
        .unwrap();
    backup::restore(&s, &dir, &first.id, true, p.clone(), cancel.clone())
        .await
        .unwrap();
    assert_eq!(text(&s, "/int/settings.txt").await, "Placeholder text.\n");
    assert_eq!(text(&s, "/int/folder/inner.txt").await, "placeholder inner");
    /* region data stays as the update server last wrote it */
    assert_eq!(
        text(&s, firmware::REGION_PATH).await,
        "placeholder newer region"
    );
    assert_eq!(
        text(&s, "/ext/notes/hello.txt").await,
        "Placeholder text for hello.txt.\n"
    );
    /* nothing on the SD card is deleted */
    assert_eq!(text(&s, "/ext/notes/only-here.txt").await, "placeholder");

    assert_eq!(
        backup::restore(&s, &dir, "../../elsewhere", false, p, cancel)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_sd_backup_without_a_card_says_so() {
    let (s, _f) = connect_with(FakeConfig {
        no_sd: true,
        ..Default::default()
    })
    .await;
    let dir = temp("nosd");
    let (p, _) = recorder();
    let e = backup::create(&s, &dir, true, p.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NoSd);
    assert!(backup::list(&dir).is_empty());
    /* the internal storage alone still works */
    backup::create(&s, &dir, false, p, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    assert_eq!(backup::list(&dir).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn folder_sync_copies_only_what_changed_and_removes_only_what_was_agreed() {
    use super::sync;
    let (s, f) = connect().await;
    let local = temp("sync");
    std::fs::create_dir_all(local.join("sub")).unwrap();
    std::fs::write(local.join("a.txt"), b"placeholder a").unwrap();
    std::fs::write(local.join("sub/b.txt"), b"placeholder b").unwrap();
    std::fs::write(local.join(".hidden"), b"skipped").unwrap();
    let (p, _) = recorder();
    let cancel = AtomicBool::new(false);

    /* nothing there yet: everything is new */
    let plan = sync::plan(&s, &local, "/ext/synced").await.unwrap();
    assert_eq!(plan.new.len(), 2);
    let done = sync::apply(&s, &local, "/ext/synced", &plan, &[], p.clone(), &cancel)
        .await
        .unwrap();
    assert_eq!(done.copied, 2);
    assert_eq!(text(&s, "/ext/synced/sub/b.txt").await, "placeholder b");

    /* change one file, and leave one only on the Flipper */
    std::fs::write(local.join("a.txt"), b"placeholder A").unwrap();
    storage::write(&s, "/ext/synced/only-here.txt", b"x", None, None)
        .await
        .unwrap();
    let plan = sync::plan(&s, &local, "/ext/synced").await.unwrap();
    assert_eq!(plan.new.len(), 0);
    assert_eq!(
        plan.changed
            .iter()
            .map(|i| i.rel.as_str())
            .collect::<Vec<_>>(),
        ["a.txt"]
    );
    assert_eq!(plan.same, 1);
    assert_eq!(plan.extra.len(), 1);
    let writes = count(&f, "storage_write_request");
    let done = sync::apply(&s, &local, "/ext/synced", &plan, &[], p.clone(), &cancel)
        .await
        .unwrap();
    assert_eq!((done.copied, done.removed), (1, 0));
    assert_eq!(count(&f, "storage_write_request") - writes, 1);
    assert!(storage::stat(&s, "/ext/synced/only-here.txt").await.is_ok());
    let plan = sync::plan(&s, &local, "/ext/synced").await.unwrap();
    let done = sync::apply(
        &s,
        &local,
        "/ext/synced",
        &plan,
        &["only-here.txt".into()],
        p,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!((done.copied, done.removed), (0, 1));
    assert!(storage::stat(&s, "/ext/synced/only-here.txt")
        .await
        .is_err());
    let _ = std::fs::remove_dir_all(&local);
}
