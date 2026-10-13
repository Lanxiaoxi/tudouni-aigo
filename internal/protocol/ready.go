package protocol

import (
	"fmt"
	"time"
)

// ReadyInfo is what WaitReady learned from the runtime's handshake.
type ReadyInfo struct {
	// Protocol is init.protocol: the semantic version of the conversation. The
	// design is explicit that a front end does not require this to match its
	// own build's protocol version — only VERSION, the envelope, is a hard
	// failure (see CheckVersion) — so WaitReady reports Protocol rather than
	// comparing it against a constant, and leaves "is this compatible enough"
	// to the caller.
	Protocol int
	// RuntimeVersion is whatever version string the runtime chose to put in its
	// init fields, if any (see composition.go's InitFields — "version" is not a
	// required key, so this is best-effort and may be empty).
	RuntimeVersion string
	// Init is the raw init message, for a caller that wants a field this type
	// does not single out.
	Init map[string]any
}

// WaitReady blocks until the runtime's first message arrives, or until timeout,
// or until the runtime exits first — and reports which of those happened.
//
// This exists because, per the design, "the connection process cannot treat a
// successful SSH login or a successful remote process start as success by
// itself." Start/StartWithBackend only establishes the transport; WaitReady is
// the minimal handshake check layered on top of it, reusing the protocol's own
// init message rather than inventing a second handshake. It must be called
// once, immediately after Start or StartWithBackend returns without error, and
// before any front end hook is relied on to have seen the opening — the first
// message observed by WaitReady is also delivered to Hooks.OnMessage the
// normal way, through the same readLoop.
//
// Three ways this can fail, and each is reported as what it actually is rather
// than folded into one generic error:
//
//   - the process/session ended before saying anything: "the runtime exited
//     before completing its handshake", carrying whatever Diagnostics
//     collected from stderr — this is what a missing resource, an
//     incompatible remote platform, or a shell wrapper that never execs the
//     binary all look like from here;
//   - nothing arrived within timeout: a dirty session (a login banner or a
//     MOTD a non-PTY session should not have produced in the first place, but
//     which a misconfigured account might still print to stdout before the
//     command, or after it printing nothing at all);
//   - the first message decoded but was not an init: whatever reached stdout
//     first was not this protocol, which is the "stdout polluted" case the
//     design calls out — "if stdout is polluted by a shell startup script or
//     other program during startup, this must be clearly reported, and an
//     unreliable protocol session must not continue."
//
// WaitReady does not itself detect skipped (unparseable) lines before the
// first good one — LineReader already discards those silently by design, for
// the ordinary case of a stray blank line — but a dirty stream whose first
// *parseable* JSON object is not init is still caught by the third check
// above, which is the case that actually matters here: this is a session that
// was never asked to produce anything but the protocol, so the first object on
// its stdout is supposed to be init or nothing at all.
func (c *Client) WaitReady(timeout time.Duration) (ReadyInfo, error) {
	select {
	case message, ok := <-c.firstMessage():
		if !ok {
			code, stopped, hasCode := c.RuntimeExited()
			if hasCode && !stopped {
				return ReadyInfo{}, fmt.Errorf(
					"the runtime exited (code %d) before completing its handshake; diagnostics: %s",
					code, formatDiagnostics(c.Diagnostics()))
			}
			return ReadyInfo{}, fmt.Errorf(
				"the runtime's connection ended before completing its handshake; diagnostics: %s",
				formatDiagnostics(c.Diagnostics()))
		}
		if TypeOf(message) != OutInit {
			return ReadyInfo{}, fmt.Errorf(
				"the runtime's first message was %q, not %q: its stdout is not reliably carrying only "+
					"the protocol, so this session cannot continue; diagnostics: %s",
				TypeOf(message), OutInit, formatDiagnostics(c.Diagnostics()))
		}
		return readyInfoFromInit(message), nil
	case <-time.After(timeout):
		code, stopped, hasCode := c.RuntimeExited()
		if hasCode {
			return ReadyInfo{}, fmt.Errorf(
				"the runtime exited (code %d, stopped=%v) before completing its handshake; diagnostics: %s",
				code, stopped, formatDiagnostics(c.Diagnostics()))
		}
		return ReadyInfo{}, fmt.Errorf(
			"the runtime did not complete its handshake within %s; diagnostics: %s",
			timeout, formatDiagnostics(c.Diagnostics()))
	}
}

// firstMessage returns a channel that receives exactly the first message this
// client's dispatch loop sees (whatever its type), then closes — or closes
// without a value if the runtime exits first. It is built once per Start, by
// temporarily intercepting dispatch rather than hooks: the caller's Hooks must
// still see the same message afterwards (WaitReady is meant to run before
// a front end is driving the client at all, but must not make that a hard
// requirement by consuming a message the hooks would otherwise never get).
func (c *Client) firstMessage() <-chan map[string]any {
	out := make(chan map[string]any, 1)

	c.readyMu.Lock()
	if c.readyDone {
		// Already past the handshake: nothing to wait for. A caller that calls
		// WaitReady twice, or after messages are already flowing, gets a closed
		// empty channel rather than blocking forever on an event that already
		// happened.
		c.readyMu.Unlock()
		close(out)
		return out
	}
	c.readySinks = append(c.readySinks, out)
	c.readyMu.Unlock()

	go func() {
		<-c.done
		c.readyMu.Lock()
		if !c.readyDone {
			c.readyDone = true
			for _, sink := range c.readySinks {
				close(sink)
			}
			c.readySinks = nil
		}
		c.readyMu.Unlock()
	}()

	return out
}

// deliverFirstMessage feeds the message to any pending firstMessage waiters,
// exactly once, before the message is also handed to Hooks via the ordinary
// dispatch path. See dispatch.
func (c *Client) deliverFirstMessage(message map[string]any) {
	c.readyMu.Lock()
	if c.readyDone {
		c.readyMu.Unlock()
		return
	}
	c.readyDone = true
	sinks := c.readySinks
	c.readySinks = nil
	c.readyMu.Unlock()

	for _, sink := range sinks {
		sink <- message
		close(sink)
	}
}

func readyInfoFromInit(message map[string]any) ReadyInfo {
	info := ReadyInfo{Init: message}
	if protocolValue, ok := message["protocol"]; ok {
		if asFloat, ok := protocolValue.(float64); ok {
			info.Protocol = int(asFloat)
		}
	}
	if versionValue, ok := message["version"].(string); ok {
		info.RuntimeVersion = versionValue
	}
	return info
}

func formatDiagnostics(lines []string) string {
	if len(lines) == 0 {
		return "(none)"
	}
	const maxShown = 20
	if len(lines) > maxShown {
		lines = lines[len(lines)-maxShown:]
	}
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += " | "
		}
		out += line
	}
	return out
}
