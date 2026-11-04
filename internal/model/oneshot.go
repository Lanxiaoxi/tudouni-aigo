package model

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// oneShotTimeout caps a side request. It is a feature beside the conversation,
// not the conversation, so an endpoint that has not answered in this long is a
// reason to show nothing rather than a reason to keep a goroutine and a
// connection waiting for the client's ten-minute budget.
const oneShotTimeout = 45 * time.Second

// CompleteOneShot runs one small request **beside** the session rather than as
// part of it, with reasoning asked off.
//
// It is a deliberate sibling of `Complete`, for the same reasons `ProbeEffort`
// is, and every difference is about not touching the main conversation:
//
//   - **No knob is written.** Reasoning is turned off in this request's own
//     body; the adapter's `thinking`/`effort` (read by every turn through
//     `snapshot`) are never changed. Flipping them for the side call would race
//     a turn that starts while it is in flight.
//   - **No endpoint memory is written.** `Complete`'s recoveries remember, per
//     process, that an endpoint refuses "do not think", refuses
//     `stream_options`, or wants thinking replayed — and a thinking-only model
//     refusing this request's "off" would, through that memory, make every
//     later turn send nothing about reasoning, silently dropping the level the
//     person chose. Here the refusal is recovered **locally**: the request goes
//     once more saying nothing about reasoning, and nothing is remembered.
//   - **Not streamed, not retried.** Nobody is watching it arrive, and a side
//     feature that retries through a rate limit spends the quota the next turn
//     is about to need.
//
// The route (endpoint, key, headers, session header) is the session's own,
// read once, so the request goes where the conversation goes and on the same
// credential.
func (m *OpenAICompatible) CompleteOneShot(ctx context.Context, messages []map[string]any) (ModelResponse, error) {
	route := m.Route()
	codec, err := dialectFor(route.Style)
	if err != nil {
		return ModelResponse{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, oneShotTimeout)
	defer cancel()

	knobs := ReasoningKnobs{Thinking: false}
	// A thinking-only model already proved, earlier in this process, that it
	// refuses "off": go straight to silence rather than earn the same 400.
	// Reading the memory is harmless; only writing it would leak into turns.
	if !thinkingInstructionSupported(route.BaseURL, route.Model) {
		knobs.omit = true
	}
	response, err := m.oneShotOnce(ctx, codec, route, messages, knobs)
	if err != nil && !knobs.omit && isThinkingInstructionRejection(err) {
		knobs.omit = true
		response, err = m.oneShotOnce(ctx, codec, route, messages, knobs)
	}
	if err != nil && ctx.Err() != nil {
		return ModelResponse{}, CancelledError{}
	}
	return response, err
}

func (m *OpenAICompatible) oneShotOnce(ctx context.Context, codec dialect, route Route, messages []map[string]any, knobs ReasoningKnobs) (ModelResponse, error) {
	body, err := codec.encode(dialectRequest{
		model:    route.Model,
		messages: messages,
		knobs:    knobs,
		images:   m.images,
	})
	if err != nil {
		return ModelResponse{}, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return ModelResponse{}, AsFatal("cannot encode the request: %v", err)
	}
	endpoint := endpointURL(route.BaseURL, codec.path())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return ModelResponse{}, AsFatal("cannot build the request: %v", err)
	}
	// Same header order as completeOnce: configured headers first, so nothing
	// configured can displace the ones this package is responsible for.
	for name, value := range templateHeaders(route) {
		request.Header.Set(name, value)
	}
	request.Header.Set("Content-Type", "application/json")
	if route.APIKey != "" {
		request.Header.Set(codec.credentialHeader(), credentialValue(codec.credentialHeader(), route.APIKey))
	}

	response, err := m.client.Do(request)
	if err != nil {
		return ModelResponse{}, AsTransient("%v", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		// Classified for the one refusal recovered above. The classifier is a
		// pure function — it remembers nothing — so calling it here is safe.
		return ModelResponse{}, classifyHTTPError(response.StatusCode, string(raw), endpoint, false)
	}
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return ModelResponse{}, AsTransient("cannot read the response: %v", err)
	}
	return codec.parseUnary(raw)
}
