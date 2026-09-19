package builtin

import (
	"os"
	"path/filepath"
	"testing"
)

// TestPruneReportsWhatThePreviousRunLeft is the number the start-up warning is built on.
//
// The count answers "what did the previous run leave in this directory", which is the
// evidence that the session did not exit cleanly and that its commands may still be
// running. It used to be written as `if err == nil { count++ } else { count++ }`, which
// claimed to tell a failed removal from a successful one and did not — the next reader
// would believe the failure was handled somewhere.
func TestPruneReportsWhatThePreviousRunLeft(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.out", "b.out", "keep.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	board := &JobBoard{dir: dir}
	if got := board.prune(); got != 2 {
		t.Errorf("prune reported %d leftovers, want the two .out files", got)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "keep.txt" {
		t.Errorf("the directory holds %v, want only keep.txt", entries)
	}
}
