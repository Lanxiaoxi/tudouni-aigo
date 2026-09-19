package model

import "testing"

// TestAStreamedFinishReasonIsKept — the endpoint's own answer to "why did this
// generation end" used to be dropped on the floor.
//
// It is the only field that separates two outcomes that look identical from above:
// a generation the endpoint cut off because the output budget ran out, and one that
// ended deliberately with nothing to say. A thinking model that spends its whole
// allowance returns `content: null`, no tool call and `finish_reason: "length"` —
// and with the marker dropped, the audit recorded that step as an ordinary empty
// answer, which is exactly the confusion a reader spent an evening chasing.
//
// The chunk that carries the marker carries no content, which is why it has to be
// read before the delta is examined rather than after.
func TestAStreamedFinishReasonIsKept(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"choices": []any{map[string]any{
			"index": 0, "delta": map[string]any{"reasoning_content": "thinking..."},
		}}},
		map[string]any{"choices": []any{map[string]any{
			"index": 0, "delta": map[string]any{}, "finish_reason": "length",
		}}},
		map[string]any{"choices": []any{}, "usage": map[string]any{
			"prompt_tokens": 40, "completion_tokens": 4096,
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if response.FinishReason != "length" {
		t.Errorf("FinishReason = %q, want length", response.FinishReason)
	}
	if response.Content != nil {
		t.Errorf("Content = %#v, want nil: this step produced no answer", response.Content)
	}
	if len(response.ToolCalls) != 0 {
		t.Errorf("ToolCalls = %#v, want none", response.ToolCalls)
	}
	if response.Usage == nil || response.Usage.CompletionTokens != 4096 {
		t.Errorf("Usage = %#v, want the endpoint's own count", response.Usage)
	}
}

// TestAUnaryFinishReasonIsKept covers the non-streamed path, which reads the marker
// from the choice rather than from a chunk.
func TestAUnaryFinishReasonIsKept(t *testing.T) {
	server, _, _ := dialectGateway(t, `{
		"choices": [{"message": {"role": "assistant", "content": null}, "finish_reason": "length"}],
		"usage": {"prompt_tokens": 40, "completion_tokens": 4096}
	}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if response.FinishReason != "length" {
		t.Errorf("FinishReason = %q, want length", response.FinishReason)
	}
}
