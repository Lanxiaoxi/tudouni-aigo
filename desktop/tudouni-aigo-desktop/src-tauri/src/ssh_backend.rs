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
//! SSH channel the same shape, and `spawn_remote` (in `launch_remote.rs`) reuses every
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
//! [`ChannelStderr`] (the stderr reader thread).
//!
//! # Why every call into the channel is non-blocking, and this is not a detail
//!
//! **This is the fix for a deadlock that made every remote session hang at
//! "handshaking" with a healthy runtime on the far end.**
//!
//! The previous version put the whole session in libssh2's *blocking* mode and
//! let each reader sit inside `read()` for as long as the far end stayed quiet.
//! That holds the shared lock for the entire wait, and it composes into a
//! three-way deadlock — the exact hazard the paragraph above used to describe as
//! avoided, while doing it:
//!
//!   1. the **stderr** reader takes the lock and blocks in `read()`. A remote
//!      runtime writes nothing to stderr, so on an idle session this never
//!      returns;
//!   2. the **wait loop** takes the bridge lock and calls `try_wait`, which
//!      needs the channel lock → blocked, still holding the bridge lock;
//!   3. `runtime_stderr` (reached from the WebView, and a **synchronous** Tauri
//!      command) needs the bridge lock → blocked. The renderer's main thread is
//!      now stuck, which is why the window froze completely;
//!   4. the **stdout** reader needs the channel lock → blocked. So the runtime's
//!      own opening `init` was never read, and the session sat in
//!      `handshaking` forever while the remote process ran perfectly.
//!
//! The repair is a discipline rather than a lock: the session is put in
//! **non-blocking** mode once the command is started, and every read and write
//! in this module loops on `WouldBlock`, **releasing the lock between
//! attempts**. No call ever waits on the network while holding the lock, so no
//! thread can starve another and every one of them makes progress.
//!
//! The cost is a poll (see [`POLL_INTERVAL`]): an idle channel is checked a few
//! hundred times a second instead of sleeping on the socket. That is the right
//! trade for three threads sharing one non-thread-safe session, and it is the
//! same shape `spawn`'s own wait loop already uses locally (`try_wait` plus a
//! sleep).

use ssh2::{Channel, Session};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a `WouldBlock` attempt waits before trying the channel again.
///
/// Short enough that a session's first `init` is delivered without a person
/// perceiving a delay (a few milliseconds against a handshake measured in
/// hundreds), and long enough that three threads polling one channel do not
/// spin a core. It is not a timeout: reads use it only to yield the lock, and
/// nothing ever gives up on a live channel that is merely quiet.
const POLL_INTERVAL: Duration = Duration::from_millis(4);

/// How long a **write** may sit in `WouldBlock` before it is a failure.
///
/// Reads may wait indefinitely — an idle session writes nothing, and treating
/// that as broken is exactly the bug the non-blocking loop was introduced to
/// fix. Writes are different: a peer that has stopped draining its receive
/// window for this long is wedged, and retrying forever would hold the caller
/// (and, before the command was made async, the window) for the life of the
/// session. The shutdown path has a 30 s budget; a single line gets 5 s.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// The error a write reports once `WRITE_TIMEOUT` has elapsed.
fn write_timed_out() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "the SSH channel accepted no bytes for 5s; the connection is wedged",
    )
}

/// The error every poisoned-lock path reports. One spelling, so a caller
/// matching on the message (a test, or a person reading a log) sees one string.
fn poisoned() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, "the channel lock is poisoned")
}

/// Writes all of `data`, yielding the lock while the channel reports `WouldBlock`.
///
/// Loop-and-yield rather than one blocking `write_all`: the channel is shared
/// with two reader threads, and holding the lock across a wait for the send
/// window is how the deadlock described in the module doc came back.
fn write_all_yielding(channel: &Arc<Mutex<Channel>>, mut data: &[u8]) -> std::io::Result<()> {
    let deadline = Instant::now() + WRITE_TIMEOUT;
    while !data.is_empty() {
        let result = {
            let mut guard = channel.lock().map_err(|_| poisoned())?;
            guard.write(data)
        };
        match result {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "the channel accepted no bytes",
                ))
            }
            Ok(written) => data = &data[written..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(write_timed_out());
                }
                thread::sleep(POLL_INTERVAL)
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Flushes the channel, yielding the lock while it reports `WouldBlock`.
fn flush_yielding(channel: &Arc<Mutex<Channel>>) -> std::io::Result<()> {
    let deadline = Instant::now() + WRITE_TIMEOUT;
    loop {
        let result = {
            let mut guard = channel.lock().map_err(|_| poisoned())?;
            guard.flush()
        };
        match result {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(write_timed_out());
                }
                thread::sleep(POLL_INTERVAL)
            }
            Err(error) => return Err(error),
        }
    }
}

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
///
/// `WouldBlock` is **retried after releasing the lock**, never propagated: in
/// non-blocking mode "nothing has arrived yet" is the ordinary state of an idle
/// channel, and returning it as `Err` would make `read_until` treat a quiet
/// session as a broken one. The sleep is what keeps the retry from spinning —
/// see the module doc for why this loop is the repair for the hang.
pub struct ChannelStdout {
    channel: Arc<Mutex<Channel>>,
}

impl Read for ChannelStdout {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let result = {
                let mut channel = self.channel.lock().map_err(|_| poisoned())?;
                channel.read(buf)
            };
            match result {
                // A zero-length read is EOF, and `read_until` turns it into a
                // clean stop. It must not be retried.
                Ok(read) => return Ok(read),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL_INTERVAL)
                }
                Err(error) => return Err(error),
            }
        }
    }
}

/// A plain `Read` onto `Channel::stderr()`, the same way [`ChannelStdout`] is
/// onto the ordinary stream — so the stderr-draining thread `spawn_remote`
/// starts can be exactly the local path's loop, against a plain `Read`.
///
/// The same `WouldBlock` retry as `ChannelStdout`, and it matters most here: a
/// remote runtime normally writes **nothing** to stderr, so this reader is
/// parked in this loop for the entire life of the session. Holding the lock
/// across that wait is precisely what used to freeze the window — see the
/// module doc.
pub struct ChannelStderr {
    channel: Arc<Mutex<Channel>>,
}

impl Read for ChannelStderr {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let result = {
                let channel = self.channel.lock().map_err(|_| poisoned())?;
                channel.stderr().read(buf)
            };
            match result {
                Ok(read) => return Ok(read),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL_INTERVAL)
                }
                Err(error) => return Err(error),
            }
        }
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
    // The session is kept alongside the channel (not dropped once the channel
    // is open) because the connection is a fact this type owns, and dropping it
    // while the channel is in use would be the wrong way to think about the
    // lifetime. In practice the ordering is safe either way: `ssh2::Channel`
    // holds its own `Arc` to the session's inner state, so the reader threads'
    // channel clones keep the connection alive until they see EOF or an error.
    // The comment here used to claim the opposite — that declaration order put
    // the channel out of scope first — which was simply not how `ssh2` works.
    #[allow(dead_code)]
    session: Session,
    exit_status: Option<i32>,
}

/// What `spawn_remote` needs to reach a host: resolved connection details,
/// not an alias — alias resolution (`~/.ssh/config`) is a Workspace Manager
/// concern from a later phase, not this transport's.
///
/// `Clone` so the probe's session cache can keep the parameters that produced
/// a connection and answer "is this the same connection?" on the next click.
#[derive(Clone)]
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

    // **Non-blocking from here on, and this is load-bearing.** The command is
    // started (which is the last thing that must wait on the network), and every
    // read/write below yields the shared lock on `WouldBlock` instead of sitting
    // inside libssh2 waiting. In blocking mode, an idle stderr reader held the
    // lock for the life of the session and froze both the stdout reader and the
    // synchronous `runtime_stderr` command — the deadlock the module doc
    // describes in full.
    //
    // The connect timeout bounded the handshake and authentication and must not
    // bound ordinary reads once the runtime is running, which is exactly why
    // this is non-blocking-and-retry rather than a read timeout: a timeout would
    // mistake an idle conversation for a dead one after a fixed interval.
    session.set_blocking(false);

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

    // Resolve first, then connect with the same budget the handshake is given.
    // A bare `TcpStream::connect` uses the OS default (tens of seconds on an
    // unreachable host), so `connect_timeout` used to bound only the SSH part
    // of a connection whose TCP part could already have outlived it.
    let socket = address
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {address}: {e}"))?
        .next()
        .ok_or_else(|| format!("{address} resolved to no address"))?;
    let tcp = TcpStream::connect_timeout(&socket, target.connect_timeout)
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
        let mut channel = self.channel.lock().map_err(|_| poisoned())?;
        if !channel.eof() {
            return Ok(None);
        }
        // EOF means the remote command has nothing left to say, but libssh2
        // can still be waiting on the close/exit-status exchange. `close()` is
        // idempotent and is what makes `exit_status()` meaningful afterwards.
        //
        // `WouldBlock` here is "the exchange has not finished yet", not a
        // failure: report "still running" and poll again. Treating it as an
        // error (the previous `let _ = ...` did exactly that) made a perfectly
        // clean remote exit look like a crash with code -1.
        if let Err(error) = channel.close().map_err(std::io::Error::from) {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error);
        }
        if let Err(error) = channel.wait_close().map_err(std::io::Error::from) {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error);
        }
        // Only now is the exit status authoritative. A failure here is a real
        // protocol fault (the channel closed without reporting one), which the
        // wait loop turns into `-1`; it is not cached as if it were an answer.
        let code = channel
            .exit_status()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
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
        let mut channel = self.channel.lock().map_err(|_| poisoned())?;
        let _ = channel.close();
        let _ = channel.wait_close();
        Ok(())
    }

    fn wait_after_kill(&mut self) {
        // kill() already called wait_close(); there is no separate OS
        // process on this side to reap.
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        write_all_yielding(&self.channel, line.as_bytes())?;
        write_all_yielding(&self.channel, b"\n")?;
        flush_yielding(&self.channel)
    }

    fn shutdown(&mut self) -> std::io::Result<()> {
        write_all_yielding(&self.channel, SHUTDOWN_LINE.as_bytes())?;
        flush_yielding(&self.channel)?;
        // send_eof is the channel's actual "no more input is coming" signal
        // — the remote equivalent of dropping a ChildStdin, without tearing
        // down the channel's ability to still be read from or waited on.
        //
        // Retried on `WouldBlock` for the same reason as every write above:
        // one transient window must not turn a clean shutdown into an error.
        //
        // The error is converted through `io::Error` before its kind is read:
        // `ssh2::Error` has no `kind()` of its own, and `would_block` is what
        // says "the send window is not open yet" rather than "this failed".
        let deadline = Instant::now() + WRITE_TIMEOUT;
        loop {
            let result = {
                let mut channel = self.channel.lock().map_err(|_| poisoned())?;
                channel.send_eof().map_err(std::io::Error::from)
            };
            match result {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(write_timed_out());
                    }
                    thread::sleep(POLL_INTERVAL)
                }
                Err(error) => return Err(std::io::Error::new(std::io::ErrorKind::Other, error)),
            }
        }
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
