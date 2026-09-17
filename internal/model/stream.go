package model

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// parseStream reads an SSE stream, feeding increments to the sink and returning
// the assembled response.
//
// The accumulation rules are not arbitrary; each one corresponds to something a
// gateway actually does:
//
//   - tool calls are joined **by index**, not by arrival order. A gateway is free
//     to interleave the pieces of several calls, and joining by arrival produces
//     calls with the arguments of another call spliced into them;
//   - the id is taken from the first non-empty piece, and the name is **not**
//     appended when it repeats. Some gateways restate the function name in every
//     chunk, which naively concatenated gives `read_fileread_file`;
//   - the usage block belongs to the whole request, so it replaces rather than
//     accumulates;
//   - a placeholder chunk carrying only an id and nothing else is dropped.
func parseStream(reader io.Reader, sink DeltaSink) (ModelResponse, error) {
	accumulator := newStreamAccumulator()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") {
			// Blank keep-alive lines and comments carry nothing.
			continue
		}
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
			// One unreadable chunk must not lose the whole answer; the pieces that
			// did arrive are still on the screen and still usable.
			continue
		}
		if err := accumulator.feed(chunk, sink); err != nil {
			return ModelResponse{}, err
		}
	}
	if err := scanner.Err(); err != nil {
		return ModelResponse{}, AsTransient("the stream broke off: %v", err)
	}
	return accumulator.response(), nil
}

type streamAccumulator struct {
	content      strings.Builder
	reasoning    strings.Builder
	hasContent   bool
	hasReasoning bool
	chunks       int
	usage        *TokenUsage
	// calls is keyed by index; order is recovered by sorting the keys at the end.
	calls map[int]*ToolCall
	order []int
}

func newStreamAccumulator() *streamAccumulator {
	return &streamAccumulator{calls: map[int]*ToolCall{}}
}

func (a *streamAccumulator) feed(chunk map[string]any, sink DeltaSink) error {
	// Usage may arrive on its own chunk, including the one after the last content
	// chunk, so it is read before anything else looks at `choices`.
	if usage := extractUsage(chunk["usage"]); usage != nil {
		a.usage = usage
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
		a.content.WriteString(text)
		a.hasContent = true
		a.chunks++
		if sink != nil {
			sink(text, "")
		}
	}

	if reasoning := extractReasoning(delta); reasoning != nil && *reasoning != "" {
		a.reasoning.WriteString(*reasoning)
		a.hasReasoning = true
		a.chunks++
		if sink != nil {
			sink("", *reasoning)
		}
	}

	a.feedToolCalls(delta["tool_calls"])
	return nil
}

func (a *streamAccumulator) feedToolCalls(raw any) {
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
		call, present := a.calls[index]
		if !present {
			call = &ToolCall{}
			a.calls[index] = call
			a.order = append(a.order, index)
		}
		if id, ok := entry["id"].(string); ok && id != "" && call.ID == "" {
			call.ID = id
		}
		function, _ := entry["function"].(map[string]any)
		if function == nil {
			continue
		}
		if name, ok := function["name"].(string); ok && name != "" && !strings.Contains(call.Name, name) {
			// Restated names are not appended; a name that is genuinely split
			// across chunks does not appear in the earlier piece, so this cannot
			// drop a real fragment.
			call.Name = name
		}
		if args, ok := function["arguments"].(string); ok {
			call.Arguments += args
		}
	}
}

func (a *streamAccumulator) response() ModelResponse {
	result := ModelResponse{
		Usage:        a.usage,
		Streamed:     true,
		StreamChunks: a.chunks,
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
