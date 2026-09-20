package cli

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// TestTheAskersMemoryIsTheGateSMemory is the regression for a rule written into the
// wrong object.
//
// `Channels` used to build its own `Memory` and bind the asker to it, while the
// permission gate read the one the runtime had constructed. Pressing `t` therefore
// wrote the rule somewhere the gate never looked: the same tool asked again in the
// same run, and the audit's "what did this approval remember" came out empty. It was
// hard to notice because the rule *was* written to the configuration file — it took
// effect on the next run.
//
// The assertion is on the object the runtime hands in, because that is the identity
// the gate compares against.
func TestTheAskersMemoryIsTheGateSMemory(t *testing.T) {
	// The runtime's own memory, standing in for `composition.go`'s.
	runtimeMemory := security.NewMemory(nil, nil, "permissions.json", nil)
	channels := Channels(false, strings.NewReader("t\n"), &strings.Builder{})

	ask := channels.AskerFactory(runtimeMemory, nil)
	if ask == nil {
		t.Fatal("the factory returned no asker")
	}

	// `t` with a tool that carries no command parameter is the "always allow this
	// tool" answer, which is the case the gate re-checks with `memory.Has`.
	if approved := ask("read_file", security.RiskLow, map[string]any{"path": "a.txt"}); !approved {
		t.Fatal("pressing `t` was not treated as approval")
	}
	if !runtimeMemory.Has("read_file") {
		t.Error("the approval was remembered somewhere the permission gate cannot see it")
	}
}

// TestTheAskerWritesItsPromptToTheDiagnosticStream: stdout carries the agent's answer
// and `tudouni-aigo > chat.txt` has to stay clean, so where the approval prompt goes is a
// contract rather than a preference. The streams are parameters now, which is what
// lets this be asserted at all.
func TestTheAskerWritesItsPromptToTheDiagnosticStream(t *testing.T) {
	var diag strings.Builder
	channels := Channels(false, strings.NewReader("n\n"), &diag)

	ask := channels.AskerFactory(security.NewMemory(nil, nil, "permissions.json", nil), nil)
	if approved := ask("shell", security.RiskHigh, map[string]any{"command": "rm -rf /"}); approved {
		t.Fatal("`n` was treated as approval")
	}
	if !strings.Contains(diag.String(), "审批") {
		t.Errorf("the approval prompt did not reach the diagnostic stream:\n%s", diag.String())
	}
}

// TestAutopilotStillAnswersWithoutAReader: the autopilot asker must not touch the
// input stream at all. A run started with `--autopilot` that blocked on a prompt
// nobody was there to answer would hang in exactly the situations autopilot exists
// for.
func TestAutopilotStillAnswersWithoutAReader(t *testing.T) {
	channels := Channels(true, strings.NewReader(""), &strings.Builder{})
	ask := channels.AskerFactory(security.NewMemory(nil, nil, "permissions.json", nil), nil)

	if !ask("shell", security.RiskHigh, map[string]any{"command": "anything"}) {
		t.Error("autopilot refused a call; it is supposed to answer yes without asking")
	}
}
