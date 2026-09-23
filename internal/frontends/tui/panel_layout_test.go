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
				// One row carries an endpoint, because that is the column that can
				// be arbitrarily long and the reason this panel reflowed: the case
				// below without a `where` is the one that never caught it.
				m.panel.mcp = []any{
					map[string]any{"name": "kb", "state": "loaded", "tools": 6,
						"where": "https://kb.lanxi.me"},
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
				rendered := m.renderOverlay(termWidth-8, m.bodyHeight())
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

// TestASelectedRowAlwaysSetsItsInk — the accent background is the one surface a
// theme may not hand to the terminal.
//
// A transparent palette stores "do not paint" in its `bg`, and `lipgloss.Color`
// drops that sentinel without a word: the selected row came out as
// terminal-default ink on the accent. On a dark terminal that is light text on
// amber — the palette's least readable pair, in the row the cursor is sitting on.
func TestASelectedRowAlwaysSetsItsInk(t *testing.T) {
	withColour(t)
	t.Cleanup(func() { setTheme(defaultTheme) })
	for _, key := range themeOrder {
		setTheme(key)
		row := selectedRow("2  A-T2  石墨琥珀 · 深透明", 40)
		if !strings.Contains(row, "\x1b[38;2;") {
			t.Errorf("%s: the selected row names no foreground: %q", key, row)
		}
		if strings.Contains(row, ansiDefault) {
			t.Errorf("%s: the do-not-paint sentinel reached the renderer: %q", key, row)
		}
	}
}

// TestAnMCPRowsEndpointDoesNotWrapTheRow — the endpoint is the one column on the
// MCP panel that can be arbitrarily long, and it used to be free to run over the
// frame's inner width.
//
// The cost is not a clipped string. A row that does not fit is reflowed by the
// frame, whose wrap disagrees with this program's about ANSI escapes, so the row
// came out as two physical lines and the cursor painted **both** of them as a
// full-width accent bar — the row under the cursor read as a solid bar of colour
// with the server's state pushed off it, and the panel lost its right border.
//
// `https://kb.lanxi.me` is the real endpoint from `~/.tudouni/mcp.json`, and it is
// here rather than a `strings.Repeat` because the bug needs a token that is both
// long and **unbreakable**: the wrapper can only cut at a space, so a long final
// token is what pushes the row over.
func TestAnMCPRowsEndpointDoesNotWrapTheRow(t *testing.T) {
	withColour(t)
	const endpoint = "https://kb.lanxi.me"
	for _, termWidth := range []int{140, 100, 84, 80, 76, 72, 64, 56, 48} {
		m := filledModel(termWidth, 40)
		m.railHidden = true
		m.panel.mcp = []any{map[string]any{
			"name": "kb", "state": "loaded", "tools": 6, "where": endpoint,
		}}
		m.overlay = overlay{kind: overlayMCP, stayOpen: true, title: i18nTitle("mcp_dialog.head")}
		m.overlay.cursor = 0

		rendered := m.renderOverlay(termWidth-8, m.bodyHeight())
		width := overlayFrameWidth(termWidth-8) + 2
		for _, line := range panelLines(t, rendered) {
			if got := runewidth.StringWidth(stripANSI(line)); got != width {
				t.Errorf("term %d: a line is %d cells wide, want %d: %q",
					termWidth, got, width, stripANSI(line))
			}
		}
		// The row itself is one physical line, accent bar included. Two would mean
		// the frame reflowed it, which is the reported shape.
		body := stripANSI(rendered)
		if strings.Count(body, "https://kb.lanxi.me") > 1 {
			t.Errorf("term %d: the endpoint was drawn twice, so the row wrapped:\n%s", termWidth, body)
		}
	}
}

// TestALongEndpointIsCutVisibly — when the endpoint cannot fit, it is cut with an
// ellipsis rather than silently ending mid-host.
//
// A remote server's endpoint is the one value on this row a person checks against
// their own config file, so "kb.lanxi" and "kb.lanxi.me" have to be told apart.
func TestALongEndpointIsCutVisibly(t *testing.T) {
	withColour(t)
	m := filledModel(76, 40)
	m.railHidden = true
	m.panel.mcp = []any{map[string]any{
		"name": "kb", "state": "unload", "tools": 0,
		"where": "https://kb.lanxi.me/a/very/long/path/that/cannot/fit",
	}}
	m.overlay = overlay{kind: overlayMCP, stayOpen: true, title: i18nTitle("mcp_dialog.head")}

	inner := overlayInner(76 - 8)
	row := mcpRow{name: "kb", state: "unload", where: "https://kb.lanxi.me/a/very/long/path/that/cannot/fit"}
	text := row.text(len("kb"), inner)
	if width := runewidth.StringWidth(stripANSI(text)); width > inner-1 {
		t.Errorf("the row is %d cells for a budget of %d (the selection marker takes one more): %q",
			width, inner, stripANSI(text))
	}
	if !strings.Contains(stripANSI(text), "…") {
		t.Errorf("a cut row says nothing about being cut: %q", stripANSI(text))
	}
	if !strings.Contains(stripANSI(text), "https://kb.lanxi") {
		t.Errorf("the host is gone entirely, so nothing can be checked: %q", stripANSI(text))
	}
}

// TestTheMCPFooterFitsOneLine — the hint line is the one row on the panel that has
// to be read at a glance, and it was 107 cells long in a 72-cell panel.
//
// The wrapper breaks at a space, so the overflow was not a clipped tail: it was
// the last four words on a second line of their own, which reads as a separate
// sentence rather than as the rest of the hint. The row is dim and the eye lands
// on the cursor's row instead, so the second line looked like stray text left
// under the panel.
func TestTheMCPFooterFitsOneLine(t *testing.T) {
	withColour(t)
	footer := i18n.T("mcp_dialog.footer")
	// 72 is the widest inner width the panel ever has (the frame is capped at 76
	// and loses 4 to its border and padding). It is the width the screenshot's
	// panel had, and the one the hint has to fit.
	if got := len(wrapCells(footer, 72)); got != 1 {
		t.Errorf("the footer wraps into %d lines at inner width 72: %q", got, footer)
	}
	// Narrower than that is a terminal the panel is shrinking into, where wrapping
	// is expected — but it must still break on spaces rather than mid-word.
	for _, line := range wrapCells(footer, 48) {
		if strings.HasSuffix(line, "-") {
			t.Errorf("the footer broke mid-word: %q", line)
		}
	}
}

func i18nTitle(key string) string {
	return i18n.T(key)
}
