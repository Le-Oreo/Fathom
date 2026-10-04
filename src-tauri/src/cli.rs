use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use tokio::sync::oneshot;

use crate::transport::{is_idle, write_patiently, Link, WRITE_DEADLINE};

pub type OnData = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

const PROMPT: &[u8] = b">: ";

enum Out {
    Bytes(Vec<u8>),
    /* stop and hand the link back */
    Release(oneshot::Sender<Link>),
}

pub struct Cli {
    tx: smpsc::Sender<Out>,
    /* how many ">: " prompts the Flipper has printed */
    prompts: tokio::sync::watch::Receiver<u64>,
    sink: Arc<Mutex<OnData>>,
}

impl Cli {
    pub fn start(
        link: Link,
        leftover: Vec<u8>,
        on_data: OnData,
        on_lost: Box<dyn FnOnce() + Send>,
    ) -> Cli {
        let (tx, rx) = smpsc::channel::<Out>();
        let sink = Arc::new(Mutex::new(on_data));
        let to = sink.clone();
        let (count, prompts) = tokio::sync::watch::channel(0u64);
        let mut synced = false;
        let mut early: Vec<u8> = Vec::new();
        let mut tail: Vec<u8> = Vec::new();
        let mut on_data = move |b: Vec<u8>| {
            let mut joined = std::mem::take(&mut tail);
            let before = joined.len();
            joined.extend_from_slice(&b);
            let n = joined
                .windows(3)
                .enumerate()
                .filter(|(i, w)| *w == PROMPT && i + 3 > before)
                .count() as u64;
            tail = joined[joined.len().saturating_sub(2)..].to_vec();
            if n > 0 {
                count.send_modify(|c| *c += n);
            }
            let out = if synced {
                b
            } else {
                early.extend_from_slice(&b);
                match early.windows(3).position(|w| w == PROMPT) {
                    Some(at) => {
                        synced = true;
                        let mut out = b"\r\n".to_vec();
                        out.extend_from_slice(&early[at..]);
                        early = Vec::new();
                        out
                    }
                    None => {
                        if early.len() > 64 * 1024 {
                            early.drain(..early.len() - 3);
                        }
                        return;
                    }
                }
            };
            let f = to.lock().unwrap().clone();
            f(out)
        };
        let Link {
            mut reader,
            mut writer,
        } = link;
        thread::Builder::new()
            .name("flipper-cli".into())
            .spawn(move || {
                if !leftover.is_empty() {
                    on_data(leftover);
                }
                let mut buf = vec![0u8; 4096];
                loop {
                    loop {
                        match rx.try_recv() {
                            Ok(Out::Bytes(b)) => {
                                if write_patiently(&mut *writer, &b, WRITE_DEADLINE).is_err() {
                                    on_lost();
                                    return;
                                }
                            }
                            Ok(Out::Release(done)) => {
                                let _ = done.send(Link { reader, writer });
                                return;
                            }
                            Err(smpsc::TryRecvError::Empty) => break,
                            /* the Console was closed some other way: let the port go */
                            Err(smpsc::TryRecvError::Disconnected) => return,
                        }
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            on_lost();
                            return;
                        }
                        Ok(n) => on_data(buf[..n].to_vec()),
                        Err(e) if is_idle(&e) => {}
                        Err(_) => {
                            on_lost();
                            return;
                        }
                    }
                }
            })
            .expect("couldn't start the CLI thread");
        Cli { tx, prompts, sink }
    }

    pub fn prompts(&self) -> u64 {
        *self.prompts.borrow()
    }

    pub async fn wait_prompt(&self, seen: u64, limit: std::time::Duration) -> bool {
        let mut rx = self.prompts.clone();
        tokio::time::timeout(limit, rx.wait_for(|c| *c > seen))
            .await
            .is_ok_and(|r| r.is_ok())
    }

    pub fn set_sink(&self, on_data: OnData) {
        *self.sink.lock().unwrap() = on_data;
    }

    pub fn write(&self, bytes: Vec<u8>) -> bool {
        self.tx.send(Out::Bytes(bytes)).is_ok()
    }

    pub async fn release(&self) -> Option<Link> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Out::Release(tx)).ok()?;
        rx.await.ok()
    }
}
