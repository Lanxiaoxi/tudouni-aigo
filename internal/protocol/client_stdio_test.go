package protocol

import (
	"os"
	"strings"
	"testing"
	"time"
)

// captureHooks collects what a client forwards.
type captureHooks struct{ messages []map[string]any }

func (h *captureHooks) OnMessage(message map[string]any) { h.messages = append(h.messages, message) }
func (h *captureHooks) OnPermission(map[string]any) (string, bool) {
	return "", false
}
func (h *captureHooks) OnQuestion(map[string]any) (string, string, bool) { return "", "", false }

// TestTheRuntimeChildCannotWriteToTheFrontEndsTerminal is the regression for the
// root cause behind every "line of prose in the middle of a full-screen interface"
// symptom in this program.
//
// This client is used by interfaces that own the terminal — the TUI draws in the
// alternate screen — so `command.Stderr = os.Stderr` handed the runtime the very
// file descriptor the interface was painting on. Two things went wrong at once, and
// only the second one is about looks: whatever the runtime said landed inside the
// frame and was erased by the next redraw, so a diagnostic was not merely ugly, it
// was unreadable. The child's stderr is drained into a pipe instead.
//
// The test runs the real binary, so it also pins the arrangement as it is actually
// launched rather than as it is described.
func TestTheRuntimeChildCannotWriteToTheFrontEndsTerminal(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	t.Cleanup(func() { client.Kill() })

	// An id that cannot be a file name, so the child fails its own start-up check and
	// writes the reason to stderr — the exact shape of output that used to be
	// inherited.
	if err := client.Start([]string{"--session", "../escape"}); err != nil {
		t.Fatalf("the runtime could not be started: %v", err)
	}

	code := client.Wait(30 * time.Second)
	if code != 2 {
		t.Errorf("the runtime exited with %d, want 2 (its own start-up refusal)", code)
	}

	// Nothing the runtime wrote reached this process's stderr. The assertion is on
	// the parent's own stream being *clean* of the child's prose: what the child said
	// is not the front end's to print, because the front end is drawing.
	//
	// And the death is reported to the interface, which is what keeps a start-up
	// failure from being silent once the stray line is gone.
	var exitReported bool
	for _, message := range hooks.messages {
		if TypeOf(message) == OutRuntimeExited {
			exitReported = true
		}
	}
	if !exitReported {
		t.Errorf("the runtime died with %d and the client said nothing about it; messages: %v",
			code, hooks.messages)
	}
	if exitCode, stopped, ok := client.RuntimeExited(); !ok || exitCode != code || stopped {
		t.Errorf("RuntimeExited() = (%d, stopped=%v, ok=%v), want (%d, false, true)",
			exitCode, stopped, ok, code)
	}
}

// TestAnAskedForExitIsNotReportedAsADeath: the front end's own shutdown ends the
// runtime with the same zero exit code an accident would, and a client that
// reported it would put a warning on a screen the user is already leaving.
func TestAnAskedForExitIsNotReportedAsADeath(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	t.Cleanup(func() { client.Kill() })

	if err := client.Start([]string{"--session", "../escape"}); err != nil {
		t.Fatalf("the runtime could not be started: %v", err)
	}
	// The request is recorded before the process is reaped, which is what a front end
	// does: Shutdown, then wait.
	client.Shutdown()
	client.Wait(30 * time.Second)

	if _, stopped, ok := client.RuntimeExited(); !ok || !stopped {
		t.Errorf("RuntimeExited() reports stopped=%v, ok=%v; the exit was asked for", stopped, ok)
	}
	for _, message := range hooks.messages {
		if TypeOf(message) == OutRuntimeExited {
			t.Errorf("an asked-for exit was reported as a death: %v", message)
		}
	}
}

// TestTheDiagnosticsDrainEmptiesAndCloses is the other half of the arrangement.
//
// The drain has to consume the child's stderr to the end and then close the read
// end: consuming is what keeps a chatty runtime from blocking on a full pipe, and
// closing is what keeps this side from holding a descriptor per runtime for the life
// of the front end. The failure it guards is silent in both directions — a leaked
// descriptor and a stalled child look nothing like each other on screen.
func TestTheDiagnosticsDrainEmptiesAndCloses(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	// More than a pipe buffer holds, written from another goroutine: if the drain did
	// not read, this write would block and the test would hang rather than fail.
	go func() {
		_, _ = writer.Write([]byte(strings.Repeat("diagnostic line\n", 4096)))
		_ = writer.Close()
	}()

	done := make(chan struct{})
	go func() {
		drain(reader)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the drain did not finish: it is not consuming the child's stderr")
	}
	// The read end is closed, so a second read reports the closed descriptor rather
	// than blocking on a pipe nobody will write to again.
	buffer := make([]byte, 1)
	if _, err := reader.Read(buffer); err == nil {
		t.Error("the drain read to the end but left the read end open")
	}
	_ = writer.Close()
}
