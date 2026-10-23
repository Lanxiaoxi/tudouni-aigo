//! The commands that act on one session: its process (attach, send, listen,
//! shut down, kill, version, stderr) and its stored transcripts
//! (`sessions_search`, which scans files rather than talking to a child).

use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::launch::AttachOptions;
use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::bridge::LinePayload;
use crate::bridge::SharedProcess;
use crate::launch_remote::RemoteAttachOptions;
use crate::launch::resolve_binary;
use crate::launch::spawn;
use crate::launch_remote::spawn_remote;
use crate::session_search;

/// How long a graceful shutdown is given before the child is killed.
///
/// The Go client hard-codes the same 30 seconds inside `Close()`, and for the
/// same reason: `shutdown` lets the current turn finish, so the wait has to be
/// generous — but it has to end, or the window cannot be closed.
pub(crate) const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

/// Start one session's runtime and begin forwarding it.
///
/// **It adds a session; it does not replace one.** Calling it twice gives two
/// running sessions, which is what a person who opens a second conversation
/// while the first is working is asking for. The returned key is that session's
/// handle for as long as its process lives, and the front end passes it back on
/// every call that acts on that session.
///
/// Every failure here is something the person can act on — no binary, a
/// workspace the runtime refuses, no permission to execute it — so they are
/// returned as sentences rather than as an exit code somewhere. They belong to
/// the session being opened and to no other: a refusal to start B must not take
/// over a screen where A is running.
/// **`async`, and that is load-bearing.** A synchronous Tauri command runs on
/// the main thread, and spawning a child plus sweeping its staging directory is
/// filesystem work; `sessions_search` below documents the same rule. The work
/// itself moves to the blocking pool so the window's event loop stays free.
#[tauri::command]
pub(crate) async fn runtime_attach(
    app: AppHandle,
    options: AttachOptions,
) -> Result<ChildKey, String> {
    tauri::async_runtime::spawn_blocking(move || spawn(&app, &options))
        .await
        .map_err(|error| format!("the runtime start task failed: {error}"))?
}

/// Start one session's runtime on a remote host over SSH, and begin
/// forwarding it exactly like a local one.
///
/// This is the Remote Backend's one entry point from the front end: everything
/// downstream of the returned key — `runtime_send`, `runtime_shutdown`,
/// `runtime_kill`, the `runtime://line` / `runtime://stderr` / `runtime://exited`
/// events — is already backend-agnostic, because `Child_` holds a
/// `Box<dyn ssh_backend::RuntimeProcess>` rather than a concrete local type.
/// This command's whole job is building that one `RuntimeProcess` and handing
/// it to the same registration, staging-sweep-skipping, and stdout/stderr/wait
/// thread setup `spawn` already does for a local child.
///
/// Host key verification, Workspace Manager configuration, and automatic
/// installation of the runtime binary are later-phase concerns; see
/// `ssh_backend::connect`'s own doc for why host key checking in particular is
/// deliberately not this function's job.
#[tauri::command]
pub(crate) async fn runtime_attach_remote(
    app: AppHandle,
    options: RemoteAttachOptions,
) -> Result<ChildKey, String> {
    tauri::async_runtime::spawn_blocking(move || spawn_remote(&app, &options))
        .await
        .map_err(|error| format!("the remote runtime start task failed: {error}"))?
}

/// Write one protocol line to **one** session's stdin.
///
/// The key is required. Without it the write would go to whichever session
/// happened to be first, and a misdirected `user_message` runs a turn in the
/// wrong conversation — the kind of mistake that is invisible until somebody
/// reads the transcript. The line itself arrives already encoded (including
/// `v`), so nothing here parses it: whatever the front end decided is what goes
/// out, and to whom is decided by the key.
///
/// The write can block for up to `ssh_backend`'s write timeout on a wedged
/// connection, so it happens off the main thread and **outside** the bridge
/// lock — see [`SharedProcess`]. Holding that lock across a remote write would
/// stall every other session and every stderr reader behind one bad connection.
#[tauri::command]
pub(crate) async fn runtime_send(
    app: AppHandle,
    key: ChildKey,
    line: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<Bridge> = app.state();
        let process = {
            let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            guard
                .children
                .get(&key)
                .map(|current| current.process.clone())
                .ok_or("that session's runtime is not running")?
        };
        let mut process = process.lock().map_err(|_| "the runtime lock is poisoned")?;
        process
            .write_line(&line)
            .map_err(|e| format!("could not write to the runtime: {e}"))
    })
    .await
    .map_err(|error| format!("the send task failed: {error}"))?
}

/// Mark that the front end is listening and flush everything queued so far, in
/// order. Called once, after the first `subscribe`.
///
/// A child is **not** required. The front end registers its listener and
/// announces it in the same layout effect that starts the runtime a moment
/// later, so this call normally arrives first — and refusing it there is what
/// used to strand the opening `init` -> `session_load` -> `ui(state)` triple in
/// the queue, with the UI booting forever and no error anywhere. Recording the
/// announcement is therefore the whole job; flushing is the easy half that only
/// applies when the child happens to exist already.
#[tauri::command]
pub(crate) fn runtime_attach_listener(app: AppHandle) -> Result<usize, String> {
    let state: State<Bridge> = app.state();
    // Every child's queue, because the announcement is process-wide and the
    // queues are not. Flushing only one would release the first session's opening
    // triple while leaving a second session's `init` stranded until its next
    // line arrived — and there is no next line until the front end sends
    // something, which it will not do before it has seen `init`.
    let pending: Vec<(ChildKey, String)> = {
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard.listening = true;
        guard
            .children
            .iter_mut()
            .flat_map(|(key, current)| {
                let key = *key;
                current.queue.drain(..).map(move |line| (key, line))
            })
            .collect()
    };
    let count = pending.len();
    for (key, line) in pending {
        let _ = app.emit("runtime://line", LinePayload { key, line });
    }
    Ok(count)
}

/// Ask one session — or every session — to finish, then make sure it is gone.
///
/// `shutdown` lets the current turn finish; it is not an interrupt. Killing
/// mid-turn leaves an assistant message with tool calls and no results, and that
/// session can never be sent to again. So this is the polite path, and the
/// timeout below is the fallback that keeps a window closable.
///
/// **`None` means every session** (the window is closing, so nothing survives
/// anyway) and `Some(key)` means one. Per-session shutdown exists because
/// closing one conversation is not a reason to end another: with several open,
/// "stop this one" and "stop everything" are different acts.
///
/// Only the waiter thread calls `wait`, and it removes the slot when it does.
/// This function therefore polls the slots rather than waiting on its own
/// handles: two waiters on one child is a race with no upside.
#[tauri::command]
pub(crate) async fn runtime_shutdown(
    app: AppHandle,
    key: Option<ChildKey>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shutdown_blocking(app, key))
        .await
        .map_err(|error| format!("the shutdown task failed: {error}"))?
}

/// The blocking half of `runtime_shutdown`, for callers that already own a
/// thread (the close prompt and the tray's Quit) and must not spawn a nested
/// task. Everything that goes through the Tauri command uses the async
/// wrapper above instead.
pub(crate) fn shutdown_blocking(app: AppHandle, key: Option<ChildKey>) -> Result<(), String> {
    let state: State<Bridge> = app.state();

    // Take a handle to each target under the bridge lock, mark it as requested,
    // then release the lock **before** writing `shutdown`. A remote write can
    // wait out `WRITE_TIMEOUT`; doing it under the bridge lock would freeze
    // every other session and the resource panel for those seconds. One line
    // per session, so the writes still happen concurrently.
    let targets: Vec<SharedProcess> = {
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let keys: Vec<ChildKey> = match key {
            Some(key) => {
                if guard.children.contains_key(&key) {
                    vec![key]
                } else {
                    vec![]
                }
            }
            None => guard.children.keys().copied().collect(),
        };
        keys.into_iter()
            .filter_map(|target| {
                guard.children.get_mut(&target).map(|current| {
                    current.requested = true;
                    current.process.clone()
                })
            })
            .collect()
    };
    for process in targets {
        match process.lock() {
            Ok(mut process) => {
                // A failure here is reported by the exit path; shutdown is
                // best-effort once the session is already going away.
                let _ = process.shutdown();
            }
            Err(_) => return Err("the runtime lock is poisoned".to_string()),
        }
    }

    // Then wait for all of them at once, with one deadline for the whole set.
    //
    // A per-session deadline would be N × 30s to close a window with N sessions
    // open, and the person watching would read that as a hang. The budget belongs
    // to the act of closing, not to each child.
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        let still_running = {
            let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            match key {
                Some(key) => guard.children.contains_key(&key),
                None => !guard.children.is_empty(),
            }
        };
        if !still_running {
            return Ok(());
        }
        if Instant::now() >= deadline {
            // The timeout has to exist, or the window cannot be closed. The cost
            // is real and is stated in the design: a kill mid-turn can leave a
            // session unsendable.
            //
            // Collect the handles under the bridge lock and kill after
            // releasing it, for the same reason the writes above are outside.
            let victims: Vec<SharedProcess> = {
                let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
                match key {
                    Some(key) => guard
                        .children
                        .get(&key)
                        .map(|current| vec![current.process.clone()])
                        .unwrap_or_default(),
                    None => guard
                        .children
                        .values()
                        .map(|current| current.process.clone())
                        .collect(),
                }
            };
            for process in victims {
                if let Ok(mut process) = process.lock() {
                    let _ = process.kill();
                }
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// The kill switch, for when the timeout is not enough.
///
/// Off the main thread because `wait_after_kill` reaps a local child and can
/// block until it is gone; the bridge lock is released before that wait starts.
#[tauri::command]
pub(crate) async fn runtime_kill(
    app: AppHandle,
    key: Option<ChildKey>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<Bridge> = app.state();
        let victims: Vec<SharedProcess> = {
            let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            let keys: Vec<ChildKey> = match key {
                Some(key) => {
                    if guard.children.contains_key(&key) {
                        vec![key]
                    } else {
                        vec![]
                    }
                }
                None => guard.children.keys().copied().collect(),
            };
            keys.into_iter()
                .filter_map(|target| {
                    guard.children.remove(&target).map(|mut current| {
                        current.requested = true;
                        current.process.clone()
                    })
                })
                .collect()
        };
        for process in victims {
            let mut process = process.lock().map_err(|_| "the runtime lock is poisoned")?;
            let _ = process.kill();
            process.wait_after_kill();
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("the kill task failed: {error}"))?
}

/// The runtime's own version, from `--version`.
///
/// `init` carries no product version — `v` is the envelope and `protocol` is the
/// conversation's semantic version, and neither is one. So it is read by running
/// the binary once, and the second whitespace-separated field is the version
/// (`internal/version/version.go`'s `Describe()`). `dev` is returned as-is: a
/// build without ldflags is a dev build, and prettifying it would hide which
/// binary is actually running.
#[tauri::command]
pub(crate) async fn runtime_version(binary: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_version(&binary))
        .await
        .map_err(|error| format!("the version task failed: {error}"))?
}

fn read_version(binary: &str) -> Result<Option<String>, String> {
    let path = if binary.trim().is_empty() {
        resolve_binary(None)?
    } else {
        resolve_binary(Some(binary))?
    };

    // Same CREATE_NO_WINDOW flag as spawn(): the welcome screen runs this from
    // a GUI process, and without the flag a console window flashes on screen.
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut version_command = Command::new(&path);
    version_command.arg("--version");
    #[cfg(windows)]
    version_command.creation_flags(CREATE_NO_WINDOW);
    let output = version_command
        .output()
        .map_err(|e| format!("could not run {}: {e}", path.display()))?;

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_version_output(&text))
}

/// The version out of one `--version` output, or `None`.
///
/// `Describe()` prints a name and a version separated by whitespace (`tudouni-aigo
/// 4.18.0`), and `dev` is a legitimate second field: a build without ldflags is a
/// dev build, and prettifying it would hide which binary is actually running.
///
/// Shared with the remote door below, so the two cannot parse the same output
/// differently — which would show one version on a local session and another on a
/// remote one running the same build.
fn parse_version_output(text: &str) -> Option<String> {
    text.split_whitespace()
        .nth(1)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The version of the runtime **running on a remote child's host**.
///
/// The window-level `runtime_version` reads this machine's binary, and on a
/// remote session that is the wrong answer — the host may be running an older or
/// newer build (the install is a one-off, not an upgrade-on-connect), so Audit
/// showing the local version beside a `protocol` that came from the host is two
/// lines that contradict each other.
///
/// `init` carries no version to fall back on (`v` is the envelope, `protocol` is
/// the conversation's semantic version), so the only way to learn it is to run
/// the binary once — over the child's own SSH destination, with the path it was
/// started from. **Both come off the bridge rather than from the caller**, for
/// the same reason the paste's destination does: a front end that could name a
/// path here could ask a host to execute something this program never started.
///
/// A host that cannot answer is reported as `None` rather than as an error: the
/// panel draws "unknown", which is honest, where a red failure row would suggest
/// the session itself is broken.
#[tauri::command]
pub(crate) async fn remote_runtime_version(app: AppHandle, key: ChildKey) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || remote_version_blocking(app, key))
        .await
        .map_err(|error| format!("the remote version task failed: {error}"))?
}

fn remote_version_blocking(app: AppHandle, key: ChildKey) -> Result<Option<String>, String> {
    let ssh = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so its version cannot be asked for")?;
        match (current.remote_ssh.clone(), current.remote_binary.clone()) {
            (Some(ssh), Some(binary)) if !binary.trim().is_empty() => (ssh, binary),
            _ => return Err("that session is not remote, or its binary path is unknown".to_string()),
        }
    };
    let (ssh, binary) = ssh;
    let session = crate::ssh_backend::dial_session(&ssh.to_target())
        .map_err(|e| format!("could not reach the remote host to ask its version: {e}"))?;
    // Quoted, because the path comes from a saved entry and a space in it would
    // otherwise split the command — the same rule every other remote command
    // here follows.
    let command = format!("{} --version", crate::remote_install::q(binary.trim()));
    let output = crate::remote_install::exec_capture(&session, &command)
        .map_err(|e| format!("could not run --version on the remote host: {e}"))?;
    Ok(parse_version_output(&output))
}

/// Search the workspace's saved sessions for a keyword and hand back the hits.
///
/// **A host-side read, like `config_read`.** The session files belong to the
/// workspace, and a runtime child answers only for the workspace it is itself
/// running in — so a search that should span "the sessions I can see" is asked
/// of the one process that is always present and belongs to no session. The
/// scan is read-only and never touches a live child's write path: it stops at
/// the first match in each file, and the rules it applies are the runtime's own
/// (see `session_search`'s module doc).
///
/// The query is case-insensitive. An empty or whitespace query is answered
/// with an empty list rather than an error — the front end debounces and only
/// sends a real query, and refusing here would turn "nothing typed yet" into a
/// red row in the rail.
///
/// **`async`, and that is load-bearing, not style.** A *synchronous* Tauri
/// command runs on the **main thread**, and the window's event loop lives
/// there: the scan is a read of every session file (one measured file is 52 MB,
/// and a keyword that is not in a file means the whole file has to be read
/// before it can be ruled out), so a sync command froze the entire window —
/// no keys, no pointer, no repaint — until the scan finished. An async command
/// runs off the main thread, and `spawn_blocking` moves the blocking read onto
/// the blocking pool rather than an async worker.
#[tauri::command]
pub(crate) async fn sessions_search(
    workspace: String,
    query: String,
) -> Result<Vec<session_search::SessionSearchHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let dir = PathBuf::from(workspace.trim());
    if !dir.is_dir() {
        // A workspace that is not a directory has no session store to read,
        // and that is a normal state (the person has not opened anything),
        // not a fault worth surfacing as a red error.
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || session_search::search(&dir, &query))
        .await
        .map_err(|err| err.to_string())?
}

/// The last stderr lines of one child, for the local "the runtime would not
/// start" panel.
///
/// Per session, because a start-up failure belongs to the session whose binary
/// would not start. A single shared ring would mix two sessions' diagnostics and
/// then show them under whichever one the person happened to be looking at.
#[tauri::command]
pub(crate) fn runtime_stderr(app: AppHandle, key: ChildKey) -> Vec<String> {
    let state: State<Bridge> = app.state();
    // Bound to a local before returning: the guard borrows `state`, and a
    // `match` used directly as the tail expression would keep its temporary
    // alive past the end of the block.
    let lines = match state.inner.lock() {
        Ok(guard) => guard
            .children
            .get(&key)
            .map(|current| current.stderr.iter().cloned().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    lines
}
