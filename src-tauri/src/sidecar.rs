use std::path::{Path, PathBuf};

use std::process::{Child, Command, Stdio};

#[cfg(windows)]

use std::os::windows::process::CommandExt;

use std::sync::Mutex;

use std::time::Duration;

use tauri::{AppHandle, Manager};



static OSS_CHILD: Mutex<Option<Child>> = Mutex::new(None);



#[cfg(windows)]

const CREATE_NO_WINDOW: u32 = 0x08000000;



pub fn spawn_oss_api(app: &AppHandle) -> Result<(), String> {

    if let Ok(resource_dir) = app.path().resource_dir() {
        for api_dir in [
            resource_dir.join("oss-api"),
            resource_dir.join("resources").join("oss-api"),
        ] {
            let node = api_dir.join("node.exe");
            let script = api_dir.join("server.cjs");
            if node.is_file() && script.is_file() {
                return spawn_node_process(&node, &script);
            }
        }
    }



    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    let script = manifest.join("../oss-server/dist/server.cjs");

    if !script.is_file() {

        return Err("OSS API not built: run npm run build:api from project root.".into());

    }



    let node = which_node()?;

    spawn_node_process(&node, &script)

}



fn which_node() -> Result<PathBuf, String> {

    let node = Command::new("where")

        .arg("node")

        .output()

        .ok()

        .and_then(|o| {

            if o.status.success() {

                String::from_utf8(o.stdout)

                    .ok()

                    .and_then(|s| s.lines().next().map(|l| PathBuf::from(l.trim())))

            } else {

                None

            }

        });

    node.filter(|p| p.is_file())

        .ok_or_else(|| "Node.js not found on PATH (required for dev).".into())

}



fn spawn_node_process(node: &Path, script: &Path) -> Result<(), String> {

    let mut cmd = Command::new(node);

    cmd.arg(script)

        .env("PORT", "3088")

        .stdout(Stdio::null())

        .stderr(Stdio::null());

    #[cfg(windows)]

    cmd.creation_flags(CREATE_NO_WINDOW);



    let child = cmd

        .spawn()

        .map_err(|e| format!("Failed to start OSS API: {}", e))?;

    if let Ok(mut guard) = OSS_CHILD.lock() {

        *guard = Some(child);

    }

    wait_health()

}



fn wait_health() -> Result<(), String> {

    let client = reqwest::blocking::Client::builder()

        .timeout(Duration::from_secs(2))

        .build()

        .map_err(|e| e.to_string())?;

    for _ in 0..40 {

        if let Ok(res) = client.get("http://127.0.0.1:3088/api/health").send() {

            if res.status().is_success() {

                return Ok(());

            }

        }

        std::thread::sleep(Duration::from_millis(250));

    }

    Err("OSS API health check timed out.".into())

}



pub fn stop_oss_api() {

    if let Ok(mut guard) = OSS_CHILD.lock() {

        if let Some(mut child) = guard.take() {

            let _ = child.kill();

        }

    }

}


