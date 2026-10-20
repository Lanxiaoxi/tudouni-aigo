package protocol

import (
	"strings"
	"testing"
)

// codeIntelStub is a runtime with the code-index capability.
type codeIntelStub struct {
	stubRuntime

	snapshot map[string]any
	panelErr error
	// actionErr is what the next CodeIntelAction returns.
	actionErr error
	// calls records the verbs the runtime was asked for, in order.
	calls []string
}

func (s *codeIntelStub) CodeIntelPanel() (map[string]any, error) {
	if s.panelErr != nil {
		return nil, s.panelErr
	}
	return s.snapshot, nil
}

func (s *codeIntelStub) CodeIntelAction(action string, arguments map[string]any) (map[string]any, error) {
	s.calls = append(s.calls, action)
	if s.actionErr != nil {
		return nil, s.actionErr
	}
	switch action {
	case CodeIntelConfig:
		enabled, _ := arguments["enabled"].(bool)
		return map[string]any{"enabled": enabled}, nil
	case CodeIntelInit:
		return map[string]any{"started": true, "full": true}, nil
	case CodeIntelSync:
		return map[string]any{"started": true, "full": false}, nil
	default:
		return nil, nil
	}
}

// TestCodeIntelStatusAnswersWithTheSnapshot: one message, the runtime's payload unchanged.
func TestCodeIntelStatusAnswersWithTheSnapshot(t *testing.T) {
	runtime := &codeIntelStub{snapshot: map[string]any{
		"enabled": true,
		"indexed": true,
		"files":   float64(552),
	}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": CodeIntelStatus,
	}))

	if kind, _ := String(message, "kind"); kind != UICodeIntel {
		t.Fatalf("kind = %q, want %q", kind, UICodeIntel)
	}
	payload, ok := message["codeintel"].(map[string]any)
	if !ok {
		t.Fatalf("codeintel = %T, want an object", message["codeintel"])
	}
	if files, _ := payload["files"].(float64); files != 552 {
		t.Errorf("files = %v, want the runtime's own number", payload["files"])
	}
	// `status` changes nothing, so it must not be followed by a state snapshot: one
	// request, one answer.
	if len(runtime.calls) != 1 || runtime.calls[0] != CodeIntelStatus {
		t.Fatalf("the runtime saw %v", runtime.calls)
	}
}

// TestCodeIntelConfigAlsoRestatesTheState: a permission change changes what the model can
// see, so the schema snapshot follows the panel's own answer — the pairing `mcp` uses.
func TestCodeIntelConfigAlsoRestatesTheState(t *testing.T) {
	runtime := &codeIntelStub{snapshot: map[string]any{"enabled": true}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": CodeIntelConfig, "enabled": true,
	}))
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want a notice, the panel and the state: %v", len(messages), messages)
	}
	if TypeOf(messages[0]) != OutNotice {
		t.Errorf("first = %q, want a notice", TypeOf(messages[0]))
	}
	if kind, _ := String(messages[1], "kind"); kind != UICodeIntel {
		t.Errorf("second kind = %q, want %q", kind, UICodeIntel)
	}
	if kind, _ := String(messages[2], "kind"); kind != UIState {
		t.Errorf("third kind = %q, want the state snapshot", kind)
	}
}

// TestCodeIntelInitAcknowledgesWithoutAStateDump: a build's progress is pushed through the
// runtime's own hook, so the reply is the acknowledgement and the panel's snapshot — not a
// state snapshot nobody asked for.
func TestCodeIntelInitAcknowledgesWithoutAStateDump(t *testing.T) {
	runtime := &codeIntelStub{snapshot: map[string]any{"building": true}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": CodeIntelInit,
	}))
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a notice and the panel", len(messages))
	}
	if kind, _ := String(messages[1], "kind"); kind != UICodeIntel {
		t.Errorf("kind = %q, want %q", kind, UICodeIntel)
	}
}

// TestCodeIntelRefusalReachesThePanel: a refusal is a sentence inside the snapshot, because
// a notice lands behind the panel that is asking.
func TestCodeIntelRefusalReachesThePanel(t *testing.T) {
	runtime := &codeIntelStub{
		snapshot:  map[string]any{"enabled": true},
		actionErr: &stubError{"an index build is already running"},
	}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": CodeIntelInit,
	}))
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a warning and a snapshot", len(messages))
	}
	problem, _ := String(messages[1], "problem")
	if !strings.Contains(problem, "already running") {
		t.Errorf("problem = %q, want the runtime's sentence", problem)
	}
	if _, ok := messages[1]["codeintel"].(map[string]any); !ok {
		t.Error("a refused action dropped the snapshot")
	}
}

func TestCodeIntelRejectsAnUnknownVerb(t *testing.T) {
	runtime := &codeIntelStub{snapshot: map[string]any{}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": "delete-everything",
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

// TestCodeIntelHandlersAreOptional: a runtime without the capability has to say so —
// an empty panel and "this build cannot do this" look identical on screen.
func TestCodeIntelHandlersAreOptional(t *testing.T) {
	message := onlyMessage(t, driveServer(t, &stubRuntime{}, map[string]any{
		"v": VERSION, "t": InCodeIntel, "action": CodeIntelStatus,
	}))
	if TypeOf(message) != OutNotice {
		t.Errorf("type = %q, want a notice", TypeOf(message))
	}
}
