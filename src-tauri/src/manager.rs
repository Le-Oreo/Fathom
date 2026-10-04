use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cli::{Cli, OnData};
use crate::error::{DeviceError, ErrorCode};
use crate::rpc::proto::{pb_system, pb_system::reboot_request::RebootMode};
use crate::rpc::{Content, LogEntry, LogFn, Session, SessionOptions, REQUEST_TIMEOUT};
use crate::services::device::{self, DeviceInfo, Pairs};
use crate::transport::serial::FoundPort;
use crate::transport::Link;

pub const POLL_EVERY: Duration = Duration::from_secs(1);
const REBOOT_LEAVE: Duration = Duration::from_secs(10);
const REBOOT_RETURN: Duration = Duration::from_secs(30);
const SETTLE: Duration = Duration::from_secs(8);
const SETTLE_RETRY: Duration = Duration::from_millis(700);
const CLI_SWITCH: Duration = Duration::from_secs(2);
const UPDATE_RETRY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionState {
    pub status: Status,
    pub ports: Vec<PortInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<DeviceInfo>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub console: bool,
    /* the port (an id from `ports`) of the Flipper connected */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

pub type Discover = Box<dyn Fn() -> Vec<FoundPort> + Send + Sync>;
pub type Open = Box<dyn Fn(&FoundPort) -> Result<Link, (ErrorCode, String)> + Send + Sync>;
pub type Emit = Box<dyn Fn(&ConnectionState) + Send + Sync>;

pub type Opening<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Link, (ErrorCode, String)>> + Send + 'a>,
>;

pub trait Wireless: Send + Sync {
    fn ports(&self) -> Vec<FoundPort>;
    fn open<'a>(&'a self, id: &'a str) -> Opening<'a>;
}

pub fn is_wireless(id: &str) -> bool {
    id.starts_with(crate::transport::ble::PREFIX)
}

struct State {
    status: Status,
    ports: Vec<FoundPort>,
    error: Option<ErrorCode>,
    info: Option<DeviceInfo>,
    session: Option<Arc<Session>>,
    cli: Option<Arc<Cli>>,
    /* the id of the Flipper connected */
    current: Option<String>,
    epoch: u64,
    /* restarting: report no Flippers until it's back */
    hold: bool,
    /* device info keys already written to the log */
    keys_logged: bool,
    /* when each Flipper plugged in now was first seen */
    seen: HashMap<String, Instant>,
}

pub struct Manager {
    discover: Discover,
    open: Open,
    emit: Emit,
    log: LogFn,
    opts: SessionOptions,
    state: Mutex<State>,
    connect_lock: tokio::sync::Mutex<()>,
    me: Weak<Manager>,
    wireless: std::sync::OnceLock<Arc<dyn Wireless>>,
}

impl Manager {
    pub fn new(
        discover: Discover,
        open: Open,
        emit: Emit,
        log: LogFn,
        opts: SessionOptions,
    ) -> Arc<Manager> {
        Arc::new_cyclic(|me| Manager {
            discover,
            open,
            emit,
            log,
            opts,
            state: Mutex::new(State {
                status: Status::Disconnected,
                ports: Vec::new(),
                error: None,
                info: None,
                session: None,
                cli: None,
                current: None,
                epoch: 0,
                hold: false,
                keys_logged: false,
                seen: HashMap::new(),
            }),
            connect_lock: tokio::sync::Mutex::new(()),
            me: me.clone(),
            wireless: std::sync::OnceLock::new(),
        })
    }

    pub fn set_wireless(&self, w: Arc<dyn Wireless>) {
        let _ = self.wireless.set(w);
    }

    fn all_ports(&self) -> Vec<FoundPort> {
        let mut ports = (self.discover)();
        if let Some(w) = self.wireless.get() {
            for p in w.ports() {
                if !ports.iter().any(|u| u.name.eq_ignore_ascii_case(&p.name)) {
                    ports.push(p);
                }
            }
        }
        ports
    }

    fn snapshot(st: &State) -> ConnectionState {
        ConnectionState {
            status: st.status,
            ports: st
                .ports
                .iter()
                .map(|p| PortInfo {
                    id: p.id.clone(),
                    name: p.name.clone(),
                })
                .collect(),
            error: st.error,
            info: if st.status == Status::Connected {
                st.info.clone()
            } else {
                None
            },
            console: st.status == Status::Connected && st.cli.is_some(),
            current: if st.status == Status::Connected {
                st.current.clone()
            } else {
                None
            },
        }
    }

    pub fn current(&self) -> ConnectionState {
        Self::snapshot(&self.state.lock().unwrap())
    }

    fn update(&self, f: impl FnOnce(&mut State)) {
        let mut st = self.state.lock().unwrap();
        let before = Self::snapshot(&st);
        f(&mut st);
        let after = Self::snapshot(&st);
        if after != before {
            (self.emit)(&after);
        }
    }

    fn end_session(st: &mut State) -> Option<Arc<Session>> {
        st.status = Status::Disconnected;
        st.info = None;
        st.current = None;
        st.epoch += 1;
        st.cli = None;
        st.session.take()
    }

    fn note_ports(st: &mut State, ports: &[FoundPort]) {
        let now = Instant::now();
        st.seen.retain(|id, _| ports.iter().any(|p| &p.id == id));
        for p in ports {
            st.seen.entry(p.id.clone()).or_insert(now);
        }
    }

    /* Looks for Flippers. Called about once a second. */
    pub fn poll(&self) {
        if self.state.lock().unwrap().hold {
            return;
        }
        let ports = self.all_ports();
        let mut gone = None;
        self.update(|st| {
            if st.hold || st.ports == ports {
                return;
            }
            let lost = st.status == Status::Connected
                && !ports.iter().any(|p| Some(&p.id) == st.current.as_ref());
            if lost {
                gone = Self::end_session(st);
            }
            Self::note_ports(st, &ports);
            st.ports = ports;
            /* something was plugged in or out: start afresh */
            st.error = None;
        });
        if let Some(s) = gone {
            s.drop_link();
        }
    }

    fn session_lost(&self, epoch: u64) {
        let ports = self.all_ports();
        let mut gone = None;
        self.update(|st| {
            if st.epoch != epoch || st.status != Status::Connected {
                return;
            }
            gone = Self::end_session(st);
            if !st.hold {
                st.ports = ports;
            }
        });
        drop(gone);
    }

    fn fail(&self, code: ErrorCode, detail: impl Into<String>) -> Result<(), DeviceError> {
        self.update(|st| {
            st.status = Status::Disconnected;
            st.error = Some(code);
        });
        Err(DeviceError::new(code, detail))
    }

    pub async fn connect(&self, port: Option<String>) -> Result<(), DeviceError> {
        let _one_at_a_time = self.connect_lock.lock().await;
        if self.state.lock().unwrap().status == Status::Connected {
            return Ok(());
        }
        if self.state.lock().unwrap().hold {
            return self.fail(ErrorCode::Disconnected, "restarting");
        }
        let ports = self.all_ports();
        self.update(|st| {
            Self::note_ports(st, &ports);
            st.ports = ports.clone();
        });
        let target = match &port {
            Some(id) => ports.iter().find(|p| &p.id == id).cloned(),
            None if ports.len() > 1 => {
                return Err(DeviceError::new(
                    ErrorCode::Failed,
                    "several Flippers are plugged in; pick one",
                ))
            }
            None => ports.first().cloned(),
        };
        let Some(target) = target else {
            return self.fail(ErrorCode::Disconnected, "no Flipper found");
        };
        self.update(|st| {
            st.status = Status::Connecting;
            st.error = None;
        });
        let settled_by = self
            .state
            .lock()
            .unwrap()
            .seen
            .get(&target.id)
            .map(|t| *t + SETTLE);
        let (session, info, pairs, epoch) = loop {
            match self.attempt(&target).await {
                Ok(r) => break r,
                Err(e) => {
                    let still_there = self.all_ports().iter().any(|p| p.id == target.id);
                    let settling = settled_by.is_some_and(|t| Instant::now() < t);
                    if still_there && settling && Self::may_settle(e.code) {
                        tokio::time::sleep(SETTLE_RETRY).await;
                        continue;
                    }
                    return self.fail(e.code, e.detail);
                }
            }
        };
        let power = device::power_pairs(&session).await.unwrap_or_default();
        self.log_keys_once(&pairs, &power);
        let session = Arc::new(session);
        let mut late = None;
        self.update(|st| {
            if st.epoch != epoch || session.is_closed() {
                /* it closed while we were asking for its info */
                st.status = Status::Disconnected;
                st.error = Some(ErrorCode::Disconnected);
                late = Some(session.clone());
                return;
            }
            st.status = Status::Connected;
            st.info = Some(info);
            st.session = Some(session.clone());
            st.current = Some(target.id.clone());
        });
        if late.is_some() {
            return Err(ErrorCode::Disconnected.into());
        }
        Ok(())
    }

    fn may_settle(code: ErrorCode) -> bool {
        matches!(
            code,
            ErrorCode::PortBusy
                | ErrorCode::NoAnswer
                | ErrorCode::Timeout
                | ErrorCode::Disconnected
                | ErrorCode::Failed
        )
    }

    async fn attempt(
        &self,
        target: &FoundPort,
    ) -> Result<(Session, DeviceInfo, Pairs, u64), DeviceError> {
        let wireless = is_wireless(&target.id);
        let link = if wireless {
            let w = self
                .wireless
                .get()
                .ok_or_else(|| DeviceError::new(ErrorCode::Disconnected, "no Bluetooth"))?;
            w.open(&target.id)
                .await
                .map_err(|(code, detail)| DeviceError::new(code, detail))?
        } else {
            (self.open)(target).map_err(|(code, detail)| DeviceError::new(code, detail))?
        };
        (self.log)(LogEntry {
            dir: "out",
            name: "start_rpc_session".into(),
            detail: target.path.clone(),
        });
        let epoch = {
            let mut st = self.state.lock().unwrap();
            st.epoch += 1;
            st.epoch
        };
        let me = self.me.clone();
        let on_close = Box::new(move || {
            if let Some(m) = me.upgrade() {
                m.session_lost(epoch);
            }
        });
        let session = if wireless {
            Session::open_rpc(link, self.opts, self.log.clone(), on_close).await?
        } else {
            Session::open(link, self.opts, self.log.clone(), on_close).await?
        };
        match device::device_info(&session, &target.path).await {
            Ok((mut info, pairs)) => {
                if info.id.is_empty() {
                    info.id = target.id.clone();
                }
                if wireless {
                    info.link = "Bluetooth";
                }
                Ok((session, info, pairs, epoch))
            }
            Err(e) => {
                session.drop_link();
                Err(e.into())
            }
        }
    }

    fn log_keys_once(&self, pairs: &Pairs, power: &Pairs) {
        let mut st = self.state.lock().unwrap();
        if st.keys_logged {
            return;
        }
        st.keys_logged = true;
        let private = |k: &str| {
            ["uid", "mac", "serial", "name"]
                .iter()
                .any(|w| k.contains(w))
        };
        for (k, v) in pairs.iter().filter(|(k, _)| !private(k)) {
            log::info!(target: "device", "device info: {k} = {v}");
        }
        for (k, v) in power {
            log::info!(target: "device", "power info: {k} = {v}");
        }
    }

    pub fn session(&self) -> Result<Arc<Session>, DeviceError> {
        let st = self.state.lock().unwrap();
        if st.cli.is_some() && st.status == Status::Connected {
            return Err(DeviceError::new(
                ErrorCode::ConsoleOpen,
                "the Console has the CLI",
            ));
        }
        match (&st.session, st.status) {
            (Some(s), Status::Connected) if !s.is_closed() => Ok(s.clone()),
            _ => Err(ErrorCode::Disconnected.into()),
        }
    }

    pub async fn device_info(&self) -> Result<DeviceInfo, DeviceError> {
        let session = self.session()?;
        let port = self
            .state
            .lock()
            .unwrap()
            .info
            .as_ref()
            .map(|i| i.port.clone())
            .unwrap_or_default();
        let (mut info, _) = device::device_info(&session, &port).await?;
        if info.id.is_empty() {
            info.id = self
                .state
                .lock()
                .unwrap()
                .current
                .clone()
                .unwrap_or_default();
        }
        Ok(info)
    }

    pub async fn play_alert(&self) -> Result<(), DeviceError> {
        let session = self.session()?;
        let req =
            Content::SystemPlayAudiovisualAlertRequest(pb_system::PlayAudiovisualAlertRequest {});
        session.request(req, "", REQUEST_TIMEOUT).await?;
        Ok(())
    }

    pub async fn reboot(&self) -> Result<(), DeviceError> {
        let session = self.session()?;
        self.restart(session, RebootMode::Os, REBOOT_RETURN).await?;
        Ok(())
    }

    async fn restart(
        &self,
        session: Arc<Session>,
        mode: RebootMode,
        back_within: Duration,
    ) -> Result<bool, DeviceError> {
        let req = Content::SystemRebootRequest(pb_system::RebootRequest { mode: mode as i32 });
        let detail = match mode {
            RebootMode::Os => "OS mode",
            RebootMode::Dfu => "DFU mode",
            RebootMode::Update => "UPDATE mode",
        };
        session.send(req, detail)?;
        let id = self.state.lock().unwrap().current.clone();
        let mut gone = None;
        self.update(|st| {
            st.hold = true;
            st.ports.clear();
            st.seen.clear();
            gone = Self::end_session(st);
        });
        drop(session);
        if let Some(s) = gone {
            s.drop_link();
        }
        let present = |m: &Manager| m.all_ports().iter().any(|p| Some(&p.id) == id.as_ref());
        let start = Instant::now();
        while present(self) && start.elapsed() < REBOOT_LEAVE {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let start = Instant::now();
        while !present(self) && start.elapsed() < back_within {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let back = present(self);
        self.state.lock().unwrap().hold = false;
        self.poll();
        Ok(back)
    }

    pub async fn restart_into_update(&self, wait: Duration) -> Result<DeviceInfo, DeviceError> {
        let session = self.session()?;
        let id = self.state.lock().unwrap().current.clone();
        let deadline = Instant::now() + wait;
        self.restart(session, RebootMode::Update, wait).await?;
        loop {
            let ports = self.all_ports();
            let here = ports.iter().find(|p| Some(&p.id) == id.as_ref()).cloned();
            if let Some(p) = here {
                if self.connect(Some(p.id)).await.is_ok() {
                    if let Some(info) = self.current().info {
                        return Ok(info);
                    }
                }
            }
            if Instant::now() >= deadline {
                return Err(DeviceError::new(
                    ErrorCode::UpdateStuck,
                    "the Flipper didn't come back",
                ));
            }
            tokio::time::sleep(UPDATE_RETRY).await;
        }
    }

    pub async fn cli_attach(&self, on_data: OnData) -> Result<(), DeviceError> {
        let _one_at_a_time = self.connect_lock.lock().await;
        if let Some(cli) = self.state.lock().unwrap().cli.clone() {
            cli.set_sink(on_data);
            /* the new terminal starts on a fresh line */
            cli.write(vec![0x03]);
            return Ok(());
        }
        if self
            .state
            .lock()
            .unwrap()
            .current
            .as_deref()
            .is_some_and(is_wireless)
        {
            return Err(DeviceError::new(
                ErrorCode::UsbOnly,
                "the CLI isn't on Bluetooth",
            ));
        }
        let session = self.session()?;
        if !session.storage_free() {
            return Err(DeviceError::new(
                ErrorCode::Busy,
                "a file is being read or written",
            ));
        }
        if session.take_listener() {
            let stop = Content::GuiStopScreenStreamRequest(
                crate::rpc::proto::pb_gui::StopScreenStreamRequest {},
            );
            let _ = session
                .request(stop, "for the Console", REQUEST_TIMEOUT)
                .await;
        }
        let epoch = self.state.lock().unwrap().epoch;
        let (link, rest) = session.release(CLI_SWITCH).await?;
        drop(session);
        let me = self.me.clone();
        let cli = Arc::new(Cli::start(
            link,
            rest,
            on_data,
            Box::new(move || {
                if let Some(m) = me.upgrade() {
                    m.session_lost(epoch);
                }
            }),
        ));
        cli.write(vec![0x03]);
        let mut old = None;
        let mut attached = false;
        self.update(|st| {
            if st.epoch == epoch && st.status == Status::Connected {
                old = st.session.take();
                st.cli = Some(cli.clone());
                attached = true;
            }
        });
        drop(old);
        if !attached {
            return Err(ErrorCode::Disconnected.into());
        }
        Ok(())
    }

    pub fn cli_write(&self, bytes: Vec<u8>) -> Result<(), DeviceError> {
        let cli = self.state.lock().unwrap().cli.clone();
        match cli {
            Some(c) if c.write(bytes) => Ok(()),
            _ => Err(ErrorCode::Disconnected.into()),
        }
    }

    pub async fn cli_detach(&self) -> Result<(), DeviceError> {
        let _one_at_a_time = self.connect_lock.lock().await;
        let Some(cli) = self.state.lock().unwrap().cli.clone() else {
            return Ok(());
        };
        for _ in 0..3 {
            let seen = cli.prompts();
            cli.write(vec![0x03]);
            if cli.wait_prompt(seen, Duration::from_millis(1000)).await {
                break;
            }
        }
        let Some(link) = cli.release().await else {
            return Err(ErrorCode::Disconnected.into());
        };
        let mut epoch = 0;
        self.update(|st| {
            st.epoch += 1;
            epoch = st.epoch;
        });
        let me = self.me.clone();
        let on_close = Box::new(move || {
            if let Some(m) = me.upgrade() {
                m.session_lost(epoch);
            }
        });
        let port = self
            .state
            .lock()
            .unwrap()
            .info
            .as_ref()
            .map(|i| i.port.clone())
            .unwrap_or_default();
        (self.log)(LogEntry {
            dir: "out",
            name: "start_rpc_session".into(),
            detail: port,
        });
        match Session::open(link, self.opts, self.log.clone(), on_close).await {
            Ok(session) => {
                let session = Arc::new(session);
                let mut ok = false;
                self.update(|st| {
                    if st.epoch == epoch && st.status == Status::Connected {
                        st.cli = None;
                        st.session = Some(session.clone());
                        ok = true;
                    }
                });
                if !ok {
                    session.drop_link();
                    return Err(ErrorCode::Disconnected.into());
                }
                Ok(())
            }
            Err(e) => {
                let e = DeviceError::from(e);
                let mut gone = None;
                self.update(|st| {
                    if st.epoch == epoch {
                        gone = Self::end_session(st);
                        st.error = Some(e.code);
                    }
                });
                drop(gone);
                Err(e)
            }
        }
    }

    pub async fn disconnect(&self) {
        let _one_at_a_time = self.connect_lock.lock().await;
        let mut gone = None;
        self.update(|st| {
            if st.status == Status::Connected {
                gone = Self::end_session(st);
            }
        });
        if let Some(s) = gone {
            s.close().await;
        }
    }

    /* Switches to another Flipper that's plugged in. */
    pub async fn switch_to(&self, port: String) -> Result<(), DeviceError> {
        if !self.all_ports().iter().any(|p| p.id == port) {
            return Err(DeviceError::new(ErrorCode::Disconnected, "not plugged in"));
        }
        self.disconnect().await;
        self.connect(Some(port)).await
    }

    pub async fn shutdown(&self) {
        let mut gone = None;
        self.update(|st| gone = Self::end_session(st));
        if let Some(s) = gone {
            s.close().await;
        }
    }
}

pub fn start_polling(manager: &Arc<Manager>) {
    let weak = Arc::downgrade(manager);
    thread::Builder::new()
        .name("flipper-poll".into())
        .spawn(move || loop {
            match weak.upgrade() {
                Some(m) => m.poll(),
                None => return,
            }
            thread::sleep(POLL_EVERY);
        })
        .expect("couldn't start the port poller");
}

#[cfg(test)]
mod tests;
