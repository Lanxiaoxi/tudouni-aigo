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
func (c *Client) Start(arguments []string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	argv := append([]string{executable, "--runtime-stdio"}, arguments...)
	command := exec.Command(argv[0], argv[1:]...)
	command.Stderr = os.Stderr
	command.Env = os.Environ()

	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
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
		close(c.done)
	}()
	return nil
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
func (c *Client) Shutdown() { c.Send(map[string]any{"t": InShutdown}) }

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

// DefaultArguments are the flags this build passes to its own runtime child.
func DefaultArguments(sessionID string, stream, autopilot, debug bool) []string {
	var out []string
	if sessionID != "" {
		out = append(out, "--session", sessionID)
	}
	if stream {
		out = append(out, "--stream")
	} else {
		out = append(out, "--no-stream")
	}
	if autopilot {
		out = append(out, "--autopilot")
	}
	if debug {
		out = append(out, "--debug")
	}
	return out
}

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
