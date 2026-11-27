package subagent

import (
	"context"
	"strings"
	"testing"
	"time"
)

// startBackground puts n running background delegations on a board, ids
// sub-w-1..n, started one second apart.
func startBackground(board *Board, clock *fakeClock, ids ...string) {
	for _, id := range ids {
		board.Start(Delegation{ID: id, Label: "task " + id, Depth: 1, Background: true})
		clock.tick(1)
	}
}

// waitAny runs a no-id collect on its own goroutine so the test can settle
// delegations in the middle of the wait.
func waitAny(board *Board, seconds int) <-chan string {
	out := make(chan string, 1)
	go func() {
		out <- collectExecute(context.Background(), board, "", true, seconds).Text
	}()
	return out
}

// TestWaitAnyReturnsWhicheverFinishesFirst is the regression for the scenario
// that motivated wait-any: five children, the parent cannot know the finishing
// order, and a wait pinned to the last one left the earlier finishers unread.
// The no-id wait returns on the first settle, whichever child it is.
func TestWaitAnyReturnsWhicheverFinishesFirst(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)
	startBackground(board, clock, "sub-w-1", "sub-w-2", "sub-w-3", "sub-w-4", "sub-w-5")

	done := waitAny(board, 10)
	time.Sleep(3 * collectPollInterval)
	select {
	case text := <-done:
		t.Fatalf("the wait returned before anything finished: %q", text)
	default:
	}

	board.Settle("sub-w-2", Settlement{Text: "answer two", StopReason: "answered"}, 0)
	select {
	case text := <-done:
		if !strings.Contains(text, "answer two") {
			t.Fatalf("the wait did not hand over the first finisher: %q", text)
		}
		if !strings.Contains(text, "4 background subagent(s) still running") {
			t.Fatalf("the wait did not say how many are still running: %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the wait did not return after a child finished")
	}
	if board.Uncollected() != 0 {
		t.Fatal("the handed-over result is still waiting to be collected")
	}
}

// TestWaitAnyHandsOverEverythingThatHasFinished pins the burst case: results
// that settled before the call are all handed over in one answer, in the order
// they finished, and none of them is handed over twice.
func TestWaitAnyHandsOverEverythingThatHasFinished(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)
	startBackground(board, clock, "sub-w-1", "sub-w-2", "sub-w-3")

	board.Settle("sub-w-3", Settlement{Text: "answer three"}, 100)
	board.Settle("sub-w-1", Settlement{Text: "answer one"}, 200)

	result := collectExecute(context.Background(), board, "", true, 5)
	three := strings.Index(result.Text, "answer three")
	one := strings.Index(result.Text, "answer one")
	if three < 0 || one < 0 {
		t.Fatalf("not every finished result was handed over: %q", result.Text)
	}
	if three > one {
		t.Errorf("results are not in finishing order: %q", result.Text)
	}
	if ids, _ := result.Audit["subagent_ids"].([]string); len(ids) != 2 {
		t.Errorf("audit ids = %v, want both", result.Audit["subagent_ids"])
	}
	if !strings.Contains(result.Text, "1 background subagent(s) still running") {
		t.Errorf("the answer does not say one is still running: %q", result.Text)
	}

	// The one left running is still there to wait for, and the two handed over
	// are not handed over again.
	ready, running := board.TakeReady()
	if len(ready) != 0 || running != 1 {
		t.Fatalf("after collection: ready=%d running=%d, want 0 and 1", len(ready), running)
	}
	if !board.WasCollected("sub-w-3") || !board.WasCollected("sub-w-1") {
		t.Error("handed-over delegations are not remembered as collected")
	}
}

// TestWaitAnyWithNothingInFlightReturnsAtOnce: a wait that nothing could end
// would only ever run into its deadline.
func TestWaitAnyWithNothingInFlightReturnsAtOnce(t *testing.T) {
	board := NewBoard((&fakeClock{}).read)
	started := time.Now()
	result := collectExecute(context.Background(), board, "", true, 30)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("the wait took %s with nothing to wait for", elapsed)
	}
	if !strings.Contains(result.Text, "nothing to wait for") {
		t.Fatalf("unexpected answer: %q", result.Text)
	}
}

// TestCollectWithAnIDNeverWaits pins the other half of the design: an id is a
// look at one child, so the call returns at once even with wait=true and a long
// deadline, and it points the model at the no-id form for waiting.
func TestCollectWithAnIDNeverWaits(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)
	startBackground(board, clock, "sub-w-1")

	started := time.Now()
	result := collectExecute(context.Background(), board, "sub-w-1", true, 300)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("a collect with an id waited %s", elapsed)
	}
	if !strings.Contains(result.Text, "not finished yet") || !strings.Contains(result.Text, "without an id") {
		t.Fatalf("unexpected answer: %q", result.Text)
	}
	if !board.IsRunning("sub-w-1") {
		t.Error("a look changed the delegation's state")
	}
}

// TestWaitAnyIgnoresForegroundDelegations: a foreground child's answer goes
// back as its own tool result, so it is neither something to wait for nor a
// reason to keep waiting.
func TestWaitAnyIgnoresForegroundDelegations(t *testing.T) {
	board := NewBoard((&fakeClock{}).read)
	board.Start(Delegation{ID: "sub-f-1", Depth: 1})
	result := collectExecute(context.Background(), board, "", true, 30)
	if !strings.Contains(result.Text, "nothing to wait for") {
		t.Fatalf("a foreground delegation was treated as background work: %q", result.Text)
	}
}
