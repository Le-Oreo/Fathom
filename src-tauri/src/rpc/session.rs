use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::oneshot;

use super::framing::{self, Decoder};
use super::proto::{pb, pb_system};
use crate::error::{DeviceError, ErrorCode};
use crate::transport::{is_idle, write_patiently, Link, WRITE_DEADLINE};

pub type Content = pb::main::Content;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const NUDGE_AFTER: Duration = Duration::from_millis(500);
const ECHO: &[u8] = b"start_rpc_session";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    Disconnected,
    Timeout,
    /* the CLI never offered a prompt */
    NoAnswer,
    /* a command_status other than OK */
    Status(i32),
    Protocol(String),
}

impl From<RpcError> for DeviceError {
    fn from(e: RpcError) -> Self {
        match e {
            RpcError::Disconnected => ErrorCode::Disconnected.into(),
            RpcError::Timeout => ErrorCode::Timeout.into(),
            RpcError::NoAnswer => ErrorCode::NoAnswer.into(),
            RpcError::Status(s) => {
                DeviceError::new(ErrorCode::from_status(s), format!("command_status {s}"))
            }
            RpcError::Protocol(d) => DeviceError::new(ErrorCode::Failed, d),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SessionOptions {
    /* from opening the port to the RPC session starting */
    pub handshake: Duration,
    pub ping_every: Duration,
    pub ping_timeout: Duration,
    pub stop_timeout: Duration,
}

impl Default for SessionOptions {
    fn default() -> Self {
        SessionOptions {
            handshake: Duration::from_secs(3),
            ping_every: Duration::from_secs(3),
            ping_timeout: Duration::from_secs(5),
            stop_timeout: Duration::from_millis(500),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub dir: &'static str,
    pub name: String,
    pub detail: String,
}

pub type LogFn = Arc<dyn Fn(LogEntry) + Send + Sync>;
pub type Listener = Arc<dyn Fn(pb::Main) + Send + Sync>;

pub type PartFn = Box<dyn FnMut(&pb::Main) + Send>;

struct Pending {
    parts: Vec<pb::Main>,
    tx: oneshot::Sender<Result<Vec<pb::Main>, RpcError>>,
    last: Instant,
    on_part: Option<PartFn>,
}

type Released = Result<(Link, Vec<u8>), RpcError>;

enum Out {
    Bytes(Vec<u8>),
    Mark(oneshot::Sender<()>),
    Release {
        bytes: Vec<u8>,
        stop: u32,
        limit: Duration,
        done: oneshot::Sender<Released>,
    },
}

pub struct Call {
    id: u32,
    rx: oneshot::Receiver<Result<Vec<pb::Main>, RpcError>>,
}

struct Inner {
    out: Mutex<Option<smpsc::Sender<Out>>>,
    pending: Mutex<HashMap<u32, Pending>>,
    next_id: AtomicU32,
    closed: AtomicBool,
    last_rx: Mutex<Instant>,
    on_close: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /* the listener and the id of the stream it belongs to */
    listener: Mutex<Option<(u64, Listener)>>,
    listener_ids: AtomicU32,
    log: LogFn,
}

impl Inner {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /* Ids start at 1 and skip 0 when they wrap. */
    fn next_id(&self) -> u32 {
        loop {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            if id != 0 {
                return id;
            }
        }
    }

    fn queue(&self, bytes: Vec<u8>) -> bool {
        match self.out.lock().unwrap().as_ref() {
            Some(tx) => tx.send(Out::Bytes(bytes)).is_ok(),
            None => false,
        }
    }

    fn begin(&self, on_part: Option<PartFn>) -> Result<Call, RpcError> {
        if self.is_closed() {
            return Err(RpcError::Disconnected);
        }
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id,
            Pending {
                parts: Vec::new(),
                tx,
                last: Instant::now(),
                on_part,
            },
        );
        Ok(Call { id, rx })
    }

    fn send_part(&self, id: u32, content: Content, has_next: bool) -> Result<(), RpcError> {
        let msg = pb::Main {
            command_id: id,
            has_next,
            content: Some(content),
            ..Default::default()
        };
        if self.queue(framing::encode(&msg)) {
            Ok(())
        } else {
            self.pending.lock().unwrap().remove(&id);
            Err(RpcError::Disconnected)
        }
    }

    async fn finish(&self, call: Call, idle: Duration) -> Result<Vec<pb::Main>, RpcError> {
        let Call { id, mut rx } = call;
        loop {
            match tokio::time::timeout(idle, &mut rx).await {
                Ok(Ok(result)) => return result,
                Ok(Err(_)) => return Err(RpcError::Disconnected),
                Err(_) => {
                    let mut pending = self.pending.lock().unwrap();
                    let fresh = pending.get(&id).is_some_and(|p| p.last.elapsed() < idle);
                    if !fresh {
                        pending.remove(&id);
                        return Err(RpcError::Timeout);
                    }
                }
            }
        }
    }

    async fn call(&self, content: Content, timeout: Duration) -> Result<Vec<pb::Main>, RpcError> {
        let call = self.begin(None)?;
        self.send_part(call.id, content, false)?;
        self.finish(call, timeout).await
    }

    fn dispatch(&self, msg: pb::Main) {
        *self.last_rx.lock().unwrap() = Instant::now();
        let id = msg.command_id;
        let mut pending = self.pending.lock().unwrap();
        let Some(p) = pending.get_mut(&id) else {
            drop(pending);
            if id == 0 {
                let listener = self
                    .listener
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, f)| f.clone());
                if let Some(f) = listener {
                    f(msg);
                }
            }
            return;
        };
        if msg.command_status != pb::CommandStatus::Ok as i32 {
            let p = pending.remove(&id).unwrap();
            let _ = p.tx.send(Err(RpcError::Status(msg.command_status)));
            return;
        }
        let more = msg.has_next;
        p.last = Instant::now();
        if let Some(f) = p.on_part.as_mut() {
            f(&msg);
        }
        p.parts.push(msg);
        if !more {
            let p = pending.remove(&id).unwrap();
            let _ = p.tx.send(Ok(p.parts));
        }
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.out.lock().unwrap().take();
        let waiting: Vec<Pending> = self
            .pending
            .lock()
            .unwrap()
            .drain()
            .map(|(_, p)| p)
            .collect();
        for p in waiting {
            let _ = p.tx.send(Err(RpcError::Disconnected));
        }
        self.listener.lock().unwrap().take();
        if let Some(f) = self.on_close.lock().unwrap().take() {
            f();
        }
    }
}

pub struct Session {
    inner: Arc<Inner>,
    opts: SessionOptions,
    storage: Arc<tokio::sync::Mutex<()>>,
}

impl Session {
    pub async fn open(
        link: Link,
        opts: SessionOptions,
        log: LogFn,
        on_close: Box<dyn FnOnce() + Send>,
    ) -> Result<Session, RpcError> {
        Self::open_with(link, opts, log, on_close, true).await
    }

    pub async fn open_rpc(
        link: Link,
        opts: SessionOptions,
        log: LogFn,
        on_close: Box<dyn FnOnce() + Send>,
    ) -> Result<Session, RpcError> {
        Self::open_with(link, opts, log, on_close, false).await
    }

    async fn open_with(
        link: Link,
        opts: SessionOptions,
        log: LogFn,
        on_close: Box<dyn FnOnce() + Send>,
        handshake: bool,
    ) -> Result<Session, RpcError> {
        let Link {
            mut reader,
            mut writer,
        } = link;
        let (reader, writer, leftover) = if handshake {
            tokio::task::spawn_blocking(move || {
                start_rpc(&mut *reader, &mut *writer, opts.handshake)
                    .map(|left| (reader, writer, left))
            })
            .await
            .map_err(|e| RpcError::Protocol(e.to_string()))??
        } else {
            (reader, writer, Vec::new())
        };

        let (tx, rx) = smpsc::channel::<Out>();
        let inner = Arc::new(Inner {
            out: Mutex::new(Some(tx)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            last_rx: Mutex::new(Instant::now()),
            on_close: Mutex::new(Some(on_close)),
            listener: Mutex::new(None),
            listener_ids: AtomicU32::new(1),
            log,
        });
        spawn_io(reader, writer, rx, leftover, inner.clone());
        tokio::spawn(keepalive(Arc::downgrade(&inner), opts));
        Ok(Session {
            inner,
            opts,
            storage: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub async fn storage_turn(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.storage.clone().lock_owned().await
    }

    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    pub fn storage_free(&self) -> bool {
        self.storage.try_lock().is_ok()
    }

    pub fn take_listener(&self) -> bool {
        self.inner.listener.lock().unwrap().take().is_some()
    }

    /* Sends a request and waits for every part of the reply. */
    pub async fn request(
        &self,
        content: Content,
        detail: &str,
        timeout: Duration,
    ) -> Result<Vec<pb::Main>, RpcError> {
        self.log_out(&content, detail);
        self.inner.call(content, timeout).await
    }

    pub async fn request_parts(
        &self,
        content: Content,
        detail: &str,
        idle: Duration,
        on_part: PartFn,
    ) -> Result<Vec<pb::Main>, RpcError> {
        self.log_out(&content, detail);
        let call = self.inner.begin(Some(on_part))?;
        self.inner.send_part(call.id, content, false)?;
        self.inner.finish(call, idle).await
    }

    pub fn begin(&self, first: &Content, detail: &str) -> Result<Call, RpcError> {
        self.log_out(first, detail);
        self.inner.begin(None)
    }

    pub fn send_part(&self, call: &Call, content: Content, has_next: bool) -> Result<(), RpcError> {
        self.inner.send_part(call.id, content, has_next)
    }

    pub fn answered(&self, call: &Call) -> bool {
        !self.inner.pending.lock().unwrap().contains_key(&call.id)
    }

    pub async fn finish(&self, call: Call, idle: Duration) -> Result<Vec<pb::Main>, RpcError> {
        self.inner.finish(call, idle).await
    }

    pub async fn flushed(&self) -> Result<(), RpcError> {
        let (tx, rx) = oneshot::channel();
        let queued = match self.inner.out.lock().unwrap().as_ref() {
            Some(out) => out.send(Out::Mark(tx)).is_ok(),
            None => false,
        };
        if !queued {
            return Err(RpcError::Disconnected);
        }
        rx.await.map_err(|_| RpcError::Disconnected)
    }

    pub async fn request_quiet(
        &self,
        content: Content,
        detail: Option<&str>,
        timeout: Duration,
    ) -> Result<Vec<pb::Main>, RpcError> {
        if let Some(d) = detail {
            self.log_out(&content, d);
        }
        self.inner.call(content, timeout).await
    }

    /* Sends a request that gets no reply (a reboot). */
    pub fn send(&self, content: Content, detail: &str) -> Result<(), RpcError> {
        self.log_out(&content, detail);
        let msg = pb::Main {
            command_id: self.inner.next_id(),
            content: Some(content),
            ..Default::default()
        };
        if self.inner.is_closed() || !self.inner.queue(framing::encode(&msg)) {
            return Err(RpcError::Disconnected);
        }
        Ok(())
    }

    pub fn set_listener(&self, listener: Listener) -> u64 {
        let id = u64::from(self.inner.listener_ids.fetch_add(1, Ordering::SeqCst));
        *self.inner.listener.lock().unwrap() = Some((id, listener));
        id
    }

    pub fn clear_listener(&self, id: u64) -> bool {
        let mut l = self.inner.listener.lock().unwrap();
        if l.as_ref().is_some_and(|(cur, _)| *cur == id) {
            *l = None;
            return true;
        }
        false
    }

    pub fn log_in(&self, name: &str, detail: &str) {
        (self.inner.log)(LogEntry {
            dir: "in",
            name: name.into(),
            detail: detail.into(),
        });
    }

    fn log_out(&self, content: &Content, detail: &str) {
        (self.inner.log)(LogEntry {
            dir: "out",
            name: content_name(content),
            detail: detail.into(),
        });
    }

    pub async fn close(&self) {
        if self.inner.is_closed() {
            return;
        }
        let stop = Content::StopSession(pb::StopSession {});
        self.log_out(&stop, "");
        let _ = self.inner.call(stop, self.opts.stop_timeout).await;
        self.inner.close();
    }

    pub fn drop_link(&self) {
        self.inner.close();
    }

    pub async fn release(&self, limit: Duration) -> Released {
        let on_close = self.inner.on_close.lock().unwrap().take();
        let stop = Content::StopSession(pb::StopSession {});
        self.log_out(&stop, "for the Console");
        let id = self.inner.next_id();
        let bytes = framing::encode(&pb::Main {
            command_id: id,
            content: Some(stop),
            ..Default::default()
        });
        let (tx, rx) = oneshot::channel();
        let queued = !self.inner.is_closed()
            && self.inner.out.lock().unwrap().as_ref().is_some_and(|o| {
                o.send(Out::Release {
                    bytes,
                    stop: id,
                    limit,
                    done: tx,
                })
                .is_ok()
            });
        let result = if queued {
            rx.await.unwrap_or(Err(RpcError::Disconnected))
        } else {
            Err(RpcError::Disconnected)
        };
        if result.is_err() {
            self.inner.close();
            if let Some(f) = on_close {
                f();
            }
        }
        result
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.inner.close();
    }
}

pub fn content_name(content: &Content) -> String {
    let debug = format!("{content:?}");
    let variant = debug.split(['(', ' ', '{']).next().unwrap_or("");
    let mut out = String::with_capacity(variant.len() + 8);
    for (i, ch) in variant.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn start_rpc(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    limit: Duration,
) -> Result<Vec<u8>, RpcError> {
    let start = Instant::now();
    let mut buf = [0u8; 512];
    let mut read = |seen: &mut Vec<u8>| -> Result<(), RpcError> {
        if start.elapsed() > limit {
            return Err(RpcError::NoAnswer);
        }
        match reader.read(&mut buf) {
            Ok(0) => Err(RpcError::Disconnected),
            Ok(n) => {
                seen.extend_from_slice(&buf[..n]);
                Ok(())
            }
            Err(e) if is_idle(&e) => Ok(()),
            Err(_) => Err(RpcError::Disconnected),
        }
    };
    let mut seen = Vec::new();
    let mut nudged = false;
    while !seen.ends_with(b">: ") {
        if !nudged && start.elapsed() > NUDGE_AFTER {
            write_patiently(writer, b"\r", WRITE_DEADLINE).map_err(|_| RpcError::Disconnected)?;
            nudged = true;
        }
        read(&mut seen)?;
        if seen.len() > 8192 {
            seen.drain(..seen.len() - 16);
        }
    }
    write_patiently(writer, b"start_rpc_session\r", WRITE_DEADLINE)
        .map_err(|_| RpcError::Disconnected)?;
    let mut seen = Vec::new();
    loop {
        if let Some(at) = find(&seen, ECHO) {
            if let Some(nl) = seen[at..].iter().position(|&b| b == b'\n') {
                return Ok(seen[at + nl + 1..].to_vec());
            }
        }
        read(&mut seen)?;
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/* Most bytes sent in one write. */
const SEND_AT_ONCE: usize = 16 * 1024;
const READ_AT_LEAST: Duration = Duration::from_millis(50);

/* One thread sends and receives in turn: Windows lets only one read or
write through a port at a time. It never waits on a send without reading
in between, since a Flipper that can't send can stop taking data too. */
fn spawn_io(
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    rx: smpsc::Receiver<Out>,
    leftover: Vec<u8>,
    inner: Arc<Inner>,
) {
    thread::Builder::new()
        .name("flipper-io".into())
        .spawn(move || {
            let mut decoder = Decoder::default();
            let mut buf = vec![0u8; 4096];
            let mut data = leftover;
            let mut queue: VecDeque<Out> = VecDeque::new();
            let mut sending: Vec<u8> = Vec::new();
            let mut at = 0;
            let mut stuck: Option<Instant> = None;
            let mut last_read = Instant::now();
            let mut open = true;
            loop {
                while open {
                    match rx.try_recv() {
                        Ok(o) => queue.push_back(o),
                        Err(smpsc::TryRecvError::Empty) => break,
                        Err(smpsc::TryRecvError::Disconnected) => open = false,
                    }
                }
                /* start the next send once the last has gone out whole */
                while at == sending.len() {
                    sending.clear();
                    at = 0;
                    match queue.pop_front() {
                        None => break,
                        Some(Out::Mark(done)) => {
                            let _ = done.send(());
                        }
                        Some(Out::Bytes(b)) => {
                            sending = b;
                            while let Some(Out::Bytes(next)) = queue.front() {
                                if sending.len() + next.len() > SEND_AT_ONCE {
                                    break;
                                }
                                if let Some(Out::Bytes(next)) = queue.pop_front() {
                                    sending.extend_from_slice(&next);
                                }
                            }
                        }
                        Some(Out::Release {
                            bytes,
                            stop,
                            limit,
                            done,
                        }) => {
                            if inner.is_closed() {
                                let _ = done.send(Err(RpcError::Disconnected));
                                return;
                            }
                            let result = release(
                                &mut *reader,
                                &mut *writer,
                                &bytes,
                                stop,
                                limit,
                                &mut decoder,
                                std::mem::take(&mut data),
                                &inner,
                            );
                            inner.close();
                            let _ = done.send(result.map(|rest| (Link { reader, writer }, rest)));
                            return;
                        }
                    }
                }
                let mut moving = false;
                if at < sending.len() {
                    match writer.write(&sending[at..]) {
                        Ok(n) if n > 0 => {
                            at += n;
                            stuck = None;
                            moving = true;
                        }
                        Ok(_) => {}
                        Err(e) if is_idle(&e) => {}
                        Err(_) => {
                            inner.close();
                            return;
                        }
                    }
                    if at < sending.len()
                        && stuck.get_or_insert_with(Instant::now).elapsed() >= WRITE_DEADLINE
                    {
                        inner.close();
                        return;
                    }
                }
                if inner.is_closed() {
                    /* closed: what was queued still goes out (a reboot request) */
                    if !open && queue.is_empty() && at == sending.len() {
                        return;
                    }
                    if at == sending.len() && queue.is_empty() {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    continue;
                }
                /* while it's taking data, keep sending; still read now and then */
                let more = at < sending.len() || !queue.is_empty();
                if moving && more && last_read.elapsed() < READ_AT_LEAST {
                    continue;
                }
                if data.is_empty() {
                    last_read = Instant::now();
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            inner.close();
                            continue;
                        }
                        Ok(n) => data.extend_from_slice(&buf[..n]),
                        Err(e) if is_idle(&e) => continue,
                        Err(_) => {
                            inner.close();
                            continue;
                        }
                    }
                }
                match decoder.push(&data) {
                    Ok(msgs) => msgs.into_iter().for_each(|m| inner.dispatch(m)),
                    Err(_) => inner.close(),
                }
                data.clear();
            }
        })
        .expect("couldn't start the I/O thread");
}

#[allow(clippy::too_many_arguments)]
fn release(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    bytes: &[u8],
    stop: u32,
    limit: Duration,
    decoder: &mut Decoder,
    mut data: Vec<u8>,
    inner: &Inner,
) -> Result<Vec<u8>, RpcError> {
    write_patiently(writer, bytes, WRITE_DEADLINE).map_err(|_| RpcError::Disconnected)?;
    let start = Instant::now();
    let mut buf = vec![0u8; 4096];
    loop {
        let (msgs, rest) = decoder
            .push_until(&data, stop)
            .map_err(|e| RpcError::Protocol(format!("{e:?}")))?;
        data.clear();
        for m in msgs {
            if m.command_id == stop && m.command_status != pb::CommandStatus::Ok as i32 {
                return Err(RpcError::Status(m.command_status));
            }
            inner.dispatch(m);
        }
        if let Some(rest) = rest {
            return Ok(rest);
        }
        if start.elapsed() > limit {
            return Err(RpcError::Timeout);
        }
        match reader.read(&mut buf) {
            Ok(0) => return Err(RpcError::Disconnected),
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(e) if is_idle(&e) => {}
            Err(_) => return Err(RpcError::Disconnected),
        }
    }
}

/* A busy Flipper can be slow to answer: it counts as gone only after two
pings in a row go unanswered with nothing else coming back either. */
async fn keepalive(inner: Weak<Inner>, opts: SessionOptions) {
    let tick = opts.ping_every.min(Duration::from_millis(500));
    let mut missed = 0;
    loop {
        tokio::time::sleep(tick).await;
        let Some(inner) = inner.upgrade() else { return };
        if inner.is_closed() {
            return;
        }
        let idle = inner.pending.lock().unwrap().is_empty()
            && inner.last_rx.lock().unwrap().elapsed() >= opts.ping_every;
        if !idle {
            missed = 0;
            continue;
        }
        let ping = Content::SystemPingRequest(pb_system::PingRequest { data: vec![0xf1] });
        match inner.call(ping, opts.ping_timeout).await {
            Err(RpcError::Timeout) => {
                let heard = inner.last_rx.lock().unwrap().elapsed() < opts.ping_timeout;
                missed = if heard { 0 } else { missed + 1 };
                if missed >= 2 {
                    inner.close();
                    return;
                }
            }
            Err(RpcError::Disconnected) => return,
            _ => missed = 0,
        }
    }
}
