package runtime

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestTheStatusPayloadKeepsTheThinkingKnobsAsAnObject pins the shape a front end
// reads.
//
// The previous generation sent `{"thinking": bool, "effort": str}` here. Sending the
// bare effort string instead is not a smaller version of the same thing: a front end
// doing `reasoning["thinking"]` gets nothing, falls back to its own default, and
// therefore reports "thinking: on" for a session where it is off. That is a
// wrong value on screen with nothing anywhere reporting a divergence, so the shape
// is worth a test of its own.
func TestTheStatusPayloadKeepsTheThinkingKnobsAsAnObject(t *testing.T) {
	metadata := map[string]any{}
	modelState := state.NewSessionModel(metadata, "m-one", "one")
	modelState.SelectThinking(false, 0)
	modelState.SelectEffort("max", 0)

	runtimeValue := &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: metadata},
		ModelState:     modelState,
		Catalog:        state.Registry{Source: "/tmp/config.json"},
		Chat:           &statusChat{},
	}

	payload := runtimeValue.StatusMessage()
	status, _ := payload["status"].(map[string]any)
	modelInfo, _ := status["model"].(map[string]any)

	reasoning, ok := modelInfo["reasoning"].(map[string]any)
	if !ok {
		t.Fatalf("reasoning is not an object: %#v", modelInfo["reasoning"])
	}
	if thinking, _ := reasoning["thinking"].(bool); thinking {
		t.Error("thinking = true, want false")
	}
	if effort, _ := reasoning["effort"].(string); effort != "max" {
		t.Errorf("effort = %v, want max (it survives thinking being off)", effort)
	}

	// `context` must be present even when the layer is off: absent and nil are the
	// same statement here, and a front end has to be able to tell "no context
	// management" from "a row of zeroes".
	if _, present := status["context"]; !present {
		t.Error("the status payload has no context key")
	}

	meta, _ := status["meta"].(map[string]any)
	if source, _ := meta["catalog"].(string); source != "/tmp/config.json" {
		t.Errorf("meta.catalog = %v, want the catalogue's source path", meta["catalog"])
	}
}

// TestTheStatePayloadAlwaysCarriesTheSubagentList pins the shape a front end reads.
//
// A running delegation is transient — it exists only for the length of one tool
// call — so the two states that matter are "one is running" and "none is", and a
// front end has to tell the second apart from "the runtime did not say". Absent
// and empty would both mean "nothing is running", and a front end that had to
// handle both is a front end with a second definition of the panel's shape; the
// first bug it produces is a crash on the empty case.
//
// The list is checked with a nil board as well, because that is the state a
// runtime built without the delegation tool holds.
func TestTheStatePayloadAlwaysCarriesTheSubagentList(t *testing.T) {
	metadata := map[string]any{}
	runtimeValue := &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: metadata},
		ModelState:     state.NewSessionModel(metadata, "m-one", "one"),
		Catalog:        state.Registry{},
		Chat:           &statusChat{},
		// The state payload reads the running autopilot switch and the granted
		// tools, so a runtime with neither is not "a runtime without subagents" —
		// it is a crash in a different place.
		Agent:  agent.New(agent.Config{Chat: &statusChat{}, Tools: tools.NewRegistry()}),
		Memory: security.NewMemory(nil, nil, "", nil),
	}

	// No board at all: delegation is not available in this runtime.
	payload := runtimeValue.StateMessage(false)
	empty, ok := payload["subagents"].([]any)
	if !ok {
		t.Fatalf("subagents is %T, want a list even when there is no board", payload["subagents"])
	}
	if len(empty) != 0 {
		t.Errorf("a runtime with no board reported %d subagents", len(empty))
	}

	// One in flight.
	runtimeValue.Subagents = subagent.NewBoard(nil)
	runtimeValue.Subagents.Start(subagent.Delegation{
		ID: "sub-s-1", Label: "count the widgets", Model: "m-one", Provider: "one", Depth: 1,
	})

	payload = runtimeValue.StateMessage(false)
	rows, ok := payload["subagents"].([]any)
	if !ok {
		t.Fatalf("subagents is %T, want a list", payload["subagents"])
	}
	if len(rows) != 1 {
		t.Fatalf("reported %d subagents, want 1", len(rows))
	}
	row, _ := rows[0].(map[string]any)
	if id, _ := row["id"].(string); id != "sub-s-1" {
		t.Errorf("row id = %v", row["id"])
	}
	if label, _ := row["label"].(string); label != "count the widgets" {
		t.Errorf("row label = %v", row["label"])
	}
}

// TestTheOriginMarkerDoesNotReachTheAuditLog keeps the private convention private.
//
// `child_origin` is a note from this program to its own protocol layer. Writing it
// into the log would put a field in the reader's view that means nothing to them —
// a child's records are in the child's own file, so which file a line came from
// already answers the question it asks. It is also what keeps "the audit log is
// the protocol" true: everything the log holds, a front end receives.
func TestTheOriginMarkerDoesNotReachTheAuditLog(t *testing.T) {
	child := map[string]any{
		subagent.ChildOriginKey: true,
		"kind":                  "tool_call",
		"subagent_id":           "sub-s-1",
		"tool":                  "read_file",
	}
	trimmed := auditRecord(child)
	if _, present := trimmed[subagent.ChildOriginKey]; present {
		t.Error("the origin marker was written to the audit log")
	}
	if trimmed["tool"] != "read_file" || trimmed["subagent_id"] != "sub-s-1" {
		t.Errorf("trimming the marker dropped something else: %v", trimmed)
	}
	// The input is not mutated: the same record goes on to the protocol layer,
	// which needs the marker.
	if _, present := child[subagent.ChildOriginKey]; !present {
		t.Error("trimming for the log removed the marker from the record itself")
	}

	// An ordinary record is returned as-is rather than copied: this runs once per
	// event on every turn, and the common case has nothing to remove.
	ordinary := map[string]any{"kind": "tool_call", "tool": "shell"}
	if got := auditRecord(ordinary); len(got) != len(ordinary) {
		t.Errorf("an ordinary record was not passed through: %v", got)
	}
}

// TestTheStatsLineReportsTheAverageOutputRate pins the one line the REPL prints
// after every turn.
//
// The figure is the **session's** average, not the last call's: this report is read
// per turn and what a person compares is the previous turn against this one. It is
// the same arithmetic the status bar and `--audit` use, so the three cannot
// disagree about what a rate is.
func TestTheStatsLineReportsTheAverageOutputRate(t *testing.T) {
	logs := tempSink(t)
	// Two successful calls: 300 tokens in 4s of model time is 75 tok/s.
	writeAll(t, logs, "s", []map[string]any{
		audit.Event(audit.KindModelCall, "s", "run-1", 0, map[string]any{
			"status": "ok", "prompt_tokens": 1000, "cached_tokens": 400,
			"completion_tokens": 100, "duration_ms": 1000}),
		audit.Event(audit.KindModelCall, "s", "run-1", 1, map[string]any{
			"status": "ok", "prompt_tokens": 2000, "cached_tokens": 2000,
			"completion_tokens": 200, "duration_ms": 3000}),
		// A failed attempt carries no usage and must not enter the denominator:
		// including it would report a rate dragged down by a call that produced
		// nothing.
		audit.Event(audit.KindModelCall, "s", "run-1", 1, map[string]any{
			"status": "error", "duration_ms": 6000, "attempt": 1}),
	})

	line := statsRuntime(logs).StatsLine()
	if !strings.Contains(line, "75.0 tok/s") {
		t.Fatalf("the stats line lost the rate: %q", line)
	}
	if !strings.Contains(line, "300 tokens") {
		t.Errorf("the stats line lost the output total: %q", line)
	}
	if !strings.Contains(line, "hit rate 80%") {
		t.Errorf("the stats line lost the cache figure: %q", line)
	}
}

// TestTheStatsLineOmitsAnUnmeasurableRate is the rule that keeps this line from
// carrying a permanent claim about nothing.
//
// A log whose successful calls recorded no duration — an older log, or one from a
// gateway that reported no usage — has completion tokens but no denominator. The
// segment is left out rather than filled with the em dash `OutputRate` returns:
// "avg — tok/s" on every turn of every session is noise, and the reports that do
// have a slot for the figure (`--audit`, `/status`) still state "not measured".
func TestTheStatsLineOmitsAnUnmeasurableRate(t *testing.T) {
	cases := []struct {
		name   string
		record map[string]any
	}{
		{
			name: "a successful call with no duration",
			record: map[string]any{"status": "ok", "prompt_tokens": 1000,
				"completion_tokens": 300},
		},
		{
			name: "a successful call with no output",
			record: map[string]any{"status": "ok", "prompt_tokens": 1000,
				"completion_tokens": 0, "duration_ms": 4000},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			logs := tempSink(t)
			writeAll(t, logs, "s", []map[string]any{
				audit.Event(audit.KindModelCall, "s", "run-1", 0, testCase.record),
			})

			line := statsRuntime(logs).StatsLine()
			if strings.Contains(line, "tok/s") {
				t.Fatalf("the stats line claims a rate it never measured: %q", line)
			}
			if strings.Contains(line, "avg —") {
				t.Fatalf("the stats line printed a dash where a figure belongs: %q", line)
			}
			// The rest of the line survives: dropping the rate must not take the
			// cache figure with it.
			if !strings.Contains(line, "hit rate") {
				t.Errorf("the rate's absence took the cache figure with it: %q", line)
			}
		})
	}
}

// tempSink is an audit sink in a directory the test owns.
func tempSink(t *testing.T) *audit.JsonlSink {
	t.Helper()
	sink, err := audit.NewJsonlSink(filepath.Join(t.TempDir(), "logs"))
	if err != nil {
		t.Fatalf("cannot open an audit sink: %v", err)
	}
	t.Cleanup(func() { _ = sink.Close() })
	return sink
}

func writeAll(t *testing.T, sink *audit.JsonlSink, sessionID string, records []map[string]any) {
	t.Helper()
	for _, record := range records {
		if err := sink.Write(record); err != nil {
			t.Fatalf("cannot write an audit record: %v", err)
		}
	}
}

// statsRuntime is the minimum a stats line needs: a session id, an audit sink and
// a model adapter that declares no window.
func statsRuntime(logs *audit.JsonlSink) *Runtime {
	metadata := map[string]any{}
	return &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: metadata},
		Logs:           logs,
		ModelState:     state.NewSessionModel(metadata, "m-one", "one"),
		Chat:           &statusChat{},
	}
}

// statusChat is the minimum a status payload needs from a model adapter.
type statusChat struct{}

func (s *statusChat) Complete(messages []map[string]any, tools []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	return model.ModelResponse{}, nil
}

func (s *statusChat) SwitchModel(name string) bool { return true }

func (s *statusChat) Install(model.Route) bool { return true }

func (s *statusChat) SetReasoning(thinking bool, effort string) {}

func (s *statusChat) ModelName() string { return "m-one" }

func (s *statusChat) ProviderName() string { return "one" }

func (s *statusChat) BaseURL() string { return "https://example.invalid" }

func (s *statusChat) Route() model.Route { return model.Route{Name: "one", Model: "m-one"} }

func (s *statusChat) SameEndpoint(route model.Route) bool { return route.Name == "one" }
