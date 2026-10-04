/* The commands the UI may call. Each needs its allow-<name> permission in capabilities/default.json. */
const COMMANDS: &[&str] = &[
    "connection_current",
    "connection_connect",
    "device_info",
    "device_power",
    "device_reboot",
    "device_play_alert",
    "storage_info",
    "app_icon_set",
    "screen_start",
    "screen_stop",
    "input_send",
    "file_save",
    "storage_list",
    "storage_stat",
    "storage_read",
    "storage_write",
    "storage_mkdir",
    "storage_rename",
    "storage_remove",
    "storage_md5",
    "library_scan",
    "app_start",
    "transfer_upload",
    "transfer_download",
    "transfer_cancel",
    "upload_pick",
    "upload_folder_pick",
    "dropped_items",
    "download_folder_pick",
    "firmware_latest",
    "firmware_fork_latest",
    "firmware_pick",
    "firmware_install",
    "backup_list",
    "backup_create",
    "backup_restore",
    "cli_attach",
    "cli_write",
    "cli_detach",
    "diagnostics",
    "device_clock_get",
    "device_clock_set",
    "connection_switch",
    "sync_links",
    "sync_link_add",
    "sync_link_remove",
    "sync_preview",
    "sync_apply",
    "bluetooth_enable",
];

fn main() {
    compile_protos();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build step failed");
}

/* Rust types for the Flipper's RPC messages, from the flipperzero-protobuf submodule in proto/.
protox parses the .proto files, so nobody needs protoc installed. */
fn compile_protos() {
    println!("cargo:rerun-if-changed=proto");
    if !std::path::Path::new("proto/flipper.proto").exists() {
        panic!("proto/flipper.proto is missing. Fetch the submodule: git submodule update --init");
    }
    let fds = protox::compile(["flipper.proto"], ["proto"])
        .expect("couldn't parse the Flipper .proto files");
    prost_build::Config::new()
        .include_file("flipper_pb.rs")
        .compile_fds(fds)
        .expect("couldn't generate the Flipper protobuf types");
}
