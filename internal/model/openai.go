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

// onTheWireMessage keeps only the fields the chat completions shape defines, for
// the messages whose fields are all strings or arrays of objects and therefore
// need no rebuilding.
//
// The four roles this program sends are:
//
//	system     {role, content}
//	user       {role, content}
//	assistant  {role, content, tool_calls}
//	tool       {role, content, tool_call_id, name}
//
// `name` is kept because it is the documented optional field of these roles, even
// though nothing here sets it — a gateway that reads it should not be sent a
// request that means something else. Everything else is dropped, and what that
// currently drops is `artifact_id`, a field of this program's session format.
//
// The whitelist is a property of OpenAI's shape rather than of this program, so it
// lives with the dialect: the day a second shape accepts the list whole it needs
// its own list, and the day this one gains a field the whitelist has to be told.
func (openaiDialect) onTheWireMessage(message map[string]any) map[string]any {
	clean := make(map[string]any, 4)
	for _, key := range []string{"role", "content", "tool_calls", "tool_call_id", "name"} {
		if value, ok := message[key]; ok {
			clean[key] = value
		}
	}
	return clean
}

func (openaiDialect) encode(request dialectRequest) (map[string]any, error) {
	messages := make([]map[string]any, 0, len(request.messages))
	for _, message := range request.messages {
		messages = append(messages, openaiDialect{}.onTheWireMessage(message))
	}
	body := map[string]any{
		"model":    request.model,
		"messages": messages,
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

// applyOpenAIRequestFields writes the reasoning switch into a chat completions body.
//
// **One field, not two.** This dialect used to send `thinking: {"type": "enabled"}` or
// `{"type": "disabled"}` beside `reasoning_effort`, because that is what the previous
// generation wrote: the OpenAI SDK treats `extra_body` as an escape hatch and merges
// it into the top level, so the field reached the wire without the SDK having a type
// for it. Writing the JSON by hand has no such requirement, and the second field
// turned out to be pure liability — measured against a real gateway it is redundant
// (`reasoning_effort` alone expresses on, off and the level), and an upstream that
// does not know the field rejects the whole request with `json: unknown field
// "thinking"`. A field nobody needs is not free: it is a rejection waiting for the one
// gateway that has never heard of it.
//
// `"none"` is how thinking is turned off, and it is a real value of this parameter
// rather than an invented one. It is not universally accepted — a thinking-only model
// refuses it by name — and that refusal is what `Complete` recovers from by sending
// the request again with nothing said about reasoning at all.
func applyOpenAIRequestFields(body map[string]any, knobs ReasoningKnobs) {
	if knobs.omit {
		// Nothing to say. A thinking-only model refuses an explicit "do not think"
		// instruction by name, and the only request it accepts is silent on the
		// subject — so silence is what this state means, and it is different from
		// "off".
		return
	}
	if knobs.Thinking {
		body["reasoning_effort"] = knobs.Effort
		return
	}
	body["reasoning_effort"] = offEffort
}

// offEffort is the value that means "do not reason".
//
// It is named rather than inlined because it is a protocol literal that appears in
// the request builder and in the refusal detection, and the two have to agree.
const offEffort = "none"

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
