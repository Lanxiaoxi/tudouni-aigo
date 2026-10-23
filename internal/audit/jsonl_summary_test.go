package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The incremental views on the sink are only worth having if they say exactly
// what the slice-based functions say over the same records. That is the whole
// contract: `/status` reads the sink, `--audit` reads the records, and the two
// must not be able to disagree about one session.
//
// These tests compose the case that makes disagreement possible — a cache that is
// extended across several reads, with a turn boundary in the middle — rather than
// reading everything in one call, which is the case a plain recompute gets right
// by construction.

// appendScript writes a session's records in three pieces, so that each read sees
// a prefix of the log rather than the whole thing.
func appendScript(t *testing.T, sink *JsonlSink, sessionID string) [][]map[string]any {
	t.Helper()

	batches := [][]map[string]any{
		{
			Event(KindRunStarted, sessionID, "run-1", 0, nil),
			Event(KindModelCall, sessionID, "run-1", 0, map[string]any{
				"status": "ok", "prompt_tokens": 1000, "cached_tokens": 400,
				"miss_tokens": 600, "completion_tokens": 120, "duration_ms": 3000,
			}),
			Event(KindToolResult, sessionID, "run-1", 0, map[string]any{
				"name": "read_file", "status": "ok", "duration_ms": 200,
			}),
			Event(KindRunFinished, sessionID, "run-1", 0, map[string]any{"duration_ms": 5000}),
		},
		{
			Event(KindRunStarted, sessionID, "run-2", 0, nil),
			// A failed attempt inside a retry: no usage, and it must not become the
			// "last prompt" the way a naive loop would make it.
			Event(KindModelCall, sessionID, "run-2", 0, map[string]any{
				"status": "error", "duration_ms": 500, "backoff_ms": 700,
			}),
			Event(KindModelCall, sessionID, "run-2", 0, map[string]any{
				"status": "ok", "prompt_tokens": 2500, "cached_tokens": 1000,
				"miss_tokens": 1500, "completion_tokens": 300, "duration_ms": 4000,
			}),
		},
		{
			Event(KindPermission, sessionID, "run-2", 0, map[string]any{"waited_ms": 1200}),
			// A verdict nobody was asked for: it must not count as a wait.
			Event(KindPermission, sessionID, "run-2", 0, map[string]any{"outcome": "allow"}),
			Event(KindToolResult, sessionID, "run-2", 0, map[string]any{
				"name": "ask_user", "status": "ok", "duration_ms": 900,
				"human_wait_ms": 400, "question_status": "answered",
			}),
			Event(KindToolResult, sessionID, "run-2", 0, map[string]any{
				"name": "grep", "status": "ok", "duration_ms": 100, "parallel": true,
			}),
			Event(KindToolBatch, sessionID, "run-2", 0, map[string]any{"wall_ms": 80}),
			Event(KindRunFinished, sessionID, "run-2", 0, map[string]any{"duration_ms": 8000}),
		},
	}

	for index, batch := range batches {
		for _, record := range batch {
			if err := sink.Write(record); err != nil {
				t.Fatalf("writing batch %d: %v", index, err)
			}
		}
		// One read per batch: this is what makes the test about extension rather
		// than about a single full pass.
		if _, err := sink.Read(sessionID); err != nil {
			t.Fatalf("reading after batch %d: %v", index, err)
		}
	}
	return batches
}

// TestTheIncrementalSummaryMatchesASinglePass compares the two answers after the
// cache has been extended three times.
func TestTheIncrementalSummaryMatchesASinglePass(t *testing.T) {
	sink, _ := newTestSink(t)
	sessionID := "20260101-120000"
	appendScript(t, sink, sessionID)

	records, err := sink.Read(sessionID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	summary, timing, hasTurn := sink.Summary(sessionID)
	if want := state.Summarize(records); !sameValue(summary, want) {
		t.Fatalf("the incremental ledger differs from a single pass:\ngot  %v\nwant %v", summary, want)
	}

	wantTiming, wantHasTurn := LastTurnTime(records)
	if hasTurn != wantHasTurn {
		t.Fatalf("hasTurn = %v, want %v", hasTurn, wantHasTurn)
	}
	if timing != wantTiming {
		t.Fatalf("the incremental timing differs from a single pass:\ngot  %+v\nwant %+v", timing, wantTiming)
	}
}

// TestTheIncrementalLastTurnPairsByRunID is the rule `lastTurnMs` exists for: a
// turn that never finished must not report the previous turn's duration.
func TestTheIncrementalLastTurnPairsByRunID(t *testing.T) {
	sink, _ := newTestSink(t)
	sessionID := "20260101-120000"
	appendScript(t, sink, sessionID)

	// run-3 starts and dies — no `run_finished`.
	if err := sink.Write(Event(KindRunStarted, sessionID, "run-3", 0, nil)); err != nil {
		t.Fatalf("writing run-3: %v", err)
	}

	if ms, ok := sink.LastTurnMs(sessionID); ok || ms != 0 {
		t.Fatalf("a turn that never finished reported %dms (present=%v); "+
			"it must report nothing rather than the previous turn's total", ms, ok)
	}

	records, err := sink.Read(sessionID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if want, ok := LastTurnMsFromRecords(records); ok || want != 0 {
		t.Fatalf("the single-pass helper disagrees: %dms (present=%v)", want, ok)
	}
}

// TestATruncatedLogDropsTheDerivedState is the reset path. A log that shrank is a
// log somebody replaced, and the counters describing the old bytes are describing
// records that are no longer there.
func TestATruncatedLogDropsTheDerivedState(t *testing.T) {
	sink, dir := newTestSink(t)
	sessionID := "20260101-120000"
	appendScript(t, sink, sessionID)

	if _, _, hasTurn := sink.Summary(sessionID); !hasTurn {
		t.Fatal("the scripted session has no turn to report")
	}

	// Replace the file with one holding a single, different record.
	path := dir + "/" + sessionID + ".jsonl"
	if err := writeWholeFile(path, Event(KindRunStarted, sessionID, "run-new", 0, nil)); err != nil {
		t.Fatalf("rewriting the log: %v", err)
	}

	summary, _, hasTurn := sink.Summary(sessionID)
	usage, _ := summary["usage"].(map[string]any)
	if prompt, _ := usage["prompt"].(int); prompt != 0 {
		t.Fatalf("a truncated log still reports %d prompt tokens from the old bytes", prompt)
	}
	counters, _ := summary["counters"].(map[string]any)
	if runs, _ := counters["runs"].(int); runs != 1 {
		t.Fatalf("a truncated log reports %d runs, want 1", runs)
	}
	if !hasTurn {
		t.Error("the replacement record starts a turn and that turn has no finish; " +
			"hasTurn should still be true")
	}
}

// sameValue compares two summary maps by their contents.
func sameValue(left, right map[string]any) bool {
	return render(left) == render(right)
}

// render is `fmt.Sprint` under another name, so the comparison does not depend on
// map iteration order.
func render(value map[string]any) string { return fmt.Sprint(value) }

// writeWholeFile replaces a file's contents, which is the one thing the sink never
// does — and therefore the case its cache has to notice.
func writeWholeFile(path string, records ...map[string]any) error {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	for _, record := range records {
		if err := encoder.Encode(record); err != nil {
			return err
		}
	}
	return os.WriteFile(path, []byte(builder.String()), 0o600)
}

// LastTurnMsFromRecords is the single-pass form of the pairing rule, so the test
// can compare the fold against a walk. It mirrors what the runtime used to do and
// is kept here rather than in the package: the package's one implementation is the
// fold.
func LastTurnMsFromRecords(events []map[string]any) (int64, bool) {
	runID := ""
	for _, event := range events {
		if stringOf(event["kind"]) == KindRunStarted {
			runID = stringOf(event["run_id"])
		}
	}
	if runID == "" {
		return 0, false
	}
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if stringOf(event["kind"]) != KindRunFinished || stringOf(event["run_id"]) != runID {
			continue
		}
		return int64(numberOf(event["duration_ms"])), true
	}
	return 0, false
}
