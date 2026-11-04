package protocol

import (
	"context"
	"strings"
	"testing"
	"time"
)

// suggestRuntime answers turns and suggestions, recording what it was asked.
type suggestRuntime struct {
	stubRuntime
	asked   chan [2]string
	replies []string
	// block, when set, holds the suggestion request until its context ends —
	// the shape of a slow endpoint a new turn has to cancel.
	block bool
	ended chan error
}

func newSuggestRuntime(replies ...string) *suggestRuntime {
	return &suggestRuntime{asked: make(chan [2]string, 4), ended: make(chan error, 4), replies: replies}
}

func (r *suggestRuntime) RunTurn(context.Context, string) (string, error) {
	return "Committed. Want me to push?", nil
}

func (r *suggestRuntime) SuggestReplies(ctx context.Context, runID, prompt, answer string) ([]string, error) {
	r.asked <- [2]string{prompt, answer}
	if r.block {
		<-ctx.Done()
		r.ended <- ctx.Err()
		return nil, ctx.Err()
	}
	return r.replies, nil
}

// fakeRunStarted gives the server a run id, the way the agent's first event does.
func fakeRunStarted(server *Server, runID string) {
	server.stateLock.Lock()
	server.lastRunID = runID
	server.stateLock.Unlock()
}

func suggestionsIn(t *testing.T, raw string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if !strings.Contains(line, `"kind":"suggestions"`) {
			continue
		}
		out = append(out, lastMessage(t, line))
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// TestSuggestionsArriveAfterTheAnswer: a turn a person started ends with an
// answer, and the buttons come afterwards, tagged with that turn's run id.
func TestSuggestionsArriveAfterTheAnswer(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newSuggestRuntime("push 吧")
	server.Attach(runtimeValue)
	fakeRunStarted(server, "r1")

	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "commit it"})
	server.joinTurn()

	asked := <-runtimeValue.asked
	if asked[0] != "commit it" || asked[1] != "Committed. Want me to push?" {
		t.Errorf("asked with %q", asked)
	}
	waitFor(t, func() bool { return len(suggestionsIn(t, output.String())) == 1 })
	message := suggestionsIn(t, output.String())[0]
	if message["run_id"] != "r1" {
		t.Errorf("run_id = %v", message["run_id"])
	}
	replies, _ := message["replies"].([]any)
	if len(replies) != 1 || replies[0] != "push 吧" {
		t.Errorf("replies = %v", message["replies"])
	}
	raw := output.String()
	if strings.Index(raw, `"kind":"run_finished"`) > strings.Index(raw, `"kind":"suggestions"`) {
		t.Error("suggestions were sent before the answer")
	}
}

// TestTheNextTurnCancelsAPendingSuggestion: a slow side request must never hold
// the person's next message, and its result must not land under the next turn.
func TestTheNextTurnCancelsAPendingSuggestion(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newSuggestRuntime("push 吧")
	runtimeValue.block = true
	server.Attach(runtimeValue)
	fakeRunStarted(server, "r1")

	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "commit it"})
	server.joinTurn()
	<-runtimeValue.asked

	// The next message starts promptly: the side request is not on the turn path.
	done := make(chan struct{})
	go func() {
		server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "next"})
		server.joinTurn()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the next turn waited behind the suggestion request")
	}
	select {
	case err := <-runtimeValue.ended:
		if err == nil {
			t.Error("the first suggestion request ended without being cancelled")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first suggestion request was never cancelled")
	}
	if got := suggestionsIn(t, output.String()); len(got) != 0 {
		t.Errorf("a cancelled request still drew buttons: %v", got)
	}
}

// TestSuggestionsCanBeTurnedOff: the person's switch is absolute.
func TestSuggestionsCanBeTurnedOff(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := newSuggestRuntime("push 吧")
	server.Attach(runtimeValue)
	fakeRunStarted(server, "r1")

	server.Dispatch(map[string]any{"v": VERSION, "t": InSetSuggestions, "on": false})
	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "commit it"})
	server.joinTurn()

	select {
	case <-runtimeValue.asked:
		t.Fatal("asked for suggestions with the switch off")
	case <-time.After(100 * time.Millisecond):
	}
}

// suggestGoalRuntime continues once: no buttons may be drawn under an answer an
// automatic round is about to follow, and none for the round itself.
type suggestGoalRuntime struct {
	*goalRuntime
	asked chan struct{}
}

func (r *suggestGoalRuntime) SuggestReplies(context.Context, string, string, string) ([]string, error) {
	r.asked <- struct{}{}
	return []string{"x"}, nil
}

func TestNoSuggestionsWhileAGoalContinues(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	runtimeValue := &suggestGoalRuntime{goalRuntime: newGoalRuntime(), asked: make(chan struct{}, 4)}
	server.Attach(runtimeValue)
	fakeRunStarted(server, "r1")

	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "keep going"})
	server.joinTurn()
	select {
	case <-runtimeValue.started:
	case <-time.After(2 * time.Second):
		t.Fatal("the automatic round never ran")
	}
	waitFor(t, func() bool { return strings.Count(output.String(), `"kind":"run_finished"`) == 2 })
	server.joinTurn()

	select {
	case <-runtimeValue.asked:
		t.Fatal("asked for suggestions around an automatic round")
	case <-time.After(100 * time.Millisecond):
	}
}
