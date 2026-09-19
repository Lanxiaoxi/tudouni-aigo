package state

import "testing"

// TestOnlyARealQuestionCountsAsAWait separates two numbers that used to be one.
//
// A `permission` event is written for **every** call that goes through the gate,
// whether or not anybody was asked, because the log has to answer "why did this not
// ask". `waited_ms` is the field that says a person was: the gate sets it only when
// the question actually went out. The status screen's "of which N approval waits" was
// counting the events, so N was the number of tool calls — a figure that told nobody
// anything while claiming the user had been interrupted once per call.
//
// A zero wait still counts: a question that was answered instantly was still asked.
func TestOnlyARealQuestionCountsAsAWait(t *testing.T) {
	events := []map[string]any{
		{"kind": "permission", "tool": "read_file", "outcome": "auto_allowed"},
		{"kind": "permission", "tool": "write_file", "outcome": "approved", "waited_ms": 4200},
		{"kind": "permission", "tool": "read_file", "outcome": "policy_denied"},
		{"kind": "permission", "tool": "shell", "outcome": "approved", "waited_ms": 0},
		{"kind": "tool_result", "tool": "shell", "status": "ok"},
	}
	counters, _ := Summarize(events)["counters"].(map[string]any)
	if got := numberFieldOf(counters, "permission_waits"); got != 2 {
		t.Errorf("permission_waits = %d, want 2 (the calls that actually asked)", got)
	}
	if got := numberFieldOf(counters, "tool_calls"); got != 1 {
		t.Errorf("tool_calls = %d, want 1: the two counters answer different questions", got)
	}
}
