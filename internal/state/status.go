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
			permissionWaits++
		}
	}

	result := map[string]any{
		"usage": map[string]any{
			"prompt":     prompt,
			"cached":     cached,
			"miss":       miss,
			"completion": completion,
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

// TokensText is the short form of a token count (2.0k / 1.0M).
//
// Deliberately not imported from the interface code: this is the ledger, that is
// layout. They agree on the shape because three different renderings of one
// number would read as three different numbers.
func TokensText(count *int) string {
	if count == nil {
		return "—"
	}
	value := *count
	switch {
	case value >= 1_000_000:
		return strconv.FormatFloat(float64(value)/1_000_000, 'f', 1, 64) + "M"
	case value >= 1_000:
		return strconv.FormatFloat(float64(value)/1_000, 'f', 1, 64) + "k"
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
