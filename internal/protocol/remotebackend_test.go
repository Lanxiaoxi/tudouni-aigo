package protocol

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
)

// TestBuildRuntimeCommandQuotesEveryToken checks that the command line
// RemoteBackend hands to the SSH session has no bare token a shell could
// reinterpret — the design's own requirement: "command arguments and remote
// paths must be safely escaped, and user input must not be concatenated
// directly into a shell command."
func TestBuildRuntimeCommandQuotesEveryToken(t *testing.T) {
	command := buildRuntimeCommand("/opt/tudouni/bin/tudouni-aigo", []string{"--session", "a; rm -rf /"})

	want := "'/opt/tudouni/bin/tudouni-aigo' --runtime-stdio '--session' 'a; rm -rf /'"
	if command != want {
		t.Errorf("buildRuntimeCommand = %q, want %q", command, want)
	}
}

// TestBuildRuntimeCommandHandlesAPathWithASingleQuote is the case single
// quoting alone cannot ignore: a path containing a quote character must still
// come out as one argument, with the quote itself escaped rather than ending
// the quoted string early.
func TestBuildRuntimeCommandHandlesAPathWithASingleQuote(t *testing.T) {
	command := buildRuntimeCommand("/home/o'brien/tudouni-aigo", nil)
	want := "'/home/o'\\''brien/tudouni-aigo' --runtime-stdio"
	if command != want {
		t.Errorf("buildRuntimeCommand = %q, want %q", command, want)
	}
}

// TestNewRemoteBackendStartRefusesAnEmptyBinaryPath checks the one precondition
// RemoteBackend.Start enforces itself, before ever touching the network: a
// Remote Bootstrapper (a later phase) is what is supposed to have already
// confirmed a verified absolute path exists, and a RemoteBackend built without
// one must fail immediately rather than ask SSH to run an empty command.
func TestNewRemoteBackendStartRefusesAnEmptyBinaryPath(t *testing.T) {
	backend := NewRemoteBackend(ssh.Host{HostName: "example.test", Port: 22, User: "deploy"}, "", nil)
	if _, _, _, err := backend.Start(); err == nil {
		t.Fatal("Start succeeded with no binary path")
	}
}
