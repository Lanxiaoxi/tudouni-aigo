package runtime

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// EffortProbe is the answer to one probed level.
//
// Result carries the model package's own spelling ("ok", "rejected",
// "uncertain") rather than a translation: the front end draws one column per
// result, and a second copy of the three words would be a second place they
// could stop agreeing.
type EffortProbe struct {
	Level string
	// Result is "ok", "rejected" or "uncertain".
	Result string
	// Note is the endpoint's own sentence when the result is uncertain — the
	// one thing that tells an upstream error from a timeout. Empty for the
	// two verdicts that need no explanation.
	Note string
}

// probeEffortAdapter is what the runtime's chat adapter must be able to do
// for a probe to run at all.
//
// A narrow interface asserted here rather than a method on protocol.Runtime,
// for the reason GoalCommander keeps: the probe is one front end's feature,
// and the two other front ends (CLI, TUI) must not be refused a session
// because their runtime never answered one. The protocol layer reports a
// runtime without the method as "not supported" rather than as an empty
// probe that refused every level.
type probeEffortAdapter interface {
	ProbeEffort(level string) (model.ProbeOutcome, error)
}

// ProbeEffort asks the endpoint, level by level, which of the current model's
// offered levels it takes.
//
// The levels are the model's own list (`managedLevels`), so the probe never
// asks about a level the menu would not offer — the configuration the front
// end writes afterwards contains only words the runtime will accept. The asks
// are serial, not parallel: six at once would land on a rate limit, and a 429
// in the middle of a probe reads as "uncertain" rather than as the level's
// answer.
//
// The session's thinking switch is deliberately not touched. Each probe
// request says thinking on in its own body — a level the endpoint takes only
// while thinking is not a level — and leaving the session's knob as it was is
// what keeps the panel and the session in agreement afterwards.
func (r *Runtime) ProbeEffort() (map[string]any, error) {
	prober, ok := r.Chat.(probeEffortAdapter)
	if !ok {
		return nil, errorf("this runtime cannot probe effort levels")
	}

	modelID, provider := r.ModelState.Selected(), r.ModelState.SelectedProvider()

	levels := r.managedLevels()
	rows := make([]map[string]any, 0, len(levels))
	for _, level := range levels {
		result, err := prober.ProbeEffort(level)
		row := map[string]any{"level": level, "result": string(result)}
		if err != nil && result != model.ProbeRejected {
			// The ask never reached an answer: the result is uncertain and the
			// sentence is what says why. `rejected` carries no error, so this
			// branch cannot touch it.
			row["note"] = err.Error()
		}
		rows = append(rows, row)
	}

	return map[string]any{
		"model":    modelID,
		"provider": provider,
		"levels":   rows,
	}, nil
}
