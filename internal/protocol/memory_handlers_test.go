package protocol

import (
	"strings"
	"testing"
)

// memoryStub is a runtime with the workspace-memory capability.
type memoryStub struct {
	stubRuntime

	// snapshot is what MemoryPanel answers with.
	snapshot map[string]any
	panelErr error
	// actionErr is what the next MemoryAction returns.
	actionErr error
	// calls records "<action>:<first argument that mattered>".
	calls []string
}

func (s *memoryStub) MemoryPanel() (map[string]any, error) {
	if s.panelErr != nil {
		return nil, s.panelErr
	}
	return s.snapshot, nil
}

func (s *memoryStub) MemoryAction(action string, arguments map[string]any) (map[string]any, error) {
	id, _ := String(arguments, "proposal_id")
	if id == "" {
		id, _ = String(arguments, "entry_id")
	}
	s.calls = append(s.calls, action+":"+id)
	if s.actionErr != nil {
		return nil, s.actionErr
	}
	switch action {
	case MemoryPublish:
		return map[string]any{"entry_id": "mem_001", "revision": 2}, nil
	case MemoryDeprecate:
		return map[string]any{"proposal_id": "proposal_007"}, nil
	case MemoryRebuild:
		return map[string]any{"entries": 4}, nil
	default:
		return nil, nil
	}
}

func TestMemoryListAnswersWithTheSnapshot(t *testing.T) {
	runtime := &memoryStub{snapshot: map[string]any{
		"root":    "/ws/.tudouni/memory",
		"entries": []any{map[string]any{"id": "mem_001", "title": "one"}},
	}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InMemoryList,
	}))

	if kind, _ := String(message, "kind"); kind != UIMemory {
		t.Fatalf("kind = %q, want %q", kind, UIMemory)
	}
	// The runtime's payload travels under `memory` unchanged: this layer adds the
	// envelope and must not reshape a body it does not understand.
	payload, ok := message["memory"].(map[string]any)
	if !ok {
		t.Fatalf("memory = %T, want an object", message["memory"])
	}
	if root, _ := String(payload, "root"); root != "/ws/.tudouni/memory" {
		t.Errorf("root = %q", root)
	}
}

// TestMemoryActionAnswersWithAFreshSnapshot: the panel redraws from the reply, so a
// successful action must carry the whole state and not just an acknowledgement.
func TestMemoryActionAnswersWithAFreshSnapshot(t *testing.T) {
	runtime := &memoryStub{snapshot: map[string]any{"entries": []any{}}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InMemoryAction, "action": MemoryPublish, "proposal_id": "proposal_001",
	}))
	if len(runtime.calls) != 1 || runtime.calls[0] != "publish:proposal_001" {
		t.Fatalf("the runtime saw %v", runtime.calls)
	}

	// One notice plus one snapshot, in that order: the sentence is for the transcript,
	// the snapshot for the panel.
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a notice and a snapshot: %v", len(messages), messages)
	}
	if TypeOf(messages[0]) != OutNotice {
		t.Errorf("first message type = %q, want %q", TypeOf(messages[0]), OutNotice)
	}
	if TypeOf(messages[1]) != OutUI {
		t.Errorf("second message type = %q, want %q", TypeOf(messages[1]), OutUI)
	}
	if _, present := messages[1]["problem"]; present {
		t.Error("a successful action carried a problem")
	}
}

// TestMemoryActionRefusalReachesThePanel: a refusal is a sentence **inside the
// snapshot**, because a notice lands behind the panel that is asking the question.
func TestMemoryActionRefusalReachesThePanel(t *testing.T) {
	runtime := &memoryStub{
		snapshot:  map[string]any{"entries": []any{}},
		actionErr: &stubError{"memory mem_002 has changed since this proposal was written"},
	}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InMemoryAction, "action": MemoryPublish, "proposal_id": "proposal_009",
	}))
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a notice and a snapshot", len(messages))
	}
	problem, _ := String(messages[1], "problem")
	if !strings.Contains(problem, "has changed") {
		t.Errorf("the snapshot's problem = %q, want the runtime's own sentence", problem)
	}
	if _, ok := messages[1]["memory"].(map[string]any); !ok {
		t.Error("a refused action dropped the snapshot, so the panel cannot redraw what still exists")
	}
}

func TestMemoryActionRejectsAnUnknownVerb(t *testing.T) {
	runtime := &memoryStub{snapshot: map[string]any{}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InMemoryAction, "action": "delete-everything",
	}))
	if len(runtime.calls) != 0 {
		t.Fatalf("an unknown verb reached the runtime: %v", runtime.calls)
	}
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a warning and a snapshot", len(messages))
	}
	if level, _ := String(messages[0], "level"); level != "warn" {
		t.Errorf("level = %q, want warn", level)
	}
}

// TestMemoryHandlersAreOptional: a runtime that does not implement the interface has to
// say so, because an empty panel and "this build cannot do memory" look identical on
// screen and the second one is a bug nobody reports.
func TestMemoryHandlersAreOptional(t *testing.T) {
	runtime := &stubRuntime{}
	for _, inbound := range []map[string]any{
		{"v": VERSION, "t": InMemoryList},
		{"v": VERSION, "t": InMemoryAction, "action": MemoryPublish, "proposal_id": "p"},
	} {
		message := onlyMessage(t, driveServer(t, runtime, inbound))
		if TypeOf(message) != OutNotice {
			t.Errorf("type = %q, want a notice", TypeOf(message))
		}
	}
}
