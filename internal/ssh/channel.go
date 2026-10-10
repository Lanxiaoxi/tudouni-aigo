package ssh

// Channel is one remote shell, as the session kernel sees it.
//
// **Everything above this line is policy; everything below it is transport.** The
// interface exists for exactly that split, and it is the same split
// `terminal.ptyProcess` makes for local shells: the coalescing rules, the drop
// policy and the lifecycle are written once and tested once, while the two
// implementations — a real SSH channel and an in-memory fake — differ only where
// they genuinely differ.
//
// It is also what makes the package testable without a server. A test that needed
// a running `sshd` would be a test that does not run on most machines, and the
// behaviour worth asserting here (a rune split across two reads, a buffer that
// overflows, an exit code that arrives after the last output) is not about SSH at
// all.
//
// **It is exported, and that is not a formality.** The tool layer lives in another
// package and has to be able to hand the manager a channel of its own to test
// against — without that, the only way to test a tool would be to run an `sshd`,
// and the layer that decides what the *model* sees would be the one layer with no
// tests at all.
//
// **There is no read deadline, and that is a decision rather than an omission.**
// The reader runs on its own goroutine, so blocking on `Read` costs nothing: it
// wakes when bytes arrive or when the channel ends, and the pull side polls the
// buffer instead of the socket. Adding a deadline would only trade a blocking
// goroutine for a timer, and it would put a bound on an idle-but-healthy session
// that nothing in this design wants. What ends a read is `Close`, which is what
// both the model's `ssh_close` and the session's hard lifetime call.
type Channel interface {
	// Read returns output from the remote shell. It blocks until bytes arrive or
	// the channel ends, and returns an error when it does.
	Read(p []byte) (int, error)
	// Write sends bytes to the remote shell's stdin.
	Write(p []byte) (int, error)
	// Resize asks the far end to change its window size.
	Resize(cols, rows int) error
	// Close releases the channel. It is idempotent, and calling it is what
	// unblocks a pending Read or Wait.
	Close() error
	// Wait blocks until the remote shell has ended and reports its exit code.
	//
	// `ok` is false when there is no code to report: a shell killed by a signal
	// has none, and neither does a connection that dropped before the far end
	// said how it ended. Zero and "not known" are different facts and are told
	// apart here rather than flattened into one number.
	Wait() (code int, ok bool, err error)
}
