// Package model is the one place that knows what a chat completion looks like.
//
// Above it, the agent asks for "a completion given these messages and tools" and
// gets a ModelResponse back. Below it sits whichever OpenAI-compatible endpoint
// the user configured. Nothing above this package knows the wire format, and
// nothing in it knows about tools, permissions or sessions.
package model

import (
	"errors"
	"fmt"
)

// Error is the base class for everything this package raises.
//
// The two subclasses exist because retrying is a decision, and a decision needs a
// classification. Everything above this package sees only these two; SDK-specific
// errors are translated here and never escape.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// TransientError is worth retrying: network trouble, a timeout, a rate limit, a
// server-side hiccup.
type TransientError struct{ Msg string }

func (e *TransientError) Error() string { return e.Msg }

// FatalError will not get better by trying again: a bad key, a malformed request,
// a model that does not exist.
type FatalError struct{ Msg string }

func (e *FatalError) Error() string { return e.Msg }

// IsFatal reports whether an error should stop the retry loop immediately.
//
// Anything unrecognised counts as fatal. Failing fast on an error we do not
// understand is the safe direction: retrying three times against something that
// will never work just delays the report by three round trips.
func IsFatal(err error) bool {
	var fatal *FatalError
	return errors.As(err, &fatal)
}

// AsTransient wraps a message as a retryable failure.
func AsTransient(format string, args ...any) error {
	return &TransientError{Msg: fmt.Sprintf(format, args...)}
}

// AsFatal wraps a message as a permanent failure.
func AsFatal(format string, args ...any) error {
	return &FatalError{Msg: fmt.Sprintf(format, args...)}
}

// TokenUsage is what one call cost.
type TokenUsage struct {
	PromptTokens     int
	CachedTokens     int
	CompletionTokens int
}

// MissTokens is the part of the prompt that was not served from cache.
func (u TokenUsage) MissTokens() int {
	if u.PromptTokens > u.CachedTokens {
		return u.PromptTokens - u.CachedTokens
	}
	return 0
}

// ToolCall is one call the model asked for.
type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// ModelResponse is one completed model turn.
type ModelResponse struct {
	// Content is nil, not empty, on a turn that only asked for tools. The
	// difference matters: an empty string would be appended to the history as
	// "the model said nothing", which is not what happened.
	Content   *string
	ToolCalls []ToolCall
	Usage     *TokenUsage
	// Reasoning is the model's thinking, when the gateway reports it. It goes to
	// the audit and to the interface; it is never fed back into the next request.
	Reasoning *string
	// FinishReason is the endpoint's own answer to "why did this generation end",
	// passed through in its own vocabulary (`stop`, `length`, `tool_calls`,
	// `end_turn`, `max_tokens`, `incomplete`…) because the three protocols do not
	// agree on the words and translating them here would invent a fourth set.
	//
	// It is the one field that separates two failures that otherwise look
	// identical from above: a generation the endpoint cut off because it ran out
	// of output room, and one that ended deliberately with nothing to say. Empty
	// means the endpoint reported none — which is itself the finding, because
	// every protocol here announces the end of a stream.
	FinishReason string
	// Streamed reports whether this turn was delivered incrementally.
	Streamed bool
	// StreamChunks counts both kinds of increment (text and reasoning). It is
	// what lands in the audit instead of the stream itself.
	StreamChunks int
}

// StreamedChars is how much text passed through the stream.
func (r ModelResponse) StreamedChars() int {
	if r.Content == nil {
		return 0
	}
	return len([]rune(*r.Content))
}

// DeltaSink receives one increment. Both parameters are the **new** piece, not the
// running total: accumulating is the caller's job.
//
// The two channels are separate fields rather than a tagged union because both
// carry strings, and routing them wrongly puts a stretch of the model thinking
// out loud into the middle of the answer — which then looks like a model problem
// rather than a plumbing problem.
type DeltaSink func(text, reasoning string)

// CompleteOptions carries the callbacks one request may want.
type CompleteOptions struct {
	// OnDelta receives stream increments. When it is nil the request is not
	// streamed at all: asking for a stream nobody reads costs the same and
	// delivers less.
	OnDelta DeltaSink
	// OnAttemptStarted runs before each attempt, including the first. It lets the
	// interface drop the half-written text of the previous attempt before the
	// next one restates the whole thing.
	OnAttemptStarted func()
	// ShouldStop is consulted while a stream is being read. A true answer abandons
	// the turn immediately and returns CancelledError.
	//
	// It exists because "stop" has to mean stop. Without it the flag set by the
	// front end would only be noticed at the next step boundary, so pressing Esc
	// during a streamed answer still made the user wait out the whole thing —
	// seconds to tens of seconds, which is exactly the cost streaming was bought
	// to remove. A stream is where the user's attention is, so it is where the
	// check has to be.
	ShouldStop func() bool
}

// CancelledError means the front end asked to abandon this turn mid-flight.
//
// A distinct type rather than a wrapped TransientError: "the user changed their
// mind" must not be retried, must not be recorded as a model failure, and must not
// end up in the audit as an error.
type CancelledError struct{}

func (CancelledError) Error() string { return "the turn was cancelled" }

// IsCancelled reports whether an error is the user abandoning the turn.
func IsCancelled(err error) bool {
	var cancelled CancelledError
	return errors.As(err, &cancelled)
}

// ChatModel is what the agent talks to.
type ChatModel interface {
	// Complete runs one request. The returned error is always a *TransientError
	// or a *FatalError.
	Complete(messages []map[string]any, tools []map[string]any, options CompleteOptions) (ModelResponse, error)
	// SwitchModel changes the model for subsequent requests. It returns false when
	// this adapter cannot do that mid-session.
	SwitchModel(name string) bool
	// Install moves to another **route**: the key, the endpoint, the protocol and
	// the model name together. It returns false when this adapter cannot.
	//
	// It is a separate capability from SwitchModel because the cost is different:
	// that one changes a single request field, this one changes the credentials,
	// the endpoint and the kind of request that goes out, which for most
	// implementations means rebuilding the client. An adapter that cannot rename a
	// model certainly cannot do this.
	//
	// **The whole route is handed over, not its fields.** That is what keeps this
	// signature from growing: a parameter added here would have to be added at
	// every call site, by a layer whose whole purpose is not to know what an
	// endpoint needs. It is also what makes the route change all-or-nothing —
	// applying the endpoint without the protocol, or the model without the extra
	// headers, produces the worst shape of bug there is: the interface, the
	// session record and the audit all say the new route, while the request still
	// goes out the old way. Nothing anywhere reports the divergence.
	//
	// Renaming a model across routes with SwitchModel alone produces that same
	// bug, which is why the two capabilities are kept apart.
	//
	// The contract matches SwitchModel's: the next request uses the new route, and
	// one already in flight is unaffected.
	Install(route Route) bool
	// SetReasoning updates the two thinking knobs for subsequent requests.
	SetReasoning(thinking bool, effort string)
	// ModelName is the model currently in use.
	ModelName() string
	// ProviderName is the route currently in use.
	ProviderName() string
	// BaseURL is where requests currently go.
	BaseURL() string
	// Route is the endpoint currently in use, as one value.
	//
	// It is how a caller answers "is this the route I think I am on" without
	// comparing a field: comparing fields is how a change of protocol once went
	// unnoticed, because every field the caller thought to check was equal.
	Route() Route
	// SameEndpoint reports whether another route reaches the same endpoint,
	// ignoring which model it names.
	//
	// It is the test behind the cheap path: the same endpoint with a different
	// model is a rename, and a different endpoint — a new key, a new protocol, a
	// header the vendor now requires — is not.
	SameEndpoint(other Route) bool
}
