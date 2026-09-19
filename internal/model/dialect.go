package model

import (
	"io"
	"strings"
)

// reader is what a dialect reads a response body from.
type reader = io.Reader

// ReasoningKnobs is how hard the model was asked to think.
//
// It is a pair of decisions, not a request body. What a body does with them —
// `reasoning_effort`, `thinking.budget_tokens`, `reasoning.effort`, or nothing at
// all — is a property of the endpoint's protocol, so it belongs to the dialect
// and not here. Before this type existed, `state.RequestFields` returned a
// literal DeepSeek-shaped body fragment, which put wire knowledge in the
// configuration layer and meant a second protocol had to reach up and edit it.
type ReasoningKnobs struct {
	// Thinking is whether the model should reason at all.
	Thinking bool
	// Effort is the level. It has a value even when Thinking is false, so that
	// turning thinking off and on again does not lose the level.
	Effort string
	// omit means "say nothing about reasoning", which is a third state and not the
	// same as Thinking == false.
	//
	// It exists because of a measured incompatibility: a thinking-only model refuses
	// both `reasoning_effort: "none"` and `thinking: {"type": "disabled"}` with a 400,
	// and the only request it accepts is one that does not mention reasoning at all.
	// Saying "off" and saying "no opinion" are therefore different requests, and a
	// protocol that cannot express "off" has to be given the latter.
	omit bool
}

// RequestFields describes the thinking knobs the way the protocol-independent
// layer understands them: two decisions, no wire shape.
//
// The name is historical — it used to return a literal body fragment, with the
// `extra_body` key the OpenAI SDK treats as an escape hatch. Where those extra
// keys land is protocol-specific (chat completions flattens them into the top
// level, the Messages shape puts `thinking` in an object of its own), so that
// decision moved down into each dialect's request builder.
func RequestFields(thinking bool, effort string) ReasoningKnobs {
	return ReasoningKnobs{Thinking: thinking, Effort: effort}
}

// effortOr is the configured effort with a fallback when it is blank.
//
// A blank effort is not the same as "no preference" to every endpoint: the
// Messages shape has no default for it, so sending an empty string is a request
// the endpoint may refuse. The callers all pass a resolved value; this keeps a
// hand-built adapter from putting "" on the wire.
func effortOr(effort, fallback string) string {
	if strings.TrimSpace(effort) == "" {
		return fallback
	}
	return effort
}

// dialect turns one protocol into request bodies and ModelResponses.
//
// It is deliberately narrow. Everything that is not the wire format — the HTTP
// client, the timeout, the retry classification, the cancellation check, the
// "this gateway dislikes stream_options" recovery — stays in completeOnce, and
// every dialect inherits it. The failure this partition prevents is the one a
// single adapter per protocol always ends in: three copies of the retry rule, two
// of which have been fixed.
type dialect interface {
	// path is the endpoint path appended to the route's base URL.
	path() string
	// encode builds the request body.
	encode(request dialectRequest) (map[string]any, error)
	// parseUnary reads a whole non-streamed response body.
	parseUnary(body []byte) (ModelResponse, error)
	// parseStream reads an SSE body, feeding increments to the sink.
	//
	// The body is handed over untouched rather than pre-buffered, because a
	// stream is where the user is waiting and where pressing stop has to be
	// noticed: reading it to the end first would move cancellation to after the
	// answer finished arriving, which is the cost streaming was bought to
	// remove.
	parseStream(body reader, sink DeltaSink, shouldStop func() bool) (ModelResponse, error)
	// wantsStreamOptions reports whether this protocol has an `include_usage`
	// style parameter that may have to be dropped after a rejection.
	wantsStreamOptions() bool
	// credentialHeader is the header a credential is placed in.
	//
	// This is a protocol fact and not a preference, and getting it wrong produces an
	// authentication failure that reads like a bad key: the Messages shape takes
	// `x-api-key`, so a bearer token sent to it is answered with "Missing API key" —
	// a message that sends the reader to their key rather than to the header. The
	// official Anthropic API and the gateways that re-serve its shape were measured
	// to agree on this, which is why it is one answer per protocol rather than
	// something configurable.
	credentialHeader() string
}

// dialectRequest is everything a dialect needs to build one request.
type dialectRequest struct {
	model    string
	messages []map[string]any
	tools    []map[string]any
	stream   bool
	knobs    ReasoningKnobs
	// includeStreamUsage is whether to ask for token usage on a streamed request.
	//
	// It is computed by the transport, which owns the one fact this depends on
	// beyond the protocol — whether this particular gateway has already refused
	// the parameter once (see unsupportedStreamOptions). A dialect that has no
	// such parameter ignores it.
	includeStreamUsage bool
}

// dialectFor picks the implementation for a style.
//
// An unknown style is a refusal, not a fallback. Guessing `openai` for a typo
// sends the request to an endpoint that answers with a JSON decode error naming
// a field, and the person then has to work backwards from the wire to the line in
// their configuration file. Naming the bad value here is the shorter path, and it
// is the same choice the catalogue makes for every other key.
func dialectFor(style Style) (dialect, error) {
	switch style {
	case StyleOpenAI:
		return openaiDialect{}, nil
	case StyleAnthropic:
		return anthropicDialect{}, nil
	case StyleResponses:
		return responsesDialect{}, nil
	default:
		return nil, AsFatal("unknown api_style %q: the wire protocols are %s, %s, %s",
			string(style), StyleOpenAI, StyleAnthropic, StyleResponses)
	}
}
