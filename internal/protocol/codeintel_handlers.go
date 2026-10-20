package protocol

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The workspace's code index, as this layer sees it.
//
// The shape is the memory handlers' and for the same reasons: an absent session and an
// absent feature are two different sentences, a refusal is a sentence rather than a
// silent empty answer, and the snapshot is re-sent after every action so the panel
// redraws from one message rather than patching its own copy.
//
// One difference is this surface's own. `init` and `sync` **start a build and answer at
// once**; the runtime narrates the pass through its `ui(codeintel)` hook, which is where
// the progress and the final outcome arrive. So the reply below is not the build's
// result — it is the acknowledgement, and the snapshot that follows it is a photograph
// of the index as it was *before* the build began. A front end draws `building` from
// there and waits for the pushed messages.
//
// The handlers therefore never block on the build. That is not an optimisation: this
// loop also carries the turn's deltas, the approvals and the interrupt, so a handler
// that waited ninety seconds for a full index pass would make the window look hung.

// CodeIntelService is what a runtime must provide for the workspace's code-index panel.
//
// Optional like every other feature interface here. `CodeIntelPanel` returns the
// snapshot the `ui` message carries; `CodeIntelAction` performs one verb and returns a
// short result for the acknowledgement.
type CodeIntelService interface {
	CodeIntelPanel() (map[string]any, error)
	CodeIntelAction(action string, arguments map[string]any) (map[string]any, error)
}

// handleCodeIntel answers `codeintel_action`.
//
// Everything here runs inline, and that is a deliberate difference from the MCP mount:
// registering or unregistering a tool touches a map the agent reads once per request, and
// a call already in flight holds its own copy of the tool value — so the worst case of a
// switch thrown mid-turn is that the call finishes and the *next* request does not see the
// tool. An MCP mount has a server process to shut down and cannot say that, which is why
// it waits for the turn and this does not.
func (s *Server) handleCodeIntel(message map[string]any) {
	service, ok := s.codeIntelService()
	if !ok {
		return
	}
	action, present := String(message, "action")
	if !present || action == "" {
		s.notice("warn", "codeintel", i18n.T("channels.codeintel.needs_action",
			"actions", strings.Join(CodeIntelActions, ", ")))
		s.sendCodeIntelSnapshot(service, i18n.T("channels.codeintel.needs_action",
			"actions", strings.Join(CodeIntelActions, ", ")))
		return
	}
	if !knownCodeIntelAction(action) {
		s.notice("warn", "codeintel", i18n.T("channels.codeintel.unknown_action",
			"action", action, "actions", strings.Join(CodeIntelActions, ", ")))
		s.sendCodeIntelSnapshot(service, i18n.T("channels.codeintel.unknown_action",
			"action", action, "actions", strings.Join(CodeIntelActions, ", ")))
		return
	}

	result, err := service.CodeIntelAction(action, message)
	if err != nil {
		s.notice("warn", "codeintel", i18n.T("channels.codeintel.action_failed",
			"action", action, "problem", err.Error()))
		s.sendCodeIntelSnapshot(service, err.Error())
		return
	}
	if line := codeIntelResultLine(action, result); line != "" {
		s.notice("info", "codeintel", line)
	}
	s.sendCodeIntelSnapshot(service, "")
	// A permission change rewrites what the model can see, so the state snapshot follows
	// at once rather than waiting for the next tool result — the same pairing `mcp`
	// load/unload uses.
	if action == CodeIntelConfig {
		s.Send(s.stateMessage(false))
	}
}

// codeIntelResultLine is what the transcript says about a finished action.
//
// The build's own outcome does not appear here: it arrives as the pushed
// `ui(codeintel)` when the pass ends, and a second sentence at the moment the button was
// pressed would say "done" before anything had started.
func codeIntelResultLine(action string, result map[string]any) string {
	if result == nil {
		return ""
	}
	switch action {
	case CodeIntelConfig:
		enabled, _ := result["enabled"].(bool)
		if enabled {
			return i18n.T("channels.codeintel.enabled")
		}
		return i18n.T("channels.codeintel.disabled")
	case CodeIntelInit:
		return i18n.T("channels.codeintel.init_started")
	case CodeIntelSync:
		return i18n.T("channels.codeintel.sync_started")
	default:
		return ""
	}
}

// sendCodeIntelSnapshot sends the panel's view, with the runtime's sentence attached when
// there is one.
func (s *Server) sendCodeIntelSnapshot(service CodeIntelService, problem string) {
	payload, err := service.CodeIntelPanel()
	if err != nil {
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UICodeIntel,
			"problem": err.Error(),
		})
		return
	}
	message := map[string]any{
		"v": VERSION, "t": OutUI, "kind": UICodeIntel,
		"codeintel": payload,
	}
	if problem != "" {
		message["problem"] = problem
	}
	s.Send(message)
}

// codeIntelService finds the runtime's index surface, reporting the two ways it can be
// absent.
func (s *Server) codeIntelService() (CodeIntelService, bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "codeintel", i18n.T("channels.codeintel.no_session"))
		return nil, false
	}
	service, ok := runtime.(CodeIntelService)
	if !ok {
		s.notice("warn", "codeintel", i18n.T("channels.codeintel.unsupported"))
		return nil, false
	}
	return service, true
}

func knownCodeIntelAction(action string) bool {
	for _, candidate := range CodeIntelActions {
		if candidate == action {
			return true
		}
	}
	return false
}
