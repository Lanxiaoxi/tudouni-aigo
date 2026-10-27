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

// levelProbeAdapter is a prober that also knows whether its wire can be asked
// about a level **as a level**.
//
// Optional, like the prober itself: an adapter that does not answer is treated as
// "yes", because a probe that does carry the level is the common case and refusing
// to report it would only hide the fact this interface exists to state.
type levelProbeAdapter interface {
	ProbeCarriesLevel() bool
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
	// A runtime assembled without a model state has no current endpoint to ask
	// and no level list to walk. The production assembly always has one, so this
	// is the stub half of the seam — and it is a returned error rather than a
	// panic because the protocol layer turns an error into the panel's own
	// `problem` sentence.
	if r.ModelState == nil {
		return nil, errorf("this runtime has no model selected, so there is nothing to probe")
	}

	modelID, provider := r.ModelState.Selected(), r.ModelState.SelectedProvider()

	// Whether the wire carries the level at all. When it does not (the Messages
	// shape translates a level into a thinking budget, and a probe's budget is
	// the protocol floor), every ask is the endpoint's **one** answer about
	// thinking. Then the pass asks **once** and copies that reading onto every
	// level: six identical requests would spend five real requests to learn
	// nothing, and the rows still travel, because each level's own reading is
	// what a front end writes.
	carriesLevel := true
	if informed, ok := prober.(levelProbeAdapter); ok {
		carriesLevel = informed.ProbeCarriesLevel()
	}
	if !carriesLevel {
		levels := r.managedLevels()
		if len(levels) == 0 {
			return nil, errorf("this model offers no reasoning levels, so there is nothing to probe")
		}
		if r.ModelState.Selected() != modelID || r.ModelState.SelectedProvider() != provider {
			return nil, errorf("the model changed while the effort levels were being probed, so the result was discarded")
		}
		result, err := prober.ProbeEffort(levels[0])
		row := map[string]any{"result": string(result)}
		if err != nil && result != model.ProbeRejected {
			row["note"] = err.Error()
		}
		rows := make([]map[string]any, 0, len(levels))
		for _, level := range levels {
			// A fresh map per level: one shared map would let a front end's
			// own write to a row (adding a note, say) show up on all of them.
			copied := make(map[string]any, len(row)+1)
			for key, value := range row {
				copied[key] = value
			}
			copied["level"] = level
			rows = append(rows, copied)
		}
		return map[string]any{
			"model":    modelID,
			"provider": provider,
			"levels":   rows,
			// Present **only** in this case, and the absence rule is the
			// reading: a front end that does not know the key draws the rows as
			// they come, which is what a runtime that sends no key produces
			// anyway.
			"levels_are_one_answer": true,
		}, nil
	}

	levels := r.managedLevels()
	rows := make([]map[string]any, 0, len(levels))
	for _, level := range levels {
		// **The endpoint is pinned for the whole pass.** `/model` and `/effort`
		// stay reachable while the probe runs (it is six serial asks, minutes at
		// worst), and the adapter re-reads its route on every call. Without this
		// check a switch mid-pass would answer some rows from one model and
		// report them all under the model the pass started on — and the panel
		// writes that report into the configuration file. Refusing is the only
		// honest ending: the rows already collected are about an endpoint that
		// is no longer the session's.
		if r.ModelState.Selected() != modelID || r.ModelState.SelectedProvider() != provider {
			return nil, errorf("the model changed while the effort levels were being probed, so the result was discarded")
		}
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
