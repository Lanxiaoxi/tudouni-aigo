package protocol

import (
	"context"
	"strings"
	"testing"
	"time"
)

// blockingRuntime is a runtime whose turn does not end until its context is
// cancelled — the shape of a turn that is waiting on a slow command, on a request
// that has not answered, or on a delegation. It is what makes "the stop reached the
// turn" **observable** rather than inferred from a flag the test would have to read
// anyway.
//
// It counts its turns so the second one can report the context it was handed, which
// is how the "a fresh context per turn" rule is checked.
type blockingRuntime struct {
	*stubRuntime
	turns     int
	entered   chan struct{}
	cancelled chan struct{}
	// secondErr records the state of the second turn's context **when it arrived**. A
	// context held on the server rather than created per turn would still be cancelled
	// here, and the second turn would stop at its first safe point for no reason the
	// person could see.
	secondErr error
}

func (r *blockingRuntime) RunTurn(ctx context.Context, _ string) (string, error) {
	r.turns++
	if r.turns == 1 {
		close(r.entered)
		<-ctx.Done()
		close(r.cancelled)
		return "", nil
	}
	r.secondErr = ctx.Err()
	return "second turn done", nil
}

func newBlockingRuntime() *blockingRuntime {
	return &blockingRuntime{
		stubRuntime: &stubRuntime{},
		entered:     make(chan struct{}),
		cancelled:   make(chan struct{}),
	}
}

// TestAStopCancelsTheTurnItWasAimedAt is the piece that makes the rest of the change
// reach anything at all.
//
// The server used to set a flag and nothing else, and a flag can only be **checked** —
// at the next safe point, which for a slow command or a request still waiting for its
// first byte is minutes away. Cancelling the context is what reaches work that is
// already in flight, and it is the whole difference between "stop eventually" and
// "stop now".
func TestAStopCancelsTheTurnItWasAimedAt(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newBlockingRuntime()
	server.Attach(runtimeValue)

	server.startTurn("跑一个很慢的命令")

	select {
	case <-runtimeValue.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the turn never started")
	}

	server.requestStop()

	select {
	case <-runtimeValue.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("a stop did not cancel the turn's context: it would only be noticed at the next safe point")
	}
}

// TestTheNextTurnGetsAFreshContext is the failure that a context stored on the server
// would cause, and it is the same failure `ClearStop` already exists to prevent for
// the flag: the runtime outlives the turn, so a cancelled context left on it stops
// the *next* turn at its first safe point — with nothing on the wire to say why.
func TestTheNextTurnGetsAFreshContext(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newBlockingRuntime()
	server.Attach(runtimeValue)

	server.startTurn("第一轮")
	select {
	case <-runtimeValue.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the first turn never started")
	}
	server.requestStop()
	select {
	case <-runtimeValue.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the stop did not reach the first turn")
	}

	// The second turn joins the first, so by the time it runs the stop is over.
	server.startTurn("第二轮")

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if runtimeValue.turns >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if runtimeValue.turns < 2 {
		t.Fatal("the second turn never ran")
	}
	if runtimeValue.secondErr != nil {
		t.Errorf("the second turn was handed an already-cancelled context (%v): "+
			"the turn context is being reused across turns", runtimeValue.secondErr)
	}
}

// TestTheInterruptMessageReachesTheSameStop: the wire path and the direct call have to
// be the same stop, or a front end's button would do something subtly different from
// what the tests cover.
func TestTheInterruptMessageReachesTheSameStop(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newBlockingRuntime()
	server.Attach(runtimeValue)

	server.startTurn("跑一个很慢的命令")
	select {
	case <-runtimeValue.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the turn never started")
	}

	// Exactly what `Client.Interrupt` puts on the transport.
	server.Dispatch(map[string]any{"v": VERSION, "t": InInterrupt})

	select {
	case <-runtimeValue.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the interrupt message did not cancel the turn's context")
	}
}
