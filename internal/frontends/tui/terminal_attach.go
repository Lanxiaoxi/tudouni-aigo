package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// Attaching: the one state where this interface stops being an interface.
//
// Everything else here answers a keystroke by doing something to the screen — the
// input line grows, a panel moves, a command runs. Attached, a keystroke is
// **bytes on their way to a process**, and the two rules that follow from that are
// what this file implements:
//
//   - **nothing is interpreted here.** `Ctrl+C` means whatever the shell says it
//     means (usually "interrupt the running command", *not* "quit this program"),
//     arrows are escape sequences rather than cursor movement in the input line,
//     and `q` is the letter q rather than "close this panel". A front end that
//     kept its own bindings while attached would make the shell unusable for
//     exactly the programs a terminal exists to run.
//   - **the layout does not change.** Under a full-screen program the bytes
//     include cursor movements this interface does not emulate, so the output is
//     drawn as text with its escape sequences removed (see `terminalOutputLine`).
//     Emulating them properly would mean a screen buffer and a cursor — a project
//     rather than a panel — and the design puts that work on the client's side of
//     the boundary. Saying so in the banner is the honest version.

// detachKey is how the keyboard comes back. It is `Ctrl+\` because that is the
// sequence every terminal multiplexer uses to leave a session, and because it is
// one of the few chords a shell does not want for itself: `Ctrl+C`, `Ctrl+D`,
// `Ctrl+Z` and `Ctrl+A` all mean something inside a shell, and detaching on one of
// them would make the shell's own job control unreachable.
const detachKey = tea.KeyCtrlBackslash

// attachTerminal points the input line at one shell.
//
// A terminal that has already ended can be attached to as well, and it shows the
// output that arrived before it stopped. Refusing would make the last screenful of
// a finished command unreachable, which is the thing somebody most often wants
// back.
func (m *model) attachTerminal(row terminalRow) {
	m.attached = terminalAttach{
		id:     row.id,
		shell:  row.shell,
		status: row.status,
		// The **scratch buffer is dropped, not carried over**: it is what has
		// arrived since this terminal was attached, and keeping another
		// terminal's tail under a new header would attribute one shell's output
		// to another.
		scrollback: nil,
	}
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("terminal.attach_head",
			"id", row.id, "shell", row.shell, "status", m.attachedStatusText()), role: "turn_start"},
	}}, "notice", "")
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("terminal.attach_hint"), role: "rule"},
	}}, "notice", "")
	m.autoResize()
}

// detach gives the keyboard back to the input line. **The shell keeps running** —
// it belongs to the workspace, not to this view, and leaving one is not ending it.
// `terminal_kill` is the message that ends one, and it is a different key.
func (m *model) detach() {
	if m.attached.id == "" {
		return
	}
	id := m.attached.id
	m.attached = terminalAttach{}
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("terminal.detached", "id", id), role: "notice"},
	}}, "notice", "")
}

// attachedStatusText is the attached terminal's status as its banner reads it.
//
// It goes through the same function the panel does, so a terminal cannot be
// "running" in the banner and "exited" three rows above it in the list.
func (m model) attachedStatusText() string {
	text, _ := terminalStatusText(terminalRow{
		id: m.attached.id, status: m.attached.status,
	})
	return text
}

// autoResize tells the runtime how wide this interface is now.
//
// The size sent is the **transcript's** width, not the whole terminal's: an
// attached shell draws into the body, and a shell told it has 200 columns while it
// is displayed in 140 would lay a table out past the right edge of the pane it
// lives in. Same reasoning for the height.
//
// It is sent on attach and on every window change, and sending it when nothing
// changed is harmless — the runtime applies the size it already has. Not sending
// it is the failure that matters: without a resize, `vim` and `top` draw at 80
// columns for ever, and the symptom looks like a rendering bug in this program.
func (m *model) autoResize() {
	if m.attached.id == "" || m.client == nil {
		return
	}
	cols, rows := m.attachSize()
	m.client.TerminalResize(m.attached.id, cols, rows)
}

// attachSize is the pane an attached shell draws into.
func (m model) attachSize() (int, int) {
	cols := m.width
	if cols < 20 {
		cols = 20
	}
	rows := m.bodyHeight()
	if rows < 3 {
		rows = 3
	}
	return cols, rows
}

// handleAttachedKey forwards one keystroke to the shell.
//
// The order of the two branches is the whole design: the detach chord is checked
// **first and alone**, and every other key — including `Ctrl+C`, `Esc` and the
// arrow keys — is encoded and sent. Routing a key through this interface's own
// handlers while attached is how `Ctrl+C` ends up quitting the program instead of
// interrupting the command the person was trying to stop.
func (m model) handleAttachedKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if key.Type == detachKey {
		m.detach()
		return m, nil
	}
	data := encodeKey(key)
	if data == "" {
		return m, nil
	}
	m.client.TerminalInput(m.attached.id, data)
	return m, nil
}

// encodeKey turns one keystroke into the bytes a terminal sends for it.
//
// The two halves are the two halves of the keyboard. A key with runes is a
// **character** and goes out as UTF-8, with the ESC prefix Alt adds (that prefix
// is not a convention of this program: it is what `Alt+key` means on a real
// terminal, and every readline-style editor understands it). A key without runes
// is a **control code or an escape sequence**, and the control codes are the ones
// that carry their own byte value — `Ctrl+C` is 0x03 because that is ETX, not
// because anything maps it.
func encodeKey(key tea.KeyMsg) string {
	if len(key.Runes) > 0 {
		text := string(key.Runes)
		if key.Alt {
			return "\x1b" + text
		}
		return text
	}
	// The C0 range is the byte itself. This covers Ctrl+A..Ctrl+Z, Ctrl+\,
	// Ctrl+], Ctrl+^ and Ctrl+_ — which is every control key a shell reads, and
	// covers them **without a table**: a table is a list that drifts, and this is
	// the definition.
	if code := int(key.Type); code >= 0 && code < 0x20 {
		return string(rune(code))
	}
	switch key.Type {
	case tea.KeyEnter:
		// A carriage return, which is what a terminal's Enter sends. `\n` would
		// work for most shells and would break the one case that matters on
		// Windows, where the console translates CR and not LF.
		return "\r"
	case tea.KeyBackspace:
		// DEL, not BS (0x08). A real terminal's Backspace sends DEL, and a shell's
		// line editor reads it as "delete the character before the cursor"; sending
		// BS makes readline interpret it as `Ctrl+H`, whose binding is the same on
		// some editors and not on others.
		return "\x7f"
	case tea.KeyTab:
		return "\t"
	case tea.KeySpace:
		return " "
	case tea.KeyEsc:
		return "\x1b"
	case tea.KeyUp:
		return "\x1b[A"
	case tea.KeyDown:
		return "\x1b[B"
	case tea.KeyRight:
		return "\x1b[C"
	case tea.KeyLeft:
		return "\x1b[D"
	case tea.KeyHome:
		return "\x1b[H"
	case tea.KeyEnd:
		return "\x1b[F"
	case tea.KeyPgUp:
		return "\x1b[5~"
	case tea.KeyPgDown:
		return "\x1b[6~"
	case tea.KeyDelete:
		return "\x1b[3~"
	case tea.KeyShiftTab:
		return "\x1b[Z"
	case tea.KeyF1:
		return "\x1bOP"
	case tea.KeyF2:
		return "\x1bOQ"
	case tea.KeyF3:
		return "\x1bOR"
	case tea.KeyF4:
		return "\x1bOS"
	case tea.KeyF5:
		return "\x1b[15~"
	case tea.KeyF6:
		return "\x1b[17~"
	case tea.KeyF7:
		return "\x1b[18~"
	case tea.KeyF8:
		return "\x1b[19~"
	case tea.KeyF9:
		return "\x1b[20~"
	case tea.KeyF10:
		return "\x1b[21~"
	case tea.KeyF11:
		return "\x1b[23~"
	case tea.KeyF12:
		return "\x1b[24~"
	}
	// Anything else — a key this build has never heard of — sends nothing rather
	// than a guess. Sending a wrong byte to a shell is a command that ran with a
	// character nobody typed.
	return ""
}

// terminalOutputLine turns one output batch into transcript lines.
//
// **Escape sequences are removed**, with two exceptions that are cheap and worth
// keeping. The reason for removing them is not tidiness: a program's output
// routinely contains cursor movements (`\x1b[2J`, `\x1b[H`, `\x1b[K`), and drawing
// those literally would clear or scramble the screen this interface is drawing on.
// A real terminal emulator interprets them into a screen buffer; this interface has
// no buffer, so the honest thing is to show the text and say the rest was dropped.
//
// `\r` is handled rather than stripped: a progress line rewrites itself with
// carriage returns, and the last rewrite is the part that matters. Splitting on it
// keeps the final state instead of every intermediate one.
func terminalOutputLine(data string) []string {
	// `ansi.Strip` is the program's own ANSI-aware stripper (already used for
	// measuring panel rows), so this cannot drift from how the rest of the
	// interface decides what a string's visible text is.
	cleaned := ansi.Strip(data)
	// Carriage returns separate the rewrites of one line; the last one is what a
	// terminal would be showing.
	if index := strings.LastIndex(cleaned, "\r"); index >= 0 {
		cleaned = cleaned[index+1:]
	}
	cleaned = strings.ReplaceAll(cleaned, "\r", "")
	return strings.Split(cleaned, "\n")
}

// rowOfTerminal finds a terminal in the runtime's list.
func (m model) rowOfTerminal(id string) (terminalRow, bool) {
	for _, row := range m.terminalPanelRows() {
		if row.id == id {
			return row, true
		}
	}
	return terminalRow{}, false
}

// fitPanelRow truncates one panel row so that it — together with the one-cell
// selection marker it may gain — stays inside the frame.
//
// **This is not cosmetic, and the failure is specific.** A row handed to the frame
// one cell too wide is reflowed *early*: lipgloss's wrapper does not agree with this
// program's `wrapCells` about ANSI escapes, so a styled row wraps sooner than it
// measures, and the consequence is that **the selected row occupies two lines while
// the rows around it occupy one**. The panel's height then depends on where the
// cursor is, which is visibly a different frame for every arrow-key press — the
// reported bug this interface has already paid for once (see `renderMCPPanel`).
//
// The marker is why the budget is `inner - 1` rather than `inner`: `selectedRow`
// prepends `▌` before the frame sees the row, so a row that exactly fills the pane
// on its own becomes one cell too wide the moment it is selected.
//
// Truncation rather than wrapping, for the reason the MCP panel states: `wrapCells`
// breaks at the last space, which leaves the tail of a long name alone on a second
// line — exactly the shape that reflows.
func fitPanelRow(line string, inner int) string {
	if inner <= 1 {
		return line
	}
	return ansi.Truncate(line, inner-1, "…")
}

// renderTerminalView draws the attached shell's output and its banner.
//
// The banner is the load-bearing part. Attached is the one state where this
// interface's appearance does not match its behaviour: the input line is gone and
// every keystroke is going to a process, and a person who did not know that would
// type a message to the model and watch it run as a shell command. So the head says
// which terminal, which shell, and how to get the keyboard back.
//
// Output is drawn **newest last**, windowed to the rows available, and the ellipsis
// row at the top is what says that earlier output scrolled out of this buffer —
// a tail presented without that marker reads as the whole session.
func (m model) renderTerminalView(available int) string {
	if available < 1 {
		return ""
	}
	var rows []string
	head := m.terminalAttachHead()
	if head != "" {
		rows = append(rows, wrapCells(head, maxInt(m.width-2, 16))...)
		rows = append(rows, "")
	}
	body := "answer"
	if m.attached.status != protocol.TerminalRunning {
		// A finished terminal's last screenful is dimmed: it is a record rather
		// than something that will keep producing, and painting it in the live ink
		// makes a dead shell look busy.
		body = "rule"
	}
	lines := m.attached.scrollback
	// The banner costs rows, so the window is measured after it.
	budget := available - len(rows)
	if budget < 1 {
		budget = 1
	}
	start := 0
	if len(lines) > budget {
		start = len(lines) - budget
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("terminal.scrollback_cut")))
		budget--
		if budget < 1 {
			budget = 1
		}
		if len(lines) > budget {
			start = len(lines) - budget
		}
	}
	for _, line := range lines[start:] {
		rows = append(rows, currentTheme.styleFor(body).Render(line))
	}
	if len(lines) == 0 && m.attached.status == protocol.TerminalRunning {
		// Nothing yet. Saying so beats an empty pane, which is indistinguishable
		// from an interface that has stopped drawing.
		rows = append(rows, currentTheme.styleFor("rule").Render(i18n.T("terminal.attach_hint")))
	}
	return strings.Join(rows, "\n")
}

// firstWord is the leading word of a command's arguments, lowercased.
//
// It exists so `/terminal` can be typed four ways without this file spelling
// `strings.ToLower(arguments[0])` four times — and, more importantly, so the
// empty case is one branch rather than four that each have to remember it.
func firstWord(arguments []string) string {
	if len(arguments) == 0 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(arguments[0]))
}

// terminalByIndex resolves what a person types after `/terminal`.
//
// **Two spellings, and both are needed.** `term-01` is the id the runtime minted
// and is what a script would use; `1` is what somebody looking at a list of three
// terminals types. The index is 1-based because the panel numbers its rows that
// way, and a command whose number does not match the number on screen is a command
// that attaches to the wrong shell.
//
// A bare id that matches nothing answers nil rather than a guess: attaching to
// "the first one" when the id was misremembered would hand the keyboard to a shell
// the person was not looking at.
func (m model) terminalByIndex(value string) *terminalRow {
	rows := m.terminalPanelRows()
	if index, ok := parseNumber(value); ok {
		if index >= 1 && index <= len(rows) {
			return &rows[index-1]
		}
		return nil
	}
	for index := range rows {
		if rows[index].id == value {
			return &rows[index]
		}
	}
	return nil
}

// terminalExitLine is the one line a terminal's ending leaves in the transcript.
//
// It is written from the **event** and never from the request, which is the
// design's rule that the runtime is the only source of truth: a person who pressed
// `k` and a process that refused to die must not read the same.
func (m *model) terminalExitLine(payload map[string]any) {
	id, _ := protocol.String(payload, "terminal_id")
	if id == "" {
		return
	}
	reason, _ := protocol.String(payload, "reason")
	row := terminalRow{id: id, status: protocol.TerminalExited}
	if terminal, ok := payload["terminal"].(map[string]any); ok {
		row.status, _ = protocol.String(terminal, "status")
		row.exitCode = terminal["exit_code"]
	}
	status, role := terminalStatusText(row)
	if reason == protocol.TerminalExitReasonKilled {
		role = "warn"
	}
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.T("terminal.ended", "id", id, "status", status), role: role},
	}}, "notice", "")

	// The attached view follows the runtime's status rather than its own guess:
	// when the shell this interface is typing into ends, the banner has to say so,
	// and the keyboard goes back to the input line — continuing to swallow every
	// keystroke for a process that is gone would make the whole interface look
	// dead.
	if m.attached.id == id {
		m.attached.status = row.status
		m.attached.exitCode = row.exitCode
		m.detach()
	}
}
