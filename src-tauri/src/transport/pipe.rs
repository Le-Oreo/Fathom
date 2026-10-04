use std::io::{self, Read, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use super::Link;

const READ_WAIT: Duration = Duration::from_millis(5);

pub struct PipeReader {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    at: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.at >= self.buf.len() {
            match self.rx.recv_timeout(READ_WAIT) {
                Ok(chunk) => {
                    self.buf = chunk;
                    self.at = 0;
                }
                Err(RecvTimeoutError::Timeout) => return Err(io::ErrorKind::TimedOut.into()),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

pub struct PipeWriter {
    tx: Sender<Vec<u8>>,
}

impl Write for PipeWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.is_empty() {
            return Ok(0);
        }
        self.tx
            .send(data.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/* (host end, device end) */
pub fn pipe() -> (Link, Link) {
    let (to_device, from_host) = channel();
    let (to_host, from_device) = channel();
    let host = Link {
        reader: Box::new(PipeReader {
            rx: from_device,
            buf: Vec::new(),
            at: 0,
        }),
        writer: Box::new(PipeWriter { tx: to_device }),
    };
    let device = Link {
        reader: Box::new(PipeReader {
            rx: from_host,
            buf: Vec::new(),
            at: 0,
        }),
        writer: Box::new(PipeWriter { tx: to_host }),
    };
    (host, device)
}
