package model

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestResponsesRequestFlattensToolsAndItems pins the three structural
// differences from chat completions.
//
// None of them is a rename. The system prompt is a top-level field, the
// conversation is a flat item list with a type on every entry, and a tool result
// is an item rather than a message. A request built in the other shape is refused
// by the endpoint, and the refusal names a field rather than the configuration
// that chose the protocol.
func TestResponsesRequestFlattensToolsAndItems(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "gpt-x", StyleResponses),
		Thinking: true, Effort: "high",
	})

	_, err := adapter.Complete([]map[string]any{
		{"role": "system", "content": "be terse"},
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": nil, "tool_calls": []any{
			map[string]any{"id": "call_1", "function": map[string]any{
				"name": "read_file", "arguments": `{"path":"a.txt"}`,
			}},
		}},
		{"role": "tool", "tool_call_id": "call_1", "content": "file body"},
	}, []map[string]any{{
		"type": "function",
		"function": map[string]any{
			"name": "read_file", "description": "read a file",
			"parameters": map[string]any{"type": "object"},
		},
	}}, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	body := (*bodies)[0]
	if got := body["instructions"]; got != "be terse" {
		t.Errorf("instructions = %v, want the lifted system prompt", got)
	}
	if _, present := body["messages"]; present {
		t.Error("the request carries a messages array, which this protocol does not have")
	}
	// Storage is asked for explicitly on every request: this program keeps its
	// sessions locally, and a default that stored them server-side would be a
	// silent change of where a conversation lives.
	if store, present := body["store"]; !present || store != false {
		t.Errorf("store = %v, want an explicit false", body["store"])
	}

	items, _ := body["input"].([]any)
	if len(items) != 3 {
		t.Fatalf("input has %d items, want 3: %#v", len(items), items)
	}
	// The user turn is an item with a type and a content part.
	user, _ := items[0].(map[string]any)
	if user["type"] != "message" || user["role"] != "user" {
		t.Errorf("items[0] = %#v, want a user message item", user)
	}
	part := firstPart(t, user)
	if part["type"] != "input_text" || part["text"] != "hello" {
		t.Errorf("the user content part = %#v, want input_text/hello", part)
	}

	// The assistant's call is its own item, and its id is `call_id` — the field a
	// result references. Putting the item id there produces a call that never
	// matches its result.
	call, _ := items[1].(map[string]any)
	if call["type"] != "function_call" {
		t.Errorf("items[1].type = %v, want function_call", call["type"])
	}
	if call["call_id"] != "call_1" || call["name"] != "read_file" {
		t.Errorf("the call item = %#v", call)
	}
	if args, _ := call["arguments"].(string); args != `{"path":"a.txt"}` {
		t.Errorf("arguments = %v, want the JSON text passed through", call["arguments"])
	}

	// The tool result is an item of its own, not a message with a role.
	result, _ := items[2].(map[string]any)
	if result["type"] != "function_call_output" {
		t.Errorf("items[2].type = %v, want function_call_output", result["type"])
	}
	if result["call_id"] != "call_1" || result["output"] != "file body" {
		t.Errorf("the result item = %#v", result)
	}

	// Tools are flat here: the schema stays `parameters`, but the nesting under
	// `function` is gone.
	tools, _ := body["tools"].([]any)
	entry, _ := tools[0].(map[string]any)
	if entry["name"] != "read_file" {
		t.Errorf("tools[0].name = %v, want read_file", entry["name"])
	}
	if _, present := entry["function"]; present {
		t.Error("tools[0] is still nestled under function")
	}
	if _, present := entry["parameters"]; !present {
		t.Error("tools[0] has no parameters schema")
	}

	// The thinking knob uses this protocol's own spelling.
	reasoning, ok := body["reasoning"].(map[string]any)
	if !ok || reasoning["effort"] != "high" {
		t.Errorf("reasoning = %#v, want {effort: high}", body["reasoning"])
	}
	// `summary` is not decoration: without it this endpoint sends no reasoning
	// events at all, so the thinking display would go blank while the model kept
	// thinking and billing for it.
	if reasoning["summary"] != "auto" {
		t.Errorf("reasoning.summary = %v, want auto", reasoning["summary"])
	}
	// Stateless multi-turn thinking needs the encrypted reasoning replayed, and
	// asking for it is how this request says so.
	included, _ := body["include"].([]any)
	if len(included) != 1 || included[0] != "reasoning.encrypted_content" {
		t.Errorf("include = %#v, want the encrypted reasoning", body["include"])
	}
	if _, present := body["reasoning_effort"]; present {
		t.Error("reasoning_effort was sent to the Responses protocol")
	}
	if _, present := body["thinking"]; present {
		t.Error("the chat completions thinking marker was sent to the Responses protocol")
	}
}

// TestResponsesStreamDoesNotDoubleTheArguments covers the gateway that sends both
// the fragments and the finished item: appending the second to the first produces
// `{"a":1}{"a":1}`, which is not JSON, and the tool would fail on arguments the
// model actually sent correctly.
func TestResponsesStreamDoesNotDoubleTheArguments(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "response.output_item.added", "output_index": 0,
			"item": map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file"}},
		map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1",
			"delta": `{"path":"a.txt"}`},
		map[string]any{"type": "response.output_item.done", "output_index": 0,
			"item": map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1",
				"name": "read_file", "arguments": `{"path":"a.txt"}`}},
		map[string]any{"type": "response.completed", "response": map[string]any{
			"output": []any{}, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1},
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if len(response.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %#v, want one", response.ToolCalls)
	}
	if got := response.ToolCalls[0].Arguments; got != `{"path":"a.txt"}` {
		t.Errorf("arguments = %q, want them once, not doubled", got)
	}
}

// TestAResponsesErrorEventIsReported keeps a truncated answer from being returned
// as a complete one.
//
// This protocol reports a mid-stream failure as an event rather than a status
// code, so a parser that only knew the documented delta events would treat the
// failure as an event it does not recognise and hand back whatever text had
// arrived — which reads as the model having stopped mid-sentence.
func TestAResponsesErrorEventIsReported(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "response.output_text.delta", "delta": "half an answer"},
		map[string]any{"type": "error", "code": "server_error", "message": "something went wrong"},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err == nil {
		t.Fatal("a mid-stream error was reported as a successful turn")
	}
	if !strings.Contains(err.Error(), "something went wrong") {
		t.Errorf("the error does not carry the cause: %v", err)
	}
}

// TestAFailedResponsesEventIsReported covers the other failure event, whose text
// lives one level down under `response.error`.
func TestAFailedResponsesEventIsReported(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "response.failed", "response": map[string]any{
			"error": map[string]any{"code": "rate_limit_exceeded", "message": "slow down"},
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	_, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err == nil {
		t.Fatal("a failed response was reported as a successful turn")
	}
	if !strings.Contains(err.Error(), "slow down") {
		t.Errorf("the error does not carry the cause: %v", err)
	}
}

// TestResponsesStopsThinkingByOmittingTheKnob keeps the off-direction honest:
// there is no `none` level in this program's vocabulary, so the field is left out
// rather than filled with an invented value.
func TestResponsesStopsThinkingByOmittingTheKnob(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	adapter.SetReasoning(false, "max")
	completeOnce(t, adapter)

	if _, present := (*bodies)[0]["reasoning"]; present {
		t.Errorf("reasoning was sent while thinking is off: %#v", (*bodies)[0]["reasoning"])
	}
}

// TestResponsesUsageMapsTheNestedCacheField is the silent failure this mapping
// exists for: the cache count is one level deeper here, and a normaliser that
// missed it would report every hit as a miss with nothing to show for it.
func TestResponsesUsageMapsTheNestedCacheField(t *testing.T) {
	server, _, _ := dialectGateway(t, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],
		"usage":{"input_tokens":200,"output_tokens":30,"input_tokens_details":{"cached_tokens":180}}}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	response := completeOnce(t, adapter)

	if response.Usage == nil {
		t.Fatal("no usage was read")
	}
	if response.Usage.PromptTokens != 200 || response.Usage.CompletionTokens != 30 {
		t.Errorf("usage = %+v, want 200/30", *response.Usage)
	}
	if response.Usage.CachedTokens != 180 {
		t.Errorf("CachedTokens = %d, want 180", response.Usage.CachedTokens)
	}
}

// TestResponsesUnaryReadsReasoningAndCalls covers a whole response, including the
// `reasoning` item, whose readable part is the summary.
func TestResponsesUnaryReadsReasoningAndCalls(t *testing.T) {
	server, _, _ := dialectGateway(t, `{
		"id":"resp_1","object":"response",
		"output":[
			{"type":"reasoning","summary":[{"type":"summary_text","text":"weighing options"}]},
			{"type":"message","content":[{"type":"output_text","text":"here it is"}]},
			{"type":"function_call","id":"fc_1","call_id":"call_9","name":"read_file","arguments":"{\"path\":\"b.txt\"}"}
		],
		"usage":{"input_tokens":12,"output_tokens":8,"input_tokens_details":{"cached_tokens":4}}
	}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	response := completeOnce(t, adapter)

	if response.Content == nil || *response.Content != "here it is" {
		t.Errorf("Content = %#v, want the output text", response.Content)
	}
	if response.Reasoning == nil || *response.Reasoning != "weighing options" {
		t.Errorf("Reasoning = %#v, want the summary", response.Reasoning)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %#v, want one", response.ToolCalls)
	}
	call := response.ToolCalls[0]
	// The id that a result references is `call_id`, not the item's own `id`.
	if call.ID != "call_9" || call.Name != "read_file" {
		t.Errorf("call = %+v, want call_9/read_file", call)
	}
	arguments := map[string]any{}
	if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
		t.Fatalf("arguments are not JSON text: %q", call.Arguments)
	}
	if arguments["path"] != "b.txt" {
		t.Errorf("arguments = %v, want b.txt", call.Arguments)
	}
}

// TestResponsesStreamAssemblesDeltas walks a real event sequence.
//
// The argument fragments are named by item id rather than by index here, which is
// the part that cannot be shared with the other two dialects: a parser that
// assumed an index would drop the arguments of every call in the turn.
func TestResponsesStreamAssemblesDeltas(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_1"}},
		map[string]any{"type": "response.in_progress"},
		map[string]any{"type": "response.output_item.added", "output_index": 0,
			"item": map[string]any{"type": "reasoning", "id": "rs_1"}},
		map[string]any{"type": "response.reasoning_summary_text.delta", "item_id": "rs_1",
			"delta": "let me think "},
		map[string]any{"type": "response.reasoning_summary_text.delta", "item_id": "rs_1",
			"delta": "about it"},
		map[string]any{"type": "response.output_item.added", "output_index": 1,
			"item": map[string]any{"type": "message", "id": "msg_1", "role": "assistant"}},
		map[string]any{"type": "response.output_text.delta", "item_id": "msg_1",
			"delta": "Checking "},
		map[string]any{"type": "response.output_text.delta", "item_id": "msg_1",
			"delta": "the file."},
		map[string]any{"type": "response.output_item.added", "output_index": 2,
			"item": map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_7", "name": "read_file"}},
		map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1",
			"delta": `{"path":`},
		map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1",
			"delta": `"c.txt"}`},
		map[string]any{"type": "response.function_call_arguments.done", "item_id": "fc_1",
			"arguments": `{"path":"c.txt"}`},
		map[string]any{"type": "response.completed", "response": map[string]any{
			"id": "resp_1",
			"output": []any{
				map[string]any{"type": "message", "content": []any{
					map[string]any{"type": "output_text", "text": "Checking the file."},
				}},
			},
			"usage": map[string]any{"input_tokens": 40, "output_tokens": 15,
				"input_tokens_details": map[string]any{"cached_tokens": 32}},
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	var streamedText, streamedReasoning strings.Builder
	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(text, reasoning string) {
			streamedText.WriteString(text)
			streamedReasoning.WriteString(reasoning)
		}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if streamedText.String() != "Checking the file." {
		t.Errorf("the streamed text = %q", streamedText.String())
	}
	if streamedReasoning.String() != "let me think about it" {
		t.Errorf("the streamed reasoning = %q", streamedReasoning.String())
	}
	// The text must not be doubled by the `response.completed` snapshot, which
	// also carries the finished message.
	if response.Content == nil || *response.Content != "Checking the file." {
		t.Errorf("Content = %#v, want it exactly once", response.Content)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %#v, want one", response.ToolCalls)
	}
	if got := response.ToolCalls[0].Arguments; got != `{"path":"c.txt"}` {
		t.Errorf("arguments = %q, want the joined fragments", got)
	}
	if response.ToolCalls[0].ID != "call_7" {
		t.Errorf("call id = %q, want the call_id a result can reference", response.ToolCalls[0].ID)
	}
	if response.Usage == nil || response.Usage.CompletionTokens != 15 || response.Usage.CachedTokens != 32 {
		t.Errorf("usage = %#v, want the completed event's block", response.Usage)
	}
}

// TestResponsesStreamFallsBackToTheFinalSnapshot covers a gateway that streams the
// envelope but sends the answer only in the final event: without the fallback the
// turn would come back empty, which reads as the model having nothing to say.
func TestResponsesStreamFallsBackToTheFinalSnapshot(t *testing.T) {
	server, _ := streamGateway(t, sse(
		map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_1"}},
		map[string]any{"type": "response.completed", "response": map[string]any{
			"id": "resp_1",
			"output": []any{
				map[string]any{"type": "message", "content": []any{
					map[string]any{"type": "output_text", "text": "only at the end"},
				}},
			},
			"usage": map[string]any{"input_tokens": 5, "output_tokens": 3},
		}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if response.Content == nil || *response.Content != "only at the end" {
		t.Errorf("Content = %#v, want the final snapshot folded in", response.Content)
	}
}

// TestResponsesSendsNoStreamOptionsParameter is a protocol fact: this shape has no
// `include_usage`.
func TestResponsesSendsNoStreamOptionsParameter(t *testing.T) {
	server, bodies := streamGateway(t, sse(
		map[string]any{"type": "response.output_text.delta", "delta": "ok"},
		map[string]any{"type": "response.completed", "response": map[string]any{}},
	))
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleResponses)})

	if _, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(string, string) {}}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if _, present := (*bodies)[0]["stream_options"]; present {
		t.Errorf("stream_options was sent to the Responses protocol: %#v", (*bodies)[0])
	}
}

// firstPart returns the first content part of a message item.
func firstPart(t *testing.T, item map[string]any) map[string]any {
	t.Helper()
	parts, _ := item["content"].([]any)
	if len(parts) == 0 {
		t.Fatalf("the item has no content parts: %#v", item)
	}
	part, _ := parts[0].(map[string]any)
	return part
}
