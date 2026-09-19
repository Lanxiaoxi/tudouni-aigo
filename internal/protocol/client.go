package protocol

import (
	"io"
	"os"
	"os/exec"
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
	command *exec.Cmd
	stdin   io.WriteCloser

	writeMu sync.Mutex
	done    chan struct{}
	code    int

	// exitMu guards the two fields below, which the wait goroutine writes while the
	// interface reads them.
	exitMu  sync.Mutex
	stopped bool
	codeSet bool
}

// NewClient prepares a client. Call Start to launch the runtime.
func NewClient(hooks Hooks) *Client {
	return &Client{hooks: hooks, done: make(chan struct{})}
}

// Start launches the runtime as a child process and begins reading.
//
// Three details in the launch are not decoration:
//
//  1. the **absolute path to this same executable**, not "tudouni" off PATH. A
//     different build on PATH would be a different program, and the symptom is
//     "the child exits immediately and I read EOF";
//  2. `--runtime-stdio`, which is the mode that speaks this protocol;
//  3. the working directory is inherited, which is what makes the workspace the
//     directory the user started in.
//
// The child's **stderr is drained and dropped**, and that is the fourth detail
// rather than an oversight. This client is used by full-screen front ends that own
// the terminal: `command.Stderr = os.Stderr` handed the child the same file
// descriptor the interface draws on, so every diagnostic it wrote landed inside the
// alternate screen and was erased by the next redraw — visible as corrupt frames,
// useless as a diagnostic. What a person must see travels as a notice instead (the
// runtime turns its own records into one), and the child's exit code still reaches
// them through runtimeExited: a runtime that dies at startup no longer does so
// silently.
func (c *Client) Start(arguments []string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	argv := append([]string{executable, "--runtime-stdio"}, arguments...)
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = os.Environ()

	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	// A pipe rather than io.Discard, and that distinction is the point: io.Discard
	// gives the child a closed descriptor, and a process that writes to a closed
	// stderr can fail in ways that have nothing to do with its own work. A pipe
	// keeps stderr usable and gives this side somewhere to read from, so the child
	// can never block on a full diagnostic buffer either.
	diagnostics, sink, err := os.Pipe()
	if err != nil {
		return err
	}
	command.Stderr = sink
	if err := command.Start(); err != nil {
		_ = diagnostics.Close()
		_ = sink.Close()
		return err
	}
	// The parent's copy of the write end has to go, or the read end below sees no
	// end of stream: the drain would sit there for the life of the process holding a
	// descriptor per runtime.
	_ = sink.Close()
	go drain(diagnostics)

	c.command = command
	c.stdin = stdin

	go c.readLoop(stdout)
	go func() {
		_ = command.Wait()
		c.writeMu.Lock()
		code := 0
		if command.ProcessState != nil {
			code = command.ProcessState.ExitCode()
		}
		c.code = code
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

// drain reads a child's diagnostics to the end, discarding them.
//
// Discarding is deliberate and so is reading them at all: the bytes are what the
// child would otherwise block on, and what they say has already been re-routed
// through the places a person can actually see it — the audit log, and the notice
// channel. See Start.
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
	return c.Wait(30 * time.Second)
}

// Kill ends the process without waiting for it.
//
// Forcing a kill is the last resort, not a way to interrupt: `messages` is only
// consistent between steps, so a kill mid-step can leave a session file with an
// assistant message whose tool results never arrived — and that session can never
// be sent again.
func (c *Client) Kill() {
	if c.command != nil && c.command.Process != nil {
		_ = c.command.Process.Kill()
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
