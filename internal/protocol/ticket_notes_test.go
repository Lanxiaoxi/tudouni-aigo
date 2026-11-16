package protocol

import (
	"strings"
	"testing"
)

func noteRow(id, text, author string, updated any) map[string]any {
	return map[string]any{"id": id, "text": text, "author": author, "updated_at_ms": updated}
}

func bindWithNotes(notes any) map[string]any {
	return map[string]any{
		"v": VERSION, "t": InTicketBind,
		"ticket": map[string]any{"id": "tk-1", "notes": notes},
	}
}

func TestTicketBindPassesValidNotesThrough(t *testing.T) {
	runtime := &ticketStub{}
	row := noteRow("nt-2", "agent said", "agent", float64(1770000000001))
	row["session_id"] = "s-1"
	row["created_at_ms"] = float64(1770000000000)
	raw := driveServer(t, runtime, bindWithNotes([]any{
		noteRow("nt-1", "person said", "person", float64(1770000000000)),
		row,
	}))
	if raw != "" {
		t.Fatalf("a valid bind must be silent, got %q", raw)
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("the runtime saw %d binds, want 1", len(runtime.calls))
	}
	rows, ok := runtime.calls[0]["notes"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("notes = %#v", runtime.calls[0]["notes"])
	}
	first := rows[0].(map[string]any)
	if first["id"] != "nt-1" || first["text"] != "person said" || first["author"] != "person" || first["updated_at_ms"] != int64(1770000000000) {
		t.Errorf("first row = %#v", first)
	}
	second := rows[1].(map[string]any)
	if second["session_id"] != "s-1" || second["created_at_ms"] != int64(1770000000000) {
		t.Errorf("optional fields were dropped: %#v", second)
	}
}

func TestTicketBindWithoutOrNullNotesHasNone(t *testing.T) {
	for name, message := range map[string]map[string]any{
		"absent": {"v": VERSION, "t": InTicketBind, "ticket": map[string]any{"id": "tk-1"}},
		"null":   bindWithNotes(nil),
		"empty":  bindWithNotes([]any{}),
	} {
		t.Run(name, func(t *testing.T) {
			runtime := &ticketStub{}
			if raw := driveServer(t, runtime, message); raw != "" {
				t.Fatalf("got %q", raw)
			}
			if len(runtime.calls) != 1 {
				t.Fatalf("calls = %d", len(runtime.calls))
			}
			if rows, _ := runtime.calls[0]["notes"].([]any); len(rows) != 0 {
				t.Errorf("notes = %#v", runtime.calls[0]["notes"])
			}
		})
	}
}

func TestTicketBindRefusesTheWholeBindOnABadNote(t *testing.T) {
	good := noteRow("ok", "fine", "person", float64(1))
	tooMany := make([]any, 101)
	for index := range tooMany {
		tooMany[index] = noteRow(strings.Repeat("i", index+1), "x", "person", float64(1))
	}
	cases := map[string]any{
		"not an array":     map[string]any{"id": "a"},
		"row not object":   []any{"note"},
		"empty id":         []any{noteRow("", "x", "person", float64(1))},
		"id not text":      []any{map[string]any{"id": 3, "text": "x", "author": "person", "updated_at_ms": float64(1)}},
		"text missing":     []any{map[string]any{"id": "a", "author": "person", "updated_at_ms": float64(1)}},
		"text not text":    []any{noteRow("a", "x", "person", float64(1)), map[string]any{"id": "b", "text": 4, "author": "person", "updated_at_ms": float64(1)}},
		"author unknown":   []any{noteRow("a", "x", "robot", float64(1))},
		"author missing":   []any{map[string]any{"id": "a", "text": "x", "updated_at_ms": float64(1)}},
		"updated missing":  []any{map[string]any{"id": "a", "text": "x", "author": "person"}},
		"updated fraction": []any{noteRow("a", "x", "person", 1.5)},
		"updated negative": []any{noteRow("a", "x", "person", float64(-1))},
		"updated as text":  []any{noteRow("a", "x", "person", "1")},
		"duplicate id":     []any{noteRow("a", "x", "person", float64(1)), noteRow("a", "y", "agent", float64(1))},
		"one note too long": []any{noteRow("a", strings.Repeat("字", 4001), "person", float64(1))},
		"more than 100":    tooMany,
		"total too large": []any{
			noteRow("a", strings.Repeat("x", 4000), "person", float64(1)),
			noteRow("b", strings.Repeat("x", 4000), "person", float64(1)),
			noteRow("c", strings.Repeat("x", 4000), "person", float64(1)),
			noteRow("d", "x", "person", float64(1)),
		},
		"one bad among ok": []any{good, noteRow("b", "x", "nobody", float64(1))},
	}
	for name, notes := range cases {
		t.Run(name, func(t *testing.T) {
			runtime := &ticketStub{}
			message := onlyMessage(t, driveServer(t, runtime, bindWithNotes(notes)))
			if TypeOf(message) != OutNotice {
				t.Fatalf("got %v, want a notice", message)
			}
			if level, _ := String(message, "level"); level != "warn" {
				t.Errorf("level = %q", level)
			}
			if code, _ := String(message, "code"); code != "ticket" {
				t.Errorf("code = %q", code)
			}
			if text, _ := String(message, "text"); !strings.Contains(text, "notes") {
				t.Errorf("the notice does not name the notes: %q", text)
			}
			if len(runtime.calls) != 0 {
				t.Errorf("the runtime was called for a refused bind: %v", runtime.calls)
			}
		})
	}
}

func TestNotesExactlyAtTheCeilingsAreAccepted(t *testing.T) {
	rows := make([]any, 100)
	for index := range rows {
		rows[index] = noteRow(strings.Repeat("i", index+1), "x", "person", float64(1))
	}
	runtime := &ticketStub{}
	if raw := driveServer(t, runtime, bindWithNotes(rows)); raw != "" {
		t.Fatalf("100 notes: got %q", raw)
	}
	runtime = &ticketStub{}
	three := []any{
		noteRow("a", strings.Repeat("字", 4000), "person", float64(1)),
		noteRow("b", strings.Repeat("字", 4000), "person", float64(1)),
		noteRow("c", strings.Repeat("字", 4000), "agent", float64(1)),
	}
	if raw := driveServer(t, runtime, bindWithNotes(three)); raw != "" {
		t.Fatalf("12000 runes: got %q", raw)
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("calls = %d", len(runtime.calls))
	}
}
