package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// TestSessionSummariesOrdersByCreationAndHidesChildren pins the two properties
// the picker depends on: newest first by **creation time** (an id like `demo` is
// not a timestamp), and subagent sessions never listed at all.
func TestSessionSummariesOrdersByCreationAndHidesChildren(t *testing.T) {
	dir := t.TempDir()
	store, err := state.NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	save := func(id string, createdAt float64, userText string) {
		session := state.NewEmptySession(id)
		session.CreatedAt = createdAt
		session.Append(map[string]any{"role": "user", "content": userText})
		if err := store.Save(session); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}
	save("20260101-120000", 100, "the older one")
	save("demo", 300, "a named session")
	save("20260102-120000", 200, "the middle one")
	save("sub-20260101-120000-1", 400, "a delegation")

	rows := SessionSummaries(store, 50, true)
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3 (sub- sessions are not resumable)", len(rows))
	}
	want := []string{"demo", "20260102-120000", "20260101-120000"}
	for index, id := range want {
		if rows[index]["session_id"] != id {
			t.Errorf("row %d is %v, want %s (newest first by creation time)",
				index, rows[index]["session_id"], id)
		}
	}
	if got := rows[0]["preview"]; got != "a named session" {
		t.Errorf("preview = %q", got)
	}
	if rows[0]["modified_at"] == nil {
		t.Error("modified_at is nil for a readable session")
	}
}

// TestSessionSummariesCountsMessagesStepsAndTodos: the numbers in the list come
// from the summary scan, and a wrong count is a wrong claim about a session
// before the user has opened it.
func TestSessionSummariesCountsMessagesStepsAndTodos(t *testing.T) {
	store, err := state.NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := state.NewEmptySession("20260101-120000")
	session.CreatedAt = 100
	session.Metadata["todos"] = []any{
		map[string]any{"content": "one", "status": "completed"},
		map[string]any{"content": "two", "status": "pending"},
	}
	session.Append(map[string]any{"role": "user", "content": "do the thing"})
	session.Append(map[string]any{"role": "assistant", "content": "on it"})
	session.Append(map[string]any{"role": "user", "content": "and again"})
	session.Append(map[string]any{"role": "assistant", "content": "done"})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}

	rows := SessionSummaries(store, 50, true)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	if row["messages"] != 4 {
		t.Errorf("messages = %v, want 4", row["messages"])
	}
	if row["steps"] != 2 {
		t.Errorf("steps = %v, want 2", row["steps"])
	}
	if row["preview"] != "do the thing" {
		t.Errorf("preview = %q", row["preview"])
	}
	todos, _ := row["todos"].(string)
	if todos == "" {
		t.Error("todos line is empty for a session with a task list")
	}
	// The structured tally sits beside the pre-rendered sentence: a front end
	// drawing a bar reads the numbers, never the sentence's wording.
	if row["todo_done"] != 1 || row["todo_total"] != 2 {
		t.Errorf("todo counts = %v/%v, want 1/2", row["todo_done"], row["todo_total"])
	}
	// Zero totals are stated even with no list, never left absent — the same
	// never-optional rule `archived` follows on every row.
	session2 := state.NewEmptySession("20260101-130000")
	session2.CreatedAt = 200
	session2.Append(map[string]any{"role": "user", "content": "hello"})
	if err := store.Save(session2); err != nil {
		t.Fatalf("save second: %v", err)
	}
	rows = SessionSummaries(store, 50, true)
	row = rows[0]
	if row["todo_done"] != 0 || row["todo_total"] != 0 {
		t.Errorf("todo counts without a list = %v/%v, want 0/0", row["todo_done"], row["todo_total"])
	}
}

// TestSessionSummariesKeepsAnUnreadableFile: a file that cannot be read stays on
// the list with the reason in place of the preview — dropping it would hide a
// real problem. This used to fall out of the full-load path for free; the
// summary scan has to fail the same way.
func TestSessionSummariesKeepsAnUnreadableFile(t *testing.T) {
	dir := t.TempDir()
	store, err := state.NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	session := state.NewEmptySession("good")
	session.CreatedAt = 200
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	// A file from a version that knows records this one does not: Load refuses
	// it, LoadSummary refuses it, and the list has to say so instead of lying.
	future := fmt.Sprintf(`{"v":%d,"type":"head","session_id":"bad","created_at":100}`+"\n", state.StateVersion+1)
	if err := os.WriteFile(filepath.Join(dir, "bad"+state.Suffix), []byte(future), 0o600); err != nil {
		t.Fatal(err)
	}

	rows := SessionSummaries(store, 50, true)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	var bad map[string]any
	for _, row := range rows {
		if row["session_id"] == "bad" {
			bad = row
		}
	}
	if bad == nil {
		t.Fatal("the unreadable session is missing from the list")
	}
	preview, _ := bad["preview"].(string)
	if preview == "" || strings.Contains(preview, "⟪") {
		t.Errorf("preview = %q, want a stated reason", preview)
	}
	if bad["messages"] != 0 || bad["steps"] != 0 {
		t.Errorf("unreadable row claims %+v", bad)
	}
}

// TestSessionSummariesRespectsTheLimit: the picker caps the list, and the cap
// keeps the newest — an arbitrary slice of the directory would hide exactly the
// sessions somebody is looking for.
func TestSessionSummariesRespectsTheLimit(t *testing.T) {
	store, err := state.NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for created := 1; created <= 5; created++ {
		session := state.NewEmptySession(fmt.Sprintf("s%d", created))
		session.CreatedAt = float64(created)
		if err := store.Save(session); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	rows := SessionSummaries(store, 2, true)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0]["session_id"] != "s5" || rows[1]["session_id"] != "s4" {
		t.Errorf("the limit kept %v and %v, want the two newest",
			rows[0]["session_id"], rows[1]["session_id"])
	}
}

// TestSessionSummariesFiltersArchivedBeforeTheLimit is the whole reason the filter
// lives in the runtime rather than in a front end.
//
// The cap keeps the **newest** N. If a front end filtered the answer, archiving the
// newest session would free no slot at all — the older, un-archived one would stay
// outside the cap and out of the list. So the test archives the newest two of five
// and asks for two: the answer must be the two newest *un-archived* ones, which are
// `s3` and `s2`, not `s5` and `s4` (archived) and not an empty list.
func TestSessionSummariesFiltersArchivedBeforeTheLimit(t *testing.T) {
	store, err := state.NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for created := 1; created <= 5; created++ {
		session := state.NewEmptySession(fmt.Sprintf("s%d", created))
		session.CreatedAt = float64(created)
		if err := store.Save(session); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	for _, id := range []string{"s5", "s4"} {
		if err := store.Archive(id, true); err != nil {
			t.Fatalf("archive %s: %v", id, err)
		}
	}

	rows := SessionSummaries(store, 2, false)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0]["session_id"] != "s3" || rows[1]["session_id"] != "s2" {
		t.Errorf("the filter kept %v and %v, want s3 and s2 — archived rows must free a slot, not be filtered out of the newest N",
			rows[0]["session_id"], rows[1]["session_id"])
	}

	// With archived included, the newest two are back and each row states its flag.
	all := SessionSummaries(store, 2, true)
	if len(all) != 2 || all[0]["session_id"] != "s5" {
		t.Fatalf("includeArchived kept %+v, want the two newest with s5 first", all)
	}
	if all[0]["archived"] != true || all[1]["archived"] != true {
		t.Errorf("archived flag not stated: %v / %v", all[0]["archived"], all[1]["archived"])
	}
}

// TestSessionSummariesArchiveRoundTripsThroughMetadata: archiving is a metadata
// change, so it must survive a save/load cycle and be readable from the summary.
func TestSessionSummariesArchiveRoundTripsThroughMetadata(t *testing.T) {
	store, err := state.NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := state.NewEmptySession("20260101-120000")
	session.CreatedAt = 100
	session.Append(map[string]any{"role": "user", "content": "keep me"})
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := store.Archive("20260101-120000", true); err != nil {
		t.Fatalf("archive: %v", err)
	}
	rows := SessionSummaries(store, 50, true)
	if len(rows) != 1 || rows[0]["archived"] != true {
		t.Fatalf("after archive: %+v", rows)
	}
	// The transcript is untouched — archiving is not deletion.
	if rows[0]["messages"] != 1 || rows[0]["preview"] != "keep me" {
		t.Errorf("archiving changed the session's content: %+v", rows[0])
	}

	if err := store.Archive("20260101-120000", false); err != nil {
		t.Fatalf("unarchive: %v", err)
	}
	loaded, err := store.Load("20260101-120000")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if state.IsArchived(loaded.Metadata) {
		t.Error("un-archiving left the flag set")
	}
	if _, present := loaded.Metadata[state.ArchivedAtKey]; present {
		t.Error("un-archiving left archived_at behind")
	}
}
