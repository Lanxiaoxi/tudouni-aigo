package state

import (
	"strings"
	"testing"
)

func logAttachment() TicketAttachment {
	return TicketAttachment{
		Name:  "server.log",
		Path:  ".tudouni/ticket-attachments/tk-1/server.log",
		Bytes: 482113,
	}
}

func TestBindingStoresAttachmentsAndTheyRoundTripThroughMetadata(t *testing.T) {
	spec := TicketSpec{ID: "tk-1", Title: "T", Brief: "B", Attachments: []TicketAttachment{logAttachment()}}
	metadata := map[string]any{}
	bound, _, err := BindTicket(metadata, spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(bound.Attachments) != 1 || bound.Attachments[0] != logAttachment() {
		t.Fatalf("bound attachments = %+v", bound.Attachments)
	}

	loaded, ok := LoadTicket(metadata)
	if !ok || len(loaded.Attachments) != 1 || loaded.Attachments[0] != logAttachment() {
		t.Fatalf("loaded attachments = %+v (ok=%v)", loaded.Attachments, ok)
	}

	// A stored record that went through JSON carries float64 sizes; a resumed
	// session must read them the same way.
	roundTripped := map[string]any{TicketKey: map[string]any{
		"id": "tk-1",
		"attachments": []any{map[string]any{
			"name": "server.log", "path": ".tudouni/ticket-attachments/tk-1/server.log", "bytes": float64(482113),
		}},
	}}
	again, ok := LoadTicket(roundTripped)
	if !ok || len(again.Attachments) != 1 || again.Attachments[0] != logAttachment() {
		t.Fatalf("a JSON-decoded record lost its attachments: %+v", again.Attachments)
	}

	// The block is what init sends: always an array.
	block := bound.Block()
	rows, isList := block["attachments"].([]any)
	if !isList || len(rows) != 1 {
		t.Fatalf("block attachments = %#v", block["attachments"])
	}
	empty := Ticket{ID: "tk-2"}.Block()
	if rows, isList := empty["attachments"].([]any); !isList || len(rows) != 0 {
		t.Errorf("an unattached ticket must carry [] not %#v", empty["attachments"])
	}
}

func TestChangingTheAttachmentsIsAChangeAndRepeatingThemIsNot(t *testing.T) {
	spec := TicketSpec{ID: "tk-1", Title: "T", Brief: "B", Attachments: []TicketAttachment{logAttachment()}}
	metadata := newTicketMetadata(t, spec)

	if _, changed, err := BindTicket(metadata, spec); err != nil || changed {
		t.Errorf("identical attachments: changed=%v err=%v, want no change", changed, err)
	}

	bigger := logAttachment()
	bigger.Bytes++
	for name, moved := range map[string][]TicketAttachment{
		"size":    {bigger},
		"removed": nil,
		"added":   {logAttachment(), {Name: "b.txt", Path: ".tudouni/ticket-attachments/tk-1/b.txt", Bytes: 1}},
	} {
		moved := moved
		metadata := newTicketMetadata(t, spec)
		next := spec
		next.Attachments = moved
		if _, changed, err := BindTicket(metadata, next); err != nil || !changed {
			t.Errorf("%s: changed=%v err=%v, want a change", name, changed, err)
		}
	}

	// Re-binding with attachments keeps the reports, as it does for any refresh.
	AppendTicketReport(metadata, TicketReport{ID: "r1", Status: TicketStatusDone, Summary: "s"})
	next := spec
	next.Attachments = nil
	bound, _, err := BindTicket(metadata, next)
	if err != nil || len(bound.Reports) != 1 {
		t.Errorf("reports after refresh = %d, err=%v", len(bound.Reports), err)
	}
}

func TestBindRefusesBadAttachments(t *testing.T) {
	good := logAttachment()
	cases := map[string][]TicketAttachment{
		"empty name":    {{Name: "", Path: good.Path}},
		"slash in name": {{Name: "a/b.log", Path: good.Path}},
		"backslash":     {{Name: `a\b.log`, Path: good.Path}},
		"long name":     {{Name: strings.Repeat("n", TicketAttachmentNameCeiling+1), Path: good.Path}},
		"empty path":    {{Name: "a", Path: ""}},
		"long path":     {{Name: "a", Path: strings.Repeat("p", TicketAttachmentPathCeiling+1)}},
		"absolute":      {{Name: "a", Path: "/etc/passwd"}},
		"drive":         {{Name: "a", Path: "C:/x/a.log"}},
		"drive bare":    {{Name: "a", Path: "C:a.log"}},
		"dotdot":        {{Name: "a", Path: "x/../../a.log"}},
		"dotdot lead":   {{Name: "a", Path: "../a.log"}},
		"dotdot win":    {{Name: "a", Path: `x\..\a.log`}},
		"negative":      {{Name: "a", Path: good.Path, Bytes: -1}},
		"newline":       {{Name: "a\nb", Path: good.Path}},
	}
	for name, attachments := range cases {
		t.Run(name, func(t *testing.T) {
			metadata := map[string]any{}
			if _, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1", Attachments: attachments}); err == nil {
				t.Error("the bind was accepted")
			}
			if _, present := metadata[TicketKey]; present {
				t.Error("a refused bind left a record behind")
			}
		})
	}

	tooMany := make([]TicketAttachment, MaxTicketAttachments+1)
	for index := range tooMany {
		tooMany[index] = good
	}
	if _, _, err := BindTicket(map[string]any{}, TicketSpec{ID: "tk-1", Attachments: tooMany}); err == nil {
		t.Error("more than the cap was accepted")
	}
	if _, _, err := BindTicket(map[string]any{}, TicketSpec{ID: "tk-1", Attachments: tooMany[:MaxTicketAttachments]}); err != nil {
		t.Errorf("exactly the cap was refused: %v", err)
	}
}

func TestLoadDropsAnAttachmentRowThatEscapesTheWorkspace(t *testing.T) {
	metadata := map[string]any{TicketKey: map[string]any{
		"id": "tk-1",
		"attachments": []any{
			map[string]any{"name": "evil", "path": "../../secret", "bytes": float64(1)},
			map[string]any{"name": "ok", "path": "a/ok.log", "bytes": float64(2)},
		},
	}}
	ticket, ok := LoadTicket(metadata)
	if !ok || len(ticket.Attachments) != 1 || ticket.Attachments[0].Name != "ok" {
		t.Fatalf("attachments = %+v", ticket.Attachments)
	}
}

func TestTheTailListsTheAttachments(t *testing.T) {
	ticket := Ticket{ID: "tk-1", Title: "T", Brief: "B", Attachments: []TicketAttachment{
		logAttachment(),
		{Name: "report.pdf", Path: ".tudouni/ticket-attachments/tk-1/report.pdf", Bytes: 0},
	}}
	text := TicketText(ticket)
	for _, want := range []string{
		"- server.log: .tudouni/ticket-attachments/tk-1/server.log (482113 bytes)",
		"- report.pdf: .tudouni/ticket-attachments/tk-1/report.pdf (0 bytes)",
		"read_file", "read_document", "grep", "ticket_report",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the tail lacks %q:\n%s", want, text)
		}
	}
}

func TestTheTailIsUnchangedWithoutAttachments(t *testing.T) {
	text := TicketText(Ticket{ID: "tk-1", Title: "T", Brief: "B"})
	for _, banned := range []string{"附件", "read_document", "bytes)"} {
		if strings.Contains(text, banned) {
			t.Errorf("a ticket without attachments mentions %q:\n%s", banned, text)
		}
	}
}

func TestTheTailNeverListsMoreThanTheCap(t *testing.T) {
	// Only a hand-built Ticket can exceed the cap; the tail still stays bounded.
	many := make([]TicketAttachment, MaxTicketAttachments+30)
	for index := range many {
		many[index] = logAttachment()
	}
	text := TicketText(Ticket{ID: "tk-1", Attachments: many})
	if got := strings.Count(text, "- server.log:"); got != MaxTicketAttachments {
		t.Errorf("the tail lists %d attachments, want %d", got, MaxTicketAttachments)
	}
}
