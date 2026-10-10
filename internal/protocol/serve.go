package protocol

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
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
	// OnTerminalEvent carries one terminal event to the front end as the body of
	// a `ui` message — the protocol layer adds the envelope.
	//
	// It is a hook like the others, and it has to be, for a reason specific to
	// terminals: the objects that produce these events are **process-scoped** (a
	// shell outlives the session that happened to be mounted when it was created),
	// while the transport belongs to the connection. Passing the destination in is
	// what lets a session switch move the events to a new front end without
	// touching the shells — see `terminal.Manager.SetSink`.
	//
	// Nil means "nobody is listening", which is what an in-process front end with
	// nowhere to draw them looks like. The terminals still run and can still be
	// listed; only the byte stream has no reader.
	OnTerminalEvent func(payload map[string]any)
	// Report is where an instruction a person has to **act on** goes when it is
	// produced **while a session is already running**: today, the device code and
	// the verification URI of the managed-token login (`--ericai`).
	//
	// **A message, not stderr, and that is the whole point.** This mode's stderr is
	// drained and dropped by the front end that started this process (see
	// Client.Start), so writing the login instructions there is indistinguishable
	// from not writing them at all: the runtime polls for a device code for its
	// full five-minute timeout while the screen shows nothing, and the symptom
	// reads as "the session hung". A person cannot finish a login they were never
	// shown.
	//
	// Only the **mid-session** half arrives here. A login that happens at open is
	// run once the opening triple has been sent — see Server.emitOpening — so its
	// instructions travel the same way and never wait behind a handshake that is
	// not being written yet.
	//
	// Nil means "nobody asked", and the runtime then writes to its own stderr, which
	// is the right answer for an in-process front end that owns a terminal.
	Report func(level, text string)
}

// RuntimeOpener builds a runtime for one session.
//
// It is a function parameter rather than an import because this package must not
// know how a runtime is put together. That is the whole point of the protocol
// layer: the day the runtime is assembled differently, or lives in another
// process, or is a stub in a test, nothing here changes.
type RuntimeOpener func(sessionID string, hooks RuntimeHooks) (Runtime, error)

// AuthStartup is what a runtime implements when it manages a credential and wants
// to check it before the first turn.
//
// Optional, like the goal hooks and DrainAuthNotices: a runtime that knows nothing
// about tokens does not implement it, and nothing in this layer has to know what a
// token is. The call is **separated from assembly on purpose** — see StartAuth.
type AuthStartup interface {
	StartupAuth()
}

// StartAuth asks a runtime to check its credential at open, and does nothing when
// it does not manage one.
//
// **Why this is not called while the runtime is being assembled.** It used to be,
// and the cost was paid by the person: an interactive login blocks for up to its
// full device-code timeout, so doing it during assembly holds back the whole
// opening handshake — under `--runtime-stdio` the front end has drawn nothing at all,
// and the code the person is asked to type expires before the screen that could show
// it ever appears.
//
// Called once the opening has been sent instead, the instruction reaches a front end
// that is already drawing, and the check is a JWT decode plus, at most, one refresh
// in the ordinary case. Both callers do it this way: `Server.emitOpening` for the
// child process, `cli.Run` for the in-process REPL.
func StartAuth(runtime Runtime) {
	if starter, ok := runtime.(AuthStartup); ok {
		starter.StartupAuth()
	}
}

// Main is the entry point for `--runtime-stdio`: the mode a front end starts as a
// child process.
//
// It returns the process exit code. A configuration problem exits 2 with the
// reason on stderr and **nothing at all on stdout** — a front end that sees a
// partially written handshake has to guess, and the guess is always worse than
// being told.
func Main(opener RuntimeOpener, summaries func(includeArchived bool) []map[string]any,
	deleter func(id string) error, archiver func(id string, archived bool) error,
	initialSession string, autopilot, stream, debug bool) int {

	transport := OpenStdio()
	server := NewServer(transport, Bootstrap{
		SessionSummaries: summaries,
		DeleteSession:    deleter,
		ArchiveSession:   archiver,
		Autopilot:        autopilot,
		Stream:           stream,
		Debug:            debug,
	})
	// A runtime that cannot be assembled is still a message the front end has to
	// receive: it is the reason the session never started, and with the child's
	// stderr out of reach (see Client.Start) the notice channel is the only place it
	// can be read. Wired before the opener runs, because the opener is what fails.
	OpenFailureNotice(server.notice)

	open := func(sessionID string) (Runtime, error) {
		return opener(sessionID, RuntimeHooks{
			ShouldStop: server.ShouldStop,
			OnDelta:    server.OnDelta,
			OnEvent:    server.OnEvent,
			// The whole point of this mode: the person is on the other end of the
			// pipe, so an approval has to travel as a message rather than be printed
			// at whatever terminal this child happens to share.
			Channels: server.Channels(),
			// Terminal output is the one stream that does **not** belong to a
			// session, so its hook is wired here rather than derived from the
			// runtime: the shells are process-scoped and the destination is the
			// connection, which is exactly the pairing `RuntimeHooks.OnTerminalEvent`
			// exists to express.
			OnTerminalEvent: server.SendTerminalEvent,
			// Same reasoning, and the same failure without it: this mode's stderr is
			// drained by the front end (see Client.Start), so an instruction written
			// there reaches nobody. See RuntimeHooks.Report.
			Report: server.reporter,
		})
	}
	server.bootstrap.Factory = open

	runtime, err := open(initialSession)
	if err != nil {
		// Said twice on purpose, to two different readers. The notice is what the
		// front end draws — a sentence instead of a bare exit code — and the stderr
		// line is the contract for somebody running this mode in a plain terminal
		// directly, where nothing else would print the reason.
		if openFailureNotice != nil {
			openFailureNotice("warn", "runtime", i18n.T("channels.runtime.open_failed",
				"problem", err.Error()))
		}
		warn("%v", err)
		return 2
	}
	server.Attach(runtime)

	return server.Serve()
}

// RuntimeDir is where sessions and logs live; a front end needs it only to display
// the audit path, which the runtime already sends in the handshake.
func RuntimeDir() string { return paths.WorkspaceRuntimeDir() }
