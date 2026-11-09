package protocol

import (
	"strings"
	"testing"
)

func attachmentRow(name, path string, bytes any) map[string]any {
	return map[string]any{"name": name, "path": path, "bytes": bytes}
}

func bindWith(attachments any) map[string]any {
	return map[string]any{
		"v": VERSION, "t": InTicketBind,
		"ticket": map[string]any{"id": "tk-1", "attachments": attachments},
	}
}

func TestTicketBindPassesValidAttachmentsThrough(t *testing.T) {
	runtime := &ticketStub{}
	raw := driveServer(t, runtime, bindWith([]any{
		attachmentRow("server.log", ".tudouni/ticket-attachments/tk-1/server.log", float64(482113)),
		attachmentRow("zero.txt", "a/zero.txt", float64(0)),
	}))
	if raw != "" {
		t.Fatalf("a valid bind must be silent, got %q", raw)
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("the runtime saw %d binds", len(runtime.calls))
	}
	rows, ok := runtime.calls[0]["attachments"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("attachments = %#v", runtime.calls[0]["attachments"])
	}
	first := rows[0].(map[string]any)
	if first["name"] != "server.log" || first["path"] != ".tudouni/ticket-attachments/tk-1/server.log" || first["bytes"] != int64(482113) {
		t.Errorf("first row = %#v", first)
	}
}

func TestTicketBindWithoutOrNullAttachmentsHasNone(t *testing.T) {
	for name, message := range map[string]map[string]any{
		"absent": {"v": VERSION, "t": InTicketBind, "ticket": map[string]any{"id": "tk-1"}},
		"null":   bindWith(nil),
		"empty":  bindWith([]any{}),
	} {
		t.Run(name, func(t *testing.T) {
			runtime := &ticketStub{}
			if raw := driveServer(t, runtime, message); raw != "" {
				t.Fatalf("got %q", raw)
			}
			if len(runtime.calls) != 1 {
				t.Fatalf("calls = %d", len(runtime.calls))
			}
			if rows, _ := runtime.calls[0]["attachments"].([]any); len(rows) != 0 {
				t.Errorf("attachments = %#v", runtime.calls[0]["attachments"])
			}
		})
	}
}

func TestTicketBindRefusesBadAttachments(t *testing.T) {
	good := attachmentRow("a.log", "w/a.log", float64(1))
	tooMany := make([]any, 51)
	for index := range tooMany {
		tooMany[index] = good
	}
	cases := map[string]any{
		"not an array":     map[string]any{"name": "a"},
		"a string":         "a.log",
		"more than 50":     tooMany,
		"row not object":   []any{"a.log"},
		"name with slash":  []any{attachmentRow("d/a.log", "w/a.log", float64(1))},
		"name with bslash": []any{attachmentRow(`d\a.log`, "w/a.log", float64(1))},
		"empty name":       []any{attachmentRow("", "w/a.log", float64(1))},
		"long name":        []any{attachmentRow(strings.Repeat("n", 256), "w/a.log", float64(1))},
		"name not text":    []any{map[string]any{"name": 3, "path": "w/a", "bytes": float64(1)}},
		"empty path":       []any{attachmentRow("a", "", float64(1))},
		"long path":        []any{attachmentRow("a", strings.Repeat("p", 1025), float64(1))},
		"absolute path":    []any{attachmentRow("a", "/etc/passwd", float64(1))},
		"windows drive":    []any{attachmentRow("a", "C:/x/a.log", float64(1))},
		"dotdot segment":   []any{attachmentRow("a", "w/../../a.log", float64(1))},
		"leading dotdot":   []any{attachmentRow("a", "../a.log", float64(1))},
		"negative bytes":   []any{attachmentRow("a", "w/a", float64(-1))},
		"fractional bytes": []any{attachmentRow("a", "w/a", 1.5)},
		"bytes as text":    []any{attachmentRow("a", "w/a", "12")},
		"bytes missing":    []any{map[string]any{"name": "a", "path": "w/a"}},
		"one bad among ok": []any{good, attachmentRow("a", "../x", float64(1))},
		"path missing":     []any{map[string]any{"name": "a", "bytes": float64(1)}},
		"huge bytes":       []any{attachmentRow("a", "w/a", 1e300)},
	}
	for name, attachments := range cases {
		t.Run(name, func(t *testing.T) {
			runtime := &ticketStub{}
			message := onlyMessage(t, driveServer(t, runtime, bindWith(attachments)))
			if TypeOf(message) != OutNotice {
				t.Fatalf("got %v, want a notice", message)
			}
			if level, _ := String(message, "level"); level != "warn" {
				t.Errorf("level = %q", level)
			}
			if code, _ := String(message, "code"); code != "ticket" {
				t.Errorf("code = %q", code)
			}
			if text, _ := String(message, "text"); !strings.Contains(text, "attachments") {
				t.Errorf("the notice does not name the attachments: %q", text)
			}
			if len(runtime.calls) != 0 {
				t.Errorf("the runtime was called for a refused bind: %v", runtime.calls)
			}
		})
	}
}

func TestExactlyFiftyAttachmentsAreAccepted(t *testing.T) {
	rows := make([]any, 50)
	for index := range rows {
		rows[index] = attachmentRow("a.log", "w/a.log", float64(1))
	}
	runtime := &ticketStub{}
	if raw := driveServer(t, runtime, bindWith(rows)); raw != "" {
		t.Fatalf("got %q", raw)
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("calls = %d", len(runtime.calls))
	}
}
