package state

import (
	"encoding/json"
	"strings"
	"testing"
)

func personNote(id, text string, at int64) TicketNote {
	return TicketNote{ID: id, Text: text, Author: TicketNoteAuthorPerson, UpdatedAtMs: at}
}

func TestTheNoteCeilingsKeepTheirNames(t *testing.T) {
	// The desktop reads these by name from this file; the values are the design's.
	if TicketNoteTextCeiling != 4000 || MaxTicketNotes != 100 || TicketNotesTotalCeiling != 12000 || MaxTicketNoteOps != 50 {
		t.Fatalf("ceilings drifted: %d %d %d %d",
			TicketNoteTextCeiling, MaxTicketNotes, TicketNotesTotalCeiling, MaxTicketNoteOps)
	}
}

func TestABindReplacesTheNotesAndReportsChangeOnlyWhenTheyDiffer(t *testing.T) {
	metadata := map[string]any{}
	spec := TicketSpec{ID: "tk-1", Title: "T", Brief: "B", Notes: []TicketNote{personNote("n1", "one", 10)}}
	if _, changed, err := BindTicket(metadata, spec); err != nil || !changed {
		t.Fatalf("first bind: changed=%v err=%v", changed, err)
	}
	if _, changed, err := BindTicket(metadata, spec); err != nil || changed {
		t.Fatalf("identical re-bind: changed=%v err=%v, want unchanged", changed, err)
	}

	// Edited text, a different list, and an emptied list are all changes.
	for name, notes := range map[string][]TicketNote{
		"edited":  {personNote("n1", "one!", 11)},
		"added":   {personNote("n1", "one", 10), personNote("n2", "two", 12)},
		"removed": nil,
	} {
		moved := spec
		moved.Notes = notes
		probe := map[string]any{}
		_, _, _ = BindTicket(probe, spec)
		if _, changed, err := BindTicket(probe, moved); err != nil || !changed {
			t.Errorf("%s: changed=%v err=%v, want a change", name, changed, err)
		}
	}

	// Replacement, not merge: the second bind's list is the whole list.
	replaced := spec
	replaced.Notes = []TicketNote{personNote("n9", "nine", 20)}
	ticket, _, err := BindTicket(metadata, replaced)
	if err != nil {
		t.Fatal(err)
	}
	if len(ticket.Notes) != 1 || ticket.Notes[0].ID != "n9" {
		t.Errorf("notes after a replacing bind: %+v", ticket.Notes)
	}
	loaded, _ := LoadTicket(metadata)
	if len(loaded.Notes) != 1 || loaded.Notes[0].ID != "n9" {
		t.Errorf("stored notes after a replacing bind: %+v", loaded.Notes)
	}
}

func TestARebindOfTheSameTicketKeepsNoteOpsAndANewTicketClearsThem(t *testing.T) {
	metadata := map[string]any{}
	spec := TicketSpec{ID: "tk-1"}
	if _, _, err := BindTicket(metadata, spec); err != nil {
		t.Fatal(err)
	}
	_, _, refused := ApplyTicketNote(metadata, TicketNoteChange{
		Op: TicketNoteOpAdd, Text: "x", NewNoteID: "nt-1", OpID: "op-1", AtMs: 5,
	})
	if refused != "" {
		t.Fatal(refused)
	}
	// The front end's bind arrives after the write; it lists the note back, as
	// the real one would, and the op log must survive it.
	spec.Notes = []TicketNote{{ID: "nt-1", Text: "x", Author: TicketNoteAuthorAgent, UpdatedAtMs: 5}}
	ticket, _, err := BindTicket(metadata, spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(ticket.NoteOps) != 1 {
		t.Errorf("a same-id rebind lost the note ops: %+v", ticket.NoteOps)
	}
	ticket, _, _ = BindTicket(metadata, TicketSpec{ID: "tk-2"})
	if len(ticket.NoteOps) != 0 {
		t.Errorf("a different ticket kept the old note ops: %+v", ticket.NoteOps)
	}
}

func TestBindRefusesNotesOverTheCeilings(t *testing.T) {
	long := strings.Repeat("字", TicketNoteTextCeiling+1)
	manyRows := make([]TicketNote, MaxTicketNotes+1)
	for index := range manyRows {
		manyRows[index] = personNote(strings.Repeat("i", index+1), "x", 1)
	}
	// 4 x 3000 = 12000 is allowed; one more rune is not.
	exactly := []TicketNote{
		personNote("a", strings.Repeat("x", 3000), 1), personNote("b", strings.Repeat("x", 3000), 1),
		personNote("c", strings.Repeat("x", 3000), 1), personNote("d", strings.Repeat("x", 3000), 1),
	}
	over := append(append([]TicketNote(nil), exactly...), personNote("e", "x", 1))
	cases := map[string][]TicketNote{
		"one note too long": {personNote("a", long, 1)},
		"too many notes":    manyRows,
		"total too large":   over,
		"empty id":          {personNote("", "x", 1)},
		"duplicate id":      {personNote("a", "x", 1), personNote("a", "y", 1)},
		"bad author":        {{ID: "a", Text: "x", Author: "robot"}},
	}
	for name, notes := range cases {
		t.Run(name, func(t *testing.T) {
			metadata := map[string]any{}
			if _, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1", Notes: notes}); err == nil {
				t.Fatal("the bind was accepted")
			}
			if _, bound := LoadTicket(metadata); bound {
				t.Error("a refused bind left a record")
			}
		})
	}
	if _, _, err := BindTicket(map[string]any{}, TicketSpec{ID: "tk-1", Notes: exactly}); err != nil {
		t.Errorf("notes exactly at the total ceiling were refused: %v", err)
	}
}

func TestBlockCarriesNotesAndNoteOpsAsArraysThroughAJSONRoundTrip(t *testing.T) {
	metadata := map[string]any{}
	ticket, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1"})
	if err != nil {
		t.Fatal(err)
	}
	block := ticket.Block()
	for _, key := range []string{"notes", "note_ops"} {
		rows, ok := block[key].([]any)
		if !ok || len(rows) != 0 {
			t.Errorf("empty %s = %#v, want an empty array", key, block[key])
		}
	}

	_, _, refused := ApplyTicketNote(metadata, TicketNoteChange{
		Op: TicketNoteOpAdd, Text: "decision", SessionID: "s-1", NewNoteID: "nt-1", OpID: "op-1", AtMs: 1770000000000,
	})
	if refused != "" {
		t.Fatal(refused)
	}
	_, _, refused = ApplyTicketNote(metadata, TicketNoteChange{Op: TicketNoteOpRemove, ID: "nt-1", OpID: "op-2", AtMs: 1770000000001})
	if refused != "" {
		t.Fatal(refused)
	}
	_, _, _ = ApplyTicketNote(metadata, TicketNoteChange{
		Op: TicketNoteOpAdd, Text: "kept", SessionID: "s-1", NewNoteID: "nt-2", OpID: "op-3", AtMs: 1770000000002,
	})

	// Through JSON, numbers come back as float64, the way a resumed session sees them.
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	loaded, ok := LoadTicket(decoded)
	if !ok {
		t.Fatal("the record did not load")
	}
	if len(loaded.Notes) != 1 || loaded.Notes[0] != (TicketNote{
		ID: "nt-2", Text: "kept", Author: TicketNoteAuthorAgent, SessionID: "s-1",
		CreatedAtMs: 1770000000002, UpdatedAtMs: 1770000000002,
	}) {
		t.Errorf("notes after a round trip: %+v", loaded.Notes)
	}
	if len(loaded.NoteOps) != 3 || loaded.NoteOps[1].Op != TicketNoteOpRemove || loaded.NoteOps[0].AtMs != 1770000000000 {
		t.Errorf("note ops after a round trip: %+v", loaded.NoteOps)
	}

	wire := loaded.Block()["note_ops"].([]any)
	remove := wire[1].(map[string]any)
	if remove["text"] != nil || remove["op_id"] != "op-2" || remove["note_id"] != "nt-1" || remove["op"] != "remove" {
		t.Errorf("a remove op on the wire: %v", remove)
	}
	add := wire[0].(map[string]any)
	if add["text"] != "decision" {
		t.Errorf("an add op on the wire: %v", add)
	}
	note := loaded.Block()["notes"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "text", "author", "updated_at_ms", "session_id", "created_at_ms"} {
		if _, present := note[key]; !present {
			t.Errorf("a note on the wire lacks %q: %v", key, note)
		}
	}
}

func TestNoteOpsAreCappedAtTheNewest(t *testing.T) {
	metadata := map[string]any{}
	if _, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1"}); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < MaxTicketNoteOps+7; index++ {
		// Add once, then update the same note: the list of notes stays short
		// while the op log grows past its cap.
		change := TicketNoteChange{Op: TicketNoteOpAdd, Text: "x", NewNoteID: "nt-1", OpID: "op", AtMs: int64(index)}
		if index > 0 {
			change = TicketNoteChange{Op: TicketNoteOpUpdate, ID: "nt-1", Text: "y", OpID: "op", AtMs: int64(index)}
		}
		if _, _, refused := ApplyTicketNote(metadata, change); refused != "" {
			t.Fatalf("op %d refused: %s", index, refused)
		}
	}
	ticket, _ := LoadTicket(metadata)
	if len(ticket.NoteOps) != MaxTicketNoteOps {
		t.Fatalf("kept %d ops, want %d", len(ticket.NoteOps), MaxTicketNoteOps)
	}
	if ticket.NoteOps[len(ticket.NoteOps)-1].AtMs != int64(MaxTicketNoteOps+6) {
		t.Error("the newest op was dropped")
	}
}

func TestAnAgentCannotTouchAPersonsNoteAndARefusalWritesNothing(t *testing.T) {
	metadata := map[string]any{}
	if _, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1", Notes: []TicketNote{personNote("p1", "mine", 1)}}); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(metadata)
	for _, change := range []TicketNoteChange{
		{Op: TicketNoteOpUpdate, ID: "p1", Text: "yours now", OpID: "o", AtMs: 2},
		{Op: TicketNoteOpRemove, ID: "p1", OpID: "o", AtMs: 2},
	} {
		if _, _, refused := ApplyTicketNote(metadata, change); refused != NoteRefusedPersonNote {
			t.Errorf("%s on a person's note: refused=%q", change.Op, refused)
		}
	}
	if _, _, refused := ApplyTicketNote(metadata, TicketNoteChange{Op: TicketNoteOpRemove, ID: "ghost", OpID: "o"}); refused != NoteRefusedNotFound {
		t.Errorf("a missing id: refused=%q", refused)
	}
	after, _ := json.Marshal(metadata)
	if string(before) != string(after) {
		t.Errorf("a refused write changed the record:\n%s\n%s", before, after)
	}
}

func TestAgentWritesRespectTheCeilingsAndWriteNothingWhenRefused(t *testing.T) {
	metadata := map[string]any{}
	person := make([]TicketNote, 0, 4)
	for _, id := range []string{"a", "b", "c", "d"} {
		person = append(person, personNote(id, strings.Repeat("x", 3000), 1))
	}
	if _, _, err := BindTicket(metadata, TicketSpec{ID: "tk-1", Notes: person}); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(metadata)
	if _, _, refused := ApplyTicketNote(metadata, TicketNoteChange{Op: TicketNoteOpAdd, Text: "x", NewNoteID: "n", OpID: "o"}); refused != NoteRefusedTotal {
		t.Errorf("an add past the total: refused=%q", refused)
	}
	if _, _, refused := ApplyTicketNote(metadata, TicketNoteChange{Op: TicketNoteOpAdd, Text: strings.Repeat("x", TicketNoteTextCeiling+1), NewNoteID: "n", OpID: "o"}); refused != NoteRefusedTooLong {
		t.Errorf("an add past the single ceiling: refused=%q", refused)
	}
	after, _ := json.Marshal(metadata)
	if string(before) != string(after) {
		t.Error("a refused write changed the record")
	}

	// The count ceiling.
	full := map[string]any{}
	rows := make([]TicketNote, MaxTicketNotes)
	for index := range rows {
		rows[index] = personNote(strings.Repeat("i", index+1), "x", 1)
	}
	if _, _, err := BindTicket(full, TicketSpec{ID: "tk-1", Notes: rows}); err != nil {
		t.Fatal(err)
	}
	if _, _, refused := ApplyTicketNote(full, TicketNoteChange{Op: TicketNoteOpAdd, Text: "x", NewNoteID: "n", OpID: "o"}); refused != NoteRefusedFull {
		t.Errorf("an add to a full list: refused=%q", refused)
	}

	// Shrinking an agent note is allowed even when the total is at the ceiling,
	// and so is growing it back to what it was.
	tight := map[string]any{}
	notes := []TicketNote{
		personNote("a", strings.Repeat("x", 4000), 1), personNote("b", strings.Repeat("x", 4000), 1),
		{ID: "mine", Text: strings.Repeat("x", 4000), Author: TicketNoteAuthorAgent, UpdatedAtMs: 1},
	}
	if _, _, err := BindTicket(tight, TicketSpec{ID: "tk-1", Notes: notes}); err != nil {
		t.Fatal(err)
	}
	if _, _, refused := ApplyTicketNote(tight, TicketNoteChange{Op: TicketNoteOpUpdate, ID: "mine", Text: strings.Repeat("x", 3999), OpID: "o", AtMs: 2}); refused != "" {
		t.Errorf("shrinking: refused=%q", refused)
	}
	if _, _, refused := ApplyTicketNote(tight, TicketNoteChange{Op: TicketNoteOpUpdate, ID: "mine", Text: strings.Repeat("x", 4000), OpID: "o", AtMs: 3}); refused != "" {
		t.Errorf("restoring to the old size: refused=%q", refused)
	}
}

func TestApplyTicketNoteOnAnUnboundSessionIsRefused(t *testing.T) {
	metadata := map[string]any{}
	if _, _, refused := ApplyTicketNote(metadata, TicketNoteChange{Op: TicketNoteOpAdd, Text: "x", NewNoteID: "n", OpID: "o"}); refused != NoteRefusedUnbound {
		t.Errorf("refused=%q", refused)
	}
	if _, bound := LoadTicket(metadata); bound {
		t.Error("an unbound note write resurrected the binding")
	}
}

func TestATicketTailListsNotesInFullOnlyWhenThereAreSome(t *testing.T) {
	none := TicketText(Ticket{ID: "tk-1", Title: "T"})
	if strings.Contains(none, "工单笔记") || strings.Contains(none, "ticket_note") {
		t.Errorf("a ticket without notes was charged for the notes section:\n%s", none)
	}

	long := strings.Repeat("长", TicketNoteTextCeiling)
	ticket := Ticket{ID: "tk-1", Title: "T", Notes: []TicketNote{
		// Out of order on purpose: the later one is listed first in the slice.
		{ID: "nt-b", Text: "second", Author: TicketNoteAuthorAgent, CreatedAtMs: 1778000000000, UpdatedAtMs: 1778000000000},
		{ID: "nt-a", Text: long, Author: TicketNoteAuthorPerson, CreatedAtMs: 1777000000000, UpdatedAtMs: 1777000000000},
	}}
	text := TicketText(ticket)
	for _, want := range []string{
		"## 工单笔记（跨会话共享；这张工单上的每个会话都能看到）",
		"[nt-a · 用户 · ", "[nt-b · agent · ", long, "second",
		"用户写的条目代表用户的判断，优先级高于你自己的推断。用户要求你记录什么时，调用 ticket_note；其余时候不要写。",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the tail lacks %q", want)
		}
	}
	if strings.Index(text, "nt-a") > strings.Index(text, "nt-b") {
		t.Error("the notes are not sorted by creation time")
	}
	if strings.Contains(text, "只引用前") {
		t.Error("notes were truncated")
	}

	// Without creation times the front end's own order stands.
	undated := Ticket{ID: "tk-1", Notes: []TicketNote{
		personNote("z", "first", 300), personNote("y", "second", 100),
	}}
	got := TicketText(undated)
	if strings.Index(got, "[z ·") > strings.Index(got, "[y ·") {
		t.Errorf("undated notes were reordered:\n%s", got)
	}
}

func TestTheBriefCutPointsAtBriefMd(t *testing.T) {
	text := TicketText(Ticket{ID: "tk-1", Brief: strings.Repeat("长", TicketTailBriefRunes+1)})
	if !strings.Contains(text, "第一条消息") || !strings.Contains(text, "brief.md") {
		t.Errorf("the cut does not say where the full brief is:\n%s", text)
	}
}
