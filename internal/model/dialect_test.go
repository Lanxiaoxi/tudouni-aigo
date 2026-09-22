package model

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// route is a Route with the two fields every test needs, so that a case that
// cares about the protocol does not have to also write an endpoint and a model
// name in full.
func route(baseURL, modelID string, style Style) Route {
	return Route{Name: "test", APIKey: "test-key", BaseURL: baseURL, Model: modelID, Style: style}
}

// sse renders a stream of events the way a gateway sends them.
//
// The `event:` line is included even though the adapter ignores it — that is what
// the wire looks like, and a test that sent only `data:` would not catch a parser
// that mishandled the real thing.
func sse(events ...map[string]any) string {
	var out strings.Builder
	for _, event := range events {
		if name, ok := event["type"].(string); ok {
			fmt.Fprintf(&out, "event: %s\n", name)
		}
		payload, _ := json.Marshal(event)
		fmt.Fprintf(&out, "data: %s\n\n", payload)
	}
	out.WriteString("data: [DONE]\n\n")
	return out.String()
}

// dialectGateway answers with one fixed body and records what it was sent.
func dialectGateway(t *testing.T, body string) (*httptest.Server, *[]map[string]any, *[]http.Header) {
	t.Helper()
	bodies := &[]map[string]any{}
	headers := &[]http.Header{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Errorf("the request body is not JSON: %v (%s)", err, raw)
		}
		*bodies = append(*bodies, decoded)
		*headers = append(*headers, r.Header.Clone())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server, bodies, headers
}

// streamGateway answers every request with an SSE body.
func streamGateway(t *testing.T, body string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	bodies := &[]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		_ = json.Unmarshal(raw, &decoded)
		*bodies = append(*bodies, decoded)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server, bodies
}

// TestRouteHeadersReachTheRequest pins the escape hatch that exists for vendors
// that require their own client identification.
//
// The disappearing-header failure has no local symptom: the endpoint answers with
// whatever it says when a required header is missing, and nothing in this program
// connects that to a configuration line.
func TestRouteHeadersReachTheRequest(t *testing.T) {
	server, _, headers := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "opencode", APIKey: "k", BaseURL: server.URL, Model: "m",
			Headers: map[string]string{
				"User-Agent":         "tudouni/0.2",
				"x-opencode-session": "ses_123",
			},
		},
		Thinking: state.DefaultThinking, Effort: state.DefaultEffort,
	})

	completeOnce(t, adapter)

	sent := (*headers)[0]
	if got := sent.Get("User-Agent"); got != "tudouni/0.2" {
		t.Errorf("User-Agent = %q, want the configured one", got)
	}
	if got := sent.Get("x-opencode-session"); got != "ses_123" {
		t.Errorf("x-opencode-session = %q, want the configured one", got)
	}
	// The headers this package owns must survive a configuration that names them.
	if got := sent.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := sent.Get("Authorization"); got != "Bearer k" {
		t.Errorf("Authorization = %q, want the route key", got)
	}
}

// TestAConfiguredHeaderCannotDisplaceTheCredential keeps the ordering deliberate:
// a route that names Authorization is a mistake, and the mistake must not turn
// into a request without a key.
func TestAConfiguredHeaderCannotDisplaceTheCredential(t *testing.T) {
	server, _, headers := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "p", APIKey: "real-key", BaseURL: server.URL, Model: "m",
			Headers: map[string]string{"Authorization": "Bearer wrong"},
		},
	})

	completeOnce(t, adapter)

	if got := (*headers)[0].Get("Authorization"); got != "Bearer real-key" {
		t.Errorf("Authorization = %q, want the route's own key", got)
	}
}

// TestStyleIsInferredFromTheBaseURL pins the inference, including the case that
// matters most: a base URL with no distinguishing suffix keeps the default that
// existed before any of this.
func TestStyleIsInferredFromTheBaseURL(t *testing.T) {
	cases := []struct {
		baseURL string
		want    Style
	}{
		{"https://api.deepseek.com", StyleOpenAI},
		{"https://api.deepseek.com/v1", StyleOpenAI},
		{"https://host/apps/anthropic", StyleAnthropic},
		{"https://host/apps/anthropic/", StyleAnthropic},
		{"https://api.anthropic.com/v1/messages", StyleAnthropic},
		{"https://api.x.ai/v1/responses", StyleResponses},
		{"https://host/responses", StyleResponses},
	}
	for _, item := range cases {
		if got := StyleFromBaseURL(item.baseURL); got != item.want {
			t.Errorf("StyleFromBaseURL(%q) = %q, want %q", item.baseURL, got, item.want)
		}
	}
}

// TestAnUnknownStyleIsRefusedByName is the failure direction: a typo must not be
// treated as the default, because the resulting request would be answered by the
// endpoint with an error about a field, and the person would have to work
// backwards from the wire to their configuration file.
func TestAnUnknownStyleIsRefusedByName(t *testing.T) {
	_, err := New(Options{Route: Route{BaseURL: "https://example.invalid", Model: "m", Style: "antropic"}})
	if err == nil {
		t.Fatal("an unknown api_style was accepted")
	}
	if !strings.Contains(err.Error(), "antropic") {
		t.Errorf("the error does not name the bad value: %v", err)
	}
}

// evolvingGateway answers each request in the shape the request itself is in, so
// that a test can move a route from one protocol to another without the fake
// endpoint becoming the thing under test.
func evolvingGateway(t *testing.T) (*httptest.Server, *[]map[string]any, *[]http.Header) {
	t.Helper()
	bodies := &[]map[string]any{}
	headers := &[]http.Header{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Errorf("the request body is not JSON: %v (%s)", err, raw)
		}
		*bodies = append(*bodies, decoded)
		*headers = append(*headers, r.Header.Clone())

		w.Header().Set("Content-Type", "application/json")
		// `max_tokens` exists only in the Messages shape, which is the same test
		// the assertions below make.
		if _, isMessages := decoded["max_tokens"]; isMessages {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(server.Close)
	return server, bodies, headers
}

// TestRouteChangeMovesTheProtocolAndTheHeaders is the whole point of handing over
// a Route rather than four strings.
//
// The bug it exists to prevent: the interface, the session record and the audit
// all report the new route, while the request keeps going out the old way — old
// endpoint, old protocol, missing headers — and nothing anywhere reports it.
func TestRouteChangeMovesTheProtocolAndTheHeaders(t *testing.T) {
	server, bodies, headers := evolvingGateway(t)

	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "one", APIKey: "key-one", BaseURL: server.URL, Model: "m-one",
			Headers: map[string]string{"x-route": "one"},
		},
	})
	completeOnce(t, adapter)

	if !adapter.Install(Route{
		Name: "two", APIKey: "key-two", BaseURL: server.URL, Model: "m-two",
		Style:   StyleAnthropic,
		Headers: map[string]string{"x-route": "two", "x-opencode-session": "ses_9"},
	}) {
		t.Fatal("Install refused a valid route change")
	}
	completeOnce(t, adapter)

	if got := (*bodies)[1]["max_tokens"]; got == nil {
		t.Errorf("the second request is not in the Messages shape: %#v", (*bodies)[1])
	}
	if got := (*bodies)[1]["messages"]; got == nil {
		t.Fatalf("the second request has no messages: %#v", (*bodies)[1])
	}
	second := (*headers)[1]
	// The credential moves to the header this protocol actually reads. A bearer
	// token sent to the Messages shape is answered with "Missing API key" while the
	// key sits in the request, which is a message that accuses the wrong thing.
	if got := second.Get("x-api-key"); got != "key-two" {
		t.Errorf("x-api-key = %q, want the new route's key", got)
	}
	if got := second.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want it unused by the Messages protocol", got)
	}
	if got := second.Get("x-route"); got != "two" {
		t.Errorf("x-route = %q, want two", got)
	}
	if got := second.Get("x-opencode-session"); got != "ses_9" {
		t.Errorf("x-opencode-session = %q, want the header the new route added", got)
	}
}

// TestRenameAndRouteChangeAreDifferentQuestions keeps the cheap path cheap.
//
// A protocol or a header appearing on the route must move the adapter; a model
// name alone must not, or every `/model` within one route would pay a full
// reinstall and the distinction the interface relies on would be gone.
func TestRenameAndRouteChangeAreDifferentQuestions(t *testing.T) {
	base := Route{Name: "p", APIKey: "k", BaseURL: "https://example.invalid", Model: "m-one"}

	renamed := base
	renamed.Model = "m-two"
	if !base.sameEndpoint(renamed) {
		t.Error("a renamed model was treated as another endpoint")
	}

	restyled := base
	restyled.Style = StyleAnthropic
	if base.sameEndpoint(restyled) {
		t.Error("a change of protocol was treated as the same endpoint")
	}

	reheadered := base
	reheadered.Headers = map[string]string{"x-opencode-session": "ses_1"}
	if base.sameEndpoint(reheadered) {
		t.Error("an added header was treated as the same endpoint")
	}

	rekeyed := base
	rekeyed.APIKey = "other"
	if base.sameEndpoint(rekeyed) {
		t.Error("a different key was treated as the same endpoint")
	}
}

// TestAnthropicRequestLiftsTheSystemPromptAndRewritesTools pins the two
// structural changes the Messages shape requires.
//
// Neither is a rename, and both fail on a real conversation rather than on a
// trivial one: a `system` role in `messages` is rejected outright, and an
// OpenAI-shaped tool entry is rejected the first time the model wants a tool —
// which is late enough to read as a tool problem rather than a plumbing problem.
func TestAnthropicRequestLiftsTheSystemPromptAndRewritesTools(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"content":[{"type":"text","text":"ok"}]}`)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "claude-x", StyleAnthropic),
		Thinking: true, Effort: "high",
	})

	_, err := adapter.Complete([]map[string]any{
		{"role": "system", "content": "you are terse"},
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": nil, "tool_calls": []any{
			map[string]any{"id": "call_1", "function": map[string]any{
				"name": "read_file", "arguments": `{"path":"a.txt"}`,
			}},
		}},
		{"role": "tool", "tool_call_id": "call_1", "content": "file body"},
	}, []map[string]any{{
		"type": "function",
		"function": map[string]any{
			"name": "read_file", "description": "read a file",
			"parameters": map[string]any{"type": "object"},
		},
	}}, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	body := (*bodies)[0]
	if got := body["system"]; got != "you are terse" {
		t.Errorf("system = %v, want it lifted to the top level", got)
	}
	if _, present := requestedRole(t, body, "system"); present {
		t.Error("a system role reached messages, which this protocol refuses")
	}

	messages := messagesOf(t, body)
	if len(messages) != 3 {
		t.Fatalf("messages has %d entries, want 3: %#v", len(messages), messages)
	}
	// The tool result must be a user turn carrying a tool_result block: there is
	// no `tool` role in this protocol.
	result := messages[2]
	if result["role"] != "user" {
		t.Errorf("the tool result role = %v, want user", result["role"])
	}
	block := blockOf(t, result, "tool_result")
	if block["tool_use_id"] != "call_1" {
		t.Errorf("tool_use_id = %v, want call_1", block["tool_use_id"])
	}

	// The assistant turn's call must be reproduced as a tool_use block with a
	// parsed input object — a dropped call turns the result above into a
	// reference to something that does not exist.
	call := blockOf(t, messages[1], "tool_use")
	if call["name"] != "read_file" {
		t.Errorf("tool_use.name = %v, want read_file", call["name"])
	}
	input, ok := call["input"].(map[string]any)
	if !ok || input["path"] != "a.txt" {
		t.Errorf("tool_use.input = %#v, want the decoded arguments", call["input"])
	}

	// Tools are flattened and the schema is renamed.
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %#v, want one entry", body["tools"])
	}
	entry, _ := tools[0].(map[string]any)
	if entry["name"] != "read_file" {
		t.Errorf("tools[0].name = %v, want read_file", entry["name"])
	}
	if _, present := entry["function"]; present {
		t.Error("tools[0] is still nested under function")
	}
	if _, present := entry["input_schema"]; !present {
		t.Error("tools[0] has no input_schema")
	}

	// The thinking switch becomes this protocol's own parameter, and no
	// chat-completions-only field goes along with it.
	thinking, ok := body["thinking"].(map[string]any)
	if !ok || thinking["type"] != "enabled" {
		t.Errorf("thinking = %#v, want {type: enabled}", body["thinking"])
	}
	if _, present := body["reasoning_effort"]; present {
		t.Error("reasoning_effort was sent to the Messages protocol")
	}
	maxTokens := intOf(body["max_tokens"])
	budget := intOf(thinking["budget_tokens"])
	if maxTokens <= budget {
		t.Errorf("max_tokens = %d is not above the thinking budget %d: the endpoint refuses that", maxTokens, budget)
	}
}

// TestAnthropicStopsThinkingWhenAsked keeps the knob honest in the other
// direction: thinking off must reach the endpoint as this protocol's disabled
// marker.
func TestAnthropicStopsThinkingWhenAsked(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"content":[{"type":"text","text":"ok"}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	adapter.SetReasoning(false, "max")
	completeOnce(t, adapter)

	thinking, ok := (*bodies)[0]["thinking"].(map[string]any)
	if !ok || thinking["type"] != "disabled" {
		t.Errorf("thinking = %#v, want {type: disabled}", (*bodies)[0]["thinking"])
	}
	if _, present := thinking["budget_tokens"]; present {
		t.Error("a budget was sent while thinking is off")
	}
}

// TestAnthropicUsageMapsTheCacheField is the silent failure this mapping exists
// for.
//
// A normaliser that only knew the chat completions spelling would report every
// cached token as a miss. Nothing errors: the number simply looks worse than it
// is, for ever, and the cache looks like it never works on this route.
func TestAnthropicUsageMapsTheCacheField(t *testing.T) {
	server, _, _ := dialectGateway(t, `{"content":[{"type":"text","text":"ok"}],
		"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":90,"cache_creation_input_tokens":5}}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	response := completeOnce(t, adapter)

	if response.Usage == nil {
		t.Fatal("no usage was read from the response")
	}
	if response.Usage.PromptTokens != 100 || response.Usage.CompletionTokens != 20 {
		t.Errorf("usage = %+v, want 100/20", *response.Usage)
	}
	if response.Usage.CachedTokens != 90 {
		t.Errorf("CachedTokens = %d, want 90", response.Usage.CachedTokens)
	}
	if got := response.Usage.MissTokens(); got != 10 {
		t.Errorf("MissTokens = %d, want 10", got)
	}
}

// TestAnthropicUnaryReadsBlocksAndToolCalls covers a whole response, which is the
// path taken when nobody is streaming.
func TestAnthropicUnaryReadsBlocksAndToolCalls(t *testing.T) {
	server, _, _ := dialectGateway(t, `{
		"id":"msg_1","type":"message","role":"assistant",
		"content":[
			{"type":"thinking","thinking":"let me look"},
			{"type":"text","text":"reading it now"},
			{"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"a.txt"}}
		],
		"stop_reason":"tool_use",
		"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0}
	}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	response := completeOnce(t, adapter)

	if response.Content == nil || *response.Content != "reading it now" {
		t.Errorf("Content = %#v, want the text block", response.Content)
	}
	if response.Reasoning == nil || *response.Reasoning != "let me look" {
		t.Errorf("Reasoning = %#v, want the thinking block", response.Reasoning)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %#v, want one", response.ToolCalls)
	}
	call := response.ToolCalls[0]
	if call.ID != "toolu_1" || call.Name != "read_file" {
		t.Errorf("call = %+v, want toolu_1/read_file", call)
	}
	// The object has to come back as the JSON text the tool layer parses.
	arguments := map[string]any{}
	if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
		t.Fatalf("arguments are not JSON text: %q (%v)", call.Arguments, err)
	}
	if arguments["path"] != "a.txt" {
		t.Errorf("arguments = %v, want the decoded input", call.Arguments)
	}
}

// TestAnthropicStreamAssemblesTextThinkingAndToolCalls walks a real event
// sequence, because that is where this protocol differs most from chat
// completions: the call's arguments arrive as fragments of JSON, and the text and
// thinking arrive as deltas on separate block indices.
func TestAnthropicStreamAssemblesTextThinkingAndToolCalls(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "message_start", "message": map[string]any{
			"id": "msg_1", "usage": map[string]any{"input_tokens": 30, "output_tokens": 0},
		}},
		map[string]any{"type": "ping"},
		map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "thinking", "thinking": ""}},
		map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "I should read "}},
		map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "the file first."}},
		map[string]any{"type": "content_block_stop", "index": 0},
		map[string]any{"type": "content_block_start", "index": 1,
			"content_block": map[string]any{"type": "text", "text": ""}},
		map[string]any{"type": "content_block_delta", "index": 1,
			"delta": map[string]any{"type": "text_delta", "text": "Let me "}},
		map[string]any{"type": "content_block_delta", "index": 1,
			"delta": map[string]any{"type": "text_delta", "text": "check."}},
		map[string]any{"type": "content_block_stop", "index": 1},
		map[string]any{"type": "content_block_start", "index": 2,
			"content_block": map[string]any{"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": map[string]any{}}},
		map[string]any{"type": "content_block_delta", "index": 2,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": `{"path":`}},
		map[string]any{"type": "content_block_delta", "index": 2,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": `"a.txt"}`}},
		map[string]any{"type": "content_block_stop", "index": 2},
		map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
			"usage": map[string]any{"input_tokens": 30, "output_tokens": 12, "cache_read_input_tokens": 20}},
		map[string]any{"type": "message_stop"},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	var streamedText, streamedReasoning strings.Builder
	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(text, reasoning string) {
			streamedText.WriteString(text)
			streamedReasoning.WriteString(reasoning)
		}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if streamedText.String() != "Let me check." {
		t.Errorf("the streamed text = %q", streamedText.String())
	}
	if streamedReasoning.String() != "I should read the file first." {
		t.Errorf("the streamed reasoning = %q", streamedReasoning.String())
	}
	if response.Content == nil || *response.Content != "Let me check." {
		t.Errorf("Content = %#v", response.Content)
	}
	if response.Reasoning == nil || *response.Reasoning != "I should read the file first." {
		t.Errorf("Reasoning = %#v", response.Reasoning)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %#v, want one", response.ToolCalls)
	}
	call := response.ToolCalls[0]
	if call.Name != "read_file" || call.ID != "toolu_1" {
		t.Errorf("call = %+v, want read_file/toolu_1", call)
	}
	// The fragments must have been joined, not replaced by the last one.
	if call.Arguments != `{"path":"a.txt"}` {
		t.Errorf("arguments = %q, want the joined fragments", call.Arguments)
	}
	if !response.Streamed {
		t.Error("Streamed = false on a streamed turn")
	}
	if response.Usage == nil || response.Usage.CompletionTokens != 12 || response.Usage.CachedTokens != 20 {
		t.Errorf("usage = %#v, want the message_delta block", response.Usage)
	}
}

// TestAnthropicSendsNoStreamOptionsParameter is a protocol fact rather than a
// preference: this shape has no `include_usage`, and sending it is a 400 from a
// strict endpoint.
func TestAnthropicSendsNoStreamOptionsParameter(t *testing.T) {
	server, bodies := streamGateway(t, sse(
		map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": "ok"}},
		map[string]any{"type": "message_stop"},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	body := (*bodies)[0]
	if _, present := body["stream_options"]; present {
		t.Errorf("stream_options was sent to the Messages protocol: %#v", body)
	}
	if body["stream"] != true {
		t.Errorf("stream = %v, want true", body["stream"])
	}
}

// TestAStreamWithNothingButASystemPromptIsRefusedLocally keeps the failure where
// it can be explained.
//
// The endpoint's own answer to an empty message list names `messages`, which
// sends the reader looking at the wrong thing. This can only happen if the whole
// request was a system prompt, and saying that is what makes it fixable.
func TestAStreamWithNothingButASystemPromptIsRefusedLocally(t *testing.T) {
	server, _, _ := dialectGateway(t, `{"content":[{"type":"text","text":"ok"}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	_, err := adapter.Complete([]map[string]any{{"role": "system", "content": "only this"}}, nil, CompleteOptions{})
	if err == nil {
		t.Fatal("a request with no conversation turn was sent")
	}
	if !strings.Contains(err.Error(), "system prompt") {
		t.Errorf("the error does not explain the cause: %v", err)
	}
}

// TestAnthropicErrorEventIsReported keeps a half-delivered answer from being
// returned as a complete one: this protocol reports a mid-stream failure as an
// event, so a parser that only knew the documented deltas would hand back the text
// that had arrived and call the turn successful.
func TestAnthropicErrorEventIsReported(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": "half an answer"}},
		map[string]any{"type": "error", "error": map[string]any{
			"type": "overloaded_error", "message": "try again later",
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err == nil {
		t.Fatal("a mid-stream error was reported as a successful turn")
	}
	if !strings.Contains(err.Error(), "try again later") {
		t.Errorf("the error does not carry the cause: %v", err)
	}
}

// --- helpers -------------------------------------------------------------

// newTestAdapter builds an adapter and fails the test if the route is refused.
func newTestAdapter(t *testing.T, options Options) *OpenAICompatible {
	t.Helper()
	adapter, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return adapter
}

// TestPrivateSessionFieldsNeverReachTheWire is the regression for a 400 that
// killed a session outright.
//
// This program's session format carries bookkeeping the context layer needs —
// `artifact_id` on a tool message is the one that has actually been rejected —
// and the chat completions shape **takes the message list whole**. Passing it
// through put our private field in the request body, and the gateway answered
//
//	Extra inputs are not permitted, field: 'messages[5].artifact_id'
//
// as a **fatal** 400: the turn died, and because the offending message is in the
// session file it would have been re-sent with every later turn of that session.
// The failure is worth a test of its own rather than a line in another one,
// because what it protects is "a session can be continued at all".
func TestPrivateSessionFieldsNeverReachTheWire(t *testing.T) {
	// The session message the agent writes for a tool result that became an
	// artifact, verbatim: content is the human-readable reference, `artifact_id`
	// is the machine-readable one.
	toolMessage := map[string]any{
		"role":         "tool",
		"tool_call_id": "chatcmpl-tool-87eadf8d31c8bb9d",
		"content":      "[artifact art_f7e0211e7551 · 45 字符 · shell]",
		"artifact_id":  "art_f7e0211e7551",
	}
	messages := []map[string]any{
		{"role": "user", "content": "count the lines"},
		{"role": "assistant", "content": nil, "tool_calls": []any{
			map[string]any{"id": "chatcmpl-tool-87eadf8d31c8bb9d", "function": map[string]any{
				"name": "shell", "arguments": `{"command":"Get-ChildItem"}`,
			}},
		}},
		toolMessage,
	}

	server, bodies, _ := dialectGateway(t, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "gpt-x", StyleOpenAI)})

	if _, err := adapter.Complete(messages, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	body := (*bodies)[0]
	sent, ok := requestedRole(t, body, "tool")
	if !ok {
		t.Fatalf("the tool message did not reach the wire at all: %#v", messagesOf(t, body))
	}
	if _, present := sent["artifact_id"]; present {
		t.Errorf("artifact_id reached the request body: %#v", sent)
	}
	// The whitelist must keep the fields the protocol defines, or the fix trades a
	// 400 for a tool result the model cannot pair with its call.
	if sent["tool_call_id"] != "chatcmpl-tool-87eadf8d31c8bb9d" {
		t.Errorf("tool_call_id = %v, want it preserved", sent["tool_call_id"])
	}
	if sent["content"] != toolMessage["content"] {
		t.Errorf("content = %v, want the reference preserved", sent["content"])
	}
	// And the caller's message is not the thing that was edited: the session file
	// still has to carry the field, that is how an artifact is found again.
	if toolMessage["artifact_id"] != "art_f7e0211e7551" {
		t.Error("the fix mutated the session message instead of the wire copy")
	}
}

// TestTheWireWhitelistKeepsEveryFieldTheShapeDefines: the filter is a whitelist,
// so the risk it introduces is over-redaction — dropping a field a gateway needs
// and producing a confusing reply instead of a refusal.
func TestTheWireWhitelistKeepsEveryFieldTheShapeDefines(t *testing.T) {
	dialect := openaiDialect{}
	message := map[string]any{
		"role":         "tool",
		"content":      "body",
		"tool_call_id": "call_1",
		"name":         "read_file",
		"tool_calls":   []any{},
		"artifact_id":  "art_deadbeef",
		"pinned":       true,
	}
	got := dialect.onTheWireMessage(message, false)

	for _, key := range []string{"role", "content", "tool_call_id", "name", "tool_calls"} {
		if _, present := got[key]; !present {
			t.Errorf("%q was dropped from the wire message", key)
		}
	}
	for _, key := range []string{"artifact_id", "pinned"} {
		if _, present := got[key]; present {
			t.Errorf("%q reached the wire message", key)
		}
	}
	if len(message) != 7 {
		t.Errorf("the input message was mutated down to %d keys", len(message))
	}
}

// TestReasoningIsSentBackOnlyWhenTheEndpointAskedForIt is the regression for a
// fatal 400 that made a session impossible to continue.
//
// A thinking endpoint requires the assistant turn it produced to come back with its
// `reasoning_content`, and refuses the whole request by name without it — measured
// on opencode-go / deepseek-v4.1-flash:
//
//	The `reasoning_content` in the thinking mode must be passed back to the API.
//
// The field is not part of the base chat completions shape, though, so an endpoint
// that has never heard of it can refuse the message *for carrying* it. Neither
// answer may be assumed, which is why the flag exists and why both directions are
// pinned here: the request the endpoint asked for, and the request to one that has
// not asked.
func TestReasoningIsSentBackOnlyWhenTheEndpointAskedForIt(t *testing.T) {
	dialect := openaiDialect{}
	message := map[string]any{
		"role":              "assistant",
		"content":           nil,
		"reasoning_content": "I should read the file first.",
		"tool_calls": []any{map[string]any{
			"id": "call_1", "type": "function",
			"function": map[string]any{"name": "read_file", "arguments": `{"path":"a.txt"}`},
		}},
	}

	sent := dialect.onTheWireMessage(message, true)
	if sent["reasoning_content"] != "I should read the file first." {
		t.Errorf("reasoning_content = %#v, want the thinking sent back", sent["reasoning_content"])
	}
	// The rest of the turn has to survive the same pass, or the fix trades one 400
	// for a tool result the model cannot pair with its call.
	if _, present := sent["tool_calls"]; !present {
		t.Error("the tool calls were dropped along with the whitelist change")
	}

	withheld := dialect.onTheWireMessage(message, false)
	if _, present := withheld["reasoning_content"]; present {
		t.Errorf("reasoning_content reached an endpoint that never asked for it: %#v", withheld)
	}
	// Dropping the field must not drop the message: an assistant turn that asked for
	// a tool is still an assistant turn that asked for a tool.
	if _, present := withheld["tool_calls"]; !present {
		t.Error("the tool calls were dropped with the field")
	}
	// And the caller's own message is not the thing that was edited — the session
	// file keeps the thinking whether or not this endpoint is sent it.
	if message["reasoning_content"] != "I should read the file first." {
		t.Error("the filter mutated the session message instead of the wire copy")
	}
}

// messagesOf reads the `messages` array out of a request body.
func messagesOf(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, _ := body["messages"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		entry, _ := item.(map[string]any)
		out = append(out, entry)
	}
	return out
}

// requestedRole reports whether any message carries this role.
func requestedRole(t *testing.T, body map[string]any, role string) (map[string]any, bool) {
	t.Helper()
	for _, message := range messagesOf(t, body) {
		if message["role"] == role {
			return message, true
		}
	}
	return nil, false
}

// blockOf finds the first content block of a given type in one message.
func blockOf(t *testing.T, message map[string]any, kind string) map[string]any {
	t.Helper()
	blocks, _ := message["content"].([]any)
	for _, item := range blocks {
		block, ok := item.(map[string]any)
		if ok && block["type"] == kind {
			return block
		}
	}
	t.Fatalf("no %s block in %#v", kind, message)
	return nil
}
