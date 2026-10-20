package state

import (
	"fmt"
	"testing"
)

// forkFixture builds the shape a real session has after three turns: the
// system message, then per turn a user prompt, the model's work (an assistant
// message with tool calls and its result), and the turn's final answer. The
// second and third turns deliberately answer with the **same** text, which is
// the case the `userBefore` tie-break exists for.
func forkFixture(t *testing.T, store *SessionStore, id string) {
	t.Helper()
	session := NewEmptySession(id)
	session.Append(map[string]any{"role": "system", "content": "the system prompt"})
	// Turn one.
	session.Append(map[string]any{"role": "user", "content": "first question"})
	session.Append(map[string]any{
		"role":         "assistant",
		"content":      "let me look",
		"tool_calls":   []any{map[string]any{"id": "c1", "function": map[string]any{"name": "read_file"}}},
	})
	session.Append(map[string]any{"role": "tool", "content": "the file's contents"})
	session.Append(map[string]any{"role": "assistant", "content": "the answer to one"})
	// Turn two: a repeated reply.
	session.Append(map[string]any{"role": "user", "content": "second question"})
	session.Append(map[string]any{"role": "assistant", "content": "a repeated answer"})
	// Turn three: the same reply again, this time after a change note the
	// runtime inserted.
	session.Append(map[string]any{"role": "user", "content": "third question", RuntimeNoteKey: true})
	session.Append(map[string]any{"role": "assistant", "content": "a repeated answer"})
	if err := store.Save(session); err != nil {
		t.Fatal(err)
	}
}

// TestForkCutsOnTheTurnBoundary is the ordinary case: the copy ends at the
// end of the matched reply's turn — after its tool work and its result, not
// on the message itself. Cutting on the message would leave `tool_calls`
// without results, and the fork's first request would be refused.
func TestForkCutsOnTheTurnBoundary(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "20260101-000000")

	newID, err := store.Fork("20260101-000000", "the answer to one", 0)
	if err != nil {
		t.Fatal(err)
	}
	if newID == "20260101-000000" {
		t.Fatal("the fork reused the source's id")
	}

	forked, err := store.Load(newID)
	if err != nil {
		t.Fatal(err)
	}
	roles := make([]string, 0, len(forked.Messages))
	for _, message := range forked.Messages {
		role, _ := message["role"].(string)
		roles = append(roles, role)
	}
	want := []string{"system", "user", "assistant", "tool", "assistant"}
	if fmt.Sprint(roles) != fmt.Sprint(want) {
		t.Fatalf("the fork carries %v, want %v: the cut must land after the reply's tool work",
			roles, want)
	}
	// The source is untouched.
	source, err := store.Load("20260101-000000")
	if err != nil {
		t.Fatal(err)
	}
	if len(source.Messages) != 9 {
		t.Fatalf("the source lost messages: has %d, want 9", len(source.Messages))
	}
}

// TestForkOfARepeatedReplyUsesTheCount is the case the tie-break exists for:
// two turns answered with the same words. Without `userBefore` the newest
// copy wins; with the right count, the fork lands on the one the front end
// drew.
func TestForkOfARepeatedReplyUsesTheCount(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "20260101-000000")

	// No count: the newest copy of the repeated answer.
	newID, err := store.Fork("20260101-000000", "a repeated answer", -1)
	if err != nil {
		t.Fatal(err)
	}
	newest, err := store.Load(newID)
	if err != nil {
		t.Fatal(err)
	}
	// The newest copy's turn ends the conversation, so the copy is the whole
	// session.
	if len(newest.Messages) != 9 {
		t.Fatalf("without a count the fork took %d messages, want all 9 (the newest copy)",
			len(newest.Messages))
	}

	// Count 2: the front end drew two user rows above the reply it meant —
	// "second question" and the change note in front of the third (runtime
	// notes draw as rows in a `session_load` rebuild, so they count).
	newID, err = store.Fork("20260101-000000", "a repeated answer", 2)
	if err != nil {
		t.Fatal(err)
	}
	forked, err := store.Load(newID)
	if err != nil {
		t.Fatal(err)
	}
	last := forked.Messages[len(forked.Messages)-1]
	text, _ := MessageText(last)
	if text != "a repeated answer" {
		t.Fatalf("the fork ends on %q, want the repeated answer", text)
	}
	// It must be the **second** copy: one user prompt below it, not three.
	if got := userRowsBefore(forked.Messages, len(forked.Messages)-1); got != 2 {
		t.Fatalf("the fork landed on a copy with %d user rows above it, want 2", got)
	}
	// Turn two had no tool work, so the cut is exactly on the reply itself:
	// system, turn one (4), turn two's prompt and reply = 7.
	if len(forked.Messages) != 7 {
		t.Fatalf("the fork carried %d messages, want 7 (through turn two's reply)",
			len(forked.Messages))
	}
}

// TestForkOfAMissingReplyFails: the source survives, no new file, and the
// error says the reply was not found.
func TestForkOfAMissingReplyFails(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "20260101-000000")

	if _, err := store.Fork("20260101-000000", "a reply that is not there", 0); err == nil {
		t.Fatal("forking a missing reply succeeded; it must fail")
	}
	// Nothing was created.
	if len(store.ListIDs()) != 1 {
		t.Fatalf("a failed fork left %d session files, want 1 (the source only)", len(store.ListIDs()))
	}
}

// TestForkRefusesChildSessions: a `sub-` file belongs to a delegation in its
// parent's transcript, and forking it by name would orphan that tool call —
// the same reason `Delete` refuses.
func TestForkRefusesChildSessions(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "sub-20260101-000000")

	if _, err := store.Fork("sub-20260101-000000", "the answer to one", 0); err == nil {
		t.Fatal("forking a child session succeeded; it must be refused")
	}
}

// TestForkDropsTheArchivedFlag: a fork is a new, active conversation, and
// inheriting the source's archive would hide it from the default list.
func TestForkDropsTheArchivedFlag(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "20260101-000000")
	if err := store.Archive("20260101-000000", true); err != nil {
		t.Fatal(err)
	}

	newID, err := store.Fork("20260101-000000", "the answer to one", 0)
	if err != nil {
		t.Fatal(err)
	}
	forked, err := store.Load(newID)
	if err != nil {
		t.Fatal(err)
	}
	if archived, _ := forked.Metadata[ArchivedKey].(bool); archived {
		t.Fatal("the fork inherited the source's archived flag")
	}
}

// TestForkKeepsMetadata: the copy runs on the source's model choice, so the
// metadata the runtime reads its settings from must travel with it.
func TestForkKeepsMetadata(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	forkFixture(t, store, "20260101-000000")
	source, err := store.Load("20260101-000000")
	if err != nil {
		t.Fatal(err)
	}
	source.Metadata["model"] = "provider/model"
	if err := store.Save(source); err != nil {
		t.Fatal(err)
	}

	newID, err := store.Fork("20260101-000000", "the answer to one", 0)
	if err != nil {
		t.Fatal(err)
	}
	forked, err := store.Load(newID)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := forked.Metadata["model"].(string); got != "provider/model" {
		t.Fatalf("the fork's model choice is %q, want the source's", got)
	}
}
