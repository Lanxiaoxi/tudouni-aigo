package ssh

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// DialConnector builds the connector that opens real SSH connections.
//
// Everything about this file is deliberately small. The interesting behaviour —
// the buffer bound, the drop policy, the lifecycle — lives in `session.go`, which
// knows nothing about sockets; what is left here is the part that genuinely needs
// the SSH library, and keeping it thin is what lets the rest be tested without a
// server.
//
// `configPath` and `home` empty mean the user's own files.
func DialConnector(configPath, home string) Connector {
	return func(host Host, cols, rows int, timeout time.Duration) (Channel, error) {
		client, err := dial(host, timeout, home)
		if err != nil {
			return nil, err
		}

		session, err := client.NewSession()
		if err != nil {
			_ = client.Close()
			return nil, fmt.Errorf("connected to %s but could not open a session channel: %w", host.Display(), err)
		}

		// **The pipes are taken before the shell starts, and the order is forced.**
		// `StdinPipe` and `StdoutPipe` refuse to run once the session has started
		// ("pipe after process started"), because the copy goroutines are set up at
		// start time — so asking for them after `Shell()` would be an error on every
		// single connect. They are captured here and the shell is started below.
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

		// The PTY is requested before the shell starts, and it is what makes this
		// an interactive session rather than a command runner. Without it the remote
		// side gives a pipe, and every full-screen program — `top`, `vim`, an
		// installer with a progress bar — either refuses to start or draws nothing.
		// The login shell also behaves differently: with a PTY it sources the
		// profile and keeps its state between commands, which is the whole point of
		// a persistent session.
		if err := session.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{}); err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf(
				"%s accepted the connection but refused a PTY request: %w. "+
					"An interactive session needs one — a host configured to force a non-interactive command cannot be used this way",
				host.Display(), err)
		}

		// `Shell` rather than `Start("bash -i")`: it asks the far end for the login
		// shell the account is actually configured with, which is what a person gets
		// when they type `ssh host`. Naming a shell here would work on most hosts and
		// fail on exactly the ones where somebody set a different login shell
		// deliberately.
		if err := session.Shell(); err != nil {
			_ = session.Close()
			_ = client.Close()
			return nil, fmt.Errorf("%s accepted the connection but could not start a shell: %w", host.Display(), err)
		}

		return &sshChannel{client: client, session: session, stdin: stdin, stdout: stdout}, nil
	}
}

// dial performs the handshake and authentication.
//
// The steps are in the order they must be: connect, verify the host key, then
// authenticate. Verifying before authenticating is not an optimisation, it is the
// point — an unverified peer that is offered a signature has already been told
// which key the user holds, and on a host that is not the one they meant, that is
// the thing worth not leaking.
func dial(host Host, timeout time.Duration, home string) (*ssh.Client, error) {
	if timeout <= 0 {
		timeout = DefaultConnectTimeoutSeconds * time.Second
	}
	if home == "" {
		home = homeDirFor("")
	}

	// Known hosts, fail-closed. `knownhosts.New` implements OpenSSH's own file
	// format and its matching rules, which is exactly the behaviour to want: a host
	// the user has already trusted through `ssh` is trusted here, and one they have
	// not is not.
	knownHostsPath := DefaultKnownHostsPath(home)
	hostKeyCallback, err := knownhosts.New(knownHostsPath)
	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf(
				"no %s: this program verifies host keys and never accepts one it has not seen. "+
					"Connect once with `ssh %s` to record it, then try again",
				knownHostsPath, host.Alias)
		}
		return nil, fmt.Errorf("cannot read %s: %w", knownHostsPath, err)
	}

	signers, err := loadIdentityFiles(host)
	if err != nil {
		return nil, err
	}

	config := &ssh.ClientConfig{
		User: host.User,
		Auth: []ssh.AuthMethod{
			ssh.PublicKeys(signers...),
		},
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			// The callback is given the name the dialer used, which for us is the
			// **resolved** host name rather than the alias. That matters: the person
			// recorded `10.0.1.5` in known_hosts through `ssh`, because that is the
			// name OpenSSH dials — checking the alias here would reject a host the
			// user has already approved, or worse, accept a different machine that
			// happens to share the alias.
			if err := hostKeyCallback(hostname, remote, key); err != nil {
				return explainHostKey(host, knownHostsPath, err)
			}
			return nil
		},
		Timeout: timeout,
	}

	client, err := ssh.Dial("tcp", host.Address(), config)
	if err != nil {
		return nil, explainDial(host, err)
	}
	return client, nil
}

// loadIdentityFiles reads the private keys the host's configuration names.
//
// **Passphrase-protected keys are refused with a sentence that says what to do**,
// and that is a scope decision rather than an oversight. The first phase supports
// key files only: no agent, no password, and — because the approval panel is a
// yes/no question and `ask_user` writes its answer into the conversation — nowhere
// to type a passphrase that would not put it in the context, the session file and
// the audit log. So an encrypted key is reported as unusable rather than prompted
// for, and the message names the real ways out.
func loadIdentityFiles(host Host) ([]ssh.Signer, error) {
	var signers []ssh.Signer
	var problems []string

	for _, path := range host.IdentityFiles {
		raw, err := os.ReadFile(path)
		if err != nil {
			if isNoSuchFile(err) {
				problems = append(problems, fmt.Sprintf("%s does not exist", path))
				continue
			}
			problems = append(problems, fmt.Sprintf("%s could not be read: %v", path, err))
			continue
		}
		signer, err := ssh.ParsePrivateKey(raw)
		if err != nil {
			var needsPassphrase *ssh.PassphraseMissingError
			if errors.As(err, &needsPassphrase) {
				problems = append(problems, fmt.Sprintf(
					"%s is passphrase-protected, and this program cannot ask for one: "+
						"the answer would have to travel through the conversation and the audit log. "+
						"Use a key without a passphrase for this host, or load the key into an agent "+
						"and point IdentityFile at a copy without one",
					path))
				continue
			}
			problems = append(problems, fmt.Sprintf("%s is not a usable private key: %v", path, err))
			continue
		}
		signers = append(signers, signer)
	}

	if len(signers) == 0 {
		return nil, fmt.Errorf("no usable private key for %s:\n  - %s",
			host.Alias, strings.Join(problems, "\n  - "))
	}
	return signers, nil
}

// explainDial turns a transport failure into something a model can act on.
//
// The distinction the messages carry is the one that decides what to try next:
// "nothing is listening there" is about the address, a timeout is about
// reachability, and a rejected key is about the far end's `authorized_keys` —
// three different next steps that a bare `dial tcp: i/o timeout` would collapse
// into one guess.
func explainDial(host Host, err error) error {
	text := err.Error()
	switch {
	case strings.Contains(text, "no such host"):
		return fmt.Errorf("cannot resolve %s: %w. Check the HostName in the Host block for %q",
			host.HostName, err, host.Alias)
	case strings.Contains(text, "connection refused"):
		return fmt.Errorf(
			"%s refused the connection on port %d: %w. Nothing is listening there, or the port is wrong",
			host.HostName, host.Port, err)
	case strings.Contains(text, "i/o timeout"), strings.Contains(text, "connection timed out"), strings.Contains(text, "deadline exceeded"):
		return fmt.Errorf(
			"connecting to %s timed out: %w. The address is not reachable from here. "+
				"If this host is only reachable through a jump host, note that a ProxyJump setting is refused "+
				"by this program rather than ignored — that refusal is reported when the alias is resolved",
			host.Address(), err)
	case strings.Contains(text, "unable to authenticate"), strings.Contains(text, "no supported methods remain"):
		return fmt.Errorf(
			"%s rejected the key offered for user %q: %w. The key file was read successfully, so this is the "+
				"far end refusing it — check that the public half is in that account's authorized_keys",
			host.HostName, host.User, err)
	}
	return fmt.Errorf("could not connect to %s: %w", host.Address(), err)
}

// explainHostKey turns a known-hosts rejection into the two facts that matter:
// which host was refused, and how the two ways of resolving it differ.
//
// The mismatch case is called out separately from the unknown case on purpose.
// They look alike in the raw error and mean completely different things: an
// unknown host is a first connection, while a mismatch is either a rebuilt machine
// or an interception — and the second one must not be waved through by the same
// habit that handles the first.
func explainHostKey(host Host, knownHostsPath string, err error) error {
	var keyErr *knownhosts.KeyError
	if errors.As(err, &keyErr) {
		if len(keyErr.Want) > 0 {
			return fmt.Errorf(
				"the host key for %s does not match the one recorded in %s: %w. "+
					"This is either a rebuilt machine or somebody intercepting the connection, and this program "+
					"cannot tell which — so it refuses. If the machine was rebuilt, remove its old entry from %s "+
					"and connect once with `ssh` to record the new one",
				host.Address(), knownHostsPath, err, knownHostsPath)
		}
		return fmt.Errorf(
			"%s is not in %s, and this program never accepts a host key it has not seen: %w. "+
				"Connect once with `ssh %s` to record it, then try again",
			host.Address(), knownHostsPath, err, host.Alias)
	}
	return fmt.Errorf("the host key for %s was refused: %w", host.Address(), err)
}

// sshChannel adapts one `ssh.Session` to the kernel's `channel` interface.
//
// The adapter is thin on purpose, but three of its mappings are decisions rather
// than plumbing:
//
//   - **Close means the whole connection.** Closing the session channel alone
//     would leave the TCP connection and its authentication open, and a session the
//     model believes it closed while the far end still holds a login is exactly the
//     leak `ssh_close` exists to prevent.
//   - **Wait reports whether a code exists.** A remote command killed by a signal
//     sends an exit-signal rather than an exit-status, and reporting 0 for it would
//     make "it crashed" and "it succeeded" the same row.
//   - **A closed channel reads as EOF, not as a fault.** The read loop treats end
//     of stream as "stop reading"; an error would be reported to the model as a
//     transport failure on every ordinary exit.
type sshChannel struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
}

// Read returns output from the remote shell.
func (c *sshChannel) Read(p []byte) (int, error) { return c.stdout.Read(p) }

// Write sends bytes to the remote shell's stdin.
func (c *sshChannel) Write(p []byte) (int, error) { return c.stdin.Write(p) }

// Resize asks the far end to change the window size.
func (c *sshChannel) Resize(cols, rows int) error {
	if !sensibleSize(cols, rows) {
		// Ignored rather than clamped: a size nobody asked for makes a full-screen
		// program redraw at the wrong width, and on screen that is
		// indistinguishable from a rendering bug in this program.
		return nil
	}
	return c.session.WindowChange(rows, cols)
}

// sensibleSize is the guard `Resize` applies, split out so it can be tested
// without a live SSH session — which is the only way this rule gets a test at all,
// since everything else in `sshChannel` needs a server.
func sensibleSize(cols, rows int) bool {
	return cols > 0 && rows > 0
}

// Close ends the session channel **and the connection under it**.
func (c *sshChannel) Close() error {
	var err error
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if closeErr := c.session.Close(); closeErr != nil && !isClosedError(closeErr) {
		err = closeErr
	}
	if c.client != nil {
		// The client is closed as well, and it is not redundant: `Session.Close`
		// tears down the channel, while the TCP connection and its authenticated
		// state survive it. A session the model closed must not leave a login open
		// on a production host.
		_ = c.client.Close()
	}
	return err
}

// Wait blocks until the remote shell ends and reports its exit code.
func (c *sshChannel) Wait() (int, bool, error) {
	err := c.session.Wait()
	if err == nil {
		// A clean exit. The code is a real observation rather than a default:
		// `Wait` returning nil means the far end sent status 0.
		return 0, true, nil
	}
	var exit *ssh.ExitError
	if errors.As(err, &exit) {
		return exit.ExitStatus(), true, nil
	}
	var missing *ssh.ExitMissingError
	if errors.As(err, &missing) {
		// The connection dropped before the far end said how it ended — a network
		// fault, or a session killed from the far side. There is no code to report,
		// and saying 0 would be inventing one.
		return 0, false, nil
	}
	return 0, false, err
}

// isClosedError reports whether an error is the ordinary "it was already gone".
//
// `ssh.Session.Close` returns an error when the underlying channel has already
// been torn down by the far end, which is the normal shape of "the shell exited,
// then we closed it". Reporting that as a failure would make `ssh_close` fail
// every time a session had ended on its own — the common case, not the edge one.
func isClosedError(err error) bool {
	if err == nil {
		return true
	}
	text := err.Error()
	return strings.Contains(text, "closed") || strings.Contains(text, "EOF")
}
