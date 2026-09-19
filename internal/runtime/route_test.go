package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// TestRouteOfCarriesTheWholeEndpoint is the guard on the one place the catalogue
// and the model package meet.
//
// Everything the catalogue knows has to arrive, and the two fields that are easiest
// to lose are the newest: the protocol and the extra headers. Losing either has no
// local symptom — the request simply goes out in the old shape, or without the
// header the vendor asked for, and the complaint comes from the endpoint.
//
// It also pins the conversion of "no api_style configured", which has to reach the
// model package as **empty** rather than as the resolved default: resolving it here
// would be a second place that decides what the base URL means, and the two would
// drift.
func TestRouteOfCarriesTheWholeEndpoint(t *testing.T) {
	provider := state.Provider{
		Name:     "qwen",
		BaseURL:  "https://host/apps/anthropic/",
		APIKey:   "sk-1",
		Verify:   true,
		APIStyle: state.StyleAnthropic,
		Headers:  map[string]string{"x-opencode-session": "ses_1"},
		Models:   []state.ModelRef{{ID: "qwen3-max"}},
	}

	converted := routeOf(provider, "qwen3-max", "ses_abc")

	if converted.Name != "qwen" || converted.Model != "qwen3-max" {
		t.Errorf("route = %+v, want the route and model names", converted)
	}
	// The session id is what a configured `${session}` header is filled from, so
	// losing it here would make that header silently disappear.
	if converted.SessionID != "ses_abc" {
		t.Errorf("SessionID = %q, want the session it was built for", converted.SessionID)
	}
	if converted.APIKey != "sk-1" {
		t.Errorf("APIKey = %q", converted.APIKey)
	}
	if converted.Verify != true {
		t.Error("Verify was lost")
	}
	if converted.Style != model.StyleAnthropic {
		t.Errorf("Style = %q, want %q", converted.Style, model.StyleAnthropic)
	}
	if got := converted.Headers["x-opencode-session"]; got != "ses_1" {
		t.Errorf("Headers = %#v, want the configured header", converted.Headers)
	}

	// An unconfigured route hands over an empty style, and the model package is
	// what decides it means chat completions.
	plain := routeOf(state.Provider{Name: "p", BaseURL: "https://api.deepseek.com", APIKey: "k"}, "m", "")
	if plain.Style != "" {
		t.Errorf("Style = %q for a route that declared none, want empty", plain.Style)
	}
	adapter, err := model.New(model.Options{Route: plain})
	if err != nil {
		t.Fatalf("New on a plain route: %v", err)
	}
	if adapter.Route().Style != model.StyleOpenAI {
		t.Errorf("the resolved style = %q, want %q", adapter.Route().Style, model.StyleOpenAI)
	}
}
