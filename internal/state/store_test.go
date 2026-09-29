package state

import (
	"fmt"
	"os"
	"path/filepath"
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

// TestLoadSummaryMatchesLoad is the contract the session list is built on: the
// cheap scan has to agree with a full Load on every number the list prints, or
// the picker lies about the session it is offering.
func TestLoadSummaryMatchesLoad(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	session := NewEmptySession("20260101-120000")
	session.CreatedAt = 1700000000
	session.Metadata["todos"] = []any{
		map[string]any{"content": "first", "status": "completed"},
		map[string]any{"content": "second", "status": "pending"},
	}
	session.Append(map[string]any{"role": "user", "content": "  hello   world  "})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	// A second round: more messages, changed metadata (a fresh `meta` record, and
	// readers take the last one), and a `ctx` record — the kind of line the
	// summary scan exists to skip.
	session.Append(map[string]any{"role": "assistant", "content": "hi"})
	session.Append(map[string]any{"role": "user", "content": "second question"})
	session.Metadata["todos"] = []any{
		map[string]any{"content": "first", "status": "completed"},
		map[string]any{"content": "second", "status": "completed"},
	}
	session.Context = map[string]any{"artifacts": []any{"art_1"}}
	if err := store.Save(session); err != nil {
		t.Fatalf("second save: %v", err)
	}

	loaded, err := store.Load("20260101-120000")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	summary, err := store.LoadSummary("20260101-120000", 40)
	if err != nil {
		t.Fatalf("LoadSummary: %v", err)
	}

	if summary.CreatedAt != loaded.CreatedAt {
		t.Errorf("CreatedAt = %v, want %v", summary.CreatedAt, loaded.CreatedAt)
	}
	if summary.Messages != len(loaded.Messages) {
		t.Errorf("Messages = %d, want %d", summary.Messages, len(loaded.Messages))
	}
	if summary.Steps != loaded.StepCount() {
		t.Errorf("Steps = %d, want %d", summary.Steps, loaded.StepCount())
	}
	if summary.Preview != "hello world" {
		t.Errorf("Preview = %q, want %q (folded, first user message)", summary.Preview, "hello world")
	}
	// The metadata a todo line is drawn from has to be the **last** record's, not
	// the first: the list showing stale task state is exactly what a resumed
	// session then contradicts.
	todos, _ := summary.Metadata["todos"].([]any)
	if len(todos) != 2 {
		t.Fatalf("summary metadata has %v, want the last meta record", summary.Metadata)
	}
	last, _ := todos[1].(map[string]any)
	if last["status"] != "completed" {
		t.Errorf("summary metadata is the first meta record, want the last: %v", todos)
	}
	if _, modified := store.FileTimes("20260101-120000"); modified == nil || *modified != summary.ModifiedAt {
		t.Errorf("ModifiedAt = %v, want the file mtime %v", summary.ModifiedAt, modified)
	}
}

// TestLoadSummaryTruncatesThePreview pins the cap: the preview exists to be one
// line in a picker, and a session that opens with a pasted log must not put the
// log in the list. The ellipsis is the same one the old list code added.
func TestLoadSummaryTruncatesThePreview(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := NewEmptySession("20260101-120000")
	session.Append(map[string]any{"role": "user", "content": strings.Repeat("x", 100)})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	summary, err := store.LoadSummary("20260101-120000", 40)
	if err != nil {
		t.Fatalf("LoadSummary: %v", err)
	}
	want := strings.Repeat("x", 40) + "…"
	if summary.Preview != want {
		t.Errorf("Preview = %q, want %q", summary.Preview, want)
	}
}

// TestLoadSummarySkipsTheFirstTextlessUserMessage: the preview is the first user
// message **with text**, which is what the list showed before. A user record
// whose body has no describable text (an empty parts array) must not become an
// empty preview while a later message had one.
func TestLoadSummarySkipsTheFirstTextlessUserMessage(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := NewEmptySession("20260101-120000")
	session.Append(map[string]any{"role": "user", "content": []any{}})
	session.Append(map[string]any{"role": "user", "content": "the real question"})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	summary, err := store.LoadSummary("20260101-120000", 40)
	if err != nil {
		t.Fatalf("LoadSummary: %v", err)
	}
	if summary.Preview != "the real question" {
		t.Errorf("Preview = %q, want %q", summary.Preview, "the real question")
	}
}

// TestLoadSummaryRefusesANewerFile matches Load: a file written by a version
// that knows records this one does not is refused, not guessed at. The check has
// to fire on the `head` record in particular, because that is the line the
// summary scan reads before anything else.
func TestLoadSummaryRefusesANewerFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "20260101-120000"+Suffix)
	body := fmt.Sprintf(`{"v":%d,"type":"head","session_id":"20260101-120000","created_at":1}`, StateVersion+1) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadSummary("20260101-120000", 40); err == nil {
		t.Fatal("LoadSummary accepted a file from a newer version")
	}
	if _, err := store.Load("20260101-120000"); err == nil {
		t.Fatal("Load accepted a file from a newer version")
	}
}

// TestLoadSummarySurvivesHalfLines: a process killed mid-write leaves a line
// that is not JSON. Load skips it and so must the summary — one broken tail must
// not make the session unreadable in the picker.
func TestLoadSummarySurvivesHalfLines(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	session := NewEmptySession("20260101-120000")
	session.CreatedAt = 1700000000
	session.Append(map[string]any{"role": "user", "content": "before the crash"})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	path := filepath.Join(dir, "20260101-120000"+Suffix)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"v":1,"type":"msg","message":{"role":"assis`); err != nil {
		t.Fatal(err)
	}
	file.Close()

	summary, err := store.LoadSummary("20260101-120000", 40)
	if err != nil {
		t.Fatalf("LoadSummary: %v", err)
	}
	if summary.Messages != 1 || summary.Preview != "before the crash" {
		t.Errorf("summary = %+v, want the intact records only", summary)
	}
}

// TestLoadSummaryReportsAMissingFile: the error has to be the same shape Load
// produces, because the session list prints it verbatim in place of the preview
// and a caller cannot tell the two apart.
func TestLoadSummaryReportsAMissingFile(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadSummary("20260101-120000", 40); err == nil {
		t.Fatal("LoadSummary succeeded on a file that does not exist")
	}
}
