use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::fake::{FakeConfig, FakeFlipper, FakeHandle};
use crate::transport::pipe::pipe;

/* What's "plugged in", and what opening each port does. */
#[derive(Default)]
struct Bench {
    ports: Mutex<Vec<FoundPort>>,
    fakes: Mutex<Vec<FakeHandle>>,
    configs: Mutex<Vec<(String, FakeConfig)>>,
    open_error: Mutex<Option<ErrorCode>>,
    busy_opens: Mutex<usize>,
    states: Mutex<Vec<ConnectionState>>,
}

impl Bench {
    fn plug(&self, name: &str, cfg: FakeConfig) {
        let id = format!("flip_{name}");
        self.ports.lock().unwrap().push(FoundPort {
            id: id.clone(),
            name: name.into(),
            path: format!("/dev/{name}"),
        });
        self.configs.lock().unwrap().push((id, cfg));
    }
    fn unplug_all(&self) {
        self.ports.lock().unwrap().clear();
        for mut f in self.fakes.lock().unwrap().drain(..) {
            f.unplug();
        }
    }
    fn last(&self) -> ConnectionState {
        self.states
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a state was sent")
    }
}

fn settled(m: &Manager) {
    m.poll();
    m.state
        .lock()
        .unwrap()
        .seen
        .values_mut()
        .for_each(|t| *t -= SETTLE);
}

fn manager(bench: &Arc<Bench>) -> Arc<Manager> {
    let (b1, b2, b3) = (bench.clone(), bench.clone(), bench.clone());
    Manager::new(
        Box::new(move || b1.ports.lock().unwrap().clone()),
        Box::new(move |port| {
            if let Some(code) = *b2.open_error.lock().unwrap() {
                return Err((code, "test".into()));
            }
            {
                let mut busy = b2.busy_opens.lock().unwrap();
                if *busy > 0 {
                    *busy -= 1;
                    return Err((ErrorCode::PortBusy, "settling".into()));
                }
            }
            let cfg = b2
                .configs
                .lock()
                .unwrap()
                .iter()
                .find(|(id, _)| id == &port.id)
                .map(|(_, c)| c.clone());
            let (host, device) = pipe();
            b2.fakes
                .lock()
                .unwrap()
                .push(FakeFlipper::new(&port.name, cfg.unwrap_or_default()).spawn(device));
            Ok(host)
        }),
        Box::new(move |s| b3.states.lock().unwrap().push(s.clone())),
        Arc::new(|_| {}),
        SessionOptions {
            handshake: Duration::from_millis(800),
            ping_every: Duration::from_millis(300),
            ping_timeout: Duration::from_millis(400),
            stop_timeout: Duration::from_millis(200),
        },
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn connects_to_the_only_flipper_and_reads_it() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.poll();
    assert_eq!(m.current().status, Status::Disconnected);
    assert_eq!(
        m.current().ports,
        vec![PortInfo {
            id: "flip_Nautilus".into(),
            name: "Nautilus".into()
        }]
    );

    m.connect(None).await.unwrap();
    let s = m.current();
    assert_eq!(s.status, Status::Connected);
    let info = s.info.unwrap();
    assert_eq!(
        (
            info.name.as_str(),
            info.firmware.as_str(),
            info.port.as_str()
        ),
        ("Nautilus", "1.3.4", "/dev/Nautilus")
    );
    /* the UI saw connecting, then connected */
    let seen: Vec<Status> = bench
        .states
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.status)
        .collect();
    assert!(
        seen.ends_with(&[Status::Connecting, Status::Connected]),
        "{seen:?}"
    );

    let session = m.session().unwrap();
    assert_eq!(
        device::power_info(&session).await.unwrap(),
        device::PowerInfo {
            battery: 86,
            charging: true
        }
    );
    let sd = device::storage_info(&session, "/ext")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((sd.used, sd.total), (8_000_000_000, 32_000_000_000));
    assert!(device::storage_info(&session, "/int")
        .await
        .unwrap()
        .is_some());
    /* connecting again is a no-op */
    m.connect(None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn no_sd_card_reads_as_none() {
    let bench = Arc::new(Bench::default());
    bench.plug(
        "Orca",
        FakeConfig {
            no_sd: true,
            ..Default::default()
        },
    );
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let session = m.session().unwrap();
    assert_eq!(device::storage_info(&session, "/ext").await.unwrap(), None);
    assert!(device::storage_info(&session, "/int")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_plugged_in() {
    let bench = Arc::new(Bench::default());
    let m = manager(&bench);
    let err = m.connect(None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Disconnected);
    assert_eq!(m.current().error, Some(ErrorCode::Disconnected));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_flippers_wait_for_a_pick() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    bench.plug("Orca", FakeConfig::default());
    let m = manager(&bench);
    m.poll();
    assert_eq!(m.current().ports.len(), 2);
    let err = m.connect(None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Failed);
    assert_eq!(m.current().status, Status::Disconnected);
    assert_eq!(
        m.current().error,
        None,
        "not a failure to show, just a choice to make"
    );

    m.connect(Some("flip_Orca".into())).await.unwrap();
    assert_eq!(m.current().info.unwrap().name, "Orca");
}

#[tokio::test(flavor = "multi_thread")]
async fn unplugging_disconnects_and_plugging_back_in_starts_afresh() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();

    bench.unplug_all();
    tokio::time::sleep(Duration::from_millis(100)).await;
    m.poll();
    let s = m.current();
    assert_eq!(
        (s.status, s.ports.len(), s.info.is_none()),
        (Status::Disconnected, 0, true)
    );
    assert!(m.session().is_err());

    bench.plug("Nautilus", FakeConfig::default());
    m.poll();
    assert_eq!(bench.last().ports.len(), 1);
    assert_eq!(bench.last().error, None);
    m.connect(None).await.unwrap();
    assert_eq!(m.current().status, Status::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_poll_notices_an_unplug_on_its_own() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    /* gone from the port list, before any read fails */
    bench.ports.lock().unwrap().clear();
    m.poll();
    assert_eq!(m.current().status, Status::Disconnected);
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_errors_for_ports_that_wont_work() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    settled(&m);
    for code in [ErrorCode::PortBusy, ErrorCode::Permission] {
        *bench.open_error.lock().unwrap() = Some(code);
        assert_eq!(m.connect(None).await.unwrap_err().code, code);
        assert_eq!(m.current().error, Some(code));
        assert_eq!(m.current().status, Status::Disconnected);
    }
    *bench.open_error.lock().unwrap() = None;

    let bench = Arc::new(Bench::default());
    bench.plug(
        "Silent",
        FakeConfig {
            silent: true,
            ..Default::default()
        },
    );
    let m = manager(&bench);
    settled(&m);
    assert_eq!(m.connect(None).await.unwrap_err().code, ErrorCode::NoAnswer);
    assert_eq!(m.current().error, Some(ErrorCode::NoAnswer));
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_waits_for_the_flipper_to_come_back() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();

    let b = bench.clone();
    let replug = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        b.unplug_all();
        tokio::time::sleep(Duration::from_millis(400)).await;
        b.plug("Nautilus", FakeConfig::default());
    });
    m.reboot().await.unwrap();
    replug.await.unwrap();
    let s = m.current();
    assert_eq!((s.status, s.ports.len()), (Status::Disconnected, 1));
    assert!(bench
        .states
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.ports.is_empty()));
    m.connect(None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_hands_the_flipper_back_to_its_cli() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    m.shutdown().await;
    assert_eq!(m.current().status, Status::Disconnected);
    let received = bench.fakes.lock().unwrap()[0].received();
    assert_eq!(received.last().map(String::as_str), Some("stop_session"));
}

#[test]
fn state_serializes_like_the_ui_expects() {
    let s = ConnectionState {
        status: Status::Disconnected,
        ports: vec![PortInfo {
            id: "flip_A".into(),
            name: "A".into(),
        }],
        error: Some(ErrorCode::PortBusy),
        info: None,
        console: false,
        current: None,
    };
    assert_eq!(
        serde_json::to_string(&s).unwrap(),
        r#"{"status":"disconnected","ports":[{"id":"flip_A","name":"A"}],"error":"port-busy"}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn screen_frames_and_keys() {
    use crate::rpc::proto::pb_gui::{InputKey, InputType};
    use crate::services::screen;

    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let session = m.session().unwrap();

    let frames = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let f = frames.clone();
    let id = screen::start(&session, Arc::new(move |b| f.lock().unwrap().push(b)))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let got = frames.lock().unwrap().clone();
    assert_eq!(
        got.len(),
        1,
        "the fake sends one frame when the stream starts"
    );
    assert_eq!((got[0].len(), got[0][0]), (1025, 0));

    for t in [InputType::Press, InputType::Short, InputType::Release] {
        screen::input(&session, InputKey::Ok, t).await.unwrap();
    }
    screen::stop(&session, id - 1).await.unwrap();
    assert!(!bench.fakes.lock().unwrap()[0]
        .received()
        .contains(&"gui_stop_screen_stream_request".to_string()));
    screen::stop(&session, id).await.unwrap();
    let received = bench.fakes.lock().unwrap()[0].received();
    let inputs = received
        .iter()
        .filter(|n| *n == "gui_send_input_event_request")
        .count();
    assert_eq!(inputs, 3);
    assert!(received.contains(&"gui_stop_screen_stream_request".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flipper_that_just_appeared_gets_time_to_settle() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    *bench.busy_opens.lock().unwrap() = 2;
    let m = manager(&bench);
    m.poll();
    m.connect(None).await.unwrap();
    assert_eq!(m.current().status, Status::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_restart_it_reconnects_even_if_the_port_needs_a_moment() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let b = bench.clone();
    let replug = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        b.unplug_all();
        tokio::time::sleep(Duration::from_millis(300)).await;
        /* back, but Windows refuses the first two opens */
        *b.busy_opens.lock().unwrap() = 2;
        b.plug("Nautilus", FakeConfig::default());
    });
    m.reboot().await.unwrap();
    replug.await.unwrap();
    m.connect(None).await.unwrap();
    assert_eq!(m.current().status, Status::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_busy_for_good_still_says_so() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    /* long after it appeared, a busy port fails at once */
    settled(&m);
    *bench.open_error.lock().unwrap() = Some(ErrorCode::PortBusy);
    let started = std::time::Instant::now();
    assert_eq!(m.connect(None).await.unwrap_err().code, ErrorCode::PortBusy);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_waits_through_the_updaters_restarts_then_reconnects() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let b = bench.clone();
    let updater = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        b.unplug_all();
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.configs.lock().unwrap().clear();
        b.plug(
            "Nautilus",
            FakeConfig {
                silent: true,
                ..Default::default()
            },
        );
        tokio::time::sleep(Duration::from_millis(1200)).await;
        b.unplug_all();
        b.configs.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.plug("Nautilus", FakeConfig::default());
    });
    let info = m
        .restart_into_update(Duration::from_secs(20))
        .await
        .unwrap();
    updater.await.unwrap();
    assert_eq!(info.name, "Nautilus");
    assert_eq!(m.current().status, Status::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_that_never_comes_back_says_so() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let b = bench.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        b.unplug_all();
    });
    let e = m
        .restart_into_update(Duration::from_millis(1500))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::UpdateStuck);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_console_takes_the_cli_and_gives_it_back() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let session = m.session().unwrap();
    crate::services::screen::start(&session, Arc::new(|_| {}))
        .await
        .unwrap();
    drop(session);
    let text = Arc::new(Mutex::new(Vec::<u8>::new()));
    let t = text.clone();
    m.cli_attach(Arc::new(move |b| t.lock().unwrap().extend(b)))
        .await
        .unwrap();
    assert!(m.current().console);
    assert_eq!(m.session().err().unwrap().code, ErrorCode::ConsoleOpen);
    let seen = |s: &str| String::from_utf8_lossy(&text.lock().unwrap()).contains(s);
    for b in "hlep".bytes() {
        m.cli_write(vec![b]).unwrap();
    }
    /* typed, corrected with backspaces, run */
    m.cli_write(b"\x7f\x7f\x7felp\r".to_vec()).unwrap();
    for _ in 0..50 {
        if seen("Placeholder help") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen(">: "));
    assert!(seen("Placeholder help"));
    assert!(text.lock().unwrap().starts_with(b"\r\n>: "));
    m.cli_detach().await.unwrap();
    assert!(!m.current().console);
    assert_eq!(m.current().status, Status::Connected);
    assert_eq!(m.device_info().await.unwrap().name, "Nautilus");
    /* detaching twice is harmless */
    m.cli_detach().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pulling_the_cable_in_the_console_disconnects() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    m.cli_attach(Arc::new(|_| {})).await.unwrap();
    bench.unplug_all();
    for _ in 0..50 {
        if m.current().status == Status::Disconnected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(m.current().status, Status::Disconnected);
    assert!(!m.current().console);
    assert_eq!(
        m.cli_write(b"x".to_vec()).unwrap_err().code,
        ErrorCode::Disconnected
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_clock_reads_and_sets() {
    use crate::services::device::{self, Clock};
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    let m = manager(&bench);
    m.connect(None).await.unwrap();
    let s = m.session().unwrap();
    assert_eq!(device::get_clock(&s).await.unwrap().year, 2024);
    let now = Clock {
        year: 2026,
        month: 10,
        day: 3,
        hour: 14,
        minute: 2,
        second: 11,
        weekday: 6,
    };
    device::set_clock(&s, now).await.unwrap();
    assert_eq!(device::get_clock(&s).await.unwrap(), now);
    /* nothing the Flipper can't keep */
    assert!(device::set_clock(&s, Clock { month: 13, ..now })
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_between_two_flippers() {
    let bench = Arc::new(Bench::default());
    bench.plug("Nautilus", FakeConfig::default());
    bench.plug("Orca", FakeConfig::default());
    let m = manager(&bench);
    m.connect(Some("flip_Nautilus".into())).await.unwrap();
    assert_eq!(m.current().info.unwrap().name, "Nautilus");
    m.switch_to("flip_Orca".into()).await.unwrap();
    let s = m.current();
    assert_eq!(
        (s.status, s.info.unwrap().name),
        (Status::Connected, "Orca".to_string())
    );
    assert_eq!(
        m.switch_to("flip_Beluga".into()).await.unwrap_err().code,
        ErrorCode::Disconnected
    );
    assert_eq!(m.current().info.unwrap().name, "Orca");
}

#[derive(Default)]
struct Air {
    names: Mutex<Vec<String>>,
    fakes: Mutex<Vec<FakeHandle>>,
}
impl Wireless for Air {
    fn ports(&self) -> Vec<FoundPort> {
        self.names
            .lock()
            .unwrap()
            .iter()
            .map(|n| FoundPort {
                id: format!("ble:{n}"),
                name: n.clone(),
                path: "Bluetooth".into(),
            })
            .collect()
    }
    fn open<'a>(&'a self, id: &'a str) -> Opening<'a> {
        Box::pin(async move {
            let name = id.trim_start_matches("ble:").to_string();
            let (host, device) = pipe();
            let cfg = FakeConfig {
                rpc_only: true,
                ..Default::default()
            };
            self.fakes
                .lock()
                .unwrap()
                .push(FakeFlipper::new(&name, cfg).spawn(device));
            Ok(host)
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bluetooth_connects_without_the_cli_and_the_cable_wins() {
    let bench = Arc::new(Bench::default());
    let air = Arc::new(Air::default());
    air.names.lock().unwrap().push("Nautilus".into());
    let m = manager(&bench);
    m.set_wireless(air.clone());
    m.poll();
    assert_eq!(m.current().ports[0].id, "ble:Nautilus");
    m.connect(None).await.unwrap();
    let info = m.current().info.unwrap();
    assert_eq!((info.name.as_str(), info.link), ("Nautilus", "Bluetooth"));
    /* files work over it; the Console needs the cable */
    let s = m.session().unwrap();
    assert!(!crate::services::storage::list(&s, "/ext")
        .await
        .unwrap()
        .is_empty());
    drop(s);
    assert_eq!(
        m.cli_attach(Arc::new(|_| {})).await.unwrap_err().code,
        ErrorCode::UsbOnly
    );
    /* plugged in too: only the USB port is listed */
    bench.plug("Nautilus", FakeConfig::default());
    let ports = m.all_ports();
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0].id, "flip_Nautilus");
}
