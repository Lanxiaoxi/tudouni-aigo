package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// The tests here pin the things a rendering change can silently break: the
// derived colours against the original's goldens, the invariants the layout has
// to hold (rows fit, styles balance, breaks land on words), and the handful of
// behaviours that were wrong once already and were not caught by the suite.

// ── theme goldens ─────────────────────────────────────────────────────────────

// TestDerivedRolesMatchTheOriginal pins the nine derived roles against the values
// the original produces. Those values were computed from the same palette by the
// same three rules, so a mismatch means this port's arithmetic drifted — and an
// off-by-one per channel is exactly the kind of thing the eye forgives and a
// golden table does not.
func TestDerivedRolesMatchTheOriginal(t *testing.T) {
	cases := []struct {
		key                                    themeKey
		rail, elevated, sunk, hairline, ink4   string
		accentSoft, dangerSoft, skill, railBar string
	}{
		{
			key:  themeAmber,
			rail: "#1D1C19", elevated: "#292724", sunk: "#0C0C0A", hairline: "#32302C",
			ink4: "#54524D", accentSoft: "#695123", dangerSoft: "#5E2A23",
			skill: "#595048", railBar: "#2A241E",
		},
		{
			key:  themePinkViolet,
			rail: "#E2E9F6", elevated: "#D8DFEB", sunk: "#F1F7FE", hairline: "#D1D7E4",
			ink4: "#B4B8C6", accentSoft: "#C3B4C2", dangerSoft: "#D8A3A7",
			skill: "#A892B6", railBar: "#D0C0E0",
		},
	}
	for _, want := range cases {
		got := themes[want.key]
		for name, pair := range map[string][2]string{
			"rail":        {got.rail, want.rail},
			"elevated":    {got.elevated, want.elevated},
			"sunk":        {got.sunk, want.sunk},
			"hairline":    {got.hairline, want.hairline},
			"ink4":        {got.ink4, want.ink4},
			"accent_soft": {got.accentSoft, want.accentSoft},
			"danger_soft": {got.dangerSoft, want.dangerSoft},
			"skill":       {got.skill, want.skill},
			"rail_bar":    {got.railBar, want.railBar},
		} {
			if pair[0] != pair[1] {
				t.Errorf("%s: %s = %s, want %s", want.key, name, pair[0], pair[1])
			}
		}
	}
	// The transparent variant keeps its original's derived roles: only the listed
	// surfaces change, the rail and the thinking block stay put.
	clear, amber := themes[themeDeepClear], themes[themeAmber]
	if clear.rail != amber.rail || clear.sunk != amber.sunk {
		t.Fatal("the clear variant drifted from its original palette")
	}
}

// TestTokensAreNotRepaintedByTheDerivation guards the separation the palette layer
// depends on: the tokens are data and must survive `deriveTheme` untouched.
func TestTokensAreNotRepaintedByTheDerivation(t *testing.T) {
	got := themes[themeAmber]
	if got.bg != ambersPalette.bg || got.accent != ambersPalette.accent || got.ink != ambersPalette.ink {
		t.Fatal("deriveTheme altered the palette it was given")
	}
}

// ── layout invariants ─────────────────────────────────────────────────────────

// TestScreenNeverExceedsTheTerminal is the invariant a full-screen program cannot
// break: one row too many and the status bar or the input line is pushed off the
// bottom. It is the check that would have caught the newline-in-a-row bug, where a
// multi-line report counted as one row and twelve.
func TestScreenNeverExceedsTheTerminal(t *testing.T) {
	for _, size := range []struct{ width, height int }{
		{80, 24}, {100, 30}, {120, 36}, {160, 50}, {200, 60},
	} {
		for _, rail := range []bool{true, false} {
			m := filledModel(size.width, size.height)
			m.railHidden = rail
			lines := strings.Split(m.View(), "\n")
			if len(lines) > size.height {
				t.Errorf("%dx%d railHidden=%v: %d rows drawn", size.width, size.height, rail, len(lines))
			}
			for index, line := range lines {
				if got := runewidth.StringWidth(stripANSI(line)); got > size.width {
					t.Errorf("%dx%d railHidden=%v: row %d is %d cells wide: %q",
						size.width, size.height, rail, index, got, stripANSI(line))
				}
			}
		}
	}
}

// TestTheRailIsDockedRight pins the one deliberate departure from the original's
// layout: the context rail is the right-hand column, so the conversation keeps the
// left margin. It is asserted on the rendered body rather than on the join call,
// because what can silently break is the padding — a transcript block that is not
// padded to its full width lets the rail slide left on the short rows.
func TestTheRailIsDockedRight(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.railHidden = false

	bars, header := 0, 0
	for _, row := range strings.Split(m.renderBodySplit(30), "\n") {
		plain := stripANSI(row)
		if at := strings.Index(plain, "▌"); at >= 0 {
			if column := runewidth.StringWidth(plain[:at]); column < m.width-railWidth {
				t.Errorf("a rail block bar sits at column %d, left of the rail: %q", column, plain)
			}
			bars++
		}
		if strings.HasPrefix(plain, "Turn 1") {
			header++
		}
	}
	if bars == 0 {
		t.Fatal("no rail block bar was drawn: the rail is missing from the body")
	}
	if header == 0 {
		t.Fatal("the transcript no longer starts at the left margin")
	}
}

// TestMultiLineEntryCountsItsRows is the same invariant at the level of one entry:
// a report with newlines in it occupies as many rows as it has lines.
func TestMultiLineEntryCountsItsRows(t *testing.T) {
	m := filledModel(120, 40)
	m.turnSeq = 1
	m.handleUI(map[string]any{
		"kind": "context",
		"context": map[string]any{
			"window": 128000,
			"context": map[string]any{
				"estimated_tokens": 12400, "limit_tokens": 128000,
				"compact_threshold": 100000, "artifacts": 3, "open": 2,
				"items": 5, "removed": 1, "pinned": 0, "degraded": 0,
			},
			"active": true, "folded": 4, "messages": 12, "generation": 1,
			"summary_id": "abcdef0123456789", "summary_chars": 3412,
		},
	})
	if len(m.transcript) == 0 {
		t.Fatal("the context report never reached the transcript")
	}
	rows := 0
	for index := range m.transcript {
		rows += len(m.renderEntry(index, 100))
	}
	if rows < 8 {
		t.Fatalf("a multi-line report rendered as %d rows", rows)
	}
	if lines := len(strings.Split(m.View(), "\n")); lines > m.height {
		t.Fatalf("the frame grew to %d rows for a %d-row terminal", lines, m.height)
	}
}

// ── turn outcomes ─────────────────────────────────────────────────────────────

// TestStopReasonsAreDistinguishable — a turn that died on a model error must not
// read as "Answered". That confusion is the whole reason the original keeps a
// separate exception type for the step limit.
func TestStopReasonsAreDistinguishable(t *testing.T) {
	seen := map[string]string{}
	for _, reason := range []string{"answered", "max_steps", "cancelled", "model_error", "model_fatal"} {
		turn := &turnData{index: 1, steps: 3, finished: true, outcome: reason, duration: 4200 * time.Millisecond}
		header := stripANSI(turnHeader(turn).plain())
		if !strings.Contains(header, "4.2s") {
			t.Errorf("%s: the frozen duration is missing: %q", reason, header)
		}
		if previous, ok := seen[header]; ok {
			t.Errorf("%s and %s render identically: %q", reason, previous, header)
		}
		seen[header] = reason
	}
	// An unrecognised reason prints itself: it is searchable, "unknown" is not.
	turn := &turnData{index: 1, outcome: "some_new_reason", finished: true}
	if !strings.Contains(turnHeader(turn).plain(), "some_new_reason") {
		t.Error("an unknown stop reason must be shown verbatim")
	}
}

// TestTurnDurationIsFrozen — a finished turn's duration comes from the event, not
// from the clock at draw time. Reading the clock made it climb forever.
func TestTurnDurationIsFrozen(t *testing.T) {
	m := filledModel(120, 36)
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})
	m.handleEvent(map[string]any{"kind": "run_finished", "run_id": "r1", "stop_reason": "answered", "duration_ms": 1500})
	first := stripANSI(turnHeader(m.transcript[0].turn).plain())
	time.Sleep(20 * time.Millisecond)
	second := stripANSI(turnHeader(m.transcript[0].turn).plain())
	if first != second {
		t.Fatalf("the duration moved after the turn ended: %q then %q", first, second)
	}
}

// ── streaming ─────────────────────────────────────────────────────────────────

// TestTheStreamedAnswerIsDrawnOnce — the live copy comes down before the finished
// answer goes up, or the same paragraph appears twice.
func TestTheStreamedAnswerIsDrawnOnce(t *testing.T) {
	m := filledModel(120, 36)
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})
	m.handleDelta(map[string]any{"channel": "text", "text": "Hello ", "run_id": "r1", "step": 1})
	m.handleDelta(map[string]any{"channel": "text", "text": "world.", "run_id": "r1", "step": 1})
	m.handleUI(map[string]any{"kind": "run_finished", "answer": "Hello world.", "run_id": "r1"})
	m.handleEvent(map[string]any{"kind": "run_finished", "run_id": "r1", "stop_reason": "answered"})

	var body strings.Builder
	for index := range m.transcript {
		for _, row := range m.renderEntry(index, 90) {
			body.WriteString(stripANSI(row))
			body.WriteString("\n")
		}
	}
	if count := strings.Count(body.String(), "Hello world."); count != 1 {
		t.Fatalf("the answer appears %d times:\n%s", count, body.String())
	}
	if strings.Contains(body.String(), "  ● \n") {
		t.Fatalf("an empty streaming marker was left behind:\n%s", body.String())
	}
}

// TestTheUserLineIsDrawnOnce is the same rule for the line the *user* typed, which
// had two possible authors: the flat-log echo `submit` used to append, and the turn
// block's own `  > ` line (`view.go:418`, the only place the original draws it —
// `view_state.py:919-923`). Both were live at once, so every turn printed the
// sentence twice: once at the left margin on Enter, once indented under the header.
func TestTheUserLineIsDrawnOnce(t *testing.T) {
	m := filledModel(120, 36)
	// nil stdin: `Send` writes nowhere, which is all a front end test needs.
	m.client = protocol.NewClient(nil)
	m.input = "当前工作区目录是什么"

	next, _ := m.submit()
	m = next.(model)
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})

	var body strings.Builder
	for index := range m.transcript {
		for _, row := range m.renderEntry(index, 90) {
			body.WriteString(stripANSI(row))
			body.WriteString("\n")
		}
	}
	if count := strings.Count(body.String(), "当前工作区目录是什么"); count != 1 {
		t.Fatalf("the user line appears %d times:\n%s", count, body.String())
	}
	// The survivor is the turn's own copy — indented under its header, in the
	// turn, which is what makes the header own the text it summarises.
	if !strings.Contains(body.String(), "  > 当前工作区目录是什么") {
		t.Fatalf("the turn block lost the line the user typed:\n%s", body.String())
	}
}

// TestRestoredUserMessagesCarryNoPrefix: history is drawn the way the original
// draws it (`app.py:1195-1198` — the content alone). A `> ` marker that appears in
// replay and never in a live turn reads as a turn that never closed.
func TestRestoredUserMessagesCarryNoPrefix(t *testing.T) {
	m := testModel()
	m.restoreMessages(map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": "第一句"},
		map[string]any{"role": "assistant", "content": "答案"},
	}})

	var restored string
	for index := range m.transcript {
		if m.transcript[index].kind == "user" {
			restored = stripANSI(strings.Join(m.renderEntry(index, 90), "\n"))
		}
	}
	if restored == "" {
		t.Fatal("the restored user message never reached the transcript")
	}
	if strings.Contains(restored, ">") {
		t.Fatalf("a restored user line carries a live-turn marker: %q", restored)
	}
	if !strings.Contains(restored, "第一句") {
		t.Fatalf("the restored line lost its text: %q", restored)
	}
}

// ── session switching ─────────────────────────────────────────────────────────

// TestSwitchingSessionClearsTheScreen — two conversations must not share a screen,
// and the empty state has to come back for the new one.
func TestSwitchingSessionClearsTheScreen(t *testing.T) {
	m := filledModel(120, 36)
	m.sessionID = ""
	m.handleServerMessage(map[string]any{"t": "init", "session_id": "one", "model": "m"})
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})
	m.handleDelta(map[string]any{"channel": "text", "text": "first conversation", "run_id": "r1", "step": 1})
	m.handleUI(map[string]any{"kind": "run_finished", "answer": "first conversation", "run_id": "r1"})
	if m.turnSeq != 2 {
		t.Fatalf("expected the fixture turn plus one, got %d", m.turnSeq)
	}
	m.handleServerMessage(map[string]any{"t": "init", "session_id": "two", "model": "m"})
	if m.turnSeq != 0 {
		t.Fatalf("the switch did not reset the turn counter: %d", m.turnSeq)
	}
	if !m.welcomeVisible() {
		t.Fatal("the empty state must come back for the new session")
	}
	for index := range m.transcript {
		text := stripANSI(renderOne(m.transcript[index].line))
		if strings.Contains(text, "first conversation") {
			t.Fatal("the previous conversation is still on screen")
		}
	}
}

// ── the command palette ───────────────────────────────────────────────────────

// TestPaletteFiltersLikeTheOriginal — case-insensitive prefix matching over the
// name without the slash. `/RE` matching nothing is the failure this pins.
func TestPaletteFiltersLikeTheOriginal(t *testing.T) {
	if got := filterCommands("re"); len(got) != 1 || got[0].name != "/resume" {
		t.Fatalf("prefix filter: %v", got)
	}
	if got := filterCommands("RE"); len(got) != 1 || got[0].name != "/resume" {
		t.Fatalf("the filter must ignore case: %v", got)
	}
	if got := filterCommands(""); len(got) != len(commands()) {
		t.Fatalf("an empty query lists everything: got %d", len(got))
	}
	for _, command := range commands() {
		if command.hint == "" {
			t.Errorf("%s has no hint: the palette column would be blank", command.name)
		}
	}
}

// TestPaletteCarriesTheArgument — the palette's filter is the input line, so the
// text after the command survives into the command that runs.
func TestPaletteCarriesTheArgument(t *testing.T) {
	m := filledModel(120, 36)
	m.input = "/resume 20260917-120000-abcd"
	m.inputCursor = len([]rune(m.input))
	if got := m.paletteQuery(); got != "resume" {
		t.Fatalf("query = %q", got)
	}
	if got := m.paletteArgument(); got != "20260917-120000-abcd" {
		t.Fatalf("argument = %q", got)
	}
	m.input = "/re"
	if got := m.paletteQuery(); got != "re" {
		t.Fatalf("query = %q", got)
	}
}

// ── the input box ─────────────────────────────────────────────────────────────

// TestInputEditorMovesAndEdits — the caret is real: text can be inserted and
// removed anywhere in the buffer, which is what makes the box an editor rather
// than an append-only string.
func TestInputEditorMovesAndEdits(t *testing.T) {
	m := filledModel(120, 36)
	m.insertText("helo")
	m.moveCaret(-1)
	m.insertText("l")
	if m.input != "hello" {
		t.Fatalf("insert at the caret: %q", m.input)
	}
	m.moveCaret(-1)
	m.backspace()
	if m.input != "helo" {
		t.Fatalf("backspace at the caret: %q", m.input)
	}
	m.deleteForward()
	if m.input != "heo" {
		t.Fatalf("delete forward: %q", m.input)
	}
	m.moveCaretLineStart()
	if m.inputCursor != 0 {
		t.Fatalf("home did not reach the start: %d", m.inputCursor)
	}
	m.moveCaretLineEnd()
	if m.inputCursor != len([]rune(m.input)) {
		t.Fatalf("end did not reach the finish: %d", m.inputCursor)
	}
	m.insertText("\nsecond line")
	if rows := len(inputRows(m.input, 40)); rows != 2 {
		t.Fatalf("a newline must start a new row: %d", rows)
	}
	// The two-row window follows the caret.
	window := inputRows(m.input, 40)
	if first, got := inputWindow(window, m.inputCursor); len(got) != 2 || first < 0 {
		t.Fatalf("the window is wrong: first=%d rows=%d", first, len(got))
	}
}

// TestBriefReadsWhatEachToolIsAbout — the quiet line names the subject, and the
// shapes that are not strings get words rather than a Go dump.
func TestBriefReadsWhatEachToolIsAbout(t *testing.T) {
	cases := map[string]string{
		`{"path": "a/b.go", "content": "x"}`:                                   "a/b.go",
		`{"command": "go test ./..."}`:                                         "go test ./...",
		`{"todos": [1, 2, 3]}`:                                                 "3 tasks",
		`{"url": "https://example.com/x", "raw": false}`:                       "https://example.com/x",
		`{"path": "notes.md", "content": "cut off mid-s` + "\n" + `": "": ""}`: "notes.md",
	}
	for arguments, want := range cases {
		tool := "read_file"
		if strings.Contains(arguments, "todos") {
			tool = "todo_write"
		}
		if strings.Contains(arguments, "command") {
			tool = "shell"
		}
		if strings.Contains(arguments, "url") {
			tool = "fetch_web"
		}
		if got := toolBrief(tool, arguments); got != want {
			t.Errorf("%s %s -> %q, want %q", tool, arguments, got, want)
		}
	}
	if got := briefValue("todo_write", true); got != i18n.T("brief.yes") {
		t.Errorf("a boolean should read as a word, got %q", got)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

// filledModel is a model with enough state for the layouts to have something to
// draw: panels, a session, a finished turn and a couple of tool lines.
func filledModel(width, height int) model {
	m := model{width: width, height: height, theme: defaultTheme, booting: false}
	m.maxSteps = 40
	m.sessionID = "20260917-120000-abcd"
	m.auditPath = "/home/u/.tudouni/logs/20260917-120000-abcd.jsonl"
	m.panel.model = "deepseek/deepseek-chat"
	m.panel.window = float64(128000)
	m.panel.thinking = true
	m.panel.messages, m.panel.steps = 12, 4
	m.panel.todos = []any{
		map[string]any{"status": "completed", "content": "列模块清单"},
		map[string]any{"status": "in_progress", "content": "读一遍旧 TUI 的渲染代码"},
		map[string]any{"status": "pending", "content": "对照 Go 版找差异"},
	}
	m.panel.skills = []any{map[string]any{"name": "frontend-design"}}
	m.panel.jobs = []any{
		map[string]any{"id": "1", "state": "running", "command": "go test ./...", "seconds": 12},
		map[string]any{"id": "2", "state": "uncollected", "command": "go build ./...", "exit_code": 0},
	}
	m.panel.mcp = []any{map[string]any{"name": "kb", "state": "loaded", "tools": 3}}
	m.panel.agentsMD = []any{map[string]any{"path": "AGENT.md", "lines": 42}}
	m.panel.toolInfo = map[string]map[string]any{
		"shell": {"risk": "high", "parallel_safe": true},
	}
	turn := &turnData{index: 1, runID: "r1", userInput: "帮我看一下 main.py",
		startedAt: time.Now(), finished: true, steps: 3, outcome: "answered",
		duration: 4200 * time.Millisecond, thinking: "用户想让我读 main.py"}
	turn.lines = []renderLine{
		toolCallLine("shell", `{"command": "ls"}`, 0, "high"),
		toolResultLine(0, map[string]any{"status": "ok", "chars": 8412, "duration_ms": 41}),
	}
	m.transcript = []entry{
		{turn: turn},
		{kind: "assistant", text: "这是 **答案** 正文。"},
	}
	m.turnSeq = 1
	return m
}
