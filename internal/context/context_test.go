package context

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The behaviour contracts this package has to hold, taken from the invariants the
// Python tests fixed in place. They are not "does the code run" tests: each one
// pins a rule that, when it breaks, produces a session that looks fine and costs
// fifty times more per turn — or one where the model quietly stops seeing
// information it already had.

// harness wires a store, a manager and a renderer over a temp directory.
type harness struct {
	store    *ArtifactStore
	manager  *Manager
	renderer *Renderer
}

func newHarness(t *testing.T, window *int) *harness {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "artifacts")
	store := OpenArtifactStore(dir, nil)
	manager := NewManager(store, nil, NewBudget(window), nil)
	return &harness{store: store, manager: manager, renderer: NewRenderer(store, manager)}
}

func (h *harness) add(t *testing.T, text string, options AddOptions) Artifact {
	t.Helper()
	artifact, err := h.store.Create(text, "file", ArtifactSource{Tool: "read_file"},
		map[string]any{"lines": CountLines(text)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	h.manager.Add(artifact.ID, options)
	return artifact
}

func windowOf(tokens int) *int { return &tokens }

// bigText is a body large enough that every level is meaningfully smaller.
func bigText(lines int) string {
	var builder strings.Builder
	for index := 0; index < lines; index++ {
		builder.WriteString(fmt.Sprintf("第 %d 行：这一行是用来撑大正文的中文内容，用来验证降级真的把 token 降下来了。\n", index+1))
	}
	return builder.String()
}

// TestDegradationLadderActuallyShrinks ...
//
// "The level changed" and "the payload got smaller" are different statements, and
// the first version of this system only ever checked the first one. A range level
// that still carries the full file's line bounds renders the whole file: the level
// moves, the token count does not, and neither the log nor the level tells you.
func TestDegradationLadderActuallyShrinks(t *testing.T) {
	h := newHarness(t, windowOf(12000))
	h.add(t, bigText(400), AddOptions{})

	render := h.renderer.RenderItem
	var ladder []string
	previous := h.manager.Estimate(render, 0)
	ladder = append(ladder, string(h.manager.Items()[0].Representation))

	for pass := 0; pass < 8; pass++ {
		if len(h.manager.Fit(render, 0)) == 0 {
			break
		}
		item := h.manager.Items()[0]
		current := h.manager.Estimate(render, 0)
		if item.Representation != RepresentationMetadata && !item.Removed {
			if current >= previous {
				t.Fatalf("step to %s did not shrink: %d → %d",
					item.Representation, previous, current)
			}
		}
		previous = current
		ladder = append(ladder, string(item.Representation))
		if item.Removed {
			ladder[len(ladder)-1] = "removed"
			break
		}
	}

	// The ladder is allowed to stop early: single-step mode deliberately stops as
	// soon as it fits, because the levels below would be information thrown away
	// for nothing. What has to hold is that it walks the ladder in order and never
	// skips a rung, and that every rung it does take shrinks the payload.
	if len(ladder) < 2 {
		t.Fatal("nothing degraded at all")
	}
	want := []string{"full", "range", "preview", "metadata", "removed"}
	for index, step := range ladder {
		if index >= len(want) || step != want[index] {
			t.Fatalf("ladder was %v, which is not a prefix of %v", ladder, want)
		}
	}
}

// TestEvictionIsTheLastRung ...
//
// Removing an item from the context is the step after metadata and nothing else —
// the item stays in the list with Removed set rather than being deleted, because an
// artifact that bottomed out must not reappear when the budget loosens.
func TestEvictionIsTheLastRung(t *testing.T) {
	h := newHarness(t, windowOf(4100)) // effective limit lands at a few dozen tokens
	artifact := h.add(t, bigText(400), AddOptions{})
	render := h.renderer.RenderItem

	seen := map[string]bool{}
	for pass := 0; pass < 10; pass++ {
		h.manager.Fit(render, 0)
		item := h.manager.Item(artifact.ID)
		seen[string(item.Representation)] = true
		if item.Removed {
			break
		}
	}

	item := h.manager.Item(artifact.ID)
	if !item.Removed {
		t.Fatalf("degraded through %v and never evicted", seen)
	}
	if _, still := h.store.Get(artifact.ID); !still {
		t.Fatal("eviction deleted the artifact; it is supposed to leave the body on disk")
	}
}

// TestSingleLineBodyStillDegrades ...
//
// Line count is the first gate and it does nothing for minified JSON, a log built
// by joining an array, or anything without newlines: that splits into one line, so
// "give it 20 lines" is the whole body. Only the character gate catches it.
func TestSingleLineBodyStillDegrades(t *testing.T) {
	h := newHarness(t, windowOf(12000))
	h.add(t, strings.Repeat("没有换行的很长正文，", 4000), AddOptions{})

	render := h.renderer.RenderItem
	before := h.manager.Estimate(render, 0)
	h.manager.Fit(render, 0)
	after := h.manager.Estimate(render, 0)

	if after >= before {
		t.Fatalf("a single-line body did not shrink: %d → %d", before, after)
	}
}

// TestLevelsNeverComeBack asserts the one-way rule.
//
// `full → range → full` makes the rendered prompt differ every round, and the
// provider's prefix cache is computed over the longest common prefix — every token
// after the first changed byte is billed as a miss, at roughly fifty times the
// price. So a step that has headroom must not restore detail.
func TestLevelsNeverComeBack(t *testing.T) {
	h := newHarness(t, windowOf(12000))
	h.add(t, bigText(400), AddOptions{})
	render := h.renderer.RenderItem

	h.manager.Fit(render, 0)
	dropped := h.manager.Items()[0].Representation
	if dropped == RepresentationFull {
		t.Fatal("nothing degraded, so the test cannot prove anything")
	}

	// Plenty of room now. The level must not move back.
	h.manager.Budget.MaxTokens = windowOf(1_000_000)
	h.manager.Fit(render, 0)

	if got := h.manager.Items()[0].Representation; got != dropped {
		t.Fatalf("level came back up: %s → %s", dropped, got)
	}
}

// TestPinnedItemsAreNotTouched: pinned means "do not touch it even when tokens run
// short", and the system prompt and the task depend on it.
func TestPinnedItemsAreNotTouched(t *testing.T) {
	h := newHarness(t, windowOf(12000))
	pinned := h.add(t, bigText(400), AddOptions{Pinned: true})
	render := h.renderer.RenderItem

	for pass := 0; pass < 6; pass++ {
		h.manager.Fit(render, 0)
	}

	item := h.manager.Item(pinned.ID)
	if item.Representation != RepresentationFull || item.Removed {
		t.Fatalf("a pinned item moved: level=%s removed=%v", item.Representation, item.Removed)
	}
}

// TestUnknownWindowMeansNoDegradation ...
//
// A made-up ceiling is worse than none: it degrades a context that would have fit,
// and "why can the model not see the whole file" then has no answer anywhere.
func TestUnknownWindowMeansNoDegradation(t *testing.T) {
	h := newHarness(t, nil)
	h.add(t, bigText(400), AddOptions{})
	render := h.renderer.RenderItem

	if degraded := h.manager.Fit(render, 0); len(degraded) != 0 {
		t.Fatalf("degraded %d items with an unknown window", len(degraded))
	}
	if got := h.manager.Items()[0].Representation; got != RepresentationFull {
		t.Fatalf("level moved to %s with an unknown window", got)
	}
}

// TestDegradeOrderIsDetermined: the same input must move the same item twice, or
// two restores of one session produce different contexts. The tie-break on
// artifact id is what makes the order total.
func TestDegradeOrderIsDetermined(t *testing.T) {
	build := func() []*ContextItem {
		items := []*ContextItem{
			{ArtifactID: "art_c", Priority: 0, Zone: ZoneDynamic, Sequence: 2},
			{ArtifactID: "art_a", Priority: 0, Zone: ZoneDynamic, Sequence: 1},
			{ArtifactID: "art_b", Priority: 0, Zone: ZoneStable, Sequence: 3},
		}
		return items
	}
	budget := NewBudget(windowOf(1000))

	first := budget.next(build())
	second := budget.next(build())
	if first.ArtifactID != second.ArtifactID {
		t.Fatalf("order is not determined: %s vs %s", first.ArtifactID, second.ArtifactID)
	}
	// dynamic before stable, and the oldest dynamic one wins.
	if first.ArtifactID != "art_a" {
		t.Fatalf("picked %s, expected the oldest dynamic item art_a", first.ArtifactID)
	}
}

// TestCalibrationIgnoresSmallSamples ...
//
// In a 200-token request the absolute error is tiny while the ratio can be absurd
// (180 estimated against 220 measured gives 1.22). Letting that loose would skew
// every request for the next few hundred thousand tokens.
func TestCalibrationIgnoresSmallSamples(t *testing.T) {
	budget := NewBudget(windowOf(100_000))
	before := budget.Factor()

	if got := budget.Calibrate(180, 220); got != before {
		t.Fatalf("a small sample moved the factor: %v → %v", before, got)
	}
	if got := budget.Calibrate(50_000, 90_000); got == before {
		t.Fatalf("a large sample did not move the factor (still %v)", got)
	}
	if got := budget.Factor(); got > 3.0 || got < 0.33 {
		t.Fatalf("factor %v escaped its clamp", got)
	}
}

// TestIdenticalContentAndSourceIsReused: writing the same body twice is free, and
// the id is derived from content so that the rendered prompt is stable between
// runs.
func TestIdenticalContentAndSourceIsReused(t *testing.T) {
	h := newHarness(t, nil)
	source := ArtifactSource{Tool: "read_file", Path: "a.txt"}

	first, err := h.store.Create("同一个文件的内容", "file", source, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.store.Create("同一个文件的内容", "file", source, nil)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != second.ID {
		t.Fatalf("the same content and source produced two artifacts: %s, %s", first.ID, second.ID)
	}
	if h.store.Len() != 1 {
		t.Fatalf("store holds %d artifacts, want 1", h.store.Len())
	}
}

// TestSameContentDifferentSourceStaysSeparate ...
//
// They are two different events, and merging them loses which file was actually
// read — which is the first thing anybody asks afterwards.
func TestSameContentDifferentSourceStaysSeparate(t *testing.T) {
	h := newHarness(t, nil)
	body := "两个文件恰好一样的内容"

	first, err := h.store.Create(body, "file", ArtifactSource{Tool: "read_file", Path: "a.txt"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.store.Create(body, "file", ArtifactSource{Tool: "read_file", Path: "b.txt"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID == second.ID {
		t.Fatalf("two sources collapsed into one artifact: %s", first.ID)
	}
	if !strings.HasSuffix(second.ID, "-2") {
		t.Fatalf("the second artifact is %s, expected a -2 suffix", second.ID)
	}
}

// TestHistoryCarriesAReferenceNotABody is the reason this layer exists.
func TestHistoryCarriesAReferenceNotABody(t *testing.T) {
	h := newHarness(t, nil)
	body := bigText(200)
	artifact := h.add(t, body, AddOptions{})

	reference := BuildReference(artifact.ID, artifact.Chars, "read_file")
	if strings.Contains(reference, "第 1 行") {
		t.Fatal("the reference line contains the body")
	}
	if !strings.Contains(reference, artifact.ID) {
		t.Fatalf("the reference does not name the artifact: %q", reference)
	}
	if !strings.Contains(reference, "字符") {
		t.Fatalf("the reference does not say how big the body is: %q", reference)
	}
	if got := ParseReference(reference); got != artifact.ID {
		t.Fatalf("reference did not round-trip: got %q", got)
	}
}

// TestFullLevelRendersTheBodyVerbatim ...
//
// The payload shape has to stay byte-identical to before this layer existed: a
// full-level render adds nothing, which is also what keeps the prefix cache warm
// for every artifact that has not been degraded.
func TestFullLevelRendersTheBodyVerbatim(t *testing.T) {
	h := newHarness(t, nil)
	body := bigText(5)
	artifact := h.add(t, body, AddOptions{})

	item := h.manager.Item(artifact.ID)
	rendered := h.renderer.RenderItem(item)
	if rendered != body {
		t.Fatalf("full level added something:\nwant %q\ngot  %q", body, rendered)
	}
}

// TestDegradedLevelsSaySoOutLoud ...
//
// A model that sees half the content and believes it saw all of it is the one
// silent failure this layer can produce. The header is its only evidence.
func TestDegradedLevelsSaySoOutLoud(t *testing.T) {
	h := newHarness(t, windowOf(12000))
	artifact := h.add(t, bigText(400), AddOptions{})
	render := h.renderer.RenderItem

	h.manager.Fit(render, 0)
	item := h.manager.Item(artifact.ID)
	if item.Representation != RepresentationRange {
		t.Fatalf("expected the first step to reach range, got %s", item.Representation)
	}

	rendered := h.renderer.RenderItem(item)
	if !strings.Contains(rendered, "共 400 行") {
		t.Fatalf("the range header does not state the total:\n%s", firstLines(rendered, 3))
	}
	if !strings.Contains(rendered, "行") {
		t.Fatalf("the range header does not state the interval:\n%s", firstLines(rendered, 3))
	}
}

// TestEvictedReferenceStillRendersASentence ...
//
// An empty string would read as "this tool returned nothing", which is a wrong
// conclusion that sends the model down a needless path to redo the work.
func TestEvictedReferenceStillRendersASentence(t *testing.T) {
	h := newHarness(t, nil)
	artifact := h.add(t, bigText(10), AddOptions{})
	message := map[string]any{
		"role":         "tool",
		"tool_call_id": "call_1",
		"content":      BuildReference(artifact.ID, artifact.Chars, "read_file"),
		"artifact_id":  artifact.ID,
	}

	h.manager.Remove(artifact.ID)
	rendered := h.renderer.RenderToolContent(message)

	if strings.TrimSpace(rendered) == "" {
		t.Fatal("an evicted artifact rendered as empty text")
	}
	if !strings.Contains(rendered, artifact.ID) {
		t.Fatalf("the sentence does not name the artifact: %q", rendered)
	}
}

// TestMissingBodyIsSaidNotSilentlyDropped.
func TestMissingBodyIsSaidNotSilentlyDropped(t *testing.T) {
	h := newHarness(t, nil)
	artifact := h.add(t, bigText(10), AddOptions{})

	// Delete the body behind the store's back, as a person deleting the directory
	// would.
	if err := os.Remove(filepath.Join(h.store.Directory, "refs", refName(artifact.ID)+".txt")); err != nil {
		t.Fatal(err)
	}
	h.store.loaded = false
	h.store.Load()

	if _, ok := h.store.Content(artifact.ID); ok {
		t.Fatal("the store returned a body that is not on disk")
	}
	rendered := h.renderer.RenderArtifact(artifact, RepresentationFull, nil)
	if !rendered.Missing {
		t.Fatal("a missing body was not reported as missing")
	}
	if strings.TrimSpace(rendered.Text) == "" {
		t.Fatal("a missing body rendered as empty text")
	}
}

// TestSessionStateIsRebuiltNotStored: notes differ every round, and persisting
// them would make whoever restores the session believe that was what went out.
func TestSessionStateIsRebuiltNotStored(t *testing.T) {
	h := newHarness(t, nil)
	h.manager.SetNotes([]string{"todos: 1/3 done"})

	payload := h.manager.State.ToJSON()
	if _, present := payload["notes"]; present {
		t.Fatal("notes reached the session-file form")
	}
	if h.manager.State.Version != 0 {
		t.Fatalf("setting notes bumped the version to %d, which would trigger a write",
			h.manager.State.Version)
	}
}

// TestHydrateGivesLegacySessionsAnArtifact ...
//
// Every tool message must end up with an artifact behind it: the reference in
// history is the only entry point for rendering, so a missing one means the model
// can never see that tool result again.
func TestHydrateGivesLegacySessionsAnArtifact(t *testing.T) {
	h := newHarness(t, nil)
	messages := []map[string]any{
		{"role": "system", "content": "prompt"},
		{"role": "user", "content": "read it"},
		{"role": "assistant", "content": nil},
		{"role": "tool", "tool_call_id": "call_1", "content": "文件正文在这里"},
	}

	created, err := h.manager.Hydrate(messages, ZoneDynamic, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("hydrated %d artifacts, want 1", len(created))
	}
	item := h.manager.Item(created[0])
	if item == nil || item.Representation != RepresentationFull {
		t.Fatal("a hydrated item is not at full level, so the old session would render differently")
	}
	if body, ok := h.store.Content(created[0]); !ok || body != "文件正文在这里" {
		t.Fatalf("the hydrated body does not match: %q", body)
	}
}

// --- compaction -------------------------------------------------------------

func history(count int) []map[string]any {
	messages := []map[string]any{{"role": "system", "content": "prompt"}}
	for index := 0; index < count; index++ {
		messages = append(messages,
			map[string]any{"role": "user", "content": fmt.Sprintf("问题 %d", index)},
			map[string]any{"role": "assistant", "content": fmt.Sprintf("回答 %d", index)},
		)
	}
	return messages
}

// TestFoldPointLandsOnAUserMessage ...
//
// The provider requires every tool_calls to have a paired result, so cutting
// mid-turn produces a payload that cannot be sent — and the 400 it returns reads
// like "context too long".
func TestFoldPointLandsOnAUserMessage(t *testing.T) {
	for count := 10; count < 40; count++ {
		messages := history(count)
		point := FoldPoint(messages, 0)
		if point == 0 {
			continue
		}
		if messages[point]["role"] != "user" {
			t.Fatalf("history of %d folded at %d, which is a %s message",
				count, point, messages[point]["role"])
		}
	}
}

// TestFirstUserMessageIsNeverFolded: it is the session's task anchor, and the
// band marks are attached to that position.
func TestFirstUserMessageIsNeverFolded(t *testing.T) {
	messages := history(30)
	point := FoldPoint(messages, 0)
	if point <= FirstUserIndex(messages) {
		t.Fatalf("folded from %d, which swallows the first user message at %d",
			point, FirstUserIndex(messages))
	}
}

// TestShortHistoryIsNotFolded: folding two messages costs a round trip and
// invalidates the prefix cache — a net loss.
func TestShortHistoryIsNotFolded(t *testing.T) {
	if point := FoldPoint(history(3), 0); point != 0 {
		t.Fatalf("folded %d messages from a short history", point)
	}
}

// TestRecentMessagesAreNeverFolded.
func TestRecentMessagesAreNeverFolded(t *testing.T) {
	messages := history(30)
	point := FoldPoint(messages, 0)
	if point > len(messages)-KeepRecentMessages {
		t.Fatalf("folded up to %d of %d, which eats into the last %d",
			point, len(messages), KeepRecentMessages)
	}
}

// TestSecondFoldGoesFurther: a boundary that does not advance buys a summary that
// says nothing new for the price of a round trip.
func TestSecondFoldGoesFurther(t *testing.T) {
	messages := history(30)
	first := FoldPoint(messages, 0)
	if first == 0 {
		t.Fatal("nothing folded to begin with")
	}

	// Leave only the untouched tail as the remainder; there is nothing to fold.
	if again := FoldPoint(messages[:first+KeepRecentMessages], first); again <= first {
		return // as expected: not enough new material, and it says so
	} else if again != 0 {
		t.Fatalf("fold point %d did not advance past %d but was reported as progress", again, first)
	}
}

// TestDigestCarriesReferencesNotBodies.
func TestDigestCarriesReferencesNotBodies(t *testing.T) {
	messages := []map[string]any{
		{"role": "system", "content": "prompt"},
		{"role": "user", "content": "读一下大文件"},
		{"role": "assistant", "content": "", "tool_calls": []any{
			map[string]any{"function": map[string]any{"name": "read_file", "arguments": `{"path":"big.txt"}`}},
		}},
		{"role": "tool", "tool_call_id": "call_1",
			"content": "[artifact art_abcdef012345 · 120480 字符 · read_file]"},
	}

	skeleton := DigestMessages(messages, 0, nil, DigestMaxChars)
	if !strings.Contains(skeleton, "art_abcdef012345") {
		t.Fatalf("the skeleton lost the reference:\n%s", skeleton)
	}
	// The reference is wrapped in "[工具结果]" and nothing else — that prefix is
	// what tells the summarising model this line stands in for a result.
	if !strings.Contains(skeleton, "[工具结果] [artifact art_abcdef012345") {
		t.Fatalf("the reference is not marked as a tool result:\n%s", skeleton)
	}
	if !strings.Contains(skeleton, "调用 read_file") {
		t.Fatalf("the skeleton lost the tool call:\n%s", skeleton)
	}
}

// TestDigestKeepsTheRecentEnd: "current state" and "next step" depend on what
// happened recently, so the cut comes off the front.
func TestDigestKeepsTheRecentEnd(t *testing.T) {
	messages := history(20)
	skeleton := DigestMessages(messages, 0, nil, 120)

	if !strings.Contains(skeleton, "问题 19") && !strings.Contains(skeleton, "回答 19") {
		t.Fatalf("the newest messages were dropped:\n%s", skeleton)
	}
	if !strings.Contains(skeleton, "没有列在这里") {
		t.Fatalf("the dropped stretch was not disclosed:\n%s", skeleton)
	}
}

// TestCompactionBlockRoundTrips, and a broken block reads as "never compacted"
// rather than making the session unopenable.
func TestCompactionBlockRoundTrips(t *testing.T) {
	original := Compaction{FoldedMessages: 13, SummaryID: "art_1", Generation: 2, UpdatedAt: 1.5}
	metadata := map[string]any{}
	StoreCompaction(metadata, original)

	loaded, ok := LoadCompaction(metadata)
	if !ok || loaded != original {
		t.Fatalf("round trip produced %+v (ok=%v), want %+v", loaded, ok, original)
	}
	if !loaded.Active() {
		t.Fatal("a compacted state does not report as active")
	}

	for _, broken := range []any{
		nil, "a string", map[string]any{}, map[string]any{"folded_messages": 0},
		map[string]any{"folded_messages": "thirteen"},
	} {
		if state, ok := CompactionFromBlock(broken); ok {
			t.Fatalf("a broken block %#v read as %+v", broken, state)
		}
	}
}

// TestAttentionIsIdenticalWhenNothingWasFolded ...
//
// An uncompacted session therefore takes a path byte-identical to before this
// feature existed.
func TestAttentionIsIdenticalWhenNothingWasFolded(t *testing.T) {
	messages := history(5)
	view := FoldedView(messages, 0, nil)
	if len(view) != len(messages) {
		t.Fatalf("view has %d messages, want %d", len(view), len(messages))
	}
	for index := range messages {
		if messages[index]["content"] != view[index]["content"] {
			t.Fatalf("message %d changed", index)
		}
	}
}

// TestSystemPromptSurvivesFolding ...
//
// It is messages[0] and the folded stretch is [0, folded) — they overlap
// numerically, and the system prompt has to stay. Dropping it changes the model's
// whole behaviour for the rest of the session.
func TestSystemPromptSurvivesFolding(t *testing.T) {
	messages := history(30)
	point := FoldPoint(messages, 0)
	summary := SummaryMessage("摘要正文")

	view := FoldedView(messages, point, summary)
	if len(view) == 0 || view[0]["role"] != "system" {
		t.Fatalf("the system prompt is not first: %v", roles(view))
	}
	if view[1]["role"] != "user" || !strings.Contains(view[1]["content"].(string), SummaryHeader) {
		t.Fatalf("the summary is not directly after the system prompt: %v", roles(view))
	}
	if len(view) != 2+len(messages)-point {
		t.Fatalf("view has %d messages, want %d", len(view), 2+len(messages)-point)
	}
}

// TestSummaryMessageIsAPlainUserMessage ...
//
// The folded stretch contained things the user and the assistant said, and turning
// those into one system message would falsify "who is speaking" for that stretch.
func TestSummaryMessageIsAPlainUserMessage(t *testing.T) {
	message := SummaryMessage(" 内容 ")
	if message["role"] != "user" {
		t.Fatalf("the summary is a %v message", message["role"])
	}
	content, _ := message["content"].(string)
	if !strings.HasPrefix(content, SummaryHeader) {
		t.Fatalf("the summary does not open with the header: %q", firstLines(content, 2))
	}
	if !strings.HasSuffix(content, "内容") {
		t.Fatalf("the summary body was not trimmed and appended: %q", firstLines(content, 3))
	}
}

// TestMissingSummaryIsSaidNotSilentlyEmpty ...
//
// Empty reads as "nothing happened in that whole stretch", which lets the model
// cheerfully redo work it already did.
func TestMissingSummaryIsSaidNotSilentlyEmpty(t *testing.T) {
	text := MissingSummary(Compaction{FoldedMessages: 13})
	if !strings.Contains(text, "13") {
		t.Fatalf("the notice does not say how much was folded: %q", firstLines(text, 3))
	}
	if strings.TrimSpace(text) == "" {
		t.Fatal("a missing summary rendered as empty text")
	}
}

func roles(messages []map[string]any) []string {
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		role, _ := message["role"].(string)
		out = append(out, role)
	}
	return out
}

func firstLines(text string, count int) string {
	lines := strings.SplitN(text, "\n", count+1)
	if len(lines) > count {
		lines = lines[:count]
	}
	return strings.Join(lines, "\n")
}
