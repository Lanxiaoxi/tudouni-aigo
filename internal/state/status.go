package state

import (
	"fmt"
	"strconv"
)

// The ledger `/status` reports, counted from the audit events rather than
// tracked separately.
//
// A running total kept in memory would be faster, but it would be a **second
// source for the same fact**, and it would drift in a way nobody can detect:
// the status bar says 120k tokens, the audit log adds up to 130k, and both look
// normal. The cost is stated plainly — every `/status` re-reads that jsonl,
// which for one session is tens to hundreds of lines.
//
// Turns are counted from `run_started`, not `run_finished`: an interrupted turn
// is still a turn that ran, and "how many times did the user press enter" is the
// question this number answers.

// PercentDecimals is the display precision for a context ratio. It is shared
// with the command-line summary: the same number reported to one decimal in one
// place and as an integer in another makes users think one of them is wrong.
const PercentDecimals = 1

// Summarize counts a run of audit events.
//
// Failures inside a retry carry no usage fields, so they contribute zero to the
// token totals. That is not an omission: "how much was spent" only has an answer
// for calls that succeeded. Missing fields count as zero throughout — the log may
// be copied, spliced or truncated, and a missing key must not break `/status`.
func Summarize(events []map[string]any) map[string]any {
	runs, modelCalls, modelOK, toolCalls := 0, 0, 0, 0
	permissionWaits, asks := 0, 0
	prompt, cached, miss, completion := 0, 0, 0, 0
	// modelMs is the wall time of the **successful** calls only, and it is summed
	// here rather than taken from the audit report's own timing line for one
	// reason: that one totals every `model_call` including the failed attempts of
	// a retry, while `completion_tokens` only exists on the calls that returned.
	// Dividing one by the other would report a rate dragged down by attempts that
	// produced no output at all.
	modelMs := 0
	var lastPrompt *int

	for _, item := range events {
		switch stringFieldOf(item, "kind") {
		case "run_started":
			runs++
		case "model_call":
			modelCalls++
			if stringFieldOf(item, "status") == "ok" {
				modelOK++
				prompt += numberFieldOf(item, "prompt_tokens")
				cached += numberFieldOf(item, "cached_tokens")
				miss += numberFieldOf(item, "miss_tokens")
				completion += numberFieldOf(item, "completion_tokens")
				modelMs += numberFieldOf(item, "duration_ms")
				// "How much did the last request actually send" is the input of
				// the last **successful** call. Counting successes rather than
				// the last line matters: a failed attempt has no such field and
				// may be followed by a successful one.
				value := numberFieldOf(item, "prompt_tokens")
				lastPrompt = &value
			}
		case "tool_result":
			toolCalls++
			if stringFieldOf(item, "question_status") != "" {
				asks++
			}
		case "permission":
			// Only a call that actually asked somebody counts as a wait. A
			// verdict is written for **every** call, whether or not anybody was
			// asked, and `waited_ms` is the field that says a person was: the
			// gate sets it only when the question went out. Counting the verdicts
			// instead made the status screen's "of which N approval waits" equal
			// the number of tool calls — a figure that tells nobody anything, and
			// that says people were interrupted N times when they were not.
			if _, asked := item["waited_ms"]; asked {
				permissionWaits++
			}
		}
	}

	result := map[string]any{
		"usage": map[string]any{
			"prompt":     prompt,
			"cached":     cached,
			"miss":       miss,
			"completion": completion,
			// `model_ms` is what the output rate is computed from, and it travels
			// with the usage block because the two are only meaningful together:
			// a token count with no denominator cannot be read as a speed.
			"model_ms": modelMs,
		},
		"counters": map[string]any{
			"runs":             runs,
			"model_calls":      modelCalls,
			"model_ok":         modelOK,
			"tool_calls":       toolCalls,
			"permission_waits": permissionWaits,
			"asks":             asks,
		},
	}
	if lastPrompt != nil {
		result["last_prompt_tokens"] = *lastPrompt
	} else {
		result["last_prompt_tokens"] = nil
	}
	return result
}

// HitRate is the display form of the cache hit rate.
//
// With no input tokens it is an em dash, not 0%. 0% would read as "the cache is
// misconfigured" when in fact no cache lookup has happened yet, and those two
// must be distinguishable.
func HitRate(prompt, cached int) string {
	if prompt == 0 {
		return "—"
	}
	return fmt.Sprintf("%.0f%%", float64(cached)/float64(prompt)*100)
}

// OutputRate is the average output rate, in tokens per second.
//
// Deliberately an average over the **whole call**, not the decode rate: the
// measurement available is `duration_ms` (which includes the prompt being
// processed) divided into `completion_tokens` (which does not count the prompt).
// The honest description is therefore "average", and it is the number that
// answers "is this endpoint slow today" rather than "how fast does this model
// decode once it starts" — the latter would need a first-token timestamp, which
// nothing on this path records.
//
// An em dash, never 0.0, when either half is missing or zero. Three cases reach
// here and all three mean "no measurement": a call that produced no output (a
// tool-only step, or a turn that only thought), a duration that was not recorded,
// and a log copied from elsewhere. `0.0 tok/s` would read as a measurement of
// zero — a claim the ledger cannot make, the same rule HitRate follows.
func OutputRate(completionTokens, modelMs int) string {
	text, ok := OutputRateText(completionTokens, modelMs)
	if !ok {
		return "—"
	}
	return text
}

// OutputRateText is OutputRate with "was there a measurement at all" kept as a
// separate answer.
//
// The two are split because the callers want opposite things from the same
// silence. A **report** — the `--audit` summary, `/status` — has a slot for the
// figure and fills it with an em dash: the reader is looking at a ledger and "not
// measured" is a fact the ledger must state. A **status bar segment** has no slot
// to spare, and "— tok/s" written there forever on a session whose steps all
// called tools would be a permanent claim of failure about nothing. It omits the
// segment instead, which is the same rule modelLine follows for a missing
// `cached_tokens`.
func OutputRateText(completionTokens, modelMs int) (string, bool) {
	if completionTokens <= 0 || modelMs <= 0 {
		return "", false
	}
	rate := float64(completionTokens) / (float64(modelMs) / 1000.0)
	switch {
	// Past a hundred the decimal is noise — the endpoint's speed is not stable to
	// that precision, and one more digit on a status bar costs a column.
	case rate >= 100:
		return fmt.Sprintf("%.0f", rate), true
	default:
		return fmt.Sprintf("%.1f", rate), true
	}
}

// TokensText is the short form of a token count (2.0k / 1M).
//
// Deliberately not imported from the interface code: this is the ledger, that is
// layout. They agree on the shape because three different renderings of one number
// would read as three different numbers.
//
// An integral value in the millions drops the decimal: `1M`, not `1.0M`. The two say
// the same thing, and the second is one character wider on a status bar where every
// column is fought over — while `1.5M` keeps its digit because that one carries
// information.
func TokensText(count *int) string {
	if count == nil {
		return "—"
	}
	value := *count
	switch {
	case value >= 1_000_000:
		millions := float64(value) / 1_000_000
		if millions == float64(int64(millions)) {
			return strconv.FormatInt(int64(millions), 10) + "M"
		}
		return strconv.FormatFloat(millions, 'f', 1, 64) + "M"
	case value >= 1_000:
		thousands := float64(value) / 1_000
		if thousands == float64(int64(thousands)) && value%1_000 == 0 {
			return strconv.FormatInt(int64(thousands), 10) + "k"
		}
		return strconv.FormatFloat(thousands, 'f', 1, 64) + "k"
	default:
		return strconv.Itoa(value)
	}
}

// ContextText renders "how full is the context".
//
// Two facts about the measurement, both stated in the README: it is what the
// **last request** actually sent, not "now" — the next request adds this turn's
// answer and tool results, so the number is a lower bound. And when the window is
// unknown (the model is not in the catalogue) only the usage is reported: a wrong
// percentage is worse than none, because it gets believed. Above 100% it is
// reported as it is, not clamped.
func ContextText(used, window *int) string {
	if used == nil {
		return "—"
	}
	if window == nil || *window == 0 {
		return TokensText(used)
	}
	percent := float64(*used) / float64(*window) * 100
	return fmt.Sprintf("%s / %s（%s%%）",
		TokensText(used), TokensText(window), formatPercent(percent))
}

func formatPercent(value float64) string {
	return strconv.FormatFloat(value, 'f', PercentDecimals, 64)
}

func numberFieldOf(record map[string]any, key string) int {
	switch value := record[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	default:
		return 0
	}
}
