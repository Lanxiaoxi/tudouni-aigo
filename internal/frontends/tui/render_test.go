package tui

import (
	"strings"
	"testing"

	"github.com/mattn/go-runewidth"
)

func visible(text string) string { return stripANSI(text) }

func TestWrapCellsBreaksAtSpaces(t *testing.T) {
	rows := wrapCells("go build ./...  finished (exit 0) · result not collected", 30)
	if len(rows) < 3 {
		t.Fatalf("expected several rows, got %d: %q", len(rows), rows)
	}
	for _, row := range rows {
		// A hard cell break splits words ("finished (ex" / "it 0)"), which is the
		// bug this rule exists for.
		if strings.HasSuffix(row, "(ex") || strings.HasPrefix(row, "it ") {
			t.Fatalf("wrapped mid-word: %q", rows)
		}
		if runewidth.StringWidth(row) > 30 {
			t.Fatalf("row wider than the limit: %q", row)
		}
	}
}

func TestWrapCellsBreaksOnNewlines(t *testing.T) {
	rows := wrapCells("alpha\nbeta", 40)
	if len(rows) != 2 || rows[0] != "alpha" || rows[1] != "beta" {
		t.Fatalf("newline must break the row: %q", rows)
	}
	// A multi-line report is what pushed the status bar off the terminal.
	long := wrapCells(strings.Repeat("x\n", 5), 40)
	if len(long) != 6 {
		t.Fatalf("expected 6 rows, got %d", len(long))
	}
}

func TestWrapCellsKeepsStylesBalanced(t *testing.T) {
	line := "\x1b[38;2;131;121;104mauto\x1b[0m and more words here"
	rows := wrapCells(line, 12)
	if len(rows) < 2 {
		t.Fatalf("expected a wrap, got %q", rows)
	}
	if !strings.Contains(rows[0], "\x1b[38;2;131;121;104m") {
		t.Fatalf("the style was dropped: %q", rows[0])
	}
	for _, row := range rows {
		if strings.Contains(row, "8;2;131;121;104m") && !strings.Contains(row, "\x1b[") {
			t.Fatalf("a sequence tail leaked as text: %q", row)
		}
	}
}

func TestSpreadKeepsTheRightHalf(t *testing.T) {
	left := "✗ This turn failed"
	right := "  auto-approve off  ·  2 background jobs · 1 to collect  ·  context 12.4k / 128.0k (9.7%)  ·  cache hit 88%  ·  session 4 messages · 2 steps  ·  audit .tudouni/logs"
	got := visible(spreadStyled(left, right, 120))
	if runewidth.StringWidth(got) > 120 {
		t.Fatalf("wider than the bar: %d %q", runewidth.StringWidth(got), got)
	}
	if !strings.Contains(got, "auto-approve off") {
		t.Fatalf("the right half must survive a narrow bar: %q", got)
	}
	if !strings.Contains(got, "This turn failed") {
		t.Fatalf("the left half must survive too: %q", got)
	}
}

func TestSpreadClipsTheLeftAtItsLastWord(t *testing.T) {
	// The clip must land on a word boundary near the budget, not on the first
	// space in the line — breaking at the first space leaves a one-word status bar.
	left := "○ Idle · starts after your first message"
	right := "  auto-approve off  ·  context  —  ·  cache hit  —  ·  session  —  ·  audit .tudouni/logs"
	got := visible(spreadStyled(left, right, 120))
	if !strings.Contains(got, "Idle · starts after") {
		t.Fatalf("the left was cut far too early: %q", got)
	}
	if runewidth.StringWidth(got) > 120 {
		t.Fatalf("wider than the bar: %d", runewidth.StringWidth(got))
	}
}
