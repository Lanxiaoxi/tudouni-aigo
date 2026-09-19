package model

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// TestTheMessagesStreamKeepsThePromptUsage follows the protocol's real shape rather
// than a convenient one.
//
// The usage of one Messages request is split across two events, and not symmetrically:
// `message_start` reports the prompt with its cache counts, and `message_delta` reports
// the final `output_tokens` and **nothing else**. Treating the later block as a
// replacement zeroed the prompt side of a real measurement, on every streamed call,
// which is the kind of wrong number that looks plausible — the prompt total, the cache
// hit rate and the context percentage all simply read lower than the truth.
//
// The test that was here before handed `message_delta` a block carrying `input_tokens`,
// which no endpoint sends, so it could not see the difference.
func TestTheMessagesStreamKeepsThePromptUsage(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "message_start", "message": map[string]any{
			"id": "msg_1",
			"usage": map[string]any{
				"input_tokens": 1000, "cache_read_input_tokens": 800, "output_tokens": 1,
			},
		}},
		map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""}},
		map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": "hi"}},
		map[string]any{"type": "content_block_stop", "index": 0},
		map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": 42}},
		map[string]any{"type": "message_stop"},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleAnthropic)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if response.Usage == nil {
		t.Fatal("the stream reported no usage at all")
	}
	if response.Usage.PromptTokens != 1000 || response.Usage.CachedTokens != 800 {
		t.Errorf("usage = %+v, want the prompt side kept from message_start", *response.Usage)
	}
	if response.Usage.CompletionTokens != 42 {
		t.Errorf("completion = %d, want the final output count from message_delta",
			response.Usage.CompletionTokens)
	}
}

// TestOmitWritesNothingAboutReasoning pins the third state of the thinking switch.
//
// `omit` is what `Complete` retries with after an endpoint refused to be told "do not
// think": that model accepts only a request which does not mention reasoning at all. The
// Messages dialect never read the flag, and with thinking off it *always* wrote
// `{"type":"disabled"}` — the exact shape that had just been refused. The retry was a
// byte-for-byte copy of the request that failed, so the route was marked unusable and
// the model could never be called again.
func TestOmitWritesNothingAboutReasoning(t *testing.T) {
	request := dialectRequest{
		model:    "m",
		messages: []map[string]any{{"role": "user", "content": "hi"}},
	}

	request.knobs = ReasoningKnobs{Thinking: false, Effort: "low", omit: true}
	omitted, err := anthropicDialect{}.encode(request)
	if err != nil {
		t.Fatal(err)
	}
	if thinking, present := omitted["thinking"]; present {
		t.Fatalf("`omit` still wrote a reasoning instruction: %#v", thinking)
	}

	// The other two states still say what they mean.
	request.knobs = ReasoningKnobs{Thinking: true, Effort: "low"}
	enabled, err := anthropicDialect{}.encode(request)
	if err != nil {
		t.Fatal(err)
	}
	if thinking, _ := enabled["thinking"].(map[string]any); thinking["type"] != "enabled" {
		t.Errorf("thinking on wrote %#v", enabled["thinking"])
	}

	request.knobs = ReasoningKnobs{Thinking: false, Effort: "low"}
	disabled, err := anthropicDialect{}.encode(request)
	if err != nil {
		t.Fatal(err)
	}
	if thinking, _ := disabled["thinking"].(map[string]any); thinking["type"] != "disabled" {
		t.Errorf("thinking off wrote %#v", disabled["thinking"])
	}
}

// TestAZeroedUsageBlockIsUnknownNotFree is the guard the chat completions dialect was
// missing while the other two had it.
//
// A block whose counters are all zero is a gateway that sends the field without
// measuring anything, or one that sends it on a frame where it means nothing yet.
// Recording it as a measurement puts a real call into the audit as having cost nothing,
// and the hit rate and the context percentage are then computed from it.
func TestAZeroedUsageBlockIsUnknownNotFree(t *testing.T) {
	for _, block := range []map[string]any{
		{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
		{"prompt_tokens_details": map[string]any{"cached_tokens": 0}},
		{},
	} {
		if usage := extractUsage(block); usage != nil {
			t.Errorf("a zeroed usage block was recorded as a measurement: %+v", *usage)
		}
	}

	// One real number is enough to make it a measurement.
	usage := extractUsage(map[string]any{"prompt_tokens": 10, "completion_tokens": 0})
	if usage == nil || usage.PromptTokens != 10 {
		t.Errorf("a real usage block was dropped: %#v", usage)
	}
}

// TestATruncatedErrorBodyIsStillValidUTF8: these endpoints answer a bad request in
// Chinese, so a byte slice at an arbitrary offset lands inside a character about half
// the time — and the error string travels into the audit and onto the screen.
func TestATruncatedErrorBodyIsStillValidUTF8(t *testing.T) {
	body := strings.Repeat("上下文太长了，请减少一些内容。", 200)
	err := classifyHTTPError(400, body, "http://example.invalid/v1/messages", false)
	if err == nil {
		t.Fatal("a 400 was classified as no error")
	}
	if !utf8.ValidString(err.Error()) {
		t.Errorf("the truncated error body is not valid UTF-8: %q", err.Error())
	}
}
