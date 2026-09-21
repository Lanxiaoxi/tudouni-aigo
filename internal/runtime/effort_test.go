package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// effortRuntime is a runtime whose /effort surface can be exercised: a catalogue
// loaded from a real config file, the session's model choice, and an adapter that
// remembers what it was last told.
//
// It is built by hand rather than through Compose on purpose. The levels have to
// come from the catalogue and only from the catalogue, so a runtime assembled some
// other way must still enforce the same list — that is the property the first
// version of this code got wrong.
func effortRuntime(t *testing.T, body string, current string) (*Runtime, *recordingChat) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the configuration: %v", err)
	}
	catalog, err := state.Load(path)
	if err != nil {
		t.Fatalf("loading the configuration: %v", err)
	}

	metadata := map[string]any{}
	chat := &recordingChat{model: current, provider: "p"}
	return &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: metadata},
		ModelState:     state.NewSessionModel(metadata, current, "p"),
		Catalog:        catalog,
		Chat:           chat,
		// The state payload reads the running autopilot switch and the granted
		// tools, so a runtime with neither is not "a runtime without subagents" —
		// it is a crash in a different place.
		Agent:  agent.New(agent.Config{Chat: chat, Tools: tools.NewRegistry()}),
		Memory: security.NewMemory(nil, nil, "", nil),
	}, chat
}

// recordingChat is the minimum an adapter needs to be, plus a memory of the
// reasoning knobs, because those are what this file is about.
type recordingChat struct {
	model    string
	provider string
	thinking bool
	effort   string
}

func (c *recordingChat) Complete([]map[string]any, []map[string]any, model.CompleteOptions) (model.ModelResponse, error) {
	return model.ModelResponse{}, nil
}

func (c *recordingChat) SwitchModel(name string) bool { c.model = name; return true }

func (c *recordingChat) Install(route model.Route) bool {
	c.model, c.provider = route.Model, route.Name
	return true
}

func (c *recordingChat) SetReasoning(thinking bool, effort string) {
	c.thinking, c.effort = thinking, effort
}

func (c *recordingChat) ModelName() string    { return c.model }
func (c *recordingChat) ProviderName() string { return c.provider }
func (c *recordingChat) BaseURL() string      { return "https://example.invalid" }

func (c *recordingChat) Route() model.Route {
	return model.Route{Name: c.provider, Model: c.model}
}

func (c *recordingChat) SameEndpoint(route model.Route) bool {
	return route.Name == c.provider && route.Model == c.model
}

const narrowRouteConfig = `{
	"providers": {
		"p": {
			"base_url": "https://api.example",
			"api_key": "k",
			"effort_levels": ["low", "high"],
			"models": [
				{"id": "narrow"},
				{"id": "wide", "effort_levels": ["low", "high", "xhigh"]}
			]
		}
	}
}`

// TestSetEffortRefusesALevelTheModelDoesNotTake is the behaviour the whole design
// turns on: a refused level is reported, and nothing about the session moves.
//
// The alternative — quietly sending a different level — is what this replaced. It
// is worse exactly because it looks like success: the screen keeps the level that
// was typed while the request carries another one.
func TestSetEffortRefusesALevelTheModelDoesNotTake(t *testing.T) {
	runtimeValue, chat := effortRuntime(t, narrowRouteConfig, "narrow")

	ok, message := runtimeValue.SetEffort("xhigh")
	if ok {
		t.Fatal("xhigh was accepted by a model that declares [low high]")
	}
	if !strings.Contains(message, "low") || !strings.Contains(message, "high") {
		t.Errorf("the refusal does not name the levels this model takes: %s", message)
	}
	if !strings.Contains(message, "xhigh") {
		t.Errorf("the refusal does not name what was refused: %s", message)
	}

	// Nothing moved: not the session's level, and not what the adapter will send.
	if got := runtimeValue.ModelState.Effort(); got != state.DefaultEffort {
		t.Errorf("the session's effort = %q after a refusal, want it untouched at %q", got, state.DefaultEffort)
	}
	if chat.effort != "" {
		t.Errorf("the adapter was told to use %q after a refusal, want it untouched", chat.effort)
	}
}

// TestSetEffortAcceptsALevelTheModelTakesAndSendsItVerbatim is the other half:
// inside the declared list the word goes out unchanged, stored unchanged, and
// reported unchanged. `xhigh` surviving is the specific thing that used to fail.
func TestSetEffortAcceptsALevelTheModelTakesAndSendsItVerbatim(t *testing.T) {
	runtimeValue, chat := effortRuntime(t, narrowRouteConfig, "wide")

	ok, message := runtimeValue.SetEffort("xhigh")
	if !ok {
		t.Fatalf("xhigh was refused by a model that declares it: %s", message)
	}
	if chat.effort != "xhigh" {
		t.Errorf("the adapter was told %q, want xhigh — levels are never rewritten", chat.effort)
	}
	if got := runtimeValue.ModelState.Effort(); got != "xhigh" {
		t.Errorf("the session stored %q, want xhigh", got)
	}
	if !strings.Contains(message, "xhigh") {
		t.Errorf("the confirmation does not name the level: %s", message)
	}
}

// TestTheLevelsFollowTheModel pins that the list belongs to the model rather than
// to the process. Switching to a model with a different vocabulary has to change
// what is accepted, or `/effort` would offer levels the model in use refuses.
func TestTheLevelsFollowTheModel(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, narrowRouteConfig, "narrow")

	// The model that opened is the narrow one.
	if ok, message := runtimeValue.SetEffort("xhigh"); ok {
		t.Fatalf("xhigh was accepted before the switch: %s", message)
	}

	if ok, message := runtimeValue.SetModel("wide"); !ok {
		t.Fatalf("switching to wide failed: %s", message)
	}
	if ok, message := runtimeValue.SetEffort("xhigh"); !ok {
		t.Fatalf("xhigh was still refused after switching to a model that takes it: %s", message)
	}

	// And back: the wide model's vocabulary must not linger.
	if ok, message := runtimeValue.SetModel("narrow"); !ok {
		t.Fatalf("switching back to narrow failed: %s", message)
	}
	if ok, _ := runtimeValue.SetEffort("xhigh"); ok {
		t.Error("xhigh was accepted after switching back to a model that does not take it")
	}
}

// TestTheLevelsSentToTheFrontEndAreTheModelsOwn guards the payload, not the
// internal state: the interface renders `effort_levels` and nothing else, so a list
// resolved correctly but published wrongly is the same bug as not resolving it.
func TestTheLevelsSentToTheFrontEndAreTheModelsOwn(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, narrowRouteConfig, "narrow")

	listed, ok := runtimeValue.StateMessage(true)["effort_levels"].([]string)
	if !ok {
		t.Fatalf("effort_levels is %T, want a list of strings",
			runtimeValue.StateMessage(true)["effort_levels"])
	}
	if strings.Join(listed, ",") != "low,high" {
		t.Errorf("effort_levels = %v, want the current model's [low high]", listed)
	}
}

// TestAModelDeclaringNoLevelsStillPublishesAMenu keeps the broad default honest:
// a route that declares nothing publishes a usable list rather than an empty one,
// because an empty menu claims the model takes no level.
func TestAModelDeclaringNoLevelsStillPublishesAMenu(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, `{"providers": {"p": {
		"base_url": "https://api.example", "api_key": "k",
		"models": [{"id": "plain"}]
	}}}`, "plain")

	listed, _ := runtimeValue.StateMessage(true)["effort_levels"].([]string)
	if len(listed) != len(state.BroadEffortLevels) {
		t.Errorf("a model declaring no levels published %v, want the broad vocabulary", listed)
	}
	if ok, message := runtimeValue.SetEffort("xhigh"); !ok {
		t.Errorf("a model declaring nothing refused a level from the broad vocabulary: %s", message)
	}
}

// TestNoneIsStillTheSwitchAndNotALevel keeps the one level that is not a level out
// of the vocabulary, whichever list is in force.
func TestNoneIsStillTheSwitchAndNotALevel(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, narrowRouteConfig, "narrow")

	ok, message := runtimeValue.SetEffort("none")
	if ok {
		t.Fatal("`none` was accepted as an effort level")
	}
	if !strings.Contains(message, "/thinking") {
		t.Errorf("the refusal does not point at the switch that does turn thinking off: %s", message)
	}
}

// TestAModelsDefaultEffortIsAdoptedWhenNobodyChose is the half-wired field this
// fixes at the runtime end: `reasoning_effort` in a model entry now reaches the
// session instead of being read, validated and dropped.
func TestAModelsDefaultEffortIsAdoptedWhenNobodyChose(t *testing.T) {
	body := `{"providers": {"p": {
		"base_url": "https://api.example", "api_key": "k",
		"models": [{"id": "quiet", "reasoning_effort": "low"}]
	}}}`
	runtimeValue, _ := effortRuntime(t, body, "quiet")

	ref, ok := runtimeValue.Catalog.Find("quiet", "p")
	if !ok {
		t.Fatal("the model is missing from the catalogue")
	}
	runtimeValue.applyDefaultEffortFor(ref)
	if got := runtimeValue.ModelState.Effort(); got != "low" {
		t.Errorf("the session came up at %q, want the model's declared default low", got)
	}

	// And a level someone chose is not overwritten by it.
	if ok, message := runtimeValue.SetEffort("high"); !ok {
		t.Fatalf("choosing high was refused: %s", message)
	}
	runtimeValue.applyDefaultEffortFor(ref)
	if got := runtimeValue.ModelState.Effort(); got != "high" {
		t.Errorf("the chosen level was replaced by the model default (%q)", got)
	}
}
