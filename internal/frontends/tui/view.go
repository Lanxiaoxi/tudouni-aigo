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

// The palette. One light theme and one dark, chosen by whether the terminal
// reports a dark background — a hard-coded set of colours that reads well on one
// background is unreadable on the other, and the person looking at it cannot tell
// that the program chose wrong.
var (
	styleUser      = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	styleAssistant = lipgloss.NewStyle()
	styleEvent     = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	styleNotice    = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	styleError     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9"))
	styleBar       = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	styleTitle     = lipgloss.NewStyle().Bold(true)
	styleDialog    = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1)
)

// minRailWidth is where the rail stops being worth its columns. Below it the rail
// is dropped entirely rather than squeezed: a panel showing half of every field is
// worse than no panel.
const minRailWidth = 80
const railWidth = 28

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

	// The dialogs take over the body: an approval request is the only thing that
	// matters while it is up, and drawing the transcript behind it would only make
	// the decision harder to read.
	body := ""
	switch {
	case m.pendingPermission != nil:
		body = m.renderPermissionDialog()
	case m.pendingQuestion != nil:
		body = m.renderQuestionDialog()
	default:
		body = m.renderBody(height - 4)
	}

	return strings.Join([]string{top, body, status, prompt}, "\n")
}

func (m model) renderTopBar() string {
	name := i18n.T("session.bar.unnamed")
	if session := m.panel.model; session != "" {
		name = session
	}
	left := i18n.T("session.bar.session", "name", name)
	if m.options.SessionID != "" {
		left = i18n.T("session.bar.session", "name", m.options.SessionID)
	}
	right := i18n.T("session.bar.rail_hint")
	return spread(left, right, m.width, styleBar)
}

func (m model) renderBody(available int) string {
	if available < 3 {
		available = 3
	}
	showRail := !m.railHidden && m.width >= minRailWidth
	if !showRail {
		return m.renderTranscript(m.width, available)
	}
	transcriptWidth := m.width - railWidth - 1
	rail := m.renderRail(railWidth, available)
	transcript := m.renderTranscript(transcriptWidth, available)
	return lipgloss.JoinHorizontal(lipgloss.Top, rail, " ", transcript)
}

// renderTranscript draws the conversation.
//
// Wrapping is done in cells, not runes: a Chinese character occupies two columns,
// and counting characters instead would push every line past the right edge — which
// looks like a bug in the content rather than in the layout.
func (m model) renderTranscript(width, height int) string {
	var rows []string
	for _, entry := range m.transcript {
		prefix := "  "
		style := styleAssistant
		switch entry.kind {
		case "user":
			prefix = "> "
			style = styleUser
		case "event":
			style = styleEvent
		case "notice":
			style = styleNotice
		case "error":
			style = styleError
		}
		for index, physical := range strings.Split(entry.text, "\n") {
			head := prefix
			if index > 0 {
				head = "  "
			}
			rows = append(rows, style.Render(head)+wrapCells(physical, width-2))
		}
	}

	// The scroll offset counts lines back from the bottom, so the newest line is
	// always where the eye already is.
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

// renderRail draws the six blocks that describe the run.
func (m model) renderRail(width, height int) string {
	var builder strings.Builder
	block := func(title string, rows []string, empty, hint string) {
		builder.WriteString(styleTitle.Render(title) + "\n")
		if len(rows) == 0 {
			builder.WriteString(styleBar.Render("  "+empty) + "\n")
			if hint != "" {
				builder.WriteString(styleBar.Render("  "+hint) + "\n")
			}
		} else {
			for _, row := range rows {
				builder.WriteString("  " + wrapCells(row, width-3) + "\n")
			}
		}
		builder.WriteString("\n")
	}

	block(i18n.T("rail.tasks"), todoRows(m.panel.todos),
		i18n.T("rail.tasks.empty"), i18n.T("rail.tasks.empty_hint"))

	block(i18n.T("rail.jobs"), jobRows(m.panel.jobs),
		i18n.T("rail.jobs.empty"), i18n.T("rail.jobs.empty_hint"))

	block(i18n.T("rail.skills"), skillRows(m.panel.skills),
		i18n.T("rail.skills.empty"), i18n.T("rail.skills.empty_hint"))

	block(i18n.T("rail.mcp"), mcpRows(m.panel.mcp),
		i18n.T("rail.mcp.empty"), i18n.T("rail.mcp.empty_hint"))

	block(i18n.T("rail.permissions"), m.permissionRows(), "", "")

	sessionRows := []string{
		i18n.T("status.session.span",
			"messages", i18n.Tn("status.session.messages", m.panel.messages),
			"steps", i18n.Tn("status.session.steps", m.panel.steps)),
	}
	if m.panel.model != "" {
		sessionRows = append(sessionRows, m.panel.model)
	}
	if !m.panel.thinking {
		sessionRows = append(sessionRows, i18n.T("rail.session.thinking_off"))
	}
	block(i18n.T("rail.session"), sessionRows,
		i18n.T("rail.session.empty"), i18n.T("rail.session.empty_hint"))

	lines := strings.Split(strings.TrimRight(builder.String(), "\n"), "\n")
	if len(lines) > height {
		lines = lines[:height]
	}
	return strings.Join(lines, "\n")
}

func todoRows(todos []any) []string {
	var rows []string
	for _, item := range todos {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status, _ := row["status"].(string)
		content, _ := row["content"].(string)
		mark := "[ ]"
		switch status {
		case "in_progress":
			mark = "[~]"
		case "completed":
			mark = "[x]"
		}
		rows = append(rows, mark+" "+content)
	}
	return rows
}

func jobRows(jobs []any) []string {
	var rows []string
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		state, _ := row["state"].(string)
		id, _ := row["id"].(string)
		seconds := intOf(row["seconds"])
		switch state {
		case "running":
			rows = append(rows, fmt.Sprintf("#%s "+i18n.T("rail.job.running"), id, secondsText(seconds)))
		case "uncollected":
			rows = append(rows, fmt.Sprintf("#%s "+i18n.T("rail.job.uncollected"), id, row["exit_code"]))
		default:
			rows = append(rows, fmt.Sprintf("#%s "+i18n.T("rail.job.done"), id, row["exit_code"]))
		}
	}
	return rows
}

func skillRows(skills []any) []string {
	var rows []string
	for _, item := range skills {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := row["name"].(string)
		if name != "" {
			rows = append(rows, name)
		}
	}
	return rows
}

func mcpRows(servers []any) []string {
	var rows []string
	for _, item := range servers {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := row["name"].(string)
		state, _ := row["state"].(string)
		rows = append(rows, fmt.Sprintf("%s (%s)", name, state))
	}
	return rows
}

// permissionRows renders the risk levels with the disposition the runtime computed.
//
// The disposition is not derived here: which levels run without asking is the
// policy's judgement, and re-deriving it would drift by *showing the wrong thing on
// the one line that says whether you will be asked*.
func (m model) permissionRows() []string {
	var rows []string
	for _, item := range m.panel.riskScope {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		risk, _ := row["risk"].(string)
		disposition, _ := row["disposition"].(string)
		text := i18n.T("rail.permission.ask")
		if disposition == "auto" {
			text = i18n.T("rail.permission.auto")
		}
		rows = append(rows, fmt.Sprintf("%-7s %s", risk, text))
	}
	for _, item := range m.panel.granted {
		if name, ok := item.(string); ok {
			rows = append(rows, name+" "+i18n.T("rail.permission.granted"))
		}
	}
	for _, item := range m.panel.denied {
		if name, ok := item.(string); ok {
			rows = append(rows, i18n.T("rail.permission.denied")+name)
		}
	}
	return rows
}

func (m model) renderStatusBar() string {
	left := i18n.T("status.idle")
	switch {
	case m.busy && m.activity != "":
		left = m.activity
	case m.busy:
		left = i18n.T("turn.running")
	}

	parts := []string{}
	if m.panel.autopilot {
		parts = append(parts, i18n.T("status.autopilot.on"))
	}
	parts = append(parts, contextText(m.panel))
	if m.quiet {
		parts = append(parts, i18n.T("status.quiet"))
	}
	right := strings.Join(parts, " · ")
	return spread(left, right, m.width, styleBar)
}

// contextText is the status bar's context segment.
//
// It reports the estimate against the **usable budget**, not the raw window: the
// budget is what a turn can actually spend (window minus the reply reserve minus
// headroom), and a ratio against the raw window would advertise headroom that
// does not exist. When the window is unknown it degrades to usage only — a wrong
// percentage is worse than none, because it gets believed.
func contextText(s panelstate) string {
	if s.context == nil {
		return i18n.T("status.context.none")
	}
	stats, _ := s.context["context"].(map[string]any)
	used := intOf(stats["estimated_tokens"])
	limit := intOf(stats["limit_tokens"])

	if limit <= 0 {
		return i18n.T("status.context.used", "used", state.TokensText(&used))
	}
	percent := fmt.Sprintf("%.0f", float64(used)/float64(limit)*100)
	return i18n.T("status.context.percent",
		"used", state.TokensText(&used),
		"total", state.TokensText(&limit),
		"percent", percent)
}

func (m model) renderInput() string {
	// Shift+Enter inserts a newline, so the prompt shows the last physical line
	// while the buffer keeps them all.
	lines := strings.Split(m.input, "\n")
	last := lines[len(lines)-1]
	if m.input == "" {
		return styleBar.Render("> ") + styleBar.Render(i18n.T("input.placeholder"))
	}
	return "> " + last
}

// renderPermissionDialog draws one approval request.
//
// Four details in here are not cosmetic:
//
//   - the arguments are printed **whole**. They are the material for the decision,
//     and a truncated shell command hides the half that matters;
//   - the hint lines from the runtime are reproduced verbatim. They contain facts
//     this program cannot reconstruct — what exactly gets remembered, and that a
//     trust group is a snapshot;
//   - a key that the runtime did not offer is not shown. Offering "always allow"
//     when there is nothing to remember produces a key that appears to work and
//     changes nothing;
//   - Escape denies. It is the same direction as an unreadable input, and there is
//     no third state the runtime could move to anyway.
func (m model) renderPermissionDialog() string {
	request := m.pendingPermission
	risk, _ := protocol.String(request, "risk")

	var builder strings.Builder
	builder.WriteString(styleError.Render(i18n.T("permission_dialog.head")) + "\n\n")

	kind := i18n.T("permission_dialog.kind_builtin")
	if protocol.BoolOr(request, "external", false) {
		kind = i18n.T("permission_dialog.kind_external")
	}
	builder.WriteString(i18n.T("permission_dialog.title", "kind", kind, "risk", risk) + "\n\n")

	arguments, _ := request["arguments"].(map[string]any)
	if len(arguments) == 0 {
		builder.WriteString(styleBar.Render(i18n.T("permission_dialog.no_args")) + "\n")
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
	builder.WriteString("\n\n" + styleBar.Render(i18n.T("permission_dialog.footer")))

	return styleDialog.Width(min(m.width-4, 96)).Render(builder.String())
}

func (m model) renderQuestionDialog() string {
	request := m.pendingQuestion
	question, _ := protocol.String(request, "question")
	header, _ := protocol.String(request, "header")

	var builder strings.Builder
	builder.WriteString(styleTitle.Render(i18n.T("question_dialog.head")) + "\n\n")
	if header != "" {
		builder.WriteString(styleTitle.Render(header) + "\n")
	}
	builder.WriteString(question + "\n\n")

	options, _ := request["options"].([]any)
	if len(options) == 0 {
		builder.WriteString(styleBar.Render(i18n.T("question_dialog.no_options")) + "\n")
	} else {
		for index, item := range options {
			text, _ := item.(string)
			builder.WriteString(fmt.Sprintf("  %d) %s\n", index+1, text))
		}
	}
	builder.WriteString("\n> " + m.questionInput + "\n\n")
	builder.WriteString(styleBar.Render(i18n.T("question_dialog.skip")) + "\n")
	builder.WriteString(styleBar.Render(i18n.T("question_dialog.footer2")))

	return styleDialog.Width(min(m.width-4, 96)).Render(builder.String())
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

// spread puts one string on the left and one on the right of a line.
//
// The padding is measured in cells, so a Chinese session id or a Chinese
// placeholder does not push the right half out of alignment.
func spread(left, right string, width int, style lipgloss.Style) string {
	leftWidth := runewidth.StringWidth(left)
	rightWidth := runewidth.StringWidth(right)
	padding := width - leftWidth - rightWidth
	if padding < 1 {
		return style.Render(left)
	}
	return left + strings.Repeat(" ", padding) + style.Render(right)
}

// wrapCells wraps text at a number of terminal cells.
func wrapCells(text string, width int) string {
	if width <= 1 {
		return text
	}
	var out strings.Builder
	column := 0
	for _, char := range text {
		cellWidth := runewidth.RuneWidth(char)
		if column+cellWidth > width {
			out.WriteRune('\n')
			column = 0
		}
		out.WriteRune(char)
		column += cellWidth
	}
	return out.String()
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
