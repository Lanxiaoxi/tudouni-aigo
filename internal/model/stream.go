package model

import (
	"bufio"
	"encoding/json"
	"strings"
)

// responseAccumulator is the middle shape every dialect's stream is folded into.
//
// The three protocols announce their increments with different event names and
// different nesting, but once an increment has been identified it is one of three
// things: answer text, reasoning text, or a fragment of a tool call. Accumulating
// those three is identical everywhere — the joining rules below were learned from
// real gateways and are not protocol-specific — so each dialect does only the
// translation and this type does the bookkeeping.
type responseAccumulator struct {
	content      strings.Builder
	reasoning    strings.Builder
	hasContent   bool
	hasReasoning bool
	chunks       int
	usage        *TokenUsage
	// finishReason is the last one seen rather than the first: a gateway is free
	// to send `null` on every content chunk and the real marker on the last one,
	// and the last non-empty value is the one that describes the end.
	finishReason string
	// calls is keyed by index; order is recovered by sorting the keys at the end.
	calls map[int]*ToolCall
	order []int
}

// nextIndex is the index a positional (non-streamed) caller should use.
//
// A whole response has no interleaving to preserve, so its tool calls are numbered
// in the order they appear. The index still goes through the same map as the
// streamed path, so both end up sorted and rendered by one piece of code.
func (a *responseAccumulator) nextIndex() int { return len(a.order) }

func newResponseAccumulator() *responseAccumulator {
	return &responseAccumulator{calls: map[int]*ToolCall{}}
}

// text records a piece of the answer.
func (a *responseAccumulator) text(piece string) {
	if piece == "" {
		return
	}
	a.content.WriteString(piece)
	a.hasContent = true
	a.chunks++
}

// reasoningText records a piece of the model's thinking.
func (a *responseAccumulator) reasoningText(piece string) {
	if piece == "" {
		return
	}
	a.reasoning.WriteString(piece)
	a.hasReasoning = true
	a.chunks++
}

// toolFragment records one piece of a tool call.
//
// The index is what the call is joined by — not arrival order. A gateway is free
// to interleave the pieces of several calls, and joining by arrival produces calls
// with the arguments of another call spliced into them. The name is **not**
// appended when it repeats, because some gateways restate it in every fragment,
// which naively concatenated gives `read_fileread_file`.
func (a *responseAccumulator) toolFragment(index int, id, name, arguments string, nameIsAppendable bool) {
	call, present := a.calls[index]
	if !present {
		call = &ToolCall{}
		a.calls[index] = call
		a.order = append(a.order, index)
	}
	if id != "" && call.ID == "" {
		call.ID = id
	}
	if name != "" {
		if nameIsAppendable {
			call.Name += name
		} else if !strings.Contains(call.Name, name) {
			call.Name = name
		}
	}
	if arguments != "" {
		call.Arguments += arguments
	}
}

// replaceToolCall overwrites a call with its finished form.
//
// It exists for the protocols that send both fragments and a final item: the
// assembled fragments and the final value are two renderings of the same thing,
// and appending the second to the first would produce arguments like
// `{"path":"a"}{"path":"a"}` — valid-looking JSON that is not JSON. Overwriting is
// the correct reading of "here is the whole thing".
func (a *responseAccumulator) replaceToolCall(index int, id, name, arguments string) {
	call, present := a.calls[index]
	if !present {
		call = &ToolCall{}
		a.calls[index] = call
		a.order = append(a.order, index)
	}
	if id != "" {
		call.ID = id
	}
	if name != "" {
		call.Name = name
	}
	if arguments != "" {
		call.Arguments = arguments
	}
}

// toolCalls feeds the chat completions `tool_calls` array of one chunk.
//
// This is the OpenAI shape: a list of `{index, id, function: {name, arguments}}`
// entries where `arguments` accumulates as text.
func (a *responseAccumulator) toolCalls(raw any) {
	items, _ := raw.([]any)
	for position, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		index := position
		if value, ok := entry["index"]; ok {
			index = intOf(value)
		}
		function, _ := entry["function"].(map[string]any)
		id, _ := entry["id"].(string)
		name, arguments := "", ""
		if function != nil {
			name, _ = function["name"].(string)
			arguments, _ = function["arguments"].(string)
		}
		a.toolFragment(index, id, name, arguments, false)
	}
}

// response turns the accumulated pieces into the shared answer type.
func (a *responseAccumulator) response(streamed bool) ModelResponse {
	result := ModelResponse{
		Usage:        a.usage,
		Streamed:     streamed,
		StreamChunks: a.chunks,
		FinishReason: a.finishReason,
	}
	if a.hasContent {
		text := a.content.String()
		result.Content = &text
	}
	if a.hasReasoning {
		text := a.reasoning.String()
		result.Reasoning = &text
	}

	// Sort by index so the calls come back in the order the model meant them.
	sortInts(a.order)
	for _, index := range a.order {
		call := a.calls[index]
		// A placeholder that never received a name is dropped: an empty tool call
		// would be sent to a tool registry that has no such tool.
		if call.Name == "" {
			continue
		}
		if call.ID == "" {
			call.ID = "call_" + itoa(len(result.ToolCalls))
		}
		result.ToolCalls = append(result.ToolCalls, *call)
	}
	return result
}

// readSSE drives an SSE body, handing each decoded chunk to one dialect callback.
//
// The scanner rules are the protocol-independent parts, and each one corresponds
// to something a gateway actually does: `data:` lines carry the payload, blank
// lines and `:` comments (keep-alives) carry nothing, `[DONE]` ends the stream,
// and one unreadable chunk must not lose the whole answer — the pieces that did
// arrive are still on the screen and still usable.
//
// The callback may return an error, and that is how a failure delivered **inside**
// the stream is handled. Not every protocol reports trouble with a status code: one
// of them sends a mid-stream error event, and treating it as an unknown event would
// return a truncated answer as if it were complete.
func readSSE(body reader, sink DeltaSink, shouldStop func() bool, feed func(chunk map[string]any, accumulator *responseAccumulator) error) (ModelResponse, error) {
	accumulator := newResponseAccumulator()
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)

	for scanner.Scan() {
		if shouldStop != nil && shouldStop() {
			return ModelResponse{}, CancelledError{}
		}
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		// A dialect with named events (`event: content_block_delta`) still puts
		// the whole payload in the `data:` line, so the event name is never
		// needed: the JSON carries its own `type`. Skipping other field lines is
		// therefore correct for all three protocols, not a shortcut for one.
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}

		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if err := feed(chunk, accumulator); err != nil {
			return ModelResponse{}, err
		}
	}
	if err := scanner.Err(); err != nil {
		return ModelResponse{}, AsTransient("the stream broke off: %v", err)
	}
	return accumulator.response(true), nil
}

// parseToolCallItems folds a whole (non-streamed) array of tool call entries.
//
// `idKeys` and `nameKeys` are lists because the three protocols spell them
// differently (`id` versus `call_id`, `name` versus a nested `function.name`), and
// passing the alternatives in keeps this from becoming three near-identical
// functions.
func parseToolCallItems(raw any, idKeys, nameKeys []string) []ToolCall {
	items, _ := raw.([]any)
	var out []ToolCall
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		call := ToolCall{ID: firstString(entry, idKeys...), Name: firstString(entry, nameKeys...)}
		// `function` is a nested object in the chat completions shape only; in
		// the flattened shapes the keys above already found the name.
		if function, ok := entry["function"].(map[string]any); ok {
			if call.Name == "" {
				call.Name = firstString(function, nameKeys...)
			}
			call.Arguments = stringifyArguments(function["arguments"])
		} else {
			call.Arguments = stringifyArguments(firstValue(entry, "arguments", "input", "partial_json"))
		}
		if call.Name == "" {
			continue
		}
		out = append(out, call)
	}
	return out
}

// stringifyArguments renders a tool call's arguments as the JSON text the tool
// layer parses.
//
// The protocols disagree about the carrier: chat completions and the streaming
// events hand over a JSON **string**, while the Messages shape hands back a parsed
// **object** in `input`. `ToolCall.Arguments` is a string in both cases because
// that is what the tools parse, so the object is converted back to text here —
// this is the only place that difference is allowed to show.
func stringifyArguments(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case map[string]any:
		if len(typed) == 0 {
			// An empty `input` is a tool call that takes no arguments. It is
			// rendered as an empty object rather than as nothing, because the
			// tool layer parses what it is given and "" is not JSON.
			return "{}"
		}
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "{}"
		}
		return string(encoded)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

// firstValue returns the value of the first key that is present.
func firstValue(object map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, present := object[key]; present {
			return value
		}
	}
	return nil
}

// sortInts orders the tool call indices.
func sortInts(values []int) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
