package protocol

import (
	"strings"
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
	RunTurn(text string) (string, error)
	// ClearStop resets this turn's cancellation flag.
	//
	// It is per-turn and must be cleared at the start of every turn: a flag that
	// survives one interrupt makes every later turn stop at its first safe point,
	// and the symptom is "sending a message does nothing".
	ClearStop()
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
	// SessionSummaries lists the saved sessions, for the picker.
	SessionSummaries func() []map[string]any
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
	serving bool

	// stop is this turn's cancellation flag. It is cleared at the start of every
	// turn; see Runtime.ClearStop.
	stop   bool
	answer string

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
	StartGoalRound(round GoalRound) (answer string, started bool, err error)
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

	s.mu.Lock()
	s.serving = true
	s.mu.Unlock()

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

	s.mu.Lock()
	s.serving = false
	s.mu.Unlock()

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
		s.sendSessions()

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

	case InGoal:
		s.handleGoal(message)

	case InRefreshState:
		s.Send(s.stateMessage(false))

	case InUserMessage:
		text, _ := String(message, "text")
		s.startTurn(text)

	default:
		// Ignored on purpose. See the comment on CheckVersion.
	}
	return true
}

// JoinTurn waits for the running turn to finish, for a caller that needs a
// consistent message list.
func (s *Server) joinTurn() {
	s.turnMu.Lock()
	done := s.turnDone
	s.turnMu.Unlock()
	<-done
}

// startTurn begins a turn started by a person.
func (s *Server) startTurn(text string) {
	s.startTurnWith(text, nil)
}

// startGoalTurn begins a turn the goal driver reserved.
//
// It goes through the same function as a person's turn on purpose: an automatic
// round has to wait for whatever is running, and it must not be a second
// scheduler. The reservation travels with the turn so the runtime can refuse it
// when the turn actually starts — the queue is where a goal edit, a pause, or a
// person's message can land in between.
func (s *Server) startGoalTurn(round GoalRound) bool {
	if round == nil {
		return false
	}
	return s.startTurnWith("", round)
}

func (s *Server) startTurnWith(text string, round GoalRound) bool {
	// Wait for the previous turn: two turns must never interleave, because the
	// message list is only consistent between steps.
	s.joinTurn()

	s.mu.Lock()
	s.stop = false
	s.answer = ""
	s.mu.Unlock()

	done := make(chan struct{})
	s.turnMu.Lock()
	s.turnDone = done
	s.goalRound = round
	s.turnMu.Unlock()

	runtime := s.current()
	if runtime == nil {
		s.clearGoalRound()
		close(done)
		s.notice("warn", "session", i18n.T("channels.model.no_session"))
		return false
	}

	// The turn runs on its own goroutine so the read loop keeps turning. That is
	// not a performance choice: if the loop were busy running the turn it could
	// never read the `permission_response` that the turn is waiting for, and the
	// two would deadlock.
	go func() {
		defer close(done)
		s.runTurn(runtime, text)
	}()
	return true
}

// clearGoalRound drops the reservation the next turn would have run.
func (s *Server) clearGoalRound() {
	s.turnMu.Lock()
	s.goalRound = nil
	s.turnMu.Unlock()
}

func (s *Server) pendingGoalRound() GoalRound {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	return s.goalRound
}

func (s *Server) runTurn(runtime Runtime, text string) {
	runtime.ClearStop()

	// A reserved round takes the path that composes its own opening message. A
	// stale reservation means no turn ran, and then there is nothing to report —
	// falling through to `RunTurn("")` would ask the model to answer an empty
	// question, which is a real turn spent on nothing.
	if round := s.pendingGoalRound(); round != nil {
		answer, err, ran := s.runGoalRound(runtime, round)
		if !ran {
			return
		}
		s.finishTurn(runtime, answer, err)
		return
	}

	answer, err := runtime.RunTurn(text)
	s.finishTurn(runtime, answer, err)
}

// runGoalRound runs one reserved round, or reports that it was refused.
func (s *Server) runGoalRound(runtime Runtime, round GoalRound) (string, error, bool) {
	s.clearGoalRound()
	runner, ok := runtime.(GoalRoundRunner)
	if !ok {
		return "", nil, false
	}
	answer, started, err := runner.StartGoalRound(round)
	if !started {
		return "", nil, false
	}
	return answer, err, true
}

// finishTurn reports a finished turn and then asks the goal driver whether another
// round is allowed.
//
// The order matters and it is the whole reason the hook is here rather than in the
// agent: by this point the answer has been sent, the session file holds the turn,
// the message list is consistent, and no other turn is running. That is the only
// instant at which "is this session finished?" has a well-defined answer.
func (s *Server) finishTurn(runtime Runtime, answer string, err error) {
	if err != nil {
		if _, cancelled := err.(interface{ Error() string }); cancelled && isCancel(err) {
			s.notice("warn", "cancelled", i18n.T("channels.run_failed", "problem", err.Error()))
		} else {
			s.notice("warn", "model", i18n.T("channels.run_failed", "problem", err.Error()))
		}
	}

	s.mu.Lock()
	s.answer = answer
	s.mu.Unlock()

	// The answer goes out after RunTurn returns, never from the event handler:
	// the handler runs before the answer exists, so sending it there would send
	// an empty string.
	s.Send(map[string]any{
		"v": VERSION, "t": OutUI, "kind": UIRunFinished,
		"answer": answer, "run_id": s.lastRun(),
	})

	// One more snapshot to close the turn: the task list may have changed on the
	// last step, and the panel should not be a turn behind.
	s.Send(s.stateMessage(false))

	// A reserved round is queued on its **own** goroutine, and it waits for this
	// turn's `done` first. Calling back into `startTurn` from here would deadlock:
	// that path begins with `joinTurn`, which waits for the very `done` this
	// function has not closed yet.
	scheduler, ok := runtime.(GoalRoundScheduler)
	if !ok {
		return
	}
	// **Before** the driver is asked, and this order is the whole point: a goal the
	// model created during a turn a person started becomes armed here, and the
	// driver then sees an armed, active goal and continues it. Asking the driver
	// first would mean every goal created this way was refused once for not being
	// armed yet — a round silently not taken, and the session stopping for no
	// reason the log explains.
	if armer, ok := runtime.(GoalArmer); ok {
		armer.ArmFromTurn()
	}
	round := s.reservedGoalRound(scheduler, err)
	if round == nil {
		return
	}
	done := s.currentTurnDone()
	go func() {
		<-done
		s.startGoalTurn(round)
	}()
}

// reservedGoalRound asks the runtime whether another round is allowed, and returns
// the reservation if it is.
//
// `stopped` is this server's own flag rather than the runtime's, because the
// question is "did somebody ask to stop **during this turn**" — and this flag is
// cleared at the start of every turn precisely so it can answer that. A stop inside
// a round has to turn continuation off, not merely end the round: an interrupt that
// is followed by another round is an interrupt that does not work.
func (s *Server) reservedGoalRound(scheduler GoalRoundScheduler, outcome error) GoalRound {
	var reserved GoalRound
	scheduler.ObserveTurn(outcome, s.ShouldStop(), func(round GoalRound) bool {
		if reserved != nil {
			// One at a time. A runtime that asked twice would be building a queue
			// it has no way to drain.
			return false
		}
		reserved = round
		return true
	})
	if reserved == nil {
		// The loop stopped. It may also have disarmed the goal, and the status
		// snapshot already sent was built before that decision — so one more goes
		// out, or the interface keeps reporting a session as ready to continue
		// after it has stopped. A queued round sends its own snapshots instead.
		s.Send(s.stateMessage(false))
	}
	return reserved
}

func (s *Server) currentTurnDone() <-chan struct{} {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	return s.turnDone
}

// RequestStop asks the current turn to stop at its next safe point.
func (s *Server) RequestStop() { s.requestStop() }

func (s *Server) requestStop() {
	s.mu.Lock()
	s.stop = true
	s.mu.Unlock()
	runtime := s.current()
	if runtime == nil {
		return
	}
	// The runtime owns the flag the agent actually reads; the server keeps its own
	// so a stop arriving before a runtime exists is not lost.
	if stopper, ok := runtime.(interface{ MarkStop() }); ok {
		stopper.MarkStop()
	}
}

// ShouldStop reports whether this turn has been asked to stop.
func (s *Server) ShouldStop() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stop
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

func (s *Server) sendSessions() {
	items := s.bootstrap.SessionSummaries
	var list []map[string]any
	if items != nil {
		list = items()
	}
	if list == nil {
		list = []map[string]any{}
	}
	s.Send(map[string]any{"v": VERSION, "t": OutSessions, "items": list})
}

func (s *Server) setAutopilot(on bool) {
	// Two places change, and both are needed: the process-level fact, so a session
	// switched to later is assembled with the same mode; and the running runtime,
	// which is what the gate actually reads.
	s.bootstrap.Autopilot = on
	if runtime := s.current(); runtime != nil {
		runtime.SetAutopilot(on)
	}
	s.Send(s.stateMessage(false))
}

func (s *Server) setModel(name string) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "model", i18n.T("channels.model.no_session"))
		return
	}
	ok, message := runtime.SetModel(name)
	if ok {
		s.notice("info", "model", i18n.T("channels.model.reply", "message", message))
	} else {
		s.notice("warn", "model", i18n.T("channels.model.not_changed", "message", message))
	}
	s.Send(s.stateMessage(false))
}

func (s *Server) setThinking(on bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "thinking", i18n.T("channels.thinking.no_session"))
		return
	}
	ok, message := runtime.SetThinking(on)
	if ok {
		s.notice("info", "thinking", i18n.T("channels.thinking.reply", "message", message))
	} else {
		s.notice("warn", "thinking", i18n.T("channels.thinking.not_changed", "message", message))
	}
	s.Send(s.stateMessage(false))
}

func (s *Server) setEffort(level string) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "effort", i18n.T("channels.effort.no_session"))
		return
	}
	ok, message := runtime.SetEffort(level)
	if ok {
		s.notice("info", "effort", i18n.T("channels.effort.reply", "message", message))
	} else {
		s.notice("warn", "effort", i18n.T("channels.effort.not_changed", "message", message))
	}
	s.Send(s.stateMessage(false))
}

func (s *Server) startCompact() {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "compact", i18n.T("channels.compact.no_session"))
		return
	}
	// Compacting writes a summary with a real model round trip, which takes
	// seconds. Waiting for it here would freeze the read loop for that whole time,
	// so it runs on its own goroutine and the answer arrives asynchronously.
	go func() {
		s.joinTurn()
		result, err := runtime.Compact()
		if err != nil {
			s.notice("warn", "compact", i18n.T("channels.compact.failed", "problem", err.Error()))
			return
		}
		payload := map[string]any{
			"v": VERSION, "t": OutUI, "kind": UICompacted,
			"compaction": result["compaction"],
		}
		if ctx, ok := result["context"]; ok {
			payload["context"] = ctx
		}
		s.Send(payload)
		s.Send(s.stateMessage(false))
	}()
}

// handleGoal performs a command about the session's goal.
//
// The command is the person's half of the goal feature, and it is deliberately a
// command rather than a message to the model: a goal the model created for itself
// has to be stoppable without asking that model to stop it, and "ask the model to
// run update_goal(pause)" is not a control, it is a suggestion.
//
// An empty action is a read, which is what `/goal` on its own means. Every branch
// ends by sending a fresh panel snapshot, so the rail and the transcript never
// disagree about whether the goal is still running.
func (s *Server) handleGoal(message map[string]any) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "goal", i18n.T("channels.goal.no_session"))
		return
	}

	action, _ := String(message, "action")
	if action == "" {
		s.Send(s.stateMessage(false))
		s.notice("info", "goal", goalStateText(runtime.GoalPanel()))
		return
	}
	switch action {
	case GoalPause, GoalResume, GoalClear:
	default:
		// Not silently treated as a read: a mistyped pause would then look like it
		// worked, and the goal would keep running.
		s.notice("warn", "goal", i18n.T("channels.goal.unknown_action",
			"action", action, "actions", strings.Join(GoalActions, ", ")))
		return
	}

	commander, ok := runtime.(GoalCommander)
	if !ok {
		// An older runtime: the command is understood by the protocol and not by the
		// thing behind it. Saying so beats a silent no-op.
		s.notice("warn", "goal", i18n.T("channels.goal.unsupported"))
		return
	}
	panel, err := commander.GoalCommand(action)
	if err != nil {
		s.notice("warn", "goal", i18n.T("channels.goal.refused", "problem", err.Error()))
		s.Send(s.stateMessage(false))
		return
	}
	s.Send(s.stateMessage(false))
	s.notice("info", "goal", goalActionText(action, panel))
}

// goalActionText says what the command did, in the terms the person used.
func goalActionText(action string, panel map[string]any) string {
	if action == GoalClear {
		return i18n.T("channels.goal.cleared")
	}
	return goalStateText(panel)
}

// goalStateText is the one-line report of where the goal stands.
//
// `armed` is stated separately from the phase because they answer different
// questions and can differ: a resumed session's active goal is not armed, and a
// person reading "active" alone would expect work to continue.
func goalStateText(panel map[string]any) string {
	objective, _ := panel["objective"].(string)
	if objective == "" {
		return i18n.T("channels.goal.none")
	}
	phase, _ := panel["phase"].(string)
	rounds, _ := panel["rounds_text"].(string)
	armed, _ := panel["armed"].(bool)
	state := i18n.T("channels.goal.paused_state")
	if armed {
		state = i18n.T("channels.goal.armed_state")
	}
	return i18n.T("channels.goal.state",
		"objective", objective, "phase", phase, "rounds", rounds, "state", state)
}

func (s *Server) handleMCP(message map[string]any) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "mcp", i18n.T("channels.mcp.no_session"))
		return
	}
	action, _ := String(message, "action")
	switch action {
	case "list", "load", "unload":
	default:
		// An unrecognised action is not treated as `list`: doing so would make a
		// mistyped load look like it succeeded.
		s.notice("warn", "mcp", i18n.T("channels.mcp.unknown_action",
			"action", action, "actions", strings.Join(MCPActions, ", ")))
		return
	}

	servers, _ := Strings(message, "servers")

	send := func() {
		payload, notes := runtime.MCPMessage(action, servers)
		if payload == nil {
			s.notice("warn", "mcp", i18n.T("channels.mcp.no_host"))
			return
		}
		payload["v"] = VERSION
		payload["t"] = OutUI
		payload["kind"] = UIMCP
		if notes == nil {
			notes = []string{}
		}
		payload["mcp_notes"] = notes
		s.Send(payload)
		// A mount changes what the model can see, so the panel snapshot follows at
		// once rather than waiting for the next tool result.
		s.Send(s.stateMessage(false))
	}

	// `list` changes nothing, so it does not wait for a running turn. `load` and
	// `unload` do: the tool definitions are snapshotted at the start of a turn, and
	// pulling a server out from under a call in flight ends it with a dead
	// connection.
	if action == "list" {
		send()
		return
	}
	go func() {
		s.joinTurn()
		send()
	}()
}

func (s *Server) switchSession(message map[string]any) {
	raw, present := message["session_id"]
	sessionID := ""
	if present && raw != nil {
		text, ok := raw.(string)
		if !ok {
			s.notice("warn", "session", i18n.T("channels.session.needs_string"))
			return
		}
		sessionID = text
	}

	if s.bootstrap.Factory == nil {
		s.notice("warn", "session", i18n.T("channels.session.switch_failed",
			"problem", "this runtime cannot open a session"))
		return
	}

	// Wait for the running turn first. Interrupting it would leave a half-written
	// assistant message behind, and that makes the session unsendable.
	s.joinTurn()

	previous := s.current()
	next, err := s.bootstrap.Factory(sessionID)
	if err != nil {
		// The old session survives untouched. A front end is not allowed to clear
		// its screen when it sends this request, precisely so that a failure here
		// does not look like "my session is gone".
		s.notice("warn", "session", i18n.T("channels.session.switch_failed", "problem", err.Error()))
		return
	}

	// The previous runtime is closed only after the new one exists: assembling can
	// fail, and losing the old session to a half-built replacement is worse than
	// keeping both alive for a moment.
	if previous != nil {
		if err := previous.Close(); err != nil {
			warn("%s", i18n.T("channels.session.close_failed", "problem", err.Error()))
		}
	}

	s.Attach(next)
	s.pending.abandonAll()

	s.mu.Lock()
	s.stop = false
	s.answer = ""
	s.lastRunID = ""
	s.lastStep = 0
	s.mu.Unlock()

	s.emitOpening()
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
	// parent's own account of having delegated: their `run_id` is the parent's turn
	// and their `session_id` is the parent's session. Putting this in `forwardChild`
	// reads correctly and does nothing, because that branch never sees these kinds.
	//
	// It hears about the two transitions rather than about every child event, so a
	// subagent that makes forty tool calls sends one extra snapshot, not forty.
	if kind == "delegation_started" || kind == "delegation_finished" {
		if notifier, ok := s.current().(interface{ OnDelegationChanged() }); ok {
			notifier.OnDelegationChanged()
		}
		s.Send(s.stateMessage(false))
	}
}

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
// Measured, not inferred: see docs/protocol.md 3.8 for the table.
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
		Questioner: func(args AskUserArgs) Answer {
			return s.askUser(args)
		},
		AskerFactory: func(memory *security.Memory, trust security.TrustGroupLookup) security.AskFunc {
			return s.askPermission(memory, trust)
		},
	}
}
