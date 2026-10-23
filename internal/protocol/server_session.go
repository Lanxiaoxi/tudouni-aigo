package protocol

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// Session management: which session is mounted, and the list / archive operations
// on the others.
//
// Every command here is **not** a turn command, and that difference decides how it
// waits. Switching and deleting rebuild or remove the runtime itself, so they join
// the running turn first — interrupting one would leave an assistant message with
// `tool_calls` and no results, which makes the session permanently unsendable.
// Listing and archiving do not touch the runtime, so archiving waits only for the
// file's writer to be quiet.
//
// The filter (`active` / `all`) is a **view**, not an argument: the list is re-sent
// for reasons the front end did not ask about, and every one of those answers has
// to carry the same filter.
//
// The value is validated rather than trusted: an unknown filter keeps whatever was
// in effect instead of flipping the view, because silently hiding sessions on a
// typo is the failure that cannot be recovered from the wire.
func (s *Server) sessionList(message map[string]any) {
	filter, _ := String(message, "filter")
	switch filter {
	case "active":
		s.sessionIncludeArchived = false
	case "all", "":
		s.sessionIncludeArchived = true
	default:
		// Unknown value: keep whatever was in effect rather than changing the view
		// on a string nobody recognises.
	}
	s.sendSessions()
}

func (s *Server) sendSessions() {
	items := s.bootstrap.SessionSummaries
	var list []map[string]any
	if items != nil {
		list = items(s.sessionIncludeArchived)
	}
	if list == nil {
		list = []map[string]any{}
	}
	s.Send(map[string]any{"v": VERSION, "t": OutSessions, "items": list})
}

// archiveSession sets or clears one session's archived flag.
//
// It is deliberately **not** gated on the session being unmounted the way
// `deleteSession` is. Deleting the mounted session has to rebuild the runtime
// because the file it is running against is gone; archiving leaves the file
// exactly where it was, so the session in progress is unaffected. The real gate —
// "do not archive a session some running child is writing" — lives in the front
// end, which is the only side that can see the other connections; the runtime
// cannot know about them and must not pretend to.
func (s *Server) archiveSession(message map[string]any) {
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
		s.notice("warn", "session", i18n.T("channels.session.archive_failed",
			"name", sessionID, "problem", "no session id was given"))
		return
	}
	archived, ok := Bool(message, "archived")
	if !ok {
		s.notice("warn", "session", i18n.T("channels.session.archive_failed",
			"name", sessionID, "problem", "archived must be a boolean"))
		return
	}

	if s.bootstrap.ArchiveSession == nil {
		// Fail-closed, like a nil Factory or a nil deleter: a runtime wired without
		// an archiver refuses rather than guessing at one.
		s.notice("warn", "session", i18n.T("channels.session.archive_failed",
			"name", sessionID, "problem", "this runtime cannot archive sessions"))
		return
	}

	// Wait the turn out before touching metadata, the way `deleteSession` waits
	// before touching the file. The id being archived is often the *mounted*
	// session — the desktop's card menu sends it through that session's own
	// child — and the agent appends to this same file between steps, so a
	// mid-turn rewrite would race the writer. With no turn running this is a
	// no-op: `turnDone` is already closed.
	s.joinTurn()

	if err := s.bootstrap.ArchiveSession(sessionID, archived); err != nil {
		s.notice("warn", "session", i18n.T("channels.session.archive_failed",
			"name", sessionID, "problem", err.Error()))
		return
	}

	s.sendSessions()
	if archived {
		s.notice("info", "session", i18n.T("channels.session.archived", "name", sessionID))
	} else {
		s.notice("info", "session", i18n.T("channels.session.unarchived", "name", sessionID))
	}
}

