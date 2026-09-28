package protocol

import (
	"errors"
	"strings"
	"testing"
)

// deleteStub is a runtime with a chosen session id: the delete path branches on
// "is this the mounted session", and the ordinary stub is pinned to "parent".
// `closed` records Close() so the test can check the old runtime is shut down.
type deleteStub struct {
	stubRuntime
	id     string
	closed bool
}

func (r *deleteStub) SessionID() string { return r.id }
func (r *deleteStub) Close() error      { r.closed = true; return nil }

// countKind counts the outbound messages of one kind.
func countKind(messages []map[string]any, kind string) int {
	n := 0
	for _, message := range messages {
		if TypeOf(message) == kind {
			n++
		}
	}
	return n
}

// sessionNotices returns every notice carrying the "session" code.
func sessionNotices(messages []map[string]any) []map[string]any {
	var out []map[string]any
	for _, message := range messages {
		if TypeOf(message) != OutNotice {
			continue
		}
		if got, _ := message["code"].(string); got == "session" {
			out = append(out, message)
		}
	}
	return out
}

// TestDeletingAnotherSessionOnlyRefreshesTheList is the ordinary case: the file
// goes, the picker is told, and the mounted session is untouched — no new
// handshake, because the transcript on screen still belongs to the session that
// was never deleted.
func TestDeletingAnotherSessionOnlyRefreshesTheList(t *testing.T) {
	var out strings.Builder
	deleted := []string{}
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		DeleteSession: func(id string) error {
			deleted = append(deleted, id)
			return nil
		},
	})
	server.Attach(&deleteStub{id: "kept"})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionDelete, "session_id": "20260101-120000"})

	if len(deleted) != 1 || deleted[0] != "20260101-120000" {
		t.Fatalf("the deleter saw %v, want exactly the requested id", deleted)
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutSessions); got != 1 {
		t.Errorf("sent %d sessions lists after a delete, want 1 (the picker must refresh)", got)
	}
	if got := countKind(messages, OutInit); got != 0 {
		t.Errorf("sent %d init messages, want 0: the mounted session did not change", got)
	}
	if got := len(sessionNotices(messages)); got != 1 {
		t.Errorf("sent %d session notices, want 1 confirming the delete", got)
	}
}

// TestDeletingTheCurrentSessionReplacesIt is decision B: the front end is never
// left on a session whose file is gone. The replacement is opened before the old
// runtime closes, so an assembly failure cannot lose the old one.
func TestDeletingTheCurrentSessionReplacesIt(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		DeleteSession: func(id string) error { return nil },
		Factory: func(sessionID string) (Runtime, error) {
			return &deleteStub{id: "fresh"}, nil
		},
	})
	current := &deleteStub{id: "current"}
	server.Attach(current)

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionDelete, "session_id": "current"})

	if server.current().SessionID() != "fresh" {
		t.Fatalf("the mounted session is %q, want the replacement", server.current().SessionID())
	}
	if !current.closed {
		t.Error("the old runtime was never closed")
	}
	messages := sentMessages(t, &out)
	// The opening triple: a replacement session is a new conversation, and the
	// front end learns it the same way it learned the first one.
	if got := countKind(messages, OutInit); got != 1 {
		t.Errorf("sent %d init messages after deleting the current session, want 1", got)
	}
	if got := countKind(messages, OutSessionLoad); got != 1 {
		t.Errorf("sent %d session_load messages, want 1", got)
	}
}

// TestAFailedDeleteChangesNothing is the no-optimistic-update contract on the
// runtime side: the file survives, no list is sent that pretends it is gone, and
// the reason arrives as a notice.
func TestAFailedDeleteChangesNothing(t *testing.T) {
	var out strings.Builder
	factoryRuns := 0
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		DeleteSession: func(id string) error { return errors.New("the file is locked") },
		Factory: func(sessionID string) (Runtime, error) {
			factoryRuns++
			return &deleteStub{id: "fresh"}, nil
		},
	})
	server.Attach(&deleteStub{id: "current"})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionDelete, "session_id": "current"})

	if factoryRuns != 0 {
		t.Errorf("the factory ran %d times after a failed delete, want 0", factoryRuns)
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutSessions); got != 0 {
		t.Errorf("sent %d sessions lists after a failed delete, want 0: the list did not change", got)
	}
	notices := sessionNotices(messages)
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 carrying the reason", len(notices))
	}
	if text, _ := notices[0]["text"].(string); !strings.Contains(text, "the file is locked") {
		t.Errorf("the notice lost the reason: %v", notices[0]["text"])
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("a failed delete reported level %q, want warn", level)
	}
}

// TestANilDeleterRefuses is fail-closed, the same rule a nil Factory follows for
// switching: a runtime wired without a deleter refuses rather than guessing.
func TestANilDeleterRefuses(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&deleteStub{id: "current"})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionDelete, "session_id": "current"})

	messages := sentMessages(t, &out)
	notices := sessionNotices(messages)
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 refusal", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("the refusal reported level %q, want warn", level)
	}
}

// TestADeleteWithoutAnIDIsRefused: an empty id would otherwise be a delete of
// nothing that still reports success.
func TestADeleteWithoutAnIDIsRefused(t *testing.T) {
	var out strings.Builder
	deleted := []string{}
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		DeleteSession: func(id string) error {
			deleted = append(deleted, id)
			return nil
		},
	})
	server.Attach(&deleteStub{id: "current"})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionDelete})

	if len(deleted) != 0 {
		t.Fatalf("the deleter ran with %v, want no call at all", deleted)
	}
	if got := len(sessionNotices(sentMessages(t, &out))); got != 1 {
		t.Errorf("sent %d session notices, want 1 refusal", got)
	}
}
