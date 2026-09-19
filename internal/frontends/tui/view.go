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

	top := m.renderTopBar()
	session := m.renderSessionBar()
	status := m.renderStatusBar()
	prompt := m.renderInput()
	summary := ""
	// The summary is a **narrow-screen** form. On a wide terminal the session
	// bar's `Ctrl+B context rail` already says how to get the rail back, and a
	// second line repeating the contents is one row of vertical space for
	// nothing.
	if m.showRailSummary() {
		summary = m.renderRailSummary()
	}
	body := m.renderBody(m.bodyHeight())
	parts := []string{top, session}
	if summary != "" {
		parts = append(parts, summary)
	}
	parts = append(parts, body, status, prompt)
	return strings.Join(parts, "\n")
}

// showRailSummary reports whether the narrow-screen stand-in for the rail is
// drawn. View and bodyHeight must agree on it, or the body is measured for a
// frame that is not the one being drawn.
func (m model) showRailSummary() bool {
	return m.width < narrowColumns && (m.railHidden || m.width < minRailWidth)
}

// bodyHeight is how many rows the body has: the terminal minus the bars and the
// input box.
//
// It is a method rather than an expression inside View because **the scroll
// window is measured in these rows** and the empty state is fitted into them:
// two places deriving the number separately is how a window ends up one row
// taller than the frame and pushes the status bar off the bottom.
func (m model) bodyHeight() int {
	height := m.height
	if height <= 0 {
		height = 24
	}
	rows := lipgloss.Height(m.renderTopBar()) + lipgloss.Height(m.renderSessionBar()) +
		lipgloss.Height(m.renderStatusBar()) + lipgloss.Height(m.renderInput())
	if m.showRailSummary() {
		rows += lipgloss.Height(m.renderRailSummary())
	}
	if body := height - rows; body >= 3 {
		return body
	}
	return 3
}

// narrowColumns is where the bars stop carrying their right-hand halves.
const narrowColumns = 120

// chromeRow paints one full-width bar.
//
// It goes through paintRow rather than a lipgloss Width+Background style so the
// background survives the resets inside the row: a bar is several coloured
// segments, and every one of them ends with a reset that would otherwise clear
// the background for the rest of the line.
func chromeRow(text string, width int) string {
	if currentTheme.clearRoles["chrome"] {
		return padCells(text, width)
	}
	return paintRow(text, width, currentTheme.chrome)
}

// padCells pads a row out to width without painting anything.
func padCells(text string, width int) string {
	if visible := runewidth.StringWidth(stripANSI(text)); visible < width {
		return text + strings.Repeat(" ", width-visible)
	}
	return text
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
	return chromeRow(spreadStyled(name, right, m.width), m.width)
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
	// The limit the runtime is actually enforcing, not the flag: the two can
	// differ, and a bar advertising "up to 5 steps" over a run allowed forty is
	// worse than saying nothing.
	if m.maxSteps > 0 && !narrow {
		left += currentTheme.styleFor("process").Render(
			i18n.T("session.bar.max_steps", "n", m.maxSteps))
	}

	right := ""
	if narrow {
		right = currentTheme.styleFor("rule").Render(i18n.T("session.bar.rail_hint"))
		return chromeRow(spreadStyled(left, right, m.width), m.width)
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
	return chromeRow(spreadStyled(left, right, m.width), m.width)
}

// renderRailSummary is the one-line stand-in for the rail while it is hidden.
// Every block it summarises stays answerable without the 32 columns: which
// risks will ask, what is running in the background, whether any server is up.
//
// It opens with the key that brings the rail back. Without that the line only
// says what is missing, and "collapsed" becomes indistinguishable from "gone".
func (m model) renderRailSummary() string {
	parts := []string{i18n.T("rail.summary.expand")}
	if outstanding := outstandingJobs(m.panel.jobs); outstanding > 0 {
		parts = append(parts, i18n.Tn("rail.summary.jobs", outstanding, "n", outstanding))
	} else if len(m.panel.jobs) > 0 {
		// Nothing is hanging, but jobs exist — "N background jobs (all collected)"
		// is a different fact from "no jobs", and dropping the segment entirely
		// made the two look the same.
		parts = append(parts, i18n.Tn("rail.summary.jobs_collected", len(m.panel.jobs),
			"n", len(m.panel.jobs)))
	}
	if running, _ := mcpTally(m.panel.mcp); running > 0 {
		parts = append(parts, i18n.Tn("rail.summary.mcp", running, "n", running))
	}
	if todo := railTodoSummary(m.panel.todos); todo != "" {
		parts = append(parts, todo)
	}
	if len(m.panel.skills) > 0 {
		parts = append(parts, i18n.Tn("rail.summary.skills", len(m.panel.skills),
			"n", len(m.panel.skills)))
	}
	if permission := m.permissionSummary(); permission != "" {
		parts = append(parts, permission)
	}
	// The autopilot state is part of the summary because the summary is defined as
	// "say what collapsing hid", and one of the things it hid is whether the next
	// risky call will ask. Leaving it out makes the collapsed line silently answer
	// "yes" to a question it never addresses.
	if m.panel.autopilot {
		parts = append(parts, i18n.T("rail.summary.autopilot"))
	}
	// One line, clipped at the edge: the original's summary is a single row with
	// `nowrap` + `clip`, and a summary that wraps to a second row would move the
	// status bar and the input box down for the sake of an aside.
	line := currentTheme.styleFor("rule").Render(strings.Join(parts, i18n.T("list.separator")))
	return chromeRow(clipStyled(line, m.width), m.width)
}

// permissionSummary is the rail summary's permission half: which risk levels
// will ask, or that none of them will.
func (m model) permissionSummary() string {
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
	if len(asking) > 0 {
		return i18n.T("rail.summary.asking", "risks", strings.Join(asking, i18n.T("list.separator")))
	}
	if len(m.panel.riskScope) > 0 {
		return i18n.T("rail.summary.all_auto")
	}
	return ""
}

func (m model) renderBody(available int) string {
	var body string
	switch {
	case m.pendingPermission != nil:
		body = lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderPermissionDialog())
	case m.pendingQuestion != nil:
		body = lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderQuestionDialog())
	case m.overlay.kind != overlayNone:
		body = lipgloss.Place(m.width, available, lipgloss.Center, lipgloss.Center,
			m.renderOverlay(m.width-8))
	default:
		body = m.renderBodySplit(available)
	}
	// **The body is the theme's own background.** Everything else on this screen
	// is a bar or a box painted *on* it, and without this fill the palette's floor
	// colour never appears at all: a dark theme on a light terminal is unreadable,
	// and the "deep clear" variant loses the one thing it is transparent against.
	return paintBackground(body, m.width, currentTheme.bg)
}

// paintBackground fills every row out to the full width in one colour.
func paintBackground(block string, width int, colour string) string {
	if colour == "" || colour == ansiDefault {
		// The transparent variants hand the background to the terminal. Painting
		// the sentinel would emit an escape the terminal cannot resolve.
		return block
	}
	rows := strings.Split(block, "\n")
	for index, row := range rows {
		rows[index] = paintRow(row, width, colour)
	}
	return strings.Join(rows, "\n")
}

// paintRow pads one row to width and paints it in one background colour.
//
// Padding first, then styling: a background only covers the cells that exist, so
// a short row would leave the terminal's own colour showing at the right edge —
// a ragged right margin that reads as a rendering fault.
//
// The row is split on the SGR reset before being painted, because a reset inside
// it (every styled fragment ends with one) would otherwise drop the background
// for everything after it — which is exactly the trailing half of a line that is
// mostly unstyled text.
func paintRow(row string, width int, colour string) string {
	if colour == "" || colour == ansiDefault {
		return row
	}
	if visible := runewidth.StringWidth(stripANSI(row)); visible < width {
		row += strings.Repeat(" ", width-visible)
	}
	style := lipgloss.NewStyle().Background(lipgloss.Color(colour))
	parts := strings.Split(row, "\x1b[0m")
	for part := range parts {
		parts[part] = style.Render(parts[part])
	}
	return strings.Join(parts, "")
}

// padRows pads every row of a block out to width, so a block placed after it in a
// horizontal join starts at the same column on every row.
func padRows(block string, width int) string {
	rows := strings.Split(block, "\n")
	for index, row := range rows {
		if visible := runewidth.StringWidth(stripANSI(row)); visible < width {
			rows[index] = row + strings.Repeat(" ", width-visible)
		}
	}
	return strings.Join(rows, "\n")
}

// renderBodySplit draws the conversation and, when the rail is up, the rail beside
// it. **The rail is docked right**, which is the one place this port departs from
// the original's layout on purpose: Python puts the context column on the left
// (`app.py` CSS `#rail`, and the `Horizontal` at `app.py:639-641` yields
// rail-then-log). The conversation is what the eye is on, so it keeps the left
// margin and the panel stays out of the column the text starts at — a request from
// the user, not a parity finding. The rail's own width, its six blocks, the
// narrow-screen drop rule and the collapsed summary are untouched by it.
func (m model) renderBodySplit(available int) string {
	showRail := !m.railHidden && m.width >= minRailWidth
	if !showRail {
		return m.renderTranscript(m.width, available)
	}
	transcriptWidth := m.width - railWidth - 1
	rail := m.renderRail(railWidth, available)
	// The transcript is padded to its full width **because the rail follows it**:
	// `JoinHorizontal` pads a block to its own widest row, so one short row would
	// let the rail slide left and leave background between it and the edge. With
	// the rail first — the original's order — that leftover landed on the outside
	// and nobody could see it.
	transcript := padRows(m.renderTranscript(transcriptWidth, available), transcriptWidth)
	return lipgloss.JoinHorizontal(lipgloss.Top,
		transcript, " ", paintBackground(rail, railWidth, currentTheme.rail))
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
	//
	// It is drawn to the room that is actually left. The full card is 23 rows
	// and a 24-row terminal has 16: the fixed-height form was cut off, and
	// everything below it — the init notices, which are conversation content —
	// was off-screen and, while the empty state was up, unreachable.
	if m.welcomeVisible() {
		rows = append(rows, m.renderWelcome(width, maxInt(height-1, 1))...)
		rows = append(rows, "")
	}
	for index := range m.transcript {
		rows = append(rows, m.renderEntry(index, width)...)
	}

	if len(rows) == 0 {
		rows = append(rows, "")
	}
	return m.window(rows, height)
}

// window cuts the log down to the rows the body has room for.
//
// The window is held by **anchor** — the index of the row drawn on its first
// line — and not by a distance from the bottom. That distinction is the whole
// fix for "the log drags me down while it streams": when an answer grows inside
// one entry, or a report arrives as one multi-row entry, nothing about the
// window depends on how many rows exist below it, so the row the reader is on
// does not move. `follow` is the one thing that does depend on them, and it
// means exactly "the window is on the newest row".
func (m model) window(rows []string, height int) string {
	state := m.scroll
	if state == nil {
		// A model built by hand (the zero value, a test literal) has no shared
		// cell to keep a position in. It draws the way the log did before the
		// position existed: the cover page from the top, the conversation from
		// the newest row.
		anchor := 0
		if !m.welcomeVisible() {
			anchor = maxInt(len(rows)-height, 0)
		}
		return joinRows(rows, anchor, height)
	}
	welcome := m.welcomeVisible()
	if welcome != state.welcome {
		// Crossing between the empty state and the conversation is the one
		// moment that **decides** the anchoring: the cover page opens at the
		// top, the conversation opens on the newest row. Every later frame
		// leaves it where the reader put it.
		state.welcome = welcome
		state.follow = !welcome
		state.anchor = 0
	}
	state.maxAnchor = maxInt(len(rows)-height, 0)
	if state.follow {
		state.anchor = state.maxAnchor
	}
	if state.anchor > state.maxAnchor {
		state.anchor = state.maxAnchor
	}
	if state.anchor < 0 {
		state.anchor = 0
	}
	return joinRows(rows, state.anchor, height)
}

// joinRows is the window itself: `rows[anchor : anchor+height]`, padded with
// blanks so the frame is the same height whatever the log holds.
func joinRows(rows []string, anchor, height int) string {
	end := min(anchor+height, len(rows))
	if anchor > end {
		anchor = end
	}
	visible := append([]string{}, rows[anchor:end]...)
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
		return append(m.renderAnswerBlock(item.text, width), "")
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
	case len(item.lines) > 0:
		// A block rendered by the interface itself (`/status`, `/tools`, …): each
		// row carries its own segments, so it goes through the same wrapper as any
		// other line and wraps at the screen width like everything else.
		var out []string
		for _, line := range item.lines {
			out = append(out, wrapCells(renderOne(line), width)...)
		}
		return append(out, "")
	case item.kind == "user":
		return wrapCells(renderOne(item.line), width)
	default:
		out := wrapCells(renderOne(item.line), width)
		return append(out, "")
	}
}

// renderAnswerBlock draws one finished answer: markdown, with an accent bar down
// the left. Shared by the standalone path and the in-turn path so an answer cannot
// look like two different things depending on where it landed.
func (m model) renderAnswerBlock(text string, width int) []string {
	lines := renderMarkdown(text, width-3)
	out := make([]string, 0, len(lines)+1)
	out = append(out, "")
	for _, line := range lines {
		out = append(out, currentTheme.styleFor("tool").Render("│ ")+line)
	}
	return out
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

	// The finished answer, **inside the turn that produced it**. Same framing as a
	// standalone answer (markdown, accent bar on the left); only the position
	// differs, and the position is the point — the header saying "Answered" owns
	// the text it is summarising.
	if turn.answer != "" {
		out = append(out, m.renderAnswerBlock(turn.answer, width)...)
	}

	// The thinking block: one folded line by default, the quote block when this
	// turn is expanded. Both paths share the same constructors.
	//
	// **The live block is checked first, and that order is load-bearing.** A turn
	// that has made one tool call already has a finalized `turn.thinking` — the
	// reasoning of its **previous** step — and while the model thinks about the
	// next one the live copy is the only thing describing the present. Ranking the
	// finalized text above it left the panel showing the last step's thoughts with
	// a frozen counter, which reads as "it is stuck" rather than "it is thinking".
	// The live copy is dropped the moment its step's whole reasoning arrives, so
	// the two branches are never both current — only ever one step apart.
	if m.thinkingLive && m.thinkingText != "" && turn.runID == m.streamRunID {
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
	} else if turn.thinking != "" {
		chars := runewidth.StringWidth(turn.thinking)
		if turn.expanded {
			out = append(out, renderOne(thinkingExpandedHead(chars)))
			out = append(out, thinkingBody(turn.thinking, width)...)
		} else {
			out = append(out, renderOne(thinkingFolded(turn, chars, "")))
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
	if width > leftWidth+rightWidth+4 {
		rule = width - leftWidth - rightWidth - 2
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
	if badge := m.jobsBadge(narrow); badge != "" {
		// Warn when something finished and was never collected: that is the state
		// where backgrounding silently goes wrong, and it is the one worth the eye.
		role := "tool"
		if uncollectedJobs(m.panel.jobs) > 0 {
			role = "warn"
		}
		right += currentTheme.styleFor("rule").Render("  ·  ") +
			currentTheme.styleFor(role).Render(badge)
	}
	if badge := m.subagentsBadge(narrow); badge != "" {
		// Always the accent, never the warn ink: a running delegation is a normal
		// part of a turn rather than a state somebody has to act on. The jobs badge
		// earns the warning colour because an uncollected result means a command
		// may have failed silently; a subagent's answer has already been handed to
		// the model by the time the row disappears, so there is nothing to chase.
		right += currentTheme.styleFor("rule").Render("  ·  ") +
			currentTheme.styleFor("accent").Render(badge)
	}
	right += currentTheme.styleFor("rule").Render("  ·  " + m.statusRight(narrow))
	return chromeRow(spreadStyled(left, right, m.width), m.width)
}

// phase is the coarse state the status bar paints: what the runtime is doing
// right now, or how the last turn ended.
//
// The original derived it in a shared reducer over the event stream. There is
// only one front end that needs it here, so it is derived in place — but the
// distinctions are the same, because they are the ones a reader acts on:
// "finished", "hit the step limit", "you stopped it" and "the model failed" must
// not share a glyph or a colour.
type phase string

const (
	phaseBooting   phase = "booting"
	phaseIdle      phase = "idle"
	phaseWorking   phase = "working"
	phaseFinished  phase = "finished"
	phaseLimited   phase = "limited"
	phaseFailed    phase = "failed"
	phaseCancelled phase = "cancelled"
)

func (m model) phase() phase {
	if m.booting {
		return phaseBooting
	}
	if m.busy {
		return phaseWorking
	}
	last := m.lastFinishedTurn()
	if last == nil {
		return phaseIdle
	}
	switch last.outcome {
	case "max_steps":
		return phaseLimited
	case "cancelled":
		return phaseCancelled
	case "model_error", "model_fatal":
		return phaseFailed
	}
	return phaseFinished
}

func (m model) lastFinishedTurn() *turnData {
	for index := len(m.transcript) - 1; index >= 0; index-- {
		if turn := m.transcript[index].turn; turn != nil && turn.finished {
			return turn
		}
	}
	return nil
}

// phaseMark is the glyph, and phaseColour the token it is painted in. Shape
// first, colour second: a monochrome terminal still tells the five apart.
func phaseMark(value phase) string {
	switch value {
	case phaseIdle:
		return "○"
	case phaseWorking:
		return "●"
	case phaseFinished:
		return "✓"
	case phaseLimited:
		return "!"
	case phaseFailed:
		return "✗"
	case phaseCancelled:
		return "—"
	}
	return "·"
}

func phaseColour(value phase) string {
	switch value {
	case phaseWorking:
		return currentTheme.accent
	case phaseFinished:
		return currentTheme.ok
	case phaseLimited, phaseCancelled:
		return currentTheme.warn
	case phaseFailed:
		return currentTheme.danger
	}
	return currentTheme.ink4
}

// settledText is what a terminal phase says when there is no activity left to
// project: `run_finished` clears the activity, and a bar left holding a bare
// glyph reads as broken.
func settledText(value phase) string {
	switch value {
	case phaseFinished:
		return i18n.T("status.settled.answered")
	case phaseLimited:
		return i18n.T("status.settled.limited")
	case phaseFailed:
		return i18n.T("status.settled.failed")
	case phaseCancelled:
		return i18n.T("status.settled.cancelled")
	}
	return ""
}

// renderStatusLeft is the mark plus what the runtime last said it was doing.
// The mark's colour follows the phase, so "running / done / interrupted" read
// apart at a glance; the words stay in the secondary ink so the line never
// shouts.
func (m model) renderStatusLeft(narrow bool) string {
	current := m.phase()
	if current == phaseBooting {
		text := i18n.T("status.boot.starting")
		if m.bootSlow {
			text = i18n.T("status.boot.slow")
		}
		mark := m.spinnerFrame()
		if mark == "" {
			mark = "·"
		}
		return currentTheme.styleMark(currentTheme.ink4).Render(mark) +
			currentTheme.styleFor("answer").Render(" "+text)
	}
	mark := phaseMark(current)
	if spin := m.spinnerFrame(); spin != "" {
		mark = spin
	}
	text := m.activity
	if text == "" {
		text = settledText(current)
	}
	if current == phaseIdle {
		// "Idle" and "nothing has been said yet" are different screens, and the
		// second one is where a new user is.
		key := "status.idle"
		if m.turnSeq == 0 {
			key = "status.idle.new"
		}
		text = i18n.T(key)
	}
	left := currentTheme.styleMark(phaseColour(current)).Render(mark) +
		currentTheme.styleFor("answer").Render(" "+text)
	if step := m.stepText(); step != "" {
		left += "    " + currentTheme.styleFor("rule").Render(step)
	}
	return left
}

// stepText is "step 3 / 40" while a turn is running. It needs both numbers: the
// step alone says nothing, and the limit alone is already in the session bar.
func (m model) stepText() string {
	if m.current == nil || m.current.steps == 0 || m.maxSteps <= 0 {
		return ""
	}
	return i18n.T("status.step", "step", m.current.steps, "total", m.maxSteps)
}

// autopilotBadge is always on the bar — both states — because its meaning is
// "will it ask me next", and an empty cell cannot tell "off" from "not drawn".
func (m model) autopilotBadge(narrow bool) string {
	key := "status.autopilot.off"
	role := "rule"
	if m.panel.autopilot {
		key = "status.autopilot.on"
		role = "warn"
	}
	if narrow {
		if m.panel.autopilot {
			key = "status.autopilot.on_short"
		} else {
			key = "status.autopilot.off_short"
		}
	}
	return currentTheme.styleFor(role).Render(i18n.T(key))
}

// statusRight is the cost of this run: context, cache hit, the output rate, how
// long this turn has been going (or how big the session is), and where the audit
// is written.
// Narrow screens keep the first two — the audit path and "this turn" are the
// longest and least urgent items, and keeping all five on a narrow screen is
// what clips the left half into a sentence with no verb.
func (m model) statusRight(narrow bool) string {
	context := m.contextText(narrow)
	hit := m.cacheHitText()
	rate := m.outputRateText()
	if narrow {
		// The rate is dropped rather than the cache hit: on a narrow bar the
		// cache figure is the one that changes the bill, and `spreadStyled` cuts
		// from the tail anyway — putting the rate last would just mean it was the
		// segment that vanished without anybody deciding so.
		return strings.Join([]string{context, hit}, "  ·  ")
	}
	if rate == "" {
		// No measurement (a turn that only called tools). The segment is left out
		// entirely rather than drawn as `avg — tok/s`: see OutputRateText.
		return strings.Join([]string{context, hit, m.spanText(),
			i18n.T("status.audit", "path", m.auditDirShort())}, "  ·  ")
	}
	return strings.Join([]string{context, hit, rate, m.spanText(),
		i18n.T("status.audit", "path", m.auditDirShort())}, "  ·  ")
}

// outputRateText is the last model call's average output rate, or "" when there
// is no measurement to report.
//
// It reads the same four fields the rail's Session block and the cache-hit figure
// read, so the bar is describing one call throughout: the prompt size, the cached
// part, the answer size and the call's duration all come from the same
// `model_call` event.
func (m model) outputRateText() string {
	completion, span := m.panel.completionTokens, m.panel.modelMs
	if completion == nil || span == nil {
		return ""
	}
	rate, ok := state.OutputRateText(*completion, *span)
	if !ok {
		return ""
	}
	return i18n.T("status.rate", "rate", rate)
}

// contextText is the last request's prompt size against the model's window.
// When the window is unknown it degrades to usage only — a wrong percentage gets
// believed, and no percentage beats a wrong one.
func (m model) contextText(narrow bool) string {
	prompt := m.panel.promptTokens
	if prompt == nil {
		return i18n.T("status.context.none")
	}
	used := stateTokensText(*prompt)
	window := intOf(m.panel.window)
	if window <= 0 {
		return i18n.T("status.context.used", "used", used)
	}
	if narrow {
		return i18n.T("status.context.plain", "used", used, "total", stateTokensText(window))
	}
	percent := fmt.Sprintf("%.1f", float64(*prompt)/float64(window)*100)
	return i18n.T("status.context.percent",
		"used", used, "total", stateTokensText(window), "percent", percent)
}

// cacheHitText is how much of the last prompt came from the provider's cache.
// It is the number that explains why two identical-looking turns differ in cost,
// and it is the only reason the figure is on the bar at all.
func (m model) cacheHitText() string {
	prompt, cached := m.panel.promptTokens, m.panel.cachedTokens
	if prompt == nil || cached == nil || *prompt <= 0 {
		return i18n.T("status.hit.none")
	}
	return i18n.T("status.hit", "percent",
		fmt.Sprintf("%.0f", float64(*cached)/float64(*prompt)*100))
}

// spanText is "this turn 4.2s" while one is running or just finished, else how
// big the session is. A brand new session has one message (the system prompt),
// and reporting that as "session 1 message · 0 steps" reads as "we have already
// talked" — so the session form needs more than one message.
func (m model) spanText() string {
	if m.current != nil {
		return i18n.T("status.turn", "duration", durationText(time.Since(m.current.startedAt)))
	}
	if last := m.lastFinishedTurn(); last != nil && last.duration > 0 {
		return i18n.T("status.turn", "duration", durationText(last.duration))
	}
	if m.panel.steps > 0 || m.panel.messages > 1 {
		// Two independent numbers, so two plural decisions, then the outer
		// template: one `{n}` rule cannot cover both.
		return i18n.T("status.session.span",
			"messages", i18n.Tn("status.session.messages", m.panel.messages, "n", m.panel.messages),
			"steps", i18n.Tn("status.session.steps", m.panel.steps, "n", m.panel.steps))
	}
	return i18n.T("status.session.none")
}

// auditDirShort shortens the audit path to `.tudouni/logs`.
//
// The first thirty columns of the full path are a constant on any given machine,
// and the file name is the session id — which is already on the line above in
// the rail. What is left is the part a person reads.
func (m model) auditDirShort() string {
	if m.auditPath == "" {
		return "—"
	}
	path := strings.ReplaceAll(m.auditPath, "\\", "/")
	const marker = "/.tudouni/"
	if index := strings.Index(path, marker); index >= 0 {
		short := ".tudouni/" + path[index+len(marker):]
		if slash := strings.LastIndex(short, "/"); slash > 0 {
			return short[:slash]
		}
		return short
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) > 1 {
		return strings.Join(parts[len(parts)-2:], "/")
	}
	return path
}

// jobsBadge reports what is still hanging in the background.
//
// "How many are outstanding" is the question this cell answers, so the
// all-collected state gets its own wording rather than vanishing: an empty cell
// cannot be told apart from "there are no jobs at all".
func (m model) jobsBadge(narrow bool) string {
	if len(m.panel.jobs) == 0 {
		return ""
	}
	outstanding := outstandingJobs(m.panel.jobs)
	if outstanding == 0 {
		return i18n.T("status.jobs.collected", "n", len(m.panel.jobs))
	}
	text := i18n.Tn("status.jobs.running", outstanding, "n", outstanding)
	if !narrow && uncollectedJobs(m.panel.jobs) > 0 {
		text += i18n.T("status.jobs.uncollected", "n", uncollectedJobs(m.panel.jobs))
	}
	return text
}

// subagentsBadge is the status bar's delegation cell.
//
// It says what the subagent is **doing** when it can, because "1 subagent" on its
// own is not actionable: a delegation that has been reading files for two seconds
// and one that has been thinking for ninety look identical, and only the second is
// worth wondering about. The activity comes from the child's own events via
// observeChild, so the cell is as specific as the child's last report.
//
// Unlike the jobs cell there is no all-done wording: a delegation removes its row
// the moment it settles, so an empty cell already means "none", and a "collected"
// cell would be permanently absent rather than occasionally informative.
func (m model) subagentsBadge(narrow bool) string {
	if len(m.panel.subagents) == 0 {
		return ""
	}
	text := i18n.Tn("status.subagents.running", len(m.panel.subagents), "n", len(m.panel.subagents))
	// The detail is dropped on a narrow terminal: the elapsed seconds and the
	// tool name are worth more than the count, but not worth pushing the model
	// name off the right-hand edge.
	if narrow {
		return text
	}
	if first, ok := m.panel.subagents[0].(map[string]any); ok {
		if activity, _ := first["activity"].(string); activity != "" {
			text += i18n.T("status.subagents.doing", "what", activity)
			return text
		}
		if label, _ := first["label"].(string); label != "" {
			text += i18n.T("status.subagents.doing", "what", label)
		}
	}
	return text
}

// stateTokensText formats a token count for humans (14.1k / 1.0M).
func stateTokensText(n int) string {
	return state.TokensText(&n)
}

// renderInput is the two-line input inside its accent rules — the only
// high-contrast border on the screen, because it is where the eye should be.
// The box sits on chrome, like the three bars above it.
//
// It is a fixed four rows: the top rule, two editable rows, the bottom rule.
// Growth on demand would move the status bar every time the draft wrapped,
// which is the one line on this screen that must not jump.
func (m model) renderInput() string {
	rule := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent)).
		Render(strings.Repeat("─", maxInt(m.width, 4)))
	inner := maxInt(m.width-6, 10)
	rows := m.inputView(inner)
	// Both editable rows get the prompt's indent, so a wrapped draft lines up
	// under the first character typed rather than under the "> ".
	body := currentTheme.styleFor("tool").Render("> ") + rows[0] + "\n" +
		"  " + rows[1]
	return rule + "\n" + chromeRow(body, m.width) + "\n" + rule
}

// renderPermissionDialog draws one approval request.
//
//   - **the tool is named**, in the title and in bold: "built-in tool, HIGH risk"
//     describes a category, and the decision is about one program;
//   - the arguments are printed **whole** — they are the material for the
//     decision, and a truncated shell command hides the half that matters;
//   - the hint lines are reproduced verbatim: they contain facts this program
//     cannot reconstruct;
//   - a key the runtime did not offer is not shown.
func (m model) renderPermissionDialog() string {
	request := m.pendingPermission
	tool, _ := protocol.String(request, "tool")
	// Upper case: the risk word is a label, and the runtime reports it lower case.
	riskText, _ := protocol.String(request, "risk")
	risk := strings.ToUpper(strings.TrimSpace(riskText))
	if risk == "" {
		risk = "?"
	}
	info := m.panel.toolInfo[tool]

	head := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.danger)).Bold(true)
	boxWidth := min(m.width-8, 96)
	background := panelBackground()
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.danger)).
		Background(lipgloss.Color(background)).
		Padding(0, 1).
		Width(boxWidth)
	// `Width()` includes the padding and the border is added on top, so a box built
	// with Padding(0,1) has boxWidth-2 usable columns. Getting this wrong by two
	// makes lipgloss reflow the rows, and its wrap does not agree with this
	// program's about ANSI escapes — which is how a highlighted row ends up
	// spanning two lines.
	inner := boxWidth - 2

	var builder strings.Builder
	// Head: the alarm word on the left, the risk as a chip at the right-hand end.
	// The chip is a background block rather than a word because a terminal has no
	// other way to say "this is a label" — and the risk is the first thing to read.
	badge := lipgloss.NewStyle().
		Foreground(lipgloss.Color(currentTheme.danger)).
		Background(lipgloss.Color(currentTheme.dangerSoft)).
		Padding(0, 1).
		Render(i18n.T("permission_dialog.risk_badge", "risk", risk))
	headText := i18n.T("permission_dialog.head")
	headLine := head.Render(headText)
	if pad := inner - runewidth.StringWidth(headText) - runewidth.StringWidth(stripANSI(badge)); pad > 0 {
		headLine += strings.Repeat(" ", pad)
	} else {
		headLine += "  "
	}
	builder.WriteString(headLine + badge + "\n")

	kind := i18n.T("permission_dialog.kind_builtin")
	if strings.HasPrefix(tool, "mcp__") {
		kind = i18n.T("permission_dialog.kind_external")
	}
	title := currentTheme.styleFor("user").Render(tool) +
		currentTheme.styleFor("process").Render(
			i18n.T("permission_dialog.title", "kind", kind, "risk", risk))
	// The two facts the tool registry knows and the risk column cannot express:
	// this one cannot run beside its siblings, and this one takes over the input.
	if info != nil {
		if flag, _ := info["parallel_safe"].(bool); !flag {
			title += currentTheme.styleFor("process").Render(i18n.T("permission_dialog.no_parallel"))
		}
		if flag, _ := info["interactive"].(bool); flag {
			title += currentTheme.styleFor("process").Render(i18n.T("permission_dialog.interactive"))
		}
	}
	builder.WriteString(wrapCells(title, inner)[0] + "\n")
	if rest := wrapCells(title, inner); len(rest) > 1 {
		builder.WriteString(strings.Join(rest[1:], "\n") + "\n")
	}
	builder.WriteString("\n")

	arguments, _ := request["arguments"].(map[string]any)
	if len(arguments) == 0 {
		builder.WriteString(currentTheme.styleFor("rule").
			Render(i18n.T("permission_dialog.no_args")) + "\n")
	} else {
		// A block on the sunken background, so the command reads as quoted
		// material rather than as part of the question.
		names := make([]string, 0, len(arguments))
		width := 0
		for name := range arguments {
			names = append(names, name)
			if len(name) > width {
				width = len(name)
			}
		}
		sortStrings(names)
		var block []string
		for _, name := range names {
			block = append(block, currentTheme.styleFor("rule").Render(fmt.Sprintf("  %-*s", width+2, name))+
				currentTheme.styleFor("answer").Render(renderArgument(arguments[name])))
		}
		builder.WriteString(paintBlock(block, inner, currentTheme.sunk) + "\n")
	}

	builder.WriteString("\n")
	rememberHint, _ := protocol.String(request, "remember_hint")
	trustHint, _ := protocol.String(request, "trust_all_hint")
	if rememberHint != "" {
		builder.WriteString(permissionHint("t", rememberHint) + "\n")
	}
	if allowAll, _ := request["allow_trust_all"].(bool); allowAll && trustHint != "" {
		builder.WriteString(permissionHint("a", trustHint) + "\n")
	}
	// The buttons are key labels, not clickable widgets: the terminal has no
	// pointer here, and a button that cannot be pressed is worse than a key hint.
	buttons := []string{i18n.T("permission_dialog.allow"), i18n.T("permission_dialog.deny")}
	if rememberHint != "" {
		buttons = append(buttons, i18n.T("permission_dialog.always"))
	}
	if allowAll, _ := request["allow_trust_all"].(bool); allowAll && trustHint != "" {
		buttons = append(buttons, i18n.T("permission_dialog.allow_all"))
	}
	builder.WriteString("\n" + currentTheme.styleFor("answer").Render(strings.Join(buttons, "   ")))
	builder.WriteString("\n" + currentTheme.styleFor("rule").
		Render(i18n.T("permission_dialog.footer")))

	// Every row is painted on the card's background before it is handed to the box:
	// leaving the body transparent and relying on the box's own background is what
	// produced a panel made of three surfaces, because `elevated` and `sunk` stay
	// opaque even when the theme does not.
	return box.Render(paintBackground(builder.String(), inner, background))
}

// permissionHint is `t = <consequence>`. The consequence sentence comes from the
// runtime verbatim: it is the only thing that knows what remembering means for
// this particular command prefix.
func permissionHint(key, text string) string {
	return currentTheme.styleFor("rule").Render(key+" = ") +
		currentTheme.styleFor("process").Render(text)
}

// paintBlock draws a group of rows on one background, padded to a common width.
func paintBlock(rows []string, width int, colour string) string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, paintRow(row, width, colour))
	}
	return strings.Join(out, "\n")
}

// questionIndex is the option the cursor is on. Enter answers the highlighted
// option, not the first one: with `↑↓` available, "Enter picks the top row" is a
// trap.
func (m model) questionIndex() int {
	options, _ := m.pendingQuestion["options"].([]any)
	if len(options) == 0 {
		return -1
	}
	if m.questionCursor < 0 {
		return 0
	}
	if m.questionCursor >= len(options) {
		return len(options) - 1
	}
	return m.questionCursor
}

// renderQuestionDialog draws one question.
//
// Skipping is its own action rather than "Enter on an empty line": Enter is the
// easiest key in the interface, and making it mean "I did not decide" turns an
// unnoticed keystroke into an answer nobody gave.
func (m model) renderQuestionDialog() string {
	request := m.pendingQuestion
	question, _ := protocol.String(request, "question")
	header, _ := protocol.String(request, "header")

	boxWidth := min(m.width-8, 96)
	background := panelBackground()
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Background(lipgloss.Color(background)).
		Padding(0, 1).
		Width(boxWidth)
	// As in the approval dialog: `Width()` includes the padding, the border is added
	// on top, so Padding(0,1) leaves boxWidth-2 usable columns.
	inner := boxWidth - 2

	var builder strings.Builder
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent)).Bold(true).
		Render(i18n.T("question_dialog.head")) +
		currentTheme.styleFor("rule").Render("   ask_user") + "\n")
	if header != "" {
		builder.WriteString(currentTheme.styleFor("rule").Render("header: ") +
			currentTheme.styleFor("process").Render(header) + "\n")
	}
	builder.WriteString(currentTheme.styleFor("user").Render(question) + "\n\n")

	options, _ := request["options"].([]any)
	if len(options) == 0 {
		builder.WriteString(currentTheme.styleFor("rule").
			Render(i18n.T("question_dialog.no_options")) + "\n")
	} else {
		selected := m.questionIndex()
		rows := make([]string, 0, len(options))
		for index, item := range options {
			text, _ := item.(string)
			if index == selected {
				// The highlighted row is the one Enter takes, so it is drawn the
				// same way every other list in this interface draws its cursor.
				rows = append(rows, selectedRow(
					fmt.Sprintf("  %d  %s", index+1, clipText(text, inner-8)), inner))
				continue
			}
			rows = append(rows, currentTheme.styleFor("rule").Render(fmt.Sprintf("   %d  ", index+1))+
				currentTheme.styleFor("answer").Render(text))
		}
		builder.WriteString(strings.Join(rows, "\n") + "\n")
	}
	// The free-text line stays: a question may have no options, and the answer is
	// not always one of them.
	builder.WriteString("\n" + currentTheme.styleFor("tool").Render("> ") +
		currentTheme.styleFor("user").Render(m.questionInput) +
		currentTheme.styleFor("caret").Render(" ") + "\n\n")
	builder.WriteString(currentTheme.styleFor("rule").Render(i18n.T("question_dialog.skip")))
	builder.WriteString("\n" + currentTheme.styleFor("rule").
		Render(i18n.T("question_dialog.footer1")+"\n"+i18n.T("question_dialog.footer2")))

	// Painted for the same reason as the approval card: see panelBackground.
	return box.Render(paintBackground(builder.String(), inner, background))
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

// spreadStyled puts one string on the left and one on the right of a line; the
// padding is computed from the **visible** width (ANSI stripped), because escape
// sequences have no width but do have length.
//
// When the two halves do not fit, the **left** is what gets cut. That is the
// original's rule, and it is the right one: the left is a sentence ("Model is
// thinking", "step 3 / 40") that stays meaningful when shortened, while the right
// is a set of figures — dropping it entire leaves "the cost of this run" with
// nothing in it, which is what happened when the right half grew to the full
// four segments.
func spreadStyled(left, right string, width int) string {
	leftWidth := runewidth.StringWidth(stripANSI(left))
	rightWidth := runewidth.StringWidth(stripANSI(right))
	if leftWidth+rightWidth+1 <= width {
		return left + strings.Repeat(" ", width-leftWidth-rightWidth) + right
	}
	// It does not fit. The left half is a sentence ("Model is thinking", "step 3
	// / 40"); the right is a set of figures whose first segments are what a glance
	// needs and whose last ones (/audit's path, this turn's clock) have other
	// outlets. So the left gets a floor — past it, a truncated sentence stops being
	// a sentence — and the right is cut at the tail.
	rightBudget := min(rightWidth, width*2/3)
	leftBudget := width - rightBudget - 1
	clippedLeft := ""
	if leftBudget > 0 {
		clippedLeft = clipStyled(left, leftBudget)
	}
	remaining := width - runewidth.StringWidth(stripANSI(clippedLeft)) - 1
	if remaining < 1 {
		return clipStyled(left, width)
	}
	if clippedLeft == "" {
		return clipStyled(right, width)
	}
	return clippedLeft + " " + clipStyled(right, remaining)
}

// clipStyled cuts a styled row to a number of cells, closing any style it cut
// open. The caller re-applies the bar's background after every reset, so the
// closing reset cannot leave a half-painted line behind.
func clipStyled(text string, width int) string {
	if runewidth.StringWidth(stripANSI(text)) <= width {
		return text
	}
	rows := wrapCells(text, width)
	if len(rows) == 0 {
		return ""
	}
	return rows[0] + "\x1b[0m"
}

// wrapCells wraps text at a number of terminal cells.
//
// ANSI escape sequences pass through untouched and cost **zero** columns. This
// is not an optimisation — it is the difference between a wrapped line and
// mangled output: a sequence broken mid-way leaves the tail (`8;2;131;121;104m`)
// as visible text, and every count that treated the sequence as printable width
// wrapped lines far too early. Styled rows are the norm here, so the escape
// handling lives in the one wrapper everything goes through.
//
// Breaks land on spaces when there is one to land on. A hard cell break splits
// words down the middle — "finished (exit 0)" came out as "finished (ex" /
// "it 0)" — and the terminal's own word wrap does not.
//
// A newline inside the text **breaks the row**. It is not padding: go-runewidth
// reports width 0 for every control character, so `\n` used to be written into
// the row and silently produced a line the caller had not counted — the
// multi-line `/context` and `/tools` reports came out as one "row" of a dozen
// physical lines, the height budget was wrong by that many rows, and the status
// bar was pushed off the bottom of the terminal.
func wrapCells(text string, width int) []string {
	if width <= 1 {
		return strings.Split(text, "\n")
	}
	var out []string
	var current strings.Builder
	column := 0
	inEscape := false
	// breakAt is the byte offset in `current` where the row may be cut — the
	// position of the most recent space — together with the column it sits at.
	// Without it a break can only land wherever the cells run out, which splits
	// words.
	breakAt := -1
	breakColumn := 0
	reset := func() {
		current.Reset()
		column = 0
		breakAt = -1
		breakColumn = 0
	}
	// cut breaks the row at the recorded space, dropping the whitespace.
	cut := func() bool {
		if breakAt <= 0 {
			return false
		}
		full := current.String()
		head := full[:breakAt]
		tail := strings.TrimLeft(full[breakAt:], " \t")
		out = append(out, head)
		dropped := len(full[breakAt:]) - len(tail)
		current.Reset()
		current.WriteString(tail)
		column -= breakColumn + dropped
		breakAt = -1
		breakColumn = 0
		return true
	}
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
		if char == '\n' {
			out = append(out, current.String())
			reset()
			continue
		}
		if char == '\r' {
			continue
		}
		if char == '\t' {
			for pad := 4 - column%4; pad > 0; pad-- {
				if column+1 > width {
					if !cut() {
						out = append(out, current.String())
						reset()
					}
				}
				// The break candidate moves with every whitespace cell: it must be
				// the **last** one that fits, or the row breaks at the first space in
				// the line.
				breakAt = current.Len()
				breakColumn = column
				current.WriteRune(' ')
				column++
			}
			continue
		}
		if char < 0x20 {
			// Any other control character is not printable; drawing it would
			// move the terminal's cursor rather than add a cell.
			continue
		}
		cells := runewidth.RuneWidth(char)
		if column+cells > width {
			if !cut() {
				out = append(out, current.String())
				reset()
			}
		}
		if char == ' ' {
			breakAt = current.Len()
			breakColumn = column
		}
		current.WriteRune(char)
		column += cells
	}
	out = append(out, current.String())
	return out
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
