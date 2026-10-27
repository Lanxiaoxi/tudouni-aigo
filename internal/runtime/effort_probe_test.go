package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// probeChat is an adapter that answers the probe. It rides on `recordingChat`
// (the adapter `effortRuntime` already builds) and adds the one method the
// probe asserts, so the levels under test are the catalogue's own.
type probeChat struct {
	recordingChat

	// answers is what each level gets. A `ProbeOutcome` plus an error, because
	// the uncertain reading is exactly the pair.
	answers map[string]struct {
		outcome model.ProbeOutcome
		err     error
	}
	// asked records the levels in the order the runtime sent them.
	asked []string
	// onAsk runs after each answer, which is how a test switches the model
	// *during* a pass.
	onAsk func(level string)
	// repeatsOneAnswer is the Messages shape's honest limitation: the wire has
	// no level field, so every ask returns the same finding.
	repeatsOneAnswer bool
}

// ProbeCarriesLevel is the optional second half of the seam: false means the
// wire cannot be asked about a level as a level.
func (c *probeChat) ProbeCarriesLevel() bool { return !c.repeatsOneAnswer }

func (c *probeChat) ProbeEffort(level string) (model.ProbeOutcome, error) {
	c.asked = append(c.asked, level)
	answer, ok := c.answers[level]
	if c.onAsk != nil {
		c.onAsk(level)
	}
	if !ok {
		return model.ProbeOK, nil
	}
	return answer.outcome, answer.err
}

// probeRuntime builds a runtime over the narrow route (whose "wide" model
// declares [low high xhigh]) with the scripted adapter above.
func probeRuntime(t *testing.T, current string, chat *probeChat) *Runtime {
	t.Helper()
	runtimeValue, _ := effortRuntime(t, narrowRouteConfig, current)
	// The stub runtime's `Chat` has to be the scripted one *and* the recorded
	// one: `effortRuntime` returns the recording adapter it installed, and the
	// probe assertion is about the method on the adapter the runtime holds.
	runtimeValue.Chat = chat
	return runtimeValue
}

func otherError(text string) error { return errorf("%s", text) }

// TestProbeEffortAnswersEveryLevelInTheModelsOrder pins the three things the
// panel reads: the pair the result is about, one row per offered level, in the
// catalogue's order, and serial asks (the order is recorded, and there is no
// concurrency to interleave it).
func TestProbeEffortAnswersEveryLevelInTheModelsOrder(t *testing.T) {
	chat := &probeChat{recordingChat: recordingChat{model: "wide", provider: "p"}}
	runtimeValue := probeRuntime(t, "wide", chat)

	payload, err := runtimeValue.ProbeEffort()
	if err != nil {
		t.Fatalf("ProbeEffort: %v", err)
	}
	if payload["model"] != "wide" || payload["provider"] != "p" {
		t.Errorf("the payload names %v/%v, want wide/p", payload["model"], payload["provider"])
	}
	rows, _ := payload["levels"].([]map[string]any)
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want one per offered level (wide declares low/high/xhigh)", len(rows))
	}
	for i, want := range []string{"low", "high", "xhigh"} {
		if rows[i]["level"] != want {
			t.Errorf("row %d is %v, want %q in the catalogue's order", i, rows[i]["level"], want)
		}
		if rows[i]["result"] != "ok" {
			t.Errorf("row %d reads %v, want ok", i, rows[i]["result"])
		}
	}
	if len(chat.asked) != 3 {
		t.Errorf("the adapter was asked %d times, want one per level", len(chat.asked))
	}
}

// TestProbeEffortKeepsTheThreeReadingsApart is the whole design in one pass: a
// refused level is `rejected` and carries **no** error (the refusal is the
// answer, not a failure), a level that never got an answer is `uncertain` with
// the endpoint's sentence, and neither is collapsed into the other.
func TestProbeEffortKeepsTheThreeReadingsApart(t *testing.T) {
	chat := &probeChat{
		recordingChat: recordingChat{model: "wide", provider: "p"},
		answers: map[string]struct {
			outcome model.ProbeOutcome
			err     error
		}{
			"low":   {outcome: model.ProbeOK},
			"high":  {outcome: model.ProbeRejected},
			"xhigh": {outcome: model.ProbeUncertain, err: otherError("HTTP 429: rate limited")},
		},
	}
	runtimeValue := probeRuntime(t, "wide", chat)

	payload, err := runtimeValue.ProbeEffort()
	if err != nil {
		t.Fatalf("ProbeEffort: %v", err)
	}
	rows, _ := payload["levels"].([]map[string]any)
	byLevel := map[string]map[string]any{}
	for _, row := range rows {
		byLevel[row["level"].(string)] = row
	}

	if got := byLevel["low"]["result"]; got != "ok" {
		t.Errorf("low = %v, want ok", got)
	}
	if _, carries := byLevel["high"]["note"]; carries {
		t.Errorf("a rejected level carries no note: %v", byLevel["high"])
	}
	if got := byLevel["xhigh"]["result"]; got != "uncertain" {
		t.Errorf("xhigh = %v, want uncertain", got)
	}
	if note, _ := byLevel["xhigh"]["note"].(string); note == "" {
		t.Error("an uncertain level carries the endpoint's own sentence")
	}
}

// TestProbeEffortDiscardsTheResultWhenTheModelMoves is the bug a six-ask pass
// makes possible: `/model` stays reachable while it runs, so a switch halfway
// through would answer the remaining rows from another endpoint while the
// payload named the one the pass started on — and the panel would offer to
// write that mixed report into the configuration file.
func TestProbeEffortDiscardsTheResultWhenTheModelMoves(t *testing.T) {
	chat := &probeChat{recordingChat: recordingChat{model: "wide", provider: "p"}}
	runtimeValue := probeRuntime(t, "wide", chat)
	chat.onAsk = func(level string) {
		if level == "low" {
			// The person switches models while the pass is in flight.
			if ok, message := runtimeValue.SetModel("narrow"); !ok {
				t.Fatalf("switching to narrow failed: %s", message)
			}
		}
	}

	payload, err := runtimeValue.ProbeEffort()
	if err == nil {
		t.Fatalf("a pass whose model changed answered anyway: %v", payload)
	}
	if len(chat.asked) != 1 {
		t.Errorf("the pass went on asking after the model moved: %v", chat.asked)
	}
}

// TestProbeEffortSaysWhenTheRowsAreOneAnswer covers the Messages shape's honest
// failure to answer per level: the wire has no field for a level, so six asks
// produce six copies of one finding. The key is present exactly then — its
// absence is what a front end reads as "these rows are per level", which is also
// what a runtime that predates the key means.
func TestProbeEffortSaysWhenTheRowsAreOneAnswer(t *testing.T) {
	chat := &probeChat{recordingChat: recordingChat{model: "wide", provider: "p"}}
	runtimeValue := probeRuntime(t, "wide", chat)
	chat.repeatsOneAnswer = true

	payload, err := runtimeValue.ProbeEffort()
	if err != nil {
		t.Fatalf("ProbeEffort: %v", err)
	}
	if got, _ := payload["levels_are_one_answer"].(bool); !got {
		t.Errorf("levels_are_one_answer = %v, want true for a wire that never sees the level", payload["levels_are_one_answer"])
	}
	// And it was learned with **one** request: five more identical asks would be
	// five real requests spent to learn nothing.
	if len(chat.asked) != 1 {
		t.Errorf("the adapter was asked %d times, want once for a wire that cannot carry a level", len(chat.asked))
	}
	// Every level still has its own row, because that is what a save writes.
	rows, _ := payload["levels"].([]map[string]any)
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want one per offered level: %v", len(rows), payload["levels"])
	}
	for _, row := range rows {
		if row["level"] == nil || row["result"] == nil {
			t.Errorf("a row is missing its level or result: %v", row)
		}
	}

	// And the common case omits the key rather than sending false: "absent" has
	// to keep meaning "per level" for every front end that predates it.
	perLevelChat := &probeChat{recordingChat: recordingChat{model: "wide", provider: "p"}}
	perLevel := probeRuntime(t, "wide", perLevelChat)
	other, err := perLevel.ProbeEffort()
	if err != nil {
		t.Fatalf("ProbeEffort: %v", err)
	}
	if _, present := other["levels_are_one_answer"]; present {
		t.Errorf("the key was sent for a per-level wire: %v", other)
	}
}

func TestProbeEffortWithoutAnAdapterSaysSo(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, narrowRouteConfig, "narrow")
	// `recordingChat` is the runtime's ordinary adapter and has no probe method.
	if _, err := runtimeValue.ProbeEffort(); err == nil {
		t.Fatal("a runtime whose adapter cannot probe answered instead of reporting it")
	}
}

// TestProbeEffortWithoutAModelOrCatalogueRefuses keeps the stub half of the
// seam honest: the production assembly always has both, and a nil must be a
// reported error rather than a panic in a goroutine the server cannot see.
func TestProbeEffortWithoutAModelOrCatalogueRefuses(t *testing.T) {
	chat := &probeChat{recordingChat: recordingChat{model: "wide", provider: "p"}}
	runtimeValue := &Runtime{Chat: chat}
	if _, err := runtimeValue.ProbeEffort(); err == nil {
		t.Fatal("a runtime with no model state and no catalogue answered a probe")
	}
}
