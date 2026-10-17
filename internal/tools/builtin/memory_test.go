package builtin

import (
	"context"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/memory"
)

// memoryToolsFor builds the three tools over a fresh workspace memory.
func memoryToolsFor(t *testing.T) (MemoryTools, *memory.Workspace) {
	t.Helper()
	store, err := memory.Open(t.TempDir())
	if err != nil {
		t.Fatalf("opening workspace memory: %v", err)
	}
	return NewMemoryTools(store), store
}

// call finds and executes one tool from the set.
func runMemoryTool(t *testing.T, set MemoryTools, name string, args map[string]any) (string, map[string]any) {
	t.Helper()
	for _, tool := range set.All {
		if tool.Name != name {
			continue
		}
		result, err := tool.Execute(context.Background(), args)
		if err != nil {
			t.Fatalf("%s(%v): %v", name, args, err)
		}
		return result.Text, result.Audit
	}
	t.Fatalf("no tool called %s", name)
	return "", nil
}

// publishOne proposes and approves a memory directly through the store, which is what
// the review queue would do.
func publishOne(t *testing.T, store *memory.Workspace, proposal memory.Proposal) *memory.Entry {
	t.Helper()
	id, err := store.Propose(proposal)
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	entry, err := store.Publish(id)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	return entry
}

func TestMemorySearchToolFindsAPublishedMemory(t *testing.T) {
	set, store := memoryToolsFor(t)
	entry := publishOne(t, store, memory.Proposal{
		Title:    "Android 构建中的 JDK 版本兼容问题",
		Body:     "先看 Gradle Wrapper 和 JDK 的版本兼容关系。",
		Triggers: []string{"Could not determine java version"},
		Tags:     []string{"gradle"},
		// Verified on purpose: the tool must report it, because the model is expected to
		// weigh a verified note differently from an inferred one.
		Confidence: memory.ConfidenceVerified,
	})

	text, audit := runMemoryTool(t, set, "memory_search", map[string]any{
		"query": "Could not determine java version from '21.0.1'",
	})
	if !strings.Contains(text, entry.ID) {
		t.Errorf("the result does not name the id, so memory_get cannot be called:\n%s", text)
	}
	if !strings.Contains(text, "verified") {
		t.Errorf("the result does not carry the confidence:\n%s", text)
	}
	if !strings.Contains(text, "命中原因") {
		t.Errorf("the result does not say why it matched, so the model cannot judge whether it applies:\n%s", text)
	}
	if results, _ := audit["results"].(int); results != 1 {
		t.Errorf("audit results = %v, want 1", audit["results"])
	}
}

// TestMemorySearchToolSaysNothingRatherThanInventing: an empty answer must be an
// explicit "there is nothing", because a model that reads silence tends to fill it.
func TestMemorySearchToolSaysNothingRatherThanInventing(t *testing.T) {
	set, _ := memoryToolsFor(t)
	text, audit := runMemoryTool(t, set, "memory_search", map[string]any{"query": "完全无关的事情"})
	if !strings.Contains(text, "没有匹配") {
		t.Errorf("an empty search did not say so:\n%s", text)
	}
	if results, _ := audit["results"].(int); results != 0 {
		t.Errorf("audit results = %v, want 0", audit["results"])
	}
}

func TestMemoryGetToolReturnsTheWholeBody(t *testing.T) {
	set, store := memoryToolsFor(t)
	entry := publishOne(t, store, memory.Proposal{
		Title: "标题", Body: "第一段。\n\n第二段，最后一句。", Confidence: memory.ConfidenceObserved,
	})

	text, _ := runMemoryTool(t, set, "memory_get", map[string]any{"id": entry.ID})
	for _, want := range []string{"第一段。", "第二段，最后一句。", entry.ID, "observed"} {
		if !strings.Contains(text, want) {
			t.Errorf("the answer is missing %q:\n%s", want, text)
		}
	}
}

func TestMemoryGetToolRefusesAnUnknownID(t *testing.T) {
	set, _ := memoryToolsFor(t)
	for _, tool := range set.All {
		if tool.Name != "memory_get" {
			continue
		}
		if _, err := tool.Execute(context.Background(), map[string]any{"id": "mem_999"}); err == nil {
			t.Fatal("reading a nonexistent memory succeeded")
		}
	}
}

// TestMemoryProposeToolOnlyQueues is the permission boundary, asserted where the model
// touches it: proposing must not publish.
func TestMemoryProposeToolOnlyQueues(t *testing.T) {
	set, store := memoryToolsFor(t)

	text, audit := runMemoryTool(t, set, "memory_propose", map[string]any{
		"title":      "npm 拉不动依赖时先看代理",
		"body":       "子进程里也要有 HTTPS_PROXY。",
		"triggers":   []any{"npm ERR! network"},
		"tags":       []any{"npm"},
		"confidence": "observed",
	})
	if id, _ := audit["proposal"].(string); id == "" {
		t.Fatalf("the audit does not name the proposal: %v", audit)
	}
	// The sentence the model reads has to say "not in effect yet": a model that believes
	// it has just written a memory will stop trying to remember.
	if !strings.Contains(text, "还没有生效") {
		t.Errorf("the answer does not say the proposal is inert:\n%s", text)
	}
	if results, err := store.Search(memory.Query{Text: "npm ERR! network"}); err != nil || len(results) != 0 {
		t.Fatalf("a proposal was already retrievable: %d results, %v", len(results), err)
	}
	candidates, err := store.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("Candidates = %d, %v; want 1", len(candidates), err)
	}
}

// TestMemoryProposeToolUpdatesByID: an update proposal has to carry the revision the
// model read, and a stale one has to be refused at publish time rather than silently
// winning.
func TestMemoryProposeToolUpdatesByID(t *testing.T) {
	set, store := memoryToolsFor(t)
	entry := publishOne(t, store, memory.Proposal{
		Title: "旧结论", Body: "原来的做法。", Confidence: memory.ConfidenceObserved,
	})

	if _, audit := runMemoryTool(t, set, "memory_propose", map[string]any{
		"op":                "update",
		"entry_id":          entry.ID,
		"expected_revision": entry.Revision,
		"title":             "新结论",
		"body":              "现在的做法。",
	}); audit["op"] != "update" {
		t.Fatalf("audit = %v", audit)
	}

	candidates, err := store.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("Candidates = %d, %v", len(candidates), err)
	}
	candidate := candidates[0]
	if candidate.TargetID != entry.ID || candidate.ExpectedRevision != entry.Revision {
		t.Errorf("the proposal lost its target or revision: %+v", candidate)
	}
	if candidate.Title != "新结论" || !strings.Contains(candidate.Body, "现在的做法") {
		t.Errorf("the proposal does not carry the new text: %+v", candidate)
	}
}

func TestMemoryProposeToolCanProposeADeprecation(t *testing.T) {
	set, store := memoryToolsFor(t)
	entry := publishOne(t, store, memory.Proposal{
		Title: "过时的坑", Body: "已经修好了。", Confidence: memory.ConfidenceObserved,
	})
	if _, audit := runMemoryTool(t, set, "memory_propose", map[string]any{
		"op":       "deprecate",
		"entry_id": entry.ID,
		"title":    "过时的坑",
		"body":     "新版本已经修复",
		"reason":   "新版本已经修复",
	}); audit["op"] != "deprecate" {
		t.Fatalf("audit = %v", audit)
	}
	candidates, _ := store.Candidates()
	if len(candidates) != 1 || candidates[0].Op != memory.OpDeprecate {
		t.Fatalf("candidates = %+v", candidates)
	}
	// Still active until somebody publishes the deprecation.
	if _, err := store.Get(entry.ID); err != nil {
		t.Errorf("the memory vanished before its deprecation was approved: %v", err)
	}
}

func TestMemoryToolsNeedAStore(t *testing.T) {
	if set := NewMemoryTools(nil); len(set.All) != 0 || set.Store != nil {
		t.Fatalf("a nil store produced tools: %+v", set)
	}
}
