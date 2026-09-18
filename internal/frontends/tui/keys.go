package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// handleKey routes one keystroke.
//
// Priority, top to bottom: an approval owns the keyboard, then a question, then
// an overlay panel, then the editor. The ordering is the safety property: a
// keystroke meant for a dialog must never land in the input line and leave as a
// message.
//
// The editor is reached through `handleEditorKey`, and **nothing inside the
// editor may call back into this function**: the palette's filter is the input
// line, so the palette forwards typing to the editor, and routing that through
// here re-entered the palette branch for ever. Go does not catch that; it dies
// with "fatal error: stack overflow", which is what typing any letter into the
// command palette used to do.
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
	return m.handleEditorKey(key)
}

// handleEditorKey is the input line: the careted editor plus the interface-level
// keys that belong to it (quit, interrupt, the rail, the panels).
func (m model) handleEditorKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.Type {
	case tea.KeyCtrlC:
		return m, tea.Quit

	case tea.KeyEsc:
		if m.busy {
			m.client.Interrupt()
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("escape.interrupting"), role: "warn"},
			}}, "notice", "")
			return m, nil
		}
		// Idle, Esc does nothing — and says so. A key that silently does nothing
		// is indistinguishable from an interface that has stopped responding.
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("escape.idle"), role: "rule"},
		}}, "notice", "")
		return m, nil

	case tea.KeyCtrlB:
		// The rail toggle is a display preference, not a mode, and it is bound at the
		// **window** level in the original, so it fires whatever is on top. Pressing
		// it also **pins** the choice: from here on the interface stops opening the
		// rail on its own, or a task list arriving would shove back what the user
		// just folded.
		m.toggleRail()
		return m, nil

	case tea.KeyCtrlK:
		// The palette's named key. `/` still opens it — muscle memory from the
		// line interface — but the hint bars advertise this one, because a key
		// chord works while the input line already has text in it.
		//
		// With an empty line it inserts the `/`: the panel is about to be used to
		// type a command, and the line is where the command goes. Leaving it blank
		// shows the same list but hides where to type.
		if strings.TrimSpace(m.input) == "" {
			m.input = "/"
			m.inputCursor = 1
		}
		return m, m.openCommandPalette()

	case tea.KeyCtrlS:
		// The skills list is a lookup, so it opens as a panel — instantly, before
		// the runtime has answered: an empty frame beats a dead keypress while the
		// list is read off disk.
		m.overlay = overlay{kind: overlaySkills, title: i18n.T("skills.title")}
		m.client.ListSkills()
		return m, nil

	case tea.KeyCtrlT:
		return m, m.toggleThinking()

	case tea.KeyUp:
		// Three meanings, one key, and each is the only sensible one at the time:
		// move the caret inside the box, and fall through to the transcript once
		// the caret is already on the top row. That is what the original's
		// PromptArea does, and it keeps Up from being a dead key in a box that
		// has text in it.
		if !m.atFirstRow(m.inputInnerWidth()) {
			m.moveCaretRow(m.inputInnerWidth(), -1)
			return m, nil
		}
		m.scroll += 1
		return m, nil

	case tea.KeyDown:
		if !m.atLastRow(m.inputInnerWidth()) {
			m.moveCaretRow(m.inputInnerWidth(), 1)
			return m, nil
		}
		if m.scroll > 0 {
			m.scroll -= 1
		}
		return m, nil

	case tea.KeyLeft:
		m.moveCaret(-1)
		return m, nil

	case tea.KeyRight:
		m.moveCaret(1)
		return m, nil

	case tea.KeyCtrlLeft:
		m.moveCaretWord(-1)
		return m, nil

	case tea.KeyCtrlRight:
		m.moveCaretWord(1)
		return m, nil

	case tea.KeyHome, tea.KeyCtrlA:
		m.moveCaretLineStart()
		return m, nil

	case tea.KeyEnd, tea.KeyCtrlE:
		m.moveCaretLineEnd()
		return m, nil

	case tea.KeyDelete:
		m.deleteForward()
		return m, nil

	case tea.KeyCtrlW:
		m.deleteWordBack()
		return m, nil

	case tea.KeyCtrlU:
		m.deleteToLineStart()
		return m, nil

	case tea.KeyCtrlJ:
		// A newline inside the prompt. Shift+Enter is what the original uses, but
		// Bubble Tea v1 cannot see it: a terminal sends the same byte for Enter and
		// Shift+Enter unless it speaks the kitty keyboard protocol, and this
		// version does not request it. Ctrl+J and Alt+Enter are what a terminal
		// can actually deliver, so those are what the copy advertises.
		m.insertText("\n")
		return m, nil

	case tea.KeyEnter:
		if key.Alt {
			m.insertText("\n")
			return m, nil
		}
		return m.submit()

	case tea.KeyBackspace:
		m.backspace()
		return m, nil

	case tea.KeySpace:
		m.insertText(" ")
		return m, nil

	case tea.KeyRunes:
		// A paste arrives as one KeyRunes message carrying the whole chunk,
		// newlines included, so it has to go in verbatim.
		m.insertText(string(key.Runes))
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

// inputInnerWidth is the editable width inside the box, matching renderInput.
func (m model) inputInnerWidth() int {
	return maxInt(m.width-6, 10)
}

// moveCaretWord moves the caret one word left or right, stopping at whitespace
// boundaries — Ctrl+Left/Right in every shell.
func (m *model) moveCaretWord(delta int) {
	runes, cursor := m.runesOf()
	position := cursor
	if delta < 0 {
		for position > 0 && runes[position-1] == ' ' {
			position--
		}
		for position > 0 && runes[position-1] != ' ' {
			position--
		}
	} else {
		for position < len(runes) && runes[position] != ' ' {
			position++
		}
		for position < len(runes) && runes[position] == ' ' {
			position++
		}
	}
	m.inputCursor = position
}

// submit sends the input line, unless it is a command.
func (m model) submit() (tea.Model, tea.Cmd) {
	text := strings.TrimSpace(m.input)
	m.input = ""
	m.inputCursor = 0
	if text == "" {
		return m, nil
	}

	if strings.HasPrefix(text, "/") {
		return m.runCommand(text)
	}

	// **No line here.** The turn block draws the line the user typed, out of
	// `pendingUserInput` → `turn.userInput` (`view.go:418`), and that is the only
	// place the original draws it (`view_state.py:919-923`). Appending a flat-log
	// echo as well put the same sentence on screen twice: once at the left margin
	// the moment Enter was pressed, once indented under the turn's header when
	// `run_started` came back.
	m.busy = true
	m.pendingUserInput = text
	m.activity = i18n.T("activity.preparing")
	m.streamedText = ""
	m.thinkingChars = 0
	m.client.UserMessage(text)
	return m, m.ensureSpinner()
}

// runCommand handles the slash commands.
func (m model) runCommand(text string) (tea.Model, tea.Cmd) {
	fields := strings.Fields(text)
	name := fields[0]
	arguments := fields[1:]
	// The raw remainder, for messages that quote back what was typed.
	rest := strings.TrimSpace(strings.TrimPrefix(text, name))

	switch name {
	case "/exit", "/quit":
		return m, tea.Quit

	case "/help":
		return m.showHelp()

	case "/new":
		// **No line here.** The `init` that comes back already prints the session's
		// identity, and printing one now as well produces the same sentence twice.
		// Waiting for the init also means the line is confirmation that the switch
		// happened rather than a claim that it was asked for.
		m.client.SwitchSession("")
		return m, nil

	case "/resume":
		if len(arguments) == 0 {
			// No argument: the picker. The panel opens **now**, empty, and the
			// runtime's list fills it — an empty frame beats a dead keypress
			// while the runtime reads the directory.
			m.overlay = overlay{kind: overlaySessions, title: i18n.T("session_dialog.head")}
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("resume.loading"), role: "rule"},
			}}, "notice", "")
			m.client.ListSessions()
			return m, nil
		}
		// The same reasoning as `/new`: the arriving `init` names the session, and
		// it is the only statement that is true once the switch has actually landed.
		m.client.SwitchSession(arguments[0])
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
				m.appendModelList()
				return m, nil
			}
			return m, m.openOptionPicker(i18n.T("model.pick.title"), m.modelOptions(), pickerStartNext)
		}
		m.client.SetModel(arguments[0])
		return m, nil

	case "/thinking":
		if len(arguments) == 0 {
			// Three lines, not one: the state, the effort (which survives thinking
			// being off, and that is the next thing the user wonders about), and how
			// to change it.
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("thinking.mode", "state", i18n.T("thinking."+onOff(m.panel.thinking))), role: "notice"},
			}}, "notice", "")
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("thinking.effort", "effort", m.panel.effort) +
					thinkingEffortNote(m.panel.thinking), role: "rule"},
			}}, "notice", "")
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("thinking.howto"), role: "rule"},
			}}, "notice", "")
			return m, nil
		}
		// **Only the literal `on` and `off`.** The protocol takes those two words
		// and nothing else, and the previous generation refused the aliases here on
		// purpose: the interface and the runtime must not drift about which
		// spellings count. `state.ResolveThinking` is the *runtime's* vocabulary
		// (it also answers `开`, `true`, `enabled`, …); using it here would make the
		// TUI accept eleven words and send one of two.
		word := strings.ToLower(strings.TrimSpace(arguments[0]))
		if word != "on" && word != "off" {
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("cmd.thinking.unknown", "rest", arguments[0]), role: "warn"},
			}}, "notice", "")
			return m, nil
		}
		m.client.SetThinking(word == "on")
		return m, nil

	case "/effort":
		if len(arguments) == 0 {
			if len(m.effortLevels) == 0 {
				m.appendEffortList()
				return m, nil
			}
			return m, m.openOptionPicker(i18n.T("effort.pick.title"), m.effortOptions(), pickerStartCurrent)
		}
		m.client.SetEffort(arguments[0])
		return m, nil

	case "/theme":
		if len(arguments) == 0 {
			return m, m.openOptionPicker(i18n.T("theme.pick.title"), pickerThemeOptions(), pickerStartCurrent)
		}
		key, ok := resolveTheme(arguments[0])
		if !ok {
			// The template names the value that was not recognised; binding it
			// under the wrong placeholder printed a literal `{name}` and threw the
			// typed word away.
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("theme.unknown", "name", arguments[0]), role: "warn"},
				{text: "  " + themeListing(), role: "rule"},
			}}, "notice", "")
			return m, nil
		}
		setTheme(key)
		m.theme = key
		return m, m.echoTheme(key)

	case "/autopilot":
		// Ask for the opposite, and say nothing yet: the runtime owns this fact,
		// and the echo comes from the snapshot it sends back (reportAutopilot).
		want := !m.panel.autopilot
		m.autopilotWanted = &want
		m.client.SetAutopilot(want)
		return m, nil

	case "/mcp":
		// Two accepted shapes: no argument opens the panel, and
		// `load|unload <name>` goes straight through for somebody who already knows
		// which server they want.
		//
		// Anything else **still opens the panel**. That is the point of the branch:
		// after a typo, "what can I do here" is the next question, and the panel is
		// the cheapest answer to it. Leaving the user with one line of text and no
		// way forward is the failure this exists to avoid.
		if len(arguments) >= 2 {
			action := strings.ToLower(arguments[0])
			if action == "load" || action == "unload" {
				m.client.MCP(action, arguments[1:])
				m.appendLine(renderLine{segments: []seg{
					{text: i18n.T("mcp.pending", "action", action, "name", arguments[1]), role: "notice"},
				}}, "notice", "")
				return m, nil
			}
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("cmd.mcp.unknown", "rest", rest), role: "warn"},
			}}, "notice", "")
		} else if len(arguments) == 1 {
			// A lone word — most often `load` with the name forgotten.
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("cmd.mcp.unknown", "rest", rest), role: "warn"},
			}}, "notice", "")
		}
		m.overlay = overlay{kind: overlayMCP, stayOpen: true,
			title: i18n.T("mcp_dialog.head")}
		m.client.MCP("list", nil)
		return m, nil

	case "/skills":
		m.overlay = overlay{kind: overlaySkills, title: i18n.T("skills.title")}
		m.client.ListSkills()
		return m, nil

	case "/quiet":
		// A display preference, so it takes effect **now** and tells you so — no
		// protocol message, because there is nothing to confirm. `on` and `off`
		// are accepted as well as the bare toggle: `/quiet off` that quietly
		// toggles *on* is a command that does the opposite of what it says.
		want := !m.quiet
		if len(arguments) > 0 {
			// Lowercased, like the previous generation: `/quiet OFF` and `/quiet Off`
			// both mean the same thing to a person, and a command that works in one
			// spelling and warns in another reads as a bug in the interface.
			switch strings.ToLower(arguments[0]) {
			case "on":
				want = true
			case "off":
				want = false
			default:
				m.appendLine(renderLine{segments: []seg{
					{text: i18n.T("cmd.quiet.unknown", "rest", arguments[0]), role: "warn"},
				}}, "notice", "")
				return m, nil
			}
		}
		m.quiet = want
		word := i18n.T("quiet.off")
		note := i18n.T("quiet.off_note")
		if m.quiet {
			word = i18n.T("quiet.on")
			note = i18n.T("quiet.on_note")
		}
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("quiet.name"), role: "rule"},
			{text: word, role: "waiting"},
			{text: note, role: "rule"},
		}}, "notice", "")
		if m.quiet {
			// The switch only changes how things are drawn from here on: the turns
			// already on screen were drawn the old way, and the original has no
			// per-turn event log to redraw them from. Saying so stops the switch
			// from looking broken.
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("quiet.on_extra"), role: "rule"},
			}}, "notice", "")
		}
		// Turning quiet on mid-turn has to start the frame chain, or the spinner
		// would sit on frame zero until some other message happened to arrive.
		return m, m.ensureSpinner()

	case "/audit":
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("cmd.audit.line", "path", m.auditPath), role: "notice"},
		}}, "notice", "")
		return m, nil
	}

	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("cmd.unknown", "name", name), role: "warn"},
		{text: "  " + strings.Join(slashCommands(), "  "), role: "rule"},
	}}, "notice", "")
	return m, nil
}

// showHelp is the command and key reference.
//
// Every command is listed with its one-line description, and the keys below it
// include the ones the welcome card has no room for. A help screen that lists
// bare names makes the reader guess what they do — which is what the palette is
// for, and this is the same information in a form that stays on screen.
func (m model) showHelp() (tea.Model, tea.Cmd) {
	lines := []renderLine{{segments: []seg{
		{text: i18n.T("help.commands_title"), role: "rule"},
	}}}
	nameWidth := 0
	for _, command := range commands() {
		if len(command.name) > nameWidth {
			nameWidth = len(command.name)
		}
	}
	for _, command := range commands() {
		lines = append(lines, renderLine{segments: []seg{
			{text: "  " + fmt.Sprintf("%-*s", nameWidth, command.name), role: "process"},
			{text: "  " + command.hint, role: "rule"},
		}})
		// The detail goes on its **own indented line**. It is a sentence, not a
		// second column: appended to the row it pushes the row past the panel's
		// inner width, and the border re-flows it — which is how one help entry
		// turns into three lines with the highlight smeared down them.
		if command.detail != "" {
			lines = append(lines, renderLine{segments: []seg{
				{text: strings.Repeat(" ", nameWidth+4) + command.detail, role: "rule"},
			}})
		}
	}
	lines = append(lines, renderLine{segments: []seg{
		{text: i18n.T("help.keys_title"), role: "rule"},
	}})
	for _, pair := range hintPairs(false) {
		lines = append(lines, renderLine{segments: []seg{
			{text: "  " + fmt.Sprintf("%-11s", pair[0]), role: "process"},
			{text: pair[1], role: "rule"},
		}})
	}
	// The arrow-key line is separate from the pairs above because it has no single
	// key on the left: it is three behaviours behind one pair of keys.
	lines = append(lines, renderLine{segments: []seg{
		{text: "  " + fmt.Sprintf("%-11s", "↑ ↓") + i18n.T("hint.arrows"), role: "rule"},
	}})
	lines = append(lines, renderLine{segments: []seg{
		{text: "  " + fmt.Sprintf("%-11s", "Ctrl+J") + i18n.T("hint.newline_key"), role: "rule"},
	}})
	lines = append(lines, renderLine{segments: []seg{
		{text: i18n.T("help.themes"), role: "rule"},
	}})
	m.appendLines(lines)
	return m, nil
}

// slashCommands returns the command names, for the "unknown command" line.
func slashCommands() []string {
	names := make([]string, 0, len(commands()))
	for _, command := range commands() {
		names = append(names, command.name)
	}
	return names
}

// toggleRail folds or unfolds the context rail, and pins the choice.
func (m *model) toggleRail() {
	m.railHidden = !m.railHidden
	m.railPinned = true
}

// thinkingEffortNote says whether the effort level is in force.
//
// With thinking off the level is still remembered — that is the whole point of
// keeping the two knobs apart — and saying so is the answer to "did I just lose the
// level I set".
func thinkingEffortNote(thinking bool) string {
	if thinking {
		return ""
	}
	return i18n.T("thinking.effort_off_note")
}

// appendModelList is the `/model` fallback for a runtime that sent no catalogue.
//
// A picker with zero options reads as a broken interface, so this route exists; it
// says what it does know rather than the single current name, because "which models
// can I choose" is the question the command was typed to answer.
func (m *model) appendModelList() {
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("model.current", "name", m.panel.model), role: "notice"},
	}}, "notice", "")
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("model.no_catalog"), role: "warn"},
	}}, "notice", "")
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("model.howto"), role: "rule"},
	}}, "notice", "")
}

// appendEffortList is the `/effort` fallback: the current level, then how to change it.
func (m *model) appendEffortList() {
	text := i18n.T("effort.current", "effort", m.panel.effort)
	if !m.panel.thinking {
		text += i18n.T("effort.off_note")
	}
	m.appendLine(renderLine{segments: []seg{{text: text, role: "notice"}}}, "notice", "")
	if len(m.effortLevels) == 0 {
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("effort.no_catalog"), role: "warn"},
		}}, "notice", "")
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("effort.howto_bare"), role: "rule"},
		}}, "notice", "")
		return
	}
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("effort.howto", "levels", strings.Join(m.effortLevels, " / ")), role: "rule"},
	}}, "notice", "")
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

// echoTheme says out loud that the palette changed, and that it changed nothing
// outside this run.
//
// A switch that only changes colours gives no evidence it did anything — the
// whole screen shifts, which the eye reads as "something happened" but not as
// "which one did I land on". The name is the answer to that, and "this run only"
// is the answer to "did I just write that to my config".
func (m *model) echoTheme(key themeKey) tea.Cmd {
	value := themes[key]
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("theme.switched"), role: "rule"},
		{text: string(key) + " " + value.name, role: "turn_start"},
		{text: i18n.T("theme.only_this_run"), role: "rule"},
	}}, "notice", "")
	return nil
}

// ── overlays ──────────────────────────────────────────────────────────────────

func (m *model) openCommandPalette() tea.Cmd {
	m.overlay = overlay{kind: overlayCommand}
	return nil
}

// pickerStart says where a picker's cursor lands when it opens.
type pickerStart int

const (
	// pickerStartCurrent: on the value in effect. Right for a list whose point is
	// "what am I on" (theme, effort) — Enter there is a harmless no-op.
	pickerStartCurrent pickerStart = iota
	// pickerStartNext: on the entry after it. Right for `/model`, which is opened
	// in order to change something; landing on the current row makes Enter a
	// no-op that reads as a hang.
	pickerStartNext
)

func (m *model) openOptionPicker(title string, options []option, start pickerStart) tea.Cmd {
	cursor := 0
	current := -1
	for index, opt := range options {
		if opt.current {
			current = index
		}
	}
	if current >= 0 {
		cursor = current
		if start == pickerStartNext && len(options) > 1 {
			cursor = (current + 1) % len(options)
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
		if preview == "" {
			// A session nobody has spoken in shows a placeholder rather than a
			// blank: an empty row reads as a rendering fault.
			preview = i18n.T("session.row.untitled")
		}
		messages, steps := intOf(row["messages"]), intOf(row["steps"])
		line := fmt.Sprintf("%-22s %s · %s   %s", id,
			i18n.Tn("status.session.messages", messages, "n", messages),
			i18n.Tn("status.session.steps", steps, "n", steps),
			clipText(preview, 40))
		// The runtime sends `todos` as the **pre-rendered progress line**, e.g.
		// `2/5 done, current: write the tests` — not a count. Reading it as an int
		// yields zero for every session, so the suffix silently never appeared and
		// "which session still has work in it" was unanswerable. That is the stated
		// reason the field is on this row at all.
		if todos, _ := row["todos"].(string); todos != "" {
			line += i18n.T("session.row.todos", "todos", todos)
		}
		options = append(options, option{value: id, row: line})
	}
	m.sessionOptions = options
	m.overlay = overlay{kind: overlaySessions, title: i18n.T("session_dialog.head"), options: options}
}

// handleOverlayKey routes keys while a panel is up.
//
// The command palette is the exception to "the overlay owns the keyboard": its
// filter **is** the input line, so typing goes to the editor and the palette
// re-filters from it. That is what lets `/resume 2026` narrow the list and carry
// the argument in one gesture — with a private filter buffer the space key had
// nowhere to go and the argument could never be typed at all.
func (m model) handleOverlayKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.overlay.kind == overlayCommand {
		switch key.Type {
		case tea.KeyCtrlB:
			// Bound at the window level in the original, so it works with a panel
			// open. Requiring Esc first is a key that looks broken.
			m.toggleRail()
			return m, nil
		case tea.KeyEsc:
			// Esc leaves the palette and clears the line: the line exists to hold
			// the command, and half a command with no list is not useful.
			m.overlay = overlay{}
			m.input = ""
			m.inputCursor = 0
			return m, nil
		case tea.KeyCtrlC:
			return m, tea.Quit
		case tea.KeyUp:
			m.moveCursor(-1)
			return m, nil
		case tea.KeyDown:
			m.moveCursor(1)
			return m, nil
		case tea.KeyEnter:
			return m.commitOverlay()
		}
		// Everything else is editing, and the palette follows the line.
		//
		// This goes to `handleEditorKey`, **not** to `handleKey`: `handleKey`
		// dispatches on the overlay being open, and the palette is the overlay, so
		// that path is an infinite loop.
		next, cmd := m.handleEditorKey(key)
		after := next.(model)
		after.overlay.cursor = 0
		return after, cmd
	}
	switch key.Type {
	case tea.KeyCtrlB:
		// The rail toggle belongs to the window, not to whichever panel happens to
		// be open: requiring Esc first makes the key look broken.
		m.toggleRail()
		return m, nil

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

	case tea.KeyEnter, tea.KeySpace:
		// Space toggles as well as Enter: the original's server panel takes
		// either, and a switch that ignores the key everybody tries second reads
		// as unresponsive.
		return m.commitOverlay()

	case tea.KeyRunes:
		// A picker honours the number keys: pressing the row number is picking
		// that row, which is faster than walking down a long list.
		if index, ok := parseNumber(string(key.Runes)); ok {
			if m.overlay.kind == overlayOptions || m.overlay.kind == overlaySessions ||
				m.overlay.kind == overlayMCP || m.overlay.kind == overlaySkills {
				if index >= 1 && index <= m.overlayCount() {
					m.overlay.cursor = index - 1
					return m.commitOverlay()
				}
			}
		}
		if string(key.Runes) == "q" {
			m.overlay = overlay{}
			return m, nil
		}
		return m, nil
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
	case overlaySkills:
		return len(m.skillRows)
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
			// Nothing matched, so there is no row to run — but Enter still has to do
			// **something**. The typed line is a command as far as the user is
			// concerned, so it goes through the normal dispatch, which answers
			// "no such command" and lists them. Swallowing the key leaves the line
			// sitting there with no feedback at all.
			typed := strings.TrimSpace(m.input)
			m.overlay = overlay{}
			if typed == "" {
				m.input = ""
				m.inputCursor = 0
				return m, nil
			}
			m.input = ""
			m.inputCursor = 0
			return m.runCommand(typed)
		}
		picked := rows[m.overlay.cursor]
		// The argument comes from the line the user typed, not from the panel: the
		// panel is a list of candidates and must not invent parameters.
		argument := m.paletteArgument()
		m.overlay = overlay{}
		m.input = ""
		m.inputCursor = 0
		if argument != "" {
			return m.runCommand(picked.name + " " + argument)
		}
		return m.runCommand(picked.name)

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
				m.overlay = overlay{}
				return m, m.echoTheme(key)
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
		// A failed server re-presses as load, which is the retry.
		action := "load"
		if row.state == "loaded" {
			action = "unload"
		}
		m.overlay.waiting = i18n.T("mcp_dialog.pending", "name", row.name)
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

	case overlaySkills:
		// The list is a lookup: closing on the first key is the only action that
		// makes sense, and leaving it up after Enter would look like a selection.
		m.overlay = overlay{}
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
	// The waiting note is cleared only when the runtime's answer arrives; a
	// snapshot alone does not settle the panel.
}

// settleOverlay writes the runtime's verdict onto a panel that asked for one.
//
// Only the model and effort notices settle the picker: other notices (the
// startup lines, a warning about something else entirely) arrive while a panel
// happens to be open, and letting those close it would be "pushed aside while
// choosing". The sentence is reproduced verbatim because it carries facts this
// program cannot reconstruct — which route lacked a key, which value is still
// pending — and the panel stays up so it can be read before Esc.
func (m *model) settleOverlay(code, text string) {
	switch code {
	case "model", "effort":
		if m.overlay.kind == overlayOptions {
			m.overlay.waiting = text
		}
	case "mcp":
		if m.overlay.kind == overlayMCP {
			m.overlay.waiting = ""
		}
	}
}

// modelOptions is the `/model` catalogue.
//
// The initial cursor is the **next entry after the current one**: the panel is
// opened to change something, and the row it lands on should not be the row
// already in effect — Enter on that row is a no-op that looks like a hang.
func (m model) modelOptions() []option {
	options := make([]option, 0, len(m.modelCatalog)+len(m.modelAliases))
	for _, item := range m.modelCatalog {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["id"].(string)
		provider, _ := row["provider"].(string)
		name := id
		if provider != "" {
			name = provider + "/" + id
		}

		// The row carries what the model is **for**, not just its name. Two routes
		// can serve the same id, and the only thing that tells them apart is the
		// route in front of it; the summary and the label are what the catalogue
		// author wrote to say which one this is.
		summary, _ := row["summary"].(string)
		label, _ := row["label"].(string)
		rowText := name
		if summary != "" {
			rowText += "  " + summary
		}

		// The note is assembled in reading order — label, then window — and the
		// "(current)" marker is not part of it: that is `current`, drawn as the dot
		// on the row. Prefixing the note with it is what used to make the dot
		// disappear on every row that had a window or a label to show.
		note := ""
		if window, ok := row["window"]; ok && window != nil {
			note = windowText(window)
		}
		if label != "" && label != id {
			note = strings.TrimSpace(label + "  " + note)
		}
		options = append(options, option{
			value: name, row: rowText, note: note, current: name == m.panel.model,
		})
	}
	// Retired names go in their own list after the live ones, and **cannot be
	// chosen**: they are recognised, not selectable (the endpoint retired the model
	// and a newer one serves the requests). Putting them in the main list would
	// offer two rows with the same effect and no way to tell which is which.
	for _, item := range m.modelAliases {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["id"].(string)
		of, _ := row["of"].(string)
		if id == "" {
			continue
		}
		options = append(options, option{
			row:  i18n.T("model.aliases", "old", id, "new", of),
			note: i18n.T("picker.alias"),
		})
	}
	return options
}

func (m model) effortOptions() []option {
	options := make([]option, 0, len(m.effortLevels))
	for _, level := range m.effortLevels {
		options = append(options, option{
			value: level, row: level, current: level == m.panel.effort,
		})
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

	// `t` exists only when the runtime offered something to remember. A key that
	// silently allows everything is exactly what the runtime refuses to offer, so
	// this must follow the request rather than its own idea of what is safe.
	rememberHint, _ := protocol.String(request, "remember_hint")
	hasRemember := rememberHint != ""
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
// The cursor is a real selection: `↑↓` move it, a digit takes that row, and Enter
// takes the highlighted one. Enter is the easiest key in the interface, so it
// must never mean "skip" — that would turn a keystroke nobody thought about into
// an answer nobody gave. Skipping is Esc, which is also what the panel says.
//
// A typed line still wins over the highlight, because a question may have no
// options at all and the runtime accepts a free-text answer.
func (m model) handleQuestionKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	request := m.pendingQuestion
	id, _ := protocol.String(request, "id")
	options, _ := request["options"].([]any)

	finish := func(status, text string) (tea.Model, tea.Cmd) {
		m.pendingQuestion = nil
		m.questionInput = ""
		m.questionCursor = 0
		m.client.AnswerQuestion(id, status, text)
		return m, nil
	}
	choose := func(index int) (tea.Model, tea.Cmd) {
		if index < 0 || index >= len(options) {
			return m, nil
		}
		text, _ := options[index].(string)
		return finish(protocol.QuestionAnswered, text)
	}

	switch key.Type {
	case tea.KeyEsc, tea.KeyCtrlC:
		return finish(protocol.QuestionSkipped, "")
	case tea.KeyUp:
		if m.questionCursor > 0 {
			m.questionCursor--
		}
		return m, nil
	case tea.KeyDown:
		if m.questionCursor < len(options)-1 {
			m.questionCursor++
		}
		return m, nil
	case tea.KeyBackspace:
		if m.questionInput != "" {
			runes := []rune(m.questionInput)
			m.questionInput = string(runes[:len(runes)-1])
		}
		return m, nil
	case tea.KeyEnter:
		if text := strings.TrimSpace(m.questionInput); text != "" {
			return finish(protocol.QuestionAnswered, text)
		}
		if len(options) == 0 {
			// Nothing to choose and nothing typed: the only honest answer is to
			// send it back unanswered rather than invent one.
			return finish(protocol.QuestionSkipped, "")
		}
		return choose(m.questionIndex())
	case tea.KeyRunes:
		if index, ok := parseNumber(string(key.Runes)); ok && len(options) > 0 {
			return choose(index - 1)
		}
		m.questionInput += string(key.Runes)
		return m, nil
	case tea.KeySpace:
		m.questionInput += " "
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
