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

	rows := SessionSummaries(store, 50)
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

	rows := SessionSummaries(store, 50)
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

	rows := SessionSummaries(store, 50)
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
	rows := SessionSummaries(store, 2)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0]["session_id"] != "s5" || rows[1]["session_id"] != "s4" {
		t.Errorf("the limit kept %v and %v, want the two newest",
			rows[0]["session_id"], rows[1]["session_id"])
	}
}
