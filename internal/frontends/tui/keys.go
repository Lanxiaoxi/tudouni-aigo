package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// handleKey routes one keystroke.
//
// Priority, top to bottom: an approval owns the keyboard, then a question, then
// an overlay panel, then the editor. The ordering is the safety property: a
// keystroke meant for a dialog must never land in the input line and leave as a
// message.
func (m model) handleKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.pendingPermission != nil {
		return m.handlePermissionKey(key)
	}
	if m.pendingQuestion != nil {
		return m.handleQuestionKey(key)
	}
	if m.overlay.kind != overlayNone {
		return m.handleOverlayKey(key)
	}

	switch key.Type {
	case tea.KeyCtrlC:
		return m, tea.Quit

	case tea.KeyEsc:
		if m.busy {
			m.client.Interrupt()
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("escape.interrupting"), role: "warn"},
			}}, "notice", "")
		}
		return m, nil

	case tea.KeyCtrlB:
		// The rail toggle is a display preference, not a mode.
		m.railHidden = !m.railHidden
		return m, nil

	case tea.KeyCtrlK:
		// The palette's named key. `/` still opens it — muscle memory from the
		// line interface — but the hint bars advertise this one, because a key
		// chord works while the input line already has text in it.
		return m, m.openCommandPalette()

	case tea.KeyCtrlS:
		// The skills list is a lookup, so it goes to the transcript where it
		// can be scrolled back — the same reasoning as /status and /tools.
		m.client.ListSkills()
		return m, nil

	case tea.KeyCtrlT:
		return m, m.toggleThinking()

	case tea.KeyUp:
		m.scroll += 3
		return m, nil

	case tea.KeyDown:
		if m.scroll > 0 {
			m.scroll -= 3
		}
		return m, nil

	case tea.KeyEnter:
		return m.submit()

	case tea.KeyBackspace:
		if m.input != "" {
			runes := []rune(m.input)
			m.input = string(runes[:len(runes)-1])
		}
		return m, nil

	case tea.KeySpace:
		m.input += " "
		return m, nil

	case tea.KeyRunes:
		m.input += string(key.Runes)
		// `/` at the start of an empty line opens the palette; typing after it
		// filters. Opening on the keystroke means the palette never loses the
		// first letter.
		if m.input == "/" {
			return m, m.openCommandPalette()
		}
		return m, nil
	}
	return m, nil
}

// submit sends the input line, unless it is a command.
func (m model) submit() (tea.Model, tea.Cmd) {
	text := strings.TrimSpace(m.input)
	m.input = ""
	if text == "" {
		return m, nil
	}

	if strings.HasPrefix(text, "/") {
		return m.runCommand(text)
	}

	m.appendUser(text)
	m.busy = true
	m.pendingUserInput = text
	m.activity = i18n.T("activity.preparing")
	m.streamedText = ""
	m.thinkingChars = 0
	m.client.UserMessage(text)
	return m, nil
}

// runCommand handles the slash commands.
func (m model) runCommand(text string) (tea.Model, tea.Cmd) {
	fields := strings.Fields(text)
	name := fields[0]
	arguments := fields[1:]

	switch name {
	case "/exit", "/quit":
		return m, tea.Quit

	case "/help":
		return m.showHelp()

	case "/new":
		m.client.SwitchSession("")
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("switch.new_session"), role: "notice"},
		}}, "notice", "")
		return m, nil

	case "/resume":
		if len(arguments) == 0 {
			// No argument: the picker. The panel opens **now**, empty, and the
			// runtime's list fills it — an empty frame beats a dead keypress
			// while the runtime reads the directory.
			m.overlay = overlay{kind: overlaySessions, title: i18n.T("resume.title")}
			m.client.ListSessions()
			return m, nil
		}
		m.client.SwitchSession(arguments[0])
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("switch.to_session", "name", arguments[0]), role: "notice"},
		}}, "notice", "")
		return m, nil

	case "/status":
		m.client.AskStatus()
		return m, nil

	case "/tools":
		m.client.AskTools()
		return m, nil

	case "/context":
		m.client.AskContext()
		return m, nil

	case "/compact":
		m.client.Compact()
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("cmd.compact.waiting"), role: "notice"},
		}}, "notice", "")
		return m, nil

	case "/model":
		if len(arguments) == 0 {
			if len(m.modelCatalog) == 0 {
				// No catalogue on this protocol: the plain-text fallback. A picker
				// with zero options looks like the interface is broken, when it is
				// really the runtime speaking an older shape.
				m.appendLine(renderLine{segments: []seg{
					{text: i18n.T("model.current", "name", m.panel.model), role: "notice"},
					{text: i18n.T("model.howto"), role: "rule"},
				}}, "notice", "")
				return m, nil
			}
			return m, m.openOptionPicker(i18n.T("model.pick.title"), m.modelOptions(), false)
		}
		m.client.SetModel(arguments[0])
		return m, nil

	case "/thinking":
		if len(arguments) == 0 {
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("thinking.mode", "state", i18n.T("thinking."+onOff(m.panel.thinking))), role: "notice"},
			}}, "notice", "")
			return m, nil
		}
		on, known := state.ResolveThinking(arguments[0])
		if !known {
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("cmd.thinking.unknown", "rest", arguments[0]), role: "warn"},
			}}, "notice", "")
			return m, nil
		}
		m.client.SetThinking(on)
		return m, nil

	case "/effort":
		if len(arguments) == 0 {
			if len(m.effortLevels) == 0 {
				m.appendLine(renderLine{segments: []seg{
					{text: i18n.T("effort.current", "effort", m.panel.effort), role: "notice"},
				}}, "notice", "")
				return m, nil
			}
			return m, m.openOptionPicker(i18n.T("effort.pick.title"), m.effortOptions(), false)
		}
		m.client.SetEffort(arguments[0])
		return m, nil

	case "/theme":
		if len(arguments) == 0 {
			return m, m.openOptionPicker(i18n.T("theme.pick.title"), pickerThemeOptions(), true)
		}
		key, ok := resolveTheme(arguments[0])
		if !ok {
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("theme.unknown", "query", arguments[0], "list", themeListing()), role: "warn"},
			}}, "notice", "")
			return m, nil
		}
		setTheme(key)
		m.theme = key
		return m, nil

	case "/autopilot":
		m.client.SetAutopilot(!m.panel.autopilot)
		return m, nil

	case "/mcp":
		if len(arguments) >= 2 {
			m.client.MCP(arguments[0], arguments[1:])
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("mcp.pending", "action", arguments[0], "name", arguments[1]), role: "notice"},
			}}, "notice", "")
			return m, nil
		}
		m.overlay = overlay{kind: overlayMCP, staysOpen: true,
			title: i18n.T("mcp.panel.title")}
		m.client.MCP("list", nil)
		return m, nil

	case "/skills":
		m.client.ListSkills()
		return m, nil

	case "/quiet":
		// A display preference, so it takes effect **now** and tells you so — no
		// protocol message, because there is nothing to confirm.
		m.quiet = !m.quiet
		word := i18n.T("quiet.off")
		note := i18n.T("quiet.off_note")
		if m.quiet {
			word = i18n.T("quiet.on")
			note = i18n.T("quiet.on_note")
		}
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("quiet.name") + word + note, role: "notice"},
		}}, "notice", "")
		return m, nil

	case "/audit":
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("cmd.audit.line", "path", m.auditPath), role: "notice"},
		}}, "notice", "")
		return m, nil
	}

	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("cmd.unknown", "name", name), role: "warn"},
	}}, "notice", "")
	return m, nil
}

func (m model) showHelp() (tea.Model, tea.Cmd) {
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("help.commands_title"), role: "turn_start"},
		{text: "  " + strings.Join(commandNames(), "  "), role: "rule"},
		{text: i18n.T("help.keys_title"), role: "turn_start"},
		{text: "  Enter  " + i18n.T("hint.enter") +
			"   Shift+Enter  " + i18n.T("hint.shift_enter") +
			"   Esc  " + i18n.T("hint.escape") +
			"   Ctrl+B  " + i18n.T("hint.rail") +
			"   Ctrl+T  " + i18n.T("hint.thinking"), role: "rule"},
		{text: i18n.T("help.themes"), role: "rule"},
	}}, "notice", "")
	return m, nil
}

func commandNames() []string {
	return []string{"/new", "/resume", "/status", "/tools", "/context", "/compact",
		"/model", "/thinking", "/effort", "/theme", "/mcp", "/skills", "/autopilot",
		"/quiet", "/audit", "/help", "/exit"}
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

// ── overlays ──────────────────────────────────────────────────────────────────

func (m *model) openCommandPalette() tea.Cmd {
	m.overlay = overlay{kind: overlayCommand}
	return nil
}

func (m *model) openOptionPicker(title string, options []option, closesOnPick bool) tea.Cmd {
	cursor := 0
	for index, opt := range options {
		if opt.note == i18n.T("picker.current") {
			cursor = index
		}
	}
	m.overlay = overlay{kind: overlayOptions, title: title, options: options, cursor: cursor}
	return nil
}

func (m *model) openSessionPicker(payload map[string]any) {
	items, _ := payload["items"].([]any)
	options := make([]option, 0, len(items))
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["session_id"].(string)
		preview, _ := row["preview"].(string)
		messages, _ := asInt(row["messages"])
		options = append(options, option{
			value: id,
			row:   fmt.Sprintf("%s  %s", id, clipText(preview, 40)),
			note:  i18n.Tn("status.session.messages", messages),
		})
	}
	m.sessionOptions = options
	m.overlay = overlay{kind: overlaySessions, title: i18n.T("resume.title"), options: options}
}

// handleOverlayKey routes keys while a panel is up.
func (m model) handleOverlayKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.Type {
	case tea.KeyEsc, tea.KeyCtrlC:
		if key.Type == tea.KeyCtrlC {
			return m, tea.Quit
		}
		m.overlay = overlay{}
		return m, nil

	case tea.KeyUp:
		m.moveCursor(-1)
		return m, nil

	case tea.KeyDown:
		m.moveCursor(1)
		return m, nil

	case tea.KeyEnter:
		return m.commitOverlay()

	case tea.KeyBackspace:
		if m.overlay.kind == overlayCommand && m.overlay.filter != "" {
			runes := []rune(m.overlay.filter)
			m.overlay.filter = string(runes[:len(runes)-1])
			m.overlay.cursor = 0
		}
		return m, nil

	case tea.KeyRunes, tea.KeySpace:
		if m.overlay.kind == overlayCommand {
			m.overlay.filter += string(key.Runes)
			m.overlay.cursor = 0
			return m, nil
		}
		// A picker honours the number keys: pressing the row number is picking
		// that row, which is faster than walking down a 13-item list.
		if m.overlay.kind == overlayOptions {
			if index, ok := parseNumber(string(key.Runes)); ok &&
				index >= 1 && index <= len(m.overlay.options) {
				m.overlay.cursor = index - 1
				return m.commitOverlay()
			}
		}
	}
	return m, nil
}

func (m *model) moveCursor(delta int) {
	count := m.overlayCount()
	if count == 0 {
		return
	}
	m.overlay.cursor += delta
	if m.overlay.cursor < 0 {
		m.overlay.cursor = count - 1
	}
	if m.overlay.cursor >= count {
		m.overlay.cursor = 0
	}
}

func (m model) overlayCount() int {
	switch m.overlay.kind {
	case overlayCommand:
		return len(m.filteredCommands())
	case overlayOptions, overlaySessions:
		return len(m.overlay.options)
	case overlayMCP:
		return len(m.mcpPanelRows())
	}
	return 0
}

// commitOverlay acts on the row under the cursor.
//
// Which panels close is decided by **who owns the outcome**: the theme is local
// (a wrong pick is visible immediately, so pick-and-close), while model and
// effort changes only the runtime can confirm — their panels stay up until the
// notice arrives, and the notice is printed under the panel.
func (m model) commitOverlay() (tea.Model, tea.Cmd) {
	switch m.overlay.kind {
	case overlayCommand:
		rows := m.filteredCommands()
		if m.overlay.cursor >= len(rows) {
			return m, nil
		}
		picked := rows[m.overlay.cursor]
		m.overlay = overlay{}
		m.input = ""
		return m.runCommand(picked)

	case overlayOptions:
		if m.overlay.cursor >= len(m.overlay.options) {
			return m, nil
		}
		picked := m.overlay.options[m.overlay.cursor]
		switch m.overlay.title {
		case i18n.T("theme.pick.title"):
			// Local, visible, done.
			if key, ok := resolveTheme(picked.value); ok {
				setTheme(key)
				m.theme = key
			}
			m.overlay = overlay{}
			return m, nil
		case i18n.T("model.pick.title"):
			m.overlay.waiting = i18n.T("picker.waiting", "value", picked.value)
			m.client.SetModel(picked.value)
			return m, nil
		case i18n.T("effort.pick.title"):
			m.overlay.waiting = i18n.T("picker.waiting", "value", picked.value)
			m.client.SetEffort(picked.value)
			return m, nil
		}
		return m, nil

	case overlayMCP:
		rows := m.mcpPanelRows()
		if m.overlay.cursor >= len(rows) {
			return m, nil
		}
		row := rows[m.overlay.cursor]
		action := "load"
		if row.state == "loaded" {
			action = "unload"
		}
		m.overlay.waiting = i18n.T("mcp.panel.waiting", "action", action, "name", row.name)
		m.client.MCP(action, []string{row.name})
		return m, nil

	case overlaySessions:
		if m.overlay.cursor >= len(m.overlay.options) {
			return m, nil
		}
		picked := m.overlay.options[m.overlay.cursor]
		m.overlay = overlay{}
		m.client.SwitchSession(picked.value)
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("switch.to_session", "name", picked.value), role: "notice"},
		}}, "notice", "")
		return m, nil
	}
	return m, nil
}

// reloadOverlayOptions recomputes the picker's rows from the latest state,
// keeping the cursor where it was. A picker left open is live; a static
// highlight on a value that is no longer current reads as "my press did
// nothing".
func (m *model) reloadOverlayOptions() {
	if m.overlay.kind != overlayOptions || m.overlay.waiting == "" {
		return
	}
	switch m.overlay.title {
	case i18n.T("model.pick.title"):
		m.overlay.options = m.modelOptions()
	case i18n.T("effort.pick.title"):
		m.overlay.options = m.effortOptions()
	}
	// The waiting note is cleared only when a notice about the change arrives;
	// applyState alone does not settle the panel.
}

func (m model) modelOptions() []option {
	options := make([]option, 0, len(m.modelCatalog))
	for _, item := range m.modelCatalog {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["id"].(string)
		provider, _ := row["provider"].(string)
		window, _ := row["context_window"]
		name := id
		if provider != "" {
			name = provider + "/" + id
		}
		note := ""
		if name == m.panel.model {
			note = i18n.T("picker.current")
		}
		if window != nil {
			note = windowText(window) + "  " + note
		}
		options = append(options, option{value: name, row: name, note: strings.TrimSpace(note)})
	}
	return options
}

func (m model) effortOptions() []option {
	options := make([]option, 0, len(m.effortLevels))
	for _, level := range m.effortLevels {
		note := ""
		if level == m.panel.effort {
			note = i18n.T("picker.current")
		}
		options = append(options, option{value: level, row: level, note: note})
	}
	return options
}

// toggleThinking flips the expanded state of the turn with thinking content —
// the one under the viewport is, in this layout, the most recent one that has
// any, because that is the turn a person is reading.
func (m model) toggleThinking() tea.Cmd {
	for index := len(m.transcript) - 1; index >= 0; index-- {
		turn := m.transcript[index].turn
		if turn != nil && turn.thinking != "" {
			turn.expanded = !turn.expanded
			return nil
		}
	}
	return nil
}

// ── dialogs ───────────────────────────────────────────────────────────────────

// handlePermissionKey answers an approval request.
//
// Escape denies — the same direction as unreadable input: fail closed. There is
// no third state the runtime could move to anyway.
func (m model) handlePermissionKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	request := m.pendingPermission
	id, _ := protocol.String(request, "id")

	hasRemember := request["remember"] != nil
	hasTrustAll, _ := request["allow_trust_all"].(bool)

	decide := func(decision string) (tea.Model, tea.Cmd) {
		m.pendingPermission = nil
		m.client.AnswerPermission(id, decision)
		return m, nil
	}

	switch key.Type {
	case tea.KeyEsc, tea.KeyCtrlC:
		return decide("deny")
	case tea.KeyRunes:
		switch strings.ToLower(string(key.Runes)) {
		case "y":
			return decide("allow")
		case "n":
			return decide("deny")
		case "t":
			if hasRemember {
				return decide("always")
			}
		case "a":
			if hasTrustAll {
				return decide("always_group")
			}
		}
	}
	return m, nil
}

// handleQuestionKey answers a question.
//
// Enter is the easiest key in the interface, so it cannot mean "yes" here. The
// first option is reached with `1` or by typing; Enter on an empty line skips.
func (m model) handleQuestionKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	request := m.pendingQuestion
	id, _ := protocol.String(request, "id")

	finish := func(status, text string) (tea.Model, tea.Cmd) {
		m.pendingQuestion = nil
		m.questionInput = ""
		m.client.AnswerQuestion(id, status, text)
		return m, nil
	}

	switch key.Type {
	case tea.KeyEsc, tea.KeyCtrlC:
		return finish(protocol.QuestionSkipped, "")
	case tea.KeyBackspace:
		if m.questionInput != "" {
			runes := []rune(m.questionInput)
			m.questionInput = string(runes[:len(runes)-1])
		}
		return m, nil
	case tea.KeyEnter:
		if strings.TrimSpace(m.questionInput) == "" {
			return finish(protocol.QuestionSkipped, "")
		}
		options, _ := request["options"].([]any)
		if index, ok := parseNumber(m.questionInput); ok && index >= 1 && index <= len(options) {
			if text, ok := options[index-1].(string); ok {
				return finish(protocol.QuestionAnswered, text)
			}
		}
		return finish(protocol.QuestionAnswered, m.questionInput)
	case tea.KeyRunes, tea.KeySpace:
		m.questionInput += string(key.Runes)
		return m, nil
	}
	return m, nil
}

func parseNumber(text string) (int, bool) {
	value := 0
	for _, char := range strings.TrimSpace(text) {
		if char < '0' || char > '9' {
			return 0, false
		}
		value = value*10 + int(char-'0')
	}
	return value, value > 0
}
