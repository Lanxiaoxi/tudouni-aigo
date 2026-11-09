package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

func attachmentSpec(id string, bytes int64) map[string]any {
	spec := bindSpec(id)
	// The shape the protocol layer hands over: []any of maps with int64 sizes.
	spec["attachments"] = []any{
		map[string]any{"name": "server.log", "path": ".tudouni/ticket-attachments/" + id + "/server.log", "bytes": bytes},
	}
	return spec
}

func TestInitEchoesTheAttachments(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	// Always an array, empty when none: a front end has one case to read.
	block := r.ticketInit().(map[string]any)
	if rows, ok := block["attachments"].([]any); !ok || len(rows) != 0 {
		t.Fatalf("init.ticket.attachments without any = %#v, want []", block["attachments"])
	}

	if err := r.BindTicket(attachmentSpec("tk-1", 482113)); err != nil {
		t.Fatal(err)
	}
	block = r.ticketInit().(map[string]any)
	rows, ok := block["attachments"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("init.ticket.attachments = %#v", block["attachments"])
	}
	row := rows[0].(map[string]any)
	if row["name"] != "server.log" || row["path"] != ".tudouni/ticket-attachments/tk-1/server.log" || row["bytes"] != int64(482113) {
		t.Errorf("attachment row = %#v", row)
	}
}

func TestChangedAttachmentsAreCheckpointedAndSurviveAResume(t *testing.T) {
	r, store := ticketRuntime(t)
	if err := r.BindTicket(attachmentSpec("tk-1", 10)); err != nil {
		t.Fatal(err)
	}
	// Same ticket, different size: a change, so it must reach the session file.
	if err := r.BindTicket(attachmentSpec("tk-1", 11)); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(r.SessionIDValue)
	if err != nil {
		t.Fatal(err)
	}
	ticket, ok := state.LoadTicket(loaded.Metadata)
	if !ok || len(ticket.Attachments) != 1 || ticket.Attachments[0].Bytes != 11 {
		t.Fatalf("the stored attachments = %+v", ticket.Attachments)
	}
}

func TestARefusedAttachmentLeavesNothingBound(t *testing.T) {
	r, _ := ticketRuntime(t)
	spec := bindSpec("tk-1")
	spec["attachments"] = []any{map[string]any{"name": "a", "path": "../x", "bytes": int64(1)}}
	if err := r.BindTicket(spec); err == nil {
		t.Fatal("an attachment that escapes the workspace was accepted")
	}
	if hasTicketReport(r) {
		t.Error("a refused bind registered the tool")
	}
}
