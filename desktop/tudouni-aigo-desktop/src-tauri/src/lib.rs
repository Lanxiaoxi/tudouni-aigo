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
use std::process::{Child, ChildStdin, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use std::ffi::c_void;

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
    workspace: PathBuf,
    /// This child's slice of the paste staging area, cleared when it exits.
    ///
    /// **Per child, and that is a data-loss fix rather than tidiness.** The
    /// staging directory used to be wiped on every start, which with one session
    /// was the only moment nothing was in flight. With several, starting B would
    /// delete a picture pasted into A that A's runtime had not read yet — and
    /// nothing would say so: the path in A's sentence would simply resolve to no
    /// file, which the runtime treats as an ordinary word.
    staging: PathBuf,
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
                child,
                stdin: Some(stdin),
                requested: false,
                queue: VecDeque::new(),
                stderr: VecDeque::new(),
                workspace: workspace.clone(),
                staging: staging.clone(),
            },
        );

        // Which staging directories belong to somebody: every live child's, plus
        // the one just registered. Collected under the same lock so a concurrent
        // start cannot have its directory removed by this sweep.
        let live: HashSet<PathBuf> = guard
            .children
            .values()
            .map(|current| current.staging.clone())
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
                        Some(current) => match current.child.try_wait() {
                            Ok(Some(status)) => {
                                let requested = current.requested;
                                guard.children.remove(&key);
                                break Some((status.code().unwrap_or(-1), requested));
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
    let stdin = current.stdin.as_mut().ok_or("that session's runtime is shutting down")?;
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

    // Take the handles out rather than cloning them: `ChildStdin` is not
    // cloneable, and moving it out is what makes closing the pipe possible —
    // which is the second half of the shutdown contract, since EOF on stdin takes
    // the same path through the server loop as the message does.
    let pipes: Vec<ChildStdin> = {
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
        let mut pipes = Vec::with_capacity(targets.len());
        for target in targets {
            if let Some(current) = guard.children.get_mut(&target) {
                current.requested = true;
                if let Some(pipe) = current.stdin.take() {
                    pipes.push(pipe);
                }
            }
        }
        pipes
    };

    // One `shutdown` line per session, written before any of them is dropped: the
    // sessions are independent, so asking them in the same pass costs nothing and
    // lets them finish their turns concurrently. Doing this session by session
    // would serialise N times the time a turn takes.
    for mut pipe in pipes {
        let _ = pipe.write_all(b"{\"v\":1,\"t\":\"shutdown\"}\n");
        let _ = pipe.flush();
        // Dropping the handle closes the pipe.
        drop(pipe);
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
                        let _ = current.child.kill();
                    }
                }
                None => {
                    for current in guard.children.values_mut() {
                        let _ = current.child.kill();
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
            let _ = current.child.kill();
            let _ = current.child.wait();
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
        (current.workspace.clone(), current.staging.clone())
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
/// The menu is the three things the icon has to offer and no more: show, a
/// separator, and quit. Quit goes through `runtime_shutdown` on a thread and
/// then `destroy` — the same path as the `/exit` command — because the tray
/// must not raise a close request (the prompt handler would refuse it and
/// leave the application "quitting" forever), and must not kill running turns
/// without the graceful wait `runtime_shutdown` provides.
///
/// Left click shows the window (the near-universal Windows convention);
/// double click is deliberately left to bubble through as its own event and
/// also shows it, via the same `TrayIconEvent::Click` match. The menu still
/// opens on **right** click, because `show_menu_on_left_click` stays off.
fn make_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show tudouni-aigo", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                if let Ok(()) = tray_show_inner(app) {}
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
            runtime_attach_listener,
            runtime_send,
            runtime_shutdown,
            runtime_kill,
            runtime_version,
            runtime_stderr,
            set_prevent_sleep,
            os_user_name,
            workspace_check,
            image_stash,
            close_prompt_answer,
            close_prompt_ack,
            window_destroy,
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
