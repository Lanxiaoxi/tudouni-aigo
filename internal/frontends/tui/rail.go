package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The rail: the context column that holds what the run is doing.
//
// It is **docked right** (see `renderBodySplit`) — the one deliberate departure
// from the original's layout, which docks this column on the left. The blocks
// themselves are the original's, cell for cell.
//
// Five blocks, each introduced by a colour bar. The bar is the rail_bar role — a
// **softened** version of the theme's line colour, because one full-strength
// stroke per block competes with the body text for attention, and an anchor is
// supposed to be the quiet layer. The eye counts the segments by walking the bar.
//
// There is no Permissions block. It listed low/medium/high against the
// disposition the runtime computed, and that is the same fact the status bar's
// permission chip already carries — one fact drawn twice, in the column that has
// the least room to spare. The granted / command-rule / denied rows that used to
// ride in the same block are gone with it: those are policy, `/tools` is where
// the policy is read.
//
// There is no Session block either. Every fact it carried is stated somewhere
// better, and it cost more rows than the rest of the rail together on a normal
// terminal: the id is on the top bar, the model and the step limit are on the
// session bar, and the context figure, the message/step counts and the audit
// path are on the status bar. The effort level moved onto the session bar beside
// the model. The AGENT.md rows are gone with it — the startup notice that says
// which files were spliced in is where that question is actually asked, and
// keeping a standing copy cost a row per file.
//
// The block order is **not** interchangeable. It is the order the design fixed
// (goal / tasks / skills), with the two blocks that stand for something *alive*
// on this machine — background jobs and MCP — kept in a fixed order after them.
// Jobs sits above MCP because "a command I started" is something the person
// asked for and is watching, while a mounted server is background
// infrastructure. Moving a block shifts every block below it, and "which block is
// where" is the muscle memory a person builds between two glances.

// railMinWidth is where the rail stops being worth its columns, and railMaxWidth
// is where it stops being a column and starts competing with the conversation.
// 32 is the design's own width and the floor here; wider is better for the rows
// that are prose or command lines rather than figures, which wrap at 30 cells.
const (
	railMinWidth = 32
	railMaxWidth = 48
	// transcriptMinWidth is what the conversation keeps, whatever the rail wants.
	// Below it the welcome card and the two-column `/status` sheet stop being
	// readable, and "the rail is comfortable" is paid for with the thing the
	// screen exists for. With railMaxWidth at 48 the two never collide: no
	// terminal this rail is drawn on is narrower than the rail plus this.
	transcriptMinWidth = 48
)

// clipEllipsis marks a row that was cut to fit the rail's own width.
const clipEllipsis = "…"

// railMaxRows caps a block whose content is prose rather than a list. Task rows
// and job rows are lists — the person asked for every one of them, so the cap there
// is a soft one that bites on a short terminal (see clipBlock). The Goal objective
// is unbounded text: one paragraph cost nine rows of a twenty-three-row rail, which
// pushed the three blocks below it off the screen.
const railMaxRows = 6

// goalMaxRows is the Goal block's own cap, and it is one row more than railMaxRows
// on purpose: the row that says "the rest is one `/goal` away" is part of what the
// block draws, so it is the block's last row rather than a row the block budget
// then counts and reports a second time.
const goalMaxRows = railMaxRows + 1

// railWidthFor is the rail's width for a terminal. It scales with the terminal —
// a third of it, minus the chrome — and stops at both ends: 32 because that is
// the design's column, 48 because past that the conversation is paying for the
// rail. Whatever the result, the transcript keeps transcriptMinWidth, so the two
// can never collide and the result is always a drawable column.
func (m model) railWidthFor() int {
	width := m.width/3 - 4
	if width < railMinWidth {
		width = railMinWidth
	}
	if width > railMaxWidth {
		width = railMaxWidth
	}
	if m.width-width < transcriptMinWidth {
		width = m.width - transcriptMinWidth
	}
	return width
}

// railBlock is one titled section of the rail.
type railBlock struct {
	title string
	count string
	rows  []string
	empty string
	hint  string
}

func (m model) railBlocks(width int) []railBlock {
	return []railBlock{
		{
			title: i18n.T("rail.goal"),
			// The badge is the round counter, which is the one number that answers
			// "how much longer can this go on by itself".
			count: goalCount(m.panel.goal),
			rows:  goalRows(m.panel.goal, width),
			empty: i18n.T("rail.goal.empty"), hint: i18n.T("rail.goal.empty_hint"),
		},
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
// When the blocks do not fit, the **top** is what survives: this is a fixed
// column rather than a scroll container, so the alternative is a block that
// cannot be reached at all. Two things keep "does not fit" from being the common
// case: a block whose content is prose is capped (railMaxRows, and the goal's own
// objective cap), and a block that does fall off the bottom is marked as
// truncated instead of being drawn as though it were complete.
func (m model) renderRail(width, height int) string {
	// The title carries no bold: every block shouting would mean nothing shouts.
	// It is the same grey as the body — it says "what this block is called", and
	// the count rides right next to it so the eye reads them together.
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	emptyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))

	var out []string
	for _, block := range m.railBlocks(width - 2) {
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
		var content []string
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
				content = append(content, wrapCells(emptyStyle.Render(sentence), width-2)...)
			}
		} else {
			for _, line := range block.rows {
				content = append(content, wrapCells(line, width-2)...)
			}
		}
		// The title is clipped rather than wrapped: it is a heading, and a heading
		// on two lines reads as two rows of content. The bar is added exactly once,
		// where the row is emitted — adding it here as well drew two of them, which
		// is what the title rows looked like before this was fixed.
		lines := append([]string{clipStyled(head, width-2)}, clipBlock(content, width-2)...)
		lines = append(lines, "")
		if len(out)+len(lines) > height {
			// Out of room: draw what still fits of this block and stop. Whole
			// blocks first keeps a half-drawn block from looking like a complete
			// one with missing rows.
			for _, line := range lines {
				if len(out) >= height {
					break
				}
				out = append(out, row(line))
			}
			break
		}
		for _, line := range lines {
			out = append(out, row(line))
		}
	}
	for len(out) < height {
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}

// clipBlock returns a block's content rows, each already at most railMaxRows
// long, with the rows that did not fit reported in one.
//
// The cap is what keeps a long task list or a long command from taking the whole
// column: the person asked for every row, so the rows are not dropped silently —
// the last row says how many are missing. A row wider than the rail is clipped
// with the same marker, for the same reason: a row that overflows would widen the
// frame the conversation is joined to.
func clipBlock(rows []string, width int) []string {
	kept := make([]string, 0, len(rows)+1)
	hidden := 0
	for _, line := range rows {
		visible := line
		if runewidth.StringWidth(stripANSI(visible)) > width {
			visible = clipStyled(line, width) + clipEllipsis
		}
		if len(kept) >= railMaxRows {
			hidden++
			continue
		}
		kept = append(kept, visible)
	}
	// The count goes on the last row that survived — and only when the last row is
	// not already a "there is more" row of its own. Two markers stacked read as two
	// separate omissions, and the block whose own cap fired has already said its
	// number (see `railMore` and goalRows).
	if hidden > 0 && !isRailMore(kept[len(kept)-1]) {
		kept[len(kept)-1] += currentTheme.styleFor("rule").Render(
			i18n.Tn("rail.more", hidden, "n", hidden))
	}
	return kept
}

// railMore is the style role of a row that says something was left out. It is one
// role rather than three, because "is this row an omission marker" is asked by the
// cap above and must not depend on the wording.
const railMore = "warn"

// isRailMore reports whether a row is an omission marker. The test is on the role
// the row opens with: the row's text is localized and the count is in it, so the
// text is not something to match on.
func isRailMore(row string) bool {
	return strings.Contains(row, currentTheme.styleFor(railMore).Render("x"))
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

// goalRows is the goal block: the objective, the round counter, and whether it is
// still running.
//
// The "not continuing" line is the reason this block exists at all. A goal can be
// active and disarmed — after a resume, after a pause, after the round budget ran
// out — and a panel that showed only the phase would leave a person waiting for
// work that is never going to start.
//
// The objective is the one unbounded string in the rail, so it is capped at the
// rail's own content width: an objective is a paragraph a model wrote, and at 30
// cells of content width the one in this repository's own session took nine rows
// of a twenty-three-row column — the Tasks block and both blocks below it went off
// the screen for it. The cap keeps "did it understand what I asked" answerable
// from the rail; the whole sentence is one `/goal` away, and the row that was cut
// says so.
func goalRows(goal map[string]any, width int) []string {
	objective, _ := goal["objective"].(string)
	if goal == nil || objective == "" {
		return nil
	}
	process := currentTheme.styleFor("process")

	var rows []string
	// A newline is a row break in wrapCells, and an objective is one sentence: a
	// model that wrote one would otherwise spend the whole cap on two physical
	// lines' worth of text.
	objective = strings.ReplaceAll(objective, "\n", " ")
	wrapped := wrapCells(process.Render(objective), width)
	// The cap is six rows of text: the objective is prose, and the block still has
	// to fit its phase and its "continuing / paused" row underneath it.
	if len(wrapped) > railMaxRows {
		hidden := len(wrapped) - railMaxRows
		wrapped = wrapped[:railMaxRows]
		wrapped = append(wrapped, currentTheme.styleFor(railMore).Render(
			i18n.T("rail.goal.more", "n", hidden)))
	}
	rows = append(rows, wrapped...)

	phase, _ := goal["phase"].(string)
	rounds, _ := goal["rounds_text"].(string)
	rows = append(rows, currentTheme.styleFor("rule").Render(
		i18n.T("rail.goal.line", "phase", phase, "rounds", rounds)))

	armed, _ := goal["armed"].(bool)
	role := "waiting"
	text := i18n.T("rail.goal.disarmed")
	if armed {
		role = "answer"
		text = i18n.T("rail.goal.armed")
	}
	rows = append(rows, currentTheme.styleFor(role).Render(text))

	if message, _ := goal["blocked_message"].(string); message != "" {
		rows = append(rows, currentTheme.styleFor("warn").Render(message))
	}
	return rows
}

// goalCount is the badge beside the Goal title: the round counter, or "" when
// there is no goal.
func goalCount(goal map[string]any) string {
	if goal == nil {
		return ""
	}
	objective, _ := goal["objective"].(string)
	if objective == "" {
		return ""
	}
	rounds, _ := goal["rounds_text"].(string)
	return rounds
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

func windowText(window any) string {
	if text, ok := window.(string); ok && text != "" {
		return text
	}
	if number, ok := asInt(window); ok && number > 0 {
		return stateTokensText(number)
	}
	return ""
}
