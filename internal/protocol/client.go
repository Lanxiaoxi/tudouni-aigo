package protocol

import (
	"io"
	"strings"
	"sync"
	"time"
)

// Hooks is what a front end has to implement.
//
// Three callbacks, and only one of them is interesting: `OnPermission` and
// `OnQuestion` may return "I will answer later", which is what lets an interactive
// interface draw a panel instead of blocking the thread that reads messages.
type Hooks interface {
	// OnMessage receives everything that does not need an answer: init,
	// session_load, event, ui, notice, sessions, delta, delta_reset.
	OnMessage(message map[string]any)
	// OnPermission answers one approval request. Returning ok=false means "my
	// interface will answer later" — it does **not** mean "refuse".
	OnPermission(request map[string]any) (decision string, ok bool)
	// OnQuestion answers one question. Same convention.
	OnQuestion(request map[string]any) (status, text string, ok bool)
}

// Client is a front end's connection to a runtime.
type Client struct {
	hooks   Hooks
	backend Backend
	stdin   io.WriteCloser

	writeMu sync.Mutex
	done    chan struct{}
	code    int

	// exitMu guards the two fields below, which the wait goroutine writes while the
	// interface reads them.
	exitMu  sync.Mutex
	stopped bool
	codeSet bool

	// diagMu guards diagnostics, the capped tail of the backend's stderr. It
	// exists for backends where stderr is not simply dropped — see
	// StartWithBackend's drain — and is nil-safe to read before any Start.
	diagMu      sync.Mutex
	diagnostics []string

	// readyMu guards the WaitReady bookkeeping below. See ready.go.
	readyMu    sync.Mutex
	readyDone  bool
	readySinks []chan map[string]any
}

// NewClient prepares a client. Call Start to launch the runtime.
func NewClient(hooks Hooks) *Client {
	return &Client{hooks: hooks, done: make(chan struct{})}
}

// Start launches the runtime as a child process on this machine and begins
// reading.
//
// This is the Local Backend path, and it is unchanged from what this method
// has always done — see LocalBackend's doc for the three details in the launch
// that are not decoration. Start is now a thin call onto StartWithBackend; the
// three details themselves live in LocalBackend so that a RemoteBackend
// (ssh.DialRuntimeSession and --runtime-stdio run on the far end) can share the
// rest of this type: readLoop, the protocol dispatch, every Client method
// below.
//
// The child's **stderr is drained and dropped**, same as always, and for the
// same reason recorded there: a full-screen front end owns the terminal, and a
// diagnostic written to it would land inside the alternate screen and vanish on
// the next redraw. What a person must see still travels as a notice instead.
func (c *Client) Start(arguments []string) error {
	return c.StartWithBackend(NewLocalBackend(arguments))
}

// StartWithBackend launches the runtime through the given Backend and begins
// reading its protocol stream.
//
// Everything from here down is backend-agnostic, which is the point of the
// seam: whether stdin/stdout/stderr came from a local exec.Cmd or from a plain
// SSH session makes no difference to the JSONL loop, the permission/question
// routing, or any method on Client. A Backend's only two obligations are
// stated on the interface itself — stdout carries the protocol exclusively,
// and stderr is diagnostics only — and this method trusts both.
func (c *Client) StartWithBackend(backend Backend) error {
	stdin, stdout, stderr, err := backend.Start()
	if err != nil {
		return err
	}

	c.backend = backend
	c.stdin = stdin

	go c.drainDiagnostics(stderr)
	go c.readLoop(stdout)
	go func() {
		code, ok, _ := backend.Wait()
		c.writeMu.Lock()
		if ok {
			c.code = code
		}
		c.writeMu.Unlock()

		c.exitMu.Lock()
		c.codeSet = true
		stopped := c.stopped
		c.exitMu.Unlock()

		close(c.done)
		// Told, not just recorded: a runtime that died is something the interface has
		// to be able to say. When the front end asked for the shutdown this is the
		// ordinary end of a session and there is nothing to report.
		//
		// The message goes through `OnMessage` so that a front end needs to know only
		// one callback to be told everything; the exit code is read back with
		// RuntimeExited, which is why this carries no payload of its own.
		if !stopped && c.hooks != nil {
			c.hooks.OnMessage(map[string]any{"v": VERSION, "t": OutRuntimeExited})
		}
	}()
	return nil
}

// drainDiagnostics reads a backend's stderr to the end, discarding the bytes
// but keeping a bounded tail for Diagnostics.
//
// Discarding is deliberate and so is reading them at all: the bytes are what
// the far end would otherwise block on, and what they say has already been
// re-routed through the places a person can actually see it — the audit log
// and the notice channel, for a local runtime; for a remote one, Diagnostics is
// that place, since there is no audit log on this side of the connection yet.
func (c *Client) drainDiagnostics(reader io.Reader) {
	lineReader := newDiagnosticLineReader(reader)
	for {
		line, ok := lineReader.next()
		if !ok {
			return
		}
		c.diagMu.Lock()
		c.diagnostics = append(c.diagnostics, line)
		if len(c.diagnostics) > maxDiagnosticLines {
			c.diagnostics = c.diagnostics[len(c.diagnostics)-maxDiagnosticLines:]
		}
		c.diagMu.Unlock()
	}
}

// maxDiagnosticLines bounds how much of a backend's stderr Diagnostics keeps.
// It exists for the remote case the design calls for — "save limited-length
// diagnostic logs" — and the cap is lines, not bytes, because a single
// pathological line (a stack trace with no newlines) should not be allowed to
// exhaust it on its own; see diagnosticLineReader for how a too-long line is
// still bounded in bytes.
const maxDiagnosticLines = 200

// Diagnostics returns the backend's most recent stderr lines, oldest first,
// up to maxDiagnosticLines. It is empty for a runtime that has written nothing
// to stderr, which is the ordinary case for a healthy local runtime.
func (c *Client) Diagnostics() []string {
	c.diagMu.Lock()
	defer c.diagMu.Unlock()
	out := make([]string, len(c.diagnostics))
	copy(out, c.diagnostics)
	return out
}

// drain reads a reader to the end, discarding the bytes. It is kept for its
// existing test (TestTheDiagnosticsDrainEmptiesAndCloses in
// client_stdio_test.go), which pins the same "read to the end, then close"
// contract that drainDiagnostics now applies per line rather than in bulk.
func drain(reader io.Reader) {
	_, _ = io.Copy(io.Discard, reader)
	if closer, ok := reader.(io.Closer); ok {
		_ = closer.Close()
	}
}

// RuntimeExited reports how the runtime process ended, and whether that ending was
// the front end's own request.
//
// `stopped` is true only after Shutdown asked the runtime to finish, which is what
// separates "the session is over" from "the runtime died": an exit code alone cannot
// tell them apart, because a runtime that ends because its stdin closed also leaves
// with zero.
func (c *Client) RuntimeExited() (code int, stopped bool, ok bool) {
	c.exitMu.Lock()
	defer c.exitMu.Unlock()
	return c.code, c.stopped, c.codeSet
}

func (c *Client) readLoop(stdout io.Reader) {
	reader := NewLineReader(stdout, DirectionFromRuntime)
	for {
		message, ok := reader.Next()
		if !ok {
			return
		}
		c.dispatch(message)
	}
}

func (c *Client) dispatch(message map[string]any) {
	c.deliverFirstMessage(message)
	switch TypeOf(message) {
	case OutPermissionRequest:
		decision, ok := c.hooks.OnPermission(message)
		if ok {
			id, _ := String(message, "id")
			c.AnswerPermission(id, decision)
		}
		// ok=false means the interface is drawing a panel. It is not a refusal,
		// and the runtime is still waiting: a fallback answer here would be sent
		// immediately and recorded in the audit as a decision the user never made.
	case OutQuestionRequest:
		status, text, ok := c.hooks.OnQuestion(message)
		if ok {
			id, _ := String(message, "id")
			c.AnswerQuestion(id, status, text)
		}
	default:
		c.hooks.OnMessage(message)
	}
}

// Send writes one message to the runtime.
func (c *Client) Send(message map[string]any) {
	message["v"] = VERSION
	line := MustEncode(message)
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.stdin != nil {
		_, _ = io.WriteString(c.stdin, line)
	}
}

// UserMessage asks the runtime to run one turn.
func (c *Client) UserMessage(text string) {
	c.Send(map[string]any{"t": InUserMessage, "text": text})
}

// AnswerPermission answers a request, after the interface decided.
func (c *Client) AnswerPermission(id, decision string) {
	c.Send(map[string]any{"t": InPermissionResponse, "id": id, "decision": decision})
}

// AnswerQuestion answers a question, after the interface decided.
func (c *Client) AnswerQuestion(id, status, text string) {
	c.Send(map[string]any{"t": InQuestionResponse, "id": id, "status": status, "text": text})
}

// Interrupt stops the current turn.
func (c *Client) Interrupt() { c.Send(map[string]any{"t": InInterrupt}) }

// SwitchSession moves to another session without restarting.
func (c *Client) SwitchSession(sessionID string) {
	c.Send(map[string]any{"t": InSessionSwitch, "session_id": sessionID})
}

// ListSessions asks for the session list.
func (c *Client) ListSessions() { c.Send(map[string]any{"t": InSessionList}) }

// SetAutopilot switches the "do not ask" mode.
func (c *Client) SetAutopilot(on bool) {
	c.Send(map[string]any{"t": InSetAutopilot, "on": on})
}

// SetModel switches the model for this session.
func (c *Client) SetModel(name string) {
	c.Send(map[string]any{"t": InSetModel, "model": name})
}

// SetThinking switches thinking mode.
func (c *Client) SetThinking(on bool) {
	c.Send(map[string]any{"t": InSetThinking, "on": on})
}

// SetEffort changes the thinking effort.
func (c *Client) SetEffort(level string) {
	c.Send(map[string]any{"t": InSetEffort, "effort": level})
}

// AskStatus requests the status screen.
func (c *Client) AskStatus() { c.Send(map[string]any{"t": InStatus}) }

// AskTools requests the tool list.
func (c *Client) AskTools() { c.Send(map[string]any{"t": InTools}) }

// AskContext requests the context ledger.
func (c *Client) AskContext() { c.Send(map[string]any{"t": InContext}) }

// Compact asks for the history to be folded once.
func (c *Client) Compact() { c.Send(map[string]any{"t": InCompact}) }

// ListSkills asks for this session's skill catalogue.
func (c *Client) ListSkills() { c.Send(map[string]any{"t": InSkills}) }

// MCP asks about or changes MCP mounts.
func (c *Client) MCP(action string, servers []string) {
	message := map[string]any{"t": InMCP, "action": action}
	if servers != nil {
		message["servers"] = servers
	}
	c.Send(message)
}

// Goal sends a command about the session's goal.
//
// An empty action asks for the current state and changes nothing, which is what
// `/goal` with no argument means.
func (c *Client) Goal(action string) {
	message := map[string]any{"t": InGoal}
	if action != "" {
		message["action"] = action
	}
	c.Send(message)
}

// RefreshState asks for a fresh panel snapshot.
//
// It is sent only when the interface knows something is outstanding, and throttled
// when it does. It is not a heartbeat: the message exists for the quiet moments,
// and a poll with no reason dilutes that reason away.
func (c *Client) RefreshState() { c.Send(map[string]any{"t": InRefreshState}) }

// ListFiles asks for one directory level of the workspace.
//
// An empty path means the workspace root, which is the same value the protocol
// uses for "the workspace itself" — there is no second spelling to keep in step.
func (c *Client) ListFiles(path string) {
	c.Send(map[string]any{"t": InFileList, "path": path})
}

// ReadFile asks for one file. The answer carries a preview and an artifact
// reference; the whole body stays on disk.
func (c *Client) ReadFile(path string) {
	c.Send(map[string]any{"t": InFileRead, "path": path})
}

// ListTerminals asks for the workspace's terminals.
func (c *Client) ListTerminals() { c.Send(map[string]any{"t": InTerminalList}) }

// CreateTerminal asks for a new shell. An empty cwd means the workspace root; a
// size of zero means "the conventional 80x24", which the runtime applies.
func (c *Client) CreateTerminal(cwd string, cols, rows int) {
	message := map[string]any{"t": InTerminalCreate}
	if cwd != "" {
		message["cwd"] = cwd
	}
	if cols > 0 && rows > 0 {
		message["cols"] = cols
		message["rows"] = rows
	}
	c.Send(message)
}

// TerminalInput writes raw bytes to a terminal.
//
// **There is no reply.** The output arrives as `ui` / `kind=terminal_output`
// messages on its own schedule, which is why this returns nothing: a caller that
// waited for a response would wait forever on a command that prints nothing, and
// would have no way to show a prompt waiting for input.
func (c *Client) TerminalInput(id, data string) {
	c.Send(map[string]any{"t": InTerminalInput, "terminal_id": id, "data": data})
}

// TerminalResize tells the runtime the terminal's new size.
func (c *Client) TerminalResize(id string, cols, rows int) {
	c.Send(map[string]any{
		"t": InTerminalResize, "terminal_id": id, "cols": cols, "rows": rows,
	})
}

// TerminalKill ends a terminal and everything it started.
func (c *Client) TerminalKill(id string) {
	c.Send(map[string]any{"t": InTerminalKill, "terminal_id": id})
}

// TerminalClose forgets a terminal that has already ended, so it stops appearing
// in the list.
//
// A separate message from TerminalKill rather than a flag on it: ending a shell
// and dropping the record of it are two different acts, and the runtime refuses
// the second for a terminal that still needs the first. The answer is a fresh
// full list.
func (c *Client) TerminalClose(id string) {
	c.Send(map[string]any{"t": InTerminalClose, "terminal_id": id})
}

// Shutdown asks the runtime to finish and exit.
//
// The current turn finishes first; this does not interrupt it. Interrupting would
// leave an assistant message with tool_calls and no results behind, and that makes
// the session permanently unsendable.
//
// It also records that the ending was asked for, which is what keeps RuntimeExited
// from reporting an ordinary exit as a death.
func (c *Client) Shutdown() {
	c.exitMu.Lock()
	c.stopped = true
	c.exitMu.Unlock()
	c.Send(map[string]any{"t": InShutdown})
}

// Wait blocks until the runtime exits, up to the timeout, then kills it.
func (c *Client) Wait(timeout time.Duration) int {
	select {
	case <-c.done:
	case <-time.After(timeout):
		c.Kill()
		<-c.done
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.code
}

// Close asks the runtime to finish and waits, then makes sure it is gone.
func (c *Client) Close() int {
	c.Shutdown()
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	code := c.Wait(30 * time.Second)
	// Backend.Close releases whatever the backend holds beyond the process
	// itself. For LocalBackend this is a no-op; for RemoteBackend it is the
	// step that actually ends the SSH session and the connection beneath it —
	// the "release SSH resources" the design calls for on normal shutdown.
	if c.backend != nil {
		_ = c.backend.Close()
	}
	return code
}

// Kill ends the process without waiting for it.
//
// Forcing a kill is the last resort, not a way to interrupt: `messages` is only
// consistent between steps, so a kill mid-step can leave a session file with an
// assistant message whose tool results never arrived — and that session can never
// be sent again.
//
// For a RemoteBackend this ends the SSH session (and attempts a remote
// signal first; see RuntimeSession.Kill) rather than a local process, which is
// why Kill is a Backend method and Client only forwards to it.
func (c *Client) Kill() {
	if c.backend != nil {
		_ = c.backend.Kill()
	}
}

// ChildEnv is the environment for a child runtime. Go has no encoding problem to
// solve here — the streams are bytes and the protocol is UTF-8 — but keeping the
// function makes the launch contract explicit and greppable.
func ChildEnv(base []string) []string { return base }

// ParseSessionID pulls the session id out of a `--session` style argument list.
func ParseSessionID(arguments []string) string {
	for index, argument := range arguments {
		if argument == "--session" && index+1 < len(arguments) {
			return arguments[index+1]
		}
		if strings.HasPrefix(argument, "--session=") {
			return strings.TrimPrefix(argument, "--session=")
		}
	}
	return ""
}
