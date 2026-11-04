package protocol

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The user's hooks file, as this layer sees it.
//
// Same shape as the memory handlers and for the same reasons: an absent session and an
// absent feature are two different sentences, a refusal is a sentence rather than a silent
// empty answer, and the payload is whatever the runtime built. The one difference is that
// a refusal here also re-sends the snapshot carrying `problem`, exactly as memory does —
// the panel is a layer over the transcript, so a notice would be printed behind it.

// HooksService is what a runtime must provide for the hooks panel.
//
// Optional like every other feature interface here. `HooksPanel` returns the snapshot the
// `ui` message carries; `HooksAction` performs one change and returns a short result for
// the notice ("saved 3 hooks").
type HooksService interface {
	HooksPanel() (map[string]any, error)
	HooksAction(action string, arguments map[string]any) (map[string]any, error)
}

// handleHooksList answers `hooks_list`.
func (s *Server) handleHooksList() {
	service, ok := s.hooksService()
	if !ok {
		return
	}
	s.sendHooksSnapshot(service, "")
}

// handleHooksAction answers `hooks_action`: one change, then the whole snapshot again.
//
// The snapshot always goes out, on success and on failure alike. The runtime is the only
// source of truth for what is in the file and what this session is running, so the panel
// redraws from one message instead of patching its own copy from a success flag.
func (s *Server) handleHooksAction(message map[string]any) {
	service, ok := s.hooksService()
	if !ok {
		return
	}
	action, present := String(message, "action")
	if !present || action == "" {
		sentence := i18n.T("channels.hooks.needs_action", "actions", strings.Join(HooksActions, ", "))
		s.notice("warn", "hooks", sentence)
		s.sendHooksSnapshot(service, sentence)
		return
	}
	if !knownHooksAction(action) {
		sentence := i18n.T("channels.hooks.unknown_action",
			"action", action, "actions", strings.Join(HooksActions, ", "))
		s.notice("warn", "hooks", sentence)
		s.sendHooksSnapshot(service, sentence)
		return
	}

	result, err := service.HooksAction(action, message)
	if err != nil {
		s.notice("warn", "hooks", i18n.T("channels.hooks.action_failed",
			"action", action, "problem", err.Error()))
		s.sendHooksSnapshot(service, err.Error())
		return
	}
	if line := hooksResultLine(action, result); line != "" {
		s.notice("info", "hooks", line)
	}
	s.sendHooksSnapshot(service, "")
}

// hooksResultLine is what the transcript says about a finished action.
//
// It says the thing a person would otherwise have to discover: that saving changed the
// file and **not** the session they are in. A line that only said "saved" would be read as
// "now active", and the first tool call after it would disprove that.
func hooksResultLine(action string, result map[string]any) string {
	if action != HooksSave || result == nil {
		return ""
	}
	count := 0
	if value, ok := result["hooks"].(int); ok {
		count = value
	}
	return i18n.T("channels.hooks.saved", "n", count)
}

// sendHooksSnapshot sends the panel's view, with the runtime's sentence attached when there
// is one.
func (s *Server) sendHooksSnapshot(service HooksService, problem string) {
	payload, err := service.HooksPanel()
	if err != nil {
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UIHooks,
			"problem": err.Error(),
		})
		return
	}
	message := map[string]any{
		"v": VERSION, "t": OutUI, "kind": UIHooks,
		"hooks": payload,
	}
	if problem != "" {
		message["problem"] = problem
	}
	s.Send(message)
}

// hooksService finds the runtime's hooks surface, reporting the two ways it can be absent.
func (s *Server) hooksService() (HooksService, bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "hooks", i18n.T("channels.hooks.no_session"))
		return nil, false
	}
	service, ok := runtime.(HooksService)
	if !ok {
		s.notice("warn", "hooks", i18n.T("channels.hooks.unsupported"))
		return nil, false
	}
	return service, true
}

func knownHooksAction(action string) bool {
	for _, candidate := range HooksActions {
		if candidate == action {
			return true
		}
	}
	return false
}
