pub mod ble;
#[cfg(test)]
pub mod flaky;
#[cfg(test)]
pub mod pipe;
pub mod serial;

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

pub struct Link {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

/* No data yet, as opposed to a closed link. */
pub fn is_idle(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

/* How long the Flipper may take no bytes at all, e.g. while it saves to its SD card. */
pub const WRITE_DEADLINE: Duration = Duration::from_secs(30);

/* Writes all of it, waiting while the port is only slow. Windows reports a
write that timed out as 0 bytes written rather than an error. */
pub fn write_patiently(w: &mut dyn Write, mut buf: &[u8], deadline: Duration) -> io::Result<()> {
    let mut since = Instant::now();
    while !buf.is_empty() {
        match w.write(buf) {
            Ok(0) => {}
            Ok(n) => {
                buf = &buf[n..];
                since = Instant::now();
                continue;
            }
            Err(e) if is_idle(&e) => {}
            Err(e) => return Err(e),
        }
        if since.elapsed() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* takes nothing for its first few tries, as a busy Flipper does on Windows */
    struct Busy {
        stalls: usize,
        got: Vec<u8>,
    }
    impl Write for Busy {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.stalls > 0 {
                self.stalls -= 1;
                return if self.stalls.is_multiple_of(2) {
                    Ok(0)
                } else {
                    Err(io::ErrorKind::TimedOut.into())
                };
            }
            let n = buf.len().min(3);
            self.got.extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_slow_flipper_is_waited_for() {
        let mut w = Busy {
            stalls: 40,
            got: Vec::new(),
        };
        write_patiently(&mut w, b"update package", Duration::from_secs(5)).unwrap();
        assert_eq!(w.got, b"update package");
        let mut stuck = Busy {
            stalls: usize::MAX,
            got: Vec::new(),
        };
        assert!(write_patiently(&mut stuck, b"x", Duration::from_millis(50)).is_err());
    }
}
