//! The registry of running children, and the two events that carry their bytes.
//!
//! One session is one child process, so this is where "which session has a
//! process right now" lives, together with the key the front end holds for it.
//! The bytes themselves are never parsed here — see `crate`'s own doc for why
//! that boundary is load-bearing.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ssh_backend;

/// How many stderr lines to keep for the local diagnostics panel. This is not
/// protocol data and is never shown as session content.
pub(crate) const STDERR_RING: usize = 200;

/// How many stdout lines to hold for a child the WebView has not attached to
/// yet.
///
/// The queue exists for one handshake race and is flushed within a frame of the
/// listener registering, so a legitimate backlog is the opening triple plus
/// whatever a fast runtime emits before the renderer is ready. A cap therefore
/// only bites when the WebView never attaches at all (a crashed renderer, a
/// window that was torn down before its listener ran) — and in that case an
/// unbounded queue grows for the life of the process. Dropping the oldest line
/// is the right end to lose: the newest state is the one a later attach can
/// still act on.
pub(crate) const LINE_QUEUE_LIMIT: usize = 1024;

/// One child's process, shared rather than owned by the bridge map.
///
/// Writes can block for up to `ssh_backend`'s write timeout, so they must not
/// happen while the bridge lock is held: that lock is what every session, every
/// stderr reader and the resource panel need, and one wedged connection holding
/// it would freeze all of them. The `Arc` lets a caller clone the handle under
/// the bridge lock, release it, and only then take the process lock.
pub(crate) type SharedProcess = Arc<Mutex<Box<dyn ssh_backend::RuntimeProcess>>>;

/// Which child a message belongs to.
///
/// Minted by the bridge, monotonic, and **never derived from a session id**. A
/// new session's id is chosen by the runtime and only arrives in `init`, so at
/// the moment the child is started there is no id to name it by. This key is the
/// handle the front end holds for one session's process, and it is also the
/// capability to tear that process down — holding it is what lets a caller act
/// on that session and nothing else.
pub(crate) type ChildKey = u64;

/// A line read from the child, forwarded verbatim, tagged with its origin.
///
/// The tag is load-bearing and cannot be inferred from the line: `session_load`,
/// every `ui` kind, `notice`, `sessions` and both blocking requests carry **no**
/// `session_id` (see `protocol/schema/outbound.schema.json`). A front end that
/// tried to attribute them by reading the payload would attribute the approval
/// prompt to the wrong session, which hangs the one it actually came from —
/// the runtime waits on that id forever.
#[derive(Clone, Serialize)]
pub(crate) struct LinePayload {
    pub(crate) key: ChildKey,
    pub(crate) line: String,
}

/// The child ended. Both a requested shutdown and a crash exit with code 0, so
/// `requested` is the only thing that tells "the session ended" from "the
/// runtime died".
#[derive(Clone, Serialize)]
pub(crate) struct ExitPayload {
    pub(crate) key: ChildKey,
    pub(crate) code: i32,
    pub(crate) requested: bool,
}

/// One diagnostic line from a child. Separate from `runtime://line` because it
/// is not protocol data, and tagged for the same reason: a start-up failure has
/// to be attributable to the session whose binary would not start.
#[derive(Clone, Serialize)]
pub(crate) struct StderrPayload {
    pub(crate) key: ChildKey,
    pub(crate) line: String,
}

#[derive(Default)]
pub(crate) struct Bridge {
    pub(crate) inner: Mutex<BridgeState>,
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
pub(crate) struct BridgeState {
    /// Live children, by key. A key leaves this map only when its child is
    /// reaped, so membership *is* "this session has a process right now".
    pub(crate) children: HashMap<ChildKey, Child_>,
    /// The next key to hand out. Monotonic, never reused: a front end that
    /// still holds a stale key must be told "no such child" rather than have a
    /// newer session answer for the old one.
    pub(crate) next_key: ChildKey,
    /// True once the front end says a listener is in place.
    pub(crate) listening: bool,
}

pub(crate) struct Child_ {
    /// The running runtime, local or remote. See `ssh_backend::RuntimeProcess`
    /// for why this is a trait object rather than a bare `Child`: a remote
    /// runtime has no PID, no separate stdin handle, and a stdin "close" that
    /// means something different (`send_eof` on the SSH channel rather than
    /// dropping a pipe). Shared so I/O can happen outside the bridge lock; see
    /// [`SharedProcess`].
    pub(crate) process: SharedProcess,
    /// True once we have asked for the shutdown ourselves.
    pub(crate) requested: bool,
    /// Lines read before the front end attached, flushed in order on attach.
    pub(crate) queue: VecDeque<String>,
    pub(crate) stderr: VecDeque<String>,
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
    /// For a remote child this is the **local** app's own concept of a workspace
    /// path and is not meaningful: the directory is on the far host, and a
    /// fabricated local one would make the local doors (stash, inline image,
    /// deliverable open) write or read files that do not exist here. It is kept
    /// `None` for a remote child so those doors take the remote branch instead.
    pub(crate) workspace: Option<PathBuf>,
    /// This child's slice of the paste staging area, cleared when it exits.
    /// `None` for a remote child, for the same reason `workspace` is.
    pub(crate) staging: Option<PathBuf>,
    /// The workspace **on the remote host**, for a remote child — the directory
    /// the runtime there treats as its working directory. Pasted pictures land
    /// under `<remote_workspace>/.tudouni/paste/<key>/`, resolved against this
    /// root on the far end. `None` for a local child.
    pub(crate) remote_workspace: Option<String>,
    /// How to reach the host a remote child runs on, kept so the paste's upload
    /// dials the same destination the session itself was started through. The
    /// connection is re-dialled per act (see `remote_files`' module doc) rather
    /// than sharing the runtime's channel. `None` for a local child.
    pub(crate) remote_ssh: Option<RemoteSshConn>,
}

/// The SSH destination of one remote child, as `spawn_remote` was handed it.
///
/// A struct rather than reusing `RemoteAttachOptions` because that type also
/// carries the session's launch arguments, and a connection record that says
/// "and this session's `--max-steps`" is a shape that drifts.
#[derive(Clone)]
pub(crate) struct RemoteSshConn {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) identity_files: Vec<String>,
    pub(crate) password: Option<String>,
    pub(crate) connect_timeout: Duration,
}

impl RemoteSshConn {
    pub(crate) fn to_target(&self) -> ssh_backend::SshTarget {
        ssh_backend::SshTarget {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            identity_files: self.identity_files.clone(),
            password: self.password.clone(),
            connect_timeout: self.connect_timeout,
        }
    }
}

/// Put a diagnostic line on the same channel the children's stderr uses.
///
/// `key` 0 means "the bridge itself, not a session" — the front end has no
/// session bucket to file it under, which is exactly right for a directory that
/// could not be read.
pub(crate) fn report_stderr(app: &AppHandle, key: ChildKey, line: String) {
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
pub(crate) fn forward_line(app: &AppHandle, key: ChildKey, line: String) {
    let state: State<Bridge> = app.state();

    let attached = {
        let mut guard = match state.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if guard.listening {
            true
        } else if let Some(current) = guard.children.get_mut(&key) {
            // Bounded: see `LINE_QUEUE_LIMIT`. The oldest line goes first so a
            // listener that attaches late still sees the newest state.
            if current.queue.len() >= LINE_QUEUE_LIMIT {
                current.queue.pop_front();
            }
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
