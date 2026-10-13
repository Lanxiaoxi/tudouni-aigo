//! The Remote Backend: starting the runtime over SSH instead of as a local
//! child process.
//!
//! This module's one job mirrors `spawn`'s own doc exactly, for the far end
//! instead of this machine: move bytes, never parse the protocol. Everything
//! that reads `kind` off a line lives in the WebView, same as for a local
//! runtime, and nothing here changes that.
//!
//! # Why a trait, not a second `spawn`
//!
//! `Child_` holds a `std::process::Child` because that is what a local
//! runtime is. A remote runtime is an `ssh2::Channel` instead: no PID, no
//! `wait()` that blocks a whole thread, and a stdin pipe that is the same
//! object as stdout rather than a distinct handle. Rather than duplicate
//! `spawn`'s staging, bridge-locking and queueing logic for a second shape of
//! child, [`RuntimeProcess`] is the one difference factored out: "can this be
//! polled for exit, killed, written to, and read as a stream of lines". A
//! local `std::process::Child` already has that shape; this module gives the
//! SSH channel the same shape, and `spawn_remote` (in `lib.rs`) reuses every
//! other line of `spawn`'s surrounding machinery through the type both can
//! live inside, `Child_`.
//!
//! # No PTY, deliberately
//!
//! This is the same decision `ssh.DialRuntimeSession` makes on the Go side,
//! for the same reason: a PTY opens a login shell, which can print a banner,
//! a MOTD, or anything a person put in their own dotfiles — on **stdout**,
//! the one stream this protocol requires to carry nothing else. Running the
//! remote command directly over a plain SSH channel means nothing speaks on
//! that stream except the runtime binary this session asked for.
//!
//! # One channel, three threads
//!
//! `spawn`'s local path hands each of three threads (stdout reader, stderr
//! reader, wait loop) its own OS handle: `ChildStdout`, `ChildStderr`, and
//! the `Child` itself. `ssh2::Channel` has no such split — one object is
//! simultaneously stdin, stdout, the stderr stream, and the control plane
//! for exit status, and `libssh2` is explicit that it is not safe to drive
//! one `Channel` from two threads at once without serialising the calls
//! externally.
//!
//! So the channel lives behind one `Arc<Mutex<Channel>>`, shared by every
//! piece that touches it: [`SshRuntimeProcess`] (for `write_line`, `kill`,
//! `try_wait`), [`ChannelStdout`] (the stdout reader thread), and
//! [`ChannelStderr`] (the stderr reader thread). Each `read()`/`write()` call
//! takes the lock only for that one call — a blocking read while holding the
//! lock would starve `runtime_send` for however long the far end stays quiet,
//! which on an idle session is most of the time — so the lock is reacquired
//! on every call rather than held across one.

use ssh2::{Channel, Session};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What `spawn`'s wait/kill/send plumbing needs from a running runtime, local
/// or remote.
///
/// Four methods, not three — `write_line` and `shutdown` are split rather
/// than exposing a bare `&mut dyn Write`, because the two concrete types
/// disagree about what "close stdin" even means:
///
///   - a local child's stdin is `ChildStdin`, a handle **separate** from the
///     child itself, and `runtime_shutdown` can `take()` it out of `Child_`
///     and drop it — closing just that pipe while the child keeps running
///     and reading EOF off it, same as `protocol.LocalBackend` on the Go
///     side;
///   - an SSH channel has **no such split**: it is simultaneously stdin,
///     stdout and the control plane for exit status, so there is no handle
///     to take out without taking the whole channel. `send_eof()` is the
///     actual remote equivalent — it tells the far end's command "no more
///     input is coming" without tearing down the channel's ability to still
///     be read from or waited on.
///
/// `shutdown` captures "do whatever this backend's version of closing stdin
/// is" so `runtime_shutdown` does not need to know which of those two shapes
/// it is holding.
pub trait RuntimeProcess: Send {
    /// The OS process id if this runtime runs locally, or `None` for a
    /// remote runtime (whose process lives on the far end of an SSH
    /// connection and has no PID visible from this machine).
    fn pid(&self) -> Option<u32>;

    /// Polls for exit without blocking. `Ok(Some(code))` means it has
    /// already ended; `Ok(None)` means it is still running.
    ///
    /// `code` follows the same convention `spawn`'s local wait thread already
    /// uses: `-1` when the far end ended the connection without reporting a
    /// code the way a signal-killed local process also reports none through
    /// `ExitStatus::code()`.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;

    /// Ends the runtime without waiting for it to exit on its own. The last
    /// resort, same as `Child::kill` — see that type's own callers for why a
    /// kill mid-turn is accepted as a cost rather than engineered around.
    fn kill(&mut self) -> std::io::Result<()>;

    /// Writes one already-encoded protocol line and a trailing newline, then
    /// flushes it. This is `runtime_send`'s one piece of actual I/O, factored
    /// out so it does not need to know which kind of stdin it is writing to.
    /// `line` does not include its own newline; this method appends exactly
    /// one, the same way `runtime_send`'s inline write used to.
    fn write_line(&mut self, line: &str) -> std::io::Result<()>;

    /// Blocks until the runtime has actually ended, after `kill`. For a local
    /// child this reaps the process (so `kill` is not left to produce a
    /// zombie); for a remote one there is no OS-level process on this side
    /// to reap, so this is a no-op that returns immediately — `kill`'s own
    /// channel teardown already waited for the SSH side of it.
    fn wait_after_kill(&mut self);

    /// Writes the `shutdown` message, flushes it, then closes stdin — a
    /// local child's pipe handle, or an SSH channel's EOF signal, whichever
    /// this implementation is. See the trait doc for why these three steps
    /// cannot be decomposed into `write_line` plus a separate `close`: there
    /// is no `close` that means the same thing for both backends, only a
    /// "finish telling it I am done sending" that each implements its own
    /// way.
    fn shutdown(&mut self) -> std::io::Result<()>;
}

/// The `shutdown` message body, written once here rather than at each call
/// site. Matches the Go client's own `Shutdown()` exactly ({"t":"shutdown"}).
const SHUTDOWN_LINE: &str = "{\"v\":1,\"t\":\"shutdown\"}\n";

/// A plain `Read` onto the channel's ordinary stream (the command's stdout),
/// taking the shared lock for each call. This is what `spawn_remote`'s
/// stdout-reading thread is built against — the same `BufReader<R>` /
/// `read_until(b'\n', ..)` loop the local path already uses, unchanged,
/// because both sides of that loop only need a `Read`.
pub struct ChannelStdout {
    channel: Arc<Mutex<Channel>>,
}

impl Read for ChannelStdout {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        channel.read(buf)
    }
}

/// A plain `Read` onto `Channel::stderr()`, the same way [`ChannelStdout`] is
/// onto the ordinary stream — so the stderr-draining thread `spawn_remote`
/// starts can be exactly the local path's loop, against a plain `Read`.
pub struct ChannelStderr {
    channel: Arc<Mutex<Channel>>,
}

impl Read for ChannelStderr {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        channel.stderr().read(buf)
    }
}

/// A remote runtime process: one SSH session, one non-PTY channel running the
/// runtime binary, shared with the stdout and stderr readers behind one lock
/// (see the module doc, "One channel, three threads").
///
/// The session is kept alongside the channel — not dropped once the channel
/// is open — because dropping it would close the TCP connection underneath a
/// channel that is still in use. Releasing both together on `kill` is the
/// same rule `sshChannel.Close` follows on the Go side, for the same reason:
/// a session believed closed must not leave the connection open underneath
/// it.
pub struct SshRuntimeProcess {
    channel: Arc<Mutex<Channel>>,
    // Order matters for Drop: fields are dropped in declaration order, and
    // the Arc<Mutex<Channel>> above (and every other clone of it) must be
    // gone before the session is torn down, since a channel outliving its
    // session is a channel into a closed connection. Both reader structs are
    // owned by threads that end on their own EOF/error, which happens before
    // this field is dropped in every path that calls kill() first — see
    // kill()'s own doc for why that ordering is enforced there rather than
    // left to hope.
    #[allow(dead_code)]
    session: Session,
    exit_status: Option<i32>,
}

/// What `spawn_remote` needs to reach a host: resolved connection details,
/// not an alias — alias resolution (`~/.ssh/config`) is a Workspace Manager
/// concern from a later phase, not this transport's.
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Paths to private key files to try, in order. Passphrase-protected
    /// keys are out of scope for the same reason the Go connector refuses
    /// them: there is nowhere in this flow to ask for a passphrase that does
    /// not put it in a place this program would have to protect forever.
    pub identity_files: Vec<String>,
    /// A password, tried if no identity file authenticates. Empty means none
    /// is configured.
    pub password: Option<String>,
    pub connect_timeout: Duration,
}

/// Connects to `target`, opens one non-PTY channel, and runs `command` on it
/// — the SSH equivalent of `Command::new(binary).args(..).spawn()` in
/// `spawn()`, with the same two things that command never does: no shell
/// metacharacter in `command` is trusted (the caller is responsible for
/// quoting every token, exactly as `protocol.buildRuntimeCommand` does on the
/// Go side), and nothing here parses what comes back.
///
/// Returns the process handle plus a stdout and a stderr reader, each backed
/// by the same shared channel — see the module doc for why none of the three
/// may be used from more than one thread at a time without that shared lock.
///
/// Host key verification is intentionally **not** done here. `ssh2` has no
/// equivalent of Go's `knownhosts.New`, and reimplementing OpenSSH's own
/// known_hosts matching rules inside this crate would be a second, drifting
/// copy of logic the Go side already owns correctly. The design's security
/// requirement — never silently accept an unverified host key — is met by
/// the Workspace Manager phase doing that check (through the Go side, which
/// already has it) before this function is ever called with a target to
/// connect to; this function's own job is only to carry the already-resolved
/// SSH session, not to decide whether to trust it.
pub fn connect(
    target: &SshTarget,
    command: &str,
) -> Result<(SshRuntimeProcess, ChannelStdout, ChannelStderr), String> {
    let session = dial_session(target)?;

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("connected to {}:{} but could not open a session channel: {e}", target.host, target.port))?;

    // No request_pty call: see the module doc for why this must stay a plain
    // channel.
    channel
        .exec(command)
        .map_err(|e| format!("{}:{} accepted the connection but could not start the command: {e}", target.host, target.port))?;

    // The connect timeout bounded the handshake and authentication; it must
    // not also bound ordinary reads once the runtime is running, or an idle
    // conversation would be mistaken for a dead one. Reads block instead,
    // the same way a local pipe read does.
    session.set_timeout(0);

    let shared = Arc::new(Mutex::new(channel));

    Ok((
        SshRuntimeProcess {
            channel: shared.clone(),
            session,
            exit_status: None,
        },
        ChannelStdout { channel: shared.clone() },
        ChannelStderr { channel: shared },
    ))
}

/// Opens the TCP connection, completes the SSH handshake and authenticates —
/// the half of `connect` that has nothing to do with starting the runtime
/// specifically. The install module (`remote_install.rs`) uses this directly:
/// an install runs several separate exec requests (`uname`, the upload, the
/// verify-and-switch command) over the lifetime of one authenticated
/// session, rather than the one long-lived channel `connect` hands to
/// `spawn_remote`.
///
/// See `connect`'s own doc for why host key verification is deliberately
/// not done here either.
pub fn dial_session(target: &SshTarget) -> Result<Session, String> {
    let address = format!("{}:{}", target.host, target.port);
    let tcp = TcpStream::connect(&address)
        .map_err(|e| format!("could not open a TCP connection to {address}: {e}"))?;

    let mut session = Session::new().map_err(|e| format!("could not start an SSH session: {e}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(target.connect_timeout.as_millis().min(u32::MAX as u128) as u32);
    session
        .handshake()
        .map_err(|e| format!("{address} did not complete the SSH handshake: {e}"))?;

    authenticate(&mut session, target)?;
    Ok(session)
}

/// Tries each configured identity file in order, then falls back to a
/// password if one is configured — the same order and the same "either is
/// enough" rule `internal/ssh/dial.go`'s `loadIdentityFiles` uses, kept
/// consistent so a host that works from the Go-side tools behaves the same
/// way here.
fn authenticate(session: &mut Session, target: &SshTarget) -> Result<(), String> {
    let mut problems = Vec::new();

    for path in &target.identity_files {
        match session.userauth_pubkey_file(&target.user, None, std::path::Path::new(path), None) {
            Ok(()) => return Ok(()),
            Err(e) => problems.push(format!("{path}: {e}")),
        }
    }

    if let Some(password) = target.password.as_deref().filter(|p| !p.is_empty()) {
        match session.userauth_password(&target.user, password) {
            Ok(()) => return Ok(()),
            Err(e) => problems.push(format!("password authentication: {e}")),
        }
    }

    if problems.is_empty() {
        return Err(format!(
            "no identity file or password was configured for {}@{}",
            target.user, target.host
        ));
    }
    Err(format!(
        "{} could not be authenticated:\n  - {}",
        target.user,
        problems.join("\n  - ")
    ))
}

impl RuntimeProcess for SshRuntimeProcess {
    fn pid(&self) -> Option<u32> {
        None
    }

    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if let Some(code) = self.exit_status {
            return Ok(Some(code));
        }
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        if !channel.eof() {
            return Ok(None);
        }
        // EOF means the remote command has nothing left to say, but libssh2
        // can still be waiting on the close/exit-status exchange; close() is
        // idempotent and is what makes exit_status() meaningful afterwards.
        let _ = channel.close();
        let _ = channel.wait_close();
        let code = channel.exit_status().unwrap_or(-1);
        self.exit_status = Some(code);
        Ok(Some(code))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        // There is no remote-signal equivalent that is both widely supported
        // and does not need a PTY (`channel_signal` exists but many servers
        // reject it outright); closing the channel is what reliably ends the
        // command's ability to read or write anything further, which is the
        // same "last resort, not an interrupt" Kill already is on the Go
        // side and in the local Rust path. The stdout/stderr reader threads
        // see this as an ordinary read error or EOF and end on their own —
        // nothing here needs to join them.
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        let _ = channel.close();
        let _ = channel.wait_close();
        Ok(())
    }

    fn wait_after_kill(&mut self) {
        // kill() already called wait_close(); there is no separate OS
        // process on this side to reap.
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        channel.write_all(line.as_bytes())?;
        channel.write_all(b"\n")?;
        channel.flush()
    }

    fn shutdown(&mut self) -> std::io::Result<()> {
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned"))?;
        channel.write_all(SHUTDOWN_LINE.as_bytes())?;
        channel.flush()?;
        // send_eof is the channel's actual "no more input is coming" signal
        // — the remote equivalent of dropping a ChildStdin, without tearing
        // down the channel's ability to still be read from or waited on.
        channel
            .send_eof()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    }
}

/// Implements [`RuntimeProcess`] for a local child, so `Child_` can hold
/// either kind behind one `Box<dyn RuntimeProcess>` and every caller —
/// `runtime_kill`, `runtime_shutdown`, `runtime_send`, the wait-loop thread in
/// `spawn` — can stay unaware of which one it has.
pub struct LocalRuntimeProcess {
    child: std::process::Child,
    /// `None` once `shutdown` has taken and dropped it — the same "closing
    /// this pipe is the second half of the shutdown contract" rule `Child_`
    /// used to document directly, now living with the handle it describes.
    stdin: Option<std::process::ChildStdin>,
}

impl LocalRuntimeProcess {
    pub fn new(child: std::process::Child, stdin: std::process::ChildStdin) -> Self {
        Self { child, stdin: Some(stdin) }
    }
}

impl RuntimeProcess for LocalRuntimeProcess {
    fn pid(&self) -> Option<u32> {
        Some(self.child.id())
    }

    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.child.try_wait()?.map(|status| status.code().unwrap_or(-1)))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }

    fn wait_after_kill(&mut self) {
        let _ = self.child.wait();
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stdin already closed"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    fn shutdown(&mut self) -> std::io::Result<()> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin.write_all(SHUTDOWN_LINE.as_bytes())?;
            stdin.flush()?;
            // Dropping the handle closes the pipe — the second half of the
            // shutdown contract described on the trait.
        }
        Ok(())
    }
}
