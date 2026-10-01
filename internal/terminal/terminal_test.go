package terminal

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// collector gathers events from a manager's sink.
//
// The sink is called from the terminal's own goroutines, so every read here is
// under the mutex: a test that read a slice as it was being appended to would be
// a data race, and `go test -race` would be right to fail on it.
type collector struct {
	mu     sync.Mutex
	events []Event
}

func (c *collector) sink(event Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func (c *collector) snapshot() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Event, len(c.events))
	copy(out, c.events)
	return out
}

// output joins every batch of terminal output seen so far.
func (c *collector) output() string {
	var builder strings.Builder
	for _, event := range c.snapshot() {
		if event.Kind == EventOutput {
			builder.WriteString(event.Data)
		}
	}
	return builder.String()
}

func (c *collector) exit() (Event, bool) {
	for _, event := range c.snapshot() {
		if event.Kind == EventExit {
			return event, true
		}
	}
	return Event{}, false
}

// waitFor polls until the condition holds or the deadline passes.
//
// Polling rather than a channel because the thing being waited for arrives on a
// goroutine this test does not own, and the interesting assertions are about the
// *content* of what arrived rather than about a single signal.
func waitFor(t *testing.T, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}

// startManager builds a manager over a temp directory with a collecting sink.
func startManager(t *testing.T) (*Manager, *collector) {
	t.Helper()
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	sink := &collector{}
	manager.SetSink(sink.sink)
	t.Cleanup(func() { _ = manager.Close() })
	return manager, sink
}

// echoCommand is a command that prints a known marker in every shell this
// program supports.
//
// It is chosen per platform rather than passed in, because the test's job is to
// prove the *shell* works — writing `sh -c` syntax into a PowerShell terminal
// would be testing the test's assumptions rather than the PTY.
func echoCommand(marker string) string {
	if isWindows() {
		return "echo " + marker + "\r"
	}
	return "echo " + marker + "\n"
}

// TestCreateStartsARealShellInARealPTY is the load-bearing test of this package.
//
// It asserts the one thing the design turns on — that a terminal is a **PTY with
// a shell on it**, not a pair of pipes — by running a command and reading what the
// shell wrote back. A pipe-based implementation fails this at the first step: a
// shell attached to pipes either refuses to run interactively or never prints a
// prompt, which is exactly why the design forbids pipes.
func TestCreateStartsARealShellInARealPTY(t *testing.T) {
	manager, sink := startManager(t)

	info, err := manager.Create("", 100, 30)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if info.Status != StatusRunning {
		t.Errorf("status = %q, want %q", info.Status, StatusRunning)
	}
	if info.PID <= 0 {
		t.Errorf("pid = %d, want a real process id", info.PID)
	}
	if info.Cols != 100 || info.Rows != 30 {
		t.Errorf("size = %dx%d, want 100x30", info.Cols, info.Rows)
	}
	if info.Cwd != "" {
		t.Errorf("cwd = %q, want the empty string for the workspace root", info.Cwd)
	}

	marker := "PTY_ROUNDTRIP_OK"
	if err := manager.Input(info.ID, echoCommand(marker)); err != nil {
		t.Fatalf("Input: %v", err)
	}

	// The poll is the asynchronous-output assertion: nothing here waits for a
	// reply to the input, because there is no reply — the bytes arrive on their
	// own schedule, which is the design's `command → PTY → async stream`.
	waitFor(t, "the shell's echo to come back", 20*time.Second, func() bool {
		return strings.Contains(sink.output(), marker)
	})
}

func TestListKeepsFinishedTerminals(t *testing.T) {
	manager, sink := startManager(t)
	info, err := manager.Create("", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// `exit` ends the shell by itself, which is the other ending this package has
	// to report. The exit code has to arrive, and it has to be 0 — a shell told to
	// exit reports success.
	command := "exit\n"
	if isWindows() {
		command = "exit\r"
	}
	if err := manager.Input(info.ID, command); err != nil {
		t.Fatalf("Input: %v", err)
	}

	waitFor(t, "the terminal to report its exit", 20*time.Second, func() bool {
		_, ok := sink.exit()
		return ok
	})

	event, _ := sink.exit()
	if event.Reason != ReasonExited {
		t.Errorf("reason = %q, want %q (the shell exited by itself)", event.Reason, ReasonExited)
	}
	if event.Info.Status != StatusExited {
		t.Errorf("status = %q, want %q", event.Info.Status, StatusExited)
	}
	if event.Info.ExitCode == nil {
		t.Fatal("exit code is nil; a shell that ran `exit` reports 0")
	}
	if *event.Info.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", *event.Info.ExitCode)
	}

	// **The terminal stays on the list.** A row that vanished would take the exit
	// code and the last screenful of output with it, and those are exactly what
	// somebody looking at a finished terminal wants.
	rows := manager.List()
	if len(rows) != 1 {
		t.Fatalf("list has %d terminals, want 1 (finished ones stay)", len(rows))
	}
	if rows[0].Status != StatusExited {
		t.Errorf("listed status = %q, want %q", rows[0].Status, StatusExited)
	}
}

func TestKillEndsTheTerminalAndSaysSo(t *testing.T) {
	manager, sink := startManager(t)
	info, err := manager.Create("", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := manager.Kill(info.ID); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	waitFor(t, "the exit event after a kill", 20*time.Second, func() bool {
		_, ok := sink.exit()
		return ok
	})

	event, _ := sink.exit()
	if event.Reason != ReasonKilled {
		t.Errorf("reason = %q, want %q", event.Reason, ReasonKilled)
	}
	if event.Info.Status != StatusKilled {
		t.Errorf("status = %q, want %q", event.Info.Status, StatusKilled)
	}
	// A killed shell did not choose an exit code, so there is none to report.
	// Inventing 0 here would make "we killed it" and "it finished cleanly" the
	// same row.
	if event.Info.ExitCode != nil {
		t.Errorf("exit code = %d, want nil for a killed terminal", *event.Info.ExitCode)
	}

	// Idempotent: the person pressed the button, and "it was already gone" is the
	// outcome they wanted.
	if err := manager.Kill(info.ID); err != nil {
		t.Errorf("killing an ended terminal: %v", err)
	}
}

func TestCreateRefusesACwdOutsideTheWorkspace(t *testing.T) {
	manager, _ := startManager(t)
	for _, escape := range []string{"..", "../..", "../../outside"} {
		if _, err := manager.Create(escape, 80, 24); err == nil {
			t.Errorf("Create(%q) was allowed; it escapes the workspace", escape)
		}
	}
	// Nothing was created: a refusal that left a process behind would be worse
	// than one that spawned somewhere wrong.
	if rows := manager.List(); len(rows) != 0 {
		t.Errorf("a refused create left %d terminal(s) behind", len(rows))
	}
}

func TestCreateRefusesAFileAsACwd(t *testing.T) {
	manager, _ := startManager(t)
	// A shell started in "some other directory" reads as "the request was
	// honoured" while the person's commands run somewhere they did not ask for,
	// so a cwd that is a file is refused rather than replaced by its parent.
	file := filepath.Join(manager.Root(), "notes.txt")
	if err := os.WriteFile(file, []byte("x\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := manager.Create("notes.txt", 80, 24); err == nil {
		t.Error("a file was accepted as a terminal's working directory")
	}
	// A path that is not there is refused too, and for the same reason: the
	// alternative is a shell that starts somewhere else and says nothing.
	if _, err := manager.Create("no/such/directory", 80, 24); err == nil {
		t.Error("a missing directory was accepted as a terminal's working directory")
	}
	if rows := manager.List(); len(rows) != 0 {
		t.Errorf("a refused create left %d terminal(s) behind", len(rows))
	}
}

func TestCreateUsesAWorkspaceRelativeSubdirectory(t *testing.T) {
	manager, sink := startManager(t)
	if err := os.MkdirAll(filepath.Join(manager.Root(), "backend"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	info, err := manager.Create("backend", 90, 25)
	if err != nil {
		t.Fatalf("Create(backend): %v", err)
	}
	// The row reports the path **relative to the workspace**, which is the
	// vocabulary both Files and Terminal speak. An absolute path in a row would
	// invite a front end to send one back.
	if info.Cwd != "backend" {
		t.Errorf("cwd = %q, want %q", info.Cwd, "backend")
	}

	// And the shell really is there: printing the directory's own name proves the
	// cwd reached the process rather than merely the row.
	command := "basename $PWD\n"
	if isWindows() {
		command = "Split-Path -Leaf (Get-Location)\r"
	}
	if err := manager.Input(info.ID, command); err != nil {
		t.Fatalf("Input: %v", err)
	}
	waitFor(t, "the shell to report its working directory", 20*time.Second, func() bool {
		return strings.Contains(sink.output(), "backend")
	})
}

func TestInputAndResizeRefuseAnUnknownId(t *testing.T) {
	manager, _ := startManager(t)
	if err := manager.Input("term-99", "whoami\n"); err == nil {
		t.Error("input to an unknown terminal was accepted")
	}
	if err := manager.Resize("term-99", 100, 40); err == nil {
		t.Error("resize of an unknown terminal was accepted")
	}
	if err := manager.Kill("term-99"); err == nil {
		t.Error("killing an unknown terminal was accepted")
	}
}

func TestResizeIsIgnoredForANonsenseSize(t *testing.T) {
	manager, _ := startManager(t)
	info, err := manager.Create("", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Ignored rather than clamped: a size nobody asked for makes a full-screen
	// program redraw at the wrong width, and on screen that is indistinguishable
	// from a rendering bug in this program.
	if err := manager.Resize(info.ID, 0, 0); err != nil {
		t.Fatalf("Resize(0,0) returned an error: %v", err)
	}
	rows := manager.List()
	if rows[0].Cols != 80 || rows[0].Rows != 24 {
		t.Errorf("size after a nonsense resize = %dx%d, want the unchanged 80x24",
			rows[0].Cols, rows[0].Rows)
	}

	if err := manager.Resize(info.ID, 120, 40); err != nil {
		t.Fatalf("Resize(120,40): %v", err)
	}
	rows = manager.List()
	if rows[0].Cols != 120 || rows[0].Rows != 40 {
		t.Errorf("size after resize = %dx%d, want 120x40", rows[0].Cols, rows[0].Rows)
	}
}

func TestEmptyInputIsAccepted(t *testing.T) {
	manager, _ := startManager(t)
	info, err := manager.Create("", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The protocol explicitly allows an empty write, and refusing it would give a
	// front end one more error path to handle for no gain.
	if err := manager.Input(info.ID, ""); err != nil {
		t.Errorf("empty input was refused: %v", err)
	}
}

func TestSinkCanBeMovedWithoutTouchingTheTerminals(t *testing.T) {
	manager, first := startManager(t)
	info, err := manager.Create("", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// This is the session-switch case: the connection changes, the shells do not.
	second := &collector{}
	manager.SetSink(second.sink)

	marker := "AFTER_SINK_MOVE"
	if err := manager.Input(info.ID, echoCommand(marker)); err != nil {
		t.Fatalf("Input: %v", err)
	}
	waitFor(t, "output on the new sink", 20*time.Second, func() bool {
		return strings.Contains(second.output(), marker)
	})
	if strings.Contains(first.output(), marker) {
		t.Error("output arrived on the old sink after it was replaced")
	}
}
