package runtime

import (
	"errors"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// driverRuntime builds the smallest runtime the driver touches: a session with
// metadata, and nothing else. Everything the driver needs is session state plus the
// armed flag, and keeping the fixture that small is the point — a driver that
// needed a model, a tool registry or a context manager to make its decision would
// not be a scheduler, it would be a second turn runner.
func driverRuntime(t *testing.T, phase state.Phase, rounds, maxRounds int, armed bool) *Runtime {
	t.Helper()
	session := state.NewEmptySession("s")
	session.Messages = append(session.Messages, map[string]any{"role": "system", "content": "prompt"})
	return runtimeOver(t, session, phase, rounds, maxRounds, armed)
}

// runtimeOver is driverRuntime for a caller that built its own session — which the
// arming tests have to do, because what they vary is the message history.
func runtimeOver(t *testing.T, session *state.Session, phase state.Phase, rounds, maxRounds int, armed bool) *Runtime {
	t.Helper()

	if _, err := state.CreateGoal(session.Metadata, state.GoalSpec{
		Objective: "把重连修好，并证明它修好了", MaxRounds: maxRounds, ID: "goal-1", Now: 100,
	}); err != nil {
		t.Fatalf("CreateGoal: %v", err)
	}
	for round := 1; round <= rounds; round++ {
		current, _ := state.LoadGoal(session.Metadata)
		if _, err := state.AdmitGoalRound(session.Metadata, current.ID, current.Revision, round); err != nil {
			t.Fatalf("seeding round %d: %v", round, err)
		}
	}
	if phase != state.PhaseActive {
		current, _ := state.LoadGoal(session.Metadata)
		change := state.GoalChange{Op: state.GoalOpPause}
		switch phase {
		case state.PhaseComplete:
			change = state.GoalChange{Op: state.GoalOpComplete}
		case state.PhaseBlocked:
			change = state.GoalChange{Op: state.GoalOpBlock, BlockedText: "上游持续 500"}
		}
		if _, err := state.ApplyGoalChange(session.Metadata, current.ID, current.Revision, change); err != nil {
			t.Fatalf("moving to %s: %v", phase, err)
		}
	}

	runtimeValue := &Runtime{SessionIDValue: "s", SessionValue: session}
	runtimeValue.Driver = NewDriver(runtimeValue)
	if armed {
		runtimeValue.SetGoalArmed(true)
	}
	return runtimeValue
}

// recordingQueue captures what the driver asked to have run.
type recordingQueue struct {
	rounds []*Reservation
	refuse bool
}

func (q *recordingQueue) queue(round protocol.GoalRound) bool {
	if q.refuse {
		return false
	}
	reservation, ok := round.(*Reservation)
	if !ok {
		return false
	}
	q.rounds = append(q.rounds, reservation)
	return true
}

func TestDriverContinuesAnArmedActiveGoal(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 3, true)
	queue := &recordingQueue{}

	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionContinue) {
		t.Fatalf("decision = %q, want continue", decision)
	}
	if len(queue.rounds) != 1 {
		t.Fatalf("queued %d rounds, want 1", len(queue.rounds))
	}
	reservation := queue.rounds[0]
	if reservation.Round() != 1 {
		t.Errorf("round = %d, want 1", reservation.Round())
	}
	if reservation.GoalID() != "goal-1" {
		t.Errorf("goal id = %q", reservation.GoalID())
	}
	// The prompt has to be the runtime's own text, marked, or the next turn reads
	// it as something the user said.
	messages := reservation.Messages()
	if len(messages) != 1 || !state.IsGoalRound(messages[0]) {
		t.Fatalf("the reserved prompt is not a goal round message: %#v", messages)
	}
	text, _ := state.MessageText(messages[0])
	if !strings.Contains(text, "1/3") || !strings.Contains(text, "把重连修好") {
		t.Errorf("the prompt does not carry the goal and the round:\n%s", text)
	}

	// Reserving must not spend. The number is spent at admission, and only then.
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("reserving spent a round: %d/%d", goal.Rounds, goal.MaxRounds)
	}
}

func TestDriverRefusesTheStatesThatMustNotContinue(t *testing.T) {
	cases := []struct {
		name      string
		phase     state.Phase
		rounds    int
		maxRounds int
		armed     bool
		want      Decision
	}{
		{"paused", state.PhasePaused, 0, 5, true, DecisionRefused},
		{"completed", state.PhaseComplete, 0, 5, true, DecisionIdle},
		{"blocked", state.PhaseBlocked, 0, 5, true, DecisionIdle},
		{"round budget spent", state.PhaseActive, 3, 3, true, DecisionRefused},
		{"not armed", state.PhaseActive, 0, 5, false, DecisionRefused},
	}
	for _, testCase := range cases {
		runtimeValue := driverRuntime(t, testCase.phase, testCase.rounds, testCase.maxRounds, testCase.armed)
		queue := &recordingQueue{}
		decision := runtimeValue.ObserveTurn(nil, false, queue.queue)
		if decision != string(testCase.want) {
			t.Errorf("%s: decision = %q, want %q", testCase.name, decision, testCase.want)
		}
		if len(queue.rounds) != 0 {
			t.Errorf("%s: queued %d rounds, want none", testCase.name, len(queue.rounds))
		}
		// Whatever the outcome, a goal that is not continuing must not still be
		// reported as armed: the payload tail would tell the model to expect
		// another round that is never coming.
		if runtimeValue.GoalArmed() {
			t.Errorf("%s: the goal is still armed after the driver refused", testCase.name)
		}
	}
}

func TestDriverDisarmsOnAStopRequest(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 9, true)
	queue := &recordingQueue{}

	decision := runtimeValue.ObserveTurn(nil, true, queue.queue)
	if decision != string(DecisionRefused) {
		t.Fatalf("decision = %q, want refused", decision)
	}
	if len(queue.rounds) != 0 {
		t.Errorf("a stop still queued %d rounds", len(queue.rounds))
	}
	if runtimeValue.GoalArmed() {
		t.Error("a stop request left the goal armed")
	}
	// And the goal itself is untouched: stopping is not pausing. A person who
	// interrupts to say something else must find the goal still there.
	goal, ok := state.LoadGoal(runtimeValue.SessionValue.Metadata)
	if !ok || goal.Phase != state.PhaseActive {
		t.Errorf("a stop changed the goal: %+v", goal)
	}
}

func TestDriverDisarmsOnAFailedTurn(t *testing.T) {
	for _, testCase := range []struct {
		name string
		err  error
	}{
		{"cancelled", agent.RunCancelled{}},
		{"model failed", errors.New("502 from the gateway")},
	} {
		runtimeValue := driverRuntime(t, state.PhaseActive, 0, 9, true)
		queue := &recordingQueue{}
		decision := runtimeValue.ObserveTurn(testCase.err, false, queue.queue)
		if decision != string(DecisionRefused) {
			t.Errorf("%s: decision = %q, want refused", testCase.name, decision)
		}
		if len(queue.rounds) != 0 {
			t.Errorf("%s: queued %d rounds after a failed turn", testCase.name, len(queue.rounds))
		}
		if runtimeValue.GoalArmed() {
			t.Errorf("%s: a failed turn left the goal armed", testCase.name)
		}
	}
}

// Running out of steps is the one outcome that is not a failure. It is exactly
// what a long task does, and treating it as a reason to stop would make the round
// budget unreachable — the goal would die on the first turn that hit the step cap.
func TestDriverContinuesAfterAStepLimit(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 9, true)
	queue := &recordingQueue{}

	decision := runtimeValue.ObserveTurn(&agent.StepLimitExceeded{Step: 120, Tools: []string{"shell"}}, false, queue.queue)
	if decision != string(DecisionContinue) {
		t.Fatalf("decision = %q, want continue", decision)
	}
	if len(queue.rounds) != 1 {
		t.Fatalf("queued %d rounds, want 1", len(queue.rounds))
	}
	if !runtimeValue.GoalArmed() {
		t.Error("a step limit disarmed the goal")
	}
}

// A turn a person started is where the authorization comes from, so the goal keeps
// running after it. This is the case that makes the feature work: the model creates
// the goal while answering a person, and the very next thing that happens is the
// first round.
func TestDriverContinuesAfterAHumanTurn(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 9, true)
	runtimeValue.SessionValue.Messages = append(runtimeValue.SessionValue.Messages,
		map[string]any{"role": "user", "content": "顺便把这个也改一下"})
	queue := &recordingQueue{}

	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionContinue) {
		t.Fatalf("decision = %q, want continue", decision)
	}
	if len(queue.rounds) != 1 {
		t.Errorf("queued %d rounds after a human turn, want 1", len(queue.rounds))
	}
	if !runtimeValue.GoalArmed() {
		t.Error("a human turn disarmed the goal")
	}
}

// The other half of that rule: one authorization produces one round. A round that
// has just finished must not start another, or a single arming would spend the whole
// budget back to back with nobody watching.
func TestADriverDoesNotChainAutomaticRounds(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 1, 9, true)
	goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata)
	// The turn that just finished was an automatic round.
	runtimeValue.SessionValue.Messages = append(runtimeValue.SessionValue.Messages,
		state.GoalRoundPrompt(goal, 1))
	queue := &recordingQueue{}

	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionRefused) {
		t.Fatalf("decision = %q, want refused", decision)
	}
	if len(queue.rounds) != 0 {
		t.Errorf("queued %d rounds straight after a round, want none", len(queue.rounds))
	}
	if runtimeValue.GoalArmed() {
		t.Error("the goal stayed armed after an automatic round")
	}
}

func TestDriverDropsTheReservationWhenNothingTakesIt(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)
	queue := &recordingQueue{refuse: true}

	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionRefused) {
		t.Fatalf("decision = %q, want refused", decision)
	}
	if runtimeValue.Driver.Pending() != nil {
		t.Error("a reservation nobody took is still pending")
	}
	// The number must be free again: nothing ran, so nothing was spent.
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("a dropped reservation spent a round: %d", goal.Rounds)
	}
}

func TestAdmissionSpendsTheRoundAndMovesTheRevision(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)
	queue := &recordingQueue{}
	runtimeValue.ObserveTurn(nil, false, queue.queue)

	reservation := queue.rounds[0]
	before, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata)

	if !runtimeValue.Driver.Admit(reservation) {
		t.Fatal("the reservation was refused")
	}
	after, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata)
	if after.Rounds != 1 {
		t.Errorf("rounds = %d, want 1", after.Rounds)
	}
	if after.Revision != before.Revision+1 {
		t.Errorf("revision = %d, want %d — admission must invalidate later reservations",
			after.Revision, before.Revision+1)
	}
	if runtimeValue.Driver.Pending() != nil {
		t.Error("the reservation is still pending after admission")
	}
	if runtimeValue.Driver.Admit(reservation) {
		t.Error("the same reservation was admitted twice")
	}
}

// The point of reserving before running: between the driver's claim and the round's
// start, a person may have edited or paused the goal. Admission has to notice, and
// notice without spending anything.
func TestAdmissionRefusesAStaleReservation(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)
	queue := &recordingQueue{}
	runtimeValue.ObserveTurn(nil, false, queue.queue)
	reservation := queue.rounds[0]

	// The user redefines the goal in between.
	current, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata)
	if _, err := state.ApplyGoalChange(runtimeValue.SessionValue.Metadata, current.ID, current.Revision,
		state.GoalChange{Op: state.GoalOpEdit, Objective: "其实是另一个问题"}); err != nil {
		t.Fatalf("edit: %v", err)
	}

	if runtimeValue.Driver.Admit(reservation) {
		t.Fatal("a reservation for a goal that moved was admitted")
	}
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("a refused admission spent a round: %d", goal.Rounds)
	}
	if runtimeValue.Driver.Pending() != nil {
		t.Error("a refused admission left the reservation pending")
	}
}

func TestAdmissionRefusesAPausedGoal(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)
	queue := &recordingQueue{}
	runtimeValue.ObserveTurn(nil, false, queue.queue)
	reservation := queue.rounds[0]

	runtimeValue.SetGoalArmed(false)
	if runtimeValue.Driver.Admit(reservation) {
		t.Fatal("a reservation was admitted while the goal was disarmed")
	}
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("a refused admission spent a round: %d", goal.Rounds)
	}
}

// A round with no budget left must not be admitted even if a reservation exists:
// the budget is the bound on what a goal may cost, and it is checked at both ends.
func TestAdmissionRefusesAnExhaustedBudget(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 1, true)
	queue := &recordingQueue{}
	runtimeValue.ObserveTurn(nil, false, queue.queue)
	reservation := queue.rounds[0]

	// Something else spends the last round first.
	current, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata)
	if _, err := state.AdmitGoalRound(runtimeValue.SessionValue.Metadata, current.ID, current.Revision, 1); err != nil {
		t.Fatalf("spending the budget: %v", err)
	}
	if runtimeValue.Driver.Admit(reservation) {
		t.Fatal("a reservation was admitted with no budget left")
	}
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 1 {
		t.Errorf("rounds = %d, want the budget to stay at 1", goal.Rounds)
	}
}

// The one rule that must not depend on anything else: a session loaded from disk
// never continues on its own, whatever the goal block says.
func TestAResumedRuntimeCannotBeArmed(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, false)
	runtimeValue.Resumed = true
	runtimeValue.SetGoalArmed(true)

	if runtimeValue.GoalArmed() {
		t.Fatal("a resumed runtime armed itself")
	}
	queue := &recordingQueue{}
	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision == string(DecisionContinue) {
		t.Error("a resumed runtime continued the goal")
	}
	if len(queue.rounds) != 0 {
		t.Errorf("a resumed runtime queued %d rounds", len(queue.rounds))
	}
}

// Every decision has to be readable afterwards, including the refusals: "why did
// it stop" is the question a person asks after an autonomous session, and a log
// that only records the rounds that ran cannot answer it.
func TestEveryDriverDecisionIsAudited(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		phase  state.Phase
		armed  bool
		reason string
	}{
		{"not armed", state.PhaseActive, false, ReasonNotArmed},
		{"paused", state.PhasePaused, true, ReasonGoalPaused},
		{"complete", state.PhaseComplete, true, ReasonGoalComplete},
	} {
		runtimeValue := driverRuntime(t, testCase.phase, 0, 5, testCase.armed)
		events := []map[string]any{}
		runtimeValue.OnEventHook = func(record map[string]any) { events = append(events, record) }

		runtimeValue.ObserveTurn(nil, false, (&recordingQueue{}).queue)

		found := false
		for _, record := range events {
			if record["kind"] != "goal_round" {
				continue
			}
			found = true
			if record["reason"] != testCase.reason {
				t.Errorf("%s: audit reason = %v, want %s", testCase.name, record["reason"], testCase.reason)
			}
			if record["goal_id"] != "goal-1" {
				t.Errorf("%s: audit record does not name the goal: %v", testCase.name, record)
			}
		}
		if !found {
			t.Errorf("%s: no goal_round record was written", testCase.name)
		}
	}
}

func TestDriverWithoutAGoalDoesNothing(t *testing.T) {
	session := state.NewEmptySession("s")
	runtimeValue := &Runtime{SessionIDValue: "s", SessionValue: session}
	runtimeValue.Driver = NewDriver(runtimeValue)
	runtimeValue.SetGoalArmed(true)

	queue := &recordingQueue{}
	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionIdle) {
		t.Fatalf("decision = %q, want idle", decision)
	}
	if len(queue.rounds) != 0 {
		t.Errorf("a session with no goal queued %d rounds", len(queue.rounds))
	}
}

func TestStartGoalRoundRefusesAnUnarmedOrUnusableReservation(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)

	if _, started, err := runtimeValue.StartGoalRound(nil); started || err == nil {
		t.Errorf("a nil reservation started a round (started=%v, err=%v)", started, err)
	}

	queue := &recordingQueue{}
	runtimeValue.ObserveTurn(nil, false, queue.queue)
	reservation := queue.rounds[0]

	// No agent to run it: refused, and — the part that matters — nothing spent.
	if _, started, err := runtimeValue.StartGoalRound(reservation); started || !errors.Is(err, ErrGoalNotArmed) {
		t.Errorf("a round ran with no agent (started=%v, err=%v)", started, err)
	}
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("a refused round spent a number: %d", goal.Rounds)
	}

	// Disarmed: same answer, and still nothing spent.
	runtimeValue.SetGoalArmed(false)
	if _, started, _ := runtimeValue.StartGoalRound(reservation); started {
		t.Error("a disarmed runtime started a round")
	}
	if goal, _ := state.LoadGoal(runtimeValue.SessionValue.Metadata); goal.Rounds != 0 {
		t.Errorf("a refused round spent a number: %d", goal.Rounds)
	}
}

// --- arming, which is what makes a goal the model created actually run --------

// humanSession is a session whose turn in progress a person started, in the shape
// the goal tools actually run inside: the user's message, the model's narration, the
// tool call and its result.
func humanSession() *state.Session {
	session := state.NewEmptySession("s")
	session.Messages = append(session.Messages,
		map[string]any{"role": "user", "content": "把重连修好，这个估计要跑几轮"},
		map[string]any{"role": "assistant", "content": nil},
		map[string]any{"role": "tool", "tool_call_id": "c1", "content": "ok"},
	)
	return session
}

// The whole point of this batch: a goal the model created while answering a person
// becomes armed, so the driver continues it. Without this the feature is a record
// that never runs.
func TestAGoalCreatedInAHumanTurnIsArmed(t *testing.T) {
	session := humanSession()
	runtimeValue := runtimeOver(t, session, state.PhaseActive, 0, 5, false)

	if runtimeValue.GoalArmed() {
		t.Fatal("the fixture started armed")
	}
	runtimeValue.ArmFromTurn()
	if !runtimeValue.GoalArmed() {
		t.Fatal("a goal created in a person's turn was not armed")
	}

	// And the driver now continues it, which is the consequence that matters.
	queue := &recordingQueue{}
	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionContinue) {
		t.Errorf("decision = %q, want continue", decision)
	}
	if len(queue.rounds) != 1 {
		t.Errorf("queued %d rounds, want 1", len(queue.rounds))
	}
}

// The authorization rule, from the other side: a model inside its own round cannot
// arm itself, or it would be deciding how long it runs.
func TestAnAutonomousRoundCannotArmTheGoal(t *testing.T) {
	session := state.NewEmptySession("s")
	session.Messages = append(session.Messages,
		map[string]any{"role": "user", "content": "把重连修好"},
		map[string]any{"role": "assistant", "content": "好"},
	)
	runtimeValue := runtimeOver(t, session, state.PhaseActive, 1, 5, false)
	// The turn in progress is an automatic round.
	goal, _ := state.LoadGoal(session.Metadata)
	session.Messages = append(session.Messages, state.GoalRoundPrompt(goal, 1))

	runtimeValue.ArmFromTurn()
	if runtimeValue.GoalArmed() {
		t.Fatal("an autonomous round armed the goal")
	}
}

func TestOnlyAnActiveGoalIsArmedByATurn(t *testing.T) {
	for _, phase := range []state.Phase{state.PhasePaused, state.PhaseBlocked, state.PhaseComplete} {
		runtimeValue := runtimeOver(t, humanSession(), phase, 0, 5, false)
		runtimeValue.ArmFromTurn()
		if runtimeValue.GoalArmed() {
			t.Errorf("a %s goal was armed by a finished turn", phase)
		}
	}
}

func TestATurnWithNoGoalArmsNothing(t *testing.T) {
	session := humanSession()
	metadata := session.Metadata
	runtimeValue := &Runtime{SessionIDValue: "s", SessionValue: session}
	runtimeValue.Driver = NewDriver(runtimeValue)
	_ = metadata

	runtimeValue.ArmFromTurn()
	if runtimeValue.GoalArmed() {
		t.Fatal("a turn with no goal armed something")
	}
}

// --- the commands a person gives ---------------------------------------------

func TestGoalCommandPauseResumeRoundTrip(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)

	paused, err := runtimeValue.GoalCommand(state.GoalActionPause)
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if paused["phase"] != string(state.PhasePaused) {
		t.Errorf("phase = %v", paused["phase"])
	}
	if runtimeValue.GoalArmed() {
		t.Error("a paused goal is still armed")
	}
	// A paused goal must not continue even if somebody asks the driver.
	queue := &recordingQueue{}
	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision == string(DecisionContinue) {
		t.Error("a paused goal continued")
	}

	resumed, err := runtimeValue.GoalCommand(state.GoalActionResume)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if resumed["phase"] != string(state.PhaseActive) {
		t.Errorf("phase after resume = %v", resumed["phase"])
	}
	if resumed["armed"] != true {
		t.Error("the resume snapshot does not report the goal as armed")
	}
	if !runtimeValue.GoalArmed() {
		t.Error("resume did not arm the process")
	}
}

func TestGoalCommandClearStopsAndRemoves(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)

	panel, err := runtimeValue.GoalCommand(state.GoalActionClear)
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if objective, _ := panel["objective"].(string); objective != "" {
		t.Errorf("the clear snapshot still names an objective: %v", panel)
	}
	if _, ok := state.LoadGoal(runtimeValue.SessionValue.Metadata); ok {
		t.Error("the goal survived the clear command")
	}
	if runtimeValue.GoalArmed() {
		t.Error("clearing the goal left the session armed")
	}
	// And the driver agrees there is nothing to continue.
	queue := &recordingQueue{}
	if decision := runtimeValue.ObserveTurn(nil, false, queue.queue); decision != string(DecisionIdle) {
		t.Errorf("decision after clear = %q, want idle", decision)
	}
}

// Resume on a session that was loaded from disk cannot arm it, and the panel has to
// say so rather than report the command's intent.
func TestGoalCommandResumeOnAResumedSessionReportsDisarmed(t *testing.T) {
	runtimeValue := runtimeOver(t, humanSession(), state.PhasePaused, 0, 5, false)
	runtimeValue.Resumed = true

	panel, err := runtimeValue.GoalCommand(state.GoalActionResume)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if panel["phase"] != string(state.PhaseActive) {
		t.Errorf("phase = %v, want the goal to be active", panel["phase"])
	}
	if panel["armed"] != false {
		t.Error("the panel claims a resumed session is armed")
	}
	if runtimeValue.GoalArmed() {
		t.Error("a resumed session armed itself through the command surface")
	}
}

// GoalLine is what the transcript re-states every turn, and the "not continuing"
// suffix is the part that keeps a person from waiting for work that will not start.
func TestGoalLineReportsTheGoalAndWhetherItRuns(t *testing.T) {
	runtimeValue := driverRuntime(t, state.PhaseActive, 0, 5, true)
	line := runtimeValue.GoalLine()
	if !strings.Contains(line, "把重连修好") || !strings.Contains(line, "0/5") {
		t.Errorf("the goal line is missing the objective or the budget: %q", line)
	}
	if strings.Contains(line, "not continuing") {
		t.Errorf("an armed goal is reported as not continuing: %q", line)
	}

	runtimeValue.SetGoalArmed(false)
	if line := runtimeValue.GoalLine(); !strings.Contains(line, "not continuing") {
		t.Errorf("a disarmed goal does not say so: %q", line)
	}

	// No goal: no line at all, because the terminal re-states this after every turn
	// and a sentence about the absence of a goal would appear in every session.
	empty := &Runtime{SessionIDValue: "s", SessionValue: state.NewEmptySession("s")}
	if line := empty.GoalLine(); line != "" {
		t.Errorf("a session with no goal produced a line: %q", line)
	}
}

func TestGoalPanelIsAlwaysACompleteShape(t *testing.T) {
	empty := &Runtime{SessionIDValue: "s", SessionValue: state.NewEmptySession("s")}
	panel := empty.GoalPanel()
	for _, key := range []string{"id", "objective", "phase", "armed"} {
		if _, present := panel[key]; !present {
			t.Errorf("the empty goal panel has no %q key: %v", key, panel)
		}
	}

	withGoal := driverRuntime(t, state.PhaseActive, 0, 5, true)
	panel = withGoal.GoalPanel()
	for _, key := range []string{"id", "objective", "phase", "rounds_text", "armed", "limit_reached"} {
		if _, present := panel[key]; !present {
			t.Errorf("the goal panel has no %q key: %v", key, panel)
		}
	}
	if panel["armed"] != true || panel["rounds_text"] != "0/5" {
		t.Errorf("the panel disagrees with the goal: %v", panel)
	}
}
