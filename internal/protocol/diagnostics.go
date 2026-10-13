package protocol

import (
	"bufio"
	"io"
)

// diagnosticLineReader turns a backend's stderr into lines for
// Client.drainDiagnostics, the same way NewLineReader does for the protocol
// stream on stdout — but it never looks at the content: a diagnostic line is
// kept or dropped whole, never parsed, because stderr by definition is not
// this protocol.
//
// maxDiagnosticLineBytes bounds one line's own length. Without it, a backend
// that writes a single enormous line with no newline (a runtime that panics
// mid-write, or a shell that echoes a very long one) would make bufio.Scanner
// report ErrTooLong and the whole drain would stop reading — which, for a
// stream that must never be allowed to block the far end, is the one failure
// mode that cannot be tolerated.
const maxDiagnosticLineBytes = 64 * 1024

type diagnosticLineReader struct {
	scanner *bufio.Scanner
}

func newDiagnosticLineReader(reader io.Reader) *diagnosticLineReader {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxDiagnosticLineBytes)
	return &diagnosticLineReader{scanner: scanner}
}

// next returns the next line, or ok=false at end of stream or on an error
// (including a too-long line, at which point this reader stops rather than
// resynchronising on arbitrary bytes).
func (r *diagnosticLineReader) next() (string, bool) {
	if !r.scanner.Scan() {
		return "", false
	}
	return r.scanner.Text(), true
}
