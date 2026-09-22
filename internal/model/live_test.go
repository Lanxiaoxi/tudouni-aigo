package model

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// liveRoute is a real endpoint to exercise the adapter against, read out of the
// machine's own configuration.
//
// It exists because the failure this file covers is a property of somebody else's
// gateway: every part of it is unit-tested above with a fake endpoint, and none of
// that proves the field is the one the real one is asking for. The test is gated on
// the environment because it spends money and reaches the network.
//
//	TUDOUNI_LIVE_BASE_URL   e.g. https://opencode.ai/zen/go/v1
//	TUDOUNI_LIVE_API_KEY    the key
//	TUDOUNI_LIVE_MODEL      e.g. deepseek-v4.1-flash
//	TUDOUNI_LIVE_SESSION    optional, the x-opencode-session header
//
// With no variables set it reads ~/.tudouni/config.json and takes the first route
// whose models list contains TUDOUNI_LIVE_MODEL. Nothing is sent without an
// explicit model name: a test that quietly picks a model spends somebody's budget
// on a route they did not choose.
type liveRoute struct {
	baseURL string
	apiKey  string
	model   string
	session string
}

func liveRouteFromEnv(t *testing.T) (liveRoute, bool) {
	t.Helper()
	model := os.Getenv("TUDOUNI_LIVE_MODEL")
	if model == "" {
		return liveRoute{}, false // not opted in
	}
	route := liveRoute{
		baseURL: os.Getenv("TUDOUNI_LIVE_BASE_URL"),
		apiKey:  os.Getenv("TUDOUNI_LIVE_API_KEY"),
		model:   model,
		session: os.Getenv("TUDOUNI_LIVE_SESSION"),
	}
	if route.session == "" {
		// A gateway that routes by session refuses a request without one, and the
		// value itself is opaque — any stable string will do for a test.
		route.session = "tudouni-live-test"
	}
	if route.baseURL != "" && route.apiKey != "" {
		return route, true
	}

	// Fall back to the machine's configuration, which is where the person running
	// this already put the key.
	home, err := os.UserHomeDir()
	if err != nil {
		return liveRoute{}, false
	}
	raw, err := os.ReadFile(filepath.Join(home, ".tudouni", "config.json"))
	if err != nil {
		return liveRoute{}, false
	}
	var config struct {
		Providers map[string]struct {
			BaseURL string `json:"base_url"`
			APIKey  string `json:"api_key"`
			Models  []struct {
				ID string `json:"id"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return liveRoute{}, false
	}
	for _, provider := range config.Providers {
		if provider.APIKey == "" {
			continue
		}
		for _, m := range provider.Models {
			if m.ID != model {
				continue
			}
			route.baseURL = provider.BaseURL
			route.apiKey = provider.APIKey
			return route, true
		}
	}
	return liveRoute{}, false
}

// TestLiveEndpointReplaysTheThinking is the one test that talks to a real gateway.
//
// What it proves that the fakes cannot: that `reasoning_content` is the field this
// endpoint wants, and that the recovery in `Complete` works against the real
// refusal. The failure mode it guards is measured rather than theoretical — on
// opencode-go / deepseek-v4.1-flash a request whose assistant turn carries
// `tool_calls` without its thinking is answered 400, intermittently:
//
//	The `reasoning_content` in the thinking mode must be passed back to the API.
//
// Intermittently is the whole point of the design being tested here. The gateway
// load-balances across upstreams that disagree, so "always send it" and "always
// omit it" are both wrong; the adapter is supposed to omit it until an endpoint
// refuses, then send it from then on.
func TestLiveEndpointReplaysTheThinking(t *testing.T) {
	route, ok := liveRouteFromEnv(t)
	if !ok {
		t.Skip("set TUDOUNI_LIVE_MODEL (and a key, or use ~/.tudouni/config.json) to run this")
	}

	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "live", APIKey: route.apiKey, BaseURL: route.baseURL,
			Model: route.model, SessionID: route.session, Style: StyleOpenAI,
			// Gateways that route by conversation refuse a request without this
			// header, and the real configuration writes it exactly like this — the
			// value is the one the program supplies, not one this test invents.
			Headers: map[string]string{
				"x-opencode-session": SessionPlaceholder,
			},
		},
		Thinking: true, Effort: "high",
	})
	forgetReplayReasoning(route.baseURL, route.model)

	tools := []map[string]any{{
		"type": "function",
		"function": map[string]any{
			"name":        "read_file",
			"description": "read a file",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string"}},
				"required":   []any{"path"},
			},
		},
	}}

	// Step one: let the endpoint produce a tool call and its own thinking, which is
	// where a real `reasoning_content` comes from — an invented string is not the
	// same thing, and may not even be accepted.
	ask := []map[string]any{{
		"role": "user",
		"content": "Call read_file for a.txt. Do not answer in words.",
	}}
	first, err := adapter.Complete(ask, tools, CompleteOptions{})
	if err != nil {
		// A network that cannot reach the endpoint is the environment's business,
		// not the adapter's: what this test looks for is what the endpoint *says*,
		// so an unreachable host skips rather than fails. A 400-class refusal is the
		// opposite — it is the finding.
		if isNetworkTrouble(err) {
			t.Skipf("the live endpoint is unreachable from here: %v", err)
		}
		t.Fatalf("the first live call failed: %v", err)
	}
	if len(first.ToolCalls) == 0 {
		t.Skipf("the endpoint answered without a tool call, so there is nothing to replay: %#v", first.Content)
	}
	if first.Reasoning == nil || *first.Reasoning == "" {
		t.Skip("the endpoint reported no thinking, so this route cannot exercise the replay")
	}
	t.Logf("step 1: %d tool call(s), %d chars of thinking", len(first.ToolCalls), len(*first.Reasoning))

	// Step two, the shape the agent sends: the assistant turn with its tool call and
	// its thinking, then the result.
	call := first.ToolCalls[0]
	history := []map[string]any{
		ask[0],
		{
			"role": "assistant", "content": nil,
			"reasoning_content": *first.Reasoning,
			"tool_calls": []any{map[string]any{
				"id": call.ID, "type": "function",
				"function": map[string]any{"name": call.Name, "arguments": call.Arguments},
			}},
		},
		{"role": "tool", "tool_call_id": call.ID, "content": "line one"},
	}

	second, err := adapter.Complete(history, tools, CompleteOptions{})
	if err != nil {
		if isNetworkTrouble(err) {
			t.Skipf("the live endpoint dropped the second call: %v", err)
		}
		t.Fatalf("the endpoint refused the history that carries its own thinking: %v", err)
	}
	if second.Content == nil && len(second.ToolCalls) == 0 {
		t.Error("the second call answered nothing at all")
	}
	if !replayReasoningFor(route.baseURL, route.model) {
		t.Log("the endpoint accepted the first request, so no refusal was learned this run — " +
			"the replay path was exercised, but not the recovery")
	}
}

// isNetworkTrouble reports whether a failure is about reaching the endpoint rather
// than about what was sent to it.
//
// The distinction decides skip versus fail, so it is made on the error's type rather
// than on its text. `completeOnce` classifies the two kinds apart already: anything
// the endpoint answered with a status becomes `FatalError` or `CredentialError`, and
// anything that never got that far — `EOF`, a reset connection, a DNS failure, a
// timeout — becomes `TransientError`. So transient is the network's fault and fatal
// is ours, which is the opposite of how the retry loop reads them: there, transient
// is the retryable one because a retry *can* help, while here it is the one a test
// should not fail on because nothing about the adapter was exercised.
func isNetworkTrouble(err error) bool {
	var transient *TransientError
	return errors.As(err, &transient)
}
