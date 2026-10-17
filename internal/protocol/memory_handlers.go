package protocol

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// Workspace memory, as this layer sees it.
//
// The two handlers here follow the same shape as the files and terminal ones, and for
// the same reasons: an absent session and an absent feature are two different
// sentences, a refusal is a sentence rather than a silent empty answer, and the payload
// is whatever the runtime built.
//
// One difference is worth stating, because it is the only one. A refusal **also**
// re-sends the snapshot, carrying `problem`. The memory panel is a modal layer over
// the transcript, so a notice about "this proposal disappeared" would be printed behind
// the panel that is asking the question — the failure the files panel hit first and
// fixed by growing its own problem field. The snapshot is the panel's own channel, so
// the sentence goes there and the notice stays for the transcript's benefit.

// MemoryService is what a runtime must provide for the workspace's memory panel.
//
// Optional like every other feature interface here. `MemoryPanel` returns the snapshot
// the `ui` message carries; `MemoryAction` performs one review decision and returns a
// short result for the notice ("published mem_003").
type MemoryService interface {
	MemoryPanel() (map[string]any, error)
	MemoryAction(action string, arguments map[string]any) (map[string]any, error)
}

// handleMemoryList answers `memory_list`.
func (s *Server) handleMemoryList() {
	service, ok := s.memoryService()
	if !ok {
		return
	}
	s.sendMemorySnapshot(service, "")
}

// handleMemoryAction answers `memory_action`: one review decision, then the whole
// snapshot again.
//
// The snapshot always goes out, on success and on failure alike, and that is the
// design's answer to "how does the panel know what happened": the runtime is the only
// source of truth for what memories and proposals exist, so the panel redraws from one
// message rather than patching its own copy from a success flag.
func (s *Server) handleMemoryAction(message map[string]any) {
	service, ok := s.memoryService()
	if !ok {
		return
	}
	action, present := String(message, "action")
	if !present || action == "" {
		s.notice("warn", "memory", i18n.T("channels.memory.needs_action",
			"actions", strings.Join(MemoryActions, ", ")))
		s.sendMemorySnapshot(service, i18n.T("channels.memory.needs_action",
			"actions", strings.Join(MemoryActions, ", ")))
		return
	}
	if !knownMemoryAction(action) {
		s.notice("warn", "memory", i18n.T("channels.memory.unknown_action",
			"action", action, "actions", strings.Join(MemoryActions, ", ")))
		s.sendMemorySnapshot(service, i18n.T("channels.memory.unknown_action",
			"action", action, "actions", strings.Join(MemoryActions, ", ")))
		return
	}

	result, err := service.MemoryAction(action, message)
	if err != nil {
		s.notice("warn", "memory", i18n.T("channels.memory.action_failed",
			"action", action, "problem", err.Error()))
		s.sendMemorySnapshot(service, err.Error())
		return
	}
	// One sentence per verb, because they mean different things to the person reading
	// the transcript afterwards: a publication is a fact about the corpus, a queued
	// proposal is a reminder that nothing has changed yet.
	if line := memoryResultLine(action, result); line != "" {
		s.notice("info", "memory", line)
	}
	s.sendMemorySnapshot(service, "")
}

// memoryResultLine is what the transcript says about a finished action.
func memoryResultLine(action string, result map[string]any) string {
	if result == nil {
		return ""
	}
	switch action {
	case MemoryPublish:
		if id, ok := result["entry_id"].(string); ok && id != "" {
			revision := 0
			if value, ok := result["revision"].(int); ok {
				revision = value
			}
			return i18n.T("channels.memory.published", "id", id, "revision", revision)
		}
		// A published deprecation has no entry to name: the memory is gone from the
		// active set by design, so there is nothing to announce beyond the snapshot.
		return ""
	case MemoryDeprecate:
		if id, ok := result["proposal_id"].(string); ok && id != "" {
			return i18n.T("channels.memory.queued", "id", id)
		}
		return ""
	case MemoryRebuild:
		entries := 0
		if value, ok := result["entries"].(int); ok {
			entries = value
		}
		return i18n.T("channels.memory.rebuilt", "entries", entries)
	case MemoryConfig:
		return i18n.T("channels.memory.saved")
	default:
		return ""
	}
}

// sendMemorySnapshot sends the panel's view, with the runtime's sentence attached when
// there is one.
func (s *Server) sendMemorySnapshot(service MemoryService, problem string) {
	payload, err := service.MemoryPanel()
	if err != nil {
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UIMemory,
			"problem": err.Error(),
		})
		return
	}
	message := map[string]any{
		"v": VERSION, "t": OutUI, "kind": UIMemory,
		"memory": payload,
	}
	if problem != "" {
		message["problem"] = problem
	}
	s.Send(message)
}

// memoryService finds the runtime's memory surface, reporting the two ways it can be
// absent.
func (s *Server) memoryService() (MemoryService, bool) {
	runtime := s.current()
	if runtime == nil {
		s.notice("warn", "memory", i18n.T("channels.memory.no_session"))
		return nil, false
	}
	service, ok := runtime.(MemoryService)
	if !ok {
		s.notice("warn", "memory", i18n.T("channels.memory.unsupported"))
		return nil, false
	}
	return service, true
}

func knownMemoryAction(action string) bool {
	for _, candidate := range MemoryActions {
		if candidate == action {
			return true
		}
	}
	return false
}
