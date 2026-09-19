package model

import (
	"encoding/json"
	"fmt"
)

// anthropicDialect speaks the Messages shape: POST /v1/messages, a top-level// `system`, `content` block arrays, `tool_use` / `tool_result` blocks, and
// `max_tokens` as a required field.
//
// The endpoints this reaches are Claude itself and the Anthropic-compatible
// surfaces of MiniMax, Qwen (Model Studio) and others. It is one protocol, so it
// is one implementation — a vendor difference that shows up here is a difference
// of *capability* (which effort levels an endpoint accepts, whether it supports
// thinking at all) and belongs in configuration or in an honest error, not in a
// fourth copy of this file.
type anthropicDialect struct{}

func (anthropicDialect) path() string { return "/v1/messages" }

// wantsStreamOptions is false: this protocol has no `include_usage` parameter.
// The usage block arrives on the `message_delta` event unconditionally, so there
// is nothing to drop and nothing to retry.
func (anthropicDialect) wantsStreamOptions() bool { return false }

// credentialHeader is `x-api-key`, and the bare key goes in it.
//
// This is not the same answer as the other two protocols give, and the difference
// was measured rather than assumed: against a real gateway serving this shape, a
// bearer token in `Authorization` is refused with "Missing API key" — a message
// that accuses the credential of being absent while it is sitting in the request.
// The official Anthropic API and the gateways that re-serve its shape agree on
// `x-api-key`, which is why this is a protocol fact rather than a setting.
func (anthropicDialect) credentialHeader() string { return "x-api-key" }

// Thinking budgets, in tokens.
//
// The Messages shape does not take a level; it takes a budget. The levels this
// program offers are the vocabulary the user sees, so they are translated here —
// the same mapping for every endpoint, with the per-endpoint effort vocabularies
// (Qwen's `output_config.effort`, glm's `high|max`) deliberately not modelled yet.
// They differ per *model*, not per protocol, and a guess at one of them would fail
// in a way that reads as the model refusing to think.
const (
	thinkingBudgetLow  = 4096
	thinkingBudgetHigh = 12288
	thinkingBudgetMax  = 32768
)

func thinkingBudget(effort string) int {
	switch effort {
	case "low":
		return thinkingBudgetLow
	case "max":
		return thinkingBudgetMax
	default:
		return thinkingBudgetHigh
	}
}

// maxOutputTokens is how much room the answer gets.
//
// It is a function of the thinking budget rather than a constant because the
// endpoint requires `max_tokens` to exceed `thinking.budget_tokens`, and because a
// thinking model that spends its whole allowance thinking returns an empty answer
// with `stop_reason: max_tokens` — which reads as the model having nothing to say.
// The two are set here in one place so that relationship cannot drift.
func maxOutputTokens(effort string) int { return thinkingBudget(effort) + 8192 }

// onTheWireMessage returns the message unchanged: this shape rebuilds every
// message field by field in `splitSystemPrompt` and `anthropicMessages`, so a key
// this program added to its own session format has no path to the wire. The
// method exists to satisfy the dialect interface honestly rather than to filter —
// see the interface for why the filter has to exist at all.
func (anthropicDialect) onTheWireMessage(message map[string]any) map[string]any {
	return message
}

func (anthropicDialect) encode(request dialectRequest) (map[string]any, error) {
	system, messages, err := splitSystemPrompt(request.messages)
	if err != nil {
		return nil, err
	}

	body := map[string]any{
		"model":      request.model,
		"messages":   messages,
		"max_tokens": maxOutputTokens(request.knobs.Effort),
	}
	// `system` is omitted rather than sent as an empty string: the field is
	// optional, and an empty one is a prompt the model has to interpret.
	if system != "" {
		body["system"] = system
	}
	if len(request.tools) > 0 {
		body["tools"] = anthropicTools(request.tools)
	}

	// The thinking switch is mapped onto this protocol's own parameter. There is
	// no `reasoning_effort` in this shape, and there is no `thinking` field in the
	// chat completions shape: sending either one to the wrong endpoint is an
	// unknown-parameter rejection.
	if request.knobs.Thinking {
		body["thinking"] = map[string]any{
			"type":          "enabled",
			"budget_tokens": thinkingBudget(request.knobs.Effort),
		}
	} else {
		body["thinking"] = map[string]any{"type": "disabled"}
	}

	if request.stream {
		body["stream"] = true
	}
	return body, nil
}

// anthropicTools rewrites tool definitions into this protocol's shape.
//
// The change is small and load-bearing: chat completions nests the schema under
// `function` and calls it `parameters`, while this shape flattens the entry and
// calls it `input_schema`. Passing the OpenAI shape through produces a request the
// endpoint refuses for every tool — that is, once the model would first want one,
// which is late enough to look like a tool problem rather than a plumbing problem.
func anthropicTools(tools []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		function, ok := tool["function"].(map[string]any)
		if !ok {
			// Already flat: a caller that built this shape itself is left alone.
			out = append(out, tool)
			continue
		}
		entry := map[string]any{"name": firstString(function, "name")}
		if description := firstString(function, "description"); description != "" {
			entry["description"] = description
		}
		if schema, present := function["parameters"]; present {
			entry["input_schema"] = schema
		}
		out = append(out, entry)
	}
	return out
}

// splitSystemPrompt lifts the system message out of the array and rewrites the
// rest into content blocks.
//
// The Messages shape has no `system` role — `system` is a top-level field — and no
// `tool` role: a tool result is a `user` message carrying a `tool_result` block.
// Both facts have to be applied to every request, including the ones that resume a
// long conversation, which is why this runs on the whole history rather than being
// arranged once at the start.
func splitSystemPrompt(messages []map[string]any) (string, []map[string]any, error) {
	system := ""
	out := make([]map[string]any, 0, len(messages))

	for _, message := range messages {
		switch role, _ := message["role"].(string); role {
		case "system":
			text, _ := message["content"].(string)
			if system != "" && text != "" {
				system += "\n\n"
			}
			system += text

		case "tool":
			out = append(out, map[string]any{
				"role": "user",
				"content": []any{map[string]any{
					"type":        "tool_result",
					"tool_use_id": firstString(message, "tool_call_id"),
					"content":     stringifyContent(message["content"]),
				}},
			})

		case "assistant":
			out = append(out, anthropicAssistantMessage(message))

		default:
			out = append(out, map[string]any{
				"role":    role,
				"content": textBlocks(stringifyContent(message["content"])),
			})
		}
	}

	if len(out) == 0 {
		// A request with no turns left after the system prompt was lifted out is
		// refused by the endpoint as an empty message list, and the message it
		// returns names `messages` rather than the thing that was actually wrong.
		return "", nil, AsFatal("every message in this request was a system prompt, and the Messages protocol needs at least one conversation turn")
	}
	return system, out, nil
}

// anthropicAssistantMessage renders one assistant turn, including the tool calls
// it asked for.
//
// The calls are not optional to reproduce: an assistant turn that asked for a tool
// must be followed by its result, and the endpoint matches them by `tool_use_id`. A
// turn whose calls were dropped turns the next `tool_result` into a reference to
// something that does not exist, which the endpoint refuses for the whole request.
func anthropicAssistantMessage(message map[string]any) map[string]any {
	blocks := []any{}
	if text := stringifyContent(message["content"]); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	if calls, ok := message["tool_calls"].([]any); ok {
		for _, item := range calls {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			function, _ := entry["function"].(map[string]any)
			call := map[string]any{
				"type":  "tool_use",
				"id":    firstString(entry, "id"),
				"name":  firstString(function, "name"),
				"input": parseArguments(firstString(function, "arguments")),
			}
			if call["name"] == "" {
				continue
			}
			blocks = append(blocks, call)
		}
	}
	return map[string]any{"role": "assistant", "content": blocks}
}

// textBlocks wraps text in the content array this protocol expects.
//
// A bare string is accepted too, but only where the content is a plain text
// block; using the array everywhere means one shape to reason about, and it is
// the shape that the tool blocks require anyway.
func textBlocks(text string) []any {
	return []any{map[string]any{"type": "text", "text": text}}
}

// stringifyContent renders a message body as text.
func stringifyContent(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(encoded)
	}
}

// parseArguments turns the JSON text of a tool call's arguments back into the
// object this protocol wants in `input`.
//
// Unparseable arguments become an empty object rather than an error: the text came
// out of this program's own history, and a session with one malformed call in it
// would otherwise become impossible to resume. An empty object is a call with no
// arguments, which is the closest honest reading.
func parseArguments(raw string) map[string]any {
	if raw == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}
	}
	return out
}

func (anthropicDialect) parseUnary(raw []byte) (ModelResponse, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ModelResponse{}, AsFatal("the response is not JSON: %v", err)
	}

	blocks, _ := payload["content"].([]any)
	if len(blocks) == 0 {
		return ModelResponse{}, AsFatal("the response has no content blocks")
	}
	return readContentBlocks(blocks, extractAnthropicUsage(payload["usage"])), nil
}

func (anthropicDialect) parseStream(body reader, sink DeltaSink, shouldStop func() bool) (ModelResponse, error) {
	// blocks remembers which tool call each content-block index belongs to.
	// This protocol's deltas carry only an index, so without it a fragment of
	// arguments cannot be attributed to the call it belongs to.
	blocks := map[int]*ToolCall{}

	return readSSE(body, sink, shouldStop, func(chunk map[string]any, accumulator *responseAccumulator) error {
		switch firstString(chunk, "type") {
		case "message_start":
			message, _ := chunk["message"].(map[string]any)
			if usage := extractAnthropicUsage(message["usage"]); usage != nil {
				accumulator.usage = usage
			}

		case "content_block_start":
			block, _ := chunk["content_block"].(map[string]any)
			if firstString(block, "type") != "tool_use" {
				// Text and thinking blocks announce nothing useful here: their
				// content arrives in the deltas below.
				return nil
			}
			call := &ToolCall{ID: firstString(block, "id"), Name: firstString(block, "name")}
			blocks[intOf(chunk["index"])] = call
			// `input` is an empty object at this point, and the arguments are
			// assembled from `input_json_delta` fragments. It is deliberately not
			// read here: doing so would put "{}" in front of the real arguments.
			accumulator.toolFragment(intOf(chunk["index"]), call.ID, call.Name, "", false)

		case "content_block_delta":
			delta, _ := chunk["delta"].(map[string]any)
			switch firstString(delta, "type") {
			case "text_delta":
				if text := firstString(delta, "text"); text != "" {
					accumulator.text(text)
					if sink != nil {
						sink(text, "")
					}
				}
			case "thinking_delta":
				if text := firstString(delta, "thinking"); text != "" {
					accumulator.reasoningText(text)
					if sink != nil {
						sink("", text)
					}
				}
			case "input_json_delta":
				index := intOf(chunk["index"])
				fragment := firstString(delta, "partial_json")
				call := blocks[index]
				if call == nil || fragment == "" {
					return nil
				}
				accumulator.toolFragment(index, "", "", fragment, true)
			}

		case "message_delta":
			// The complete usage block arrives last, and it replaces the partial
			// one from `message_start` rather than accumulating onto it: both
			// describe the same request.
			if usage := extractAnthropicUsage(chunk["usage"]); usage != nil {
				accumulator.usage = usage
			}

		case "error":
			// This protocol reports a mid-stream failure as an event, with no
			// HTTP status to classify. Letting it fall through as an unknown
			// event would return a truncated answer as if it were complete.
			return fmt.Errorf("the endpoint reported an error mid-stream: %s", failureText(chunk))
		}
		// `content_block_stop`, `message_stop` and `ping` carry nothing.
		return nil
	})
}

// readContentBlocks folds a whole (non-streamed) `content` array.
func readContentBlocks(blocks []any, usage *TokenUsage) ModelResponse {
	accumulator := newResponseAccumulator()
	accumulator.usage = usage

	for _, item := range blocks {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch firstString(block, "type") {
		case "text":
			accumulator.text(firstString(block, "text"))
		case "thinking":
			accumulator.reasoningText(firstString(block, "thinking"))
		case "tool_use":
			name := firstString(block, "name")
			if name == "" {
				continue
			}
			// The index is positional here, because a non-streamed response has
			// no interleaving to preserve. A missing id is left empty and filled
			// in by the accumulator, which mints one rather than sending an empty
			// identifier to a tool result that has to reference it.
			accumulator.toolFragment(accumulator.nextIndex(), firstString(block, "id"), name, stringifyArguments(block["input"]), true)
		}
	}
	result := accumulator.response(false)
	// This protocol reports no `usage` at all rather than sending zeros, so a
	// missing block stays nil — "unknown", not "free".
	return result
}

// extractAnthropicUsage normalises this protocol's usage block.
//
// The field names are different in every position that matters, and the cache
// field most of all: `cache_read_input_tokens` is where a cache hit is reported,
// and a normaliser that only knew the chat completions spelling would report every
// cached token as a miss. That failure is silent — the number would simply look
// worse than it is — which is why it is worth the mapping.
func extractAnthropicUsage(raw any) *TokenUsage {
	block, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	usage := &TokenUsage{
		PromptTokens:     intOf(block["input_tokens"]),
		CompletionTokens: intOf(block["output_tokens"]),
		CachedTokens:     intOf(block["cache_read_input_tokens"]),
	}
	if usage.PromptTokens == 0 && usage.CompletionTokens == 0 && usage.CachedTokens == 0 {
		// A usage object with nothing in it is the `message_start` event, whose
		// counters are all zero by design. Reporting it as a measurement would
		// record a real request as having cost nothing.
		return nil
	}
	return usage
}
