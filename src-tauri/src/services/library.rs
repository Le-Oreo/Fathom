use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use super::storage;
use crate::error::DeviceError;
use crate::rpc::Session;

/* (id, folder, extension) as in src/catalog.ts */
pub const CATEGORIES: [(&str, &str, &str); 6] = [
    ("subghz", "/ext/subghz", ".sub"),
    ("ir", "/ext/infrared", ".ir"),
    ("nfc", "/ext/nfc", ".nfc"),
    ("rfid", "/ext/lfrfid", ".rfid"),
    ("badusb", "/ext/badusb", ".txt"),
    ("ibutton", "/ext/ibutton", ".ibtn"),
];

pub fn read_limit(category: &str) -> u64 {
    match category {
        "subghz" | "ir" => 32 * 1024,
        _ => 64 * 1024,
    }
}

const SKIP_DIRS: [&str; 1] = ["assets"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LibraryItem {
    pub category: String,
    pub name: String,
    pub path: String,
    pub meta: String,
    pub detail: String,
    pub fields: Vec<(String, String)>,
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Described {
    pub meta: String,
    pub detail: String,
    pub fields: Vec<(String, String)>,
}

#[derive(Default)]
pub struct Cache(pub(crate) Mutex<HashMap<(String, String, u64), Described>>);

impl Cache {
    /* That path and everything under it. */
    pub fn forget(&self, path: &str) {
        let under = format!("{}/", path.trim_end_matches('/'));
        self.0
            .lock()
            .unwrap()
            .retain(|(_, p, _), _| p != path && !p.starts_with(&under));
    }
}

fn clean(v: &str) -> Option<String> {
    let v = v.trim();
    let ok = !v.is_empty()
        && v.chars().count() <= 32
        && v.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '/' | '.' | '+' | '-' | '(' | ')')
        });
    ok.then(|| v.to_string())
}

fn header(text: &str) -> Vec<(&str, &str)> {
    text.lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect()
}

fn first<'a>(h: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    h.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| *v)
        .filter(|v| !v.is_empty())
}

fn mhz(hz: &str) -> Option<String> {
    let hz: f64 = hz.parse().ok()?;
    Some(format!("{:.2} MHz", hz / 1_000_000.0))
}

fn preset(p: &str) -> String {
    let short = p
        .strip_prefix("FuriHalSubGhzPreset")
        .unwrap_or(p)
        .trim_end_matches("Async");
    match short {
        "Ook270" => "AM270".into(),
        "Ook650" => "AM650".into(),
        "2FSKDev238" => "FM238".into(),
        "2FSKDev476" => "FM476".into(),
        other => other.into(),
    }
}

fn nfc_family(t: &str) -> &'static str {
    let t = t.to_ascii_lowercase();
    if t.contains("15693") || t.contains("slix") {
        "NFC-V"
    } else if t.contains("felica") {
        "NFC-F"
    } else if t.contains("14443-3b") || t.contains("14443-4b") {
        "NFC-B"
    } else {
        "NFC-A"
    }
}

/* The descriptive fields of one file, by category. */
pub fn describe(category: &str, text: &str) -> Described {
    let h = header(text);
    let field = |k: &str, v: &str| (k.to_string(), v.to_string());
    match category {
        "subghz" => {
            let freq = first(&h, "Frequency").and_then(mhz);
            let preset = first(&h, "Preset").map(preset).as_deref().and_then(clean);
            let protocol = first(&h, "Protocol").and_then(clean);
            let mut fields = Vec::new();
            if let Some(f) = &freq {
                fields.push(field("Frequency", f));
            }
            if let Some(p) = &preset {
                fields.push(field("Preset", p));
            }
            if let Some(p) = &protocol {
                fields.push(field("Protocol", p));
            }
            Described {
                meta: freq.unwrap_or_default(),
                detail: protocol.unwrap_or_default(),
                fields,
            }
        }
        "ir" => {
            let buttons = h
                .iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("name"))
                .count();
            /* each button names its protocol, or is "type: raw" */
            let mut protocols: Vec<String> = Vec::new();
            for (k, v) in &h {
                let p = if k.eq_ignore_ascii_case("protocol") {
                    match clean(v) {
                        Some(p) => p,
                        None => continue,
                    }
                } else if k.eq_ignore_ascii_case("type") && v.eq_ignore_ascii_case("raw") {
                    "RAW".to_string()
                } else {
                    continue;
                };
                if !protocols.contains(&p) {
                    protocols.push(p);
                }
            }
            let protocol = match protocols.len() {
                0 => String::new(),
                1 => protocols.remove(0),
                _ => "Mixed".into(),
            };
            let mut fields = vec![field("Buttons", &buttons.to_string())];
            if !protocol.is_empty() {
                fields.push(field("Protocol", &protocol));
            }
            Described {
                meta: format!("{buttons} button{}", if buttons == 1 { "" } else { "s" }),
                detail: protocol,
                fields,
            }
        }
        "nfc" => {
            let device = first(&h, "Device type").and_then(clean).unwrap_or_default();
            /* only these known lines name the specific type */
            let specific = if let Some(t) = first(&h, "NTAG/Ultralight type").and_then(clean) {
                Some(t)
            } else if let Some(t) = first(&h, "Mifare Classic type").and_then(clean) {
                Some(format!("Mifare Classic {t}"))
            } else {
                first(&h, "Mifare DESFire type").and_then(clean)
            };
            let kind = specific.unwrap_or_else(|| device.clone());
            Described {
                detail: if kind.is_empty() {
                    String::new()
                } else {
                    nfc_family(&format!("{device} {kind}")).into()
                },
                fields: if kind.is_empty() {
                    vec![]
                } else {
                    vec![field("Type", &kind)]
                },
                meta: kind,
            }
        }
        "rfid" => {
            let kind = first(&h, "Key type").and_then(clean).unwrap_or_default();
            Described {
                detail: "125 kHz".into(),
                fields: if kind.is_empty() {
                    vec![]
                } else {
                    vec![field("Type", &kind)]
                },
                meta: kind,
            }
        }
        "ibutton" => {
            let kind = first(&h, "Protocol")
                .or_else(|| first(&h, "Key type"))
                .and_then(clean)
                .unwrap_or_default();
            Described {
                detail: "iButton".into(),
                fields: if kind.is_empty() {
                    vec![]
                } else {
                    vec![field("Type", &kind)]
                },
                meta: kind,
            }
        }
        "badusb" => {
            let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
            Described {
                meta: "Script".into(),
                detail: format!("{lines} line{}", if lines == 1 { "" } else { "s" }),
                fields: vec![field("Lines", &lines.to_string())],
            }
        }
        _ => Described::default(),
    }
}

pub async fn scan(
    s: &std::sync::Arc<Session>,
    cache: &Cache,
    device: &str,
) -> Result<Vec<LibraryItem>, DeviceError> {
    use crate::error::ErrorCode;
    let mut out = Vec::new();
    for (category, folder, ext) in CATEGORIES {
        let mut dirs = vec![folder.to_string()];
        while let Some(dir) = dirs.pop() {
            let entries = match storage::list(s, &dir).await {
                Ok(e) => e,
                Err(e) if matches!(e.code, ErrorCode::NotFound | ErrorCode::NoSd) => continue,
                Err(e) => return Err(e),
            };
            for e in entries {
                let path = format!("{dir}/{}", e.name);
                if e.name.starts_with('.') {
                    continue;
                }
                if e.dir {
                    if !(dir == folder && SKIP_DIRS.contains(&e.name.as_str())) {
                        dirs.push(path);
                    }
                    continue;
                }
                if !e.name.to_ascii_lowercase().ends_with(ext) {
                    continue;
                }
                let key = (device.to_string(), path.clone(), e.size);
                let known = cache.0.lock().unwrap().get(&key).cloned();
                let d = match known {
                    Some(d) => d,
                    None if e.size <= read_limit(category) => {
                        match storage::read(s, &path, None, None).await {
                            Ok(bytes) => {
                                let d = describe(category, &String::from_utf8_lossy(&bytes));
                                cache.0.lock().unwrap().insert(key, d.clone());
                                d
                            }
                            Err(e) if e.code == ErrorCode::Disconnected => return Err(e),
                            Err(_) => Described::default(),
                        }
                    }
                    None => Described::default(),
                };
                out.push(LibraryItem {
                    category: category.into(),
                    name: e.name,
                    path,
                    meta: d.meta,
                    detail: d.detail,
                    fields: d.fields,
                    size: e.size,
                });
            }
        }
    }
    Ok(out)
}
