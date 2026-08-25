#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemBuilder, MenuItemKind};
use tauri::menu::Menu;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const SNAPSHOT_FILE_NAME: &str = "snapshot-v2.json";
const SNAPSHOT_CHANGED_EVENT: &str = "snapshot-changed";
const TOGGLE_FULLSCREEN_MENU_ID: &str = "toggle-fullscreen";

/// One publication's file identity: the inode and nanosecond mtime of the
/// same open file the contents were read from. The daemon publishes by
/// atomic rename, so every publication is a fresh inode; even an in-place
/// rewrite would move the nanosecond mtime. Two matching events therefore
/// belong to the same publication exactly when they read the same
/// generation — and to no fixed time window at all: the daemon's 250ms
/// poll can publish external database commits back to back, so a window
/// could swallow a distinct publication's whole burst, delaying the final
/// state until an unrelated later event or the heartbeat.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct FileGeneration {
    inode: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
}

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

fn read_snapshot_in(directory: &Path) -> Result<(SnapshotPayload, FileGeneration), String> {
    let path = directory.join(SNAPSHOT_FILE_NAME);
    // Open once and read everything from the same handle: the fstat
    // identity and the contents always describe one file, never a
    // publication that swapped in between a stat and a read.
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let system_time = metadata.modified().map_err(|error| error.to_string())?;
    let mtime_ms = system_time
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let generation = FileGeneration {
        inode: metadata.ino(),
        mtime_sec: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
    };
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|error| error.to_string())?;
    Ok((SnapshotPayload { mtime_ms, contents }, generation))
}

fn read_snapshot_payload() -> Result<SnapshotPayload, String> {
    read_snapshot_in(&app_support_root()?).map(|(payload, _generation)| payload)
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

/// The token-usage snapshot lives next to the session snapshot but is owned by
/// the daemon's token-usage collector; a missing file simply means "no token
/// data yet" and is reported as a fixed error string the frontend can branch on.
#[tauri::command]
async fn read_token_usage_snapshot() -> Result<SnapshotPayload, String> {
    let path = app_support_root()?.join("token-usage-snapshot.json");
    let metadata = std::fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "token_usage_snapshot_missing".to_string()
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

/// Reveal a session transcript in Finder: `/usr/bin/open -R <path>`, fixed
/// argv, no shell. The path comes from the daemon's own snapshot field.
#[tauri::command]
async fn reveal_transcript(path: &str) -> Result<(), String> {
    run("/usr/bin/open", &["-R", path])
}

/// Destructive session delete via the installed binary, mirroring
/// `ack_session`'s fixed-argv invocation (`sessions clear <provider> <id>`,
/// validated in src/core/cli.ts). The webview gates this behind a confirm.
#[tauri::command]
async fn clear_session(provider: &str, session_id: &str) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/stream-deck-agents");
    let path = executable.to_string_lossy().to_string();
    run(&path, &["sessions", "clear", provider, session_id])
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
/// events; coalescing is by file generation, so exactly one event per
/// publication reaches the webview no matter how closely publications
/// follow, while repeated events for the last successfully emitted
/// generation stay suppressed. A sink that fails does not stamp the
/// generation: a later event of the same burst retries.
fn watch_snapshot_directory(
    directory: &Path,
    mut on_change: impl FnMut(SnapshotPayload) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let watched_directory = directory.to_path_buf();
    let mut last_emit: Option<FileGeneration> = None;
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        if !event_touches_snapshot(&event) {
            return;
        }
        // Read fresh rather than trusting the event kind: the identity and
        // the contents come from one open file, and the generation is
        // compared against the last emitted one — only repeats of it are
        // suppressed. The generation is stamped after the sink returns Ok,
        // so a failed emit retries on a later burst event.
        let Ok((payload, generation)) = read_snapshot_in(&watched_directory) else {
            return;
        };
        if last_emit == Some(generation) {
            return;
        }
        if on_change(payload).is_ok() {
            last_emit = Some(generation);
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

/// Preserve Tauri's standard macOS menu while replacing its predefined
/// fullscreen item. The predefined item calls Cocoa's `toggleFullScreen:`
/// selector directly, which is a no-op for borderless windows; a normal item
/// lets the event handler use Tauri's programmatic path instead.
fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    {
        let view = menu
            .items()?
            .into_iter()
            .find_map(|item| match item {
                MenuItemKind::Submenu(submenu) if matches!(submenu.text().as_deref(), Ok("View")) => {
                    Some(submenu)
                }
                _ => None,
            })
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "default menu has no View submenu",
                )
            })?;
        let view_items = view.items()?;
        if view_items.len() != 1 || !matches!(view_items[0], MenuItemKind::Predefined(_)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "default View menu has an unexpected shape",
            )
            .into());
        }

        let fullscreen = MenuItemBuilder::with_id(TOGGLE_FULLSCREEN_MENU_ID, "Toggle Full Screen")
            .accelerator("Cmd+Ctrl+F")
            .build(app)?;
        view.remove(&view_items[0])?;
        view.append(&fullscreen)?;
    }
    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id() != TOGGLE_FULLSCREEN_MENU_ID {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let Ok(is_fullscreen) = window.is_fullscreen() else {
                return;
            };
            let _ = window.set_fullscreen(!is_fullscreen);
        })
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
            read_token_usage_snapshot,
            read_paseo_server_id,
            ack_session,
            reveal_transcript,
            clear_session,
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
    // coalescing stamp (the stamp-on-success invariant under test).
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
    fn generation_identity_tracks_publications() {
        let directory =
            std::env::temp_dir().join(format!("agent-strip-generation-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(SNAPSHOT_FILE_NAME), r#"{"n":0}"#).unwrap();

        // The same unchanged file reads as the same generation, twice.
        let (first_payload, first) = read_snapshot_in(&directory).unwrap();
        let (second_payload, second) = read_snapshot_in(&directory).unwrap();
        assert_eq!(first, second);
        assert_eq!(first_payload.contents, second_payload.contents);

        // A new publication (temp sibling renamed over the target) is a
        // distinct generation even though the path is unchanged: the temp
        // file's inode is freshly allocated while the old target still
        // exists, so the inode necessarily differs.
        let temp = directory.join(".snapshot-v2.json-48158-generation.tmp");
        std::fs::write(&temp, r#"{"n":1}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();
        let (_, third) = read_snapshot_in(&directory).unwrap();
        assert_ne!(first, third);

        std::fs::remove_dir_all(&directory).ok();
    }

    /// One daemon publication — temporary sibling written, then renamed over
    /// the target — against the real watcher: exactly one emitted payload,
    /// with the quota snapshot and temp-file churn excluded, and a later
    /// publication emitting again as its own generation.
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

        // A later publication emits again: a distinct generation is never
        // suppressed, no matter how soon it follows.
        let temp = directory.join(".snapshot-v2.json-48158-test2.tmp");
        std::fs::write(&temp, r#"{"n":2}"#).unwrap();
        std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();
        let second = receiver
            .recv_timeout(Duration::from_millis(600))
            .expect("a second publication emits as its own generation");
        assert_eq!(second.contents, r#"{"n":2}"#);

        std::fs::remove_dir_all(&directory).ok();
    }

    /// The daemon's poll loop can publish on an external database commit
    /// every 250ms, so a genuine publication can follow the previous one well
    /// inside any fixed coalescing window. The second publication here lands
    /// immediately after the first payload was received — inside the 250ms
    /// window a time-based gate would still hold — yet must still emit, or
    /// the final state never arrives until an unrelated later event.
    #[test]
    fn two_distinct_publications_inside_the_coalesce_window_both_emit() {
        let directory =
            std::env::temp_dir().join(format!("agent-strip-two-{}", std::process::id()));
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

        let publish = |contents: &str, suffix: &str| {
            let temp = directory.join(format!(".snapshot-v2.json-48158-{suffix}.tmp"));
            std::fs::write(&temp, contents).unwrap();
            std::fs::rename(&temp, directory.join(SNAPSHOT_FILE_NAME)).unwrap();
        };

        publish(r#"{"n":1}"#, "a");
        let first = receiver
            .recv_timeout(Duration::from_millis(600))
            .expect("the first publication emits");
        assert_eq!(first.contents, r#"{"n":1}"#);

        // Distinct generation, issued the instant the first payload landed
        // — inside the 250ms window the old time gate burned on emit.
        publish(r#"{"n":2}"#, "b");
        let second = receiver
            .recv_timeout(Duration::from_millis(600))
            .expect("a distinct generation inside the window must still emit");
        assert_eq!(second.contents, r#"{"n":2}"#);

        // The second publication's burst still coalesces to that one event.
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());

        std::fs::remove_dir_all(&directory).ok();
    }

    /// A sink that fails must not stamp the generation: the stamp lands only
    /// on success, so a later event of the same publication burst (macOS
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
            "after the successful retry the emitted generation suppresses the burst's remaining events"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    /// A sink that succeeds only after a long delay must not let the same
    /// burst emit twice: the generation is stamped when the sink returns Ok,
    /// and the burst's later events re-read the same (unchanged) file, so
    /// the emitted generation still suppresses them regardless of timing.
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
                // Outlast far beyond any plausible burst spread before
                // reporting success.
                std::thread::sleep(Duration::from_millis(500));
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
