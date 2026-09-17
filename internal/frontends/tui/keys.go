package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// handleKey routes one keystroke.
//
// The dialogs come first: while an approval is on screen it owns the keyboard,
// because the one thing that must not happen is a keystroke meant for the dialog
// landing in the input line and being sent as a message.
func (m model) handleKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.pendingPermission != nil {
		return m.handlePermissionKey(key)
	}
	if m.pendingQuestion != nil {
		return m.handleQuestionKey(key)
	}

	switch key.Type {
	case tea.KeyCtrlC:
		return m, tea.Quit

	case tea.KeyEsc:
		if m.busy {
			m.client.Interrupt()
			m.append("notice", i18n.T("escape.interrupting"))
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

	case tea.KeyUp:
		m.scroll += 3
		return m, nil

	case tea.KeyDown:
		if m.scroll > 0 {
			m.scroll -= 3
		}
		return m, nil

	case tea.KeyCtrlB:
		// The rail toggle is a display preference, not a mode.
		m.railHidden = !m.railHidden
		return m, nil

	case tea.KeyCtrlT:
		m.thinkingExpanded = !m.thinkingExpanded
		return m, nil

	case tea.KeyRunes, tea.KeySpace:
		m.input += string(key.Runes)
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

	m.append("user", text)
	m.busy = true
	m.activity = i18n.T("activity.preparing")
	m.streamedText = ""
	m.client.UserMessage(text)
	return m, nil
}

// runCommand handles the slash commands.
//
// Recognising the words a user types is the interface's business — `/thinking 开`
// and `/thinking on` mean the same thing here. What is *not* the interface's
// business is the value that goes on the wire: that is the protocol's shape, and
// the protocol says a boolean.
func (m model) runCommand(text string) (tea.Model, tea.Cmd) {
	fields := strings.Fields(text)
	name := fields[0]
	arguments := fields[1:]

	switch name {
	case "/exit", "/quit":
		return m, tea.Quit

	case "/help":
		m.append("notice", i18n.T("help.commands_title"))
		m.append("notice", "  "+strings.Join(commandNames(), "  "))
		m.append("notice", i18n.T("help.keys_title"))
		m.append("notice", "  Enter  "+i18n.T("hint.enter"))
		m.append("notice", "  Shift+Enter  "+i18n.T("hint.shift_enter"))
		m.append("notice", "  Esc  "+i18n.T("hint.escape"))
		m.append("notice", "  Ctrl+B  "+i18n.T("hint.rail"))
		m.append("notice", "  Ctrl+T  "+i18n.T("hint.thinking"))
		return m, nil

	case "/new":
		m.client.SwitchSession("")
		m.append("notice", i18n.T("switch.new_session"))
		return m, nil

	case "/resume":
		if len(arguments) == 0 {
			m.client.ListSessions()
			m.append("notice", i18n.T("resume.loading"))
			return m, nil
		}
		m.client.SwitchSession(arguments[0])
		m.append("notice", i18n.T("switch.to_session", "name", arguments[0]))
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
		m.append("notice", i18n.T("cmd.compact.waiting"))
		return m, nil

	case "/model":
		if len(arguments) == 0 {
			m.append("notice", i18n.T("model.current", "name", m.panel.model))
			m.append("notice", i18n.T("model.howto"))
			return m, nil
		}
		m.client.SetModel(arguments[0])
		return m, nil

	case "/thinking":
		if len(arguments) == 0 {
			m.append("notice", i18n.T("thinking.mode", "state", i18n.T("thinking."+onOff(m.panel.thinking))))
			return m, nil
		}
		on, known := state.ResolveThinking(arguments[0])
		if !known {
			m.append("error", i18n.T("cmd.thinking.unknown", "rest", arguments[0]))
			return m, nil
		}
		m.client.SetThinking(on)
		return m, nil

	case "/effort":
		if len(arguments) == 0 {
			m.append("notice", i18n.T("effort.current", "effort", m.panel.effort))
			m.append("notice", i18n.T("effort.howto", "levels", strings.Join(state.EffortLevels, " / ")))
			return m, nil
		}
		m.client.SetEffort(arguments[0])
		return m, nil

	case "/autopilot":
		m.client.SetAutopilot(!m.panel.autopilot)
		return m, nil

	case "/mcp":
		if len(arguments) >= 2 {
			m.client.MCP(arguments[0], arguments[1:])
			m.append("notice", i18n.T("mcp.pending", "action", arguments[0], "name", arguments[1]))
			return m, nil
		}
		m.client.MCP("list", nil)
		return m, nil

	case "/skills":
		m.append("notice", i18n.T("skills.footer"))
		return m, nil

	case "/quiet":
		m.quiet = !m.quiet
		word := i18n.T("quiet.off")
		note := i18n.T("quiet.off_note")
		if m.quiet {
			word = i18n.T("quiet.on")
			note = i18n.T("quiet.on_note")
		}
		m.append("notice", i18n.T("quiet.name")+word+note)
		return m, nil

	case "/audit":
		m.append("notice", i18n.T("cmd.audit.line", "path", m.auditPath))
		return m, nil
	}

	m.append("error", i18n.T("cmd.unknown", "name", name))
	return m, nil
}

func commandNames() []string {
	return []string{"/new", "/resume", "/status", "/tools", "/context", "/compact",
		"/model", "/thinking", "/effort", "/mcp", "/skills", "/autopilot", "/quiet",
		"/audit", "/help", "/exit"}
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

// handlePermissionKey answers an approval request.
//
// The keys follow the prompt the runtime sent: `t` and `a` exist only when the
// runtime offered them, and the interface never invents a wider option. If a
// person could grant "always allow the whole shell" from here, it would be a
// permission the runtime deliberately refused to offer.
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
		// Escape denies. It is the same direction as the unreadable-input path:
		// fail closed. It is not "dismiss without deciding", because the runtime
		// has no third state to move to — it would just wait forever.
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
		// What goes back is the option's **text**, not its number: numbers are only
		// how this panel happens to draw them.
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
