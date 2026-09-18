package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// sentMessages parses everything a server wrote to a stream.
//
// The assertions below are about messages the server **must not** send as much as
// about the ones it must, so the test reads the whole output rather than the last
// line. It decodes what actually crossed — a field the encoder drops is a field
// the front end never sees, and a test on the map in memory would not notice.
func sentMessages(t *testing.T, out *strings.Builder) []map[string]any {
	t.Helper()
	var messages []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatalf("the server wrote a line that is not a message: %q (%v)", line, err)
		}
		messages = append(messages, message)
	}
	return messages
}

// eventsOf returns every forwarded audit record of one kind.
func eventsOf(messages []map[string]any, kind string) []map[string]any {
	var out []map[string]any
	for _, message := range messages {
		if TypeOf(message) != OutEvent {
			continue
		}
		if name, _ := message["kind"].(string); name == kind {
			out = append(out, message)
		}
	}
	return out
}

func countStateSnapshots(messages []map[string]any) int {
	n := 0
	for _, message := range messages {
		if TypeOf(message) != OutUI {
			continue
		}
		if kind, _ := message["kind"].(string); kind == UIState {
			n++
		}
	}
	return n
}

// childRecord builds an audit record as the runtime hands one over for a
// delegated agent: the child's own record plus the runtime's origin marker.
func childRecord(fields map[string]any) map[string]any {
	record := map[string]any{childOriginKey: true}
	for key, value := range fields {
		record[key] = value
	}
	return record
}

// TestAChildsToolCallDoesNotBecomeTheParentsCall is the regression test for a bug
// that reads as a runtime fault rather than a bookkeeping one.
//
// `callID` is what an approval request names as the call it is about. A subagent
// runs inside its parent's tool call, so its own `tool_call` event arrives while
// the parent's is still in flight — and if that event were allowed to set the
// field, the next approval prompt for the parent would name a call the user never
// made, about a tool they never saw called.
func TestAChildsToolCallDoesNotBecomeTheParentsCall(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{
		"kind": "tool_call", "session_id": "parent", "tool": "subagent", "call_id": "call_parent",
	})
	server.OnEvent(childRecord(map[string]any{
		"kind": "tool_call", "session_id": "sub-parent-1", "tool": "read_file",
		"call_id": "call_child", "subagent_id": "sub-parent-1",
	}))

	if got := server.currentCallID(); got != "call_parent" {
		t.Fatalf("the approval would name %q; a child's tool call must not become the parent's", got)
	}
}

// TestAParentsOwnToolResultIsNotAChilds is the regression test the protocol probe
// caught, and it is the bug that would have hidden the whole feature.
//
// The parent's `tool_result` for a subagent call carries `subagent_id` so an
// interface can connect the delegating call to the child it started. Classifying
// records by that field therefore marks the parent's own result as a child's — and
// a front end that skips child records then drops the delegation's answer out of
// the transcript, which is the only place it is ever shown. It also skips the
// snapshot that retires the badge, so the status bar would keep claiming a
// subagent was running.
func TestAParentsOwnToolResultIsNotAChilds(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{
		"kind": "tool_result", "session_id": "parent", "tool": "subagent",
		"call_id": "call_2", "status": "ok", "chars": 120,
		"subagent_id": "sub-parent-1",
	})

	messages := sentMessages(t, &out)
	records := eventsOf(messages, "tool_result")
	if len(records) != 1 {
		t.Fatalf("forwarded %d tool results, want 1", len(records))
	}
	if child, _ := records[0]["child"].(bool); child {
		t.Error("the parent's own tool result was marked as a child's; its answer would never be drawn")
	}
	// The correlation still travels, which is the reason the field is there.
	if id, _ := records[0]["subagent_id"].(string); id != "sub-parent-1" {
		t.Errorf("subagent_id = %v, want it kept for correlation", records[0]["subagent_id"])
	}
	// And the snapshot that retires the delegation's row is driven by this result.
	if countStateSnapshots(messages) == 0 {
		t.Error("no state snapshot followed the parent's tool result; the badge would stay up")
	}
}

// TestTheOriginMarkerDoesNotCrossTheWire keeps the private convention private: a
// front end reads `child`, and two spellings of one fact is how they end up
// disagreeing.
func TestTheOriginMarkerDoesNotCrossTheWire(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(childRecord(map[string]any{"kind": "model_call", "session_id": "sub-parent-1", "step": 1}))
	server.OnEvent(map[string]any{"kind": "model_call", "session_id": "parent", "step": 1, "status": "ok"})

	for _, message := range sentMessages(t, &out) {
		if _, present := message[childOriginKey]; present {
			t.Errorf("the runtime's private marker crossed the wire: %v", message)
		}
	}
}

// TestAChildsStepDoesNotAdvanceTheParentsStep is the other half.
//
// `lastStep` decides which streaming block a delta belongs to. A child's loop
// counts its own steps from one, so a child event landing there would make the
// parent's next delta attach to a step the parent never reached — and the answer
// would be drawn in the wrong place in the transcript.
func TestAChildsStepDoesNotAdvanceTheParentsStep(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{"kind": "model_call", "session_id": "parent", "step": 2, "status": "ok"})
	server.OnEvent(childRecord(map[string]any{
		"kind": "model_call", "session_id": "sub-parent-1", "step": 7, "status": "ok",
	}))

	server.stateLock.Lock()
	step := server.lastStep
	server.stateLock.Unlock()
	if step != 2 {
		t.Fatalf("lastStep = %d, want 2; a child's step is not the parent's", step)
	}
}

// TestAChildsRecordIsForwardedAndMarked checks that isolation did not turn into
// silence: the front end still learns what the child is doing, and it can tell
// where the record came from.
func TestAChildsRecordIsForwardedAndMarked(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(childRecord(map[string]any{
		"kind": "tool_call", "session_id": "sub-parent-1", "tool": "read_file",
		"call_id": "call_child", "subagent_id": "sub-parent-1", "step": 3,
	}))

	records := eventsOf(sentMessages(t, &out), "tool_call")
	if len(records) != 1 {
		t.Fatalf("forwarded %d records, want 1", len(records))
	}
	event := records[0]
	if child, _ := event["child"].(bool); !child {
		t.Error("the record was not marked as a child's; a front end cannot tell it from the parent's own")
	}
	if id, _ := event["subagent_id"].(string); id != "sub-parent-1" {
		t.Errorf("subagent_id = %v, want the child's session id", event["subagent_id"])
	}
	// The child's own step number travels unchanged. It means nothing in the
	// parent's loop, and that is exactly why it must not be rewritten: `--audit
	// <child id>` shows it, and the protocol is the audit log.
	if step, _ := event["step"].(float64); step != 3 {
		t.Errorf("step = %v, want the child's own 3", event["step"])
	}
	// The parent's own counters must be untouched by the record that was forwarded.
	server.stateLock.Lock()
	step, callID := server.lastStep, server.callID
	server.stateLock.Unlock()
	if step != 0 || callID != "" {
		t.Errorf("a child's record set the parent's state: step=%d call=%q", step, callID)
	}
}

// TestAParentsRecordIsNotMarkedAsAChild guards the marker itself. If it were set
// on ordinary records, every front end would stop drawing the parent's own turn.
func TestAParentsRecordIsNotMarkedAsAChild(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{"kind": "tool_call", "session_id": "parent", "tool": "shell", "call_id": "c1"})

	records := eventsOf(sentMessages(t, &out), "tool_call")
	if len(records) != 1 {
		t.Fatalf("forwarded %d records, want 1", len(records))
	}
	if _, present := records[0]["child"]; present {
		t.Error("an ordinary record was marked as a child's")
	}
	// And the parent's own call is remembered, which is what the marker protects.
	if got := server.currentCallID(); got != "c1" {
		t.Errorf("callID = %q, want c1", got)
	}
}

// TestADelegationTransitionAsksForASnapshot covers the moment the badge appears.
//
// The test sends the record the way the runtime actually does — **as a parent
// record**, with the parent's `run_id` and `session_id`. That detail is the whole
// test: an earlier version of this asserted it with a child-marked record, which
// passed while the real thing did nothing, because `delegation_started` never
// travels on the child path. The badge then silently never appeared while every
// test stayed green.
//
// Neither transition produces a tool result of its own — the parent's `subagent`
// call is still running when it starts, and when it finishes the row is already
// gone — so without a snapshot at these two points the badge is only ever drawn
// after the delegation is over.
func TestADelegationTransitionAsksForASnapshot(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	runtime := &stubRuntime{}
	server.Attach(runtime)

	// The parent's own record, exactly as `runtime.onEvent` receives it.
	server.OnEvent(map[string]any{
		"kind": "delegation_started", "session_id": "parent", "run_id": "run-1",
		"subagent_id": "sub-parent-1", "depth": 1, "step": 0,
	})

	if runtime.delegationChanges != 1 {
		t.Errorf("the runtime was told about %d transitions, want 1", runtime.delegationChanges)
	}
	messages := sentMessages(t, &out)
	if countStateSnapshots(messages) == 0 {
		t.Error("no state snapshot was sent for a delegation starting; the badge would never appear")
	}
	// The transition record is the parent's, so it is forwarded unmarked and does
	// not disturb the parent's own counters.
	records := eventsOf(messages, "delegation_started")
	if len(records) != 1 {
		t.Fatalf("forwarded %d delegation_started records, want 1", len(records))
	}
	if child, _ := records[0]["child"].(bool); child {
		t.Error("the parent's own delegation record was marked as a child's")
	}

	// A child's ordinary step is not a transition and must not cost a snapshot: a
	// subagent that makes forty tool calls would otherwise send forty of them.
	var before strings.Builder
	server = NewServer(OpenStreams(strings.NewReader(""), &before), Bootstrap{})
	server.Attach(runtime)
	server.OnEvent(childRecord(map[string]any{
		"kind": "tool_result", "session_id": "sub-parent-1", "tool": "read_file",
	}))
	childMessages := sentMessages(t, &before)
	if len(childMessages) != 1 {
		t.Errorf("a child's tool result sent %d messages, want exactly the forwarded record", len(childMessages))
	}
	if countStateSnapshots(childMessages) != 0 {
		t.Error("a child's ordinary step cost a state snapshot")
	}
}

// stubRuntime is the smallest thing that satisfies Runtime, so the server can be
// driven without a session.
type stubRuntime struct {
	delegationChanges int
}

func (*stubRuntime) RunTurn(string) (string, error)     { return "", nil }
func (*stubRuntime) SessionID() string                  { return "parent" }
func (*stubRuntime) Messages() []map[string]any         { return nil }
func (*stubRuntime) ClearStop()                         {}
func (*stubRuntime) InitFields() map[string]any         { return map[string]any{} }
func (*stubRuntime) StateMessage(bool) map[string]any   { return map[string]any{} }
func (*stubRuntime) StatusMessage() map[string]any      { return map[string]any{} }
func (*stubRuntime) ToolsMessage() map[string]any       { return map[string]any{} }
func (*stubRuntime) ContextMessage() map[string]any     { return map[string]any{} }
func (*stubRuntime) SkillsMessage() map[string]any      { return map[string]any{} }
func (*stubRuntime) SetAutopilot(bool)                  {}
func (*stubRuntime) SetModel(string) (bool, string)     { return false, "" }
func (*stubRuntime) SetThinking(bool) (bool, string)    { return false, "" }
func (*stubRuntime) SetEffort(string) (bool, string)    { return false, "" }
func (*stubRuntime) Compact() (map[string]any, error)   { return map[string]any{}, nil }
func (*stubRuntime) SessionSummaries() []map[string]any { return nil }
func (*stubRuntime) Close() error                       { return nil }
func (*stubRuntime) StatsLine() string                  { return "" }
func (*stubRuntime) ProgressLine() string               { return "" }
func (*stubRuntime) JobsProgressLine() string           { return "" }
func (*stubRuntime) MCPMessage(string, []string) (map[string]any, []string) {
	return map[string]any{}, nil
}

func (r *stubRuntime) OnDelegationChanged() { r.delegationChanges++ }
