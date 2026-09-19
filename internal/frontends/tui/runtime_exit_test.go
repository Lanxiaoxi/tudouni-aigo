package tui

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// transcriptText is everything drawn in the log, joined.
func transcriptText(m model) string {
	var out strings.Builder
	for _, item := range m.transcript {
		if item.turn != nil {
			for _, line := range item.turn.lines {
				out.WriteString(line.plain())
				out.WriteString("\n")
			}
			continue
		}
		out.WriteString(item.line.plain())
		out.WriteString("\n")
	}
	return out.String()
}

// TestARuntimeThatDiedIsSaidOutLoud is the compensation for taking the child's
// stderr away from the terminal.
//
// The interface used to be told "the runtime is gone" by a stray line the child
// wrote onto a screen it did not own — visible as corruption, erased on the next
// redraw, but visible. With the child's stderr drained (see `protocol.Client.Start`)
// that accidental channel is closed, so the death has to be said deliberately: a
// session that silently stops taking input is the failure this line prevents.
func TestARuntimeThatDiedIsSaidOutLoud(t *testing.T) {
	m := testModel()
	m.client = protocol.TestClientWithExit(2, false)

	m.noteRuntimeGone()

	text := transcriptText(m)
	if !strings.Contains(text, i18n.T("runtime.exited.unexpected", "code", 2)) {
		t.Errorf("the transcript does not report the exit:\n%s", text)
	}
	if !strings.Contains(text, i18n.T("runtime.exited.detail")) {
		t.Errorf("the report does not say where the record of it is:\n%s", text)
	}
	var warned bool
	for _, item := range m.transcript {
		for _, line := range item.line.segments {
			if line.role == "warn" {
				warned = true
			}
		}
	}
	if !warned {
		t.Error("a runtime that died unexpectedly is not drawn as a warning")
	}
}

// TestTheDeathIsReportedOnce: one line is a report, two read as two deaths. The
// client sends the message once, but a failed session switch can end a runtime more
// than once in a single run.
func TestTheDeathIsReportedOnce(t *testing.T) {
	m := testModel()
	m.client = protocol.TestClientWithExit(2, false)

	m.noteRuntimeGone()
	m.noteRuntimeGone()

	want := i18n.T("runtime.exited.unexpected", "code", 2)
	if got := strings.Count(transcriptText(m), want); got != 1 {
		t.Errorf("the exit was reported %d times, want 1:\n%s", got, transcriptText(m))
	}
}

// TestACleanUnexpectedExitIsNotAWarning: a runtime that leaves with zero nobody
// asked for is still an ending, and an ending is not a crash. Painting the two the
// same colour would make the report useless in the one case a person has to act on.
func TestACleanUnexpectedExitIsNotAWarning(t *testing.T) {
	m := testModel()
	m.client = protocol.TestClientWithExit(0, false)

	m.noteRuntimeGone()

	text := transcriptText(m)
	if !strings.Contains(text, i18n.T("runtime.exited.ordered")) {
		t.Errorf("a clean unexpected exit was not reported:\n%s", text)
	}
	for _, item := range m.transcript {
		for _, line := range item.line.segments {
			if line.role == "warn" {
				t.Errorf("an ending with a zero exit code is drawn as a warning: %q", line.text)
			}
		}
	}
}

// TestAnAskedForExitDrawsNothing: when the front end asked the runtime to finish,
// the interface is on its way out. A warning about the exit it requested is noise on
// a screen the user is already leaving.
func TestAnAskedForExitDrawsNothing(t *testing.T) {
	m := testModel()
	m.client = protocol.TestClientWithExit(0, true)

	m.noteRuntimeGone()

	if text := strings.TrimSpace(transcriptText(m)); text != "" {
		t.Errorf("the asked-for exit was drawn:\n%s", text)
	}
}

// TestTheExitMessageIsRoutedFromTheProtocolLayer is the routing half, which the
// tests above do not touch.
//
// They call `noteRuntimeGone` directly, so a client that sent one message type while
// this interface switched on another would leave every one of them green and the
// screen silent. The payload below is the one the client actually builds.
func TestTheExitMessageIsRoutedFromTheProtocolLayer(t *testing.T) {
	m := testModel()
	m.client = protocol.TestClientWithExit(7, false)

	m.handleServerMessage(map[string]any{"v": protocol.VERSION, "t": protocol.OutRuntimeExited})

	if text := transcriptText(m); !strings.Contains(text, i18n.T("runtime.exited.unexpected", "code", 7)) {
		t.Errorf("the exit message did not reach the transcript:\n%s", text)
	}
}

// TestAModelWithoutARuntimeStillSaysSomething: a model built by hand has no client,
// and the renderer must not dereference it. The plainer sentence is the honest one —
// there is no exit code to report.
func TestAModelWithoutARuntimeStillSaysSomething(t *testing.T) {
	m := testModel()

	m.noteRuntimeGone()

	if text := transcriptText(m); !strings.Contains(text, i18n.T("runtime.exited.ordered")) {
		t.Errorf("a model with no runtime said nothing about it:\n%s", text)
	}
}
