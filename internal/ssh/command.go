package ssh

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// CommandChannel is what a non-interactive remote command holds: a pipe in,
// a pipe out, a diagnostics pipe, and the exit.
//
// It is deliberately a separate interface from `Channel` rather than a
// widened version of it. The interactive path's contract is a PTY — `Resize`
// exists and `Read`/`Write` move the shell's byte stream — and a channel that
// can sometimes resize and sometimes not would force every caller to know
// which one it holds. A runtime carried over SSH has no window to resize, and
// the one thing the interactive channel lacks is stderr, which the command
// channel is the right shape to carry.
type CommandChannel interface {
	// Write sends bytes to the remote command's stdin.
	Write(p []byte) (int, error)
	// Read returns the remote command's stdout.
	Read(p []byte) (int, error)
	// Stderr returns the command's diagnostics. **It must be drained by the
	// caller**, for the same reason every pipe does: a process that writes to
	// a full stderr buffer blocks, and a blocked runtime is a runtime that
	// answers nothing.
	Stderr() io.Reader
	// Close ends the session channel **and the connection under it**.
	Close() error
	// Wait blocks until the command ends and reports its exit code.
	Wait() (code int, ok bool, err error)
}

// CommandConnector opens one connection and starts one remote command,
// without a PTY.
//
// The counterpart of `DialConnector`: same host resolution, same host-key
// policy (fail-closed, known_hosts), same authentication (keys in order, then
// a configured password). What it drops is the terminal, and what it gains
// is a stderr stream — the two things that make a session useful for carrying
// a protocol rather than a shell.
//
// `configPath` and `home` empty mean the user's own files.
type CommandConnector func(host Host, command []string, timeout time.Duration) (CommandChannel, error)

// DialCommandConnector builds the connector that opens real SSH command
// sessions.
func DialCommandConnector(configPath, home string) CommandConnector {
	return func(host Host, command []string, timeout time.Duration) (CommandChannel, error) {
		client, err := dial(host, timeout, home)
		if err != nil {
			return nil, err
		}

		session, err := client.NewSession()
		if err != nil {
			_ = client.Close()
			return nil, fmt.Errorf("connected to %s but could not open a session channel: %w", host.Display(), err)
		}

		// The pipes are taken before the command starts, and the order is
		// forced: `StdinPipe`/`StdoutPipe`/`StderrPipe` refuse to run once the
		// session has started, for the reason the interactive connector states.
		stdin, err := session.StdinPipe()
		if err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf("could not open a stdin pipe to %s: %w", host.Display(), err)
		}
		stdout, err := session.StdoutPipe()
		if err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf("could not open a stdout pipe from %s: %w", host.Display(), err)
		}
		stderr, err := session.StderrPipe()
		if err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf("could not open a stderr pipe from %s: %w", host.Display(), err)
		}

		// No PTY request at all. `Start` sends the command over an exec
		// channel, and the far end runs it through `sh -c` — which is why the
		// argument vector is joined with quoting rather than sent raw: a raw
		// join would let a path containing a space or a quote arrive as several
		// words, or as a shell construct, and the failure would be a command
		// the person never wrote.
		if err := session.Start(quoteCommand(command)); err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf("%s accepted the connection but could not start the command: %w", host.Display(), err)
		}

		return &commandChannel{client: client, session: session, stdin: stdin, stdout: stdout, stderr: stderr}, nil
	}
}

// quoteCommand turns an argument vector into the single string an SSH exec
// request carries.
//
// The join is the whole contract: `sh -c` receives one string, so the only
// way argv survives is for each element to be quoted in a way the shell
// cannot re-parse. Elements are quoted on demand — one that is safe as-is
// stays bare, which keeps the command readable in an audit or an error
// message — and quoting is the single-quoted form, which is the one where
// **nothing** is special but the quote itself.
func quoteCommand(args []string) string {
	if len(args) == 0 {
		return ""
	}
	parts := make([]string, len(args))
	for index, arg := range args {
		parts[index] = shellQuote(arg)
	}
	return strings.Join(parts, " ")
}

// unsafeForBare are the characters that change what `sh -c` will do with a
// word: the shell metacharacters, the quote pair, and the backtick and `$`
// that start expansions. Everything else — including `~` and `#`, which are
// special only in positions we never occupy inside a joined command — is safe
// bare, and keeping the set narrow is what keeps the commands legible.
const unsafeForBare = ` \t\n"\'` + "`" + `$\\;|&<>(){}*?[]~#%`

func shellQuote(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, unsafeForBare) {
		return arg
	}
	// The empty string must still become an empty argument, and the only
	// spelling of that is a quoted pair.
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// commandChannel adapts one `ssh.Session` running one command to
// `CommandChannel`.
//
// The mappings follow `sshChannel`'s, and the two that differ are the ones
// that matter: there is no resize, because there is no window, and Close
// closes the connection, because a command the caller believes it closed
// while the far end still holds an authenticated session is the same leak
// `ssh_close` exists to prevent.
type commandChannel struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	stderr  io.Reader
}

func (c *commandChannel) Write(p []byte) (int, error) { return c.stdin.Write(p) }
func (c *commandChannel) Read(p []byte) (int, error)  { return c.stdout.Read(p) }
func (c *commandChannel) Stderr() io.Reader           { return c.stderr }

func (c *commandChannel) Close() error {
	var err error
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if closeErr := c.session.Close(); closeErr != nil && !isClosedError(closeErr) {
		err = closeErr
	}
	if c.client != nil {
		_ = c.client.Close()
	}
	return err
}

func (c *commandChannel) Wait() (int, bool, error) {
	err := c.session.Wait()
	if err == nil {
		return 0, true, nil
	}
	var exit *ssh.ExitError
	if errors.As(err, &exit) {
		return exit.ExitStatus(), true, nil
	}
	var missing *ssh.ExitMissingError
	if errors.As(err, &missing) {
		return 0, false, nil
	}
	return 0, false, err
}
