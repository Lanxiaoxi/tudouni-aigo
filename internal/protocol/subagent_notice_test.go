package protocol

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// noticesOf returns every notice the server sent.
func noticesOf(messages []map[string]any) []map[string]any {
	var out []map[string]any
	for _, message := range messages {
		if TypeOf(message) == OutNotice {
			out = append(out, message)
		}
	}
	return out
}

// TestADelegationsRouteReachesTheFrontEndAsANotice is the regression for a
// diagnostic that was written where nobody could read it.
//
// The delegation tool used to report the child's resolved route with
// `fmt.Fprintf(os.Stderr, ...)`. The runtime is the front end's own child process,
// so that stderr is the terminal the interface draws on: the line landed in the
// alternate screen and the next redraw erased it. The fact still has to arrive —
// the status bar carries the parent's route, not the child's — so it arrives as a
// record on the parent's stream, which is what this layer turns into a notice.
//
// The record is delivered **as the runtime delivers it**: through `OnEvent`, not
// through the child path. A version of this test that used `childRecord` would pass
// with the handling in `forwardChild`, where it would never fire.
func TestADelegationsRouteReachesTheFrontEndAsANotice(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{
		"kind": "subagent_started", "session_id": "parent", "subagent_id": "sub-parent-1",
		"depth": 1, "provider": "opencode-go", "model": "deepseek-v4.1-flash",
	})

	messages := sentMessages(t, &out)
	notices := noticesOf(messages)
	if len(notices) != 1 {
		t.Fatalf("the route report produced %d notices, want 1", len(notices))
	}
	notice := notices[0]
	if level, _ := notice["level"].(string); level != "info" {
		t.Errorf("the route report is announced as %q, want info — it is a fact, not a failure", level)
	}
	if code, _ := notice["code"].(string); code != "subagent" {
		t.Errorf("the notice is coded %q, want subagent", code)
	}
	text, _ := notice["text"].(string)
	// Both halves of the route, because "which model" without "by which route" is
	// the question this notice exists to answer.
	for _, want := range []string{"sub-parent-1", "opencode-go", "deepseek-v4.1-flash"} {
		if !strings.Contains(text, want) {
			t.Errorf("the notice does not mention %q: %q", want, text)
		}
	}
	// i18n renders an unknown key as an unmissable marker rather than as nothing,
	// so a missing template shows up here instead of as an empty line on screen.
	if strings.Contains(text, "⟪") {
		t.Errorf("the notice is a missing i18n key: %q", text)
	}
}

// TestAChildSessionThatCouldNotBeSavedBecomesAWarning is the same rule for the one
// failure a delegation can suffer that leaves no other trace.
//
// Nothing else on the parent's side records it: the parent still receives the
// child's answer, so the loss of the child's transcript is invisible unless this
// layer says so. It is a warning rather than information because the transcript is
// the only way to read what the child actually did.
func TestAChildSessionThatCouldNotBeSavedBecomesAWarning(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{
		"kind": "subagent_problem", "session_id": "parent", "subagent_id": "sub-parent-1",
		"problem": "save_failed", "reason": "open sub-parent-1.jsonl: access is denied",
	})

	notices := noticesOf(sentMessages(t, &out))
	if len(notices) != 1 {
		t.Fatalf("the save failure produced %d notices, want 1", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("a lost child transcript is announced as %q, want warn", level)
	}
	text, _ := notices[0]["text"].(string)
	if !strings.Contains(text, "sub-parent-1") || !strings.Contains(text, "access is denied") {
		t.Errorf("the warning does not name the child and the reason: %q", text)
	}
	if strings.Contains(text, "⟪") {
		t.Errorf("the warning is a missing i18n key: %q", text)
	}
}

// TestTheDelegationRecordsAreForwardedUnmarked pins the routing both tests above
// depend on: these two kinds are the parent's own account of having delegated, so
// they travel the ordinary path and not the child's.
func TestTheDelegationRecordsAreForwardedUnmarked(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&stubRuntime{})

	server.OnEvent(map[string]any{
		"kind": "subagent_started", "session_id": "parent", "subagent_id": "sub-parent-1",
		"depth": 1, "provider": "p", "model": "m",
	})

	records := eventsOf(sentMessages(t, &out), "subagent_started")
	if len(records) != 1 {
		t.Fatalf("forwarded %d subagent_started records, want 1", len(records))
	}
	if child, _ := records[0]["child"].(bool); child {
		t.Error("the parent's own account of the delegation was marked as a child's record")
	}
}

// TestARuntimeThatCannotBeAssembledSaysWhy is the compensation for the child's
// stderr being out of reach.
//
// The opener runs before there is a runtime that could hold a notice, so a failure
// there used to be reported only on stderr — which the front end that started this
// process no longer inherits, because that stream is the terminal it draws on. Left
// as it was, a user would get a blank interface and a bare exit code where the
// sentence naming the problem used to be.
func TestARuntimeThatCannotBeAssembledSaysWhy(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	OpenFailureNotice(server.notice)
	t.Cleanup(func() { openFailureNotice = nil })

	// Stands in for `Main`'s own error path: the opener failed, so the reason goes out
	// as a notice and the process then leaves with 2.
	if openFailureNotice == nil {
		t.Fatal("the failure reporter was not wired")
	}
	openFailureNotice("warn", "runtime",
		i18n.T("channels.runtime.open_failed", "problem", "no usable model route"))

	notices := noticesOf(sentMessages(t, &out))
	if len(notices) != 1 {
		t.Fatalf("the reason for a failed start-up produced %d notices, want 1", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("a start-up that never happened is announced as %q, want warn", level)
	}
	text, _ := notices[0]["text"].(string)
	if !strings.Contains(text, "no usable model route") {
		t.Errorf("the notice does not carry the reason: %q", text)
	}
	if strings.Contains(text, "⟪") {
		t.Errorf("the notice is a missing i18n key: %q", text)
	}
}
