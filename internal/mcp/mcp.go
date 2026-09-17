// Package mcp speaks the Model Context Protocol to servers the user configured.
//
// A hand-written JSON-RPC client, no SDK: the protocol subset this needs is
// small, and the transport is the part that has to be understood anyway — a stdio
// server is a child process whose stdout is a message stream, which is not a
// detail an SDK can hide.
//
// Two things in here are security boundaries rather than plumbing:
//
//   - **Every tool from a server is high risk and every call is approved.** The
//     side effects of an external tool cannot be verified at runtime and there is
//     no configuration that could make them safe, so the risk level is fixed
//     rather than configurable.
//   - **`where` is redacted for remote servers.** A local server's command line
//     would leak the paths it was started with, so it reports nothing; a remote
//     one reports `scheme://host` and stops there.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
)

// Protocol constants.
const (
	// NamePrefix marks a tool as coming from a server, so a person reading a
	// permission prompt can tell an external tool from a built-in one at a glance.
	NamePrefix = "mcp__"
	// Separator divides the server name from the tool name.
	Separator = "__"
	// ProtocolVersion is the revision this client implements.
	ProtocolVersion = "2024-11-05"
	// DefaultTimeoutSeconds is how long a request waits.
	DefaultTimeoutSeconds = 60.0
	// MinTimeoutSeconds and MaxTimeoutSeconds bound a configured timeout.
	MinTimeoutSeconds = 1.0
	// MaxTimeoutSeconds bounds it from above.
	MaxTimeoutSeconds = 600.0
	// MaxListPages stops a tools/list that keeps handing out pages.
	MaxListPages = 50
	// ShutdownGraceSeconds is how long a process gets to exit on its own.
	ShutdownGraceSeconds = 5.0
	// ToolNameMax is the length limit for an exposed tool name.
	ToolNameMax = 64
	// MaxBodyBytes caps an HTTP response body.
	MaxBodyBytes = 8 << 20
)

// ServerNamePattern is the only shape a server name may take. It is strict because
// the name is spliced into every tool name the model sees.
var ServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,24}$`)

// McpError is a protocol-level failure.
type McpError struct{ Message string }

func (e McpError) Error() string { return e.Message }

// McpTimeout means no answer arrived in time.
type McpTimeout struct{ Message string }

func (e McpTimeout) Error() string { return e.Message }

// McpServerDown means the process or connection is gone.
type McpServerDown struct{ Message string }

func (e McpServerDown) Error() string { return e.Message }

// McpToolError means the tool ran and reported a failure.
type McpToolError struct{ Message string }

func (e McpToolError) Error() string { return e.Message }

// McpConfigError is a configuration problem: it is the user's to fix.
type McpConfigError struct{ Message string }

func (e McpConfigError) Error() string { return e.Message }

// Channel is one transport. Two implementations exist: a child process and an HTTP
// endpoint. Everything above this line is transport-agnostic.
type Channel interface {
	Request(method string, params map[string]any, timeout time.Duration) (map[string]any, error)
	Notify(method string, params map[string]any) error
	Close() error
	// Where is the redacted location. Empty for a local server.
	Where() string
}

// --- stdio ------------------------------------------------------------------

// StdioChannel runs a server as a child process and speaks JSON-RPC over its
// stdin and stdout, one message per line.
//
// stderr is **not** captured: a server's logging belongs to the person running it,
// and swallowing it would hide the only diagnostic channel available when a server
// misbehaves.
type StdioChannel struct {
	name    string
	command string
	args    []string
	env     map[string]string

	process *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader

	mu      sync.Mutex
	pending map[int64]chan map[string]any
	nextID  int64
	closed  bool
	err     error

	writeMu sync.Mutex
}

// NewStdioChannel prepares a stdio channel. It does not start anything.
func NewStdioChannel(name, command string, args []string, env map[string]string) *StdioChannel {
	return &StdioChannel{name: name, command: command, args: args, env: env, pending: map[int64]chan map[string]any{}}
}

// Start launches the process and begins reading its stdout.
func (c *StdioChannel) Start() error {
	command := exec.Command(c.command, c.args...)
	command.Env = mergeEnv(c.env)

	stdin, err := command.StdinPipe()
	if err != nil {
		return McpError{Message: fmt.Sprintf("cannot open stdin: %v", err)}
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		stdin.Close()
		return McpError{Message: fmt.Sprintf("cannot open stdout: %v", err)}
	}
	if err := command.Start(); err != nil {
		stdin.Close()
		// The wording names the command, because "cannot start" without it leaves
		// the reader hunting through their config for which one failed.
		return McpConfigError{Message: fmt.Sprintf("cannot start `%s`: %v", c.command, err)}
	}

	c.process = command
	c.stdin = stdin
	c.stdout = bufio.NewReaderSize(stdout, 1<<20)
	go c.readLoop()
	return nil
}

// readLoop dispatches inbound messages to whoever is waiting for them.
func (c *StdioChannel) readLoop() {
	for {
		line, err := c.stdout.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var message map[string]any
			if jsonErr := json.Unmarshal(bytes.TrimSpace(line), &message); jsonErr == nil {
				c.deliver(message)
			}
			// A line that is not JSON is skipped rather than fatal: servers print
			// banners and warnings on stdout despite the spec, and killing the
			// connection over one would make a working server unusable.
		}
		if err != nil {
			c.fail(McpServerDown{Message: fmt.Sprintf("MCP server `%s` closed its stdout", c.name)})
			return
		}
	}
}

func (c *StdioChannel) deliver(message map[string]any) {
	rawID, present := message["id"]
	if !present {
		return // a notification; nothing is waiting for it
	}
	id := numericID(rawID)

	c.mu.Lock()
	waiter, waiting := c.pending[id]
	if waiting {
		delete(c.pending, id)
	}
	c.mu.Unlock()

	if waiting {
		waiter <- message
	}
}

func (c *StdioChannel) fail(err error) {
	c.mu.Lock()
	c.closed = true
	c.err = err
	waiters := c.pending
	c.pending = map[int64]chan map[string]any{}
	c.mu.Unlock()

	for _, waiter := range waiters {
		close(waiter)
	}
}

// Request sends a call and waits for its answer.
func (c *StdioChannel) Request(method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	c.mu.Lock()
	if c.closed {
		err := c.err
		c.mu.Unlock()
		if err == nil {
			err = McpServerDown{Message: fmt.Sprintf("MCP server `%s` is closed", c.name)}
		}
		return nil, err
	}
	c.nextID++
	id := c.nextID
	waiter := make(chan map[string]any, 1)
	c.pending[id] = waiter
	c.mu.Unlock()

	if err := c.write(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	}); err != nil {
		return nil, err
	}

	select {
	case message, ok := <-waiter:
		if !ok {
			c.mu.Lock()
			err := c.err
			c.mu.Unlock()
			if err == nil {
				err = McpServerDown{Message: fmt.Sprintf("MCP server `%s` is closed", c.name)}
			}
			return nil, err
		}
		return resultOrRaise(message, method)
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, McpTimeout{Message: fmt.Sprintf("no response to %s after %.0f seconds",
			method, timeout.Seconds())}
	}
}

// Notify sends a notification: no answer is expected.
func (c *StdioChannel) Notify(method string, params map[string]any) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *StdioChannel) write(message map[string]any) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return McpError{Message: err.Error()}
	}
	// One message per line, serialised: two concurrent writes interleaving would
	// produce a line that is not JSON, and the failure would look like a protocol
	// violation on the server's side.
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(raw, '\n')); err != nil {
		return McpServerDown{Message: fmt.Sprintf("failed to write to server `%s`: %v", c.name, err)}
	}
	return nil
}

// Close shuts the process down.
func (c *StdioChannel) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()

	if c.stdin != nil {
		c.stdin.Close()
	}
	if c.process != nil && c.process.Process != nil {
		done := make(chan struct{})
		go func() {
			c.process.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(time.Duration(ShutdownGraceSeconds * float64(time.Second))):
			// Terminating the tree rather than the process: a server started
			// through npx or a shell wrapper has children, and killing the wrapper
			// leaves them holding the pipes.
			terminateTree(c.process)
			<-done
		}
	}
	c.fail(McpServerDown{Message: fmt.Sprintf("MCP server `%s` is closed", c.name)})
	return nil
}

// Where is empty for a local server: its command line would leak the paths it was
// started with.
func (c *StdioChannel) Where() string { return "" }

// --- HTTP -------------------------------------------------------------------

// HTTPChannel talks to a remote server over Streamable HTTP.
type HTTPChannel struct {
	name    string
	baseURL string
	headers map[string]string
	client  *http.Client

	mu      sync.Mutex
	session string
	nextID  int64
}

// NewHTTPChannel prepares a remote channel.
func NewHTTPChannel(name, baseURL string, headers map[string]string, client *http.Client) *HTTPChannel {
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return &HTTPChannel{name: name, baseURL: baseURL, headers: headers, client: client}
}

// Request posts one call.
func (c *HTTPChannel) Request(method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	session := c.session
	c.mu.Unlock()

	raw, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	})
	if err != nil {
		return nil, McpError{Message: err.Error()}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(raw))
	if err != nil {
		return nil, McpError{Message: err.Error()}
	}
	request.Header.Set("Content-Type", "application/json")
	// Both are accepted, and the spec asks for both: some servers answer with JSON
	// and some with an event stream.
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	if session != "" {
		request.Header.Set("Mcp-Session-Id", session)
	}
	for key, value := range c.headers {
		request.Header.Set(key, value)
	}

	response, err := c.client.Do(request)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, McpTimeout{Message: fmt.Sprintf("no response to %s after %.0f seconds", method, timeout.Seconds())}
		}
		return nil, McpServerDown{Message: fmt.Sprintf("cannot reach server `%s` (%v)", c.name, err)}
	}
	defer response.Body.Close()

	if newSession := response.Header.Get("Mcp-Session-Id"); newSession != "" {
		c.mu.Lock()
		c.session = newSession
		c.mu.Unlock()
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, MaxBodyBytes))
	if err != nil {
		return nil, McpError{Message: fmt.Sprintf("cannot read the response (%v)", err)}
	}
	if response.StatusCode >= 400 {
		return nil, McpServerDown{Message: fmt.Sprintf("server `%s` returned HTTP %d: %s",
			c.name, response.StatusCode, bodyHint(body))}
	}

	payload, err := decodeBody(body, response.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	return resultOrRaise(payload, method)
}

// Notify posts a notification.
func (c *HTTPChannel) Notify(method string, params map[string]any) error {
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		return McpError{Message: err.Error()}
	}
	request, err := http.NewRequest(http.MethodPost, c.baseURL, bytes.NewReader(raw))
	if err != nil {
		return McpError{Message: err.Error()}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err := c.client.Do(request)
	if err != nil {
		return McpServerDown{Message: fmt.Sprintf("cannot reach server `%s` (%v)", c.name, err)}
	}
	response.Body.Close()
	return nil
}

// Close is a no-op: there is no process to collect.
func (c *HTTPChannel) Close() error { return nil }

// Where reports `scheme://host`, and stops there.
//
// The path and the query can carry a token — plenty of hosted MCP endpoints put one
// in the URL — and this string reaches the model. A host is enough to answer "which
// server is this", which is the only question it is for.
func (c *HTTPChannel) Where() string {
	parsed, err := url.Parse(c.baseURL)
	if err != nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

// decodeBody reads either a JSON body or the last event of a stream.
//
// Servers choose which one to send, and refusing one of them would make half the
// ecosystem unusable.
func decodeBody(body []byte, contentType string) (map[string]any, error) {
	trimmed := bytes.TrimSpace(body)
	if bytes.HasPrefix(trimmed, []byte("{")) {
		var payload map[string]any
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return nil, McpError{Message: "the response body is not JSON"}
		}
		return payload, nil
	}

	// An event stream: take the **last** data line. Intermediate events are
	// progress notifications, and the answer is the one that arrives at the end.
	var last string
	for _, line := range strings.Split(string(trimmed), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "data:") {
			last = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
	}
	if last == "" {
		return nil, McpError{Message: "the event stream carried no JSON-RPC response"}
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(last), &payload); err != nil {
		return nil, McpError{Message: "the event stream carried something that is not JSON"}
	}
	return payload, nil
}

// --- shared -----------------------------------------------------------------

// resultOrRaise unwraps a JSON-RPC response, turning an error member into a typed
// error. Sharing this is what keeps the two transports reporting failures the same
// way — a server's error should not read differently depending on how it is
// reached.
func resultOrRaise(message map[string]any, method string) (map[string]any, error) {
	if raw, present := message["error"]; present && raw != nil {
		object, _ := raw.(map[string]any)
		code := numericID(object["code"])
		text, _ := object["message"].(string)
		if text == "" {
			text = "(the server gave no explanation)"
		}
		if method == "tools/call" && code == -32602 {
			// Invalid arguments is the one error the model can fix, and it has to
			// arrive as a shape the caller can recognise rather than as a generic
			// protocol failure.
			return nil, McpToolError{Message: text}
		}
		return nil, McpError{Message: fmt.Sprintf("the server refused %s: %s (code=%d)", method, text, code)}
	}

	result, ok := message["result"].(map[string]any)
	if !ok {
		return map[string]any{}, nil
	}
	return result, nil
}

func numericID(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}

func bodyHint(body []byte) string {
	flat := strings.Join(strings.Fields(string(body)), " ")
	if len(flat) > 300 {
		return flat[:300]
	}
	return flat
}

func mergeEnv(extra map[string]string) []string {
	env := append([]string(nil), environ()...)
	for key, value := range extra {
		env = append(env, key+"="+value)
	}
	return env
}

func environ() []string { return os.Environ() }

// terminateTree collects a server and everything it started. A server launched
// through npx or a shell wrapper has children, and killing only the wrapper leaves
// them holding the pipes.
func terminateTree(command *exec.Cmd) {
	process.TerminateTree(command)
}
