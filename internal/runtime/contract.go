package runtime

import "github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"

// The runtime's contract with the protocol layer, checked by the compiler.
//
// Each of these is one line that would otherwise be discovered by `go build` in
// whichever package happens to use the interface, and only on the path that uses
// it. A method removed from `Runtime`, renamed, or given a different signature is a
// compile error **here** — in the file that says "this is the implementation of
// that contract" — rather than a type assertion quietly falling back to
// "unsupported".
//
// It is a normal source file rather than a test on purpose: the assertion has to
// hold for the binary that ships. In a `_test.go` file it would only be checked
// when somebody ran the tests for this package, which is not when a protocol change
// breaks the runtime.
//
// The optional interfaces are asserted separately because that is how the protocol
// layer consumes them: `runtime.(GoalRoundRunner)` in a type assertion, with the
// false branch being a real feature (the command answers "this build cannot do
// that"). An assertion here means the implementation exists and matches; it does
// not mean every build reaches those code paths.

// Runtime is the required half: without every one of these methods, nothing works.
var _ protocol.Runtime = (*Runtime)(nil)

// GoalRoundRunner is the automatic continuation path.
var _ protocol.GoalRoundRunner = (*Runtime)(nil)

// GoalArmer lets a goal created during a person's turn start running.
var _ protocol.GoalArmer = (*Runtime)(nil)

// GoalCommander accepts `/goal pause|resume|clear`.
var _ protocol.GoalCommander = (*Runtime)(nil)

// GoalRoundScheduler is how `finishTurn` asks whether another round is allowed.
var _ protocol.GoalRoundScheduler = (*Runtime)(nil)

// FileService answers `file_list` / `file_read`.
var _ protocol.FileService = (*Runtime)(nil)

// TerminalService owns the workspace's shells.
var _ protocol.TerminalService = (*Runtime)(nil)

// CodeIntelService answers `codeintel_action`.
var _ protocol.CodeIntelService = (*Runtime)(nil)

// UsageService answers `usage_stats`.
var _ protocol.UsageService = (*Runtime)(nil)

// MemoryService answers the workspace-memory commands.
var _ protocol.MemoryService = (*Runtime)(nil)

// AuthStartup runs the credential check at the moment the handshake is out.
var _ protocol.AuthStartup = (*Runtime)(nil)

// IndexWarmer is the code index's background warm-up.
var _ protocol.IndexWarmer = (*Runtime)(nil)

// AuthNoticeDrainer is the optional half of the credential reporting: the events
// collected during a turn, handed over once it is finished.
//
// It has no named interface on the protocol side — the server asserts it inline,
// because "does this runtime manage a credential" is a fact about how the process
// was started rather than a capability every runtime must declare. It is asserted
// here anyway, so a change to the method's signature is a compile error rather than
// a silently skipped notice.
var _ interface{ DrainAuthNotices() []map[string]any } = (*Runtime)(nil)
