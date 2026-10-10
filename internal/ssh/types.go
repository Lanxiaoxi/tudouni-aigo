package ssh

import (
	"net"
	"sort"
	"strconv"
	"time"
)

// Info is one session, as the runtime reports it.
//
// It deliberately carries **no output**: the bytes are the agent's, delivered
// through `ssh_read`, and a list that also held a transcript would be a second
// copy of every session's output growing in memory.
type Info struct {
	ID string
	// User, HostName and Port are the resolved destination — what the connection
	// actually opens to, never the alias. They are split rather than pre-joined so
	// a caller can render them its own way, and so the audit can record the host
	// without the port glued on.
	User     string
	HostName string
	Port     int
	// Alias is what the model asked for when it connected. It is kept beside the
	// resolved destination because they can differ (`HostName` redirects, `%h`
	// substitution), and a person reading the session list needs to recognise
	// which of their own aliases this is.
	Alias string
	// Status and ExitCode are the session's alone. A caller displays them and
	// never derives either.
	Status Status
	// ExitCode is nil until the session has ended, and stays nil when there is no
	// code to report. See `session.waitLoop` for why that is not the same as 0.
	ExitCode  *int
	CreatedAt float64
	Cols      int
	Rows      int
}

// Destination is the `user@host:port` sentence for a person.
func (i Info) Destination() string {
	port := i.Port
	if port == 0 {
		port = DefaultPort
	}
	return i.User + "@" + net.JoinHostPort(i.HostName, strconv.Itoa(port))
}

// Duration is how long the session has been alive, as of `now`.
func (i Info) Duration(now float64) time.Duration {
	seconds := now - i.CreatedAt
	if seconds < 0 {
		seconds = 0
	}
	return time.Duration(seconds * float64(time.Second))
}

// ReadResult is what one `ssh_read` call amounts to.
//
// It is one value rather than a string plus flags because **the string alone
// cannot be acted on**. A model that received only the output would have to guess
// whether the command finished, whether more is coming, and what it exited with —
// and every one of those guesses has a wrong answer that looks reasonable.
type ReadResult struct {
	// Output is the bytes taken from the session's buffer, decoded as UTF-8 with
	// any incomplete trailing rune held back for the next call.
	Output string
	// Truncated means the read limit was reached with output still buffered: call
	// again to get the rest. It is **not** an error and **not** the end.
	Truncated bool
	// Dropped is how many times the buffer has overflowed since the session
	// started, cumulatively. Non-zero means everything read so far may have gaps.
	Dropped int
	// Exited means the session is over. Output may still be available in the same
	// answer when it is set — see `EOF` for the distinction that matters.
	Exited bool
	// EOF means the session has ended **and** everything it wrote has been read.
	// Only then is "there is no more output" a true statement; a session that
	// exited with a full buffer still has things to say.
	EOF bool
	// Reason is the status the session ended with, when it ended.
	Reason string
	// ExitCode is the remote command's exit code, when it had one.
	ExitCode *int
	// TimedOut means the wait expired with the session still running and nothing
	// to read. It is the ordinary answer to "has this long command printed
	// anything yet", not a failure.
	TimedOut bool
	// Session is the session's state as of this read.
	Session Info
}

// sortedIDs orders session ids the way a person reads a list: `ssh-01` before
// `ssh-02`, not `ssh-10` before `ssh-2`. The ids are minted zero-padded for the
// same reason.
func sortedIDs(ids []string) []string {
	out := append([]string(nil), ids...)
	sort.Strings(out)
	return out
}
