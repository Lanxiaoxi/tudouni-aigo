package audit

import (
	"strings"
	"testing"
)

// TestTheTimingAddsUpOutOfTheEvents mirrors the previous generation's
// `summarize_time`, including the two subtleties that make the numbers mean
// something.
func TestTheTimingAddsUpOutOfTheEvents(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "duration_ms": 1000, "status": "ok"},
		{"kind": "model_call", "duration_ms": 500, "status": "error", "backoff_ms": 500},
		// A serial tool: its duration is real occupied time.
		{"kind": "tool_result", "duration_ms": 300},
		// A parallel batch: per-call durations overlap, so the batch's wall time is
		// what the turn actually spent, and the difference is the saving.
		{"kind": "tool_result", "duration_ms": 400, "parallel": true},
		{"kind": "tool_result", "duration_ms": 600, "parallel": true},
		{"kind": "tool_batch", "wall_ms": 700},
		// A question: the handler blocked on a person, and that stretch is inside the
		// tool's own duration_ms.
		{"kind": "tool_result", "duration_ms": 5000, "human_wait_ms": 4900},
		{"kind": "permission", "waited_ms": 120},
		{"kind": "run_finished", "duration_ms": 9000},
	}

	timing := SummarizeTime(events)

	if timing.ModelMs != 1500 {
		t.Errorf("model ms = %d, want 1500", timing.ModelMs)
	}
	// Serial tool durations (300, plus the 5000 of the question) plus the batch's
	// wall time, minus the 4900 a person spent typing an answer. That last stretch
	// sits inside `ask_user`'s own duration_ms, and leaving it in would report "I
	// read the question for five seconds" as "this tool takes five seconds".
	if timing.ToolMs != 1100 {
		t.Errorf("tool ms = %d, want 1100", timing.ToolMs)
	}
	if timing.HumanMs != 4900 {
		t.Errorf("human ms = %d, want 4900", timing.HumanMs)
	}
	if timing.WaitedMs != 120 {
		t.Errorf("approval wait ms = %d, want 120", timing.WaitedMs)
	}
	if timing.BackoffMs != 500 {
		t.Errorf("backoff ms = %d, want 500", timing.BackoffMs)
	}
	if timing.SavedMs != 300 {
		t.Errorf("saved ms = %d, want 300 (1000 of tool time in 700 of wall time)", timing.SavedMs)
	}
	if timing.RunMs != 9000 {
		t.Errorf("run ms = %d, want 9000", timing.RunMs)
	}

	// The identity: measured parts plus whatever nobody instrumented equals the
	// turn, and the human's time is added back rather than counted twice.
	if got, want := timing.ExplainedMs(), 1500+1100+120+500+4900; got != want {
		t.Errorf("explained = %d, want %d", got, want)
	}
	if got, want := timing.UnattributedMs(), 9000-8120; got != want {
		t.Errorf("unattributed = %d, want %d", got, want)
	}
}

// TestUnattributedIsNeverNegative: millisecond rounding and a log copied from
// somewhere else can both push it below zero, and a negative number there has no
// explanation worth reading.
func TestUnattributedIsNeverNegative(t *testing.T) {
	timing := Timing{RunMs: 100, ModelMs: 500}
	if got := timing.UnattributedMs(); got != 0 {
		t.Errorf("unattributed = %d, want 0", got)
	}
}

// TestAnOldLogWithNoDurationsPrintsNoTimingLine: a line of zeros is noise dressed
// as a report, so nothing measured means nothing printed.
func TestAnOldLogWithNoDurationsPrintsNoTimingLine(t *testing.T) {
	if line := timingLine(SummarizeTime([]map[string]any{{"kind": "run_started"}})); line != "" {
		t.Errorf("a log with no durations produced a timing line: %q", line)
	}
}

// TestTheSummaryCarriesWhatTheCommandIsFor pins the four things somebody reads
// `--audit` for: what it cost, how the tool calls ended, where the time went, and
// why the turn stopped.
func TestTheSummaryCarriesWhatTheCommandIsFor(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "status": "ok", "prompt_tokens": 1000, "cached_tokens": 400,
			"miss_tokens": 600, "completion_tokens": 50, "duration_ms": 2000},
		{"kind": "model_call", "status": "error"},
		{"kind": "tool_result", "status": "ok", "duration_ms": 10},
		{"kind": "tool_result", "status": "denied", "duration_ms": 0},
		{"kind": "tool_result", "status": "invalid_args", "duration_ms": 0},
		{"kind": "run_finished", "duration_ms": 2500, "stop_reason": "answered"},
	}

	text := Summarize(events)
	for _, want := range []string{
		"2 (1 succeeded)", // model calls, and how many worked
		"1000 tokens",     // input
		"40%",             // cache hit rate
		"50 tokens",       // output
		"25.0 tok/s",      // 50 completion tokens in the successful call's 2s
		"denied=1",        // tool outcomes, refusals included
		"invalid_args=1",  // the number answers "how much work", not "how much worked"
		"Time",            // the timing line
		"turn total",      // the turn duration
		"answered",        // why the turn ended
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the summary is missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "$") {
		t.Errorf("the summary reports money; it may only report tokens:\n%s", text)
	}
}

// TestTheOutputRateIsAnEmDashWhenNothingWasMeasured — the report has a slot for the
// figure, so "not measured" is a fact it states rather than a column it drops.
// `0.0 tok/s` would read as a measurement of zero, and the failed call in this log
// is the case that reaches here: it carries no completion tokens at all.
func TestTheOutputRateIsAnEmDashWhenNothingWasMeasured(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "status": "error", "duration_ms": 900},
		{"kind": "model_call", "status": "ok", "prompt_tokens": 800, "completion_tokens": 0,
			"duration_ms": 1200},
	}
	text := Summarize(events)
	if !strings.Contains(text, "avg — tok/s") {
		t.Errorf("an unmeasurable rate is not stated as such:\n%s", text)
	}
	if strings.Contains(text, "0.0 tok/s") {
		t.Errorf("the summary claims a measured zero rate:\n%s", text)
	}
}

// TestOneRecordIsOneCappedLine: a log is read by scanning many lines at once, so a
// record that wraps over two lines makes a hundred-line turn unreadable.
func TestOneRecordIsOneCappedLine(t *testing.T) {
	record := map[string]any{
		"kind": "tool_call", "ts": "2026-09-17T21:36:29.123456+08:00", "step": 3,
		"tool": "shell", "arguments": strings.Repeat("x", 500),
	}
	line := FormatLine(record)
	if strings.Contains(line, "\n") {
		t.Errorf("one record rendered as more than one line:\n%s", line)
	}
	if !strings.HasPrefix(line, "21:36:29.123456") {
		t.Errorf("the timestamp is not time-only: %q", line)
	}
	if !strings.Contains(line, "step=3") {
		t.Errorf("the step is missing: %q", line)
	}
	if len([]rune(line)) > 200 {
		t.Errorf("the line was not capped: %d runes", len([]rune(line)))
	}
}

// TestADamagedRecordStillPrints: a log can be copied, spliced or hand-edited, and a
// viewer that crashes on a bad line is worse than useless — the bad line is exactly
// the one somebody is looking for.
func TestADamagedRecordStillPrints(t *testing.T) {
	line := FormatLine(map[string]any{"step": 1})
	if !strings.Contains(line, "?") {
		t.Errorf("a record with no kind or timestamp did not print placeholders: %q", line)
	}
	if line == "" {
		t.Error("a damaged record produced no line at all")
	}
}
