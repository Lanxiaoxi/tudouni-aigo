package protocol

import (
	"strings"
	"testing"
	"time"
)

// terminalStub is a runtime with the two workspace capabilities, so the server's
// dispatch can be driven without a shell or a disk.
//
// It implements **both** optional interfaces, which is what makes it useful here:
// the half of these handlers worth testing is the translation, and that only
// happens when the runtime claims to have the feature.
type terminalStub struct {
	stubRuntime

	files     map[string]map[string]any
	terminals []map[string]any
	// created is the row the next CreateTerminal answers with, or the error.
	createRow   map[string]any
	createErr   error
	lastCwd     string
	lastCols    int
	lastRows    int
	inputs      []string
	resizes     [][2]int
	killed      []string
	readFailure error
}

func (s *terminalStub) ListFiles(path string) (map[string]any, error) {
	payload, ok := s.files[path]
	if !ok {
		return nil, &stubError{"no such path in this workspace: " + path}
	}
	return payload, nil
}

func (s *terminalStub) ReadFile(path string) (map[string]any, error) {
	if s.readFailure != nil {
		return nil, s.readFailure
	}
	return map[string]any{
		"path": path, "artifact_id": "art_x", "content": "package main\n",
		"chars": 13, "bytes": 13, "truncated": false, "total_lines": 2,
	}, nil
}

func (s *terminalStub) ListTerminals() []map[string]any {
	if s.terminals == nil {
		return []map[string]any{}
	}
	return s.terminals
}

func (s *terminalStub) CreateTerminal(cwd string, cols, rows int) (map[string]any, error) {
	s.lastCwd, s.lastCols, s.lastRows = cwd, cols, rows
	if s.createErr != nil {
		return nil, s.createErr
	}
	if s.createRow == nil {
		return map[string]any{"id": "term-01", "status": "running"}, nil
	}
	return s.createRow, nil
}

func (s *terminalStub) TerminalInput(id, data string) error {
	s.inputs = append(s.inputs, id+"\x00"+data)
	return nil
}

func (s *terminalStub) TerminalResize(id string, cols, rows int) error {
	s.resizes = append(s.resizes, [2]int{cols, rows})
	return nil
}

func (s *terminalStub) TerminalKill(id string) error {
	s.killed = append(s.killed, id)
	return nil
}

type stubError struct{ text string }

func (e *stubError) Error() string { return e.text }

// driveServer runs one inbound message through a fresh server over a stub runtime.
func driveServer(t *testing.T, runtime Runtime, inbound map[string]any) string {
	t.Helper()
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.Attach(runtime)
	server.Dispatch(inbound)
	return output.String()
}

// decodeAll turns every line the server wrote into messages.
func decodeAll(t *testing.T, raw string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		message, err := Decode(line)
		if err != nil {
			t.Fatalf("the server wrote a line that does not decode: %v (%s)", err, line)
		}
		out = append(out, message)
	}
	return out
}

// onlyMessage returns the single message the server sent, failing if there is not
// exactly one.
//
// Exactly one is the point: a handler that answered twice, or that followed its
// answer with a snapshot nobody asked for, would pass a "does it contain X" test
// while sending a front end two messages for one request.
func onlyMessage(t *testing.T, raw string) map[string]any {
	t.Helper()
	messages := decodeAll(t, raw)
	if len(messages) != 1 {
		t.Fatalf("the server sent %d messages, want 1: %v", len(messages), messages)
	}
	return messages[0]
}

func TestFileListAnswersWithTheRuntimesPayload(t *testing.T) {
	runtime := &terminalStub{files: map[string]map[string]any{
		"": {"path": "", "entries": []any{
			map[string]any{"name": "src", "path": "src", "type": "directory", "size": 0},
		}},
	}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InFileList,
	}))

	if TypeOf(message) != OutUI {
		t.Fatalf("type = %q, want %q", TypeOf(message), OutUI)
	}
	if kind, _ := String(message, "kind"); kind != UIFiles {
		t.Errorf("kind = %q, want %q", kind, UIFiles)
	}
	// The runtime's own payload travels unchanged; this layer adds the envelope
	// and must not reshape the body it does not understand.
	if path, _ := String(message, "path"); path != "" {
		t.Errorf("path = %q, want the empty string for the workspace root", path)
	}
	entries, _ := message["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v, want one row", message["entries"])
	}
}

func TestFileReadWithoutAPathIsRefusedRatherThanGuessed(t *testing.T) {
	runtime := &terminalStub{}
	// An absent directory means "the root", but an absent *file* name means the
	// request does not say what to read. Guessing would make a dropped argument
	// look like a successful read of a file nobody named.
	for _, inbound := range []map[string]any{
		{"v": VERSION, "t": InFileRead},
		{"v": VERSION, "t": InFileRead, "path": ""},
	} {
		message := onlyMessage(t, driveServer(t, runtime, inbound))
		if TypeOf(message) != OutNotice {
			t.Errorf("type = %q, want a notice", TypeOf(message))
		}
		if level, _ := String(message, "level"); level != "warn" {
			t.Errorf("level = %q, want warn", level)
		}
	}
}

func TestFileReadCarriesTheArtifactReference(t *testing.T) {
	runtime := &terminalStub{}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InFileRead, "path": "src/main.go",
	}))
	if kind, _ := String(message, "kind"); kind != UIFileRead {
		t.Fatalf("kind = %q, want %q", kind, UIFileRead)
	}
	// The reference is what keeps the protocol from becoming a file-transfer
	// mechanism: the preview draws immediately and the body stays on disk.
	if id, _ := String(message, "artifact_id"); id != "art_x" {
		t.Errorf("artifact_id = %q, want art_x", id)
	}
	if path, _ := String(message, "path"); path != "src/main.go" {
		t.Errorf("path = %q, want src/main.go", path)
	}
}

func TestFileFailureIsAnoticeNotAnEmptyAnswer(t *testing.T) {
	runtime := &terminalStub{}
	// An empty directory listing and "this path does not exist" look identical on
	// screen, and the second one is what a person needs to be told.
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InFileList, "path": "nope",
	}))
	if TypeOf(message) != OutNotice {
		t.Fatalf("type = %q, want a notice", TypeOf(message))
	}
	text, _ := String(message, "text")
	if !strings.Contains(text, "nope") {
		t.Errorf("the notice does not name the path: %q", text)
	}
}

// TestAWorkspaceMessageWithNoRuntimeSaysSo covers the case a front end hits after
// a session ends. It is the branch that a "just return an empty list" shortcut
// would swallow, and the symptom would be a file tree that is empty rather than a
// sentence saying there is no session.
func TestAWorkspaceMessageWithNoRuntimeSaysSo(t *testing.T) {
	for _, kind := range []string{InFileList, InTerminalList, InTerminalCreate} {
		message := onlyMessage(t, driveServer(t, nil, map[string]any{"v": VERSION, "t": kind}))
		if TypeOf(message) != OutNotice {
			t.Errorf("%s with no runtime answered %q, want a notice", kind, TypeOf(message))
		}
	}
}

// TestWorkspaceMessagesSaysUnsupportedWhenTheRuntimeCannot covers the second
// absence, which is a different problem with a different remedy: the runtime exists
// but this build cannot do the thing.
func TestWorkspaceMessagesSaysUnsupportedWhenTheRuntimeCannot(t *testing.T) {
	// plainStub has no FileService and no TerminalService.
	plain := &stubRuntime{}
	for _, kind := range []string{InFileList, InTerminalList, InTerminalCreate, InTerminalKill} {
		message := onlyMessage(t, driveServer(t, plain, map[string]any{"v": VERSION, "t": kind}))
		if TypeOf(message) != OutNotice {
			t.Errorf("%s against a runtime without the feature answered %q, want a notice", kind, TypeOf(message))
			continue
		}
		if code, _ := String(message, "code"); code != "files" && code != "terminal" {
			t.Errorf("%s notice code = %q, want files or terminal", kind, code)
		}
	}
}

func TestTerminalListAlwaysSendsAnArray(t *testing.T) {
	runtime := &terminalStub{}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalList,
	}))
	if kind, _ := String(message, "kind"); kind != UITerminals {
		t.Fatalf("kind = %q, want %q", kind, UITerminals)
	}
	// `[]` and never null: a front end that has to tell "there are none" from "the
	// runtime did not say" has two cases to draw where one is correct.
	rows, ok := message["terminals"].([]any)
	if !ok {
		t.Fatalf("terminals = %T, want an array even when empty", message["terminals"])
	}
	if len(rows) != 0 {
		t.Errorf("terminals = %v, want an empty array", rows)
	}
}

func TestTerminalCreateAppliesTheConventionalSizeWhenTheClientDoesNotSay(t *testing.T) {
	runtime := &terminalStub{}
	onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalCreate,
	}))
	if runtime.lastCols != TerminalDefaultCols || runtime.lastRows != TerminalDefaultRows {
		t.Errorf("size = %dx%d, want the default %dx%d",
			runtime.lastCols, runtime.lastRows, TerminalDefaultCols, TerminalDefaultRows)
	}
	if runtime.lastCwd != "" {
		t.Errorf("cwd = %q, want the empty string for the workspace root", runtime.lastCwd)
	}
}

func TestTerminalCreateAnswersWithTheCreatedRow(t *testing.T) {
	runtime := &terminalStub{createRow: map[string]any{
		"id": "term-01", "cwd": "backend", "shell": "pwsh", "pid": 42,
		"status": "running", "exit_code": nil,
	}}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalCreate, "cwd": "backend", "cols": 120, "rows": 40,
	}))
	if kind, _ := String(message, "kind"); kind != UITerminalCreated {
		t.Fatalf("kind = %q, want %q", kind, UITerminalCreated)
	}
	if id, _ := String(message, "terminal_id"); id != "term-01" {
		t.Errorf("terminal_id = %q, want term-01", id)
	}
	row, _ := message["terminal"].(map[string]any)
	if row == nil || row["id"] != "term-01" {
		t.Errorf("terminal = %v, want the created row", message["terminal"])
	}
	if runtime.lastCols != 120 || runtime.lastRows != 40 {
		t.Errorf("size = %dx%d, want 120x40", runtime.lastCols, runtime.lastRows)
	}
}

// TestTerminalCreateFailureSendsTheUnchangedList is the design's two-outcome rule.
//
// A failure is **not** answered with a created row carrying an error: a front end
// given a row would remember an id for a shell that does not exist and would then
// send input to it. It gets a sentence and the list, which is what tells it
// nothing changed.
func TestTerminalCreateFailureSendsTheUnchangedList(t *testing.T) {
	runtime := &terminalStub{
		createErr: &stubError{"no such directory in this workspace: nope"},
		terminals: []map[string]any{{"id": "term-01", "status": "running"}},
	}
	messages := decodeAll(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalCreate, "cwd": "nope",
	}))
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want a notice and the list: %v", len(messages), messages)
	}
	if TypeOf(messages[0]) != OutNotice {
		t.Errorf("first message is %q, want the notice first", TypeOf(messages[0]))
	}
	if kind, _ := String(messages[1], "kind"); kind != UITerminals {
		t.Errorf("second message kind = %q, want %q", kind, UITerminals)
	}
	rows, _ := messages[1]["terminals"].([]any)
	if len(rows) != 1 {
		t.Errorf("the list was not sent unchanged: %v", messages[1]["terminals"])
	}
	// And no `terminal_created` was sent at all — that is the assertion that
	// matters, because it is the message a front end would act on.
	for _, message := range messages {
		if kind, _ := String(message, "kind"); kind == UITerminalCreated {
			t.Error("a failed create sent a terminal_created")
		}
	}
}

// TestTerminalInputIsSilentOnSuccess is the asynchronous shape.
//
// A reply here would tell a front end the write was accepted and nothing about what
// it did, and a front end that waited for one would never show a prompt — because
// most terminal input produces no output at all.
func TestTerminalInputIsSilentOnSuccess(t *testing.T) {
	runtime := &terminalStub{}
	raw := driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalInput, "terminal_id": "term-01", "data": "npm test\r",
	})
	if strings.TrimSpace(raw) != "" {
		t.Errorf("terminal_input answered with %q; it must be silent on success", raw)
	}
	// The bytes travel verbatim, including the carriage return: nothing here
	// parses a command.
	if len(runtime.inputs) != 1 || runtime.inputs[0] != "term-01\x00npm test\r" {
		t.Errorf("inputs = %q, want the raw bytes passed through", runtime.inputs)
	}
}

func TestTerminalInputPassesControlCharactersThrough(t *testing.T) {
	runtime := &terminalStub{}
	for _, data := range []string{"\x03", "\x04", "\t", "\x1b[A", "\x1b"} {
		driveServer(t, runtime, map[string]any{
			"v": VERSION, "t": InTerminalInput, "terminal_id": "term-01", "data": data,
		})
	}
	want := []string{
		"term-01\x00\x03", "term-01\x00\x04", "term-01\x00\t",
		"term-01\x00\x1b[A", "term-01\x00\x1b",
	}
	if len(runtime.inputs) != len(want) {
		t.Fatalf("got %d inputs, want %d: %q", len(runtime.inputs), len(want), runtime.inputs)
	}
	for index, expected := range want {
		if runtime.inputs[index] != expected {
			t.Errorf("input %d = %q, want %q", index, runtime.inputs[index], expected)
		}
	}
}

func TestTerminalInputWithoutAnIdIsRefused(t *testing.T) {
	runtime := &terminalStub{}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalInput, "data": "x",
	}))
	if TypeOf(message) != OutNotice {
		t.Errorf("type = %q, want a notice", TypeOf(message))
	}
	if len(runtime.inputs) != 0 {
		t.Errorf("input was forwarded without an id: %q", runtime.inputs)
	}
}

func TestTerminalResizeNeedsBothNumbers(t *testing.T) {
	runtime := &terminalStub{}
	for _, inbound := range []map[string]any{
		{"v": VERSION, "t": InTerminalResize, "terminal_id": "term-01", "cols": 120},
		{"v": VERSION, "t": InTerminalResize, "terminal_id": "term-01", "rows": 40},
	} {
		message := onlyMessage(t, driveServer(t, runtime, inbound))
		if TypeOf(message) != OutNotice {
			t.Errorf("a half-specified resize answered %q, want a notice", TypeOf(message))
		}
	}
	if len(runtime.resizes) != 0 {
		t.Errorf("a half-specified resize reached the runtime: %v", runtime.resizes)
	}

	// A successful resize is **silent**, like terminal_input: the runtime is the
	// only source of truth for the size, and it reports it back on the next
	// snapshot rather than answering every drag of a window splitter.
	raw := driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalResize, "terminal_id": "term-01", "cols": 120, "rows": 40,
	})
	if strings.TrimSpace(raw) != "" {
		t.Errorf("a successful resize answered with %q", raw)
	}
	if len(runtime.resizes) != 1 || runtime.resizes[0] != [2]int{120, 40} {
		t.Errorf("resizes = %v, want one 120x40", runtime.resizes)
	}
}

func TestTerminalResizeWithoutAnIdIsRefused(t *testing.T) {
	runtime := &terminalStub{}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalResize, "cols": 120, "rows": 40,
	}))
	if TypeOf(message) != OutNotice {
		t.Errorf("type = %q, want a notice", TypeOf(message))
	}
	if len(runtime.resizes) != 0 {
		t.Errorf("a resize with no id reached the runtime: %v", runtime.resizes)
	}
}

// TestTerminalKillDoesNotAnswerWithAnExit is the "runtime is the only source of
// truth" rule stated as a test.
//
// The ending travels out as the `terminal_exit` event the manager produces for
// every ending. Answering here would be a second truth, and the two would disagree
// the first time a process refused to die.
func TestTerminalKillDoesNotAnswerWithAnExit(t *testing.T) {
	runtime := &terminalStub{}
	raw := driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTerminalKill, "terminal_id": "term-01",
	})
	if strings.TrimSpace(raw) != "" {
		t.Errorf("terminal_kill answered with %q; the exit event is the answer", raw)
	}
	if len(runtime.killed) != 1 || runtime.killed[0] != "term-01" {
		t.Errorf("killed = %v, want one term-01", runtime.killed)
	}
}

// TestTerminalEventsReachTheWire is the end-to-end check of the output path.
//
// It exercises `SendTerminalEvent` directly rather than through a real shell, and
// that is the right level for this test: what is being checked is that an event
// body from the runtime becomes a `ui` message with an envelope, on the right
// transport. That a real PTY produces those events is the terminal package's
// business and is tested there against an actual shell.
func TestTerminalEventsReachTheWire(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})

	// What runtime.terminalEventPayload produces for an output batch.
	server.SendTerminalEvent(map[string]any{
		"kind": UITerminalOutput, "terminal_id": "term-01", "data": "npm test\r\n",
	})

	message := lastMessage(t, output.String())
	if message == nil {
		t.Fatal("nothing reached the transport")
	}
	if TypeOf(message) != OutUI {
		t.Fatalf("type = %q, want %q", TypeOf(message), OutUI)
	}
	if version, _ := Int(message, "v"); version != VERSION {
		t.Errorf("v = %v, want %d", message["v"], VERSION)
	}
	if kind, _ := String(message, "kind"); kind != UITerminalOutput {
		t.Errorf("kind = %q, want %q", kind, UITerminalOutput)
	}
	if data, _ := String(message, "data"); data != "npm test\r\n" {
		t.Errorf("data = %q, want the raw batch", data)
	}
}

// TestSendTerminalEventDropsAnUnknownBody covers the nil payload, which is what an
// event kind this build does not know produces. Writing a line for it would be a
// message no front end can parse.
func TestSendTerminalEventDropsAnUnknownBody(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.SendTerminalEvent(nil)
	if strings.TrimSpace(output.String()) != "" {
		t.Errorf("a nil payload produced %q", output.String())
	}
}

// TestTerminalEventsAreNotCrowdedBySnapshots pins the high-frequency path: an
// output batch must produce exactly one line, because it is the message that is
// sent thousands of times.
func TestTerminalEventsAreNotCrowdedBySnapshots(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	for index := 0; index < 5; index++ {
		server.SendTerminalEvent(map[string]any{
			"kind": UITerminalOutput, "terminal_id": "term-01", "data": "x",
		})
	}
	messages := decodeAll(t, output.String())
	if len(messages) != 5 {
		t.Fatalf("five batches produced %d messages", len(messages))
	}
	for _, message := range messages {
		if kind, _ := String(message, "kind"); kind != UITerminalOutput {
			t.Errorf("a batch was accompanied by a %q message", kind)
		}
	}
}

// TestTheTerminalSurfaceIsOptional is the interface check: the token runtime the
// rest of this package's tests use must NOT accidentally satisfy TerminalService,
// or the "unsupported" branch would be dead code that looks tested.
func TestTheTerminalSurfaceIsOptional(t *testing.T) {
	var plain Runtime = &stubRuntime{}
	if _, ok := plain.(TerminalService); ok {
		t.Error("stubRuntime satisfies TerminalService; it must not, so the unsupported branch is reachable")
	}
	if _, ok := plain.(FileService); ok {
		t.Error("stubRuntime satisfies FileService; it must not")
	}
	var full Runtime = &terminalStub{}
	if _, ok := full.(TerminalService); !ok {
		t.Error("terminalStub does not satisfy TerminalService")
	}
	if _, ok := full.(FileService); !ok {
		t.Error("terminalStub does not satisfy FileService")
	}
}

// TestWorkspaceHandlersDoNotBlockOnASlowRuntime is a guard on the one rule that
// keeps a terminal usable.
//
// Writing to a PTY can block, so the *runtime* owns the write side (see
// `terminal.inputQueue`); this layer must never wait on anything but the transport.
// The assertion here is modest but real: dispatching a batch of input completes
// promptly even though the stub's Input does nothing.
func TestWorkspaceHandlersDoNotBlockOnASlowRuntime(t *testing.T) {
	runtime := &terminalStub{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for index := 0; index < 200; index++ {
			server := NewServer(OpenStreams(strings.NewReader(""), &safeBuffer{}), Bootstrap{})
			server.Attach(runtime)
			server.Dispatch(map[string]any{
				"v": VERSION, "t": InTerminalInput, "terminal_id": "term-01", "data": "x",
			})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatching terminal input did not complete; something in this path blocks")
	}
}
