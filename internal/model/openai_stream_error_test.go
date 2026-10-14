package model

import (
	"strings"
	"testing"
)

// TestAMidStreamUpstreamErrorIsReported is the regression for a gateway that
// reports an upstream failure **inside** the stream while still answering 200.
//
// The body is the one measured on a real gateway: an `event: error` line, one
// data line carrying the error object, then [DONE]. Before the fix the parser
// skipped the event line, ignored the chunk (no `choices`), read [DONE] as a
// normal end, and the turn came back as a successful, empty answer — the
// `empty_response` the interface then showed as "the model thought but said
// nothing".
func TestAMidStreamUpstreamErrorIsReported(t *testing.T) {
	body := "event: error\n" +
		"data: {\"message\":\"upstream error\",\"code\":503}\n" +
		"\n" +
		"data: [DONE]\n" +
		"\n"
	server, _ := streamGateway(t, body)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err == nil {
		t.Fatal("a mid-stream 503 was reported as a successful, empty answer")
	}
	// The retry loop is the existing answer to an upstream that may well stop
	// being broken, so the classification has to be the one that reaches it.
	if IsFatal(err) {
		t.Errorf("the upstream 503 is classified fatal: %v", err)
	}
	if !strings.Contains(err.Error(), "upstream error") {
		t.Errorf("the error does not carry the endpoint's message: %v", err)
	}
	if !strings.Contains(err.Error(), "503") {
		t.Errorf("the error does not carry the code: %v", err)
	}
}

// TestTheErrorEnvelopeShapeIsReportedToo pins the other shape of this failure:
// the standard OpenAI error envelope, whose failure sits under `error` rather
// than at the top level.
func TestTheErrorEnvelopeShapeIsReportedToo(t *testing.T) {
	body := "data: {\"error\":{\"message\":\"boom\",\"type\":\"upstream_error\"}}\n" +
		"\n" +
		"data: [DONE]\n" +
		"\n"
	server, _ := streamGateway(t, body)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err == nil {
		t.Fatal("a mid-stream error envelope was reported as a successful, empty answer")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("the error does not carry the endpoint's message: %v", err)
	}
}

// TestAUsageOnlyTrailerIsNotMistakenForAnError pins the other side of the
// change: the one chunk without `choices` this program expects — the usage
// trailer — must still pass through silently, with its counters recorded.
func TestAUsageOnlyTrailerIsNotMistakenForAnError(t *testing.T) {
	body := sse(
		map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"role": "assistant", "content": "ok"},
			"finish_reason": "stop",
		}}},
		map[string]any{"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5}},
	)
	server, _ := streamGateway(t, body)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("a stream with a usage trailer failed: %v", err)
	}
	if response.Content == nil || *response.Content != "ok" {
		t.Errorf("Content = %#v, want the streamed text", response.Content)
	}
	if response.Usage == nil || response.Usage.CompletionTokens != 5 {
		t.Errorf("usage = %#v, want the trailer's counters", response.Usage)
	}
}
