package state

import "testing"

// ── OutputRate ────────────────────────────────────────────────────────────────

// TestTheOutputRateIsTokensOverTheWholeCall pins the arithmetic and the one
// decision behind it: the denominator is the call's own `duration_ms`, which
// includes the prompt being processed, so the figure is an average rather than the
// decode rate.
func TestTheOutputRateIsTokensOverTheWholeCall(t *testing.T) {
	cases := []struct {
		completion int
		modelMs    int
		want       string
	}{
		{190, 5000, "38.0"},
		{190, 1000, "190"},   // past a hundred the decimal is noise
		{100, 1000, "100"},   // exactly at the boundary keeps the integer form
		{99, 1000, "99.0"},   // one below it keeps the decimal
		{1, 100_000, "0.0"},  // slow enough to round to zero — still a measurement
		{5000, 1000, "5000"}, // a fast endpoint is not capped
	}
	for _, testCase := range cases {
		got, ok := OutputRateText(testCase.completion, testCase.modelMs)
		if !ok {
			t.Errorf("OutputRateText(%d, %d) reported no measurement", testCase.completion, testCase.modelMs)
			continue
		}
		if got != testCase.want {
			t.Errorf("OutputRateText(%d, %d) = %q, want %q",
				testCase.completion, testCase.modelMs, got, testCase.want)
		}
	}
}

// TestNoMeasurementIsNotZero is the rule the whole ledger follows: `0.0 tok/s`
// would read as "this endpoint produced nothing per second", which is a claim
// nobody measured. Three cases reach here and all three mean "not measured".
func TestNoMeasurementIsNotZero(t *testing.T) {
	cases := []struct {
		name       string
		completion int
		modelMs    int
	}{
		{"a call that produced no output", 0, 5000},
		{"a call whose duration was not recorded", 190, 0},
		{"a log copied from elsewhere", 0, 0},
		{"a negative count from a spliced log", -5, 5000},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			text, ok := OutputRateText(testCase.completion, testCase.modelMs)
			if ok || text != "" {
				t.Fatalf("OutputRateText(%d, %d) = %q, %v; want no measurement",
					testCase.completion, testCase.modelMs, text, ok)
			}
			// The reporting form fills its slot with the em dash rather than
			// leaving it blank: a ledger states "not measured".
			if got := OutputRate(testCase.completion, testCase.modelMs); got != "—" {
				t.Fatalf("OutputRate = %q, want an em dash", got)
			}
		})
	}
}

// ── the ledger the rate is computed from ──────────────────────────────────────

// TestTheRateDenominatorCountsOnlyTheSuccessfulCalls is the reason `model_ms` is
// accumulated beside the token totals rather than taken from the audit report's
// own timing line.
//
// That line totals **every** `model_call`, including the failed attempts of a
// retry. Those attempts have no `completion_tokens`, so dividing one by the other
// would report a rate dragged down by calls that produced nothing — a number that
// looks like a slow endpoint and is really a flaky one.
func TestTheRateDenominatorCountsOnlyTheSuccessfulCalls(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "status": "error", "duration_ms": 3000, "attempt": 1},
		{"kind": "model_call", "status": "ok", "prompt_tokens": 1000, "cached_tokens": 400,
			"miss_tokens": 600, "completion_tokens": 190, "duration_ms": 5000},
		{"kind": "model_call", "status": "fatal", "duration_ms": 7000},
		{"kind": "model_call", "status": "ok", "prompt_tokens": 2000, "completion_tokens": 0,
			"duration_ms": 1000},
	}
	usage, _ := Summarize(events)["usage"].(map[string]any)

	if got := numberOfField(usage, "model_ms"); got != 6000 {
		t.Fatalf("model_ms = %d, want 6000 (the two successful calls only)", got)
	}
	if got := numberOfField(usage, "completion"); got != 190 {
		t.Fatalf("completion = %d, want 190", got)
	}
	// 190 tokens in 6s, not in 16s.
	if got := OutputRate(numberOfField(usage, "completion"), numberOfField(usage, "model_ms")); got != "31.7" {
		t.Fatalf("rate = %q, want 31.7", got)
	}
}

// TestTheRateSurvivesAJSONRoundTrip: the audit log is read back from disk, so
// every number arrives as a float64 rather than an int. A type assertion that only
// accepted one of the two would report no measurement for every restored session —
// silently, because an em dash is a legal answer.
func TestTheRateSurvivesAJSONRoundTrip(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "status": "ok", "prompt_tokens": float64(1000),
			"completion_tokens": float64(190), "duration_ms": float64(5000)},
	}
	usage, _ := Summarize(events)["usage"].(map[string]any)
	if got := numberOfField(usage, "model_ms"); got != 5000 {
		t.Fatalf("model_ms = %d after a JSON round trip, want 5000", got)
	}
	if got := OutputRate(numberOfField(usage, "completion"), numberOfField(usage, "model_ms")); got != "38.0" {
		t.Fatalf("rate = %q, want 38.0", got)
	}
}

// TestALogWithNoDurationsStillSummarizes: a session recorded before this field
// existed, or one whose log was spliced, must not break the ledger — the same rule
// every other missing field follows.
func TestALogWithNoDurationsStillSummarizes(t *testing.T) {
	events := []map[string]any{
		{"kind": "model_call", "status": "ok", "prompt_tokens": 1000, "completion_tokens": 50},
		{"kind": "run_started"},
	}
	summary := Summarize(events)
	usage, _ := summary["usage"].(map[string]any)
	if usage == nil {
		t.Fatal("the summary lost its usage block")
	}
	if got := OutputRate(numberOfField(usage, "completion"), numberOfField(usage, "model_ms")); got != "—" {
		t.Fatalf("rate = %q, want an em dash", got)
	}
}

// numberOfField reads a numeric field out of a summary map, with the assertion
// failing loudly rather than reading zero — a test that silently compared zero
// against zero would pass on an empty block.
func numberOfField(row map[string]any, key string) int {
	value, present := row[key]
	if !present {
		return 0
	}
	return numberFieldOf(map[string]any{key: value}, key)
}
