//! Starting the runtime as a local child process.
//!
//! This is the half of the bridge that owns the pipes: an absolute path to the
//! binary, the workspace as the working directory, a drained stderr, and lines
//! queued until the front end attaches. See `crate`'s module doc for why each
//! of those four is load-bearing.

use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::bridge::Child_;
use crate::bridge::ExitPayload;
use crate::bridge::SharedProcess;
use crate::workspace_staging::PASTE_DIR;
use crate::workspace_staging::PASTE_SUBDIR;
use crate::bridge::STDERR_RING;
use crate::bridge::StderrPayload;
use crate::bridge::forward_line;
use crate::workspace_staging::sweep_staging;
use crate::workspace_staging::unsafe_workspace;
use crate::ssh_backend;

/// How often the wait thread asks whether a child has ended.
///
/// The exit is reported to the WebView from here, so this is the worst-case
/// latency of "the session ended" being painted. 200 ms is imperceptible, and
/// the alternative that was here before (100 ms) doubled the rate at which
/// every session took the process lock for no observable benefit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

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
    /// `--ericai`: manage the session's EricAI token.
    ///
    /// A start-up argument rather than a setting, because that is what the runtime
    /// makes it: `--ericai` decides at open which route this session manages, and a
    /// session switched onto that route later is deliberately *not* taken over
    /// (`internal/runtime/composition.go`, `Options.EricAI`). So the flag has to be
    /// on the command line — passing it in a message would be asking for something
    /// the runtime does not do.
    ///
    /// `None` and `Some(false)` mean the same thing here and that is deliberate:
    /// absent is how a boolean flag is absent, and there is no third state to
    /// express.
    ///
    /// It is **not** defaulted to true anywhere. Turning it on lets this process
    /// rewrite `providers.ericai.api_key` in the person's own configuration and
    /// store a refresh token under `~/.tudouni/`, which is not a thing to do on
    /// somebody's behalf without their asking.
    ericai: Option<bool>,
}

/// Where the runtime binary lives.
///
/// Resolution order:
///   1. `TUDOUNI_RUNTIME` — an explicit override, used by the dev scripts;
///   2. next to the executable (a packaged app puts it in `resources/runtime/`);
///   3. `dist/` in the repository root — development only.
///
/// Never `PATH`: another build there is another program.
pub(crate) fn resolve_binary(explicit: Option<&str>) -> Result<PathBuf, String> {
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

/// Start one child and return the key that names it.
///
/// **It does not touch any other child.** That is the change multi-session
/// needs: this used to kill whatever was running first, because `runtime_attach`
/// meant "restart", which was the only way to change the workspace a single
/// process was in. Now each call adds a session beside the others, and the
/// caller gets back a key it can send to, wait on, and shut down.
///
/// Ending a session is therefore a separate act (`runtime_shutdown`), and
/// nothing here reaches for it implicitly. A session that is running a turn when
/// somebody opens another one keeps its turn.
pub(crate) fn spawn(
    app: &AppHandle,
    options: &AttachOptions,
) -> Result<ChildKey, String> {
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
    // Present or absent, like `--stream`: a boolean flag given a value would have
    // to be spelled `--ericai=true`, and it is never given one.
    if options.ericai == Some(true) {
        command.arg("--ericai");
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
    let process: SharedProcess =
        Arc::new(Mutex::new(Box::new(ssh_backend::LocalRuntimeProcess::new(child, stdin))));

    // The key is minted and the child registered under the bridge lock, so
    // `image_stash` can never observe a child whose workspace has not been
    // recorded yet.
    let (key, live_staging) = {
        let state: State<Bridge> = app.state();
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard.next_key += 1;
        let key = guard.next_key;

        // This child's own slice of the staging area. Per key, so that clearing
        // one session's leftovers cannot take a picture another session is
        // about to send.
        let staging = workspace
            .join(PASTE_DIR)
            .join(PASTE_SUBDIR)
            .join(key.to_string());

        guard.children.insert(
            key,
            Child_ {
                process,
                requested: false,
                queue: VecDeque::new(),
                stderr: VecDeque::new(),
                workspace: Some(workspace.clone()),
                staging: Some(staging.clone()),
                remote_workspace: None,
                remote_ssh: None,
                remote_binary: None,
            },
        );

        // Which staging directories belong to somebody: every live child's, plus
        // the one just registered. Collected under the same lock so a concurrent
        // start cannot have its directory removed by this sweep. A remote
        // child contributes nothing here — its `staging` is `None` — since it
        // has no local staging directory to protect.
        let live: HashSet<PathBuf> = guard
            .children
            .values()
            .filter_map(|current| current.staging.clone())
            .collect();
        (key, live)
    };

    // Leftovers from runs that are over are swept now, and this is the only
    // moment it is safe to do so: nothing is in flight for those sessions, and no
    // draft refers to them.
    //
    // What makes clearing safe at all is that the directory is a **staging area
    // and not the storage**. A picture that was sent has already been copied into
    // the runtime's content-addressed artifact store
    // (`<workspace>/.tudouni/artifacts/<session>/`), which is what the session
    // file references and what `/resume` reads back; the file here is only what
    // the path in the sentence pointed at when the turn ran. So a stale path in
    // an old session resolves to nothing, and the runtime's scanner treats a word
    // that names no file as a word — which is exactly what it does for any path a
    // person typed that has since been deleted.
    //
    // Without this, every screenshot anyone ever pasted would stay in the
    // workspace for the life of the project.
    sweep_staging(app, &workspace, &live_staging);

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
                        // The key is the only thing that says whose line this is.
                        // `session_load` and `ui` carry no `session_id`, so a
                        // front end that tried to read attribution off the
                        // payload would get it wrong for exactly the messages
                        // that matter most.
                        forward_line(&app, key, line);
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
                            if let Some(current) = guard.children.get_mut(&key) {
                                if current.stderr.len() >= STDERR_RING {
                                    current.stderr.pop_front();
                                }
                                current.stderr.push_back(line.clone());
                            }
                        }
                        // Diagnostics, not business data: a separate channel.
                        let _ = app.emit("runtime://stderr", StderrPayload { key, line });
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- wait: report the exit code and whether we asked for it ----
    spawn_wait_thread(app, key);

    Ok(key)
}

/// Starts the one thread that reports a child's exit, for either backend.
///
/// This is the only place a child is reaped, which is why `runtime_shutdown`
/// polls instead of calling `wait()`: two waiters on one handle would race.
///
/// **The bridge lock is never held across `try_wait`.** `try_wait` takes the
/// process's own lock and, for a remote child, can touch the SSH channel; the
/// bridge lock is what every session, every reader and the resource panel need.
/// The handle is cloned out under the bridge lock and polled after releasing
/// it, so one slow connection cannot stall the rest of the app.
///
/// The slot is removed here and only here (or by `runtime_kill`), so membership
/// in `children` means "this session has a process right now". A caller that
/// acts on a key the bridge no longer holds is told so rather than being
/// silently answered by a newer session.
pub(crate) fn spawn_wait_thread(app: &AppHandle, key: ChildKey) {
    let app = app.clone();
    thread::spawn(move || {
        let outcome = loop {
            // Clone the handle out, then drop the bridge lock.
            let process = {
                let state: State<Bridge> = app.state();
                let guard = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => break None,
                };
                match guard.children.get(&key) {
                    Some(current) => current.process.clone(),
                    // Already reaped or killed: nothing to say.
                    None => break None,
                }
            };

            let waited = {
                let mut process = match process.lock() {
                    Ok(process) => process,
                    Err(_) => break None,
                };
                process.try_wait()
            };

            match waited {
                Ok(Some(code)) => {
                    let requested = {
                        let state: State<Bridge> = app.state();
                        let mut guard = match state.inner.lock() {
                            Ok(guard) => guard,
                            Err(_) => break None,
                        };
                        match guard.children.remove(&key) {
                            Some(current) => current.requested,
                            // `runtime_kill` removed it while we were polling.
                            None => break None,
                        }
                    };
                    break Some((code, requested));
                }
                Ok(None) => {}
                Err(_) => {
                    let state: State<Bridge> = app.state();
                    let mut guard = match state.inner.lock() {
                        Ok(guard) => guard,
                        Err(_) => break None,
                    };
                    if guard.children.remove(&key).is_none() {
                        break None;
                    }
                    break Some((-1, false));
                }
            }
            thread::sleep(EXIT_POLL_INTERVAL);
        };

        if let Some((code, requested)) = outcome {
            // The runtime never sends `runtime_exited` itself — in the Go client
            // it is the client's own synthesized message, and this is its
            // equivalent. `requested` is not optional: a requested shutdown and
            // a crash both exit with code 0, so it is the only thing that tells
            // "the session ended" from "the runtime died".
            let _ = app.emit("runtime://exited", ExitPayload { key, code, requested });
        }
    });
}
