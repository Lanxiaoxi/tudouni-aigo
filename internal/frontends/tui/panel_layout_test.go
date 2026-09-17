package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
	"github.com/muesli/termenv"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// **Force a colour profile in these tests.** This is not a detail: with no
// profile lipgloss strips every style, the escape bytes vanish, and the wrap
// arithmetic changes. The reported bug — a selected row whose highlight spanned
// three lines — was invisible in a colourless render and reproduced immediately
// with a profile set.
func withColour(t *testing.T) {
	t.Helper()
	previous := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	t.Cleanup(func() { lipgloss.SetColorProfile(previous) })
}

func panelLines(t *testing.T, rendered string) []string {
	t.Helper()
	return strings.Split(rendered, "\n")
}

func widestLine(lines []string) int {
	widest := 0
	for _, line := range lines {
		if width := runewidth.StringWidth(stripANSI(line)); width > widest {
			widest = width
		}
	}
	return widest
}

// TestPanelsDoNotReflowTheirRows is the regression for the reported bug.
//
// Every panel draws one line per row. The frame *will* reflow a row that does not
// fit its content width, and its wrap does not agree with this program's about
// ANSI escapes, so a styled row measures wider than it looks, wraps early, and the
// selected row's highlight ends up two or three lines tall.
//
// The test makes that observable without hardcoding line counts: select the row
// with the longest text and the row with the shortest, and require the same number
// of lines. A row that reflows changes the count for one of them.
func TestPanelsDoNotReflowTheirRows(t *testing.T) {
	withColour(t)
	const termWidth = 120
	frameWidth := overlayFrameWidth(termWidth-8) + 2

	cases := []struct {
		name  string
		setup func(m *model)
		count int
	}{
		{
			name: "command palette",
			setup: func(m *model) {
				m.input = "/"
				m.inputCursor = 1
				m.overlay = overlay{kind: overlayCommand}
			},
			count: len(commands()),
		},
		{
			name: "option picker",
			setup: func(m *model) {
				m.overlay = overlay{kind: overlayOptions, title: i18nTitle("model.pick.title"),
					options: []option{
						{value: "a", row: "short", note: ""},
						{value: "b", row: strings.Repeat("long-option-name ", 4), note: ""},
						{value: "c", row: "middle", note: ""},
					}}
			},
			count: 3,
		},
		{
			name: "mcp panel",
			setup: func(m *model) {
				m.panel.mcp = []any{
					map[string]any{"name": "kb", "state": "loaded", "tools": 3},
					map[string]any{"name": "remote", "state": "failed",
						"error": strings.Repeat("connection refused ", 6)},
				}
				m.overlay = overlay{kind: overlayMCP}
			},
			count: 2,
		},
		{
			name: "session picker",
			setup: func(m *model) {
				m.sessionOptions = []option{
					{value: "a", row: "20260917-120000-abcd  12 messages · 4 steps   short"},
					{value: "b", row: strings.Repeat("20260917-120000-efgh ", 4)},
				}
				m.overlay = overlay{kind: overlaySessions}
			},
			count: 2,
		},
		{
			name: "skills panel",
			setup: func(m *model) {
				m.skillRows = []skillRow{
					{name: "short", description: "brief"},
					{name: "long-skill-name", description: strings.Repeat("a long description ", 6)},
				}
				m.overlay = overlay{kind: overlaySkills}
			},
			count: 2,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			counts := map[int]int{}
			for cursor := 0; cursor < testCase.count; cursor++ {
				m := filledModel(termWidth, 40)
				m.railHidden = true
				testCase.setup(&m)
				m.overlay.cursor = cursor
				rendered := m.renderOverlay(termWidth - 8)
				lines := panelLines(t, rendered)
				counts[cursor] = len(lines)
				if widest := widestLine(lines); widest > frameWidth {
					t.Errorf("cursor %d: a line is %d cells wide (frame %d)", cursor, widest, frameWidth)
				}
				// One line per row: the head, the rows and the footers, plus the
				// frame's two padding rows and two border rows.
				for _, line := range lines {
					if runewidth.StringWidth(stripANSI(line)) != frameWidth {
						t.Errorf("cursor %d: line is not the frame's width: %q",
							cursor, stripANSI(line))
						break
					}
				}
			}
			first := -1
			for cursor, count := range counts {
				if first < 0 {
					first = count
					continue
				}
				if count != first {
					t.Fatalf("the panel reflows a row: %d lines with cursor %d but %d with another — a selected row that wraps",
						count, cursor, first)
				}
			}
		})
	}
}

// TestOverlayInnerIsTheRowBudget pins the arithmetic the panels depend on: the
// frame's `Width()` includes its 1,2 padding and the border is added on top, so a
// row budgeted to `overlayInner` never has to be reflowed.
func TestOverlayInnerIsTheRowBudget(t *testing.T) {
	for _, width := range []int{40, 72, 80, 112, 200} {
		frame := overlayFrameWidth(width)
		inner := overlayInner(width)
		if frame > overlayMaxWidth {
			t.Fatalf("frame width %d exceeds the maximum", frame)
		}
		if inner != frame-4 {
			t.Errorf("overlayInner(%d) = %d, want frame(%d) - 4", width, inner, frame)
		}
		// A row that fills the budget exactly must survive as one line.
		row := strings.Repeat("x", inner)
		if rows := wrapCells(row, inner); len(rows) != 1 {
			t.Errorf("a row of exactly %d cells wrapped into %d lines", inner, len(rows))
		}
	}
}

// TestThePermissionDialogDoesNotReflow — the dialogs use `Padding(0,1)`, so their
// row budget is boxWidth-2, and a long command must stay on one line inside the
// argument block.
func TestThePermissionDialogDoesNotReflow(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.pendingPermission = map[string]any{
		"id": "p", "tool": "shell", "risk": "high",
		"arguments": map[string]any{
			"command": "rm -rf build/ && CGO_ENABLED=0 go build -trimpath -ldflags -s -w -o dist/tudouni.exe ./cmd/tudouni",
		},
		"remember_hint": strings.Repeat("consequence sentence ", 3),
	}
	lines := panelLines(t, m.renderPermissionDialog())
	// boxWidth is min(width-8,96) = 96, border adds 2.
	if widest := widestLine(lines); widest > 98 {
		t.Errorf("the dialog is %d cells wide (limit 98):\n%s", widest, strings.Join(lines, "\n"))
	}
	// The command is 99 cells; it is allowed to wrap inside its own block, but the
	// block must not be what widens the box.
	for _, line := range lines {
		if runewidth.StringWidth(stripANSI(line)) > 98 {
			t.Fatalf("a dialog line is too wide: %q", stripANSI(line))
		}
	}
}

func i18nTitle(key string) string {
	return i18n.T(key)
}
