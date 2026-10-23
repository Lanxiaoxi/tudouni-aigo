//! Starting the runtime over SSH instead of as a local child.
//!
//! The transport itself lives in [`ssh_backend`]; what is here is the command
//! line the far end is asked to run, the package resolution for the remote
//! install, and the registration of the resulting child in the bridge.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::bridge::Child_;
use crate::bridge::RemoteSshConn;
use crate::bridge::SharedProcess;
use crate::bridge::STDERR_RING;
use crate::bridge::StderrPayload;
use crate::bridge::forward_line;
use crate::remote_files;
use crate::ssh_backend;

/// Options the front end passes to `runtime_attach_remote`.
///
/// This is deliberately a separate type from [`AttachOptions`] rather than
/// one struct with optional SSH fields: `binary`/`workspace` mean something
/// different here (a path and a working directory **on the remote host**,
/// never resolved or validated on this machine), and conflating the two
/// shapes would let a caller accidentally mix a local workspace with a
/// remote connection.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttachOptions {
    /// The SSH host or address to connect to. Never an alias resolved from
    /// `~/.ssh/config` — that resolution is a Workspace Manager concern
    /// (a later phase) and happens before this struct is built; by the time
    /// it reaches this command, `host`/`port`/`user` are the destination
    /// `ssh` itself would have dialled.
    host: String,
    port: u16,
    user: String,
    /// Paths to private key files on **this** machine, tried in order. See
    /// `ssh_backend::authenticate` for the fallback to `password`.
    #[serde(default)]
    identity_files: Vec<String>,
    /// A password, if one is configured for this host. Never logged; see
    /// `ssh_backend::SshTarget`'s own field doc.
    password: Option<String>,
    /// Absolute path to the runtime binary **on the remote host**. Required
    /// — there is no PATH lookup, for the same reason `LocalBackend` never
    /// does one on this side: a different build under the same name is a
    /// different program, and the symptom is a session that exits
    /// immediately with nothing to explain why.
    remote_binary: String,
    /// The workspace **on the remote host** — the directory the runtime
    /// treats as its working directory and, through it, the root the file
    /// tools may touch.
    ///
    /// **Required, and it is what the remote command `cd`s into.**
    /// A non-PTY SSH exec starts in the account's home directory, and the
    /// runtime refuses the home directory as a workspace — so without this the
    /// session died on start-up before it could say anything, whichever
    /// directory the person had chosen. See `build_remote_command`.
    remote_workspace: String,
    session_id: Option<String>,
    max_steps: Option<i64>,
    stream: Option<bool>,
    autopilot: Option<bool>,
    ericai: Option<bool>,
    /// Milliseconds to allow for the TCP connection, the SSH handshake and
    /// authentication together. `None` or `0` means `ssh_backend`'s own
    /// default.
    connect_timeout_ms: Option<u64>,
}

/// Redacted on purpose: the struct carries a password, and a derived `Debug`
/// would put it in any log line that ever formatted these options. Not a
/// theoretical leak — `{:?}` is the obvious way to diagnose a failed attach.
impl std::fmt::Debug for RemoteAttachOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteAttachOptions")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("identity_files", &self.identity_files)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("remote_binary", &self.remote_binary)
            .field("remote_workspace", &self.remote_workspace)
            .field("session_id", &self.session_id)
            .field("max_steps", &self.max_steps)
            .field("stream", &self.stream)
            .field("autopilot", &self.autopilot)
            .field("ericai", &self.ericai)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

/// Finds the bundled release archive for one remote platform, the
/// `remote-packages/` equivalent of `resolve_binary`'s own search —
/// `remote-packages/*.zip` is a `tauri.conf.json` resource, so a packaged
/// build puts it in the same `resources/` directory `resolve_binary` already
/// walks up to find.
///
/// `triple` is the release triple (`x86_64-unknown-linux-musl` or
/// `x86_64-pc-windows-msvc`) — the same string `stage-remote-packages.mjs`
/// names the archive with, so the two never need a separate lookup table to
/// agree on a file name.
pub(crate) fn resolve_remote_package(triple: &str) -> Result<PathBuf, String> {
    if let Ok(from_env) = std::env::var("TUDOUNI_REMOTE_PACKAGES") {
        let dir = PathBuf::from(&from_env);
        if let Some(found) = find_package_in_dir(&dir, triple) {
            return Ok(found);
        }
        return Err(format!(
            "TUDOUNI_REMOTE_PACKAGES points at {from_env}, which has no archive for {triple}"
        ));
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..3 {
            let Some(current) = dir else { break };
            for candidate_dir in [
                current.join("remote-packages"),
                current.join("resources").join("remote-packages"),
            ] {
                if let Some(found) = find_package_in_dir(&candidate_dir, triple) {
                    return Ok(found);
                }
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }

    Err(format!(
        "no bundled release archive was found for {triple}. \
         Run `npm run runtime:stage-remote` after `make release`, \
         or set TUDOUNI_REMOTE_PACKAGES to the directory that holds it."
    ))
}

/// Picks the archive in `dir` whose name ends with `-<triple>.zip` — not an
/// exact name match, because the archive's own name carries the version
/// (`tudouni-aigo-<version>-<triple>.zip`) and this function has no reason
/// to know what version was staged; it takes whichever one is there. A
/// directory holding more than one archive for the same triple (an old
/// staging left behind by a previous version) is not disambiguated here —
/// `stage-remote-packages.mjs` always overwrites rather than accumulates,
/// so this situation does not arise from the normal build path.
fn find_package_in_dir(dir: &Path, triple: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let suffix = format!("-{triple}.zip");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(&suffix) {
            return Some(entry.path());
        }
    }
    None
}

/// The remote twin of [`spawn`]: starts the runtime over SSH instead of as a
/// local child, then reuses the exact same registration and
/// stdout/stderr/wait-thread shape — only how the three streams are obtained
/// differs, and that difference is already isolated behind
/// `ssh_backend::connect` and `Box<dyn ssh_backend::RuntimeProcess>`.
///
/// What this function deliberately does **not** do, because it belongs to a
/// later phase:
///
///   - resolve an `~/.ssh/config` alias — `options` already carries the
///     resolved host/port/user;
///   - verify the remote host key — see `ssh_backend::connect`'s own doc for
///     why that check belongs on the Go side of this project, not duplicated
///     here;
///   - detect, install or upgrade the remote runtime binary — `remote_binary`
///     must already be a verified, absolute path when this is called;
///   - check protocol readiness beyond "the SSH session opened and the
///     command started" — the init-message handshake is a protocol-layer
///     concern the WebView's own client performs once lines start arriving,
///     the same way it already does for a local runtime.
pub(crate) fn spawn_remote(app: &AppHandle, options: &RemoteAttachOptions) -> Result<ChildKey, String> {
    if options.remote_binary.trim().is_empty() {
        return Err("no remote runtime binary path was given".to_string());
    }
    // Refused rather than defaulted, for the same reason the local path refuses
    // a missing workspace: the workspace **is** the file tools' boundary, and
    // there is no honest value to substitute for one the caller did not give.
    // Note this is the remote directory, not a local one — nothing here touches
    // the filesystem of this machine.
    if options.remote_workspace.trim().is_empty() {
        return Err("no remote workspace directory was given".to_string());
    }

    let command = build_remote_command(options);

    let target = ssh_backend::SshTarget {
        host: options.host.clone(),
        port: options.port,
        user: options.user.clone(),
        identity_files: options.identity_files.clone(),
        password: options.password.clone(),
        connect_timeout: Duration::from_millis(options.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000)),
    };

    let (process, stdout, stderr) = ssh_backend::connect(&target, &command)
        .map_err(|e| format!("could not start the remote runtime: {e}"))?;
    let process: SharedProcess = Arc::new(Mutex::new(Box::new(process)));

    // The key is minted and the child registered under the bridge lock, same
    // as the local path. There is no **local** staging directory — a remote
    // child's workspace is on the far host, and its paste area lives there
    // too — but the remote workspace and the SSH destination are recorded so
    // `image_stash` can upload into it and the remote doors can dial it.
    let remote_workspace = options.remote_workspace.trim().to_string();
    let remote_ssh = RemoteSshConn {
        host: options.host.clone(),
        port: options.port,
        user: options.user.clone(),
        identity_files: options.identity_files.clone(),
        password: options.password.clone(),
        connect_timeout: target.connect_timeout,
    };
    let (key, live_slices) = {
        let state: State<Bridge> = app.state();
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard.next_key += 1;
        let key = guard.next_key;
        guard.children.insert(
            key,
            Child_ {
                process,
                requested: false,
                queue: VecDeque::new(),
                stderr: VecDeque::new(),
                workspace: None,
                staging: None,
                remote_workspace: Some(remote_workspace.clone()),
                remote_ssh: Some(remote_ssh.clone()),
            },
        );
        // Which remote children's paste slices belong to somebody: every
        // running remote child in this same remote workspace, including the
        // one just registered. Collected under the same lock as the local
        // sweep's `live` set, so a concurrent start cannot have its slice
        // removed by this sweep.
        let live_slices: Vec<String> = guard
            .children
            .iter()
            .filter(|(_, current)| {
                current.remote_workspace.as_deref() == Some(remote_workspace.as_str())
            })
            .map(|(child_key, _)| child_key.to_string())
            .collect();
        (key, live_slices)
    };

    // Leftovers from finished remote sessions are swept in the background,
    // at the same moment the local sweep runs: a local child is starting,
    // which means the person is working in this workspace, and nothing is in
    // flight for the sessions that are over. The sweep dials its own
    // connection (see `remote_files`' module doc) and never blocks the start.
    {
        let sweep_target = target;
        let sweep_workspace = remote_workspace;
        thread::spawn(move || {
            remote_files::sweep_remote_paste(&sweep_target, &sweep_workspace, &live_slices);
        });
    }

    // ---- stdout: one JSON line at a time, queued until attach ----
    //
    // Identical to spawn()'s own loop, against a `Read` that happens to be
    // backed by the SSH channel's ordinary stream rather than a pipe.
    {
        let app = app.clone();
        thread::spawn(move || {
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
                        forward_line(&app, key, line);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- stderr: drained and kept in a small ring, for diagnostics only ----
    //
    // Identical to spawn()'s own loop; see its comment for why a ring and not
    // a bare drop.
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
                        let _ = app.emit("runtime://stderr", StderrPayload { key, line });
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- wait: report the exit code and whether we asked for it ----
    //
    // The same thread the local path uses; `try_wait` is what hides "poll an
    // SSH channel for EOF and an exit-status exchange" behind the interface
    // "poll a local process" already has.
    crate::launch::spawn_wait_thread(app, key);

    Ok(key)
}

/// Builds the one command line `spawn_remote` asks the SSH session to run.
///
/// # Why this begins with `cd`
///
/// A non-PTY SSH exec starts in the account's **home directory**, and the
/// runtime takes its working directory as the workspace — then refuses the home
/// directory outright (`paths.UnsafeWorkspace`), because `read_file` needs no
/// approval and starting there would hand over `.ssh`, other projects' `.env`
/// files and browser data without anybody being asked twice.
///
/// So without the `cd` below, **every** remote session died on start-up with
/// "this cannot be the workspace: /home/<user> is your home directory", no
/// matter which directory the person had chosen — the one field this command
/// was given, `remote_workspace`, was accepted and then never used. The local
/// path has always set this explicitly (`Command::current_dir`); this is its
/// remote equivalent, and it is the whole reason the remote backend can open
/// anything at all.
///
/// `&&` rather than a plain sequence: if the directory does not exist, `cd`
/// fails, the runtime must not run, and the far end's shell reports the failure
/// as a non-zero exit — which is a session that says why it did not start,
/// rather than one that quietly opened in the home directory. `exec` after the
/// `cd` keeps the channel's process the runtime itself, so `kill` and the exit
/// status still mean what they mean (no extra shell survives underneath).
fn build_remote_command(options: &RemoteAttachOptions) -> String {
    let mut tokens: Vec<String> = Vec::new();

    // The workspace, first and unconditionally. `spawn_remote` refuses an empty
    // one before reaching here, so this is the person's own choice or nothing.
    tokens.push("cd".to_string());
    tokens.push(quote_shell_argument(&options.remote_workspace));
    tokens.push("&&".to_string());
    tokens.push("exec".to_string());

    tokens.push(quote_shell_argument(&options.remote_binary));
    tokens.push("--runtime-stdio".to_string());
    if let Some(id) = options.session_id.as_deref() {
        if !id.is_empty() {
            tokens.push("--session".to_string());
            tokens.push(quote_shell_argument(id));
        }
    }
    if let Some(steps) = options.max_steps {
        if steps > 0 {
            tokens.push("--max-steps".to_string());
            tokens.push(quote_shell_argument(&steps.to_string()));
        }
    }
    if options.stream == Some(true) {
        tokens.push("--stream".to_string());
    }
    if options.autopilot == Some(true) {
        tokens.push("--autopilot".to_string());
    }
    if options.ericai == Some(true) {
        tokens.push("--ericai".to_string());
    }
    tokens.join(" ")
}

/// Quotes one argument for safe inclusion in the command line
/// `ssh_backend::connect` passes to the remote shell.
///
/// Single-quoting is POSIX shells' one truly inert quoting form — nothing
/// inside single quotes is special except a single quote itself — so the
/// only character that needs escaping is the quote character, closed,
/// escaped, and reopened. This mirrors `ssh.QuoteShellArgument` on the Go
/// side exactly, so a workspace path or session id behaves the same way
/// whichever side built the command.
fn quote_shell_argument(argument: &str) -> String {
    let mut out = String::with_capacity(argument.len() + 2);
    out.push('\'');
    for ch in argument.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}
