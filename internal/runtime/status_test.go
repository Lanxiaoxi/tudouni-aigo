package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// TestTheStatusPayloadKeepsTheThinkingKnobsAsAnObject pins the shape a front end
// reads.
//
// The previous generation sent `{"thinking": bool, "effort": str}` here. Sending the
// bare effort string instead is not a smaller version of the same thing: a front end
// doing `reasoning["thinking"]` gets nothing, falls back to its own default, and
// therefore reports "thinking: on" for a session where it is off. That is a
// wrong value on screen with nothing anywhere reporting a divergence, so the shape
// is worth a test of its own.
func TestTheStatusPayloadKeepsTheThinkingKnobsAsAnObject(t *testing.T) {
	metadata := map[string]any{}
	modelState := state.NewSessionModel(metadata, "m-one", "one")
	modelState.SelectThinking(false, 0)
	modelState.SelectEffort("max", 0)

	runtimeValue := &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: metadata},
		ModelState:     modelState,
		Catalog:        state.Registry{Source: "/tmp/config.json"},
		Chat:           &statusChat{},
	}

	payload := runtimeValue.StatusMessage()
	status, _ := payload["status"].(map[string]any)
	modelInfo, _ := status["model"].(map[string]any)

	reasoning, ok := modelInfo["reasoning"].(map[string]any)
	if !ok {
		t.Fatalf("reasoning is not an object: %#v", modelInfo["reasoning"])
	}
	if thinking, _ := reasoning["thinking"].(bool); thinking {
		t.Error("thinking = true, want false")
	}
	if effort, _ := reasoning["effort"].(string); effort != "max" {
		t.Errorf("effort = %v, want max (it survives thinking being off)", effort)
	}

	// `context` must be present even when the layer is off: absent and nil are the
	// same statement here, and a front end has to be able to tell "no context
	// management" from "a row of zeroes".
	if _, present := status["context"]; !present {
		t.Error("the status payload has no context key")
	}

	meta, _ := status["meta"].(map[string]any)
	if source, _ := meta["catalog"].(string); source != "/tmp/config.json" {
		t.Errorf("meta.catalog = %v, want the catalogue's source path", meta["catalog"])
	}
}

// statusChat is the minimum a status payload needs from a model adapter.
type statusChat struct{}

func (s *statusChat) Complete(messages []map[string]any, tools []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	return model.ModelResponse{}, nil
}

func (s *statusChat) SwitchModel(name string) bool { return true }

func (s *statusChat) Install(apiKey, baseURL, model, provider string) bool { return true }

func (s *statusChat) SetReasoning(thinking bool, effort string) {}

func (s *statusChat) ModelName() string { return "m-one" }

func (s *statusChat) ProviderName() string { return "one" }

func (s *statusChat) BaseURL() string { return "https://example.invalid" }
