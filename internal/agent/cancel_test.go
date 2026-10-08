package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// These tests are about the one thing a stop is not allowed to cost: the session.
//
// The invariant at the top of retry.go says every `tool_calls` entry must be followed
// by a tool result. A stop is the moment that is hardest to honour — the loop wants to
// return immediately, and the calls after the one in flight were never run — and the
// damage is permanent rather than local: the assistant message is already in the
// session file, so every later turn of that session is answered 400 with a message
// that reads like "the context is too long".

// blockingTool registers a tool that does not return until the turn is cancelled. It
// is the shape of every slow call there is — a command, a search, a delegation — and
// it is the only way to make a stop land *during* a tool rather than between steps.
//
// It is deliberately **not** parallel-safe, which forces the serial path: the calls
// after it are then reached one at a time, and the stop has to be noticed between
// them rather than by a batch that was already in flight.
func blockingTool(t *testing.T, entered chan struct{}) tools.Tool {
	t.Helper()
	return tools.Tool{
		Name:        "slow",
		Description: "blocks until the turn is cancelled",
		Risk:        security.RiskLow,
		Schema:      tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path")}, "path"),
		Handler: func(ctx context.Context, _ map[string]any) (tools.Result, error) {
			close(entered)
			<-ctx.Done()
			// The handler says it was interrupted, which is how a tool reports "I
			// stopped because you told me to" as opposed to "I failed". The agent
			// turns this into `status: interrupted`.
			return tools.Result{
				Text:  "stopped before it finished",
				Audit: map[string]any{tools.InterruptedAuditKey: true},
			}, nil
		},
	}
}

// toolResults returns the `tool_result` events of one turn, in the order they were
// emitted. The session's own tool messages do not carry a status — the status is the
// loop's vocabulary, and the audit is where it is written down.
//
// `audit.Event` flattens its data into the record rather than nesting it, so the
// fields are read from the record itself.
func toolResults(h *harness) []map[string]any {
	var results []map[string]any
	for _, record := range h.events {
		if kind, _ := record["kind"].(string); kind != audit.KindToolResult {
			continue
		}
		results = append(results, record)
	}
	return results
}

// TestAStopDuringAToolStillAnswersEveryCallItAskedFor is the invariant under the
// conditions that break it: the stop lands inside the first call, and the other two
// were never run.
func TestAStopDuringAToolStillAnswersEveryCallItAskedFor(t *testing.T) {
	entered := make(chan struct{})
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{
			{ID: "call-1", Name: "slow", Arguments: `{"path":"a.txt"}`},
			{ID: "call-2", Name: "read_file", Arguments: `{"path":"b.txt"}`},
			{ID: "call-3", Name: "read_file", Arguments: `{"path":"c.txt"}`},
		}},
		textResponse("this answer must never be produced"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)
	if err := h.tools.Register(blockingTool(t, entered)); err != nil {
		t.Fatalf("registering the blocking tool: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-entered
		cancel()
	}()

	if _, err := h.agent.Run(ctx, "go"); !isCancelled(err) {
		t.Fatalf("a stopped turn returned %v, want RunCancelled", err)
	}

	// The checkpoint that runs on the way out enforces the invariant, so a violation
	// has already failed the test. This states the same fact from the session side, so
	// the test still means something if the checkpoint is ever moved.
	h.checkConsistency(t)

	results := toolResults(h)
	if len(results) != 3 {
		t.Fatalf("the model asked for 3 calls and %d results were reported: %v", len(results), results)
	}
	for index, want := range []string{"call-1", "call-2", "call-3"} {
		if got := results[index]["call_id"]; got != want {
			t.Errorf("result %d is for %v, want %s — results must follow the model's order", index, got, want)
		}
	}

	// The call that was running and the two that were never reached are all
	// `interrupted`. They are **not** `error`: nothing broke, and a person pressing
	// stop must not show up in the audit as a tool failure.
	for index, result := range results {
		if got := result["status"]; got != statusInterrupted {
			t.Errorf("result %d has status %v, want %s", index, got, statusInterrupted)
		}
	}

	// The turn ended where it was told to. A model call after the stop would be the
	// request the person just asked to abandon.
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1 — a stop must not ask again", chat.calls)
	}
}

// TestTheCallThatWasNeverReachedSaysSoToTheModel pins the text, because the model is
// the reader that has to act on it: it is looking at a list of results and needs to
// know which one did not run, and that repeating it is allowed.
func TestTheCallThatWasNeverReachedSaysSoToTheModel(t *testing.T) {
	entered := make(chan struct{})
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{
			{ID: "call-1", Name: "slow", Arguments: `{"path":"a.txt"}`},
			{ID: "call-2", Name: "read_file", Arguments: `{"path":"b.txt"}`},
		}},
	}}
	h := newHarness(t, chat, security.AlwaysAllow)
	if err := h.tools.Register(blockingTool(t, entered)); err != nil {
		t.Fatalf("registering the blocking tool: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-entered
		cancel()
	}()
	if _, err := h.agent.Run(ctx, "go"); !isCancelled(err) {
		t.Fatalf("a stopped turn returned %v, want RunCancelled", err)
	}

	var skipped string
	for _, message := range h.session.Messages {
		if id, _ := message["tool_call_id"].(string); id == "call-2" {
			skipped, _ = message["content"].(string)
		}
	}
	if skipped == "" {
		t.Fatal("the call that never ran has no result message at all")
	}
	if !strings.Contains(skipped, "read_file") {
		t.Errorf("the message does not name the tool that did not run: %q", skipped)
	}
}

// TestAToolThatFailsOnTheWayOutIsStillInterrupted covers the other legal way a handler
// can react to a stop: reporting it as an **error** rather than as an interrupted
// result. Left alone, the loop's generic handling would tell the model "the tool
// failed", which sends it looking for a cause and sends the person looking for a bug —
// when the cause is the stop they asked for.
//
// The text is asserted, not just the status, because this call **did** start: unlike a
// call that was never reached, it may already have had side effects, and "repeat it
// freely" would be the wrong advice.
func TestAToolThatFailsOnTheWayOutIsStillInterrupted(t *testing.T) {
	entered := make(chan struct{})
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: []model.ToolCall{{ID: "call-1", Name: "explodes", Arguments: `{"path":"a.txt"}`}}},
	}}
	h := newHarness(t, chat, security.AlwaysAllow)
	if err := h.tools.Register(tools.Tool{
		Name:        "explodes",
		Description: "fails once the turn is cancelled",
		Risk:        security.RiskLow,
		Schema:      tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path")}, "path"),
		Handler: func(ctx context.Context, _ map[string]any) (tools.Result, error) {
			close(entered)
			<-ctx.Done()
			return tools.Result{}, errors.New("killed by the transport")
		},
	}); err != nil {
		t.Fatalf("registering the failing tool: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-entered
		cancel()
	}()
	if _, err := h.agent.Run(ctx, "go"); !isCancelled(err) {
		t.Fatalf("a stopped turn returned %v, want RunCancelled", err)
	}

	results := toolResults(h)
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := results[0]["status"]; got != statusInterrupted {
		t.Errorf("status = %v, want %s — an error on the way out is the stop, not a fault", got, statusInterrupted)
	}
	preview, _ := results[0]["preview"].(string)
	if !strings.Contains(preview, "可能已经做了一部分") {
		t.Errorf("the result does not warn that the call may have had side effects: %q", preview)
	}
}

// TestAnAlreadyCancelledTurnNeverCallsTheModel: a stop that arrives before the turn
// starts is still a stop. Without the check at the top of the loop the request would
// go out anyway, and the person would watch an answer begin after asking it not to.
func TestAnAlreadyCancelledTurnNeverCallsTheModel(t *testing.T) {
	chat := &fakeModel{}
	h := newHarness(t, chat, security.AlwaysAllow)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := h.agent.Run(ctx, "go"); !isCancelled(err) {
		t.Fatalf("a turn that was cancelled before it started returned %v, want RunCancelled", err)
	}
	if chat.calls != 0 {
		t.Errorf("the model was called %d times after the turn was already cancelled", chat.calls)
	}
}

// cancellingModel cancels the turn from inside the model call, which is the only way
// to reach the backoff with the context already done.
type cancellingModel struct {
	*fakeModel
	cancel context.CancelFunc
}

func (m *cancellingModel) Complete(messages []map[string]any, toolSchemas []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	m.cancel()
	return m.fakeModel.Complete(messages, toolSchemas, options)
}

// TestABackoffIsAbandonedWhenTheTurnIsCancelled is the wait nobody could interrupt
// before: a transient failure made the loop sleep, and a stop during that sleep was
// only noticed **after** it — one delay late, and then the request went out again.
func TestABackoffIsAbandonedWhenTheTurnIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	chat := &cancellingModel{
		fakeModel: &fakeModel{errs: []error{model.AsTransient("the endpoint was busy")}},
		cancel:    cancel,
	}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run(ctx, "go"); !isCancelled(err) {
		t.Fatalf("a cancelled backoff returned %v, want RunCancelled", err)
	}
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1 — a cancelled backoff must not retry", chat.calls)
	}
}
