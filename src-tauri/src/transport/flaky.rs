/* A link that behaves like a busy Flipper on Windows: small buffers both
ways, writes that time out as 0 bytes or take only part, reads in odd
pieces. The Flipper's end blocks when the computer isn't reading. */
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::Link;

const HOST_WAIT: Duration = Duration::from_millis(15);
const DEVICE_WAIT: Duration = Duration::from_millis(5);

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /* 1..=n */
    pub fn upto(&mut self, n: usize) -> usize {
        1 + (self.next() % n.max(1) as u64) as usize
    }
}

struct State {
    data: VecDeque<u8>,
    writer_gone: bool,
    reader_gone: bool,
}

struct Lane {
    cap: usize,
    state: Mutex<State>,
    cv: Condvar,
    rng: Mutex<Rng>,
}

impl Lane {
    fn new(cap: usize, seed: u64) -> Arc<Self> {
        Arc::new(Lane {
            cap,
            state: Mutex::new(State {
                data: VecDeque::new(),
                writer_gone: false,
                reader_gone: false,
            }),
            cv: Condvar::new(),
            rng: Mutex::new(Rng::new(seed)),
        })
    }
    fn roll(&self, n: usize) -> usize {
        self.rng.lock().unwrap().upto(n)
    }
}

/* the computer's end of a lane: gives up after a moment, as Windows does.
Windows also lets only one read or write at a time through a port. */
struct HostWriter(Arc<Lane>, Arc<Mutex<()>>);
struct HostReader(Arc<Lane>, Arc<Mutex<()>>);
/* the Flipper's end: its sends wait for room */
struct DeviceWriter(Arc<Lane>);
struct DeviceReader(Arc<Lane>);

impl Write for HostWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _port = self.1.lock().unwrap();
        let lane = &self.0;
        let st = lane.state.lock().unwrap();
        let (mut st, _) = lane
            .cv
            .wait_timeout_while(st, HOST_WAIT, |s| {
                s.data.len() >= lane.cap && !s.reader_gone
            })
            .unwrap();
        if st.reader_gone {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let room = lane.cap - st.data.len();
        if room == 0 || buf.is_empty() {
            /* Windows: a write that timed out "succeeds" with nothing written */
            return if lane.roll(3) == 1 {
                Err(io::ErrorKind::TimedOut.into())
            } else {
                Ok(0)
            };
        }
        let n = lane.roll(room.min(buf.len()));
        st.data.extend(&buf[..n]);
        lane.cv.notify_all();
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for HostReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let _port = self.1.lock().unwrap();
        let lane = &self.0;
        let st = lane.state.lock().unwrap();
        let (mut st, _) = lane
            .cv
            .wait_timeout_while(st, HOST_WAIT, |s| s.data.is_empty() && !s.writer_gone)
            .unwrap();
        if st.data.is_empty() {
            return if st.writer_gone {
                Err(io::ErrorKind::BrokenPipe.into())
            } else {
                Err(io::ErrorKind::TimedOut.into())
            };
        }
        let n = lane.roll(st.data.len().min(out.len()));
        for (i, b) in st.data.drain(..n).enumerate() {
            out[i] = b;
        }
        lane.cv.notify_all();
        Ok(n)
    }
}

impl Write for DeviceWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let lane = &self.0;
        let st = lane.state.lock().unwrap();
        let mut st = lane
            .cv
            .wait_while(st, |s| s.data.len() >= lane.cap && !s.reader_gone)
            .unwrap();
        if st.reader_gone {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let n = (lane.cap - st.data.len()).min(buf.len());
        st.data.extend(&buf[..n]);
        lane.cv.notify_all();
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for DeviceReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let lane = &self.0;
        let st = lane.state.lock().unwrap();
        let (mut st, _) = lane
            .cv
            .wait_timeout_while(st, DEVICE_WAIT, |s| s.data.is_empty() && !s.writer_gone)
            .unwrap();
        if st.data.is_empty() {
            return if st.writer_gone {
                Ok(0)
            } else {
                Err(io::ErrorKind::TimedOut.into())
            };
        }
        let n = lane.roll(st.data.len().min(out.len()));
        for (i, b) in st.data.drain(..n).enumerate() {
            out[i] = b;
        }
        lane.cv.notify_all();
        Ok(n)
    }
}

macro_rules! gone {
    ($t:ty, $field:ident) => {
        impl Drop for $t {
            fn drop(&mut self) {
                self.0.state.lock().unwrap().$field = true;
                self.0.cv.notify_all();
            }
        }
    };
}
gone!(HostWriter, writer_gone);
gone!(DeviceWriter, writer_gone);
gone!(HostReader, reader_gone);
gone!(DeviceReader, reader_gone);

/* (computer end, Flipper end) */
pub fn flaky(seed: u64, to_flipper: usize, to_computer: usize) -> (Link, Link) {
    let down = Lane::new(to_flipper, seed);
    let up = Lane::new(to_computer, seed ^ 0xabcd);
    let port = Arc::new(Mutex::new(()));
    let host = Link {
        reader: Box::new(HostReader(up.clone(), port.clone())),
        writer: Box::new(HostWriter(down.clone(), port)),
    };
    let device = Link {
        reader: Box::new(DeviceReader(down)),
        writer: Box::new(DeviceWriter(up)),
    };
    (host, device)
}
