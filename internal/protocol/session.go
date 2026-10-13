package protocol

import (
	"bufio"
	"io"
	"sync"
)

// RuntimeSession is the piece of a runtime's process that a Client drives:
// a pipe to write to, a stream to read from, a diagnostics stream that must
// be drained, and the exit.
//
// It exists for the remote case. A Client has always been written against
// a child process — `Start` builds one — and the protocol running over a
// pair of pipes that happens to be a child's stdio is the whole reason the
// client could be pointed at anything else. A runtime reached over SSH is
// a session that has already started somewhere else, and the client's job
// with it is identical: read lines, dispatch, write lines back, wait for
// the exit. What is different is only where the pipes come from, and this
// interface is the boundary between "they come from here" and "they come
// from somewhere else".
type RuntimeSession interface {
	// Stdin is where the client writes. Closing it is the second half of
	// the shutdown contract: EOF on stdin takes the runtime through the same
	// exit path a `shutdown` message does.
	Stdin() io.WriteCloser
	// Stdout carries the protocol, one message per line.
	Stdout() io.Reader
	// Stderr carries the runtime's diagnostics. **The session owns the
	// draining**, for the reason `Client.Start` states for the child case:
	// a runtime that writes to a full stderr buffer blocks, and a blocked
	// runtime answers nothing.
	Stderr() io.Reader
	// Exit is closed when the runtime has ended, after ExitCode is final.
	Exit() <-chan struct{}
	// ExitCode is the runtime's exit code. It is only meaningful after
	// Exit has closed; a session that cannot report one reports -1, which
	// a front end reads as "no code" rather than "it succeeded".
	ExitCode() int
}

// StdioSession is a `RuntimeSession` built around a process that has already
// been started.
//
// It is the remote backend's half of the seam: SSH gives it an already-open
// stdin pipe, an already-open stdout pipe and a stderr pipe, and the fact
// that the process has started. What it does with them is exactly what
// `Client.Start` does for a child — drain stderr, close the exit channel on
// the reader's EOF, hand the write end back — minus the part that starts a
// process, because that part is the caller's business.
type StdioSession struct {
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader

	exitMu     sync.Mutex
	exitClosed bool
	exitOnce   sync.Once
	exit       chan struct{}
	code       int

	// stderrSink receives the diagnostics, one line at a time. Nil discards,
	// which is what a local child has always had: the TUI draws its own
	// screen, and what a person must see travels as a notice instead.
	stderrSink func(line string)
}

// NewStdioSession wraps an already-started runtime.
//
// The parent's copy of stderr's write end must already be closed by the
// caller, or the drain never sees an end of stream and holds the descriptor
// for the life of the process — the same rule `Client.Start` follows for a
// child. `sink` may be nil to discard.
func NewStdioSession(stdin io.WriteCloser, stdout, stderr io.Reader, sink func(line string)) *StdioSession {
	return &StdioSession{stdin: stdin, stdout: stdout, stderr: stderr, exit: make(chan struct{}), code: -1, stderrSink: sink}
}

func (s *StdioSession) Stdin() io.WriteCloser  { return s.stdin }
func (s *StdioSession) Stdout() io.Reader      { return s.stdout }
func (s *StdioSession) Stderr() io.Reader      { return s.stderr }
func (s *StdioSession) Exit() <-chan struct{}  { return s.exit }

func (s *StdioSession) ExitCode() int {
	s.exitMu.Lock()
	defer s.exitMu.Unlock()
	return s.code
}

// MarkExited records the exit code and closes the exit channel.
//
// Idempotent, because the two callers that report an exit — the stderr
// drain seeing EOF and the caller observing the process end — do not agree
// on who gets there first, and the second one must not move the code under
// the first. A second call with a different code is ignored: the first
// report is the one the client waited on, and a correction arriving later
// would change what an already-returned `Wait` would have read.
func (s *StdioSession) MarkExited(code int) {
	s.exitMu.Lock()
	first := !s.exitClosed
	if first {
		s.code = code
		s.exitClosed = true
	}
	s.exitMu.Unlock()
	if first {
		s.exitOnce.Do(func() { close(s.exit) })
	}
}

// StderrDrain reads the diagnostics to the end, line by line.
//
// It does **not** mark the session exited: the authority on the exit code is
// whatever waits on the process — `command.Wait` locally, `session.Wait` over
// SSH — and that report is what `MarkExited` is for. A stderr EOF arrives a
// fraction of a second before the exit status does, and letting it close the
// exit channel first would make `ExitCode` final with a value nobody set.
//
// Line-by-line rather than byte-by-byte because the sink, when there is one,
// is a diagnostic ring a person reads: a half line is a line that has
// nothing to say. A final line without a trailing newline is delivered, for
// the same reason `session_load`'s reader keeps an incomplete trailing line
// rather than dropping it.
func (s *StdioSession) StderrDrain() {
	reader := bufio.NewReader(s.stderr)
	var tail string
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			tail += line
			if tailEndsWithNewline(tail) {
				s.deliver(tail)
				tail = ""
			}
		}
		if err != nil {
			break
		}
	}
	if tail != "" {
		s.deliver(tail)
	}
}

func (s *StdioSession) deliver(line string) {
	if s.stderrSink == nil {
		return
	}
	s.stderrSink(trimLineEnd(line))
}

func tailEndsWithNewline(text string) bool {
	return len(text) > 0 && text[len(text)-1] == '\n'
}

// DiagnosticsLineLimit is the number of stderr lines a session keeps for
// diagnostics.
//
// Bounded, because stderr is unbounded and the client's memory is not: a
// runtime that logs verbosely for an hour would otherwise hold an hour of
// lines for a panel that shows the last screenful. The ring keeps the most
// recent, and that is the half that answers "why did it just die".
const DiagnosticsLineLimit = 200

// DiagnosticsRing keeps the last few diagnostic lines of one runtime.
type DiagnosticsRing struct {
	mu   sync.Mutex
	lines []string
}

// Add keeps one line, evicting the oldest past the limit.
func (r *DiagnosticsRing) Add(line string) {
	if line == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.lines) >= DiagnosticsLineLimit {
		r.lines = r.lines[1:]
	}
	r.lines = append(r.lines, line)
}

// All returns a copy of what is kept, oldest first.
func (r *DiagnosticsRing) All() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}

// trimLineEnd strips the line terminator the reader carried.
func trimLineEnd(line string) string {
	text := line
	if len(text) > 0 && text[len(text)-1] == '\n' {
		text = text[:len(text)-1]
	}
	if len(text) > 0 && text[len(text)-1] == '\r' {
		text = text[:len(text)-1]
	}
	return text
}
