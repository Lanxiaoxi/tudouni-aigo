package protocol

import (
	"strings"
	"testing"
)

// authRuntime is a runtime that has something to say about the session's credential.
//
// It embeds the ordinary stub and adds the optional method, which is exactly how the
// real runtime participates: this layer never learns what a token is, it only asks
// whether the runtime has anything queued.
type authRuntime struct {
	stubRuntime
	queued []map[string]any
}

func (r *authRuntime) RunTurn(string) (string, error) { return "answered", nil }

func (r *authRuntime) DrainAuthNotices() []map[string]any {
	out := r.queued
	r.queued = nil
	return out
}

// TestCredentialNoticesAreSentWhenTheTurnEnds — the sentence a refresh produced has
// to reach the person, and the protocol is the only way out of the child process.
//
// It is sent **when the turn ends** rather than from inside the runtime, because the
// event belongs to that turn: a line pushed out mid-turn would appear under a turn
// that is still drawing, and a front end cannot reorder what it has already been
// given.
func TestCredentialNoticesAreSentWhenTheTurnEnds(t *testing.T) {
	var out strings.Builder
	runtimeValue := &authRuntime{queued: []map[string]any{
		{"level": "info", "code": "auth", "text": "[ericai] token refreshed (valid for about 70 min)"},
	}}
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(runtimeValue)

	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "hello"})
	server.joinTurn()

	notices := 0
	for _, message := range sentMessages(t, &out) {
		if TypeOf(message) != OutNotice {
			continue
		}
		if code, _ := message["code"].(string); code != "auth" {
			continue
		}
		notices++
		if text, _ := message["text"].(string); !strings.Contains(text, "token refreshed") {
			t.Errorf("the notice lost its text: %v", message)
		}
		if level, _ := message["level"].(string); level != "info" {
			t.Errorf("level = %v, want the level the runtime chose", message["level"])
		}
	}
	if notices != 1 {
		t.Fatalf("sent %d credential notices, want 1", notices)
	}
	// Drained, not repeated: a queue that survived the send would say the same thing
	// after every later turn.
	if left := runtimeValue.DrainAuthNotices(); len(left) != 0 {
		t.Errorf("the queue still holds %v after being sent", left)
	}
}

// TestARuntimeWithoutCredentialNoticesIsStillFine — the method is optional, and a
// runtime that does not implement it must not be a special case anywhere below.
func TestARuntimeWithoutCredentialNoticesIsStillFine(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.Dispatch(map[string]any{"v": VERSION, "t": InUserMessage, "text": "hello"})
	server.joinTurn()

	for _, message := range sentMessages(t, &out) {
		if TypeOf(message) != OutNotice {
			continue
		}
		if code, _ := message["code"].(string); code == "auth" {
			t.Errorf("a runtime that says nothing about credentials produced an auth notice: %v", message)
		}
	}
}
