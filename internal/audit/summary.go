package audit

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// Timing is how the wall time of a session was spent.
//
// Every field is summed from the audit events rather than tracked as the session
// runs. Keeping a second running total would be faster and would be a second source
// for the same fact — and it would drift in a way nobody can detect: the report says
// 12s of tool time, the log adds up to 19s, and both look normal.
type Timing struct {
	RunMs     int
	ModelMs   int
	ToolMs    int
	WaitedMs  int
	HumanMs   int
	BackoffMs int
	SavedMs   int
}

// ExplainedMs is the part of the turn that was measured.
//
// HumanMs is added back rather than counted twice: it has already been **subtracted**
// out of ToolMs (see SummarizeTime), so leaving it out of this identity would drop
// the time a person spent typing an answer into "unattributed" — a bucket whose name
// means "not instrumented", while this stretch is instrumented.
func (t Timing) ExplainedMs() int {
	return t.ModelMs + t.ToolMs + t.WaitedMs + t.BackoffMs + t.HumanMs
}

// UnattributedMs is the part of the turn nothing measured: writing the session,
// appending audit records, parsing and deciding policy.
//
// Floored at zero, because millisecond rounding and a log copied from elsewhere can
// both push it negative and a negative number here has no explanation worth reading.
// It is not padding either: it is whatever is left, and saying so beats letting the
// listed parts look like the whole.
func (t Timing) UnattributedMs() int {
	if value := t.RunMs - t.ExplainedMs(); value > 0 {
		return value
	}
	return 0
}

// SummarizeTime adds the durations up out of the events.
//
// It is deliberately the same shape as `state.Summarize`: no separate timer state
// exists, because two records of one fact eventually disagree.
func SummarizeTime(events []map[string]any) Timing {
	total := func(kind, field string) int {
		sum := 0
		for _, event := range events {
			if stringOf(event["kind"]) == kind {
				sum += numberOf(event[field])
			}
		}
		return sum
	}
	toolDurations := func(parallel bool) int {
		sum := 0
		for _, event := range events {
			if stringOf(event["kind"]) != "tool_result" {
				continue
			}
			if truthyOf(event["parallel"]) != parallel {
				continue
			}
			sum += numberOf(event["duration_ms"])
		}
		return sum
	}

	// A parallel batch's per-call durations overlap, so their sum is "how long each
	// tool took" while the batch's wall time is "how long the batch occupied the
	// turn". An older log has no `tool_batch` events at all, both terms are zero, and
	// the tool figure falls back to the plain sum — no old number changes.
	batchSum := toolDurations(true)
	batchWall := total("tool_batch", "wall_ms")

	// Time a person spent answering a question is **taken out of** the tool time:
	// `ask_user`'s handler blocks on the human, so without this subtraction "I read
	// the question for 30 seconds" is reported as "this tool takes 30 seconds".
	humanMs := total("tool_result", "human_wait_ms")
	toolMs := toolDurations(false) + batchWall - humanMs
	if toolMs < 0 {
		toolMs = 0
	}

	return Timing{
		RunMs:     total("run_finished", "duration_ms"),
		ModelMs:   total("model_call", "duration_ms"),
		ToolMs:    toolMs,
		WaitedMs:  total("permission", "waited_ms"),
		HumanMs:   humanMs,
		BackoffMs: total("model_call", "backoff_ms"),
		SavedMs:   batchSum - batchWall,
	}
}

// Summarize renders the block that closes `--audit`.
//
// **Tokens, never money.** Prices change and they differ by time of day, so writing
// one into the output would freeze something that moves; whoever wants the cost can
// multiply by the price list of the day.
func Summarize(events []map[string]any) string {
	summary := state.Summarize(events)
	counters, _ := summary["counters"].(map[string]any)
	usage, _ := summary["usage"].(map[string]any)

	// Tool outcomes by status. A refused call is counted here like any other: the
	// number answers "how much work happened", not "how much succeeded".
	byStatus := map[string]int{}
	results := 0
	for _, event := range events {
		if stringOf(event["kind"]) != "tool_result" {
			continue
		}
		results++
		status := stringOf(event["status"])
		if status == "" {
			status = "?"
		}
		byStatus[status]++
	}

	prompt := numberOf(usage["prompt"])
	cached := numberOf(usage["cached"])
	completion := numberOf(usage["completion"])
	// The rate's denominator is the successful calls' own wall time, which
	// `state.Summarize` accumulates beside the token totals so that one number
	// cannot describe a different set of calls than the other. It is an em dash
	// when there is nothing to divide — a report has a slot for the figure, and
	// "not measured" is a fact it has to state.
	rate := state.OutputRate(completion, numberOf(usage["model_ms"]))

	var builder strings.Builder
	builder.WriteString(strings.Repeat("-", 78) + "\n")
	builder.WriteString(i18n.T("audit.summary.model",
		"calls", numberOf(counters["model_calls"]),
		"ok", numberOf(counters["model_ok"]),
		"prompt", prompt,
		"cached", cached,
		"miss", numberOf(usage["miss"]),
		"hit_rate", state.HitRate(prompt, cached),
		"completion", completion,
		"rate", rate) + "\n")

	if len(byStatus) == 0 {
		builder.WriteString(i18n.T("audit.summary.tools_none", "calls", results) + "\n")
	} else {
		statuses := make([]string, 0, len(byStatus))
		for status := range byStatus {
			statuses = append(statuses, status)
		}
		sort.Strings(statuses)
		parts := make([]string, 0, len(statuses))
		for _, status := range statuses {
			parts = append(parts, fmt.Sprintf("%s=%d", status, byStatus[status]))
		}
		builder.WriteString(i18n.T("audit.summary.tools",
			"calls", results, "statuses", strings.Join(parts, "  ")) + "\n")
	}

	if line := timingLine(SummarizeTime(events)); line != "" {
		builder.WriteString(line + "\n")
	}

	var stops []string
	for _, event := range events {
		if stringOf(event["kind"]) != "run_finished" {
			continue
		}
		if reason := stringOf(event["stop_reason"]); reason != "" {
			stops = append(stops, reason)
		}
	}
	if len(stops) > 0 {
		builder.WriteString(i18n.T("audit.summary.stops", "reasons", strings.Join(stops, "  ")) + "\n")
	}

	builder.WriteString(i18n.T("audit.summary.cost_tip"))
	return builder.String()
}

// timingLine renders the one duration line.
//
// Nothing measured means nothing printed: an old log with no duration fields would
// otherwise get a line of zeros, and a line of zeros is noise dressed as a report.
func timingLine(timing Timing) string {
	if timing.ModelMs == 0 && timing.ToolMs == 0 && timing.WaitedMs == 0 && timing.HumanMs == 0 {
		return ""
	}
	parts := []string{
		i18n.T("audit.timing.model", "value", msText(timing.ModelMs)),
		i18n.T("audit.timing.tool", "value", msText(timing.ToolMs)),
	}
	// The saving is listed separately: it is not part of the tool figure (that one
	// reports real wall time) and it is not added into the turn total either — it is
	// exactly the stretch that was saved and therefore never happened.
	if timing.SavedMs > 0 {
		parts = append(parts, i18n.T("audit.timing.saved", "value", msText(timing.SavedMs)))
	}
	// Things that did not happen get no slot: nobody was asked and nobody was
	// questioned, so those two entries would be 0ms of noise.
	if timing.WaitedMs > 0 {
		parts = append(parts, i18n.T("audit.timing.approval", "value", msText(timing.WaitedMs)))
	}
	if timing.HumanMs > 0 {
		parts = append(parts, i18n.T("audit.timing.human", "value", msText(timing.HumanMs)))
	}
	if timing.BackoffMs > 0 {
		parts = append(parts, i18n.T("audit.timing.backoff", "value", msText(timing.BackoffMs)))
	}
	// The turn total only exists in a log that recorded `run_finished.duration_ms`,
	// so these two appear together or not at all.
	if timing.RunMs > 0 {
		parts = append(parts,
			i18n.T("audit.timing.unattributed", "value", msText(timing.UnattributedMs())),
			i18n.T("audit.timing.run", "value", msText(timing.RunMs)))
	}
	return i18n.T("audit.timing.line", "parts", strings.Join(parts, "  "))
}

// msText is a duration as a person reads it.
func msText(ms int) string {
	switch {
	case ms >= 60_000:
		return fmt.Sprintf("%dm%02ds", ms/60_000, (ms%60_000)/1000)
	case ms >= 1_000:
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	default:
		return fmt.Sprintf("%dms", ms)
	}
}

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

func numberOf(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func truthyOf(value any) bool {
	flag, _ := value.(bool)
	return flag
}
