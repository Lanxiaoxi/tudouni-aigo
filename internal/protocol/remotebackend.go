package protocol

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
)

// RemoteBackend starts the runtime on another machine, reached over SSH, and
// carries the protocol over that session's stdio.
//
// It is deliberately thin, matching the design's own boundary: "Remote Backend
// is responsible for transport and connection lifecycle, not for reimplementing
// tool calls or approval logic." Everything about *that* stays in Client and in
// the runtime itself, on the far end. What this type owns is:
//
//   - opening the SSH connection and a plain (non-PTY) session — see
//     ssh.DialRuntimeSession for why no PTY is requested;
//   - building the one command that session runs: the absolute path to the
//     remote runtime binary, `--runtime-stdio`, and the caller's arguments,
//     each shell-quoted so a workspace path or session id cannot change what
//     runs;
//   - handing back that session's stdin/stdout/stderr, unmodified — this type
//     never reads a line of them itself, so it cannot drift from the protocol
//     Client already speaks;
//   - the connection's lifecycle: Wait, Kill, Close.
//
// Protocol readiness — did the thing that started actually come up as this
// protocol, at a compatible version — is checked by the caller after Start
// returns, the same way Client would check a local runtime's first message.
// See Client.StartWithBackend.
type RemoteBackend struct {
	// Host is the resolved SSH destination. Resolving an alias from
	// ~/.ssh/config happens before this type is built — a RemoteBackend never
	// reads that file itself — so Host already carries HostName, Port, User and
	// how to authenticate.
	Host ssh.Host
	// BinaryPath is the absolute path to the runtime executable on the remote
	// host. It is required and is never looked up on the remote PATH: the
	// design calls for "using absolute paths to start the Runtime" exactly
	// because a PATH lookup can find a different build with the same name.
	BinaryPath string
	// Arguments are the extra flags the runtime should start with — the same
	// values LocalBackend.Arguments carries (--session, --max-steps, and so
	// on), not including --runtime-stdio, which is always added.
	Arguments []string
	// ConnectTimeout bounds the TCP handshake, key exchange and authentication.
	// Zero means ssh.DialRuntimeSession's own default.
	ConnectTimeout time.Duration
	// ConfigPath and Home locate ~/.ssh/config and ~/.ssh/known_hosts. Empty
	// means the user's own files, same convention as ssh.NewManager.
	ConfigPath string
	Home       string

	session *ssh.RuntimeSession
}

// NewRemoteBackend builds a backend that will start binaryPath on host over
// SSH, once Start is called.
func NewRemoteBackend(host ssh.Host, binaryPath string, arguments []string) *RemoteBackend {
	return &RemoteBackend{Host: host, BinaryPath: binaryPath, Arguments: arguments}
}

// Start opens the SSH connection, starts the remote runtime without a PTY, and
// returns its stdio.
//
// A failure here is always a connection or launch failure — nothing about the
// protocol has been read yet, so an error from Start is reported the same way
// a local exec.Cmd failure would be, before Client has anything resembling a
// runtime to talk to.
func (b *RemoteBackend) Start() (io.WriteCloser, io.Reader, io.Reader, error) {
	if strings.TrimSpace(b.BinaryPath) == "" {
		return nil, nil, nil, fmt.Errorf("remote backend: no runtime binary path was given")
	}

	command := buildRuntimeCommand(b.BinaryPath, b.Arguments)

	session, stdin, stdout, stderr, err := ssh.DialRuntimeSession(b.Host, command, b.ConnectTimeout, b.Home)
	if err != nil {
		return nil, nil, nil, err
	}
	b.session = session
	return stdin, stdout, stderr, nil
}

// buildRuntimeCommand assembles the shell command line a RuntimeSession runs:
// the absolute binary path, --runtime-stdio, then the caller's arguments —
// every token quoted so none of them can be reinterpreted by the remote shell.
func buildRuntimeCommand(binaryPath string, arguments []string) string {
	tokens := make([]string, 0, len(arguments)+2)
	tokens = append(tokens, ssh.QuoteShellArgument(binaryPath), "--runtime-stdio")
	for _, argument := range arguments {
		tokens = append(tokens, ssh.QuoteShellArgument(argument))
	}
	return strings.Join(tokens, " ")
}

// Wait blocks until the remote runtime process ends and reports its exit code.
func (b *RemoteBackend) Wait() (int, bool, error) {
	if b.session == nil {
		return 0, false, nil
	}
	return b.session.Wait()
}

// Kill ends the remote process without waiting for it to exit on its own.
func (b *RemoteBackend) Kill() error {
	if b.session == nil {
		return nil
	}
	return b.session.Kill()
}

// Close ends the SSH session and the connection beneath it.
//
// This is the step that actually releases the SSH resources the design calls
// for: "On normal shutdown... release the SSH session" and "On unexpected
// disconnection... clean up the remote process as much as possible." Close is
// safe to call after Kill or after Wait has already returned.
func (b *RemoteBackend) Close() error {
	if b.session == nil {
		return nil
	}
	return b.session.Close()
}
