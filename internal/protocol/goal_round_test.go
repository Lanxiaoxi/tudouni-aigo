package protocol

import (
	"strings"
	"testing"
	"time"
)

// goalRuntime is a runtime that can continue a goal, built to test the
// **sequencing** — the only thing the protocol layer is responsible for here: that
// a finished turn is the point at which the scheduler is asked, and that the round
// it reserved actually runs afterwards.
//
// Whether a goal *should* continue is the driver's question, and it is tested where
// the driver lives.
type goalRuntime struct {
	stubRuntime

	queued chan GoalRound
	// observeCalls counts how many times the scheduler was consulted. A second call
	// is what proves the automatic round went through the same turn-finished path as
	// a human one.
	observeCalls int
	// continueOnce makes the first decision a reservation and the rest refusals, so
	// the loop terminates deterministically.
	continueOnce bool
	// refuse, when set, makes ObserveTurn decline the reservation — the state a
	// driver is in when the goal moved between reserving and starting.
	refuse bool

	started     chan GoalRound
	startAnswer string
	// startedFlag is what `StartGoalRound` reports as "a turn ran". False is a real
	// outcome for the real runtime, so it has to be expressible here.
	startedFlag bool

	// armCalls records how often the server asked the runtime whether a finished
	// turn grants continuation. The order against observeCalls is the thing worth
	// asserting: arming has to come first, or a goal created during the turn is
	// refused once for not being armed yet.
	armCalls int
	// commands records the goal commands the server accepted.
	commands []string
	// commandErr, when set, is what GoalCommand returns.
	commandErr error
}

func (r *goalRuntime) GoalLine() string          { return "" }
func (r *goalRuntime) GoalPanel() map[string]any { return map[string]any{"objective": ""} }

// ArmFromTurn is part of GoalArmer. It arms unconditionally, because what the tests
// here are about is the **order** in which the server calls it — whether the real
// runtime arms is its own test.
func (r *goalRuntime) ArmFromTurn() { r.armCalls++ }

// GoalCommand is part of GoalCommander.
func (r *goalRuntime) GoalCommand(action string) (map[string]any, error) {
	if r.commandErr != nil {
		return nil, r.commandErr
	}
	r.commands = append(r.commands, action)
	return map[string]any{"objective": "把重连修好", "phase": "active", "rounds_text": "0/5", "armed": true}, nil
}

func newGoalRuntime() *goalRuntime {
	return &goalRuntime{
		queued:       make(chan GoalRound, 2),
		started:      make(chan GoalRound, 2),
		continueOnce: true,
		startAnswer:  "round done",
		startedFlag:  true,
	}
}

func (r *goalRuntime) RunTurn(string) (string, error) { return "turn done", nil }

// ObserveTurn records the decision and hands the reservation to the server's own
// queue function, exactly as the real runtime does.
func (r *goalRuntime) ObserveTurn(_ error, _ bool, queue func(GoalRound) bool) string {
	r.observeCalls++
	if r.refuse || !r.continueOnce || r.observeCalls > 1 {
		return "refused"
	}
	reservation := &stubRound{goalID: "goal-1", revision: 1, round: 1}
	if queue == nil || !queue(reservation) {
		return "refused"
	}
	select {
	case r.queued <- reservation:
	default:
	}
	return "continue"
}

func (r *goalRuntime) StartGoalRound(round GoalRound) (string, bool, error) {
	select {
	case r.started <- round:
	default:
	}
	if !r.startedFlag {
		return "", false, nil
	}
	return r.startAnswer, true, nil
}

// stubRound is the opaque reservation the server carries.
type stubRound struct {
	goalID   string
	revision int
	round    int
}

func (r *stubRound) GoalID() string             { return r.goalID }
func (r *stubRound) Revision() int              { return r.revision }
func (r *stubRound) Round() int                 { return r.round }
func (r *stubRound) Messages() []map[string]any { return nil }

// TestAnAutomaticRoundRunsAfterTheTurnSettles is the deadlock test.
//
// The queue callback runs inside the finished turn's own goroutine, and that turn's
// completion is signalled by closing `turnDone` — which happens after `runTurn`
// returns. So a server that called back into `startTurn` from there would wait on a
// channel it is itself responsible for closing, and the session would hang with the
// goal half continued: no further turn, no answer, and nothing on the wire to say
// why.
func TestAnAutomaticRoundRunsAfterTheTurnSettles(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	server.startTurn("把重连修好")

	// The turn finishes, and the driver's reservation is queued behind it.
	select {
	case round := <-runtimeValue.queued:
		if round.Round() != 1 {
			t.Errorf("reserved round %d, want 1", round.Round())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler was never consulted after the turn finished")
	}

	// And it actually runs. This is the assertion that hangs if the ordering is
	// wrong, which is why it has a deadline rather than a plain receive.
	select {
	case round := <-runtimeValue.started:
		if round.GoalID() != "goal-1" {
			t.Errorf("the round that ran is for goal %q", round.GoalID())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reserved round never started: a turn was queued behind a turn that never ended")
	}

	// The automatic round is a turn like any other: its answer reaches the front
	// end. An autonomous round whose answer vanished would leave the transcript
	// showing work that never happened.
	waitForOutput(t, output, "round done")
}

// TestAnAutomaticRoundIsReportedLikeAnyOtherTurn pins the reporting, which is the
// part a front end depends on: the round arrives as a turn with an answer, not as a
// silent event.
func TestAnAutomaticRoundIsReportedLikeAnyOtherTurn(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	server.startTurn("开始")
	waitForOutput(t, output, "round done")

	// Both turns finish, and the automatic one carries its own answer.
	finished := 0
	for _, message := range sentFromBuffer(t, output) {
		if TypeOf(message) != OutUI {
			continue
		}
		if kind, _ := message["kind"].(string); kind == UIRunFinished {
			finished++
			if answer, _ := message["answer"].(string); answer == "" {
				t.Errorf("a finished turn carried no answer: %v", message)
			}
		}
	}
	if finished != 2 {
		t.Errorf("%d turns were reported as finished, want 2 (the person's and the round)", finished)
	}
	// Two observations: the person's turn, and then the round's.
	if runtimeValue.observeCalls != 2 {
		t.Errorf("the scheduler was consulted %d times, want 2", runtimeValue.observeCalls)
	}
}

// A reservation that went stale before its turn started must cost nothing — no
// invented answer, and no finished turn reported for one that never ran.
func TestAStaleReservationReportsNoTurn(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	runtimeValue.startedFlag = false
	server.Attach(runtimeValue)

	server.startTurn("开始")
	// The person's turn is reported; the stale round must not add a second one.
	waitForOutput(t, output, "turn done")
	time.Sleep(200 * time.Millisecond)

	finished := 0
	for _, message := range sentFromBuffer(t, output) {
		if TypeOf(message) != OutUI {
			continue
		}
		if kind, _ := message["kind"].(string); kind == UIRunFinished {
			finished++
		}
	}
	if finished != 1 {
		t.Errorf("%d finished turns were reported, want 1 — the stale round invented one", finished)
	}
	if strings.Contains(output.String(), "round done") {
		t.Error("a stale reservation produced an answer")
	}
}

// TestTheCarrierArmsBeforeItAsks is the ordering test.
//
// A goal the model creates during a turn a person started is written down by the
// tool, but it is *this* process that decides whether the session continues. If the
// server asked the scheduler first and armed afterwards, that goal would be refused
// once for not being armed yet — a round silently not taken, and the session
// stopping for a reason nothing in the log explains.
func TestTheCarrierArmsBeforeItAsks(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	server.startTurn("把重连修好")
	waitForOutput(t, output, "round done")

	if runtimeValue.armCalls == 0 {
		t.Fatal("the server never offered the runtime a chance to arm the goal")
	}
	// Both happened, on both turns, and nothing refused for "not armed".
	if runtimeValue.observeCalls < 2 {
		t.Errorf("the scheduler was consulted %d times, want at least 2", runtimeValue.observeCalls)
	}
	if runtimeValue.armCalls < runtimeValue.observeCalls {
		t.Errorf("arming happened %d times but the scheduler was asked %d times: the ask came first",
			runtimeValue.armCalls, runtimeValue.observeCalls)
	}
}

// TestGoalCommandsReachTheRuntime covers the command surface, which is the half that
// makes a model-created goal answerable to the person who did not ask for it.
func TestGoalCommandsReachTheRuntime(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	for _, action := range []string{GoalPause, GoalResume, GoalClear} {
		server.Dispatch(map[string]any{
			"v": float64(VERSION), "t": InGoal, "action": action,
		})
	}

	if len(runtimeValue.commands) != 3 {
		t.Fatalf("the runtime received %v, want all three commands", runtimeValue.commands)
	}
	for index, want := range []string{GoalPause, GoalResume, GoalClear} {
		if runtimeValue.commands[index] != want {
			t.Errorf("command %d = %q, want %q", index, runtimeValue.commands[index], want)
		}
	}
	// Every command answers with a fresh snapshot, so the rail and the transcript
	// never disagree about whether the goal is still running.
	if snapshots := countStateSnapshots(sentFromBuffer(t, output)); snapshots < 3 {
		t.Errorf("%d state snapshots for three commands, want at least 3", snapshots)
	}
}

// An empty action is a read, and must not be sent to the runtime as a command: a
// mistyped action that silently became a no-op is worse than one that is refused.
func TestAnEmptyGoalActionReadsWithoutChanging(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	server.Dispatch(map[string]any{"v": float64(VERSION), "t": InGoal})

	if len(runtimeValue.commands) != 0 {
		t.Errorf("a read was sent as a command: %v", runtimeValue.commands)
	}
	// It still answers: the caller asked where things stand.
	if snapshots := countStateSnapshots(sentFromBuffer(t, output)); snapshots != 1 {
		t.Errorf("%d state snapshots for a read, want 1", snapshots)
	}
	notices := []map[string]any{}
	for _, message := range sentFromBuffer(t, output) {
		if TypeOf(message) == OutNotice {
			notices = append(notices, message)
		}
	}
	if len(notices) == 0 {
		t.Error("a goal read produced no notice, so `/goal` would print nothing")
	}
}

// An action outside the three is refused by name — never quietly treated as a read,
// which would make a mistyped pause look like it worked.
func TestAnUnknownGoalActionIsRefusedByName(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newGoalRuntime()
	server.Attach(runtimeValue)

	server.Dispatch(map[string]any{"v": float64(VERSION), "t": InGoal, "action": "stop"})

	if len(runtimeValue.commands) != 0 {
		t.Errorf("an unknown action was passed through: %v", runtimeValue.commands)
	}
	found := false
	for _, message := range sentFromBuffer(t, output) {
		if TypeOf(message) != OutNotice {
			continue
		}
		if text, _ := message["text"].(string); strings.Contains(text, "stop") {
			found = true
		}
	}
	if !found {
		t.Errorf("the refusal does not name the action that was wrong:\n%s", output.String())
	}
}

// waitForOutput blocks until the stream contains a fragment, or fails the test.
func waitForOutput(t *testing.T, output *safeBuffer, fragment string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(output.String(), fragment) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the transport never carried %q:\n%s", fragment, output.String())
}

// sentFromBuffer decodes what a server wrote to a concurrent buffer.
//
// `sentMessages` takes a `*strings.Builder` because every other test owns a
// single-threaded stream. These tests cannot: the round runs on its own goroutine,
// which is the whole point of them, so the output goes through `safeBuffer` and is
// copied into a builder here rather than by widening the shared helper.
func sentFromBuffer(t *testing.T, output *safeBuffer) []map[string]any {
	t.Helper()
	builder := &strings.Builder{}
	builder.WriteString(output.String())
	return sentMessages(t, builder)
}
