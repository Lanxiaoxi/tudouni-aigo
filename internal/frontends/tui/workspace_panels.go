package tui

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// The workspace's two panels: Files and Terminal.
//
// Both are the same shape as the skills panel — a lookup that is opened, read
// and dismissed — with one difference each, and the difference is the whole
// reason they are separate panels rather than a generic list:
//
//   - **Files walks.** Enter on a directory replaces the list instead of closing
//     the panel, because browsing is a sequence of steps and a panel that closed
//     on every one would cost a `/files` per directory.
//   - **Terminal attaches.** Choosing a terminal hands the keyboard to a shell,
//     which is the only state in this interface where a keystroke is not a
//     command. See `terminalAttach`.

// fileRow is one line of the browser.
type fileRow struct {
	name  string
	path  string
	isDir bool
	size  int64
}

// filePanelRows reads the listing the runtime answered with.
//
// The rows are built here rather than in `renderFilesPanel` because the key
// handler needs the same list — it maps the cursor to a path to open — and two
// walks of one slice is how a cursor ends up pointing at a different row than the
// one drawn under it.
func (m model) filePanelRows() []fileRow {
	rows := make([]fileRow, 0, len(m.files.entries))
	for _, item := range m.files.entries {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := protocol.String(entry, "name")
		path, _ := protocol.String(entry, "path")
		kind, _ := protocol.String(entry, "type")
		if name == "" {
			continue
		}
		rows = append(rows, fileRow{
			name:  name,
			path:  path,
			isDir: kind == protocol.FileTypeDirectory,
			size:  int64(intOf(entry["size"])),
		})
	}
	return rows
}

// renderFilesPanel draws the browser.
//
// The head carries the **path the runtime echoed back**, not the one that was
// typed. They agree after normalisation, and showing the resolved one is what
// makes "where am I" answerable after a `/files ./src/../src`.
func (m model) renderFilesPanel(width, height int) string {
	rows := m.filePanelRows()
	first, last := windowRows(len(rows), m.overlay.cursor, overlayListRows(height))
	inner := overlayInner(width)
	var body []string

	switch {
	case m.files.opened != nil:
		body = append(body, m.fileViewRows(inner)...)
	case m.files.loading:
		body = append(body, wrapCells(currentTheme.styleFor("rule").
			Render(i18n.T("files.loading", "path", m.filesLabel())), inner)...)
	case len(rows) == 0:
		body = append(body, wrapCells(currentTheme.styleFor("rule").
			Render(i18n.T("files.empty")), inner)...)
	}

	nameWidth := 0
	for _, row := range rows {
		if len([]rune(row.name)) > nameWidth {
			nameWidth = len([]rune(row.name))
		}
	}
	for index := first; index < last; index++ {
		row := rows[index]
		// A directory gets a trailing slash and the accent: it is the thing you
		// can open, and the one glyph is what says so at a glance.
		name, role := row.name, "rule"
		if row.isDir {
			name, role = row.name+i18n.T("files.dir_marker"), "tool"
		}
		line := currentTheme.styleFor(role).Render(fmt.Sprintf("%-*s", nameWidth+1, name))
		if !row.isDir {
			line += currentTheme.styleFor("rule").Render("   " + byteSize(row.size))
		}
		line = fitPanelRow(line, inner)
		if index == m.overlay.cursor {
			body = append(body, highlightRows(line, inner,
				func(text string) string { return selectedRow(text, inner) })...)
		} else {
			body = append(body, wrapCells(line, inner)...)
		}
	}
	if last < len(rows) {
		body = append(body, wrapCells(currentTheme.styleFor("rule").
			Render(i18n.T("files.too_many", "n", len(rows)-last, "shown", last)), inner)...)
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").
		Render(i18n.T("files.footer")), inner)...)

	return overlayFrame(width, i18n.T("files.title")+"  "+m.filesLabel(), "", panelBody(body, inner))
}

// fileViewRows draws an opened file.
//
// The content is **the runtime's preview**, drawn as plain text rather than as
// markdown: this is a file viewer, not a chat, and rendering a `.go` file through
// the answer pipeline would reformat it. The cut is stated in words when it
// happened, because a viewer that silently showed the first 200k characters of a
// 2MB file would be a viewer that lies about what is in the file.
func (m model) fileViewRows(inner int) []string {
	opened := m.files.opened
	path, _ := protocol.String(opened, "path")
	content, _ := protocol.String(opened, "content")
	lines := intOf(opened["total_lines"])
	chars := intOf(opened["chars"])
	truncated, _ := opened["truncated"].(bool)
	artifactID, _ := protocol.String(opened, "artifact_id")

	var rows []string
	rows = append(rows, wrapCells(currentTheme.styleFor("tool").
		Render(i18n.T("files.read_head",
			"path", path, "lines", lines, "chars", chars)), inner)...)
	if truncated {
		rows = append(rows, wrapCells(currentTheme.styleFor("warn").
			Render(i18n.T("files.read_cut", "chars", chars, "id", artifactID)), inner)...)
	}
	rows = append(rows, "")
	// Only as many lines as the panel's budget allows: `overlayFrame` will not
	// truncate, so a body that ran past the bottom would push the frame's own top
	// rows off the screen instead of scrolling.
	budget := overlayListRows(m.bodyHeight()) - len(rows)
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if budget <= 0 {
			break
		}
		rows = append(rows, wrapCells(currentTheme.styleFor("answer").Render(line), inner)...)
		budget--
	}
	return rows
}

// filesLabel is the browser's current position as a person reads it.
func (m model) filesLabel() string {
	if m.files.path == "" {
		return i18n.T("files.root")
	}
	return m.files.path
}

// terminalRow is one line of the terminal panel.
type terminalRow struct {
	id       string
	cwd      string
	shell    string
	status   string
	exitCode any
}

// terminalPanelRows reads the runtime's terminal list.
//
// The rows come straight from the snapshot: a status is never inferred here. The
// runtime is the only end that can see the process, and a front end that decided
// "it is probably still running" would be a second answer to a question that has
// exactly one.
func (m model) terminalPanelRows() []terminalRow {
	rows := make([]terminalRow, 0, len(m.panel.terminals))
	for _, item := range m.panel.terminals {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := protocol.String(entry, "id")
		if id == "" {
			continue
		}
		cwd, _ := protocol.String(entry, "cwd")
		shell, _ := protocol.String(entry, "shell")
		status, _ := protocol.String(entry, "status")
		rows = append(rows, terminalRow{
			id: id, cwd: cwd, shell: shell, status: status, exitCode: entry["exit_code"],
		})
	}
	return rows
}

// terminalStatusText is one terminal's state as a person reads it.
//
// The three cases are distinct on purpose, and the third is why this is a
// function rather than a lookup: `exited` with a code, `exited` with no code, and
// `killed` are three different things that a single word would flatten. A killed
// shell did not choose an exit status, so printing one would be an invented
// number; a shell killed by a signal on POSIX is exactly that case.
func terminalStatusText(row terminalRow) (string, string) {
	switch row.status {
	case protocol.TerminalKilled:
		return i18n.T("terminal.killed"), "warn"
	case protocol.TerminalExited:
		if code, ok := row.exitCode.(float64); ok {
			return i18n.T("terminal.exited", "code", int(code)), "rule"
		}
		if code, ok := row.exitCode.(int); ok {
			return i18n.T("terminal.exited", "code", code), "rule"
		}
		return i18n.T("terminal.exited_unknown"), "rule"
	default:
		return i18n.T("terminal.running"), "result"
	}
}

// renderTerminalPanel lists the workspace's shells.
func (m model) renderTerminalPanel(width, height int) string {
	rows := m.terminalPanelRows()
	first, last := windowRows(len(rows), m.overlay.cursor, overlayListRows(height))
	inner := overlayInner(width)
	var body []string
	if len(rows) == 0 {
		body = append(body, wrapCells(currentTheme.styleFor("rule").
			Render(i18n.T("terminal.empty")), inner)...)
	}

	idWidth := 0
	for _, row := range rows {
		if len(row.id) > idWidth {
			idWidth = len(row.id)
		}
	}
	for index := first; index < last; index++ {
		row := rows[index]
		status, role := terminalStatusText(row)
		mark := "  "
		if row.id == m.attached.id {
			// Which one the keyboard is pointed at. Without it, attaching to a
			// terminal and reopening the panel gives no way to tell which shell
			// the next keystroke lands in.
			mark = "▌ "
		}
		line := currentTheme.styleFor("tool").Render(mark+fmt.Sprintf("%-*s", idWidth, row.id)) +
			currentTheme.styleFor(role).Render("  "+status)
		if row.cwd != "" {
			line += currentTheme.styleFor("rule").Render("  " + row.cwd)
		}
		if row.shell != "" {
			line += currentTheme.styleFor("rule").Render("  (" + row.shell + ")")
		}
		line = fitPanelRow(line, inner)
		if index == m.overlay.cursor {
			body = append(body, highlightRows(line, inner,
				func(text string) string { return selectedRow(text, inner) })...)
		} else {
			body = append(body, wrapCells(line, inner)...)
		}
	}
	body = append(body, wrapCells(currentTheme.styleFor("rule").
		Render(i18n.T("terminal.footer")), inner)...)
	return overlayFrame(width, i18n.T("terminal.title"), "", panelBody(body, inner))
}

// terminalAttachHead is the banner drawn above the transcript while the keyboard
// belongs to a shell.
//
// It exists because the attached state is the one place this interface behaves
// differently from what it looks like: the input line is still on screen and still
// says "type here", but the keys are going to a process. A person who did not know
// that would type a message to the model and watch it run as a shell command.
func (m model) terminalAttachHead() string {
	if m.attached.id == "" {
		return ""
	}
	status, _ := terminalStatusText(terminalRow{id: m.attached.id, status: m.attached.status})
	return currentTheme.styleFor("waiting").Render(i18n.T("terminal.attach_head",
		"id", m.attached.id, "shell", m.attached.shell, "status", status))
}

// appendTerminalOutput records one output batch on the attach buffer.
//
// **The bytes are already a string** by the time they get here — the runtime
// splits batches on rune boundaries (see `terminal.splitRunes`), so no decoding
// happens on this side and a multi-byte character cannot be cut in half here.
//
// What is stored is the *text*, with the escape sequences kept: the runtime strips
// nothing, and this interface draws the terminal's raw bytes. Trying to render
// them faithfully would mean writing a terminal emulator — a screen grid, cursor
// movement, scroll regions — which is a project rather than a panel, and the
// design puts that work on the client's side of the boundary (the desktop uses a
// real emulator; this one keeps the tail).
func (m *model) appendTerminalOutput(id, data string) {
	if id != m.attached.id {
		// Output from a terminal this interface is not attached to. It is counted
		// so `/terminal` can say how much arrived, and dropped otherwise: keeping
		// every terminal's stream in memory is N buffers for one screen.
		m.attached.pendingBytes += len(data)
		return
	}
	m.attached.pendingBytes += len(data)
	m.attached.scrollback = appendScrollback(m.attached.scrollback, data)
}

// scrollbackLimit bounds how much output this interface keeps per terminal.
//
// A build log is megabytes, and this program is drawing: holding all of it would
// mean the interface's memory grows with the length of a command somebody ran,
// which is not a thing a UI should do. 4000 lines is about fifty screens.
const scrollbackLimit = 4000

// appendScrollback adds a batch to the tail and trims from the front.
//
// Splitting on newlines is what makes the trim a *line* bound rather than a byte
// bound — so what gets dropped is old output rather than half of a line somebody
// is reading.
func appendScrollback(existing []string, data string) []string {
	text := strings.ReplaceAll(data, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(existing) > 0 {
		// The batch boundary is not a line boundary: the first fragment continues
		// the last line already held, and appending it as a new row would break
		// one line into two.
		existing[len(existing)-1] += lines[0]
		lines = lines[1:]
	}
	existing = append(existing, lines...)
	if len(existing) > scrollbackLimit {
		existing = existing[len(existing)-scrollbackLimit:]
	}
	return existing
}

// byteSize renders a file size the way a person reads one.
func byteSize(value int64) string {
	switch {
	case value < 1024:
		return fmt.Sprintf("%d B", value)
	case value < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(value)/1024)
	case value < 1024*1024*1024:
		return fmt.Sprintf("%.1f MB", float64(value)/(1024*1024))
	default:
		return fmt.Sprintf("%.1f GB", float64(value)/(1024*1024*1024))
	}
}
