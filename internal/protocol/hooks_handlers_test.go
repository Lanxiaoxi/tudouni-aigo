package protocol

import (
	"strings"
	"testing"
)

// hooksStub is a runtime with the hooks-panel capability.
type hooksStub struct {
	stubRuntime

	// snapshot is what HooksPanel answers with.
	snapshot  map[string]any
	panelErr  error
	actionErr error
	// calls records "<action>:<revision>".
	calls []string
}

func (s *hooksStub) HooksPanel() (map[string]any, error) {
	if s.panelErr != nil {
		return nil, s.panelErr
	}
	return s.snapshot, nil
}

func (s *hooksStub) HooksAction(action string, arguments map[string]any) (map[string]any, error) {
	revision, _ := String(arguments, "revision")
	s.calls = append(s.calls, action+":"+revision)
	if s.actionErr != nil {
		return nil, s.actionErr
	}
	return map[string]any{"hooks": 3}, nil
}

func TestHooksListAnswersWithTheSnapshot(t *testing.T) {
	runtime := &hooksStub{snapshot: map[string]any{
		"path":    "/home/me/.tudouni/hooks.json",
		"entries": []any{map[string]any{"name": "guard"}},
	}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksList,
	}))

	if kind, _ := String(message, "kind"); kind != UIHooks {
		t.Fatalf("kind = %q, want %q", kind, UIHooks)
	}
	// The runtime's payload travels under `hooks` unchanged: this layer adds the envelope
	// and must not reshape a body it does not understand.
	payload, ok := message["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("hooks = %T, want an object", message["hooks"])
	}
	if path, _ := String(payload, "path"); path != "/home/me/.tudouni/hooks.json" {
		t.Errorf("path = %q", path)
	}
	if _, present := message["problem"]; present {
		t.Error("a plain read carried a problem")
	}
}

// TestHooksSaveAnswersWithAFreshSnapshot: the panel redraws from the reply, so a
// successful save must carry the whole state and not just an acknowledgement.
func TestHooksSaveAnswersWithAFreshSnapshot(t *testing.T) {
	runtime := &hooksStub{snapshot: map[string]any{"entries": []any{}}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksAction, "action": HooksSave, "revision": "abc",
	}))
	if len(runtime.calls) != 1 || runtime.calls[0] != "save:abc" {
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
	text, _ := String(messages[0], "text")
	// The sentence has to say the session in front of the person did not change — "saved"
	// alone is read as "now active", and the next tool call would disprove it.
	if !strings.Contains(text, "3") || !strings.Contains(text, "new session") {
		t.Errorf("notice = %q, want the count and the new-session caveat", text)
	}
	if TypeOf(messages[1]) != OutUI {
		t.Errorf("second message type = %q, want %q", TypeOf(messages[1]), OutUI)
	}
	if _, present := messages[1]["problem"]; present {
		t.Error("a successful save carried a problem")
	}
}

// TestHooksRefusalReachesThePanel: a refusal is a sentence **inside the snapshot**,
// because a notice lands behind the panel that is asking the question.
func TestHooksRefusalReachesThePanel(t *testing.T) {
	runtime := &hooksStub{
		snapshot:  map[string]any{"entries": []any{}},
		actionErr: &stubError{"the matcher of guard is not a valid regular expression"},
	}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksAction, "action": HooksSave, "revision": "abc",
	}))
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a notice and a snapshot", len(messages))
	}
	problem, _ := String(messages[1], "problem")
	if !strings.Contains(problem, "not a valid regular expression") {
		t.Errorf("the snapshot's problem = %q, want the runtime's own sentence", problem)
	}
	if _, ok := messages[1]["hooks"].(map[string]any); !ok {
		t.Error("a refused save dropped the snapshot, so the panel cannot redraw what the file still says")
	}
}

func TestHooksActionRejectsAnUnknownVerb(t *testing.T) {
	runtime := &hooksStub{snapshot: map[string]any{}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksAction, "action": "delete-everything",
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
	if problem, _ := String(messages[1], "problem"); !strings.Contains(problem, "delete-everything") {
		t.Errorf("problem = %q, want the verb named", problem)
	}
}

func TestHooksActionWithoutAVerbIsRefused(t *testing.T) {
	runtime := &hooksStub{snapshot: map[string]any{}}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksAction,
	}))
	if len(runtime.calls) != 0 {
		t.Fatalf("a request with no verb reached the runtime: %v", runtime.calls)
	}
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a warning and a snapshot", len(messages))
	}
}

func TestAPanelThatCannotBeBuiltStillAnswers(t *testing.T) {
	runtime := &hooksStub{panelErr: &stubError{"no home directory"}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InHooksList,
	}))
	if problem, _ := String(message, "problem"); !strings.Contains(problem, "no home directory") {
		t.Errorf("problem = %q, want the reason", problem)
	}
	if _, present := message["hooks"]; present {
		t.Error("an unbuildable panel carried a snapshot")
	}
}

// TestHooksHandlersAreOptional: a runtime that does not implement the interface has to
// say so, because an empty panel and "this build cannot edit hooks" look identical on
// screen and the second one is a bug nobody reports.
func TestHooksHandlersAreOptional(t *testing.T) {
	runtime := &stubRuntime{}
	for _, inbound := range []map[string]any{
		{"v": VERSION, "t": InHooksList},
		{"v": VERSION, "t": InHooksAction, "action": HooksSave},
	} {
		message := onlyMessage(t, driveServer(t, runtime, inbound))
		if TypeOf(message) != OutNotice {
			t.Errorf("type = %q, want a notice", TypeOf(message))
		}
	}
}
