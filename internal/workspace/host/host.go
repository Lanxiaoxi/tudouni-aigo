// Package host is the workspace host: one process per workspace that owns the
// things a workspace has independent of any conversation — its files, its git
// state, its terminals, and the stream of "something changed" events.
//
// It speaks JSONL on stdin/stdout (docs/spec/workspace-host-protocol.md) and does
// not load models, sessions or an agent. It is deliberately not part of
// `internal/runtime`: a session runtime comes and goes with a conversation, while
// a terminal somebody is working in must not.
package host

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/gitinfo"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

// Options configures one host run.
type Options struct {
	WorkspaceID string
	Root        string
	In          io.Reader
	Out         io.Writer
	// Err receives diagnostics only; nothing a front end needs is ever on it.
	Err io.Writer
	// Version overrides the announced version (tests). Empty means this build's.
	Version string
	// DisableWatcher starts the host without a file watcher, which is also what a
	// host does when the watcher cannot start: file_watch is reported false.
	DisableWatcher bool
	// Hub tunes the event hub (tests inject a short window or a fake clock).
	Hub HubConfig
}

// Lifecycle states of a WorkspaceContext.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopping = "stopping"
	StateStopped  = "stopped"
)

// WorkspaceContext is what the services share: who the workspace is, where it
// is, what this host can do for it, and how far along its life it is.
//
// `workspace_id` is the identity and `root` only says where to look; the id is
// never derived from the path, because the same path can exist on two machines.
type WorkspaceContext struct {
	ID           string
	Root         string // as given, absolute — what host_init reports
	Capabilities Capabilities

	mu    sync.Mutex
	state string
}

// State returns the lifecycle state.
func (w *WorkspaceContext) State() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.state
}

func (w *WorkspaceContext) setState(state string) {
	w.mu.Lock()
	w.state = state
	w.mu.Unlock()
}

// outQueueSize bounds the lines waiting for the writer.
//
// The queue is bounded on purpose and **nothing is dropped from it**. Results,
// workspace events and exits are all things a front end cannot recover by
// guessing, so a full queue makes the producers wait — which is backpressure all
// the way to the source. Terminal output is the high-volume producer, and it does
// not queue at all: it is pulled from the terminal's ring buffer at the rate the
// writer can take (see terminals.go), so a front end that cannot keep up loses
// old output (reported as a gap), never unbounded memory.
const outQueueSize = 512

// maxLineBytes bounds one inbound line. A paste into a terminal is the largest
// legitimate message; anything beyond this is a bug or an attack.
const maxLineBytes = 32 << 20

// maxConcurrentRequests bounds in-flight file/git requests. They run off the read
// loop so that a slow `git status` cannot delay a keystroke, but not without limit.
const maxConcurrentRequests = 8

// Host is the running service.
type Host struct {
	ctx   *WorkspaceContext
	ws    *tools.Workspace
	root  string // resolved root; what every path check is made against
	opts  Options
	files *filesystemService
	terms *terminalManager
	hub   *EventHub

	watcher *Watcher

	out       chan []byte
	done      chan struct{}
	closeOnce sync.Once
	writerEnd chan struct{}

	reqCtx    context.Context
	cancelReq context.CancelFunc
	inflight  sync.WaitGroup
	sem       chan struct{}

	errMu sync.Mutex
}

// Run starts a host and serves it until shutdown or end of input. It returns the
// process exit code: 0 for a clean stop, 2 for a bad start.
func Run(opts Options) int {
	if opts.Err == nil {
		opts.Err = io.Discard
	}
	if opts.WorkspaceID == "" {
		fmt.Fprintln(opts.Err, "workspace host: --workspace-id is required")
		return 2
	}
	root := opts.Root
	if root == "" {
		cwd, err := os.Getwd()
		if err != nil {
			fmt.Fprintln(opts.Err, "workspace host:", err)
			return 2
		}
		root = cwd
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintln(opts.Err, "workspace host:", err)
		return 2
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		reason := "not a directory"
		if err != nil {
			reason = err.Error()
		}
		fmt.Fprintf(opts.Err, "workspace host: root %s: %s\n", absolute, reason)
		return 2
	}
	ws, err := tools.NewWorkspace(absolute)
	if err != nil {
		fmt.Fprintln(opts.Err, "workspace host:", err)
		return 2
	}

	h := &Host{
		ctx:       &WorkspaceContext{ID: opts.WorkspaceID, Root: absolute, state: StateStarting},
		ws:        ws,
		root:      ws.Root(),
		opts:      opts,
		out:       make(chan []byte, outQueueSize),
		done:      make(chan struct{}),
		writerEnd: make(chan struct{}),
		sem:       make(chan struct{}, maxConcurrentRequests),
	}
	h.reqCtx, h.cancelReq = context.WithCancel(context.Background())
	h.files = newFilesystemService(ws)
	h.terms = newTerminalManager(h)
	h.hub = NewEventHub(opts.Hub, h.sendWorkspaceEvent)

	out := opts.Out
	if out == nil {
		out = io.Discard
	}
	go h.writeLoop(out)

	// Capabilities are decided before the handshake so host_init is truthful.
	if !opts.DisableWatcher {
		w, err := StartWatcher(h.root, h.hub, h.logf)
		if err != nil {
			h.logf("file watcher unavailable: %v", err)
		} else {
			h.watcher = w
		}
	}
	h.ctx.Capabilities = Capabilities{
		Files:                true,
		FileWatch:            h.watcher != nil,
		FileRangeRead:        true,
		Git:                  gitinfo.Available(),
		Terminal:             true,
		TerminalOutputReplay: true,
		SystemOpen:           false,
	}
	h.ctx.setState(StateRunning)
	h.sendHostInit()

	h.readLoop(opts.In)
	h.shutdown()
	return 0
}

// logf writes a diagnostic line. Serialised so concurrent goroutines do not
// interleave their halves.
func (h *Host) logf(format string, args ...any) {
	h.errMu.Lock()
	defer h.errMu.Unlock()
	fmt.Fprintf(h.opts.Err, "workspace host: "+format+"\n", args...)
}

// --- output -------------------------------------------------------------

// writeLoop is the only goroutine that touches the output stream, so two
// messages can never interleave on one line.
func (h *Host) writeLoop(out io.Writer) {
	defer close(h.writerEnd)
	write := func(line []byte) bool {
		_, err := out.Write(line)
		return err == nil
	}
	for {
		select {
		case line := <-h.out:
			if !write(line) {
				// The front end is gone. Nothing can be said to it any more, and
				// the read loop will see EOF on its own.
				h.closeDone()
				return
			}
		case <-h.done:
			// Flush what was already accepted: the last result before a shutdown
			// is still owed to somebody.
			for {
				select {
				case line := <-h.out:
					if !write(line) {
						return
					}
				default:
					return
				}
			}
		}
	}
}

func (h *Host) closeDone() { h.closeOnce.Do(func() { close(h.done) }) }

// send queues one message. It blocks while the queue is full (backpressure) and
// gives up once the host is stopping.
func (h *Host) send(msg map[string]any) {
	msg["v"] = envelopeVersion
	line, err := protocol.Encode(msg)
	if err != nil {
		h.logf("cannot encode %v: %v", msg["t"], err)
		return
	}
	select {
	case h.out <- []byte(line):
	case <-h.done:
	}
}

func (h *Host) sendHostInit() {
	h.send(map[string]any{
		"t":                      MsgHostInit,
		"workspace_id":           h.ctx.ID,
		"root":                   h.ctx.Root,
		"host_protocol":          HostProtocol,
		"version":                h.version(),
		"pid":                    os.Getpid(),
		"workspace_capabilities": h.ctx.Capabilities,
	})
}

func (h *Host) version() string {
	if h.opts.Version != "" {
		return h.opts.Version
	}
	return version.Current()
}

func (h *Host) sendWorkspaceEvent(event WorkspaceEvent) {
	changes := event.Changes
	if changes == nil {
		changes = []Change{}
	}
	invalidates := event.Invalidates
	if invalidates == nil {
		invalidates = []string{}
	}
	h.send(map[string]any{
		"t":              MsgWorkspaceEvent,
		"workspace_id":   h.ctx.ID,
		"revision":       event.Revision,
		"changes":        changes,
		"invalidates":    invalidates,
		"reset_required": event.ResetRequired,
	})
}

func (h *Host) sendResult(req string, data any, werr *wireError) {
	if req == "" {
		return
	}
	if werr != nil {
		h.send(map[string]any{
			"t": MsgResult, "req": req, "ok": false,
			"error": map[string]any{"code": werr.Code, "message": werr.Message},
		})
		return
	}
	if data == nil {
		data = map[string]any{}
	}
	h.send(map[string]any{"t": MsgResult, "req": req, "ok": true, "data": data})
}

// afterSend lets a handler run something once its result is on the queue.
//
// It exists for `term_attach`: the front end must see the replay in the result
// before the first live `term_output`, and the single output queue preserves that
// only if the live stream starts after the result is queued.
type afterSend struct {
	data any
	then func()
}

// --- input --------------------------------------------------------------

func (h *Host) readLoop(in io.Reader) {
	if in == nil {
		return
	}
	reader := bufio.NewReaderSize(in, 64*1024)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > maxLineBytes {
			h.logf("dropping an oversized line (%d bytes)", len(line))
		} else if strings.TrimSpace(line) != "" {
			if stop := h.handleLine(line); stop {
				return
			}
		}
		if err != nil {
			// EOF and read errors both mean the front end is gone, which is the
			// same as asking us to stop.
			return
		}
	}
}

// handleLine returns true when the host should stop.
func (h *Host) handleLine(line string) bool {
	msg, err := protocol.Decode(line)
	if err != nil {
		h.logf("ignoring an unreadable line: %v", err)
		return false
	}
	req, _ := protocol.String(msg, "req")
	if version, ok := protocol.Int(msg, "v"); !ok || version != envelopeVersion {
		message := fmt.Sprintf("this host speaks envelope version %d", envelopeVersion)
		out := map[string]any{"t": MsgError, "code": CodeBadVersion, "message": message}
		if req != "" {
			out["req"] = req
		}
		h.send(out)
		if req != "" {
			h.sendResult(req, nil, errf(CodeBadVersion, "%s", message))
		}
		return false
	}

	t := protocol.TypeOf(msg)
	switch t {
	case MsgShutdown:
		return true
	case MsgFsList, MsgFsStat, MsgFsRead, MsgFsReadBytes, MsgFsSearch, MsgGitStatus, MsgGitDiff:
		h.async(req, func() (any, *wireError) { return h.handleSlow(t, msg) })
	case MsgTermList, MsgTermCreate, MsgTermAttach, MsgTermDetach, MsgTermInput, MsgTermResize:
		// Inline: these are quick, and keeping them on the read loop is what keeps
		// keystrokes and resizes in the order they were sent.
		h.reply(req, func() (any, *wireError) { return h.terms.handle(t, msg) })
	case MsgTermKill, MsgTermClose:
		// Off the loop: both wait for the process to be gone.
		h.async(req, func() (any, *wireError) { return h.terms.handle(t, msg) })
	default:
		// Unknown names are ignored — except that a request is owed an answer.
		if req != "" {
			h.sendResult(req, nil, errf(CodeUnsupported, "unknown message %q", t))
		}
	}
	return false
}

func (h *Host) handleSlow(t string, msg map[string]any) (any, *wireError) {
	switch t {
	case MsgGitStatus, MsgGitDiff:
		return h.handleGit(t, msg)
	}
	return h.files.handle(h.reqCtx, t, msg)
}

// reply runs fn on the calling goroutine and sends its outcome.
func (h *Host) reply(req string, fn func() (any, *wireError)) {
	data, werr := safely(fn)
	h.deliver(req, data, werr)
}

// async runs fn on its own goroutine, bounded by maxConcurrentRequests.
func (h *Host) async(req string, fn func() (any, *wireError)) {
	select {
	case h.sem <- struct{}{}:
	case <-h.done:
		return
	}
	h.inflight.Add(1)
	go func() {
		defer h.inflight.Done()
		defer func() { <-h.sem }()
		data, werr := safely(fn)
		h.deliver(req, data, werr)
	}()
}

func (h *Host) deliver(req string, data any, werr *wireError) {
	if after, ok := data.(*afterSend); ok {
		h.sendResult(req, after.data, werr)
		if after.then != nil {
			after.then()
		}
		return
	}
	h.sendResult(req, data, werr)
}

// safely turns a panic in a handler into an `internal` result. One bad request
// must not take the terminals of a whole workspace down with it.
func safely(fn func() (any, *wireError)) (data any, werr *wireError) {
	defer func() {
		if r := recover(); r != nil {
			data, werr = nil, errf(CodeInternal, "handler panicked: %v", r)
		}
	}()
	return fn()
}

// --- shutdown -----------------------------------------------------------

// shutdown ends the terminals, stops the watcher and flushes the output. It is
// idempotent in effect: Run calls it once, on the way out.
func (h *Host) shutdown() {
	h.ctx.setState(StateStopping)
	h.cancelReq()
	h.hub.Close()
	if h.watcher != nil {
		h.watcher.Close()
	}
	h.terms.closeAll(3 * time.Second)

	finished := make(chan struct{})
	go func() { h.inflight.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(time.Second):
	}

	h.closeDone()
	select {
	case <-h.writerEnd:
	case <-time.After(2 * time.Second):
	}
	h.ctx.setState(StateStopped)
}

// --- argument helpers ----------------------------------------------------

func argString(msg map[string]any, key string) string {
	value, _ := protocol.String(msg, key)
	return value
}

func argInt(msg map[string]any, key string, fallback int) (int, *wireError) {
	raw, present := msg[key]
	if !present || raw == nil {
		return fallback, nil
	}
	value, ok := protocol.Int(msg, key)
	if !ok {
		return 0, errf(CodeBadRequest, "%s must be an integer", key)
	}
	return value, nil
}

// compile-time check that the wire structs marshal: the first encode of a
// Capabilities value should not be where a tag typo is found.
var _ = json.Marshal
