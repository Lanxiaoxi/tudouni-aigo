package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestOneShotLeavesTheSessionUntouched pins the whole reason the side call is a
// sibling of Complete: a thinking-only model refusing "do not think" is recovered
// for this request alone, and nothing the next turn reads — the process-wide
// endpoint memory, the adapter's own knobs — has moved.
func TestOneShotLeavesTheSessionUntouched(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		if _, said := body["reasoning_effort"]; said {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"m is a thinking-only model; disabling thinking is not supported"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"[\"push\"]"}}]}`))
	}))
	defer server.Close()

	adapter := newTestAdapter(t, Options{Route: route(server.URL, "oneshot-thinking-only", StyleOpenAI), Thinking: true, Effort: "high"})
	response, err := adapter.CompleteOneShot(context.Background(), []map[string]any{{"role": "user", "content": "hi"}})
	if err != nil {
		t.Fatalf("CompleteOneShot: %v", err)
	}
	if response.Content == nil || *response.Content != `["push"]` {
		t.Fatalf("content = %v", response.Content)
	}
	if len(bodies) != 2 {
		t.Fatalf("the gateway saw %d requests, want 2 (off, then silent)", len(bodies))
	}
	if got := bodies[0]["reasoning_effort"]; got != offEffort {
		t.Errorf("first attempt reasoning_effort = %v, want %q", got, offEffort)
	}
	for i, body := range bodies {
		if _, streamed := body["stream"]; streamed {
			t.Errorf("attempt %d asked for a stream", i)
		}
		if _, asked := body["stream_options"]; asked {
			t.Errorf("attempt %d sent stream_options", i)
		}
	}
	if !thinkingInstructionSupported(server.URL, "oneshot-thinking-only") {
		t.Error("the side call wrote the thinking refusal into the process-wide memory; the next turn would drop the person's level")
	}
	if _, knobs := adapter.snapshot(); !knobs.Thinking || knobs.Effort != "high" {
		t.Errorf("adapter knobs changed to %+v", knobs)
	}
}

// TestOneShotDoesNotRetryAFailure: a side feature that retried a rate limit
// would spend the quota the next turn needs.
func TestOneShotDoesNotRetryAFailure(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"slow down"}`))
	}))
	defer server.Close()

	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
	if _, err := adapter.CompleteOneShot(context.Background(), []map[string]any{{"role": "user", "content": "hi"}}); err == nil {
		t.Fatal("want an error for a 429")
	}
	if calls != 1 {
		t.Errorf("the gateway saw %d requests, want exactly 1", calls)
	}
}

// TestOneShotIsCancelled: a new turn cancels the side call, and that must come
// back as a cancellation rather than a model failure.
func TestOneShotIsCancelled(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)

	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := adapter.CompleteOneShot(ctx, []map[string]any{{"role": "user", "content": "hi"}})
	if !IsCancelled(err) {
		t.Fatalf("err = %v, want a cancellation", err)
	}
}
