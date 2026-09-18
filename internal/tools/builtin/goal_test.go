package builtin

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// humanTurn builds a session whose turn in progress was started by a person: a
// real user message, then the assistant's call for a tool and that tool's result —
// the shape a goal tool actually runs inside.
func humanTurn() *state.Session {
	session := state.NewEmptySession("s")
	session.Messages = append(session.Messages,
		map[string]any{"role": "user", "content": "把重连修好，这个要跑好几轮"},
		map[string]any{"role": "assistant", "content": nil},
		map[string]any{"role": "tool", "tool_call_id": "c1", "content": "ok"},
	)
	return session
}

// autonomousTurn builds a session whose turn in progress is an automatic
// continuation: the round prompt is a user-role message the runtime wrote.
func autonomousTurn() *state.Session {
	goal := state.Goal{ID: "goal-1", Objective: "修好重连", Phase: state.PhaseActive, Revision: 1, MaxRounds: 5}
	session := state.NewEmptySession("s")
	session.Messages = append(session.Messages,
		map[string]any{"role": "user", "content": "把重连修好"},
		map[string]any{"role": "assistant", "content": "好"},
		state.GoalRoundPrompt(goal, 1),
		map[string]any{"role": "assistant", "content": nil},
		map[string]any{"role": "tool", "tool_call_id": "c1", "content": "ok"},
	)
	return session
}

func newTestBoard(session *state.Session) (*GoalBoard, *int) {
	commits := 0
	board := NewGoalBoard(session.Metadata, session, func() { commits++ })
	return board, &commits
}

func TestCreateGoalNeedsAPerson(t *testing.T) {
	board, commits := newTestBoard(autonomousTurn())
	result := board.Create(map[string]any{"objective": "修好重连"})

	if !strings.Contains(result.Text, "Only the user") {
		t.Errorf("an autonomous round created a goal:\n%s", result.Text)
	}
	if _, ok := state.LoadGoal(board.Metadata); ok {
		t.Fatal("the refused create still wrote a goal")
	}
	if *commits != 0 {
		t.Errorf("a refused create committed %d times", *commits)
	}
}

func TestCreateGoalThenReadItBack(t *testing.T) {
	session := humanTurn()
	board, commits := newTestBoard(session)

	created := board.Create(map[string]any{"objective": " 修好 websocket 重连 ", "max_goal_rounds": float64(12)})
	if !strings.Contains(created.Text, "修好 websocket 重连") {
		t.Errorf("the create answer does not name the objective:\n%s", created.Text)
	}
	if *commits != 1 {
		t.Errorf("a create committed %d times, want 1", *commits)
	}

	goal, ok := state.LoadGoal(session.Metadata)
	if !ok {
		t.Fatal("the goal is not in the session metadata")
	}
	if goal.Objective != "修好 websocket 重连" {
		t.Errorf("objective = %q, want the trimmed text", goal.Objective)
	}
	if goal.MaxRounds != 12 {
		t.Errorf("max rounds = %d, want 12", goal.MaxRounds)
	}

	// What the model reads must name the two numbers it has to copy back, or the
	// revision fence turns every later update into a guessing game.
	read := board.GetText()
	for _, want := range []string{"goal_id: " + goal.ID, "revision: 1", "phase: active", "rounds: 0/12"} {
		if !strings.Contains(read, want) {
			t.Errorf("get_goal output is missing %q:\n%s", want, read)
		}
	}
	if !strings.Contains(read, "started by the user") {
		t.Errorf("get_goal does not say which kind of turn this is:\n%s", read)
	}
}

func TestGetGoalWithNoGoalSaysSo(t *testing.T) {
	board, _ := newTestBoard(humanTurn())
	text := board.GetText()
	if !strings.Contains(text, "no goal") {
		t.Errorf("an empty session did not report having no goal:\n%s", text)
	}
}

// The revision fence is what makes "read get_goal first" more than etiquette: an
// update built on a stale read must be refused, and the refusal must hand back the
// current numbers so the next attempt can succeed.
func TestUpdateGoalRefusesAStaleRevision(t *testing.T) {
	session := humanTurn()
	board, _ := newTestBoard(session)
	board.Create(map[string]any{"objective": "第一版目标"})

	// A second change against revision 1 is fine and moves it to 2.
	first := board.Update(map[string]any{
		"goal_id": idOf(t, board), "revision": float64(1), "action": state.GoalOpEdit, "objective": "第二版目标",
	})
	if !strings.Contains(first.Text, "第二版目标") {
		t.Fatalf("the edit was refused:\n%s", first.Text)
	}

	stale := board.Update(map[string]any{
		"goal_id": idOf(t, board), "revision": float64(1), "action": state.GoalOpComplete,
	})
	if !strings.Contains(stale.Text, "not the current one") {
		t.Errorf("a stale complete was not refused for the right reason:\n%s", stale.Text)
	}
	if !strings.Contains(stale.Text, "revision: 2") {
		t.Errorf("the refusal did not hand back the current revision:\n%s", stale.Text)
	}
	if goal, _ := state.LoadGoal(session.Metadata); goal.Phase != state.PhaseActive {
		t.Errorf("the refused update still moved the phase to %q", goal.Phase)
	}
}

func TestUpdateGoalRejectsAnUnknownAction(t *testing.T) {
	session := humanTurn()
	board, _ := newTestBoard(session)
	board.Create(map[string]any{"objective": "目标"})

	result := board.Update(map[string]any{
		"goal_id": idOf(t, board), "revision": float64(1), "action": "rewind",
	})
	if !strings.Contains(result.Text, "Unknown action") {
		t.Errorf("an unknown action was not refused:\n%s", result.Text)
	}
}

// A round may end the goal — otherwise the loop could only ever stop by exhausting
// its budget — but it may not redefine or resume one.
func TestWhatAnAutonomousRoundMayDo(t *testing.T) {
	session := autonomousTurn()
	board, _ := newTestBoard(session)

	// A goal the round is working on already exists, so the round has something to
	// complete. Created directly because create_goal is confined to human turns.
	created, err := state.CreateGoal(session.Metadata, state.GoalSpec{Objective: "修好重连", MaxRounds: 5, ID: "goal-1"})
	if err != nil {
		t.Fatalf("seeding the goal: %v", err)
	}

	for _, action := range []string{state.GoalOpEdit, state.GoalOpPause, state.GoalOpResume} {
		result := board.Update(map[string]any{
			"goal_id": created.ID, "revision": float64(created.Revision), "action": action,
		})
		if !strings.Contains(result.Text, "Only the user") {
			t.Errorf("%s was allowed in an autonomous round:\n%s", action, result.Text)
		}
	}

	completed := board.Update(map[string]any{
		"goal_id": created.ID, "revision": float64(created.Revision), "action": state.GoalOpComplete,
	})
	if !strings.Contains(completed.Text, "marked complete") {
		t.Errorf("an autonomous round could not complete the goal:\n%s", completed.Text)
	}
	goal, _ := state.LoadGoal(session.Metadata)
	if goal.Phase != state.PhaseComplete {
		t.Errorf("phase = %q after complete", goal.Phase)
	}
}

func TestBlockedNeedsAReasonAndIsReported(t *testing.T) {
	session := autonomousTurn()
	board, _ := newTestBoard(session)
	created, err := state.CreateGoal(session.Metadata, state.GoalSpec{Objective: "修好重连", MaxRounds: 5, ID: "goal-1"})
	if err != nil {
		t.Fatalf("seeding the goal: %v", err)
	}

	missing := board.Update(map[string]any{
		"goal_id": created.ID, "revision": float64(created.Revision), "action": state.GoalOpBlock,
	})
	if !strings.Contains(missing.Text, "blocked_reason") {
		t.Errorf("a block without a reason was not refused:\n%s", missing.Text)
	}

	blocked := board.Update(map[string]any{
		"goal_id": created.ID, "revision": float64(created.Revision),
		"action": state.GoalOpBlock, "blocked_reason": "上游接口持续返回 500",
	})
	if !strings.Contains(blocked.Text, "上游接口持续返回 500") {
		t.Errorf("the blocker is missing from the answer:\n%s", blocked.Text)
	}
	// The reason has to persist in the block the payload tail renders from, or the
	// next session would show a blocked goal with nothing in it.
	text := state.GoalText(mustLoad(t, session.Metadata), state.ActivationDisarmed)
	if !strings.Contains(text, "上游接口持续返回 500") || !strings.Contains(text, "model-reported") {
		t.Errorf("the blocker is missing from the payload tail:\n%s", text)
	}
}

func TestSecondCreateIsRefusedNotOverwritten(t *testing.T) {
	session := humanTurn()
	board, _ := newTestBoard(session)
	board.Create(map[string]any{"objective": "第一个"})

	second := board.Create(map[string]any{"objective": "第二个"})
	if !strings.Contains(second.Text, "already has a goal") {
		t.Errorf("a second create was not refused:\n%s", second.Text)
	}
	if goal, _ := state.LoadGoal(session.Metadata); goal.Objective != "第一个" {
		t.Errorf("the refused create changed the objective to %q", goal.Objective)
	}
}

// The audit is how "how much did this goal get used" is answered later. A create
// that records nothing leaves that question with no answer at all.
func TestGoalChangesAreAudited(t *testing.T) {
	session := humanTurn()
	board, _ := newTestBoard(session)

	created := board.Create(map[string]any{"objective": "目标", "max_goal_rounds": float64(7)})
	if created.Audit["goal_present"] != true {
		t.Errorf("the create audit does not say a goal is present: %v", created.Audit)
	}
	if created.Audit["goal_phase"] != string(state.PhaseActive) {
		t.Errorf("the create audit has phase %v", created.Audit["goal_phase"])
	}
	if created.Audit["goal_max_rounds"] != 7 {
		t.Errorf("the create audit has max rounds %v", created.Audit["goal_max_rounds"])
	}
	if created.Audit["goal_revision"] != 1 {
		t.Errorf("the create audit has revision %v", created.Audit["goal_revision"])
	}

	read := board.GetText()
	if read == "" {
		t.Error("get_goal produced no text")
	}
	// A session with no goal says so rather than reporting an empty one, and its
	// audit fields say "no goal" rather than omitting the field — a reader that has
	// to treat "absent" and "false" differently will get it wrong once.
	empty := NewGoalBoard(map[string]any{}, humanTurn(), nil)
	if empty.auditFields()["goal_present"] != false {
		t.Error("a session with no goal reported one in its audit fields")
	}
}

// The three tools have to be registered together, and none of them may run
// concurrently: two goal changes in one batch would each act on a revision the
// other just moved.
func TestGoalToolsAreRegisteredAsASet(t *testing.T) {
	tools := NewGoalTools(map[string]any{}, humanTurn(), nil)
	names := map[string]bool{}
	for _, tool := range tools.All {
		names[tool.Name] = true
		if tool.ParallelSafe && tool.Name != "get_goal" {
			t.Errorf("%s is marked parallel safe, though it changes state", tool.Name)
		}
		if tool.Risk != security.RiskLow {
			t.Errorf("%s has risk %v, want low", tool.Name, tool.Risk)
		}
	}
	for _, want := range []string{"get_goal", "create_goal", "update_goal"} {
		if !names[want] {
			t.Errorf("%s is not registered", want)
		}
	}
	if tools.Board == nil {
		t.Error("NewGoalTools returned no board, so the runtime has nothing to render")
	}

	// get_goal is the exception on parallelism: it changes nothing, and a read
	// that has to wait behind a write it does not touch is a needless round trip.
	for _, tool := range tools.All {
		if tool.Name == "get_goal" && !tool.ParallelSafe {
			t.Error("get_goal is not marked parallel safe, though it only reads")
		}
	}
}

func TestGoalToolSchemasAreValid(t *testing.T) {
	tools := NewGoalTools(map[string]any{}, humanTurn(), nil)
	for _, tool := range tools.All {
		if tool.Schema == nil {
			t.Errorf("%s has no schema", tool.Name)
		}
		if tool.Handler == nil {
			t.Errorf("%s has no handler", tool.Name)
		}
		if strings.TrimSpace(tool.Description) == "" {
			t.Errorf("%s has no description, so the model has nothing to decide with", tool.Name)
		}
	}
	// The schema is what the model codes against, so the required fields are worth
	// asserting: a create without an objective and an update without a goal_id,
	// revision and action must not even be sendable.
	for _, tool := range tools.All {
		required := requiredOf(tool.Schema)
		switch tool.Name {
		case "create_goal":
			if len(required) != 1 || required[0] != "objective" {
				t.Errorf("create_goal requires %v", required)
			}
		case "update_goal":
			for _, want := range []string{"goal_id", "revision", "action"} {
				if !contains(required, want) {
					t.Errorf("update_goal does not require %s (requires %v)", want, required)
				}
			}
		}
	}
}

// requiredOf reads the required list out of a schema. ObjectSchema stores it as a
// []string, but the same schema round-trips through JSON on its way to a provider,
// so both shapes have to be readable — the test would otherwise pass against a
// schema that no longer matches what is sent.
func requiredOf(schema map[string]any) []string {
	switch raw := schema["required"].(type) {
	case []string:
		return raw
	case []any:
		out := make([]string, 0, len(raw))
		for _, entry := range raw {
			if text, ok := entry.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func idOf(t *testing.T, board *GoalBoard) string {
	t.Helper()
	goal, ok := state.LoadGoal(board.Metadata)
	if !ok {
		t.Fatal("no goal to read an id from")
	}
	return goal.ID
}

func mustLoad(t *testing.T, metadata map[string]any) state.Goal {
	t.Helper()
	goal, ok := state.LoadGoal(metadata)
	if !ok {
		t.Fatal("expected a goal in the metadata")
	}
	return goal
}
