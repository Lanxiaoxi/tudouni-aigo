package tui

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

// The overlays. One rule governs all of them: **the keyboard belongs to the
// overlay** while it is up, because a keystroke meant for the panel must never
// land in the input line and leave as a message.

type overlayKind int

const (
	overlayNone overlayKind = iota
	overlayCommand
	overlayOptions
	overlayMCP
	overlaySessions
	overlaySkills
)

// option is one row of a picker. The value is what goes back on the wire; the
// row and the note are what a person reads.
type option struct {
	value string
	row   string
	note  string
}

// overlay is the active floating panel.
//
// Every list is **windowed** when it is longer than maxOverlayRows. Without that
// the panel simply grew past the bottom of the terminal and the last few rows
// were never drawn — silently, because a terminal cannot show what ran off it.
type overlay struct {
	kind    overlayKind
	title   string
	options []option
	cursor  int

	// filter is the command palette's typed fragment, which is the input line
	// itself: the palette does not own a separate buffer, so typing `/resume x`
	// both narrows the list and supplies the argument.
	filter string

	// waiting names the action the runtime is still processing. The panel
	// **never draws a result before the runtime confirms it**: a mount that
	// failed to start would otherwise read as mounted.
	waiting string

	// count is the badge on the panel head (`3 / 5 running`).
	count string

	// stayOpen marks panels that survive an action (MCP: toggling one server off
	// and on again is the common case; closing between every toggle would cost
	// one /mcp per server).
	stayOpen bool
}

// maxOverlayRows is how many list rows a panel shows before it scrolls.
//
// It is **derived from the command count**, not written down. A literal was tried
// before and broke the way a literal always breaks here: the list grew past it and
// the extra commands existed, ran, and were not on screen — the palette's whole job
// is "here is everything you can type", and a scrolling cap silently makes that
// false. The +3 is headroom for the hint row, the "more" markers and the border.
func maxOverlayRows() int { return len(commands()) + 3 }

// welcomeLogo is the three-line mark. Half- and full-block characters only:
// they are exactly one cell wide in every monospace font, where graphic
// characters often go double-width under CJK fonts and shove the text beside
// them out of line. The three lines are the same width for the same reason.
var welcomeLogo = []string{" ▄▄▄▄▄▄", "██▀▀██ ", " ▄▄▄▄▄▄"}

// The welcome screen's geometry, mirrored from the original.
//
// These are *total* widths and heights, border included — the same numbers the
// original's stylesheet carries. Two boxes side by side (32 + 1 + 42 = 75) with
// the key card spanning them; on a 200-column terminal they do not stretch,
// because three long empty bars are uglier than the whitespace.
//
// The height matters as much as the width: 14 = 10 rows of content + 2 rows of
// padding + 2 border rows. Writing 10 and letting the border and padding be
// added on top is what keeps the two boxes level with each other — they carry
// the same number of content rows on purpose, so neither deforms with the data.
const (
	welcomeStartWidth  = 32
	welcomeRightWidth  = 42
	welcomeHintWidth   = 75
	welcomeStackColumn = 86
	welcomeBoxLines    = 10
	welcomeHintLines   = 4
	welcomeStampWidth  = 14
)

// welcomeTitleWidth is the recent row's title column: content width minus the
// stamp minus the one-cell gap. It is odd on purpose — a CJK title fills
// whole two-cell characters plus a one-cell ellipsis, so only an odd column
// count can be filled exactly, and a row one cell short makes the right border
// look misaligned.
func welcomeTitleWidth() int { return welcomeRightWidth - 4 - welcomeStampWidth - 1 }

// renderWelcome is the empty state: two boxes side by side (start + recent)
// with the full-width hint box under them. Left-aligned, not centred — the
// content starts where the conversation will. Below welcomeStackColumn the two
// boxes stack instead: 75 columns of boxes do not fit a narrow terminal, and
// squeezing them would clip text off the right edge.
func (m model) renderWelcome(width int) []string {
	stacked := width < welcomeStackColumn
	startBox := m.renderWelcomeBox(welcomeStartWidth, welcomeBoxLines,
		i18n.T("welcome.box.start"), m.startRows())
	recentBox := m.renderWelcomeBox(welcomeRightWidth, welcomeBoxLines,
		i18n.T("welcome.box.recent"), m.recentBoxRows(4))

	var body string
	if stacked {
		boxWidth := min(width-2, welcomeHintWidth)
		startBox = m.renderWelcomeBox(boxWidth, welcomeBoxLines,
			i18n.T("welcome.box.start"), m.startRows())
		recentBox = m.renderWelcomeBox(boxWidth, welcomeBoxLines,
			i18n.T("welcome.box.recent"), m.recentBoxRows(4))
		body = lipgloss.JoinVertical(lipgloss.Left, startBox, "", recentBox)
	} else {
		body = lipgloss.JoinHorizontal(lipgloss.Top, startBox, " ", recentBox)
	}
	hintRows := m.hintRows(width)
	hintWidth := min(width-2, welcomeHintWidth)
	hintBox := m.renderWelcomeBox(hintWidth, welcomeHintLines,
		i18n.T("welcome.box.hint"), hintRows)
	body = lipgloss.JoinVertical(lipgloss.Left, body, "", hintBox)
	return strings.Split(lipgloss.PlaceHorizontal(width, lipgloss.Left, body), "\n")
}

// renderWelcomeBox draws one box with its title on the top border line.
//
// The title is text on the frame, not a content row: it says what the block *is*
// and must not be mistaken for one of the things inside it. Drawing it here means
// the frame is built once and the first border line is replaced, rather than a
// second box implementation existing only for the title.
func (m model) renderWelcomeBox(width, contentLines int, title string, content []string) string {
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Background(lipgloss.Color(currentTheme.surface)).
		Foreground(lipgloss.Color(currentTheme.ink2)).
		Padding(1, 1).
		Width(width - 2).
		Height(contentLines)
	drawn := box.Render(strings.Join(content, "\n"))
	rows := strings.Split(drawn, "\n")
	if len(rows) == 0 {
		return drawn
	}
	rows[0] = boxTopLine(width, title)
	return strings.Join(rows, "\n")
}

// boxTopLine is `╭─ Start ─────────────╮`, painted in the frame's colours.
func boxTopLine(width int, title string) string {
	const corner = "╭"
	titleWidth := runewidth.StringWidth(title)
	fill := width - 5 - titleWidth
	for fill < 1 && titleWidth > 0 {
		title = clipText(title, titleWidth-1)
		titleWidth = runewidth.StringWidth(title)
		fill = width - 5 - titleWidth
	}
	border := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.accent))
	surface := currentTheme.surface
	if title == "" {
		return paintRow(corner+border.Render(strings.Repeat("─", width-2))+border.Render("╮"), width, surface)
	}
	line := border.Render(corner+"─ ") +
		currentTheme.styleFor("rule").Render(title) +
		border.Render(" "+strings.Repeat("─", fill)+"╮")
	return paintRow(line, width, surface)
}

// hintPairs is the key card's content. The narrow set is not the full set
// trimmed — the wording is shorter too: at 75 columns the full sentences wrap
// into rows the box is not tall enough to hold, and a wrapped key hint is a key
// hint that got cut off.
func hintPairs(narrow bool) [][2]string {
	if narrow {
		return [][2]string{
			{"Enter", i18n.T("hint.enter_short")},
			{"/", i18n.T("hint.slash_short")},
			{"Ctrl+T", i18n.T("hint.thinking_short")},
			{"Ctrl+B", i18n.T("hint.rail_short")},
			{"Esc", i18n.T("hint.escape_short")},
			{"Ctrl+S", i18n.T("hint.skills_short")},
			{"Ctrl+K", i18n.T("hint.palette_short")},
		}
	}
	return [][2]string{
		{"Enter", i18n.T("hint.enter")},
		{"/", i18n.T("hint.slash")},
		{"Ctrl+T", i18n.T("hint.thinking")},
		{"Ctrl+B", i18n.T("hint.rail")},
		{"Esc", i18n.T("hint.escape")},
		{"Ctrl+S", i18n.T("hint.skills")},
		{"Ctrl+K", i18n.T("hint.palette")},
	}
}

// hintRows is the keyboard card. It can wrap, unlike the boxes' fixed lines —
// running out of width folds to the next row instead of clipping a key away.
// Three pairs per row: the English wordings are long enough that four wrap.
func (m model) hintRows(width int) []string {
	pairs := hintPairs(width < welcomeHintWidth)
	const perRow = 3
	var rows []string
	for start := 0; start < len(pairs); start += perRow {
		var line strings.Builder
		for index, pair := range pairs[start:min(start+perRow, len(pairs))] {
			if index > 0 {
				line.WriteString("   ")
			}
			line.WriteString(currentTheme.styleFor("process").Render(pair[0]))
			line.WriteString(currentTheme.styleFor("rule").Render(" " + pair[1]))
		}
		rows = append(rows, line.String())
	}
	return rows
}

// startRows is the identity panel: the mark, the greeting, the version, and
// where to type. Ten lines, fixed — the boxes are the same height because their
// content is the same height, and neither deforms with the data.
func (m model) startRows() []string {
	inner := welcomeStartWidth - 4 // minus border and padding
	centre := func(text string, role string) string {
		text = clipText(text, inner)
		line := currentTheme.styleFor(role).Render(text)
		pad := (inner - runewidth.StringWidth(stripANSI(text))) / 2
		if pad < 0 {
			pad = 0
		}
		return strings.Repeat(" ", pad) + line
	}
	rows := []string{}
	for _, row := range welcomeLogo {
		rows = append(rows, centre(row, "tool"))
	}
	rows = append(rows, "")
	rows = append(rows, centre(i18n.T("welcome.back", "name", userName()), "user"))
	rows = append(rows, "")
	rows = append(rows, centre(version.Describe(), "answer"))
	rows = append(rows, centre(m.modelAndWorkspace(), "process"))
	rows = append(rows, "")
	rows = append(rows, centre(i18n.T("welcome.palette_hint"), "rule"))
	for len(rows) < welcomeBoxLines {
		rows = append(rows, "")
	}
	return rows
}

// recentBoxRows fills the second box with the sessions last touched, newest by
// mtime — "the last time I worked on it", not "the first time it was created".
// Empty slots hold their line so the box height never depends on the disk.
func (m model) recentBoxRows(limit int) []string {
	rows := []string{currentTheme.styleFor("process").Render(i18n.T("welcome.recent.title"))}
	items := mostRecent(m.recentSessions, limit)
	for _, item := range items {
		rows = append(rows, recentRow(item))
	}
	for index := limit - len(items); index > 0; index-- {
		blank := ""
		if len(items) == 0 && index == limit {
			blank = currentTheme.styleFor("rule").Render(i18n.T("welcome.recent.empty"))
		}
		rows = append(rows, blank)
	}
	rows = append(rows, "", currentTheme.styleFor("process").Render(i18n.T("welcome.recent.motto")))
	// Clip first, then centre on the clipped width — centring on the unclipped
	// width overflows the box and paints across the frame.
	inner := welcomeRightWidth - 4
	motto := clipText(mottoOfDay(), inner)
	if pad := inner - runewidth.StringWidth(motto); pad > 0 {
		motto = strings.Repeat(" ", pad/2) + motto
	}
	rows = append(rows, currentTheme.styleFor("quote").Render(motto))
	for len(rows) < welcomeBoxLines {
		rows = append(rows, "")
	}
	return rows
}

// mottoOfDay is today's line from a rotating list: the same all day, different
// tomorrow. A "what's new" block in a tool opened daily becomes noise; one line
// that quietly changes is the version of that idea a daily tool can carry.
func mottoOfDay() string {
	day := int(time.Now().Unix() / 86_400)
	return i18n.T(fmt.Sprintf("motto.%d", day%15+1))
}

// mostRecent sorts by mtime, newest first, and keeps limit. Sessions whose
// mtime is unreadable sort last: they have no "recently" to speak of.
func mostRecent(items []map[string]any, limit int) []map[string]any {
	copied := make([]map[string]any, len(items))
	copy(copied, items)
	for i := 1; i < len(copied); i++ {
		for j := i; j > 0; j-- {
			if modifiedOf(copied[j]) > modifiedOf(copied[j-1]) {
				copied[j], copied[j-1] = copied[j-1], copied[j]
			} else {
				break
			}
		}
	}
	if len(copied) > limit {
		copied = copied[:limit]
	}
	return copied
}

func modifiedOf(item map[string]any) float64 {
	switch value := item["modified_at"].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	}
	return 0
}

// recentRow is `12 minutes ago  the title of that conversation`. The title —
// the first user message's opening, which the runtime already computed — is
// what a person recognises; the id is a timestamp nobody can read.
func recentRow(item map[string]any) string {
	stamp := ""
	if modified := modifiedOf(item); modified > 0 {
		stamp = timeAgo(time.Since(time.Unix(int64(modified), 0)))
	}
	title, _ := item["preview"].(string)
	if title == "" {
		title = i18n.T("session.row.untitled")
	}
	pad := welcomeStampWidth - runewidth.StringWidth(stamp) + 1
	if pad < 1 {
		pad = 1
	}
	return currentTheme.styleFor("rule").Render(stamp+strings.Repeat(" ", pad)) +
		currentTheme.styleFor("answer").Render(clipText(title, welcomeTitleWidth()))
}

// timeAgo is the recent list's stamp, rounded the way a person rounds: two units
// are enough, because "3 hours ago" and "3 hours 12 minutes ago" answer the same
// question. Past a week the duration stops meaning anything, so it becomes a
// date.
func timeAgo(d time.Duration) string {
	if d < 0 {
		// A clock that went backwards is not "-3 minutes ago".
		d = 0
	}
	switch {
	case d < time.Minute:
		return i18n.T("time.just_now")
	case d < time.Hour:
		return i18n.Tn("time.minutes_ago", int(d.Minutes()), "n", int(d.Minutes()))
	case d < 24*time.Hour:
		return i18n.Tn("time.hours_ago", int(d.Hours()), "n", int(d.Hours()))
	case d < 7*24*time.Hour:
		return i18n.Tn("time.days_ago", int(d.Hours()/24), "n", int(d.Hours()/24))
	default:
		return time.Now().Add(-d).Format("2006-01-02")
	}
}

// userName greets the person. A missing name is not an error — the greeting
// just loses one word.
func userName() string {
	for _, name := range []string{"LOGNAME", "USER", "LNAME", "USERNAME"} {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

// modelAndWorkspace is the start box's context line: what model this run talks
// to and where the agent's hands are tied to.
//
// Only the last segment of the workspace is shown. The full path is routinely
// longer than the box, and the part that identifies the project — "tudouni-aigo"
// — is at the end; the rest is the same on both sides of a copy.
func (m model) modelAndWorkspace() string {
	workspace, err := os.Getwd()
	if err == nil {
		workspace = workspaceName(workspace)
	} else {
		workspace = ""
	}
	return modelAndWorkspaceText(m.panel.model, workspace)
}

func modelAndWorkspaceText(model, workspace string) string {
	switch {
	case model == "" && workspace == "":
		return "—"
	case workspace == "":
		return model
	case model == "":
		return workspace
	}
	return model + "  ·  " + workspace
}

// workspaceName is the last path segment, tolerating both separators.
func workspaceName(path string) string {
	trimmed := strings.TrimRight(path, "/\\")
	if index := strings.LastIndexAny(trimmed, "/\\"); index >= 0 {
		if name := trimmed[index+1:]; name != "" {
			return name
		}
	}
	return trimmed
}

// renderOverlay draws the active panel centred over the body.
func (m model) renderOverlay(width int) string {
	switch m.overlay.kind {
	case overlayCommand:
		return m.renderCommandPalette(width)
	case overlayOptions:
		return m.renderOptionPicker(width)
	case overlayMCP:
		return m.renderMCPPanel(width)
	case overlaySessions:
		return m.renderSessionPicker(width)
	case overlaySkills:
		return m.renderSkillsPanel(width)
	}
	return ""
}

// overlayFrameWidth is the widest a panel gets, and overlayInner the width its
// rows have to fit.
//
// The distinction is the whole of a bug that was reported from a real terminal:
// `Width()` in lipgloss **includes** the padding, and the border is added on top,
// so a 76-wide panel has 72 columns for its rows. Rows padded to the *available*
// width instead (up to 112) do not overflow — the frame reflows them, and a styled
// row measures wider than it looks, so the wrap lands early and the selected row's
// background ends up spanning two or three lines. In a colourless terminal none of
// that happens and the panel looks perfect, which is why the sandbox render was
// clean while the screen was not.
const overlayMaxWidth = 76

func overlayFrameWidth(width int) int {
	if width > overlayMaxWidth {
		return overlayMaxWidth
	}
	return width
}

func overlayInner(width int) int {
	if inner := overlayFrameWidth(width) - 4; inner > 8 {
		return inner
	}
	return 8
}

// panelBody wraps every row to the panel's inner width and joins them.
//
// It is always this program's wrapper, never the frame's: `wrapCells` counts ANSI
// escapes as zero width, and the frame's does not. Handing the frame only rows
// that already fit is what keeps the panel's geometry the panel's own.
func panelBody(rows []string, inner int) string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, wrapCells(row, inner)...)
	}
	return strings.Join(out, "\n")
}

// highlightRows wraps one row and paints every physical line as a rectangle, so a
// selected row that is long enough to wrap stays a block instead of a ragged edge.
func highlightRows(row string, inner int, paint func(string) string) []string {
	physical := wrapCells(row, inner)
	out := make([]string, 0, len(physical))
	for _, line := range physical {
		out = append(out, paint(line))
	}
	return out
}

// overlayFrame is the shared modal shape: 76 columns, the elevated background,
// a round hairline border. Hairline, not accent — every panel framed in the
// interaction colour would make the frame shout, and a modal already owns the
// screen by being on top.
func overlayFrame(width int, title, badge, body string) string {
	frameWidth := overlayFrameWidth(width)
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.hairline)).
		Background(lipgloss.Color(currentTheme.elevated)).
		Width(frameWidth).Padding(1, 2)
	head := lipgloss.NewStyle().
		Foreground(lipgloss.Color(currentTheme.ink4)).Bold(true).Render(title)
	if badge != "" {
		// The count sits at the right-hand end of the head line: "how many of
		// these are there" belongs with the title, not with the rows.
		pad := frameWidth - 4 - runewidth.StringWidth(title) - runewidth.StringWidth(badge)
		if pad > 0 {
			head += strings.Repeat(" ", pad)
		} else {
			head += "  "
		}
		head += currentTheme.styleFor("rule").Render(badge)
	}
	return style.Render(head + "\n" + body)
}

// selectedRow is the visual anchor for "the cursor is here": a block glyph for
// monochrome terminals plus reverse video. Reverse video is the load-bearing
// half — it carries its own contrast under **every** theme, so no palette needs
// a hand-tuned "selected foreground".
func selectedRow(row string, width int) string {
	style := lipgloss.NewStyle().
		Background(lipgloss.Color(currentTheme.accent)).
		Foreground(lipgloss.Color(currentTheme.darkColor())).
		Width(width)
	return style.Render("▌" + row)
}

// currentRow marks the value that is in effect. It is a separate signal from the
// cursor: the cursor is "where typing continues", the dot is "what you are on
// now", and collapsing them means the panel cannot show both.
func currentRow(row string, isCurrent bool, width int) string {
	marker := "  "
	if isCurrent {
		marker = currentTheme.styleFor("result").Render("● ") + ""
	}
	return marker + row
}

// darkColor is the colour to print on top of an accent background.
//
// It is always the palette's own background, light theme included: the accent is
// a mid-tone, and the light theme's `surface` is close enough to it that the
// label drops below a readable contrast.
//
// A transparent palette has no background of its own — its `bg` is the "do not
// paint" sentinel, and `lipgloss.Color` silently drops it, which leaves the
// selected row as accent-on-terminal-default: light ink on amber, unreadable on
// a dark terminal. The colour to print on the accent is then the one the palette
// is transparent *in front of*.
func (t theme) darkColor() string {
	if t.bg == ansiDefault {
		return originalBgOf(t.palette)
	}
	return t.bg
}

// windowRows slices a list around the cursor so a panel never runs off the
// bottom of the terminal. It returns the visible slice and the index the cursor
// has inside it.
func windowRows(count, cursor, limit int) (int, int) {
	if count <= limit {
		return 0, count
	}
	first := cursor - limit/2
	if first < 0 {
		first = 0
	}
	if first > count-limit {
		first = count - limit
	}
	return first, first + limit
}

// renderCommandPalette draws the command list.
//
// Each row is the name in a fixed column plus the command's one-line
// description. The column is what makes the hints line up; without it the panel
// is a list of names that assumes you already know what they do.
func (m model) renderCommandPalette(width int) string {
	rows := m.filteredCommands()
	first, last := windowRows(len(rows), m.overlay.cursor, maxOverlayRows())
	inner := overlayInner(width)
	var body []string
	body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("palette.hint")), inner)...)
	if first > 0 {
		body = append(body, currentTheme.styleFor("rule").Render(fmt.Sprintf("  ↑ %d more", first)))
	}
	if len(rows) == 0 {
		body = append(body, currentTheme.styleFor("rule").Render("  "+i18n.T("palette.no_match")))
	}
	nameWidth := 0
	for _, command := range commands() {
		if len(command.name) > nameWidth {
			nameWidth = len(command.name)
		}
	}
	highlight := lipgloss.NewStyle().
		Background(lipgloss.Color(currentTheme.accentSoft)).
		Width(inner)
	for index := first; index < last; index++ {
		command := rows[index]
		row := fmt.Sprintf("  %-*s  ", nameWidth, command.name)
		row += currentTheme.styleFor("rule").Render(command.hint)
		if index == m.overlay.cursor {
			// The palette highlights with the **soft** accent, not the reverse
			// video the pickers use: here the cursor means "typing continues from
			// here", not "Enter commits this one".
			body = append(body, highlightRows(row, inner,
				func(line string) string { return highlight.Render(line) })...)
			continue
		}
		body = append(body, wrapCells(currentTheme.styleFor("answer").Render(
			fmt.Sprintf("  %-*s  ", nameWidth, command.name))+
			currentTheme.styleFor("rule").Render(command.hint), inner)...)
	}
	if last < len(rows) {
		body = append(body, currentTheme.styleFor("rule").Render(
			fmt.Sprintf("  ↓ %d more", len(rows)-last)))
	}
	return overlayFrame(width, i18n.T("palette.title"), "",
		panelBody(body, inner))
}

// filteredCommands is the candidates for the current line.
//
// The filter is the **input line**, not a private buffer: `/resume 2026` narrows
// the list and supplies the argument in one gesture, and the Enter that commits
// carries that argument. Matching is case-insensitive and ignores a leading `/`,
// because a command list that rejects `/RE` is a command list that looks broken.
func (m model) filteredCommands() []commandInfo {
	return filterCommands(m.paletteQuery())
}

// paletteQuery is the text after the leading `/`.
func (m model) paletteQuery() string {
	text := strings.TrimSpace(m.input)
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	text = strings.TrimPrefix(text, "/")
	if index := strings.IndexByte(text, ' '); index >= 0 {
		text = text[:index]
	}
	return text
}

// paletteArgument is everything after the command name on the palette line.
func (m model) paletteArgument() string {
	text := strings.TrimSpace(m.input)
	if index := strings.IndexByte(text, ' '); index >= 0 {
		return strings.TrimSpace(text[index+1:])
	}
	return ""
}

// renderOptionPicker serves /theme, /model and /effort.
//
// The `●` marks **the value in effect** and the cursor is the reverse-video row.
// Both are needed: the cursor is where Enter acts, and the dot is what the
// setting currently is — a panel that only marked the cursor made "which one am
// I on" unanswerable without reading the notes.
func (m model) renderOptionPicker(width int) string {
	rows := m.overlay.options
	first, last := windowRows(len(rows), m.overlay.cursor, maxOverlayRows())
	inner := overlayInner(width)
	var body []string
	for index := first; index < last; index++ {
		opt := rows[index]
		isCurrent := opt.note == i18n.T("picker.current")
		row := currentRow("  "+opt.row, isCurrent, inner)
		if index == m.overlay.cursor {
			body = append(body, highlightRows(row, inner,
				func(line string) string { return selectedRow(line, inner) })...)
		} else {
			body = append(body, wrapCells(row, inner)...)
		}
	}
	// The note belongs to the row under the cursor and is drawn once, below the
	// list: repeating it under every row is a paragraph per candidate.
	if m.overlay.cursor >= 0 && m.overlay.cursor < len(rows) {
		if note := optionNote(rows[m.overlay.cursor]); note != "" {
			body = append(body, wrapCells(currentTheme.styleFor("rule").Render("  "+note), inner)...)
		}
	}
	if m.overlay.waiting != "" {
		// The runtime has not spoken yet. Drawing the new value before the
		// runtime confirms it is drawing a lie — the panel stays open and says so.
		body = append(body, wrapCells(currentTheme.styleFor("warn").Render("  "+m.overlay.waiting), inner)...)
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("option.footer")), inner)...)
	badge := ""
	if len(rows) > 0 {
		badge = i18n.Tn("option.count", len(rows), "n", len(rows))
	}
	return overlayFrame(width, m.overlay.title, badge, panelBody(body, inner))
}

// optionNote is the row's explanation, with the "(current)" marker stripped —
// the marker is drawn as the dot, and repeating it as text says it twice.
func optionNote(opt option) string {
	note := strings.TrimSpace(strings.TrimSuffix(opt.note, i18n.T("picker.current")))
	return strings.TrimSpace(note)
}

// renderMCPPanel lists the configured servers and what they are doing.
//
// The state mark and colour carry the answer: mounted, configured but not
// mounted, and tried-and-failed are three different situations, and the third
// one has to say why.
func (m model) renderMCPPanel(width int) string {
	rows := m.mcpPanelRows()
	first, last := windowRows(len(rows), m.overlay.cursor, maxOverlayRows())
	inner := overlayInner(width)
	var body []string
	if len(rows) == 0 {
		body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("mcp_dialog.empty")), inner)...)
	}
	nameWidth := 0
	for _, row := range rows {
		if len(row.name) > nameWidth {
			nameWidth = len(row.name)
		}
	}
	for index := first; index < last; index++ {
		row := rows[index]
		text := row.text(nameWidth)
		if index == m.overlay.cursor {
			body = append(body, highlightRows(text, inner,
				func(line string) string { return selectedRow(line, inner) })...)
		} else {
			body = append(body, wrapCells(text, inner)...)
		}
	}
	if m.overlay.waiting != "" {
		body = append(body, wrapCells(currentTheme.styleFor("warn").Render(m.overlay.waiting), inner)...)
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("mcp_dialog.footer")), inner)...)
	loaded, total := mcpTally(m.panel.mcp)
	badge := ""
	if total > 0 {
		badge = i18n.T("mcp_dialog.running", "loaded", loaded, "total", total)
	}
	return overlayFrame(width, i18n.T("mcp_dialog.head"), badge, panelBody(body, inner))
}

type mcpRow struct {
	name  string
	state string
	tools int
	where string
	err   string
}

// text draws one MCP row: mark, name in a fixed column, then the state.
func (row mcpRow) text(nameWidth int) string {
	mark, role := "·", "rule"
	switch row.state {
	case "loaded":
		mark, role = "●", "answer"
	case "failed":
		mark, role = "✗", "denied"
	case "unload":
		mark = "○"
	}
	detail := i18n.T("mcp.not_loaded")
	switch row.state {
	case "loaded":
		detail = i18n.Tn("mcp.tools", row.tools, "n", row.tools)
	case "failed":
		// Without the reason, "not connected" helps nobody.
		reason := row.err
		if reason == "" {
			reason = i18n.T("mcp.no_reason")
		}
		detail = i18n.T("mcp.not_connected", "error", reason)
	}
	line := currentTheme.styleFor(role).Render(mark+" ") +
		currentTheme.styleFor("process").Render(fmt.Sprintf("%-*s", nameWidth, row.name)) +
		currentTheme.styleFor(role).Render("  "+detail)
	if row.where != "" {
		// Host only. A hosted URL routinely carries a token in path or query, and
		// this string is drawn on a screen.
		line += currentTheme.styleFor("rule").Render("  " + row.where)
	}
	return line
}

func (m model) mcpPanelRows() []mcpRow {
	var rows []mcpRow
	for _, item := range m.panel.mcp {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := row["name"].(string)
		state, _ := row["state"].(string)
		where, _ := row["where"].(string)
		err, _ := row["error"].(string)
		rows = append(rows, mcpRow{
			name: name, state: state, tools: intOf(row["tools"]),
			where: where, err: err,
		})
	}
	return rows
}

// renderSessionPicker lists the saved sessions.
//
// The current session is marked: `/resume` on the session you are already in is a
// no-op, and without the mark that no-op looks like a broken panel.
func (m model) renderSessionPicker(width int) string {
	rows := m.sessionOptions
	first, last := windowRows(len(rows), m.overlay.cursor, maxOverlayRows())
	inner := overlayInner(width)
	var body []string
	if len(rows) == 0 {
		body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("session_dialog.empty")), inner)...)
	}
	for index := first; index < last; index++ {
		opt := rows[index]
		line := currentRow(opt.row, opt.value == m.sessionID, inner)
		if index == m.overlay.cursor {
			body = append(body, highlightRows(line, inner,
				func(text string) string { return selectedRow(text, inner) })...)
		} else {
			body = append(body, wrapCells(line, inner)...)
		}
		if index == m.overlay.cursor && opt.note != "" {
			body = append(body, wrapCells(currentTheme.styleFor("rule").Render("  "+opt.note), inner)...)
		}
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("session_dialog.footer")), inner)...)
	return overlayFrame(width, i18n.T("session_dialog.head"), "", panelBody(body, inner))
}

// renderSkillsPanel is the `Ctrl+S` list: everything this workspace offers, with
// the loaded ones ticked.
//
// It is a panel rather than a block in the log because it is a lookup that is
// opened, read and dismissed — and because the rail's skills block answers a
// different question ("which ones has this session read").
func (m model) renderSkillsPanel(width int) string {
	rows := m.skillRows
	first, last := windowRows(len(rows), m.overlay.cursor, maxOverlayRows())
	inner := overlayInner(width)
	var body []string
	if len(rows) == 0 {
		body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("skills.empty")), inner)...)
	}
	nameWidth := 0
	for _, row := range rows {
		if len(row.name) > nameWidth {
			nameWidth = len(row.name)
		}
	}
	for index := first; index < last; index++ {
		row := rows[index]
		mark, role := "  ", "rule"
		if row.loaded {
			mark, role = "✓ ", "result"
		}
		line := currentTheme.styleFor(role).Render(mark) +
			currentTheme.styleFor("skill").Render(fmt.Sprintf("%-*s", nameWidth, row.name))
		if row.description != "" {
			line += currentTheme.styleFor("rule").Render("   " + row.description)
		}
		if index == m.overlay.cursor {
			body = append(body, highlightRows(line, inner,
				func(text string) string { return selectedRow(text, inner) })...)
		} else {
			body = append(body, wrapCells(line, inner)...)
		}
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").Render(i18n.T("skills.footer")), inner)...)
	return overlayFrame(width, i18n.T("skills.title"), "", panelBody(body, inner))
}

// skillRow is one line of the skills panel.
type skillRow struct {
	name        string
	description string
	loaded      bool
}

// appendSkills records the catalogue for the panel and leaves one line in the
// log saying how many there are. The full list is a panel, not a screenful of
// log: it is a lookup, and the log is for what happened.
func (m *model) appendSkills(payload map[string]any) {
	rows, _ := payload["skills"].([]any)
	loaded := map[string]bool{}
	for _, name := range stringList(payload["active"]) {
		loaded[name] = true
	}
	m.skillRows = m.skillRows[:0]
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := textOf2(row, "name", "")
		if name == "" {
			continue
		}
		m.skillRows = append(m.skillRows, skillRow{
			name:        name,
			description: textOf2(row, "description", ""),
			loaded:      loaded[name],
		})
	}
	if len(m.skillRows) == 0 {
		m.overlay = overlay{kind: overlaySkills, title: i18n.T("skills.title")}
		return
	}
	// The panel opens itself: the request was made by a person pressing a key to
	// see the list, and answering that with a single line of text in the log
	// would make them press again.
	m.overlay = overlay{kind: overlaySkills, title: i18n.T("skills.title")}
}

// pickerThemeOptions builds the /theme list from the palettes.
//
// The key and the ordinal are in the row because they are what `/theme <x>`
// accepts: a picker that shows only the display name teaches nothing about the
// command form.
func pickerThemeOptions() []option {
	options := make([]option, 0, len(themeOrder))
	for index, key := range themeOrder {
		value := themes[key]
		row := fmt.Sprintf("%d  %-5s %s", index+1, key, value.name)
		note := value.source
		if key == currentTheme.key {
			note = i18n.T("picker.current") + "  " + note
		}
		options = append(options, option{value: string(key), row: row, note: note})
	}
	return options
}
