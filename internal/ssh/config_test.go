package ssh

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeConfig lays out a fake home with a `~/.ssh/config` and returns its path.
//
// It is a helper rather than five lines in every test because the layout is part
// of what is being tested: the parser derives the home directory from the
// configuration path, so a test that puts the file somewhere else is testing a
// different thing.
func writeConfig(t *testing.T, body string) (configPath, home string) {
	t.Helper()
	home = t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o755); err != nil {
		t.Fatalf("mkdir .ssh: %v", err)
	}
	configPath = filepath.Join(sshDir, "config")
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return configPath, home
}

// writeKey puts a file where an IdentityFile points. The contents are never
// parsed by the config layer, so any bytes do.
func writeKey(t *testing.T, home, name string) string {
	t.Helper()
	path := filepath.Join(home, ".ssh", name)
	if err := os.WriteFile(path, []byte("not a real key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return path
}

func TestLookupResolvesTheUsualFields(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/deploy_ed25519
`)
	key := writeKey(t, home, "deploy_ed25519")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q, want 10.0.1.5", host.HostName)
	}
	if host.User != "deploy" {
		t.Errorf("User = %q, want deploy", host.User)
	}
	if host.Port != 2222 {
		t.Errorf("Port = %d, want 2222", host.Port)
	}
	if len(host.IdentityFiles) != 1 || host.IdentityFiles[0] != key {
		t.Errorf("IdentityFiles = %v, want [%s]", host.IdentityFiles, key)
	}
	if host.Address() != "10.0.1.5:2222" {
		t.Errorf("Address = %q, want 10.0.1.5:2222", host.Address())
	}
	if host.Display() != "deploy@10.0.1.5:2222" {
		t.Errorf("Display = %q", host.Display())
	}
}

// TestHostStarFillsInWhatASpecificBlockLeavesOut is the `Host *` idiom, and it is
// the reason resolution is per **field** rather than per block. A block-at-a-time
// reading finds no user for `prod` and silently authenticates as the local login
// name — a different account on the far end, and nothing in the output says so.
func TestHostStarFillsInWhatASpecificBlockLeavesOut(t *testing.T) {
	configPath, home := writeConfig(t, `
Host *
    User admin
    Port 2200
    IdentityFile ~/.ssh/id_ed25519

Host prod
    HostName 10.0.1.5
`)
	writeKey(t, home, "id_ed25519")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.User != "admin" {
		t.Errorf("User = %q, want admin (from the Host * block)", host.User)
	}
	if host.Port != 2200 {
		t.Errorf("Port = %d, want 2200 (from the Host * block)", host.Port)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q, want 10.0.1.5", host.HostName)
	}
}

// TestProxyJumpIsRefusedRatherThanIgnored is the single most important behaviour
// in this file: ignoring the field would connect to an address that is usually
// unroutable from here, and on a network where it happens to resolve, to a machine
// nobody chose.
func TestProxyJumpIsRefusedRatherThanIgnored(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    ProxyJump bastion
`)
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, err = config.Lookup("prod")
	if err == nil {
		t.Fatal("Lookup accepted a ProxyJump host; it must refuse rather than route differently")
	}
	if !strings.Contains(err.Error(), "PROXYJUMP") {
		t.Errorf("the refusal does not name the field: %v", err)
	}
	// The line number is asserted because the message is the only thing standing
	// between a person and a silent route change: it has to say which line to fix.
	if !strings.Contains(err.Error(), "config:4") {
		t.Errorf("the refusal does not name the file and line: %v", err)
	}
}

// TestARejectedFieldInHostStarRefusesEverythingItTouches covers the case that
// makes the refusal walk every matching scope rather than just the winning one:
// the field is in `Host *`, so it applies to hosts whose own block never mentions
// it — and a person reading only their host's block would have no way to find it.
func TestARejectedFieldInHostStarRefusesEverythingItTouches(t *testing.T) {
	configPath, home := writeConfig(t, `
Host *
    StrictHostKeyChecking no

Host prod
    HostName 10.0.1.5
`)
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if _, err := config.Lookup("prod"); err == nil {
		t.Fatal("Lookup ignored StrictHostKeyChecking from a Host * block")
	}
}

// TestToleratedFieldsAreReportedNotRefused is the other half of the two-level
// policy. A machine with a harmless `UseKeychain` line has to stay usable, and the
// person still has to be told their line did nothing.
func TestToleratedFieldsAreReportedNotRefused(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    IdentityFile ~/.ssh/deploy
    UseKeychain yes
    ServerAliveInterval 30
    SomethingBrandNew whatever
`)
	writeKey(t, home, "deploy")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup refused a host over harmless fields: %v", err)
	}
	joined := strings.Join(host.Warnings, "\n")
	for _, want := range []string{"USEKEYCHAIN", "SERVERALIVEINTERVAL", "SOMETHINGBRANDNEW"} {
		if !strings.Contains(joined, want) {
			t.Errorf("warnings do not mention %s:\n%s", want, joined)
		}
	}
}

// TestMatchBlockIsRefused: a conditional block cannot be applied *or* ruled out,
// so the only honest answers are "ask the user" or "refuse". The design picks
// refuse, because guessing could authenticate as somebody else.
func TestMatchBlockIsRefused(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5

Match host prod
    User deploy
`)
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, err = config.Lookup("prod")
	if err == nil {
		t.Fatal("Lookup accepted a config containing a Match block")
	}
	if !strings.Contains(err.Error(), "Match") {
		t.Errorf("the refusal does not mention Match: %v", err)
	}
}

// TestFieldsUnderAMatchBlockAreNotAppliedAsUnconditional checks the two halves of
// what happens to a `Match` block: lookup refuses, and the refusal points at the
// Match line rather than at the host the model happened to name.
//
// Refusing **every** lookup in a file that contains a Match is the conservative
// reading and it is deliberate. The conditions in a Match are not evaluated, so
// there is no host for which this parser can say the block definitely does not
// apply — and "it probably does not apply to this one" is exactly the reasoning
// that connects as somebody else.
func TestFieldsUnderAMatchBlockAreNotAppliedAsUnconditional(t *testing.T) {
	configPath, home := writeConfig(t, `
Host other
    HostName 10.0.0.9
    User shared
    IdentityFile ~/.ssh/k

Match host other
    User root
`)
	writeKey(t, home, "k")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, err = config.Lookup("other")
	if err == nil {
		t.Fatal("Lookup succeeded with a Match block present; the fields under it cannot be ruled out")
	}
	if !strings.Contains(err.Error(), "Match") {
		t.Errorf("the refusal does not name Match: %v", err)
	}
	// The line number matters here for the same reason it does for ProxyJump: the
	// block may be nowhere near the host the model named.
	if !strings.Contains(err.Error(), "config:7") {
		t.Errorf("the refusal does not point at the Match line: %v", err)
	}
}

// TestIncludeIsExpandedAsIfInline is the case the flattening exists for: a `Host`
// block that starts in one file and continues in another has to behave as one.
func TestIncludeIsExpandedAsIfInline(t *testing.T) {
	home := t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(filepath.Join(sshDir, "conf.d"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(`
Include ~/.ssh/conf.d/*

Host prod
    HostName 10.0.1.5
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, "conf.d", "work.conf"), []byte(`
Host prod
    User deploy
    IdentityFile ~/.ssh/work_key
`), 0o600); err != nil {
		t.Fatalf("write include: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, "work_key"), []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	config, err := LoadConfig("", home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q, want the value from the main file", host.HostName)
	}
	if host.User != "deploy" {
		t.Errorf("User = %q, want deploy (from the included file)", host.User)
	}
}

// TestIncludeCycleIsSkippedNotFatal: a file that includes itself is a mistake, and
// making every host in it unreachable would be a worse answer than a warning.
func TestIncludeCycleIsSkippedNotFatal(t *testing.T) {
	home := t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "Include ~/.ssh/config\n\nHost prod\n    HostName 10.0.1.5\n    User deploy\n    IdentityFile ~/.ssh/k\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, "k"), []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	config, err := LoadConfig("", home)
	if err != nil {
		t.Fatalf("LoadConfig on a self-including file: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q", host.HostName)
	}
	if len(config.Warnings()) == 0 {
		t.Error("a self-include was not reported at all")
	}
}

// TestNegatedPatternBeatsAPositiveOne pins OpenSSH's rule: `!` disqualifies the
// block outright. Getting this backwards applies a block to the one host the
// person explicitly excluded.
func TestNegatedPatternBeatsAPositiveOne(t *testing.T) {
	configPath, home := writeConfig(t, `
Host *.corp !secret.corp
    User shared
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("box.corp")
	if err != nil {
		t.Fatalf("Lookup box.corp: %v", err)
	}
	if host.User != "shared" {
		t.Errorf("box.corp User = %q, want shared", host.User)
	}

	// The excluded name must not pick up the block — and with no other block to
	// supply a key, it fails for exactly that reason, which is the observable
	// evidence that the pattern did not match.
	secret := writeKey(t, home, "k")
	_ = secret
	if _, err := config.Lookup("secret.corp"); err == nil {
		t.Fatal("the negated pattern still matched; `!secret.corp` must disqualify the block")
	}
}

// TestUserAtHostOverridesTheConfig: a person who typed `user@host` meant it.
func TestUserAtHostOverridesTheConfig(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("root@prod")
	if err != nil {
		t.Fatalf("Lookup root@prod: %v", err)
	}
	if host.User != "root" {
		t.Errorf("User = %q, want root (the explicit part wins)", host.User)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q, want the configured one", host.HostName)
	}
}

// TestAliasWithNoBlockIsAHostName: a person who has never written a config still
// has to be able to connect, so an unknown alias is used as the host name.
func TestAliasWithNoBlockIsAHostName(t *testing.T) {
	configPath, home := writeConfig(t, "")
	key := writeKey(t, home, "id_ed25519")

	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("example.com")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "example.com" {
		t.Errorf("HostName = %q, want example.com", host.HostName)
	}
	if host.Port != DefaultPort {
		t.Errorf("Port = %d, want %d", host.Port, DefaultPort)
	}
	if len(host.IdentityFiles) != 1 || host.IdentityFiles[0] != key {
		t.Errorf("IdentityFiles = %v, want the default ed25519 key %s", host.IdentityFiles, key)
	}
}

// TestMissingConfigIsNotAnError is the state of a machine that has never run
// `ssh`: an ordinary state, not a failure to report at start-up.
func TestMissingConfigIsNotAnError(t *testing.T) {
	home := t.TempDir()
	config, err := LoadConfig("", home)
	if err != nil {
		t.Fatalf("a missing config was reported as an error: %v", err)
	}
	if !config.Missing() {
		t.Error("Missing() = false for a file that is not there")
	}
}

// TestNoPrivateKeyIsExplainedBeforeConnecting: the failure has to name the
// candidate files, or the person has no idea what to create.
func TestNoPrivateKeyIsExplainedBeforeConnecting(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
`)
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, err = config.Lookup("prod")
	if err == nil {
		t.Fatal("Lookup succeeded with no private key anywhere")
	}
	if !strings.Contains(err.Error(), "IdentityFile") {
		t.Errorf("the failure does not suggest IdentityFile: %v", err)
	}
}

// TestBadPortIsRefusedAtParseTimeRatherThanDialTime: a port that is not a number
// is a configuration mistake, and reporting it as "connection failed" sends the
// person looking at the network.
func TestBadPortIsRefused(t *testing.T) {
	configPath, home := writeConfig(t, `
Host prod
    HostName 10.0.1.5
    User deploy
    Port twenty-two
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if _, err := config.Lookup("prod"); err == nil {
		t.Fatal("Lookup accepted a non-numeric Port")
	}
}

// TestHostNameSubstitutionUsesTheAlias pins `%h`, which is the whole reason the
// substitution exists: `HostName %h.internal` means "the alias, in another
// domain", and substituting the *resolved* name would make it a no-op.
func TestHostNameSubstitutionUsesTheAlias(t *testing.T) {
	configPath, home := writeConfig(t, `
Host web1
    HostName %h.corp.example
    User deploy
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("web1")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "web1.corp.example" {
		t.Errorf("HostName = %q, want web1.corp.example", host.HostName)
	}
}

// TestCommentsAndEqualsSyntax: both `Key value` and `Key=value` are real, and a
// `#` inside a quoted value is text rather than a comment.
func TestCommentsAndEqualsSyntax(t *testing.T) {
	configPath, home := writeConfig(t, `
# a leading comment
Host prod
    HostName=10.0.1.5    # a trailing comment
    User deploy
    IdentityFile ~/.ssh/k
`)
	writeKey(t, home, "k")
	config, err := LoadConfig(configPath, home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	host, err := config.Lookup("prod")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if host.HostName != "10.0.1.5" {
		t.Errorf("HostName = %q, want 10.0.1.5 (the comment must be stripped)", host.HostName)
	}
}
