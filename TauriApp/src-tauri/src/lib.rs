use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

static CALL_COUNTER: AtomicU64 = AtomicU64::new(0);
static TERM_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Dedicated emacsclient socket for this app so we never collide with the
/// user's interactive Emacs (e.g. a running Doom session on the default
/// "server" socket). `--socket-name=org-gui` connects to a daemon named
/// "org-gui".
const SOCKET_NAME: &str = "org-gui";

/// The macOS native per-user temp dir (from `confstr(_CS_DARWIN_USER_TEMP_DIR)`,
/// exposed via `getconf DARWIN_USER_TEMP_DIR`). On macOS the Emacs *server*
/// creates its socket under THIS directory (`<dir>/emacs<uid>/org-gui`),
/// while `emacsclient` with a bare `--socket-name` resolves the directory
/// from `$TMPDIR` — and those two can differ (e.g. a sandboxed or login-shell
/// `$TMPDIR` vs the launchd value). When they disagree, emacsclient reports
/// "can't find socket" even though the daemon is alive and bound. Cached
/// because it's immutable per machine and we don't want to spawn `getconf`
/// on every probe.
fn darwin_user_temp_dir() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            std::process::Command::new("getconf")
                .arg("DARWIN_USER_TEMP_DIR")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .clone()
}

/// Every directory the Emacs server might have placed its socket-containing
/// `emacs<uid>` subdir under. Ordered most- to least-authoritative.
fn candidate_socket_parents() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(d) = darwin_user_temp_dir() {
        v.push(PathBuf::from(d));
    }
    if let Ok(t) = std::env::var("TMPDIR") {
        if !t.is_empty() {
            v.push(PathBuf::from(t));
        }
    }
    if let Ok(x) = std::env::var("XDG_RUNTIME_DIR") {
        if !x.is_empty() {
            v.push(PathBuf::from(x));
        }
    }
    v.push(PathBuf::from("/tmp"));
    v
}

/// Find the absolute path of the org-gui server socket if it exists, by
/// scanning every candidate parent for an `emacs*` subdir containing a
/// file named `org-gui`. Returns None when no socket exists yet (e.g. right
/// before the first daemon spawn).
fn resolve_socket_path() -> Option<PathBuf> {
    for parent in candidate_socket_parents() {
        if let Ok(entries) = std::fs::read_dir(&parent) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name == "emacs" || name.starts_with("emacs") {
                        let sock = entry.path().join(SOCKET_NAME);
                        if sock.exists() {
                            return Some(sock);
                        }
                    }
                }
            }
        }
    }
    None
}

/// The value to pass to `emacsclient --socket-name`. Prefers the resolved
/// ABSOLUTE socket path (which bypasses emacsclient's own directory
/// guessing and so always agrees with the server), falling back to the bare
/// name when no socket exists yet.
fn socket_name_arg() -> String {
    resolve_socket_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| SOCKET_NAME.to_string())
}

/// A live embedded-Emacs terminal session (emacsclient -t running in a PTY).
struct TermSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Terminals(Mutex<HashMap<u64, TermSession>>);

#[derive(serde::Serialize, Clone)]
struct TermData {
    id: u64,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(serde::Serialize, Clone)]
struct PrereqStatus {
    platform: String,
    emacs_installed: bool,
    emacsclient_path: Option<String>,
    homebrew_installed: bool,
    doom_dir: Option<String>,
    doom_installed: bool,
    can_auto_install: bool,
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| String::from("/"))
}

/// Look up an executable on $PATH (returns the absolute path if found).
fn find_in_path(bin: &str) -> Option<String> {
    let path = std::env::var("PATH").ok()?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path.split(sep) {
        if dir.is_empty() { continue; }
        let p = std::path::Path::new(dir).join(bin);
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// Detect Doom Emacs install location (XDG first, then legacy ~/.emacs.d).
fn detect_doom_dir() -> Option<String> {
    let h = home_dir();
    for c in [format!("{h}/.config/emacs"), format!("{h}/.emacs.d")] {
        if std::path::Path::new(&format!("{c}/bin/doom")).exists() {
            return Some(c);
        }
    }
    None
}

/// Whether Doom is actually *installed*, not merely cloned. A bare clone has
/// `bin/doom` but no package store yet; `doom install` populates `.local/straight`.
/// Gating on that lets a previously-failed install be retried instead of being
/// reported as "done".
fn doom_is_installed(doom_dir: &Option<String>) -> bool {
    match doom_dir {
        Some(d) => std::path::Path::new(&format!("{d}/.local/straight")).exists(),
        None => false,
    }
}

/// Detection state for the Setup modal: which prerequisites are present on
/// this machine and whether the in-app installer can handle this platform.
#[tauri::command]
fn check_prereqs() -> PrereqStatus {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
    .to_string();

    let emacsclient = find_in_path("emacsclient").or_else(|| {
        ["/opt/homebrew/bin/emacsclient",
         "/usr/local/bin/emacsclient",
         "/usr/bin/emacsclient",
         "/Applications/Emacs.app/Contents/MacOS/bin/emacsclient"]
            .into_iter()
            .find(|c| std::path::Path::new(c).exists())
            .map(|s| s.to_string())
    });
    let emacs_installed = emacsclient.is_some() || find_in_path("emacs").is_some();

    let homebrew_installed = std::path::Path::new("/opt/homebrew/bin/brew").exists()
        || std::path::Path::new("/usr/local/bin/brew").exists();

    let doom_dir = detect_doom_dir();
    let doom_installed = doom_is_installed(&doom_dir);

    let can_auto_install = matches!(platform.as_str(), "macos" | "linux");

    PrereqStatus {
        platform,
        emacs_installed,
        emacsclient_path: emacsclient,
        homebrew_installed,
        doom_dir,
        doom_installed,
        can_auto_install,
    }
}

const INSTALL_SCRIPT_MACOS: &str = include_str!("../scripts/install-prereqs-macos.sh");
const INSTALL_SCRIPT_LINUX: &str = include_str!("../scripts/install-prereqs-linux.sh");

/// One-click installer: writes the platform script to a temp file, runs it,
/// and streams each output line to the frontend as an `install://log` event.
/// Emits `install://done` on success, `install://error` on failure.
#[tauri::command]
async fn install_prereqs(app: tauri::AppHandle) -> Result<String, String> {
    let script = if cfg!(target_os = "macos") {
        INSTALL_SCRIPT_MACOS
    } else if cfg!(target_os = "linux") {
        INSTALL_SCRIPT_LINUX
    } else {
        return Err("Automatic install isn't supported on this platform yet. Please install Emacs (and optionally Doom Emacs) manually.".to_string());
    };

    let tmp = std::env::temp_dir().join("orggui-install-prereqs.sh");
    std::fs::write(&tmp, script).map_err(|e| format!("Could not write installer script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(&tmp, perms);
    }

    let app_clone = app.clone();
    let tmp_for_blk = tmp.clone();
    let result: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("/bin/bash")
            .arg(&tmp_for_blk)
            // Make sure the script's PATH includes Homebrew even before brew
            // is in the user's shell rc files.
            .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}",
                std::env::var("PATH").unwrap_or_default()))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start installer: {e}"))?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let app_out = app_clone.clone();
        let app_err = app_clone.clone();
        let t_out = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app_out.emit("install://log", line);
            }
        });
        let t_err = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app_err.emit("install://log", format!("⚠ {line}"));
            }
        });
        let status = child.wait().map_err(|e| format!("wait failed: {e}"))?;
        let _ = t_out.join();
        let _ = t_err.join();

        if status.success() {
            let _ = app_clone.emit::<()>("install://done", ());
            Ok("ok".to_string())
        } else {
            let msg = format!("Installer exited with status {status}");
            let _ = app_clone.emit("install://error", msg.clone());
            Err(msg)
        }
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    result
}

/// Resolve the `emacsclient` executable. macOS GUI apps inherit a minimal
/// PATH, so we probe common absolute locations before falling back to the
/// bare name (which relies on PATH). An explicit override via the
/// ORG_GUI_EMACSCLIENT env var always wins.
fn emacsclient_bin() -> String {
    if let Ok(p) = std::env::var("ORG_GUI_EMACSCLIENT") {
        if !p.is_empty() {
            return p;
        }
    }
    let candidates = [
        "/opt/homebrew/bin/emacsclient",
        "/usr/local/bin/emacsclient",
        "/usr/bin/emacsclient",
        "/Applications/Emacs.app/Contents/MacOS/bin/emacsclient",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "emacsclient".to_string()
}

/// Resolve the matching `emacs` executable. Tries an env override first, then
/// derives the path from emacsclient_bin (sibling binary), then probes the
/// usual locations.
fn emacs_bin() -> String {
    if let Ok(p) = std::env::var("ORG_GUI_EMACS") {
        if !p.is_empty() {
            return p;
        }
    }
    let client = emacsclient_bin();
    // Most installations ship emacs alongside emacsclient — just swap the file name.
    let sibling = client.replace("/emacsclient", "/emacs");
    if std::path::Path::new(&sibling).exists() {
        return sibling;
    }
    let candidates = [
        "/opt/homebrew/bin/emacs",
        "/usr/local/bin/emacs",
        "/usr/bin/emacs",
        "/Applications/Emacs.app/Contents/MacOS/Emacs",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "emacs".to_string()
}

/// Cheap probe: does the named daemon answer a no-op eval?
/// Probe the daemon with a hard timeout so a slow-to-respond server
/// (e.g. Doom mid-startup) doesn't make us think it's dead. Spawns
/// emacsclient, polls try_wait every 100 ms, and kills the child if the
/// deadline expires. Returns true only on a clean success status.
fn probe_daemon_timeout(client: &str, timeout_secs: u64) -> bool {
    let mut child = match std::process::Command::new(client)
        .arg(format!("--socket-name={}", socket_name_arg()))
        .arg("--eval")
        .arg("t")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return false,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// Poll for the daemon to bind, with per-attempt timeout so a long-running
/// daemon startup doesn't make the entire poll loop hang on a single probe.
fn wait_for_daemon_with_timeout(client: &str, total_secs: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(total_secs);
    while std::time::Instant::now() < deadline {
        if probe_daemon_timeout(client, 3) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    false
}

/// Does ANY emacs --daemon=org-gui process currently exist on the system?
/// pgrep returns 0 (exit-success) iff at least one match was found.
fn daemon_process_alive() -> bool {
    std::process::Command::new("pgrep")
        .arg("-f")
        .arg(format!("emacs.*--daemon={SOCKET_NAME}"))
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

// Concurrency lock around ensure_daemon: rapid bridge calls (drag, arrow-key
// nudge) used to race here and each tried to spawn its own daemon, producing
// "Unable to start daemon: server already running" once Doom's 19 s startup
// began. With a global Mutex, only one thread at a time inspects/spawns; the
// others wait, re-probe under the lock, and find the daemon already healthy.
static DAEMON_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
// Wall-clock seconds of the last successful probe. Subsequent ensure_daemon
// calls within `DAEMON_PROBE_CACHE_SECS` skip the probe entirely so a hot
// stream of bridge calls doesn't spawn an emacsclient round-trip for every
// keystroke.
static DAEMON_LAST_OK_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const DAEMON_PROBE_CACHE_SECS: u64 = 10;

/// Recognise the family of emacsclient error messages that mean "the socket is
/// stale / the daemon went away". Trigger our one-shot recovery (clear the
/// cache, force ensure_daemon, retry the call) when we see one — so a daemon
/// that died inside the 10 s probe-cache window doesn't surface as a hard
/// error to the user.
fn looks_like_stale_socket(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("connection refused")
        || m.contains("can't connect to")
        || m.contains("cant connect to")
        || m.contains("can't find socket")
        || m.contains("cant find socket")
        || m.contains("error accessing socket")
        || m.contains("no such file or directory")
}

/// Make sure an `org-gui` Emacs daemon is running. The fast path is a single
/// noop probe (cached for 10 s). When the probe fails we DON'T immediately
/// assume the daemon is gone — we pgrep for an `emacs --daemon=org-gui`
/// process first. If one exists, the daemon is mid-startup (Doom can take
/// 20 s); just wait for it. Only when no daemon process exists do we clean
/// stale sockets and spawn a fresh server. Two spawn fallbacks: user init
/// first; `emacs -q` if user init fails or hangs.
fn ensure_daemon(client: &str) -> Result<(), String> {
    let _guard = DAEMON_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_ok = DAEMON_LAST_OK_SECS.load(Ordering::Relaxed);
    if now_secs.saturating_sub(last_ok) < DAEMON_PROBE_CACHE_SECS {
        return Ok(());
    }

    // Quick probe with a 2 s ceiling — enough to ride out a brief stall but
    // not enough to make the user wait if the daemon really is dead.
    if probe_daemon_timeout(client, 2) {
        DAEMON_LAST_OK_SECS.store(now_secs, Ordering::Relaxed);
        return Ok(());
    }

    // Probe failed. Maybe the daemon process is alive but mid-startup
    // (Doom takes ~19 s). Don't spawn a duplicate — wait for the existing
    // process to become responsive.
    if daemon_process_alive() {
        if wait_for_daemon_with_timeout(client, 60) {
            DAEMON_LAST_OK_SECS.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                Ordering::Relaxed,
            );
            return Ok(());
        }
        return Err(format!(
            "An org-gui Emacs daemon is running but didn't respond within 60 s.\n\nIf this persists, click ↻ Daemon in the toolbar to reset it.",
        ));
    }

    // No daemon process. Clean orphan socket files so a fresh daemon can
    // claim the name without colliding.
    let parents: Vec<std::path::PathBuf> = [
        std::env::var("XDG_RUNTIME_DIR").ok(),
        std::env::var("TMPDIR").ok(),
        Some("/tmp".to_string()),
    ]
    .into_iter()
    .flatten()
    .map(std::path::PathBuf::from)
    .collect();
    for parent in &parents {
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name == "emacs" || name.starts_with("emacs") {
                        let sock = entry.path().join(SOCKET_NAME);
                        if sock.exists() {
                            let _ = std::fs::remove_file(&sock);
                        }
                    }
                }
            }
        }
    }

    let emacs = emacs_bin();
    // Attempt 1: spawn daemon with the user's normal init. The Emacs parent
    // exits quickly after forking the daemon (status 0), so output()
    // returning success only tells us the fork happened — not that the
    // daemon is bound and ready. Wait for it to bind.
    let out_full = std::process::Command::new(&emacs)
        .arg(format!("--daemon={SOCKET_NAME}"))
        .output();
    if let Ok(out) = &out_full {
        if out.status.success() && wait_for_daemon_with_timeout(client, 90) {
            DAEMON_LAST_OK_SECS.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                Ordering::Relaxed,
            );
            return Ok(());
        }
    }

    // Attempt 1 didn't bind in 90 s. Before racing it with a `-q` spawn —
    // which would crash with "server already running" if the original is
    // still booting — check whether the Doom daemon process is actually
    // still alive. Cold-boot Doom can take several minutes to byte-compile
    // packages on first run; if it's still chugging, we keep waiting
    // rather than trying to outrun it.
    if daemon_process_alive() {
        if wait_for_daemon_with_timeout(client, 180) {
            DAEMON_LAST_OK_SECS.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                Ordering::Relaxed,
            );
            return Ok(());
        }
        // Process exists but still didn't bind after 4.5 min total. Don't
        // spawn -q — it would just collide. Surface a helpful error.
        let full_err = out_full
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
            .unwrap_or_default();
        return Err(format!(
            "Emacs daemon process is running but hasn't bound the org-gui socket after 4.5 min. \
             Your init may be hung. Try `pkill -f 'emacs.*--daemon=org-gui'` then click ↻ Daemon \
             to restart with a minimal Emacs.{}",
            if full_err.is_empty() {
                String::new()
            } else {
                format!("\n\nEmacs stderr from initial spawn:\n{full_err}")
            }
        ));
    }

    // Attempt 2: no daemon process alive — Attempt 1 must have crashed
    // (broken init.el, missing package, etc.). Try a minimal `-q` daemon
    // so the bridge can still operate.
    let out_min = std::process::Command::new(&emacs)
        .arg("-q")
        .arg(format!("--daemon={SOCKET_NAME}"))
        .output();
    if let Ok(out) = &out_min {
        if out.status.success() && wait_for_daemon_with_timeout(client, 30) {
            DAEMON_LAST_OK_SECS.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                Ordering::Relaxed,
            );
            return Ok(());
        }
    }

    // Both failed — bubble up the most informative stderr we captured.
    let full_err = out_full
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
        .unwrap_or_else(|e| format!("could not exec {emacs}: {e}"));
    let min_err = out_min
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
        .unwrap_or_else(|e| format!("could not exec {emacs} -q: {e}"));
    let msg = if !full_err.is_empty() {
        full_err
    } else if !min_err.is_empty() {
        min_err
    } else {
        "Emacs daemon spawned but never bound the org-gui socket within 60 s.".to_string()
    };
    Err(format!(
        "Could not start the org-gui Emacs daemon.\n\n\
         Emacs reported:\n{msg}\n\n\
         Try `{emacs} --daemon={SOCKET_NAME}` in a terminal to reproduce \
         the error directly. If your init file errors out you'll see it there.",
    ))
}

/// Escape a Rust string into an Emacs Lisp string literal body (the part
/// between the surrounding quotes). Only backslash and double-quote need
/// escaping for a valid elisp string.
fn elisp_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn bridge_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Production: the bundled resource. Dev: `tauri dev` runs with CWD at
    // src-tauri/, so fall back to the source tree if the resource isn't
    // staged into the dev target dir yet.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("resources/org-gui-bridge.el", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    candidates.push(PathBuf::from("resources/org-gui-bridge.el"));
    candidates.push(PathBuf::from("src-tauri/resources/org-gui-bridge.el"));

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "Could not locate org-gui-bridge.el".to_string())
}

/// A token that identifies the exact bridge file we want the daemon to have
/// loaded. It is a content hash of the file (app-version-prefixed for readable
/// logs), so it changes iff the bridge's CONTENTS change — immune to
/// mtime-preserving installers, and it forces a reload exactly when (and only
/// when) the bridge actually differs.
///
/// The daemon remembers the last token it loaded in `org-gui-bridge--loaded-token`.
/// Because Rust BOTH writes that variable (right after `load-file`) AND compares
/// against it, a reload-on-every-call storm is structurally impossible — unlike
/// the previous design, which compared a hand-maintained `org-gui-bridge-version`
/// defconst (frozen at 0.2.117) against `CARGO_PKG_VERSION`, so any version bump
/// made the equality permanently false and re-`load`ed the 1900-line bridge on
/// every single call, freezing the single-threaded daemon (and the embedded
/// editor's keystrokes) each time.
fn bridge_load_token(bridge: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    match std::fs::read(bridge) {
        Ok(bytes) => {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            format!("{}-{:x}", env!("CARGO_PKG_VERSION"), h.finish())
        }
        // File unreadable (shouldn't happen — we just resolved it): fall back to
        // the build version. Still Rust-set-and-compared, so still no storm.
        Err(_) => env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Call a bridge function in the user's running Emacs and return its JSON.
///
/// `func` must name an `org-gui-*` function. The bridge writes its JSON
/// result to a temp file (sidestepping emacsclient's prin1 escaping), which
/// we then read and delete. Returns the JSON string verbatim.
#[tauri::command]
async fn org_call(
    app: tauri::AppHandle,
    func: String,
    args: Vec<String>,
    // Optional per-call wall-clock ceiling (seconds). Defaults to 30. Long-
    // running bridge ops (e.g. a Google Calendar sync that waits on the
    // OAuth browser consent) pass a larger value.
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    // Whitelist: only our own namespaced functions, no arbitrary elisp.
    let valid = func.starts_with("org-gui-")
        && func
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("Refused to call non-bridge function: {func}"));
    }

    let bridge = bridge_path(&app)?;
    if !bridge.exists() {
        return Err(format!("Bridge file not found at {}", bridge.display()));
    }

    let n = CALL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("orggui-{}-{}.json", std::process::id(), n));

    let arg_lits: Vec<String> = args.iter().map(|a| elisp_string(a)).collect();
    // Load the bundled bridge ONLY when the running daemon doesn't already have
    // THIS bridge (matched by content token). The `setq` runs after `load-file`
    // inside the same `unless`, so once loaded, every later call's `equal` is
    // true and we skip the reload — no more "Loading bridge.el…done" on every
    // invocation freezing the daemon. See `bridge_load_token`.
    let token = bridge_load_token(&bridge);
    let elisp = format!(
        "(progn (unless (and (featurep 'org-gui-bridge) \
            (equal (bound-and-true-p org-gui-bridge--loaded-token) {token})) \
          (load-file {path}) \
          (setq org-gui-bridge--loaded-token {token})) \
        (org-gui-call {tmp} #'{func} {args}))",
        token = elisp_string(&token),
        path = elisp_string(&bridge.to_string_lossy()),
        tmp = elisp_string(&tmp.to_string_lossy()),
        func = func,
        args = arg_lits.join(" "),
    );

    let bin = emacsclient_bin();
    let tmp_for_blk = tmp.clone();
    let call_timeout = timeout_secs.unwrap_or(30);
    let result = tauri::async_runtime::spawn_blocking(move || {
        // One attempt = ensure_daemon → emacsclient --eval → read temp file.
        // Returns Err with a stale-socket-shaped message when we want the
        // caller to invalidate the probe cache and retry once.
        let attempt = || -> Result<String, String> {
            // Guarantee the named daemon is alive BEFORE running emacsclient. We
            // used to rely on `emacsclient -a ""` to autospawn, but that path
            // swallows Emacs's stderr and surfaces only the generic "Could not
            // start the Emacs daemon" message; ensure_daemon spawns explicitly
            // and bubbles up the real error.
            ensure_daemon(&bin)?;

            let sock = socket_name_arg();
            // Run emacsclient --eval with a hard wall-clock ceiling. A bridge
            // call should complete in well under a second; if it hasn't
            // returned in BRIDGE_CALL_TIMEOUT_SECS the daemon is wedged (e.g.
            // a runaway elisp loop, or a modal prompt with no frame to answer
            // it). Rather than block this command forever — which strands the
            // whole UI and lets emacsclient zombies pile up — we kill the
            // client and surface a recoverable error pointing at ↻ Daemon.
            let bridge_call_timeout_secs = call_timeout;
            let mut child = match std::process::Command::new(&bin)
                .arg(format!("--socket-name={sock}"))
                .arg("--eval")
                .arg(&elisp)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    return Err(format!(
                        "Failed to launch '{bin}': {e}. Is Emacs installed?"
                    ));
                }
            };
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(bridge_call_timeout_secs);
            let out = loop {
                match child.try_wait() {
                    Ok(Some(_status)) => {
                        break child
                            .wait_with_output()
                            .map_err(|e| format!("Failed to read emacsclient output: {e}"))?;
                    }
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(format!(
                                "Emacs call timed out after {bridge_call_timeout_secs}s — the \
                                 daemon looks wedged (a runaway parse or a prompt with no \
                                 frame). Click ↻ Restart Emacs daemon in the ⚙ menu to recover.",
                            ));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                    Err(e) => return Err(format!("Error waiting on emacsclient: {e}")),
                }
            };
            if out.status.success() {
                return match std::fs::read_to_string(&tmp_for_blk) {
                    Ok(s) => {
                        let _ = std::fs::remove_file(&tmp_for_blk);
                        Ok(s)
                    }
                    Err(e) => Err(format!("Could not read bridge result: {e}")),
                };
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let msg = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                // Never surface an empty "Emacs call failed:" — when
                // emacsclient exits non-zero with no output (e.g. killed,
                // or a silent connection failure), attach actionable
                // diagnostics: exit code, the socket path we targeted,
                // and whether a daemon process is even alive.
                let code = out
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string());
                format!(
                    "emacsclient exited {code} with no output (socket: {sock}; daemon process {}). \
                     Try ↻ Restart Emacs daemon from the ⚙ menu.",
                    if daemon_process_alive() { "alive" } else { "NOT found" },
                )
            };
            Err(format!("Emacs call failed: {msg}"))
        };

        match attempt() {
            Ok(s) => Ok(s),
            Err(e) if looks_like_stale_socket(&e) => {
                // The probe-cache fast-path returned Ok because the daemon
                // looked alive seconds ago, but the socket has gone stale (or
                // the daemon died) since. Invalidate the cache so the next
                // ensure_daemon does the full probe → pgrep → cleanup → spawn
                // dance, then retry the bridge call exactly once. If THAT
                // also fails we surface the second error so users see the
                // real underlying problem.
                use std::sync::atomic::Ordering;
                DAEMON_LAST_OK_SECS.store(0, Ordering::Relaxed);
                attempt()
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    // Clean up the per-call temp result file on EVERY path. The success path
    // already removed it inline; this catches read-failure and non-success
    // exits so tiny JSON files can't accumulate under repeated failures.
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Manually clear a stuck Emacs daemon. Walks every plausible socket location
/// for the named `org-gui` server (any `emacs*` subdir of $XDG_RUNTIME_DIR,
/// $TMPDIR, and /tmp) and removes lingering files, then `pkill`s any process
/// whose command line mentions `--socket-name=org-gui`. The next bridge call
/// auto-spawns a fresh daemon. Surfaced as the toolbar "Restart daemon"
/// action so users don't have to drop to a shell when the server gets wedged.
#[tauri::command]
fn restart_emacs_daemon() -> Result<String, String> {
    let parents: Vec<std::path::PathBuf> = [
        std::env::var("XDG_RUNTIME_DIR").ok(),
        std::env::var("TMPDIR").ok(),
        Some("/tmp".to_string()),
    ]
    .into_iter()
    .flatten()
    .map(std::path::PathBuf::from)
    .collect();

    let mut removed = 0usize;
    for parent in &parents {
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name == "emacs" || name.starts_with("emacs") {
                        let sock = entry.path().join(SOCKET_NAME);
                        if sock.exists() && std::fs::remove_file(&sock).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }
    // Best-effort: TERM any lingering org-gui daemon process so the socket
    // file we just removed can't be re-created by a dying-but-still-alive
    // server before our retry connects.
    let _ = std::process::Command::new("pkill")
        .arg("-f")
        .arg(format!("emacs.*{SOCKET_NAME}"))
        .output();
    Ok(format!(
        "Cleared {removed} stale socket{} and signalled any lingering daemon. The next action will spawn a fresh server.",
        if removed == 1 { "" } else { "s" }
    ))
}

#[tauri::command]
async fn download_and_install_update(
    app: tauri::AppHandle,
    manifest_url: String,
) -> Result<String, String> {
    let url = url::Url::parse(&manifest_url).map_err(|e| format!("Invalid URL: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Failed to set endpoints: {e}"))?
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;
    let update = update.ok_or_else(|| "No update available".to_string())?;

    let mut total_downloaded = 0u64;
    let app_progress = app.clone();
    let app_finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                total_downloaded += chunk as u64;
                let _ = app_progress.emit(
                    "updater://progress",
                    UpdateProgress { downloaded: total_downloaded, total },
                );
            },
            move || {
                let _ = app_finished.emit::<()>("updater://finished", ());
            },
        )
        .await
        .map_err(|e| format!("Download/install failed: {e}"))?;

    Ok("Installed. Please restart the app to apply.".to_string())
}

/// Relaunch the running app — bound to the "Restart to apply ↻" button after
/// a successful in-app update. Without this the frontend's button never
/// actually triggers a relaunch and the user is stuck on the old binary.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Does this absolute path exist on disk? Used by session restore to drop
/// tabs whose .org file was moved/deleted since last launch, so dead tabs
/// don't accumulate in the strip.
#[tauri::command]
fn path_exists(path: String) -> bool {
    !path.is_empty() && std::path::Path::new(&path).exists()
}

/// Install org-gcal (and its dependencies) into the app-private package dir
/// `~/.org-gui/elpa`, fully decoupled from the user's Doom/straight setup.
/// Runs a throwaway `emacs --batch` (NOT the daemon — the download takes
/// 1–2 min and we don't want to block the daemon), pulling from GNU/NonGNU/
/// MELPA. The daemon then loads org-gcal from that dir on demand.
#[tauri::command]
async fn gcal_install() -> Result<String, String> {
    let emacs = emacs_bin();
    let elisp = r#"(let ((package-user-dir (expand-file-name "~/.org-gui/elpa"))
        (package-archives '(("gnu" . "https://elpa.gnu.org/packages/")
                            ("nongnu" . "https://elpa.nongnu.org/nongnu/")
                            ("melpa" . "https://melpa.org/packages/"))))
    (require 'package)
    (package-initialize)
    (unless (package-installed-p 'org-gcal)
      (package-refresh-contents)
      (package-install 'org-gcal))
    (princ (if (package-installed-p 'org-gcal) "INSTALLED" "FAILED")))"#;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new(&emacs)
            .arg("-Q")
            .arg("--batch")
            .arg("--eval")
            .arg(elisp)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch '{emacs}': {e}"))?;
        // Generous ceiling — first-time install fetches the archive list +
        // a dozen packages over the network.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    let out = child
                        .wait_with_output()
                        .map_err(|e| format!("Failed to read install output: {e}"))?;
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    if stdout.contains("INSTALLED") {
                        return Ok("org-gcal installed.".to_string());
                    }
                    return Err(format!(
                        "org-gcal install did not complete.\n{}\n{}",
                        stdout.trim(),
                        stderr.trim(),
                    ));
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("org-gcal install timed out after 5 min (network?).".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(format!("Error waiting on install: {e}")),
            }
        }
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

/// Open a terminal Emacs frame (emacsclient -t) on FILE inside a PTY. Streams
/// the terminal output to the frontend via `emacs-term-data` events and returns
/// a session id used by the write/resize/close commands.
#[tauri::command]
async fn emacs_term_open(
    app: tauri::AppHandle,
    terms: tauri::State<'_, Terminals>,
    file: String,
    begin: i64,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let bin = emacsclient_bin();
    // Make sure the named daemon is alive before we try to attach a `-t`
    // frame; otherwise emacsclient races the daemon startup and the frame
    // attaches to a half-initialised server (or to nothing at all).
    ensure_daemon(&bin)?;

    // Arm a one-shot hook (server-after-make-frame-hook) that prepares the next
    // new frame: narrow it (via an indirect buffer) to the subtree at BEGIN, or
    // show the whole file when BEGIN is 0.
    //
    // Crucially, we open the `-t` frame below WITHOUT a FILE argument. If we
    // passed the file, the server would run `server-switch-buffer` on the
    // whole-file buffer *after* our hook fires, clobbering the narrowing — the
    // user would then see the entire file instead of just the node. With no
    // file arg, our hook's buffer choice is the one that sticks.
    let bridge = bridge_path(&app)?;
    // Same content-token reload guard as org_call (see `bridge_load_token`): load
    // the bridge only if the daemon doesn't already have this exact file, and
    // record the token so subsequent calls skip the reload.
    let token = bridge_load_token(&bridge);
    let arm = format!(
        "(progn (unless (and (featurep 'org-gui-bridge) \
            (equal (bound-and-true-p org-gui-bridge--loaded-token) {token})) \
          (load-file {path}) \
          (setq org-gui-bridge--loaded-token {token})) \
        (org-gui-arm-edit {file} {begin}))",
        token = elisp_string(&token),
        path = elisp_string(&bridge.to_string_lossy()),
        file = elisp_string(&file),
        begin = begin,
    );
    // Resolve the absolute socket path once for both the arm-edit eval and
    // the `-t` frame so a TMPDIR mismatch can't make the PTY attach to a
    // socket emacsclient can't find.
    let sock = socket_name_arg();
    let _ = std::process::Command::new(&bin)
        .arg(format!("--socket-name={sock}"))
        .arg("--eval")
        .arg(&arm)
        .output();

    let mut cmd = CommandBuilder::new(bin.clone());
    // App-private daemon (named socket so it never fights the user's Doom).
    cmd.arg(format!("--socket-name={sock}"));
    cmd.arg("-t"); // interactive terminal frame; the armed hook sets the buffer
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to launch emacsclient -t (is the Emacs server running?): {e}"))?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = TERM_COUNTER.fetch_add(1, Ordering::Relaxed);

    let app_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_reader.emit("emacs-term-data", TermData { id, data });
                }
                Err(_) => break,
            }
        }
        let _ = app_reader.emit("emacs-term-exit", id);
    });

    terms
        .0
        .lock()
        .unwrap()
        .insert(id, TermSession { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
async fn emacs_term_write(
    terms: tauri::State<'_, Terminals>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let mut map = terms.0.lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
async fn emacs_term_resize(
    terms: tauri::State<'_, Terminals>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = terms.0.lock().unwrap();
    if let Some(s) = map.get(&id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    Ok(())
}

#[tauri::command]
async fn emacs_term_close(terms: tauri::State<'_, Terminals>, id: u64) -> Result<(), String> {
    // Take the session out of the map first so the lock isn't held across the
    // (brief) blocking wait. kill() THEN wait() so the emacsclient child is
    // reaped instead of left as a zombie until app exit (matches the
    // kill+wait pattern used everywhere else).
    let session = terms.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    if let Some(mut s) = session {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Terminals::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            org_call,
            check_prereqs,
            install_prereqs,
            download_and_install_update,
            restart_app,
            restart_emacs_daemon,
            path_exists,
            gcal_install,
            emacs_term_open,
            emacs_term_write,
            emacs_term_resize,
            emacs_term_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
