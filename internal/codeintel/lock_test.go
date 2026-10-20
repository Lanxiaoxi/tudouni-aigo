package codeintel

// The two pieces that are not about parsing: the workspace's settings and the claim that
// keeps two sessions off one index.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestConfigDefaultsToOff(t *testing.T) {
	root := t.TempDir()
	config := LoadConfig(root)
	if config.Enabled {
		t.Error("code intelligence is on for a workspace that was never configured")
	}
	if config.Version != ConfigVersion {
		t.Errorf("version = %d, want %d", config.Version, ConfigVersion)
	}
}

func TestConfigRoundTrip(t *testing.T) {
	root := t.TempDir()
	if _, err := SetEnabled(root, true); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	if !Enabled(root) {
		t.Error("the switch did not survive being written")
	}
	// The file has to be somewhere a person can find it, and nowhere two features share:
	// the memory settings live next door and a rewrite of one must not drop the other.
	path := ConfigPath(root)
	if want := filepath.Join(root, ".tudouni", "codeintel", "config.json"); path != want {
		t.Errorf("ConfigPath = %q, want %q", path, want)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("config.json: %v", err)
	}
	var decoded Config
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("config.json does not parse: %v (%s)", err, raw)
	}
	if !decoded.Enabled {
		t.Error("the file says off after turning it on")
	}

	if _, err := SetEnabled(root, false); err != nil {
		t.Fatalf("SetEnabled off: %v", err)
	}
	if Enabled(root) {
		t.Error("the switch did not survive being turned off")
	}
}

// TestBrokenConfigReadsAsOff: this is read on the path that builds the tool registry, so a
// truncated file must not stop a session from opening — the switch is the compromise, and
// it is the state the person is shown and can fix in one click.
func TestBrokenConfigReadsAsOff(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(ConfigPath(root)), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(ConfigPath(root), []byte(`{"version": 1, "enabled": `), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if Enabled(root) {
		t.Error("a half-written config turned the capability on")
	}
}

func TestAcquireIsExclusive(t *testing.T) {
	root := t.TempDir()

	first, err := Acquire(root, 0)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}

	if _, err := Acquire(root, 0); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Acquire = %v, want ErrLocked", err)
	}
	// The claim names its holder, so a person who sees "another session" can check.
	if holder := Holder(root); holder != strconv.Itoa(os.Getpid()) {
		t.Errorf("Holder = %q, want this process's pid", holder)
	}

	first.Release()
	second, err := Acquire(root, 0)
	if err != nil {
		t.Fatalf("Acquire after Release: %v", err)
	}
	second.Release()
}

// TestAStaleClaimIsTakenOver is the one failure a lock file has: a process that died while
// holding it. Without this rule the workspace's index can never be updated again until
// somebody knows to delete a hidden file.
func TestAStaleClaimIsTakenOver(t *testing.T) {
	root := t.TempDir()
	path := LockPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("999999\n"+strconv.FormatInt(time.Now().Add(-2*LockStaleAfter).UnixNano(), 10)+"\n"), 0o644); err != nil {
		t.Fatalf("write stale claim: %v", err)
	}

	lock, err := Acquire(root, 0)
	if err != nil {
		t.Fatalf("a stale claim was not taken over: %v", err)
	}
	lock.Release()
}

// TestWaitingIsBounded: a caller that asked to wait gets one more chance after the claim
// is released, and gives up with ErrLocked when the deadline passes.
func TestWaitingIsBounded(t *testing.T) {
	root := t.TempDir()
	held, err := Acquire(root, 0)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		released, err := Acquire(root, time.Second)
		if err == nil {
			released.Release()
		}
		done <- err
	}()

	time.Sleep(200 * time.Millisecond)
	held.Release()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a waiter did not get the claim after it was released: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the waiter never finished")
	}
}

// TestLockPathIsInsideTheIndex keeps the claim next to the thing it guards: a lock beside
// the workspace root would be one more file to ignore.
func TestLockPathIsInsideTheIndex(t *testing.T) {
	path := filepath.ToSlash(LockPath("/ws"))
	if !strings.HasSuffix(path, ".tudouni/index/lock") {
		t.Errorf("LockPath = %q, want it inside the index directory", path)
	}
}
