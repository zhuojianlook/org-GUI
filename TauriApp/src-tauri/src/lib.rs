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
/// "server" socket). `--socket-name=org-gui` paired with `-a ""` makes
/// emacsclient connect to a daemon named "org-gui", auto-starting it (loading
/// the user's config) if one isn't running yet.
const SOCKET_NAME: &str = "org-gui";

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
    let doom_installed = doom_dir.is_some();

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
    // Load the bundled bridge ONLY when the running daemon doesn't already
    // have the version we ship — checks `org-gui-bridge-version` so an app
    // upgrade still forces a reload, but routine calls don't spam the
    // message buffer with "Loading bridge.el…done" on every invocation.
    let elisp = format!(
        "(progn (unless (and (featurep 'org-gui-bridge) \
            (equal (bound-and-true-p org-gui-bridge-version) {})) \
          (load-file {})) \
        (org-gui-call {} #'{} {}))",
        elisp_string(env!("CARGO_PKG_VERSION")),
        elisp_string(&bridge.to_string_lossy()),
        elisp_string(&tmp.to_string_lossy()),
        func,
        arg_lits.join(" "),
    );

    let bin = emacsclient_bin();
    let tmp_for_blk = tmp.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new(&bin)
            // Dedicated socket + -a "" : connect to (or auto-start) an
            // app-private daemon so we don't collide with the user's Doom.
            .arg(format!("--socket-name={SOCKET_NAME}"))
            .arg("-a")
            .arg("")
            .arg("--eval")
            .arg(&elisp)
            .output();
        match output {
            Ok(out) => {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let msg = if !stderr.is_empty() { stderr } else { stdout };
                    return Err(format!(
                        "Emacs call failed (is the Emacs server running?): {msg}"
                    ));
                }
                match std::fs::read_to_string(&tmp_for_blk) {
                    Ok(s) => {
                        let _ = std::fs::remove_file(&tmp_for_blk);
                        Ok(s)
                    }
                    Err(e) => Err(format!("Could not read bridge result: {e}")),
                }
            }
            Err(e) => Err(format!(
                "Failed to launch '{bin}': {e}. Is Emacs installed and the server started?"
            )),
        }
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    result
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
    let arm = format!(
        "(progn (unless (and (featurep 'org-gui-bridge) \
            (equal (bound-and-true-p org-gui-bridge-version) {})) \
          (load-file {})) \
        (org-gui-arm-edit {} {}))",
        elisp_string(env!("CARGO_PKG_VERSION")),
        elisp_string(&bridge.to_string_lossy()),
        elisp_string(&file),
        begin,
    );
    let _ = std::process::Command::new(&bin)
        .arg(format!("--socket-name={SOCKET_NAME}"))
        .arg("-a")
        .arg("")
        .arg("--eval")
        .arg(&arm)
        .output();

    let mut cmd = CommandBuilder::new(bin.clone());
    // App-private daemon (named socket so it never fights the user's Doom).
    cmd.arg(format!("--socket-name={SOCKET_NAME}"));
    cmd.arg("-a");
    cmd.arg("");
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
    if let Some(mut s) = terms.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
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
            emacs_term_open,
            emacs_term_write,
            emacs_term_resize,
            emacs_term_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
