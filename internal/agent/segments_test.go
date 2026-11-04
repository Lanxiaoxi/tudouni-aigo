package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// These tests pin segment scheduling: a batch is cut into runs of consecutive
// parallel-safe calls, the runs overlap internally, and the runs themselves follow
// one another in the model's order. The point of cutting by position rather than by
// tool is that a `shell` ahead of a `read_file` may have written what the read is
// about, so the two must never swap places or overlap.

// execLog records what the handlers saw, in the order it happened.
type execLog struct {
	mu      sync.Mutex
	entries []string
}

func (l *execLog) add(entry string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
}

// at is the position of the first matching entry, or -1.
func (l *execLog) at(entry string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	for index, got := range l.entries {
		if got == entry {
			return index
		}
	}
	return -1
}

func (l *execLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.entries...)
}

// rendezvous blocks each caller until `need` of them have arrived. It is how a test
// turns "these ran at the same time" from a guess about scheduling into something
// that was observed: if the calls were serialised, the first would wait here alone
// until the timeout.
type rendezvous struct {
	need int
	mu   sync.Mutex
	seen int
	all  chan struct{}
}

func newRendezvous(need int) *rendezvous {
	return &rendezvous{need: need, all: make(chan struct{})}
}

func (r *rendezvous) arrive() bool {
	r.mu.Lock()
	r.seen++
	if r.seen == r.need {
		close(r.all)
	}
	r.mu.Unlock()
	select {
	case <-r.all:
		return true
	case <-time.After(5 * time.Second):
		return false
	}
}

// probeTool is a tool that writes "start:<name>" and "end:<name>" around its work,
// optionally waiting for its peers in between.
func probeTool(name string, parallel bool, risk security.RiskLevel, log *execLog, meet *rendezvous) tools.Tool {
	return tools.Tool{
		Name:         name,
		Description:  name,
		Risk:         risk,
		ParallelSafe: parallel,
		Schema:       tools.EmptySchema(),
		Handler: func(context.Context, map[string]any) (tools.Result, error) {
			log.add("start:" + name)
			if meet != nil && !meet.arrive() {
				log.add("unmet:" + name)
			}
			log.add("end:" + name)
			return tools.TextResult("ok " + name), nil
		},
	}
}

func registerAll(t *testing.T, h *harness, list ...tools.Tool) {
	t.Helper()
	for _, tool := range list {
		if err := h.tools.Register(tool); err != nil {
			t.Fatalf("registering %s: %v", tool.Name, err)
		}
	}
}

func callsFor(names ...string) []model.ToolCall {
	calls := make([]model.ToolCall, 0, len(names))
	for index, name := range names {
		calls = append(calls, model.ToolCall{ID: fmt.Sprintf("c%d", index+1), Name: name, Arguments: `{}`})
	}
	return calls
}

// TestPlanSegmentsCutsByPositionAndNeverReorders is the rule itself, as a table.
func TestPlanSegmentsCutsByPositionAndNeverReorders(t *testing.T) {
	safe := prepared{tool: tools.Tool{Name: "safe", ParallelSafe: true}}
	serial := prepared{tool: tools.Tool{Name: "serial"}}
	unknown := prepared{}
	// The registry refuses this combination, so it can only arrive by a bug; the
	// scheduler must still not overlap a call that waits for a person.
	asking := prepared{tool: tools.Tool{Name: "asking", ParallelSafe: true, Interactive: true}}

	cases := []struct {
		name  string
		batch []prepared
		want  string
	}{
		{"empty", nil, ""},
		{"one safe call", []prepared{safe}, "0-1"},
		{"two safe calls", []prepared{safe, safe}, "0-2p"},
		{"serial then two safe", []prepared{serial, safe, safe}, "0-1 1-3p"},
		{"two safe then serial", []prepared{safe, safe, serial}, "0-2p 2-3"},
		{"safe between serial", []prepared{serial, safe, serial}, "0-1 1-2 2-3"},
		{"safe serial safe", []prepared{safe, serial, safe}, "0-1 1-2 2-3"},
		{"two runs split by one serial", []prepared{safe, safe, serial, safe, safe}, "0-2p 2-3 3-5p"},
		{"all serial", []prepared{serial, serial}, "0-1 1-2"},
		{"unknown splits a run", []prepared{safe, unknown, safe}, "0-1 1-2 2-3"},
		{"unknown beside a run", []prepared{safe, safe, unknown}, "0-2p 2-3"},
		{"interactive never overlaps", []prepared{safe, asking, safe, safe}, "0-1 1-2 2-4p"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var parts []string
			for _, group := range planSegments(testCase.batch) {
				text := fmt.Sprintf("%d-%d", group.start, group.end)
				if group.parallel {
					text += "p"
				}
				parts = append(parts, text)
			}
			if got := strings.Join(parts, " "); got != testCase.want {
				t.Errorf("plan = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestSegmentsOverlapOnlyInsideTheirOwnRun runs five calls — safe, safe, serial,
// safe, safe — and checks all three promises at once: each run really overlapped,
// no run overlapped the serial call, and the serial call kept its place.
func TestSegmentsOverlapOnlyInsideTheirOwnRun(t *testing.T) {
	log := &execLog{}
	first, second := newRendezvous(2), newRendezvous(2)
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: callsFor("p1", "p2", "ser", "p3", "p4")},
		textResponse("done"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)
	registerAll(t, h,
		probeTool("p1", true, security.RiskLow, log, first),
		probeTool("p2", true, security.RiskLow, log, first),
		probeTool("ser", false, security.RiskLow, log, nil),
		probeTool("p3", true, security.RiskLow, log, second),
		probeTool("p4", true, security.RiskLow, log, second),
	)

	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}

	for _, entry := range log.snapshot() {
		if strings.HasPrefix(entry, "unmet:") {
			t.Fatalf("%s never met its neighbour, so the run was serialised: %v", entry, log.snapshot())
		}
	}
	endOfFirstRun := max(log.at("end:p1"), log.at("end:p2"))
	startOfSerial, endOfSerial := log.at("start:ser"), log.at("end:ser")
	startOfSecondRun := min(log.at("start:p3"), log.at("start:p4"))
	if log.at("start:p1") < 0 || log.at("end:p4") < 0 || startOfSerial < 0 {
		t.Fatalf("not every call ran: %v", log.snapshot())
	}
	if startOfSerial < endOfFirstRun {
		t.Errorf("the serial call started before the run ahead of it finished: %v", log.snapshot())
	}
	if startOfSecondRun < endOfSerial {
		t.Errorf("the run behind the serial call started before it finished: %v", log.snapshot())
	}

	// Which results are marked is what the audit's timing reads: marked calls are
	// folded into the segment's wall time, unmarked ones are added up.
	wantParallel := map[string]bool{"c1": true, "c2": true, "c3": false, "c4": true, "c5": true}
	for _, result := range toolResults(h) {
		id, _ := result["call_id"].(string)
		flag, _ := result["parallel"].(bool)
		if flag != wantParallel[id] {
			t.Errorf("%s parallel = %v, want %v", id, flag, wantParallel[id])
		}
	}

	// One tool_batch per overlapped run, none for the serial call.
	var batches []map[string]any
	for _, record := range h.events {
		if kind, _ := record["kind"].(string); kind == "tool_batch" {
			batches = append(batches, record)
		}
	}
	if len(batches) != 2 {
		t.Fatalf("%d tool_batch events, want 2 (one per parallel run)", len(batches))
	}
	for index, want := range []string{"p1,p2", "p3,p4"} {
		if got, _ := batches[index]["tools"].(string); got != want {
			t.Errorf("batch %d covers %q, want %q", index, got, want)
		}
	}

	// The history is in the model's order, not the order things finished in.
	var order []string
	for _, message := range h.session.Messages {
		if role, _ := message["role"].(string); role == "tool" {
			id, _ := message["tool_call_id"].(string)
			order = append(order, id)
		}
	}
	if strings.Join(order, ",") != "c1,c2,c3,c4,c5" {
		t.Errorf("tool results are in order %v, want the model's order", order)
	}
}

// TestALoneSafeCallBetweenSerialOnesIsNotParallel: with nothing to overlap with it
// is an ordinary serial call, and it must not claim otherwise in the audit.
func TestALoneSafeCallBetweenSerialOnesIsNotParallel(t *testing.T) {
	log := &execLog{}
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: callsFor("ser1", "lone", "ser2")},
		textResponse("done"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)
	registerAll(t, h,
		probeTool("ser1", false, security.RiskLow, log, nil),
		probeTool("lone", true, security.RiskLow, log, nil),
		probeTool("ser2", false, security.RiskLow, log, nil),
	)

	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}

	for _, result := range toolResults(h) {
		if flag, _ := result["parallel"].(bool); flag {
			t.Errorf("%v was marked parallel, but nothing ran beside it", result["call_id"])
		}
	}
	for _, record := range h.events {
		if kind, _ := record["kind"].(string); kind == "tool_batch" {
			t.Errorf("a tool_batch was reported for a batch with no overlapped run: %v", record)
		}
	}
	if want := []string{"start:ser1", "end:ser1", "start:lone", "end:lone", "start:ser2", "end:ser2"}; strings.Join(log.snapshot(), ",") != strings.Join(want, ",") {
		t.Errorf("execution order = %v, want %v", log.snapshot(), want)
	}
}

// TestAQuestionInALaterSegmentWaitsForTheEarlierResults is the approval rule across
// a segment boundary. The serial call is asked about first, and the two medium-risk
// calls behind it are asked about only after its result has been shown — and both
// before either of them starts, because a yes to the second must not be given while
// the first is already running.
func TestAQuestionInALaterSegmentWaitsForTheEarlierResults(t *testing.T) {
	log := &execLog{}
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: callsFor("ser", "m1", "m2")},
		textResponse("done"),
	}}

	results := 0
	var seenAtApproval []int
	h := newHarness(t, chat, func(string, security.RiskLevel, map[string]any) bool {
		seenAtApproval = append(seenAtApproval, results)
		log.add("ask")
		return true
	})
	h.eventHook = func(record map[string]any) {
		if kind, _ := record["kind"].(string); kind == "tool_result" {
			results++
		}
	}
	registerAll(t, h,
		probeTool("ser", false, security.RiskMedium, log, nil),
		probeTool("m1", true, security.RiskMedium, log, nil),
		probeTool("m2", true, security.RiskMedium, log, nil),
	)

	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}

	if got := fmt.Sprint(seenAtApproval); got != "[0 1 1]" {
		t.Errorf("results already shown at each question = %s, want [0 1 1]", got)
	}
	// Both questions of the overlapped run come before either of its calls starts.
	asks := 0
	for _, entry := range log.snapshot() {
		if entry == "ask" {
			asks++
			continue
		}
		if (entry == "start:m1" || entry == "start:m2") && asks < 3 {
			t.Errorf("%s started after only %d questions; the run was not decided up front: %v",
				entry, asks, log.snapshot())
		}
	}
}

// TestARefusedCallInAnOverlappedRunStillAnswers: a call that never ran is still owed
// a result, and the calls beside it are unaffected.
func TestARefusedCallInAnOverlappedRunStillAnswers(t *testing.T) {
	log := &execLog{}
	chat := &fakeModel{script: []model.ModelResponse{
		{ToolCalls: callsFor("ser", "m1", "m2")},
		textResponse("done"),
	}}
	h := newHarness(t, chat, func(string, security.RiskLevel, map[string]any) bool { return false })
	registerAll(t, h,
		probeTool("ser", false, security.RiskLow, log, nil),
		probeTool("m1", true, security.RiskMedium, log, nil),
		probeTool("m2", true, security.RiskMedium, log, nil),
	)

	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}

	results := toolResults(h)
	if len(results) != 3 {
		t.Fatalf("%d results for 3 calls: %v", len(results), results)
	}
	if got := results[0]["status"]; got != statusOK {
		t.Errorf("the serial low-risk call has status %v, want ok", got)
	}
	for _, result := range results[1:] {
		if got := result["status"]; got != statusDenied {
			t.Errorf("%v has status %v, want denied", result["call_id"], got)
		}
	}
	if log.at("start:m1") >= 0 || log.at("start:m2") >= 0 {
		t.Errorf("a refused call ran: %v", log.snapshot())
	}
	h.checkConsistency(t)
}
