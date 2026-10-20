package protocol

import (
	"errors"
	"strings"
	"testing"
)

// TestForkingTheMountedSessionOpensTheCopy is the ordinary case: the fork
// copies the session up to the chosen reply under a fresh id, and the front
// end lands on the copy through the opening triple — the way every new
// session is reached. The source survives, untouched, in the list.
func TestForkingTheMountedSessionOpensTheCopy(t *testing.T) {
	var out strings.Builder
	var forked string
	var gotID, gotReply string
	var gotUserBefore int
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ForkSession: func(id, reply string, userBefore int) (string, error) {
			gotID, gotReply, gotUserBefore = id, reply, userBefore
			forked = "20260102-080000"
			return forked, nil
		},
		Factory: func(sessionID string) (Runtime, error) {
			return &deleteStub{id: sessionID}, nil
		},
	})
	previous := &deleteStub{id: "current"}
	server.Attach(previous)

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionFork,
		"session_id": "current", "reply": "the reply", "user_before": 1,
	})

	if gotID != "current" || gotReply != "the reply" || gotUserBefore != 1 {
		t.Fatalf("the forker saw (%q, %q, %d), want (current, the reply, 1)",
			gotID, gotReply, gotUserBefore)
	}
	if server.current().SessionID() != forked {
		t.Fatalf("the mounted session is %q, want the copy %q",
			server.current().SessionID(), forked)
	}
	if !previous.closed {
		t.Error("the previous runtime was never closed")
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutInit); got != 1 {
		t.Errorf("sent %d init messages after a fork, want 1 (the opening triple)", got)
	}
	if got := countKind(messages, OutSessionLoad); got != 1 {
		t.Errorf("sent %d session_load messages, want 1", got)
	}
	// The fork adds a row the front end did not draw, and the list has to
	// show it.
	if got := countKind(messages, OutSessions); got != 1 {
		t.Errorf("sent %d sessions lists after a fork, want 1", got)
	}
	notices := sessionNotices(messages)
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 confirming the fork", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "info" {
		t.Errorf("the confirmation reported level %q, want info", level)
	}
}

// TestForkingAnotherSessionKeepsTheMountedOne is the mirror: the copy is
// made and shows up in the list, but the conversation on screen is not
// touched — no opening triple, because the transcript still belongs to the
// session that was never replaced.
func TestForkingAnotherSessionKeepsTheMountedOne(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ForkSession: func(id, reply string, userBefore int) (string, error) {
			return "20260102-080000", nil
		},
		Factory: func(sessionID string) (Runtime, error) {
			return &deleteStub{id: sessionID}, nil
		},
	})
	previous := &deleteStub{id: "mounted"}
	server.Attach(previous)

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionFork,
		"session_id": "20260101-120000", "reply": "the reply",
	})

	if got := server.current().SessionID(); got != "mounted" {
		t.Fatalf("the mounted session changed to %q; it must stay put", got)
	}
	if previous.closed {
		t.Error("forking another session closed the mounted runtime")
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutInit); got != 0 {
		t.Errorf("sent %d init messages, want 0: the mounted session did not change", got)
	}
	if got := countKind(messages, OutSessions); got != 1 {
		t.Errorf("sent %d sessions lists, want 1 (the list gained a row)", got)
	}
	if got := len(sessionNotices(messages)); got != 1 {
		t.Errorf("sent %d session notices, want 1 confirming the fork", got)
	}
}

// TestAFailedForkChangesNothing is the no-optimistic-update contract: the
// source survives, the front end stays on what it was reading, and the reason
// arrives as a notice.
func TestAFailedForkChangesNothing(t *testing.T) {
	var out strings.Builder
	factoryRuns := 0
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ForkSession: func(id, reply string, userBefore int) (string, error) {
			return "", errors.New("the reply was not found")
		},
		Factory: func(sessionID string) (Runtime, error) {
			factoryRuns++
			return &deleteStub{id: "copy"}, nil
		},
	})
	previous := &deleteStub{id: "current"}
	server.Attach(previous)

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionFork,
		"session_id": "current", "reply": "a reply that is not there",
	})

	if factoryRuns != 0 {
		t.Errorf("the factory ran %d times after a failed fork, want 0", factoryRuns)
	}
	if got := server.current().SessionID(); got != "current" {
		t.Fatalf("the mounted session changed to %q; a failed fork must not move it", got)
	}
	if previous.closed {
		t.Error("a failed fork closed the previous runtime")
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutSessions); got != 0 {
		t.Errorf("sent %d sessions lists after a failed fork, want 0", got)
	}
	if got := countKind(messages, OutInit); got != 0 {
		t.Errorf("sent %d init messages after a failed fork, want 0", got)
	}
	notices := sessionNotices(messages)
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 carrying the reason", len(notices))
	}
	if text, _ := notices[0]["text"].(string); !strings.Contains(text, "the reply was not found") {
		t.Errorf("the notice lost the reason: %v", notices[0]["text"])
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("a failed fork reported level %q, want warn", level)
	}
}

// TestANilForkerRefuses is fail-closed, the same rule a nil Factory follows:
// a runtime wired without a forker refuses rather than guessing at a copy.
func TestANilForkerRefuses(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&deleteStub{id: "current"})

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionFork,
		"session_id": "current", "reply": "the reply",
	})

	notices := sessionNotices(sentMessages(t, &out))
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 refusal", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("the refusal reported level %q, want warn", level)
	}
}

// TestAForkWithoutAReplyIsRefused: an empty reply names no message, and a
// fork of "nothing" must not be a fork that succeeds.
func TestAForkWithoutAReplyIsRefused(t *testing.T) {
	var out strings.Builder
	forkerRuns := 0
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ForkSession: func(id, reply string, userBefore int) (string, error) {
			forkerRuns++
			return "copy", nil
		},
	})
	server.Attach(&deleteStub{id: "current"})

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionFork, "session_id": "current",
	})

	if forkerRuns != 0 {
		t.Fatalf("the forker ran %d times without a reply, want no call at all", forkerRuns)
	}
	if got := len(sessionNotices(sentMessages(t, &out))); got != 1 {
		t.Errorf("sent %d session notices, want 1 refusal", got)
	}
}
