package runtime

import (
	"encoding/json"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// statePanelRuntime is the smallest runtime the state payload can be built from.
// Every field it reads is filled in because a nil one is not "a runtime without
// that feature" — it is a panic somewhere else, and the test would then be about
// the wrong thing.
func statePanelRuntime(session *state.Session) *Runtime {
	return &Runtime{
		SessionIDValue: session.SessionID,
		SessionValue:   session,
		ModelState:     state.NewSessionModel(session.Metadata, "m-one", "one"),
		Catalog:        state.Registry{},
		Chat:           &statusChat{},
		Agent:          agent.New(agent.Config{Chat: &statusChat{}, Tools: tools.NewRegistry()}),
		Memory:         security.NewMemory(nil, nil, "", nil),
		Policy:         security.Policy{},
	}
}

// todoRowsInPayload reads the task block's rows the way a front end does: out of
// the JSON that actually crosses the wire, not out of the map the runtime built.
// The TUI is a child process on the JSONL protocol, so the round trip is part of
// the contract rather than a test convenience.
func todoRowsInPayload(t *testing.T, payload map[string]any) []any {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("the state payload does not encode: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("the state payload does not decode: %v", err)
	}
	rows, ok := decoded["todos"].([]any)
	if !ok {
		t.Fatalf("todos is %T on the wire, want a list", decoded["todos"])
	}
	return rows
}

// TestTheStatePayloadCarriesATaskListWrittenThisSession is the regression for the
// task block being empty for a whole live session.
//
// `todo_write` stores the list it just received as `[]map[string]any` because the
// board writes straight into live session metadata; the same list read back from a
// session file went through JSON and is a `[]any`. The runtime's own reader accepted
// only the second shape, so it answered "no list" for every list written in this
// process — which is the whole of a live session. The Tasks block in the rail (and
// every other reader of the state payload) drew "No tasks yet" while the model was
// on its fifteenth `todo_write`, and the same list appeared after a `/resume`, when
// it had been through the file once.
func TestTheStatePayloadCarriesATaskListWrittenThisSession(t *testing.T) {
	session := state.NewEmptySession("s")
	if result := builtin.NewTodoBoard(session.Metadata).Write(map[string]any{
		"todos": []any{
			map[string]any{"content": "复现断连", "status": builtin.InProgress},
			map[string]any{"content": "补一条回归测试", "status": builtin.Pending},
		},
	}); result.Text == "" {
		t.Fatal("the task list was not written")
	}

	rows := todoRowsInPayload(t, statePanelRuntime(session).StateMessage(false))
	if len(rows) != 2 {
		t.Fatalf("the task block got %d rows, want 2 (the list written this session)", len(rows))
	}
	first, _ := rows[0].(map[string]any)
	if content, _ := first["content"].(string); content != "复现断连" {
		t.Errorf("first row content = %v, want the task the model wrote", first["content"])
	}
	if status, _ := first["status"].(string); status != builtin.InProgress {
		t.Errorf("first row status = %v, want %s", first["status"], builtin.InProgress)
	}
}

// TestTheStatePayloadCarriesATaskListLoadedFromDisk is the other half of the same
// rule: the JSON shape a resumed session hands over has to keep working. A fix that
// only taught the reader the in-memory shape would trade one empty block for
// another.
func TestTheStatePayloadCarriesATaskListLoadedFromDisk(t *testing.T) {
	session := state.NewEmptySession("s")
	loaded, err := json.Marshal([]map[string]any{
		{"content": "复现断连", "status": builtin.InProgress},
		{"content": "补一条回归测试", "status": builtin.Completed},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fromFile any
	if err := json.Unmarshal(loaded, &fromFile); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	session.Metadata[builtin.TodosKey] = fromFile

	rows := todoRowsInPayload(t, statePanelRuntime(session).StateMessage(false))
	if len(rows) != 2 {
		t.Fatalf("the task block got %d rows, want 2 (the list read back from a session file)", len(rows))
	}
}

// TestTheStatePayloadSaysNoTasksInTheEmptyShapes: absent, null and an empty list all
// mean "no task list", and every one of them has to leave the payload's shape alone
// — a front end with two empty cases has two places to get the empty one wrong.
func TestTheStatePayloadSaysNoTasksInTheEmptyShapes(t *testing.T) {
	for name, value := range map[string]any{
		"absent":       nil,
		"empty":        []any{},
		"empty in map": []map[string]any{},
	} {
		session := state.NewEmptySession("s")
		if value != nil {
			session.Metadata[builtin.TodosKey] = value
		}
		rows := todoRowsInPayload(t, statePanelRuntime(session).StateMessage(false))
		if len(rows) != 0 {
			t.Errorf("%s: reported %d rows, want 0", name, len(rows))
		}
	}
}
