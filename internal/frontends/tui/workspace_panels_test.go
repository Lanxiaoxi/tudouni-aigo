package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// terminalPanelModel is a filled model with three terminals, one per ending.
//
// Three rather than one on purpose: the assertions below are about the three
// reading **differently**, and a single-row fixture cannot tell a status function
// that works from one that returns a constant.
func terminalPanelModel() model {
	m := filledModel(120, 40)
	m.railHidden = true
	m.panel.terminals = []any{
		map[string]any{"id": "term-01", "cwd": "", "shell": "pwsh", "status": "running",
			"pid": 100, "exit_code": nil, "cols": 80, "rows": 24},
		map[string]any{"id": "term-02", "cwd": "backend", "shell": "pwsh", "status": "exited",
			"pid": 200, "exit_code": float64(0), "cols": 80, "rows": 24},
		map[string]any{"id": "term-03", "cwd": "frontend", "shell": "pwsh", "status": "killed",
			"pid": 300, "exit_code": nil, "cols": 80, "rows": 24},
	}
	return m
}

// TestTheTerminalPanelNamesEveryStatusApart is the assertion the status function
// exists for.
//
// Three endings read three ways, and the third is why this cannot be a lookup:
// `exited` with a code, `exited` without one, and `killed` are different facts. A
// killed shell did not choose an exit status, so printing `0` next to it would be
// an invented number — and the design's whole point about the socket is that the
// runtime alone decides what "running" means.
func TestTheTerminalPanelNamesEveryStatusApart(t *testing.T) {
	withColour(t)
	m := terminalPanelModel()
	m.overlay = overlay{kind: overlayTerminal}
	rendered := stripANSI(m.renderTerminalPanel(m.width-8, m.bodyHeight()))

	for _, want := range []string{"term-01", "term-02", "term-03", "backend", "frontend"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("the panel does not show %q:\n%s", want, rendered)
		}
	}
	if !strings.Contains(rendered, i18n.T("terminal.running")) {
		t.Errorf("no row says the terminal is running:\n%s", rendered)
	}
	if !strings.Contains(rendered, i18n.T("terminal.killed")) {
		t.Errorf("no row says the terminal was killed:\n%s", rendered)
	}
	if !strings.Contains(rendered, i18n.T("terminal.exited", "code", 0)) {
		t.Errorf("the exited row does not carry its code:\n%s", rendered)
	}
}

// TestATerminalWithNoExitCodeDoesNotInventOne is the one status case that a
// lookup table would have flattened.
func TestATerminalWithNoExitCodeDoesNotInventOne(t *testing.T) {
	status, _ := terminalStatusText(terminalRow{id: "t", status: protocol.TerminalExited})
	if status != i18n.T("terminal.exited_unknown") {
		t.Errorf("an exited terminal with no code reads %q, want the unknown-code sentence", status)
	}
	// And the killed row is a different word, not a zero.
	killed, _ := terminalStatusText(terminalRow{id: "t", status: protocol.TerminalKilled})
	if killed == status {
		t.Errorf("killed and exited-with-no-code read the same (%q)", killed)
	}
}

// TestTheTerminalPanelAlwaysSaysSomethingOnAnEmptyWorkspace: an empty frame is
// indistinguishable from an interface that has stopped drawing, and it does not
// say what to do about it.
func TestTheTerminalPanelAlwaysSaysSomethingOnAnEmptyWorkspace(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.railHidden = true
	m.overlay = overlay{kind: overlayTerminal}
	rendered := stripANSI(m.renderTerminalPanel(m.width-8, m.bodyHeight()))
	if !strings.Contains(rendered, "/terminal new") {
		t.Errorf("the empty panel does not say how to open one:\n%s", rendered)
	}
}

// TestEnterOnADirectoryWalksInsteadOfClosing is the one behavioural difference
// between this panel and every other picker in the interface.
//
// A panel that closed on every step would cost one `/files` per directory, and
// browsing is a walk rather than a pick.
func TestEnterOnADirectoryWalksInsteadOfClosing(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.files = filePanel{path: "", entries: []any{
		map[string]any{"name": "src", "path": "src", "type": protocol.FileTypeDirectory},
		map[string]any{"name": "README.md", "path": "README.md", "type": protocol.FileTypeFile},
	}}
	m.overlay = overlay{kind: overlayFiles}
	m.overlay.cursor = 0

	next, _ := m.commitFileBrowser()
	after := next.(model)
	if after.overlay.kind != overlayFiles {
		t.Errorf("opening a directory closed the panel (kind = %v)", after.overlay.kind)
	}
	if after.files.path != "src" {
		t.Errorf("the browser is at %q, want %q", after.files.path, "src")
	}
	if !after.files.loading {
		t.Error("the panel is not showing its loading state while the listing is read")
	}
}

// TestEnterOnAFileAsksForItWithoutLeavingThePanel: a viewer that dismissed itself
// the moment it showed something would make `Esc` the only way to read two files.
func TestEnterOnAFileAsksForItWithoutLeavingThePanel(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.client = protocol.TestClientWithExit(0, false)
	m.files = filePanel{path: "", entries: []any{
		map[string]any{"name": "README.md", "path": "README.md", "type": protocol.FileTypeFile},
	}}
	m.overlay = overlay{kind: overlayFiles}

	next, _ := m.commitFileBrowser()
	after := next.(model)
	if after.overlay.kind != overlayFiles {
		t.Errorf("opening a file closed the panel (kind = %v)", after.overlay.kind)
	}
}

// TestAParentPathStopsAtTheWorkspaceRoot — the workspace root is the empty string,
// and it is also its own parent. Walking up from it has to stay put rather than
// producing `..`, which the runtime would refuse: a key that generates a refusal
// notice is a key that looks broken.
func TestAParentPathStopsAtTheWorkspaceRoot(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"src":               "",
		"src/components":    "src",
		"src/components/ui": "src/components",
		"src/":              "",
		"a/b/":              "a",
	}
	for input, want := range cases {
		if got := parentPath(input); got != want {
			t.Errorf("parentPath(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestTheTerminalListIsReadFromTheSnapshots: the list arrives on `ui(state)` as
// well as on `terminal_list`, and a front end that only understood the second
// would show nothing after a restart — the snapshot is what re-states it.
func TestTheTerminalListIsReadFromTheSnapshots(t *testing.T) {
	m := filledModel(120, 40)
	payload := map[string]any{
		"v": 1, "t": "ui", "kind": protocol.UIState,
		"terminals": []any{map[string]any{"id": "term-01", "status": "running"}},
		"goal":      map[string]any{"objective": ""},
	}
	m.applyState(payload)
	if len(m.panel.terminals) != 1 {
		t.Fatalf("the snapshot's terminals were dropped: %v", m.panel.terminals)
	}
	rows := m.terminalPanelRows()
	if len(rows) != 1 || rows[0].id != "term-01" {
		t.Errorf("terminalPanelRows = %v, want one term-01", rows)
	}
}

// TestAttachingSwallowsEveryKeyButTheDetachChord is the safety property of the
// attached state.
//
// `Ctrl+C` inside a shell means "interrupt the running command", not "quit this
// program". A front end that kept its own bindings while attached would make the
// shell's own job control unreachable — and would quit the interface when somebody
// tried to stop a build.
func TestAttachingSwallowsEveryKeyButTheDetachChord(t *testing.T) {
	m := filledModel(120, 40)
	m.client = protocol.TestClientWithExit(0, false)
	m.attached = terminalAttach{id: "term-01", shell: "pwsh", status: protocol.TerminalRunning}

	// Ctrl+C — the one that would otherwise reach the editor's quit path.
	next, _ := m.handleAttachedKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	after := next.(model)
	if after.attached.id != "term-01" {
		t.Error("Ctrl+C detached; it belongs to the shell")
	}
	if after.runtimeGone {
		t.Error("Ctrl+C reached the interface's own key handling")
	}

	// The detach chord is the one key that does not go to the shell.
	next, _ = after.handleAttachedKey(tea.KeyMsg{Type: detachKey})
	after = next.(model)
	if after.attached.id != "" {
		t.Error("the detach chord did not detach")
	}
}

// TestDetachingLeavesTheShellRunning is the design's lifecycle rule stated as a
// test: leaving a view is not ending a process.
func TestDetachingLeavesTheShellRunning(t *testing.T) {
	m := filledModel(120, 40)
	m.panel.terminals = []any{map[string]any{"id": "term-01", "status": protocol.TerminalRunning}}
	m.attached = terminalAttach{id: "term-01", status: protocol.TerminalRunning}

	m.detach()
	if m.attached.id != "" {
		t.Errorf("still attached to %q", m.attached.id)
	}
	rows := m.terminalPanelRows()
	if len(rows) != 1 || rows[0].status != protocol.TerminalRunning {
		t.Errorf("detaching changed the terminal's status: %v", rows)
	}
}

// TestTheExitEventIsWhatEndsTheAttachedView — the runtime is the only source of
// truth for whether a terminal is running, so the view follows the event and never
// the request that asked for it.
func TestTheExitEventIsWhatEndsTheAttachedView(t *testing.T) {
	m := filledModel(120, 40)
	m.attached = terminalAttach{id: "term-01", status: protocol.TerminalRunning}
	m.terminalExitLine(map[string]any{
		"kind": protocol.UITerminalExit, "terminal_id": "term-01",
		"reason":   protocol.TerminalExitReasonExited,
		"terminal": map[string]any{"id": "term-01", "status": protocol.TerminalExited, "exit_code": 0},
	})
	if m.attached.id != "" {
		t.Error("the attached view survived its terminal's exit")
	}
}

// TestEncodeKeySendsTheBytesATerminalSends.
//
// The control range is the byte itself — `Ctrl+C` is 0x03 because that is ETX, not
// because anything maps it — and the named keys are the escape sequences a real
// terminal produces. A wrong byte here is a command that ran with a character
// nobody typed.
func TestEncodeKeySendsTheBytesATerminalSends(t *testing.T) {
	cases := []struct {
		name string
		key  tea.KeyMsg
		want string
	}{
		{"a letter", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")}, "a"},
		{"a Chinese character", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("中")}, "中"},
		{"Alt+key gets the ESC prefix", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("b"), Alt: true}, "\x1bb"},
		{"Ctrl+C is ETX", tea.KeyMsg{Type: tea.KeyCtrlC}, "\x03"},
		{"Ctrl+D is EOT", tea.KeyMsg{Type: tea.KeyCtrlD}, "\x04"},
		{"Ctrl+Z is SUB", tea.KeyMsg{Type: tea.KeyCtrlZ}, "\x1a"},
		{"Enter is CR, not LF", tea.KeyMsg{Type: tea.KeyEnter}, "\r"},
		{"Backspace is DEL", tea.KeyMsg{Type: tea.KeyBackspace}, "\x7f"},
		{"Tab is HT", tea.KeyMsg{Type: tea.KeyTab}, "\t"},
		{"Esc is ESC", tea.KeyMsg{Type: tea.KeyEsc}, "\x1b"},
		{"Up is CSI A", tea.KeyMsg{Type: tea.KeyUp}, "\x1b[A"},
		{"Left is CSI D", tea.KeyMsg{Type: tea.KeyLeft}, "\x1b[D"},
		{"Delete is CSI 3~", tea.KeyMsg{Type: tea.KeyDelete}, "\x1b[3~"},
		{"Shift+Tab is CSI Z", tea.KeyMsg{Type: tea.KeyShiftTab}, "\x1b[Z"},
	}
	for _, testCase := range cases {
		if got := encodeKey(testCase.key); got != testCase.want {
			t.Errorf("%s: encodeKey = %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

// TestAnUnmappedKeySendsNothing: guessing at a byte is a command that ran with a
// character nobody typed, and silence is recoverable while a wrong byte is not.
//
// The key chosen is one this build genuinely does not map. `0x7F` would have been
// the obvious candidate and is the wrong one: it **is** `KeyBackspace` (Bubble Tea
// spells it `keyDEL`), so testing with it would be testing the Backspace branch
// while claiming to test the default.
func TestAnUnmappedKeySendsNothing(t *testing.T) {
	if _, handled := keyBytes[tea.KeyInsert]; handled {
		t.Skip("KeyInsert is mapped now; pick another unmapped key for this test")
	}
	if got := encodeKey(tea.KeyMsg{Type: tea.KeyInsert}); got != "" {
		t.Errorf("an unmapped key encoded to %q, want nothing", got)
	}
}

// keyBytes is not a lookup table the encoder uses — it is the set of keys the
// encoder claims to handle, so a test can ask "is this key mapped" without
// duplicating the switch. See `TestEveryMappedKeyHasAByte` for what keeps it
// honest.
var keyBytes = map[tea.KeyType]bool{
	tea.KeyEnter: true, tea.KeyBackspace: true, tea.KeyTab: true, tea.KeySpace: true,
	tea.KeyEsc: true, tea.KeyUp: true, tea.KeyDown: true, tea.KeyRight: true,
	tea.KeyLeft: true, tea.KeyHome: true, tea.KeyEnd: true, tea.KeyPgUp: true,
	tea.KeyPgDown: true, tea.KeyDelete: true, tea.KeyShiftTab: true,
	tea.KeyF1: true, tea.KeyF2: true, tea.KeyF3: true, tea.KeyF4: true,
	tea.KeyF5: true, tea.KeyF6: true, tea.KeyF7: true, tea.KeyF8: true,
	tea.KeyF9: true, tea.KeyF10: true, tea.KeyF11: true, tea.KeyF12: true,
}

// TestEveryMappedKeyHasAByte is what keeps `keyBytes` from becoming a comment.
//
// A key listed there but not encoded in the switch would be a key this interface
// accepts and then silently swallows — which in an attached terminal is
// indistinguishable from a frozen shell.
func TestEveryMappedKeyHasAByte(t *testing.T) {
	for key := range keyBytes {
		if got := encodeKey(tea.KeyMsg{Type: key}); got == "" {
			t.Errorf("keyBytes lists %v but encodeKey sends nothing for it", key)
		}
	}
}

// TestTerminalOutputStripsEscapesAndKeepsTheLastRewrite.
//
// A program's output routinely contains cursor movements, and drawing those
// literally would clear or scramble the screen this interface is drawing on. The
// carriage-return case is the progress bar: it rewrites one line, and the last
// rewrite is what a terminal would be showing.
func TestTerminalOutputStripsEscapesAndKeepsTheLastRewrite(t *testing.T) {
	lines := terminalOutputLine("\x1b[2J\x1b[Hhello")
	if len(lines) == 0 || !strings.Contains(lines[len(lines)-1], "hello") {
		t.Errorf("escape sequences were not stripped: %q", lines)
	}
	for _, line := range lines {
		if strings.Contains(line, "\x1b") {
			t.Errorf("an escape sequence survived into the output: %q", line)
		}
	}

	// A progress line: several rewrites separated by CR, only the last shown.
	progress := terminalOutputLine("10%\r50%\r100% done")
	if got := strings.Join(progress, "\n"); got != "100% done" {
		t.Errorf("progress rewrites collapsed to %q, want the last one", got)
	}
}

// TestScrollbackContinuesTheLastLine: the batch boundary is not a line boundary,
// so a fragment that continues a line must not become a row of its own.
func TestScrollbackContinuesTheLastLine(t *testing.T) {
	lines := appendScrollback(nil, "npm ")
	lines = appendScrollback(lines, "test\r\n")
	joined := strings.Join(lines, "|")
	if !strings.Contains(joined, "npm test") {
		t.Errorf("a split line was broken into two rows: %q", joined)
	}
}

// TestScrollbackIsBounded is the memory bound. Without it, the interface's memory
// grows with the length of a command somebody ran.
func TestScrollbackIsBounded(t *testing.T) {
	var lines []string
	for index := 0; index < scrollbackLimit+500; index++ {
		lines = appendScrollback(lines, "line\n")
	}
	if len(lines) > scrollbackLimit+1 {
		t.Errorf("scrollback holds %d lines, want at most %d", len(lines), scrollbackLimit)
	}
	// The **newest** lines survive: dropping the recent output would leave the
	// pane showing the beginning of a build with no sign of the end.
	lines = appendScrollback(lines, "THE-NEWEST-LINE\n")
	found := false
	for _, line := range lines {
		if strings.Contains(line, "THE-NEWEST-LINE") {
			found = true
		}
	}
	if !found {
		t.Error("the newest line was dropped")
	}
}

// TestTheFilesPanelDoesNotLieAboutAnEmptyDirectory — "loading" and "empty" are
// different statements, and drawing the second while the first is true sends
// somebody looking for files that are there.
func TestTheFilesPanelDoesNotLieAboutAnEmptyDirectory(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.railHidden = true
	m.overlay = overlay{kind: overlayFiles}
	m.files = filePanel{path: "src", loading: true}
	loading := stripANSI(m.renderFilesPanel(m.width-8, m.bodyHeight()))
	if !strings.Contains(loading, "src") {
		t.Errorf("the loading panel does not say which directory:\n%s", loading)
	}
	if strings.Contains(loading, i18n.T("files.empty")) {
		t.Errorf("the loading panel claims the directory is empty:\n%s", loading)
	}

	m.files = filePanel{path: "src"}
	empty := stripANSI(m.renderFilesPanel(m.width-8, m.bodyHeight()))
	if !strings.Contains(empty, i18n.T("files.empty")) {
		t.Errorf("an empty listing says nothing about being empty:\n%s", empty)
	}
}

// TestTheBrowserPanelUsesThePathTheRuntimeEchoed — the two differ after a
// `/files ./src/../src`, and keeping the reply's spelling is what makes "where am
// I" answerable and Backspace's arithmetic correct.
func TestTheBrowserPanelUsesThePathTheRuntimeEchoed(t *testing.T) {
	m := filledModel(120, 40)
	m.handleUI(map[string]any{
		"v": 1, "t": "ui", "kind": protocol.UIFiles,
		"path": "src", "entries": []any{},
	})
	if m.files.path != "src" {
		t.Errorf("the browser kept %q, want the runtime's %q", m.files.path, "src")
	}
	if m.files.loading {
		t.Error("the loading flag survived the answer")
	}
}

// TestCreatingATerminalAttachesToIt: the answer to `/terminal new` is a shell to
// type into, not a list to read.
func TestCreatingATerminalAttachesToIt(t *testing.T) {
	m := filledModel(120, 40)
	m.handleUI(map[string]any{
		"v": 1, "t": "ui", "kind": protocol.UITerminalCreated,
		"terminal_id": "term-01",
		"terminal":    map[string]any{"id": "term-01", "shell": "pwsh", "status": protocol.TerminalRunning},
	})
	if m.attached.id != "term-01" {
		t.Errorf("attached to %q, want term-01", m.attached.id)
	}
	if m.overlay.kind != overlayNone {
		t.Errorf("a picker is still open (kind = %v)", m.overlay.kind)
	}
}

// TestTerminalByIndexAcceptsBothSpellingsAndGuessesAtNeither.
func TestTerminalByIndexAcceptsBothSpellingsAndGuessesAtNeither(t *testing.T) {
	m := terminalPanelModel()
	if row := m.terminalByIndex("1"); row == nil || row.id != "term-01" {
		t.Errorf("terminalByIndex(\"1\") = %v, want term-01", row)
	}
	if row := m.terminalByIndex("term-02"); row == nil || row.id != "term-02" {
		t.Errorf("terminalByIndex(\"term-02\") = %v, want term-02", row)
	}
	// Out of range and unknown are both nil: attaching to "the first one" when the
	// id was misremembered would hand the keyboard to a shell nobody was looking at.
	for _, bad := range []string{"0", "9", "term-99"} {
		if row := m.terminalByIndex(bad); row != nil {
			t.Errorf("terminalByIndex(%q) = %v, want nil", bad, row)
		}
	}
}

// TestTheAttachSizeIsThePaneNotTheTerminal: a shell told it has 200 columns while
// it is drawn in a 140-column pane lays its output out past the right edge.
func TestTheAttachSizeIsThePaneNotTheTerminal(t *testing.T) {
	m := filledModel(120, 40)
	cols, rows := m.attachSize()
	if cols != m.width {
		t.Errorf("cols = %d, want the terminal's width %d", cols, m.width)
	}
	if rows != m.bodyHeight() {
		t.Errorf("rows = %d, want the body's height %d", rows, m.bodyHeight())
	}
}

// TestTheFileBrowserPanelWrapsItsOwnRows is the invariant every panel here has to
// hold, tested in the form that does not depend on how wide this environment thinks
// a box-drawing character is.
//
// The failure mode is specific: `overlayFrame`'s lipgloss wrapper does not agree
// with this program's `wrapCells` about ANSI escapes, so a styled row handed to it
// over-wide is reflowed **early** — and a selected row's highlight then spans two
// or three lines instead of one. The observable consequence, and the one measured
// here, is that **the row count changes with the cursor position**, because the
// highlighted row is the one that gains a line. That is the reported bug, and it is
// the assertion the earlier `TestPanelsDoNotReflowTheirRows` makes too.
//
// A width assertion was tried first and is not usable: `go-runewidth` reports
// `EastAsianWidth` true in this environment, so every box character measures two
// cells and the frame's own border rows come out at twice their real width. That
// number is a fact about the machine rather than about the panel.
func TestTheFileBrowserPanelWrapsItsOwnRows(t *testing.T) {
	withColour(t)
	longName := "a-very-long-file-name-that-will-need-truncating-at-some-point.go"
	newModel := func(cursor int) model {
		m := filledModel(120, 40)
		m.railHidden = true
		m.overlay = overlay{kind: overlayFiles, cursor: cursor}
		m.files = filePanel{path: "src", entries: []any{
			map[string]any{"name": longName, "path": "src/" + longName,
				"type": protocol.FileTypeFile, "size": 12345},
			map[string]any{"name": strings.Repeat("deeply-nested-", 8),
				"path": "src/" + strings.Repeat("deeply-nested-", 8),
				"type": protocol.FileTypeDirectory},
		}}
		return m
	}

	first := len(panelLines(t, newModel(0).renderFilesPanel(112, 40)))
	for cursor := 1; cursor < 2; cursor++ {
		got := len(panelLines(t, newModel(cursor).renderFilesPanel(112, 40)))
		if got != first {
			t.Errorf("the panel reflows: %d lines with cursor %d but %d with another "+
				"— a selected row that wraps", got, cursor, first)
		}
	}
}

// TestTheTerminalPanelWrapsItsOwnRows is the same invariant for the other new
// panel, with a long working directory as the row that has to fit.
func TestTheTerminalPanelWrapsItsOwnRows(t *testing.T) {
	withColour(t)
	newModel := func(cursor int) model {
		m := filledModel(120, 40)
		m.railHidden = true
		m.overlay = overlay{kind: overlayTerminal, cursor: cursor}
		m.panel.terminals = []any{
			map[string]any{"id": "term-01", "shell": "pwsh", "status": "running",
				"cwd": strings.Repeat("a-rather-long-directory-name/", 5)},
			map[string]any{"id": "term-02", "shell": "pwsh", "status": "killed"},
		}
		return m
	}
	first := len(panelLines(t, newModel(0).renderTerminalPanel(112, 40)))
	for cursor := 1; cursor < 2; cursor++ {
		got := len(panelLines(t, newModel(cursor).renderTerminalPanel(112, 40)))
		if got != first {
			t.Errorf("the panel reflows: %d lines with cursor %d but %d with another",
				got, cursor, first)
		}
	}
}
