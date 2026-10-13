package ssh

import (
	"errors"
	"fmt"
	"io"
	"time"

	"golang.org/x/crypto/ssh"
)

// RuntimeSession is one non-interactive SSH session running a remote command
// whose stdio carries a line protocol — not a shell.
//
// It exists alongside sshChannel rather than reusing it because the two have
// different shapes on purpose. sshChannel is a PTY-backed interactive shell:
// one Read/Write pair, a `Channel` interface built for the `ssh_*` agent tools
// and the session kernel in session.go, which coalesces output and resizes a
// terminal. A RuntimeSession backs the Remote Runtime Backend
// (`protocol.RemoteBackend`): no PTY, no window size, and stdout and stderr
// have to stay two separate streams because the protocol lives on stdout alone
// — a shell's PTY merges both into the one stream that interactive sessions
// want and the protocol cannot tolerate.
//
// **No PTY is requested, deliberately.** A PTY gets a login shell that sources
// profile scripts, which may print banners, MOTD-style notices or anything
// else a person put in their dotfiles — exactly the stray-output case the
// remote-runtime design calls out as something that must be caught, not
// something to work around by filtering it. Running the command directly over
// a plain session channel means nothing speaks on stdout except the program
// this session asked for.
type RuntimeSession struct {
	client  *ssh.Client
	session *ssh.Session
}

// DialRuntimeSession connects to host and starts command as a plain (non-PTY)
// SSH session, returning its three standard streams.
//
// command is run exactly as given, through the account's shell — same as
// `ssh host command`. Callers are responsible for quoting it safely; see
// QuoteShellArgument. timeout bounds the connection and authentication only,
// matching DialConnector; it does not bound how long the command may run.
func DialRuntimeSession(host Host, command string, timeout time.Duration, home string) (*RuntimeSession, io.WriteCloser, io.Reader, io.Reader, error) {
	client, err := dial(host, timeout, home)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, nil, nil, nil, fmt.Errorf("connected to %s but could not open a session channel: %w", host.Display(), err)
	}

	// Pipes must be taken before Start, for the same reason DialConnector takes
	// them before Shell: golang.org/x/crypto/ssh refuses to open a pipe once the
	// session has already started copying.
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, nil, nil, fmt.Errorf("could not open a stdin pipe to %s: %w", host.Display(), err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, nil, nil, fmt.Errorf("could not open a stdout pipe from %s: %w", host.Display(), err)
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, nil, nil, fmt.Errorf("could not open a stderr pipe from %s: %w", host.Display(), err)
	}

	if err := session.Start(command); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, nil, nil, fmt.Errorf("%s accepted the connection but could not start the command: %w", host.Display(), err)
	}

	runtime := &RuntimeSession{client: client, session: session}
	return runtime, stdin, stdout, stderr, nil
}

// Wait blocks until the remote command ends and reports its exit code.
//
// ok is false when there is no code to report — a signal-killed command or a
// connection that dropped before the far end reported how it ended both leave
// nothing to say, and this never substitutes 0 for "unknown".
func (r *RuntimeSession) Wait() (code int, ok bool, err error) {
	waitErr := r.session.Wait()
	if waitErr == nil {
		return 0, true, nil
	}
	if exit, isExit := asExitError(waitErr); isExit {
		return exit, true, nil
	}
	if isExitMissing(waitErr) {
		return 0, false, nil
	}
	return 0, false, waitErr
}

// Close ends the session and the connection beneath it. Closing the connection
// as well as the session is deliberate, for the same reason sshChannel.Close
// is: a session the caller believes is closed must not leave a login open on
// a production host.
func (r *RuntimeSession) Close() error {
	var err error
	if closeErr := r.session.Close(); closeErr != nil && !isClosedError(closeErr) {
		err = closeErr
	}
	if r.client != nil {
		_ = r.client.Close()
	}
	return err
}

// Kill ends the session abruptly, without waiting for the remote command to
// exit on its own. It sends SIGKILL when the server supports signal delivery,
// and closes the channel regardless — which is itself enough to end most
// commands reading from or writing to it.
func (r *RuntimeSession) Kill() error {
	_ = r.session.Signal(ssh.SIGKILL)
	return r.session.Close()
}

// QuoteShellArgument quotes one argument for safe inclusion in the command
// line DialRuntimeSession passes to the remote shell.
//
// The remote command runs through the account's shell exactly as `ssh host
// command` does, so building it by string concatenation would let a workspace
// path or a session id containing a shell metacharacter change what runs
// rather than merely naming where it runs. Single-quoting is POSIX shells'
// one truly inert quoting form — nothing inside single quotes is special
// except a single quote itself — so the only character that needs escaping is
// the quote character, closed, escaped, and reopened.
func QuoteShellArgument(argument string) string {
	return "'" + replaceAllSingleQuotes(argument) + "'"
}

func replaceAllSingleQuotes(s string) string {
	var out []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out = append(out, '\'', '\\', '\'', '\'')
			continue
		}
		out = append(out, s[i])
	}
	return string(out)
}

func asExitError(err error) (int, bool) {
	var exit *ssh.ExitError
	if errors.As(err, &exit) {
		return exit.ExitStatus(), true
	}
	return 0, false
}

func isExitMissing(err error) bool {
	var missing *ssh.ExitMissingError
	return errors.As(err, &missing)
}
