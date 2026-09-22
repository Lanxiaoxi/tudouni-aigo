package tui

// Tests for the rendered-markdown result cache. The cache exists for one
// reason — a long session redraws the whole history on every message, and
// without it every frame re-runs glamour over every finished answer — so the
// tests are about (a) the answers staying right and (b) the per-frame cost
// staying flat as the history grows.

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// resetMarkdownResults empties the caches so one test cannot answer for another.
func resetMarkdownResults() {
	markdownResults.entries = nil
	markdownResults.order = nil
	markdownResults.frame = 0
	markdownResults.evictAt = 0
	markdownRendererCache = markdownRendererSlot{}
	markdownUncachedRenders = 0
}

func markdownTestDoc(marker string) string {
	return "## " + marker + "\n\n" +
		"一段中文说明，用来让 glamour 有真正的工作要做。\n\n" +
		"- 第一项 `code`\n- 第二项\n\n" +
		"```go\nfunc main() { println(\"hello\") }\n```\n"
}

// TestRenderedMarkdownIsStable is the premise the cache rests on: the same text
// at the same width under the same theme must produce the same rows. If glamour
// carried output state between Render calls, memoising them would be unsafe and
// this test is where that would show up.
func TestRenderedMarkdownIsStable(t *testing.T) {
	setTheme(defaultTheme)
	withColour(t)
	resetMarkdownResults()
	text := markdownTestDoc("stability")

	first := renderMarkdownUncachedOnly(text, 97)
	for attempt := 0; attempt < 5; attempt++ {
		again := renderMarkdownUncachedOnly(text, 97)
		if strings.Join(first, "\n") != strings.Join(again, "\n") {
			t.Fatalf("render %d differs from the first (%d vs %d lines)",
				attempt+2, len(first), len(again))
		}
	}
}

// renderMarkdownUncachedOnly reaches the raw renderer, bypassing the cache so a
// test can compare what the cache is storing against what the renderer does.
func renderMarkdownUncachedOnly(text string, width int) []string {
	lines, _ := renderMarkdownUncached(text, width)
	return lines
}

// TestCachedMarkdownMatchesUncached is the core correctness claim: a cached
// answer is byte-for-byte what the uncached render produces. A cache that is
// fast and wrong is worse than no cache.
//
// Colours are forced, per the repository's rule for anything that compares
// rendered output: without a profile lipgloss strips every style and the escape
// bytes vanish, so the comparison would be about less than it looks.
func TestCachedMarkdownMatchesUncached(t *testing.T) {
	setTheme(defaultTheme)
	withColour(t)
	resetMarkdownResults()
	text := markdownTestDoc("equality")

	want := renderMarkdownUncachedOnly(text, 97)
	got := renderMarkdown(text, 97)
	if strings.Join(want, "\n") != strings.Join(got, "\n") {
		t.Fatal("the first (uncached) render differs from the direct render")
	}
	// And again, now from the cache.
	again := renderMarkdown(text, 97)
	if strings.Join(want, "\n") != strings.Join(again, "\n") {
		t.Fatal("the cached render differs from the direct render")
	}
}

// TestCachedMarkdownSeparatesWidths: a resize must reflow the answer, not serve
// the rows wrapped for the old width.
func TestCachedMarkdownSeparatesWidths(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()
	text := markdownTestDoc("width")

	wide := renderMarkdown(text, 100)
	narrow := renderMarkdown(text, 40)
	if strings.Join(wide, "\n") == strings.Join(narrow, "\n") {
		t.Fatal("width 40 and width 100 produced identical rows")
	}
	// The narrow render must not have replaced the wide one.
	wideAgain := renderMarkdown(text, 100)
	if strings.Join(wide, "\n") != strings.Join(wideAgain, "\n") {
		t.Fatal("the width-100 result changed after a width-40 render")
	}
}

// TestCachedMarkdownSeparatesThemes: a theme switch must repaint the answer in
// the new palette, and switching back must give the original bytes — which is
// what proves the theme is genuinely part of the key rather than something the
// cache happens to get right because themes are set once at start-up.
func TestCachedMarkdownSeparatesThemes(t *testing.T) {
	resetMarkdownResults()
	text := markdownTestDoc("theme")

	setTheme(themePinkViolet)
	light := renderMarkdown(text, 97)
	setTheme(themeAmber)
	dark := renderMarkdown(text, 97)
	if strings.Join(light, "\n") == strings.Join(dark, "\n") {
		t.Fatal("two different themes produced identical rows")
	}
	setTheme(themePinkViolet)
	lightAgain := renderMarkdown(text, 97)
	if strings.Join(light, "\n") != strings.Join(lightAgain, "\n") {
		t.Fatal("switching back to a theme did not restore its rows")
	}
	setTheme(defaultTheme)
}

// TestCachedMarkdownSeparatesAnswers: two different answers with the same
// length must not answer for each other. This is the hash-collision guard seen
// from the outside — the cache re-checks the text rather than trusting the key.
func TestCachedMarkdownSeparatesAnswers(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()
	first := markdownTestDoc("alpha")
	second := markdownTestDoc("bravo")
	if len(first) != len(second) {
		t.Fatalf("the two fixtures must be the same length to test the guard: %d vs %d",
			len(first), len(second))
	}

	wantFirst := renderMarkdownUncachedOnly(first, 97)
	wantSecond := renderMarkdownUncachedOnly(second, 97)
	if strings.Join(wantFirst, "\n") == strings.Join(wantSecond, "\n") {
		t.Fatal("the two fixtures render identically; the test proves nothing")
	}

	gotFirst := renderMarkdown(first, 97)
	gotSecond := renderMarkdown(second, 97)
	if strings.Join(gotFirst, "\n") != strings.Join(wantFirst, "\n") {
		t.Fatal("the first answer was answered with the wrong rows")
	}
	if strings.Join(gotSecond, "\n") != strings.Join(wantSecond, "\n") {
		t.Fatal("the second answer was answered with the first one's rows")
	}
}

// TestMarkdownResultsStayBounded: a session longer than the cache must not grow
// it without limit. The bound is `markdownResultPeak`, not
// `markdownResultLimit`, because an over-limit cache is deliberately allowed to
// finish the frame it is in — see evictMarkdownResults.
func TestMarkdownResultsStayBounded(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()

	// Seed the order list past the peak without rendering thousands of distinct
	// answers: measuring the bound needs the bookkeeping, not the glamour.
	seedMarkdownOrder(markdownResultPeak * 2)

	// One miss is enough to set the map up and run the ceiling check.
	renderMarkdown(markdownTestDoc("bounded"), 97)

	if held := len(markdownResults.order); held > markdownResultPeak {
		t.Fatalf("the key list holds %d entries, peak is %d", held, markdownResultPeak)
	}
	if held := len(markdownResults.entries); held > markdownResultPeak {
		t.Fatalf("cache holds %d entries, peak is %d", held, markdownResultPeak)
	}
}

// seedMarkdownOrder pushes n synthetic keys onto the cache's order list, so a
// test can reach a size that would otherwise cost thousands of glamour renders.
// The keys are not in the map, which is exactly how a stale duplicate looks.
func seedMarkdownOrder(n int) {
	for index := 0; index < n; index++ {
		markdownResults.order = append(markdownResults.order, markdownKey{
			hash: uint64(index) + 1, width: 97, theme: defaultTheme, length: 1,
		})
	}
}

// TestMarkdownResultsSweepBackToLimit: the sweep must actually bring the cache
// back down, otherwise "bounded" is only true until the peak is reached.
func TestMarkdownResultsSweepBackToLimit(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()

	// Over the limit, as a frame that outgrew the cache leaves it.
	const over = markdownResultLimit + 40
	seedMarkdownOrder(over)

	// The first frame boundary sweeps (evictAt starts at zero).
	beginMarkdownFrame()

	if held := len(markdownResults.order); held != markdownResultLimit {
		t.Fatalf("the key list holds %d entries after a sweep, want %d", held, markdownResultLimit)
	}

	// And the interval is real: a boundary before it must not sweep again.
	order := len(markdownResults.order)
	beginMarkdownFrame()
	beginMarkdownFrame()
	if held := len(markdownResults.order); held != order {
		t.Fatalf("a sweep ran inside the interval: %d entries became %d", order, held)
	}
}

// TestMarkdownResultsSurviveAFullCache is the regression test for a real defect
// found while building this cache, and the reason eviction is deferred to a
// frame boundary.
//
// A frame renders the transcript oldest-first. The first version of this cache
// evicted the longest-held entry as soon as it was over its limit, so once the
// cache was full every miss evicted the next answer in that same walk: a session
// of `markdownResultLimit + 40` turns re-rendered **all** of its answers on every
// frame, with a full cache and a zero hit rate. Evicting between frames instead
// of during one is what fixes it, and this is what fails if that is undone.
func TestMarkdownResultsSurviveAFullCache(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()

	// Just over the limit: the case that used to thrash completely.
	const turns = markdownResultLimit + 40
	m := lagModel(turns)

	_ = m.View() // cold: every answer rendered once
	if markdownUncachedRenders != turns {
		t.Fatalf("the cold frame rendered %d answers, want %d", markdownUncachedRenders, turns)
	}

	// Warm frames must not re-render anything: the whole session is still held,
	// because an over-limit cache is only swept when a frame boundary says so.
	for frame := 0; frame < 3; frame++ {
		before := markdownUncachedRenders
		_ = m.View()
		if rerendered := markdownUncachedRenders - before; rerendered != 0 {
			t.Fatalf("warm frame %d re-rendered %d answers, want 0: "+
				"a full cache is evicting answers the frame still needs", frame, rerendered)
		}
	}
	if len(markdownResults.entries) != turns {
		t.Fatalf("cache holds %d entries, want %d (the whole session)", len(markdownResults.entries), turns)
	}
}

// TestMarkdownResultsSweepKeepsTheNewest: when the sweep does happen it must
// drop the beginning of the conversation, which the window has scrolled past,
// and keep the end of it, which is on screen.
//
// Driven through renderMarkdown and beginMarkdownFrame directly rather than
// through View: the point is the sweep's choice of victim, and a real frame
// re-renders the evicted prefix on its next pass, which would put the oldest
// answer straight back and hide what is being tested.
func TestMarkdownResultsSweepKeepsTheNewest(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()

	const turns = markdownResultLimit + 40
	for index := 1; index <= turns; index++ {
		renderMarkdown(lagAnswer(index), 97)
	}

	// Cross the sweep interval: `evictAt` starts at 0, so the first boundary
	// sweeps and the next is a full interval later.
	beginMarkdownFrame()
	for frame := 0; frame < markdownResultLimit; frame++ {
		beginMarkdownFrame()
	}

	held := func(answer string) bool {
		key := markdownKey{
			hash:   markdownHash(answer),
			width:  97,
			theme:  defaultTheme,
			length: len(answer),
		}
		_, ok := markdownResults.entries[key]
		return ok
	}
	if !held(lagAnswer(turns)) {
		t.Fatal("the sweep dropped the newest answer, which is the one on screen")
	}
	if held(lagAnswer(1)) {
		t.Fatal("the sweep kept the oldest answer, which nothing is looking at")
	}
	if held := len(markdownResults.entries); held > markdownResultLimit {
		t.Fatalf("cache holds %d entries after a sweep, limit is %d", held, markdownResultLimit)
	}
}

// ── the regression this cache exists for ─────────────────────────────────────

// lagAnswer makes one answer of the size and shape a real one has: prose, a
// list and a code block. Markdown complexity is what glamour's cost tracks, so
// a fixture of plain sentences would understate the per-frame cost the
// benchmark is guarding.
func lagAnswer(index int) string {
	return fmt.Sprintf("## 结果 %d\n\n"+
		"这是第 %d 轮的回答。下面是一段中等长度的中文说明，用来模拟真实回复的体量，"+
		"包含若干个句子、一个代码块和一个列表。段落长度大致与真实回答相当。\n\n"+
		"要点如下：\n\n"+
		"- 第一条：修改了 `internal/frontends/tui/view.go` 的渲染路径；\n"+
		"- 第二条：缓存已经渲染好的历史行，按 entry + 宽度 + 主题做键；\n"+
		"- 第三条：流式期间只重画 streaming 块。\n\n"+
		"```go\n"+
		"func (m model) renderTranscript(width, height int) string {\n"+
		"\tfor index := range m.transcript {\n"+
		"\t\trows = append(rows, m.renderEntry(index, width)...)\n"+
		"\t}\n"+
		"\treturn m.window(rows, height)\n"+
		"}\n"+
		"```\n\n"+
		"最后一句收尾，说明没有其他改动。", index, index)
}

// lagModel builds a session of N finished turns on a 120×40 terminal — the
// shape the report was written about.
func lagModel(turns int) model {
	setTheme(defaultTheme)
	m := newModel(nil, nil, Options{})
	m.width, m.height = 120, 40
	m.booting = false
	m.railHidden = true
	m.sessionID = "lag-regression"
	m.maxSteps = 40
	m.panel.model = "deepseek-flash"
	m.panel.effort = "medium"
	m.panel.messages = turns * 2
	m.panel.steps = turns * 3

	started := time.Now().Add(-time.Hour)
	for index := 0; index < turns; index++ {
		m.transcript = append(m.transcript, entry{turn: &turnData{
			index:     index + 1,
			runID:     fmt.Sprintf("run-%d", index),
			userInput: fmt.Sprintf("第 %d 轮的问题：帮我看看这段代码哪里有问题？", index+1),
			steps:     3,
			startedAt: started.Add(time.Duration(index) * time.Minute),
			duration:  4*time.Second + time.Duration(index)*100*time.Millisecond,
			finished:  true,
			outcome:   "answered",
			answer:    lagAnswer(index + 1),
			thinking:  strings.Repeat("先看渲染路径，再看缓存。", 20),
			lines: []renderLine{
				{segments: []seg{{text: "read_file  internal/frontends/tui/view.go", role: "tool"}}},
				{segments: []seg{{text: "→ 1305 lines", role: "result"}}},
				{segments: []seg{{text: "shell  go test ./internal/frontends/tui/", role: "tool"}}},
				{segments: []seg{{text: "→ ok  12.4s", role: "result"}}},
			},
		}})
	}
	m.scroll = &scrollState{follow: true}
	return m
}

// BenchmarkLongSessionFrame is the regression guard for the report this cache
// was written for: a frame of a long session must not cost what a frame of a
// hundred glamour renders costs.
//
// Read it by comparing the turns=1 row against turns=80: **the ratio is the
// measurement, not the absolute nanoseconds.** Before the cache the frame was
// ~60× more expensive at 80 turns than at 1 (5.4ms → 817ms); with it the ratio
// is in the low tens and the absolute figure is small enough that a keystroke
// or a streamed delta cannot be felt. A machine-independent threshold cannot be
// asserted here, which is why the ratio is what to look at.
func BenchmarkLongSessionFrame(b *testing.B) {
	for _, turns := range []int{1, 5, 10, 20, 40, 80} {
		b.Run(fmt.Sprintf("turns=%d", turns), func(b *testing.B) {
			m := lagModel(turns)
			// One frame to fill the cache, the way opening a session does.
			_ = m.View()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = m.View()
			}
		})
	}
}

// TestLongSessionFrameDoesNotRerenderHistory is the regression guard for the
// report this cache was written for.
//
// It asserts on **counts, not durations**: with the cache warm, a frame of a
// long session must reach glamour zero times. That is the precise defect —
// before the cache every frame re-rendered every answer, so an 80-turn session
// paid 80 glamour renders per keystroke and per streamed delta — and unlike a
// timing threshold it holds on any machine. A duration assertion here would
// either be flaky or too loose to catch anything.
func TestLongSessionFrameDoesNotRerenderHistory(t *testing.T) {
	setTheme(defaultTheme)
	resetMarkdownResults()

	m := lagModel(80)
	before := markdownUncachedRenders
	_ = m.View() // the frame that fills the cache, as opening a session does
	first := markdownUncachedRenders - before
	if first != 80 {
		t.Fatalf("the first frame reached glamour %d times, want 80 (one per answer)", first)
	}

	// Every later frame is a plain redraw: keystrokes, spinner ticks, deltas.
	// None of them may reach glamour for a finished answer.
	before = markdownUncachedRenders
	for frame := 0; frame < 20; frame++ {
		_ = m.View()
	}
	if rerendered := markdownUncachedRenders - before; rerendered != 0 {
		t.Fatalf("20 redraws of an unchanged 80-turn session reached glamour %d times, want 0: "+
			"the rendered-markdown cache is not taking effect", rerendered)
	}

	// A streamed delta must not drag the history back through the renderer
	// either — that is the case the user actually feels.
	m.busy = true
	m.streamRunID, m.streamStep = "run-79", 1
	m.thinkingLive = true
	m.thinkingText = strings.Repeat("live reasoning ", 20)
	before = markdownUncachedRenders
	for delta := 0; delta < 20; delta++ {
		m.handleDelta(map[string]any{
			"channel": "text", "text": "增量", "run_id": "run-79", "step": 1,
		})
		_ = m.View()
	}
	if rerendered := markdownUncachedRenders - before; rerendered != 0 {
		t.Fatalf("20 streamed deltas re-rendered the history %d times, want 0", rerendered)
	}
}

// TestLongSessionFrameIsNotDominatedByHistory is the timing form of the same
// check, and it is **self-normalising**: it compares the same 80-turn frame with
// the cache warm and with the cache unable to help, so slow hardware slows both
// sides and the ratio survives it.
//
// It deliberately does not compare 80 turns against 1 turn. That ratio moves
// with the machine's GC behaviour and is dominated by a 1-turn frame that costs
// a few hundred microseconds — measured anywhere between 22× and 52× across runs
// for identical code, which is a flaky test rather than a guard.
//
// Uncached, an 80-turn frame cost ~817ms against ~7ms cached; the bound below is
// two orders of magnitude looser than that and still fails loudly if the cache
// stops working.
func TestLongSessionFrameIsNotDominatedByHistory(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	setTheme(defaultTheme)

	// One frame of an 80-turn session whose answers have to be rendered.
	resetMarkdownResults()
	cold := lagModel(80)
	start := time.Now()
	_ = cold.View()

	// The same session, warm: no answer needs rendering.
	uncached := time.Since(start)
	start = time.Now()
	const rounds = 20
	for i := 0; i < rounds; i++ {
		_ = cold.View()
	}
	cached := time.Since(start) / rounds

	t.Logf("80-turn frame: %v without the cache, %v with it (%.0f× faster)",
		uncached, cached, float64(uncached)/float64(cached))

	if cached*5 > uncached {
		t.Fatalf("a warm 80-turn frame cost %v against %v uncached: the cache is doing "+
			"almost nothing", cached, uncached)
	}
}
