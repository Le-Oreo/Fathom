use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::proto::{pb, pb_storage, pb_system};
use super::{Content, LogEntry, RpcError, Session, SessionOptions};
use crate::fake::{FakeConfig, FakeFlipper, FakeHandle};
use crate::transport::pipe::pipe;

fn quick() -> SessionOptions {
    SessionOptions {
        handshake: Duration::from_millis(1500),
        ping_every: Duration::from_millis(200),
        ping_timeout: Duration::from_millis(300),
        stop_timeout: Duration::from_millis(300),
    }
}

struct Rig {
    session: Session,
    fake: FakeHandle,
    closes: Arc<AtomicUsize>,
    log: Arc<Mutex<Vec<LogEntry>>>,
}

async fn open_with(cfg: FakeConfig, opts: SessionOptions) -> Result<Rig, (RpcError, FakeHandle)> {
    let (host, device) = pipe();
    let fake = FakeFlipper::new("Testfin", cfg).spawn(device);
    let closes = Arc::new(AtomicUsize::new(0));
    let log = Arc::new(Mutex::new(Vec::new()));
    let (c, l) = (closes.clone(), log.clone());
    match Session::open(
        host,
        opts,
        Arc::new(move |e| l.lock().unwrap().push(e)),
        Box::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .await
    {
        Ok(session) => Ok(Rig {
            session,
            fake,
            closes,
            log,
        }),
        Err(e) => Err((e, fake)),
    }
}

async fn open(cfg: FakeConfig) -> Rig {
    open_with(cfg, quick())
        .await
        .map_err(|(e, _)| e)
        .expect("session should open")
}

const T: Duration = Duration::from_secs(2);

async fn closes(count: &AtomicUsize) -> usize {
    for _ in 0..100 {
        if count.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    count.load(Ordering::SeqCst)
}

fn list(path: &str) -> Content {
    Content::StorageListRequest(pb_storage::ListRequest {
        path: path.into(),
        ..Default::default()
    })
}

fn names(parts: &[pb::Main]) -> Vec<String> {
    parts
        .iter()
        .flat_map(|m| match &m.content {
            Some(Content::StorageListResponse(r)) => {
                r.file.iter().map(|f| f.name.clone()).collect()
            }
            _ => vec![],
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn switches_to_rpc_and_pings() {
    let rig = open(FakeConfig::default()).await;
    let ping = Content::SystemPingRequest(pb_system::PingRequest {
        data: vec![1, 2, 3],
    });
    let parts = rig.session.request(ping, "", T).await.unwrap();
    assert_eq!(parts.len(), 1);
    assert!(
        matches!(&parts[0].content, Some(Content::SystemPingResponse(r)) if r.data == vec![1, 2, 3])
    );
    assert_eq!(rig.log.lock().unwrap()[0].name, "system_ping_request");
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_the_prompt_after_pressing_enter() {
    let rig = open(FakeConfig {
        quiet_start: true,
        ..Default::default()
    })
    .await;
    assert!(rig.session.request(list("/ext"), "", T).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_that_never_answers() {
    let opts = SessionOptions {
        handshake: Duration::from_millis(700),
        ..quick()
    };
    let started = Instant::now();
    let err = open_with(
        FakeConfig {
            silent: true,
            ..Default::default()
        },
        opts,
    )
    .await
    .err()
    .unwrap()
    .0;
    assert_eq!(err, RpcError::NoAnswer);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn gathers_has_next_parts() {
    let rig = open(FakeConfig::default()).await;
    /* 20 files arrive as parts of 8, 8 and 4 */
    let parts = rig.session.request(list("/ext/many"), "", T).await.unwrap();
    assert_eq!(parts.len(), 3);
    assert!(parts[0].has_next && parts[1].has_next && !parts[2].has_next);
    let got = names(&parts);
    assert_eq!(got.len(), 20);
    assert_eq!(got[0], "file00.txt");
    assert_eq!(got[19], "file19.txt");
    /* device info: one key/value per part */
    let info = rig
        .session
        .request(Content::SystemDeviceInfoRequest(Default::default()), "", T)
        .await
        .unwrap();
    assert!(info.len() > 8);
}

#[tokio::test(flavor = "multi_thread")]
async fn replies_split_into_tiny_reads() {
    let rig = open(FakeConfig {
        chunk: Some(1),
        ..Default::default()
    })
    .await;
    let parts = rig.session.request(list("/ext/many"), "", T).await.unwrap();
    assert_eq!(names(&parts).len(), 20);
}

#[tokio::test(flavor = "multi_thread")]
async fn several_replies_in_one_read() {
    let rig = open(FakeConfig {
        batch: true,
        ..Default::default()
    })
    .await;
    let parts = rig.session.request(list("/ext/many"), "", T).await.unwrap();
    assert_eq!(names(&parts).len(), 20);
    let (a, b) = tokio::join!(
        rig.session.request(list("/ext/notes"), "", T),
        rig.session
            .request(Content::SystemPowerInfoRequest(Default::default()), "", T)
    );
    assert_eq!(names(&a.unwrap()), vec!["hello.txt"]);
    assert!(matches!(
        &b.unwrap()[0].content,
        Some(Content::SystemPowerInfoResponse(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn error_replies_carry_their_status() {
    let rig = open(FakeConfig::default()).await;
    let err = rig
        .session
        .request(list("/ext/nowhere"), "", T)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        RpcError::Status(pb::CommandStatus::ErrorStorageNotExist as i32)
    );
    let del = Content::StorageDeleteRequest(pb_storage::DeleteRequest {
        path: "/ext/notes".into(),
        recursive: false,
    });
    let err = rig.session.request(del, "", T).await.unwrap_err();
    assert_eq!(
        err,
        RpcError::Status(pb::CommandStatus::ErrorStorageDirNotEmpty as i32)
    );
    /* the session carries on */
    assert!(rig.session.request(list("/ext"), "", T).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn timeouts_leave_the_session_usable() {
    let opts = SessionOptions {
        ping_every: Duration::from_secs(60),
        ..quick()
    };
    let rig = open_with(FakeConfig::default(), opts)
        .await
        .map_err(|(e, _)| e)
        .unwrap();
    rig.fake.ignore("system_power_info_request");
    let started = Instant::now();
    let err = rig
        .session
        .request(
            Content::SystemPowerInfoRequest(Default::default()),
            "",
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
    assert_eq!(err, RpcError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(rig.session.request(list("/ext"), "", T).await.is_ok());
    assert!(!rig.session.is_closed());
}

#[tokio::test(flavor = "multi_thread")]
async fn sudden_disconnect_fails_whatever_is_waiting() {
    let mut rig = open(FakeConfig::default()).await;
    rig.fake.ignore("system_device_info_request");
    let session = Arc::new(rig.session);
    let s = session.clone();
    let waiting = tokio::spawn(async move {
        s.request(Content::SystemDeviceInfoRequest(Default::default()), "", T)
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    rig.fake.unplug();
    let err = waiting.await.unwrap().unwrap_err();
    assert_eq!(err, RpcError::Disconnected);
    assert!(session.is_closed());
    assert_eq!(closes(&rig.closes).await, 1);
    /* later requests fail at once */
    assert_eq!(
        session.request(list("/ext"), "", T).await.unwrap_err(),
        RpcError::Disconnected
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keepalive_pings_while_idle() {
    let rig = open(FakeConfig::default()).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let pings = rig
        .fake
        .received()
        .iter()
        .filter(|n| *n == "system_ping_request")
        .count();
    assert!(pings >= 2, "pinged {pings} times");
    assert!(!rig.session.is_closed());
    /* pings stay out of the RPC log */
    assert!(rig
        .log
        .lock()
        .unwrap()
        .iter()
        .all(|e| e.name != "system_ping_request"));
}

#[tokio::test(flavor = "multi_thread")]
async fn missed_pings_mean_the_flipper_is_gone() {
    let rig = open(FakeConfig::default()).await;
    rig.fake.ignore("system_ping_request");
    let started = Instant::now();
    while !rig.session.is_closed() && started.elapsed() < Duration::from_secs(3) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(rig.session.is_closed());
    assert_eq!(closes(&rig.closes).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_sends_stop_session() {
    let rig = open(FakeConfig::default()).await;
    rig.session.close().await;
    assert!(rig.session.is_closed());
    assert!(rig.fake.received().contains(&"stop_session".to_string()));
}
