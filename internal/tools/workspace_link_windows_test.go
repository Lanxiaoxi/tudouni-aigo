//go:build windows

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A junction is the one link an ordinary Windows user can create with no
// privilege, and `filepath.EvalSymlinks` does not resolve it. This is the shape
// that was measured: SafePath returned the path unchanged, `os.ReadFile` read the
// file outside the workspace, and `os.WriteFile` wrote one there. The control
// plane went the same way, through a junction whose *name* was not a control
// plane name.
func TestALinkTheProgramCannotResolveIsRefused(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "ws")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{root, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("OUTSIDE-SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := createJunction(filepath.Join(root, "link"), outside); err != nil {
		t.Skipf("cannot create a junction here: %v", err)
	}

	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}

	if got, err := workspace.SafePath(filepath.Join("link", "secret.txt")); err == nil {
		t.Errorf("a read through a junction was allowed: %q", got)
	}
	if got, err := workspace.WritablePath(filepath.Join("link", "pwned.txt")); err == nil {
		t.Errorf("a write through a junction was allowed: %q", got)
	}

	// The ordinary cases must survive the new check: a file that does not exist
	// yet is what every write starts with, and a real directory is not a link.
	if _, err := workspace.WritablePath(filepath.Join("notes", "new.md")); err != nil {
		t.Errorf("a new file was refused: %v", err)
	}
	if _, err := workspace.WritablePath("notes.md"); err != nil {
		t.Errorf("a file at the root was refused: %v", err)
	}
}

// createJunction makes a directory junction. `mklink` is the only way to do it
// without a native reparse-point call, and it is exactly what an attacker would
// run, so the test uses the same door.
func createJunction(link, target string) error {
	return exec.Command("cmd", "/c", "mklink", "/J", link, target).Run()
}
