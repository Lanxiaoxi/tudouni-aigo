package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// Layout: top bar (chrome) / rail + transcript / status bar (chrome) /
// input box with its two accent rules. The bars are the only chrome-coloured
// surfaces; everything else is the terminal's or the theme's background, which
// is what keeps the deep clear variant looking like one connected slab.

// minRailWidth is where the rail stops being worth its columns. Below it the
// rail is dropped rather than squeezed: half of every field is worse than none.
const minRailWidth = 100

const inputHeight = 3 // two editable lines + the caret row the input occupies

// View draws the whole screen.
func (m model) View() string {
	if m.width == 0 {
		return ""
	}
	height := m.height
	if height <= 0 {
		height = 24
	}

	top := m.renderTopBar()
	status := m.renderStatusBar()
	prompt := m.renderInput()
	bodyHeight := height - lipgloss.Height(top) - lipgloss.Height(status) - lipgloss.Height(prompt)
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	body := m.renderBody(bodyHeight)
	return strings.Join([]string{top, body, status, prompt}, "\n")
}

func (m model) bodyHeight() int {
	return m.height - 5
}

// chromeStyle paints a full-width bar in the theme's chrome role.
func chromeStyle(width int) lipgloss.Style {
	style := lipgloss.NewStyle().Width(width)
	if !currentTheme.clearRoles["chrome"] {
		style = style.Background(lipgloss.Color(currentTheme.chrome))
	}
	return style
}

func (m model) renderTopBar() string {
	name := m.sessionID
	if name == "" {
		name = i18n.T("session.bar.unnamed")
	}
	left := i18n.T("session.bar.session", "name", name)
	right := i18n.T("session.bar.rail_hint")
	text := chromeStyle(m.width).Render(spread(left, right, m.width))
	return text
}

func (m model) renderBody(available int) string {
	if m.pendingPermission != nil {
		return lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderPermissionDialog())
	}
	if m.pendingQuestion != nil {
		return lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderQuestionDialog())
	}
	if m.overlay.kind != overlayNone {
		return lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderOverlay(m.width-8))
	}
	if len(m.transcript) == 0 {
		return m.renderWelcome(m.width)
	}
	return m.renderBodySplit(available)
}

func (m model) renderBodySplit(available int) string {
	showRail := !m.railHidden && m.width >= minRailWidth
	if !showRail {
		return m.renderTranscript(m.width, available)
	}
	transcriptWidth := m.width - railWidth - 1
	rail := m.renderRail(railWidth, available)
	transcript := m.renderTranscript(transcriptWidth, available)
	return lipgloss.JoinHorizontal(lipgloss.Top, rail, " ", transcript)
}

// renderTranscript draws the conversation, newest at the bottom.
//
// Wrapping is done in cells, not runes: a CJK character occupies two columns,
// and counting characters would push every line past the right edge.
func (m model) renderTranscript(width, height int) string {
	width = maxInt(width-2, 20)
	var rows []string
	for index := range m.transcript {
		rows = append(rows, m.renderEntry(index, width)...)
	}

	if len(rows) == 0 {
		rows = append(rows, "")
	}
	end := len(rows) - m.scroll
	if end > len(rows) {
		end = len(rows)
	}
	if end < 0 {
		end = 0
	}
	start := end - height
	if start < 0 {
		start = 0
	}
	visible := rows[start:end]
	for len(visible) < height {
		visible = append(visible, "")
	}
	return strings.Join(visible, "\n")
}

// renderEntry draws one transcript entry as physical lines.
func (m model) renderEntry(index int, width int) []string {
	item := m.transcript[index]
	switch {
	case item.turn != nil:
		return m.renderTurn(item.turn, width)
	case item.kind == "assistant":
		// The finished answer is markdown. A `● ` marks it as the agent's voice
		// the way `> ` marks the user's.
		lines := renderMarkdown(item.text, width-3)
		out := make([]string, 0, len(lines))
		for lineIndex, line := range lines {
			if lineIndex == 0 {
				out = append(out, currentTheme.styleFor("answer").Render("● ")+line)
			} else {
				out = append(out, "  "+line)
			}
		}
		return append(out, "")
	case item.kind == "streaming":
		return []string{currentTheme.styleFor("answer").Render("● ") +
			currentTheme.styleFor("answer").Render(wrapCells(m.streamedText, width-3)...)}
	case item.kind == "user":
		return wrapCells(renderOne(item.line), width)
	default:
		out := wrapCells(renderOne(item.line), width)
		return append(out, "")
	}
}

// renderTurn draws one turn block: header with its rule, the user line, the
// event lines, the thinking block, and (during streaming) the live text.
func (m model) renderTurn(turn *turnData, width int) []string {
	var out []string
	out = append(out, m.renderTurnHeader(turn, width)...)

	if turn.userInput != "" {
		for lineIndex, line := range wrapCells(turn.userInput, width-4) {
			if lineIndex == 0 {
				out = append(out, currentTheme.styleFor("user").Render("  > ")+line)
			} else {
				out = append(out, "    "+line)
			}
		}
	}
	for _, line := range turn.lines {
		out = append(out, wrapCells(renderOne(line), width)...)
	}

	// The thinking block: one folded line by default, the quote block when this
	// turn is expanded. Both paths share the same constructors.
	if turn.thinking != "" {
		chars := runewidth.StringWidth(turn.thinking)
		if turn.expanded {
			out = append(out, renderOne(thinkingFolded(turn, chars, "")))
			out = append(out, thinkingBody(turn.thinking, width)...)
		} else {
			out = append(out, renderOne(thinkingFolded(turn, chars, "")))
		}
	} else if m.thinkingLive && m.thinkingChars > 0 && turn.runID == m.streamRunID {
		// Streaming: the spin frame and the live count — only while something
		// is actually running, and only in quiet mode where nothing else moves.
		out = append(out, renderOne(thinkingFolded(turn, m.thinkingChars, m.spinnerFrame())))
	}
	out = append(out, "")
	return out
}

// renderTurnHeader draws `Turn 1 ──── running · step 1`. The rule is hairline —
// present but quiet; the state on the right is the part that changes.
func (m model) renderTurnHeader(turn *turnData, width int) []string {
	header := turnHeader(turn)
	left := header.segments[0]
	right := ""
	rightRole := "rule"
	if len(header.segments) > 1 {
		rightRole = header.segments[1].role
		for _, part := range header.segments[1:] {
			right += part.text
		}
	}
	leftWidth := runewidth.StringWidth(left.text)
	rightWidth := runewidth.StringWidth(right)
	rule := 0
	if width > leftWidth+rightWidth+6 {
		rule = width - leftWidth - rightWidth - 6
	}
	ruleText := ""
	if rule > 0 {
		ruleText = " " + strings.Repeat("─", rule) + " "
	}
	return wrapCells(currentTheme.styleFor(left.role).Render(left.text)+
		currentTheme.styleFor("rule").Render(ruleText)+
		currentTheme.styleFor(rightRole).Render(right), width)
}

func (m model) renderStatusBar() string {
	left := i18n.T("status.idle")
	if len(m.transcript) == 0 && !m.busy {
		left = i18n.T("status.idle.new")
	}
	switch {
	case m.busy && m.quiet && m.spinnerFrame() != "":
		left = m.spinnerFrame() + " " + m.activity
	case m.busy && m.activity != "":
		left = "● " + m.activity
	case m.busy:
		left = "● " + i18n.T("turn.running")
	}

	parts := []string{}
	if m.panel.autopilot {
		parts = append(parts, i18n.T("status.autopilot.on_short"))
	}
	if m.quiet {
		parts = append(parts, i18n.T("status.quiet"))
	}
	parts = append(parts, contextText(m.panel))
	right := strings.Join(parts, " · ")
	return chromeStyle(m.width).Render(spread(left, right, m.width))
}

// contextText reports the estimate against the usable budget. When the window
// is unknown it degrades to usage only — a wrong percentage gets believed.
func contextText(s panelstate) string {
	if s.context == nil {
		return i18n.T("status.context.none")
	}
	stats, _ := s.context["context"].(map[string]any)
	used := intOf(stats["estimated_tokens"])
	limit := intOf(stats["limit_tokens"])

	if limit <= 0 {
		return i18n.T("status.context.used", "used", stateTokensText(used))
	}
	percent := fmt.Sprintf("%.0f", float64(used)/float64(limit)*100)
	return i18n.T("status.context.percent",
		"used", stateTokensText(used),
		"total", stateTokensText(limit),
		"percent", percent)
}

// stateTokensText formats a token count for humans (14.1k / 1.0M).
func stateTokensText(n int) string {
	return state.TokensText(&n)
}

// renderInput is the two-line input with its accent rules — the only
// high-contrast border on the screen, because this is where the eye should be.
func (m model) renderInput() string {
	ruleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent))
	textStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink))
	placeholderStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	hint := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))

	rule := ruleStyle.Render(strings.Repeat("─", maxInt(m.width-2, 4)))
	inner := maxInt(m.width-4, 10)
	lines := strings.Split(m.input, "\n")
	for len(lines) < 2 {
		lines = append(lines, "")
	}
	first, second := lines[len(lines)-2], lines[len(lines)-1]
	first = clipText(first, inner)
	second = clipText(second, inner)

	var body string
	if m.input == "" {
		body = placeholderStyle.Render(i18n.T("input.placeholder"))
	} else {
		caret := ""
		if len(lines) > 2 {
			caret = hint.Render(fmt.Sprintf("  ↑+%d ", len(lines)-2))
		}
		body = textStyle.Render(first) + "\n" + textStyle.Render(second) + caret
	}
	return "\n" + rule + "\n" + " " + body + "\n" + rule
}

// renderPermissionDialog draws one approval request.
//
//   - the arguments are printed **whole** — they are the material for the
//     decision, and a truncated shell command hides the half that matters;
//   - the hint lines are reproduced verbatim: they contain facts this program
//     cannot reconstruct;
//   - a key the runtime did not offer is not shown.
func (m model) renderPermissionDialog() string {
	request := m.pendingPermission
	risk, _ := protocol.String(request, "risk")

	head := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.danger)).Bold(true)
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.danger)).
		Background(lipgloss.Color(currentTheme.elevated)).
		Padding(0, 1).
		Width(min(m.width-8, 96))

	var builder strings.Builder
	builder.WriteString(head.Render(i18n.T("permission_dialog.head")) + "\n")
	kind := i18n.T("permission_dialog.kind_builtin")
	if protocol.BoolOr(request, "external", false) {
		kind = i18n.T("permission_dialog.kind_external")
	}
	builder.WriteString(i18n.T("permission_dialog.title", "kind", kind, "risk", risk) + "\n\n")

	arguments, _ := request["arguments"].(map[string]any)
	if len(arguments) == 0 {
		builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink3)).
			Render(i18n.T("permission_dialog.no_args")) + "\n")
	} else {
		names := make([]string, 0, len(arguments))
		for name := range arguments {
			names = append(names, name)
		}
		sortStrings(names)
		for _, name := range names {
			builder.WriteString(fmt.Sprintf("  %s = %s\n", name, renderArgument(arguments[name])))
		}
	}

	builder.WriteString("\n")
	if hint, ok := protocol.String(request, "remember_hint"); ok && hint != "" {
		builder.WriteString(i18n.T("permission_dialog.always") + "   " + hint + "\n")
	}
	if allowAll, _ := request["allow_trust_all"].(bool); allowAll {
		if hint, ok := protocol.String(request, "trust_all_hint"); ok && hint != "" {
			builder.WriteString(i18n.T("permission_dialog.allow_all") + "   " + hint + "\n")
		}
	}
	builder.WriteString("\n" + i18n.T("permission_dialog.allow") + "   " +
		i18n.T("permission_dialog.deny"))
	if request["remember"] != nil {
		builder.WriteString("   " + i18n.T("permission_dialog.always"))
	}
	builder.WriteString("\n" + lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
		Render(i18n.T("permission_dialog.footer")))

	return box.Render(builder.String())
}

func (m model) renderQuestionDialog() string {
	request := m.pendingQuestion
	question, _ := protocol.String(request, "question")
	header, _ := protocol.String(request, "header")

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Background(lipgloss.Color(currentTheme.elevated)).
		Padding(0, 1).
		Width(min(m.width-8, 96))

	var builder strings.Builder
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent)).Bold(true).
		Render(i18n.T("question_dialog.head")) + "\n")
	if header != "" {
		builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).Bold(true).
			Render(header) + "\n")
	}
	builder.WriteString(question + "\n\n")

	options, _ := request["options"].([]any)
	if len(options) == 0 {
		builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink3)).
			Render(i18n.T("question_dialog.no_options")) + "\n")
	} else {
		for index, item := range options {
			text, _ := item.(string)
			builder.WriteString(fmt.Sprintf("  %d) %s\n", index+1, text))
		}
	}
	builder.WriteString("\n> " + m.questionInput + "\n\n")
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
		Render(i18n.T("question_dialog.skip") + "\n" + i18n.T("question_dialog.footer2")))

	return box.Render(builder.String())
}

func renderArgument(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return "(empty)"
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// spread puts one string on the left and one on the right of a line, measured
// in cells so a CJK session id does not push the right half out of alignment.
func spread(left, right string, width int) string {
	leftWidth := runewidth.StringWidth(left)
	rightWidth := runewidth.StringWidth(right)
	padding := width - leftWidth - rightWidth
	if padding < 1 {
		return left
	}
	return left + strings.Repeat(" ", padding) + right
}

// wrapCells wraps text at a number of terminal cells.
func wrapCells(text string, width int) []string {
	if width <= 1 {
		return []string{text}
	}
	var out []string
	var current strings.Builder
	column := 0
	for _, char := range text {
		cellWidth := runewidth.RuneWidth(char)
		if column+cellWidth > width {
			out = append(out, current.String())
			current.Reset()
			column = 0
		}
		current.WriteRune(char)
		column += cellWidth
	}
	out = append(out, current.String())
	return out
}

func secondsText(seconds int) string {
	return fmt.Sprintf("%ds", seconds)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
