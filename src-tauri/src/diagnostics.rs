use std::sync::Arc;

use tauri::{AppHandle, Manager as _, State};

use crate::manager::Manager;

pub const LOG_NAME: &str = "fathom";
const TAIL: usize = 200;

#[tauri::command]
pub fn diagnostics(app: AppHandle, m: State<'_, Arc<Manager>>) -> String {
    let mut out = vec![
        format!("FATHOM {}", app.package_info().version),
        format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    ];
    let c = m.current();
    out.push(format!(
        "Connection: {:?}{}{}",
        c.status,
        c.error
            .map(|e| format!(", last error {e:?}"))
            .unwrap_or_default(),
        if c.console { ", Console attached" } else { "" }
    ));
    out.push(format!("Flippers plugged in: {}", c.ports.len()));
    if let Some(i) = c.info {
        out.push(format!(
            "Flipper: {} {}, firmware {} ({}), target {}, region {}",
            i.model, i.hardware, i.firmware, i.branch, i.target, i.region
        ));
    }
    out.push(String::new());
    out.push(format!("Last {TAIL} log lines:"));
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(format!("{LOG_NAME}.log"))).ok())
        .unwrap_or_default();
    let lines: Vec<&str> = log.lines().collect();
    out.extend(
        lines[lines.len().saturating_sub(TAIL)..]
            .iter()
            .map(|l| l.to_string()),
    );
    out.join("\n")
}
