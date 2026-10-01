package terminal

import (
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

// session is one running terminal: the PTY, the shell behind it, and the three
// goroutines that turn its output into events.
//
// The concurrency here has one shape and it is worth stating, because every
// alternative has a failure mode this avoids:
//
//	readLoop   reads the PTY continuously and appends to `pending` under the lock
//	flushLoop  takes `pending` on a timer and emits it
//	waitLoop   waits for the shell and then emits the one exit event
//
// **The reads never wait for the front end.** That is not an optimisation: a PTY
// whose buffer fills blocks the *shell*, so a design where the reader waited for a
// slow client would show up as "the terminal froze while I was building" — a bug
// on this side wearing the costume of a bug in the person's own command. What
// happens instead is that `pending` is bounded and the oldest bytes are dropped
// with a marker where they were.
type session struct {
	manager *Manager
	proc    ptyProcess

	// input is the write side, on its own goroutine. See inputQueue for why the
	// protocol's read loop must not write to a PTY directly.
	input *inputQueue

	mu      sync.Mutex
	info    Info
	pending []byte
	// readDone is closed by readLoop when it has stopped reading.
	readDone bool
	// killed records that somebody asked this terminal to end, which is the only
	// difference between the two exit reasons a front end is told apart.
	killed bool

	// exited closes once the exit event has gone out, so a shutdown can wait for
	// it instead of racing it.
	exited   chan struct{}
	stopOnce sync.Once
}

// start launches the four goroutines. It is called once, from Create.
func (s *session) start() {
	go s.readLoop()
	go s.flushLoop()
	go s.writeLoop()
	go s.waitLoop()
}

// snapshot reads the terminal's current Info. The copy matters: the caller is
// usually a list being handed to the protocol layer, and a shared map would be
// written by the exit path while it is being encoded.
func (s *session) snapshot() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// write queues raw bytes for the PTY.
//
// It does **not** parse them. There is no line buffer, no history and no
// "add a newline for them": `Ctrl+C`, `Ctrl+D`, `Tab`, an arrow key and Escape are
// all just bytes, and what they mean is decided by the shell on the other side. A
// runtime that interpreted them would be a second terminal emulator, and it would
// be the wrong one.
//
// The write goes onto a queue rather than to the PTY directly — see inputQueue for
// why. That is what keeps a paste into a busy terminal from freezing the runtime's
// read loop, which is the goroutine that would otherwise be the only one able to
// process a kill.
func (s *session) write(data string) error {
	if data == "" {
		// An empty write is legal and harmless, and the protocol explicitly allows
		// it. Refusing it would only give a front end one more error path to
		// handle for no gain.
		return nil
	}
	s.mu.Lock()
	ended := s.info.Status != StatusRunning
	s.mu.Unlock()
	if ended {
		return fmt.Errorf("terminal %s has ended (%s)", s.info.ID, s.info.Status)
	}
	return s.input.push([]byte(data))
}

// writeLoop drains the input queue into the PTY.
//
// It is the only goroutine that writes, which is what preserves the order the
// bytes arrived in — and for a terminal, reordered input is a command that ran
// with its characters shuffled.
func (s *session) writeLoop() {
	for {
		chunk, ok := s.input.next()
		if !ok {
			return
		}
		if _, err := s.proc.Write(chunk); err != nil {
			// The PTY is gone: the shell ended, or the console was closed. The
			// exit event is the report a front end needs, and it comes from
			// waitLoop; this loop stops so it does not spin on a dead handle.
			return
		}
	}
}

// resize sets the PTY's window size.
func (s *session) resize(cols, rows int) error {
	s.mu.Lock()
	if s.info.Status != StatusRunning {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	if err := s.proc.Resize(cols, rows); err != nil {
		return fmt.Errorf("could not resize terminal %s: %w", s.info.ID, err)
	}
	// Recorded only after the PTY accepted it, so the row never claims a size the
	// shell has not been told about: a front end that reconnects reads this back
	// and would otherwise resize the window to a lie.
	s.mu.Lock()
	s.info.Cols, s.info.Rows = cols, rows
	s.mu.Unlock()
	return nil
}

// terminate ends the shell and everything it started.
func (s *session) terminate() error {
	s.mu.Lock()
	if s.info.Status != StatusRunning {
		s.mu.Unlock()
		// Already gone, which is the outcome the caller asked for.
		return nil
	}
	s.killed = true
	s.mu.Unlock()

	// The error is deliberately dropped here and reported through the exit event
	// instead. A kill that failed is not a call the caller can retry — the process
	// is still there either way — and the fact that matters is whether it actually
	// stopped, which only the wait path can answer.
	_ = s.proc.Kill()
	return nil
}

// shutdown is terminate for the process-exit path: same ending, but it waits for
// the exit event so the front end hears about it before the transport closes.
func (s *session) shutdown() {
	_ = s.terminate()
	select {
	case <-s.exited:
	case <-time.After(2 * time.Second):
		// The process would not die within the grace period. Close is best-effort
		// by definition — the program is exiting — and blocking here would turn a
		// hard-to-kill shell into a hang on quit.
	}
}

// readLoop drains the PTY for as long as it produces anything.
//
// It never flushes directly. Every read appends to `pending` and lets flushLoop
// decide when a batch is worth sending — that is what makes the output stream
// coalesced rather than one message per read.
func (s *session) readLoop() {
	defer func() {
		s.mu.Lock()
		s.readDone = true
		s.mu.Unlock()
	}()
	buffer := make([]byte, ReadBuffer)
	for {
		count, err := s.proc.Read(buffer)
		if count > 0 {
			s.append(buffer[:count])
		}
		if err != nil {
			// End of stream, or the PTY closed under us because the shell died.
			// Either way there is nothing left to read, and waitLoop owns the
			// exit event: the read ending is not proof that the process ended.
			return
		}
	}
}

// append adds bytes to the pending batch, forcing a flush past the threshold.
//
// The forced flush is what keeps a single `cat` of a large file from becoming one
// enormous allocation, and the drop is what keeps a front end that stopped reading
// from stalling the shell.
func (s *session) append(data []byte) {
	s.mu.Lock()
	s.pending = append(s.pending, data...)
	over := len(s.pending) >= FlushThreshold
	if len(s.pending) > MaxPending {
		// Keep the **tail**, not the head: the end of a program's output is where
		// the prompt is, and dropping that would leave the terminal looking dead
		// rather than fast. The marker goes in front so the gap is visible.
		keep := MaxPending / 2
		trimmed := append([]byte(DroppedNotice), s.pending[len(s.pending)-keep:]...)
		s.pending = trimmed
	}
	s.mu.Unlock()
	if over {
		s.flush(false)
	}
}

// flushLoop emits whatever has accumulated, on a short timer.
//
// The timer is the coalescing half: without it, output would sit in the buffer
// until the next read happened to cross the threshold, and a prompt written as a
// single small burst (which is every prompt) would never reach the screen.
func (s *session) flushLoop() {
	ticker := time.NewTicker(FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !s.flush(false) {
				return
			}
		case <-s.exited:
			return
		}
	}
}

// flush emits the pending batch and reports whether a terminal is still running.
//
// `final` says this is the last call: the exit path has already established that
// the shell is gone, so an incomplete trailing rune is no longer something to
// wait for — there is nobody left to complete it.
func (s *session) flush(final bool) bool {
	s.mu.Lock()
	if len(s.pending) == 0 {
		running := s.info.Status == StatusRunning
		s.mu.Unlock()
		return running
	}
	batch := s.pending
	s.pending = nil
	info := s.info
	running := info.Status == StatusRunning
	s.mu.Unlock()

	complete, rest := splitRunes(batch)
	if !final && len(rest) > 0 {
		// Handed back to the next batch. A rune split across two reads is the
		// normal case for a UTF-8 terminal — a `汉字` is three bytes and the
		// kernel has no reason to deliver all three together — and emitting the
		// halves separately would show a replacement character in the middle of
		// the word.
		s.mu.Lock()
		s.pending = append(rest, s.pending...)
		s.mu.Unlock()
	}
	if len(complete) > 0 {
		s.manager.deliver(Event{Kind: EventOutput, Info: info, Data: string(complete)})
	}
	return running
}

// waitLoop waits for the shell and reports its ending. It is the **only** place
// an exit event is produced, whether the shell exited by itself or was killed —
// which is what makes "the runtime is the source of truth for whether a terminal
// is running" true rather than a claim.
func (s *session) waitLoop() {
	code, haveCode, _ := s.proc.Wait()

	// Give the reader a moment to drain what the shell wrote before it exited.
	// A program's last line is usually the most interesting one, and on POSIX the
	// master still holds it after the child is gone.
	if !s.waitForReader(150 * time.Millisecond) {
		// Still reading: the PTY has not reported end of stream, which on Windows
		// is what happens until the pseudoconsole is closed. Closing it is safe
		// here and only here — the process is already gone.
		_ = s.proc.Close()
		s.waitForReader(500 * time.Millisecond)
	}

	// Everything that was written before the shell ended is flushed as a final
	// batch, incomplete rune and all.
	s.flush(true)

	s.mu.Lock()
	status := StatusExited
	if s.killed {
		status = StatusKilled
	}
	s.info.Status = status
	// An exit code is reported only when the platform actually has one, and a
	// terminated process does not: a shell that was killed did not choose a code,
	// and a process that died of a signal has no code to report. Writing 0 in
	// either case would make "it was killed" and "it exited cleanly" the same row.
	if haveCode && !s.killed {
		value := code
		s.info.ExitCode = &value
	} else {
		s.info.ExitCode = nil
	}
	info := s.info
	s.mu.Unlock()

	reason := ReasonExited
	if s.killed {
		reason = ReasonKilled
	}

	// The write side is stopped before the exit is reported, and the order
	// matters: a chunk that arrived a microsecond before the shell died has
	// nowhere to go, and letting the writer stay alive would have it fail against
	// a closed handle for as long as the session object is referenced.
	s.input.close()

	s.manager.deliver(Event{Kind: EventExit, Info: info, Reason: reason})

	s.stopOnce.Do(func() { close(s.exited) })
}

// waitForReader waits for the read loop to finish on its own.
func (s *session) waitForReader(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		done := s.readDone
		s.mu.Unlock()
		if done {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// ptyProcess is one terminal's operating-system half.
//
// The interface exists so that the session's three goroutines — the part with the
// coalescing rules, the drop policy and the lifecycle — are written once and
// tested once, while the two platforms differ only where they genuinely differ.
// Everything above this line is policy; everything below it is a syscall.
type ptyProcess interface {
	// PID is the shell's process id, for display and for an operator who wants to
	// look at it by hand.
	PID() int
	// Read and Write move bytes through the PTY.
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	// Resize sets the window size, and is what makes full-screen programs work.
	Resize(cols, rows int) error
	// Kill ends the shell **and its descendants**.
	Kill() error
	// Wait blocks until the shell has ended and reports its exit code. `ok` is
	// false when the platform has no code to give — a signal, or a console this
	// program had to close.
	Wait() (code int, ok bool, err error)
	// Close releases the PTY, unblocking a pending Read.
	Close() error
}

// spawnSpec is what a platform needs to start a shell in a PTY.
type spawnSpec struct {
	// Argv is the shell's command line, argv[0] first.
	Argv []string
	// Shell is how the shell is named on screen (`/bin/zsh`, `PowerShell`). It is
	// separate from Argv because a path with arguments in it is not a name.
	Shell string
	Cwd   string
	Cols  int
	Rows  int
	// Env is the environment for the child. Nil means "inherit this process's",
	// and the platform may still add to it: a terminal needs `TERM` set, and a
	// shell that inherits the runtime's own `TERM` from a full-screen interface
	// would draw with sequences meant for a different kind of terminal.
	Env []string
}

// splitRunes returns the longest prefix of data that ends on a rune boundary,
// and the bytes that have to wait for more input.
//
// This is not pedantry. A PTY delivers bytes, and a multi-byte character is split
// across two reads whenever the kernel happens to fill the buffer in the middle
// of one — which for CJK text, box-drawing characters and emoji is a matter of
// when, not whether. Emitting the halves separately puts a replacement character
// in the middle of the word, once every few thousand characters, in a way that
// looks like a memory bug and is unfixable from the front end's side.
//
// The `rest` half of the answer is only ever an **incomplete** sequence. A byte
// that is invalid on its own is emitted rather than held: holding it would mean
// waiting for a continuation that is never coming, and the symptom would be a
// terminal that has silently stopped producing output while its buffer grows.
func splitRunes(data []byte) (complete, rest []byte) {
	if len(data) == 0 {
		return nil, nil
	}
	if utf8.Valid(data) {
		return data, nil
	}
	// Walk back over the trailing continuation bytes to the start of the final
	// rune. At most UTFMax bytes can belong to one rune, so this is bounded.
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

// isPartialRune reports whether b is a strict prefix of a valid encoding, which
// is the only thing worth waiting for.
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
