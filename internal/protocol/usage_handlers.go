package protocol

import "github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"

// UsageService is what a runtime must provide for the usage panel.
//
// Optional like every other feature interface here. `UsagePanel` returns the
// snapshot the `ui` message carries; there is no action method, because there
// is nothing on the panel a person can act on — it is the one workbench
// destination that only reads.
type UsageService interface {
	UsagePanel() (map[string]any, error)
}

// handleUsage answers `usage_stats`.
//
// The shape is the memory handlers', minus the action: an absent session and an
// absent ledger are two different sentences, and a refusal is a sentence in the
// panel's own message rather than a notice the open panel would cover. The
// snapshot is sent even on failure — as `problem` and no `usage` — because
// "the ledger could not be read" is itself an answer the panel can draw.
func (s *Server) handleUsage() {
	service, ok := s.usageService()
	if !ok {
		return
	}
	payload, err := service.UsagePanel()
	if err != nil {
		s.notice("warn", "usage", i18n.T("channels.usage.failed", "problem", err.Error()))
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UIUsage,
			"problem": err.Error(),
		})
		return
	}
	s.Send(map[string]any{
		"v": VERSION, "t": OutUI, "kind": UIUsage,
		"usage": payload,
	})
}

// usageService finds the runtime's ledger surface, reporting the two ways it
// can be absent.
func (s *Server) usageService() (UsageService, bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "usage", i18n.T("channels.usage.no_session"))
		return nil, false
	}
	service, ok := runtime.(UsageService)
	if !ok {
		s.notice("warn", "usage", i18n.T("channels.usage.unsupported"))
		return nil, false
	}
	return service, true
}
