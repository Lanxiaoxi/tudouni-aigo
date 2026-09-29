//! The runtime bridge.
//!
//! This layer owns the child process and moves bytes. It deliberately does
//! **not** parse the protocol: it hands whole lines to the WebView and writes
//! whole lines back. Any urge to read `kind` here would create a second
//! definition of the protocol, and it would drift.
//!
//! Four details are load-bearing, and all four come from
//! `internal/protocol/client.go` — the Go reference client, which is the
//! authority for how this child is driven:
//!
//! 1. **An absolute path to the same executable**, never a `PATH` lookup.
//!    Another build on `PATH` is another program, and the symptom is a child
//!    that exits immediately.
//! 2. **The working directory is the workspace.** The runtime takes `cwd` as
//!    the workspace (`paths.WorkspaceDir()`), and the file tools' boundary is
//!    exactly that. It must be set explicitly; inheriting the app's own
//!    directory would silently widen or narrow the sandbox.
//! 3. **stderr is drained**, not discarded and not inherited. `null` gives the
//!    child a closed descriptor, and a process writing diagnostics to a closed
//!    stderr fails in ways unrelated to its own work; inheriting it puts
//!    diagnostics somewhere a GUI cannot show them. A pipe that is read and
//!    dropped is what the Go client does, and the things a person actually
//!    needs to see arrive as `notice` messages instead.
//! 4. **Lines are queued until the front end attaches.** The process can be up
//!    and `init` sent before the WebView's listener exists, and the WebView's
//!    load timing is not ours to control. Queueing and flushing in order is
//!    more reliable than "register early and hope".

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};

/// How long a graceful shutdown is given before the child is killed.
///
/// The Go client hard-codes the same 30 seconds inside `Close()`, and for the
/// same reason: `shutdown` lets the current turn finish, so the wait has to be
/// generous — but it has to end, or the window cannot be closed.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

/// How many stderr lines to keep for the local diagnostics panel. This is not
/// protocol data and is never shown as session content.
const STDERR_RING: usize = 200;

/// Where a pasted picture is stashed, under the workspace.
///
/// It has to be **inside the workspace**, and that is not a preference: the
/// runtime resolves a picture named in the user's sentence through
/// `tools.Workspace.SafePath`, which refuses anything outside the working
/// directory. A file written to `%TEMP%` would produce a path that looks
/// perfectly ordinary in the sentence and can never be attached.
///
/// `.tudouni/` specifically, because that is already this program's per-workspace
/// state directory (sessions, the audit log, artifacts, job output) and it is in
/// the repository's `.gitignore`. Writing screenshots into the user's project tree
/// would leave them in `git status` for a feature whose whole point is being
/// cheap to use.
const PASTE_DIR: &str = ".tudouni";
const PASTE_SUBDIR: &str = "paste";

/// The per-picture ceiling, mirroring `content.MaxImageBytes`
/// (`internal/content/content.go`). The front end checks the same number before
/// it ever sends bytes; this is the second door, and it exists because the first
/// one is in a different process.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// The three formats the runtime can measure: the bytes that identify each, the
/// extension to store it under, and the media type to report.
///
/// The signature is what decides, **not** the extension or the type the front end
/// sent. A clipboard entry carries a name and a declared type, and both are
/// claims: a `.png` that is really a JPEG is common (a screenshot tool renaming
/// its output, a file downloaded twice), and a file whose extension disagrees
/// with its bytes is refused downstream with a message about the media type
/// rather than the file. The runtime sniffs with `http.DetectContentType`; this
/// is the same decision from the same evidence.
///
/// The three travel together in one row rather than in three tables, because they
/// are one decision — three parallel lists is how one of them ends up disagreeing
/// with the others.
///
/// WebP is deliberately absent, for the same reason `content.ImageMIMEs` leaves
/// it out: no decoder means no dimensions and no thumbnail, so accepting it here
/// would produce a file that is stashed and then refused.
struct ImageSignature {
    signature: &'static [u8],
    extension: &'static str,
    mime: &'static str,
}

const IMAGE_SIGNATURES: [ImageSignature; 3] = [
    ImageSignature {
        signature: &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        extension: "png",
        mime: "image/png",
    },
    ImageSignature {
        signature: &[0xff, 0xd8, 0xff],
        extension: "jpg",
        mime: "image/jpeg",
    },
    // `GIF8` covers both GIF87a and GIF89a: they differ in the two bytes after
    // this signature, and both are accepted.
    ImageSignature {
        signature: &[0x47, 0x49, 0x46, 0x38],
        extension: "gif",
        mime: "image/gif",
    },
];

/// A line read from the child, forwarded verbatim.
#[derive(Clone, Serialize)]
struct LinePayload {
    line: String,
}

/// The child ended. Both a requested shutdown and a crash exit with code 0, so
/// `requested` is the only thing that tells "the session ended" from "the
/// runtime died".
#[derive(Clone, Serialize)]
struct ExitPayload {
    code: i32,
    requested: bool,
}

#[derive(Default)]
struct Bridge {
    inner: Mutex<BridgeState>,
}

/// The child, and whether the front end is listening.
///
/// Both live under one lock because they are coupled. The front end announces
/// its listener in the same layout effect that starts the runtime afterwards, so
/// "listening" is routinely set while there is no child yet — and a line read at
/// that moment has to end up in the queue rather than out to nobody. Keeping the
/// flag inside `Child_` made that impossible to express: there was nothing to
/// set it on, the announcement was refused, and every line the child sent was
/// queued forever. The UI sat in its booting phase with a perfectly healthy
/// runtime behind it.
#[derive(Default)]
struct BridgeState {
    child: Option<Child_>,
    /// True once the front end says a listener is in place.
    listening: bool,
    /// Where the current child was started.
    ///
    /// Kept here rather than passed in on each call because `image_stash` has to
    /// write **inside the workspace**, and the workspace is a fact this layer
    /// already owns — it is the child's working directory. Taking it from the
    /// caller instead would make a front end able to name the directory a file is
    /// written into, which is exactly the kind of trust this boundary exists to
    /// withhold.
    workspace: Option<PathBuf>,
}

struct Child_ {
    child: Child,
    /// `None` once the shutdown has taken it. Closing this pipe is the second
    /// half of the shutdown contract — EOF on stdin takes the same path through
    /// the server loop as the `shutdown` message does — and it is only possible
    /// by moving the handle out, so it is an `Option` rather than a bare value.
    stdin: Option<ChildStdin>,
    /// True once we have asked for the shutdown ourselves.
    requested: bool,
    /// Lines read before the front end attached, flushed in order on attach.
    queue: VecDeque<String>,
    stderr: VecDeque<String>,
}

/// Options the front end passes to `runtime_attach`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachOptions {
    /// Absolute path to the runtime binary. `None` means "the packaged one",
    /// resolved by [`resolve_binary`].
    binary: Option<String>,
    /// The workspace. `None` means "the directory the app was started in",
    /// which is only sensible during development.
    workspace: Option<String>,
    session_id: Option<String>,
    max_steps: Option<i64>,
    stream: Option<bool>,
    autopilot: Option<bool>,
}

/// Where the runtime binary lives.
///
/// Resolution order:
///   1. `TUDOUNI_RUNTIME` — an explicit override, used by the dev scripts;
///   2. next to the executable (a packaged app puts it in `resources/runtime/`);
///   3. `dist/` in the repository root — development only.
///
/// Never `PATH`: another build there is another program.
fn resolve_binary(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!("the runtime binary was not found at {path}"));
    }

    if let Ok(from_env) = std::env::var("TUDOUNI_RUNTIME") {
        let candidate = PathBuf::from(&from_env);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!("TUDOUNI_RUNTIME points at {from_env}, which is not a file"));
    }

    let name = if cfg!(windows) { "tudouni-aigo.exe" } else { "tudouni-aigo" };

    // Next to the app, then one level up: a packaged bundle puts the runtime in
    // `resources/`, and a dev build sits beside `target/`.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..3 {
            let Some(current) = dir else { break };
            for candidate in [
                current.join("runtime").join(name),
                current.join(name),
                current.join("resources").join("runtime").join(name),
            ] {
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }

    Err(format!(
        "the runtime binary ({name}) was not found next to the application. \
         Set TUDOUNI_RUNTIME to its absolute path."
    ))
}

/// Start the child, replacing any previous one.
fn spawn(
    app: &AppHandle,
    options: &AttachOptions,
) -> Result<(), String> {
    let binary = resolve_binary(options.binary.as_deref())?;

    // The workspace is the child's working directory, and it is not optional:
    // the runtime refuses to run in the home directory, a volume root, or an
    // ancestor of home (`paths.UnsafeWorkspace`), and it does so by exiting with
    // code 2 after writing to stderr — which we drain. So a refusal has to be
    // caught here, before the child ever starts, or it looks like silence.
    let workspace = match options.workspace.as_deref() {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().map_err(|e| format!("cannot read the working directory: {e}"))?,
    };
    if !workspace.is_dir() {
        return Err(format!("the workspace {} is not a directory", workspace.display()));
    }
    if let Some(kind) = unsafe_workspace(&workspace) {
        return Err(format!(
            "the workspace {} cannot be used ({kind}): the runtime refuses it, \
             because the file tools' boundary would be the whole machine",
            workspace.display()
        ));
    }

    let mut command = Command::new(&binary);
    command.arg("--runtime-stdio");
    if let Some(id) = options.session_id.as_deref() {
        if !id.is_empty() {
            command.arg("--session").arg(id);
        }
    }
    if let Some(steps) = options.max_steps {
        if steps > 0 {
            command.arg("--max-steps").arg(steps.to_string());
        }
    }
    // `--stream` is a boolean flag and must be passed as `--stream=true` if ever
    // given a value; here it is only ever present or absent.
    if options.stream == Some(true) {
        command.arg("--stream");
    }
    if options.autopilot == Some(true) {
        command.arg("--autopilot");
    }

    command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // A pipe, never `null` and never inherited: see the module comment.
        .stderr(Stdio::piped());

    // The runtime is a console program, and a GUI parent has no console for it
    // to inherit — so without this flag Windows mints a fresh console window
    // ("the black box") that stays up for the life of the child. The pipes
    // above carry everything the bridge needs; the console itself is dead
    // weight. 0x08000000 is CREATE_NO_WINDOW, which has no std binding.
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", binary.display()))?;

    let stdin = child.stdin.take().ok_or("the child has no stdin")?;
    let stdout = child.stdout.take().ok_or("the child has no stdout")?;
    let stderr = child.stderr.take().ok_or("the child has no stderr")?;

    let state: State<Bridge> = app.state();
    let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;

    // If a child is already running, take it down before replacing it. A second
    // runtime in the same workspace would write the same files.
    if let Some(previous) = guard.child.as_mut() {
        previous.requested = true;
        // Straight to the kill: this path is a restart, not a shutdown, and the
        // new child needs the workspace to itself now.
        let _ = previous.child.kill();
        let _ = previous.child.wait();
    }

    // Recorded before the child is stored, so `image_stash` can never observe a
    // running child with a stale workspace.
    guard.workspace = Some(workspace.clone());
    guard.child = Some(Child_ {
        child,
        stdin: Some(stdin),
        requested: false,
        queue: VecDeque::new(),
        stderr: VecDeque::new(),
    });
    drop(guard);

    // Pasted pictures from the last run are cleared out now, and this is the only
    // moment it is safe to do so: nothing is in flight yet, and no draft refers to
    // them.
    //
    // What makes clearing safe at all is that the directory is a **staging area
    // and not the storage**. A picture that was sent has already been copied into
    // the runtime's content-addressed artifact store
    // (`<workspace>/.tudouni/artifacts/<session>/`), which is what the session
    // file references and what `/resume` reads back; the file here is only what
    // the path in the sentence pointed at when the turn ran. So a stale path in an
    // old session resolves to nothing, and the runtime's scanner treats a word
    // that names no file as a word — which is exactly what it does for any path a
    // person typed that has since been deleted.
    //
    // Without this, every screenshot anyone ever pasted would stay in the
    // workspace for the life of the project.
    let staging = workspace.join(PASTE_DIR).join(PASTE_SUBDIR);
    if let Err(error) = fs::remove_dir_all(&staging) {
        // A failure here is not worth refusing to start over: the directory may
        // simply not exist yet, which is the ordinary case on a first run.
        if error.kind() != std::io::ErrorKind::NotFound {
            let _ = app.emit(
                "runtime://stderr",
                LinePayload {
                    line: format!("could not clear {}: {error}", staging.display()),
                },
            );
        }
    }

    // ---- stdout: one JSON line at a time, queued until attach ----
    {
        let app = app.clone();
        thread::spawn(move || {
            // `read_until` rather than a fixed buffer: `session_load` carries the
            // whole session in one line and can be megabytes, so no small cap may
            // be imposed.
            let mut reader = BufReader::new(stdout);
            let mut buffer: Vec<u8> = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buffer)
                            .trim_end_matches(['\n', '\r'])
                            .to_string();
                        if line.trim().is_empty() {
                            continue;
                        }
                        forward_line(&app, line);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- stderr: drained and kept in a small ring, for diagnostics only ----
    {
        let app = app.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer: Vec<u8> = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buffer)
                            .trim_end_matches(['\n', '\r'])
                            .to_string();
                        if line.trim().is_empty() {
                            continue;
                        }
                        let state: State<Bridge> = app.state();
                        if let Ok(mut guard) = state.inner.lock() {
                            if let Some(current) = guard.child.as_mut() {
                                if current.stderr.len() >= STDERR_RING {
                                    current.stderr.pop_front();
                                }
                                current.stderr.push_back(line.clone());
                            }
                        }
                        // Diagnostics, not business data: a separate channel.
                        let _ = app.emit("runtime://stderr", LinePayload { line });
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- wait: report the exit code and whether we asked for it ----
    //
    // This is the only place the child is reaped, which is why `runtime_shutdown`
    // polls instead of calling `wait()`: two waiters on one handle would race.
    {
        let app = app.clone();
        thread::spawn(move || {
            let outcome = loop {
                {
                    let state: State<Bridge> = app.state();
                    let mut guard = match state.inner.lock() {
                        Ok(guard) => guard,
                        Err(_) => break None,
                    };
                    match guard.child.as_mut() {
                        Some(current) => match current.child.try_wait() {
                            Ok(Some(status)) => {
                                let requested = current.requested;
                                guard.child = None;
                                break Some((status.code().unwrap_or(-1), requested));
                            }
                            Ok(None) => {}
                            Err(_) => {
                                guard.child = None;
                                break Some((-1, false));
                            }
                        },
                        // Replaced by a restart, or already reaped: nothing to say.
                        None => break None,
                    }
                }
                thread::sleep(Duration::from_millis(100));
            };

            if let Some((code, requested)) = outcome {
                // The runtime never sends `runtime_exited` itself — in the Go
                // client it is the client's own synthesized message, and this is
                // its equivalent. `requested` is not optional: a requested
                // shutdown and a crash both exit with code 0, so it is the only
                // thing that tells "the session ended" from "the runtime died".
                let _ = app.emit("runtime://exited", ExitPayload { code, requested });
            }
        });
    }

    Ok(())
}

/// Forward one line: straight to the WebView once attached, otherwise queued.
///
/// The queue exists for the handshake race: the process can be up and `init`
/// sent before the WebView has a listener, and the WebView's load timing is not
/// ours to control. `init` -> `session_load` -> `ui(state)` is a fixed opening
/// triple, and losing the first one leaves the UI in its booting phase forever.
fn forward_line(app: &AppHandle, line: String) {
    let state: State<Bridge> = app.state();

    let attached = {
        let mut guard = match state.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if guard.listening {
            true
        } else if let Some(current) = guard.child.as_mut() {
            current.queue.push_back(line.clone());
            false
        } else {
            // The child was replaced or shut down between the read and here.
            return;
        }
    };

    if attached {
        let _ = app.emit("runtime://line", LinePayload { line });
    }
}

/// The names of the directories the runtime refuses as a workspace, mirroring
/// `paths.UnsafeWorkspace`. Checked here so the refusal is a message rather than
/// a silent exit.
fn unsafe_workspace(dir: &Path) -> Option<&'static str> {
    let absolute = dir.canonicalize().ok()?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);

    if let Some(home) = home {
        if let Ok(home) = home.canonicalize() {
            if absolute == home {
                return Some("it is the home directory");
            }
            if home.starts_with(&absolute) {
                return Some("it is an ancestor of the home directory");
            }
        }
    }

    // A volume root: no parent, or a parent equal to itself.
    if absolute.parent().is_none() {
        return Some("it is a volume root");
    }

    None
}

/* ============================================================
   Commands
   ============================================================ */

/// Start the runtime and begin forwarding. Idempotent: calling it again with a
/// different workspace restarts the child in that directory.
#[tauri::command]
fn runtime_attach(app: AppHandle, options: AttachOptions) -> Result<(), String> {
    spawn(&app, &options)
}

/// Write one protocol line to the child's stdin.
///
/// The line arrives already encoded (including `v`), so nothing here parses it:
/// whatever the front end decided is what goes out.
#[tauri::command]
fn runtime_send(app: AppHandle, line: String) -> Result<(), String> {
    let state: State<Bridge> = app.state();
    let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
    let current = guard.child.as_mut().ok_or("the runtime is not running")?;
    let stdin = current.stdin.as_mut().ok_or("the runtime is shutting down")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("could not write to the runtime: {e}"))
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
fn runtime_attach_listener(app: AppHandle) -> Result<usize, String> {
    let state: State<Bridge> = app.state();
    let pending: Vec<String> = {
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard.listening = true;
        match guard.child.as_mut() {
            Some(current) => current.queue.drain(..).collect(),
            None => Vec::new(),
        }
    };
    let count = pending.len();
    for line in pending {
        let _ = app.emit("runtime://line", LinePayload { line });
    }
    Ok(count)
}

/// Ask for a graceful shutdown, then make sure the child is gone.
///
/// `shutdown` lets the current turn finish — it is not an interrupt. Killing
/// mid-turn leaves an assistant message with tool calls and no results, and that
/// session can never be sent to again.
///
/// Only the waiter thread calls `wait`, and it clears the shared slot when it
/// does. This function therefore polls that slot rather than waiting on its own
/// handle: two waiters on one child is a race with no upside.
#[tauri::command]
fn runtime_shutdown(app: AppHandle) -> Result<(), String> {
    let state: State<Bridge> = app.state();

    // Take the handle out of the shared slot rather than cloning it: `ChildStdin`
    // is not cloneable, and moving it out is what makes closing the pipe
    // possible — which is the second half of the shutdown contract, since EOF on
    // stdin takes the same path through the server loop as the message does.
    let mut stdin = {
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        match guard.child.as_mut() {
            Some(current) => {
                current.requested = true;
                current.stdin.take()
            }
            None => None,
        }
    };

    if let Some(pipe) = stdin.as_mut() {
        let _ = pipe.write_all(b"{\"v\":1,\"t\":\"shutdown\"}\n");
        let _ = pipe.flush();
    }
    // Dropping the handle closes the pipe.
    drop(stdin);

    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        let still_running = {
            let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            guard.child.is_some()
        };
        if !still_running {
            return Ok(());
        }
        if Instant::now() >= deadline {
            // The timeout has to exist, or the window cannot be closed. The cost
            // is real and is stated in the design: a kill mid-turn can leave a
            // session unsendable.
            let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            if let Some(current) = guard.child.as_mut() {
                let _ = current.child.kill();
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// The kill switch, for when the timeout is not enough.
#[tauri::command]
fn runtime_kill(app: AppHandle) -> Result<(), String> {
    let state: State<Bridge> = app.state();
    let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
    match guard.child.as_mut() {
        Some(current) => {
            current.requested = true;
            let _ = current.child.kill();
            let _ = current.child.wait();
            guard.child = None;
            Ok(())
        }
        None => Ok(()),
    }
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
fn runtime_version(binary: String) -> Result<Option<String>, String> {
    let path = if binary.trim().is_empty() {
        resolve_binary(None)?
    } else {
        resolve_binary(Some(&binary))?
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
    let version = text
        .split_whitespace()
        .nth(1)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(version)
}

/// The OS user name, for the greeting. The protocol has no such field, and the
/// greeting omits the name when this returns nothing rather than saying
/// "unknown".
#[tauri::command]
fn os_user_name() -> Option<String> {
    for key in ["USERNAME", "USER", "LOGNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Can the runtime be started in this directory? `None` means yes; otherwise the
/// reason, already written for a person.
///
/// This is the same rule `spawn` applies, exposed so a workspace can be checked
/// **before** it is offered as somewhere to go. Without it, bookmarking the home
/// directory produced a row that looked exactly like a usable one, and pressing
/// it replaced the whole screen with a start-up failure — a refusal the person
/// could have been told about at the moment they chose the directory, when they
/// still had the choice in front of them.
///
/// The rule itself is not duplicated: `unsafe_workspace` is shared, so the
/// pre-check and the actual start cannot drift apart.
#[tauri::command]
fn workspace_check(path: String) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Some("no directory was given".to_string());
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Some(format!("{} is not a directory", dir.display()));
    }
    unsafe_workspace(&dir).map(|kind| {
        format!(
            "{} cannot be used ({kind}): the runtime refuses it, because the file \
             tools' boundary would be the whole machine",
            dir.display()
        )
    })
}

/// One picture written into the workspace, as the front end needs it back.
#[derive(Clone, Serialize)]
struct StashedImage {
    /// The **workspace-relative** path, with forward slashes.
    ///
    /// Relative because that is what the runtime will be handed: the user's
    /// sentence carries this string, `Workspace.SafePath` resolves it against the
    /// child's working directory, and every notice and rendered label shows the
    /// relative form. An absolute path in the prompt would be long, would name
    /// this machine, and would break the moment the workspace moved.
    ///
    /// Forward slashes always: on Windows a backslash in a prompt reads as an
    /// escape character to anybody who copies it into code, and the runtime's
    /// scanner accepts both separators.
    path: String,
    name: String,
    mime: String,
    bytes: usize,
}

/// Which of the accepted formats these bytes really are.
///
/// Decided from the **bytes**, never from the name or the declared type, because
/// both of those are claims. The runtime sniffs the same way
/// (`content.InspectImage`), so a file accepted here is one that layer accepts —
/// which is the point of asking at all rather than letting the refusal arrive a
/// round trip later.
fn sniff_image(bytes: &[u8]) -> Option<&'static ImageSignature> {
    IMAGE_SIGNATURES
        .iter()
        .find(|known| bytes.len() >= known.signature.len() && &bytes[..known.signature.len()] == known.signature)
}

/// Write a pasted picture into the workspace and hand back its path.
///
/// ## Why this command exists at all
///
/// The runtime's only way to receive a picture is a **path in the user's
/// sentence** (`internal/runtime/images.go`: there is no upload command and no
/// markup). A drop already has an absolute path from the OS; a paste does not,
/// because the clipboard carries bytes and a WebView has no filesystem. So the
/// bytes come here, become a file **inside the workspace**, and the front end
/// writes the returned path into the sentence. That is the whole feature.
///
/// ## Why the raw body
///
/// `InvokeBody::Raw`, not a JSON string. Five megabytes as base64 is 6.7MB of
/// text; as a JSON number array it is over 20MB. Tauri supports a raw body on
/// every platform this ships for (windows/amd64, linux/amd64), and the front end
/// passes a `Uint8Array` directly.
///
/// ## What is deliberately not here
///
/// **No width or height.** Measuring a picture means parsing a PNG/JPEG/GIF
/// header, which would be a second image implementation in this file — and the
/// runtime already reports both on its `image_attached` row, measured by the one
/// decoder that exists. Reporting a number this layer guessed is worse than
/// reporting none.
///
/// **No thumbnail.** The runtime's degradation ladder already shrinks a picture
/// before dropping it, and the front end renders its own preview from the bytes
/// it already has. A third copy on disk would be a third thing to keep in step.
///
/// ## Why there is no session argument
///
/// The payload **is** the bytes, so there is nowhere to put a second named
/// argument — `invoke` with a raw body carries no JSON object alongside it. That
/// is a constraint, and it happens to be the right shape anyway: a session
/// subdirectory would only separate files that are all cleared at the same
/// moment (see the staging-area note in `spawn`), and the workspace is taken from
/// the bridge rather than from the caller precisely so that no
/// caller-supplied string ever reaches this path.
#[tauri::command]
fn image_stash(app: AppHandle, request: Request<'_>) -> Result<StashedImage, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // A JSON body means the front end sent a string or an array of numbers.
        // Refused rather than decoded: accepting it would silently double the
        // cost of every paste and leave the fast path unused.
        InvokeBody::Json(_) => {
            return Err("a pasted picture must be sent as raw bytes, not as JSON".to_string())
        }
    };

    if bytes.is_empty() {
        return Err("the clipboard held an empty picture".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "the picture is {} bytes, over the {} byte ceiling for one picture",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }

    let known = sniff_image(&bytes).ok_or_else(|| {
        "the clipboard's image data is not a PNG, JPEG or GIF — those are the three \
         formats this program can measure"
            .to_string()
    })?;
    let (extension, mime) = (known.extension, known.mime);

    // The workspace comes from the bridge — it is the child's working directory,
    // a fact this layer already owns — and never from the caller. Letting a front
    // end name the directory would be letting it choose where a file is written.
    let workspace = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard.workspace.clone()
    };
    let workspace =
        workspace.ok_or("no workspace is open, so there is nowhere to put the picture")?;

    let directory = workspace.join(PASTE_DIR).join(PASTE_SUBDIR);
    fs::create_dir_all(&directory)
        .map_err(|e| format!("could not create {}: {e}", directory.display()))?;

    // The name is generated here, and that is a security property rather than
    // tidiness: the clipboard's own name is attacker-influenced text that can
    // contain a separator or `..`, and it is never used to build this path.
    // Epoch milliseconds keep the names ordered and collision-free in practice;
    // the counter covers two pastes inside the same millisecond.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let mut target = directory.join(format!("paste-{stamp}.{extension}"));
    let mut counter = 1;
    while target.exists() {
        target = directory.join(format!("paste-{stamp}-{counter}.{extension}"));
        counter += 1;
    }

    fs::write(&target, &bytes).map_err(|e| format!("could not write {}: {e}", target.display()))?;

    let relative = target
        .strip_prefix(&workspace)
        .map_err(|_| "the picture was written outside the workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(StashedImage {
        name: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: relative,
        mime: mime.to_string(),
        bytes: bytes.len(),
    })
}

/// The last stderr lines, for the local "the runtime would not start" panel.
#[tauri::command]
fn runtime_stderr(app: AppHandle) -> Vec<String> {
    let state: State<Bridge> = app.state();
    // Bound to a local before returning: the guard borrows `state`, and a
    // `match` used directly as the tail expression would keep its temporary
    // alive past the end of the block.
    let lines = match state.inner.lock() {
        Ok(guard) => guard
            .child
            .as_ref()
            .map(|current| current.stderr.iter().cloned().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    lines
}

/* ============================================================
   Entry point
   ============================================================ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance (decision 12): a second launch focuses the existing
        // window instead of starting a second runtime. The workspace state under
        // `<workspace>/.tudouni/` — permissions, mcp.json, sessions, the audit
        // log, artifacts — is written by both, so two runtimes on one workspace
        // would fight over it.
        //
        // It is registered **before** every other plugin, which the plugin's own
        // documentation requires: its setup creates the hidden window that
        // receives the "a second copy started" message, and a plugin registered
        // earlier would already have run its setup by then.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![
            runtime_attach,
            runtime_attach_listener,
            runtime_send,
            runtime_shutdown,
            runtime_kill,
            runtime_version,
            runtime_stderr,
            os_user_name,
            workspace_check,
            image_stash,
        ])
        .on_window_event(|window, event| {
            // Closing the window asks the runtime to finish first, so a turn in
            // flight is not cut in half.
            //
            // The wait has to come off the event loop. `runtime_shutdown` blocks
            // for up to `SHUTDOWN_TIMEOUT` (30s) polling for the child to exit,
            // and running it here — synchronously, on the thread that pumps
            // window events — freezes the window for that whole time with no
            // repaint and no explanation. The design's own answer is the one
            // below: refuse the close, finish in the background, then close for
            // good.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let window = window.clone();
                let app = window.app_handle().clone();
                thread::spawn(move || {
                    let _ = runtime_shutdown(app);
                    // `destroy` rather than `close`: this is the second pass
                    // through the same event, and re-emitting a close request
                    // would land right back here and refuse it again.
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("the Tauri application failed to start");
}
