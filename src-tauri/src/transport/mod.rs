pub mod ble;
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
