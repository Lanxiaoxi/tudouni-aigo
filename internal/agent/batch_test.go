package agent

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// TestASerialBatchStaysAdjacent is the rule the previous generation states as
// number three: report → decide → run → report, **one call at a time**.
//
// A person asked about call n+1 has to be able to see the result of call n first.
// The result is part of what they are judging with, and it is also the difference
// between "did the first edit land" and "am I about to approve a second edit on top
// of a failed one".
//
// The batch here is serial because `write_file` touches the workspace and therefore
// is not parallel-safe. The asker records how many tool results had already been
// emitted when it was asked, which is exactly what "adjacent" means.
func TestASerialBatchStaysAdjacent(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{
			{ID: "c1", Name: "write_file", Arguments: `{"path":"a.txt","content":"1"}`},
			{ID: "c2", Name: "write_file", Arguments: `{"path":"b.txt","content":"2"}`},
		}},
		textResponse("done"),
	}}

	var resultsSeenAtApproval []int
	results := 0
	harness := newHarness(t, chat, func(string, security.RiskLevel, map[string]any) bool {
		resultsSeenAtApproval = append(resultsSeenAtApproval, results)
		return true
	})
	// Count tool results as they are emitted, which is the order a person sees them.
	harness.eventHook = func(record map[string]any) {
		if kind, _ := record["kind"].(string); kind == "tool_result" {
			results++
		}
	}

	if _, err := harness.agent.Run("write both"); err != nil {
		t.Fatal(err)
	}

	if len(resultsSeenAtApproval) != 2 {
		t.Fatalf("the asker was consulted %d times, want 2", len(resultsSeenAtApproval))
	}
	if resultsSeenAtApproval[0] != 0 {
		t.Errorf("the first approval saw %d results, want 0", resultsSeenAtApproval[0])
	}
	if resultsSeenAtApproval[1] != 1 {
		t.Errorf("the second approval saw %d results, want 1 — the batch was "+
			"prepared up front instead of running call by call", resultsSeenAtApproval[1])
	}
}

// TestAParallelBatchIsDecidedBeforeAnythingRuns is the other half of the same rule:
// when the batch **can** run concurrently, every question is answered first.
//
// The reason is not tidiness. A yes to the third call must not be given while the
// first two are already writing files: the person would be approving something whose
// premises are already in motion.
func TestAParallelBatchIsDecidedBeforeAnythingRuns(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{
			{ID: "c1", Name: "read_file", Arguments: `{"path":"a.txt"}`},
			{ID: "c2", Name: "read_file", Arguments: `{"path":"b.txt"}`},
		}},
		textResponse("done"),
	}}

	// Both reads are LOW and parallel-safe, so the policy lets them through without
	// asking. To observe the ordering anyway, make the policy ask: a medium-risk
	// tool would break the parallel path, so instead count executions from the
	// registry side through the asker's view of the audit.
	var order []string
	harness := newHarness(t, chat, security.AlwaysAllow)
	harness.eventHook = func(record map[string]any) {
		kind, _ := record["kind"].(string)
		tool, _ := record["tool"].(string)
		order = append(order, kind+":"+tool)
	}

	if _, err := harness.agent.Run("read both"); err != nil {
		t.Fatal(err)
	}

	// Both calls are reported before any result: call, call, result, result.
	calls, firstResult := 0, -1
	for index, entry := range order {
		if entry == "tool_call:read_file" {
			calls++
		}
		if firstResult < 0 && len(entry) > 12 && entry[:12] == "tool_result:" {
			firstResult = index
		}
	}
	if calls != 2 || firstResult < 0 || firstResult < 2 {
		t.Errorf("a parallel batch did not decide everything up front: %v", order)
	}
}

// TestStepLimitNamesOnlyTheLastStepTools pins the message that is the only clue a
// person gets about where a turn got stuck.
//
// Accumulated over a whole turn it is a hundred tool names and no information; the
// question it answers is "what was it doing when it ran out of steps", and the answer
// has to be the last step.
func TestStepLimitNamesOnlyTheLastStepTools(t *testing.T) {
	script := []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		toolCallResponse("c2", "edit_file", `{"path":"b.txt","old_string":"x","new_string":"y"}`),
		toolCallResponse("c3", "read_file", `{"path":"c.txt"}`),
	}
	chat := &fakeModel{script: script}
	harness := newHarness(t, chat, security.AlwaysAllow)
	// MaxSteps is 4 in the harness; the script runs out before that, so set it low
	// enough that the limit is what ends the turn.
	harness.agent.MaxSteps = 3

	_, err := harness.agent.Run("go")
	limit, ok := err.(*StepLimitExceeded)
	if !ok {
		t.Fatalf("err = %v, want StepLimitExceeded", err)
	}
	if len(limit.Tools) != 1 || limit.Tools[0] != "read_file" {
		t.Errorf("Tools = %v, want only the last step's [read_file]", limit.Tools)
	}
}
