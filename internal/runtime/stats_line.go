package runtime

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// StatsLine implements protocol.Runtime.
//
// One line, three facts, all of them counted from the audit log rather than tracked
// separately: a running total in memory would be a second source for the same fact,
// and the two would drift in a way nobody can see. It is the same log `--audit`
// reads, so the two reports agree — literally: the sink folds each record into the
// same counters `state.Summarize` uses, at the moment it is read, so the numbers
// here and the ledger's cannot come from two different walks of the file.
//
// It is **deliberately cumulative** for tokens and steps, because that matches
// "how much has this cost", which is what the reader is asking. The one exception is
// the duration, and its label says so: "this turn" is a different question from
// "this session", and mixing the two would make neither answerable.
func (r *Runtime) StatsLine() string {
	var summary map[string]any
	var turnMs int64
	hasTurn := false
	if r.Logs != nil {
		summary, _, _ = r.Logs.Summary(r.SessionIDValue)
		turnMs, hasTurn = r.Logs.LastTurnMs(r.SessionIDValue)
	} else {
		summary = state.Summarize(nil)
	}
	usage, _ := summary["usage"].(map[string]any)
	prompt := intPtr(usage["prompt"])

	var builder strings.Builder
	// No successful model call yet (an auth failure on the first turn, say): there
	// is nothing to report, and a line reading "hit rate —" is noise.
	if prompt != nil && *prompt > 0 {
		cached := intPtr(usage["cached"])
		builder.WriteString(i18n.T("stats.usage",
			"prompt", *prompt,
			"cached", deref(cached),
			"hit_rate", state.HitRate(*prompt, deref(cached))))
	}
	// The output rate rides on the same "at least one successful call" guard rather
	// than on its own: completion tokens with no prompt tokens cannot happen (a
	// response always reports both or neither), and splitting the condition would
	// be two tests for one fact that could disagree.
	//
	// It is stated as a cumulative average over the session — "1874 tokens at an
	// average of 38 tok/s" — because that is the question this line answers: this
	// report is per turn, and the previous turn's total is what a person compares
	// the current one against. The per-step figure lives in the transcript.
	//
	// **The segment is omitted, not filled with a dash, when there is no
	// denominator.** A log recorded before `duration_ms` was summed — or one whose
	// successful calls reported no duration — would otherwise print
	// "avg — tok/s" on every turn for ever, which is a claim about a measurement
	// nobody was waiting for. This is the same rule the status bar's segment
	// follows; `OutputRate`'s em dash is for the reports that have a slot to fill.
	if prompt != nil && *prompt > 0 {
		completion := intPtr(usage["completion"])
		if completion != nil {
			if rate, ok := state.OutputRateText(*completion, deref(intPtr(usage["model_ms"]))); ok {
				builder.WriteString(i18n.T("stats.rate",
					"completion", *completion, "rate", rate))
			}
		}
	}
	if hasTurn {
		builder.WriteString(i18n.T("stats.turn", "value", msText(int(turnMs))))
	}
	// Two facts about the context figure, both stated in the README: it is what the
	// **last request** actually sent, not "now" (the next one adds this turn's answer
	// and tool results, so it is a lower bound), and it includes the cached part —
	// the window question wants the total, the money question wants the miss, and the
	// miss is already on this line as the hit rate.
	if used := intPtr(summary["last_prompt_tokens"]); used != nil {
		if window := intPtr(r.modelWindow()); window != nil && *window > 0 {
			// Above 100% is reported as it is, never clamped: that turn could not
			// go out, and smoothing the only clue makes it read as "just barely fit".
			percent := float64(*used) / float64(*window) * 100
			builder.WriteString(i18n.T("stats.context.ratio",
				"used", state.TokensText(used), "window", state.TokensText(window),
				"percent", fmt.Sprintf("%.1f", percent)))
		} else {
			builder.WriteString(i18n.T("stats.context.used_only", "used", state.TokensText(used)))
		}
	}
	return builder.String()
}

// deref reads a nullable count as a plain number, for the cases where the caller has
// already established that "absent" and "zero" mean the same thing.
func deref(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// ProgressLine implements protocol.Runtime.
func (r *Runtime) ProgressLine() string {
	return builtin.NewTodoBoard(r.meta()).ProgressLine()
}

// JobsProgressLine implements protocol.Runtime: the human's one-line view of the
// background jobs, or "" when there is nothing hanging.
func (r *Runtime) JobsProgressLine() string {
	if r.Jobs == nil {
		return ""
	}
	return r.Jobs.ProgressLine()
}

// GoalLine implements protocol.Runtime: the goal as one line for the transcript,
// or "" when this session has none.
//
// "" for no goal, rather than a line saying there is none: the line terminal
// re-states this after every turn, and a sentence about the absence of a goal is a
// sentence that would appear in every session that never had one. The `/goal`
// command answers the question explicitly for anybody who asks it.
func (r *Runtime) GoalLine() string {
	goal, ok := r.goal()
	if !ok {
		return ""
	}
	line := i18n.T("goal.line",
		"objective", goal.Objective,
		"phase", string(goal.Phase),
		"rounds", goal.RoundsText())
	if !r.GoalArmed() {
		line += i18n.T("goal.line.disarmed")
	}
	return line
}

// msText is a duration as a person reads it. Kept in step with the audit report's
// own rendering: one number shown two ways reads as two numbers.
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
