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
)

// option is one row of a picker. The value is what goes back on the wire; the
// row and the note are what a person reads.
type option struct {
	value string
	row   string
	note  string
}

// overlay is the active floating panel.
type overlay struct {
	kind    overlayKind
	title   string
	options []option
	cursor  int

	// filter is the command palette's typed fragment.
	filter string

	// waiting names the action the runtime is still processing. The panel
	// **never draws a result before the runtime confirms it**: a mount that
	// failed to start would otherwise read as mounted.
	waiting string

	// staysOpen marks panels that survive an action (MCP: toggling one server
	// off and on again is the common case; closing between every toggle would
	// cost one /mcp per server).
	staysOpen bool
}

// welcomeLogo is the three-line mark. Half- and full-block characters only:
// they are exactly one cell wide in every monospace font, where graphic
// characters often go double-width under CJK fonts and shove the text beside
// them out of line. The three lines are the same width for the same reason.
var welcomeLogo = []string{" ▄▄▄▄▄▄", "██▀▀██ ", " ▄▄▄▄▄▄"}

// welcomeBoxWidth / welcomeRightWidth / welcomeHintWidth are the three boxes'
// widths. Together they make 75 columns; on a 200-column terminal they do not
// stretch — three long empty bars are uglier than the whitespace.
const (
	welcomeStartWidth  = 32
	welcomeRightWidth  = 42
	welcomeHintWidth   = 75
	welcomeStackColumn = 78
	welcomeBoxLines    = 10
)

// renderWelcome is the empty state: two boxes side by side (start + recent)
// with the full-width hint box under them. Left-aligned, not centred — the
// content starts where the conversation will.
func (m model) renderWelcome(width int) []string {
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4))
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Background(lipgloss.Color(currentTheme.surface)).
		Foreground(lipgloss.Color(currentTheme.ink2))

	startContent := m.startRows()
	recentContent := m.recentBoxRows(4)
	startBox := box.Width(welcomeStartWidth - 2).Height(welcomeBoxLines).
		Render(strings.Join(startContent, "\n"))
	recentBox := box.Width(welcomeRightWidth - 2).Height(welcomeBoxLines).
		Render(strings.Join(recentContent, "\n"))

	hintRows := m.hintRows(width)
	hintBox := box.Width(min(width-4, welcomeHintWidth-2)).Height(len(hintRows)).
		Render(strings.Join(hintRows, "\n"))

	row := lipgloss.JoinHorizontal(lipgloss.Top,
		startBox, " ", recentBox)
	body := lipgloss.JoinVertical(lipgloss.Left, row, "", hintBox)

	// The titles ride on the border line: they are "what this box is called",
	// one greyness quieter than the content.
	titled := strings.Replace(body, boxTopLeft(), titleStyle.Render(boxTopLeft()), 1)
	_ = titled
	placed := lipgloss.PlaceHorizontal(width, lipgloss.Left, body)
	return strings.Split(placed, "\n")
}

// boxTopLeft is the corner glyph a rounded border starts with, used to pin the
// title onto the frame line.
func boxTopLeft() string { return "╭" }

// startRows is the identity panel: the mark, the greeting, the version, and
// where to type. Ten lines, fixed — the boxes are the same height because their
// content is the same height, and neither deforms with the data.
func (m model) startRows() []string {
	centre := func(text string, role string) string {
		text = clipText(text, welcomeStartWidth-6)
		line := currentTheme.styleFor(role).Render(text)
		pad := (welcomeStartWidth - 4 - runewidth.StringWidth(stripANSI(text))) / 2
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
	rows := []string{currentTheme.styleFor("rule").Render(i18n.T("welcome.recent.title"))}
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
	rows = append(rows, "", currentTheme.styleFor("rule").Render(i18n.T("welcome.recent.motto")))
	// Clip first, then centre on the clipped width — centring on the unclipped
	// width overflows the box and paints across the frame.
	motto := clipText(mottoOfDay(), welcomeRightWidth-8)
	if pad := welcomeRightWidth - 6 - runewidth.StringWidth(motto); pad > 0 {
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
	keys := []string{
		"welcome.motto.0", "welcome.motto.1", "welcome.motto.2",
		"welcome.motto.3", "welcome.motto.4", "welcome.motto.5",
		"welcome.motto.6", "welcome.motto.7",
	}
	return i18n.T(keys[day%len(keys)])
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
	const stampWidth = 15
	pad := stampWidth - runewidth.StringWidth(stamp)
	if pad < 1 {
		pad = 1
	}
	return currentTheme.styleFor("rule").Render(stamp+strings.Repeat(" ", pad)) +
		clipText(title, welcomeRightWidth-stampWidth-6)
}

// hintRows is the keyboard card. It can wrap, unlike the boxes' fixed lines —
// running out of width folds to the next row instead of clipping a key away.
func (m model) hintRows(width int) []string {
	type keyHint struct{ key, text string }
	pairs := []keyHint{
		{"Enter", i18n.T("hint.enter")}, {"/", i18n.T("hint.slash")},
		{"Ctrl+T", i18n.T("hint.thinking")}, {"Ctrl+B", i18n.T("hint.rail")},
		{"Esc", i18n.T("hint.escape")}, {"Ctrl+S", i18n.T("hint.skills")},
		{"Ctrl+K", i18n.T("hint.palette")},
	}
	perRow := 4
	if width < welcomeHintWidth {
		perRow = 3
	}
	var rows []string
	for start := 0; start < len(pairs); start += perRow {
		var line strings.Builder
		for index, pair := range pairs[start:min(start+perRow, len(pairs))] {
			if index > 0 {
				line.WriteString("   ")
			}
			line.WriteString(currentTheme.styleFor("process").Render(pair.key))
			line.WriteString(currentTheme.styleFor("rule").Render(" " + pair.text))
		}
		rows = append(rows, line.String())
	}
	return rows
}

// timeAgo is the recent list's stamp, rounded the way a person rounds.
func timeAgo(d time.Duration) string {
	switch {
	case d < time.Minute:
		return i18n.T("ago.now")
	case d < time.Hour:
		return i18n.T("ago.minutes", "n", int(d.Minutes()))
	case d < 24*time.Hour:
		return i18n.T("ago.hours", "n", int(d.Hours()))
	default:
		return i18n.T("ago.days", "n", int(d.Hours()/24))
	}
}

// userName greets the person. A missing name is not an error — the greeting
// just loses one word.
func userName() string {
	if name := os.Getenv("USERNAME"); name != "" {
		return name
	}
	if name := os.Getenv("USER"); name != "" {
		return name
	}
	return ""
}

// modelAndWorkspace is the start box's context line: what model this run talks
// to and where the agent's hands are tied to.
func (m model) modelAndWorkspace() string {
	workspace, err := os.Getwd()
	if err != nil {
		return m.panel.model
	}
	if m.panel.model == "" {
		return workspace
	}
	return m.panel.model + "  ·  " + workspace
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
	}
	return ""
}

// overlayFrame is the shared modal shape: 76 columns, the elevated background,
// a round hairline border. Hairline, not accent — every panel framed in the
// interaction colour would make the frame shout, and a modal already owns the
// screen by being on top.
func overlayFrame(width int, title string, body string) string {
	frameWidth := width
	if frameWidth > 76 {
		frameWidth = 76
	}
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.hairline)).
		Background(lipgloss.Color(currentTheme.elevated)).
		Width(frameWidth).Padding(1, 2)
	head := lipgloss.NewStyle().
		Foreground(lipgloss.Color(currentTheme.ink4)).Bold(true).Render(title)
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

// darkColor is the colour to print on top of an accent background.
func (t theme) darkColor() string {
	if t.dark {
		return t.bg
	}
	return t.surface
}

func (m model) renderCommandPalette(width int) string {
	rows := m.filteredCommands()
	body := &strings.Builder{}
	if len(rows) == 0 {
		body.WriteString(lipgloss.NewStyle().
			Foreground(lipgloss.Color(currentTheme.ink4)).Render(i18n.T("palette.no_match")) + "\n")
	}
	for index, name := range rows {
		if index == m.overlay.cursor {
			// The palette highlights with the **soft** accent, not the reverse
			// video the pickers use: here the cursor means "typing continues
			// from here", not "Enter commits this one".
			body.WriteString(lipgloss.NewStyle().
				Background(lipgloss.Color(currentTheme.accentSoft)).
				Width(width).Render("  "+name) + "\n")
		} else {
			body.WriteString("  " + name + "\n")
		}
	}
	if m.overlay.filter != "" {
		body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink3)).
			Render("/"+m.overlay.filter+"  ↑↓ · Enter · Esc") + "\n")
	}
	return overlayFrame(width, i18n.T("palette.title"), strings.TrimRight(body.String(), "\n"))
}

func (m model) filteredCommands() []string {
	var out []string
	for _, name := range commandNames() {
		if m.overlay.filter == "" || strings.HasPrefix(name, "/"+m.overlay.filter) {
			out = append(out, name)
		}
	}
	if m.overlay.cursor >= len(out) {
		return out
	}
	return out
}

// renderOptionPicker serves /theme, /model and /effort. The cursor marks the
// current selection; Enter commits.
func (m model) renderOptionPicker(width int) string {
	body := &strings.Builder{}
	for index, opt := range m.overlay.options {
		marker := "  "
		if index == m.overlay.cursor {
			marker = "● "
		}
		row := marker + opt.row
		if index == m.overlay.cursor {
			body.WriteString(selectedRow(row, width-2) + "\n")
		} else {
			body.WriteString("  " + row + "\n")
		}
		if opt.note != "" {
			body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
				Render("      "+opt.note) + "\n")
		}
	}
	if m.overlay.waiting != "" {
		// The runtime has not spoken yet. Drawing the new value before the
		// runtime confirms it is drawing a lie — the panel stays open and says so.
		body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.warn)).
			Render(m.overlay.waiting) + "\n")
	}
	body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
		Render(i18n.T("picker.footer")) + "\n")
	return overlayFrame(width, m.overlay.title, strings.TrimRight(body.String(), "\n"))
}

func (m model) renderMCPPanel(width int) string {
	body := &strings.Builder{}
	rows := m.mcpPanelRows()
	if len(rows) == 0 {
		body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
			Render(i18n.T("mcp.host.no_servers", "file", "mcp.json")) + "\n")
	}
	for index, row := range rows {
		if index == m.overlay.cursor {
			body.WriteString(selectedRow(row.text, width-2) + "\n")
		} else {
			body.WriteString("  " + row.text + "\n")
		}
	}
	if m.overlay.waiting != "" {
		body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.warn)).
			Render(m.overlay.waiting) + "\n")
	}
	body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
		Render(i18n.T("mcp.panel.footer")) + "\n")
	return overlayFrame(width, i18n.T("mcp.panel.title"), strings.TrimRight(body.String(), "\n"))
}

type mcpRow struct {
	text  string
	name  string
	state string
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
		tools, _ := asInt(row["tools"])
		where, _ := row["where"].(string)
		text := name + "  "
		if state == "loaded" {
			text += i18n.T("mcp.tools", "n", tools)
		} else {
			text += i18n.T("mcp.not_loaded")
		}
		if where != "" {
			// Host only. A hosted URL routinely carries a token in path or query,
			// and this string is drawn on a screen.
			text += "  " + where
		}
		rows = append(rows, mcpRow{text: text, name: name, state: state})
	}
	return rows
}

func (m model) renderSessionPicker(width int) string {
	body := &strings.Builder{}
	if len(m.sessionOptions) == 0 {
		body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
			Render(i18n.T("resume.none")) + "\n")
	}
	for index, opt := range m.sessionOptions {
		if index == m.overlay.cursor {
			body.WriteString(selectedRow(opt.row, width-2) + "\n")
		} else {
			body.WriteString("  " + opt.row + "\n")
		}
	}
	body.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).
		Render(i18n.T("picker.footer")) + "\n")
	return overlayFrame(width, i18n.T("resume.title"), strings.TrimRight(body.String(), "\n"))
}

// pickerThemeOptions builds the /theme list from the three palettes.
func pickerThemeOptions() []option {
	options := make([]option, 0, len(themeOrder))
	for _, key := range themeOrder {
		value := themes[key]
		row := fmt.Sprintf("%s — %s", value.name, value.source)
		note := ""
		if key == currentTheme.key {
			note = i18n.T("picker.current")
		}
		options = append(options, option{value: string(key), row: row, note: note})
	}
	return options
}
