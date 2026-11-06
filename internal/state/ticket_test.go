package state

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// newTicketMetadata binds once through the public door, so every test below
// starts from a shape the runtime actually writes rather than a hand-built map.
func newTicketMetadata(t *testing.T, spec TicketSpec) map[string]any {
	t.Helper()
	metadata := map[string]any{}
	if _, _, err := BindTicket(metadata, spec); err != nil {
		t.Fatalf("BindTicket: %v", err)
	}
	return metadata
}

func TestBindingTheSameTicketTwiceIsNotAChange(t *testing.T) {
	spec := TicketSpec{ID: "tk-1", Title: "Fix reconnect", Brief: "make it reconnect"}
	metadata := newTicketMetadata(t, spec)

	// The first bind changed something: there was nothing before it.
	if _, changed, err := BindTicket(map[string]any{}, spec); err != nil || !changed {
		t.Errorf("the first bind reported changed=%v err=%v, want a change", changed, err)
	}

	// The front end re-sends this on every session open; it must not be worth a
	// checkpoint, or opening a session rewrites the session file for nothing.
	_, changed, err := BindTicket(metadata, spec)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("re-binding an identical ticket reported a change")
	}

	// Any of the three fields moving is a change, because each of them reaches
	// either the model (title, brief) or the tool's identity (id).
	for name, moved := range map[string]TicketSpec{
		"title": {ID: "tk-1", Title: "Renamed", Brief: "make it reconnect"},
		"brief": {ID: "tk-1", Title: "Fix reconnect", Brief: "something else"},
		"id":    {ID: "tk-2", Title: "Fix reconnect", Brief: "make it reconnect"},
	} {
		if _, changed, err := BindTicket(metadata, moved); err != nil {
			t.Fatalf("%s: %v", name, err)
		} else if !changed {
			t.Errorf("moving the %s reported no change", name)
		}
	}
}

func TestATicketTailQuotesTheBriefOnlyAtItsHead(t *testing.T) {
	brief := strings.Repeat("长", TicketTailBriefRunes+500)
	ticket := Ticket{ID: "tk-1", Title: "T", Brief: brief}
	text := TicketText(ticket)

	// The tail rides every request, so it must not carry the whole brief.
	if runes := utf8.RuneCountInString(text); runes > TicketTailBriefRunes+400 {
		t.Errorf("the tail is %d runes for a %d-rune brief; it quotes too much", runes, utf8.RuneCountInString(brief))
	}
	// A silent cut would be worse than the cost: the model would take the
	// truncated text for the whole job.
	if !strings.Contains(text, "只引用前") || !strings.Contains(text, "第一条消息") {
		t.Errorf("the truncation did not say so:\n%s", text)
	}
	// It still names the ticket and still asks for the report — those are the
	// note's whole reason to exist.
	for _, want := range []string{"T", "ticket_report"} {
		if !strings.Contains(text, want) {
			t.Errorf("the tail lacks %q:\n%s", want, text)
		}
	}

	// A brief inside the limit is quoted whole, with nothing to explain.
	short := Ticket{ID: "tk-1", Title: "T", Brief: "make the websocket reconnect"}
	if got := TicketText(short); !strings.Contains(got, "make the websocket reconnect") || strings.Contains(got, "只引用前") {
		t.Errorf("a short brief was cut:\n%s", got)
	}
}
