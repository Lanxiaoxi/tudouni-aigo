package tui

import (
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The input line is an editor, not a string that things get appended to.
//
// The original inherited this from Textual's TextArea: a caret you can move, a
// newline you can type, and the usual readline-ish keys. Without a caret the only
// way to fix a typo is to delete everything after it, which is the difference
// between a prompt and a text box.
//
// It is drawn in **two rows** with soft wrapping, which is where the wrap logic
// below comes from: two rows double the amount of a pasted log or path that is
// visible at once, and the caret has to be kept inside that window.

// inputRow is one visual row of the editor: the rune range it covers.
type inputRow struct {
	start, end int
	text       string
}

// inputRows wraps the buffer into visual rows at the given width.
//
// Word wrapping, like the transcript: a hard break in the middle of a path is
// worse than in the middle of a sentence, and both are worse than a break at a
// space. A newline in the buffer is an explicit break and never gets merged.
func inputRows(text string, width int) []inputRow {
	if width < 1 {
		width = 1
	}
	runes := []rune(text)
	rows := make([]inputRow, 0, 2)
	start := 0
	for {
		end, column, lastSpace := start, 0, -1
		for end < len(runes) && runes[end] != '\n' {
			cell := runewidth.RuneWidth(runes[end])
			if column+cell > width {
				break
			}
			if runes[end] == ' ' {
				lastSpace = end
			}
			column += cell
			end++
		}
		switch {
		case end < len(runes) && runes[end] == '\n':
			rows = append(rows, inputRow{start, end, string(runes[start:end])})
			start = end + 1
			if start > len(runes) {
				return rows
			}
		case end == len(runes):
			rows = append(rows, inputRow{start, end, string(runes[start:end])})
			return rows
		case lastSpace > start:
			rows = append(rows, inputRow{start, lastSpace, string(runes[start:lastSpace])})
			start = lastSpace + 1
		default:
			rows = append(rows, inputRow{start, end, string(runes[start:end])})
			start = end
		}
	}
}

// rowOf is the visual row the caret sits on. A caret at a row's end belongs to
// that row, not the next one — otherwise typing at a wrap point would jump the
// viewport down for every character.
func rowOf(rows []inputRow, cursor int) int {
	for index, row := range rows {
		if cursor <= row.end {
			return index
		}
	}
	return len(rows) - 1
}

// inputWindow is the pair of rows the box shows: the caret's row and the one
// above it, or the first two rows while the caret is still near the top. It is
// "keep the caret visible with the least movement", which is what a two-row
// editor should do — jumping to always show the last two rows would scroll the
// text under the caret as you type.
func inputWindow(rows []inputRow, cursor int) (int, []inputRow) {
	if len(rows) <= 2 {
		padded := append([]inputRow{}, rows...)
		for len(padded) < 2 {
			index := len(padded)
			padded = append(padded, inputRow{start: index, end: index})
		}
		return 0, padded
	}
	first := rowOf(rows, cursor) - 1
	if first < 0 {
		first = 0
	}
	if first > len(rows)-2 {
		first = len(rows) - 2
	}
	return first, rows[first : first+2]
}

// caretCell is the caret's column within its row, in cells.
func caretCell(row inputRow, cursor int) int {
	runes := []rune(row.text)
	offset := cursor - row.start
	if offset < 0 {
		offset = 0
	}
	if offset > len(runes) {
		offset = len(runes)
	}
	return runewidth.StringWidth(string(runes[:offset]))
}

// ── editing ───────────────────────────────────────────────────────────────────

// runesOf is the buffer as runes, with the caret clamped into range. Every
// editing operation goes through it so a stale caret can never panic.
func (m model) runesOf() ([]rune, int) {
	runes := []rune(m.input)
	cursor := m.inputCursor
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(runes) {
		cursor = len(runes)
	}
	return runes, cursor
}

func (m *model) insertText(text string) {
	runes, cursor := m.runesOf()
	inserted := []rune(text)
	out := make([]rune, 0, len(runes)+len(inserted))
	out = append(out, runes[:cursor]...)
	out = append(out, inserted...)
	out = append(out, runes[cursor:]...)
	m.input = string(out)
	m.inputCursor = cursor + len(inserted)
}

func (m *model) backspace() {
	runes, cursor := m.runesOf()
	if cursor == 0 {
		return
	}
	m.input = string(append(runes[:cursor-1], runes[cursor:]...))
	m.inputCursor = cursor - 1
}

func (m *model) deleteForward() {
	runes, cursor := m.runesOf()
	if cursor >= len(runes) {
		return
	}
	m.input = string(append(runes[:cursor], runes[cursor+1:]...))
}

// deleteWordBack deletes back to the start of the previous word, the way
// Ctrl+W does in a shell: whitespace first, then the word's characters.
func (m *model) deleteWordBack() {
	runes, cursor := m.runesOf()
	end := cursor
	for end > 0 && runes[end-1] == ' ' {
		end--
	}
	for end > 0 && runes[end-1] != ' ' {
		end--
	}
	m.input = string(append(runes[:end], runes[cursor:]...))
	m.inputCursor = end
}

// deleteToLineStart is Ctrl+U.
func (m *model) deleteToLineStart() {
	runes, cursor := m.runesOf()
	start := cursor
	for start > 0 && runes[start-1] != '\n' {
		start--
	}
	m.input = string(append(runes[:start], runes[cursor:]...))
	m.inputCursor = start
}

func (m *model) moveCaret(delta int) {
	m.inputCursor += delta
	runes := []rune(m.input)
	if m.inputCursor < 0 {
		m.inputCursor = 0
	}
	if m.inputCursor > len(runes) {
		m.inputCursor = len(runes)
	}
}

// moveCaretLineStart / End work on the **logical** line, so Shift+Enter's
// newlines behave the way a person expects from Home and End.
func (m *model) moveCaretLineStart() {
	runes, cursor := m.runesOf()
	for cursor > 0 && runes[cursor-1] != '\n' {
		cursor--
	}
	m.inputCursor = cursor
}

func (m *model) moveCaretLineEnd() {
	runes, cursor := m.runesOf()
	for cursor < len(runes) && runes[cursor] != '\n' {
		cursor++
	}
	m.inputCursor = cursor
}

// moveCaretRow moves the caret one *visual* row up or down, keeping its column.
// It is what Up/Down mean inside a wrapped box.
func (m *model) moveCaretRow(width, delta int) {
	rows := inputRows(m.input, width)
	current := rowOf(rows, m.inputCursor)
	target := current + delta
	if target < 0 || target >= len(rows) {
		return
	}
	column := caretCell(rows[current], m.inputCursor)
	runes := []rune(rows[target].text)
	offset, cell := 0, 0
	for offset < len(runes) {
		next := runewidth.RuneWidth(runes[offset])
		if cell+next > column {
			break
		}
		cell += next
		offset++
	}
	m.inputCursor = rows[target].start + offset
}

// atFirstRow / atLastRow report whether the caret is already at the top or the
// bottom of the box, which is when Up/Down fall through to the transcript.
func (m model) atFirstRow(width int) bool {
	return rowOf(inputRows(m.input, width), m.inputCursor) == 0
}

func (m model) atLastRow(width int) bool {
	rows := inputRows(m.input, width)
	return rowOf(rows, m.inputCursor) >= len(rows)-1
}

// inputView renders the two editable rows with the caret drawn in place.
//
// The caret is a reverse-video cell rather than the terminal's own cursor: a
// full-screen program owns the screen, and painting the cell is the only way to
// keep it where the text is after a resize or a redraw.
func (m model) inputView(width int) []string {
	if m.input == "" {
		// The placeholder fills both rows: it is the only thing telling a first
		// user what this box does, and a single line of it looked like a label.
		lines := wrapCells(i18n.T("input.placeholder"), width)
		out := make([]string, 0, 2)
		for index := 0; index < len(lines) && index < 2; index++ {
			out = append(out, currentTheme.styleFor("rule").Render(lines[index]))
		}
		for len(out) < 2 {
			out = append(out, "")
		}
		return out
	}
	all := inputRows(m.input, width)
	caretRow := rowOf(all, m.inputCursor)
	first, window := inputWindow(all, m.inputCursor)
	out := make([]string, 0, len(window))
	for offset, row := range window {
		if first+offset == caretRow {
			out = append(out, m.renderCaretRow(row))
			continue
		}
		out = append(out, currentTheme.styleFor("user").Render(row.text))
	}
	return out
}

// renderCaretRow draws one row with the caret cell reversed. At the end of the
// text the caret is a reversed space, so it is visible where there is no
// character to reverse.
func (m model) renderCaretRow(row inputRow) string {
	runes := []rune(row.text)
	textStyle := currentTheme.styleFor("user")
	caretStyle := currentTheme.styleFor("caret")
	offset := m.inputCursor - row.start
	if offset < 0 {
		offset = 0
	}
	if offset > len(runes) {
		offset = len(runes)
	}
	at := " "
	after := ""
	if offset < len(runes) {
		at = string(runes[offset])
		after = string(runes[offset+1:])
	}
	return textStyle.Render(string(runes[:offset])) +
		caretStyle.Render(at) +
		textStyle.Render(after)
}
