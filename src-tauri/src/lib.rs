//! ULog Studio desktop shell: file access, save dialogs and signed auto-update from the
//! GitHub repository's Releases. All analysis runs in the web frontend.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// "owner/name" of the GitHub repository that publishes releases (set at build time).
const REPO: &str = env!("ULOG_UPDATE_REPO");
const KEYRING_SERVICE: &str = "ulog-studio";
const KEYRING_USER: &str = "github-token";

#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    error: Option<String>,
    repo: String,
    token_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettings {
    repo: String,
    has_stored_token: bool,
    token_source: Option<String>,
}

fn stored_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?.get_password().ok().filter(|t| !t.trim().is_empty())
}

/// Token lookup order: Windows Credential Manager (saved in the app) → environment → GitHub CLI.
fn github_token() -> Option<(String, String)> {
    if let Some(t) = stored_token() {
        return Some((t, "Windows Credential Manager".into()));
    }
    for v in ["ULOG_STUDIO_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(t) = std::env::var(v) {
            if !t.trim().is_empty() {
                return Some((t.trim().to_string(), format!("environment variable {v}")));
            }
        }
    }
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["auth", "token"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Ok(o) = cmd.output() {
        if o.status.success() {
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !t.is_empty() {
                return Some((t, "GitHub CLI (gh auth token)".into()));
            }
        }
    }
    None
}

/// Paths given on the command line (file association / "Open with").
#[tauri::command]
fn initial_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| {
            let l = a.to_lowercase();
            l.ends_with(".ulg") || l.ends_with(".params")
        })
        .collect()
}

#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Raw body = file content, header `x-path` = URI-encoded destination chosen in the save dialog.
#[tauri::command]
fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path")?;
    let path = urlencoding::decode(path).map_err(|e| e.to_string())?.into_owned();
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw body".into());
    };
    std::fs::write(&path, data).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn get_update_settings() -> UpdateSettings {
    UpdateSettings { repo: REPO.into(), has_stored_token: stored_token().is_some(), token_source: github_token().map(|t| t.1) }
}

#[tauri::command]
fn set_update_token(token: Option<String>) -> Result<(), String> {
    let e = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match token.filter(|t| !t.trim().is_empty()) {
        Some(t) => e.set_password(t.trim()).map_err(|e| e.to_string()),
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        },
    }
}

#[tauri::command]
async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<UpdateInfo, String> {
    let mut info = UpdateInfo { current: app.package_info().version.to_string(), repo: REPO.into(), ..Default::default() };
    // Public repository: no token needed. A token (if available) is still used: it raises the API rate limit
    // and makes a private fork work.
    let token = github_token();
    info.token_source = token.as_ref().map(|t| t.1.clone());
    let client = reqwest::Client::builder().user_agent("ulog-studio-updater").build().map_err(|e| e.to_string())?;
    let mut req = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some((t, _)) = &token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        info.error = Some(match resp.status().as_u16() {
            404 if token.is_none() => format!("{REPO} not reachable: no release yet, or the repository is private (sign in with gh auth login or save a token)."),
            404 => format!("No release found in {REPO}."),
            s => format!("GitHub returned {s} for {REPO}."),
        });
        return Ok(info);
    }
    let rel: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let Some(manifest) = rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == "latest.json")) else {
        info.error = Some("The latest release has no latest.json manifest".into());
        return Ok(info);
    };
    let url = manifest["url"].as_str().ok_or("asset without url")?.parse().map_err(|e: url::ParseError| e.to_string())?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Accept", "application/octet-stream")
        .map_err(|e| e.to_string())?;
    if let Some((t, _)) = &token {
        builder = builder.header("Authorization", format!("Bearer {t}")).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => {
            info.available = true;
            info.version = Some(u.version.clone());
            info.notes = u.body.clone();
            info.date = u.date.map(|d| d.to_string());
            *pending.0.lock().unwrap() = Some(u);
        }
        Ok(None) => {}
        Err(e) => info.error = Some(e.to_string()),
    }
    Ok(info)
}

/// Download (signature verified against the public key in tauri.conf.json), install and restart.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update pending: check first")?;
    let mut done: usize = 0;
    let app2 = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk;
                let _ = app2.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            initial_files,
            read_file,
            write_file,
            get_update_settings,
            set_update_token,
            check_update,
            install_update
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("ULog Studio {}", app.package_info().version));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ULog Studio");
}
