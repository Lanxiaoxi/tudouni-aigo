package runtime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/memory"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// openMemoryForTest gives each test its own workspace memory.
//
// It is deliberately not a whole runtime: `recallForTurn` / `onToolResult` /
// `memoryNote` only touch the memory subsystem, and assembling a runtime needs a model
// catalogue and a network — neither of which has anything to do with what is tested
// here.
func openMemoryForTest(t *testing.T) *memory.Workspace {
	t.Helper()
	store, err := memory.Open(t.TempDir())
	if err != nil {
		t.Fatalf("opening workspace memory: %v", err)
	}
	return store
}

// publishMemory proposes and approves one memory, which is the state every test needs.
func publishMemory(t *testing.T, store *memory.Workspace, proposal memory.Proposal) *memory.Entry {
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

func newMemoryToolsForTest(store *memory.Workspace) []tools.Tool {
	return builtin.NewMemoryTools(store).All
}

// TestMemoryRecallInjectsATriggerMatch is the turn-start path: the person's own words
// hit a trigger, and the memory ends up in the payload tail.
func TestMemoryRecallInjectsATriggerMatch(t *testing.T) {
	store := openMemoryForTest(t)
	entry := publishMemory(t, store, memory.Proposal{
		Title:      "Android 构建中的 JDK 版本兼容问题",
		Body:       "先看 Gradle Wrapper 和 JDK 的版本兼容关系，不要直接假定缓存损坏。",
		Triggers:   []string{"Could not determine java version"},
		Tags:       []string{"gradle"},
		Confidence: memory.ConfidenceVerified,
	})

	value := &Runtime{
		WorkspaceMemory: store,
		SessionIDValue:  "s-test",
		// A real session, because the assertion below is about `notes()` — the one path
		// every request takes — and that function reads the task list off the session's
		// metadata. Testing `memoryNote()` alone would leave "does it actually reach the
		// payload" unanswered.
		SessionValue: state.NewSession("s-test", t.TempDir()),
	}
	value.recallForTurn("跑构建时报错：Could not determine java version from '21.0.1'")

	note := value.memoryNote()
	if !strings.Contains(note, entry.ID) {
		t.Fatalf("the recalled memory is not in the payload tail:\n%s", note)
	}
	if !strings.Contains(note, "JDK") {
		t.Errorf("the block does not carry the body:\n%s", note)
	}
	// The header is load-bearing: it is the sentence that stops the model treating a
	// memory as current fact.
	if !strings.Contains(note, "不是当前事实") {
		t.Errorf("the block does not say that a memory is history rather than fact:\n%s", note)
	}
	if whole := value.notes(); !strings.Contains(whole, entry.ID) {
		t.Errorf("the memory block never reaches the payload tail:\n%s", whole)
	}
}

// TestMemoryRecallSkipsAnUnrelatedTurn is the "a memory that exists is not a memory that
// is relevant" rule, at the integration level.
func TestMemoryRecallSkipsAnUnrelatedTurn(t *testing.T) {
	store := openMemoryForTest(t)
	publishMemory(t, store, memory.Proposal{
		Title: "gradle daemon 崩了", Body: "把 daemon 关掉再试。",
		Triggers: []string{"gradle daemon disappeared"}, Confidence: memory.ConfidenceVerified,
	})

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.recallForTurn("帮我写一个 README 的目录结构")
	if note := value.memoryNote(); note != "" {
		t.Fatalf("an unrelated turn injected a memory:\n%s", note)
	}
}

// TestMemoryTurnResetDropsThePreviousTurn: one turn's recall must not leak into the next,
// or a session discussing Android would carry that note for its whole life.
func TestMemoryTurnResetDropsThePreviousTurn(t *testing.T) {
	store := openMemoryForTest(t)
	entry := publishMemory(t, store, memory.Proposal{
		Title: "gradle 版本问题", Body: "看 wrapper。",
		Triggers: []string{"gradle version mismatch"}, Confidence: memory.ConfidenceVerified,
	})

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.recallForTurn("gradle version mismatch")
	if !strings.Contains(value.memoryNote(), entry.ID) {
		t.Fatal("the first turn did not recall the memory")
	}
	value.recallForTurn("今天天气不错")
	if note := value.memoryNote(); note != "" {
		t.Fatalf("the previous turn's memory survived into the next one:\n%s", note)
	}
}

// TestMemoryToolFailureRecall is the second trigger. The full result text is used, and
// only for real failures: `denied` is a decision by the person and `interrupted` is not a
// verdict at all.
func TestMemoryToolFailureRecall(t *testing.T) {
	store := openMemoryForTest(t)
	publishMemory(t, store, memory.Proposal{
		Title:      "npm 拉不动依赖时代理没生效",
		Body:       "先确认 HTTPS_PROXY 在子进程里也在。",
		Triggers:   []string{"ECONNREFUSED 127.0.0.1:7890"},
		Confidence: memory.ConfidenceVerified,
	})

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.memory.reset()

	// A successful call recalls nothing.
	value.onToolResult("shell", "ok", "all good", false)
	if note := value.memoryNote(); note != "" {
		t.Fatalf("a successful tool call recalled a memory:\n%s", note)
	}
	// A denied call is a decision, not a failure to learn from.
	value.onToolResult("shell", "denied", "ECONNREFUSED 127.0.0.1:7890", false)
	if note := value.memoryNote(); note != "" {
		t.Fatalf("a denied tool call recalled a memory:\n%s", note)
	}
	// The real thing: the error text arrives after a lot of noise, which is the case the
	// audit's two-hundred-character preview cannot serve.
	value.onToolResult("shell", "error",
		strings.Repeat("noise\n", 40)+"npm ERR! network ECONNREFUSED 127.0.0.1:7890", false)
	note := value.memoryNote()
	if !strings.Contains(note, "npm 拉不动依赖时代理没生效") {
		t.Fatalf("a tool failure did not recall the matching memory:\n%s", note)
	}
}

// TestMemorySemanticFailureRecall is the case the design originally intended: the
// shell tool ran without error (status == "ok"), but the command exited non-zero.
// The SemanticFailure flag is what lets this trigger fire — without it, every
// non-zero exit code would be an ordinary "ok" result and the trigger would never
// see them.
func TestMemorySemanticFailureRecall(t *testing.T) {
	store := openMemoryForTest(t)
	publishMemory(t, store, memory.Proposal{
		Title:      "npm 拉不动依赖时代理没生效",
		Body:       "先确认 HTTPS_PROXY 在子进程里也在。",
		Triggers:   []string{"ECONNREFUSED 127.0.0.1:7890"},
		Confidence: memory.ConfidenceVerified,
	})

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.memory.reset()

	// A shell command that exited non-zero is status "ok" — the tool did not
	// break — but semanticFailure is true, so the recall fires.
	value.onToolResult("shell", "ok",
		"exit code 1\nnpm ERR! network ECONNREFUSED 127.0.0.1:7890", true)
	note := value.memoryNote()
	if !strings.Contains(note, "npm 拉不动依赖时代理没生效") {
		t.Fatalf("a semantic failure did not recall the matching memory:\n%s", note)
	}
}

// TestMemoryDisabledInjectsNothing: the injection switches are honoured at the injection
// point, not only at the store.
func TestMemoryDisabledInjectsNothing(t *testing.T) {
	store := openMemoryForTest(t)
	publishMemory(t, store, memory.Proposal{
		Title: "gradle 版本问题", Body: "看 wrapper。",
		Triggers: []string{"gradle version mismatch"}, Confidence: memory.ConfidenceVerified,
	})
	config := store.Config()
	config.AutoInject = false
	if _, _, err := store.SaveConfig(config); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.recallForTurn("gradle version mismatch")
	if note := value.memoryNote(); note != "" {
		t.Fatalf("auto_inject=false still injected:\n%s", note)
	}
	// The store itself still answers — that is the difference between the recall
	// triggers and the explicit tool.
	results, err := store.Search(memory.Query{Text: "gradle version mismatch"})
	if err != nil || len(results) != 1 {
		t.Fatalf("Search = %d, %v; want the memory still findable", len(results), err)
	}
}

// TestMemoryNoteRespectsTheBudget: one memory's body is cut to `entry_chars`, and the
// whole block stops at `note_chars`.
func TestMemoryNoteRespectsTheBudget(t *testing.T) {
	store := openMemoryForTest(t)
	long := strings.Repeat("很长的正文。", 400)
	for index := 0; index < 4; index++ {
		publishMemory(t, store, memory.Proposal{
			Title: "标题 " + strings.Repeat("x", index+1),
			Body:  long, Triggers: []string{"共同的触发线索"}, Confidence: memory.ConfidenceVerified,
		})
	}
	config := store.Config()
	config.MaxRecall = 3
	config.EntryChars = 200
	config.NoteChars = 700
	if _, _, err := store.SaveConfig(config); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	value := &Runtime{WorkspaceMemory: store, SessionIDValue: "s-test"}
	value.recallForTurn("看到错误：共同的触发线索")
	note := value.memoryNote()
	if note == "" {
		t.Fatal("nothing was injected")
	}
	entries := strings.Count(note, "### ")
	if entries == 0 || entries > 3 {
		t.Errorf("injected %d entries, want 1..3", entries)
	}
	// The header is not counted against the budget — it is the sentence that says how to
	// read the block — so the assertion allows for it.
	if runes := len([]rune(note)); runes > 1400 {
		t.Errorf("the block is %d runes, far past the 700-rune budget", runes)
	}
}

// TestTheStatePayloadCarriesTheMemoryCandidateCount is the regression for the
// workbench badge staying empty after a `memory_propose`.
//
// `memory_propose` is a tool, and the only snapshot a tool result re-states is
// `ui(state)`. The full snapshot travels on `ui(memory)`, which a front end only
// asks for when the panel is open — so a badge reading the panel snapshot alone
// learned about the queue at the one moment it was already being looked at.
// The count must ride on the state snapshot instead.
func TestTheStatePayloadCarriesTheMemoryCandidateCount(t *testing.T) {
	session := state.NewEmptySession("s")
	store := openMemoryForTest(t)
	runtimeValue := statePanelRuntime(session)
	runtimeValue.WorkspaceMemory = store

	count := func() int {
		t.Helper()
		payload := runtimeValue.StateMessage(false)
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("the state payload does not encode: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("the state payload does not decode: %v", err)
		}
		got, ok := decoded["memory_pending"].(float64)
		if !ok {
			t.Fatalf("memory_pending is %T on the wire, want an integer", decoded["memory_pending"])
		}
		return int(got)
	}

	if got := count(); got != 0 {
		t.Errorf("an empty queue reported %d candidates, want 0", got)
	}
	for _, title := range []string{"第一条提案", "第二条提案"} {
		if _, err := store.Propose(memory.Proposal{Title: title, Body: "正文。"}); err != nil {
			t.Fatalf("Propose: %v", err)
		}
	}
	if got := count(); got != 2 {
		t.Errorf("after two proposals the state payload reported %d, want 2", got)
	}
	id, err := store.Propose(memory.Proposal{Title: "第三条提案", Body: "正文。"})
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	if _, err := store.Publish(id); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := count(); got != 2 {
		t.Errorf("after publishing one of three, the state payload reported %d, want 2", got)
	}
}

// TestMemoryPendingWithoutAMemorySystem: a runtime that could not open its
// memory directory is not "a runtime that is hiding a count" — it reports zero,
// never an error, and the state snapshot's shape stays the same.
func TestMemoryPendingWithoutAMemorySystem(t *testing.T) {
	runtimeValue := statePanelRuntime(state.NewEmptySession("s"))
	if got := runtimeValue.memoryPending(); got != 0 {
		t.Errorf("a runtime without memory reported %d pending candidates, want 0", got)
	}
}

// TestMemoryToolsAreRegisteredOnlyWhenMemoryOpens: a tool the model can see but that
// always fails is a tool that teaches it tools lie.
func TestMemoryToolsAreRegisteredOnlyWhenMemoryOpens(t *testing.T) {
	if tools := newMemoryToolsForTest(nil); len(tools) != 0 {
		t.Fatalf("a nil store produced %d tools", len(tools))
	}
	if tools := newMemoryToolsForTest(openMemoryForTest(t)); len(tools) != 3 {
		t.Fatalf("a live store produced %d tools, want 3", len(tools))
	}
}
