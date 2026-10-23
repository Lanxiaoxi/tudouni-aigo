package agent

import (
	"fmt"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The render cache is a **correctness** risk disguised as an optimisation: if a
// key matched when the payload had changed, the request would carry message bodies
// that disagree with the levels the budget believes it set — and nothing
// downstream would notice, because the request is still well formed. It would just
// cost more, or show the model less, than the ledger says.
//
// So the tests here are not about speed. They are about the two ways a cache goes
// wrong: serving a stale entry, and failing to serve a valid one.

// cachedHarness is one agent with a ledger and a history of tool messages, which
// is the shape every rule in this file is about.
type cachedHarness struct {
	agent   *Agent
	manager *context.Manager
	session *state.Session
}

// newCachedHarness builds a session whose history holds `rounds` tool results,
// each backed by a real artifact, so rendering them is real work over real bytes.
func newCachedHarness(t *testing.T, rounds int) *cachedHarness {
	t.Helper()
	workspace := t.TempDir()
	store := context.OpenArtifactStore(workspace, nil)
	window := 200_000
	manager := context.NewManager(store, nil, context.NewBudget(&window), nil)

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "prompt"})
	session.Append(map[string]any{"role": "user", "content": "read some files"})
	for index := 0; index < rounds; index++ {
		body := fmt.Sprintf("line %d\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n", index)
		artifact, err := store.Create(body, "read_file", context.ArtifactSource{Tool: "read_file"}, nil)
		if err != nil {
			t.Fatalf("creating artifact %d: %v", index, err)
		}
		manager.Add(artifact.ID, context.AddOptions{Representation: context.RepresentationFull})
		session.Append(map[string]any{
			"role":        "tool",
			"tool_call_id": fmt.Sprintf("c%d", index),
			"artifact_id":  artifact.ID,
			"content":      "[artifact " + artifact.ID + "]",
		})
	}

	agent := New(Config{Chat: &fakeModel{}, Session: session, Context: manager, MaxSteps: 1})
	return &cachedHarness{agent: agent, manager: manager, session: session}
}

// TestTheCachedPayloadMatchesAFreshRender pins the guarantee the cache is allowed
// to make: what it returns is what a render from scratch would have returned.
//
// The comparison runs against a second agent with no cache at all, built over the
// same history and ledger. Comparing against `renderer.RenderMessage` directly
// would only test the renderer, which is not what changed.
func TestTheCachedPayloadMatchesAFreshRender(t *testing.T) {
	h := newCachedHarness(t, 4)

	// Warm the cache.
	first := h.agent.Payload()

	// The same request again, served from the cache.
	second := h.agent.Payload()
	if !sameMessages(first, second) {
		t.Fatal("the cached payload differs from the first one")
	}

	// One more appended message: the cache extends rather than rebuilds, and the
	// result still has to be what a cold render produces.
	h.session.Append(map[string]any{"role": "assistant", "content": "next"})
	grown := h.agent.Payload()

	cold := New(Config{Chat: &fakeModel{}, Session: h.session, Context: h.manager, MaxSteps: 1})
	if want := cold.Payload(); !sameMessages(grown, want) {
		t.Fatalf("the extended payload differs from a cold render:\ngot  %v\nwant %v", grown, want)
	}
}

// TestADegradedItemInvalidatesTheRender is the stale-entry direction, and it is
// the one that would matter: the budget moving a level changes a tool message's
// body, so the cached render of that message is wrong from that instant.
func TestADegradedItemInvalidatesTheRender(t *testing.T) {
	h := newCachedHarness(t, 2)
	before := h.agent.Payload()

	// Drop the ledger's first artifact to the metadata level, which is what the
	// budget does when a request does not fit.
	items := h.manager.State.Items
	if len(items) == 0 {
		t.Fatal("the harness built no ledger items")
	}
	items[0].Representation = context.RepresentationMetadata

	after := h.agent.Payload()
	if sameMessages(before, after) {
		t.Fatal("degrading an item did not change the payload: the render was served " +
			"from a cache that should have been invalidated")
	}

	cold := New(Config{Chat: &fakeModel{}, Session: h.session, Context: h.manager, MaxSteps: 1})
	if want := cold.Payload(); !sameMessages(after, want) {
		t.Fatalf("after degradation the cached payload differs from a cold render:\ngot  %v\nwant %v", after, want)
	}
}

// TestAnEvictedItemInvalidatesTheRender is the same rule one rung further: an
// eviction replaces the body with a sentence saying the body is gone, which is a
// different payload from the body itself.
func TestAnEvictedItemInvalidatesTheRender(t *testing.T) {
	h := newCachedHarness(t, 2)
	before := h.agent.Payload()

	h.manager.State.Items[0].Removed = true
	after := h.agent.Payload()
	if sameMessages(before, after) {
		t.Fatal("evicting an item did not change the payload")
	}
}

// TestTheFixedOverheadIsNotRecomputedPerMessage is the point of the exercise: the
// per-message cost is computed once, and asking for the overhead again over the
// same history does not walk it a second time.
//
// It is asserted through the cache's own state rather than through a timer,
// because a timer would be a flaky test on a loaded machine and this property is
// structural.
func TestTheFixedOverheadIsNotRecomputedPerMessage(t *testing.T) {
	h := newCachedHarness(t, 6)
	first := h.agent.FixedPayloadTokens()
	if len(h.agent.cache.costs) != h.session.MessageCount() {
		t.Fatalf("the cache holds %d costs for %d messages",
			len(h.agent.cache.costs), h.session.MessageCount())
	}

	// A second ask must be answered from the same costs.
	before := len(h.agent.cache.costs)
	if second := h.agent.FixedPayloadTokens(); second != first {
		t.Fatalf("the second answer differs (%d → %d)", first, second)
	}
	if len(h.agent.cache.costs) != before {
		t.Fatalf("the cache grew from %d to %d costs on a repeated read",
			before, len(h.agent.cache.costs))
	}
}

// TestTheCalibrationFactorAppliesToCachedCosts is the one thing that changes per
// step without changing the messages: the ratio the estimator is corrected by.
// Folding it into the cached numbers would make every step a cache miss, so it is
// applied at the end — and this pins that it really is applied.
func TestTheCalibrationFactorAppliesToCachedCosts(t *testing.T) {
	h := newCachedHarness(t, 2)
	plain := h.agent.FixedPayloadTokens()

	// A factor of two says "the estimator undercounts by half". Every scaled cost
	// has to double; the fixed overheads (message overhead, picture prices) must
	// not, because they are not estimates of text.
	h.manager.Budget.Calibrate(10_000, 20_000)
	doubled := h.agent.FixedPayloadTokens()
	if doubled <= plain {
		t.Fatalf("calibrating the budget up did not raise the estimate (%d → %d)", plain, doubled)
	}
	// And the cache was not thrown away for it: the costs are still one per message.
	if len(h.agent.cache.costs) != h.session.MessageCount() {
		t.Fatalf("the calibration discarded the cache: %d costs for %d messages",
			len(h.agent.cache.costs), h.session.MessageCount())
	}
}

// sameMessages compares two payloads by their content, since the maps themselves
// are shared by design on the picture-free path.
func sameMessages(left, right []map[string]any) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if fmt.Sprint(left[index]["role"]) != fmt.Sprint(right[index]["role"]) {
			return false
		}
		if fmt.Sprint(left[index]["content"]) != fmt.Sprint(right[index]["content"]) {
			return false
		}
	}
	return true
}
