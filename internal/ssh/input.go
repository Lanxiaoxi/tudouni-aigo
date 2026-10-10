package ssh

import (
	"fmt"
	"sync"
)

// MaxInputPending bounds how much unwritten input one session will hold.
//
// A megabyte is far more than any command a person or a model types and far less
// than a runaway script could queue. Past it a write is **refused rather than
// dropped**, and the direction matters: dropped input is silently *changed* input,
// which over SSH means a command that ran with the middle of it missing — on a
// production machine, with nothing in the result saying so.
const MaxInputPending = 1 << 20

// inputQueue decouples "the agent wrote some bytes" from "the remote shell
// accepted them".
//
// **Why a queue rather than a direct write.** Writing to a PTY on the far end is
// not guaranteed to return promptly: the kernel's terminal input buffer there is
// a few kilobytes, and when it fills — a full-screen program that is not reading
// its input, a shell busy with a long command — the write blocks inside the SSH
// channel. The caller is the tool handler, which runs on the runtime's own
// goroutine, and a blocked write there would stall the whole turn with no way to
// end the session that caused it. So the write moves onto its own goroutine and
// the queue in front of it is bounded.
//
// Ordering is preserved because there is exactly one writer and chunks go in the
// order they arrived. That matters more here than throughput: reordered input is a
// command whose characters were shuffled, and over SSH nobody is watching the
// screen to notice.
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

// push appends bytes for the writer goroutine. It never blocks on the far end.
func (q *inputQueue) push(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return fmt.Errorf("the session has ended")
	}
	if q.bytes+len(data) > MaxInputPending {
		return fmt.Errorf(
			"the remote shell is not consuming input (more than %d bytes are still queued)", MaxInputPending)
	}
	// Copied because the caller's slice belongs to a decoded protocol line that
	// this goroutine does not own.
	chunk := make([]byte, len(data))
	copy(chunk, data)
	q.chunks = append(q.chunks, chunk)
	q.bytes += len(chunk)
	q.cond.Signal()
	return nil
}

// next blocks until there is something to write, or the queue is closed.
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
		batch = make([]byte, 0, q.bytes)
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
