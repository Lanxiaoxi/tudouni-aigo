package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The rail: the context column that holds what the run is doing.
//
// It is **docked right** (see `renderBodySplit`) — the one deliberate departure
// from the original's layout, which docks this column on the left. The blocks
// themselves are the original's, cell for cell.
//
// Six blocks, each introduced by a colour bar. The bar is the rail_bar role — a
// **softened** version of the theme's line colour, because one full-strength
// stroke per block competes with the body text for attention, and an anchor is
// supposed to be the quiet layer. The eye counts the segments by walking the bar.
//
// The block order is **not** interchangeable. The first four are the order the
// design fixed (tasks / skills / permissions / session); jobs and MCP were
// appended because they are the two blocks that stand for something *alive* on
// this machine, and they belong together at the end. Moving one of them into the
// middle shifts every block below it, and "which block is where" is the muscle
// memory a person builds between two glances.

const railWidth = 32

// railBlock is one titled section of the rail.
type railBlock struct {
	title string
	count string
	rows  []string
	empty string
	hint  string
}

func (m model) railBlocks() []railBlock {
	return []railBlock{
		{
			title: i18n.T("rail.tasks"),
			count: todoCount(m.panel.todos),
			rows:  todoRows(m.panel.todos),
			empty: i18n.T("rail.tasks.empty"), hint: i18n.T("rail.tasks.empty_hint"),
		},
		{
			title: i18n.T("rail.skills"),
			// The count is what is *loaded*, and "0" is a real answer here — the
			// block's own title says "Loaded skills", so it must not look as if the
			// list failed to arrive.
			count: fmt.Sprintf("%d", len(m.panel.skills)),
			rows:  skillRows(m.panel.skills),
			empty: i18n.T("rail.skills.empty"), hint: i18n.T("rail.skills.empty_hint"),
		},
		{
			title: i18n.T("rail.permissions"),
			rows:  m.permissionRows(),
			empty: i18n.T("rail.permissions.empty"), hint: "",
		},
		{
			title: i18n.T("rail.session"),
			rows:  m.sessionRows(),
			empty: i18n.T("rail.session.empty"), hint: i18n.T("rail.session.empty_hint"),
		},
		{
			title: i18n.T("rail.jobs"),
			count: jobCount(m.panel.jobs),
			rows:  jobRows(m.panel.jobs),
			empty: i18n.T("rail.jobs.empty"), hint: i18n.T("rail.jobs.empty_hint"),
		},
		{
			title: i18n.T("rail.mcp"),
			count: mcpCount(m.panel.mcp),
			rows:  mcpRows(m.panel.mcp),
			empty: i18n.T("rail.mcp.empty"), hint: i18n.T("rail.mcp.empty_hint"),
		},
	}
}

// renderRail draws the rail at the given width.
//
// When the six blocks do not fit, the **top** is what survives. The original's
// rail is a scroll container that starts at the top; trimming from the bottom
// instead threw away the task list — with its title and its progress bar — which
// is the one block the rail opens itself for.
func (m model) renderRail(width, height int) string {
	// The title carries no bold: every block shouting would mean nothing shouts.
	// It is the same grey as the body — it says "what this block is called", and
	// the count rides right next to it so the eye reads them together.
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	emptyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))

	var out []string
	flush := func(lines []string) bool {
		if len(out)+len(lines) > height {
			return false
		}
		out = append(out, lines...)
		return true
	}
	for _, block := range m.railBlocks() {
		head := titleStyle.Render(block.title)
		if block.count != "" {
			head += titleStyle.Render(" · " + block.count)
		}
		// Every row sits one cell off the bar, the title included: that gutter is
		// the block's padding in the original, and it is what makes the bar read as
		// a frame around the block rather than as a prefix on the first word.
		// Content and empty states share it — they used to differ, which showed up
		// as the empty state indented one cell deeper than the rows that replace it.
		bar := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.railBar))
		row := func(text string) string { return bar.Render("▌") + " " + text }
		var lines []string
		// The title is clipped rather than wrapped: it is a heading, and a heading
		// on two lines reads as two rows of content.
		lines = append(lines, row(clipStyled(head, width-2)))
		if len(block.rows) == 0 {
			// The empty state wraps like any other row. It is two sentences of
			// English in a 32-column column, and drawing them unwrapped pushed them
			// past the rail's own background — and, since the two halves are joined
			// side by side, past the screen's right edge with them: the rail is the
			// last block in that join, so an over-wide row widens the frame instead
			// of sliding the conversation over.
			for _, sentence := range []string{block.empty, block.hint} {
				if sentence == "" {
					continue
				}
				for _, physical := range wrapCells(emptyStyle.Render(sentence), width-2) {
					lines = append(lines, row(physical))
				}
			}
		} else {
			for _, content := range block.rows {
				for _, physical := range wrapCells(content, width-2) {
					lines = append(lines, row(physical))
				}
			}
		}
		lines = append(lines, "")
		if !flush(lines) {
			// Out of room: draw what still fits of this block and stop. Whole
			// blocks first keeps a half-drawn block from looking like a complete
			// one with missing rows.
			for _, line := range lines {
				if len(out) >= height {
					break
				}
				out = append(out, line)
			}
			break
		}
	}
	for len(out) < height {
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}

// sessionRows is the "which conversation is this" block: the id, the model and
// its window, the thinking switch, the size, the context figure, where the audit
// goes, and which AGENT.md files were spliced in at the start.
func (m model) sessionRows() []string {
	if m.sessionID == "" {
		return nil
	}
	var rows []string
	rows = append(rows, currentTheme.styleFor("process").Render(m.sessionID))
	if m.panel.model != "" {
		modelRow := currentTheme.styleFor("skill").Render(m.panel.model)
		if m.panel.window != nil {
			modelRow += currentTheme.styleFor("rule").Render("  " + windowText(m.panel.window))
		}
		rows = append(rows, modelRow)
	}
	// Thinking-off is the one state worth a standing line: on is what the
	// endpoint does by default, and a default does not need a row. The effort
	// level rides on the same line, and **only when thinking is off** — writing
	// "off · high" on its own line would suggest high is still in effect.
	if !m.panel.thinking {
		line := currentTheme.styleFor("warn").Render(i18n.T("rail.session.thinking_off"))
		if m.panel.effort != "" {
			line += currentTheme.styleFor("rule").Render(
				i18n.T("rail.session.effort", "effort", m.panel.effort))
		}
		rows = append(rows, line)
	}
	if m.panel.messages > 0 {
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("rail.session.size",
			"messages", i18n.Tn("rail.session.messages", m.panel.messages, "n", m.panel.messages),
			"steps", i18n.Tn("rail.session.steps", m.panel.steps, "n", m.panel.steps))))
	}
	if used, cached := m.panel.promptTokens, m.panel.cachedTokens; used != nil {
		_ = cached
		window := intOf(m.panel.window)
		if window > 0 {
			rows = append(rows, currentTheme.styleFor("rule").Render(
				i18n.T("status.context.percent",
					"used", stateTokensText(*used), "total", stateTokensText(window),
					"percent", fmt.Sprintf("%.1f", float64(*used)/float64(window)*100))))
		} else {
			rows = append(rows, currentTheme.styleFor("rule").Render(
				i18n.T("status.context.used", "used", stateTokensText(*used))))
		}
	}
	if m.auditPath != "" {
		rows = append(rows, currentTheme.styleFor("rule").Render(
			i18n.T("status.audit", "path", m.auditDirShort())))
	}
	// Which AGENT.md files were spliced into this session's system message. It
	// belongs here rather than in a block of its own: it is the same kind of fact
	// as the session id — decided when the session started, different per session
	// — and the startup notice that says it scrolls away, while "did my AGENT.md
	// take effect" is a question people ask again later.
	for _, item := range m.panel.agentsMD {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := row["path"].(string)
		if name == "" {
			name = "?"
		}
		failed := false
		if value, ok := row["failed"].(bool); ok {
			failed = value
		}
		truncated := false
		if value, ok := row["truncated"].(bool); ok {
			truncated = value
		}
		// Truncated is marked differently from failed on purpose: the content did
		// get in, just not all of it, and sharing the `!` would read as "this file
		// had no effect".
		mark := ""
		if failed {
			mark = "! "
		} else if truncated {
			mark = "… "
		}
		detail := ""
		if failed {
			detail, _ = row["reason"].(string)
		} else {
			lines := intOf(row["lines"])
			detail = i18n.Tn("rail.session.agent_md_lines", lines, "n", lines)
		}
		role := "rule"
		if failed {
			role = "warn"
		}
		line := currentTheme.styleFor(role).Render(mark + name)
		if detail != "" {
			line += currentTheme.styleFor("rule").Render("  " + detail)
		}
		rows = append(rows, line)
	}
	return rows
}

// todoRows opens with the progress bar — one cell per task, compressed past
// twenty — because the question this block answers is "how much is left", and a
// fixed ten-cell bar turns that into a division problem.
func todoRows(todos []any) []string {
	var rows []string
	done := todoDone(todos)
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
		mark, role := "·", "process"
		switch status {
		case "pending":
			mark = "○"
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

func todoDone(todos []any) int {
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
	return done
}

// todoCount is the badge beside the Tasks title. Before the first task list it
// is empty rather than "0 / 0": the block already says "No tasks yet", and a
// zero beside it says the same thing twice.
func todoCount(todos []any) string {
	if len(todos) == 0 {
		return ""
	}
	return fmt.Sprintf("%d / %d", todoDone(todos), len(todos))
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
		// Rounded, not floored: one task out of thirty is one visible cell, and
		// flooring it draws an empty bar for a session that has started.
		filled = int(float64(done)*float64(cells)/float64(total) + 0.5)
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
	return i18n.Tn("rail.summary.tasks", len(todos),
		"done", todoDone(todos), "total", len(todos))
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
		// Numbers arrive as float64 through JSON; a bare type assertion on int
		// always failed, which is how every running job read "running 0s".
		seconds := intOf(row["seconds"])
		// Four states, four shapes — they answer four different questions. The
		// one that gets the eye is **uncollected**: the command finished and you
		// do not know whether it succeeded, which is exactly where backgrounding
		// silently goes wrong.
		mark, role := "·", "rule"
		tail := ""
		switch state {
		case "running":
			mark, role = "◐", "process"
			tail = i18n.T("rail.job.running", "span", fmt.Sprintf("%ds", seconds))
		case "uncollected":
			mark, role = "✓", "waiting"
			tail = i18n.T("rail.job.uncollected", "code", row["exit_code"])
		case "killed":
			mark, role = "—", "rule"
			tail = i18n.T("rail.job.killed")
		default:
			tail = i18n.T("rail.job.done", "code", row["exit_code"])
		}
		line := currentTheme.styleFor(role).Render(mark+" ") +
			currentTheme.styleFor("process").Render(command) +
			currentTheme.styleFor("rule").Render("  "+tail)
		rows = append(rows, line)
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
		tools := intOf(row["tools"])
		if state != "loaded" {
			// Only the running ones belong here: an unmounted server holds no
			// process and has no business taking a row in this block. The panel
			// answers "what is configured but not mounted".
			continue
		}
		rows = append(rows, currentTheme.styleFor("answer").Render("● ")+
			currentTheme.styleFor("process").Render(name)+
			currentTheme.styleFor("rule").Render(i18n.Tn("rail.mcp.tools", tools, "n", tools)))
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

// mcpCount reports `running / configured`. The denominator is what lets someone
// see the servers they have not mounted, instead of reading "three configured,
// one up" as broken.
func mcpCount(servers []any) string {
	if len(servers) == 0 {
		return ""
	}
	running, total := mcpTally(servers)
	return fmt.Sprintf("%d / %d", running, total)
}

// jobCount reports `outstanding / total`: "how many things are still hanging" is
// what this block answers, and "seven have been started" is not.
func jobCount(jobs []any) string {
	if len(jobs) == 0 {
		return ""
	}
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
	return fmt.Sprintf("%d / %d", outstanding, len(jobs))
}

// permissionRows lists all three risk levels with the disposition the runtime
// computed — the interface does not know "low is the default", that is the
// config's knowledge, and deriving it here would be a second definition. The
// colour lands on medium and high only: low is the norm, and colouring the norm
// colours nothing.
//
// The three remembered-exception rows carry a label rather than a bare colour:
// they are the user's own exceptions, not risks, and painting them in the risk
// colour would leave the two lines that *are* risks standing out less.
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
		// An unrecognised disposition prints itself: `auto_something` is
		// searchable, and a marker is not.
		word := i18n.LookupOr("rail.permission."+disposition, disposition)
		rows = append(rows, currentTheme.styleFor("process").Render(fmt.Sprintf("%-7s", risk))+
			currentTheme.styleFor(role).Render(word))
	}
	if names := stringList(m.panel.granted); len(names) > 0 {
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("rail.permission.granted"))+
			currentTheme.styleFor("process").Render(" "+strings.Join(names, i18n.T("list.separator"))))
	}
	if rules := stringList(m.panel.prefixes); len(rules) > 0 {
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("rail.permission.prefixes"))+
			currentTheme.styleFor("process").Render(" "+strings.Join(rules, i18n.T("list.separator"))))
	}
	if names := stringList(m.panel.denied); len(names) > 0 {
		rows = append(rows, currentTheme.styleFor("denied").Render(i18n.T("rail.permission.denied")+
			strings.Join(names, i18n.T("list.separator"))))
	}
	if len(rows) == 0 {
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("rail.permission.by_level")))
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
