package state

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// TestTheStoreTakesConcurrentSaves is the regression test for the crash that
// delegation introduces.
//
// A subagent checkpoints its own session from inside the parent's turn, so two
// goroutines reach Save with two different ids and one watermark map between
// them. Concurrent read and write of a Go map is not a lost update — it is a
// fatal error the runtime reports as "concurrent map writes", and it would take
// the whole session down in the middle of a delegation.
//
// It is written without the race detector on purpose: this machine's toolchain
// cannot build `-race` (it needs cgo), and a test that only runs where the
// detector works is a test that does not run here.
func TestTheStoreTakesConcurrentSaves(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	const writers = 8
	const rounds = 20

	var wait sync.WaitGroup
	errs := make(chan error, writers)
	for writer := 0; writer < writers; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			id := fmt.Sprintf("writer-%d", writer)
			session := NewEmptySession(id)
			for round := 0; round < rounds; round++ {
				session.Append(map[string]any{"role": "user", "content": fmt.Sprintf("%d", round)})
				if err := store.Save(session); err != nil {
					errs <- fmt.Errorf("%s round %d: %w", id, round, err)
					return
				}
			}
		}(writer)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	// Every writer's file has to be complete, not merely present: a save that
	// interleaved with another would have written fewer messages than it was given.
	for writer := 0; writer < writers; writer++ {
		id := fmt.Sprintf("writer-%d", writer)
		saved, err := store.Load(id)
		if err != nil {
			t.Fatalf("load %s: %v", id, err)
		}
		if len(saved.Messages) != rounds {
			t.Errorf("%s has %d messages, want %d", id, len(saved.Messages), rounds)
		}
	}
}

// TestListParentIDsHidesDelegatedAgents is the property the session picker and
// `--list` both depend on.
//
// A subagent's session lives in the same store as the person's sessions — that is
// what makes a delegation auditable afterwards — so something has to separate
// them, and doing it by name is what keeps the picker from opening every file in
// the directory to decide what to draw.
func TestListParentIDsHidesDelegatedAgents(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{
		"20260101-120000",
		"sub-20260101-120000-1",
		"sub-20260101-120000-2",
		"demo",
	} {
		if err := store.Save(NewSession(id, t.TempDir())); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}

	// The store itself still lists everything: the filter belongs to the callers
	// that are offering a choice, not to the file listing.
	if got := len(store.ListIDs()); got != 4 {
		t.Errorf("ListIDs returned %d ids, want 4", got)
	}

	parents := store.ListParentIDs()
	want := []string{"20260101-120000", "demo"}
	if len(parents) != len(want) {
		t.Fatalf("ListParentIDs = %v, want %v", parents, want)
	}
	for index := range want {
		if parents[index] != want[index] {
			t.Fatalf("ListParentIDs = %v, want %v", parents, want)
		}
	}
}

// TestIsChildSessionIDDoesNotClaimOrdinarySessions matters because both callers
// stop showing anything this returns true for. A false positive hides somebody's
// real conversation from the list, which is worse than showing a subagent.
func TestIsChildSessionIDDoesNotClaimOrdinarySessions(t *testing.T) {
	for _, id := range []string{"20260101-120000", "demo", "submarine", "SUB-20260101-120000-1"} {
		if IsChildSessionID(id) {
			t.Errorf("IsChildSessionID(%q) = true", id)
		}
	}
	for _, id := range []string{"sub-demo-1", "sub-20260101-120000-1"} {
		if !IsChildSessionID(id) {
			t.Errorf("IsChildSessionID(%q) = false", id)
		}
	}
}

// TestDeleteRemovesTheFileAndTheWatermark covers the happy path and the part that
// is easy to forget: the watermark. A delete that left the mark in place would
// make the next Save for the same id append onto a fresh file whose head record
// was never written — the session would look loaded but replay to nothing.
func TestDeleteRemovesTheFileAndTheWatermark(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	session := NewEmptySession("20260101-120000")
	session.Append(map[string]any{"role": "user", "content": "hello"})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	if !store.Exists(session.SessionID) {
		t.Fatal("the session file is not there after a save")
	}

	if err := store.Delete(session.SessionID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if store.Exists(session.SessionID) {
		t.Error("the file survived Delete")
	}

	// A fresh session reusing the id saves from scratch: the head record has to
	// be written again, which only happens when the watermark is really gone.
	second := NewEmptySession(session.SessionID)
	second.Append(map[string]any{"role": "user", "content": "again"})
	if err := store.Save(second); err != nil {
		t.Fatalf("save after delete: %v", err)
	}
	reloaded, err := store.Load(session.SessionID)
	if err != nil {
		t.Fatalf("load after re-save: %v", err)
	}
	if len(reloaded.Messages) != 1 {
		t.Errorf("re-saved session has %d messages, want 1 (the head record was not rewritten)", len(reloaded.Messages))
	}
}

// TestDeleteRefusesDelegatedSessions is the fail-closed half: a `sub-` file
// belongs to a task in its parent's transcript, and a delete request naming one
// is a caller bug, not something to perform.
func TestDeleteRefusesDelegatedSessions(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(NewSession("sub-parent-1", t.TempDir())); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := store.Delete("sub-parent-1"); err == nil {
		t.Fatal("Delete accepted a delegated session id")
	}
	if !store.Exists("sub-parent-1") {
		t.Error("the child session file was removed anyway")
	}
}

// TestDeleteRefusesBadIDs exercises the path-traversal guard: the id is spliced
// into a file name, so the check in Path is what keeps `../` out.
func TestDeleteRefusesBadIDs(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "../escape", "a/b", "with space"} {
		if err := store.Delete(id); err == nil {
			t.Errorf("Delete(%q) succeeded", id)
		}
	}
}

// TestDeleteReportsAMissingFile: deleting something that is not there is a
// distinct error from deleting something forbidden — a front end showing the
// list has already filtered out files that do not exist, so this case arriving
// means the list and the store disagreed, and the message should say which file.
func TestDeleteReportsAMissingFile(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	err = store.Delete("20260101-120000")
	if err == nil {
		t.Fatal("Delete succeeded on a file that does not exist")
	}
	if !strings.Contains(err.Error(), "20260101-120000") {
		t.Errorf("the error does not name the file: %v", err)
	}
}
