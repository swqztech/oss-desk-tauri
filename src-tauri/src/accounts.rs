use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssAccount {
    pub id: String,
    pub name: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub pinned: Option<bool>,
    pub pinned_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsFile {
    pub accounts: Vec<OssAccount>,
    pub active_id: Option<String>,
}

fn oss_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("oss")
}

fn accounts_path() -> PathBuf {
    oss_data_dir().join("accounts.json")
}

fn electron_leveldb_dir() -> PathBuf {
    oss_data_dir().join("Local Storage").join("leveldb")
}

pub fn ensure_migrated() {
    let path = accounts_path();
    if path.is_file() {
        return;
    }
    if let Some(file) = import_from_electron_leveldb() {
        let _ = write_file(&file);
    }
}

fn write_file(file: &AccountsFile) -> Result<(), String> {
    let dir = oss_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(accounts_path(), json).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_file() -> AccountsFile {
    ensure_migrated();
    let path = accounts_path();
    if !path.is_file() {
        return AccountsFile {
            accounts: vec![],
            active_id: None,
        };
    }
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(AccountsFile {
            accounts: vec![],
            active_id: None,
        }),
        Err(_) => AccountsFile {
            accounts: vec![],
            active_id: None,
        },
    }
}

/// 从 Electron 的 Chromium Local Storage（LevelDB 文件）导入账号。
fn import_from_electron_leveldb() -> Option<AccountsFile> {
    let dir = electron_leveldb_dir();
    if !dir.is_dir() {
        return None;
    }

    let mut merged = Vec::new();
    let mut active_id: Option<String> = None;

    let entries = fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext != "log" && ext != "ldb" {
            continue;
        }
        let data = fs::read(&path).ok()?;
        if let Some(list) = extract_utf16_json_array(&data, "oss-desk:accounts") {
            if let Ok(parsed) = serde_json::from_value::<Vec<OssAccount>>(list) {
                merged = parsed;
            }
        }
        if active_id.is_none() {
            active_id = extract_active_id(&data, "oss-desk:active-id");
        }
    }

    if merged.is_empty() {
        return None;
    }

    if active_id.is_none() {
        active_id = merged.first().map(|a| a.id.clone());
    }

    Some(AccountsFile {
        accounts: merged,
        active_id,
    })
}

fn find_key(data: &[u8], key: &str) -> Option<usize> {
    data.windows(key.len())
        .position(|w| w == key.as_bytes())
}

/// Chromium 将 localStorage 值存为 UTF-16LE，账号列表为 JSON 数组。
fn extract_utf16_json_array(data: &[u8], key: &str) -> Option<serde_json::Value> {
    let start = find_key(data, key)?;
    let tail = &data[start + key.len()..];
    let rel = tail
        .windows(2)
        .position(|w| w == b"[\x00")?;
    let json_start = start + key.len() + rel;

    for end in (json_start + 4..data.len().min(json_start + 200_000)).step_by(2) {
        if end > data.len() {
            break;
        }
        let slice = &data[json_start..end];
        if slice.len() % 2 != 0 {
            continue;
        }
        let s = String::from_utf16(
            &slice
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
        .ok()?;
        let trimmed = s.trim();
        if !trimmed.ends_with(']') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if v.is_array() {
                return Some(v);
            }
        }
    }
    None
}

fn extract_active_id(data: &[u8], key: &str) -> Option<String> {
    let start = find_key(data, key)?;
    let rest = &data[start + key.len()..];
    if rest.len() < 4 {
        return None;
    }
    // Electron 导出格式：key 后 2 字节头 + ASCII id
    let ascii = &rest[2..];
    let mut end = 0usize;
    for (i, &b) in ascii.iter().enumerate() {
        if b.is_ascii_alphanumeric() || b == b'-' {
            end = i + 1;
        } else {
            break;
        }
    }
    if end < 8 {
        return None;
    }
    let id = String::from_utf8(ascii[..end].to_vec()).ok()?;
    if id.contains('-') {
        Some(id)
    } else {
        None
    }
}

#[tauri::command]
pub fn accounts_load() -> AccountsFile {
    read_file()
}

#[tauri::command]
pub fn accounts_save(file: AccountsFile) -> Result<(), String> {
    write_file(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_electron_leveldb_smoke() {
        let file = import_from_electron_leveldb();
        if electron_leveldb_dir().is_dir() {
            assert!(file.is_some(), "expected accounts from Electron leveldb");
            assert!(!file.unwrap().accounts.is_empty());
        }
    }
}
