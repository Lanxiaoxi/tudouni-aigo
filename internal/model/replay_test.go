package model

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// reasoningRequiredGateway behaves like a thinking endpoint behind a gateway: any
// assistant turn that carries `tool_calls` without its `reasoning_content` is
// refused with the wording a real gateway used.
//
// The condition is deliberately not "the field is absent anywhere": it is the shape
// the measured failure had — a tool call whose thinking was left behind — and a
// gateway that refused plain answers would not be reproducing that.
func reasoningRequiredGateway(t *testing.T) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	bodies := &[]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		*bodies = append(*bodies, body)
		mu.Unlock()

		if !replayedThinkingInEveryToolCall(body) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"param":null,"type":"invalid_request_error",` +
				`"code":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] ` +
				`The ` + "`reasoning_content`" + ` in the thinking mode must be passed back to the API."}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],` +
			`"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	t.Cleanup(server.Close)
	return server, bodies
}

// replayedThinkingInEveryToolCall reports whether each assistant turn that asked for
// a tool carries the thinking that produced it.
func replayedThinkingInEveryToolCall(body map[string]any) bool {
	messages, _ := body["messages"].([]any)
	for _, item := range messages {
		message, _ := item.(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		if _, asks := message["tool_calls"]; !asks {
			continue
		}
		if replayed, ok := message["reasoning_content"].(string); !ok || replayed == "" {
			return false
		}
	}
	return true
}

// replayedHistory is one assistant turn of the shape the agent stores: it asked for
// a tool, and the audit carries the thinking that went with it.
func replayedHistory() []map[string]any {
	return []map[string]any{
		{"role": "user", "content": "look at docs"},
		{
			"role":              "assistant",
			"content":           nil,
			"reasoning_content": "I should list the directory first.",
			"tool_calls": []any{map[string]any{
				"id": "call_1", "type": "function",
				"function": map[string]any{"name": "shell", "arguments": `{"command":"ls docs"}`},
			}},
		},
		{"role": "tool", "tool_call_id": "call_1", "content": "20 files"},
	}
}

// TestTheAdapterLearnsThatAnEndpointNeedsTheThinkingReplayed is the regression for
// the fatal 400 that stopped a turn and then every later turn of the session: the
// assistant message is in the session file, so it is re-sent with the history for
// ever, and each request is refused the same way.
//
// Two things have to hold, and the second is the one that makes the failure
// survivable rather than merely reported: the endpoint is asked for its thinking
// *and* for the reasoning to be dropped, which no request from this side can
// satisfy — so the recovery is to send the field, not to send less. It is learned
// here, on the request that happened to carry the replayed history, so the rest of
// the session goes out right the first time.
func TestTheAdapterLearnsThatAnEndpointNeedsTheThinkingReplayed(t *testing.T) {
	server, bodies := reasoningRequiredGateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "thinking-required", StyleOpenAI),
		Thinking: true, Effort: "high",
	})
	forgetReplayReasoning(server.URL, "thinking-required")

	response, err := adapter.Complete(replayedHistory(), nil, CompleteOptions{})
	if err != nil {
		t.Fatalf("the first turn was not recovered: %v", err)
	}
	if response.Content == nil || *response.Content != "ok" {
		t.Fatalf("Content = %#v, want the retry to have succeeded", response.Content)
	}
	if len(*bodies) != 2 {
		t.Fatalf("the endpoint saw %d requests, want 2 (the refusal and the retry)", len(*bodies))
	}

	// The first attempt reproduces the failure: a tool call, no thinking, 400.
	first := (*bodies)[0]
	if replayedThinkingInEveryToolCall(first) {
		t.Error("the first attempt already carried the thinking, so nothing was learned")
	}
	// The retry sends the thinking back, and the rest of the turn with it.
	retry := (*bodies)[1]
	if !replayedThinkingInEveryToolCall(retry) {
		t.Errorf("the retry still omitted the thinking: %#v", retry)
	}
	sent, ok := requestedRole(t, retry, "assistant")
	if !ok {
		t.Fatal("the assistant turn disappeared from the retry")
	}
	if got := sent["reasoning_content"]; got != "I should list the directory first." {
		t.Errorf("reasoning_content = %#v, want the recorded thinking", got)
	}
	if _, present := sent["tool_calls"]; !present {
		t.Error("the tool calls were dropped from the retry")
	}
	// Asking the endpoint to stop thinking is not the recovery — it requires
	// thinking — so the retry must keep asking for it.
	if got := retry["reasoning_effort"]; got != "high" {
		t.Errorf("reasoning_effort on the retry = %v, want high", got)
	}

	// And the knowledge is kept: the next turn pays nothing to rediscover it. That
	// is the half that turns a permanent failure into a one-round-trip cost.
	if _, err := adapter.Complete(replayedHistory(), nil, CompleteOptions{}); err != nil {
		t.Fatalf("the second turn: %v", err)
	}
	if len(*bodies) != 3 {
		t.Fatalf("the endpoint saw %d requests in total, want 3 — the requirement was rediscovered", len(*bodies))
	}
	if !replayedThinkingInEveryToolCall((*bodies)[2]) {
		t.Errorf("the second turn went out without the thinking: %#v", (*bodies)[2])
	}
}

// TestTheReplayRequirementIsRememberedPerModel keeps the learning from spreading to
// endpoints that never asked: the refusal is a fact about one (endpoint, model), and
// a route that merely shares the base URL must not be sent a field it may refuse by
// name.
func TestTheReplayRequirementIsRememberedPerModel(t *testing.T) {
	forgetReplayReasoning("https://gateway.invalid", "one")
	forgetReplayReasoning("https://gateway.invalid", "two")

	if replayReasoningFor("https://gateway.invalid", "one") {
		t.Fatal("the endpoint was marked before it asked")
	}
	rememberReplayReasoningRequired("https://gateway.invalid", "one")

	if !replayReasoningFor("https://gateway.invalid", "one") {
		t.Error("the requirement was not remembered")
	}
	if replayReasoningFor("https://gateway.invalid", "two") {
		t.Error("the requirement leaked to another model on the same endpoint")
	}
	if replayReasoningFor("https://other.invalid", "one") {
		t.Error("the requirement leaked to another endpoint")
	}
}

// TestAnAnswerThatNeedsNoToolCallIsNeverAskedForThinkingBack keeps the recovery from
// becoming the default. An endpoint that has not refused anything is sent the
// base-shape request, because `reasoning_content` is not a field of that shape and
// some gateways refuse an unknown message field by name.
func TestAnAnswerThatNeedsNoToolCallIsNeverAskedForThinkingBack(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "plain", StyleOpenAI),
		Thinking: true, Effort: "high",
	})
	forgetReplayReasoning(server.URL, "plain")

	if _, err := adapter.Complete(replayedHistory(), nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("the endpoint saw %d requests, want 1: an accepted request was re-sent", len(*bodies))
	}
	sent, ok := requestedRole(t, (*bodies)[0], "assistant")
	if !ok {
		t.Fatal("the assistant turn did not reach the wire")
	}
	if _, present := sent["reasoning_content"]; present {
		t.Errorf("reasoning_content was sent to an endpoint that never asked for it: %#v", sent)
	}
}

// TestAThinkingRefusalIsNotConfusedWithAReplayRefusal pins the two recoveries apart.
//
// They arrive as the same status, from the same kind of endpoint, and they mention
// the same parameter — and they call for opposite requests. Mistaking one for the
// other replaces a recoverable refusal with a model this process can never call
// again: the thinking instruction is dropped for the rest of the run, so `/thinking
// on` becomes a silent no-op while the display says otherwise.
//
// The wording here is the real one, from a real endpoint. It mentions
// `reasoning_content`, and the request it refuses is one that asked for thinking —
// so it must not be read as "stop thinking".
func TestAThinkingRefusalIsNotConfusedWithAReplayRefusal(t *testing.T) {
	replay := strings.ToLower(`{"error":{"message":"Upstream request failed: [invalid_request_error] ` +
		`The ` + "`reasoning_content`" + ` in the thinking mode must be passed back to the API."}}`)
	if !isReasoningReplayRefusal(replay) {
		t.Error("the replay refusal was not recognised")
	}
	if isThinkingRefusal(replay) {
		t.Error("the replay refusal was read as a refusal to think, which is the opposite recovery")
	}
	// The whole classification, on the wrapper the endpoint actually sent: it is what
	// decides which recovery runs, and the two recoveries are opposite.
	if _, ok := classifyHTTPError(http.StatusBadRequest, replay, "https://gateway.invalid/chat/completions", true).
		(*reasoningReplayRejection); !ok {
		t.Error("a 400 asking for the thinking back was not classified as a replay rejection")
	}

	// The other direction, with the wording two real models used. Neither of these
	// mentions `reasoning_content`, and both must still be read as "cannot stop".
	for _, body := range []string{
		`glm-5.3 is a thinking-only model; disabling thinking (reasoning_effort='none') is not supported`,
		`invalid thinking: only type=enabled is allowed for this model`,
	} {
		if !isThinkingRefusal(body) {
			t.Errorf("a thinking refusal was not recognised: %s", body)
		}
		if isReasoningReplayRefusal(body) {
			t.Errorf("a thinking refusal was read as a replay refusal: %s", body)
		}
	}

	// A 400 that merely names the parameter is neither: `reasoning_effort` is the
	// vocabulary the whole thinking mode is discussed in, so an endpoint explaining
	// an unrelated problem mentions it too.
	other := `{"error":{"message":"invalid value for reasoning_effort: 'minimal' is not supported by this model"}}`
	if isThinkingRefusal(other) || isReasoningReplayRefusal(other) {
		t.Errorf("an unrelated complaint about reasoning_effort was classified as a thinking refusal: %s", other)
	}
}
