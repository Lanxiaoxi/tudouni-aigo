package protocol

import (
	"fmt"
	"strings"
	"testing"
)

// ticketStub is a runtime with the ticket-binding capability.
type ticketStub struct {
	stubRuntime

	err   error
	calls []map[string]any
	// unbinds counts the nil-spec calls separately, because a nil map and an empty
	// map are different requests and the slice above cannot tell them apart.
	unbinds int
}

func (s *ticketStub) BindTicket(ticket map[string]any) error {
	if ticket == nil {
		s.unbinds++
	}
	s.calls = append(s.calls, ticket)
	return s.err
}

func TestTicketBindPassesTheSpecToTheRuntime(t *testing.T) {
	runtime := &ticketStub{}
	raw := driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTicketBind,
		"ticket": map[string]any{"id": "tk-1", "title": "Fix it", "brief": "do the thing"},
	})
	if raw != "" {
		t.Errorf("a successful bind must be silent, got %q", raw)
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("the runtime saw %d binds, want 1", len(runtime.calls))
	}
	got := runtime.calls[0]
	if got["id"] != "tk-1" || got["title"] != "Fix it" || got["brief"] != "do the thing" {
		t.Errorf("the runtime saw %v", got)
	}
}

func TestTicketBindNullUnbinds(t *testing.T) {
	runtime := &ticketStub{}
	driveServer(t, runtime, map[string]any{"v": VERSION, "t": InTicketBind, "ticket": nil})
	if runtime.unbinds != 1 {
		t.Fatalf("a null ticket was not passed as an unbind: %v", runtime.calls)
	}
}

// An absent key is not an unbind: guessing that would silently drop the reporting
// tool from a session that is still working for a ticket.
func TestTicketBindWithoutTheKeyIsRefused(t *testing.T) {
	runtime := &ticketStub{}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{"v": VERSION, "t": InTicketBind}))
	if TypeOf(message) != OutNotice {
		t.Fatalf("got %v, want a notice", message)
	}
	if level, _ := String(message, "level"); level != "warn" {
		t.Errorf("level = %q", level)
	}
	if code, _ := String(message, "code"); code != "ticket" {
		t.Errorf("code = %q", code)
	}
	if len(runtime.calls) != 0 {
		t.Errorf("the runtime was called for a malformed bind: %v", runtime.calls)
	}
}

func TestTicketBindRefusesMalformedTickets(t *testing.T) {
	cases := map[string]any{
		"not an object": "tk-1",
		"no id":         map[string]any{"title": "x"},
		"blank id":      map[string]any{"id": "   "},
		"id not text":   map[string]any{"id": 7},
		"brief not text": map[string]any{"id": "tk-1", "brief": 3},
	}
	for name, ticket := range cases {
		t.Run(name, func(t *testing.T) {
			runtime := &ticketStub{}
			message := onlyMessage(t, driveServer(t, runtime, map[string]any{
				"v": VERSION, "t": InTicketBind, "ticket": ticket,
			}))
			if TypeOf(message) != OutNotice {
				t.Fatalf("got %v, want a notice", message)
			}
			if len(runtime.calls) != 0 {
				t.Errorf("the runtime was called: %v", runtime.calls)
			}
		})
	}
}

func TestTicketBindRuntimeRefusalReachesTheFrontEnd(t *testing.T) {
	runtime := &ticketStub{err: fmt.Errorf("too long")}
	message := onlyMessage(t, driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InTicketBind, "ticket": map[string]any{"id": "tk-1"},
	}))
	if TypeOf(message) != OutNotice {
		t.Fatalf("got %v, want a notice", message)
	}
}

// A runtime without the capability says so, rather than appearing to bind.
func TestTicketBindIsOptional(t *testing.T) {
	message := onlyMessage(t, driveServer(t, &stubRuntime{}, map[string]any{
		"v": VERSION, "t": InTicketBind, "ticket": map[string]any{"id": "tk-1"},
	}))
	if TypeOf(message) != OutNotice {
		t.Fatalf("got %v, want a notice", message)
	}
	if code, _ := String(message, "code"); code != "ticket" {
		t.Errorf("code = %q", code)
	}
}

func TestSendTicketEventAddsTheEnvelope(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.SendTicketEvent(nil)
	if output.String() != "" {
		t.Errorf("a nil payload produced output: %q", output.String())
	}
	server.SendTicketEvent(map[string]any{"kind": UITicketReport, "report_id": "r1"})
	message := onlyMessage(t, output.String())
	if TypeOf(message) != OutUI {
		t.Errorf("t = %q", TypeOf(message))
	}
	if kind, _ := String(message, "kind"); kind != UITicketReport {
		t.Errorf("kind = %q", kind)
	}
}
