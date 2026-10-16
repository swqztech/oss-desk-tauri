mod download;
mod sidecar;

use download::{
    download_clear, download_list, download_open, download_remove, download_show, download_url,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = sidecar::spawn_oss_api(&handle) {
                    eprintln!("[oss-desk] {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            download_list,
            download_clear,
            download_remove,
            download_show,
            download_open,
            download_url
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OSS Desk");
}
