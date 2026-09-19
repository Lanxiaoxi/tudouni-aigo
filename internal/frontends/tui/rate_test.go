package tui

import (
	"strings"
	"testing"

	"github.com/mattn/go-runewidth"
)

// The output rate on the status bar.
//
// The figure is the **last successful model call's** completion tokens over that
// same call's duration — the four numbers the bar draws (prompt size, cached part,
// answer size, duration) all come from one `model_call` event, so the segments
// beside each other are describing the same thing. The session-wide average is a
// different figure with a different question behind it, and it lives in `/status`
// and `--audit`.

// TestTheBarShowsTheLastCallsRate is the happy path, and it pins the arithmetic:
// 190 tokens in 5s is 38 tok/s.
func TestTheBarShowsTheLastCallsRate(t *testing.T) {
	withColour(t)
	m := filledModel(160, 40)
	m.panel.promptTokens = intPtr(12400)
	m.panel.cachedTokens = intPtr(10900)
	m.panel.completionTokens = intPtr(190)
	m.panel.modelMs = intPtr(5000)

	right := visible(m.statusRight(false))
	if !strings.Contains(right, "avg 38.0 tok/s") {
		t.Fatalf("the rate is missing from the bar: %q", right)
	}
	// It sits with the figures it belongs to, not appended after the audit path —
	// the tail is what `spreadStyled` cuts first.
	if strings.Index(right, "tok/s") > strings.Index(right, "audit") {
		t.Errorf("the rate was appended after the audit path, so a narrow bar loses it: %q", right)
	}
}

// TestTheRateIsOmittedRatherThanDrawnAsADash is the one rule that keeps this
// segment from becoming permanent furniture.
//
// A step that only asked for tools reports no completion tokens, and a session
// whose steps are all tool calls would otherwise carry `avg — tok/s` on every line
// it ever draws — a standing statement about a measurement nobody was waiting for.
// The report (`--audit`, `/status`) keeps the em dash because it has a slot to fill;
// the bar leaves the segment out.
func TestTheRateIsOmittedRatherThanDrawnAsADash(t *testing.T) {
	withColour(t)
	cases := []struct {
		name       string
		completion *int
		modelMs    *int
	}{
		{"no call yet", nil, nil},
		{"a tool-only step", intPtr(0), intPtr(5000)},
		{"a duration that was not recorded", intPtr(190), nil},
		{"neither half arrived", intPtr(0), intPtr(0)},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			m := filledModel(160, 40)
			m.panel.promptTokens = intPtr(12400)
			m.panel.cachedTokens = intPtr(10900)
			m.panel.completionTokens = testCase.completion
			m.panel.modelMs = testCase.modelMs

			right := visible(m.statusRight(false))
			if strings.Contains(right, "tok/s") {
				t.Fatalf("the bar claims a rate it never measured: %q", right)
			}
			// The other segments survive: dropping the rate must not take the
			// context figure with it.
			if !strings.Contains(right, "context 12.4k") {
				t.Errorf("the rate's absence took the context figure with it: %q", right)
			}
		})
	}
}

// TestANarrowBarDropsTheRateAndKeepsTheCacheHit: on a narrow terminal the cache
// figure is the one that changes the bill, and the rate is the newcomer. Deciding
// this explicitly is the point — leaving it to `spreadStyled`'s tail cut would mean
// the segment vanished without anybody choosing it.
func TestANarrowBarDropsTheRateAndKeepsTheCacheHit(t *testing.T) {
	withColour(t)
	m := filledModel(100, 30)
	m.panel.promptTokens = intPtr(12400)
	m.panel.cachedTokens = intPtr(10900)
	m.panel.completionTokens = intPtr(190)
	m.panel.modelMs = intPtr(5000)

	right := visible(m.statusRight(true))
	if strings.Contains(right, "tok/s") {
		t.Errorf("the narrow bar kept the rate: %q", right)
	}
	if !strings.Contains(right, "cache hit 88%") {
		t.Errorf("the narrow bar lost the cache hit: %q", right)
	}
}

// TestTheRateComesFromOneCallNotTwo is the invariant the four fields have to hold
// together: they describe **one** call, never a mixture.
func TestTheRateComesFromOneCallNotTwo(t *testing.T) {
	m := filledModel(160, 40)
	m.busy = true
	m.beginTurn(map[string]any{"run_id": "r1"})

	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "ok", "run_id": "r1",
		"prompt_tokens": 12400, "cached_tokens": 10900,
		"completion_tokens": 190, "duration_ms": 5000,
	})
	if got := visible(m.statusRight(false)); !strings.Contains(got, "38.0 tok/s") {
		t.Fatalf("the first step's rate is missing: %q", got)
	}

	// The next successful call restates all four, and the bar follows it whole.
	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "ok", "run_id": "r1",
		"prompt_tokens": 20000, "cached_tokens": 20000,
		"completion_tokens": 40, "duration_ms": 1000,
	})
	got := visible(m.statusRight(false))
	if !strings.Contains(got, "40.0 tok/s") {
		t.Fatalf("the bar did not follow the second call: %q", got)
	}
	if strings.Contains(got, "38.0") {
		t.Fatalf("the bar mixed the two calls' figures: %q", got)
	}
}

// TestAFailedAttemptLeavesTheLastGoodMeasurementStanding — a retry attempt carries
// no usage block, and it must not blank the bar.
//
// This is the same rule `promptTokens` and `cachedTokens` already follow, and the
// rate's two halves ride with them precisely so the four cannot disagree: all four
// are "the last **successful** call", so a backoff between two attempts leaves the
// previous figures up rather than replacing a real measurement with nothing.
func TestAFailedAttemptLeavesTheLastGoodMeasurementStanding(t *testing.T) {
	m := filledModel(160, 40)
	m.busy = true
	m.beginTurn(map[string]any{"run_id": "r1"})

	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "ok", "run_id": "r1",
		"prompt_tokens": 12400, "cached_tokens": 10900,
		"completion_tokens": 190, "duration_ms": 5000,
	})
	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "error", "run_id": "r1",
		"attempt": 1, "backoff_ms": 500,
	})

	got := visible(m.statusRight(false))
	if !strings.Contains(got, "38.0 tok/s") {
		t.Errorf("a failed retry blanked a real measurement: %q", got)
	}
	if !strings.Contains(got, "cache hit 88%") {
		t.Errorf("the cache figure did not survive the retry either: %q", got)
	}
}

// TestASuccessfulCallMissingAFieldClearsThatHalf is the rule that makes the
// "one call" invariant hold by construction.
//
// Each of the two fields is written **per successful call**, to a value or to nil.
// A call that omits one therefore clears it, and since a rate needs both, the pair
// on the bar is either from a single call or absent — the dangerous shape, a stale
// token count over this call's fresh duration, cannot be built.
//
// The case is real rather than hypothetical: a gateway that refuses
// `stream_options` reports no usage at all on a streamed call, and the previous
// step's figures must not be recycled into a plausible-looking rate.
func TestASuccessfulCallMissingAFieldClearsThatHalf(t *testing.T) {
	m := filledModel(160, 40)
	m.busy = true
	m.beginTurn(map[string]any{"run_id": "r1"})

	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "ok", "run_id": "r1",
		"prompt_tokens": 12400, "cached_tokens": 10900,
		"completion_tokens": 190, "duration_ms": 5000,
	})
	// Succeeded, and reports a duration but no usage block — which is what a
	// gateway that dropped `stream_options` produces.
	m.handleEvent(map[string]any{
		"kind": "model_call", "status": "ok", "run_id": "r1",
		"prompt_tokens": 13000, "duration_ms": 4000,
	})

	if m.panel.completionTokens != nil {
		t.Fatalf("the previous call's token count was left standing: %d",
			*m.panel.completionTokens)
	}
	if got := visible(m.statusRight(false)); strings.Contains(got, "tok/s") {
		t.Fatalf("the bar invented a rate across two calls: %q", got)
	}
}

// TestThePairIsNeverAssembledFromTwoCalls is the same invariant asserted on the
// property rather than on one ordering of the events: whichever half a successful
// call omits, the pair on the bar is never half-stale.
func TestThePairIsNeverAssembledFromTwoCalls(t *testing.T) {
	// Each entry is one successful call's payload after the first, which always
	// supplies both halves.
	secondCalls := []map[string]any{
		{"completion_tokens": 100, "duration_ms": 2000},
		{"completion_tokens": 100},
		{"duration_ms": 2000},
		{},
	}
	for _, second := range secondCalls {
		m := filledModel(160, 40)
		m.busy = true
		m.beginTurn(map[string]any{"run_id": "r1"})
		m.handleEvent(map[string]any{
			"kind": "model_call", "status": "ok", "run_id": "r1",
			"prompt_tokens": 12400, "completion_tokens": 190, "duration_ms": 5000,
		})

		payload := map[string]any{"kind": "model_call", "status": "ok", "run_id": "r1",
			"prompt_tokens": 13000}
		for key, value := range second {
			payload[key] = value
		}
		m.handleEvent(payload)

		// A rate may be drawn only when both halves came from this second call.
		_, hasTokens := second["completion_tokens"]
		_, hasSpan := second["duration_ms"]
		drawn := strings.Contains(visible(m.statusRight(false)), "tok/s")
		if drawn != (hasTokens && hasSpan) {
			t.Fatalf("second call %v: rate drawn = %v, want %v (the pair must come from one call)",
				second, drawn, hasTokens && hasSpan)
		}
	}
}

// TestThePerStepLineCarriesTheRate: the transcript's model line is where one step
// can be compared with the next, which is the question "was that step slow".
func TestThePerStepLineCarriesTheRate(t *testing.T) {
	line := modelLine(map[string]any{
		"duration_ms": 5000, "prompt_tokens": 12400,
		"cached_tokens": 10900, "completion_tokens": 190,
	})
	text := line.plain()
	if !strings.Contains(text, "38.0 tok/s") {
		t.Fatalf("the step line lost its rate: %q", text)
	}
	if !strings.Contains(text, "cache hit") {
		t.Fatalf("the step line lost its cache figure: %q", text)
	}
}

// TestTheStepLineOmitsAnUnmeasurableRate — same rule as the bar, for the same
// reason: a tool-only step is the common case in a long turn.
func TestTheStepLineOmitsAnUnmeasurableRate(t *testing.T) {
	cases := []map[string]any{
		{"duration_ms": 5000, "prompt_tokens": 12400, "cached_tokens": 10900},
		{"duration_ms": 5000, "prompt_tokens": 12400, "completion_tokens": 0},
		{"prompt_tokens": 12400, "completion_tokens": 190},
	}
	for _, payload := range cases {
		if text := modelLine(payload).plain(); strings.Contains(text, "tok/s") {
			t.Errorf("the step line invented a rate from %v: %q", payload, text)
		}
	}
}

// TestTheBarStillFitsWithTheExtraSegment is the layout regression this change can
// cause.
//
// The right-hand half of the status bar is clipped from its tail when it does not
// fit, so a segment added anywhere but the end widens what has to fit. The bar must
// stay exactly the terminal's width at every size — one cell over and the terminal
// wraps the row, which pushes the input box down and shows the bar twice.
func TestTheBarStillFitsWithTheExtraSegment(t *testing.T) {
	withColour(t)
	for _, width := range []int{80, 100, 119, 120, 160, 200} {
		m := filledModel(width, 30)
		m.panel.promptTokens = intPtr(12400)
		m.panel.cachedTokens = intPtr(10900)
		m.panel.completionTokens = intPtr(190)
		m.panel.modelMs = intPtr(5000)

		row := m.renderStatusBar()
		if got := runewidth.StringWidth(stripANSI(row)); got != width {
			t.Errorf("width %d: the status bar is %d cells wide: %q", width, got, stripANSI(row))
		}
		// The left half is the sentence that survives a narrow bar: "auto off"
		// must not be the segment that gets dropped in favour of a figure.
		if plain := stripANSI(row); !strings.Contains(plain, "auto") {
			t.Errorf("width %d: the left half was clipped away: %q", width, plain)
		}
	}
}

// TestTheRateSitsBeforeTheTailSegments is the ordering rule that decides what
// survives a clip.
//
// `spreadStyled` cuts the right half at its **tail**, and the documented priority is
// "the first segments are what a glance needs; the audit path and this turn's clock
// have other outlets". So a segment added to the bar has to be inserted where it
// belongs in that order rather than appended — appending it would make the rate the
// first thing dropped, which is the opposite of the intent.
func TestTheRateSitsBeforeTheTailSegments(t *testing.T) {
	m := filledModel(160, 40)
	m.panel.promptTokens = intPtr(12400)
	m.panel.cachedTokens = intPtr(10900)
	m.panel.completionTokens = intPtr(190)
	m.panel.modelMs = intPtr(5000)

	right := visible(m.statusRight(false))
	rate := strings.Index(right, "tok/s")
	if rate < 0 {
		t.Fatalf("the rate is missing: %q", right)
	}
	for _, later := range []string{"this turn", "audit"} {
		if at := strings.Index(right, later); at >= 0 && at < rate {
			t.Errorf("%q precedes the rate, so the rate would be cut before it: %q", later, right)
		}
	}
	// And it follows the two figures it is read against.
	if at := strings.Index(right, "cache hit"); at < 0 || at > rate {
		t.Errorf("the rate does not follow the cache figure: %q", right)
	}
}

// TestTheWideBarDrawsAllFiveSegments is the plain case: with room, nothing is
// dropped. It is also the assertion that would catch a segment silently going
// missing from the wide form.
func TestTheWideBarDrawsAllFiveSegments(t *testing.T) {
	withColour(t)
	m := filledModel(200, 40)
	m.panel.jobs = nil
	m.panel.promptTokens = intPtr(12400)
	m.panel.cachedTokens = intPtr(10900)
	m.panel.completionTokens = intPtr(190)
	m.panel.modelMs = intPtr(5000)

	plain := stripANSI(m.renderStatusBar())
	for _, want := range []string{
		"context 12.4k", "cache hit 88%", "avg 38.0 tok/s", "this turn", "audit",
	} {
		if !strings.Contains(plain, want) {
			t.Errorf("the wide bar lost %q: %q", want, plain)
		}
	}
}

// intPtr is a small helper for the tests above: the panel's fields are pointers
// because "no measurement" and "a measurement of zero" are different facts.
func intPtr(value int) *int { return &value }
