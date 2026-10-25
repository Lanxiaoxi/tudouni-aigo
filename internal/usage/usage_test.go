package usage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// modelCall builds the audit record one successful (or failed) model call
// emits, with the fields the ledger folds.
func modelCall(sessionID, runID, model string, prompt, cached, miss, completion, durationMs int) map[string]any {
	return map[string]any{
		"kind":              "model_call",
		"status":            "ok",
		"ts":                "2026-10-25T10:00:00.000",
		"session_id":        sessionID,
		"run_id":            runID,
		"model":             model,
		"prompt_tokens":     prompt,
		"cached_tokens":     cached,
		"miss_tokens":       miss,
		"completion_tokens": completion,
		"duration_ms":       durationMs,
	}
}

// runFinished builds the audit record one finished turn emits.
func runFinished(sessionID, runID, ts string, durationMs int) map[string]any {
	return map[string]any{
		"kind":        "run_finished",
		"ts":          ts,
		"session_id":  sessionID,
		"run_id":      runID,
		"duration_ms": durationMs,
	}
}

func TestLedgerFoldsOneRowPerTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	ledger, err := NewLedger(path)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	defer ledger.Close()

	// One turn, three successful calls, one failed attempt in the middle.
	ledger.Observe(modelCall("s1", "r1", "m-a", 100, 80, 20, 10, 500))
	ledger.Observe(modelCall("s1", "r1", "m-b", 200, 0, 200, 30, 1500))
	failed := modelCall("s1", "r1", "m-b", 999, 0, 999, 999, 999)
	failed["status"] = "error"
	ledger.Observe(failed)
	ledger.Observe(modelCall("s1", "r1", "m-b", 300, 300, 0, 60, 2500))
	// A concurrent turn from a subagent folds independently.
	ledger.Observe(modelCall("s2", "r2", "m-a", 50, 0, 50, 5, 100))
	ledger.Observe(runFinished("s2", "r2", "2026-10-25T11:00:00.000", 400))
	ledger.Observe(runFinished("s1", "r1", "2026-10-25T12:00:00.000", 6000))

	rows := readRows(t, path)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d: %v", len(rows), jsonMust(t, rows))
	}

	byRun := map[string]map[string]any{}
	for _, row := range rows {
		byRun[row["run_id"].(string)] = row
	}
	r1 := byRun["r1"]
	if r1 == nil {
		t.Fatalf("no row for r1")
	}
	// Failed attempt contributes nothing; model is the last successful call's.
	for key, want := range map[string]any{
		"prompt": 600, "cached": 380, "miss": 220, "completion": 100,
		"model_ms": int64(4500), "duration_ms": int64(6000), "calls": 3, "model": "m-b",
	} {
		if got := r1[key]; got != want && !numberEqual(got, want) {
			t.Errorf("r1.%s = %v, want %v", key, got, want)
		}
	}
	if r1["ts"] != "2026-10-25T12:00:00.000" {
		t.Errorf("r1.ts = %v, want the run_finished record's own ts", r1["ts"])
	}

	r2 := byRun["r2"]
	if r2 == nil {
		t.Fatalf("no row for r2")
	}
	if got := r2["session_id"]; got != "s2" {
		t.Errorf("r2.session_id = %v, want s2", got)
	}
}

func TestLedgerSkipsTurnsWithoutSuccessfulCalls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	ledger, err := NewLedger(path)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	defer ledger.Close()

	// A pure-tool turn, and a turn that only ever failed: neither spent tokens,
	// so neither lands in the ledger.
	ledger.Observe(runFinished("s1", "r1", "2026-10-25T10:00:00.000", 800))
	failed := modelCall("s1", "r2", "m-a", 100, 0, 100, 0, 200)
	failed["status"] = "error"
	ledger.Observe(failed)
	ledger.Observe(runFinished("s1", "r2", "2026-10-25T10:01:00.000", 900))
	// A finish for a run this process never saw start must not write either.
	ledger.Observe(runFinished("s1", "ghost", "2026-10-25T10:02:00.000", 700))

	if rows := readRows(t, path); len(rows) != 0 {
		t.Fatalf("want 0 rows, got %d: %v", len(rows), jsonMust(t, rows))
	}
}

func TestLedgerEvictsStuckFolds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	ledger, err := NewLedger(path)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	defer ledger.Close()

	// More stuck turns than maxPending: the oldest folds must be dropped, not
	// hoarded, and the newest one must still be writable afterwards.
	for i := 0; i < maxPending+10; i++ {
		ledger.Observe(modelCall("s", fmt.Sprintf("stuck-%d", i), "m", 1, 0, 1, 1, 1))
	}
	ledger.Observe(modelCall("s", "fresh", "m", 10, 0, 10, 2, 3))
	ledger.Observe(runFinished("s", "fresh", "2026-10-25T10:00:00.000", 4))

	rows := readRows(t, path)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	if rows[0]["run_id"] != "fresh" {
		t.Fatalf("the surviving row is %v, want fresh", rows[0]["run_id"])
	}
}

func TestAggregateEmptyAndMissing(t *testing.T) {
	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local)

	missing := filepath.Join(t.TempDir(), "absent.jsonl")
	report, err := Aggregate(missing, now)
	if err != nil {
		t.Fatalf("missing file: %v", err)
	}
	if report.Turns != 0 || report.Tokens != 0 || report.Peak != nil || report.StreakLongest != 0 {
		t.Fatalf("missing file must answer the zero report, got %+v", report)
	}

	empty := filepath.Join(t.TempDir(), "empty.jsonl")
	if err := os.WriteFile(empty, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err = Aggregate(empty, now)
	if err != nil {
		t.Fatalf("empty file: %v", err)
	}
	if report.Turns != 0 {
		t.Fatalf("empty file must answer the zero report, got %+v", report)
	}
}

func TestAggregateSkipsHalfLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	good := `{"v":1,"kind":"run","ts":"2026-10-25T10:00:00.000","prompt":100,"completion":10,"calls":1,"duration_ms":500}`
	half := `{"v":1,"kind":"run","ts":"2026-10-25T11:00:00.000","prom`
	content := good + "\n" + half + "\n" + good + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := Aggregate(path, time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if report.Turns != 2 || report.Prompt != 200 || report.Tokens != 220 {
		t.Fatalf("half line must be skipped, got %+v", report)
	}
}

func TestAggregatePeakStreaksAndWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	var content string
	// A three-day streak ending two days before `now`, then a gap, then today.
	// All inside the 365-day window, so by_day carries all four.
	for _, day := range []string{"2026-10-20", "2026-10-21", "2026-10-22", "2026-10-25"} {
		content += rowDay(t, day, 1000, 2) + "\n"
	}
	// A peak day older than the window: out of by_day, still the peak, and its
	// own two-day streak (the three-day October streak stays the longest).
	content += rowDay(t, "2025-09-01", 90000, 9) + "\n"
	content += rowDay(t, "2025-09-02", 10, 1) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local)
	report, err := Aggregate(path, now)
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}

	if report.Turns != 6 || report.Days != 6 || report.Tokens != 94010 {
		t.Fatalf("totals over the whole file: %+v", report)
	}
	if report.Peak == nil || report.Peak.Day != "2025-09-01" || report.Peak.Tokens != 90000 {
		t.Fatalf("peak must reach past the window: %+v", report.Peak)
	}
	// Today has a record, so the current streak counts back over the gap.
	if report.StreakCurrent != 1 || report.StreakLongest != 3 {
		t.Fatalf("streaks: current=%d longest=%d", report.StreakCurrent, report.StreakLongest)
	}
	if len(report.ByDay) != 4 {
		t.Fatalf("by_day must carry only window days, got %d: %+v", len(report.ByDay), report.ByDay)
	}
	if report.ByDay[0].Day != "2026-10-20" || report.ByDay[len(report.ByDay)-1].Day != "2026-10-25" {
		t.Fatalf("by_day must ascend: %+v", report.ByDay)
	}
}

func TestAggregateCurrentStreakFallsBackToYesterday(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	var content string
	for _, day := range []string{"2026-10-23", "2026-10-24"} {
		content += rowDay(t, day, 100, 1) + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	// `now` is the morning after: today has no record yet, so the streak is
	// still alive through yesterday — and it is two days long.
	report, err := Aggregate(path, time.Date(2026, 10, 25, 7, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if report.StreakCurrent != 2 {
		t.Fatalf("current streak through yesterday: got %d, want 2", report.StreakCurrent)
	}

	// Two silent days later the same history reads as no current streak.
	report, err = Aggregate(path, time.Date(2026, 10, 27, 7, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if report.StreakCurrent != 0 {
		t.Fatalf("a streak two silent days dead must read 0, got %d", report.StreakCurrent)
	}
}

func TestAggregateSplitsDaysByModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	content := `{"v":1,"kind":"run","ts":"2026-10-25T10:00:00.000","prompt":100,"completion":10,"calls":1,"model":"m-a"}` + "\n" +
		`{"v":1,"kind":"run","ts":"2026-10-25T11:00:00.000","prompt":200,"completion":20,"calls":1,"model":"m-b"}` + "\n" +
		// Two turns of the same model on one day fold into one bucket.
		`{"v":1,"kind":"run","ts":"2026-10-25T12:00:00.000","prompt":1,"completion":2,"calls":1,"model":"m-a"}` + "\n" +
		// A row without a model: in the day's totals, in no bucket — and the
		// day it lands on carries no key for it to hide in.
		`{"v":1,"kind":"run","ts":"2026-10-24T09:00:00.000","prompt":50,"completion":5,"calls":1}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := Aggregate(path, time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	// The split never covers the model-less row, so it sums to less than the
	// day — that is the honest answer, not a bug in the fold.
	if report.Tokens != 388 {
		t.Fatalf("totals keep every row: got %d, want 388", report.Tokens)
	}
	if len(report.ByDay) != 2 {
		t.Fatalf("by_day carries both days, got %d: %+v", len(report.ByDay), report.ByDay)
	}
	modeled := report.ByDay[1]
	if modeled.Day != "2026-10-25" {
		t.Fatalf("by_day must ascend, got %+v", report.ByDay)
	}
	if modeled.Models["m-a"] != 113 || modeled.Models["m-b"] != 220 {
		t.Fatalf("per-model split: %+v", modeled.Models)
	}
	if len(modeled.Models) != 2 {
		t.Fatalf("per-model split must carry exactly the two models: %+v", modeled.Models)
	}
	if report.ByDay[0].Models != nil {
		t.Fatalf("a day with no modeled rows carries no split: %+v", report.ByDay[0].Models)
	}
}

func TestReportPayloadOmitsEmptyModelSplits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	content := `{"v":1,"kind":"run","ts":"2026-10-25T10:00:00.000","prompt":100,"completion":10,"calls":1,"model":"m-a"}` + "\n" +
		`{"v":1,"kind":"run","ts":"2026-10-24T09:00:00.000","prompt":50,"completion":5,"calls":1}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := Aggregate(path, time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	byDay, ok := report.Payload()["by_day"].([]map[string]any)
	if !ok || len(byDay) != 2 {
		t.Fatalf("payload by_day: %v", report.Payload()["by_day"])
	}
	// Absence, not an empty map: the front end hides its per-model charts
	// when the key is missing, and an empty map would read as "charts with
	// nothing in them" — a different sentence.
	if got, ok := byDay[0]["models"]; ok {
		t.Fatalf("the model-less day must omit models, got %v", got)
	}
	split, ok := byDay[1]["models"].(map[string]int)
	if !ok {
		t.Fatalf("the modeled day must carry its split: %v", byDay[1])
	}
	if split["m-a"] != 110 {
		t.Fatalf("split value: %v", split)
	}
}

func TestAggregateDropsRowsWithoutADay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	content := `{"v":1,"kind":"run","ts":"not-a-date","prompt":100,"completion":10,"calls":1}` + "\n" +
		`{"v":1,"kind":"run","ts":"2026-10-25T10:00:00.000","prompt":1,"completion":1,"calls":1}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := Aggregate(path, time.Date(2026, 10, 25, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	// The undated spend stays in the totals but has no day to be a cell of.
	if report.Tokens != 112 || report.Turns != 2 || report.Days != 1 {
		t.Fatalf("totals keep undated rows, days do not: %+v", report)
	}
	if report.Peak == nil || report.Peak.Day != "2026-10-25" {
		t.Fatalf("peak must come from dated days only: %+v", report.Peak)
	}
}

// rowDay builds one ledger row as it sits in the file, for the read-side tests.
// One row is one finished turn; a day's turn count is how many rows carry it.
func rowDay(t *testing.T, day string, tokens, turns int) string {
	t.Helper()
	row := map[string]any{
		"v":           FileVersion,
		"kind":        KindRun,
		"ts":          day + "T12:00:00.000",
		"session_id":  "s",
		"run_id":      day + "-r",
		"prompt":      tokens - 10,
		"completion":  10,
		"calls":       turns,
		"duration_ms": 1000,
	}
	encoded, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("rowDay: %v", err)
	}
	return string(encoded)
}

// readRows parses every row the ledger wrote, failing on a row that does not.
func readRows(t *testing.T, path string) []map[string]any {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read ledger: %v", err)
	}
	var rows []map[string]any
	for _, line := range splitLines(string(content)) {
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("ledger wrote an unparseable line %q: %v", line, err)
		}
		rows = append(rows, row)
	}
	return rows
}

func splitLines(content string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' {
			if line := content[start:i]; line != "" {
				lines = append(lines, line)
			}
			start = i + 1
		}
	}
	if start < len(content) {
		lines = append(lines, content[start:])
	}
	return lines
}

func jsonMust(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

func numberEqual(got, want any) bool {
	toFloat := func(v any) (float64, bool) {
		switch n := v.(type) {
		case int:
			return float64(n), true
		case int64:
			return float64(n), true
		case float64:
			return n, true
		default:
			return 0, false
		}
	}
	a, okA := toFloat(got)
	b, okB := toFloat(want)
	return okA && okB && a == b
}
