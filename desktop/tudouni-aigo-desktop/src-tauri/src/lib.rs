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

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use tauri_winrt_notification::Toast;

/// The configuration files the desktop reads and writes directly.
///
/// A module rather than a pair of commands in this file, because it is the one
/// thing here that touches a file the runtime also owns and it carries rules of
/// its own. See its comment for why the desktop is the writer, and for the three
/// rules that keep a save from destroying what the form does not draw.
mod config_file;

/// The Remote Backend: starting the runtime over SSH instead of as a local
/// child process. See its own module doc for why this is a trait
/// ([`ssh_backend::RuntimeProcess`]) rather than a parallel copy of `spawn`.
mod ssh_backend;

/// Reads the user's `~/.ssh/config` so the Add Remote Workspace form can
/// prefill from hosts OpenSSH is already configured with. See its own module
/// doc for why this is a deliberately weaker second copy of the Go parser
/// rather than a link to it.
mod ssh_config;

/// The Remote Bootstrapper's transport half: platform detection, SFTP
/// upload, and the verify-and-switch sequence for installing or upgrading
/// the Runtime on a remote host. See its own module doc for the division of
/// labour with `internal/bootstrap` (Go), which specifies every rule this
/// module only mirrors.
mod remote_install;

/// Phase 4: remote config.json detection and safe writes (§9). See its own
/// module doc for the division of labour with
/// `internal/bootstrap/configsync.go`.
mod remote_config;

/// The connect step of the "add a remote workspace" flow: one dial, then the
/// facts only the far end can answer — its home, its platform, whether the
/// Runtime is installed, and what directories it has. See its own module doc
/// for why the flow connects *before* it asks a person anything.
mod remote_probe;

/// How long a graceful shutdown is given before the child is killed.
///
/// The Go client hard-codes the same 30 seconds inside `Close()`, and for the
/// same reason: `shutdown` lets the current turn finish, so the wait has to be
/// generous — but it has to end, or the window cannot be closed.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the front end is given to **acknowledge** a close prompt before the
/// window closes anyway.
///
/// This is a deadline on the *round trip*, not on the person's decision — see
/// `CLOSE_PROMPT_ACK`. The prompt is the front end's to draw, because every
/// overlay in this application is DOM (`PanelHost`, the two blocking modals), and
/// that round trip can fail: the renderer can be wedged, or the tree can have
/// thrown before the dialog mounted. **A window that cannot be closed is worse
/// than a prompt that is skipped**, which is the same reasoning as
/// `SHUTDOWN_TIMEOUT` and is why this budget exists rather than being left to the
/// front end's good behaviour.
///
/// It has to be short, because it is only covering "the front end never drew the
/// dialog at all" — a live front end answers it in milliseconds.
const CLOSE_PROMPT_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether a close prompt is on screen and unanswered.
///
/// **Not on `Bridge`.** This has nothing to do with the children — minimizing
/// keeps them all running — and the window event handler is handed a `Window`,
/// not the bridge state. It is also deliberately *not* a remembered decision:
/// what the person chose last time is a **preference**, and preferences in this
/// application live in the front end (`aigo.prefs`), read there and enforced
/// there. Rust holds only "a question is outstanding", which is a fact about
/// this moment and nothing else.
static CLOSE_PROMPT_PENDING: AtomicBool = AtomicBool::new(false);

/// Whether the front end has **drawn** the prompt it was asked for.
///
/// This is the difference between a deadline on the round trip and a deadline on
/// the person, and getting it wrong is not a small thing: a fixed timeout alone
/// would close the window a few seconds after the dialog appeared, while somebody
/// was still reading it and deciding. The prompt offers to *remember* a choice, so
/// pausing over it is the expected behaviour rather than an edge case.
///
/// So the watchdog disarms itself the moment the front end says it has the
/// dialog up, and from then on the window waits for an answer for as long as the
/// person takes. What the deadline still covers is the case it was written for:
/// a WebView that is wedged or broken, which never acknowledges anything, and
/// which must not be able to trap the window on screen.
static CLOSE_PROMPT_ACK: AtomicBool = AtomicBool::new(false);

/// Which prompt the watchdog below is watching.
///
/// Bumped when a prompt is asked, and again when it is answered. A watchdog that
/// wakes to find the number moved is looking at a prompt that is over — either
/// answered or superseded — and must not close a window on the strength of a
/// question nobody is asking any more. Without this, answering a prompt and then
/// closing the window again a second later would let the *first* watchdog fire
/// during the second prompt.
static CLOSE_PROMPT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The prompt is over, however it ended.
///
/// One function because the three fields have to move together: a caller that
/// cleared `PENDING` but left `ACK` set would leave the next prompt looking
/// already-answered, and its watchdog would disarm itself instantly and never
/// close a window whose front end had died.
fn end_close_prompt() {
    CLOSE_PROMPT_PENDING.store(false, Ordering::SeqCst);
    CLOSE_PROMPT_ACK.store(false, Ordering::SeqCst);
    CLOSE_PROMPT_GENERATION.fetch_add(1, Ordering::SeqCst);
}

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

/// Which child a message belongs to.
///
/// Minted by the bridge, monotonic, and **never derived from a session id**. A
/// new session's id is chosen by the runtime and only arrives in `init`, so at
/// the moment the child is started there is no id to name it by. This key is the
/// handle the front end holds for one session's process, and it is also the
/// capability to tear that process down — holding it is what lets a caller act
/// on that session and nothing else.
type ChildKey = u64;

/// A line read from the child, forwarded verbatim, tagged with its origin.
///
/// The tag is load-bearing and cannot be inferred from the line: `session_load`,
/// every `ui` kind, `notice`, `sessions` and both blocking requests carry **no**
/// `session_id` (see `protocol/schema/outbound.schema.json`). A front end that
/// tried to attribute them by reading the payload would attribute the approval
/// prompt to the wrong session, which hangs the one it actually came from —
/// the runtime waits on that id forever.
#[derive(Clone, Serialize)]
struct LinePayload {
    key: ChildKey,
    line: String,
}

/// The child ended. Both a requested shutdown and a crash exit with code 0, so
/// `requested` is the only thing that tells "the session ended" from "the
/// runtime died".
#[derive(Clone, Serialize)]
struct ExitPayload {
    key: ChildKey,
    code: i32,
    requested: bool,
}

/// One diagnostic line from a child. Separate from `runtime://line` because it
/// is not protocol data, and tagged for the same reason: a start-up failure has
/// to be attributable to the session whose binary would not start.
#[derive(Clone, Serialize)]
struct StderrPayload {
    key: ChildKey,
    line: String,
}

#[derive(Default)]
struct Bridge {
    inner: Mutex<BridgeState>,
}

/// Every running child, and whether the front end is listening.
///
/// **One session, one child.** The runtime takes its working directory as the
/// workspace and `--session` names the conversation, so a session is a process
/// rather than something a message can move — and two of them run in parallel by
/// both existing at once. That is the whole of the multi-session design; there is
/// no in-process multiplexing to add here.
///
/// Everything lives under one lock because the pieces are coupled. The front end
/// announces its listener in the same layout effect that starts the runtime
/// afterwards, so "listening" is routinely set while there is no child yet — and a
/// line read at that moment has to end up in the queue rather than out to nobody.
/// Keeping the flag inside one child made that impossible to express: there was
/// nothing to set it on, the announcement was refused, and every line the child
/// sent was queued forever. The UI sat in its booting phase with a perfectly
/// healthy runtime behind it. The flag is therefore **process-wide** — there is
/// one WebView, and it registers one set of listeners — while the queues are
/// per-child.
#[derive(Default)]
struct BridgeState {
    /// Live children, by key. A key leaves this map only when its child is
    /// reaped, so membership *is* "this session has a process right now".
    children: HashMap<ChildKey, Child_>,
    /// The next key to hand out. Monotonic, never reused: a front end that
    /// still holds a stale key must be told "no such child" rather than have a
    /// newer session answer for the old one.
    next_key: ChildKey,
    /// True once the front end says a listener is in place.
    listening: bool,
}

struct Child_ {
    /// The running runtime, local or remote. See `ssh_backend::RuntimeProcess`
    /// for why this is a trait object rather than a bare `Child`: a remote
    /// runtime has no PID, no separate stdin handle, and a stdin "close" that
    /// means something different (`send_eof` on the SSH channel rather than
    /// dropping a pipe).
    process: Box<dyn ssh_backend::RuntimeProcess>,
    /// True once we have asked for the shutdown ourselves.
    requested: bool,
    /// Lines read before the front end attached, flushed in order on attach.
    queue: VecDeque<String>,
    stderr: VecDeque<String>,
    /// Where this child was started.
    ///
    /// Kept per child rather than passed in on each call because `image_stash`
    /// has to write **inside the workspace**, and the workspace is a fact this
    /// layer already owns — it is the child's working directory. Taking it from
    /// the caller instead would make a front end able to name the directory a
    /// file is written into, which is exactly the kind of trust this boundary
    /// exists to withhold.
    ///
    /// It is per child and not per bridge because with several sessions open the
    /// two are no longer the same thing: a paste made while looking at session B
    /// has to land in B's workspace, which is not necessarily A's.
    ///
    /// For a remote child this is still the **local** app's own concept of a
    /// workspace path and is not meaningful — image pasting into a remote
    /// workspace is Phase 2 (remote file access) territory, not this phase's.
    /// It is kept as `None` for a remote child rather than given a fabricated
    /// local path, so `image_stash` can refuse cleanly instead of writing
    /// somewhere wrong.
    workspace: Option<PathBuf>,
    /// This child's slice of the paste staging area, cleared when it exits.
    /// `None` for a remote child, for the same reason `workspace` is.
    staging: Option<PathBuf>,
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

/// Options the front end passes to `runtime_attach_remote`.
///
/// This is deliberately a separate type from [`AttachOptions`] rather than
/// one struct with optional SSH fields: `binary`/`workspace` mean something
/// different here (a path and a working directory **on the remote host**,
/// never resolved or validated on this machine), and conflating the two
/// shapes would let a caller accidentally mix a local workspace with a
/// remote connection.
#[derive(Debug, Deserialize)]
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
fn resolve_remote_package(triple: &str) -> Result<PathBuf, String> {
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
fn spawn(
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
    let process: Box<dyn ssh_backend::RuntimeProcess> =
        Box::new(ssh_backend::LocalRuntimeProcess::new(child, stdin));

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
    //
    // This is the only place a child is reaped, which is why `runtime_shutdown`
    // polls instead of calling `wait()`: two waiters on one handle would race.
    //
    // The slot is removed here and only here, so membership in `children` means
    // "this session has a process right now". A caller that acts on a key the
    // bridge no longer holds is told so rather than being silently answered by a
    // newer session.
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
                    match guard.children.get_mut(&key) {
                        Some(current) => match current.process.try_wait() {
                            Ok(Some(code)) => {
                                let requested = current.requested;
                                guard.children.remove(&key);
                                break Some((code, requested));
                            }
                            Ok(None) => {}
                            Err(_) => {
                                guard.children.remove(&key);
                                break Some((-1, false));
                            }
                        },
                        // Already reaped or shut down: nothing to say.
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
                let _ = app.emit("runtime://exited", ExitPayload { key, code, requested });
            }
        });
    }

    Ok(key)
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
fn spawn_remote(app: &AppHandle, options: &RemoteAttachOptions) -> Result<ChildKey, String> {
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
    let process: Box<dyn ssh_backend::RuntimeProcess> = Box::new(process);

    // The key is minted and the child registered under the bridge lock, same
    // as the local path — but with no staging directory, since pasting a
    // picture into a remote workspace is Phase 2 territory (see `Child_`'s
    // own doc for `workspace`/`staging` being `None` here).
    let key = {
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
            },
        );
        key
    };

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
    // Identical in shape to spawn()'s own wait loop; `try_wait` is what hides
    // "poll an SSH channel for EOF and an exit-status exchange" behind the
    // same interface "poll a local process" already has.
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
                    match guard.children.get_mut(&key) {
                        Some(current) => match current.process.try_wait() {
                            Ok(Some(code)) => {
                                let requested = current.requested;
                                guard.children.remove(&key);
                                break Some((code, requested));
                            }
                            Ok(None) => {}
                            Err(_) => {
                                guard.children.remove(&key);
                                break Some((-1, false));
                            }
                        },
                        None => break None,
                    }
                }
                thread::sleep(Duration::from_millis(100));
            };

            if let Some((code, requested)) = outcome {
                let _ = app.emit("runtime://exited", ExitPayload { key, code, requested });
            }
        });
    }

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

/// Remove staging directories that belong to no live child.
///
/// Leftovers are swept when a session starts, which used to be "when the runtime
/// starts" and was safe because there was only one. With several sessions that
/// moment is no longer quiescent: another session may be mid-paste, and its file
/// has to survive this one's start. So the sweep is by **membership** — anything
/// not owned by a live child is a leftover — rather than by "everything except
/// mine".
///
/// A failure is reported on the diagnostics channel and nothing more: refusing to
/// start a session because an old screenshot could not be deleted would trade a
/// real capability for a tidy directory.
fn sweep_staging(app: &AppHandle, workspace: &Path, live: &HashSet<PathBuf>) {
    let root = workspace.join(PASTE_DIR).join(PASTE_SUBDIR);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        // The ordinary case on a first run.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            report_stderr(app, 0, format!("could not read {}: {error}", root.display()));
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if live.contains(&path) {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&path) {
            report_stderr(app, 0, format!("could not clear {}: {error}", path.display()));
        }
    }
}

/// Put a diagnostic line on the same channel the children's stderr uses.
///
/// `key` 0 means "the bridge itself, not a session" — the front end has no
/// session bucket to file it under, which is exactly right for a directory that
/// could not be read.
fn report_stderr(app: &AppHandle, key: ChildKey, line: String) {
    let _ = app.emit("runtime://stderr", StderrPayload { key, line });
}

/// Forward one line: straight to the WebView once attached, otherwise queued.
///
/// The queue exists for the handshake race: the process can be up and `init`
/// sent before the WebView has a listener, and the WebView's load timing is not
/// ours to control. `init` -> `session_load` -> `ui(state)` is a fixed opening
/// triple, and losing the first one leaves the UI in its booting phase forever.
///
/// The queue is per child, because the race is per child: the first session is
/// started by the same layout effect that registers the listener, while a later
/// one is started long after the listener exists.
fn forward_line(app: &AppHandle, key: ChildKey, line: String) {
    let state: State<Bridge> = app.state();

    let attached = {
        let mut guard = match state.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if guard.listening {
            true
        } else if let Some(current) = guard.children.get_mut(&key) {
            current.queue.push_back(line.clone());
            false
        } else {
            // Shut down between the read and here.
            return;
        }
    };

    if attached {
        let _ = app.emit("runtime://line", LinePayload { key, line });
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
#[tauri::command]
fn runtime_attach(app: AppHandle, options: AttachOptions) -> Result<ChildKey, String> {
    spawn(&app, &options)
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
fn runtime_attach_remote(app: AppHandle, options: RemoteAttachOptions) -> Result<ChildKey, String> {
    spawn_remote(&app, &options)
}

/// Options for `install_remote_runtime`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRemoteOptions {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
    /// The version string this install should be recorded under
    /// (`~/.tudouni/runtime/<version>/`) — the desktop app's own build
    /// version, read from `app.package_info()` by the caller in the
    /// WebView, not resolved here: this module has no reason to know its
    /// own version string any more directly than that.
    version: String,
}

/// One progress event the install flow emits as it runs each step, carried
/// to the WebView as `remote-install://progress` — what
/// `connection.phase = 'installing'` (§5.1 of the design) is drawn from.
#[derive(Clone, Serialize)]
struct InstallProgressPayload {
    /// A caller-supplied id correlating a sequence of progress events with
    /// the one `install_remote_runtime` call that produced them — a plain
    /// counter rather than a `ChildKey`, since an install can happen before
    /// any runtime process exists for the workspace it is about to make
    /// usable.
    request_id: String,
    stage: String,
    /// Set only during the `uploading` stage; `(0, 0)` otherwise.
    uploaded_entries: usize,
    total_entries: usize,
}

/// Installs or upgrades the Runtime on a remote host over SSH — the Remote
/// Bootstrapper's one entry point from the front end (§3.5, §8).
///
/// This single command performs the whole sequence: detect the remote
/// platform, pick the matching bundled archive, check whether this exact
/// version is already current (skip entirely if so), upload into a fresh
/// staging directory, then verify and atomically switch. Every step is
/// reported through `remote-install://progress` as it starts, keyed by
/// `request_id` so a front end tracking more than one install (unlikely,
/// but not prevented) can tell them apart.
///
/// Returns the absolute path to the installed binary — through
/// `CurrentLink`, exactly what a subsequent `runtime_attach_remote` should
/// pass as `remote_binary` once this call succeeds. This command does not
/// start the runtime itself: installing and connecting are two separate
/// acts here, the same way `runtime_attach`/`resolve_binary` never install
/// anything locally either.
#[tauri::command]
fn install_remote_runtime(
    app: AppHandle,
    request_id: String,
    options: InstallRemoteOptions,
) -> Result<String, String> {
    let target = ssh_backend::SshTarget {
        host: options.host,
        port: options.port,
        user: options.user,
        identity_files: options.identity_files,
        password: options.password,
        connect_timeout: Duration::from_millis(options.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000)),
    };

    let session = remote_install::open_install_session(&target)
        .map_err(|e| format!("could not connect to install the remote runtime: {e}"))?;

    // Platform is detected once here (rather than inside install_or_upgrade
    // alone) so the archive to upload can be chosen before staging begins —
    // install_or_upgrade still re-detects internally for its own layout, but
    // that second exec is cheap (two `uname` calls) next to a wrong binary
    // discovered only after an upload.
    let remote_target = remote_install::detect_remote_target(&session)
        .map_err(|e| format!("could not identify the remote platform: {e}"))?;
    let archive_path = resolve_remote_package(remote_target.triple)
        .map_err(|e| format!("could not find the install package for this platform: {e}"))?;

    let emit_stage = {
        let app = app.clone();
        let request_id = request_id.clone();
        move |stage: remote_install::InstallStage| {
            let stage_name = match stage {
                remote_install::InstallStage::DetectingPlatform => "detecting_platform",
                remote_install::InstallStage::CheckingExistingInstall => "checking_existing_install",
                remote_install::InstallStage::PreparingStaging => "preparing_staging",
                remote_install::InstallStage::Uploading => "uploading",
                remote_install::InstallStage::VerifyingAndSwitching => "verifying_and_switching",
                remote_install::InstallStage::Done => "done",
            };
            let _ = app.emit(
                "remote-install://progress",
                InstallProgressPayload {
                    request_id: request_id.clone(),
                    stage: stage_name.to_string(),
                    uploaded_entries: 0,
                    total_entries: 0,
                },
            );
        }
    };

    let emit_progress = {
        let app = app.clone();
        let request_id = request_id.clone();
        move |done: usize, total: usize| {
            let _ = app.emit(
                "remote-install://progress",
                InstallProgressPayload {
                    request_id: request_id.clone(),
                    stage: "uploading".to_string(),
                    uploaded_entries: done,
                    total_entries: total,
                },
            );
        }
    };

    remote_install::install_or_upgrade(&session, &archive_path, &options.version, emit_stage, emit_progress)
        .map_err(|e| format!("could not install the remote runtime: {e}"))
}

/// Options shared by `check_remote_config` and `write_remote_config` — the
/// SSH destination, nothing else. A separate, smaller struct from
/// `InstallRemoteOptions` because a config-sync call carries no version and
/// no runtime-specific fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigTarget {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
}

impl RemoteConfigTarget {
    fn into_ssh_target(self) -> ssh_backend::SshTarget {
        ssh_backend::SshTarget {
            host: self.host,
            port: self.port,
            user: self.user,
            identity_files: self.identity_files,
            password: self.password,
            connect_timeout: Duration::from_millis(self.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000)),
        }
    }
}

/// What `check_remote_config` reports — the camelCase wire shape of
/// `remote_config::RemoteConfigInspection`.
#[derive(Serialize)]
struct RemoteConfigStatusPayload {
    status: String,
    fingerprint: String,
    error: Option<String>,
}

/// Reads and classifies the remote account's `~/.tudouni/config.json`
/// (§9.3 of the design) — the Workspace Manager's one entry point for
/// deciding what a `configPolicy` of `ask` should actually ask about.
///
/// Never writes anything. The returned fingerprint is what the front end
/// compares against a stored baseline (§9.5) to decide whether this is a
/// first sync, an ordinary continuation, or a conflict.
#[tauri::command]
fn check_remote_config(target: RemoteConfigTarget) -> Result<RemoteConfigStatusPayload, String> {
    let ssh_target = target.into_ssh_target();
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to check the remote configuration: {e}"))?;
    let inspection = remote_config::check_remote_config(&session, &home)
        .map_err(|e| format!("could not read the remote configuration: {e}"))?;
    Ok(RemoteConfigStatusPayload {
        status: inspection.status.as_str().to_string(),
        fingerprint: inspection.fingerprint,
        error: inspection.error,
    })
}

/// Writes `contents` to the remote account's `~/.tudouni/config.json`
/// safely (§9.6): a temp file, the existing file backed up, then an atomic
/// SFTP rename into place. `contents` must already be the complete file —
/// this command does not merge or validate it beyond what
/// `remote_config::write_remote_config` itself does.
///
/// Returns the fingerprint of what was just written, so the caller can
/// record it as the new sync baseline without a second round trip to read
/// it back.
#[tauri::command]
fn write_remote_config(target: RemoteConfigTarget, contents: String) -> Result<String, String> {
    let ssh_target = target.into_ssh_target();
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to write the remote configuration: {e}"))?;
    let bytes = contents.into_bytes();
    remote_config::write_remote_config(&session, &home, &bytes)
        .map_err(|e| format!("could not write the remote configuration: {e}"))?;
    Ok(remote_config::fingerprint_hex(&bytes))
}

/// Write one protocol line to **one** session's stdin.
///
/// The key is required. Without it the write would go to whichever session
/// happened to be first, and a misdirected `user_message` runs a turn in the
/// wrong conversation — the kind of mistake that is invisible until somebody
/// reads the transcript. The line itself arrives already encoded (including
/// `v`), so nothing here parses it: whatever the front end decided is what goes
/// out, and to whom is decided by the key.
#[tauri::command]
fn runtime_send(app: AppHandle, key: ChildKey, line: String) -> Result<(), String> {
    let state: State<Bridge> = app.state();
    let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
    let current = guard
        .children
        .get_mut(&key)
        .ok_or("that session's runtime is not running")?;
    current
        .process
        .write_line(&line)
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
fn runtime_shutdown(app: AppHandle, key: Option<ChildKey>) -> Result<(), String> {
    let state: State<Bridge> = app.state();

    // `shutdown()` is called while holding the lock, one child at a time —
    // unlike the old `ChildStdin`-only version, `RuntimeProcess::shutdown`
    // cannot be moved out and called after releasing it, because a remote
    // channel's "close" (`send_eof`) is a method on the object itself, not an
    // owned handle whose `Drop` does the closing. The write and flush this
    // performs are fast (one small line, no network round trip waited on
    // here), so holding the lock for it is the same cost `runtime_send`
    // already pays for an ordinary message.
    {
        let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let targets: Vec<ChildKey> = match key {
            Some(key) => {
                if guard.children.contains_key(&key) {
                    vec![key]
                } else {
                    vec![]
                }
            }
            None => guard.children.keys().copied().collect(),
        };
        // One `shutdown` line per session: the sessions are independent, so
        // asking them in the same pass costs nothing and lets them finish
        // their turns concurrently. Doing this session by session would
        // serialise N times the time a turn takes.
        for target in targets {
            if let Some(current) = guard.children.get_mut(&target) {
                current.requested = true;
                let _ = current.process.shutdown();
            }
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
            let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
            match key {
                Some(key) => {
                    if let Some(current) = guard.children.get_mut(&key) {
                        let _ = current.process.kill();
                    }
                }
                None => {
                    for current in guard.children.values_mut() {
                        let _ = current.process.kill();
                    }
                }
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// The kill switch, for when the timeout is not enough.
#[tauri::command]
fn runtime_kill(app: AppHandle, key: Option<ChildKey>) -> Result<(), String> {
    let state: State<Bridge> = app.state();
    let mut guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
    let targets: Vec<ChildKey> = match key {
        Some(key) => {
            if guard.children.contains_key(&key) {
                vec![key]
            } else {
                vec![]
            }
        }
        None => guard.children.keys().copied().collect(),
    };
    for target in targets {
        if let Some(mut current) = guard.children.remove(&target) {
            current.requested = true;
            let _ = current.process.kill();
            current.process.wait_after_kill();
        }
    }
    Ok(())
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

/// Keep the screen awake, or let it sleep.
///
/// This talks to the OS directly rather than through a Tauri API, for a
/// concrete reason: the locked tauri 2.12 exposes no prevent-sleep method
/// (checked against the crate source), and the `tauri-plugin-prevent-sleep`
/// that provides one is published as a crate with no JavaScript bindings — so
/// the windowing layer would be reached through a dependency that the front
/// end cannot address. The native calls are one function each:
///
///   - **Windows**: `SetThreadExecutionState` from kernel32, loaded at runtime
///     with `LoadLibrary`/`GetProcAddress` so no link dependency is added.
///   - **macOS**: the IOKit display-sleep assertion pair.
///
/// The state is process-wide rather than per-window, which is the right
/// scope: the question the OS must answer is "is work running in this
/// program", and there is one process. Calling it twice with the same value
/// is a no-op, so the front end may re-assert on every state change without
/// tracking what it sent last.
///
/// `ES_DISPLAY_REQUIRED` and not only `ES_SYSTEM_REQUIRED`: the reported bug
/// is the **screen lock**, and the system-required flag alone would still let
/// the display go dark.
///
/// **The value is the front end's call, and this command only carries it.**
/// The rule "wake only while a session is actually running, never while the app
/// merely sits open" is a policy about sessions, and the sessions live in the
/// front end's store — which is where it is enforced (see `keepAwake`).
#[tauri::command]
fn set_prevent_sleep(_app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

        type SetThreadExecutionStateFn =
            unsafe extern "system" fn(flags: u32) -> u32;

        // The function has been in kernel32 since Windows 2000, so loading it
        // at runtime is a portability formality rather than a compatibility
        // gate — but the gate is kept anyway: a platform without it is a
        // refusal with a sentence, not a crash inside a FFI call.
        unsafe {
            // Both lookups report failure as NULL, not as an Option.
            let k32 = LoadLibraryA(b"kernel32.dll\0".as_ptr() as *const i16);
            if k32.is_null() {
                return Err("could not load kernel32.dll".to_string());
            }
            let f = GetProcAddress(k32, b"SetThreadExecutionState\0".as_ptr() as *const i8);
            if f.is_null() {
                return Err("SetThreadExecutionState was not found in kernel32.dll".to_string());
            }
            let set_state = std::mem::transmute::<*mut c_void, SetThreadExecutionStateFn>(f);
            // Off means "no flags other than ES_CONTINUOUS": that is how the
            // API spells "return to the default" rather than "nothing".
            let flags = if on {
                ES_CONTINUOUS | ES_DISPLAY_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            let applied = set_state(flags);
            if applied == 0 {
                return Err("SetThreadExecutionState refused the change".to_string());
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = on;
        Err("keeping the screen awake is not implemented on this platform yet")
    }

    Ok(())
}

// `LoadLibraryA` from kernel32. The calling process always has kernel32
// mapped, and `LoadLibrary` itself lives in it, so this lookup never needs a
// second library.
#[cfg(windows)]
unsafe extern "system" {
    fn LoadLibraryA(name: *const i16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const i8) -> *mut c_void;
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

/// Open one **declared deliverable** in the operating system's default
/// application.
///
/// This exists as a command rather than as a direct `openPath` call from the
/// page for one reason: **the boundary has to be re-checked on this side of the
/// IPC**, against the file that is actually there. The path arrives from the
/// model, through the runtime, through the card — three hops in which nothing
/// verified that it names a file inside the workspace whose session declared it.
/// The Go runtime checks it when the declaration is made, and that check is
/// right; but a check made once, in another process, minutes ago, about a path
/// that is a *string* in between, is not the thing to hand to `explorer.exe`.
///
/// So the same rule is applied here, at the moment of the act: join the
/// workspace and the relative path, canonicalize both, and require the result to
/// stay under the root. A `..` that escapes, a symlink pointing out, or a file
/// that has been replaced since the declaration all fail the same way.
///
/// **It does not open through the plugin's own scope check.** `openPath` takes a
/// path and learns nothing about workspaces, so the scope check would be the
/// front end's, which is the layer this command exists to stop trusting.
///
/// The error string is written for a person: it is shown on the card, next to
/// the file it is about, and "the file is gone" is the one outcome a reader can
/// act on.
#[tauri::command]
fn deliverable_open(workspace: String, path: String) -> Result<(), String> {
    let relative = path.trim();
    if relative.is_empty() {
        return Err("no file was named".to_string());
    }
    // An absolute path is refused rather than joined: `Path::join` with an
    // absolute argument **replaces** the base, so passing one through would skip
    // the boundary below by construction.
    if Path::new(relative).is_absolute() {
        return Err("the card names a path outside the workspace".to_string());
    }

    let root = fs::canonicalize(workspace.trim())
        .map_err(|e| format!("cannot read the workspace directory: {e}"))?;
    let target = fs::canonicalize(root.join(relative)).map_err(|_| {
        format!("{relative} is not there any more — it may have been moved or deleted")
    })?;
    if target.strip_prefix(&root).is_err() {
        return Err(format!("{relative} is outside the workspace"));
    }
    if !target.is_file() {
        return Err(format!("{relative} is not a regular file"));
    }

    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("the system could not open it: {e}"))
}

/// One workspace picture, ready to be handed to the WebView as a `data:` URL.
#[derive(Clone, Serialize)]
struct InlineImage {
    /// The picture's bytes, base64-encoded, already carrying its `data:` prefix.
    ///
    /// Returned as a complete URL rather than as raw bytes so the front end can
    /// put the value straight into an `<img src>`. Raw bytes would arrive as a
    /// JSON number array — over 20MB for a five megabyte picture — and the front
    /// end would then have to base64 them itself, which is the same work done
    /// twice in a slower place.
    url: String,
}

/// Ceiling on one inline picture.
///
/// The same number `image_stash` accepts, and for the same reason: it is the
/// runtime's own picture ceiling (`content.InspectImage`), so a picture the
/// runtime would accept is one this can draw. A `data:` URL is a third larger
/// than its bytes once base64 encoding is counted, and it lives in the DOM
/// rather than in a file, so this is also the point past which drawing one is
/// worse for the window than showing its path.
const MAX_INLINE_IMAGE_BYTES: usize = MAX_IMAGE_BYTES;

/// The extensions a workspace path may carry to be drawn inline.
///
/// A **name** check, deliberately, alongside the byte sniff below: the name
/// decides whether to read the file at all, and the bytes decide whether what was
/// read is really a picture. Neither alone is enough — the name is a claim, and
/// sniffing means reading a file whose first bytes would otherwise be discarded.
const INLINE_IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// Read one picture **inside the workspace** and return it as a `data:` URL.
///
/// ## Why this exists
///
/// The runtime has no channel for a picture other than a path in a sentence (see
/// `image_stash`), so a model that generates an image hands back a path. Before
/// this command the chat could only print that path: a WebView cannot load
/// `C:\…\out.png` as an `<img>`, and the CSP deliberately allows no remote image
/// origins. The person was told *where* the picture was instead of being shown
/// it, which is the one thing a chat window is for.
///
/// ## Why through a command and not the `asset:` protocol
///
/// The `asset:` protocol is the obvious answer and it is the wrong one here: its
/// scope is configuration, so the whole permitted surface is a static list of
/// directories decided at build time, and it would have to name the workspace
/// directory of whoever is running — which is not known until they pick one. It
/// also turns **any** model-authored `![](asset://…)` into a read of any path the
/// scope covers, decided by the renderer rather than by this boundary. A command
/// takes the workspace from the bridge and re-checks every path against it, which
/// is the same rule `deliverable_open` applies and for the same reason.
///
/// ## The boundary
///
/// Canonicalize the root and the target, then require the target to stay under
/// the root. `..`, an absolute path, and a symlink pointing out all fail here,
/// because the check is made against the file that is really there rather than
/// against the string. `workspace` arrives from the front end but is only ever
/// the runtime's own `init.workspace` — the relative path's meaning depends on
/// it, so the two have to be the same fact.
///
/// ## What it refuses
///
/// Non-pictures by extension and by bytes, directories, files over the ceiling,
/// and anything outside the workspace. Each refusal is a sentence for a person,
/// because it is drawn next to the picture that did not load.
#[tauri::command]
fn inline_image(workspace: String, path: String) -> Result<InlineImage, String> {
    let relative = path.trim();
    if relative.is_empty() {
        return Err("no picture was named".to_string());
    }
    let root = fs::canonicalize(workspace.trim())
        .map_err(|e| format!("cannot read the workspace directory: {e}"))?;

    // Resolved against the root, and an absolute path is refused rather than
    // joined: `Path::join` with an absolute argument *replaces* the base, which
    // would skip the boundary below by construction.
    let named = Path::new(relative);
    if named.is_absolute() {
        return Err("the picture names a path outside the workspace".to_string());
    }
    let candidate = root.join(named);
    let target = fs::canonicalize(&candidate).map_err(|_| {
        format!("{relative} is not there — the picture may not have been written yet")
    })?;
    if target.strip_prefix(&root).is_err() {
        return Err(format!("{relative} is outside the workspace"));
    }
    if !target.is_file() {
        return Err(format!("{relative} is not a regular file"));
    }

    // The extension decides whether to read at all; see `INLINE_IMAGE_EXTENSIONS`.
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !INLINE_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "{relative} is not a picture this window can draw (it accepts png, jpg, gif, webp and bmp)"
        ));
    }

    let metadata = fs::metadata(&target).map_err(|e| format!("cannot read {relative}: {e}"))?;
    if metadata.len() > MAX_INLINE_IMAGE_BYTES as u64 {
        return Err(format!(
            "{relative} is {} bytes, over the {} byte ceiling for one picture",
            metadata.len(),
            MAX_INLINE_IMAGE_BYTES
        ));
    }

    let bytes = fs::read(&target).map_err(|e| format!("cannot read {relative}: {e}"))?;
    // The bytes are the authority on what this is, never the name. `sniff_image`
    // is the same check `image_stash` applies, so the two cannot accept
    // different formats.
    let known = sniff_image(&bytes).ok_or_else(|| {
        format!("{relative} is not a PNG, JPEG or GIF — its contents do not match its name")
    })?;

    Ok(InlineImage {
        url: format!("data:{};base64,{}", known.mime, base64_encode(&bytes)),
    })
}

/// Base64 encode, for a `data:` URL.
///
/// Hand-written rather than a dependency: this is the whole of what the crate
/// would be used for, and the alphabet has no options to get wrong. The standard
/// `+/` alphabet with `=` padding is what a `data:` URL expects.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        // The final group is padded rather than filled with zero bits, so a
        // decoder can tell a short tail from a real character.
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
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

/* ============================================================
   The configuration files
   ============================================================ */

/// Read `~/.ssh/config` and hand back its concrete `Host` blocks, for the
/// Add Remote Workspace form's host picker.
///
/// A local read of one file the user already maintains: no connection is
/// attempted, and nothing here is a request the runtime is waiting on. The
/// front end treats the answer as **prefill suggestions only** — every field
/// the form fills from it is still editable and still validated at Save.
///
/// The refusal rules the Go side applies when it dials (`ProxyJump` and
/// friends in `internal/ssh/config.go`'s `rejectedFields`) are applied here
/// too, as a per-host `refused` flag: a block that names one of them is
/// listed but marked unselectable, because the dial would fail the same way
/// the Go side's own refusal describes. See `ssh_config`'s module doc for
/// why that second copy of the rules exists at all.
#[tauri::command]
fn read_ssh_config() -> ssh_config::SshConfigDocument {
    ssh_config::read_config()
}

/// What `append_ssh_host` is given: the alias to write and the block's fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSshHostOptions {
    alias: String,
    hostname: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
}

/// Add one `Host` block to the user's own `~/.ssh/config` and return the file's
/// path.
///
/// This is what "configure a host here, since there is none" means in this
/// application: `~/.ssh/config` is the one place a host is configured (the Go
/// side reads the same file), so a host added through the wizard is written
/// **there** rather than into a private list only this program can see — a
/// private list would be a host the person cannot reach with `ssh` either.
///
/// **A password is never written.** `Password` is this project's own extension,
/// not an OpenSSH keyword; writing it would break the person's own `ssh` with
/// `Bad configuration option: password` on every connection. See
/// `ssh_config::append_host`.
#[tauri::command]
fn append_ssh_host(options: AppendSshHostOptions) -> Result<String, String> {
    ssh_config::append_host(
        &options.alias,
        &ssh_config::SshConfigHost {
            alias: options.alias.clone(),
            hostname: options.hostname,
            port: options.port,
            user: options.user,
            identity_files: options.identity_files,
            has_password: false,
            refused: None,
        },
    )
}

/// Options for the three `remote_probe`-backed commands: the SSH destination
/// and nothing else.
///
/// The same shape as [`RemoteConfigTarget`] and deliberately a distinct type
/// rather than a reuse of it: the two are different questions asked of the same
/// server, and one gaining a field the other has no business carrying is
/// exactly the kind of drift a shared struct invites.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbeTarget {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
}

impl RemoteProbeTarget {
    fn into_ssh_target(self) -> ssh_backend::SshTarget {
        ssh_backend::SshTarget {
            host: self.host,
            port: self.port,
            user: self.user,
            identity_files: self.identity_files,
            password: self.password,
            connect_timeout: Duration::from_millis(
                self.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000),
            ),
        }
    }
}

/// Connect to a host and report what is on the other end: the account's home,
/// its platform, whether the Runtime is installed (and at which version),
/// whether it has a usable `config.json`, and the directories inside `path`.
///
/// This is the **first** step of adding a remote workspace — see
/// `remote_probe`'s module doc for why the flow connects before asking the
/// person anything. It writes nothing, installs nothing, and starts no session:
/// the workspace it is asked about is read, never entered.
///
/// `path` omitted or empty means the account's home directory.
#[tauri::command]
fn probe_remote_host(
    target: RemoteProbeTarget,
    path: Option<String>,
) -> Result<remote_probe::RemoteProbe, String> {
    remote_probe::probe(&target.into_ssh_target(), path.as_deref())
}

/// List one directory on a host the wizard has already probed — the browser's
/// "open a folder" and "up" clicks.
///
/// Unlike `probe_remote_host` it does not re-ask the host what it is: the
/// platform, the runtime's state and the config's state were reported by the
/// first probe and do not change while the person is choosing a directory.
/// It makes only the calls a listing needs (over the cached connection when
/// one exists), which is what makes a click in the browser feel like a listing
/// rather than a reconnect. See `remote_probe`'s module doc.
///
/// `path` omitted or empty means the account's home directory.
#[tauri::command]
fn browse_remote_dir(target: RemoteProbeTarget, path: Option<String>) -> Result<remote_probe::RemoteBrowse, String> {
    remote_probe::browse(&target.into_ssh_target(), path.as_deref())
}

/// Create one directory on a remote host, for the wizard's "new folder".
///
/// A separate command from `probe_remote_host` on purpose: browsing a host must
/// not be able to create anything on it, and the only way to guarantee that is
/// for the two to be different calls.
///
/// Returns the directory's absolute path, which is what the caller then lists.
#[tauri::command]
fn create_remote_directory(target: RemoteProbeTarget, path: String) -> Result<String, String> {
    remote_probe::create_directory(&target.into_ssh_target(), &path)
}

/// Read `~/.tudouni/config.json` and `mcp.json` for the config panel.
///
/// The front end draws this, so it is the panel's own shape rather than the
/// runtime's `providers` object: routes as a **list** (which keeps the file's
/// order, and the order is what decides the default route), headers as pairs (a
/// map would re-arrange itself between renders), and a `problem` field per file
/// instead of an error.
///
/// That last one is the load-bearing part. A file that will not parse still has
/// to be **shown** — its path, and the sentence saying what is wrong — because a
/// panel that answers "it could not be read" with nothing on screen leaves the
/// person with no idea which file to open. The `problem` is also what the panel
/// reads to decide that saving is off: a merge needs an object to preserve, and
/// there is none.
#[tauri::command]
fn config_read() -> Result<config_file::ConfigDocument, String> {
    config_file::read_document()
}

/// Reads the local config.json as plain text — Phase 4's one addition to
/// this command set, for config sync (§9). See
/// `config_file::read_local_config_text` for why this is a separate,
/// un-parsed read rather than reusing `config_read`'s structured document.
///
/// Returns the text alongside its fingerprint (SHA256, hex) so the caller
/// never needs a second hashing dependency on the JS side just to compare
/// it against a remote one — `remote_config::fingerprint_hex` is the exact
/// same function `check_remote_config`/`write_remote_config` already use,
/// so a local and a remote fingerprint are always computed the same way.
#[tauri::command]
fn read_local_config_text() -> Result<Option<LocalConfigTextPayload>, String> {
    let text = config_file::read_local_config_text()?;
    Ok(text.map(|text| {
        let fingerprint = remote_config::fingerprint_hex(text.as_bytes());
        LocalConfigTextPayload { text, fingerprint }
    }))
}

#[derive(Serialize)]
struct LocalConfigTextPayload {
    text: String,
    fingerprint: String,
}

/// Apply one save and return the files as they are **afterwards**.
///
/// The reply is a fresh read, not the patch echoed back: what the panel draws
/// next is therefore the file's own content. That is the same rule the settings
/// panel follows when it shows the argv a child was actually given rather than
/// what somebody typed — a remembered value must not read as "this is in force".
///
/// Failures are sentences for a person, and every one of them is a reason
/// **nothing was written**: the merge is built in memory and the rename at the
/// end is the only step that touches the file.
#[tauri::command]
fn config_write(patch: config_file::ConfigPatch) -> Result<config_file::ConfigDocument, String> {
    config_file::write_document(patch)
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
/// ## Why the session arrives as a header
///
/// The payload **is** the bytes, so there is nowhere to put a second named
/// argument — `invoke` with a raw body carries no JSON object alongside it. With
/// one session that was fine; with several it is not, because the picture has to
/// land in the workspace of the session whose draft it is going into. So the key
/// travels as an `x-tudouni-key` header, which Tauri exposes through
/// `Request::headers()` and which costs nothing alongside a raw body.
///
/// A missing or unknown key is **refused**, never guessed. Guessing the first
/// child would write the file into a workspace the draft is not in, and the
/// sentence would then name a path that resolves to nothing — a paste that
/// silently did nothing, which is this feature's worst failure mode.
///
/// The workspace still comes from the bridge rather than from the caller: the
/// key selects among workspaces this layer already owns, and no
/// caller-supplied string ever reaches this path.
#[tauri::command]
fn image_stash(app: AppHandle, request: Request<'_>) -> Result<StashedImage, String> {
    let key = request
        .headers()
        .get("x-tudouni-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<ChildKey>().ok())
        .ok_or("this paste did not say which session it belongs to")?;

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

    // The workspace and the staging directory both come from the child — its
    // working directory and its own slice of the staging area, facts this layer
    // already owns — and never from the caller. Letting a front end name the
    // directory would be letting it choose where a file is written; letting it
    // omit one would leave the picture to land in an arbitrary session's
    // workspace.
    let (workspace, directory) = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is nowhere to put the picture")?;
        let workspace = current
            .workspace
            .clone()
            .ok_or("that session's workspace is remote; pasting a picture into a remote workspace is not supported yet")?;
        let staging = current
            .staging
            .clone()
            .ok_or("that session's workspace is remote; pasting a picture into a remote workspace is not supported yet")?;
        (workspace, staging)
    };

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

/// The last stderr lines of one child, for the local "the runtime would not
/// start" panel.
///
/// Per session, because a start-up failure belongs to the session whose binary
/// would not start. A single shared ring would mix two sessions' diagnostics and
/// then show them under whichever one the person happened to be looking at.
#[tauri::command]
fn runtime_stderr(app: AppHandle, key: ChildKey) -> Vec<String> {
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

/* ============================================================
   Closing the window: ask first, and let the answer be remembered
   ============================================================ */

/// What the person chose in the close prompt.
///
/// Three answers, and the third is not padding. **`Cancel` exists because the
/// prompt is the front end's, and every dialog in this application can be
/// dismissed** — Esc, or a click on the mask outside it. A prompt with two
/// buttons and no way to change your mind turns "I clicked X by accident" into a
/// forced choice between two real actions, and both of them do something the
/// person did not ask for: one hides the window, the other ends every session.
///
/// It is also what keeps the *state* correct. This handler refuses the close and
/// leaves `CLOSE_PROMPT_PENDING` set; a dismissal that did not clear it would
/// leave the flag true forever, and the next press of X would be read as "a
/// prompt is already up" and ignored — a window that can only be closed once.
/// So every way out of the prompt goes through `end_close_prompt`, and `Cancel`
/// is the one that does nothing else.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseChoice {
    Minimize,
    Close,
    Cancel,
}

/// Close the window for real: finish every session, then destroy it.
///
/// **`destroy` and not `close`.** `close` re-emits a close request, which lands
/// straight back in the handler below and is refused again — the window would
/// never go away. This is the same second-pass reasoning the handler has always
/// used.
///
/// The shutdown goes off the event loop, as it must: `runtime_shutdown` blocks
/// for up to `SHUTDOWN_TIMEOUT` (30s) polling for the children to exit, and
/// running it on the thread that pumps window events freezes the window for that
/// whole time with no repaint and no explanation.
fn finish_close(window: tauri::Window) {
    // A close that is already under way must not be started twice: the watchdog
    // and the person's own answer can arrive within the same instant, and two
    // shutdown passes would both write `shutdown` to the children's stdin.
    end_close_prompt();

    let app = window.app_handle().clone();
    thread::spawn(move || {
        let _ = runtime_shutdown(app, None);
        let _ = window.destroy();
    });
}

/// Tell Rust the prompt is **on screen**, so the deadline stops running.
///
/// This is the half that makes the prompt usable. Without it the watchdog would
/// fire a few seconds after the dialog appeared, whatever the person was doing:
/// the choice includes "remember this", so reading it before answering is the
/// expected behaviour, and a window that closes itself while somebody is
/// deciding is worse than no prompt at all.
///
/// It has to be acked rather than assumed, because the deadline has to still
/// cover the case it was written for — a WebView that never drew anything. A
/// front end that is running answers this within the same frame it receives the
/// event, so in practice the deadline only ever expires when the dialog really
/// is not coming.
///
/// A late ack is harmless and is not checked against the generation: the only
/// thing it does is disarm a watchdog, and a watchdog that has already fired has
/// taken the window down regardless. Refusing a late one would cost nothing and
/// buy nothing.
#[tauri::command]
fn close_prompt_ack() -> Result<(), String> {
    CLOSE_PROMPT_ACK.store(true, Ordering::SeqCst);
    Ok(())
}

/// Answer the close prompt.
///
/// The front end calls this once for each `window://close-requested` it drew a
/// dialog for, and **it is the only way the window closes from that dialog**.
/// Going through a command rather than letting the front end call
/// `getCurrentWindow().close()` is not ceremony: `close()` would raise
/// `CloseRequested` again, the handler would refuse it and ask again, and the
/// person would be looking at a prompt that reopened every time they answered it.
#[tauri::command]
fn close_prompt_answer(window: tauri::Window, choice: CloseChoice) -> Result<(), String> {
    match choice {
        // `hide`, not `minimize`. The choice's promise has always been "the
        // window leaves the screen and every session keeps running", and the
        // tray icon is what makes that promise honest: a minimized window is
        // still a taskbar button asking to be clicked again, while a hidden one
        // is reachable exactly one way — through the tray, which is created
        // before this command can ever be answered (see `make_tray`).
        // `hide` keeps the children untouched, as before.
        CloseChoice::Minimize => {
            end_close_prompt();
            window
                .hide()
                .map_err(|e| format!("could not hide the window: {e}"))
        }
        CloseChoice::Close => {
            finish_close(window);
            Ok(())
        }
        // Nothing happens to the window, and the close request is over. See the
        // enum: this is what a dismissal resolves to, and clearing the state is
        // the whole of its job.
        CloseChoice::Cancel => {
            end_close_prompt();
            Ok(())
        }
    }
}

/// Destroy the window without running the close prompt.
///
/// **For `/exit` and nothing else.** That command is already an explicit "quit
/// the application" — the person typed it and pressed Enter — so asking
/// "minimize or close?" afterwards would be the interface asking a question it
/// has been given the answer to.
///
/// The caller shuts the sessions down first (`quitApp` in `runtime/tauri.ts`
/// calls `runtime_shutdown` and then this), which is why no shutdown happens
/// here.
#[tauri::command]
fn window_destroy(window: tauri::Window) -> Result<(), String> {
    end_close_prompt();
    window
        .destroy()
        .map_err(|e| format!("could not close the window: {e}"))
}

/* ============================================================
   The tray icon
   ============================================================ */

/// The event the front end listens for when somebody acts on the tray menu.
///
/// Paired with `onTrayCommand` in `src/runtime/tauri.ts`, which is where the
/// listener lives. A `tray://` name rather than `window://` because the window
/// is only half of it: showing the window happens here, and what the front end
/// is told is *which act* was asked for — one the store, not this layer, is
/// positioned to perform (the board's gate and the modal guard are its
/// selectors, and "a new session" is its `openSession`).
const TRAY_COMMAND: &str = "tray://command";

/// The one field the front end needs: which tray item was clicked.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayCommandPayload {
    /// `"new-session"` or `"open-board"`, matching the `TrayAction` union the
    /// front end narrows on.
    action: &'static str,
}

/// Create the system tray icon and its menu.
///
/// It exists for one promise: "minimize" in the close prompt hides the window
/// while every session keeps running, and without this icon a hidden window
/// would be unreachable — the person would have to end the process from Task
/// Manager to get back to work. It is created **at startup**, not lazily on
/// the first hide, because the prompt can be answered through a remembered
/// policy with no dialog at all (`useWindowClose`), and a lazily-created icon
/// would then first appear exactly one click too late.
///
/// The menu is what the icon has to offer: show, a separator, the two session
/// acts the window can be summoned for, another separator, and quit. Quit goes
/// through `runtime_shutdown` on a thread and then `destroy` — the same path as
/// the `/exit` command — because the tray must not raise a close request (the
/// prompt handler would refuse it and leave the application "quitting"
/// forever), and must not kill running turns without the graceful wait
/// `runtime_shutdown` provides.
///
/// The two session acts do their window half here and their session half in the
/// front end: `tray_show_inner` runs synchronously, because a menu click that
/// leaves the window hidden has visibly done nothing, and the act itself is
/// then handed over as `tray://command`. The front end keeps the guards (a
/// pending approval must not be abandoned by a session switch; the board needs
/// a workspace with a child), which this layer deliberately does not restate —
/// it has no read on either condition, and a second copy would drift.
///
/// Left click shows the window (the near-universal Windows convention);
/// double click is deliberately left to bubble through as its own event and
/// also shows it, via the same `TrayIconEvent::Click` match. The menu still
/// opens on **right** click, because `show_menu_on_left_click` stays off.
fn make_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show tudouni-aigo", true, None::<&str>)?;
    let new_session_item =
        MenuItem::with_id(app, "tray-new-session", "New session", true, None::<&str>)?;
    let board_item = MenuItem::with_id(app, "tray-board", "Session board", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &new_session_item,
            &board_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                if let Ok(()) = tray_show_inner(app) {}
            }
            "tray-new-session" => {
                if let Ok(()) = tray_show_inner(app) {}
                let _ = app.emit(TRAY_COMMAND, TrayCommandPayload { action: "new-session" });
            }
            "tray-board" => {
                if let Ok(()) = tray_show_inner(app) {}
                let _ = app.emit(TRAY_COMMAND, TrayCommandPayload { action: "open-board" });
            }
            "tray-quit" => {
                let app = app.clone();
                let shutdown_handle = app.clone();
                thread::spawn(move || {
                    let _ = runtime_shutdown(shutdown_handle, None);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.destroy();
                    }
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click = show, the Windows convention. The menu opens on
            // right click only (`show_menu_on_left_click(false)` above).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray_show_inner(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Restore the main window from the tray, shared with the tray's own event
/// handlers.
fn tray_show_inner(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window does not exist")?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| format!("could not show the window: {e}"))
}

/* ============================================================
   System notifications: show a toast, and hear the click
   ============================================================ */

/// The event the front end listens for when somebody clicks a notification.
///
/// Paired with `NOTIFY_ACTIVATED` in `src/runtime/tauri.ts`, which is where the
/// listener lives. A `notify://` name rather than `window://` because this is not
/// about the window: the window is restored here, and what the front end is told
/// is *which session* the click was about.
///
/// Windows-only, because that is the only platform whose delivery path can report
/// a click — see `deliver_notification`.
#[cfg(windows)]
const NOTIFY_ACTIVATED: &str = "notify://activated";

/// One notification, as the front end asks for it.
///
/// The three identity fields exist for the **click** and are echoed back when it
/// happens. They come from the front end because they are facts only the store
/// has: `key` is the bridge's own child handle (the thing the front end addresses
/// a session by), and the runtime's session id and the workspace arrive with
/// `init` — this layer deliberately does not parse the protocol, so it could not
/// produce either of them.
///
/// `session_id` and `workspace` are what `openSession` needs when the child is
/// **gone** by the time somebody clicks: a notification is at least as old as the
/// transition that raised it, and a person who reads it a minute later may have
/// closed that conversation in between. Without them the click could only ever
/// focus a session that is still open, which is the case that needs it least.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    key: String,
    session_id: String,
    workspace: String,
    title: String,
    body: String,
}

/// The click, as the front end receives it.
#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyActivatedPayload {
    key: String,
    session_id: String,
    workspace: String,
}

/// The AppUserModelID a toast is attributed to.
///
/// The identifier from `tauri.conf.json` when the application is **installed**,
/// and PowerShell's when it is not. **This is not a cosmetic choice.** A toast is
/// shown by the shell on behalf of an AUMID Windows already knows, and a build
/// running out of `target/debug` has no registration for `dev.tudouni.aigo` — the
/// call fails with "element not found" and *nothing appears at all*. The plugin
/// makes the same test for the same reason
/// (`tauri-plugin-notification/src/desktop.rs`), which is why a development
/// build's notifications say `powershell` and wear its icon: that is a registered
/// AUMID and this one is not.
///
/// "Installed" is decided by the executable's own directory, which is what
/// separates the two cases here: NSIS puts the exe under Program Files, while
/// every development build stays under `target/{debug,release}`.
#[cfg(windows)]
fn toast_app_id(app: &AppHandle) -> String {
    let development = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .map(|dir| {
            let path = dir.display().to_string();
            path.ends_with(r"target\debug") || path.ends_with(r"target\release")
        })
        .unwrap_or(false);

    if development {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Show one system notification.
///
/// ## Why this command exists instead of the plugin's
///
/// `tauri-plugin-notification` shows a toast on every desktop platform, and on
/// Windows it is built on the very same crate this uses. What it does **not** do
/// is report the click: its `notify` command calls `show()` and drops the
/// notification handle, and its JS documents `onAction` and
/// `onNotificationReceived` as "only emitted on mobile". A toast that knows which
/// session it is about has to own its own activation callback, so Windows gets a
/// toast built here.
///
/// The plugin is still the delivery path **everywhere else**
/// (`deliver_notification`'s other half), so this is not a second
/// implementation of delivery — it is one platform's delivery plus the click.
///
/// ## What the click does
///
/// Two things, in this order:
///
///   1. **Restores the window**, through the same `tray_show_inner` the tray icon
///      uses — show, unminimize, focus. A toast is only ever sent for a session
///      nobody is looking at (`isWatched`), so the window is minimized, hidden, or
///      behind something; a notification that focuses a session inside a window
///      still in the tray would look like nothing happened.
///   2. **Tells the front end which session it was**, as `notify://activated`.
///      Focusing it is the front end's act (`focusSession` / `openSession`), not
///      this layer's: the store is the only thing that knows whether that key is
///      still live, and it is also what clears the session's `unseen` mark.
///
/// A failure is returned as a sentence because the caller is a `void`-ed promise
/// in a hook: a notification that did not arrive costs the old behaviour —
/// everything is still on the screen — and there is nothing to retry.
#[tauri::command]
fn notify_send(app: AppHandle, content: NotifyRequest) -> Result<(), String> {
    if content.title.trim().is_empty() {
        // A toast with no title is a body the shell attributes to nothing.
        return Err("a notification needs a title".to_string());
    }
    deliver_notification(&app, &content)
}

/// The Windows half: a toast whose activation comes back to this process.
///
/// `on_activated` is the whole point — it is attached to the `ToastNotification`
/// object, which the shell keeps alive once it has been shown, and it fires when
/// the toast body is clicked (there are no buttons here, so the action argument
/// is always `None`, which is deliberate: the toast has exactly one meaning).
#[cfg(windows)]
fn deliver_notification(app: &AppHandle, content: &NotifyRequest) -> Result<(), String> {
    let payload = NotifyActivatedPayload {
        key: content.key.clone(),
        session_id: content.session_id.clone(),
        workspace: content.workspace.clone(),
    };

    let target = app.clone();
    let mut toast = Toast::new(&toast_app_id(app))
        .title(&content.title)
        .on_activated(move |_action| {
            // The window first, so the session the event names is on screen by
            // the time the front end focuses it. `run_on_main_thread` because
            // this callback arrives on a COM thread that has nothing to do with
            // the event loop the window belongs to.
            let restore = target.clone();
            let _ = target.run_on_main_thread(move || {
                let _ = tray_show_inner(&restore);
            });
            let _ = target.emit(NOTIFY_ACTIVATED, payload.clone());
            Ok(())
        });

    // Skipped rather than sent empty: `notifyContent` produces no body when a
    // session has neither a workspace nor an id yet, and a `text1` element with
    // nothing in it is a blank second line the shell still reserves.
    if !content.body.is_empty() {
        toast = toast.text1(&content.body);
    }

    toast
        .show()
        .map_err(|e| format!("could not show the notification: {e}"))
}

/// Everywhere else: the plugin, exactly as before.
///
/// Linux and macOS keep the delivery they had — including its limitations, which
/// are the plugin's own permission handshake and toast, not ours. The click is
/// **not** wired up there: on macOS it needs an application delegate and on Linux
/// the notification's default action comes back over D-Bus, and neither is a
/// mechanism this file can borrow. The desktop release target is Windows NSIS, so
/// the honest thing is to keep delivery working and say nothing about a click
/// that will not arrive.
#[cfg(not(windows))]
fn deliver_notification(app: &AppHandle, content: &NotifyRequest) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(&content.title);
    if !content.body.is_empty() {
        builder = builder.body(&content.body);
    }
    builder
        .show()
        .map_err(|e| format!("could not show the notification: {e}"))
}

/* ============================================================
   Resource usage
   ============================================================ */

/// The one `System` handle the whole process shares for resource sampling.
///
/// `cpu_usage()` is a **delta**: it is the difference between two samples of
/// the process's CPU time, and the first sample for a pid has no predecessor,
/// which sysinfo reports as 0.0. A `System` minted per call would therefore
/// report 0.0% CPU **forever** for every process — the numbers would look
/// plausible and be wrong. Keeping one handle for the life of the app is what
/// gives every sample a predecessor, and the first poll after start simply
/// reads 0.0, which is true: no interval has elapsed yet.
///
/// The first sample is taken here, at start-up, and takes roughly a second on
/// Windows: it scans every process on the machine. The app is still in its
/// boot phase at that moment, so the cost lands where it is least visible.
static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

/// What the whole application — this shell and every runtime it has started —
/// is using right now.
///
/// **Process-scoped, not session-scoped.** The question the chip answers is
/// "is this application heavy", and the answer has nothing per session to do
/// with it: one number, with a per-piece breakdown for the tooltip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceUsage {
    /// This shell process's CPU as a percentage of **the machine**, 0..100.
    shell_cpu: f64,
    /// Its memory, in bytes.
    shell_mem: u64,
    /// All running runtimes' CPU summed, same scale as `shell_cpu`.
    runtimes_cpu: f64,
    /// Their memory summed.
    runtimes_mem: u64,
    /// Memory in use by the whole system, in bytes.
    system_mem_used: u64,
    /// Total physical memory, in bytes.
    system_mem_total: u64,
}

/// Sample the shell and every running runtime in one refresh.
///
/// **The sum is divided by the core count.** sysinfo's per-process `cpu_usage`
/// is relative to one core, so a process saturating two cores reads 200.0 —
/// the same convention the task manager's per-process column uses, but the
/// chip here is one small number in a status bar, and a figure that can read
/// "240%" over the whole application is noise. On the machine's scale the
/// answer is the one a person means when they ask "how busy is it".
#[tauri::command]
fn resource_usage(app: AppHandle) -> Result<ResourceUsage, String> {
    let mut system = SYSTEM
        .get_or_init(|| {
            let mut system = System::new();
            // The first sample is taken here, at the first poll, and takes
            // roughly a second on Windows: it scans every process on the
            // machine. The app is still in its boot phase at that moment, so
            // the cost lands where it is least visible.
            system.refresh_all();
            Mutex::new(system)
        })
        .lock()
        .map_err(|_| "the resource lock is poisoned")?;
    system.refresh_all();

    let cores = system.cpus().len().max(1) as f64;

    // `std::process::id` is `u32` on Windows and `usize` elsewhere, and sysinfo
    // asks for a `usize`; the widening is lossless on every platform that is
    // built for.
    let own = system
        .process(Pid::from(std::process::id() as usize))
        .map(|current| (current.cpu_usage() as f64 / cores, current.memory()))
        .unwrap_or((0.0, 0));

    let mut runtimes_cpu = 0.0;
    let mut runtimes_mem: u64 = 0;
    {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        for current in guard.children.values() {
            if let Some(pid) = current.process.pid() {
                if let Some(process) = system.process(Pid::from(pid as usize)) {
                    runtimes_cpu += process.cpu_usage() as f64 / cores;
                    runtimes_mem += process.memory();
                }
            }
        }
    }

    Ok(ResourceUsage {
        shell_cpu: own.0,
        shell_mem: own.1,
        runtimes_cpu,
        runtimes_mem,
        system_mem_used: system.used_memory(),
        system_mem_total: system.total_memory(),
    })
}

/* ============================================================
   Entry point
   ============================================================ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance (decision 12): a second launch focuses the existing
        // window instead of starting a second copy of the application.
        //
        // **The reason is narrower than it used to say, and the correction
        // matters for reading the rest of this file.** It claimed that two
        // instances would "fight over" everything under `<workspace>/.tudouni/`
        // — sessions, the audit log, artifacts, `mcp.json`. Checked against the
        // runtime, that is not true: session files and audit logs are per
        // session id, artifacts and job output are per session id, and
        // `mcp.json` is only ever read. What *is* shared is
        // `permissions.json`, which every runtime rewrites whole (read → modify
        // → rename) whenever somebody presses "always allow" — and one
        // application already runs several runtimes, so that is a property of
        // separate processes rather than of separate applications.
        //
        // What this plugin still buys is the thing a desktop app should have
        // anyway: launching it twice focuses the window you already have instead
        // of opening a second one over it.
        //
        // It is registered **before** every other plugin, which the plugin's own
        // documentation requires: its setup creates the hidden window that
        // receives the "a second copy started" message, and a plugin registered
        // earlier would already have run its setup by then.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch = "I want the app back". That has to work from the
            // tray too: a window hidden into the tray has no taskbar button,
            // so launching the exe again is a natural way to look for it —
            // `unminimize` alone would do nothing for it, so the full restore
            // (show, unminimize, focus) is the same one the tray applies.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // System notifications. The rule for *when* one is sent is the front
        // end's (`runtime/notify.ts`), and this registration is the whole of
        // Rust's part: the plugin owns the permission handshake with the OS and
        // the platform's own delivery, and doing that by hand would be a second
        // implementation of something that already exists.
        //
        // Worth knowing before wiring anything to it: on **Windows, a
        // notification is attributed to the installed application**, so it shows
        // the `powershell` name and icon when running from a development build.
        // That is the plugin's documented behaviour, not a misconfiguration.
        .plugin(tauri_plugin_notification::init())
        // Markdown links open in the OS browser rather than in a new webview:
        // Tauri 2 refuses `window.open`/`target=_blank` by default, and a new
        // webview window would be the wrong container for arbitrary external
        // URLs anyway (CSP is `default-src 'self'`).
        .plugin(tauri_plugin_opener::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![
            runtime_attach,
            runtime_attach_remote,
            install_remote_runtime,
            check_remote_config,
            write_remote_config,
            read_local_config_text,
            runtime_attach_listener,
            runtime_send,
            runtime_shutdown,
            runtime_kill,
            runtime_version,
            runtime_stderr,
            resource_usage,
            set_prevent_sleep,
            os_user_name,
            workspace_check,
            deliverable_open,
            read_ssh_config,
            append_ssh_host,
            probe_remote_host,
            browse_remote_dir,
            create_remote_directory,
            config_read,
            config_write,
            image_stash,
            inline_image,
            close_prompt_answer,
            close_prompt_ack,
            window_destroy,
            notify_send,
        ])
        // The tray is built in `setup` rather than in a builder callback so it
        // can use the app handle the same way the commands do; it must exist
        // before the first hide, because the remembered "minimize" policy can
        // hide the window with no dialog ever drawn (see `make_tray`).
        .setup(|app| {
            make_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window **asks first**, because the X button now means
            // two different things and only the person knows which one they
            // meant: minimize (every session keeps running, hidden) or close
            // (every session finishes, and the application exits).
            //
            // The prompt is drawn by the front end and answered through
            // `close_prompt_answer`, which is the only path back here. That is a
            // deliberate round trip: every overlay in this application is DOM,
            // and a native dialog would be a second visual language for one
            // question.
            //
            // **Three ways this ends, and all three have to exist:**
            //   1. the person answers "minimize" → `minimize()`, children untouched;
            //   2. the person answers "close" → `finish_close` below;
            //   3. nobody answers → the watchdog closes the window anyway, after
            //      `CLOSE_PROMPT_TIMEOUT`.
            //
            // (3) is the one that is easy to leave out and must not be. This
            // handler calls `prevent_close()`, so without a deadline a front end
            // that failed to draw the dialog — a wedged renderer, a tree that
            // threw before `CloseConfirm` mounted — would produce a window that
            // cannot be closed at all. Same reasoning as `SHUTDOWN_TIMEOUT`: the
            // wait has to end.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                // A close request while the prompt is already up is the person
                // pressing X again. It must not stack a second prompt, and it
                // must not be read as an answer: doing nothing leaves the first
                // one up, which is what they are looking at.
                if CLOSE_PROMPT_PENDING.swap(true, Ordering::SeqCst) {
                    return;
                }
                let generation = CLOSE_PROMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

                // Ask the front end. It draws the dialog, and its answer comes
                // back as a command call.
                let _ = window.emit("window://close-requested", ());

                // The deadline, on its own thread so the event loop keeps
                // painting the dialog it is waiting for.
                let window = window.clone();
                thread::spawn(move || {
                    thread::sleep(CLOSE_PROMPT_TIMEOUT);
                    // Still the same question, and still unanswered: fall
                    // through to a real close. `CLOSE_PROMPT_GENERATION` is what
                    // makes this safe — an answered prompt, or a second one
                    // asked afterwards, has moved the number on, and this
                    // thread's whole purpose is then void.
                    if CLOSE_PROMPT_GENERATION.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    // The front end confirmed it drew the dialog, so the wait is
                    // now the person's and has no deadline.
                    if CLOSE_PROMPT_ACK.load(Ordering::SeqCst) {
                        return;
                    }
                    if !CLOSE_PROMPT_PENDING.swap(false, Ordering::SeqCst) {
                        return;
                    }
                    finish_close(window);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("the Tauri application failed to start");
}

#[cfg(test)]
mod inline_image_tests {
    //! The half of `inline_image` that is testable without a Tauri app: the
    //! encoding, and the boundary arithmetic the command applies.
    //!
    //! The command itself needs an `AppHandle`, so it is not called here; what is
    //! pinned is that its two building blocks are right, because both are the kind
    //! of code that fails silently — a base64 off-by-one produces a picture that
    //! decodes to garbage, and a boundary check that lets a `..` through produces
    //! no symptom at all until it matters.

    use super::{base64_encode, INLINE_IMAGE_EXTENSIONS};

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        // Reference values produced by an independent implementation, because the
        // failure mode here is a wrong character rather than a crash.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(&[0, 1, 2, 253, 254, 255]), "AAEC/f7/");
    }

    #[test]
    fn base64_produces_exactly_four_characters_per_three_bytes() {
        // The property that matters for a `data:` URL: a decoder must see whole
        // quanta, so the length is always a multiple of four.
        for length in 0..64usize {
            let bytes: Vec<u8> = (0..length).map(|index| index as u8).collect();
            assert_eq!(
                base64_encode(&bytes).len() % 4,
                0,
                "length {length} did not encode to whole quanta"
            );
        }
    }

    #[test]
    fn the_accepted_extensions_are_the_ones_the_front_end_labels_as_pictures() {
        // `DeliverableCards.tsx` classifies a deliverable as an image by the same
        // extensions; a name it draws a card for but this refuses would be a
        // picture that shows in one place and not the other.
        for extension in ["png", "jpg", "jpeg", "gif", "webp"] {
            assert!(
                INLINE_IMAGE_EXTENSIONS.contains(&extension),
                "{extension} is missing"
            );
        }
        // Not pictures, and must not be read as if they were.
        for extension in ["svg", "html", "txt", "exe"] {
            assert!(
                !INLINE_IMAGE_EXTENSIONS.contains(&extension),
                "{extension} must not be accepted"
            );
        }
    }
}
