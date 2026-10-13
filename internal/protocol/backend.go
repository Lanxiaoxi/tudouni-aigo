package protocol

import "io"

// Backend starts the runtime process somewhere — in this machine or on another
// one reached over SSH — and hands back the three streams the protocol needs.
//
// This is the seam the remote-runtime design calls for: everything in Client
// above this interface is transport-agnostic (JSONL encode/decode, request and
// event dispatch, permission and question routing), and everything below it is
// "how do I get bytes to and from a process". A Backend is the only thing that
// knows whether that process is a local child or the far end of an SSH session.
//
// **Backend does not know the protocol.** It must not peek at a line to decide
// anything; the one exception, protocol readiness, is checked by the caller after
// Start returns, by reading the first message the normal way (see
// Client.StartWithBackend). A Backend that parsed JSON itself would be a second,
// drifting definition of the protocol living outside Client.
type Backend interface {
	// Start launches the runtime and returns its standard streams.
	//
	// stdin is written to by the client; closing it is one of the ways a runtime
	// is told to finish. stdout carries the JSONL protocol exclusively — a
	// Backend that lets anything else reach it (a login banner, a shell startup
	// script's own prints) has failed its one job, which is why
	// RemoteBackend's dial step reports a dirty stream as an error rather than
	// a Client-side problem to clean up. stderr carries diagnostics only, and is
	// drained the same way for either backend: read to the end and discarded, or
	// capped and kept for a notice — never shown on an interface's own screen.
	Start() (stdin io.WriteCloser, stdout io.Reader, stderr io.Reader, err error)

	// Wait blocks until the runtime process has ended and reports its exit code.
	//
	// ok is false when there is no code to report — a connection that dropped
	// before the far end said how the process ended has none, and reporting 0
	// would invent one. This mirors ssh.Channel.Wait and exec.Cmd.Wait, which
	// disagree about this exact case, so Backend states its own contract rather
	// than inheriting either.
	Wait() (code int, ok bool, err error)

	// Kill ends the process without waiting for it. It is the last resort for
	// both backends, for the same reason the existing local Client.Kill is: a
	// kill mid-step can leave a session file with calls that never got results.
	Kill() error

	// Close releases whatever the Backend holds beyond the process itself — for
	// LocalBackend, nothing extra; for RemoteBackend, the SSH session and the
	// connection under it. It is safe to call after Kill or after Wait has
	// returned, and safe to call more than once.
	Close() error
}
