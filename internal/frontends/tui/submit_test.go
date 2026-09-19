package tui

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// TestAnEmptyPromptSendsNothing — Enter is the easiest key in the interface, so a
// stray one on an empty box must not become a turn. Nothing downstream can tell
// "the box was empty" from "the user meant to send an empty message", and a turn
// that runs on nothing still costs a model call and a line in the audit.
//
// The whitespace cases matter as much as the empty string: Ctrl+J (and Alt+Enter)
// insert a newline in the box, and a box holding one is empty as far as the
// runtime is concerned — `strings.TrimSpace` is what makes the two the same case.
func TestAnEmptyPromptSendsNothing(t *testing.T) {
	for _, input := range []string{"", " ", "\n", "\n\n", "  \n\t ", "\u3000"} {
		m := filledModel(120, 36)
		// nil stdin: `Send` writes nowhere, which is all a front end test needs.
		m.client = protocol.NewClient(nil)
		m.input = input
		m.inputCursor = len([]rune(input))
		turns, entries := m.turnSeq, len(m.transcript)

		next, _ := m.submit()
		m = next.(model)

		if m.busy || m.pendingUserInput != "" {
			t.Fatalf("input %q started a turn: busy=%v pending=%q", input, m.busy, m.pendingUserInput)
		}
		if m.turnSeq != turns || len(m.transcript) != entries {
			t.Fatalf("input %q reached the transcript", input)
		}
		if m.input != "" {
			t.Fatalf("input %q was left in the box: %q", input, m.input)
		}
	}
}

// TestANonEmptyPromptDoesStartATurn is the other half: the guard above must not be
// satisfied by refusing everything. Without this, a `submit` that dropped every
// message would pass the test above.
func TestANonEmptyPromptDoesStartATurn(t *testing.T) {
	m := filledModel(120, 36)
	m.client = protocol.NewClient(nil)
	m.input = "  run the tests  "

	next, _ := m.submit()
	m = next.(model)

	if !m.busy {
		t.Fatal("a real message did not start a turn")
	}
	if m.pendingUserInput != "run the tests" {
		t.Fatalf("the turn carries %q, want the trimmed line", m.pendingUserInput)
	}
	if m.input != "" {
		t.Fatalf("the box was not cleared: %q", m.input)
	}
}
