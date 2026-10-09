package subagent

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The regression tests for the parallel-delegation change.
//
// The change has one shape and three failure modes, and each test here pins one
// of them:
//
//   - the child ids have to be minted without two delegations landing on the
//     same one (a shared counter, not a check-then-use);
//   - the label has to come from the call's own arguments, because the tool is
//     one value and two calls are in flight at once;
//   - the tool a child may not touch has to stay out of its registry — two
//     children writing the parent's metadata map is a fatal process abort, not a
//     lost update.
//
// Every one of them is a **race**, so none of them can be asserted by reading a
// final value: the test has to hold the two goroutines at a point where the
// hazard is live and look then. Sleeping would make the assertion a guess about
// the machine, so the rendezvous in fakeModel is used instead — both children
// park inside their first model call, and the test reads the state that exists
// exactly while they are both there.

// TestMintedChildIDsAreDistinctUnderConcurrency is the check-then-use bug.
//
// `mintChildID` used to look for a free id and take it, which is two steps: two
// goroutines in one batch both find the same free number and both open the same
// session file, so one child's transcript is appended onto the other's. The
// atomic counter is what makes the two steps one.
func TestMintedChildIDsAreDistinctUnderConcurrency(t *testing.T) {
	child := &fakeModel{}
	h := newHarness(t, child)

	tool := &Tool{Config: Config{Parent: h.parent, Store: h.store}}

	const goroutines = 32
	ids := make([]string, goroutines)
	errs := make([]error, goroutines)

	var wait sync.WaitGroup
	for index := 0; index < goroutines; index++ {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			ids[slot], errs[slot] = tool.mintChildID()
		}(index)
	}
	wait.Wait()

	seen := make(map[string]bool, goroutines)
	for index, id := range ids {
		if errs[index] != nil {
			t.Fatalf("mint %d failed: %v", index, errs[index])
		}
		if !IsChildID(id) {
			t.Errorf("minted %q, which is not a child session id", id)
		}
		if seen[id] {
			t.Fatalf("%d goroutines minted %q twice; two children would share one session file", goroutines, id)
		}
		seen[id] = true
	}
}

// TestMintingSkipsIDsThatAlreadyExist is the *other* collision, and it is a
// different one on purpose.
//
// The counter makes ids unique inside one process; it says nothing about a
// previous run, whose ids started at 1 again. A parent that is resumed and
// delegates for the first time would otherwise take `…-1` back from the child
// session a previous process wrote, and the append-only file would be extended
// with an unrelated conversation.
func TestMintingSkipsIDsThatAlreadyExist(t *testing.T) {
	child := &fakeModel{}
	h := newHarness(t, child)

	// Occupy the first few numbers the way a previous run would have.
	const occupied = 5
	for seq := 1; seq <= occupied; seq++ {
		session := state.NewEmptySession(ChildID(h.parent.SessionID, seq))
		if err := h.store.Save(session); err != nil {
			t.Fatalf("could not plant the existing child session %d: %v", seq, err)
		}
	}

	tool := &Tool{Config: Config{Parent: h.parent, Store: h.store}}

	const goroutines = 16
	ids := make([]string, goroutines)
	var wait sync.WaitGroup
	for index := 0; index < goroutines; index++ {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			ids[slot], _ = tool.mintChildID()
		}(index)
	}
	wait.Wait()

	seen := make(map[string]bool, goroutines)
	for _, id := range ids {
		if h.store.Exists(id) {
			t.Fatalf("minted %q, which already holds another run's session", id)
		}
		if seen[id] {
			t.Fatalf("minted %q twice", id)
		}
		seen[id] = true
	}
	// And the occupied numbers really were skipped rather than merely not
	// reported: the smallest minted number has to be past them.
	if seen[ChildID(h.parent.SessionID, 1)] {
		t.Error("the first number was minted over an existing session")
	}
}

// TestTwoDelegationsInOneBatchRunAtOnce is the feature itself, and the three
// things it can get wrong.
//
// Two `subagent` calls in one turn is what the change is for — before it, a tool
// that declared itself interactive-and-not-parallel-safe demoted the whole batch
// and the two ran one after the other. The assertions are the consequences that
// are invisible from the outside: the two children have to be two sessions with
// two ids and their own labels, and the board has to have carried both rows while
// they were alive.
func TestTwoDelegationsInOneBatchRunAtOnce(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	child := &fakeModel{
		script:     []model.ModelResponse{textResponse("first answer"), textResponse("second answer")},
		firstCalls: 2,
		arrived:    arrived,
		release:    release,
	}
	h := newHarness(t, child, sessionScopedStubs()...)

	arguments := []map[string]any{
		{"prompt": "count the widgets", "description": "count widgets"},
		{"prompt": "count the sprockets", "description": "count sprockets"},
	}
	results := make([]tools.Result, len(arguments))
	failures := make([]error, len(arguments))

	var wait sync.WaitGroup
	for index := range arguments {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			results[slot], failures[slot] = h.tool.Execute(context.Background(), arguments[slot])
		}(index)
	}

	// Both children are now parked inside their first model call, which they
	// reach only after announcing themselves on the board. Waiting for both
	// arrivals is what turns "they overlapped" from a guess about scheduling into
	// a fact the test observed.
	for index := 0; index < len(arguments); index++ {
		select {
		case <-arrived:
		case <-time.After(30 * time.Second):
			close(release)
			wait.Wait()
			t.Fatal("the two delegations never reached the model together; the batch ran serially")
		}
	}

	if got := h.board.Count(); got != 2 {
		t.Errorf("the board counted %d in-flight delegations while both were parked, want 2", got)
	}
	labels := map[string]bool{}
	for _, row := range h.board.Panel() {
		label, _ := row["label"].(string)
		labels[label] = true
	}
	for _, want := range []string{"count widgets", "count sprockets"} {
		if !labels[want] {
			t.Errorf("the board never carried a row labelled %q: %v", want, labels)
		}
	}

	close(release)
	wait.Wait()

	// A finished delegation leaves the board, so a badge cannot claim work is
	// still in flight. This is the same property board_test.go pins, checked here
	// on the path that two goroutines went through at once.
	if got := h.board.Count(); got != 0 {
		t.Errorf("the board still counted %d delegations after both finished", got)
	}

	ids := map[string]bool{}
	for index, result := range results {
		if failures[index] != nil {
			t.Fatalf("delegation %d returned an error rather than a result: %v", index, failures[index])
		}
		id, _ := result.Audit["subagent_id"].(string)
		if !IsChildID(id) {
			t.Fatalf("delegation %d reported subagent_id %q, which is not a child id", index, id)
		}
		if ids[id] {
			t.Fatalf("both delegations reported the child id %q; they shared one session", id)
		}
		ids[id] = true
	}
	// The two answers are the two script entries, so neither child received the
	// other's result — an interleaved write would show up here as a duplicate.
	answers := map[string]bool{}
	for _, result := range results {
		switch {
		case strings.Contains(result.Text, "first answer"):
			answers["first answer"] = true
		case strings.Contains(result.Text, "second answer"):
			answers["second answer"] = true
		default:
			t.Errorf("a delegation's result carries neither child's answer: %q", result.Text)
		}
	}
	if len(answers) != 2 {
		t.Errorf("the two delegations did not each get their own answer: %v", answers)
	}

	// The sessions on disk are the other half: two files, each carrying its own
	// task and its own label. A shared label here is exactly the bug the removed
	// `Tool.label` field caused.
	saved := h.store.ListIDs()
	if len(saved) != len(arguments) {
		t.Fatalf("the store holds %v; want one session per delegation", saved)
	}
	byLabel := map[string]*state.Session{}
	for _, id := range saved {
		session, err := h.store.Load(id)
		if err != nil {
			t.Fatalf("child session %s does not load: %v", id, err)
		}
		if depth := DepthOf(session); depth != 1 {
			t.Errorf("child session %s records depth %d, want 1", id, depth)
		}
		label, _ := session.Metadata[LabelKey].(string)
		if label == "" {
			t.Errorf("child session %s records no label", id)
		}
		if _, taken := byLabel[label]; taken {
			t.Fatalf("two child sessions claim the label %q; one delegation wore the other's name", label)
		}
		byLabel[label] = session
	}
	for label, task := range map[string]string{
		"count widgets":   "count the widgets",
		"count sprockets": "count the sprockets",
	} {
		session, found := byLabel[label]
		if !found {
			t.Fatalf("no child session carries the label %q (got %v)", label, saved)
		}
		var texts []string
		for _, message := range session.Messages {
			if text, ok := state.MessageText(message); ok {
				texts = append(texts, text)
			}
		}
		if !strings.Contains(strings.Join(texts, "\n"), task) {
			t.Errorf("the session labelled %q was not given its own task %q", label, task)
		}
	}

	// And no child was offered a tool that writes the delegating session.
	for _, name := range sessionScopedToolNames {
		if child.offered(name) {
			t.Errorf("a child was offered %s; two of them would write the parent's metadata at once", name)
		}
	}
}

// sessionScopedStubs registers the session-scoped tools in the parent's registry
// so that withholding them is something a test can observe.
//
// Without them registered the assertion above would pass vacuously: a tool that
// was never in the parent's registry cannot be missing from the child's.
func sessionScopedStubs() []tools.Tool {
	stubs := make([]tools.Tool, 0, len(sessionScopedToolNames))
	for _, name := range sessionScopedToolNames {
		stubs = append(stubs, tools.Tool{
			Name:        name,
			Description: "a tool that belongs to the delegating session",
			Risk:        security.RiskLow,
			Schema:      tools.ObjectSchema(map[string]any{}),
			Handler: func(_ context.Context, _ map[string]any) (tools.Result, error) {
				return tools.TextResult("this must never run inside a child"), nil
			},
		})
	}
	return stubs
}

// TestConcurrentDelegationsDoNotShareALabel is the narrow version of the same
// bug, kept because it is the one that fails loudly when the label goes back to
// being a field on the tool.
//
// The rendezvous is not used here: the hazard is a value written by one call and
// read by the next, so what matters is that two calls overlap at all, and the
// `firstCalls` gate makes them do so without holding them.
func TestConcurrentDelegationsDoNotShareALabel(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	child := &fakeModel{
		script:     []model.ModelResponse{textResponse("ok"), textResponse("ok")},
		firstCalls: 2,
		arrived:    arrived,
		release:    release,
	}
	h := newHarness(t, child)

	tasks := []map[string]any{
		{"prompt": "the first task", "description": "alpha"},
		{"prompt": "the second task", "description": "beta"},
	}
	var wait sync.WaitGroup
	for index := range tasks {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			if _, err := h.tool.Execute(context.Background(), tasks[slot]); err != nil {
				t.Errorf("delegation %d failed: %v", slot, err)
			}
		}(index)
	}

	for index := 0; index < 2; index++ {
		select {
		case <-arrived:
		case <-time.After(30 * time.Second):
			close(release)
			wait.Wait()
			t.Fatal("the two delegations never overlapped at the model")
		}
	}
	close(release)
	wait.Wait()

	seen := map[string]bool{}
	for _, id := range h.store.ListIDs() {
		session, err := h.store.Load(id)
		if err != nil {
			t.Fatal(err)
		}
		label, _ := session.Metadata[LabelKey].(string)
		if label != "alpha" && label != "beta" {
			t.Fatalf("a child session carries the label %q, which is neither call's", label)
		}
		seen[label] = true
	}
	if !seen["alpha"] || !seen["beta"] {
		t.Fatalf("the two delegations did not each keep their own label: %v", seen)
	}
}
