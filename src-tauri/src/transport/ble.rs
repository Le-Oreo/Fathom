use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use tokio::sync::Notify;
use uuid::Uuid;

use super::serial::FoundPort;
use super::Link;
use crate::error::ErrorCode;

pub const SERVICE: Uuid = Uuid::from_u128(0x8fe5b3d5_2e7f_4a98_2a48_7acc60fe0000);
pub const FROM_FLIPPER: Uuid = Uuid::from_u128(0x19ed82ae_ed21_4c9d_4145_228e61fe0000);
pub const TO_FLIPPER: Uuid = Uuid::from_u128(0x19ed82ae_ed21_4c9d_4145_228e62fe0000);
pub const FLOW: Uuid = Uuid::from_u128(0x19ed82ae_ed21_4c9d_4145_228e63fe0000);

pub const PREFIX: &str = "ble:";
const CHUNK: usize = 180;
/* the most the Flipper's buffer takes if it doesn't say */
const DEFAULT_CREDIT: u32 = 512;
const SCAN_EVERY: Duration = Duration::from_secs(4);

pub fn flipper_name(local_name: &str) -> Option<String> {
    let name = local_name.strip_prefix("Flipper ")?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn credit_of(v: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(v.get(..4)?.try_into().ok()?))
}

#[derive(Default)]
pub struct Ble {
    on: AtomicBool,
    found: Mutex<Vec<FoundPort>>,
    peripherals: Mutex<HashMap<String, Peripheral>>,
    adapter: tokio::sync::OnceCell<Option<Adapter>>,
    wake: Notify,
}

impl Ble {
    pub fn new() -> Arc<Ble> {
        Arc::new(Ble::default())
    }

    async fn adapter(&self) -> Option<Adapter> {
        self.adapter
            .get_or_init(|| async {
                let manager = Manager::new().await.ok()?;
                manager.adapters().await.ok()?.into_iter().next()
            })
            .await
            .clone()
    }

    /* Turns looking for Flippers over Bluetooth on or off. */
    pub fn set_enabled(self: &Arc<Self>, on: bool) {
        let was = self.on.swap(on, Ordering::SeqCst);
        if !on {
            self.found.lock().unwrap().clear();
            return;
        }
        if was {
            return;
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.scan_loop().await });
    }

    async fn scan_loop(self: Arc<Self>) {
        let Some(adapter) = self.adapter().await else {
            log::info!(target: "ble", "no Bluetooth adapter");
            return;
        };
        let _ = adapter.start_scan(ScanFilter::default()).await;
        while self.on.load(Ordering::SeqCst) {
            tokio::select! {
                _ = tokio::time::sleep(SCAN_EVERY) => {}
                _ = self.wake.notified() => {}
            }
            let Ok(list) = adapter.peripherals().await else {
                continue;
            };
            let mut found = Vec::new();
            let mut map = HashMap::new();
            for p in list {
                let Ok(Some(props)) = p.properties().await else {
                    continue;
                };
                let Some(name) = props.local_name.as_deref().and_then(flipper_name) else {
                    continue;
                };
                if !props.services.is_empty() && !props.services.contains(&SERVICE) {
                    log::debug!(target: "ble", "{name} advertises other services");
                }
                let id = format!("{PREFIX}{}", p.id());
                found.push(FoundPort {
                    id: id.clone(),
                    name,
                    path: "Bluetooth".into(),
                });
                map.insert(id, p);
            }
            found.sort_by(|a, b| a.name.cmp(&b.name));
            if self.on.load(Ordering::SeqCst) {
                *self.found.lock().unwrap() = found;
                *self.peripherals.lock().unwrap() = map;
            }
        }
        let _ = adapter.stop_scan().await;
    }

    pub fn found(&self) -> Vec<FoundPort> {
        if !self.on.load(Ordering::SeqCst) {
            return vec![];
        }
        self.found.lock().unwrap().clone()
    }

    pub async fn open(&self, id: &str) -> Result<Link, (ErrorCode, String)> {
        let p = self
            .peripherals
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or((ErrorCode::Disconnected, "no longer in range".to_string()))?;
        let fail = |e: btleplug::Error| (ErrorCode::BlePair, e.to_string());
        if !p.is_connected().await.unwrap_or(false) {
            p.connect()
                .await
                .map_err(|e| (ErrorCode::NoAnswer, e.to_string()))?;
        }
        p.discover_services().await.map_err(fail)?;
        let chars = p.characteristics();
        let find = |u: Uuid| chars.iter().find(|c| c.uuid == u).cloned();
        let (Some(from), Some(to), Some(flow)) = (find(FROM_FLIPPER), find(TO_FLIPPER), find(FLOW))
        else {
            let _ = p.disconnect().await;
            return Err((ErrorCode::Failed, "no serial service".into()));
        };
        /* these need the bond: an unpaired computer fails here */
        p.subscribe(&from).await.map_err(fail)?;
        let _ = p.subscribe(&flow).await;
        let start = p
            .read(&flow)
            .await
            .ok()
            .and_then(|v| credit_of(&v))
            .unwrap_or(DEFAULT_CREDIT);
        let mut notes = p.notifications().await.map_err(fail)?;

        let closed = Arc::new(AtomicBool::new(false));
        let credit = Arc::new((Mutex::new(start), Notify::new()));
        let (in_tx, in_rx) = smpsc::channel::<Vec<u8>>();
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

        /* what the Flipper sends, and its flow control */
        {
            let credit = credit.clone();
            let closed = closed.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(n) = notes.next().await {
                    if n.uuid == FROM_FLIPPER {
                        if in_tx.send(n.value).is_err() {
                            break;
                        }
                    } else if n.uuid == FLOW {
                        if let Some(c) = credit_of(&n.value) {
                            *credit.0.lock().unwrap() = c;
                            credit.1.notify_one();
                        }
                    }
                }
                closed.store(true, Ordering::SeqCst);
            });
        }
        {
            let closed = closed.clone();
            let p = p.clone();
            tauri::async_runtime::spawn(async move {
                let mut alive = tokio::time::interval(Duration::from_secs(1));
                loop {
                    let buf = tokio::select! {
                        b = out_rx.recv() => match b { Some(b) => b, None => break },
                        _ = alive.tick() => {
                            if !p.is_connected().await.unwrap_or(false) { break; }
                            continue;
                        }
                    };
                    let mut at = 0;
                    while at < buf.len() {
                        let room = *credit.0.lock().unwrap() as usize;
                        if room == 0 {
                            let waited =
                                tokio::time::timeout(Duration::from_secs(30), credit.1.notified())
                                    .await;
                            if waited.is_err() && *credit.0.lock().unwrap() == 0 {
                                /* it never made room: treat the link as gone */
                                closed.store(true, Ordering::SeqCst);
                                let _ = p.disconnect().await;
                                return;
                            }
                            continue;
                        }
                        let n = (buf.len() - at).min(CHUNK).min(room);
                        if p.write(&to, &buf[at..at + n], WriteType::WithResponse)
                            .await
                            .is_err()
                        {
                            closed.store(true, Ordering::SeqCst);
                            let _ = p.disconnect().await;
                            return;
                        }
                        {
                            let mut c = credit.0.lock().unwrap();
                            *c = c.saturating_sub(n as u32);
                        }
                        at += n;
                    }
                }
                closed.store(true, Ordering::SeqCst);
                let _ = p.disconnect().await;
            });
        }
        Ok(Link {
            reader: Box::new(BleReader {
                rx: in_rx,
                buf: Vec::new(),
                closed: closed.clone(),
            }),
            writer: Box::new(BleWriter { tx: out_tx, closed }),
        })
    }
}

struct BleReader {
    rx: smpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    closed: Arc<AtomicBool>,
}

impl Read for BleReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv_timeout(Duration::from_millis(15)) {
                Ok(v) => self.buf = v,
                Err(smpsc::RecvTimeoutError::Timeout) => {
                    if self.closed.load(Ordering::SeqCst) {
                        return Ok(0);
                    }
                    return Err(io::ErrorKind::TimedOut.into());
                }
                Err(smpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = self.buf.len().min(out.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

struct BleWriter {
    tx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    closed: Arc<AtomicBool>,
}

impl Write for BleWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) || self.tx.send(buf.to_vec()).is_err() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl crate::manager::Wireless for Ble {
    fn ports(&self) -> Vec<FoundPort> {
        self.found()
    }
    fn open<'a>(&'a self, id: &'a str) -> crate::manager::Opening<'a> {
        Box::pin(Ble::open(self, id))
    }
}
