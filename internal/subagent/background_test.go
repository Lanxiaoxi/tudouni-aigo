package subagent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// bgHarness is the standard harness for background tests. It is the ordinary
// newHarness, plus the release channel wired through the fake model so a test
// can hold children at their first model call and let them go on command — the
// same rendezvous the parallel tests use, reached from the background side.
type bgHarness struct {
	*harness
	// arrived and release are the rendezvous: each child's first model call
	// signals arrived and parks until release closes.
	arrived chan struct{}
	release chan struct{}
	// toolHandle is the concrete delegating tool, for Stop.
	toolHandle *Tool
}

func newBgHarness(t *testing.T, park int) *bgHarness {
	t.Helper()
	bg := &bgHarness{
		arrived: make(chan struct{}, park+2),
		release: make(chan struct{}),
	}
	child := &fakeModel{
		script:     []model.ModelResponse{textResponse("background answer")},
		firstCalls: park,
		arrived:    bg.arrived,
		release:    bg.release,
	}
	h := newHarness(t, child)
	bg.harness = h
	bg.toolHandle = h.handle
	return bg
}

// waitArrived waits for n children to reach their first model call, so "the
// delegation is running" is an observed fact rather than a race the test hopes
// to win.
func (bg *bgHarness) waitArrived(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-bg.arrived:
		case <-time.After(30 * time.Second):
			close(bg.release)
			t.Fatalf("only %d of %d delegations reached the model", i, n)
		}
	}
}

// letGo releases every parked child and waits for the board to absorb them.
func (bg *bgHarness) letGo(t *testing.T) {
	t.Helper()
	close(bg.release)
}

// settle waits until exactly n settlements are collectable.
func (bg *bgHarness) settle(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for bg.board.Uncollected() < n && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if bg.board.Uncollected() < n {
		t.Fatalf("only %d of %d delegations settled in time", bg.board.Uncollected(), n)
	}
}

// firstChildID is the id the first delegation of a fresh parent session gets.
func firstChildID() string { return "sub-20260101-120000-1" }

// minimalTools is a registry with one low-risk tool, enough for a child that
// only ever answers.
func (bg *bgHarness) minimalTools() *tools.Registry {
	registry := tools.NewRegistry()
	if err := registry.Register(tools.Tool{
		Name:         "read_file",
		Description:  "read",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema:       tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path")}, "path"),
		Handler: func(_ context.Context, _ map[string]any) (tools.Result, error) {
			return tools.TextResult("contents"), nil
		},
	}); err != nil {
		return registry
	}
	return registry
}

// TestABackgroundDelegationReturnsBeforeTheChildFinishes is the shape change
// itself: the tool result is the fact of having started, the child is still
// running when the call returns, and the result names the id the collect tool
// takes.
func TestABackgroundDelegationReturnsBeforeTheChildFinishes(t *testing.T) {
	bg := newBgHarness(t, 1)

	done := make(chan toolsResult, 1)
	go func() {
		result, err := bg.tool.Execute(context.Background(), map[string]any{
			"prompt":     "count the widgets",
			"background": true,
		})
		if err != nil {
			t.Errorf("the tool returned an error rather than a result: %v", err)
		}
		done <- toolsResult{text: result.Text}
	}()

	bg.waitArrived(t, 1)

	// The tool result is back while the child is still parked at its model call
	// — the fact this whole change exists to produce.
	result := <-done
	if !strings.Contains(result.text, "已在后台启动") {
		t.Fatalf("the result does not say the delegation started: %q", result.text)
	}
	if !strings.Contains(result.text, firstChildID()) {
		t.Fatalf("the result does not name the child id: %q", result.text)
	}
	if bg.board.Count() != 1 {
		t.Fatalf("board shows %d delegations, want the running one", bg.board.Count())
	}
	if bg.board.BackgroundRunning() != 1 {
		t.Fatalf("background running = %d, want 1", bg.board.BackgroundRunning())
	}
	if bg.board.Uncollected() != 0 {
		t.Fatalf("a running delegation is already collectable: %d", bg.board.Uncollected())
	}

	bg.letGo(t)
	bg.settle(t, 1)
}

// toolsResult carries the fields the assertions read, so the goroutine that
// runs the tool call can hand it back without racing the test.
type toolsResult struct {
	text  string
	audit map[string]any
}

// TestTheCollectedAnswerIsTheWholeResult pins what collection hands over: the
// same rendered text a foreground delegation would have returned as its tool
// result — header, answer, usage line — and collection removes the row.
func TestTheCollectedAnswerIsTheWholeResult(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "count the widgets",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)
	bg.letGo(t)
	bg.settle(t, 1)

	collect, ok := BuildCollect(bg.board)
	if !ok {
		t.Fatal("BuildCollect returned no tool")
	}
	result, err := collect.Execute(context.Background(), map[string]any{"id": firstChildID()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "background answer") {
		t.Fatalf("the collected text lost the answer: %q", result.Text)
	}
	if !strings.Contains(result.Text, "子 agent") {
		t.Fatalf("the collected text lost the header: %q", result.Text)
	}
	if bg.board.Uncollected() != 0 {
		t.Fatalf("collection left %d settlements behind", bg.board.Uncollected())
	}

	// Collecting again is "nothing there", not the same answer twice.
	again, err := collect.Execute(context.Background(), map[string]any{"id": firstChildID()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(again.Text, "没有待收取") {
		t.Fatalf("a second collection did not say the result is gone: %q", again.Text)
	}
}

// TestCollectWithoutAnIDListsWhatIsWaiting covers the no-argument form: it
// lists the waiting ids and never removes anything.
func TestCollectWithoutAnIDListsWhatIsWaiting(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "count the widgets",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)
	bg.letGo(t)
	bg.settle(t, 1)

	collect, _ := BuildCollect(bg.board)
	result, err := collect.Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, firstChildID()) {
		t.Fatalf("the listing lost the id: %q", result.Text)
	}
	if bg.board.Uncollected() != 1 {
		t.Fatal("listing collected the result instead of naming it")
	}
}

// TestCollectWhileRunningReturnsASnapshot pins the wait=false form: a
// still-running delegation is answered with a progress snapshot, clearly not
// a result, and nothing is collected. This is how the parent looks in without
// occupying the call — the alternative, polling a blocking collect every few
// seconds, is what this parameter set exists to remove.
func TestCollectWhileRunningReturnsASnapshot(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "slow work",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	collect, _ := BuildCollect(bg.board)
	result, err := collect.Execute(context.Background(), map[string]any{
		"id": firstChildID(), "wait": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "还没结束") {
		t.Fatalf("a running delegation was not answered as still running: %q", result.Text)
	}
	if status, _ := result.Audit["subagent_status"].(string); status != "running" {
		t.Errorf("audit status = %q, want running", status)
	}
	if bg.board.Uncollected() != 0 {
		t.Error("a wait=false peek collected the result; it should only report progress")
	}
	bg.letGo(t)
	bg.settle(t, 1)
}

// TestCollectWaitsForTheChildToFinish is the whole point of the default: the
// parent asks once, and the answer comes back when the child settles rather
// than when the parent decides to poll again. The collect call is on its own
// goroutine so the test can release the parked child in the middle of the
// wait.
func TestCollectWaitsForTheChildToFinish(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "slow work",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	collect, _ := BuildCollect(bg.board)
	done := make(chan toolsResult, 1)
	go func() {
		result, err := collect.Execute(context.Background(), map[string]any{"id": firstChildID()})
		if err != nil {
			t.Errorf("the collect call returned an error: %v", err)
			return
		}
		done <- toolsResult{text: result.Text, audit: result.Audit}
	}()

	// The child settles while the collect call is still waiting. The wait
	// polls the board, so the next tick after settlement sees the row out of
	// the running table and collects it.
	bg.letGo(t)

	select {
	case result := <-done:
		if !strings.Contains(result.text, "background answer") {
			t.Fatalf("the waited collect returned something other than the answer: %q", result.text)
		}
		if status, _ := result.audit["subagent_status"].(string); status != "collected" {
			t.Errorf("audit status = %q, want collected", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the collect call did not return after the child settled")
	}
	if bg.board.Uncollected() != 0 {
		t.Error("the waited collect left the settlement behind")
	}
}

// TestCollectWaitDeadlineReportsProgress pins the wait's documented end: the
// deadline passes, the answer is a progress snapshot marked as not a result,
// and nothing is collected. A collect that blocked forever would be a second
// background job wearing a collect's name.
func TestCollectWaitDeadlineReportsProgress(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "slow work",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	collect, _ := BuildCollect(bg.board)
	result, err := collect.Execute(context.Background(), map[string]any{
		"id": firstChildID(), "wait": true, "wait_seconds": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "还没结束") {
		t.Fatalf("a deadline-shaped collect did not report progress: %q", result.Text)
	}
	if strings.Contains(result.Text, "background answer") {
		t.Fatal("a timed-out collect handed over an answer the child never produced")
	}
	if bg.board.Uncollected() != 0 {
		t.Error("a timed-out collect collected the result; it should only report progress")
	}
	if bg.board.IsRunning(firstChildID()) == false {
		t.Error("the running delegation was marked settled by a peek; the board lied")
	}
	bg.letGo(t)
	bg.settle(t, 1)
}

// TestCollectWaitHonoursAStop pins the cancellation path: a stop reaches the
// wait through the context, and the result says the wait was cut short rather
// than reporting a deadline that never passed. The audit flag carries the same
// fact for the log, for the reason the jobs board states for its own case.
func TestCollectWaitHonoursAStop(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "slow work",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	collect, _ := BuildCollect(bg.board)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan toolsResult, 1)
	go func() {
		result, err := collect.Execute(ctx, map[string]any{
			"id": firstChildID(), "wait": true,
		})
		if err != nil {
			t.Errorf("the collect call returned an error: %v", err)
			return
		}
		done <- toolsResult{text: result.Text, audit: result.Audit}
	}()

	time.Sleep(300 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if !strings.Contains(result.text, "被中断") {
			t.Fatalf("an interrupted wait was not marked as interrupted: %q", result.text)
		}
		if interrupted, _ := result.audit[tools.InterruptedAuditKey].(bool); !interrupted {
			t.Error("the interrupted collect did not set the interrupted audit flag")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the collect call did not return after its context was cancelled")
	}
	if bg.board.Uncollected() != 0 {
		t.Error("an interrupted collect collected the result")
	}
	bg.letGo(t)
	bg.settle(t, 1)
}

// TestTheBackgroundCapRefusesOnePastIt pins the width bound: one more than the
// cap is refused with a sentence that says what to do.
func TestTheBackgroundCapRefusesOnePastIt(t *testing.T) {
	bg := newBgHarness(t, 2)

	// A second tool with a cap of one, sharing the board so the cap counter is
	// the production one. The registry it hands out is a fresh one with only a
	// read_file in it: the cap test never delegates far enough for the child's
	// tool set to matter.
	handle, built, ok := BuildWithHandle(Config{
		Chat:          bg.child,
		Store:         bg.store,
		Logs:          bg.logs,
		Catalog:       state.Registry{},
		Resolver:      bg.resolver,
		Parent:        bg.parent,
		Tools:         bg.minimalTools(),
		Board:         bg.board,
		Policy:        security.NewPolicy(),
		OnEvent:       func(map[string]any) {},
		MaxDepth:      DefaultMaxDepth,
		MaxBackground: 1,
	})
	if !ok {
		t.Fatal("BuildWithHandle returned no tool")
	}
	_ = handle

	if _, err := built.Execute(context.Background(), map[string]any{
		"prompt": "first", "background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	second, err := built.Execute(context.Background(), map[string]any{
		"prompt": "second", "background": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(second.Text, "上限") {
		t.Fatalf("the second background call was not refused at the cap: %q", second.Text)
	}
	if bg.board.BackgroundRunning() != 1 {
		t.Fatalf("background running = %d, want 1", bg.board.BackgroundRunning())
	}
	bg.letGo(t)
	bg.settle(t, 1)
}

// TestStopCancelsOneBackgroundChild is the per-child stop: the named child
// settles as cancelled with its partial output, and Stop reports what it did.
//
// The child's script makes it call a tool first, because a child that answers
// on its very first model call is over before the cancellation can be
// observed; the tool call is what forces a second step for the cancelled
// context to surface in.
func TestStopCancelsOneBackgroundChild(t *testing.T) {
	bg := newBgHarness(t, 1)
	bg.child.script = []model.ModelResponse{
		toolCallResponse("call-1", "read_file", `{"path":"x"}`),
		textResponse("never"),
	}

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "long task",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)

	if !bg.toolHandle.Stop(firstChildID()) {
		t.Fatal("Stop did not find the running background delegation")
	}
	bg.letGo(t)
	bg.settle(t, 1)

	collect, _ := BuildCollect(bg.board)
	stopped, err := collect.Execute(context.Background(), map[string]any{"id": firstChildID()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stopped.Text, "被中断") {
		t.Fatalf("a stopped child did not settle as cancelled: %q", stopped.Text)
	}

	// Stopping again is false: the child is gone, and saying so is the truth.
	if bg.toolHandle.Stop(firstChildID()) {
		t.Fatal("Stop claimed to stop an already-settled delegation")
	}
}

// TestStopLeavesForegroundAlone pins the boundary of the stop: a foreground id
// is not stoppable through this path — its stop is the turn's interrupt.
func TestStopLeavesForegroundAlone(t *testing.T) {
	bg := newBgHarness(t, 0)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt": "foreground task",
	}); err != nil {
		t.Fatal(err)
	}

	if bg.toolHandle.Stop(firstChildID()) {
		t.Fatal("Stop claimed to stop a foreground delegation")
	}
}

// TestTheChildCannotCollect pins the collect tool out of the child's view: it
// reads the parent's board, so it is withheld with the other session-scoped
// tools.
func TestTheChildCannotCollect(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	if _, err := h.tool.Execute(context.Background(), map[string]any{"prompt": "anything"}); err != nil {
		t.Fatal(err)
	}

	if child.offered("subagent_output") {
		t.Error("the child was offered the collect tool; the board is the parent's")
	}
	if child.offered("subagent") {
		t.Error("the child was offered the delegating tool; it could recurse")
	}
}

// TestTheNoteNamesCollectableWork pins the payload tail: a settled delegation
// appears in the uncollected section with its id, and collecting removes it.
func TestTheNoteNamesCollectableWork(t *testing.T) {
	bg := newBgHarness(t, 1)

	if _, err := bg.tool.Execute(context.Background(), map[string]any{
		"prompt":     "count the widgets",
		"background": true,
	}); err != nil {
		t.Fatal(err)
	}
	bg.waitArrived(t, 1)
	bg.letGo(t)
	bg.settle(t, 1)

	note := bg.board.Note()
	if !strings.Contains(note, "已完成待收取") {
		t.Fatalf("the note does not name the settled delegation: %q", note)
	}
	if !strings.Contains(note, "subagent_output") {
		t.Fatalf("the note does not say how to collect: %q", note)
	}

	bg.board.Collect(firstChildID())
	if strings.Contains(bg.board.Note(), "已完成待收取") {
		t.Fatalf("the note still nags after collection: %q", bg.board.Note())
	}
}
