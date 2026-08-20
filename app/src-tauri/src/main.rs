#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::Emitter;

const SNAPSHOT_FILE_NAME: &str = "snapshot-v2.json";
const SNAPSHOT_CHANGED_EVENT: &str = "snapshot-changed";
/// One atomic publish surfaces as a burst of matching events on the target
/// (two rename, one create, one metadata, one content on macOS FSEvents)
/// delivered together; admit at most one per window so a publication emits
/// exactly one event. The window is measured on the monotonic clock — a
/// backward wall-clock correction must never stretch it into suppressing
/// genuine publications. 250ms is orders of magnitude above the observed
/// burst spread and well below the daemon's 2s minimum publish interval —
/// and the daemon's 5s heartbeat re-publishes the same content, so a
/// swallowed straggler self-heals.
const SNAPSHOT_COALESCE_WINDOW: Duration = Duration::from_millis(250);

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

/// The daemon's atomic rename never writes the target in place, but it also
/// never publishes under any other name: matching on the file name alone
/// admits every event of a publish burst while excluding its temporary
/// sibling (`.snapshot-v2.json-<pid>-<uuid>.tmp`) and unrelated files such
/// as `quota-snapshot.json` in the same directory.
fn event_touches_snapshot(event: &Event) -> bool {
    event
        .paths
        .iter()
        .any(|path| path.file_name().and_then(|name| name.to_str()) == Some(SNAPSHOT_FILE_NAME))
}

fn within_coalesce_window(elapsed_since_last_emit: Duration) -> bool {
    elapsed_since_last_emit < SNAPSHOT_COALESCE_WINDOW
}

fn read_snapshot_in(directory: &Path) -> Result<SnapshotPayload, String> {
    let path = directory.join(SNAPSHOT_FILE_NAME);
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

fn read_snapshot_payload() -> Result<SnapshotPayload, String> {
    read_snapshot_in(&app_support_root()?)
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

/// Watch the directory — not the file, because the daemon publishes by
/// atomic rename, which swaps the file's inode — and push every
/// snapshot-v2.json publication to the webview with the same payload shape
/// as `read_snapshot`. Each publication surfaces as a burst of matching
/// events; the coalescing window admits only the first successful emit, so
/// exactly one event per publication reaches the webview — and a sink that
/// fails does not burn the window: a later event of the same burst retries.
fn watch_snapshot_directory(
    directory: &Path,
    mut on_change: impl FnMut(SnapshotPayload) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let watched_directory = directory.to_path_buf();
    let mut last_emit: Option<Instant> = None;
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        if !event_touches_snapshot(&event) {
            return;
        }
        if last_emit.is_some_and(|last| within_coalesce_window(last.elapsed())) {
            return;
        }
        // Read fresh rather than trusting the event kind, and stamp the
        // window only after the sink returns Ok — a failed emit retries on a
        // later burst event, and a slow successful one pins the window to
        // emit time so queued burst events stay suppressed.
        if let Ok(payload) = read_snapshot_in(&watched_directory) {
            if on_change(payload).is_ok() {
                last_emit = Some(Instant::now());
            }
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    // Process-lifetime resource: dropping the watcher would stop delivery, so
    // it is deliberately leaked once the watch is live.
    std::mem::forget(watcher);
    Ok(())
}

fn watch_snapshot(app: &tauri::App) -> Result<(), String> {
    let directory = app_support_root()?;
    let handle = app.handle().clone();
    watch_snapshot_directory(&directory, move |payload| {
        handle
            .emit(SNAPSHOT_CHANGED_EVENT, payload)
            .map_err(|error| error.to_string())
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, EventKind};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    // macOS FSEvents replays recent pre-watch events (the directory's
    // creation, the seeded target write) right after the stream starts, so
    // a test's seed can emit spuriously. Every real-watcher test therefore
    // arms its sink only after the stream has settled: while disarmed the
    // sink refuses, and a refused sink neither sends nor stamps the
    // coalescing window (the stamp-on-success invariant under test).
    const STREAM_SETTLE_MS: u64 = 200;

    fn event_for(kind: EventKind, path: PathBuf) -> Event {
        Event {
            kind,
            paths: vec![path],
            attrs: Default::default(),
        }
    }

    #[test]
    fn event_filter_matches_only_the_target_file() {
        let create = |name: &str| {
            event_for(
                EventKind::Create(CreateKind::File),
                std::env::temp_dir().join(name),
            )
        };
        assert!(event_touches_snapshot(&create("snapshot-v2.json")));
        // Same directory, wrong file: the quota snapshot and the daemon's
        // temporary sibling never match.
        assert!(!event_touches_snapshot(&create("quota-snapshot.json")));
        assert!(!event_touches_snapshot(&create(".snapshot-v2.json-48158-uuid.tmp")));
        // Directory-level events carry no matching file name.
        assert!(!event_touches_snapshot(&event_for(
            EventKind::Create(CreateKind::Folder),
            std::env::temp_dir(),
        )));
    }

    #[test]
    fn coalesce_window_admits_one_event_per_burst() {
        // The gate consumes monotonic elapsed time only, so wall-clock
        // values — including a backward clock correction — cannot re-arm
        // suppression. A burst's events land far inside the window…
        assert!(within_coalesce_window(Duration::ZERO));
        assert!(within_coalesce_window(
            SNAPSHOT_COALESCE_WINDOW - Duration::from_millis(1)
        ));
        // …and the window boundary re-arms for the next publication.
        assert!(!within_coalesce_window(SNAPSHOT_COALESCE_WINDOW));
        assert!(!within_coalesce_window(SNAPSHOT_COALESCE_WINDOW * 10));
    }

    /// One daemon publication — temporary sibling written, then renamed over
    /// the target — against the real watcher: exactly one emitted payload,
    /// with the quota snapshot and temp-file churn excluded, and a later
    /// publication emitting again once the window has expired.
    #[test]
    fn one_publication_emits_exactly_one_event() {
        let directory = std::env::temp_dir().join(format!("agent-strip-watch-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(SNAPSHOT_FILE_NAME), r#"{"n":0}"#).unwrap();

        let (sender, receiver) = mpsc::channel();
        let armed = Arc::new(AtomicBool::new(false));
        let armed_flag = armed.clone();
        watch_snapshot_directory(&directory, move |payload| {
            if !armed_flag.load(Ordering::SeqCst) {
                return Err("disarmed: replayed pre-watch event".to_string());
            }
            let _ = sender.send(payload);
            Ok(())
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(STREAM_SETTLE_MS));
        armed.store(true, Ordering::SeqCst);

        // Neighboring-file noise first: a quota snapshot write must not emit.
        std::fs::write(directory.join("quota-snapshot.json"), "{}").unwrap();
        // Then the daemon's exact publish shape: temp sibling, rename over.
        let temp = directory.join(".snapshot-v2.json-48158-test.tmp");
        std::fs::write(&temp, r#"{"n":1}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();

        let mut payloads = Vec::new();
        while let Ok(payload) = receiver.recv_timeout(Duration::from_millis(600)) {
            payloads.push(payload);
        }
        assert_eq!(payloads.len(), 1, "one publication must emit exactly one event");
        assert_eq!(payloads[0].contents, r#"{"n":1}"#);

        // A publication after the window expires emits again.
        let temp = directory.join(".snapshot-v2.json-48158-test2.tmp");
        std::fs::write(&temp, r#"{"n":2}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();
        let second = receiver
            .recv_timeout(Duration::from_millis(600))
            .expect("second publication emits once the window expired");
        assert_eq!(second.contents, r#"{"n":2}"#);

        std::fs::remove_dir_all(&directory).ok();
    }

    /// A sink that fails must not burn the window: the stamp lands only on
    /// success, so a later event of the same publication burst (macOS
    /// FSEvents delivers several matching events per publish) retries the
    /// emit and the publication still delivers exactly once.
    #[test]
    fn failed_emit_retries_on_a_later_burst_event() {
        let directory = std::env::temp_dir().join(format!("agent-strip-retry-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(SNAPSHOT_FILE_NAME), r#"{"n":0}"#).unwrap();

        let (sender, receiver) = mpsc::channel();
        let armed = Arc::new(AtomicBool::new(false));
        let armed_flag = armed.clone();
        let mut calls = 0;
        watch_snapshot_directory(&directory, move |payload| {
            if !armed_flag.load(Ordering::SeqCst) {
                return Err("disarmed: replayed pre-watch event".to_string());
            }
            calls += 1;
            if calls == 1 {
                return Err("simulated emit failure".to_string());
            }
            let _ = sender.send(payload);
            Ok(())
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(STREAM_SETTLE_MS));
        armed.store(true, Ordering::SeqCst);

        let temp = directory.join(".snapshot-v2.json-48158-retry.tmp");
        std::fs::write(&temp, r#"{"n":1}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();

        let first = receiver
            .recv_timeout(Duration::from_millis(600))
            .expect("the burst retries after the first emit fails, so the publication delivers");
        assert_eq!(first.contents, r#"{"n":1}"#);
        assert!(
            receiver.recv_timeout(Duration::from_millis(50)).is_err(),
            "after the successful retry the window suppresses the burst's remaining events"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    /// A sink that succeeds only after outlasting the window must not re-arm
    /// the gate for the same burst's queued events: the stamp is taken when
    /// the sink returns Ok, not when its event arrived. Under a pre-call
    /// stamp this test double-emits.
    #[test]
    fn slow_successful_sink_does_not_double_emit() {
        let directory = std::env::temp_dir().join(format!("agent-strip-slow-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(SNAPSHOT_FILE_NAME), r#"{"n":0}"#).unwrap();

        let (sender, receiver) = mpsc::channel();
        let armed = Arc::new(AtomicBool::new(false));
        let armed_flag = armed.clone();
        let mut calls = 0;
        watch_snapshot_directory(&directory, move |payload| {
            if !armed_flag.load(Ordering::SeqCst) {
                return Err("disarmed: replayed pre-watch event".to_string());
            }
            calls += 1;
            if calls == 1 {
                // Outlast the coalescing window before reporting success.
                std::thread::sleep(SNAPSHOT_COALESCE_WINDOW * 2);
            }
            let _ = sender.send(payload);
            Ok(())
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(STREAM_SETTLE_MS));
        armed.store(true, Ordering::SeqCst);

        let temp = directory.join(".snapshot-v2.json-48158-slow.tmp");
        std::fs::write(&temp, r#"{"n":1}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();

        let mut payloads = Vec::new();
        while let Ok(payload) = receiver.recv_timeout(Duration::from_millis(600)) {
            payloads.push(payload);
        }
        assert_eq!(
            payloads.len(),
            1,
            "a slow successful sink must not let the same burst emit twice"
        );
        assert_eq!(payloads[0].contents, r#"{"n":1}"#);

        std::fs::remove_dir_all(&directory).ok();
    }
}
