package protocol

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The workspace's two non-session capabilities, as this layer sees them.
//
// Every handler here follows one shape, and stating it once is what keeps the
// five of them from drifting apart:
//
//  1. **The runtime may not implement the feature at all.** A notice says so. The
//     alternative — an empty list — is indistinguishable on screen from "there is
//     nothing there", which is a false statement of a different kind.
//  2. **The answer is a `ui` message whose body the runtime built.** This layer
//     adds `v` / `t` / `kind` and nothing else. It does not know what a directory
//     entry is, and it must not learn: the day the shape changes, exactly one
//     package changes.
//  3. **A refusal is a notice, never a silent empty answer.** The runtime
//     returns an error with a sentence in it, and that sentence is what a person
//     reads.
//  4. **No terminal answer blocks the read loop.** Writing to a PTY can block (see
//     `terminal.inputQueue`), so the write side is the runtime's own goroutine;
//     this layer only ever hands over bytes.
//
// One rule is specific to files: `path` is optional on `file_list` and required on
// `file_read`. Listing the workspace root is a sensible default; reading a file
// somebody did not name is not, and the schema agrees (see inbound.schema.json).

// handleFileList answers `file_list`.
func (s *Server) handleFileList(message map[string]any) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "files", i18n.T("channels.files.no_session"))
		return
	}
	service, ok := runtime.(FileService)
	if !ok {
		s.notice("warn", "files", i18n.T("channels.files.unsupported"))
		return
	}
	// A missing key and an explicit empty string mean the same thing — the
	// workspace root — and are read the same way here rather than being two
	// branches that could disagree.
	path, _ := String(message, "path")
	payload, err := service.ListFiles(path)
	if err != nil {
		s.notice("warn", "files", i18n.T("channels.files.list_failed", "problem", err.Error()))
		return
	}
	payload["v"] = VERSION
	payload["t"] = OutUI
	payload["kind"] = UIFiles
	s.Send(payload)
}

// handleFileRead answers `file_read`.
//
// A missing `path` is refused rather than defaulted. The two files handlers are
// not symmetric in this, and deliberately: an absent directory means "the root",
// while an absent file name means the request does not say what to read. Guessing
// would make `file_read` with a dropped argument look like a successful read of
// some file the caller never named.
func (s *Server) handleFileRead(message map[string]any) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "files", i18n.T("channels.files.no_session"))
		return
	}
	service, ok := runtime.(FileService)
	if !ok {
		s.notice("warn", "files", i18n.T("channels.files.unsupported"))
		return
	}
	path, ok := String(message, "path")
	if !ok || path == "" {
		s.notice("warn", "files", i18n.T("channels.files.needs_path"))
		return
	}
	payload, err := service.ReadFile(path)
	if err != nil {
		s.notice("warn", "files", i18n.T("channels.files.read_failed", "problem", err.Error()))
		return
	}
	payload["v"] = VERSION
	payload["t"] = OutUI
	payload["kind"] = UIFileRead
	s.Send(payload)
}

// handleTerminalList answers `terminal_list`.
func (s *Server) handleTerminalList() {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	s.Send(map[string]any{
		"v": VERSION, "t": OutUI, "kind": UITerminals,
		"terminals": service.ListTerminals(),
	})
}

// handleTerminalCreate answers `terminal_create`.
//
// **The two outcomes are two different messages**, and that is the design's point
// rather than a convenience: success is `terminal_created` with the new row, and
// failure is **the unchanged full list** plus a notice. A failure is not answered
// with a created row carrying an error, because a front end given a row would
// remember an id for a shell that does not exist and would then send input to it.
//
// The size falls back here rather than in the runtime so that both front ends get
// the same default from the same place; a size of zero or less is what "the client
// did not say" looks like after `Int` has failed on a missing key.
func (s *Server) handleTerminalCreate(message map[string]any) {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	cwd, _ := String(message, "cwd")
	cols := intOr(message, "cols", TerminalDefaultCols)
	rows := intOr(message, "rows", TerminalDefaultRows)

	row, err := service.CreateTerminal(cwd, cols, rows)
	if err != nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.create_failed", "problem", err.Error()))
		// The list goes out as well, so a front end that had optimistically drawn
		// a tab learns the truth from the same reply as the sentence explaining
		// why.
		s.Send(s.terminalListMessage(service))
		return
	}
	s.Send(map[string]any{
		"v": VERSION, "t": OutUI, "kind": UITerminalCreated,
		"terminal":    row,
		"terminal_id": stringField(row, "id"),
	})
}

// handleTerminalInput answers `terminal_input` — which is to say, it sends no
// answer at all on success.
//
// That silence is the design: a terminal is `command → PTY → asynchronous output`,
// and the output arrives on its own schedule as `terminal_output` messages.
// Replying here would tell a front end that a write was accepted and nothing about
// what it did, and a front end that waited for a reply would never show a prompt.
//
// Both a missing id and an unknown one produce a notice. The second is worth
// stating explicitly because it is the one a front end hits after a runtime
// restart: the terminals are gone, the front end still has their ids, and a
// dropped keystroke with no explanation is the hardest kind of bug to diagnose.
func (s *Server) handleTerminalInput(message map[string]any) {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	id, ok := String(message, "terminal_id")
	if !ok || id == "" {
		s.notice("warn", "terminal", i18n.T("channels.terminal.needs_id", "action", InTerminalInput))
		return
	}
	data, _ := String(message, "data")
	if err := service.TerminalInput(id, data); err != nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.input_failed", "id", id, "problem", err.Error()))
	}
}

// handleTerminalResize answers `terminal_resize`.
//
// A refused resize is a notice rather than a silence, for the same reason the
// others are: a front end whose window changed and whose terminal did not follow
// has no way to tell "the request was too small to matter" from "the request never
// arrived".
func (s *Server) handleTerminalResize(message map[string]any) {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	id, ok := String(message, "terminal_id")
	if !ok || id == "" {
		s.notice("warn", "terminal", i18n.T("channels.terminal.needs_id", "action", InTerminalResize))
		return
	}
	cols, colsOK := Int(message, "cols")
	rows, rowsOK := Int(message, "rows")
	if !colsOK || !rowsOK {
		s.notice("warn", "terminal", i18n.T("channels.terminal.needs_size"))
		return
	}
	if err := service.TerminalResize(id, cols, rows); err != nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.resize_failed", "id", id, "problem", err.Error()))
	}
}

// handleTerminalKill answers `terminal_kill`.
//
// **The answer is not sent here.** The ending travels out as the `terminal_exit`
// event the runtime produces for every ending, whether the shell exited by itself
// or was killed — the design's rule that the runtime is the only source of truth
// for whether a terminal is running. Answering "killed" from this branch would be
// that second truth, and the two would disagree the first time a process refused
// to die.
func (s *Server) handleTerminalKill(message map[string]any) {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	id, ok := String(message, "terminal_id")
	if !ok || id == "" {
		s.notice("warn", "terminal", i18n.T("channels.terminal.needs_id", "action", InTerminalKill))
		return
	}
	if err := service.TerminalKill(id); err != nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.kill_failed", "id", id, "problem", err.Error()))
	}
}

// handleTerminalClose answers `terminal_close`.
//
// It drops a terminal that has **already ended** from the workspace's list. A
// running one is refused by the runtime, and that refusal is the safety property
// rather than a technicality: forgetting a record whose process is still alive
// would leave a shell nobody can see and nobody can end.
//
// Unlike `terminal_kill`, this handler **does** answer, and the answer is the
// resulting full list. The two differ because they change different things. A kill
// ends a process, and the ending has an event of its own (`terminal_exit`) emitted
// from the wait path — a reply there would be a second truth about whether the
// shell is running. A close changes the list, and the list is the only thing that
// can report it.
func (s *Server) handleTerminalClose(message map[string]any) {
	service, ok := s.terminalService()
	if !ok {
		return
	}
	id, ok := String(message, "terminal_id")
	if !ok || id == "" {
		s.notice("warn", "terminal", i18n.T("channels.terminal.needs_id", "action", InTerminalClose))
		return
	}
	if err := service.RemoveTerminal(id); err != nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.close_failed", "id", id, "problem", err.Error()))
		// The list goes out as well, so a front end that had already dropped the
		// tab learns the truth from the same reply as the sentence explaining why.
		s.Send(s.terminalListMessage(service))
		return
	}
	s.Send(s.terminalListMessage(service))
}

// terminalService finds the runtime's terminal surface, reporting the two ways it
// can be absent.
//
// One helper rather than the same six lines in five handlers: the alternative is
// five places to forget one of the two cases, and the case that would be dropped
// is the second one — a runtime that exists but has no manager, which is exactly
// what a test double looks like.
func (s *Server) terminalService() (TerminalService, bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "terminal", i18n.T("channels.terminal.no_session"))
		return nil, false
	}
	service, ok := runtime.(TerminalService)
	if !ok {
		s.notice("warn", "terminal", i18n.T("channels.terminal.unsupported"))
		return nil, false
	}
	return service, true
}

// terminalListMessage is the full terminal list as a `ui` message.
func (s *Server) terminalListMessage(service TerminalService) map[string]any {
	return map[string]any{
		"v": VERSION, "t": OutUI, "kind": UITerminals,
		"terminals": service.ListTerminals(),
	}
}

// intOr reads an integer field with a fallback.
//
// It is for sizes and counts, never for a protocol decision. A missing `cols` and
// a `cols` of zero mean the same thing here — "the client did not say" — and the
// fallback is the conventional terminal size rather than an arbitrary one. Using
// this shape for a switch would be the error `Bool`'s own comment warns about.
func intOr(message map[string]any, key string, fallback int) int {
	if value, ok := Int(message, key); ok && value > 0 {
		return value
	}
	return fallback
}

// stringField reads one string out of a payload the runtime built, for the
// convenience key that repeats the id beside a row.
func stringField(row map[string]any, key string) string {
	value, _ := row[key].(string)
	return value
}
