package runtime

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// The payload tail is the only place the goal reaches the model on every round.
// The state package covers what the text says; what this test covers is the join —
// that a goal written into session metadata actually turns up in the tail, in front
// of the task list, and that a session without one is not charged for the feature.
func TestTheGoalReachesThePayloadTail(t *testing.T) {
	metadata := map[string]any{}
	session := state.NewEmptySession("s")
	session.Metadata = metadata

	if _, err := state.CreateGoal(metadata, state.GoalSpec{
		Objective: "把重连修好，并证明它修好了", MaxRounds: 9, ID: "goal-1",
	}); err != nil {
		t.Fatalf("CreateGoal: %v", err)
	}
	// A task list as well, so the ordering between the two is asserted rather
	// than assumed: the goal is what the plan is for, and it reads first.
	if result := builtin.NewTodoBoard(metadata).Write(map[string]any{
		"todos": []any{map[string]any{"content": "复现断连", "status": builtin.InProgress}},
	}); result.Text == "" {
		t.Fatal("the task list was not written")
	}

	runtimeValue := &Runtime{
		SessionIDValue: "s",
		SessionValue:   session,
		Goal:           builtin.NewGoalBoard(metadata, session, nil),
	}

	note := runtimeValue.notes()
	if !strings.Contains(note, "把重连修好，并证明它修好了") {
		t.Errorf("the goal is missing from the payload tail:\n%s", note)
	}
	if !strings.Contains(note, "0/9") {
		t.Errorf("the round budget is missing from the payload tail:\n%s", note)
	}
	if !strings.Contains(note, "当前任务") {
		t.Errorf("the task list is missing from the payload tail:\n%s", note)
	}
	if goalAt, listAt := strings.Index(note, "当前目标"), strings.Index(note, "当前任务"); goalAt < 0 || listAt < 0 || goalAt > listAt {
		t.Errorf("the goal does not come before the task list (goal at %d, list at %d):\n%s", goalAt, listAt, note)
	}
	// Nothing arms a goal in this build, and the tail has to say so rather than
	// let the model plan a next round that will never start.
	if !strings.Contains(note, "未启用") {
		t.Errorf("the tail does not report continuation as off:\n%s", note)
	}
}

func TestASessionWithoutAGoalPaysNothing(t *testing.T) {
	runtimeValue := &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: map[string]any{}},
		Goal:           builtin.NewGoalBoard(map[string]any{}, nil, nil),
	}
	if note := runtimeValue.notes(); strings.Contains(note, "当前目标") {
		t.Errorf("a session with no goal produced a goal block:\n%s", note)
	}
}

// A resumed session must never report the goal as armed, whatever else changes.
// This is the rule that keeps a reopened session from continuing work nobody
// currently at the keyboard asked for, so it is asserted on its own.
func TestAResumedSessionIsNeverArmed(t *testing.T) {
	armed := &Runtime{goalActivated: true, Resumed: false}
	if armed.activation() != state.ActivationArmed {
		t.Errorf("an explicitly armed session reported %q", armed.activation())
	}
	resumed := &Runtime{goalActivated: true, Resumed: true}
	if resumed.activation() != state.ActivationDisarmed {
		t.Errorf("a resumed session reported %q", resumed.activation())
	}
	// And the default, which is what this build can actually produce: no driver
	// arms anything yet.
	plain := &Runtime{}
	if plain.activation() != state.ActivationDisarmed {
		t.Errorf("a runtime with no driver reported %q", plain.activation())
	}
}
