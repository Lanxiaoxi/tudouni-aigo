package agent

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// TestABatchThatRanTogetherIsMarkedOnItsResults is the field the audit's timing reads
// and never saw.
//
// A parallel batch's per-call durations overlap: the sum is "how long each tool took",
// while the batch's own wall time is "how long the batch occupied the turn". The summary
// adds the wall time and subtracts the marked results to get the tool time, and computes
// "how much did running together save" as the difference — so with nothing ever marked,
// the per-call durations were counted as serial work *and* the wall time was added on
// top, and the saving came out negative on every batch, which is why the "saved" section
// never appeared in `--audit`.
//
// The field cannot be written where the call is reported: whether a batch runs together
// is decided by the last call inspected, and the call event is written before that. It
// belongs on the result, which is what this checks end to end.
func TestABatchThatRanTogetherIsMarkedOnItsResults(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{
			{ID: "call_1", Name: "read_file", Arguments: `{"path":"a.txt"}`},
			{ID: "call_2", Name: "read_file", Arguments: `{"path":"b.txt"}`},
		}},
		textResponse("read both"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("read both"); err != nil {
		t.Fatal(err)
	}

	marked, unmarked := 0, 0
	for _, event := range h.events {
		if kind, _ := event["kind"].(string); kind != "tool_result" {
			continue
		}
		if flag, _ := event["parallel"].(bool); flag {
			marked++
		} else {
			unmarked++
		}
	}
	if marked != 2 || unmarked != 0 {
		t.Fatalf("%d results were marked parallel and %d were not; want both marked",
			marked, unmarked)
	}
}
