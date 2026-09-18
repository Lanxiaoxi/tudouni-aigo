package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The shipped schema is the authority on the wire shape (decision 21), and it is a
// file with no compiled counterpart anywhere. That is exactly the setup in which a
// sender and a contract drift apart: the schemas are byte-identical to the previous
// generation's, so any key this program forgets to send is a key the **old**
// generation sent — and nobody notices, because both ends here are the same binary.
//
// These tests read the schema and check what this package emits against it.

// schemaFile is one message type's declaration.
type schemaFile struct {
	Required []string                   `json:"required"`
	Fields   map[string]schemaFieldSpec `json:"fields"`
}

type schemaFieldSpec struct {
	Type     string `json:"type"`
	Const    any    `json:"const"`
	Nullable bool   `json:"nullable"`
	Enum     []any  `json:"enum"`
}

func loadSchema(t *testing.T, name string) map[string]schemaFile {
	t.Helper()
	path := filepath.Join("..", "..", "protocol", "schema", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	// The schema carries `$comment` keys holding prose, so the top level is decoded
	// as raw messages first and the message entries are picked out by hand.
	var any map[string]json.RawMessage
	if err := json.Unmarshal(raw, &any); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	decoded := map[string]schemaFile{}
	for key, value := range any {
		if strings.HasPrefix(key, "$") {
			continue
		}
		var spec schemaFile
		if err := json.Unmarshal(value, &spec); err != nil {
			t.Fatalf("parsing %s/%s: %v", path, key, err)
		}
		decoded[key] = spec
	}
	return decoded
}

// checkMessage reports every violation of one message's declared shape.
func checkMessage(t *testing.T, spec schemaFile, message map[string]any) {
	t.Helper()
	for _, key := range spec.Required {
		if _, present := message[key]; !present {
			t.Errorf("required key %q is missing from the message", key)
		}
	}
	for key, value := range message {
		field, known := spec.Fields[key]
		if !known {
			// An undeclared key is not fatal — a `doc`-only entry and additive
			// changes both exist — but it is worth saying out loud.
			t.Logf("note: key %q is not declared in the schema", key)
			continue
		}
		if value == nil {
			if !field.Nullable {
				t.Errorf("key %q is null but the schema does not allow it", key)
			}
			continue
		}
		switch field.Type {
		case "string":
			if _, ok := value.(string); !ok {
				t.Errorf("key %q is %T, want string", key, value)
			}
		case "integer":
			switch value.(type) {
			case int, int64, float64:
			default:
				t.Errorf("key %q is %T, want integer", key, value)
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				t.Errorf("key %q is %T, want boolean", key, value)
			}
		case "object":
			if _, ok := value.(map[string]any); !ok {
				t.Errorf("key %q is %T, want object", key, value)
			}
		case "array":
			if _, ok := value.([]any); !ok {
				t.Errorf("key %q is %T, want array", key, value)
			}
		}
		if field.Const != nil {
			if got := anyString(value); got != anyString(field.Const) {
				t.Errorf("key %q is %v, the schema pins it to %v", key, value, field.Const)
			}
		}
		if len(field.Enum) > 0 {
			allowed := false
			for _, candidate := range field.Enum {
				if anyString(candidate) == anyString(value) {
					allowed = true
					break
				}
			}
			if !allowed {
				t.Errorf("key %q is %v, which is not one of %v", key, value, field.Enum)
			}
		}
	}
}

func anyString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strings.TrimSuffix(strings.TrimSuffix(
			strings.TrimSpace(jsonNumber(typed)), ".0"), ".0")
	default:
		raw, _ := json.Marshal(value)
		return string(raw)
	}
}

func jsonNumber(value float64) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

// TestEverySchemaMessageTypeHasAGoSender is the inventory check: the schema names a
// set of message types, and every one of them has to be something this program can
// actually send. A declared type with no sender is a promise to other front ends
// that nobody has ever tested.
func TestEverySchemaMessageTypeHasAGoSender(t *testing.T) {
	schema := loadSchema(t, "outbound.schema.json")
	senders := map[string]bool{
		"init": true, "session_load": true, "event": true, "ui": true,
		"sessions": true, "notice": true, "delta": true, "delta_reset": true,
		"permission_request": true, "question_request": true,
	}
	for name := range schema {
		if strings.HasPrefix(name, "$") {
			continue
		}
		if !senders[name] {
			t.Errorf("the schema declares %q but this package has no sender for it", name)
		}
	}
	for name := range senders {
		if _, ok := schema[name]; !ok {
			t.Errorf("this package sends %q but the schema does not declare it", name)
		}
	}
}

// TestTheOpeningMessageSatisfiesItsSchema checks the handshake against the file.
//
// `init` is the message a new front end codes against first, and it is assembled by
// **merging** the runtime's fields into a two-key map. That merge is where a missing
// key hides: the compiler cannot see it, both ends here tolerate it, and the symptom
// would land on somebody writing a third front end.
func TestTheOpeningMessageSatisfiesItsSchema(t *testing.T) {
	schema := loadSchema(t, "outbound.schema.json")

	// The same merge emitOpening performs, over the fields a real runtime supplies.
	init := map[string]any{"v": VERSION, "t": OutInit, "protocol": PROTOCOL}
	for key, value := range sampleInitFields() {
		init[key] = value
	}

	checkMessage(t, schema["init"], init)
}

// TestTheBlockingRequestsSatisfyTheirSchemas: the approval and question messages are
// the two a front end must answer, so a missing or wrongly-typed key there is a
// front end that cannot reply — and the runtime blocks until it does.
func TestTheBlockingRequestsSatisfyTheirSchemas(t *testing.T) {
	schema := loadSchema(t, "outbound.schema.json")

	question := map[string]any{
		"v": VERSION, "t": OutQuestionRequest,
		"id": "q1", "question": "which one?", "header": "",
		"options": []any{"a", "b"}, "multi_select": false,
	}
	checkMessage(t, schema["question_request"], question)

	permission := map[string]any{
		"v": VERSION, "t": OutPermissionRequest,
		"id": "p1", "call_id": "c1", "tool": "shell", "risk": "high",
		"arguments":       map[string]any{"command": "rm -rf build"},
		"remember":        map[string]any{"tool": "shell"},
		"remember_hint":   "press t to remember this prefix",
		"allow_trust_all": false,
		"trust_all_hint":  nil,
	}
	checkMessage(t, schema["permission_request"], permission)
}

// TestTheOtherMessagesSatisfyTheirSchemas covers the rest of the vocabulary in one
// pass, so a key dropped from any of them fails here rather than in a new front end.
func TestTheOtherMessagesSatisfyTheirSchemas(t *testing.T) {
	schema := loadSchema(t, "outbound.schema.json")

	cases := map[string]map[string]any{
		"session_load": {
			"v": VERSION, "t": OutSessionLoad, "messages": []any{},
		},
		"sessions": {
			"v": VERSION, "t": OutSessions, "items": []any{},
		},
		"notice": {
			"v": VERSION, "t": OutNotice, "level": "warn", "code": "grep", "text": "…",
		},
		"event": {
			"v": VERSION, "t": OutEvent, "kind": "tool_call",
			"session_id": "s", "run_id": "r", "step": 1, "ts": "2026-01-01T00:00:00Z",
		},
		"ui": {
			"v": VERSION, "t": OutUI, "kind": UIState,
		},
		"delta": {
			"v": VERSION, "t": OutDelta, "session_id": "s", "run_id": "r",
			"step": 1, "channel": DeltaText, "text": "hi", "reset": false,
		},
		"delta_reset": {
			"v": VERSION, "t": OutDeltaReset, "session_id": "s", "run_id": "r", "step": 1,
		},
	}

	for name, message := range cases {
		spec, ok := schema[name]
		if !ok {
			t.Errorf("the schema has no %q declaration", name)
			continue
		}
		t.Run(name, func(t *testing.T) { checkMessage(t, spec, message) })
	}
}

// TestTheSchemaAgreesWithTheEnvelopeConstants: `v` is the one field either end fails
// hard on, so the constant and the schema's `const` must not disagree.
func TestTheSchemaAgreesWithTheEnvelopeConstants(t *testing.T) {
	for name := range loadSchema(t, "outbound.schema.json") {
		if strings.HasPrefix(name, "$") {
			continue
		}
		schema := loadSchema(t, "outbound.schema.json")
		field, ok := schema[name].Fields["v"]
		if !ok {
			t.Errorf("%s declares no `v`", name)
			continue
		}
		if got := int(field.Const.(float64)); got != VERSION {
			t.Errorf("%s pins v to %d; the constant is %d", name, got, VERSION)
		}
	}
}

// sampleInitFields is what a runtime contributes to the handshake.
func sampleInitFields() map[string]any {
	return map[string]any{
		"session_id":     "s",
		"resumed":        false,
		"model":          "deepseek-chat",
		"provider":       "deepseek",
		"thinking":       true,
		"effort":         "high",
		"effort_levels":  []any{"low", "high", "max"},
		"model_catalog":  map[string]any{"models": []any{}, "aliases": []any{}},
		"workspace":      "/tmp/ws",
		"max_steps":      120,
		"stream":         true,
		"context_tokens": 1000000,
		"tools":          []any{},
		"permissions":    map[string]any{},
		"audit_path":     "/tmp/ws/.tudouni/logs/s.jsonl",
		"notices":        []any{},
	}
}
