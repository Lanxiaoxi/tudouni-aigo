package ssh

import (
	"context"
	"errors"
	"sync"
	"time"
	"unicode/utf8"
)

// Session limits.
//
// The output bound has the same shape `internal/terminal` uses and for a related
// reason, but the number differs and the difference is worth stating: a terminal
// drops old bytes so a *screen* stays current, while an agent reads a *stream* and
// can be several commands behind. Four megabytes is roughly a thousand screens —
// past it the middle is not going to be read, and dropping it is far better than
// stalling the remote shell.
const (
	// MaxOutputPending bounds the bytes held for a reader that is not keeping up.
	MaxOutputPending = 4 << 20
	// ReadChunk is how much one read from the channel may take.
	ReadChunk = 32 * 1024
	// DefaultReadLimit is how much one `ssh_read` call returns before truncating.
	DefaultReadLimit = 16 * 1024
	// MaxReadLimit bounds what a caller may ask for. It exists so that "let the
	// model pick the size" does not become "let one tool result carry a
	// megabyte into the context".
	MaxReadLimit = 64 * 1024
	// DefaultReadTimeoutSeconds is how long a read waits for output that has not
	// arrived. A shell running a long command prints nothing, and waiting for ever
	// would be a tool call nobody can interrupt.
	DefaultReadTimeoutSeconds = 10
	// MaxReadTimeoutSeconds bounds what a caller may ask for.
	MaxReadTimeoutSeconds = 120
	// DefaultConnectTimeoutSeconds bounds the TCP handshake, the key exchange and
	// the authentication together.
	DefaultConnectTimeoutSeconds = 15
	// MaxConnectTimeoutSeconds bounds what a caller may ask for.
	MaxConnectTimeoutSeconds = 60
	// DroppedNotice is inserted where bytes were dropped, so the model sees a gap
	// rather than a seamless lie. It is escape-free: the place it lands may already
	// be inside a full-screen program.
	DroppedNotice = "\r\n[output dropped: the reader could not keep up]\r\n"
	// DefaultCols and DefaultRows are the size a remote PTY is asked for when the
	// caller does not say. 80x24 is the conventional terminal, and it is what a
	// program reading the size before the first resize will believe.
	DefaultCols = 80
	DefaultRows = 24
	// SessionLifetime is a hard ceiling on how long one session may live.
	//
	// A ceiling rather than an idle timeout, deliberately: a deployment script
	// that sits at a prompt for twenty minutes is doing exactly what it was asked
	// to, and killing it would be this program mistaking patience for a leak. What
	// does need bounding is a session nobody will ever close — over a working day
	// the far end accumulates shells, and the model has no reason to notice. Two
	// hours is longer than any single deployment and far shorter than a day.
	SessionLifetime = 2 * time.Hour
	// MaxSessions bounds how many sessions one workspace may hold at once.
	//
	// Four is small on purpose. A model that can open sessions without limit opens
	// one per host it touches and then loses track of which is which — and
	// `ssh_sessions` exists precisely so that "which one is still alive" has an
	// answer, which requires the list to stay readable.
	MaxSessions = 4
	// pollInterval is how often a waiting read looks again.
	//
	// Polling rather than a condition variable, and the reason is a race that a
	// condvar would lose: the state worth waking for is "the session ended", and
	// that transition is not always accompanied by an append — a connection that
	// drops with no output at all would leave a waiter asleep for ever. Twenty
	// milliseconds costs nothing against commands that take seconds.
	pollInterval = 20 * time.Millisecond
)

// Status is a session's lifecycle state.
//
// There is no `starting`: a connect is synchronous, so by the time any answer
// travels the session is either running or the attempt failed, and a state no
// message can ever carry is one nobody can act on.
type Status string

const (
	StatusRunning Status = "running"
	StatusExited  Status = "exited"
	StatusKilled  Status = "killed"
	// StatusTimedOut is what a session becomes when its hard lifetime expires. It
	// is separate from `killed` because the two want different things said: one
	// means somebody ended it, the other means it ran past a ceiling and the model
	// may reconnect and carry on.
	StatusTimedOut Status = "timed_out"
)

// session is one remote shell: the channel, the three goroutines that turn its
// output into a buffer, and the end state.
//
// The concurrency has one shape:
//
//	readLoop   reads the channel continuously and appends to `pending` under the lock
//	writeLoop  drains the input queue into the channel
//	waitLoop   waits for the remote shell and records the one exit
//
// **The reads never wait for the reader.** A channel whose window fills stops the
// remote shell from writing, and a shell blocked on its own stdout is a shell that
// has stopped answering — so a design where the reader waited for a slow consumer
// would show up as "the deployment froze" when the truth is that this side stopped
// consuming. What happens instead is that `pending` is bounded and the oldest bytes
// are dropped with a marker where they were.
type session struct {
	manager *Manager
	channel Channel
	host    Host

	input *inputQueue

	mu      sync.Mutex
	info    Info
	pending []byte
	// dropped counts how many times the buffer has overflowed. It is a number
	// rather than a flag because the model can be several commands behind, and "it
	// was dropped once" and "everything you have read has holes in it" are
	// different warnings.
	dropped  int
	readDone bool
	killed   bool
	// expired records that the hard lifetime ended it, which is the difference
	// between the two exit reasons worth telling apart.
	expired bool
	// closed is set once `ssh_close` has run, so a second close is a no-op rather
	// than an error about a session that is already gone.
	closed bool

	// exited closes once the exit has been recorded, so a shutdown can wait for it
	// instead of racing it.
	exited   chan struct{}
	stopOnce sync.Once
	// timer fires the hard lifetime.
	timer *time.Timer
}

// start launches the three goroutines and the lifetime timer. Called once.
//
// The timer is armed **before** the goroutines start, and that ordering removes a
// data race rather than merely being tidy: `waitLoop` stops the timer when the
// remote shell ends, and every goroutine this function starts is guaranteed to see
// a fully initialised field only because it is written here, first.
func (s *session) start() {
	s.timer = time.AfterFunc(SessionLifetime, func() {
		s.mu.Lock()
		running := s.info.Status == StatusRunning
		if running {
			s.expired = true
		}
		s.mu.Unlock()
		if running {
			// Ending it closes the channel, and `waitLoop` turns that into the one
			// recorded exit — the same path a kill takes, so the exit is reported
			// exactly once and by exactly one goroutine.
			_ = s.channel.Close()
		}
	})

	go s.readLoop()
	go s.writeLoop()
	go s.waitLoop()
}

// snapshot reads the session's current Info. The copy matters: the caller is
// usually a list being rendered or encoded, and a shared struct would be written
// by the exit path while it was being read.
func (s *session) snapshot() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// write queues raw bytes for the remote shell.
//
// It does **not** parse them. There is no line buffer, no history and no "add a
// newline for them": `Ctrl+C`, `Ctrl+D`, `Tab` and Escape are all just bytes, and
// what they mean is decided by the shell on the far end. A runtime that
// interpreted them would be a second terminal emulator, and it would be the wrong
// one.
func (s *session) write(data string) error {
	if data == "" {
		// An empty write is legal and harmless: it is how a caller says "nothing
		// to send" without special-casing it.
		return nil
	}
	s.mu.Lock()
	status := s.info.Status
	closed := s.closed
	id := s.info.ID
	s.mu.Unlock()
	if closed {
		return errors.New("session " + id + " has been closed")
	}
	if status != StatusRunning {
		return errors.New("session " + id + " has ended (" + string(status) + ")")
	}
	return s.input.push([]byte(data))
}

// writeLoop drains the input queue into the channel.
//
// It is the only goroutine that writes, which is what preserves the order bytes
// arrived in — and for a shell, reordered input is a command that ran with its
// characters shuffled.
func (s *session) writeLoop() {
	for {
		chunk, ok := s.input.next()
		if !ok {
			return
		}
		if _, err := s.channel.Write(chunk); err != nil {
			// The channel is gone: the shell ended, or the connection dropped. The
			// exit comes from waitLoop; this loop stops so it does not spin on a
			// dead handle.
			return
		}
	}
}

// readLoop drains the channel for as long as it produces anything.
//
// It never hands output to a caller directly. Every read appends to `pending` and
// the pull side (`read`) decides what to take — the structural difference from
// `internal/terminal`, where a flush loop pushes batches at a front end. An agent
// has no event channel, so a read's destination has to be a buffer the agent asks
// from.
func (s *session) readLoop() {
	defer func() {
		s.mu.Lock()
		s.readDone = true
		s.mu.Unlock()
	}()
	buffer := make([]byte, ReadChunk)
	for {
		count, err := s.channel.Read(buffer)
		if count > 0 {
			s.append(buffer[:count])
		}
		if err != nil {
			// End of stream, or the channel closed under us. Either way there is
			// nothing left to read; `waitLoop` owns the exit, because the read
			// ending is not proof that the remote command ended.
			return
		}
	}
}

// append adds bytes to the pending output, dropping the oldest when it overflows.
func (s *session) append(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = append(s.pending, data...)
	if len(s.pending) > MaxOutputPending {
		// Keep the **tail**, not the head: the end of a command's output is where
		// the prompt and the result are, and dropping that would leave the session
		// looking dead rather than fast. The marker goes in front so the gap is
		// visible.
		keep := MaxOutputPending / 2
		trimmed := append([]byte(DroppedNotice), s.pending[len(s.pending)-keep:]...)
		s.pending = trimmed
		s.dropped++
	}
}

// read takes up to `limit` bytes from the pending output, waiting up to `timeout`
// for something to arrive.
//
// The wait is the whole reason this is a pull rather than a callback. A shell
// running a long command prints nothing for minutes, and an agent that could only
// ask "is there anything yet" would burn a step per second on it. What this
// returns instead is one complete answer: the bytes so far, whether the session
// has ended, and — when it has — the exit code.
//
// `ctx` is the **turn's** cancellation. It is honoured for the same reason
// `shell` honours it: pressing stop must not have to wait out a ten-second read
// on a remote machine, and a handler that blocks on I/O has to be able to abandon
// it. An abandoned read loses nothing — the bytes stay in the session's buffer for
// the next call, which is a property a push-based design would not have.
func (s *session) read(ctx context.Context, limit int, timeout time.Duration) (ReadResult, error) {
	if limit <= 0 {
		limit = DefaultReadLimit
	}
	if limit > MaxReadLimit {
		limit = MaxReadLimit
	}
	deadline := time.Now().Add(timeout)

	for {
		if err := ctx.Err(); err != nil {
			return ReadResult{}, err
		}

		s.mu.Lock()
		pending := append([]byte(nil), s.pending...)
		info := s.info
		dropped := s.dropped
		s.mu.Unlock()

		if len(pending) > 0 {
			take, _, truncated := sliceOutput(pending, limit)

			// A single partial rune and nothing else: waiting is the right answer,
			// but only when a rest is actually coming. If the session has ended,
			// handing over the bytes as they are beats a stall that never resolves.
			if len(take) == 0 && utf8Partial(pending) && info.Status == StatusRunning {
				if !s.waitForMore(ctx, deadline, len(pending)) {
					return timedOutResult(info, dropped), nil
				}
				continue
			}

			s.consume(len(take))
			return result(info, take, truncated, dropped), nil
		}

		if info.Status != StatusRunning {
			// Nothing pending and the session is over: the exit is the answer.
			return result(info, nil, false, dropped), nil
		}

		if !time.Now().Before(deadline) {
			return timedOutResult(info, dropped), nil
		}

		if !s.waitForMore(ctx, deadline, 0) {
			// Nothing arrived before the deadline. Loop once more so the status is
			// re-read: the session may have ended while we waited, and answering a
			// timeout for a session that has since exited would send the model
			// looking for output that is never coming.
			continue
		}
	}
}

// sliceOutput picks the bytes one read returns.
//
// It returns what can be handed over, the incomplete tail that must wait, and
// whether the limit was hit with more still buffered. The three are decided
// together because they interact: a limit that lands mid-rune is not a truncation
// the caller should loop on, it is a boundary the next call will cross.
func sliceOutput(pending []byte, limit int) (take, rest []byte, truncated bool) {
	// **A limit smaller than the widest encoding cannot make progress.** The rune
	// logic below refuses to emit half a character, so a limit of one byte and a
	// buffer starting with a four-byte emoji yields nothing at all — and because
	// the buffer is unchanged, the next read does exactly the same thing. The
	// symptom is not a slow read but a model looping on `ssh_read` for ever, with
	// every result saying `truncated: true` and holding no output to explain why.
	//
	// Raising the floor to `utf8.UTFMax` guarantees that any buffer with at least
	// one complete character in it can hand one over, so a read always either
	// returns bytes or reports a genuine timeout. It is the caller's stated limit
	// being respected *as far as it can be honoured*, which is the only reading of
	// "return up to N bytes" that cannot deadlock.
	if limit < utf8.UTFMax {
		limit = utf8.UTFMax
	}
	if len(pending) > limit {
		head := pending[:limit]
		// Only claim truncation when the limit actually cut a byte off: a buffer
		// that is exactly limit bytes long and stops on a rune boundary is a
		// complete read, and saying otherwise would make the model call again for
		// nothing.
		complete, incomplete := splitRunes(head)
		if incomplete == nil {
			return complete, nil, true
		}
		// The cut landed inside a rune. Hand over what is complete and leave the
		// partial bytes for the next call rather than emitting a replacement
		// character in the middle of a word.
		return complete, incomplete, true
	}
	complete, incomplete := splitRunes(pending)
	if incomplete == nil {
		return complete, nil, false
	}
	return complete, incomplete, false
}

// utf8Partial reports whether data is nothing but an incomplete rune.
func utf8Partial(data []byte) bool {
	complete, rest := splitRunes(data)
	return len(complete) == 0 && len(rest) > 0
}

// consume removes the first n bytes that `read` just took.
func (s *session) consume(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n >= len(s.pending) {
		s.pending = nil
		return
	}
	s.pending = s.pending[n:]
}

// waitForMore sleeps until there is more pending output than `seen`, the session
// ends, the caller's context is cancelled, or the deadline passes. It reports
// whether the caller should look again.
func (s *session) waitForMore(ctx context.Context, deadline time.Time, seen int) bool {
	for {
		if !time.Now().Before(deadline) {
			return false
		}
		if ctx != nil && ctx.Err() != nil {
			return false
		}
		s.mu.Lock()
		changed := len(s.pending) > seen || s.info.Status != StatusRunning
		s.mu.Unlock()
		if changed {
			return true
		}
		time.Sleep(pollInterval)
	}
}

// result assembles the answer to one read.
//
// `EOF` is true only when the session has ended **and** everything it wrote has
// been drained: a session that exited with output still buffered must hand that
// output over first, or the last line of a failed command — usually the reason it
// failed — would be lost behind an exit that reported itself first.
func result(info Info, output []byte, truncated bool, dropped int) ReadResult {
	s := ReadResult{
		Output:    string(output),
		Truncated: truncated,
		Dropped:   dropped,
		Session:   info,
	}
	ended := info.Status != StatusRunning
	s.Exited = ended
	s.EOF = ended && !truncated
	if ended {
		s.Reason = string(info.Status)
		s.ExitCode = info.ExitCode
	}
	return s
}

// timedOutResult is the ordinary "nothing yet" answer for a session still running.
func timedOutResult(info Info, dropped int) ReadResult {
	return ReadResult{TimedOut: true, Dropped: dropped, Session: info}
}

// terminate ends the session and the shell behind it.
func (s *session) terminate() {
	s.mu.Lock()
	if s.info.Status != StatusRunning {
		s.mu.Unlock()
		return
	}
	s.killed = true
	s.mu.Unlock()
	// There is no remote "kill process group": closing the channel gives the far
	// end EOF, which for a login shell is exactly "end this session" — the remote
	// side's own SIGHUP handling does the rest. See the design's decision record
	// for why this is the honest equivalent of `terminal`'s process-group kill.
	_ = s.channel.Close()
}

// markClosed records that `ssh_close` has run, so a later write is refused with a
// sentence about the close rather than one about a status.
func (s *session) markClosed() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// shutdown is terminate for the process-exit path: the same ending, but it waits
// for the exit to be recorded so the far end knows before the transport goes.
func (s *session) shutdown() {
	if s.timer != nil {
		s.timer.Stop()
	}
	s.terminate()
	select {
	case <-s.exited:
	case <-time.After(2 * time.Second):
		// The far end did not confirm within the grace period. Close is
		// best-effort by definition — the program is exiting — and blocking here
		// would turn a slow remote into a hang on quit.
	}
}

// waitLoop waits for the remote shell and records its ending. It is the **only**
// place an exit is recorded, whether the shell exited by itself, was killed, or
// ran past its lifetime — which is what makes "the session is the source of truth
// for whether it is running" true rather than a claim.
func (s *session) waitLoop() {
	code, haveCode, _ := s.channel.Wait()
	if s.timer != nil {
		s.timer.Stop()
	}

	// Give the reader a moment to drain what the shell wrote before it exited. A
	// program's last line is usually the most interesting one — it is where the
	// error is — and it can still be in flight when Wait returns.
	s.waitForReader(200 * time.Millisecond)

	s.mu.Lock()
	switch {
	case s.expired:
		s.info.Status = StatusTimedOut
	case s.killed:
		s.info.Status = StatusKilled
	default:
		s.info.Status = StatusExited
	}
	// An exit code is reported only when the transport actually had one: a shell
	// killed by a signal has none, and neither does a connection that dropped
	// before the far end said how it ended. Writing 0 in either case would make
	// "it was killed" and "it exited cleanly" the same row — and over SSH, where a
	// dropped connection is a routine event, that is not a theoretical distinction.
	if haveCode && !s.killed && !s.expired {
		value := code
		s.info.ExitCode = &value
	} else {
		s.info.ExitCode = nil
	}
	s.mu.Unlock()

	s.input.close()
	_ = s.channel.Close()
	s.stopOnce.Do(func() { close(s.exited) })
}

// waitForReader waits for the read loop to finish on its own.
func (s *session) waitForReader(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		done := s.readDone
		s.mu.Unlock()
		if done {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// splitRunes returns the longest prefix of data that ends on a rune boundary, and
// the bytes that have to wait for more input.
//
// This is not pedantry. A channel delivers bytes, and a multi-byte character is
// split across two reads whenever the transport fills its buffer in the middle of
// one — which for CJK text, box-drawing characters and emoji is a matter of when,
// not whether. It is more likely here than for a local terminal: an SSH channel's
// window is what decides where a read lands, and a remote build printing Chinese
// filenames crosses that boundary constantly.
//
// The `rest` half is only ever an **incomplete** sequence. A byte that is invalid
// on its own is emitted rather than held: holding it would mean waiting for a
// continuation that is never coming, and the symptom would be a session that
// silently stopped producing output while its buffer grew.
func splitRunes(data []byte) (complete, rest []byte) {
	if len(data) == 0 {
		return nil, nil
	}
	if utf8.Valid(data) {
		return data, nil
	}
	start := len(data)
	for walked := 0; walked < utf8.UTFMax && start > 0; walked++ {
		start--
		if data[start]&0xC0 != 0x80 {
			break
		}
	}
	tail := data[start:]
	if isPartialRune(tail) && utf8.Valid(data[:start]) {
		return data[:start], tail
	}
	return data, nil
}

// isPartialRune reports whether b is a strict prefix of a valid encoding, which is
// the only thing worth waiting for.
func isPartialRune(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	var needed int
	switch lead := b[0]; {
	case lead&0x80 == 0:
		return false // a complete ASCII byte
	case lead&0xE0 == 0xC0:
		needed = 2
	case lead&0xF0 == 0xE0:
		needed = 3
	case lead&0xF8 == 0xF0:
		needed = 4
	default:
		return false // a continuation byte or 0xFF: not a lead byte at all
	}
	if len(b) >= needed {
		return false // complete, and therefore not a prefix of anything
	}
	for _, next := range b[1:] {
		if next&0xC0 != 0x80 {
			return false
		}
	}
	return true
}


