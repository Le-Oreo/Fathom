mod appicon;
mod cli;
mod commands;
mod diagnostics;
mod error;
#[cfg(test)]
mod fake;
mod files;
mod folder_sync;
mod manager;
mod rpc;
mod services;
#[cfg(test)]
mod stress_tests;
mod transport;
mod update;

use std::sync::Arc;

use tauri::{Emitter, Manager as _, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use manager::Manager;
use rpc::{LogEntry, SessionOptions};
use transport::serial;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some(diagnostics::LOG_NAME.into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let (conn, log) = (app.handle().clone(), app.handle().clone());
            let manager = Manager::new(
                Box::new(serial::discover),
                Box::new(serial::open),
                Box::new(move |s| {
                    log::info!(
                        target: "connection",
                        "{:?}{}{}",
                        s.status,
                        s.error.map(|e| format!(", {e:?}")).unwrap_or_default(),
                        if s.console { ", console" } else { "" }
                    );
                    let _ = conn.emit("connection", s);
                }),
                Arc::new(move |e: LogEntry| {
                    log::info!(target: "rpc", "{} {}", e.dir, e.name);
                    let _ = log.emit("rpc-log", e);
                }),
                SessionOptions::default(),
            );
            let ble = transport::ble::Ble::new();
            manager.set_wireless(ble.clone());
            manager::start_polling(&manager);
            app.manage(manager);
            app.manage(ble);
            app.manage(files::Transfers::default());
            app.manage(services::library::Cache::default());
            app.manage(update::Updates::default());
            app.manage(folder_sync::Links::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection_current,
            commands::connection_connect,
            commands::connection_switch,
            folder_sync::sync_links,
            folder_sync::sync_link_add,
            folder_sync::sync_link_remove,
            folder_sync::sync_preview,
            folder_sync::sync_apply,
            commands::device_info,
            commands::device_power,
            commands::device_reboot,
            commands::device_play_alert,
            commands::storage_info,
            commands::device_clock_get,
            commands::device_clock_set,
            appicon::app_icon_set,
            commands::screen_start,
            commands::screen_stop,
            commands::input_send,
            commands::file_save,
            commands::cli_attach,
            commands::cli_write,
            commands::cli_detach,
            diagnostics::diagnostics,
            commands::bluetooth_enable,
            files::storage_list,
            files::storage_stat,
            files::storage_read,
            files::storage_write,
            files::storage_mkdir,
            files::storage_rename,
            files::storage_remove,
            files::storage_md5,
            files::library_scan,
            files::app_start,
            files::transfer_upload,
            files::transfer_download,
            files::transfer_cancel,
            files::upload_pick,
            files::upload_folder_pick,
            files::dropped_items,
            files::download_folder_pick,
            update::firmware_latest,
            update::firmware_fork_latest,
            update::app_latest,
            update::app_release_open,
            update::firmware_pick,
            update::firmware_install,
            update::backup_list,
            update::backup_create,
            update::backup_restore,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<files::Transfers>().allow(paths);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|app, event| {
        /* hand the Flipper back to its CLI on the way out */
        if let RunEvent::Exit = event {
            let manager = app.state::<Arc<Manager>>().inner().clone();
            tauri::async_runtime::block_on(manager.shutdown());
        }
    });
}
