package state

import (
	"encoding/json"
	"strings"
	"testing"
)

// newGoalMetadata builds a metadata map holding one goal, failing the test if the
// transition is refused. Every test below starts from a real block rather than a
// hand-written map, so a change to the stored shape cannot leave the tests
// passing against a shape nothing produces.
func newGoalMetadata(t *testing.T, objective string, maxRounds int) map[string]any {
	t.Helper()
	metadata := map[string]any{}
	if _, err := CreateGoal(metadata, GoalSpec{Objective: objective, MaxRounds: maxRounds, ID: "goal-1", Now: 100}); err != nil {
		t.Fatalf("CreateGoal: %v", err)
	}
	return metadata
}

func TestGoalRoundTripsThroughMetadata(t *testing.T) {
	metadata := newGoalMetadata(t, "修复 websocket 重连", 20)

	goal, ok := LoadGoal(metadata)
	if !ok {
		t.Fatal("LoadGoal found no goal after CreateGoal")
	}
	if goal.Objective != "修复 websocket 重连" {
		t.Errorf("objective = %q", goal.Objective)
	}
	if goal.Phase != PhaseActive {
		t.Errorf("phase = %q, want active", goal.Phase)
	}
	if goal.Revision != 1 {
		t.Errorf("revision = %d, want 1", goal.Revision)
	}
	if goal.MaxRounds != 20 || goal.Rounds != 0 {
		t.Errorf("rounds = %d/%d, want 0/20", goal.Rounds, goal.MaxRounds)
	}
	if goal.RoundLimitReached() {
		t.Error("a fresh goal reports its round limit as reached")
	}
}

// The block has to survive JSON, because that is the only way it ever reaches the
// disk: the session store encodes metadata as JSON into a `meta` record.
func TestGoalSurvivesJSON(t *testing.T) {
	metadata := newGoalMetadata(t, "ship the goal feature", 8)
	raw, err := json.Marshal(goalBlockOf(t, metadata))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	goal, ok := GoalFromBlock(decoded)
	if !ok {
		t.Fatal("GoalFromBlock refused a block it wrote itself")
	}
	if goal.Objective != "ship the goal feature" || goal.MaxRounds != 8 {
		t.Errorf("round trip changed the goal: %+v", goal)
	}
}

func goalBlockOf(t *testing.T, metadata map[string]any) any {
	t.Helper()
	block, ok := metadata[GoalKey]
	if !ok {
		t.Fatal("metadata has no goal block")
	}
	return block
}

// change performs one transition the way a caller must: read the goal, then act
// on the revision just read. Every test goes through this, so a test can never
// quietly pass by acting on a revision the goal no longer has.
func change(t *testing.T, metadata map[string]any, goalChange GoalChange) (Goal, error) {
	t.Helper()
	current, ok := LoadGoal(metadata)
	if !ok {
		t.Fatal("change: metadata has no goal")
	}
	return ApplyGoalChange(metadata, current.ID, current.Revision, goalChange)
}

// admit performs one round admission, read-then-act for the same reason.
func admit(t *testing.T, metadata map[string]any, round int) (Goal, error) {
	t.Helper()
	current, ok := LoadGoal(metadata)
	if !ok {
		t.Fatal("admit: metadata has no goal")
	}
	return AdmitGoalRound(metadata, current.ID, current.Revision, round)
}

// The whole reason the block carries a max is that the runtime must be able to
// refuse a goal that claims to have spent more rounds than it was given. Nothing
// legal produces it, so reading it as valid would hand the driver a state it can
// neither continue nor end.
func TestGoalRefusesMoreRoundsThanBudget(t *testing.T) {
	block := map[string]any{
		"version":    GoalBlockVersion,
		"id":         "goal-1",
		"objective":  "do the thing",
		"phase":      string(PhaseActive),
		"revision":   2,
		"max_rounds": 5,
		"rounds":     6,
	}
	if _, ok := GoalFromBlock(block); ok {
		t.Fatal("a goal with rounds above max_rounds was accepted")
	}
}

func TestGoalRefusesUnreadableBlocks(t *testing.T) {
	cases := map[string]any{
		"not a map":     "goal",
		"nil":           nil,
		"wrong version": map[string]any{"version": 99, "id": "g", "objective": "x", "phase": "active", "revision": 1, "max_rounds": 5},
		"no id":         map[string]any{"version": 1, "objective": "x", "phase": "active", "revision": 1, "max_rounds": 5},
		"blank objective": map[string]any{
			"version": 1, "id": "g", "objective": "   ", "phase": "active", "revision": 1, "max_rounds": 5,
		},
		"unknown phase": map[string]any{"version": 1, "id": "g", "objective": "x", "phase": "running", "revision": 1, "max_rounds": 5},
		"zero revision": map[string]any{"version": 1, "id": "g", "objective": "x", "phase": "active", "revision": 0, "max_rounds": 5},
		"no budget":     map[string]any{"version": 1, "id": "g", "objective": "x", "phase": "active", "revision": 1, "max_rounds": 0},
		"blocked without a reason": map[string]any{
			"version": 1, "id": "g", "objective": "x", "phase": "blocked", "revision": 1, "max_rounds": 5,
		},
		"reason left on an active goal": map[string]any{
			"version": 1, "id": "g", "objective": "x", "phase": "active", "revision": 1, "max_rounds": 5,
			"blocked_code": "model-reported", "blocked_text": "still stuck",
		},
	}
	for name, block := range cases {
		if _, ok := GoalFromBlock(block); ok {
			t.Errorf("%s: block was accepted", name)
		}
	}
}

func TestCreateGoalRefusesASecondGoal(t *testing.T) {
	metadata := newGoalMetadata(t, "first", 5)
	_, err := CreateGoal(metadata, GoalSpec{Objective: "second", Now: 200})
	code, ok := GoalErrorOf(err)
	if !ok || code != GoalErrExists {
		t.Fatalf("second create: err = %v, want %s", err, GoalErrExists)
	}
	goal, _ := LoadGoal(metadata)
	if goal.Objective != "first" {
		t.Errorf("the refused create changed the objective to %q", goal.Objective)
	}
}

// The round number is the loop's budget. If any operation could move it, the
// budget would be advisory, and "this goal gets N rounds" would be a claim the
// runtime cannot keep.
func TestOnlyRoundAdmissionMovesTheRoundCount(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 3)

	for _, goalChange := range []GoalChange{
		{Op: GoalOpEdit, Objective: "long task, restated"},
		{Op: GoalOpEdit, MaxRounds: 9},
		{Op: GoalOpPause},
		{Op: GoalOpResume},
		{Op: GoalOpBlock, BlockedText: "stuck"},
		{Op: GoalOpResume},
	} {
		if _, err := change(t, metadata, goalChange); err != nil {
			t.Fatalf("%s: %v", goalChange.Op, err)
		}
		if after, _ := LoadGoal(metadata); after.Rounds != 0 {
			t.Fatalf("%s moved rounds to %d", goalChange.Op, after.Rounds)
		}
	}

	if _, err := admit(t, metadata, 1); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	if after, _ := LoadGoal(metadata); after.Rounds != 1 {
		t.Fatalf("rounds = %d after one admitted round", after.Rounds)
	}
}

func TestRoundAdmissionRefusesStaleAndOutOfOrderRounds(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 3)
	goal, _ := LoadGoal(metadata)

	if _, err := admit(t, metadata, 2); err == nil {
		t.Error("round 2 was accepted before round 1")
	}
	// A reservation taken before some other change landed must be refused rather
	// than spent. `revision+7` stands in for "the goal moved after this was
	// reserved"; the point is that the read-then-act pair no longer agrees.
	if _, err := AdmitGoalRound(metadata, goal.ID, goal.Revision+7, 1); err == nil {
		t.Error("a reservation carrying a stale revision was accepted")
	}
	if _, err := AdmitGoalRound(metadata, "some-other-goal", goal.Revision, 1); err == nil {
		t.Error("a reservation for another goal id was accepted")
	}
	// A reservation that was admissible when it was taken, still holding the
	// revision from before an admission landed: refused, and it spends nothing.
	if _, err := admit(t, metadata, 1); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	if _, err := AdmitGoalRound(metadata, goal.ID, goal.Revision, 2); err == nil {
		t.Error("a reservation taken before an admission was accepted afterwards")
	}
	// None of the refusals above may have spent a number, so round 2 is next.
	if _, err := admit(t, metadata, 2); err != nil {
		t.Fatalf("round 2 after the refused reservations: %v", err)
	}
	if after, _ := LoadGoal(metadata); after.Rounds != 2 {
		t.Errorf("rounds = %d, want 2", after.Rounds)
	}
}

func TestRoundAdmissionStopsAtTheBudget(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 2)
	for round := 1; round <= 2; round++ {
		if _, err := admit(t, metadata, round); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
	}
	current, _ := LoadGoal(metadata)
	if !current.RoundLimitReached() {
		t.Fatalf("rounds = %d/%d, want the budget spent", current.Rounds, current.MaxRounds)
	}
	_, err := AdmitGoalRound(metadata, current.ID, current.Revision, 3)
	if code, ok := GoalErrorOf(err); !ok || code != GoalErrRoundLimit {
		t.Fatalf("round 3: err = %v, want %s", err, GoalErrRoundLimit)
	}
}

// A change designed against a goal that has since moved must be refused. This is
// the fence that makes "read, then write" safe across the two model round trips
// the goal tools require.
func TestStaleRevisionIsRefused(t *testing.T) {
	metadata := newGoalMetadata(t, "original", 10)
	goal, _ := LoadGoal(metadata)

	if _, err := change(t, metadata, GoalChange{Op: GoalOpEdit, Objective: "narrowed"}); err != nil {
		t.Fatalf("edit: %v", err)
	}
	_, err := ApplyGoalChange(metadata, goal.ID, goal.Revision, GoalChange{Op: GoalOpComplete})
	if code, ok := GoalErrorOf(err); !ok || code != GoalErrStale {
		t.Fatalf("stale complete: err = %v, want %s", err, GoalErrStale)
	}
	current, _ := LoadGoal(metadata)
	if current.Phase != PhaseActive {
		t.Errorf("the refused change still moved the phase to %q", current.Phase)
	}
	// A refusal must not consume a revision either.
	if current.Revision != 2 {
		t.Errorf("revision = %d, want 2 after one accepted edit", current.Revision)
	}
}

func TestPhaseTransitions(t *testing.T) {
	metadata := newGoalMetadata(t, "job", 10)

	goal, err := change(t, metadata, GoalChange{Op: GoalOpPause})
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if goal.Phase != PhasePaused {
		t.Fatalf("phase = %q after pause", goal.Phase)
	}
	if _, err := change(t, metadata, GoalChange{Op: GoalOpPause}); err == nil {
		t.Error("a paused goal was paused again")
	}
	if _, err := change(t, metadata, GoalChange{Op: GoalOpComplete}); err != nil {
		t.Errorf("a paused goal could not be completed: %v", err)
	}

	// Completion is terminal and idempotent: two rounds declaring the same
	// success is a normal outcome, not an error.
	completed, err := change(t, metadata, GoalChange{Op: GoalOpComplete})
	if err != nil {
		t.Fatalf("second complete: %v", err)
	}
	if completed.Phase != PhaseComplete {
		t.Fatalf("phase = %q", completed.Phase)
	}
	if _, err := change(t, metadata, GoalChange{Op: GoalOpResume}); err == nil {
		t.Error("a completed goal was resumed")
	}
	if _, err := change(t, metadata, GoalChange{Op: GoalOpEdit, Objective: "one more thing"}); err == nil {
		t.Error("a completed goal was edited")
	}
}

func TestBlockCarriesAReasonAndResumeClearsIt(t *testing.T) {
	metadata := newGoalMetadata(t, "job", 10)

	if _, err := change(t, metadata, GoalChange{Op: GoalOpBlock}); err == nil {
		t.Error("a block with no reason was accepted")
	}

	blocked, err := change(t, metadata, GoalChange{
		Op: GoalOpBlock, BlockedText: "  the upstream endpoint returns 500  ",
	})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	if blocked.Phase != PhaseBlocked {
		t.Fatalf("phase = %q", blocked.Phase)
	}
	if blocked.BlockedCode != BlockCodeModelReported {
		t.Errorf("blocked code = %q, want %s", blocked.BlockedCode, BlockCodeModelReported)
	}
	if blocked.BlockedText != "the upstream endpoint returns 500" {
		t.Errorf("blocked text was not normalised: %q", blocked.BlockedText)
	}

	if _, err := change(t, metadata, GoalChange{
		Op: GoalOpBlock, BlockedCode: "Not Kebab", BlockedText: "x",
	}); err == nil {
		t.Error("a blocker code outside lower kebab case was accepted")
	}

	resumed, err := change(t, metadata, GoalChange{Op: GoalOpResume})
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if resumed.Phase != PhaseActive {
		t.Fatalf("phase = %q after resume", resumed.Phase)
	}
	if resumed.BlockedCode != "" || resumed.BlockedText != "" {
		t.Errorf("resume left the blocker behind: %q / %q", resumed.BlockedCode, resumed.BlockedText)
	}
	// The cleared block must still be readable: a stale reason on an active goal
	// is refused by the reader, so a resume that forgot to clear it would turn
	// the session into "no goal".
	if _, ok := LoadGoal(metadata); !ok {
		t.Fatal("the goal became unreadable after resume")
	}
}

func TestEditCannotCutBelowSpentRounds(t *testing.T) {
	metadata := newGoalMetadata(t, "job", 10)
	if _, err := admit(t, metadata, 1); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	if _, err := change(t, metadata, GoalChange{Op: GoalOpEdit, MaxRounds: 1}); err != nil {
		t.Fatalf("max_rounds equal to the rounds spent must be legal: %v", err)
	}
	// Raising the budget is the documented way to keep going after exhaustion.
	raised, err := change(t, metadata, GoalChange{Op: GoalOpEdit, MaxRounds: 40})
	if err != nil {
		t.Fatalf("raising the budget: %v", err)
	}
	if raised.MaxRounds != 40 {
		t.Errorf("max rounds = %d, want 40", raised.MaxRounds)
	}

	// Below what has already been spent is refused: it would produce a goal that
	// the reader rejects outright, i.e. a session that suddenly has no goal.
	// (Tested against a goal with room, so the refusal is about the edit and not
	// about the budget being full.)
	fresh := newGoalMetadata(t, "job", 10)
	if _, err := admit(t, fresh, 1); err != nil {
		t.Fatalf("fresh round 1: %v", err)
	}
	if _, err := admit(t, fresh, 2); err != nil {
		t.Fatalf("fresh round 2: %v", err)
	}
	_, err = change(t, fresh, GoalChange{Op: GoalOpEdit, MaxRounds: 1})
	if code, ok := GoalErrorOf(err); !ok || code != GoalErrInvalidEdit {
		t.Errorf("edit below the rounds spent: err = %v, want %s", err, GoalErrInvalidEdit)
	}
	if after, ok := LoadGoal(fresh); !ok || after.MaxRounds != 10 {
		t.Errorf("the refused edit changed the budget: %+v", after)
	}
}

func TestMaxRoundsDefaultsAndCeiling(t *testing.T) {
	if got, err := ResolveMaxRounds(0); err != nil || got != DefaultMaxGoalRounds {
		t.Errorf("default = %d (%v), want %d", got, err, DefaultMaxGoalRounds)
	}
	if _, err := ResolveMaxRounds(-1); err == nil {
		t.Error("a negative budget was accepted")
	}
	if _, err := ResolveMaxRounds(1); err != nil {
		t.Errorf("a budget of one was refused: %v", err)
	}
	if _, err := ResolveMaxRounds(MaxGoalRoundsCeiling); err != nil {
		t.Errorf("the ceiling itself was refused: %v", err)
	}
	if _, err := ResolveMaxRounds(MaxGoalRoundsCeiling + 1); err == nil {
		t.Error("a budget above the ceiling was accepted")
	}
}

func TestObjectiveIsRequiredAndBounded(t *testing.T) {
	metadata := map[string]any{}
	if _, err := CreateGoal(metadata, GoalSpec{Objective: "   "}); err == nil {
		t.Error("a blank objective was accepted")
	}
	if _, err := CreateGoal(metadata, GoalSpec{Objective: strings.Repeat("x", ObjectiveCeiling+1)}); err == nil {
		t.Error("an objective above the ceiling was accepted")
	}
	if _, err := CreateGoal(metadata, GoalSpec{Objective: strings.Repeat("x", ObjectiveCeiling)}); err != nil {
		t.Errorf("an objective exactly at the ceiling was refused: %v", err)
	}
}

func TestObjectiveIsNormalised(t *testing.T) {
	metadata := map[string]any{}
	goal, err := CreateGoal(metadata, GoalSpec{Objective: "  fix the reconnect bug\n", ID: "goal-1"})
	if err != nil {
		t.Fatalf("CreateGoal: %v", err)
	}
	if goal.Objective != "fix the reconnect bug" {
		t.Errorf("objective = %q, want the trimmed text", goal.Objective)
	}
}

// Who may do what is the difference between the model steering the loop and the
// model driving it. A model that can resume can undo a pause by asking nicely.
func TestOperationsBelongToAPersonOrToTheLoop(t *testing.T) {
	humanOnly := []string{GoalOpCreate, GoalOpEdit, GoalOpPause, GoalOpResume}
	for _, op := range humanOnly {
		if AuthorizedBy(op, false) {
			t.Errorf("%s was authorized for a non-human turn", op)
		}
		if !AuthorizedBy(op, true) {
			t.Errorf("%s was refused for a human turn", op)
		}
	}
	// Ending the goal has to be available inside a round, or the loop could only
	// ever stop by exhausting its budget.
	for _, op := range []string{GoalOpComplete, GoalOpBlock} {
		if !AuthorizedBy(op, false) {
			t.Errorf("%s was refused inside a goal round", op)
		}
	}
	if AuthorizedBy("delete_everything", true) {
		t.Error("an unknown operation was authorized")
	}
}

// The activation is the one thing that must not come back from a file. If it did,
// reopening a session would hand this process an authorization the person gave a
// previous one.
func TestActivationIsNotInTheStoredBlock(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	block, ok := metadata[GoalKey].(map[string]any)
	if !ok {
		t.Fatalf("goal block has type %T", metadata[GoalKey])
	}
	for _, key := range []string{"activation", "armed", "disarmed"} {
		if _, present := block[key]; present {
			t.Errorf("the stored block carries %q; authorization must stay at run time", key)
		}
	}
}

func TestGoalTextCarriesTheBudgetAndTheDisarmedWarning(t *testing.T) {
	metadata := newGoalMetadata(t, "修复 websocket 重连", 20)
	if _, err := admit(t, metadata, 1); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	goal, _ := LoadGoal(metadata)

	armed := GoalText(goal, ActivationArmed)
	if !strings.Contains(armed, "修复 websocket 重连") {
		t.Error("the objective is missing from the payload tail")
	}
	if !strings.Contains(armed, "1/20") {
		t.Errorf("the round budget is missing from the payload tail:\n%s", armed)
	}
	if strings.Contains(armed, "未启用") {
		t.Error("an armed goal warned about continuation being off")
	}

	disarmed := GoalText(goal, ActivationDisarmed)
	if !strings.Contains(disarmed, "未启用") {
		t.Errorf("a disarmed goal did not say so:\n%s", disarmed)
	}
}

func TestGoalRoundPromptIsARuntimeNote(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	goal, _ := LoadGoal(metadata)

	message := GoalRoundPrompt(goal, 2)
	if message["role"] != "user" {
		t.Errorf("role = %v, want user", message["role"])
	}
	if !IsGoalRound(message) {
		t.Error("the round prompt is not marked as a goal round")
	}
	// The marker has to be the one UserInputs already respects, or a resumed
	// session would report the runtime's own prompt as something the user asked.
	if !isRuntimeNote(message) {
		t.Error("the round prompt is not marked as a runtime note")
	}

	text, _ := MessageText(message)
	if !strings.Contains(text, "2/5") {
		t.Errorf("the round number is missing:\n%s", text)
	}
	if !strings.Contains(text, "长") && !strings.Contains(text, "long task") {
		t.Errorf("the objective is missing:\n%s", text)
	}

	// And it must not show up as a human input.
	session := NewEmptySession("s")
	session.Messages = append(session.Messages, message)
	if inputs := session.UserInputs(); len(inputs) != 0 {
		t.Errorf("UserInputs returned %d entries for a round prompt: %v", len(inputs), inputs)
	}
}

func TestBlockedGoalTextNamesTheBlocker(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	current, _ := LoadGoal(metadata)
	blocked, err := ApplyGoalChange(metadata, current.ID, current.Revision, GoalChange{
		Op: GoalOpBlock, BlockedCode: "round-limit", BlockedText: "轮次用尽",
	})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	text := GoalText(blocked, ActivationDisarmed)
	if !strings.Contains(text, "round-limit") || !strings.Contains(text, "轮次用尽") {
		t.Errorf("the blocker is missing from the payload tail:\n%s", text)
	}
}

func TestClearGoal(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	ClearGoal(metadata)
	if _, ok := LoadGoal(metadata); ok {
		t.Fatal("the goal survived ClearGoal")
	}
	// A cleared goal is not the same as one that never existed.
	fold := FoldGoal(metadata)
	if fold.Seen || fold.Current != nil {
		t.Errorf("fold = %+v, want an empty fold", fold)
	}
}

// IsHumanTurn decides whether the goal tools will accept a change from a person,
// so it is the one function here whose mistakes grant authority rather than refuse
// it. Every message shape a turn can actually have is covered below.
func TestIsHumanTurn(t *testing.T) {
	goal := Goal{ID: "goal-1", Objective: "job", Phase: PhaseActive, Revision: 1, MaxRounds: 5}
	round := GoalRoundPrompt(goal, 1)
	user := map[string]any{"role": "user", "content": "修好重连"}
	assistant := map[string]any{"role": "assistant", "content": "好"}
	call := map[string]any{"role": "assistant", "content": nil}
	result := map[string]any{"role": "tool", "tool_call_id": "c1", "content": "ok"}
	modelNote := ChangeNotice("", "deepseek-flash")

	cases := []struct {
		name     string
		messages []map[string]any
		want     bool
	}{
		{"empty history", nil, false},
		{"the user asked", []map[string]any{user}, true},
		// The realistic shape of a goal tool call: the user asked, the model
		// narrated, called, and is about to call again — the turn is still theirs.
		{"mid-turn after tools", []map[string]any{user, assistant, call, result, call, result}, true},
		{"a goal round", []map[string]any{user, assistant, round, call, result}, false},
		{"a goal round on its own", []map[string]any{round}, false},
		// A model change notice is the runtime speaking too, and it opens the turn,
		// so nothing human has been said in it.
		{"a model change notice", []map[string]any{modelNote, call, result}, false},
		// System-only, and a session whose last word was the assistant's answer.
		{"system only", []map[string]any{{"role": "system", "content": "prompt"}}, false},
		{"last word was the assistant", []map[string]any{user, assistant}, true},
	}
	for _, testCase := range cases {
		session := NewEmptySession("s")
		session.Messages = append(session.Messages, testCase.messages...)
		if got := session.IsHumanTurn(); got != testCase.want {
			t.Errorf("%s: IsHumanTurn = %v, want %v", testCase.name, got, testCase.want)
		}
	}
}

// --- the commands a person gives --------------------------------------------

func TestGoalActionOnlyAcceptsTheThreeCommands(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	for _, action := range []string{"stop", "delete", "complete", ""} {
		if _, err := GoalAction(metadata, action, 0); err == nil {
			t.Errorf("action %q was accepted", action)
		}
	}
	// A refused action must not have touched anything.
	if _, ok := LoadGoal(metadata); !ok {
		t.Fatal("a refused action removed the goal")
	}
}

func TestGoalActionClearRemovesIt(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	snapshot, err := GoalAction(metadata, GoalActionClear, 0)
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, ok := LoadGoal(metadata); ok {
		t.Fatal("the goal survived a clear")
	}
	// The answer is the empty shape, not nil: a panel has one case to draw.
	if objective, _ := snapshot["objective"].(string); objective != "" {
		t.Errorf("the clear snapshot still names an objective: %v", snapshot)
	}
	if armed, _ := snapshot["armed"].(bool); armed {
		t.Error("the clear snapshot reports the goal as armed")
	}
}

func TestGoalActionPauseStopsAnActiveGoal(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	snapshot, err := GoalAction(metadata, GoalActionPause, 0)
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if snapshot["phase"] != string(PhasePaused) {
		t.Errorf("phase = %v, want paused", snapshot["phase"])
	}
	// The command disarms by virtue of what it returns; the caller does the
	// arming. What matters here is that the goal is genuinely paused, so a
	// resumed runtime cannot pick it up.
	if goal, _ := LoadGoal(metadata); goal.Phase != PhasePaused {
		t.Errorf("the stored phase is %q", goal.Phase)
	}
}

// Pausing a blocked goal must not throw the reason away: the person asked for it to
// stop, not for the explanation to be deleted.
func TestGoalActionPauseKeepsABlocker(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	current, _ := LoadGoal(metadata)
	if _, err := ApplyGoalChange(metadata, current.ID, current.Revision,
		GoalChange{Op: GoalOpBlock, BlockedText: "上游持续 500"}); err != nil {
		t.Fatalf("block: %v", err)
	}
	snapshot, err := GoalAction(metadata, GoalActionPause, 0)
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if snapshot["phase"] != string(PhaseBlocked) {
		t.Errorf("phase = %v, want the block to survive a pause", snapshot["phase"])
	}
	if message, _ := snapshot["blocked_message"].(string); message != "上游持续 500" {
		t.Errorf("the blocker was dropped: %v", snapshot)
	}
}

func TestGoalActionResumeFromPausedAndBlocked(t *testing.T) {
	for _, start := range []GoalChange{
		{Op: GoalOpPause},
		{Op: GoalOpBlock, BlockedText: "卡住了"},
	} {
		metadata := newGoalMetadata(t, "long task", 5)
		if _, err := change(t, metadata, start); err != nil {
			t.Fatalf("%s: %v", start.Op, err)
		}
		snapshot, err := GoalAction(metadata, GoalActionResume, 0)
		if err != nil {
			t.Fatalf("resume from %s: %v", start.Op, err)
		}
		if snapshot["phase"] != string(PhaseActive) {
			t.Errorf("resume from %s left phase %v", start.Op, snapshot["phase"])
		}
		// The snapshot says the goal is armed, which is the command's claim; the
		// runtime is what actually arms the process.
		if armed, _ := snapshot["armed"].(bool); !armed {
			t.Errorf("resume from %s did not report the goal as armed", start.Op)
		}
	}
}

// A completed goal is finished. Reopening one would make the completion report a
// lie, and "keep going after this" is a new goal with a new objective.
func TestGoalActionRefusesToResumeACompletedGoal(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 5)
	if _, err := change(t, metadata, GoalChange{Op: GoalOpComplete}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if _, err := GoalAction(metadata, GoalActionResume, 0); err == nil {
		t.Fatal("a completed goal was resumed")
	}
	if goal, _ := LoadGoal(metadata); goal.Phase != PhaseComplete {
		t.Errorf("the refused resume changed the phase to %q", goal.Phase)
	}
}

func TestGoalActionWithoutAGoalIsNotAnError(t *testing.T) {
	metadata := map[string]any{}
	for _, action := range []string{GoalActionPause, GoalActionResume, GoalActionClear} {
		snapshot, err := GoalAction(metadata, action, 0)
		if err != nil {
			t.Errorf("%s on a session with no goal: %v", action, err)
		}
		if objective, _ := snapshot["objective"].(string); objective != "" {
			t.Errorf("%s reported a goal: %v", action, snapshot)
		}
	}
}

// The snapshot is the wire shape, and it must carry `armed` separately from the
// phase — that difference is the whole reason a person needs a panel at all.
func TestGoalSnapshotSeparatesArmingFromThePhase(t *testing.T) {
	metadata := newGoalMetadata(t, "long task", 7)
	goal, _ := LoadGoal(metadata)

	armed := GoalSnapshot(goal, ActivationArmed)
	if armed["phase"] != string(PhaseActive) {
		t.Errorf("phase = %v", armed["phase"])
	}
	if armed["armed"] != true {
		t.Error("an armed snapshot does not say so")
	}
	if armed["rounds_text"] != "0/7" {
		t.Errorf("rounds_text = %v", armed["rounds_text"])
	}

	disarmed := GoalSnapshot(goal, ActivationDisarmed)
	if disarmed["phase"] != string(PhaseActive) {
		t.Errorf("phase = %v", disarmed["phase"])
	}
	if disarmed["armed"] != false {
		t.Error("a disarmed snapshot claims to be armed")
	}
	// The same goal, two verdicts, and only the field under test differs.
	if disarmed["objective"] != armed["objective"] || disarmed["id"] != armed["id"] {
		t.Error("the two snapshots describe different goals")
	}
}
