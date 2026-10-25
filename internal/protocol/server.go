package protocol

import (
	"context"
	"sync"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// Runtime is what the protocol layer needs from a mounted runtime.
//
// It is an interface rather than a concrete type for one reason, and it is the
// reason this package can be tested at all: the protocol layer must not know how a
// runtime is assembled. Anything it needed to import from the assembly layer would
// make the boundary a formality.
type Runtime interface {
	SessionID() string
	// Messages is the session's raw message list, sent whole on session_load.
	Messages() []map[string]any
	// InitFields are the handshake fields this runtime contributes.
	InitFields() map[string]any
	// StatsLine is the one-line report the line REPL prints after each turn:
	// cumulative usage, this turn's duration, and how full the context is.
	//
	// It comes from the runtime rather than being assembled by the front end
	// because every number in it is counted from the audit log — the same log
	// `--audit` reads — and two places counting the same fact is how they stop
	// agreeing.
	StatsLine() string
	// ProgressLine is the human's one-line view of the task list, or "" when there
	// is none. The model takes a different view of the same list: it wants what is
	// left and what is in progress, a person wants "2/5 done" at a glance.
	ProgressLine() string
	// JobsProgressLine is the same idea for the background jobs: "2 running, 1
	// result not collected" plus the ids, or "".
	//
	// It is one notch more important than the task line — an uncollected job is a
	// process still running on somebody's machine — which is why the line terminal
	// re-states it every round.
	JobsProgressLine() string
	// GoalLine is the one-line report of the session's long-running goal, or "".
	//
	// It is here rather than only in the panel snapshot because a goal changes what
	// the session *is*: after a turn that created, completed or paused one, the
	// person needs to be told in the transcript. A panel is read when somebody
	// looks at it; this line arrives.
	GoalLine() string
	// GoalPanel is the goal as a panel payload: flat, JSON-safe, and always
	// present (a session with no goal reports the empty shape rather than omitting
	// the key, so a front end has one case to draw rather than two).
	GoalPanel() map[string]any
	StateMessage(withCatalog bool) map[string]any
	StatusMessage() map[string]any
	ToolsMessage() map[string]any
	ContextMessage() map[string]any
	SkillsMessage() map[string]any
	MCPMessage(action string, servers []string) (map[string]any, []string)
	Compact() (map[string]any, error)
	SessionSummaries() []map[string]any

	SetAutopilot(on bool)
	SetModel(name string) (bool, string)
	SetThinking(on bool) (bool, string)
	SetEffort(level string) (bool, string)

	// RunTurn runs one turn and returns the answer.
	//
	// The context is this turn's cancellation. It is a parameter rather than
	// something the runtime holds because a turn is what gets cancelled and the
	// runtime outlives it: the same runtime serves every turn of a session, and a
	// cancelled context left on it would stop the *next* turn at its first safe
	// point.
	RunTurn(ctx context.Context, text string) (string, error)
	Close() error
}

// Factory builds a runtime for a session. It is how a session switch replaces the
// runtime without restarting the process.
type Factory func(sessionID string) (Runtime, error)

// Bootstrap carries the process-level facts a new runtime inherits.
//
// A session switch rebuilds the runtime — new model client, new tool registry, new
// MCP connections — but these stay: the second session must write to the same audit
// directory and load skills from the same place.
type Bootstrap struct {
	// SessionSummaries lists the saved sessions, for the picker. The argument is
	// whether archived sessions are included: the filter has to happen here, before
	// the list's own cap, or archiving would free no slot (see the runtime's
	// `SessionSummaries`). A front end that has no archive concept asks for the
	// unfiltered list, which is why the protocol's default is to include them.
	SessionSummaries func(includeArchived bool) []map[string]any
	// DeleteSession removes one saved session. A nil hook refuses to delete —
	// the same fail-closed rule the nil Factory follows for switching.
	DeleteSession func(id string) error
	// ArchiveSession sets or clears one session's archived flag. A nil hook refuses,
	// like the two above. It is a separate hook from DeleteSession because the two
	// act on different things: one erases a file, the other edits a flag, and a
	// caller wired with a deleter but no archiver should be told archiving is
	// unavailable rather than have it silently do nothing.
	ArchiveSession func(id string, archived bool) error
	// ForkSession copies one saved session up to a chosen reply, under a fresh id,
	// and returns the new id. A nil hook refuses, like the others: a front end that
	// sends the message to a runtime that cannot fork gets a notice, not a copy
	// made from nothing.
	ForkSession func(id, reply string, userBefore int) (string, error)
	// Factory builds a runtime for a session id. A nil factory refuses to switch.
	Factory Factory
	// Autopilot is the process-level switch; a new runtime is assembled with it.
	Autopilot bool
	// Stream is whether this run streams.
	Stream bool
	// Debug turns on payload dumps.
	Debug bool
}

// Server speaks the protocol on behalf of one runtime.
type Server struct {
	transport Transport
	bootstrap Bootstrap

	mu      sync.Mutex
	runtime Runtime

	// stop is this turn's cancellation flag, cleared at the start of every turn
	// by startTurnWith. It is what the agent polls through Options.ShouldStop.
	stop bool

	// turnCtx is this turn's cancellation, and turnCancel is how it is cancelled.
	// They are created together at the start of every turn and cancelled by
	// requestStop.
	//
	// The flag above and this context carry the same fact to two different places,
	// and both are needed. The flag is what a **synchronous** check can read — the
	// goal driver asks it after the turn is over whether the person had asked to
	// stop — while the context is the only thing that can reach work which is
	// blocked: a request waiting for its first byte, a shell command, a handler
	// sleeping on a background job. A stop that only set the flag was noticed at the
	// next safe point, which for a slow command is minutes later.
	turnCtx    context.Context
	turnCancel context.CancelFunc

	// pending holds the two kinds of request that block until a front end answers.
	pending *pendingTable

	// Two locks with two jobs, and they must not be merged: send protects the
	// write to the transport, state protects the three fields the event handler
	// records on the side. Holding the send lock while reading the state would
	// deadlock the moment the event handler tried to send.
	sendLock  sync.Mutex
	stateLock sync.Mutex
	lastRunID string
	lastStep  int
	callID    string

	turnMu   sync.Mutex
	turnDone chan struct{}

	// goalRound is the reserved round the running (or next) turn is running. It is
	// written before the turn's goroutine starts and read by it, which is safe for
	// the same reason `turnDone` is: both happen under turnMu, and turnMu is held
	// for the whole handover.
	goalRound GoalRound

	// sessionFilter remembers whether the last `session_list` asked for archived
	// sessions. It exists because the list is also re-sent for reasons the front end
	// did not ask about — after a delete, after an archive — and those answers must
	// carry the same filter as the request that established the view. Answering them
	// unfiltered would put an archived row back on a list that had just hidden it,
	// and answering them filtered when the front end wanted everything would hide a
	// session it could not get back. Default true: the unfiltered list is what a
	// front end with no archive concept (CLI, TUI) must get.
	//
	// "No request yet" and "asked for everything" are the same value, and that is
	// the honest default rather than a loss: the first answer a front end gets is
	// the unfiltered list either way.
	sessionIncludeArchived bool
}

// GoalRound is one reserved automatic round, as this layer needs to see it.
//
// It is an interface rather than a struct so that the protocol layer keeps knowing
// nothing about how a goal is stored: the driver builds the thing, the server
// carries it, and the runtime decides whether it is still valid. Nothing here reads
// its contents, which is what keeps "what a round is" from having two definitions.
type GoalRound interface {
	GoalID() string
	Revision() int
	Round() int
	Messages() []map[string]any
}

// GoalRoundRunner is what a runtime must provide for automatic continuation.
//
// It is optional — a runtime that does not implement it simply never continues,
// which is the behaviour of every build before this one — and `StartGoalRound`
// reports whether a turn actually ran, so a reservation that went stale while it
// waited costs nothing.
type GoalRoundRunner interface {
	StartGoalRound(ctx context.Context, round GoalRound) (answer string, started bool, err error)
}

// GoalArmer is what a runtime must provide for a goal created during a turn to
// start running.
//
// It is a separate optional interface from the scheduler because the two are
// different questions asked at the same instant: "should this session continue?"
// is the scheduler's, and "is this session allowed to?" is this one's. Collapsing
// them would hide the rule that only a person's turn may grant the authorization.
type GoalArmer interface {
	ArmFromTurn()
}

// GoalCommander is what a runtime must provide to accept a goal command.
//
// Optional like the rest of the goal surface: a runtime that does not implement it
// answers the command with a notice saying so, which is better than a command that
// appears to work.
type GoalCommander interface {
	GoalCommand(action string) (map[string]any, error)
}

// FileService is what a runtime must provide for the workspace's file
// capability.
//
// Optional, like every other feature interface here: a runtime that does not
// implement it answers `file_list` / `file_read` with a notice saying so, which
// beats a silent empty list — "this directory is empty" and "this build cannot
// read files" look identical on screen, and the second one is a bug nobody
// reports.
//
// Both methods return the payload the `ui` message carries, minus the envelope.
// The protocol layer does not know what a directory entry is; it puts `v` / `t` /
// `kind` on whatever comes back, the same way it does for `status` and `tools`.
type FileService interface {
	ListFiles(path string) (map[string]any, error)
	ReadFile(path string) (map[string]any, error)
}

// TerminalService is what a runtime must provide for the workspace's terminals.
//
// It is the verbs a terminal really has rather than one verb-and-arguments pair,
// and collapsing them would put a `switch` on the runtime side of a boundary
// whose whole job is to keep that switch out of the protocol layer.
//
// `CreateTerminal` is the one that can fail with something to report — an
// escaped cwd, a PTY that will not start — and it returns an error rather than an
// empty row, because a front end given a row would remember an id for a shell that
// does not exist.
type TerminalService interface {
	ListTerminals() []map[string]any
	CreateTerminal(cwd string, cols, rows int) (map[string]any, error)
	// TerminalInput has no return payload: a terminal is an asynchronous stream,
	// not a request/response. See the schema's own note on `terminal_input`.
	TerminalInput(id, data string) error
	TerminalResize(id string, cols, rows int) error
	TerminalKill(id string) error
	// RemoveTerminal drops a terminal that has already **ended** from the list.
	// It is separate from TerminalKill because it does a different thing to a
	// different thing: that one ends a process, this one deletes a record. See
	// `terminal.Manager.Remove` for why a running one is refused.
	RemoveTerminal(id string) error
}

// GoalRoundScheduler is what a runtime must provide to be asked whether another
// round is allowed once a turn has finished.
//
// `ObserveTurn` is given the finished turn's outcome and the server's own queue
// function, and returns the decision it made. The runtime owns the arming state,
// the round budget and the audit record; the server owns the two things it knows
// better — when a turn finished, and how to start one.
type GoalRoundScheduler interface {
	ObserveTurn(outcome error, stopped bool, queue func(GoalRound) bool) string
}

// NewServer builds a server.
func NewServer(transport Transport, bootstrap Bootstrap) *Server {
	return &Server{
		transport: transport,
		bootstrap: bootstrap,
		pending:   newPendingTable(),
		turnDone:  closedChan(),
	}
}

// Attach mounts a runtime.
//
// Before this call no request can arrive: the channels handed out by Channels()
// read the runtime lazily, and the pending table only exists once a runtime holds
// it. That ordering is the invariant, and it is cheaper than defending against
// requests arriving before anybody can answer them.
func (s *Server) Attach(runtime Runtime) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runtime = runtime
}

func (s *Server) current() Runtime {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runtime
}

// Serve runs the read loop until end of stream or shutdown.
func (s *Server) Serve() int {
	runtime := s.current()
	if runtime == nil {
		warn("[protocol] no runtime is attached; nothing to serve")
		return 1
	}

	s.emitOpening()

	for {
		message, ok := s.transport.Recv()
		if !ok {
			break
		}
		if !s.Dispatch(message) {
			break
		}
	}

	if err := s.transportFailure(); err != nil {
		warn("[protocol] %v", err)
	}

	// Wake every waiting request before leaving. Without this the last approval
	// stays blocked forever and the child never exits — the front end is gone, so
	// nothing will ever answer it.
	s.pending.abandonAll()
	s.joinTurn()
	if skipped := s.transport.Skipped(); skipped > 0 {
		warn("[protocol] skipped %d unreadable line(s) on stdin", skipped)
	}
	_ = s.transport.Close()
	return 0
}

func (s *Server) transportFailure() error {
	if reader, ok := s.transport.(*StdinStdout); ok {
		return reader.reader.Err()
	}
	return nil
}

// Dispatch handles one inbound message. It returns false when the loop should stop.
func (s *Server) Dispatch(message map[string]any) bool {
	// The envelope version is the one place this layer fails hard. Everything
	// else — an unknown kind, an unknown field — is ignored and the loop goes on,
	// because the two ends upgrade on their own schedules and dying on an
	// unfamiliar message is the least necessary compatibility loss there is.
	if err := CheckVersion(message, DirectionFromFrontend); err != nil {
		warn("[协议] %v", err)
		return false
	}

	switch TypeOf(message) {
	case InShutdown:
		// Let the loop exit, and nothing else. The current turn finishes first:
		// interrupting it would leave an assistant message with tool_calls and no
		// results, which makes the session permanently unsendable.
		return false

	case InInterrupt:
		s.requestStop()

	case InPermissionResponse:
		id, _ := String(message, "id")
		decision, _ := String(message, "decision")
		s.pending.resolve(id, decision)

	case InQuestionResponse:
		id, _ := String(message, "id")
		status, _ := String(message, "status")
		text, _ := String(message, "text")
		s.pending.resolve(id, questionAnswer{status: status, text: text})

	case InSessionSwitch:
		s.switchSession(message)

	case InSessionList:
		s.sessionList(message)

	case InSessionDelete:
		s.deleteSession(message)

	case InSessionArchive:
		s.archiveSession(message)

	case InSessionFork:
		s.forkSession(message)

	case InSetAutopilot:
		on, _ := Bool(message, "on")
		s.setAutopilot(on)

	case InSetModel:
		name, ok := String(message, "model")
		if !ok {
			s.notice("warn", "model", i18n.T("channels.model.needs_string"))
			return true
		}
		s.setModel(name)

	case InSetThinking:
		on, _ := Bool(message, "on")
		s.setThinking(on)

	case InSetEffort:
		level, ok := String(message, "effort")
		if !ok {
			s.notice("warn", "effort", i18n.T("channels.effort.needs_string"))
			return true
		}
		s.setEffort(level)

	case InStatus:
		runtime := s.current()
		if runtime == nil {
			s.notice("warn", "status", i18n.T("channels.status.no_session"))
			return true
		}
		send := runtime.StatusMessage()
		s.Send(map[string]any{"v": VERSION, "t": OutUI, "kind": UIStatus,
			"status": send["status"], "last_prompt_tokens": send["last_prompt_tokens"],
			"context_tokens": send["context_tokens"]})

	case InTools:
		runtime := s.current()
		if runtime == nil {
			s.notice("warn", "tools", i18n.T("channels.tools.no_session"))
			return true
		}
		payload := runtime.ToolsMessage()
		payload["v"] = VERSION
		payload["t"] = OutUI
		payload["kind"] = UITools
		s.Send(payload)

	case InContext:
		runtime := s.current()
		if runtime == nil {
			s.notice("warn", "context", i18n.T("channels.context.no_session"))
			return true
		}
		payload := runtime.ContextMessage()
		payload["v"] = VERSION
		payload["t"] = OutUI
		payload["kind"] = UIContext
		s.Send(payload)

	case InSkills:
		runtime := s.current()
		if runtime == nil {
			s.notice("warn", "skills", i18n.T("channels.skills.no_session"))
			return true
		}
		payload := runtime.SkillsMessage()
		payload["v"] = VERSION
		payload["t"] = OutUI
		payload["kind"] = UISkills
		s.Send(payload)

	case InCompact:
		s.startCompact()

	case InMCP:
		s.handleMCP(message)

	case InCodeIntel:
		s.handleCodeIntel(message)

	case InUsageStats:
		s.handleUsage()

	case InGoal:
		s.handleGoal(message)

	case InRefreshState:
		s.Send(s.stateMessage(false))

	case InFileList:
		s.handleFileList(message)

	case InFileRead:
		s.handleFileRead(message)

	case InTerminalList:
		s.handleTerminalList()

	case InTerminalCreate:
		s.handleTerminalCreate(message)

	case InTerminalInput:
		s.handleTerminalInput(message)

	case InTerminalResize:
		s.handleTerminalResize(message)

	case InTerminalKill:
		s.handleTerminalKill(message)

	case InTerminalClose:
		s.handleTerminalClose(message)

	case InSubagentStop:
		s.handleSubagentStop(message)

	case InMemoryList:
		s.handleMemoryList()

	case InMemoryAction:
		s.handleMemoryAction(message)

	case InUserMessage:
		text, _ := String(message, "text")
		s.startTurn(text)

	default:
		// Ignored on purpose. See the comment on CheckVersion.
	}
	return true
}

// Send writes one message, swallowing the failure.
//
// A failed write is reported once and then ignored: the front end may have closed
// its end, which is its business, and taking the runtime down over it would lose a
// session that is otherwise fine.
func (s *Server) Send(message map[string]any) {
	s.sendLock.Lock()
	defer s.sendLock.Unlock()
	if err := s.transport.Send(message); err != nil {
		warn("%s", i18n.T("channels.write_failed", "problem", err.Error()))
	}
}

func (s *Server) notice(level, code, text string) {
	s.Send(map[string]any{
		"v": VERSION, "t": OutNotice,
		"level": level, "code": code, "text": text,
	})
}

// SendTerminalEvent forwards one thing a terminal has to say.
//
// The payload arrives already shaped (see `runtime.terminalEventPayload`), because
// what a terminal event *is* is a fact about terminals and this layer deliberately
// does not know one when it sees it. All this adds is the envelope — the same
// division of labour `ToolsMessage` and `StatusMessage` follow in the other
// direction.
//
// It is called from the terminal's **own goroutines**, so it must not block: the
// transport's write lock is the only thing it waits on, and `Send` already
// swallows a write failure rather than propagating it. That matters more here than
// anywhere else in the protocol, because a terminal whose reader stalled would
// have its PTY fill and its shell freeze — a bug on this side wearing the costume
// of a bug in the person's own command.
//
// A nil payload means "there is nothing to send", which is what an event kind this
// build does not recognise produces. Inventing a message for it would be a line
// the front end cannot parse.
func (s *Server) SendTerminalEvent(payload map[string]any) {
	if payload == nil {
		return
	}
	envelope := map[string]any{"v": VERSION, "t": OutUI}
	for key, value := range payload {
		envelope[key] = value
	}
	s.Send(envelope)
}

// SendCodeIntelEvent is the code index's equivalent of SendTerminalEvent.
//
// A separate method rather than a shared one because the two are called from different
// goroutines and routed by different hooks; the body is the same envelope and that is the
// only thing they share. See RuntimeHooks.OnCodeIntelEvent.
//
// Called from the build's own goroutine, so the same rule applies: never block, and let
// `Send` swallow a write failure.
func (s *Server) SendCodeIntelEvent(payload map[string]any) {
	if payload == nil {
		return
	}
	envelope := map[string]any{"v": VERSION, "t": OutUI}
	for key, value := range payload {
		envelope[key] = value
	}
	s.Send(envelope)
}

// reporter is where an instruction a person has to **act on** goes when it is
// produced while a session is already running: today, the device code and its
// verification URI from a managed-token login (`--ericai`).
//
// It is a hook rather than a direct call because the runtime must not know how to
// reach a front end — see RuntimeHooks.Report. The `code` is `auth` for the same
// reason `DrainAuthNotices` uses it: the front end draws the sentence verbatim and
// logs it under the credential's own kind, and this layer still knows nothing about
// what a token is.
//
// **Only the mid-session half comes through here.** A check made at open is run by
// `emitOpening`, after the handshake is on the wire, so it arrives as an ordinary
// notice too rather than being folded into `init` — see Server.emitOpening and
// StartAuth. Both halves therefore reach a person the same way, which is the point:
// there is one delivery path for instructions, not two.
func (s *Server) reporter(level, text string) {
	if level == "" {
		level = "info"
	}
	s.notice(level, "auth", text)
}

// openFailureNotice carries the reason a runtime could not be assembled out of this
// process, for `Main` to send before it exits.
//
// Without it the reason exists only on stderr — and the front end that started this
// process as its child deliberately does not inherit that stream any more (see
// Client.Start), because the stream is the terminal it is drawing on. The result was
// the worst of both: a full-screen interface showing nothing, and a user with a bare
// exit code where the sentence explaining the failure used to be.
//
// It cannot be told to the server's own `Main` through the runtime, because there is
// no runtime: the opener is what failed. Hence the channel below, which `Main` wires
// once at start-up. It is deliberately not a general back channel — the field lives
// nowhere else in this layer.
var openFailureNotice func(level, code, text string)

// OpenFailureNotice points the pre-runtime failure reporter at a transport.
//
// It is exported so the entry point can wire it without this package knowing how a
// runtime is opened. Process-wide, like the one failure it reports.
func OpenFailureNotice(report func(level, code, text string)) {
	openFailureNotice = report
}

// emitOpening sends the three messages every session starts with.
//
// It is one method because it runs in two places — at startup and after a
// successful session switch — and the order and the fields have to match exactly.
// Two copies of it would drift, and the drift would show up as a panel that is
// populated differently depending on how the session was reached.
func (s *Server) emitOpening() {
	runtime := s.current()
	if runtime == nil {
		return
	}
	init := map[string]any{"v": VERSION, "t": OutInit, "protocol": PROTOCOL}
	for key, value := range runtime.InitFields() {
		init[key] = value
	}
	s.Send(init)

	s.Send(map[string]any{"v": VERSION, "t": OutSessionLoad, "messages": runtime.Messages()})

	// The first snapshot carries the skill catalog; later ones do not. Scanning
	// the skill directory costs real time, and the result almost never changes.
	s.Send(s.stateMessage(true))

	// The credential check, and it is **after** the opening rather than inside the
	// assembly. That ordering is the whole point: an interactive login blocks for up
	// to its device-code timeout, and the instruction a person has to act on comes
	// out of it. Run while the runtime is being assembled, it holds back every
	// message above — so a front end that has drawn nothing has nowhere to show the
	// code, and the code expires before the screen that could show it exists. Here,
	// the handshake is already out and the instructions travel as an ordinary notice.
	//
	// It runs for a session switch too, which is right: the switch built a new client
	// holding whatever key the config had at that moment.
	StartAuth(runtime)

	// The code index's background warm-up, for the same reason the credential check
	// is here rather than in the assembly: the pass can take seconds, and what it
	// buys is the first code question not paying for the catch-up. It returns at
	// once and works while the person reads and types, so it is the last thing the
	// opening does — after the check that can block.
	WarmupIndex(runtime)
}

func (s *Server) stateMessage(withCatalog bool) map[string]any {
	runtime := s.current()
	if runtime == nil {
		return map[string]any{"v": VERSION, "t": OutUI, "kind": UIState}
	}
	payload := runtime.StateMessage(withCatalog)
	payload["v"] = VERSION
	payload["t"] = OutUI
	payload["kind"] = UIState
	return payload
}
// OnEvent forwards one audit record.
//
// The record is forwarded exactly as it was written to the audit log — not a field
// more, not a field less. That is what makes "the audit log is the protocol" true
// at the byte level, and it means whatever `--audit` can show, a front end can
// show too.
//
// The one addition is `child`, and it is added rather than inferred because the
// alternative is every front end re-deriving the same rule.
//
// **`child` means "this record came from a delegated agent", and the runtime says
// so with `child_origin`.** It is not the same as "this record mentions a
// subagent": the parent's own `tool_result` for a subagent call carries
// `subagent_id` so an interface can connect the two, and it is still the parent's
// own result — the thing that ends the parent's tool call and gets drawn in the
// parent's transcript. Classifying by `subagent_id` would delete the delegation's
// answer from the only place it is shown.
//
// The distinction is made by the runtime rather than here because telling a
// child's session id from the parent's is a question about sessions, and this
// layer deliberately knows nothing about what a session is.
func (s *Server) OnEvent(record map[string]any) {
	kind, _ := record["kind"].(string)

	// A child's record is forwarded and otherwise ignored. It must not touch
	// `lastStep` or `callID`: `lastStep` decides which streaming block a delta
	// belongs to, and `callID` is what an approval request names as the call it is
	// about. Letting a child's tool call land in either would make the parent's
	// next delta attach to the wrong step and its next approval prompt name a call
	// the user never made — both are wrong in a way that reads as a runtime bug
	// rather than as a bookkeeping mistake.
	if child, _ := record["child_origin"].(bool); child {
		s.forwardChild(record, kind)
		return
	}

	s.stateLock.Lock()
	switch kind {
	case "run_started":
		s.lastRunID, _ = record["run_id"].(string)
	case "tool_call":
		// Remembered so an approval request can say which call it belongs to. It
		// is recorded on the side rather than read back out of the message, because
		// the approval is built by a different goroutine than the one that read it.
		s.callID, _ = record["call_id"].(string)
		fallthrough
	case "model_call", "tool_result", "tool_batch":
		if step, ok := Int(record, "step"); ok {
			s.lastStep = step
		}
	}
	s.stateLock.Unlock()

	envelope := map[string]any{"v": VERSION, "t": OutEvent, "kind": kind}
	for key, value := range record {
		// `child_origin` is the runtime's note to this layer and does not travel:
		// `child` is what a front end reads, and two spellings of one fact is how
		// they end up disagreeing.
		if key == childOriginKey {
			continue
		}
		if _, taken := envelope[key]; taken && key != "kind" {
			continue
		}
		envelope[key] = value
	}
	s.Send(envelope)

	if kind == "tool_result" {
		// The task list and the loaded skills change on a tool result, and the
		// background board is polled here. Keying this off the tool name would make
		// the protocol layer know about specific tools — the exact coupling the
		// interface exists to prevent.
		//
		// It is also the snapshot that retires a delegation's row: the parent's
		// `subagent` call ending is a tool result like any other, so the badge is
		// cleared by the same rule that refreshes every other panel.
		s.Send(s.stateMessage(false))
	}

	// A delegation starting or finishing changes what the interfaces should show,
	// and neither moment produces a tool result of its own — the parent's `subagent`
	// call is still running when it starts, and when it finishes the row is already
	// gone. Without this the badge would only ever be drawn after the delegation was
	// over, which is the one time it is useless.
	//
	// **These two records arrive on this path, not the child's.** They are the
	// parent's own account of having delegated: their `session_id` is the
	// parent's session. Their `run_id`, however, is the **child's** id, not the
	// parent's turn (`internal/subagent/spawn.go` passes `childID`), so a front
	// end must not use it to attribute these rows to a turn. Putting this in
	// `forwardChild` reads correctly and does nothing, because that branch never
	// sees these kinds.
	//
	// It hears about the two transitions rather than about every child event, so a
	// subagent that makes forty tool calls sends one extra snapshot, not forty.
	if kind == "delegation_started" || kind == "delegation_finished" {
		if notifier, ok := s.current().(interface{ OnDelegationChanged() }); ok {
			notifier.OnDelegationChanged()
		}
		s.Send(s.stateMessage(false))
	}

	// The delegation's own facts that a person needs and the badge does not carry:
	// which route the child resolved to, how it ended, and a child transcript that
	// could not be written down.
	//
	// They arrive as audit records because of where the tool that produces them runs.
	// The runtime is the front end's child process, so its stderr *is* the terminal
	// the interface is drawing on: a line written there lands in the alternate screen
	// and is erased by the next redraw, which makes it invisible rather than loud —
	// the opposite of what a failure needs. Turning the record into a notice puts it
	// in the transcript, where it stays, and leaves the audit log as the record of
	// the same fact.
	//
	// This is the path these kinds actually travel: they are the parent's own
	// account of having delegated, so `session_id` is the parent's session and they
	// are not marked as a child's. A notice in `forwardChild` would read correctly
	// and never fire.
	//
	// **Every delegation row in a transcript is drawn from here.** The desktop
	// client used to compose its own notes for `subagent_started`,
	// `delegation_started` and `delegation_finished` on top of these notices, which
	// made one dispatch three rows: two of them restatements, worded by the client,
	// and nameless — the records carried no label for it to read. A notice is one
	// row, is worded in one place (`internal/i18n`), and reaches every front end
	// identically, so the client no longer composes any of the four.
	switch kind {
	case subagentStartedKind:
		provider, _ := String(record, "provider")
		model, _ := String(record, "model")
		// An absent depth renders as nothing rather than as zero: depth 0 is the
		// top-level agent, so "depth 0" in a notice about a child would be a wrong
		// answer rather than a missing one.
		depth := ""
		if number, ok := Int(record, "depth"); ok {
			depth = itoa(number)
		}
		s.notice("info", "subagent", i18n.T("notice.subagent.started",
			"name", delegationName(record), "provider", provider, "model", model, "depth", depth))
	case subagentProblemKind:
		reason, _ := String(record, "reason")
		s.notice("warn", "subagent", i18n.T("notice.subagent.save_failed",
			"name", delegationName(record), "problem", reason))
	case delegationFinishedKind:
		name := delegationName(record)
		reason, _ := String(record, "stop_reason")
		// Two sentences, not one with a clause appended: a foreground delegation's
		// answer is already in the transcript as the tool result, and a background
		// one's is not anywhere the person can see, so "where did the answer go"
		// has a different answer in each case and is the only thing this row is for.
		if background, _ := record["background"].(bool); background {
			s.notice("info", "subagent", i18n.T("notice.delegation.finished_background",
				"name", name, "reason", reason))
		} else {
			s.notice("info", "subagent", i18n.T("notice.delegation.finished",
				"name", name, "reason", reason))
		}
	}
}

// delegationName is what to call one delegation in a sentence a person reads.
//
// The label is the display name the delegating model supplied, and it is the only
// name that means anything to the person reading the transcript — the id is a
// session id. An empty one is a real case rather than a defensive branch: the tool
// falls back to `Config.Label`, which this build does not set, so a call the model
// gave no label to resolves to the empty string. Falling back to the id is poorer
// copy but it is better than a sentence with a hole in it.
func delegationName(record map[string]any) string {
	if label, _ := String(record, "label"); label != "" {
		return label
	}
	id, _ := String(record, "subagent_id")
	return id
}

// The record kinds the delegation tool reports about itself, and the two
// transitions the board can be read from.
//
// They are spelled here rather than imported from `internal/subagent` on purpose:
// this layer must not learn how a runtime is assembled, and the day the tool lives
// in another process the strings are what crosses. The package that emits them owns
// the canonical constants and says why they are records instead of stderr lines.
//
// `delegation_started` is deliberately absent from the notice switch above and is
// not an oversight: `subagent_started` fires microseconds earlier with the resolved
// route and the depth, so a second row announcing the same start would be a
// restatement. The record still earns its keep — it is what makes the runtime send
// the state snapshot that puts the row on the badge.
const (
	subagentStartedKind    = "subagent_started"
	subagentProblemKind    = "subagent_problem"
	delegationFinishedKind = "delegation_finished"
)

// forwardChild sends one delegated agent's record to the front end.
//
// The record goes out unmodified apart from the `child` marker, so "the audit log
// is the protocol" survives: everything `--audit <child id>` can show, a front end
// can show, including the child's own step numbers — which is the point, since
// those numbers belong to the child's loop and mean nothing in the parent's.
func (s *Server) forwardChild(record map[string]any, kind string) {
	envelope := map[string]any{"v": VERSION, "t": OutEvent, "kind": kind, "child": true}
	for key, value := range record {
		if key == childOriginKey {
			continue
		}
		if _, taken := envelope[key]; taken && key != "kind" && key != "child" {
			continue
		}
		envelope[key] = value
	}
	s.Send(envelope)
}

// childOriginKey is how the runtime marks a record as a delegated agent's.
//
// It is a private convention between the runtime and this layer rather than a
// protocol field: it never crosses the wire, so a front end cannot come to depend
// on it, and this package never has to learn what a session id looks like.
const childOriginKey = "child_origin"

// OnDelta forwards one stream increment.
//
// The step is the caller's, not this layer's, and that is the point: a delta's
// step answers "which streaming block is this chunk part of", and the only end
// that knows is the loop that issued the call.
//
// It used to be derived here as the last record's step plus one, on the reading
// that `model_call` is written after the call returns so the current block belongs
// one step later. That holds for the first step and breaks at the second: the
// record written for step 0 carries step 0, so while step 1 streams the most
// recent record is step 0's and `lastStep+1` yields 1 — the same number step 0's
// chunks were given, when the most recent record was `run_started` (step 0) and
// the sum was also 1. From step 2 on the numbers advance again. So exactly one
// boundary was wrong, and it is the one a front end crosses first: a block keyed
// on `step` never learns that step 1 has begun.
//
// Measured, not inferred: see docs/spec/protocol.md 3.8 for the table.
//
// `lastStep` keeps its own meaning — the step of the most recent audit record —
// and is no longer read from here.
//
// `lastStep` keeps its own meaning — the step of the most recent audit record —
// and is no longer read from here.
func (s *Server) OnDelta(step int, text, reasoning string, reset bool) {
	s.stateLock.Lock()
	runID := s.lastRunID
	s.stateLock.Unlock()

	sessionID := ""
	if runtime := s.current(); runtime != nil {
		sessionID = runtime.SessionID()
	}

	if reset {
		// A separate message kind, carrying no text: one message with two meanings
		// would be worse than two messages. Sending it twice (a retry goes through
		// two layers) is harmless; missing one leaves the screen showing text that
		// no longer exists.
		s.Send(map[string]any{
			"v": VERSION, "t": OutDeltaReset,
			"session_id": sessionID, "run_id": runID, "step": step,
		})
		return
	}

	send := func(channel, piece string) {
		if piece == "" {
			return
		}
		s.Send(map[string]any{
			"v": VERSION, "t": OutDelta,
			"session_id": sessionID, "run_id": runID, "step": step,
			"channel": channel, "text": piece, "reset": false,
		})
	}
	// Routed by the field, never guessed: both channels carry strings, and
	// crossing them puts a stretch of the model thinking out loud into the answer.
	send(DeltaText, text)
	send(DeltaReasoning, reasoning)
}

func (s *Server) lastRun() string {
	s.stateLock.Lock()
	defer s.stateLock.Unlock()
	return s.lastRunID
}

// Channels hands the runtime the two things it may ask a person about.
//
// Questioner is how the agent asks a question, Asker is how it asks permission.
// Neither is bound to a runtime yet: the memory and the trust-group lookup are read
// at call time from whatever runtime is attached then. That is what lets a session
// switch replace the runtime without rewiring the channels.
func (s *Server) Channels() Channels {
	return Channels{
		Questioner: func(args AskUserBatchArgs) AskUserBatchAnswer {
			return s.askUser(args)
		},
		AskerFactory: func(memory *security.Memory, trust security.TrustGroupLookup) security.AskFunc {
			return s.askPermission(memory, trust)
		},
	}
}
