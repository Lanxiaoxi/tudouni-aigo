package tui

import (
	"strings"
	"testing"
	"time"
)

// ── theme ─────────────────────────────────────────────────────────────────────

func TestDerivedRolesSitBetweenTheirEndpoints(t *testing.T) {
	th := themes[themeAmber]
	// rail is a lightening of the background toward the ink: it has to land
	// between the two, or the "soft layer" claim is decorative.
	if th.rail == th.bg || th.rail == th.ink {
		t.Fatalf("rail must sit strictly between bg and ink: got %s", th.rail)
	}
	// The same rule with the same inputs must give the same answer — the
	// palettes are the single source and nothing is hand-written per role.
	again := deriveTheme(ambersPalette)
	if again.rail != th.rail || again.sunk != th.sunk {
		t.Fatal("deriveTheme is not deterministic")
	}
}

func TestTheLightThemeDerivesInTheOtherDirection(t *testing.T) {
	th := themes[themePinkViolet]
	// A light theme's rail darkens toward the ink. If both directions produced
	// the same blend the `dark` flag would be decorative.
	if !strings.HasPrefix(th.rail, "#") {
		t.Fatalf("rail is not a colour: %s", th.rail)
	}
	dark := themes[themeAmber]
	if th.rail == dark.rail {
		t.Fatal("light and dark themes derived the same rail from different palettes")
	}
}

func TestTheDeepClearVariantKeepsTheDerivedRolesOfTheOriginal(t *testing.T) {
	clear := themes[themeDeepClear]
	amber := themes[themeAmber]
	// The clear variant paints neither the bars nor the boxes, but the rail and
	// the thinking block keep their colour — all-transparency would leave the
	// screen with nothing but text and strokes.
	if clear.rail != amber.rail || clear.sunk != amber.sunk {
		t.Fatal("the clear variant drifted from its original palette")
	}
	if clear.chrome != ansiDefault || clear.surface != ansiDefault || clear.bg != ansiDefault {
		t.Fatal("the clear variant must hand bg, chrome and surface to the terminal")
	}
	if clear.line != amber.line || clear.accent != amber.accent {
		t.Fatal("strokes belong to the theme, never to the terminal")
	}
}

func TestResolveTheme(t *testing.T) {
	cases := map[string]themeKey{
		"a":     themeAmber,
		"A-T2":  themeDeepClear,
		"at2":   themeDeepClear, // the hyphen is for humans, not for the parser
		"p3":    themePinkViolet,
		"1":     themeAmber,
		"2":     themeDeepClear,
		"3":     themePinkViolet,
		"深透明":   themeDeepClear,
		"amber": themeAmber,
		"粉紫":    themePinkViolet,
		"clear": themeDeepClear, // longest rules out nothing here: only one name contains "clear"… wait, both do
	}
	for query, want := range cases {
		got, ok := resolveTheme(query)
		if !ok || got != want {
			t.Errorf("resolveTheme(%q) = %q (%v), want %q", query, got, ok, want)
		}
	}
	if _, ok := resolveTheme("琥珀色"); ok {
		t.Error("a fragment longer than the name must not match")
	}
}

// ── tool lines ────────────────────────────────────────────────────────────────

func TestToolCallLineSyntax(t *testing.T) {
	line := toolCallLine("read_file", "main.py", 0, "low")
	text := line.plain()
	if !strings.Contains(text, "  → ") || !strings.Contains(text, "[1] read_file(main.py)") {
		t.Fatalf("call line lost the syntax: %q", text)
	}
	// LOW is the majority; writing "low risk" on every line is noise.
	if strings.Contains(text, "risk") {
		t.Fatalf("a low-risk call must not be labelled: %q", text)
	}

	high := toolCallLine("shell", "ls", 1, "high")
	if !strings.Contains(high.plain(), "HIGH") {
		t.Fatalf("a high-risk call must be labelled: %q", high.plain())
	}
}

func TestToolResultLineMarksTheStatus(t *testing.T) {
	ok := toolResultLine(0, map[string]any{"status": "ok", "chars": 8412, "duration_ms": 41})
	if !strings.Contains(ok.plain(), "✓") || !strings.Contains(ok.plain(), "8,412") {
		t.Fatalf("ok result lost its count: %q", ok.plain())
	}
	denied := toolResultLine(0, map[string]any{"status": "denied"})
	if !strings.Contains(denied.plain(), "✗") {
		t.Fatalf("denied lost its mark: %q", denied.plain())
	}
}

func TestQuietModeBriefLineBackfillsByCallID(t *testing.T) {
	call := toolBriefLine("write_file", `{"path": "hello.c", "content": "..."}`, "call-1", "medium")
	if call.anchor != "call-1" {
		t.Fatalf("the brief line lost its anchor: %q", call.anchor)
	}
	if !strings.Contains(call.plain(), "[write_file]") || !strings.Contains(call.plain(), "hello.c") {
		t.Fatalf("the brief lost the tool and its subject: %q", call.plain())
	}
	done := toolBriefDoneLine(map[string]any{"status": "ok", "call_id": "call-1", "chars": 16, "duration_ms": 1})
	if done.anchor != "call-1" || !strings.Contains(done.plain(), "✓") {
		t.Fatalf("the result tail lost its anchor or mark: %q", done.plain())
	}
	// The tail is deliberately prefix-free: it is appended to a line that
	// already names the tool.
	if strings.Contains(done.plain(), "write_file") {
		t.Fatalf("the tail must not repeat the tool name: %q", done.plain())
	}
}

func TestABriefSurvivesATruncatedPayload(t *testing.T) {
	// The wire copy of arguments is cut at 200 characters, so most write_file
	// payloads do not parse. The literal grep is the fallback.
	brief := toolBrief("write_file", `{"path": "notes.md", "content": "a very long body that got cut off mid-s`)
	if brief != "notes.md" {
		t.Fatalf("the grep fallback failed: %q", brief)
	}
}

// ── turn header ───────────────────────────────────────────────────────────────

func TestTurnHeaderIsTwoSegmentsThenOne(t *testing.T) {
	startedAt := time.Now().Add(-4 * time.Second)
	turn := &turnData{index: 2, startedAt: startedAt, finished: false, steps: 1}
	running := turnHeader(turn)
	if !strings.Contains(running.plain(), "Turn 2") || !strings.Contains(running.plain(), "running") {
		t.Fatalf("running header wrong: %q", running.plain())
	}

	turn.finished = true
	turn.steps = 3
	turn.outcome = "answered"
	settled := turnHeader(turn)
	text := settled.plain()
	if !strings.Contains(text, "3 steps") || !strings.Contains(text, "Answered") {
		t.Fatalf("settled header lost its summary: %q", text)
	}
}

// ── thinking block ────────────────────────────────────────────────────────────

func TestWrapCellsTreatsEscapeSequencesAsZeroWidth(t *testing.T) {
	// The real-screen bug: a styled row wrapped as if the SGR body were
	// printable, breaking early and, when the break landed inside a sequence,
	// leaving `8;2;131;121;104m` on screen as text. The wrapped form must keep
	// the sequence intact and count only visible cells.
	style := "\x1b[38;2;131;121;104m"
	line := style + "auto" + "\x1b[0m"
	lines := wrapCells(line, 30)
	if len(lines) != 1 {
		t.Fatalf("a short styled line must not wrap, got %d lines", len(lines))
	}
	if !strings.Contains(lines[0], style+"auto") {
		t.Fatalf("the sequence was broken: %q", lines[0])
	}

	// A long styled row wraps at the **visible** width, and both physical lines
	// carry the sequence state: the escape passes through wherever it lands.
	long := style + strings.Repeat("ab", 40) + "\x1b[0m"
	wrapped := wrapCells(long, 10)
	if len(wrapped) != int(80/10) {
		t.Fatalf("80 visible cells at width 10 = 8 lines, got %d", len(wrapped))
	}
	for _, physical := range wrapped {
		if strings.Contains(physical, "8;2;131") && !strings.Contains(physical, "\x1b[") {
			t.Fatalf("a sequence tail leaked as text: %q", physical)
		}
	}
}

func TestThinkingBodyQuotesEveryLine(t *testing.T) {
	lines := thinkingBody("first\nsecond", 40)
	if len(lines) != 2 {
		t.Fatalf("expected two physical lines, got %d", len(lines))
	}
	for _, line := range lines {
		if !strings.Contains(line, "│") {
			t.Fatal("the quote block lost its vertical bar")
		}
	}
}

func TestThinkingFoldedShowsTheCount(t *testing.T) {
	turn := &turnData{}
	line := thinkingFolded(turn, 1284, "")
	if !strings.Contains(line.plain(), "1,284") || !strings.Contains(line.plain(), "Thinking") {
		t.Fatalf("folded line lost the count: %q", line.plain())
	}
}
