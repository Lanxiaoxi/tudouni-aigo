package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
)

// Two regressions found by using the interface rather than reading it.

// TestRailRowsNeverExceedTheRail — a row wider than the rail's own column does not
// "overflow a little": the two halves of the body are joined side by side, so the
// widest rail row sets the column and **every** conversation row shifts right with
// it.
//
// The screen-level invariant test could not see this, because the whole line
// stayed under the terminal width while the rail part was too wide.
func TestRailRowsNeverExceedTheRail(t *testing.T) {
	// Both empty states: their sentences are the longest text the rail ever
	// draws, and they used to bypass the wrapper entirely.
	empty := model{width: 120, height: 40, theme: defaultTheme}
	for _, probe := range []model{empty, filledModel(120, 40)} {
		width := probe.railWidthFor()
		for _, rendered := range []string{probe.renderRail(width, 40)} {
			for index, line := range strings.Split(rendered, "\n") {
				if got := runewidth.StringWidth(stripANSI(line)); got > width {
					t.Errorf("rail row %d is %d cells wide (limit %d): %q",
						index, got, width, stripANSI(line))
				}
			}
		}
	}
}

// TestRailWidensWithTheTerminal pins the scaling rule: the rail is no longer one
// constant width, and the two ends of the rule are both load-bearing — 32 is the
// design's column, 48 is where it stops being a column, and the conversation keeps
// its own floor at every size in between.
func TestRailWidensWithTheTerminal(t *testing.T) {
	for _, testCase := range []struct{ width, want int }{
		{80, 32}, {100, 32}, {120, 36}, {150, 46}, {200, 48}, {260, 48},
	} {
		m := model{width: testCase.width, height: 40, theme: defaultTheme}
		got := m.railWidthFor()
		if got != testCase.want {
			t.Errorf("at %d columns the rail is %d wide, want %d", testCase.width, got, testCase.want)
		}
		if remaining := testCase.width - got; remaining < transcriptMinWidth {
			t.Errorf("at %d columns the conversation is left %d cells, under the %d floor",
				testCase.width, remaining, transcriptMinWidth)
		}
	}
}

// TestRailEmptyStateWrapsItsSentences — wrapping, not clipping: the hint is the
// only thing telling a new user what the block is for.
//
// The hints are now short enough to fit one row each (the rail's content budget
// is 28 cells — 32 minus the 3-cell bar gutter and the wrap margin), so this
// pins that every block's empty state reaches the screen whole rather than being
// cut off. A hint that silently drops its last word is worse than no hint.
func TestRailEmptyStateWrapsItsSentences(t *testing.T) {
	m := model{width: 120, height: 40, theme: defaultTheme}
	rendered := stripANSI(m.renderRail(m.railWidthFor(), 40))
	for _, text := range []string{
		"No goal", "a goal it keeps resuming",
		"No tasks yet", "what the agent plans to do",
		"No skills loaded", "what load_skill has read",
	} {
		if !strings.Contains(rendered, text) {
			t.Errorf("the empty state lost %q:\n%s", text, rendered)
		}
	}
}

// TestTypingInThePaletteDoesNotRecurse — the palette's filter is the input line,
// so it forwards typing to the editor. Forwarding that through `handleKey`, which
// dispatches on "an overlay is open", re-entered the palette branch for ever:
// every letter typed into the palette killed the program with
// "fatal error: stack overflow".
//
// A test cannot assert "it did not overflow" any other way than by running: the
// failure aborts the whole test binary.
func TestTypingInThePaletteDoesNotRecurse(t *testing.T) {
	m := filledModel(120, 36)
	m.railHidden = true
	// `/` opens the palette, exactly as typing it does.
	next, _ := m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	m = next.(model)
	if m.overlay.kind != overlayCommand {
		t.Fatalf("typing `/` should open the palette, got overlay %v", m.overlay.kind)
	}

	// Then type `theme` into it, one letter at a time.
	for _, letter := range []string{"t", "h", "e", "m", "e"} {
		next, _ = m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(letter)})
		m = next.(model)
	}
	if m.input != "/theme" {
		t.Fatalf("the palette's filter is the input line, so it should read /theme: %q", m.input)
	}
	if rows := m.filteredCommands(); len(rows) == 0 || !strings.HasPrefix(rows[0].name, "/theme") {
		t.Fatalf("the palette did not filter to /theme: %v", rows)
	}

	// Space and backspace are the other two paths through the same branch.
	next, _ = m.handleKey(tea.KeyMsg{Type: tea.KeySpace})
	m = next.(model)
	if m.input != "/theme " {
		t.Fatalf("space should reach the editor: %q", m.input)
	}
	next, _ = m.handleKey(tea.KeyMsg{Type: tea.KeyBackspace})
	m = next.(model)
	if m.input != "/theme" {
		t.Fatalf("backspace should reach the editor: %q", m.input)
	}

	// And the caret keys, which go through the editor too.
	next, _ = m.handleKey(tea.KeyMsg{Type: tea.KeyLeft})
	m = next.(model)
	if m.inputCursor != len([]rune("/theme"))-1 {
		t.Fatalf("left arrow did not move the caret: %d", m.inputCursor)
	}
}

// TestThePaletteStillOpensOnSlashAfterClearing — the editor's "typing `/` opens
// the palette" rule must not fire while the palette is already filtering on a
// bare slash, or every keystroke would reset the cursor position.
func TestThePaletteStillOpensOnSlashAfterClearing(t *testing.T) {
	m := filledModel(120, 36)
	next, _ := m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	m = next.(model)
	if m.overlay.kind != overlayCommand || m.input != "/" {
		t.Fatalf("state after `/`: overlay=%v input=%q", m.overlay.kind, m.input)
	}
}
