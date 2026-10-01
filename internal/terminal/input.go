package terminal

import (
	"fmt"
	"sync"
)

// MaxInputPending bounds how much unwritten input one terminal will hold.
//
// A megabyte is far more than any paste a person makes and far less than a
// runaway script could queue. Past it the write is refused rather than dropped:
// dropped input is silently *changed* input, and for a terminal that means a
// command that runs with the middle of it missing. Refusing says so.
const MaxInputPending = 1 << 20

// inputQueue decouples "the front end sent some bytes" from "the PTY accepted
// them".
//
// **Why this exists at all.** Writing to a PTY is not guaranteed to return
// promptly: the kernel's terminal input buffer is a few kilobytes, and when it
// fills — a full-screen program that is not reading its input, a `read` in a
// shell that is busy — the write blocks. The protocol read loop is what calls
// this path, and a blocked write there stops *every* message being processed,
// including the `terminal_kill` that would have unblocked it. The result is a
// runtime that has stopped answering with no way to ask it to stop, and the
// trigger is a person pasting too much into a busy terminal.
//
// So the write moves onto its own goroutine and the queue in front of it is
// bounded. Ordering is preserved because there is exactly one writer and the
// chunks go in the order they arrived — which matters more here than throughput:
// reordered input is a command that ran with its characters shuffled.
type inputQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	bytes  int
	closed bool
}

func newInputQueue() *inputQueue {
	queue := &inputQueue{}
	queue.cond = sync.NewCond(&queue.mu)
	return queue
}

// push appends bytes for the writer goroutine.
//
// It never blocks on the PTY, which is the whole point; it can refuse when the
// queue is full, and it can refuse when the queue has been closed because the
// terminal ended.
func (q *inputQueue) push(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return fmt.Errorf("the terminal has ended")
	}
	if q.bytes+len(data) > MaxInputPending {
		return fmt.Errorf(
			"the terminal is not consuming input (more than %d bytes are still queued)", MaxInputPending)
	}
	// Copied because the caller's slice belongs to a decoded protocol line that
	// this goroutine does not own; holding the original would be a race the
	// compiler cannot see.
	chunk := make([]byte, len(data))
	copy(chunk, data)
	q.chunks = append(q.chunks, chunk)
	q.bytes += len(chunk)
	q.cond.Signal()
	return nil
}

// next blocks until there is something to write, or the queue is closed.
//
// It hands back **everything queued so far in one slice**, which is what keeps a
// fast typist's keystrokes from becoming one write syscall each while still
// preserving order.
func (q *inputQueue) next() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.chunks) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.chunks) == 0 {
		return nil, false
	}
	var batch []byte
	if len(q.chunks) == 1 {
		batch = q.chunks[0]
	} else {
		total := q.bytes
		batch = make([]byte, 0, total)
		for _, chunk := range q.chunks {
			batch = append(batch, chunk...)
		}
	}
	q.chunks = nil
	q.bytes = 0
	return batch, true
}

// close stops the writer goroutine.
func (q *inputQueue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	q.chunks = nil
	q.bytes = 0
	q.cond.Broadcast()
}
