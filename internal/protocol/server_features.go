package protocol

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The feature commands: model switches, compaction, goal, MCP, and memory.
//
// They share a shape rather than a mechanism. Each one reads the mounted runtime,
// asks it to do something, and answers with a notice **and** a fresh panel
// snapshot — never only one of the two. A notice without a snapshot leaves the rail
// drawing a decision that has already been changed; a snapshot without a notice
// leaves a person who just pressed a button with no sentence saying what happened.
//
// The three model switches are the ones that must not wait for a turn: the
// settings they change are read when the *next* request is built, so waiting would
// freeze the interface during a turn for no consistency gain. Everything that
// pulls a tool out from under the model — `mcp unload`, a compaction — does wait.
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

// handleProbeEffort asks the endpoint, level by level, which reasoning levels
// the current model takes.
//
// The answer is async for the reason compaction's is: six serial asks to a
// thinking endpoint take seconds at best and a hung one a full minute each,
// and a read loop blocked for that long stops answering every other message
// on the connection — including the ones the panel itself needs. The refusal
// is not a notice alone: the panel that asked is a modal layer over the
// transcript, and a notice lands behind it — so the refusal rides the panel's
// own kind with `problem` beside it, the way memory and codeintel do.
func (s *Server) handleProbeEffort() {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "probe", i18n.T("channels.probe.no_session"))
		return
	}
	prober, ok := runtime.(ProbeEfforter)
	if !ok {
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UIProbeEffort,
			"problem": i18n.T("channels.probe.unsupported"),
		})
		return
	}
	go func() {
		payload, err := prober.ProbeEffort()
		if err != nil {
			s.Send(map[string]any{
				"v": VERSION, "t": OutUI, "kind": UIProbeEffort,
				"problem": i18n.T("channels.probe.failed", "problem", err.Error()),
			})
			return
		}
		// The answer travels under `probe`, not spread beside the envelope: the
		// snapshot is one object (the memory and usage handlers' shape), and a
		// front end reads `probe.model` / `probe.levels` out of it. Spreading the
		// keys instead would put fields on the wire the schema never declared,
		// and the panel — which reads `msg.probe` — would draw nothing at all.
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UIProbeEffort,
			"probe": payload,
		})
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
	s.resetTurnState()
	s.emitOpening()
}

// resetTurnState releases everything a finished or abandoned turn left behind.
//
// A session switch ends whatever turn was running, so its context is released
// here for the same reason the flag is cleared: the next turn must not inherit
// it. Switching sessions while a turn is in flight is the one path where the
// old turn's cancellation has no other owner. Called from every path that
// mounts a runtime the previous one is not running — the switch, a delete of
// the mounted session, and a fork that opens its copy.
func (s *Server) resetTurnState() {
	s.pending.abandonAll()

	s.mu.Lock()
	s.stop = false
	s.lastRunID = ""
	s.lastStep = 0
	if s.turnCancel != nil {
		s.turnCancel()
		s.turnCtx, s.turnCancel = nil, nil
	}
	s.mu.Unlock()
}

// deleteSession removes one saved session file.
//
// The running turn finishes first, for the same reason switchSession waits: the
// file is appended to while a turn runs, and deleting it under the writer is how
// a half line happens.
//
// Deleting the **mounted** session replaces it with a fresh one rather than
// leaving the front end on a session whose file is gone. The replacement is
// opened before the old runtime is closed (the same order switchSession keeps),
// so a failure to assemble the new one loses nothing — the old runtime stays
// mounted, and because the store dropped the deleted id's watermark, its next
// save re-writes the whole file: the delete heals itself instead of leaving a
// session that exists in memory only.
func (s *Server) deleteSession(message map[string]any) {
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
	if sessionID == "" {
		s.notice("warn", "session", i18n.T("channels.session.delete_failed",
			"name", sessionID, "problem", "no session id was given"))
		return
	}

	if s.bootstrap.DeleteSession == nil {
		// Fail-closed, like a nil Factory: a runtime wired without a deleter
		// refuses rather than guessing at one.
		s.notice("warn", "session", i18n.T("channels.session.delete_failed",
			"name", sessionID, "problem", "this runtime cannot delete sessions"))
		return
	}

	s.joinTurn()

	current := s.current()
	wasCurrent := current != nil && current.SessionID() == sessionID

	if err := s.bootstrap.DeleteSession(sessionID); err != nil {
		s.notice("warn", "session", i18n.T("channels.session.delete_failed",
			"name", sessionID, "problem", err.Error()))
		return
	}

	if wasCurrent && s.bootstrap.Factory != nil {
		next, err := s.bootstrap.Factory("")
		if err != nil {
			s.notice("warn", "session", i18n.T("channels.session.switch_failed",
				"problem", err.Error()))
			s.sendSessions()
			return
		}
		if err := current.Close(); err != nil {
			warn("%s", i18n.T("channels.session.close_failed", "problem", err.Error()))
		}
		s.Attach(next)
		s.resetTurnState()
		s.emitOpening()
	} else {
		// Not the mounted session: the picker just needs the new list. Sent even
		// on the wasCurrent path above — emitOpening already refreshed the
		// transcript, but the list itself is what the row was deleted from.
		s.sendSessions()
	}

	s.notice("info", "session", i18n.T("channels.session.deleted", "name", sessionID))
}

// forkSession copies the named session up to a chosen reply and opens the
// copy.
//
// The front end names the reply by its text and by the number of user rows it
// drew above it; the store matches and cuts on the turn boundary the reply
// ends (`SessionStore.Fork`). The copy is a new conversation and it is what
// gets mounted: a fork is "continue from here", and "continue the original"
// stays possible because the source file is never touched — the copy is a
// second file, and the source remains in the list.
//
// `user_before` absent means "no tie-break", not zero: a count of zero is a
// real answer (the first reply of the conversation), and conflating the two
// would let a missing field pick the wrong copy of a repeated reply.
//
// The copy is opened before the old runtime is closed, the same order
// `switchSession` keeps: an assembly failure must not lose what the person is
// reading. The new session's id travels on the opening triple, so the front
// end does not need — and cannot cache — the id from any other message.
func (s *Server) forkSession(message map[string]any) {
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
	reply, ok := String(message, "reply")
	if !ok || reply == "" {
		s.notice("warn", "session", i18n.T("channels.session.fork_failed",
			"name", sessionID, "problem", "the reply to fork from was not given"))
		return
	}
	// Absent is -1 (no tie-break), never 0: see the note on the handler.
	userBefore := -1
	if value, present := Int(message, "user_before"); present {
		userBefore = value
	}

	if s.bootstrap.ForkSession == nil {
		// Fail-closed, like a nil Factory or deleter: a runtime wired without a
		// forker refuses rather than guessing at a copy.
		s.notice("warn", "session", i18n.T("channels.session.fork_failed",
			"name", sessionID, "problem", "this runtime cannot fork sessions"))
		return
	}
	if s.bootstrap.Factory == nil {
		s.notice("warn", "session", i18n.T("channels.session.fork_failed",
			"name", sessionID, "problem", "this runtime cannot open a session"))
		return
	}

	// The reply's turn has to be on disk before the copy can include it: the
	// front end draws the answer the moment it streams, but the store only sees
	// it after the turn's last checkpoint. Joining also keeps the file whole
	// while it is read — a turn mid-step would be a half line.
	s.joinTurn()

	newID, err := s.bootstrap.ForkSession(sessionID, reply, userBefore)
	if err != nil {
		s.notice("warn", "session", i18n.T("channels.session.fork_failed",
			"name", sessionID, "problem", err.Error()))
		return
	}

	// The copy is a new conversation, and whether it takes the screen depends on
	// whether the source is the conversation on screen. Forking the **mounted**
	// session opens the copy — that is the fork button's whole point ("continue
	// from here"). Forking any other session only adds a row to the list and
	// leaves the on-screen conversation alone, the same `wasCurrent` rule
	// `deleteSession` keeps. In practice the button sits in the active transcript,
	// so the source is the mounted session and this branch is the one taken.
	previous := s.current()
	wasCurrent := previous != nil && previous.SessionID() == sessionID

	if wasCurrent {
		next, err := s.bootstrap.Factory(newID)
		if err != nil {
			// The copy exists on disk either way — it shows up in the session
			// list — and the front end stays on what it was reading, which is
			// what a failed open must look like (see switchSession's rule).
			s.notice("warn", "session", i18n.T("channels.session.fork_failed",
				"name", sessionID,
				"problem", "the copy was made but could not be opened: "+err.Error()))
			s.sendSessions()
			return
		}
		if err := previous.Close(); err != nil {
			warn("%s", i18n.T("channels.session.close_failed", "problem", err.Error()))
		}
		s.Attach(next)
		s.resetTurnState()
		s.emitOpening()
	}

	// The list is re-sent on both paths: the fork adds a row the front end did
	// not draw, and it is the list that has to show it. On the wasCurrent path
	// the opening triple already refreshed the transcript, but not the list.
	s.sendSessions()

	s.notice("info", "session", i18n.T("channels.session.forked", "name", sessionID))
}

