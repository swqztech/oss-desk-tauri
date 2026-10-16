use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub filename: String,
    pub file_path: String,
    pub received: u64,
    pub total: u64,
    pub percent: i32,
    pub status: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
}

fn user_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("oss")
}

fn history_path() -> PathBuf {
    user_data_dir().join("download-history.json")
}

pub fn read_history() -> Vec<DownloadRecord> {
    let path = history_path();
    if !path.is_file() {
        return vec![];
    }
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn write_history(list: &[DownloadRecord]) {
    let dir = user_data_dir();
    let _ = fs::create_dir_all(&dir);
    let trimmed: Vec<_> = list.iter().take(80).cloned().collect();
    if let Ok(json) = serde_json::to_string_pretty(&trimmed) {
        let _ = fs::write(history_path(), json);
    }
}

fn upsert(rec: DownloadRecord) -> Vec<DownloadRecord> {
    let mut list = read_history();
    list.retain(|x| x.id != rec.id);
    list.insert(0, rec);
    write_history(&list);
    list
}

fn emit_changed(app: &AppHandle, rec: &DownloadRecord) {
    let _ = app.emit("download:changed", rec);
}

#[tauri::command]
pub fn download_list() -> Vec<DownloadRecord> {
    read_history()
}

#[tauri::command]
pub fn download_clear() -> Vec<DownloadRecord> {
    write_history(&[]);
    vec![]
}

#[tauri::command]
pub fn download_remove(id: String) -> Vec<DownloadRecord> {
    let mut list = read_history();
    list.retain(|x| x.id != id);
    write_history(&list);
    list
}

#[tauri::command]
pub async fn download_show(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let rec = read_history().into_iter().find(|x| x.id == id);
    let rec = rec.ok_or_else(|| "记录不存在".to_string())?;
    let path = Path::new(&rec.file_path);
    if path.is_file() {
        app.opener()
            .reveal_item_in_dir(&rec.file_path)
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({ "ok": true }));
    }
    if let Some(parent) = path.parent() {
        app.opener()
            .open_path(parent.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(serde_json::json!({ "ok": true, "missing": true }))
}

#[tauri::command]
pub async fn download_open(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let rec = read_history().into_iter().find(|x| x.id == id);
    let rec = rec.ok_or_else(|| "记录不存在".to_string())?;
    if !Path::new(&rec.file_path).is_file() {
        return Ok(serde_json::json!({ "ok": false, "missing": true }));
    }
    app.opener()
        .open_path(&rec.file_path, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn download_url(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;

    let default_name = filename.trim();
    let default_name = if default_name.is_empty() { "download" } else { default_name };

    let picked = app
        .dialog()
        .file()
        .set_title("保存文件")
        .set_file_name(default_name)
        .blocking_save_file();

    let path = match picked {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Ok(serde_json::json!({ "ok": false, "canceled": true })),
    };

    let id = Uuid::new_v4().to_string();
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut rec = DownloadRecord {
        id: id.clone(),
        filename: default_name.to_string(),
        file_path: path.to_string_lossy().to_string(),
        received: 0,
        total: 0,
        percent: 0,
        status: "progress".into(),
        started_at,
        finished_at: None,
        error: None,
    };
    upsert(rec.clone());
    emit_changed(&app, &rec);

    let client = reqwest::Client::new();
    let resp = client
        .get(url.trim())
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;
    if !resp.status().is_success() {
        rec.status = "interrupted".into();
        rec.error = Some(format!("HTTP {}", resp.status()));
        rec.finished_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        );
        upsert(rec.clone());
        emit_changed(&app, &rec);
        return Err(rec.error.clone().unwrap_or_default());
    }

    let total = resp.content_length().unwrap_or(0);
    rec.total = total;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    use std::io::Write;
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        rec.received += chunk.len() as u64;
        rec.percent = if total > 0 {
            ((rec.received as f64 / total as f64) * 100.0).min(100.0) as i32
        } else {
            -1
        };
        upsert(rec.clone());
        emit_changed(&app, &rec);
    }

    rec.status = "completed".into();
    rec.percent = 100;
    rec.finished_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    );
    upsert(rec.clone());
    emit_changed(&app, &rec);

    Ok(serde_json::json!({
        "ok": true,
        "id": id,
        "filePath": rec.file_path
    }))
}
