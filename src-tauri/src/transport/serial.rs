use std::io::{self, Read};
use std::time::Duration;

use serialport::{SerialPort, SerialPortInfo, SerialPortType};

use super::Link;
use crate::error::ErrorCode;

pub const FLIPPER_VID: u16 = 0x0483;
pub const FLIPPER_PID: u16 = 0x5740;
const MANUFACTURER: &str = "Flipper Devices Inc.";

const READ_TIMEOUT: Duration = Duration::from_millis(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundPort {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub fn discover() -> Vec<FoundPort> {
    pick_flippers(serialport::available_ports().unwrap_or_default())
}

pub fn pick_flippers(ports: Vec<SerialPortInfo>) -> Vec<FoundPort> {
    let mut out: Vec<FoundPort> = Vec::new();
    for p in ports {
        let SerialPortType::UsbPort(usb) = &p.port_type else {
            continue;
        };
        if usb.vid != FLIPPER_VID || usb.pid != FLIPPER_PID {
            continue;
        }
        let serial = usb
            .serial_number
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let product = usb.product.as_deref().map(str::trim).unwrap_or("");
        let is_flipper = cfg!(windows)
            || usb.manufacturer.as_deref().map(str::trim) == Some(MANUFACTURER)
            || serial.is_some_and(|s| flip_name(s).is_some())
            || product.starts_with("Flipper ");
        if !is_flipper || p.port_name.starts_with("/dev/tty.") {
            continue;
        }
        let name = serial
            .and_then(flip_name)
            .or_else(|| product.strip_prefix("Flipper "))
            .filter(|s| !s.is_empty())
            .unwrap_or(&p.port_name)
            .to_string();
        let id = serial.unwrap_or(&p.port_name).to_string();
        if out.iter().any(|f| f.id == id) {
            continue;
        }
        out.push(FoundPort {
            id,
            name,
            path: p.port_name.clone(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    out
}

fn flip_name(serial: &str) -> Option<&str> {
    let head = serial.get(..5)?;
    head.eq_ignore_ascii_case("flip_").then(|| &serial[5..])
}

pub fn open(port: &FoundPort) -> Result<Link, (ErrorCode, String)> {
    let mut sp = serialport::new(&port.path, 230_400)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|e| {
            (
                open_error(&e, || discover().iter().any(|f| f.id == port.id)),
                e.to_string(),
            )
        })?;
    sp.write_data_terminal_ready(true)
        .map_err(|e| (ErrorCode::Failed, e.to_string()))?;
    let writer = sp
        .try_clone()
        .map_err(|e| (ErrorCode::Failed, e.to_string()))?;
    Ok(Link {
        reader: Box::new(SerialReader(sp)),
        writer: Box::new(writer),
    })
}

pub fn open_error(e: &serialport::Error, still_there: impl FnOnce() -> bool) -> ErrorCode {
    use serialport::ErrorKind as K;
    match e.kind() {
        K::NoDevice => {
            if still_there() {
                ErrorCode::PortBusy
            } else {
                ErrorCode::Disconnected
            }
        }
        K::Io(io::ErrorKind::PermissionDenied) => {
            if cfg!(windows) {
                ErrorCode::PortBusy
            } else {
                ErrorCode::Permission
            }
        }
        K::Io(io::ErrorKind::NotFound) => ErrorCode::Disconnected,
        _ => ErrorCode::Failed,
    }
}

struct SerialReader(Box<dyn SerialPort>);

impl Read for SerialReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::UsbPortInfo;

    fn usb(
        port: &str,
        vid: u16,
        pid: u16,
        serial: Option<&str>,
        maker: Option<&str>,
        product: Option<&str>,
    ) -> SerialPortInfo {
        SerialPortInfo {
            port_name: port.into(),
            port_type: SerialPortType::UsbPort(UsbPortInfo {
                vid,
                pid,
                serial_number: serial.map(Into::into),
                manufacturer: maker.map(Into::into),
                product: product.map(Into::into),
            }),
        }
    }

    #[test]
    fn finds_flippers_by_ids_and_maker() {
        let found = pick_flippers(vec![
            /* Linux: everything reported */
            usb(
                "/dev/ttyACM0",
                0x0483,
                0x5740,
                Some("flip_Nautilus"),
                Some(MANUFACTURER),
                Some("Flipper Nautilus"),
            ),
            usb(
                "COM5",
                0x0483,
                0x5740,
                Some("FLIP_ORCA"),
                Some("Microsoft"),
                Some("USB Serial Device (COM5)"),
            ),
            /* another STM32 board with the same ids */
            usb(
                "/dev/ttyACM1",
                0x0483,
                0x5740,
                Some("206A3B5E5748"),
                Some("STMicroelectronics"),
                Some("Virtual COM"),
            ),
            /* DFU mode isn't used */
            usb(
                "/dev/ttyACM2",
                0x0483,
                0xdf11,
                Some("flip_Dfu"),
                Some(MANUFACTURER),
                None,
            ),
            SerialPortInfo {
                port_name: "/dev/ttyS0".into(),
                port_type: SerialPortType::Unknown,
            },
        ]);
        let mut want = vec![
            FoundPort {
                id: "flip_Nautilus".into(),
                name: "Nautilus".into(),
                path: "/dev/ttyACM0".into(),
            },
            FoundPort {
                id: "FLIP_ORCA".into(),
                name: "ORCA".into(),
                path: "COM5".into(),
            },
        ];
        if cfg!(windows) {
            want.insert(
                0,
                FoundPort {
                    id: "206A3B5E5748".into(),
                    name: "/dev/ttyACM1".into(),
                    path: "/dev/ttyACM1".into(),
                },
            );
        }
        assert_eq!(found, want);
    }

    #[test]
    fn macos_lists_the_cu_device_only() {
        let found = pick_flippers(vec![
            usb(
                "/dev/tty.usbmodemflip_Nautilus1",
                0x0483,
                0x5740,
                Some("flip_Nautilus"),
                Some(MANUFACTURER),
                None,
            ),
            usb(
                "/dev/cu.usbmodemflip_Nautilus1",
                0x0483,
                0x5740,
                Some("flip_Nautilus"),
                Some(MANUFACTURER),
                None,
            ),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/dev/cu.usbmodemflip_Nautilus1");
    }

    #[test]
    fn falls_back_to_product_name_then_port_name() {
        let found = pick_flippers(vec![
            usb(
                "/dev/ttyACM3",
                0x0483,
                0x5740,
                None,
                Some(MANUFACTURER),
                Some("Flipper Beluga"),
            ),
            usb(
                "/dev/ttyACM4",
                0x0483,
                0x5740,
                None,
                Some(MANUFACTURER),
                None,
            ),
        ]);
        let by_path = |p: &str| found.iter().find(|f| f.path == p).cloned().unwrap();
        assert_eq!(
            by_path("/dev/ttyACM3"),
            FoundPort {
                id: "/dev/ttyACM3".into(),
                name: "Beluga".into(),
                path: "/dev/ttyACM3".into()
            }
        );
        assert_eq!(by_path("/dev/ttyACM4").name, "/dev/ttyACM4");
    }

    #[test]
    fn open_errors_in_plain_words() {
        let busy =
            serialport::Error::new(serialport::ErrorKind::NoDevice, "Device or resource busy");
        assert_eq!(open_error(&busy, || true), ErrorCode::PortBusy);
        assert_eq!(open_error(&busy, || false), ErrorCode::Disconnected);
        let denied = serialport::Error::new(
            serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied),
            "denied",
        );
        let want = if cfg!(windows) {
            ErrorCode::PortBusy
        } else {
            ErrorCode::Permission
        };
        assert_eq!(open_error(&denied, || true), want);
    }
}
