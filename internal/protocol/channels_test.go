package protocol

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// TestTheServersChannelsAskOverTheProtocol is the regression test for a bug that
// made the TUI unusable.
//
// `Server.Channels()` builds the two ways a runtime reaches a person — an approval
// and a question — and it had **no caller at all**. The opener therefore fell back to
// the terminal channels: the child process printed the approval prompt on stderr and
// waited on a stdin that is a pipe the front end owns, while the TUI drew an approval
// panel waiting for a keypress that would answer a request the runtime had not sent.
// Nobody could answer, so the turn never finished.
//
// The proof is the wire: asking through these channels has to put a
// `permission_request` on the transport.
func TestTheServersChannelsAskOverTheProtocol(t *testing.T) {
	// The front end's side of the pipe: the answer it will send back.
	answers := strings.NewReader(MustEncode(map[string]any{
		"v": VERSION, "t": InPermissionResponse, "id": "p-1", "decision": "allow",
	}))
	// The runtime's side: everything it sends lands here.
	output := &safeBuffer{}
	server := NewServer(OpenStreams(answers, output), Bootstrap{})

	channels := server.Channels()
	if channels.AskerFactory == nil {
		t.Fatal("the server offers no asker: an approval could only be printed at a terminal")
	}
	ask := channels.AskerFactory(security.NewMemory(nil, nil, "", nil), nil)

	// The id the server hands out is generated, so read it back out of what it sent.
	done := make(chan bool, 1)
	go func() {
		done <- ask("write_file", security.RiskMedium, map[string]any{"path": "hello.go"})
	}()

	// Wait for the request to appear on the wire.
	var request map[string]any
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if message := lastMessage(t, output.String()); message != nil {
			request = message
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if request == nil {
		t.Fatal("no message reached the transport: the approval went somewhere else")
	}
	if kind := TypeOf(request); kind != OutPermissionRequest {
		t.Fatalf("the runtime sent %q, want %q", kind, OutPermissionRequest)
	}

	// The front end answers, and the asker has to come back with that answer.
	id, _ := String(request, "id")
	server.pending.resolve(id, "allow")

	select {
	case allowed := <-done:
		if !allowed {
			t.Error("the answer was allow, but the asker reported a refusal")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the asker never returned after the answer arrived")
	}
}

// TestTheServersChannelsAskQuestionsOverTheProtocol is the same property for
// `ask_user`: it is the other half of "the runtime cannot tell who is listening".
func TestTheServersChannelsAskQuestionsOverTheProtocol(t *testing.T) {
	answers := strings.NewReader(MustEncode(map[string]any{
		"v": VERSION, "t": InQuestionResponse, "id": "q-1", "status": QuestionAnswered, "text": "the second one",
	}))
	output := &safeBuffer{}
	server := NewServer(OpenStreams(answers, output), Bootstrap{})

	done := make(chan Answer, 1)
	go func() {
		done <- server.Channels().Questioner(AskUserArgs{
			Question: "which one?", Options: []string{"a", "b"},
		})
	}()

	var request map[string]any
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if message := lastMessage(t, output.String()); message != nil {
			request = message
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if request == nil {
		t.Fatal("no message reached the transport: the question went somewhere else")
	}
	if kind := TypeOf(request); kind != OutQuestionRequest {
		t.Fatalf("the runtime sent %q, want %q", kind, OutQuestionRequest)
	}

	id, _ := String(request, "id")
	server.pending.resolve(id, questionAnswer{text: "the second one", status: QuestionAnswered})

	select {
	case answer := <-done:
		if answer.Status != QuestionAnswered || answer.Text != "the second one" {
			t.Errorf("answer = %+v, want the text the front end sent", answer)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the questioner never returned after the answer arrived")
	}
}

// safeBuffer is a buffer two goroutines touch: the send happens on the asker's.
type safeBuffer struct {
	mu   chan struct{}
	data bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	if b.mu == nil {
		b.mu = make(chan struct{}, 1)
	}
	b.mu <- struct{}{}
	defer func() { <-b.mu }()
	return b.data.Write(p)
}

func (b *safeBuffer) String() string {
	if b.mu == nil {
		return ""
	}
	b.mu <- struct{}{}
	defer func() { <-b.mu }()
	return b.data.String()
}

// lastMessage decodes the most recent line written to the transport.
func lastMessage(t *testing.T, raw string) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if strings.TrimSpace(lines[index]) == "" {
			continue
		}
		message, err := Decode(lines[index])
		if err != nil {
			continue
		}
		return message
	}
	return nil
}
