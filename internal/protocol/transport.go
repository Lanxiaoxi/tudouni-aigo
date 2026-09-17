package protocol

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Transport is the byte channel the protocol runs over.
//
// Everything the runtime says goes out through this interface, and nothing in the
// runtime knows who is on the other end. A parent process reading a pipe is one
// implementation; it is not the only one the design allows, and the difference
// between "the runtime calls the interface" and "the runtime calls the interface
// that happens to be a pipe" is the whole reason the protocol exists.
type Transport interface {
	// Send writes one message.
	Send(message map[string]any) error
	// Recv returns the next message, false at end of stream.
	Recv() (map[string]any, bool)
	// Close releases the underlying resources.
	Close() error
	// Skipped reports how many unreadable lines were dropped.
	Skipped() int
}

// StdinStdout is the transport used when the runtime is a child process.
type StdinStdout struct {
	reader  *LineReader
	writer  io.Writer
	mu      sync.Mutex
	closer  io.Closer
	quiet   bool
	flushOn bool
}

// OpenStdio wires the transport to this process's standard streams.
//
// No encoding is negotiated here: Go writes UTF-8 and `json.Encoder` does not
// escape non-ASCII, so Chinese goes out as Chinese. It matters more than it
// sounds — the pipe carries the user's own words and the model's answers.
func OpenStdio() *StdinStdout {
	reader := NewLineReader(os.Stdin, DirectionFromFrontend)
	return &StdinStdout{reader: reader, writer: os.Stdout}
}

// OpenStreams builds a transport over arbitrary streams, for tests.
func OpenStreams(in io.Reader, out io.Writer) *StdinStdout {
	return &StdinStdout{reader: NewLineReader(in, DirectionFromFrontend), writer: out}
}

// Send writes one message and flushes it.
//
// Flushing every line is not an optimisation to skip: without it the events pile
// up in a 4–8KB buffer and "streaming" means "a jump every 8KB".
func (t *StdinStdout) Send(message map[string]any) error {
	line := MustEncode(message)
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, err := io.WriteString(t.writer, line); err != nil {
		return err
	}
	if flusher, ok := t.writer.(interface{ Flush() error }); ok {
		return flusher.Flush()
	}
	return nil
}

// Recv returns the next message.
func (t *StdinStdout) Recv() (map[string]any, bool) { return t.reader.Next() }

// Skipped reports how many lines did not parse.
func (t *StdinStdout) Skipped() int { return t.reader.Skipped }

// Close closes what can be closed.
func (t *StdinStdout) Close() error {
	if t.closer != nil {
		return t.closer.Close()
	}
	return nil
}

// Buffered wraps a writer in a buffered writer plus the transport.
func Buffered(out io.Writer) (*StdinStdout, *bufio.Writer) {
	writer := bufio.NewWriter(out)
	transport := &StdinStdout{reader: NewLineReader(os.Stdin, DirectionFromFrontend), writer: writer}
	return transport, writer
}

// warn writes a diagnostic. It never goes through the protocol: the front end's
// stdout carries messages, and mixing prose into it would corrupt the stream for
// every reader that is parsing it.
func warn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// nowStamp is the timestamp format the audit uses.
func nowStamp() string { return time.Now().Format("2006-01-02T15:04:05.000") }
