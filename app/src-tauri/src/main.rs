#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::Emitter;

const SNAPSHOT_FILE_NAME: &str = "snapshot-v2.json";
const SNAPSHOT_CHANGED_EVENT: &str = "snapshot-changed";

#[derive(Serialize, Clone)]
struct SnapshotPayload {
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    contents: String,
}

fn app_support_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.drewritter.stream-deck-agents"))
}

fn read_snapshot_payload() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join(SNAPSHOT_FILE_NAME);
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    let mtime_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(SnapshotPayload { mtime_ms, contents })
}

#[tauri::command]
async fn read_snapshot() -> Result<SnapshotPayload, String> {
    read_snapshot_payload()
}

/// The quota snapshot lives next to the session snapshot but is owned by the
/// daemon's quota collector; a missing file simply means "no quota data yet"
/// and is reported as a fixed error string the frontend can branch on.
#[tauri::command]
async fn read_quota_snapshot() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join("quota-snapshot.json");
    let metadata = std::fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "quota_snapshot_missing".to_string()
        } else {
            error.to_string()
        }
    })?;
    let mtime_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(SnapshotPayload { mtime_ms, contents })
}

#[tauri::command]
async fn read_paseo_server_id() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    let path = PathBuf::from(home).join(".paseo/server-id");
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(contents.trim().to_string())
}

/// Blocking child-process wait inside async commands: acceptable at this
/// scale (a few short-lived processes per user gesture) and keeps the crate
/// dependency-light beyond tauri/serde/notify.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

/// The app's only write path back to the daemon, mirroring the plugin's
/// session-ack: the installed binary, fixed subcommand argv, no shell.
#[tauri::command]
async fn ack_session(provider: &str, session_id: &str) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/stream-deck-agents");
    let path = executable.to_string_lossy().to_string();
    run(&path, &["sessions", "ack", provider, session_id])
}

#[tauri::command]
async fn open_url(url: &str) -> Result<(), String> {
    run("/usr/bin/open", &["-u", url])
}

#[tauri::command]
async fn focus_ghostty(script: &str, terminal_id: &str) -> Result<(), String> {
    run("/usr/bin/osascript", &["-e", script, "--", terminal_id])
}

/// Watch the app-support directory — not the file, because the daemon
/// publishes by atomic rename, which swaps the file's inode — and push every
/// snapshot-v2.json change to the webview with the same payload shape as
/// `read_snapshot`.
fn watch_snapshot(app: &tauri::App) -> Result<(), String> {
    let directory = app_support_root()?;
    let handle = app.handle().clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        let touches_snapshot = event
            .paths
            .iter()
            .any(|path| path.file_name().and_then(|name| name.to_str()) == Some(SNAPSHOT_FILE_NAME));
        if !touches_snapshot {
            return;
        }
        // Read fresh rather than trusting the event: a burst of events for one
        // publish collapses into identical payloads, which the webview skips.
        if let Ok(payload) = read_snapshot_payload() {
            let _ = handle.emit(SNAPSHOT_CHANGED_EVENT, payload);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    // Process-lifetime resource: dropping the watcher would stop delivery, so
    // it is deliberately leaked once the watch is live.
    std::mem::forget(watcher);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            // A failed watch (for example the app-support directory does not
            // exist yet) must not sink the app: the webview's 10s staleness
            // reads are the fallback until an event stream exists.
            let _ = watch_snapshot(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_snapshot,
            read_quota_snapshot,
            read_paseo_server_id,
            ack_session,
            open_url,
            focus_ghostty
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-strip");
}
