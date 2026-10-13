package protocol

import (
	"io"
	"sync"
	"testing"
	"time"
)

// fakeBackend is a Backend with no process and no network under it, built to
// test everything StartWithBackend/Client do above the Backend seam without
// a real runtime or a real SSH server. This is the point of Backend being an
// interface: the behaviour worth asserting here (readiness, diagnostics,
// exit reporting, stray stdout) is the same for LocalBackend and
// RemoteBackend, so it is tested once, against the interface, rather than
// twice against two unrelated concrete types.
type fakeBackend struct {
	stdinReader  *io.PipeReader
	stdinWriter  *io.PipeWriter
	stdoutWriter *io.PipeWriter
	stdoutReader *io.PipeReader
	stderrWriter *io.PipeWriter
	stderrReader *io.PipeReader

	mu       sync.Mutex
	code     int
	hasCode  bool
	waitErr  error
	exited   chan struct{}
	killed   bool
	closed   bool
	startErr error
}

func newFakeBackend() *fakeBackend {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()
	backend := &fakeBackend{
		stdinReader:  stdinReader,
		stdinWriter:  stdinWriter,
		stdoutReader: stdoutReader,
		stdoutWriter: stdoutWriter,
		stderrReader: stderrReader,
		stderrWriter: stderrWriter,
		exited:       make(chan struct{}),
	}
	// Something has to read the other end of stdin, exactly as a real runtime
	// process does: io.Pipe's Write blocks until a Read consumes it, so a
	// Client.Send (UserMessage, Shutdown, an answered permission) would hang
	// forever against a fake that never reads its own stdin.
	go func() { _, _ = io.Copy(io.Discard, stdinReader) }()
	return backend
}

func (b *fakeBackend) Start() (io.WriteCloser, io.Reader, io.Reader, error) {
	if b.startErr != nil {
		return nil, nil, nil, b.startErr
	}
	return b.stdinWriter, b.stdoutReader, b.stderrReader, nil
}

// finish makes Wait return (code, true, nil) and unblocks it, and closes the
// stdout/stderr write ends so readLoop and drainDiagnostics see EOF rather
// than blocking forever on a pipe nobody will write to again — the same
// thing a real process exiting does to its own pipes. Call once.
func (b *fakeBackend) finish(code int) {
	b.mu.Lock()
	b.code = code
	b.hasCode = true
	b.mu.Unlock()
	_ = b.stdoutWriter.Close()
	_ = b.stderrWriter.Close()
	close(b.exited)
}

func (b *fakeBackend) Wait() (int, bool, error) {
	<-b.exited
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.code, b.hasCode, b.waitErr
}

func (b *fakeBackend) Kill() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.killed = true
	return nil
}

func (b *fakeBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	return nil
}

func (b *fakeBackend) wasKilled() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.killed
}

func (b *fakeBackend) wasClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

// writeLine writes one JSONL-shaped line to the fake runtime's stdout, as the
// real runtime would.
func (b *fakeBackend) writeLine(line string) {
	_, _ = io.WriteString(b.stdoutWriter, line+"\n")
}

func (b *fakeBackend) writeStderr(line string) {
	_, _ = io.WriteString(b.stderrWriter, line+"\n")
}

// TestStartWithBackendDeliversMessagesThroughHooks checks that a Backend's
// stdout reaches Hooks.OnMessage exactly the way a local child's always has —
// the whole point of the seam being that nothing downstream of Backend.Start
// needs to change.
func TestStartWithBackendDeliversMessagesThroughHooks(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}
	t.Cleanup(func() { backend.finish(0) })

	backend.writeLine(`{"v":1,"t":"init","protocol":9}`)
	backend.writeLine(`{"v":1,"t":"notice","text":"hello"}`)

	deadline := time.After(2 * time.Second)
	var messages []map[string]any
	for {
		messages = hooks.snapshot()
		if len(messages) >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("only %d of 2 messages arrived: %v", len(messages), messages)
		case <-time.After(5 * time.Millisecond):
		}
	}

	if TypeOf(messages[0]) != OutInit {
		t.Errorf("first message = %v, want init", messages[0])
	}
	if TypeOf(messages[1]) != "notice" {
		t.Errorf("second message = %v, want notice", messages[1])
	}
}

// TestWaitReadySucceedsOnInit is the ordinary path: the backend's first
// message is init, and WaitReady reports it without consuming it from Hooks.
func TestWaitReadySucceedsOnInit(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}
	t.Cleanup(func() { backend.finish(0) })

	backend.writeLine(`{"v":1,"t":"init","protocol":9,"version":"1.2.3"}`)

	info, err := client.WaitReady(2 * time.Second)
	if err != nil {
		t.Fatalf("WaitReady: %v", err)
	}
	if info.Protocol != 9 {
		t.Errorf("Protocol = %d, want 9", info.Protocol)
	}
	if info.RuntimeVersion != "1.2.3" {
		t.Errorf("RuntimeVersion = %q, want 1.2.3", info.RuntimeVersion)
	}

	// The init message must still reach Hooks.OnMessage: WaitReady observes it,
	// it does not steal it from the front end.
	deadline := time.After(2 * time.Second)
	var messages []map[string]any
	for {
		messages = hooks.snapshot()
		if len(messages) >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the init message never reached Hooks.OnMessage")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if TypeOf(messages[0]) != OutInit {
		t.Errorf("Hooks saw %v, want init", messages[0])
	}
}

// TestWaitReadyRejectsAPollutedFirstMessage is the "stdout polluted" case the
// design calls out: if whatever reaches stdout first is not init, this must
// be reported clearly, and the session must not be treated as ready.
func TestWaitReadyRejectsAPollutedFirstMessage(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}
	t.Cleanup(func() { backend.finish(0) })

	// A well-formed message, but not init: this is what a shell wrapper or
	// a wrong binary could still produce as valid JSONL without being this
	// protocol's handshake.
	backend.writeLine(`{"v":1,"t":"notice","text":"motd or similar"}`)

	_, err := client.WaitReady(2 * time.Second)
	if err == nil {
		t.Fatal("WaitReady succeeded on a non-init first message")
	}
}

// TestWaitReadyReportsAnEarlyExit covers a remote host where the binary is
// missing, the platform is wrong, or the command fails before ever writing a
// line: Start succeeded (the SSH session opened) but the runtime itself never
// produced a handshake.
func TestWaitReadyReportsAnEarlyExit(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}

	backend.writeStderr("exec: no such file or directory")
	backend.finish(127)

	_, err := client.WaitReady(2 * time.Second)
	if err == nil {
		t.Fatal("WaitReady succeeded despite the runtime exiting with no handshake")
	}
}

// TestWaitReadyTimesOutOnSilence covers a session that neither produced a
// message nor exited — a hung command, or a connection that is open but the
// far end never execs anything.
func TestWaitReadyTimesOutOnSilence(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}
	t.Cleanup(func() { backend.finish(0) })

	_, err := client.WaitReady(50 * time.Millisecond)
	if err == nil {
		t.Fatal("WaitReady succeeded despite nothing arriving")
	}
}

// TestDiagnosticsKeepsABoundedTail checks the stderr side of the same
// contract: lines are collected, capped, and never sent through the protocol
// dispatch — a RemoteBackend's diagnostics must never be mistaken for
// protocol content.
func TestDiagnosticsKeepsABoundedTail(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}
	t.Cleanup(func() { backend.finish(0) })

	for i := 0; i < maxDiagnosticLines+10; i++ {
		backend.writeStderr("line")
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		if len(client.Diagnostics()) == maxDiagnosticLines {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Diagnostics has %d lines, want %d", len(client.Diagnostics()), maxDiagnosticLines)
		}
		time.Sleep(5 * time.Millisecond)
	}

	for _, line := range client.Diagnostics() {
		if TypeOf(map[string]any{"t": line}) == OutInit {
			t.Fatal("a stderr line was mistaken for a protocol message type")
		}
	}
	// None of this reached Hooks.OnMessage.
	for _, message := range hooks.snapshot() {
		if TypeOf(message) == OutInit {
			t.Fatal("a diagnostic line reached the protocol dispatch")
		}
	}
}

// TestKillAndCloseReachTheBackend checks that Client.Kill and Client.Close
// forward to the Backend rather than assuming a local exec.Cmd exists — the
// regression this guards is a RemoteBackend's SSH session being leaked
// because Kill/Close only ever looked at a *exec.Cmd field.
func TestKillAndCloseReachTheBackend(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}

	client.Kill()
	if !backend.wasKilled() {
		t.Error("Client.Kill did not reach the backend")
	}
	backend.finish(0)
	client.Wait(2 * time.Second)

	_ = client.Close()
	if !backend.wasClosed() {
		t.Error("Client.Close did not reach the backend")
	}
}

// TestStartWithBackendReportsTheBackendsExitCode checks that an exit code the
// Backend reports as unknown (ok=false — a dropped connection with no exit
// status) is not quietly turned into a fabricated zero on this side.
func TestStartWithBackendReportsTheBackendsExitCode(t *testing.T) {
	hooks := &captureHooks{}
	client := NewClient(hooks)
	backend := newFakeBackend()
	backend.waitErr = nil

	if err := client.StartWithBackend(backend); err != nil {
		t.Fatalf("StartWithBackend: %v", err)
	}

	// hasCode stays false: this is the "connection dropped before the far end
	// said how it ended" case from RuntimeSession.Wait / exec.Cmd semantics.
	_ = backend.stdoutWriter.Close()
	_ = backend.stderrWriter.Close()
	close(backend.exited)

	client.Wait(2 * time.Second)
	code, _, ok := client.RuntimeExited()
	if !ok {
		t.Fatal("RuntimeExited reports ok=false after the backend exited")
	}
	if code != 0 {
		t.Errorf("code = %d, want 0 (the zero value Client started with, since the backend had none to report)", code)
	}
}
