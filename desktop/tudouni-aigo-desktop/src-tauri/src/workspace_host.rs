//! The Workspace Host registry: one `--workspace-host` process per workspace.
//!
//! A session's runtime (`launch.rs` / `launch_remote.rs`) lives and dies with
//! its conversation. The Workspace Dock's resources (files, git, terminals)
//! must not, so they are served by a second kind of child that is keyed by the
//! **workspace** instead of by a session: `tudouni-aigo --workspace-host
//! --workspace-id <id> --root <dir>`, speaking the JSONL protocol in
//! `docs/spec/workspace-host-protocol.md`. This module is the "RuntimeHost" of
//! `docs/design/workspace-dock.md` §3.1.1.
//!
//! Like `bridge.rs`, it moves bytes and never parses the protocol: whole lines
//! go to the WebView as `workspace-host://line` events and whole lines come
//! back through `host_send`. Reading `t` here would be a second definition of
//! the protocol, and the cross-language test exists to keep exactly one.
//!
//! # Events
//!
//! | event                    | payload                              |
//! |--------------------------|--------------------------------------|
//! | `workspace-host://line`  | `{workspace_id, line}`               |
//! | `workspace-host://exit`  | `{workspace_id, code, reason}`       |
//! | `workspace-host://stderr`| `{workspace_id, line}`               |
//!
//! `reason` is `"shutdown"` (we asked), `"ssh_closed"` (a remote host that went
//! away unasked) or `"exited"` (a local host that ended unasked).
//!
//! **There is no queue before the front end listens**, unlike `bridge.rs`.
//! The front end registers its three listeners once and only then calls
//! `host_attach`, so `host_init` cannot be emitted into the void; a queue here
//! would be machinery for a race that the caller's ordering already removes.
//!
//! # Local and remote
//!
//! Local: the same binary the desktop launches for `--runtime-stdio`
//! ([`crate::launch::resolve_binary`]), started with `CREATE_NO_WINDOW`.
//! Remote: another exec channel on a freshly dialled ssh2 session
//! ([`crate::ssh_backend::connect`]) running the **remote** binary the saved
//! workspace entry names — the same `cd <root> && exec <binary> …` shape
//! `launch_remote::build_remote_command` uses, because a non-PTY exec starts in
//! the home directory and the host (like the runtime) must not.
//!
//! # Identity and races
//!
//! The registry is keyed by `workspace_id`. Every start gets a **generation**,
//! so the wait thread of a host that was replaced cannot remove its
//! successor's entry, and a stale reader cannot emit a line that belongs to a
//! dead process. A start in flight holds a `Starting` slot, which is what makes
//! `host_attach` idempotent even when two calls race.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::SharedProcess;
use crate::launch::resolve_binary;
use crate::ssh_backend::{self, LocalRuntimeProcess, SshTarget};
use crate::workspace_staging::unsafe_workspace;

pub(crate) const EVENT_LINE: &str = "workspace-host://line";
pub(crate) const EVENT_EXIT: &str = "workspace-host://exit";
pub(crate) const EVENT_STDERR: &str = "workspace-host://stderr";

/// How often the wait thread asks whether a host has ended. Same cadence (and
/// the same reasoning) as `launch::EXIT_POLL_INTERVAL`.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// How long a host is given to leave after `shutdown` before it is killed.
///
/// Far shorter than a session's 30 s: a host has no turn to finish. It has to
/// end its terminals and exit, and a person closing the window is waiting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// How long to wait for the wait thread to notice a kill before the exit is
/// reported from here instead.
const KILL_GRACE: Duration = Duration::from_secs(2);

const SHUTDOWN_POLL: Duration = Duration::from_millis(50);

/* ============================================================
   Pure parts: arguments, validation, reasons
   ============================================================ */

/// A workspace id is chosen by the desktop (`src/workspaceHost/workspaceId.ts`)
/// and ends up on a command line, so it is checked rather than trusted. It may
/// be any printable text — `local:<hash>` and `rw-<…>` today — but never empty
/// and never able to break a line or a shell word apart.
pub(crate) fn validate_workspace_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("the workspace id is empty".to_string());
    }
    if id.len() > 256 {
        return Err("the workspace id is longer than 256 bytes".to_string());
    }
    if id.chars().any(|c| c.is_control()) {
        return Err("the workspace id contains a control character".to_string());
    }
    Ok(())
}

/// The argv (without the program) of a local host.
pub(crate) fn host_args(workspace_id: &str, root: &str) -> Vec<String> {
    vec![
        "--workspace-host".to_string(),
        "--workspace-id".to_string(),
        workspace_id.to_string(),
        "--root".to_string(),
        root.to_string(),
    ]
}

/// The one command line a remote host is asked to run.
///
/// `cd` first and `&&` for the reasons `launch_remote::build_remote_command`
/// gives at length: an exec channel starts in `$HOME`, a missing directory must
/// fail the command instead of quietly running somewhere else, and `exec` keeps
/// the channel's process the host itself. Every token is single-quoted by the
/// same quoting the rest of the remote code uses.
pub(crate) fn remote_host_command(binary: &str, workspace_id: &str, root: &str) -> String {
    use crate::remote_install::q;
    [
        "cd".to_string(),
        q(root),
        "&&".to_string(),
        "exec".to_string(),
        q(binary),
        "--workspace-host".to_string(),
        "--workspace-id".to_string(),
        q(workspace_id),
        "--root".to_string(),
        q(root),
    ]
    .join(" ")
}

/// Why a host ended, for the front end's "disconnected" banner.
pub(crate) fn exit_reason(remote: bool, requested: bool) -> &'static str {
    if requested {
        "shutdown"
    } else if remote {
        "ssh_closed"
    } else {
        "exited"
    }
}

/// Splits a byte stream into non-empty lines, whatever the line ending.
///
/// `read_until` rather than a fixed buffer, as in `launch::spawn`: a
/// `fs_read_bytes` result or a terminal replay is one line and can be
/// megabytes.
fn pump_lines<R: Read>(reader: R, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
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
                on_line(line);
            }
            Err(_) => break,
        }
    }
}

/* ============================================================
   Payloads and command arguments
   ============================================================ */

#[derive(Clone, Serialize)]
pub(crate) struct HostLinePayload {
    pub(crate) workspace_id: String,
    pub(crate) line: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct HostExitPayload {
    pub(crate) workspace_id: String,
    pub(crate) code: i32,
    pub(crate) reason: &'static str,
}

/// What `host_attach` answers. `already_running` is also true while another
/// attach for the same workspace is still starting its process: the caller
/// waits for `host_init` either way.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub(crate) struct HostAttachResult {
    pub(crate) already_running: bool,
    /// The host's first stdout line, when it is already running and has spoken.
    ///
    /// The spec makes that line `host_init`, and a client that attaches to a
    /// host somebody else started (a reloaded WebView, a second client) would
    /// otherwise wait for a handshake that was emitted before it existed. It is
    /// replayed verbatim and **not** inspected here — the client checks `t`.
    /// Absent for a fresh start and for a host that has not spoken yet (its
    /// `host_init` is still to arrive as an event).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) init_line: Option<String>,
}

/// One row of `host_list`.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub(crate) struct HostInfo {
    pub(crate) workspace_id: String,
    pub(crate) root: String,
    pub(crate) remote: bool,
    pub(crate) remote_workspace_id: Option<String>,
    pub(crate) pid: Option<u32>,
    pub(crate) generation: u64,
}

/// How to reach the far host of a remote workspace. The camelCase mirror of the
/// connection half of `launch_remote::RemoteAttachOptions`.
///
/// It travels with `host_attach` because the Rust side does not own saved
/// workspaces: the saved entry and its host live in the front end's store (the
/// session bridge is given the same fields at `runtime_attach_remote`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnection {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    /// Absolute path to the runtime binary **on the remote host**.
    remote_binary: String,
    connect_timeout_ms: Option<u64>,
}

/// Redacted on purpose, for the reason `RemoteAttachOptions`' `Debug` is: the
/// struct carries a password and `{:?}` is the obvious way to log a failure.
impl std::fmt::Debug for HostConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostConnection")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("identity_files", &self.identity_files)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("remote_binary", &self.remote_binary)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

/* ============================================================
   The registry
   ============================================================ */

struct HostEntry {
    process: SharedProcess,
    generation: u64,
    /// True once we asked it to end, so its exit is reported as a shutdown.
    requested: bool,
    root: String,
    remote: bool,
    remote_workspace_id: Option<String>,
    pid: Option<u32>,
    /// The first line the host wrote, kept for `HostAttachResult::init_line`.
    opening: Option<String>,
}

enum Slot {
    /// A start is in flight. Held so a second `host_attach` neither spawns a
    /// second process nor reports a failure.
    Starting { generation: u64 },
    Running(HostEntry),
}

#[derive(Default)]
struct RegistryState {
    hosts: HashMap<String, Slot>,
    next_generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Begin {
    AlreadyRunning,
    Claimed(u64),
}

/// A host picked for shutdown, with everything needed to finish it off without
/// holding the registry lock.
struct ShutdownTarget {
    workspace_id: String,
    generation: u64,
    process: SharedProcess,
}

impl RegistryState {
    fn begin(&mut self, workspace_id: &str) -> Begin {
        if self.hosts.contains_key(workspace_id) {
            return Begin::AlreadyRunning;
        }
        self.next_generation += 1;
        let generation = self.next_generation;
        self.hosts
            .insert(workspace_id.to_string(), Slot::Starting { generation });
        Begin::Claimed(generation)
    }

    /// Turns a claimed slot into a running one. False when the claim is gone,
    /// which cannot happen while the claimant holds it, but is answered rather
    /// than assumed.
    fn commit(&mut self, workspace_id: &str, entry: HostEntry) -> bool {
        match self.hosts.get(workspace_id) {
            Some(Slot::Starting { generation }) if *generation == entry.generation => {
                self.hosts
                    .insert(workspace_id.to_string(), Slot::Running(entry));
                true
            }
            _ => false,
        }
    }

    /// Gives up a claim whose start failed.
    fn abort(&mut self, workspace_id: &str, generation: u64) {
        if matches!(
            self.hosts.get(workspace_id),
            Some(Slot::Starting { generation: g }) if *g == generation
        ) {
            self.hosts.remove(workspace_id);
        }
    }

    fn process_of(&self, workspace_id: &str) -> Option<SharedProcess> {
        match self.hosts.get(workspace_id) {
            Some(Slot::Running(entry)) => Some(entry.process.clone()),
            _ => None,
        }
    }

    fn is_current(&self, workspace_id: &str, generation: u64) -> bool {
        matches!(
            self.hosts.get(workspace_id),
            Some(Slot::Running(entry)) if entry.generation == generation
        )
    }

    /// Remembers the first line of this generation's host, once. Returns whether
    /// the line belongs to a live host (and so is to be emitted): the check and
    /// the write share one lock acquisition on the hot path.
    fn note_line(&mut self, workspace_id: &str, generation: u64, line: &str) -> bool {
        match self.hosts.get_mut(workspace_id) {
            Some(Slot::Running(entry)) if entry.generation == generation => {
                if entry.opening.is_none() {
                    entry.opening = Some(line.to_string());
                }
                true
            }
            _ => false,
        }
    }

    fn opening_of(&self, workspace_id: &str) -> Option<String> {
        match self.hosts.get(workspace_id) {
            Some(Slot::Running(entry)) => entry.opening.clone(),
            _ => None,
        }
    }

    /// Removes the entry only if it is still this generation's. Returns what
    /// the exit report needs.
    fn remove_if_current(&mut self, workspace_id: &str, generation: u64) -> Option<(bool, bool)> {
        if !self.is_current(workspace_id, generation) {
            return None;
        }
        match self.hosts.remove(workspace_id) {
            Some(Slot::Running(entry)) => Some((entry.requested, entry.remote)),
            _ => None,
        }
    }

    /// Marks hosts as asked-to-end and hands back what is needed to end them.
    /// `only` names one workspace; `None` means every running host.
    fn take_for_shutdown(&mut self, only: Option<&str>) -> Vec<ShutdownTarget> {
        let mut targets = Vec::new();
        for (workspace_id, slot) in self.hosts.iter_mut() {
            if let Some(only) = only {
                if only != workspace_id {
                    continue;
                }
            }
            if let Slot::Running(entry) = slot {
                entry.requested = true;
                targets.push(ShutdownTarget {
                    workspace_id: workspace_id.clone(),
                    generation: entry.generation,
                    process: entry.process.clone(),
                });
            }
        }
        targets
    }

    fn list(&self) -> Vec<HostInfo> {
        let mut rows: Vec<HostInfo> = self
            .hosts
            .iter()
            .filter_map(|(workspace_id, slot)| match slot {
                Slot::Running(entry) => Some(HostInfo {
                    workspace_id: workspace_id.clone(),
                    root: entry.root.clone(),
                    remote: entry.remote,
                    remote_workspace_id: entry.remote_workspace_id.clone(),
                    pid: entry.pid,
                    generation: entry.generation,
                }),
                Slot::Starting { .. } => None,
            })
            .collect();
        rows.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        rows
    }
}

/// Managed state: the workspaces that currently have a host process.
#[derive(Default)]
pub(crate) struct WorkspaceHostRegistry {
    inner: Mutex<RegistryState>,
}

impl WorkspaceHostRegistry {
    /// A poisoned lock is recovered rather than propagated: the state is a map
    /// of handles, a panic in some other thread cannot leave it half-updated in
    /// a way that matters, and refusing every later call would turn one crash
    /// into a registry that can never shut anything down.
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/* ============================================================
   Starting a host
   ============================================================ */

/// A started process and its two output streams, local or remote.
struct Started {
    process: SharedProcess,
    stdout: Box<dyn Read + Send>,
    stderr: Box<dyn Read + Send>,
    remote: bool,
    pid: Option<u32>,
}

fn start_local(workspace_id: &str, root: &str) -> Result<Started, String> {
    let binary = resolve_binary(None)?;
    let dir = PathBuf::from(root);
    if !dir.is_dir() {
        return Err(format!("the workspace {} is not a directory", dir.display()));
    }
    // The same refusal `launch::spawn` applies, so the Dock cannot open a host
    // (and a file tree, and a shell) on the home directory or a volume root
    // that a session would have been refused.
    if let Some(kind) = unsafe_workspace(&dir) {
        return Err(format!(
            "the workspace {} cannot be used ({kind})",
            dir.display()
        ));
    }

    let mut command = Command::new(&binary);
    command
        .args(host_args(workspace_id, root))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // A pipe, never `null`: an undrained stderr pipe would stall the host
        // once it fills, and its reason for exiting is written there.
        .stderr(Stdio::piped());

    // The host is a console program and the parent is a GUI: without this
    // Windows mints a console window that stays up for the host's whole life.
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", binary.display()))?;
    let pid = Some(child.id());
    let stdin = child.stdin.take().ok_or("the host has no stdin")?;
    let stdout = child.stdout.take().ok_or("the host has no stdout")?;
    let stderr = child.stderr.take().ok_or("the host has no stderr")?;
    let process: SharedProcess = Arc::new(Mutex::new(Box::new(LocalRuntimeProcess::new(
        child, stdin,
    ))));
    Ok(Started {
        process,
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
        remote: false,
        pid,
    })
}

fn start_remote(
    workspace_id: &str,
    root: &str,
    connection: &HostConnection,
) -> Result<Started, String> {
    // No PATH lookup and no default, for the reason `spawn_remote` gives: a
    // different build under the same name is a different program. An empty
    // path means "not installed yet", which the front end's connect flow
    // repairs (installs) before it ever asks for a host.
    if connection.remote_binary.trim().is_empty() {
        return Err("no remote runtime binary path was given".to_string());
    }
    let command = remote_host_command(connection.remote_binary.trim(), workspace_id, root);
    let target = SshTarget {
        host: connection.host.clone(),
        port: connection.port,
        user: connection.user.clone(),
        identity_files: connection.identity_files.clone(),
        password: connection.password.clone(),
        connect_timeout: Duration::from_millis(
            connection
                .connect_timeout_ms
                .filter(|&ms| ms > 0)
                .unwrap_or(15_000),
        ),
    };
    let (process, stdout, stderr) = ssh_backend::connect(&target, &command)
        .map_err(|e| format!("could not start the remote workspace host: {e}"))?;
    let process: SharedProcess = Arc::new(Mutex::new(Box::new(process)));
    Ok(Started {
        process,
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
        remote: true,
        pid: None,
    })
}

fn registry_of(app: &AppHandle) -> State<'_, WorkspaceHostRegistry> {
    app.state::<WorkspaceHostRegistry>()
}

fn attach_blocking(
    app: &AppHandle,
    workspace_id: String,
    root: String,
    remote_workspace_id: Option<String>,
    connection: Option<HostConnection>,
) -> Result<HostAttachResult, String> {
    validate_workspace_id(&workspace_id)?;
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("the workspace root is empty".to_string());
    }

    let registry = registry_of(app);
    let generation = {
        let mut guard = registry.lock();
        match guard.begin(&workspace_id) {
            Begin::AlreadyRunning => {
                let init_line = guard.opening_of(&workspace_id);
                return Ok(HostAttachResult { already_running: true, init_line });
            }
            Begin::Claimed(generation) => generation,
        }
    };

    let started = match &remote_workspace_id {
        None => start_local(&workspace_id, &root),
        Some(_) => match &connection {
            Some(connection) => start_remote(&workspace_id, &root, connection),
            None => Err("a remote workspace needs its connection to start a host".to_string()),
        },
    };
    let started = match started {
        Ok(started) => started,
        Err(error) => {
            registry.lock().abort(&workspace_id, generation);
            return Err(error);
        }
    };

    let entry = HostEntry {
        process: started.process.clone(),
        generation,
        requested: false,
        root,
        remote: started.remote,
        remote_workspace_id,
        pid: started.pid,
        opening: None,
    };
    if !registry.lock().commit(&workspace_id, entry) {
        // Nobody can have taken the claim, but a process with no registry entry
        // would be one nothing could ever end — so it ends here.
        if let Ok(mut process) = started.process.lock() {
            let _ = process.kill();
            process.wait_after_kill();
        }
        return Err("the workspace host registry lost its claim".to_string());
    }

    start_io_threads(
        app,
        &workspace_id,
        generation,
        started.stdout,
        started.stderr,
        started.remote,
    );
    Ok(HostAttachResult { already_running: false, init_line: None })
}

fn start_io_threads(
    app: &AppHandle,
    workspace_id: &str,
    generation: u64,
    stdout: Box<dyn Read + Send>,
    stderr: Box<dyn Read + Send>,
    remote: bool,
) {
    {
        let app = app.clone();
        let id = workspace_id.to_string();
        thread::spawn(move || {
            pump_lines(stdout, |line| {
                // A line from a host that has since been replaced belongs to
                // nobody; the new host's `host_init` must not be preceded by
                // the old one's tail.
                if registry_of(&app).lock().note_line(&id, generation, &line) {
                    let _ = app.emit(
                        EVENT_LINE,
                        HostLinePayload { workspace_id: id.clone(), line },
                    );
                }
            });
        });
    }
    {
        let app = app.clone();
        let id = workspace_id.to_string();
        thread::spawn(move || {
            // Diagnostics only, and never queued: nothing here is business data.
            pump_lines(stderr, |line| {
                let _ = app.emit(
                    EVENT_STDERR,
                    HostLinePayload { workspace_id: id.clone(), line },
                );
            });
        });
    }
    spawn_wait_thread(app, workspace_id, generation, remote);
}

/// The one place a host is reaped (besides the forced path in
/// [`shutdown_hosts_blocking`], which goes through the same [`finish_exit`]).
///
/// The registry lock is never held across `try_wait`: that takes the process's
/// own lock and, for a remote host, can touch the ssh channel. The handle is
/// cloned out first, as `launch::spawn_wait_thread` does.
fn spawn_wait_thread(app: &AppHandle, workspace_id: &str, generation: u64, _remote: bool) {
    let app = app.clone();
    let id = workspace_id.to_string();
    thread::spawn(move || loop {
        let process = {
            let registry = registry_of(&app);
            let guard = registry.lock();
            match guard.hosts.get(&id) {
                Some(Slot::Running(entry)) if entry.generation == generation => {
                    entry.process.clone()
                }
                // Already finished (forced path) or replaced: nothing to say.
                _ => return,
            }
        };
        let waited = match process.lock() {
            Ok(mut process) => process.try_wait(),
            Err(_) => Ok(Some(-1)),
        };
        match waited {
            Ok(Some(code)) => {
                finish_exit(&app, &id, generation, code);
                return;
            }
            Ok(None) => {}
            // A wait that errors is a channel that is gone; -1 is the code the
            // session bridge uses for the same situation.
            Err(_) => {
                finish_exit(&app, &id, generation, -1);
                return;
            }
        }
        thread::sleep(EXIT_POLL_INTERVAL);
    });
}

/// Removes the entry (if it is still this generation's) and reports the exit.
/// Whoever removes it reports it, so an exit is emitted exactly once.
fn finish_exit(app: &AppHandle, workspace_id: &str, generation: u64, code: i32) {
    let removed = registry_of(app)
        .lock()
        .remove_if_current(workspace_id, generation);
    if let Some((requested, remote)) = removed {
        let _ = app.emit(
            EVENT_EXIT,
            HostExitPayload {
                workspace_id: workspace_id.to_string(),
                code,
                reason: exit_reason(remote, requested),
            },
        );
    }
}

/* ============================================================
   Shutdown
   ============================================================ */

fn wait_until_gone(app: &AppHandle, targets: &[&ShutdownTarget], deadline: Instant) {
    let registry = registry_of(app);
    loop {
        let any_left = {
            let guard = registry.lock();
            targets
                .iter()
                .any(|t| guard.is_current(&t.workspace_id, t.generation))
        };
        if !any_left || Instant::now() >= deadline {
            return;
        }
        thread::sleep(SHUTDOWN_POLL);
    }
}

/// Ends one host (`only = Some(id)`) or every host (`None`), politely first.
///
/// `shutdown` is written to each; they are given [`SHUTDOWN_GRACE`] to leave as
/// one group (not one budget per host: N hosts must not mean N×3 s on the way
/// out of the app), and whatever is left is killed. A host that is not running
/// is not an error — closing a workspace twice is not a fault.
pub(crate) fn shutdown_hosts_blocking(app: &AppHandle, only: Option<&str>) {
    let targets = registry_of(app).lock().take_for_shutdown(only);
    if targets.is_empty() {
        return;
    }

    for target in &targets {
        // Outside the registry lock: a remote write can wait out the ssh write
        // timeout. A failure is reported by the exit path.
        if let Ok(mut process) = target.process.lock() {
            let _ = process.shutdown();
        }
    }

    let all: Vec<&ShutdownTarget> = targets.iter().collect();
    wait_until_gone(app, &all, Instant::now() + SHUTDOWN_GRACE);

    let registry = registry_of(app);
    let stragglers: Vec<&ShutdownTarget> = {
        let guard = registry.lock();
        targets
            .iter()
            .filter(|t| guard.is_current(&t.workspace_id, t.generation))
            .collect()
    };
    if stragglers.is_empty() {
        return;
    }
    for target in &stragglers {
        if let Ok(mut process) = target.process.lock() {
            let _ = process.kill();
            process.wait_after_kill();
        }
    }
    wait_until_gone(app, &stragglers, Instant::now() + KILL_GRACE);
    // The wait thread normally reports a killed host. If it did not (a remote
    // channel that never reports EOF), the exit is reported from here so the
    // front end is never left believing a host it killed is still connected.
    for target in &stragglers {
        finish_exit(app, &target.workspace_id, target.generation, -1);
    }
}

/// The app is leaving: end every host. Called from the paths that already end
/// every session (`runtime_commands::shutdown_blocking` with no key) and from
/// the run loop's `Exit` event as the backstop.
pub(crate) fn shutdown_all_blocking(app: &AppHandle) {
    shutdown_hosts_blocking(app, None);
}

/* ============================================================
   Commands
   ============================================================ */

/// Start the host for one workspace, unless one is already running.
///
/// **Idempotent**: a second call for a running (or starting) workspace does
/// nothing and says so, which is what lets every component that needs the Dock
/// call it without coordinating. The caller must have registered the
/// `workspace-host://*` listeners first (see the module doc).
///
/// `remote_workspace_id` is `Some` for a remote workspace, in which case
/// `connection` says how to reach it and `root` is the directory **on the far
/// host**; for a local one `root` is a directory on this machine.
///
/// `async` + `spawn_blocking` for the reason `runtime_attach` gives: a remote
/// start dials ssh and a local one spawns a process, and a synchronous command
/// would run that on the thread that pumps the window's events.
#[tauri::command]
pub(crate) async fn host_attach(
    app: AppHandle,
    workspace_id: String,
    root: String,
    remote_workspace_id: Option<String>,
    connection: Option<HostConnection>,
) -> Result<HostAttachResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        attach_blocking(&app, workspace_id, root, remote_workspace_id, connection)
    })
    .await
    .map_err(|error| format!("the workspace host start task failed: {error}"))?
}

/// Write one protocol line to one workspace's host. The line arrives already
/// encoded (including `v`); nothing here parses it.
///
/// The process handle is cloned out under the registry lock and written to
/// after releasing it, like `runtime_send`: a wedged remote connection must not
/// hold the lock every other workspace needs.
#[tauri::command]
pub(crate) async fn host_send(
    app: AppHandle,
    workspace_id: String,
    line: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let process = registry_of(&app)
            .lock()
            .process_of(&workspace_id)
            .ok_or("that workspace's host is not running")?;
        let mut process = process
            .lock()
            .map_err(|_| "the workspace host lock is poisoned")?;
        process
            .write_line(&line)
            .map_err(|e| format!("could not write to the workspace host: {e}"))
    })
    .await
    .map_err(|error| format!("the workspace host send task failed: {error}"))?
}

/// End one workspace's host: `shutdown`, a short wait, then a kill. A host that
/// is not running is a success.
#[tauri::command]
pub(crate) async fn host_shutdown(app: AppHandle, workspace_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        shutdown_hosts_blocking(&app, Some(&workspace_id));
    })
    .await
    .map_err(|error| format!("the workspace host shutdown task failed: {error}"))
}

/// The running hosts, sorted by workspace id.
#[tauri::command]
pub(crate) fn host_list(registry: State<'_, WorkspaceHostRegistry>) -> Vec<HostInfo> {
    registry.lock().list()
}

/* ============================================================
   Tests: the pure parts and the registry's bookkeeping
   ============================================================ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_backend::RuntimeProcess;

    /// A process that does nothing: the registry never looks inside one.
    struct Fake {
        pid: Option<u32>,
    }

    impl RuntimeProcess for Fake {
        fn pid(&self) -> Option<u32> {
            self.pid
        }
        fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
            Ok(None)
        }
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn write_line(&mut self, _line: &str) -> std::io::Result<()> {
            Ok(())
        }
        fn wait_after_kill(&mut self) {}
        fn shutdown(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn entry(generation: u64, root: &str, remote_id: Option<&str>) -> HostEntry {
        HostEntry {
            process: Arc::new(Mutex::new(Box::new(Fake { pid: Some(7) }))),
            generation,
            requested: false,
            root: root.to_string(),
            remote: remote_id.is_some(),
            remote_workspace_id: remote_id.map(str::to_string),
            pid: Some(7),
            opening: None,
        }
    }

    fn started(state: &mut RegistryState, id: &str, root: &str) -> u64 {
        match state.begin(id) {
            Begin::Claimed(generation) => {
                assert!(state.commit(id, entry(generation, root, None)));
                generation
            }
            Begin::AlreadyRunning => panic!("{id} was already present"),
        }
    }

    #[test]
    fn local_args_are_the_documented_flags() {
        assert_eq!(
            host_args("local:abc", r"C:\work\app"),
            vec!["--workspace-host", "--workspace-id", "local:abc", "--root", r"C:\work\app"]
        );
    }

    #[test]
    fn remote_command_cds_first_and_quotes_every_value() {
        let command = remote_host_command("/home/u/.tudouni/bin/tudouni-aigo", "rw-1", "/srv/my app");
        assert_eq!(
            command,
            "cd '/srv/my app' && exec '/home/u/.tudouni/bin/tudouni-aigo' \
             --workspace-host --workspace-id 'rw-1' --root '/srv/my app'"
        );
    }

    #[test]
    fn remote_command_neutralises_single_quotes() {
        let command = remote_host_command("/bin/x", "rw-1", "/srv/it's");
        assert!(command.starts_with("cd '/srv/it'\\''s' && exec"), "{command}");
        assert!(command.ends_with("--root '/srv/it'\\''s'"), "{command}");
    }

    #[test]
    fn workspace_ids_are_checked() {
        assert!(validate_workspace_id("local:0123456789abcdef").is_ok());
        assert!(validate_workspace_id("rw-mq1x2y-ab12cd").is_ok());
        assert!(validate_workspace_id("").is_err());
        assert!(validate_workspace_id("   ").is_err());
        assert!(validate_workspace_id("a\nb").is_err());
        assert!(validate_workspace_id(&"x".repeat(257)).is_err());
    }

    #[test]
    fn exit_reasons() {
        assert_eq!(exit_reason(false, true), "shutdown");
        assert_eq!(exit_reason(true, true), "shutdown");
        assert_eq!(exit_reason(true, false), "ssh_closed");
        assert_eq!(exit_reason(false, false), "exited");
    }

    #[test]
    fn pump_lines_splits_on_either_line_ending_and_skips_blanks() {
        let mut seen = Vec::new();
        pump_lines(
            std::io::Cursor::new(b"one\r\ntwo\n\n  \nthree".to_vec()),
            |line| seen.push(line),
        );
        assert_eq!(seen, vec!["one", "two", "three"]);
    }

    #[test]
    fn pump_lines_keeps_a_very_long_line_whole() {
        let long = "x".repeat(3 * 1024 * 1024);
        let mut seen = Vec::new();
        pump_lines(std::io::Cursor::new(format!("{long}\n").into_bytes()), |line| {
            seen.push(line)
        });
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].len(), long.len());
    }

    #[test]
    fn pump_lines_replaces_invalid_utf8_instead_of_stopping() {
        let mut seen = Vec::new();
        pump_lines(std::io::Cursor::new(vec![b'a', 0xff, b'\n', b'b', b'\n']), |line| {
            seen.push(line)
        });
        assert_eq!(seen.len(), 2);
        assert!(seen[0].starts_with('a'));
        assert_eq!(seen[1], "b");
    }

    #[test]
    fn attach_is_idempotent_while_starting_and_while_running() {
        let mut state = RegistryState::default();
        let first = match state.begin("w1") {
            Begin::Claimed(generation) => generation,
            Begin::AlreadyRunning => panic!("a fresh workspace must be claimable"),
        };
        // A second attach during the first's start does not start another.
        assert_eq!(state.begin("w1"), Begin::AlreadyRunning);
        assert!(state.commit("w1", entry(first, "/a", None)));
        assert_eq!(state.begin("w1"), Begin::AlreadyRunning);
        // Another workspace is independent.
        assert!(matches!(state.begin("w2"), Begin::Claimed(_)));
    }

    #[test]
    fn a_failed_start_releases_the_claim() {
        let mut state = RegistryState::default();
        let Begin::Claimed(generation) = state.begin("w1") else { panic!() };
        state.abort("w1", generation);
        assert!(matches!(state.begin("w1"), Begin::Claimed(_)));
    }

    #[test]
    fn abort_with_a_stale_generation_changes_nothing() {
        let mut state = RegistryState::default();
        let generation = started(&mut state, "w1", "/a");
        state.abort("w1", generation);
        assert!(state.is_current("w1", generation));
    }

    #[test]
    fn generations_are_never_reused() {
        let mut state = RegistryState::default();
        let first = started(&mut state, "w1", "/a");
        assert_eq!(state.remove_if_current("w1", first), Some((false, false)));
        let second = started(&mut state, "w1", "/a");
        assert!(second > first);
    }

    #[test]
    fn a_stale_exit_cannot_remove_the_replacement() {
        let mut state = RegistryState::default();
        let old = started(&mut state, "w1", "/a");
        assert!(state.remove_if_current("w1", old).is_some());
        let new = started(&mut state, "w1", "/a");
        // The old host's wait thread reports late.
        assert_eq!(state.remove_if_current("w1", old), None);
        assert!(state.is_current("w1", new));
    }

    #[test]
    fn commit_requires_the_matching_claim() {
        let mut state = RegistryState::default();
        let Begin::Claimed(generation) = state.begin("w1") else { panic!() };
        assert!(!state.commit("w1", entry(generation + 1, "/a", None)));
        assert!(!state.commit("nope", entry(generation, "/a", None)));
        assert!(state.commit("w1", entry(generation, "/a", None)));
    }

    #[test]
    fn process_of_only_answers_for_running_hosts() {
        let mut state = RegistryState::default();
        let Begin::Claimed(generation) = state.begin("w1") else { panic!() };
        assert!(state.process_of("w1").is_none(), "a starting host has no process to write to");
        assert!(state.commit("w1", entry(generation, "/a", None)));
        assert!(state.process_of("w1").is_some());
        assert!(state.process_of("w2").is_none());
    }

    #[test]
    fn shutdown_marks_requested_and_the_exit_reads_as_a_shutdown() {
        let mut state = RegistryState::default();
        let generation = started(&mut state, "w1", "/a");
        let targets = state.take_for_shutdown(Some("w1"));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].generation, generation);
        let (requested, remote) = state.remove_if_current("w1", generation).unwrap();
        assert_eq!(exit_reason(remote, requested), "shutdown");
    }

    #[test]
    fn shutdown_of_one_leaves_the_others_and_none_means_all() {
        let mut state = RegistryState::default();
        started(&mut state, "w1", "/a");
        started(&mut state, "w2", "/b");
        let one = state.take_for_shutdown(Some("w2"));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].workspace_id, "w2");
        // Only the one asked for was marked.
        let (requested_w1, _) = {
            let generation = state.list().iter().find(|h| h.workspace_id == "w1").unwrap().generation;
            state.remove_if_current("w1", generation).unwrap()
        };
        assert!(!requested_w1);
        started(&mut state, "w3", "/c");
        let mut all: Vec<String> = state
            .take_for_shutdown(None)
            .into_iter()
            .map(|t| t.workspace_id)
            .collect();
        all.sort();
        assert_eq!(all, vec!["w2", "w3"]);
        assert!(state.take_for_shutdown(Some("missing")).is_empty());
    }

    #[test]
    fn shutdown_skips_a_host_that_is_still_starting() {
        let mut state = RegistryState::default();
        let _ = state.begin("w1");
        assert!(state.take_for_shutdown(None).is_empty());
    }

    #[test]
    fn list_is_sorted_and_omits_hosts_that_are_starting() {
        let mut state = RegistryState::default();
        started(&mut state, "b", "/b");
        started(&mut state, "a", "/a");
        let _ = state.begin("c");
        let rows = state.list();
        assert_eq!(
            rows.iter().map(|r| r.workspace_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(rows[0].root, "/a");
        assert!(!rows[0].remote);
    }

    #[test]
    fn list_reports_the_remote_marker() {
        let mut state = RegistryState::default();
        let Begin::Claimed(generation) = state.begin("rw-1") else { panic!() };
        assert!(state.commit("rw-1", entry(generation, "/srv/app", Some("rw-1"))));
        let rows = state.list();
        assert!(rows[0].remote);
        assert_eq!(rows[0].remote_workspace_id.as_deref(), Some("rw-1"));
    }

    #[test]
    fn payloads_have_the_documented_field_names() {
        let line = serde_json::to_value(HostLinePayload {
            workspace_id: "w1".into(),
            line: "{}".into(),
        })
        .unwrap();
        assert_eq!(line["workspace_id"], "w1");
        assert_eq!(line["line"], "{}");

        let exit = serde_json::to_value(HostExitPayload {
            workspace_id: "w1".into(),
            code: 2,
            reason: "exited",
        })
        .unwrap();
        assert_eq!(exit["workspace_id"], "w1");
        assert_eq!(exit["code"], 2);
        assert_eq!(exit["reason"], "exited");

        let result = serde_json::to_value(HostAttachResult {
            already_running: true,
            init_line: None,
        })
        .unwrap();
        assert_eq!(result["already_running"], true);
        assert!(result.get("init_line").is_none(), "{result}");

        let with_line = serde_json::to_value(HostAttachResult {
            already_running: true,
            init_line: Some("{\"t\":\"host_init\"}".into()),
        })
        .unwrap();
        assert_eq!(with_line["init_line"], "{\"t\":\"host_init\"}");
    }

    #[test]
    fn the_opening_line_is_kept_once_and_only_for_the_live_generation() {
        let mut state = RegistryState::default();
        let generation = started(&mut state, "w1", "/a");
        assert_eq!(state.opening_of("w1"), None, "nothing has been said yet");
        assert!(state.note_line("w1", generation, "first"));
        assert!(state.note_line("w1", generation, "second"));
        assert_eq!(state.opening_of("w1").as_deref(), Some("first"));
        // A line from another generation is neither emitted nor remembered.
        assert!(!state.note_line("w1", generation + 1, "stale"));
        assert!(!state.note_line("w2", generation, "unknown"));
        assert_eq!(state.opening_of("w1").as_deref(), Some("first"));
        // A replacement host starts with a clean slate.
        state.remove_if_current("w1", generation);
        let next = started(&mut state, "w1", "/a");
        assert_eq!(state.opening_of("w1"), None);
        assert!(state.note_line("w1", next, "new"));
        assert_eq!(state.opening_of("w1").as_deref(), Some("new"));
    }

    #[test]
    fn connection_debug_redacts_the_password() {
        let connection: HostConnection = serde_json::from_str(
            r#"{"host":"h","port":22,"user":"u","password":"hunter2","remoteBinary":"/bin/x"}"#,
        )
        .unwrap();
        let shown = format!("{connection:?}");
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("<redacted>"));
        assert!(connection.identity_files.is_empty());
    }
}
