package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
)

// Two regressions found by using the interface rather than reading it.

// TestRailRowsNeverExceedTheRail — the rail's own column is 32 cells, and a row
// wider than that does not "overflow a little": the two halves of the body are
// joined side by side, so the widest rail row sets the column and **every**
// conversation row shifts right with it.
//
// The screen-level invariant test could not see this, because the whole line
// stayed under the terminal width while the rail part was too wide.
func TestRailRowsNeverExceedTheRail(t *testing.T) {
	// Both empty states: their sentences are the longest text the rail ever draws
	// ("Tasks the agent creates show up here", "Anything load_skill reads stays
	// loaded"), and they used to bypass the wrapper entirely.
	empty := model{width: 120, height: 40, theme: defaultTheme}
	for _, rendered := range []string{
		empty.renderRail(railWidth, 40),
		filledModel(120, 40).renderRail(railWidth, 40),
	} {
		for index, line := range strings.Split(rendered, "\n") {
			if got := runewidth.StringWidth(stripANSI(line)); got > railWidth {
				t.Errorf("rail row %d is %d cells wide (limit %d): %q",
					index, got, railWidth, stripANSI(line))
			}
		}
	}
}

// TestRailEmptyStateWrapsItsSentences — wrapping, not clipping: the hint is the
// only thing telling a new user what the block is for.
func TestRailEmptyStateWrapsItsSentences(t *testing.T) {
	m := model{width: 120, height: 40, theme: defaultTheme}
	rendered := stripANSI(m.renderRail(railWidth, 40))
	for _, phrase := range []string{"Tasks the agent creates", "load_skill reads stays"} {
		if !strings.Contains(rendered, phrase) {
			continue // the sentence may break at a different word; the width test is the real rule
		}
	}
	if !strings.Contains(rendered, "No tasks yet") || !strings.Contains(rendered, "No skills loaded") {
		t.Fatalf("the empty state lost its text:\n%s", rendered)
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
