package model

import (
	"encoding/json"
	"fmt"
)

// responsesDialect speaks the Responses shape: POST /v1/responses, an `input`
// item array, `function_call` / `function_call_output` items, and `reasoning`
// for the thinking knob.
//
// It is a different protocol from chat completions in every part that matters —
// the system prompt is an `instructions` field, the conversation is a flat item
// list rather than role-tagged messages, and a tool result is an item of its own
// rather than a message with a role. Treating it as "chat completions with a
// different path" produces a request that endpoint refuses, which is why it is a
// dialect and not a flag.
type responsesDialect struct{}

func (responsesDialect) path() string { return "/v1/responses" }

// wantsStreamOptions is false: usage arrives on the `response.completed` event
// unconditionally, so there is no `include_usage` parameter to drop.
func (responsesDialect) wantsStreamOptions() bool { return false }

// credentialHeader is the Authorization header: measured against a real gateway
// serving this shape, a bearer token authenticates here.
func (responsesDialect) credentialHeader() string { return credentialHeaderBearer }

// onTheWireMessage returns the message unchanged, for the same reason as the
// Messages shape: `splitResponsesInput` builds each item from named fields, so an
// unknown key cannot reach this protocol's wire. See the dialect interface.
//
// The replay flag is ignored here too: this protocol replays reasoning as a
// dedicated `reasoning` item with encrypted content, which is a different thing
// from a chat-completions message field.
func (responsesDialect) onTheWireMessage(message map[string]any, replayReasoning bool) map[string]any {
	return message
}

func (responsesDialect) encode(request dialectRequest) (map[string]any, error) {
	instructions, items, err := splitResponsesInput(request.messages)
	if err != nil {
		return nil, err
	}

	body := map[string]any{
		"model": request.model,
		"input": items,
		// The default is server-side storage, which turns a stateless CLI into a
		// client with a growing history of every conversation on somebody else's
		// disk. This program keeps its sessions locally and re-sends the history
		// it wants, so storage is asked for explicitly, per request, rather than
		// left to a default that could change under us.
		"store": false,
	}
	if instructions != "" {
		body["instructions"] = instructions
	}
	if len(request.tools) > 0 {
		body["tools"] = responsesTools(request.tools)
	}

	// The thinking switch maps onto this protocol's own parameter. As with the
	// Messages shape, the chat completions spelling is not accepted here, and
	// sending it is an unknown-parameter rejection.
	if request.knobs.Thinking {
		body["reasoning"] = map[string]any{
			"effort": effortOr(request.knobs.Effort, "high"),
			// `summary` is not decoration: this endpoint sends no reasoning
			// events at all unless a summary is asked for, so leaving it out would
			// silently turn the thinking display off while the model kept
			// thinking and billing for it.
			"summary": "auto",
		}
		// Stateless use with a reasoning model needs the model's encrypted
		// reasoning replayed on the next turn, and asking for it is how a
		// gateway is told to include it. Without it a multi-turn thinking
		// conversation either loses its reasoning between turns or is refused.
		body["include"] = []any{"reasoning.encrypted_content"}
	}
	// With thinking off the field is omitted entirely rather than sent as
	// `{"effort": "none"}`: this program's vocabulary has no "none" level, and
	// inventing one here would be a second, invisible place where the effort
	// levels are declared.

	if request.stream {
		body["stream"] = true
	}
	return body, nil
}

// responsesTools rewrites tool definitions into this protocol's shape.
//
// The difference from chat completions is one level of nesting: this shape is
// flat (`name`, `description`, `parameters` at the top of the entry) where the
// other nests everything under `function`. The schema key is `parameters` in both,
// unlike the Messages shape's `input_schema`.
func responsesTools(tools []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		function, ok := tool["function"].(map[string]any)
		if !ok {
			// Already flat.
			out = append(out, tool)
			continue
		}
		entry := map[string]any{"type": "function", "name": firstString(function, "name")}
		if description := firstString(function, "description"); description != "" {
			entry["description"] = description
		}
		if schema, present := function["parameters"]; present {
			entry["parameters"] = schema
		}
		out = append(out, entry)
	}
	return out
}

// splitResponsesInput lifts the system prompt out and rewrites the conversation
// into this protocol's flat item list.
//
// Three rewrites happen here, and all three are structural:
//
//   - the system prompt becomes the top-level `instructions` field, because the
//     item list has no role for it;
//   - a `tool` message becomes a `function_call_output` item of its own, because
//     a tool result is not a message in this shape;
//   - an assistant turn's `tool_calls` become `function_call` items **with their
//     output text dropped**, because the endpoint re-derives the model's own text
//     from the item list and rejects a message item that carries text the model
//     never produced.
func splitResponsesInput(messages []map[string]any) (string, []map[string]any, error) {
	instructions := ""
	items := make([]map[string]any, 0, len(messages))

	for _, message := range messages {
		switch role, _ := message["role"].(string); role {
		case "system":
			text, _ := message["content"].(string)
			if instructions != "" && text != "" {
				instructions += "\n\n"
			}
			instructions += text

		case "tool":
			items = append(items, map[string]any{
				"type":    "function_call_output",
				"call_id": firstString(message, "tool_call_id"),
				"output":  stringifyContent(message["content"]),
			})

		case "assistant":
			// The text of an assistant turn is sent back as an `output_text`
			// item: it is the model's own output being replayed, not new input,
			// and the two have different type names.
			if text := stringifyContent(message["content"]); text != "" && !hasToolCalls(message) {
				items = append(items, responsesMessage("assistant", "output_text", text))
			}
			for _, item := range responsesFunctionCalls(message["tool_calls"]) {
				items = append(items, item)
			}

		default:
			items = append(items, responsesMessage(role, "input_text", stringifyContent(message["content"])))
		}
	}

	if len(items) == 0 {
		return "", nil, AsFatal("every message in this request was a system prompt, and the Responses protocol needs at least one conversation item")
	}
	return instructions, items, nil
}

// responsesMessage renders one message item.
func responsesMessage(role, contentType, text string) map[string]any {
	return map[string]any{
		"type": "message",
		"role": role,
		"content": []any{map[string]any{
			"type": contentType,
			"text": text,
		}},
	}
}

// hasToolCalls reports whether an assistant turn asked for tools.
func hasToolCalls(message map[string]any) bool {
	calls, ok := message["tool_calls"].([]any)
	return ok && len(calls) > 0
}

// responsesFunctionCalls renders the calls of one assistant turn.
func responsesFunctionCalls(raw any) []map[string]any {
	calls, _ := raw.([]any)
	var out []map[string]any
	for _, item := range calls {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		function, _ := entry["function"].(map[string]any)
		name := firstString(function, "name")
		if name == "" {
			continue
		}
		id := firstString(entry, "id")
		out = append(out, map[string]any{
			"type": "function_call",
			// `call_id` is what a `function_call_output` references; `id` is this
			// item's own identifier. They are different fields with different
			// jobs, and putting the wrong one in produces a call that never
			// matches its result.
			"call_id":   id,
			"name":      name,
			"arguments": firstString(function, "arguments"),
		})
	}
	return out
}

func (responsesDialect) parseUnary(raw []byte) (ModelResponse, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ModelResponse{}, AsFatal("the response is not JSON: %v", err)
	}

	output, _ := payload["output"].([]any)
	accumulator := newResponseAccumulator()
	accumulator.usage = extractResponsesUsage(payload["usage"])
	accumulator.foldOutputItems(output)
	accumulator.finishReason = responsesFinishReason(payload)
	return accumulator.response(false), nil
}

// responsesFinishReason names why this shape's generation ended.
//
// This protocol has no `finish_reason` field: the state is `status`, and the
// reason a generation was cut short lives one level down in
// `incomplete_details.reason` (whose value for an output budget is
// `max_output_tokens`). Reading only `status` would report "incomplete" and drop
// the one word that says **why** — the same loss this field exists to prevent.
func responsesFinishReason(payload map[string]any) string {
	if details, ok := payload["incomplete_details"].(map[string]any); ok {
		if reason := firstString(details, "reason"); reason != "" {
			return reason
		}
	}
	return firstString(payload, "status")
}

func (responsesDialect) parseStream(body reader, sink DeltaSink, shouldStop func() bool) (ModelResponse, error) {
	// callIDs maps this protocol's function-call item id to the tool call being
	// assembled, because the argument deltas name the item rather than an index.
	callIDs := map[string]int{}
	nextIndex := 0
	sawDelta := false

	return readSSE(body, sink, shouldStop, func(chunk map[string]any, accumulator *responseAccumulator) error {
		switch firstString(chunk, "type") {
		case "response.output_text.delta":
			if text := firstString(chunk, "delta"); text != "" {
				sawDelta = true
				accumulator.text(text)
				if sink != nil {
					sink(text, "")
				}
			}

		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if text := firstString(chunk, "delta"); text != "" {
				sawDelta = true
				accumulator.reasoningText(text)
				if sink != nil {
					sink("", text)
				}
			}

		case "response.output_item.added":
			item, _ := chunk["item"].(map[string]any)
			if firstString(item, "type") != "function_call" {
				return nil
			}
			index := callIndex(callIDs, &nextIndex, item)
			accumulator.toolFragment(index, firstString(item, "call_id"), firstString(item, "name"), "", false)

		case "response.function_call_arguments.delta":
			fragment := firstString(chunk, "delta")
			if fragment == "" {
				return nil
			}
			// The event names the item; the mapping was established when the item
			// was added. A delta for an item nobody announced is attributed by its
			// own id so that the arguments are not silently dropped.
			index := callIndex(callIDs, &nextIndex, chunk)
			sawDelta = true
			accumulator.toolFragment(index, "", "", fragment, true)

		case "response.output_item.done":
			// The finished item is authoritative: its `arguments` is the whole
			// JSON string rather than a fragment, and it is what the official
			// client parses. The deltas above have already assembled the same
			// text; this **replaces** it rather than appending, so a gateway that
			// sends both cannot double the arguments.
			item, _ := chunk["item"].(map[string]any)
			if firstString(item, "type") != "function_call" {
				return nil
			}
			arguments := stringifyArguments(item["arguments"])
			if arguments == "" {
				return nil
			}
			index := callIndex(callIDs, &nextIndex, item)
			accumulator.replaceToolCall(index, firstString(item, "call_id"), firstString(item, "name"), arguments)

		case "response.completed", "response.incomplete":
			// This is where the real usage block lives; the earlier events either
			// carry none or carry a partial one.
			response, _ := chunk["response"].(map[string]any)
			if usage := extractResponsesUsage(response["usage"]); usage != nil {
				accumulator.usage = usage
			}
			if reason := responsesFinishReason(response); reason != "" {
				accumulator.finishReason = reason
			}
			// A gateway that streams the envelope but not the text deltas would
			// otherwise return an empty answer. The items are folded only in that
			// case, so a normal stream cannot double its own text.
			if !sawDelta {
				output, _ := response["output"].([]any)
				accumulator.foldOutputItems(output)
			}

		case "response.failed":
			response, _ := chunk["response"].(map[string]any)
			return fmt.Errorf("the endpoint reported a failed response: %s", failureText(response))

		case "error":
			// A mid-stream failure arrives as an event of its own, with no
			// `response.` prefix and no HTTP status to classify. Falling through
			// as an unknown event would return a truncated answer as if it were
			// complete, which is the worst of the available outcomes.
			return fmt.Errorf("the endpoint reported an error mid-stream: %s", failureText(chunk))
		}
		// `response.created`, `response.in_progress`, the content-part and
		// summary-part events, and every tool-specific event this program does not
		// use carry nothing needed here. Unknown types are skipped rather than
		// refused: a gateway that adds an event must not break the turn.
		return nil
	})
}

// callIndex resolves which tool call an item names, assigning a new index when the
// item is new.
//
// This protocol identifies items by a string id rather than by a positional index
// like the other two, which is why the mapping has to be kept: the argument deltas
// carry only the id, and without it every fragment would be attributed to whatever
// call happened to be first.
func callIndex(calls map[string]int, next *int, naming map[string]any) int {
	id := firstString(naming, "id")
	if id == "" {
		id = firstString(naming, "item_id")
	}
	if id == "" {
		id = firstString(naming, "call_id")
	}
	if index, known := calls[id]; known {
		return index
	}
	index := *next
	calls[id] = index
	*next++
	return index
}

// failureText renders whatever an error event says, so the report names the cause
// rather than only the fact of the failure.
func failureText(payload map[string]any) string {
	if nested, ok := payload["error"].(map[string]any); ok {
		payload = nested
	}
	if message := firstString(payload, "message"); message != "" {
		if code := firstString(payload, "code"); code != "" {
			return code + ": " + message
		}
		return message
	}
	if code := firstString(payload, "code"); code != "" {
		return code
	}
	return stringifyContent(payload)
}

// foldOutputItems reads a whole `output` array, which is what a non-streamed
// response is and what a stream falls back to when its deltas never arrived.
func (a *responseAccumulator) foldOutputItems(output []any) {
	for _, raw := range output {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch firstString(item, "type") {
		case "message":
			content, _ := item["content"].([]any)
			for _, rawPart := range content {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				// Both spellings are read: `output_text` is what this shape
				// documents, and a gateway that answers with the input spelling
				// is saying the same thing.
				if text := firstString(part, "text"); text != "" {
					a.text(text)
				}
			}

		case "reasoning":
			// The summary is where this shape puts a readable trace of the
			// model's thinking; the encrypted content is not readable and is not
			// asked for.
			summaries, _ := item["summary"].([]any)
			for _, rawPart := range summaries {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				a.reasoningText(firstString(part, "text"))
			}

		case "function_call":
			name := firstString(item, "name")
			if name == "" {
				continue
			}
			// Arguments are a JSON string here, so they are passed through rather
			// than decoded and re-encoded.
			a.toolFragment(a.nextIndex(), firstString(item, "call_id"), name, firstString(item, "arguments"), true)
		}
	}
}

// extractResponsesUsage normalises this protocol's usage block.
//
// The cache count lives under `input_tokens_details.cached_tokens`, one level
// deeper than the chat completions spelling but with the same meaning. Missing it
// would report every cache hit as a miss, silently and for ever.
func extractResponsesUsage(raw any) *TokenUsage {
	block, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	usage := &TokenUsage{
		PromptTokens:     intOf(block["input_tokens"]),
		CompletionTokens: intOf(block["output_tokens"]),
	}
	if details, ok := block["input_tokens_details"].(map[string]any); ok {
		usage.CachedTokens = intOf(details["cached_tokens"])
	}
	if usage.PromptTokens == 0 && usage.CompletionTokens == 0 && usage.CachedTokens == 0 {
		return nil
	}
	return usage
}
