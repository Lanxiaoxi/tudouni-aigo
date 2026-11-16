package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

func hasTicketNote(r *Runtime) bool {
	_, present := r.Tools.Get(builtin.TicketNoteToolName)
	return present
}

func callNote(t *testing.T, r *Runtime, args map[string]any) (tools.Result, error) {
	t.Helper()
	tool, ok := r.Tools.Get(builtin.TicketNoteToolName)
	if !ok {
		t.Fatal("ticket_note is not registered")
	}
	return tool.Execute(context.Background(), args)
}

func bindWithNotes(id string, notes ...map[string]any) map[string]any {
	rows := make([]any, 0, len(notes))
	for _, note := range notes {
		rows = append(rows, note)
	}
	spec := bindSpec(id)
	spec["notes"] = rows
	return spec
}

func personRow(id, text string) map[string]any {
	return map[string]any{"id": id, "text": text, "author": "person", "updated_at_ms": int64(1770000000000)}
}

func TestTheNoteToolIsRegisteredAndUnregisteredWithTheBinding(t *testing.T) {
	r, _ := ticketRuntime(t)
	if hasTicketNote(r) {
		t.Fatal("ticket_note was registered before anything was bound")
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if !hasTicketNote(r) || !hasTicketReport(r) {
		t.Fatal("binding did not register both ticket tools")
	}
	// Idempotent, like the report tool.
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatalf("re-binding failed: %v", err)
	}
	if err := r.BindTicket(nil); err != nil {
		t.Fatal(err)
	}
	if hasTicketNote(r) || hasTicketReport(r) {
		t.Fatal("unbinding left a ticket tool registered")
	}
}

func TestNoteToolAddUpdateRemove(t *testing.T) {
	r, _ := ticketRuntime(t)
	var announced []map[string]any
	r.onTicketEvent = func(payload map[string]any) { announced = append(announced, payload) }
	if err := r.BindTicket(bindWithNotes("tk-1", personRow("p1", "user insight"))); err != nil {
		t.Fatal(err)
	}

	result, err := callNote(t, r, map[string]any{"op": "add", "text": "  decided on plan B  "})
	if err != nil {
		t.Fatal(err)
	}
	if len(announced) != 1 {
		t.Fatalf("%d announcements, want 1", len(announced))
	}
	add := announced[0]
	noteID, _ := add["note_id"].(string)
	if !strings.HasPrefix(noteID, "nt-") || strings.Count(noteID, "-") != 2 {
		t.Errorf("note id %q is not nt-<base36>-<random>", noteID)
	}
	if !strings.Contains(result.Text, noteID) {
		t.Errorf("the model was not told the note id: %q", result.Text)
	}
	opID, _ := add["op_id"].(string)
	if add["kind"] != "ticket_note" || add["ticket_id"] != "tk-1" || add["session_id"] != r.SessionIDValue ||
		add["op"] != "add" || add["text"] != "decided on plan B" || opID == "" {
		t.Errorf("add announcement: %v", add)
	}
	if at, _ := add["at_ms"].(int64); at <= 0 {
		t.Errorf("at_ms = %v", add["at_ms"])
	}
	ticket, _ := r.ticket()
	if len(ticket.Notes) != 2 || ticket.Notes[1].Author != "agent" || ticket.Notes[1].SessionID != r.SessionIDValue ||
		ticket.Notes[1].CreatedAtMs <= 0 {
		t.Fatalf("notes after add: %+v", ticket.Notes)
	}
	// The next tail already shows it.
	if tail := r.notes(); !strings.Contains(tail, "decided on plan B") {
		t.Errorf("the tail does not show the new note:\n%s", tail)
	}

	announced = nil
	if _, err := callNote(t, r, map[string]any{"op": "update", "id": noteID, "text": "plan B, revised"}); err != nil {
		t.Fatal(err)
	}
	if got := announced[0]; got["op"] != "update" || got["note_id"] != noteID || got["text"] != "plan B, revised" {
		t.Errorf("update announcement: %v", got)
	}
	if got := announced[0]["op_id"]; got == opID {
		t.Error("two writes shared an op id")
	}

	announced = nil
	if _, err := callNote(t, r, map[string]any{"op": "remove", "id": noteID}); err != nil {
		t.Fatal(err)
	}
	if got := announced[0]; got["op"] != "remove" || got["note_id"] != noteID || got["text"] != nil {
		t.Errorf("remove announcement: %v", got)
	}
	ticket, _ = r.ticket()
	if len(ticket.Notes) != 1 || ticket.Notes[0].ID != "p1" {
		t.Errorf("notes after remove: %+v", ticket.Notes)
	}
	if len(ticket.NoteOps) != 3 {
		t.Errorf("note_ops = %d, want 3", len(ticket.NoteOps))
	}
}

func TestNoteToolRefusesMalformedCalls(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string]map[string]any{
		"no op":              {"text": "x"},
		"bad op":             {"op": "rename", "id": "a", "text": "x"},
		"add without text":   {"op": "add"},
		"add blank text":     {"op": "add", "text": "   "},
		"update without id":  {"op": "update", "text": "x"},
		"update without text": {"op": "update", "id": "a"},
		"remove without id":  {"op": "remove"},
	} {
		if _, err := callNote(t, r, args); err == nil {
			t.Errorf("%s: the call was accepted", name)
		} else if _, ok := err.(*tools.InvalidArgumentsError); !ok {
			t.Errorf("%s: error %T is not an invalid-arguments error", name, err)
		}
	}
	if ticket, _ := r.ticket(); len(ticket.Notes) != 0 || len(ticket.NoteOps) != 0 {
		t.Errorf("a refused call wrote something: %+v", ticket)
	}
}

func TestAnAgentCannotEditAPersonsNote(t *testing.T) {
	r, _ := ticketRuntime(t)
	announced := 0
	r.onTicketEvent = func(map[string]any) { announced++ }
	if err := r.BindTicket(bindWithNotes("tk-1", personRow("p1", "do not touch the middleware"))); err != nil {
		t.Fatal(err)
	}
	for _, args := range []map[string]any{
		{"op": "update", "id": "p1", "text": "rewritten"},
		{"op": "remove", "id": "p1"},
	} {
		_, err := callNote(t, r, args)
		if err == nil {
			t.Fatalf("%v was accepted", args)
		}
		if !strings.Contains(err.Error(), "user") {
			t.Errorf("the refusal does not say whose note it is: %v", err)
		}
	}
	if _, err := callNote(t, r, map[string]any{"op": "remove", "id": "ghost"}); err == nil {
		t.Error("a missing id was accepted")
	}
	ticket, _ := r.ticket()
	if len(ticket.Notes) != 1 || ticket.Notes[0].Text != "do not touch the middleware" || len(ticket.NoteOps) != 0 {
		t.Errorf("a refused call changed the record: %+v", ticket)
	}
	if announced != 0 {
		t.Error("a refused call was announced")
	}
}

func TestAnOverCeilingNoteIsRefusedAndNothingIsWritten(t *testing.T) {
	r, store := ticketRuntime(t)
	announced := 0
	r.onTicketEvent = func(map[string]any) { announced++ }
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	path, _ := store.Path(r.SessionIDValue)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = callNote(t, r, map[string]any{"op": "add", "text": strings.Repeat("x", state.TicketNoteTextCeiling+1)})
	if err == nil {
		t.Fatal("an over-long note was accepted")
	}
	if ticket, _ := r.ticket(); len(ticket.Notes) != 0 || len(ticket.NoteOps) != 0 {
		t.Errorf("a refused call left notes behind: %+v", ticket)
	}
	after, _ := os.Stat(path)
	if !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Error("a refused call rewrote the session file")
	}
	if announced != 0 {
		t.Error("a refused call was announced")
	}

	// A full list says how to make room.
	rows := make([]map[string]any, state.MaxTicketNotes)
	for index := range rows {
		rows[index] = personRow(strings.Repeat("i", index+1), "x")
	}
	if err := r.BindTicket(bindWithNotes("tk-1", rows...)); err != nil {
		t.Fatal(err)
	}
	_, err = callNote(t, r, map[string]any{"op": "add", "text": "one more"})
	if err == nil || !strings.Contains(err.Error(), "删") && !strings.Contains(strings.ToLower(err.Error()), "delete") {
		t.Errorf("a full list did not say how to make room: %v", err)
	}
}

// The ordering rule, for notes: by the time the front end hears about a write, the
// session file already holds it.
func TestANoteIsOnDiskBeforeItIsAnnounced(t *testing.T) {
	r, store := ticketRuntime(t)
	var onDisk []state.TicketNote
	var diskOps []state.TicketNoteOp
	announced := 0
	r.onTicketEvent = func(payload map[string]any) {
		announced++
		loaded, err := store.Load(r.SessionIDValue)
		if err != nil {
			t.Errorf("load at announce time: %v", err)
			return
		}
		ticket, _ := state.LoadTicket(loaded.Metadata)
		onDisk, diskOps = ticket.Notes, ticket.NoteOps
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := callNote(t, r, map[string]any{"op": "add", "text": "insight"}); err != nil {
		t.Fatal(err)
	}
	if announced != 1 {
		t.Fatalf("%d announcements, want 1", announced)
	}
	if len(onDisk) != 1 || onDisk[0].Text != "insight" || len(diskOps) != 1 {
		t.Fatalf("at announce time the file held notes=%v ops=%v", onDisk, diskOps)
	}
}

func TestANoteIsNotAReport(t *testing.T) {
	r, _ := ticketRuntime(t)
	turnEnds := 0
	r.onTicketEvent = func(payload map[string]any) {
		if payload["kind"] == "ticket_turn_end" {
			turnEnds++
		}
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	r.beginTicketTurn()
	if _, err := callNote(t, r, map[string]any{"op": "add", "text": "x"}); err != nil {
		t.Fatal(err)
	}
	r.ObserveTicketTurn("run-1")
	if turnEnds != 1 {
		t.Fatalf("a turn whose only write was a note: %d turn-end announcements, want 1", turnEnds)
	}
}

func TestANoteAfterTheUnbindIsRefused(t *testing.T) {
	r, _ := ticketRuntime(t)
	announced := 0
	r.onTicketEvent = func(map[string]any) { announced++ }
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	tool, _ := r.Tools.Get(builtin.TicketNoteToolName)
	if err := r.BindTicket(nil); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), map[string]any{"op": "add", "text": "late"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "no longer bound") {
		t.Errorf("the refusal does not say the session was unbound: %q", result.Text)
	}
	if announced != 0 {
		t.Error("a note was announced after the unbind")
	}
	if _, ok := r.ticket(); ok {
		t.Error("the late note resurrected the binding")
	}
}

func TestANotesBindReplacesTheCopyAndOnlyChangesCheckpoint(t *testing.T) {
	r, store := ticketRuntime(t)
	spec := bindWithNotes("tk-1", personRow("p1", "one"))
	if err := r.BindTicket(spec); err != nil {
		t.Fatal(err)
	}
	path, _ := store.Path(r.SessionIDValue)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.BindTicket(spec); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Error("an identical re-bind with notes rewrote the session file")
	}

	if err := r.BindTicket(bindWithNotes("tk-1", personRow("p2", "two"), personRow("p3", "three"))); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(r.SessionIDValue)
	if err != nil {
		t.Fatal(err)
	}
	ticket, _ := state.LoadTicket(loaded.Metadata)
	if len(ticket.Notes) != 2 || ticket.Notes[0].ID != "p2" {
		t.Errorf("a changed notes list was not replaced on disk: %+v", ticket.Notes)
	}
	// A bind without notes means the front end has none.
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if ticket, _ := r.ticket(); len(ticket.Notes) != 0 {
		t.Errorf("a bind with no notes kept the old copy: %+v", ticket.Notes)
	}
}

func TestInitCarriesNotesAndNoteOpsAsArrays(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	block, _ := r.ticketInit().(map[string]any)
	for _, key := range []string{"notes", "note_ops"} {
		rows, ok := block[key].([]any)
		if !ok || len(rows) != 0 {
			t.Errorf("empty init.ticket.%s = %#v, want an empty array", key, block[key])
		}
	}
	if err := r.BindTicket(bindWithNotes("tk-1", personRow("p1", "one"))); err != nil {
		t.Fatal(err)
	}
	if _, err := callNote(t, r, map[string]any{"op": "add", "text": "mine"}); err != nil {
		t.Fatal(err)
	}
	block, _ = r.ticketInit().(map[string]any)
	notes, _ := block["notes"].([]any)
	ops, _ := block["note_ops"].([]any)
	if len(notes) != 2 || len(ops) != 1 {
		t.Fatalf("notes=%v note_ops=%v", block["notes"], block["note_ops"])
	}
	for _, key := range []string{"id", "text", "author", "updated_at_ms"} {
		if _, present := notes[0].(map[string]any)[key]; !present {
			t.Errorf("init.ticket.notes[0] lacks %q", key)
		}
	}
	for _, key := range []string{"op_id", "op", "note_id", "text", "at_ms"} {
		if _, present := ops[0].(map[string]any)[key]; !present {
			t.Errorf("init.ticket.note_ops[0] lacks %q", key)
		}
	}
}

func TestTheNotesReachThePayloadTail(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindWithNotes("tk-1", personRow("p1", "the legacy system has implicit coupling"))); err != nil {
		t.Fatal(err)
	}
	tail := r.notes()
	for _, want := range []string{"工单笔记", "[p1 · 用户", "the legacy system has implicit coupling", "ticket_note"} {
		if !strings.Contains(tail, want) {
			t.Errorf("the tail lacks %q:\n%s", want, tail)
		}
	}
}

func TestTheNoteToolAndNotesSurviveAResume(t *testing.T) {
	scene := newSandbox(t)
	store, err := state.NewSessionStore(filepath.Join(scene.Workspace, ".tudouni", "test-sessions"))
	if err != nil {
		t.Fatal(err)
	}
	booted := Booted{Store: store}

	first, err := OpenRuntime(Options{Booted: booted, Session: state.NewEmptySession("20260101-120000")})
	if err != nil {
		t.Fatalf("assembling: %v", err)
	}
	t.Cleanup(func() { _ = first.Jobs.Close() })
	if hasTicketNote(first) {
		t.Fatal("a fresh session already had ticket_note")
	}
	if err := first.BindTicket(bindWithNotes("tk-1", personRow("p1", "user note"))); err != nil {
		t.Fatal(err)
	}
	if _, err := callNote(t, first, map[string]any{"op": "add", "text": "agent note"}); err != nil {
		t.Fatal(err)
	}

	loaded, err := store.Load("20260101-120000")
	if err != nil {
		t.Fatal(err)
	}
	second, err := OpenRuntime(Options{Booted: booted, Session: loaded, Resumed: true})
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = second.Jobs.Close() })
	if !hasTicketNote(second) {
		t.Fatal("the resumed session did not get ticket_note back")
	}
	block, _ := second.InitFields()["ticket"].(map[string]any)
	if notes, _ := block["notes"].([]any); len(notes) != 2 {
		t.Errorf("the resumed session lost its notes: %v", block["notes"])
	}
	if ops, _ := block["note_ops"].([]any); len(ops) != 1 {
		t.Errorf("the resumed session lost its note ops: %v", block["note_ops"])
	}
	if tail := second.notes(); !strings.Contains(tail, "agent note") || !strings.Contains(tail, "user note") {
		t.Errorf("the resumed tail lacks the notes:\n%s", tail)
	}
}
