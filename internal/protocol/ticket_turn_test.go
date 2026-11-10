package protocol

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

// ticketTurnRuntime records ObserveTicketTurn calls. Whether a ticket is bound and
// whether the turn reported are the runtime's questions; what is tested here is
// only **when** the server asks (protocol 21).
type ticketTurnRuntime struct {
	stubRuntime
	err error

	mu    sync.Mutex
	calls int
}

func (r *ticketTurnRuntime) RunTurn(context.Context, string) (string, error) {
	return "answer", r.err
}

func (r *ticketTurnRuntime) ObserveTicketTurn(string) {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
}

func (r *ticketTurnRuntime) observed() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func TestAnAnsweredTurnIsOfferedToTheTicketObserver(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := &ticketTurnRuntime{}
	server.Attach(runtimeValue)

	server.startTurn("fix it")
	waitFor(t, func() bool { return runtimeValue.observed() == 1 })
}

// A failed or cancelled turn has nothing to hand over, so the runtime is not
// even asked.
func TestAFailedTurnIsNotOfferedToTheTicketObserver(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := &ticketTurnRuntime{err: errors.New("model broke")}
	server.Attach(runtimeValue)

	server.startTurn("fix it")
	waitForOutput(t, output, `"kind":"run_finished"`)
	server.joinTurn()
	if got := runtimeValue.observed(); got != 0 {
		t.Fatalf("a failed turn was offered %d times, want 0", got)
	}
}

// goalTicketRuntime continues once, then stops: the observer must hear about the
// chain once, after the automatic round, never after the turn that queued it.
type goalTicketRuntime struct {
	*goalRuntime

	mu        sync.Mutex
	calls     int
	atObserve []int
}

func (r *goalTicketRuntime) ObserveTicketTurn(string) {
	r.mu.Lock()
	r.calls++
	r.atObserve = append(r.atObserve, r.observeCalls)
	r.mu.Unlock()
}

func TestAQueuedGoalRoundDefersTheTicketObserver(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := &goalTicketRuntime{goalRuntime: newGoalRuntime()}
	server.Attach(runtimeValue)

	server.startTurn("fix it")
	<-runtimeValue.started
	waitFor(t, func() bool {
		runtimeValue.mu.Lock()
		defer runtimeValue.mu.Unlock()
		return runtimeValue.calls == 1
	})
	server.joinTurn()

	runtimeValue.mu.Lock()
	defer runtimeValue.mu.Unlock()
	if runtimeValue.calls != 1 {
		t.Fatalf("observer called %d times, want once for the chain", runtimeValue.calls)
	}
	// The first ObserveTurn queued the round; the observer may only run after the
	// second one, which refused.
	if runtimeValue.atObserve[0] != 2 {
		t.Errorf("observer ran after ObserveTurn call %d, want 2", runtimeValue.atObserve[0])
	}
}
