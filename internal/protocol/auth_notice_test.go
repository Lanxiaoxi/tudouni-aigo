package protocol

import (
	"context"
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

func (r *authRuntime) RunTurn(context.Context, string) (string, error) { return "answered", nil }

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

// startupAuthRuntime records that the opening asked it to check the credential, and
// what had already crossed the wire at that moment.
type startupAuthRuntime struct {
	stubRuntime
	checked bool
	sawInit bool
	out     *strings.Builder
}

func (r *startupAuthRuntime) StartupAuth() {
	r.checked = true
	r.sawInit = strings.Contains(r.out.String(), `"t":"init"`)
}

// TestTheCredentialCheckRunsAfterTheOpeningIsOnTheWire is the ordering this whole
// arrangement exists for.
//
// The check can block for a device-code timeout, and the instruction the person has
// to act on comes out of it. Run while the runtime is being assembled, the handshake
// is held back for that whole time: under `--runtime-stdio` the front end has been
// sent nothing, so it has nothing on screen to show a code in — and the code expires
// before the screen that could show it exists. Run once the opening is out, the
// instruction arrives as an ordinary notice on a front end that is already drawing.
func TestTheCredentialCheckRunsAfterTheOpeningIsOnTheWire(t *testing.T) {
	var out strings.Builder
	runtimeValue := &startupAuthRuntime{out: &out}
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(runtimeValue)

	server.emitOpening()

	if !runtimeValue.checked {
		t.Fatal("the opening never asked the runtime to check its credential")
	}
	if !runtimeValue.sawInit {
		t.Error("the check ran before `init` was sent: a person would be shown a login code that expires while the screen is still empty")
	}
}

// TestAMidSessionInstructionTravelsAsACredentialNotice — the delivery path for the
// other half: a login opened by the pre-request check, once the session is running.
//
// It is a notice like any other, with the code that says which kind, because that is
// the only channel a front end draws sentences from — and this process's stderr does
// not reach a person under `--runtime-stdio`.
func TestAMidSessionInstructionTravelsAsACredentialNotice(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})

	server.reporter("info", "[ericai]   open:  https://microsoft.com/devicelogin")

	messages := sentMessages(t, &out)
	if len(messages) != 1 {
		t.Fatalf("sent %d messages, want 1", len(messages))
	}
	if TypeOf(messages[0]) != OutNotice {
		t.Fatalf("the instruction went out as %v, want a notice", TypeOf(messages[0]))
	}
	if code, _ := messages[0]["code"].(string); code != "auth" {
		t.Errorf("code = %v, want auth — the front end reads the code to know which kind of sentence this is", messages[0]["code"])
	}
	text, _ := messages[0]["text"].(string)
	if !strings.Contains(text, "devicelogin") {
		t.Errorf("the instruction lost its text: %v", messages[0])
	}
}
