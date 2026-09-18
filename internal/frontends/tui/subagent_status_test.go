package tui

import (
	"strings"
	"testing"
)

// subagentPanel builds a panel state with one running delegation, in the shape
// the runtime sends.
func subagentPanel(id, label, activity string) []any {
	return []any{map[string]any{
		"id":         id,
		"label":      label,
		"model":      "deepseek-flash",
		"provider":   "deepseek",
		"depth":      1,
		"seconds":    4,
		"steps":      2,
		"tool_calls": 1,
		"activity":   activity,
	}}
}

// TestAChildsToolCallStaysOutOfTheParentsTranscript is the whole reason child
// records are marked.
//
// A subagent runs inside its parent's tool call, so its `tool_call` and
// `tool_result` events arrive while the parent's turn is open. Drawing them would
// interleave two conversations: the parent's block would appear to have made steps
// it never made, and a child's `read_file` would read as though the parent had
// asked for it — which is exactly the confusion delegation exists to avoid.
func TestAChildsToolCallStaysOutOfTheParentsTranscript(t *testing.T) {
	m := testModel()
	m.busy = true
	m.beginTurn(map[string]any{"run_id": "run-1"})

	before := len(m.current.lines)

	m.handleEvent(map[string]any{
		"kind": "tool_call", "child": true, "subagent_id": "sub-parent-1",
		"tool": "read_file", "arguments": `{"path":"secret.txt"}`, "call_id": "c9",
	})
	m.handleEvent(map[string]any{
		"kind": "tool_result", "child": true, "subagent_id": "sub-parent-1",
		"tool": "read_file", "status": "ok", "chars": 12,
	})

	if len(m.current.lines) != before {
		t.Errorf("a child's events added %d lines to the parent's transcript", len(m.current.lines)-before)
	}
	if m.current.steps != 0 {
		t.Errorf("the parent's turn counted %d steps from a child's events", m.current.steps)
	}
}

// TestAChildsToolNameReachesTheStatusBar is the other half: the events are
// suppressed from the transcript, not ignored. The tool name is what makes the
// badge worth reading — "1 subagent" does not say whether it is searching, reading
// or writing.
func TestAChildsToolNameReachesTheStatusBar(t *testing.T) {
	m := testModel()
	m.panel.subagents = subagentPanel("sub-parent-1", "count widgets", "")

	m.handleEvent(map[string]any{
		"kind": "tool_call", "child": true, "subagent_id": "sub-parent-1",
		"tool": "grep", "call_id": "c9",
	})

	row, _ := m.panel.subagents[0].(map[string]any)
	if got := row["activity"]; got != "grep" {
		t.Fatalf("activity = %v, want grep", got)
	}
	if badge := m.subagentsBadge(false); !strings.Contains(badge, "grep") {
		t.Errorf("the badge does not say what the subagent is doing: %q", badge)
	}

	// The result clears it. A tool name left standing after the call returned reads
	// as "still doing that", which is the wrong answer while the child decides what
	// to do next.
	m.handleEvent(map[string]any{
		"kind": "tool_result", "child": true, "subagent_id": "sub-parent-1", "tool": "grep",
	})
	if got := row["activity"]; got != "" {
		t.Errorf("activity = %v after the call returned, want it cleared", got)
	}
	// With no activity the label is the next-best thing, and it is the model's own
	// words for the task.
	if badge := m.subagentsBadge(false); !strings.Contains(badge, "count widgets") {
		t.Errorf("the badge fell back to nothing: %q", badge)
	}
}

// TestTheBadgeOnlyAppearsForARunningDelegation pins the empty case. A cell that
// showed "0 subagents" would be permanent furniture; the jobs cell next to it has
// an all-collected wording precisely because a collected job still needs a person,
// and a settled delegation does not.
func TestTheBadgeOnlyAppearsForARunningDelegation(t *testing.T) {
	m := testModel()
	if badge := m.subagentsBadge(false); badge != "" {
		t.Errorf("an idle interface shows %q", badge)
	}

	m.panel.subagents = subagentPanel("sub-parent-1", "count widgets", "grep")
	badge := m.subagentsBadge(false)
	if !strings.Contains(badge, "1 subagent") {
		t.Errorf("badge = %q, want the count", badge)
	}

	// The runtime removes the row when the delegation settles, and the badge has to
	// follow without the interface counting events itself.
	m.applyState(map[string]any{"subagents": []any{}})
	if badge := m.subagentsBadge(false); badge != "" {
		t.Errorf("the badge outlived the delegation: %q", badge)
	}
}

// TestTheBadgeDropsItsDetailOnANarrowTerminal keeps the right-hand cell from
// pushing the model name off the bar. The count is the part that must survive.
func TestTheBadgeDropsItsDetailOnANarrowTerminal(t *testing.T) {
	m := testModel()
	m.panel.subagents = subagentPanel("sub-parent-1", "count widgets", "grep")

	narrow := m.subagentsBadge(true)
	if strings.Contains(narrow, "grep") {
		t.Errorf("the narrow badge kept its detail: %q", narrow)
	}
	if !strings.Contains(narrow, "1 subagent") {
		t.Errorf("the narrow badge lost the count: %q", narrow)
	}
}

// TestTheChildActivityDoesNotInventARow checks the one failure a partial update
// causes: a subagent that appears on the bar because a record arrived for it,
// with no start time and no idea who asked for it.
func TestTheChildActivityDoesNotInventARow(t *testing.T) {
	m := testModel()
	m.panel.subagents = subagentPanel("sub-parent-1", "count widgets", "")

	m.handleEvent(map[string]any{
		"kind": "tool_call", "child": true, "subagent_id": "sub-someone-else",
		"tool": "grep", "call_id": "c9",
	})

	if len(m.panel.subagents) != 1 {
		t.Fatalf("a record for an unknown delegation created a row: %d rows", len(m.panel.subagents))
	}
	row, _ := m.panel.subagents[0].(map[string]any)
	if id, _ := row["id"].(string); id != "sub-parent-1" {
		t.Errorf("the row now belongs to %v", row["id"])
	}
	if got := row["activity"]; got != "" {
		t.Errorf("a record for another delegation set this row's activity to %v", got)
	}
}
