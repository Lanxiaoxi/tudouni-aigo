package protocol

import (
	"os"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// RuntimeHooks are the directions a runtime needs from its front end: when to stop,
// where a stream increment goes, where an audit record goes, and **how to reach a
// person**.
//
// They are passed to the opener rather than reached for, so the runtime never has to
// name the protocol layer — and neither package ends up importing the other.
type RuntimeHooks struct {
	ShouldStop func() bool
	// OnDelta carries the step the increment belongs to, supplied by the runtime
	// that issued the call. See Server.OnDelta for why it is not derived here.
	OnDelta func(step int, text, reasoning string, reset bool)
	// OnEvent receives one audit record. The server forwards it unchanged and also
	// writes it down on its own side, which is what makes "the audit log is the
	// protocol" true at the byte level.
	OnEvent func(record map[string]any)
	// Channels is how this runtime asks the person on the **other side of the
	// protocol** for an approval or an answer.
	//
	// It is a hook like the other three and for the same reason: without it the
	// opener has no way to ask "who is my front end" and falls back to the terminal
	// it happens to be running on. That failure is not a missing feature — it is a
	// front end that draws an approval panel while the prompt for that same approval
	// is printed underneath it, on stderr, by a process whose stdin nobody is
	// reading. See `openRuntime` in cmd/tudouni.
	Channels Channels
}

// RuntimeOpener builds a runtime for one session.
//
// It is a function parameter rather than an import because this package must not
// know how a runtime is put together. That is the whole point of the protocol
// layer: the day the runtime is assembled differently, or lives in another
// process, or is a stub in a test, nothing here changes.
type RuntimeOpener func(sessionID string, hooks RuntimeHooks) (Runtime, error)

// Main is the entry point for `--runtime-stdio`: the mode a front end starts as a
// child process.
//
// It returns the process exit code. A configuration problem exits 2 with the
// reason on stderr and **nothing at all on stdout** — a front end that sees a
// partially written handshake has to guess, and the guess is always worse than
// being told.
func Main(opener RuntimeOpener, summaries func() []map[string]any,
	initialSession string, autopilot, stream, debug bool) int {

	transport := OpenStdio()
	server := NewServer(transport, Bootstrap{
		SessionSummaries: summaries,
		Autopilot:        autopilot,
		Stream:           stream,
		Debug:            debug,
	})

	open := func(sessionID string) (Runtime, error) {
		return opener(sessionID, RuntimeHooks{
			ShouldStop: server.ShouldStop,
			OnDelta:    server.OnDelta,
			OnEvent:    server.OnEvent,
			// The whole point of this mode: the person is on the other end of the
			// pipe, so an approval has to travel as a message rather than be printed
			// at whatever terminal this child happens to share.
			Channels: server.Channels(),
		})
	}
	server.bootstrap.Factory = open

	runtime, err := open(initialSession)
	if err != nil {
		warn("%v", err)
		return 2
	}
	server.Attach(runtime)

	return server.Serve()
}

// RuntimeDir is where sessions and logs live; a front end needs it only to display
// the audit path, which the runtime already sends in the handshake.
func RuntimeDir() string { return paths.WorkspaceRuntimeDir() }

// StderrIsATerminal reports whether diagnostics are going to a person or to a file.
func StderrIsATerminal() bool {
	info, err := os.Stderr.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
