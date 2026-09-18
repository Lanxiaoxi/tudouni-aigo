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

func (s *Server) startTurn(text string) {
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
	s.turnMu.Unlock()

	runtime := s.current()
	if runtime == nil {
		close(done)
		s.notice("warn", "session", i18n.T("channels.model.no_session"))
		return
	}

	// The turn runs on its own goroutine so the read loop keeps turning. That is
	// not a performance choice: if the loop were busy running the turn it could
	// never read the `permission_response` that the turn is waiting for, and the
	// two would deadlock.
	go func() {
		defer close(done)
		s.runTurn(runtime, text)
	}()
}

func (s *Server) runTurn(runtime Runtime, text string) {
	runtime.ClearStop()

	answer, err := runtime.RunTurn(text)
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
func (s *Server) OnEvent(record map[string]any) {
	kind, _ := record["kind"].(string)
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
		s.Send(s.stateMessage(false))
	}
}

// OnDelta forwards one stream increment.
//
// The step number is the last event's step **plus one**, and the reason is worth
// writing down: `model_call` is recorded after the call returns, so when the first
// delta arrives the most recent event is still the previous step's. The current
// block therefore belongs to one step later. The same arithmetic holds for every
// step of the turn.
func (s *Server) OnDelta(text, reasoning string, reset bool) {
	s.stateLock.Lock()
	runID := s.lastRunID
	step := s.lastStep + 1
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
