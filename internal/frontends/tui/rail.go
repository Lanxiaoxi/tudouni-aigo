package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The rail: the left column that holds what the run is doing.
//
// Six blocks, each introduced by a colour bar. The bar is the rail_bar role — a
// **softened** version of the theme's line colour, because one full-strength
// stroke per block competes with the body text for attention, and an anchor is
// supposed to be the quiet layer. The eye counts the segments by walking the bar.

const railWidth = 32

// railBlock is one titled section of the rail.
type railBlock struct {
	title  string
	rows   []string
	empty  string
	hint   string
	marked bool // show the count badge
	count  string
}

func (m model) railBlocks() []railBlock {
	blocks := []railBlock{
		{
			title: i18n.T("rail.tasks"), rows: todoRows(m.panel.todos),
			empty: i18n.T("rail.tasks.empty"), hint: i18n.T("rail.tasks.empty_hint"),
		},
		{
			title: i18n.T("rail.skills"), rows: skillRows(m.panel.skills),
			empty: i18n.T("rail.skills.empty"), hint: i18n.T("rail.skills.empty_hint"),
		},
		{
			title: i18n.T("rail.jobs"), rows: jobRows(m.panel.jobs),
			empty: i18n.T("rail.jobs.empty"), hint: i18n.T("rail.jobs.empty_hint"),
			marked: true, count: jobCount(m.panel.jobs),
		},
		{
			title: i18n.T("rail.mcp"), rows: mcpRows(m.panel.mcp),
			empty: i18n.T("rail.mcp.empty"), hint: i18n.T("rail.mcp.empty_hint"),
			marked: true, count: mcpCount(m.panel.mcp),
		},
		{
			title: i18n.T("rail.permissions"), rows: m.permissionRows(),
			empty: i18n.T("rail.permissions.empty"), hint: "",
		},
		{
			title: i18n.T("rail.session"), rows: m.sessionRows(),
			empty: i18n.T("rail.session.empty"), hint: i18n.T("rail.session.empty_hint"),
		},
	}
	return blocks
}

// renderRail draws the rail at the given width.
func (m model) renderRail(width, height int) string {
	bar := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.railBar))
	// The title carries no bold: every block shouting would mean nothing shouts.
	// It is the same grey as the body — it says "what this block is called",
	// and the count rides right next to it so the eye reads them together.
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	badge := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	emptyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))

	var out []string
	for _, block := range m.railBlocks() {
		head := titleStyle.Render(block.title)
		if block.marked && block.count != "" {
			head += "  " + badge.Render(block.count)
		}
		out = append(out, bar.Render("▌")+head)
		if len(block.rows) == 0 {
			line := "  " + block.empty
			if block.hint != "" {
				line += " — " + block.hint
			}
			for _, physical := range wrapCells(line, width-2) {
				out = append(out, emptyStyle.Render(physical))
			}
		} else {
			for _, row := range block.rows {
				out = append(out, wrapCells(row, width-2)...)
			}
		}
		out = append(out, "")
	}

	// Trim to height, keeping the bottom (the session block matters most).
	if len(out) > height {
		out = out[len(out)-height:]
	}
	for len(out) < height {
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}

func (m model) sessionRows() []string {
	var rows []string
	// The session id leads: everything below answers "which conversation is
	// this", and a timestamp is the handle /resume takes.
	id := m.sessionID
	if id == "" {
		id = i18n.T("session.bar.unnamed")
	}
	rows = append(rows, currentTheme.styleFor("process").Render(id))
	if m.panel.model != "" {
		modelRow := m.panel.model
		if m.panel.window != nil {
			modelRow += "  " + windowText(m.panel.window)
		}
		rows = append(rows, modelRow)
	}
	rows = append(rows, i18n.T("status.session.span",
		"messages", i18n.Tn("status.session.messages", m.panel.messages),
		"steps", i18n.Tn("status.session.steps", m.panel.steps)))
	if m.auditPath != "" {
		rows = append(rows, currentTheme.styleFor("rule").Render(
			clipText(i18n.T("status.audit", "path", m.auditPath), railWidth-4)))
	}
	// Thinking-off is the one state worth a standing line: on is what the
	// endpoint does by default, and a default does not need a row.
	if !m.panel.thinking {
		rows = append(rows, i18n.T("rail.session.thinking_off"))
	}
	if m.panel.effort != "" && m.panel.thinking {
		rows = append(rows, i18n.T("rail.session.effort", "effort", m.panel.effort))
	}
	return rows
}

// todoRows opens with the progress bar — one cell per task, compressed past
// twenty — because the question this block answers is "how much is left", and a
// fixed ten-cell bar turns that into a division problem.
func todoRows(todos []any) []string {
	var rows []string
	done := 0
	for _, item := range todos {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if status, _ := row["status"].(string); status == "completed" {
			done++
		}
	}
	if len(todos) > 0 {
		rows = append(rows, progressBar(done, len(todos)))
	}
	for _, item := range todos {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status, _ := row["status"].(string)
		content, _ := row["content"].(string)
		// Shape first, colour second: a monochrome terminal still tells "todo"
		// from "doing" from "done".
		mark, role := "○", "process"
		switch status {
		case "in_progress":
			mark, role = "◐", "waiting"
		case "completed":
			mark, role = "✓", "answer"
		}
		styled := currentTheme.styleFor(role).Render(mark + " ")
		rows = append(rows, styled+currentTheme.styleFor("process").Render(content))
	}
	return rows
}

// progressBar is one glyph per task. The filled cells are the answer's colour
// when there is something done and the quiet grey when there is not — a bar of
// hollow cells is not worth highlighting.
func progressBar(done, total int) string {
	const maxWidth = 20
	cells := total
	if cells > maxWidth {
		cells = maxWidth
	}
	filled := 0
	if total > 0 {
		filled = done * cells / total
	}
	text := strings.Repeat("▰", filled) + strings.Repeat("▱", cells-filled)
	if total > maxWidth {
		text += fmt.Sprintf(" +%d", total-maxWidth)
	}
	role := "rule"
	if done > 0 {
		role = "answer"
	}
	return currentTheme.styleFor(role).Render(text)
}

// railTodoSummary is the rail summary's task half: the count and what is live.
func railTodoSummary(todos []any) string {
	if len(todos) == 0 {
		return ""
	}
	done := 0
	doing := ""
	for _, item := range todos {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status, _ := row["status"].(string)
		if status == "completed" {
			done++
		}
		if status == "in_progress" && doing == "" {
			doing, _ = row["content"].(string)
		}
	}
	return i18n.Tn("rail.summary.tasks", len(todos), "done", done, "total", len(todos))
}

func jobRows(jobs []any) []string {
	var rows []string
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		state, _ := row["state"].(string)
		command, _ := row["command"].(string)
		seconds, _ := row["seconds"].(int)
		// Four states, four shapes — they answer four different questions. The
		// one that gets the eye is **uncollected**: the command finished and you
		// do not know whether it succeeded, which is exactly where backgrounding
		// silently goes wrong.
		mark, role := "·", "rule"
		tail := ""
		switch state {
		case "running":
			mark, role = "◐", "process"
			tail = i18n.T("rail.job.running", "span", secondsText(seconds))
		case "uncollected":
			mark, role = "✓", "waiting"
			tail = i18n.T("rail.job.uncollected", "code", row["exit_code"])
		case "killed":
			mark, role = "—", "rule"
			tail = i18n.T("rail.job.killed")
		default:
			tail = i18n.T("rail.job.done", "code", row["exit_code"])
		}
		styled := currentTheme.styleFor(role).Render(mark + " ")
		label := "#" + string(rune('0'+len(rows)+1))
		if identifier, ok := row["id"].(string); ok && identifier != "" {
			label = "#" + identifier
		}
		rows = append(rows, styled+label+" "+clipText(command, railWidth-14)+"  "+currentTheme.styleFor("rule").Render(tail))
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
			rows = append(rows, currentTheme.styleFor("skill").Render(name))
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
		tools, _ := asInt(row["tools"])
		if state != "loaded" {
			// Only the running ones belong here: an unmounted server holds no
			// process and has no business taking a row in this block. The panel
			// answers "what is configured but not mounted".
			continue
		}
		rows = append(rows, currentTheme.styleFor("answer").Render("● ")+
			currentTheme.styleFor("process").Render(name)+
			currentTheme.styleFor("rule").Render(i18n.T("rail.mcp.tools", "n", tools)))
	}
	return rows
}

// mcpTally splits the server list into (running, configured).
func mcpTally(servers []any) (int, int) {
	running := 0
	for _, item := range servers {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if state, _ := row["state"].(string); state == "loaded" {
			running++
		}
	}
	return running, len(servers)
}

func mcpCount(servers []any) string {
	running, total := 0, len(servers)
	for _, item := range servers {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if state, _ := row["state"].(string); state == "loaded" {
			running++
		}
	}
	return fmt.Sprintf("%d / %d", running, total)
}

func jobCount(jobs []any) string {
	outstanding := 0
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch state, _ := row["state"].(string); state {
		case "running", "uncollected":
			outstanding++
		}
	}
	if outstanding == 0 {
		return ""
	}
	return fmt.Sprintf("%d / %d", outstanding, len(jobs))
}

// permissionRows lists all three risk levels with the disposition the runtime
// computed — the interface does not know "low is the default", that is the
// config's knowledge, and deriving it here would be a second definition. The
// colour lands on medium and high only: low is the norm, and colouring the norm
// colours nothing.
func (m model) permissionRows() []string {
	var rows []string
	for _, item := range m.panel.riskScope {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		risk, _ := row["risk"].(string)
		disposition, _ := row["disposition"].(string)
		role := "rule"
		switch risk {
		case "high":
			role = "risk_high"
		case "medium":
			role = "risk_medium"
		}
		rows = append(rows, currentTheme.styleFor("process").Render(fmt.Sprintf("%-7s", risk))+
			currentTheme.styleFor(role).Render(i18n.T("rail.permission."+disposition)))
	}
	for _, item := range m.panel.granted {
		if name, ok := item.(string); ok {
			rows = append(rows, currentTheme.styleFor("result").Render("✓ ")+name)
		}
	}
	for _, item := range m.panel.denied {
		if name, ok := item.(string); ok {
			rows = append(rows, currentTheme.styleFor("denied").Render("✗ ")+name)
		}
	}
	return rows
}

func windowText(window any) string {
	if text, ok := window.(string); ok && text != "" {
		return text
	}
	if number, ok := asInt(window); ok && number > 0 {
		return stateTokensText(number)
	}
	return ""
}
