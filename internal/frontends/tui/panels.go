package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
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

// renderWelcome is the empty state: the logo plus the three boxes — start,
// recent, hint — that are the only thing on screen worth looking at before the
// first message.
func (m model) renderWelcome(width int) string {
	logoStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color(currentTheme.accent)).Bold(true)
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Padding(0, 1)

	var logo []string
	for _, row := range welcomeLogo {
		logo = append(logo, logoStyle.Render(row))
	}

	startBox := boxStyle.Render(strings.Join([]string{
		lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).Render(i18n.T("welcome.start.title")),
		i18n.T("welcome.start.body"),
		i18n.T("welcome.start.hint"),
	}, "\n"))

	recentBox := boxStyle.Render(strings.Join(m.recentRows(), "\n"))

	hintBox := boxStyle.Render(strings.Join([]string{
		i18n.T("welcome.hint.line1"),
		i18n.T("welcome.hint.line2"),
	}, "\n"))

	inner := lipgloss.JoinVertical(lipgloss.Center,
		strings.Join(logo, "\n"), "", startBox, recentBox, hintBox)
	return lipgloss.Place(width, m.bodyHeight(), lipgloss.Center, lipgloss.Center, inner)
}

// recentRows fills the welcome screen's second box. The interface holds no
// session history of its own — that is `/resume`'s picker's job — so the box
// says where to look instead of pretending to remember.
func (m model) recentRows() []string {
	return []string{
		lipgloss.NewStyle().Foreground(lipgloss.Color(currentTheme.ink4)).Render(i18n.T("welcome.recent.title")),
		i18n.T("welcome.recent.empty"),
		i18n.T("welcome.recent.hint"),
	}
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

func overlayFrame(width int, title string, body string) string {
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(currentTheme.accent)).
		Background(lipgloss.Color(currentTheme.elevated)).
		Width(width).Padding(0, 1)
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
			body.WriteString(selectedRow(name, width-2) + "\n")
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
