package model

import (
	"encoding/json"
)

// openaiDialect speaks the chat completions shape: POST /chat/completions, a
// `choices` array, `reasoning_content` for thinking, `role: "tool"` for results.
//
// This is the shape the adapter was born with and it is still the default. The
// code here is what used to be spread through openai.go; it was moved, not
// rewritten, so a route with no `api_style` sends exactly the bytes it sent
// before.
type openaiDialect struct{}

func (openaiDialect) path() string { return "/chat/completions" }

// wantsStreamOptions is true: `stream_options.include_usage` is a parameter of
// this family, and dropping it after a rejection is the recovery that exists for
// it.
func (openaiDialect) wantsStreamOptions() bool { return true }

// credentialHeader is the Authorization header: this family authenticates with a
// bearer token.
func (openaiDialect) credentialHeader() string { return credentialHeaderBearer }

func (openaiDialect) encode(request dialectRequest) (map[string]any, error) {
	body := map[string]any{
		"model":    request.model,
		"messages": request.messages,
	}
	if len(request.tools) > 0 {
		body["tools"] = request.tools
	}
	applyOpenAIRequestFields(body, request.knobs)
	if request.stream {
		body["stream"] = true
		if request.includeStreamUsage {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	return body, nil
}

func (openaiDialect) parseUnary(raw []byte) (ModelResponse, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ModelResponse{}, AsFatal("the response is not JSON: %v", err)
	}

	choices, _ := payload["choices"].([]any)
	if len(choices) == 0 {
		return ModelResponse{}, AsFatal("the response has no choices")
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)

	result := ModelResponse{
		Usage:     extractUsage(payload["usage"]),
		Reasoning: extractReasoning(message),
	}
	if content, ok := message["content"].(string); ok {
		result.Content = &content
	}
	result.ToolCalls = parseToolCallItems(message["tool_calls"], []string{"id"}, []string{"name"})
	return result, nil
}

func (openaiDialect) parseStream(body reader, sink DeltaSink, shouldStop func() bool) (ModelResponse, error) {
	return readSSE(body, sink, shouldStop, func(chunk map[string]any, accumulator *responseAccumulator) error {
		// Usage may arrive on its own chunk, including the one after the last
		// content chunk, so it is read before anything else looks at `choices`.
		if usage := extractUsage(chunk["usage"]); usage != nil {
			accumulator.usage = usage
		}

		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			return nil
		}
		choice, _ := choices[0].(map[string]any)
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			return nil
		}

		if text, ok := delta["content"].(string); ok && text != "" {
			accumulator.text(text)
			if sink != nil {
				sink(text, "")
			}
		}
		if reasoning := extractReasoning(delta); reasoning != nil && *reasoning != "" {
			accumulator.reasoningText(*reasoning)
			if sink != nil {
				sink("", *reasoning)
			}
		}
		accumulator.toolCalls(delta["tool_calls"])
		return nil
	})
}

// applyOpenAIRequestFields merges the thinking knobs into a chat completions body.
//
// `state.RequestFields` describes the parameters the way the previous generation
// wrote them: in SDK terms. Over there the dict goes to
// `chat.completions.create(**fields)`, and the SDK treats `extra_body` as an
// **escape hatch** — it merges that object into the top level of the JSON it
// sends, which is the only way to reach a field the SDK has no type for. So the
// wire body carries a top-level `thinking`, and the endpoint never sees the string
// "extra_body".
//
// This package writes the JSON itself, so there is no SDK to do that merge. Copying
// the fields across verbatim would put a literal `extra_body` object on the wire
// and no `thinking` at all: `/thinking off` would reach the endpoint as nothing,
// thinking would stay on and keep being billed, and a strict gateway would reject
// the unknown parameter outright.
func applyOpenAIRequestFields(body map[string]any, knobs ReasoningKnobs) {
	if knobs.omit {
		// Nothing to say. A thinking-only model answers 400 to any explicit "do not
		// think" instruction, and the only request it accepts is silent on the
		// subject — so silence is what this state means, and it is different from
		// "off".
		return
	}
	if knobs.Thinking {
		body["reasoning_effort"] = knobs.Effort
		body["thinking"] = map[string]any{"type": "enabled"}
		return
	}
	// When thinking is off, only the disabled marker is sent and no
	// `reasoning_effort` goes out at all. Sending both would be asking the
	// endpoint to reconcile a contradiction, and whichever way it resolves it,
	// the bill shows it.
	//
	// This form is what the endpoints this program was built against expect, and it
	// is worth keeping: replacing it with silence would make `/thinking off` a
	// no-op on every model that merely *defaults* to thinking on. A model that
	// cannot comply is handled by the refusal-and-retry in `Complete`, which
	// produces this state's silence for that model alone.
	body["thinking"] = map[string]any{"type": "disabled"}
}

// extractReasoning reads the thinking text from a message or a streaming delta.
//
// A gateway without the field, or with it set to null or to something that is not
// a string, is not an error: the feature is optional, and saying nothing is the
// correct reading of "nothing there".
func extractReasoning(message map[string]any) *string {
	if message == nil {
		return nil
	}
	for _, key := range []string{"reasoning_content", "reasoning"} {
		if text, ok := message[key].(string); ok && text != "" {
			return &text
		}
	}
	return nil
}

// extractUsage normalises an OpenAI-shaped usage block.
//
// The cache hit count comes from the standard `prompt_tokens_details.cached_tokens`
// rather than a provider-specific field: this dialect is called "OpenAI
// compatible", so a vendor extension must not be a required part of it.
func extractUsage(raw any) *TokenUsage {
	block, ok := raw.(map[string]any)
	if !ok {
		// No usage block means "unknown", not "zero". A gateway that does not send
		// one has not spent nothing.
		return nil
	}
	usage := &TokenUsage{
		PromptTokens:     intOf(block["prompt_tokens"]),
		CompletionTokens: intOf(block["completion_tokens"]),
	}
	if details, ok := block["prompt_tokens_details"].(map[string]any); ok {
		usage.CachedTokens = intOf(details["cached_tokens"])
	}
	return usage
}

func intOf(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}

// firstString returns the first key that holds a non-empty string.
func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := object[key].(string); ok && text != "" {
			return text
		}
	}
	return ""
}
