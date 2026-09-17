package model

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// streamUsageOption asks the gateway to report token usage on a streamed request.
// Without it a streamed call has no usage block at all.
const streamUsageOption = `"stream_options":{"include_usage":true}`

// unsupportedStreamOptions remembers which (base_url, model) pairs have proved
// they reject `stream_options`.
//
// Why process-wide: knowledge bought with one 400 has to be kept, otherwise
// **every** model call pays a wasted round trip to rediscover it. The key is
// (base_url, model) rather than an instance, because switching sessions rebuilds
// the client and "does this gateway accept this parameter" has nothing to do with
// a session.
//
// Why not a configuration option: this is a discovered fact, not a preference.
// Asking a person to write "does my gateway support include_usage" means the wrong
// answer fails once per turn.
var (
	unsupportedMu   sync.Mutex
	unsupportedOpts = map[string]bool{}
)

func streamOptionsKey(baseURL, model string) string { return baseURL + "\x00" + model }

func streamOptionsSupported(baseURL, model string) bool {
	unsupportedMu.Lock()
	defer unsupportedMu.Unlock()
	return !unsupportedOpts[streamOptionsKey(baseURL, model)]
}

func rememberStreamOptionsUnsupported(baseURL, model string) {
	unsupportedMu.Lock()
	defer unsupportedMu.Unlock()
	unsupportedOpts[streamOptionsKey(baseURL, model)] = true
}

// OpenAICompatible talks to any endpoint that speaks the chat completions shape.
type OpenAICompatible struct {
	client *http.Client

	apiKey   string
	baseURL  string
	model    string
	provider string
	// verify is kept from the configuration file. A transport that skips
	// certificate checks would be built here; the default client verifies.
	verify bool

	thinking bool
	effort   string
}

// Options configures a new adapter.
type Options struct {
	APIKey   string
	BaseURL  string
	Model    string
	Provider string
	Verify   bool
	Thinking bool
	Effort   string
	Client   *http.Client
	// Timeout is how long one request may take. A streamed answer can legitimately
	// take minutes, so this is generous.
	Timeout time.Duration
}

// New creates an adapter.
func New(options Options) *OpenAICompatible {
	client := options.Client
	if client == nil {
		timeout := options.Timeout
		if timeout == 0 {
			timeout = 10 * time.Minute
		}
		client = &http.Client{Timeout: timeout}
	}
	if options.Provider != "" {
		// Recorded so `/status` can say which route a request went out on; two
		// routes can carry a model with the same name.
		_ = options.Provider
	}
	return &OpenAICompatible{
		client:   client,
		apiKey:   options.APIKey,
		baseURL:  strings.TrimRight(options.BaseURL, "/"),
		model:    options.Model,
		provider: options.Provider,
		verify:   options.Verify,
		thinking: options.Thinking,
		effort:   options.Effort,
	}
}

// ModelName is the model in use.
func (m *OpenAICompatible) ModelName() string { return m.model }

// ProviderName is the route in use.
func (m *OpenAICompatible) ProviderName() string { return m.provider }

// BaseURL is where requests go.
func (m *OpenAICompatible) BaseURL() string { return m.baseURL }

// SwitchModel changes the model for subsequent requests.
func (m *OpenAICompatible) SwitchModel(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	m.model = strings.TrimSpace(name)
	return true
}

// SetReasoning updates the two thinking knobs.
func (m *OpenAICompatible) SetReasoning(thinking bool, effort string) {
	m.thinking = thinking
	m.effort = effort
}

// Complete runs one request, streaming when a sink is present.
//
// The stream is only requested when somebody is reading it. A streamed request
// nobody consumes costs the same and delivers less, and asking for `stream` in the
// body is itself observable in the audit.
func (m *OpenAICompatible) Complete(messages []map[string]any, tools []map[string]any, options CompleteOptions) (ModelResponse, error) {
	if options.OnDelta == nil {
		return m.completeOnce(messages, tools, nil)
	}

	response, err := m.completeOnce(messages, tools, options.OnDelta)
	if err == nil {
		return response, nil
	}

	// A gateway that rejects `stream_options` cannot report usage while streaming.
	// Drop the parameter, remember it, and send the request again — the text that
	// already reached the screen is kept, and the caller is told to discard its
	// copy through OnAttemptStarted so the restatement does not read as the model
	// saying everything twice.
	if !isStreamOptionsRejection(err) {
		return ModelResponse{}, err
	}
	rememberStreamOptionsUnsupported(m.baseURL, m.model)
	if options.OnAttemptStarted != nil {
		options.OnAttemptStarted()
	}
	return m.completeOnce(messages, tools, options.OnDelta)
}

// streamOptionsRejection marks a 400 that is specifically about stream_options.
type streamOptionsRejection struct{ Msg string }

func (e *streamOptionsRejection) Error() string { return e.Msg }

func isStreamOptionsRejection(err error) bool {
	_, ok := err.(*streamOptionsRejection)
	return ok
}

func (m *OpenAICompatible) completeOnce(messages []map[string]any, tools []map[string]any, sink DeltaSink) (ModelResponse, error) {
	body := m.requestBody(messages, tools, sink != nil)
	payload, err := json.Marshal(body)
	if err != nil {
		return ModelResponse{}, AsFatal("cannot encode the request: %v", err)
	}

	endpoint := m.baseURL + "/chat/completions"
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return ModelResponse{}, AsFatal("cannot build the request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if m.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+m.apiKey)
	}
	if sink != nil {
		request.Header.Set("Accept", "text/event-stream")
	}

	response, err := m.client.Do(request)
	if err != nil {
		return ModelResponse{}, AsTransient("%v", err)
	}
	defer response.Body.Close()

	if response.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return ModelResponse{}, classifyHTTPError(response.StatusCode, string(raw), m.baseURL+"/chat/completions")
	}

	if sink == nil {
		return parseUnaryResponse(response.Body)
	}
	return parseStream(response.Body, sink)
}

func (m *OpenAICompatible) requestBody(messages []map[string]any, tools []map[string]any, stream bool) map[string]any {
	body := map[string]any{
		"model":    m.model,
		"messages": messages,
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	// The thinking knobs are read on every call, which is what makes "it takes
	// effect on the next request" true.
	for key, value := range state.RequestFields(m.thinking, m.effort) {
		body[key] = value
	}
	if stream {
		body["stream"] = true
		if streamOptionsSupported(m.baseURL, m.model) {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	return body
}

func parseUnaryResponse(reader io.Reader) (ModelResponse, error) {
	raw, err := io.ReadAll(reader)
	if err != nil {
		return ModelResponse{}, AsTransient("cannot read the response: %v", err)
	}
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
	result.ToolCalls = parseToolCalls(message["tool_calls"])
	return result, nil
}

func parseToolCalls(raw any) []ToolCall {
	items, _ := raw.([]any)
	var out []ToolCall
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		function, _ := entry["function"].(map[string]any)
		call := ToolCall{}
		call.ID, _ = entry["id"].(string)
		call.Name, _ = function["name"].(string)
		if arguments, ok := function["arguments"].(string); ok {
			call.Arguments = arguments
		}
		if call.Name == "" {
			continue
		}
		out = append(out, call)
	}
	return out
}

// extractReasoning reads the thinking text from a message.
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

// extractUsage normalises the usage block.
//
// The cache hit count comes from the standard `prompt_tokens_details.cached_tokens`
// rather than a provider-specific field: this adapter is called "OpenAI
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

// classifyHTTPError maps a failing response onto the two domain classes.
//
// The split matters because the handling is completely different: a transient
// failure is worth backing off and retrying, a permanent one only repeats the same
// failure three times.
func classifyHTTPError(status int, body string, endpoint string) error {
	trimmed := strings.TrimSpace(body)
	if len(trimmed) > 600 {
		trimmed = trimmed[:600] + "…"
	}
	summary := fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, trimmed)

	if strings.Contains(strings.ToLower(body), "stream_options") ||
		strings.Contains(strings.ToLower(body), "include_usage") {
		if status == 400 {
			return &streamOptionsRejection{Msg: summary}
		}
	}

	switch {
	case status == 408 || status == 409 || status == 429 || status >= 500:
		return AsTransient("%s", summary)
	default:
		return AsFatal("%s", summary)
	}
}
