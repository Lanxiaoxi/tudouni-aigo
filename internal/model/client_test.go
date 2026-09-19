package model

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// recordedRequest is one request the fake gateway received.
type recordedRequest struct {
	body          map[string]any
	authorization string
}

// gateway spins up an endpoint that records the JSON body of every call and
// answers with a minimal well-formed completion.
func gateway(t *testing.T) (*httptest.Server, *[]recordedRequest) {
	t.Helper()
	calls := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("the request body is not JSON: %v (%s)", err, raw)
		}
		*calls = append(*calls, recordedRequest{body: body})

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],` +
			`"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

// completeOnce runs one non-streamed call and fails the test on error.
func completeOnce(t *testing.T, adapter *OpenAICompatible) ModelResponse {
	t.Helper()
	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	return response
}

// TestThinkingIsOnByDefaultInTheRequest mirrors the original's
// `test_thinking_is_on_by_default_in_the_request`: the proof is the request body.
//
// The endpoint's own default is already "on", but the request says so explicitly:
// a default varies with the endpoint, and this one is the user's choice.
func TestThinkingIsOnByDefaultInTheRequest(t *testing.T) {
	server, calls := gateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "m", StyleOpenAI),
		Thinking: true, Effort: "high",
	})
	completeOnce(t, adapter)

	body := (*calls)[0].body
	if got := body["reasoning_effort"]; got != "high" {
		t.Errorf("reasoning_effort = %v, want high", got)
	}
	// **No second field.** `thinking` used to be sent beside this one, inherited from
	// a generation that reached the wire through the OpenAI SDK's `extra_body` merge.
	// Writing the JSON directly has no such need, the field is redundant — this one
	// expresses on, off and the level — and an upstream that has never heard of it
	// refuses the whole request with `json: unknown field "thinking"`. A field nobody
	// needs is not free.
	if _, present := body["thinking"]; present {
		t.Errorf("thinking reached the wire: %#v", body["thinking"])
	}
	// The escape hatch must not reach the endpoint either: the SDK merges it into
	// the body, and an endpoint that sees this key has been sent the plumbing.
	if _, present := body["extra_body"]; present {
		t.Errorf("extra_body reached the wire: %#v", body["extra_body"])
	}
}

// TestTurningThinkingOffChangesTheNextRequest keeps the switch real in both
// directions.
//
// Turning it off has to change the request, or the display says off while the model
// keeps thinking and the bill keeps growing. The change is now a single field moving
// to `"none"` rather than a marker appearing, and the invariant worth pinning is that
// the two directions do not produce the same body.
func TestTurningThinkingOffChangesTheNextRequest(t *testing.T) {
	server, calls := gateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "m", StyleOpenAI),
		Thinking: true, Effort: "high",
	})
	completeOnce(t, adapter)

	adapter.SetReasoning(false, "high")
	completeOnce(t, adapter)

	on, off := (*calls)[0].body, (*calls)[1].body
	if got := off["reasoning_effort"]; got != "none" {
		t.Errorf("reasoning_effort while thinking is off = %v, want none", got)
	}
	if got := on["reasoning_effort"]; got == off["reasoning_effort"] {
		t.Error("turning thinking off produced the same request as leaving it on")
	}
	if _, present := off["thinking"]; present {
		t.Errorf("thinking reached the wire: %#v", off["thinking"])
	}
}

// TestTheEffortSurvivesADisabledThinking mirrors the original's
// `test_effort_reaches_the_request_and_survives_a_disabled_thinking`: turning
// thinking off does not lose the level, and turning it back on sends it again.
func TestTheEffortSurvivesADisabledThinking(t *testing.T) {
	server, calls := gateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "m", StyleOpenAI),
		Thinking: true, Effort: "high",
	})

	adapter.SetReasoning(false, "max")
	completeOnce(t, adapter)
	adapter.SetReasoning(true, "max")
	completeOnce(t, adapter)

	second := (*calls)[1].body
	if got := second["reasoning_effort"]; got != "max" {
		t.Errorf("reasoning_effort after turning thinking back on = %v, want max", got)
	}
	// The first request, made while thinking was off, must not have kept the level:
	// the switch has to be visible in the body, not only in the interface.
	if got := (*calls)[0].body["reasoning_effort"]; got != offEffort {
		t.Errorf("reasoning_effort while thinking was off = %v, want %q", got, offEffort)
	}
}

// TestApplyRequestFieldsWritesExactlyOneField pins the whole of what this function
// is allowed to add.
//
// The count is the point. Every extra field here is one more thing an upstream can
// refuse as unknown, and the one it used to add — `thinking` — was refused by name on
// a real gateway. Writing that as "the body has these keys and no others" means a
// future addition has to be deliberate rather than incidental.
func TestApplyRequestFieldsWritesExactlyOneField(t *testing.T) {
	on := map[string]any{"model": "m"}
	applyOpenAIRequestFields(on, ReasoningKnobs{Thinking: true, Effort: "max"})
	if got := on["reasoning_effort"]; got != "max" {
		t.Errorf("reasoning_effort = %v, want max", got)
	}
	if len(on) != 2 {
		t.Errorf("the body has %d keys, want 2 (model and reasoning_effort): %#v", len(on), on)
	}

	off := map[string]any{"model": "m"}
	applyOpenAIRequestFields(off, ReasoningKnobs{Thinking: false, Effort: "max"})
	if got := off["reasoning_effort"]; got != offEffort {
		t.Errorf("reasoning_effort = %v while thinking is off, want %q", got, offEffort)
	}
	if len(off) != 2 {
		t.Errorf("the body has %d keys, want 2: %#v", len(off), off)
	}

	// The state the retry falls back to says nothing at all about reasoning.
	silent := map[string]any{"model": "m"}
	applyOpenAIRequestFields(silent, ReasoningKnobs{Thinking: false, Effort: "max", omit: true})
	if len(silent) != 1 {
		t.Errorf("the fallback body has %d keys, want only the model: %#v", len(silent), silent)
	}
	if _, present := silent["extra_body"]; present {
		t.Errorf("extra_body was not flattened: %#v", silent)
	}
}

// authGateway records the Authorization header of every call as well as the body,
// and answers in a way that names the route it was reached on.
func authGateway(t *testing.T, label string) (*httptest.Server, *[]recordedRequest) {
	t.Helper()
	calls := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("the request body is not JSON: %v (%s)", err, raw)
		}
		*calls = append(*calls, recordedRequest{body: body, authorization: r.Header.Get("Authorization")})

		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"message": map[string]any{"role": "assistant", "content": label},
			}},
			"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)
	return server, calls
}

// TestInstallingAnotherRouteMovesTheEndpointAndTheKey covers the failure with no
// symptom on the surface: after moving to another route, `/status`, the session
// record and the audit all report the new route, while every request keeps going
// to the old endpoint on the old key — and the bill is the only place that ever
// shows it.
func TestInstallingAnotherRouteMovesTheEndpointAndTheKey(t *testing.T) {
	first, firstCalls := authGateway(t, "from route one")
	second, secondCalls := authGateway(t, "from route two")

	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "one", APIKey: "key-one", BaseURL: first.URL, Model: "m-one",
		},
		Thinking: true, Effort: "high",
	})

	response := completeOnce(t, adapter)
	if response.Content == nil || *response.Content != "from route one" {
		t.Fatalf("the first request did not reach route one: %#v", response.Content)
	}

	if !adapter.Install(Route{Name: "two", APIKey: "key-two", BaseURL: second.URL, Model: "m-two"}) {
		t.Fatal("Install refused a valid route change")
	}

	response = completeOnce(t, adapter)
	if response.Content == nil || *response.Content != "from route two" {
		t.Fatalf("the request after Install did not reach route two: %#v", response.Content)
	}
	if len(*firstCalls) != 1 {
		t.Errorf("route one saw %d requests, want 1: the model call did not move", len(*firstCalls))
	}
	if got := (*secondCalls)[0].authorization; got != "Bearer key-two" {
		t.Errorf("Authorization = %q, want the new route's key", got)
	}
	if got := (*secondCalls)[0].body["model"]; got != "m-two" {
		t.Errorf("model = %v, want m-two", got)
	}
	if adapter.BaseURL() != second.URL {
		t.Errorf("BaseURL() = %s, want %s", adapter.BaseURL(), second.URL)
	}
	if adapter.ProviderName() != "two" {
		t.Errorf("ProviderName() = %s, want two", adapter.ProviderName())
	}
}

// TestInstallingRefusesAnEmptyEndpointOrModel keeps the failure direction honest:
// a half-applied route change would leave the adapter pointed somewhere nobody
// chose, which is worse than refusing.
func TestInstallingRefusesAnEmptyEndpointOrModel(t *testing.T) {
	adapter := newTestAdapter(t, Options{
		Route: Route{Name: "one", APIKey: "key-one", BaseURL: "https://example.invalid", Model: "m-one"},
	})
	if adapter.Install(Route{Name: "p", APIKey: "k", BaseURL: "   ", Model: "m"}) {
		t.Error("Install accepted an empty base_url")
	}
	if adapter.Install(Route{Name: "p", APIKey: "k", BaseURL: "https://example.invalid", Model: "  "}) {
		t.Error("Install accepted an empty model name")
	}
	// A refused install must leave the adapter exactly as it was.
	if adapter.BaseURL() != "https://example.invalid" || adapter.ModelName() != "m-one" {
		t.Errorf("a refused install changed the adapter: %s / %s", adapter.BaseURL(), adapter.ModelName())
	}
}

// TestInstallingAnUnknownProtocolIsRefusedWithoutMoving keeps the all-or-nothing
// rule: a route that cannot be spoken is not half-applied.
func TestInstallingAnUnknownProtocolIsRefusedWithoutMoving(t *testing.T) {
	adapter := newTestAdapter(t, Options{
		Route: Route{Name: "one", APIKey: "key-one", BaseURL: "https://example.invalid", Model: "m-one"},
	})
	if adapter.Install(Route{
		Name: "two", APIKey: "key-two", BaseURL: "https://other.invalid", Model: "m-two", Style: "antropic",
	}) {
		t.Error("Install accepted an unknown api_style")
	}
	if adapter.ProviderName() != "one" || adapter.ModelName() != "m-one" {
		t.Errorf("a refused install moved the adapter: %s / %s", adapter.ProviderName(), adapter.ModelName())
	}
}

// TestSwitchingWithinARouteIsTheCheapPath keeps the two capabilities apart: the
// same route only needs the model name changed, and that must not require a route
// install.
func TestSwitchingWithinARouteIsTheCheapPath(t *testing.T) {
	server, calls := authGateway(t, "ok")
	adapter := newTestAdapter(t, Options{
		Route:    Route{Name: "one", APIKey: "key-one", BaseURL: server.URL, Model: "m-one"},
		Thinking: true, Effort: "high",
	})

	if !adapter.SwitchModel("m-two") {
		t.Fatal("SwitchModel refused a valid name")
	}
	completeOnce(t, adapter)

	if got := (*calls)[0].body["model"]; got != "m-two" {
		t.Errorf("model = %v, want m-two", got)
	}
	if got := (*calls)[0].authorization; got != "Bearer key-one" {
		t.Errorf("Authorization = %q, want the unchanged key", got)
	}
}
