package bootstrap

import (
	"strings"
	"testing"
)

// TestQuoteShellArgumentIsInertAgainstMetacharacters mirrors the equivalent
// test in internal/ssh and ssh_backend.rs exactly — see quoteShellArgument's
// own doc for why the algorithm is duplicated rather than imported, and why
// this test (checked against the same cases) is what keeps the duplicates
// from drifting apart.
func TestQuoteShellArgumentIsInertAgainstMetacharacters(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"plain", "/opt/tudouni-aigo", "'/opt/tudouni-aigo'"},
		{"space", "a b", "'a b'"},
		{"semicolon injection", "a; rm -rf /", "'a; rm -rf /'"},
		{"dollar expansion", "$(whoami)", "'$(whoami)'"},
		{"single quote", "o'brien", "'o'\\''brien'"},
		{"empty", "", "''"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := quoteShellArgument(tc.input); got != tc.want {
				t.Errorf("quoteShellArgument(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestVerifyAndSwitchCommandRepointsCurrentLinkLast is the one ordering
// guarantee §8.4 requires: "switch only after verification succeeds," which
// this test reads directly off the generated command rather than trusting
// the implementation's own account of itself — the last `&&`-joined step
// must be the one that touches CurrentLink.
func TestVerifyAndSwitchCommandRepointsCurrentLinkLast(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "1.0.0", testTarget())
	command := l.VerifyAndSwitchCommand("")
	steps := strings.Split(command, " && ")
	last := steps[len(steps)-1]
	if !strings.Contains(last, "ln -sfn") || !strings.Contains(last, l.CurrentLink()) {
		t.Errorf("last step = %q, want it to repoint CurrentLink via ln -sfn", last)
	}
	// And nothing after the verification checks (test -f / test -d) may be a
	// read of StagingDir's content without having first confirmed it is
	// complete — i.e. the test steps must precede the mv/ln steps.
	var lastCheckIndex, firstMoveIndex int = -1, -1
	for i, step := range steps {
		if strings.HasPrefix(step, "test -f") || strings.HasPrefix(step, "test -d") {
			lastCheckIndex = i
		}
		if (strings.HasPrefix(step, "mv ") || strings.HasPrefix(step, "ln ")) && firstMoveIndex == -1 {
			firstMoveIndex = i
		}
	}
	if lastCheckIndex == -1 || firstMoveIndex == -1 || lastCheckIndex > firstMoveIndex {
		t.Errorf("verification steps (last at %d) do not all precede the switch steps (first at %d): %s",
			lastCheckIndex, firstMoveIndex, command)
	}
}

// TestVerifyAndSwitchCommandQuotesEveryPath is §4.1's "command arguments and
// remote paths must be safely escaped" applied to the one command that
// matters most: the one that deletes and moves directories. A version
// string containing a shell metacharacter is unlikely in practice (versions
// come from this project's own VERSION file) but the quoting must not
// assume otherwise — the same principle buildRuntimeCommand on the Go
// protocol side and quote_shell_argument on the Rust side both hold to.
func TestVerifyAndSwitchCommandQuotesEveryPath(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "1.0.0; rm -rf /", testTarget())
	command := l.VerifyAndSwitchCommand("0.9.0")
	for _, path := range []string{l.StagingDir(), l.VersionDir(), l.CurrentLink()} {
		if strings.Contains(command, path) && !strings.Contains(command, "'"+path+"'") {
			t.Errorf("path %q appears unquoted in the command: %s", path, command)
		}
	}
}

// TestVerifyAndSwitchCommandIncludesABackupStepOnlyWhenGivenAVersion covers
// both branches of the optional backup: a fresh install (no previous
// version to preserve) must not reference backups/ at all, and an upgrade
// must.
func TestVerifyAndSwitchCommandIncludesABackupStepOnlyWhenGivenAVersion(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "2.0.0", testTarget())

	fresh := l.VerifyAndSwitchCommand("")
	if strings.Contains(fresh, "/backups/") {
		t.Errorf("a fresh install's command references backups/: %s", fresh)
	}

	upgrade := l.VerifyAndSwitchCommand("1.9.0")
	if !strings.Contains(upgrade, l.BackupDir("1.9.0")) {
		t.Errorf("an upgrade's command does not reference the backup directory for 1.9.0: %s", upgrade)
	}
}

func TestRollbackCommandNamesTheBackupAndTheCurrentLink(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "2.0.0", testTarget())
	command := l.RollbackCommand("1.9.0")
	if !strings.Contains(command, l.BackupDir("1.9.0")) {
		t.Errorf("RollbackCommand does not reference the backup directory: %s", command)
	}
	if !strings.Contains(command, l.CurrentLink()) {
		t.Errorf("RollbackCommand does not repoint CurrentLink: %s", command)
	}
}

func TestCleanupStagingCommandOnlyTouchesTheStagingDirectory(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "2.0.0", testTarget())
	command := l.CleanupStagingCommand()
	if !strings.Contains(command, l.StagingDir()) {
		t.Errorf("CleanupStagingCommand does not reference StagingDir: %s", command)
	}
	if strings.Contains(command, l.VersionDir()) {
		t.Errorf("CleanupStagingCommand references VersionDir, which it must never touch: %s", command)
	}
	if strings.Contains(command, l.CurrentLink()) {
		t.Errorf("CleanupStagingCommand references CurrentLink, which it must never touch: %s", command)
	}
}
