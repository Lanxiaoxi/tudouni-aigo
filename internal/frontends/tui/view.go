package tui

import (
	"fmt"
	"os"
	"strings"
	"time"

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
//
// Four bars frame the body — top, session, (rail summary when the rail is
// hidden), status — plus the input box. Every bar is one line of chrome; the
// body is the theme's own background, which is what keeps the deep clear
// variant looking like one connected slab.
func (m model) View() string {
	if m.width == 0 {
		return ""
	}
	height := m.height
	if height <= 0 {
		height = 24
	}

	top := m.renderTopBar()
	session := m.renderSessionBar()
	status := m.renderStatusBar()
	prompt := m.renderInput()
	summary := ""
	if m.railHidden || m.width < minRailWidth {
		summary = m.renderRailSummary()
	}
	bodyHeight := height - lipgloss.Height(top) - lipgloss.Height(session) -
		lipgloss.Height(status) - lipgloss.Height(prompt) - lipgloss.Height(summary)
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	body := m.renderBody(bodyHeight)
	parts := []string{top, session}
	if summary != "" {
		parts = append(parts, summary)
	}
	parts = append(parts, body, status, prompt)
	return strings.Join(parts, "\n")
}

// narrowColumns is where the bars stop carrying their right-hand halves.
const narrowColumns = 120

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

// renderTopBar is the program line: which program, in which workspace. The
// Ctrl+K hint on the right is a hint, not a button — the only honest way to put
// "the palette opens from here" on a canvas with nothing clickable.
func (m model) renderTopBar() string {
	name := currentTheme.styleFor("tool").Render("● ") +
		currentTheme.styleFor("user").Render("tudouni") +
		currentTheme.styleFor("process").Render("  ·  agent_runtime")
	right := ""
	if m.width >= narrowColumns {
		if workspace, err := os.Getwd(); err == nil {
			right += workspace + "  "
		}
		right += currentTheme.styleFor("rule").Render(i18n.T("top.command_palette"))
	}
	return chromeStyle(m.width).Render(spreadStyled(name, right, m.width))
}

// renderSessionBar is the conversation line: which session, which model, what
// budget — plus the permission chip on the right. The chip is deliberately not
// a dropdown: the interface stays hands-off the policy, and a control that looks
// selectable but does nothing is worse than a sentence.
func (m model) renderSessionBar() string {
	narrow := m.width < narrowColumns
	name := m.sessionID
	if name == "" {
		name = i18n.T("session.bar.unnamed")
	}
	left := currentTheme.styleFor("tool").Render("● ") +
		currentTheme.styleFor("answer").Render(i18n.T("session.bar.session", "name", name))
	if m.resumed && !narrow {
		left += currentTheme.styleFor("rule").Render(i18n.T("session.bar.resumed"))
	}
	if m.panel.model != "" && !narrow {
		left += currentTheme.styleFor("process").Render("  ·  " + m.panel.model)
	}
	if !narrow {
		left += currentTheme.styleFor("process").Render(
			i18n.T("session.bar.max_steps", "n", m.options.MaxSteps))
	}

	right := ""
	if narrow {
		right = currentTheme.styleFor("rule").Render(i18n.T("session.bar.rail_hint"))
		return chromeStyle(m.width).Render(spreadStyled(left, right, m.width))
	}
	// The permission chip answers "will it ask me" in one glance. The wording
	// and the colour are the runtime's judgement; the interface only paints it.
	var asking []string
	for _, item := range m.panel.riskScope {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if disposition, _ := row["disposition"].(string); disposition == "ask" {
			risk, _ := row["risk"].(string)
			asking = append(asking, risk)
		}
	}
	switch {
	case len(m.panel.riskScope) == 0:
		right = currentTheme.styleFor("rule").Render(i18n.T("session.bar.no_permissions"))
	case len(asking) > 0:
		right = currentTheme.styleFor("warn").Render(i18n.T("rail.summary.asking",
			"risks", strings.Join(asking, i18n.T("list.separator"))))
	default:
		right = currentTheme.styleFor("result").Render(i18n.T("rail.summary.all_auto"))
	}
	right += currentTheme.styleFor("rule").Render(i18n.T("session.bar.rail_hint_indent"))
	return chromeStyle(m.width).Render(spreadStyled(left, right, m.width))
}

// renderRailSummary is the one-line stand-in for the rail while it is hidden.
// Every block it summarises stays answerable without the 32 columns: which
// risks will ask, what is running in the background, whether any server is up.
func (m model) renderRailSummary() string {
	var parts []string
	if todo := railTodoSummary(m.panel.todos); todo != "" {
		parts = append(parts, todo)
	}
	if count := jobCount(m.panel.jobs); count != "" {
		parts = append(parts, i18n.T("rail.summary.jobs", "count", count))
	}
	if running, total := mcpTally(m.panel.mcp); running > 0 {
		parts = append(parts, i18n.T("rail.summary.mcp", "n", running, "total", total))
	}
	if len(m.panel.skills) > 0 {
		parts = append(parts, i18n.T("rail.summary.skills", "n", len(m.panel.skills)))
	}
	if len(parts) == 0 {
		return ""
	}
	return chromeStyle(m.width).Render(
		currentTheme.styleFor("rule").Render(strings.Join(parts, i18n.T("list.separator"))))
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

	// The welcome screen is a **block in the log**, at the top: the init
	// notices draw beneath it and stay there when the conversation starts.
	// Removing it the moment anything arrives would make it flash — it is the
	// conversation's cover page, not a splash.
	if m.welcomeVisible() {
		rows = append(rows, m.renderWelcome(width)...)
		rows = append(rows, "")
	}
	for index := range m.transcript {
		rows = append(rows, m.renderEntry(index, width)...)
	}

	if len(rows) == 0 {
		rows = append(rows, "")
	}
	if m.welcomeVisible() {
		// The cover page pins to the **top**: the init notices can be taller
		// than it, and scrolling to the bottom would push the boxes' top edge
		// off-screen — which reads as "this screen starts mid-way".
		start := 0
		visible := rows[:min(height, len(rows))]
		_ = start
		for len(visible) < height {
			visible = append(visible, "")
		}
		return strings.Join(visible, "\n")
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
		// The finished answer is markdown, framed by an accent bar on the left —
		// the same colour family as the input rules and the turn rules, because
		// "structural lines" are one family on this screen. The bar is what says
		// "this is the agent speaking" now that the body is a block, not lines.
		lines := renderMarkdown(item.text, width-3)
		out := make([]string, 0, len(lines))
		for _, line := range lines {
			out = append(out, currentTheme.styleFor("tool").Render("│ ")+line)
		}
		return append(out, "")
	case item.kind == "streaming":
		// While it streams, the head `● ` sits on its own line and the body
		// stays plain text: re-flowing markdown on every delta stutters on
		// exactly the messages long enough to be worth formatting.
		head := currentTheme.styleFor("answer").Render("  ● ")
		body := wrapCells(m.streamedText, width-3)
		out := []string{head}
		for _, line := range body {
			out = append(out, currentTheme.styleFor("tool").Render("│ ")+
				currentTheme.styleFor("answer").Render(line))
		}
		return out
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
	} else if m.thinkingLive && m.thinkingText != "" && turn.runID == m.streamRunID {
		if m.quiet {
			// Quiet mode folds it: one line, the spin frame and the live count
			// — the only thing moving on a screen where nothing else does.
			out = append(out, renderOne(thinkingFolded(turn, m.thinkingChars, m.spinnerFrame())))
		} else {
			// Normal mode spreads it out and rewrites the block whole on every
			// chunk. One chunk is often one word; appending per-chunk would
			// lay 400 characters over 100 lines.
			out = append(out, renderOne(thinkingStreamHead()))
			out = append(out, thinkingBody(m.thinkingText, width)...)
		}
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
	// The rule is **accent** — the same colour as the input rules and the
	// welcome boxes' borders, because on this screen "structural lines" are one
	// family. A hairline rule vanished against the background, and a blank line
	// cannot tell "the last turn ended" from "one extra line happened".
	return wrapCells(currentTheme.styleFor(left.role).Render(left.text)+
		lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent)).Render(ruleText)+
		currentTheme.styleFor(rightRole).Render(right), width)
}

// renderStatusBar paints "what is it doing" on the left and "modes + the cost
// of this run" on the right. The right segment starts with two spaces: the left
// is clipped at the boundary when long, and without the gap "step 3 / 30" and
// "auto-approve on" read as one sentence.
func (m model) renderStatusBar() string {
	narrow := m.width < narrowColumns
	left := m.renderStatusLeft(narrow)

	right := "  "
	right += m.autopilotBadge(narrow)
	if m.quiet {
		right += currentTheme.styleFor("rule").Render("  ·  ") +
			currentTheme.styleFor("tool").Render(i18n.T("status.quiet"))
	}
	if n := outstandingJobs(m.panel.jobs); n > 0 {
		right += currentTheme.styleFor("rule").Render("  ·  ") +
			currentTheme.styleFor("tool").Render(i18n.Tn("status.jobs.running", n, "n", n))
	}
	right += currentTheme.styleFor("rule").Render("  ·  " + m.statusRight(narrow))
	return chromeStyle(m.width).Render(spreadStyled(left, right, m.width))
}

// renderStatusLeft is the mark plus what the runtime last said it was doing.
// The mark's colour follows the phase, so "running / done / interrupted" read
// apart at a glance; the words stay in the secondary ink so the line never
// shouts.
func (m model) renderStatusLeft(narrow bool) string {
	markColour := currentTheme.ink4
	text := i18n.T("status.idle")
	if len(m.transcript) == 0 && !m.busy {
		text = i18n.T("status.idle.new")
	}
	mark := "●"
	if m.busy {
		markColour = currentTheme.accent
		if m.quiet {
			mark = m.spinnerFrame()
		}
		if m.activity != "" {
			text = m.activity
		} else {
			text = i18n.T("turn.running")
		}
	}
	return currentTheme.styleMark(markColour).Render(mark) +
		currentTheme.styleFor("answer").Render(" "+text)
}

// autopilotBadge is always on the bar — both states — because its meaning is
// "will it ask me next", and an empty cell cannot tell "off" from "not drawn".
func (m model) autopilotBadge(narrow bool) string {
	word := i18n.T("status.autopilot.off_short")
	role := "rule"
	if m.panel.autopilot {
		word = i18n.T("status.autopilot.on_short")
		role = "warn"
	}
	return currentTheme.styleFor(role).Render(word)
}

// statusRight is the cost of this run: context, cache hit, this turn's time,
// where the audit is written. Narrow screens keep the first two numbers and
// drop the tail — the audit path is the one thing that can also be asked for
// with /audit.
func (m model) statusRight(narrow bool) string {
	parts := []string{contextText(m.panel)}
	if !narrow {
		if m.current != nil {
			parts = append(parts, i18n.T("status.turn",
				"duration", durationText(time.Since(m.current.startedAt))))
		}
		parts = append(parts, i18n.T("status.audit", "path", m.auditPath))
	}
	return strings.Join(parts, "  ·  ")
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

// renderInput is the two-line input inside its accent rules — the only
// high-contrast border on the screen, because it is where the eye should be.
// The box sits on chrome, like the three bars above it.
func (m model) renderInput() string {
	ruleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent))
	textStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink))
	placeholderStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	hint := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	promptStyle := currentTheme.styleFor("tool")

	rule := ruleStyle.Render(strings.Repeat("─", maxInt(m.width, 4)))
	inner := maxInt(m.width-6, 10)
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
	row := promptStyle.Render("> ") + body
	if !currentTheme.clearRoles["chrome"] {
		row = lipgloss.NewStyle().Background(lipgloss.Color(currentTheme.chrome)).
			Width(m.width).Render(row)
	}
	return "\n" + rule + "\n" + row + "\n" + rule
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
	return spreadStyled(left, right, width)
}

// spreadStyled is spread for pre-styled halves: the padding is computed from
// the **visible** width (ANSI stripped), because escape sequences have no width
// but do have length.
func spreadStyled(left, right string, width int) string {
	leftWidth := runewidth.StringWidth(stripANSI(left))
	rightWidth := runewidth.StringWidth(stripANSI(right))
	padding := width - leftWidth - rightWidth
	if padding < 1 {
		return left
	}
	return left + strings.Repeat(" ", padding) + right
}

// wrapCells wraps text at a number of terminal cells.
//
// ANSI escape sequences pass through untouched and cost **zero** columns. This
// is not an optimisation — it is the difference between a wrapped line and
// mangled output: a sequence broken mid-way leaves the tail (`8;2;131;121;104m`)
// as visible text, and every count that treated the sequence as printable width
// wrapped lines far too early. Styled rows are the norm here, so the escape
// handling lives in the one wrapper everything goes through.
func wrapCells(text string, width int) []string {
	if width <= 1 {
		return []string{text}
	}
	var out []string
	var current strings.Builder
	column := 0
	inEscape := false
	for _, char := range text {
		if inEscape {
			current.WriteRune(char)
			if char == 'm' {
				inEscape = false
			}
			continue
		}
		if char == '\x1b' {
			inEscape = true
			current.WriteRune(char)
			continue
		}
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
